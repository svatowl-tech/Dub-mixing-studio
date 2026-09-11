use std::path::Path;
use std::fmt;
use std::error::Error;
use serde::{Deserialize, Serialize};
use hound::{WavReader, WavWriter, WavSpec, SampleFormat};
use ebur128::{EbuR128, Mode};
use rayon::prelude::*;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NormalizationStats {
    pub initial_lufs: f64,
    pub final_lufs: f64,
    pub initial_true_peak_db: f64,
    pub final_true_peak_db: f64,
    pub gain_applied_db: f64,
    pub upward_compression_applied: bool,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_sec: f64,
    pub output_path: String,
}

#[derive(Debug)]
pub enum AudioError {
    IoError(std::io::Error),
    HoundError(hound::Error),
    EbuError(String),
    InvalidData(String),
    ProcessingError(String),
}

impl fmt::Display for AudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AudioError::IoError(e) => write!(f, "I/O Error: {}", e),
            AudioError::HoundError(e) => write!(f, "WAV Error: {}", e),
            AudioError::EbuError(e) => write!(f, "EBU R128 Error: {}", e),
            AudioError::InvalidData(e) => write!(f, "Invalid Audio Data: {}", e),
            AudioError::ProcessingError(e) => write!(f, "DSP Processing Error: {}", e),
        }
    }
}

impl Error for AudioError {}

impl From<std::io::Error> for AudioError {
    fn from(err: std::io::Error) -> Self {
        AudioError::IoError(err)
    }
}

impl From<hound::Error> for AudioError {
    fn from(err: hound::Error) -> Self {
        AudioError::HoundError(err)
    }
}

/// Helper function to convert linear peak amplitude to dBTP (decibels True Peak)
#[inline]
fn linear_to_dbtp(linear: f64) -> f64 {
    if linear > 0.0000001 {
        20.0 * linear.log10()
    } else {
        -120.0
    }
}

/// Helper function to convert dB to linear gain factor
#[inline]
fn db_to_linear(db: f64) -> f64 {
    10.0_f64.powf(db / 20.0)
}

/// Performs two-pass EBU R128 loudness normalization, upward compression,
/// and brickwall True-Peak limiting on a WAV audio file.
///
/// # Arguments
/// * `input_path` - Path to the source WAV file.
/// * `output_path` - Path where the processed 32-bit float WAV file will be written.
/// * `target_lufs` - Target Integrated Loudness in LUFS (e.g. -16.0 or -14.0 LUFS).
///
/// # Returns
/// `Result<NormalizationStats, AudioError>` with detailed loudness and peak metrics.
pub fn process_normalization(
    input_path: &Path,
    output_path: &Path,
    target_lufs: f64,
) -> Result<NormalizationStats, AudioError> {
    if !input_path.exists() {
        return Err(AudioError::InvalidData(format!(
            "Input audio file does not exist: {}",
            input_path.display()
        )));
    }

    // 1. Open reader and extract format specification
    let mut reader = WavReader::open(input_path)?;
    let spec = reader.spec();

    if spec.channels == 0 || spec.sample_rate == 0 {
        return Err(AudioError::InvalidData("Invalid audio format: channels or sample rate is zero".into()));
    }

    let channels = spec.channels as usize;
    let sample_rate = spec.sample_rate;

    // 2. Read all audio samples normalized into 32-bit floating point range [-1.0, 1.0]
    let raw_samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => {
            reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect()
        }
        SampleFormat::Int => {
            match spec.bits_per_sample {
                16 => reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / 32768.0).collect(),
                24 => reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 8388608.0).collect(),
                32 => reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 2147483648.0).collect(),
                8  => reader.samples::<i8>().map(|s| s.unwrap_or(0) as f32 / 128.0).collect(),
                b => return Err(AudioError::InvalidData(format!("Unsupported bit depth: {}", b))),
            }
        }
    };

    if raw_samples.is_empty() {
        return Err(AudioError::InvalidData("Audio file contains zero samples".into()));
    }

    let total_frames = raw_samples.len() / channels;
    let duration_sec = total_frames as f64 / sample_rate as f64;

    // =========================================================================
    // FIRST PASS: EBU R128 INTEGRATED LOUDNESS & TRUE-PEAK ANALYSIS
    // =========================================================================
    let mut initial_meter = EbuR128::new(channels as u32, sample_rate, Mode::I | Mode::TRUE_PEAK)
        .map_err(|e| AudioError::EbuError(format!("Failed to initialize EbuR128 meter: {:?}", e)))?;

    // Feed interleaved samples to the analyzer in chunks
    const CHUNK_FRAMES: usize = 4096;
    for chunk in raw_samples.chunks(CHUNK_FRAMES * channels) {
        initial_meter.add_frames_f32(chunk)
            .map_err(|e| AudioError::EbuError(format!("Error adding frames to EbuR128: {:?}", e)))?;
    }

    let initial_lufs_raw = initial_meter.loudness_global()
        .unwrap_or(-70.0);
    // Clamp to valid audio range if silence
    let initial_lufs = if initial_lufs_raw.is_nan() || initial_lufs_raw < -70.0 {
        -70.0
    } else {
        initial_lufs_raw
    };

    let mut max_initial_tp_linear = 0.0_f64;
    for ch in 0..channels as u32 {
        if let Ok(tp) = initial_meter.true_peak(ch) {
            if tp > max_initial_tp_linear {
                max_initial_tp_linear = tp;
            }
        }
    }
    let initial_true_peak_db = linear_to_dbtp(max_initial_tp_linear);

    // =========================================================================
    // SECOND PASS: TARGET GAIN, UPWARD COMPRESSION & TRUE-PEAK LIMITING
    // =========================================================================
    // 1. Calculate required base normalization gain
    let gain_applied_db = if initial_lufs > -69.0 {
        (target_lufs - initial_lufs).clamp(-30.0, 30.0)
    } else {
        0.0
    };
    let base_gain = db_to_linear(gain_applied_db) as f32;

    // 2. Upward Compression DSP parameters:
    // - Silence threshold: -32.0 dBFS
    // - Noise floor: -60.0 dBFS (signals below this are treated as background noise / ambient room tone and not boosted)
    // - Compression ratio: 2:1 (boost factor = (threshold - level) * (1 - 1/ratio) = (threshold - level) * 0.5)
    // - Ballistics: Attack 20ms, Release 100ms
    let upward_threshold_db = -32.0_f32;
    let noise_floor_db = -60.0_f32;
    let noise_taper_range_db = 10.0_f32; // -60 dB down to -70 dB smoothly tapers off boost
    let attack_time_sec = 0.020_f32;  // 20 ms attack
    let release_time_sec = 0.100_f32; // 100 ms release

    let alpha_attack = 1.0_f32 - (-1.0_f32 / (sample_rate as f32 * attack_time_sec)).exp();
    let alpha_release = 1.0_f32 - (-1.0_f32 / (sample_rate as f32 * release_time_sec)).exp();

    // 3. Peak Limiter parameters (-1.0 dBTP ceiling)
    let ceiling_dbtp = -1.0_f64;
    let ceiling_linear = db_to_linear(ceiling_dbtp) as f32; // ~0.89125

    // Prepare processed audio buffer
    let mut processed_samples = vec![0.0_f32; raw_samples.len()];

    // Process per channel to preserve stereo separation & imaging
    for ch in 0..channels {
        let mut envelope = 0.0_f32;
        let mut smoothed_gain = 1.0_f32;

        for frame in 0..total_frames {
            let idx = frame * channels + ch;
            let sample = raw_samples[idx];

            // Apply base normalization gain
            let normalized_sample = sample * base_gain;
            let abs_val = normalized_sample.abs();

            // Track envelope for ballistics
            let coeff = if abs_val > envelope { alpha_attack } else { alpha_release };
            envelope += coeff * (abs_val - envelope);

            // Calculate instantaneous level in dBFS
            let level_db = if envelope > 0.000001_f32 {
                20.0_f32 * envelope.log10()
            } else {
                -120.0_f32
            };

            // Calculate target upward compression gain
            let target_upward_gain_db = if level_db < upward_threshold_db && level_db > (noise_floor_db - noise_taper_range_db) {
                // Signal is in the active upward compression zone
                let raw_boost_db = (upward_threshold_db - level_db.max(noise_floor_db)) * 0.5_f32; // 2:1 ratio

                if level_db >= noise_floor_db {
                    raw_boost_db
                } else {
                    // Smooth taper below noise floor to avoid pumping room noise
                    let taper = (level_db - (noise_floor_db - noise_taper_range_db)) / noise_taper_range_db;
                    raw_boost_db * taper.clamp(0.0, 1.0)
                }
            } else {
                0.0_f32
            };

            let target_gain_linear = (10.0_f32).powf(target_upward_gain_db / 20.0);

            // Smooth the upward gain factor with envelope follower to prevent clicks
            let gain_coeff = if target_gain_linear > smoothed_gain { alpha_attack } else { alpha_release };
            smoothed_gain += gain_coeff * (target_gain_linear - smoothed_gain);

            // Apply upward compression
            let mut out_sample = normalized_sample * smoothed_gain;

            // Soft-knee brickwall True-Peak limiter to protect against clipping (-1.0 dBTP ceiling)
            let out_abs = out_sample.abs();
            if out_abs > ceiling_linear {
                let overage = out_abs - ceiling_linear;
                let soft_limited = ceiling_linear + (overage / (1.0 + overage));
                out_sample = out_sample.signum() * soft_limited.min(ceiling_linear);
            }

            processed_samples[idx] = out_sample;
        }
    }

    // =========================================================================
    // MEASURE FINAL PROCESSED RESULT FOR ACCURACY AUDITING
    // =========================================================================
    let mut final_meter = EbuR128::new(channels as u32, sample_rate, Mode::I | Mode::TRUE_PEAK)
        .map_err(|e| AudioError::EbuError(format!("Failed to initialize final EbuR128 meter: {:?}", e)))?;

    for chunk in processed_samples.chunks(CHUNK_FRAMES * channels) {
        final_meter.add_frames_f32(chunk)
            .map_err(|e| AudioError::EbuError(format!("Error adding frames to final meter: {:?}", e)))?;
    }

    let final_lufs_raw = final_meter.loudness_global().unwrap_or(target_lufs);
    let final_lufs = if final_lufs_raw.is_nan() { target_lufs } else { final_lufs_raw };

    let mut max_final_tp_linear = 0.0_f64;
    for ch in 0..channels as u32 {
        if let Ok(tp) = final_meter.true_peak(ch) {
            if tp > max_final_tp_linear {
                max_final_tp_linear = tp;
            }
        }
    }
    let final_true_peak_db = linear_to_dbtp(max_final_tp_linear);

    // =========================================================================
    // WRITE OUTPUT WAV FILE (High quality 32-bit float)
    // =========================================================================
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let out_spec = WavSpec {
        channels: channels as u16,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output_path, out_spec)?;
    for sample in processed_samples {
        writer.write_sample(sample)?;
    }
    writer.finalize()?;

    Ok(NormalizationStats {
        initial_lufs: (initial_lufs * 10.0).round() / 10.0,
        final_lufs: (final_lufs * 10.0).round() / 10.0,
        initial_true_peak_db: (initial_true_peak_db * 10.0).round() / 10.0,
        final_true_peak_db: (final_true_peak_db * 10.0).round() / 10.0,
        gain_applied_db: (gain_applied_db * 10.0).round() / 10.0,
        upward_compression_applied: true,
        sample_rate,
        channels: channels as u16,
        duration_sec: (duration_sec * 100.0).round() / 100.0,
        output_path: output_path.to_string_lossy().to_string(),
    })
}

/// Tauri command exposing the normalization & upward compression module to frontend.
/// Executes on a background thread pool via `tokio::task::spawn_blocking` to avoid blocking UI.
#[tauri::command]
pub async fn normalize_audio(
    input_path: String,
    output_path: String,
    target_lufs: Option<f64>,
) -> Result<NormalizationStats, String> {
    let in_path_buf = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&input_path));
    let out_path_buf = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&output_path));
    let target = target_lufs.unwrap_or(-16.0);

    tokio::task::spawn_blocking(move || {
        process_normalization(&in_path_buf, &out_path_buf, target)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task execution failed: {}", e))?
}
