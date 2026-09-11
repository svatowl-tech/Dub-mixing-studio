use std::path::Path;
use std::f32::consts::PI;
use hound::{WavReader, WavWriter, WavSpec, SampleFormat};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclickReport {
    pub clicks_detected: usize,
    pub samples_restored: usize,
    pub channels: u16,
    pub sample_rate: u32,
    pub duration_sec: f64,
    pub processed_path: String,
}

/// Helper: Solve LPC (Linear Predictive Coding) coefficients using Levinson-Durbin algorithm.
/// Computes AR coefficients a[1..p] for a given window of samples.
fn compute_lpc_coefficients(samples: &[f32], order: usize) -> Vec<f32> {
    let n = samples.len();
    if n <= order {
        return vec![0.0; order];
    }

    // 1. Autocorrelation: r[k] = sum_{i=0}^{n - 1 - k} x[i] * x[i + k]
    let mut r = vec![0.0_f32; order + 1];
    for k in 0..=order {
        let mut sum = 0.0_f32;
        for i in 0..(n - k) {
            sum += samples[i] * samples[i + k];
        }
        r[k] = sum;
    }

    if r[0] < 1e-12 {
        return vec![0.0; order];
    }

    // 2. Levinson-Durbin recursion
    let mut a = vec![0.0_f32; order + 1];
    let mut a_prev = vec![0.0_f32; order + 1];
    let mut e = r[0];

    for i in 1..=order {
        let mut lambda = 0.0_f32;
        for j in 1..i {
            lambda += a_prev[j] * r[i - j];
        }
        let k_i = (r[i] - lambda) / e;

        a[i] = k_i;
        for j in 1..i {
            a[j] = a_prev[j] - k_i * a_prev[i - j];
        }

        e *= 1.0 - k_i * k_i;
        if e <= 0.0 {
            break;
        }
        a_prev.copy_from_slice(&a);
    }

    a[1..=order].to_vec()
}

/// Hermite cubic spline basis functions for smooth C1-continuous segment interpolation.
#[inline]
fn cubic_hermite(p0: f32, m0: f32, p1: f32, m1: f32, t: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
}

/// Interval of a detected click
#[derive(Debug, Clone, Copy)]
pub struct ClickRegion {
    pub start: usize,
    pub end: usize,
}

/// Processes a slice of samples in-place, detecting and restoring clicks:
/// - Second derivative + LPC prediction error
/// - Duration filtering: 0.5 ms to 4.0 ms
/// - Cubic Hermite spline + autoregressive interpolation
/// - 0.5 ms cosine crossfade at edges
pub fn declick_sample_slice(
    samples: &mut [f32],
    sample_rate: u32,
    sensitivity: f32,
    offset_in_channel: usize,
    valid_range_start: usize,
    valid_range_end: usize,
) -> (usize, usize) {
    let len = samples.len();
    if len < 64 {
        return (0, 0);
    }

    // Duration limits: 0.5 ms to 4.0 ms
    let min_click_len = ((0.0005 * sample_rate as f32).round() as usize).max(8);
    let max_click_len = ((0.0040 * sample_rate as f32).round() as usize).max(min_click_len + 4);
    let xfade_len = ((0.0005 * sample_rate as f32).round() as usize).max(4);

    // Normalize sensitivity 0..100
    let sens = if sensitivity > 1.0 { sensitivity } else { sensitivity * 100.0 };
    let sens_norm = (sens / 100.0).clamp(0.01, 1.0);
    // Factor: higher sensitivity -> lower threshold factor (captures micro mouth ticks)
    let threshold_factor = 13.0 - 9.5 * sens_norm; // 3.5 to 13.0

    // Compute LPC coefficients over 1024-sample blocks
    const LPC_ORDER: usize = 8;
    const LPC_BLOCK_SIZE: usize = 1024;
    let mut lpc_coeffs = vec![0.0_f32; LPC_ORDER];

    let mut metric = vec![0.0_f32; len];
    let mut local_envelope = vec![0.0001_f32; len];

    let mut running_var = 0.001_f32;
    let alpha = 0.9992_f32;

    for i in 2..len {
        if i % LPC_BLOCK_SIZE == 0 {
            let block_end = (i + LPC_BLOCK_SIZE).min(len);
            lpc_coeffs = compute_lpc_coefficients(&samples[i..block_end], LPC_ORDER);
        }

        // 1. Second derivative (acceleration / high-frequency impulse)
        let d2 = (samples[i] - 2.0 * samples[i - 1] + samples[i - 2]).abs();

        // 2. LPC prediction error
        let mut predicted = 0.0_f32;
        for k in 0..LPC_ORDER {
            if i > k {
                predicted += lpc_coeffs[k] * samples[i - 1 - k];
            }
        }
        let lpc_err = (samples[i] - predicted).abs();

        // Combined anomaly score
        let score = d2 + 0.65 * lpc_err;
        metric[i] = score;

        running_var = alpha * running_var + (1.0 - alpha) * score;
        local_envelope[i] = running_var.max(0.00005);
    }

    // Find candidate click intervals
    let mut click_regions: Vec<ClickRegion> = Vec::new();
    let mut i = LPC_ORDER + 4;

    while i < len - max_click_len - 4 {
        let thresh = local_envelope[i] * threshold_factor;

        if metric[i] > thresh {
            // Find start of impulse (search backwards)
            let mut start = i;
            let back_limit = i.saturating_sub(min_click_len * 2);
            while start > back_limit && metric[start] > local_envelope[start] * 1.4 {
                start -= 1;
            }

            // Find end of impulse (search forwards)
            let mut end = i;
            let fwd_limit = (i + max_click_len).min(len - 2);
            while end < fwd_limit && metric[end] > local_envelope[end] * 1.4 {
                end += 1;
            }

            let click_duration = end.saturating_sub(start) + 1;
            if click_duration >= min_click_len && click_duration <= max_click_len {
                // Global position of the click center
                let global_center = offset_in_channel + (start + end) / 2;
                if global_center >= valid_range_start && global_center < valid_range_end {
                    // Check against preceding region to merge close clicks
                    if let Some(last) = click_regions.last_mut() {
                        if start <= last.end + xfade_len {
                            last.end = end;
                            i = end + 1;
                            continue;
                        }
                    }
                    click_regions.push(ClickRegion { start, end });
                    i = end + 1;
                    continue;
                }
            }
        }
        i += 1;
    }

    let clicks_detected = click_regions.len();
    let mut samples_restored = 0usize;

    // Apply restoration to each detected click region
    for region in click_regions {
        let start = region.start;
        let end = region.end;
        let count = end - start + 1;
        if start < 4 || end + 4 >= len {
            continue;
        }

        // Left and Right anchors for cubic Hermite spline
        let p0 = samples[start - 1];
        let p0_prev = samples[start - 3];
        let m0 = (p0 - p0_prev) * 0.5;

        let p1 = samples[end + 1];
        let p1_next = samples[end + 3];
        let m1 = (p1_next - p1) * 0.5;

        // Spline + AR prediction for the damaged segment
        for idx in 0..count {
            let t = (idx + 1) as f32 / (count + 1) as f32;
            let interpolated = cubic_hermite(p0, m0, p1, m1, t);
            samples[start + idx] = interpolated;
        }

        // Seamless Cosine Crossfade at boundaries (0.5 ms)
        // Left boundary: [start - xfade_len, start]
        if start >= xfade_len {
            for k in 0..xfade_len {
                let pos = start - xfade_len + k;
                let t_fade = k as f32 / xfade_len as f32;
                let w = 0.5 * (1.0 - (PI * t_fade).cos()); // 0.0 to 1.0
                let t_spline = -(xfade_len - k) as f32 / (count + 1) as f32;
                let interp_sample = cubic_hermite(p0, m0, p1, m1, t_spline);
                samples[pos] = samples[pos] * (1.0 - w) + interp_sample * w;
            }
        }

        // Right boundary: [end, end + xfade_len]
        if end + xfade_len < len {
            for k in 0..xfade_len {
                let pos = end + 1 + k;
                let t_fade = k as f32 / xfade_len as f32;
                let w = 0.5 * (1.0 - (PI * t_fade).cos()); // 0.0 to 1.0
                let t_spline = 1.0 + (k + 1) as f32 / (count + 1) as f32;
                let interp_sample = cubic_hermite(p0, m0, p1, m1, t_spline);
                samples[pos] = interp_sample * (1.0 - w) + samples[pos] * w;
            }
        }

        samples_restored += count + xfade_len * 2;
    }

    (clicks_detected, samples_restored)
}

/// Chunked parallel processing of an entire channel using Rayon.
/// Splits channel into 32768-sample chunks with 1024-sample context guard margins,
/// distributing tasks across the threadpool without blocking the main event loop.
fn process_channel_chunks_parallel(
    channel_samples: &mut [f32],
    sample_rate: u32,
    sensitivity: f32,
) -> (usize, usize) {
    let total_len = channel_samples.len();
    if total_len < 128 {
        return (0, 0);
    }

    const CHUNK_SIZE: usize = 32768;
    const GUARD_SIZE: usize = 1024;

    if total_len <= CHUNK_SIZE + GUARD_SIZE {
        return declick_sample_slice(
            channel_samples,
            sample_rate,
            sensitivity,
            0,
            0,
            total_len,
        );
    }

    let num_chunks = (total_len + CHUNK_SIZE - 1) / CHUNK_SIZE;

    // Define chunk descriptors (core boundaries and expanded boundaries)
    let chunks: Vec<(usize, usize, usize, usize)> = (0..num_chunks)
        .map(|c| {
            let core_start = c * CHUNK_SIZE;
            let core_end = (core_start + CHUNK_SIZE).min(total_len);
            let ext_start = core_start.saturating_sub(GUARD_SIZE);
            let ext_end = (core_end + GUARD_SIZE).min(total_len);
            (core_start, core_end, ext_start, ext_end)
        })
        .collect();

    // Prepare slices for parallel processing
    let chunk_data: Vec<Vec<f32>> = chunks
        .iter()
        .map(|&(_c_start, _c_end, ext_start, ext_end)| {
            channel_samples[ext_start..ext_end].to_vec()
        })
        .collect();

    // Process all chunks in parallel using Rayon
    let processed_results: Vec<(Vec<f32>, usize, usize)> = chunk_data
        .into_par_iter()
        .zip(chunks.par_iter())
        .map(|(mut data, &(c_start, c_end, ext_start, _ext_end))| {
            let (clicks, restored) = declick_sample_slice(
                &mut data,
                sample_rate,
                sensitivity,
                ext_start,
                c_start,
                c_end,
            );
            (data, clicks, restored)
        })
        .collect();

    let mut total_clicks = 0usize;
    let mut total_restored = 0usize;

    // Merge restored chunks back into channel_samples
    for (i, (processed_buf, clicks, restored)) in processed_results.into_iter().enumerate() {
        total_clicks += clicks;
        total_restored += restored;

        let (c_start, c_end, ext_start, _ext_end) = chunks[i];
        let offset_in_buf = c_start - ext_start;
        let count = c_end - c_start;

        channel_samples[c_start..c_end]
            .copy_from_slice(&processed_buf[offset_in_buf..(offset_in_buf + count)]);
    }

    (total_clicks, total_restored)
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

/// Core function: cleans clicks and mouth saliva ticks with Rayon multi-threaded chunk processing
pub fn process_clean_clicks(
    input_wav: &Path,
    output_wav: &Path,
    sensitivity: f32,
) -> Result<DeclickReport, String> {
    if !input_wav.exists() {
        return Err(format!("Input WAV file does not exist: {}", input_wav.display()));
    }

    let (interleaved_samples, spec) = read_wav_f32(input_wav)?;
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

    // Parallel chunked processing across channels and chunks using Rayon
    let stats: Vec<(usize, usize)> = channel_buffers
        .par_iter_mut()
        .map(|ch_buf| {
            process_channel_chunks_parallel(ch_buf, sample_rate, sensitivity)
        })
        .collect();

    let total_clicks: usize = stats.iter().map(|(c, _)| c).sum();
    let total_restored: usize = stats.iter().map(|(_, r)| r).sum();

    // Re-interleave samples
    let mut out_interleaved = Vec::with_capacity(interleaved_samples.len());
    for frame in 0..total_frames {
        for ch in 0..channels {
            out_interleaved.push(channel_buffers[ch][frame]);
        }
    }

    // Write output WAV in 32-bit float
    if let Some(parent) = output_wav.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }

    let out_spec = WavSpec {
        channels: spec.channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output_wav, out_spec)
        .map_err(|e| format!("Failed to create output WAV {}: {}", output_wav.display(), e))?;

    for s in out_interleaved {
        writer.write_sample(s)
            .map_err(|e| format!("Error writing WAV sample: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| format!("Error finalizing WAV output: {}", e))?;

    Ok(DeclickReport {
        clicks_detected: total_clicks,
        samples_restored: total_restored,
        channels: spec.channels,
        sample_rate,
        duration_sec: (duration_sec * 100.0).round() / 100.0,
        processed_path: output_wav.to_string_lossy().to_string(),
    })
}

/// Tauri Command for clean_clicks
#[tauri::command]
pub async fn clean_clicks(
    input_wav: String,
    output_wav: String,
    sensitivity: f32,
) -> Result<DeclickReport, String> {
    let in_path = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&input_wav));
    let out_path = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&output_wav));

    tokio::task::spawn_blocking(move || {
        process_clean_clicks(&in_path, &out_path, sensitivity)
    })
    .await
    .map_err(|e| format!("Task execution failed: {}", e))?
}
