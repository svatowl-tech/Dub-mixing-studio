use std::path::Path;
use std::f32::consts::PI;
use hound::{WavReader, WavWriter, WavSpec, SampleFormat};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeplosiveReport {
    pub plosives_detected: usize,
    pub max_reduction_db: f32,
    pub channels: u16,
    pub sample_rate: u32,
    pub duration_sec: f64,
    pub processed_path: String,
}

/// Normalized Biquad Filter coefficients:
/// H(z) = (b0 + b1*z^-1 + b2*z^-2) / (1 + a1*z^-1 + a2*z^-2)
#[derive(Debug, Clone, Copy)]
pub struct BiquadCoeffs {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
}

impl BiquadCoeffs {
    /// Second-order Butterworth Highpass filter
    pub fn highpass(fc: f32, sample_rate: f32, q: f32) -> Self {
        let nyquist = sample_rate * 0.5;
        let clamped_fc = fc.clamp(10.0, nyquist - 20.0);
        let omega = 2.0 * PI * clamped_fc / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);

        let a0 = 1.0 + alpha;
        let b0 = (1.0 + cos_w) * 0.5 / a0;
        let b1 = -(1.0 + cos_w) / a0;
        let b2 = (1.0 + cos_w) * 0.5 / a0;
        let a1 = (-2.0 * cos_w) / a0;
        let a2 = (1.0 - alpha) / a0;

        Self { b0, b1, b2, a1, a2 }
    }

    /// Bandpass filter with 0 dB peak gain for sidechain analysis
    pub fn bandpass(f0: f32, sample_rate: f32, q: f32) -> Self {
        let nyquist = sample_rate * 0.5;
        let clamped_f0 = f0.clamp(10.0, nyquist - 20.0);
        let omega = 2.0 * PI * clamped_f0 / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);

        let a0 = 1.0 + alpha;
        let b0 = alpha / a0;
        let b1 = 0.0;
        let b2 = -alpha / a0;
        let a1 = (-2.0 * cos_w) / a0;
        let a2 = (1.0 - alpha) / a0;

        Self { b0, b1, b2, a1, a2 }
    }
}

/// Transposed Direct Form II Biquad Filter (numerically stable, low noise)
#[derive(Debug, Clone)]
pub struct BiquadFilter {
    coeffs: BiquadCoeffs,
    s1: f32,
    s2: f32,
}

impl BiquadFilter {
    pub fn new(coeffs: BiquadCoeffs) -> Self {
        Self {
            coeffs,
            s1: 0.0,
            s2: 0.0,
        }
    }

    #[inline]
    pub fn update_coeffs(&mut self, coeffs: BiquadCoeffs) {
        self.coeffs = coeffs;
    }

    #[inline]
    pub fn process_sample(&mut self, x: f32) -> f32 {
        let y = self.coeffs.b0 * x + self.s1;
        self.s1 = self.coeffs.b1 * x - self.coeffs.a1 * y + self.s2;
        self.s2 = self.coeffs.b2 * x - self.coeffs.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.s1 = 0.0;
        self.s2 = 0.0;
    }
}

/// Dynamic 4th-Order Butterworth Highpass filter (two cascaded biquads)
#[derive(Debug, Clone)]
pub struct DynamicHighpass4thOrder {
    stage1: BiquadFilter,
    stage2: BiquadFilter,
    sample_rate: f32,
    current_fc: f32,
}

impl DynamicHighpass4thOrder {
    pub fn new(initial_fc: f32, sample_rate: f32) -> Self {
        // Butterworth 4th-order pole Q values
        let q1 = 1.0 / (2.0 * (PI / 8.0).cos()); // ≈ 0.5411961
        let q2 = 1.0 / (2.0 * (3.0 * PI / 8.0).cos()); // ≈ 1.3065630

        let coeffs1 = BiquadCoeffs::highpass(initial_fc, sample_rate, q1);
        let coeffs2 = BiquadCoeffs::highpass(initial_fc, sample_rate, q2);

        Self {
            stage1: BiquadFilter::new(coeffs1),
            stage2: BiquadFilter::new(coeffs2),
            sample_rate,
            current_fc: initial_fc,
        }
    }

    #[inline]
    pub fn set_cutoff(&mut self, fc: f32) {
        if (fc - self.current_fc).abs() > 0.1 {
            self.current_fc = fc;
            let q1 = 1.0 / (2.0 * (PI / 8.0).cos());
            let q2 = 1.0 / (2.0 * (3.0 * PI / 8.0).cos());

            self.stage1.update_coeffs(BiquadCoeffs::highpass(fc, self.sample_rate, q1));
            self.stage2.update_coeffs(BiquadCoeffs::highpass(fc, self.sample_rate, q2));
        }
    }

    #[inline]
    pub fn process_sample(&mut self, x: f32) -> f32 {
        let mid = self.stage1.process_sample(x);
        self.stage2.process_sample(mid)
    }
}

/// Two-band Sidechain Energy Analyzer for Plosive Detection:
/// - Low band: 20–120 Hz (monitored for explosive air blasts)
/// - Mid band: 200–2000 Hz (reference for normal vocal energy)
#[derive(Debug, Clone)]
pub struct TwoBandSidechain {
    filter_low: BiquadFilter,
    filter_mid: BiquadFilter,
    env_low: f32,
    env_mid: f32,
    alpha_att_low: f32,
    alpha_rel_low: f32,
    alpha_att_mid: f32,
    alpha_rel_mid: f32,
}

impl TwoBandSidechain {
    pub fn new(sample_rate: f32) -> Self {
        // Low band (20–120 Hz): center frequency ~ 65 Hz, Q ~ 0.70
        let coeffs_low = BiquadCoeffs::bandpass(65.0, sample_rate, 0.70);
        // Mid band (200–2000 Hz): center frequency ~ 630 Hz, Q ~ 0.35 (broad band)
        let coeffs_mid = BiquadCoeffs::bandpass(630.0, sample_rate, 0.35);

        // Fast attack (< 10 ms): 6 ms for rapid capsule puff detection
        let tau_att = 0.006_f32;
        let alpha_att = (-1.0 / (sample_rate * tau_att)).exp();

        // Release times
        let tau_rel_low = 0.040_f32; // 40 ms
        let alpha_rel_low = (-1.0 / (sample_rate * tau_rel_low)).exp();

        let tau_rel_mid = 0.050_f32; // 50 ms
        let alpha_rel_mid = (-1.0 / (sample_rate * tau_rel_mid)).exp();

        Self {
            filter_low: BiquadFilter::new(coeffs_low),
            filter_mid: BiquadFilter::new(coeffs_mid),
            env_low: 0.0001,
            env_mid: 0.0001,
            alpha_att_low: alpha_att,
            alpha_rel_low,
            alpha_att_mid: alpha_att,
            alpha_rel_mid,
        }
    }

    #[inline]
    pub fn process_sample(&mut self, x: f32) -> (f32, f32) {
        let low_val = self.filter_low.process_sample(x).abs();
        let mid_val = self.filter_mid.process_sample(x).abs();

        // Envelope follower for low band
        if low_val > self.env_low {
            self.env_low = self.alpha_att_low * self.env_low + (1.0 - self.alpha_att_low) * low_val;
        } else {
            self.env_low = self.alpha_rel_low * self.env_low + (1.0 - self.alpha_rel_low) * low_val;
        }

        // Envelope follower for mid band
        if mid_val > self.env_mid {
            self.env_mid = self.alpha_att_mid * self.env_mid + (1.0 - self.alpha_att_mid) * mid_val;
        } else {
            self.env_mid = self.alpha_rel_mid * self.env_mid + (1.0 - self.alpha_rel_mid) * mid_val;
        }

        (self.env_low, self.env_mid)
    }
}

/// Core single-channel dynamic de-plosive processor
pub fn process_channel_deplosive(
    samples: &mut [f32],
    sample_rate: u32,
    threshold_db: f32,
) -> (usize, f32) {
    let len = samples.len();
    if len < 32 {
        return (0, 0.0);
    }

    let sr = sample_rate as f32;
    let mut sidechain = TwoBandSidechain::new(sr);

    // Resting frequency: 40 Hz, Maximum dynamic cutoff: 175 Hz
    const REST_FC: f32 = 40.0;
    const MAX_FC: f32 = 175.0;

    let mut filter = DynamicHighpass4thOrder::new(REST_FC, sr);

    // Dynamic smoothing coefficients for the cutoff frequency
    // Attack: ~7 ms
    let alpha_f_att = (-1.0 / (sr * 0.007)).exp();
    // Release: ~80 ms as required ("с плавным возвратом (release ~80 мс)")
    let alpha_f_rel = (-1.0 / (sr * 0.080)).exp();

    let mut current_fc = REST_FC;
    let mut plosives_detected = 0usize;
    let mut in_plosive = false;
    let mut max_reduction_db = 0.0_f32;

    // Mini-block size for smooth coefficient recalculation without zipper noise
    const BLOCK_SIZE: usize = 16;
    let num_blocks = (len + BLOCK_SIZE - 1) / BLOCK_SIZE;

    for b in 0..num_blocks {
        let block_start = b * BLOCK_SIZE;
        let block_end = (block_start + BLOCK_SIZE).min(len);

        // Analyze sidechain and track target cutoff for the block
        let mut block_target_fc = REST_FC;

        for i in block_start..block_end {
            let x = samples[i];
            let (env_low, env_mid) = sidechain.process_sample(x);

            let low_db = 20.0 * (env_low + 1e-5).log10();
            let mid_db = 20.0 * (env_mid + 1e-5).log10();

            // Plosive signature check:
            // 1. Energy in 20-120 Hz exceeds user threshold
            // 2. Disproportionate surge: low energy is significantly higher than mid energy (capsule blast)
            let diff_db = low_db - mid_db;

            if low_db > threshold_db && diff_db > 4.0 {
                let level_factor = ((low_db - threshold_db) / 16.0).clamp(0.0, 1.0);
                let ratio_factor = ((diff_db - 4.0) / 14.0).clamp(0.0, 1.0);
                let severity = level_factor * ratio_factor;

                let target = REST_FC + severity * (MAX_FC - REST_FC);
                if target > block_target_fc {
                    block_target_fc = target;
                }

                if severity > 0.18 {
                    if !in_plosive {
                        plosives_detected += 1;
                        in_plosive = true;
                    }
                }
            } else if in_plosive && (low_db < threshold_db - 3.0 || diff_db < 2.0) {
                in_plosive = false;
            }
        }

        // Smoothly evolve current_fc towards block_target_fc
        if block_target_fc > current_fc {
            current_fc = alpha_f_att * current_fc + (1.0 - alpha_f_att) * block_target_fc;
        } else {
            current_fc = alpha_f_rel * current_fc + (1.0 - alpha_f_rel) * block_target_fc;
        }

        // Apply updated filter cutoff to the 4th order Butterworth HPF
        filter.set_cutoff(current_fc);

        // Process audio samples in the block
        for i in block_start..block_end {
            let orig = samples[i];
            let filtered = filter.process_sample(orig);
            samples[i] = filtered;

            if current_fc > REST_FC + 10.0 {
                let orig_mag = orig.abs();
                let filt_mag = filtered.abs();
                if orig_mag > 0.05 && orig_mag > filt_mag {
                    let red_db = 20.0 * ((orig_mag + 1e-5) / (filt_mag + 1e-5)).log10();
                    if red_db > max_reduction_db {
                        max_reduction_db = red_db;
                    }
                }
            }
        }
    }

    (plosives_detected, max_reduction_db)
}

/// Reads all samples from a WAV file and converts them to normalized f32 interleaved buffer [-1.0, 1.0]
fn read_wav_f32(path: &Path) -> Result<(Vec<f32>, WavSpec), String> {
    let mut reader = WavReader::open(path)
        .map_err(|e| format!("Failed to open WAV {}: {}", path.display(), e))?;
    let spec = reader.spec();

    if spec.channels == 0 || spec.sample_rate == 0 {
        return Err("Invalid WAV: zero channels or zero sample rate".to_string());
    }

    let samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => {
            reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect()
        }
        SampleFormat::Int => {
            match spec.bits_per_sample {
                16 => reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / 32768.0).collect(),
                24 => reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 8388608.0).collect(),
                32 => reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 2147483648.0).collect(),
                8  => reader.samples::<i8>().map(|s| s.unwrap_or(0) as f32 / 128.0).collect(),
                b => return Err(format!("Unsupported bit depth: {}", b)),
            }
        }
    };

    Ok((samples, spec))
}

/// Core function: cleans low-frequency plosives and microphone wind blasts using dynamic sidechain HPF
pub fn process_apply_deplosive(
    file_path: &Path,
    out_path: &Path,
    threshold_db: f32,
) -> Result<DeplosiveReport, String> {
    if !file_path.exists() {
        return Err(format!("Input WAV file does not exist: {}", file_path.display()));
    }

    let (interleaved_samples, spec) = read_wav_f32(file_path)?;
    let channels = spec.channels as usize;
    let sample_rate = spec.sample_rate;
    let total_frames = interleaved_samples.len() / channels;
    let duration_sec = total_frames as f64 / sample_rate as f64;

    // De-interleave channels into individual buffers
    let mut channel_buffers: Vec<Vec<f32>> = (0..channels)
        .map(|ch| {
            let mut ch_buf = Vec::with_capacity(total_frames);
            for frame in 0..total_frames {
                ch_buf.push(interleaved_samples[frame * channels + ch]);
            }
            ch_buf
        })
        .collect();

    // Process channels in parallel using Rayon
    let stats: Vec<(usize, f32)> = channel_buffers
        .par_iter_mut()
        .map(|ch_buf| {
            process_channel_deplosive(ch_buf, sample_rate, threshold_db)
        })
        .collect();

    let total_plosives: usize = stats.iter().map(|(p, _)| p).sum();
    let max_reduction: f32 = stats.iter().map(|(_, r)| *r).fold(0.0_f32, f32::max);

    // Re-interleave samples
    let mut out_interleaved = Vec::with_capacity(interleaved_samples.len());
    for frame in 0..total_frames {
        for ch in 0..channels {
            out_interleaved.push(channel_buffers[ch][frame]);
        }
    }

    // Write output WAV (preserves 32-bit float or 24-bit precision)
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }

    let out_spec = WavSpec {
        channels: spec.channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(out_path, out_spec)
        .map_err(|e| format!("Failed to create output WAV {}: {}", out_path.display(), e))?;

    for s in out_interleaved {
        writer.write_sample(s)
            .map_err(|e| format!("Error writing WAV sample: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| format!("Error finalizing WAV output: {}", e))?;

    Ok(DeplosiveReport {
        plosives_detected: total_plosives,
        max_reduction_db: (max_reduction * 10.0).round() / 10.0,
        channels: spec.channels,
        sample_rate,
        duration_sec: (duration_sec * 100.0).round() / 100.0,
        processed_path: out_path.to_string_lossy().to_string(),
    })
}

/// Tauri v2 command: apply_deplosive
#[tauri::command]
pub async fn apply_deplosive(
    file_path: String,
    out_path: String,
    threshold_db: f32,
) -> Result<DeplosiveReport, String> {
    let in_p = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&file_path));
    let out_p = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&out_path));

    tokio::task::spawn_blocking(move || {
        process_apply_deplosive(&in_p, &out_p, threshold_db)
    })
    .await
    .map_err(|e| format!("Task execution failed: {}", e))?
}
