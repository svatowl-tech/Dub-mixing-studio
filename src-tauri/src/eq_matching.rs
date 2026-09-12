use std::path::Path;
use std::sync::Arc;
use std::f32::consts::PI;
use hound::{WavReader, WavWriter, WavSpec, SampleFormat};
use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};

pub const FFT_SIZE: usize = 4096;
pub const HOP_SIZE: usize = 2048; // 50% overlap

pub const MAX_BOOST_DB: f32 = 6.0;
pub const MAX_CUT_DB: f32 = -12.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EqProfileSummary {
    pub profile_name: String,
    pub max_boost_db: f32,
    pub max_cut_db: f32,
    pub sample_rate: u32,
    pub duration_sec: f64,
}

/// Generates a Hann window of size N
pub fn hann_window(size: usize) -> Vec<f32> {
    let mut window = Vec::with_capacity(size);
    for n in 0..size {
        let val = 0.5 * (1.0 - (2.0 * PI * n as f32 / size as f32).cos());
        window.push(val);
    }
    window
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

/// Computes average Power Spectral Density (PSD) for a single channel using Hann-windowed STFT
fn compute_psd(
    channel_samples: &[f32],
    fft_size: usize,
    hop_size: usize,
    window: &[f32],
    fft_forward: &Arc<dyn rustfft::Fft<f32>>,
) -> Vec<f32> {
    let num_bins = fft_size / 2 + 1;
    let mut psd_accum = vec![0.0_f32; num_bins];
    let total_samples = channel_samples.len();

    if total_samples < fft_size {
        // Zero pad to at least one FFT block
        let mut block: Vec<Complex32> = channel_samples
            .iter()
            .zip(window.iter())
            .map(|(&s, &w)| Complex32::new(s * w, 0.0))
            .collect();
        block.resize(fft_size, Complex32::new(0.0, 0.0));
        fft_forward.process(&mut block);

        for k in 0..num_bins {
            psd_accum[k] = block[k].norm_sqr();
        }
        return psd_accum;
    }

    let mut frame_count = 0usize;
    let mut offset = 0;

    let mut block = vec![Complex32::new(0.0, 0.0); fft_size];

    while offset + fft_size <= total_samples {
        for n in 0..fft_size {
            block[n] = Complex32::new(channel_samples[offset + n] * window[n], 0.0);
        }

        fft_forward.process(&mut block);

        for k in 0..num_bins {
            psd_accum[k] += block[k].norm_sqr();
        }

        frame_count += 1;
        offset += hop_size;
    }

    if frame_count > 0 {
        let norm = 1.0 / (frame_count as f32 * fft_size as f32);
        for p in psd_accum.iter_mut() {
            *p *= norm;
        }
    }

    psd_accum
}

/// Performs 1/3-octave logarithmic frequency smoothing on a dB curve.
/// For each bin k at frequency f_k, integrates neighboring bins within [f_k * 2^(-1/6), f_k * 2^(+1/6)]
/// using a triangular weighting window in log-frequency domain.
fn smooth_one_third_octave(curve_db: &[f32], sample_rate: u32, _fft_size: usize) -> Vec<f32> {
    let num_bins = curve_db.len();
    let mut smoothed = vec![0.0_f32; num_bins];
    let nyquist = sample_rate as f32 * 0.5;
    let bin_width = nyquist / (num_bins - 1) as f32;

    // 1/3 octave ratio bounds: 2^(1/6) approx 1.122462, 2^(-1/6) approx 0.8908987
    let octave_ratio_half = 2.0_f32.powf(1.0 / 6.0);
    let log_width = 1.0_f32 / 6.0;

    for k in 0..num_bins {
        let center_freq = (k as f32 * bin_width).max(10.0);
        let f_low = center_freq / octave_ratio_half;
        let f_high = center_freq * octave_ratio_half;

        let k_low = ((f_low / bin_width).floor() as usize).min(num_bins - 1);
        let k_high = ((f_high / bin_width).ceil() as usize).min(num_bins - 1).max(k_low + 1);

        let mut sum_weight = 0.0_f32;
        let mut sum_val = 0.0_f32;

        for j in k_low..=k_high {
            let freq_j = (j as f32 * bin_width).max(10.0);
            let oct_dist = (freq_j / center_freq).log2().abs();
            let weight = (1.0 - (oct_dist / log_width)).max(0.001);

            sum_val += curve_db[j] * weight;
            sum_weight += weight;
        }

        if sum_weight > 0.0 {
            smoothed[k] = sum_val / sum_weight;
        } else {
            smoothed[k] = curve_db[k];
        }
    }

    smoothed
}

/// Computes the target dB curve for built-in profiles or external WAV references
fn calculate_transfer_curve_db(
    source_psd: &[f32],
    profile_name: &str,
    sample_rate: u32,
    fft_size: usize,
    fft_forward: &Arc<dyn rustfft::Fft<f32>>,
    window: &[f32],
) -> Result<Vec<f32>, String> {
    let num_bins = source_psd.len();
    let nyquist = sample_rate as f32 * 0.5;
    let bin_width = nyquist / (num_bins - 1) as f32;

    let normalized_name = profile_name.trim().to_lowercase();
    let ref_path = Path::new(profile_name.trim());

    // 1. Check if profile_name points to an existing WAV reference file
    if ref_path.exists() && ref_path.is_file() {
        let (ref_samples, ref_spec) = read_wav_f32(ref_path)?;
        if ref_spec.sample_rate != sample_rate {
            // Note: in a production DAW, resample ref if sample rates differ
            // For matching, we compare normalized frequencies
        }

        // Deinterleave first channel of reference audio
        let ref_ch0: Vec<f32> = ref_samples
            .iter()
            .step_by(ref_spec.channels as usize)
            .copied()
            .collect();

        let target_psd = compute_psd(&ref_ch0, fft_size, HOP_SIZE, window, fft_forward);

        // H_raw(f) = 10 * log10( (target_psd + eps) / (source_psd + eps) )
        let eps = 1e-12_f32;
        let mut raw_db = vec![0.0_f32; num_bins];
        for k in 0..num_bins {
            let s_target = target_psd.get(k).copied().unwrap_or(0.0) + eps;
            let s_source = source_psd[k] + eps;
            raw_db[k] = 10.0 * (s_target / s_source).log10();
        }

        // Align average mid-band gain around 1 kHz (between 500 Hz and 2 kHz) to prevent global volume jumps
        let k_mid_start = ((500.0 / bin_width) as usize).min(num_bins - 1);
        let k_mid_end = ((2000.0 / bin_width) as usize).min(num_bins - 1).max(k_mid_start + 1);
        let mid_avg: f32 = raw_db[k_mid_start..k_mid_end].iter().sum::<f32>() / (k_mid_end - k_mid_start) as f32;
        for val in raw_db.iter_mut() {
            *val -= mid_avg;
        }

        // Mandatory 1/3 octave smoothing
        let smoothed_db = smooth_one_third_octave(&raw_db, sample_rate, fft_size);
        return Ok(smoothed_db);
    }

    // 2. Default Target Profiles:
    let mut target_curve_db = vec![0.0_f32; num_bins];

    if normalized_name.contains("vocal") || normalized_name.contains("presence") {
        // "Vocal Presence":
        // - Soft sub-bass highpass cut below 80 Hz (-12 dB at 30 Hz, -6 dB at 60 Hz, -1 dB at 80 Hz)
        // - Presence boost 3-5 kHz (+3 dB bell curve centered at 4 kHz)
        // - Gentle air lift above 10 kHz (+1 dB)
        for k in 0..num_bins {
            let freq = k as f32 * bin_width;

            let mut db = 0.0_f32;

            // Sub-bass rolloff below 80 Hz
            if freq < 80.0 {
                let norm_f = (freq / 80.0).clamp(0.0, 1.0);
                db += -12.0 * (1.0 - norm_f).powf(1.8);
            }

            // Presence boost 3-5 kHz (+3.0 dB)
            let center_freq = 4000.0_f32;
            let bandwidth = 1400.0_f32;
            let diff = freq - center_freq;
            let bell = (-0.5 * (diff / (bandwidth * 0.5)).powi(2)).exp();
            db += 3.0 * bell;

            // Air shelf above 10 kHz
            if freq > 10000.0 {
                let air_factor = ((freq - 10000.0) / 10000.0).clamp(0.0, 1.0);
                db += 1.0 * air_factor;
            }

            target_curve_db[k] = db;
        }
    } else if normalized_name.contains("warm") || normalized_name.contains("analog") {
        // "Warm Analog":
        // - Gentle sub-rumble cut below 35 Hz
        // - Warm low-mid boost 200-300 Hz (+2.5 dB centered at 240 Hz)
        // - Gentle high-shelf roll-off 12-16 kHz (-3 dB to -5 dB)
        for k in 0..num_bins {
            let freq = k as f32 * bin_width;
            let mut db = 0.0_f32;

            // Sub rumble cut < 35 Hz
            if freq < 35.0 {
                let norm_f = (freq / 35.0).clamp(0.0, 1.0);
                db += -8.0 * (1.0 - norm_f).powf(2.0);
            }

            // Warm low-mid 200-300 Hz (+2.5 dB)
            let center_freq = 240.0_f32;
            let bandwidth = 100.0_f32;
            let diff = freq - center_freq;
            let bell = (-0.5 * (diff / (bandwidth * 0.5)).powi(2)).exp();
            db += 2.5 * bell;

            // Gentle high roll-off at 12-16 kHz
            if freq > 10000.0 {
                let high_norm = ((freq - 10000.0) / 10000.0).clamp(0.0, 1.0);
                db -= 4.0 * high_norm;
            }

            target_curve_db[k] = db;
        }
    } else {
        // Neutral / Flat fallback with clean 30 Hz subsonic filter
        for k in 0..num_bins {
            let freq = k as f32 * bin_width;
            if freq < 30.0 {
                let norm_f = (freq / 30.0).clamp(0.0, 1.0);
                target_curve_db[k] = -12.0 * (1.0 - norm_f);
            }
        }
    }

    // Apply 1/3 octave smoothing across the synthesized target curve
    let smoothed_db = smooth_one_third_octave(&target_curve_db, sample_rate, fft_size);
    Ok(smoothed_db)
}

/// Applies EQ Matching filtering via Overlap-Add (OLA) on audio samples.
/// Clamps transfer curve to [+6 dB, -12 dB] to prevent artifacts.
pub fn apply_eq_matching_ola(
    input_samples: &[f32],
    channels: usize,
    sample_rate: u32,
    profile_name: &str,
) -> Result<Vec<f32>, String> {
    if input_samples.is_empty() {
        return Ok(Vec::new());
    }

    let fft_size = FFT_SIZE;
    let hop_size = HOP_SIZE;
    let num_bins = fft_size / 2 + 1;
    let window = hann_window(fft_size);

    let mut planner = FftPlanner::new();
    let fft_forward = planner.plan_fft_forward(fft_size);
    let fft_inverse = planner.plan_fft_inverse(fft_size);

    let total_frames = input_samples.len() / channels;

    // 1. Separate channels for analysis and compute source PSD
    let mut channel_data: Vec<Vec<f32>> = vec![Vec::with_capacity(total_frames); channels];
    for frame in 0..total_frames {
        for ch in 0..channels {
            channel_data[ch].push(input_samples[frame * channels + ch]);
        }
    }

    // Average PSD across all channels
    let mut combined_psd = vec![0.0_f32; num_bins];
    for ch in 0..channels {
        let ch_psd = compute_psd(&channel_data[ch], fft_size, hop_size, &window, &fft_forward);
        for k in 0..num_bins {
            combined_psd[k] += ch_psd[k] / channels as f32;
        }
    }

    // 2. Compute transfer function in dB with 1/3 octave smoothing
    let transfer_db = calculate_transfer_curve_db(
        &combined_psd,
        profile_name,
        sample_rate,
        fft_size,
        &fft_forward,
        &window,
    )?;

    // 3. Clamp transfer function to bounds: max +6 dB, min -12 dB
    let mut filter_gain_linear = vec![1.0_f32; fft_size];
    for k in 0..num_bins {
        let clamped_db = transfer_db[k].clamp(MAX_CUT_DB, MAX_BOOST_DB);
        let linear_gain = 10.0_f32.powf(clamped_db / 20.0);
        filter_gain_linear[k] = linear_gain;

        // Conjugate symmetry for real IFFT
        if k > 0 && k < num_bins - 1 {
            filter_gain_linear[fft_size - k] = linear_gain;
        }
    }

    // 4. Overlap-Add (OLA) processing per channel
    let mut processed_channels: Vec<Vec<f32>> = vec![vec![0.0_f32; total_frames + fft_size]; channels];

    for ch in 0..channels {
        let ch_in = &channel_data[ch];
        let out_buf = &mut processed_channels[ch];

        let mut offset = 0;
        let mut block = vec![Complex32::new(0.0, 0.0); fft_size];

        while offset < total_frames {
            // Apply analysis window
            for n in 0..fft_size {
                let sample = if offset + n < total_frames {
                    ch_in[offset + n]
                } else {
                    0.0_f32
                };
                block[n] = Complex32::new(sample * window[n], 0.0);
            }

            // Forward FFT
            fft_forward.process(&mut block);

            // Frequency domain filtering: multiply spectrum by symmetric transfer gain
            for k in 0..fft_size {
                block[k] *= filter_gain_linear[k];
            }

            // Inverse FFT
            fft_inverse.process(&mut block);

            // Overlap-Add: normalize by FFT_SIZE (rustfft scaling convention)
            let inv_scale = 1.0 / fft_size as f32;
            for n in 0..fft_size {
                let out_idx = offset + n;
                if out_idx < out_buf.len() {
                    out_buf[out_idx] += block[n].re * inv_scale;
                }
            }

            offset += hop_size;
        }
    }

    // 5. Interleave channels back together and slice to original frame length
    let mut output_interleaved = Vec::with_capacity(input_samples.len());
    for frame in 0..total_frames {
        for ch in 0..channels {
            // Limiter safeguard against extreme transients
            let sample = processed_channels[ch][frame].clamp(-1.0, 1.0);
            output_interleaved.push(sample);
        }
    }

    Ok(output_interleaved)
}

/// Core processing function for EQ Matching
pub fn process_match_eq_profile(
    input_path: &Path,
    output_path: &Path,
    profile_name: &str,
) -> Result<(), String> {
    if !input_path.exists() {
        return Err(format!("Input audio file does not exist: {}", input_path.display()));
    }

    let (samples, spec) = read_wav_f32(input_path)?;
    let channels = spec.channels as usize;
    let sample_rate = spec.sample_rate;

    let processed_samples = apply_eq_matching_ola(
        &samples,
        channels,
        sample_rate,
        profile_name,
    )?;

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    let out_spec = WavSpec {
        channels: spec.channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output_path, out_spec)
        .map_err(|e| format!("Failed to create output WAV {}: {}", output_path.display(), e))?;

    for sample in processed_samples {
        writer.write_sample(sample)
            .map_err(|e| format!("Error writing audio sample: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| format!("Error finalizing WAV file: {}", e))?;

    Ok(())
}

/// Tauri Command for EQ Matching
#[tauri::command]
pub async fn match_eq_profile(
    input_path: String,
    output_path: String,
    profile_name: String,
) -> Result<(), String> {
    let in_path_buf = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&input_path));
    let out_path_buf = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&output_path));
    let profile = profile_name.clone();

    tokio::task::spawn_blocking(move || {
        process_match_eq_profile(&in_path_buf, &out_path_buf, &profile)
    })
    .await
    .map_err(|e| format!("Task execution failed: {}", e))?
}
