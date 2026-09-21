// ============================================================================
// DUB MIXING STUDIO PRO - SMART ALIGNMENT & DSP ENGINE (RUST)
// Двухуровневый алгоритм синхронизации дубляжа с оригиналом:
// 1. GCC-PHAT (Generalized Cross-Correlation with Phase Transform) - глобальный сдвиг
// 2. VAD & Vowel Kernels - сегментация гласных ядер и исключение пауз/вдохов
// 3. FastDTW по MFCC векторным признакам (Mel-Frequency Cepstral Coefficients)
// 4. WSOLA (Waveform Similarity Overlap-Add) - Pitch-Neutral ресинтез с лимитом 0.85x..1.18x
// ============================================================================

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;
use std::path::Path;
use tauri::{command, AppHandle, State};

use crate::audio_buffer_manager::AudioBufferCache;

// ============================================================================
// СТРУКТУРЫ ДАННЫХ И ТИПЫ ВОЗВРАТА
// ============================================================================

/// Точка деформации времени в пути DTW
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DtwPoint {
    pub orig_index: usize,
    pub dub_index: usize,
    pub orig_time_ms: f64,
    pub dub_time_ms: f64,
    pub cost: f32,
    pub is_vowel: bool,
}

/// Сегментная подгонка фразы
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentAdjustment {
    pub segment_index: usize,
    pub orig_start_ms: f64,
    pub orig_end_ms: f64,
    pub dub_start_ms: f64,
    pub dub_end_ms: f64,
    pub time_stretch_ratio: f64,
    pub pitch_shift_semitones: f64,
    pub energy_similarity: f32,
    pub deviation_percent: f64,
    pub is_vowel_kernel: bool,
}

/// Итоговая структура подгонки таймингов (AlignmentResult)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentResult {
    pub original_path: String,
    pub dub_path: String,
    pub output_path: String,
    pub original_duration_ms: f64,
    pub dub_duration_ms: f64,
    pub output_duration_ms: f64,
    pub detected_offset_ms: f64,
    pub offset_shift_ms: f64,
    pub stretch_ratio: f64,
    pub correlation_score: f32,
    pub sample_rate: u32,
    pub was_stretched: bool,
    pub manual_sync_required: bool,
    pub requires_actor_re_recording: bool,
    pub warning_message: Option<String>,
    pub segment_adjustments: Vec<SegmentAdjustment>,
    pub dtw_distance: f32,
    // Поля для обратной совместимости с legacy UI (originalCueId/dubCueId)
    pub original_cue_id: Option<String>,
    pub dub_cue_id: Option<String>,
    pub detected_lag_ms: Option<f64>,
    pub detected_lag_samples: Option<i64>,
    pub average_stretch_ratio: Option<f64>,
    pub max_deviation_percent: Option<f64>,
}

pub type AlignResult = AlignmentResult;
pub type AlignmentAdjustment = AlignmentResult;

/// Конфигурация параметров Smart Align
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartAlignConfig {
    pub min_stretch_ratio: Option<f64>,           // По умолчанию 0.85
    pub max_stretch_ratio: Option<f64>,           // По умолчанию 1.18
    pub max_deviation_limit_percent: Option<f64>,// По порогу 20.0%
    pub max_search_offset_ms: Option<f64>,        // По умолчанию 2000.0 ms
    pub dtw_hop_size_ms: Option<f64>,             // По умолчанию 10.0 ms
    pub dtw_window_size_ms: Option<f64>,          // По умолчанию 25.0 ms
}

impl Default for SmartAlignConfig {
    fn default() -> Self {
        Self {
            min_stretch_ratio: Some(0.85),
            max_stretch_ratio: Some(1.18),
            max_deviation_limit_percent: Some(20.0),
            max_search_offset_ms: Some(2000.0),
            dtw_hop_size_ms: Some(10.0),
            dtw_window_size_ms: Some(25.0),
        }
    }
}

// ============================================================================
// ЗАГРУЗКА И СОХРАНЕНИЕ АУДИО
// ============================================================================

pub struct MonoAudioBuffer {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

pub fn resolve_audio_samples(
    buffer_id_or_path: &str,
    cache: Option<&AudioBufferCache>,
) -> Result<MonoAudioBuffer, String> {
    if let Some(c) = cache {
        if let Some(buf_entry) = c.buffers.get(buffer_id_or_path) {
            let buf = buf_entry.value();
            let raw_samples = buf.get_slice(0, buf.total_frames * (buf.channels as usize));
            let mono_samples = if buf.channels > 1 {
                let ch = buf.channels as usize;
                raw_samples
                    .chunks(ch)
                    .map(|chunk| chunk.iter().sum::<f32>() / (ch as f32))
                    .collect()
            } else {
                raw_samples
            };
            return Ok(MonoAudioBuffer {
                samples: mono_samples,
                sample_rate: buf.sample_rate,
            });
        }

        if let Some(buf_id) = c.get_by_path(buffer_id_or_path) {
            if let Some(buf_entry) = c.buffers.get(&buf_id) {
                let buf = buf_entry.value();
                let raw_samples = buf.get_slice(0, buf.total_frames * (buf.channels as usize));
                let mono_samples = if buf.channels > 1 {
                    let ch = buf.channels as usize;
                    raw_samples
                        .chunks(ch)
                        .map(|chunk| chunk.iter().sum::<f32>() / (ch as f32))
                        .collect()
                } else {
                    raw_samples
                };
                return Ok(MonoAudioBuffer {
                    samples: mono_samples,
                    sample_rate: buf.sample_rate,
                });
            }
        }
    }

    let path = Path::new(buffer_id_or_path);
    if !path.exists() {
        return Err(format!("Аудио-источник не найден: '{}'", buffer_id_or_path));
    }

    let mut reader = WavReader::open(path)
        .map_err(|e| format!("Не удалось открыть WAV файл '{}': {}", buffer_id_or_path, e))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    if channels == 0 {
        return Err("Количество каналов равно 0".to_string());
    }

    let samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => {
            let raw: Vec<f32> = reader.samples::<f32>().filter_map(|s| s.ok()).collect();
            if channels == 1 {
                raw
            } else {
                raw.chunks(channels)
                    .map(|c| c.iter().sum::<f32>() / (channels as f32))
                    .collect()
            }
        }
        SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            let max_val = match bits {
                1..=16 => 32768.0f32,
                17..=24 => 8388608.0f32,
                _ => 2147483648.0f32,
            };
            let raw: Vec<f32> = reader
                .samples::<i32>()
                .filter_map(|s| s.ok())
                .map(|s| (s as f32) / max_val)
                .collect();
            if channels == 1 {
                raw
            } else {
                raw.chunks(channels)
                    .map(|c| c.iter().sum::<f32>() / (channels as f32))
                    .collect()
            }
        }
    };

    Ok(MonoAudioBuffer {
        samples,
        sample_rate: spec.sample_rate,
    })
}

pub fn save_mono_wav_24bit<P: AsRef<Path>>(
    path: P,
    samples: &[f32],
    sample_rate: u32,
) -> Result<(), String> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 24,
        sample_format: SampleFormat::Int,
    };

    let mut writer = WavWriter::create(path.as_ref(), spec)
        .map_err(|e| format!("Не удалось создать WAV файл {:?}: {}", path.as_ref(), e))?;

    for &sample in samples {
        let clamped = sample.max(-1.0).min(1.0);
        let sample_i32 = (clamped * 8388607.0) as i32;
        writer
            .write_sample(sample_i32)
            .map_err(|e| format!("Ошибка записи 24-bit сэмпла: {}", e))?;
    }

    writer
        .finalize()
        .map_err(|e| format!("Ошибка финализации WAV: {}", e))?;

    Ok(())
}

// ============================================================================
// УРОВЕНЬ 1: GCC-PHAT (Generalized Cross-Correlation with Phase Transform)
// ============================================================================

/// Расчет сдвига старта фразы в миллисекундах и сэмплах через фазовую трансформированную корреляцию
pub fn calculate_gcc_phat_lag(
    orig: &[f32],
    dub: &[f32],
    sample_rate: u32,
    max_search_offset_ms: f64,
) -> (f64, i64, f32) {
    if orig.is_empty() || dub.is_empty() || sample_rate == 0 {
        return (0.0, 0, 0.0);
    }

    let max_analyze_samples = (sample_rate as usize * 8).min(orig.len().max(dub.len()));
    let orig_len = orig.len().min(max_analyze_samples);
    let dub_len = dub.len().min(max_analyze_samples);

    let total_len = orig_len + dub_len;
    let fft_size = total_len.next_power_of_two().max(2048);

    let mut planner = FftPlanner::<f32>::new();
    let fft_forward = planner.plan_fft_forward(fft_size);
    let fft_inverse = planner.plan_fft_inverse(fft_size);

    let mut orig_fft: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); fft_size];
    let mut dub_fft: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); fft_size];

    for (i, &s) in orig[..orig_len].iter().enumerate() {
        let w = 0.5 * (1.0 - (2.0 * PI * (i as f32) / (orig_len as f32 - 1.0)).cos());
        orig_fft[i] = Complex::new(s * w, 0.0);
    }

    for (i, &s) in dub[..dub_len].iter().enumerate() {
        let w = 0.5 * (1.0 - (2.0 * PI * (i as f32) / (dub_len as f32 - 1.0)).cos());
        dub_fft[i] = Complex::new(s * w, 0.0);
    }

    fft_forward.process(&mut orig_fft);
    fft_forward.process(&mut dub_fft);

    let mut cross_spectrum: Vec<Complex<f32>> = Vec::with_capacity(fft_size);
    let eps = 1e-6f32;

    for i in 0..fft_size {
        let c = orig_fft[i] * dub_fft[i].conj();
        let mag = (c.re * c.re + c.im * c.im).sqrt() + eps;
        cross_spectrum.push(Complex::new(c.re / mag, c.im / mag));
    }

    fft_inverse.process(&mut cross_spectrum);

    let norm_factor = 1.0 / (fft_size as f32);
    let gcc_corr: Vec<f32> = cross_spectrum.iter().map(|c| c.re * norm_factor).collect();

    let max_lag_samples = ((max_search_offset_ms / 1000.0) * (sample_rate as f64)).round() as i64;
    let max_lag_samples = max_lag_samples.min((fft_size / 2) as i64);

    let mut best_lag_samples: i64 = 0;
    let mut max_val: f32 = -1.0;

    for lag in -max_lag_samples..=max_lag_samples {
        let idx = if lag >= 0 {
            lag as usize
        } else {
            (fft_size as i64 + lag) as usize
        };

        if idx < gcc_corr.len() {
            let val = gcc_corr[idx].abs();
            if val > max_val {
                max_val = val;
                best_lag_samples = lag;
            }
        }
    }

    let mean_corr: f32 = gcc_corr.iter().map(|v| v.abs()).sum::<f32>() / (gcc_corr.len() as f32);
    let peak_to_noise = if mean_corr > 1e-6 {
        (max_val / mean_corr) / 25.0
    } else {
        0.0
    };
    let score = peak_to_noise.min(1.0).max(0.0);
    let lag_ms = (best_lag_samples as f64 / sample_rate as f64) * 1000.0;

    (lag_ms, best_lag_samples, score)
}

// ============================================================================
// УРОВЕНЬ 2: VAD И ВЫДЕЛЕНИЕ ГЛАСНЫХ ЯДЕР (Vowel Kernels)
// ============================================================================

#[derive(Debug, Clone)]
pub struct VadFrameInfo {
    pub is_speech: bool,
    pub is_vowel_kernel: bool,
    pub rms_energy: f32,
    pub zero_crossing_rate: f32,
    pub spectral_centroid: f32,
}

/// Анализ голосовой активности (VAD) и классификация гласных ядер вокальной речи
pub fn analyze_vad_and_vowels(
    samples: &[f32],
    sample_rate: u32,
    win_size: usize,
    hop_size: usize,
) -> Vec<VadFrameInfo> {
    if samples.is_empty() || win_size == 0 || hop_size == 0 {
        return Vec::new();
    }

    let num_frames = if samples.len() >= win_size {
        (samples.len() - win_size) / hop_size + 1
    } else {
        1
    };

    let fft_size = win_size.next_power_of_two();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_size);

    let mut frames_info = Vec::with_capacity(num_frames);

    let mut max_energy = 1e-6f32;
    let mut temp_frames = Vec::with_capacity(num_frames);

    for i in 0..num_frames {
        let start = i * hop_size;
        let end = (start + win_size).min(samples.len());
        let frame = &samples[start..end];

        let sum_sq: f32 = frame.iter().map(|&s| s * s).sum();
        let rms = (sum_sq / (frame.len() as f32)).sqrt();
        if rms > max_energy {
            max_energy = rms;
        }

        let mut zcr_count = 0;
        for j in 1..frame.len() {
            if (frame[j] >= 0.0 && frame[j - 1] < 0.0) || (frame[j] < 0.0 && frame[j - 1] >= 0.0) {
                zcr_count += 1;
            }
        }
        let zcr = zcr_count as f32 / (frame.len() as f32);

        let mut fft_buf: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); fft_size];
        for (j, &s) in frame.iter().enumerate() {
            let w = 0.54 - 0.46 * (2.0 * PI * (j as f32) / (win_size as f32 - 1.0)).cos();
            fft_buf[j] = Complex::new(s * w, 0.0);
        }
        fft.process(&mut fft_buf);

        let half_len = fft_size / 2;
        let bin_freq = (sample_rate as f32) / (fft_size as f32);

        let mut weighted_freq_sum = 0.0f32;
        let mut total_mag = 0.0f32;

        for k in 0..half_len {
            let mag = (fft_buf[k].re * fft_buf[k].re + fft_buf[k].im * fft_buf[k].im).sqrt();
            let freq = k as f32 * bin_freq;
            weighted_freq_sum += freq * mag;
            total_mag += mag;
        }

        let spectral_centroid = if total_mag > 1e-6 {
            weighted_freq_sum / total_mag
        } else {
            0.0
        };

        temp_frames.push((rms, zcr, spectral_centroid));
    }

    let energy_thresh = (max_energy * 0.08).max(0.008);

    for (rms, zcr, centroid) in temp_frames {
        let is_speech = rms > energy_thresh;
        // Гласные ядра (Vowel Kernels): высокая RMS энергия, низкий ZCR (<0.32), спектральный центроид в диапазоне 300..3500 Гц
        let is_vowel_kernel = is_speech && zcr < 0.32 && centroid >= 250.0 && centroid <= 3600.0;

        frames_info.push(VadFrameInfo {
            is_speech,
            is_vowel_kernel,
            rms_energy: rms,
            zero_crossing_rate: zcr,
            spectral_centroid: centroid,
        });
    }

    frames_info
}

// ============================================================================
// 3. MFCC ВЕКТОРНЫЕ ПРИЗНАКИ И FAST-DTW
// ============================================================================

/// Извлечение MFCC признаков (Mel-Frequency Cepstral Coefficients) для кадра
pub fn extract_mfcc_features(
    samples: &[f32],
    sample_rate: u32,
    win_size: usize,
    hop_size: usize,
    num_mel_filters: usize,
    num_cepstral_coeffs: usize,
) -> Vec<Vec<f32>> {
    let num_frames = if samples.len() >= win_size {
        (samples.len() - win_size) / hop_size + 1
    } else {
        1
    };

    let fft_size = win_size.next_power_of_two();
    let half_fft = fft_size / 2;

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_size);

    let hz_to_mel = |hz: f32| 2595.0 * (1.0 + hz / 700.0).log10();
    let mel_to_hz = |mel: f32| 700.0 * (10.0f32.powf(mel / 2595.0) - 1.0);

    let mel_min = hz_to_mel(80.0);
    let mel_max = hz_to_mel((sample_rate as f32) / 2.0);

    let mut mel_points = Vec::with_capacity(num_mel_filters + 2);
    for i in 0..=(num_mel_filters + 1) {
        let m = mel_min + (i as f32 / (num_mel_filters + 1) as f32) * (mel_max - mel_min);
        mel_points.push(mel_to_hz(m));
    }

    let mut bin_indices = Vec::with_capacity(num_mel_filters + 2);
    for hz in mel_points {
        let b = ((fft_size as f32 + 1.0) * hz / (sample_rate as f32)).floor() as usize;
        bin_indices.push(b.min(half_fft));
    }

    let mut feature_matrix = Vec::with_capacity(num_frames);

    for i in 0..num_frames {
        let start = i * hop_size;
        let end = (start + win_size).min(samples.len());
        let frame = &samples[start..end];

        let mut fft_buf: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); fft_size];
        for (j, &s) in frame.iter().enumerate() {
            let w = 0.54 - 0.46 * (2.0 * PI * (j as f32) / (win_size as f32 - 1.0)).cos();
            let preemph = if j > 0 { s - 0.97 * frame[j - 1] } else { s };
            fft_buf[j] = Complex::new(preemph * w, 0.0);
        }
        fft.process(&mut fft_buf);

        let mut power_spectrum = vec![0.0f32; half_fft];
        for k in 0..half_fft {
            let mag = (fft_buf[k].re * fft_buf[k].re + fft_buf[k].im * fft_buf[k].im).sqrt();
            power_spectrum[k] = (mag * mag) / (fft_size as f32);
        }

        let mut filter_energies = vec![0.0f32; num_mel_filters];
        for m in 1..=num_mel_filters {
            let b_prev = bin_indices[m - 1];
            let b_curr = bin_indices[m];
            let b_next = bin_indices[m + 1];

            for k in b_prev..b_curr {
                if b_curr > b_prev {
                    let weight = (k - b_prev) as f32 / (b_curr - b_prev) as f32;
                    filter_energies[m - 1] += power_spectrum[k] * weight;
                }
            }
            for k in b_curr..b_next {
                if b_next > b_curr {
                    let weight = (b_next - k) as f32 / (b_next - b_curr) as f32;
                    filter_energies[m - 1] += power_spectrum[k] * weight;
                }
            }
        }

        let mut mfcc = vec![0.0f32; num_cepstral_coeffs];
        for c in 0..num_cepstral_coeffs {
            let mut sum = 0.0f32;
            for m in 0..num_mel_filters {
                let log_e = (filter_energies[m] + 1e-6).ln();
                sum += log_e * (PI * (c as f32) * (m as f32 + 0.5) / (num_mel_filters as f32)).cos();
            }
            mfcc[c] = sum;
        }

        let frame_energy: f32 = frame.iter().map(|s| s * s).sum::<f32>().sqrt();
        mfcc.push((frame_energy + 1e-6).ln());

        feature_matrix.push(mfcc);
    }

    feature_matrix
}

/// Алгоритм FastDTW по MFCC признакам с выделением гласных ядер
pub fn compute_fast_dtw_mfcc(
    orig_features: &[Vec<f32>],
    dub_features: &[Vec<f32>],
    orig_vowels: &[bool],
    dub_vowels: &[bool],
    hop_ms: f64,
) -> (f32, Vec<DtwPoint>) {
    let n = orig_features.len();
    let m = dub_features.len();

    if n == 0 || m == 0 {
        return (0.0, Vec::new());
    }

    let feat_dim = orig_features[0].len().min(dub_features[0].len());
    let mut dtw = vec![f32::INFINITY; (n + 1) * (m + 1)];
    let get_idx = |i: usize, j: usize| i * (m + 1) + j;

    dtw[get_idx(0, 0)] = 0.0;
    let window_drift = ((n.max(m) as f64) * 0.35).ceil() as usize;

    for i in 1..=n {
        let j_start = 1.max(if i > window_drift { i - window_drift } else { 1 });
        let j_end = m.min(i + window_drift);

        for j in j_start..=j_end {
            let mut dist_sq = 0.0f32;
            for k in 0..feat_dim {
                let diff = orig_features[i - 1][k] - dub_features[j - 1][k];
                dist_sq += diff * diff;
            }
            let mut cost = dist_sq.sqrt();

            let orig_is_vowel = orig_vowels.get(i - 1).cloned().unwrap_or(false);
            let dub_is_vowel = dub_vowels.get(j - 1).cloned().unwrap_or(false);

            if !orig_is_vowel && !dub_is_vowel {
                cost *= 0.2;
            } else if orig_is_vowel != dub_is_vowel {
                cost *= 1.8;
            }

            let match_cost = dtw[get_idx(i - 1, j - 1)];
            let insert_cost = dtw[get_idx(i - 1, j)];
            let delete_cost = dtw[get_idx(i, j - 1)];

            let min_prev = match_cost.min(insert_cost).min(delete_cost);
            if min_prev.is_finite() {
                dtw[get_idx(i, j)] = cost + min_prev;
            }
        }
    }

    let total_cost = dtw[get_idx(n, m)];
    let norm_dist = if (n + m) > 0 { total_cost / ((n + m) as f32) } else { 0.0 };

    let mut path = Vec::new();
    let mut i = n;
    let mut j = m;

    while i > 0 && j > 0 {
        let orig_time = (i - 1) as f64 * hop_ms;
        let dub_time = (j - 1) as f64 * hop_ms;
        let is_vowel = orig_vowels.get(i - 1).cloned().unwrap_or(false)
            || dub_vowels.get(j - 1).cloned().unwrap_or(false);

        path.push(DtwPoint {
            orig_index: i - 1,
            dub_index: j - 1,
            orig_time_ms: orig_time,
            dub_time_ms: dub_time,
            cost: dtw[get_idx(i, j)],
            is_vowel,
        });

        let diag = dtw[get_idx(i - 1, j - 1)];
        let up = dtw[get_idx(i - 1, j)];
        let left = dtw[get_idx(i, j - 1)];

        if diag <= up && diag <= left {
            i -= 1;
            j -= 1;
        } else if up <= left {
            i -= 1;
        } else {
            j -= 1;
        }
    }

    path.reverse();
    (norm_dist, path)
}

// ============================================================================
// 4. АЛГОРИТМ РЕСИНТЕЗА WSOLA (WAVEFORM SIMILARITY OVERLAP-ADD)
// ============================================================================

/// Поиск позиции с максимальной фазовой автокорреляцией формы волны
fn find_best_wsola_offset(
    input: &[f32],
    target_pos: usize,
    prev_pos: usize,
    win_size: usize,
    search_range: usize,
) -> usize {
    let mut best_offset = target_pos;
    let mut max_corr = f32::MIN;

    let start_search = target_pos.saturating_sub(search_range);
    let end_search = (target_pos + search_range).min(input.len().saturating_sub(win_size));

    let prev_end = (prev_pos + win_size).min(input.len());
    let prev_frame = &input[prev_pos..prev_end];

    for candidate_pos in start_search..=end_search {
        let candidate_end = candidate_pos + prev_frame.len();
        if candidate_end > input.len() {
            break;
        }

        let cand_frame = &input[candidate_pos..candidate_end];
        let mut corr = 0.0f32;
        for j in 0..prev_frame.len() {
            corr += prev_frame[j] * cand_frame[j];
        }

        if corr > max_corr {
            max_corr = corr;
            best_offset = candidate_pos;
        }
    }

    best_offset
}

/// Стандартное растяжение WSOLA без маски гласных
pub fn wsola_time_stretch(samples: &[f32], target_ratio: f64, sample_rate: u32) -> Vec<f32> {
    let vowel_mask = vec![true; samples.len()];
    let (stretched, _) = wsola_time_stretch_vowel_selective(samples, &vowel_mask, target_ratio, sample_rate, 10.0);
    stretched
}

/// Ресинтез WSOLA с адаптивным сохранением пауз/вдохов и лимитом 0.85x..1.18x
pub fn wsola_time_stretch_vowel_selective(
    samples: &[f32],
    vowel_mask: &[bool],
    target_ratio: f64,
    sample_rate: u32,
    hop_ms: f64,
) -> (Vec<f32>, bool) {
    let bounded_ratio = target_ratio.max(0.85).min(1.18);
    let was_clamped = (target_ratio - bounded_ratio).abs() > 0.02;

    if samples.is_empty() || (bounded_ratio - 1.0).abs() < 0.005 {
        return (samples.to_vec(), was_clamped);
    }

    let win_size = ((sample_rate as f64) * 0.025).round() as usize;
    let win_size = (win_size / 2) * 2;
    let hop_out = win_size / 2;
    let search_range = win_size / 2;

    let mut hanning_window = vec![0.0f32; win_size];
    for i in 0..win_size {
        hanning_window[i] = 0.5 * (1.0 - (2.0 * PI * (i as f32) / (win_size as f32 - 1.0)).cos());
    }

    let estimated_out_len = ((samples.len() as f64) / bounded_ratio).ceil() as usize + win_size * 2;
    let mut output = vec![0.0f32; estimated_out_len];
    let mut weight_sum = vec![0.0f32; estimated_out_len];

    let mut in_pos = 0usize;
    let mut out_pos = 0usize;
    let mut prev_natural_pos = 0usize;

    if samples.len() >= win_size {
        for i in 0..win_size {
            output[i] += samples[i] * hanning_window[i];
            weight_sum[i] += hanning_window[i];
        }
        prev_natural_pos = hop_out;
        in_pos = hop_out;
        out_pos = hop_out;
    }

    let samples_per_frame = ((sample_rate as f64 * hop_ms) / 1000.0).round() as usize;

    while in_pos + win_size + search_range < samples.len() {
        let frame_idx = (in_pos / samples_per_frame.max(1)).min(vowel_mask.len().saturating_sub(1));
        let is_vowel = vowel_mask.get(frame_idx).cloned().unwrap_or(false);

        // Паузы и вдохи НЕ растягиваются (растяжение 1.0x), растягиваются только гласные ядра
        let frame_ratio = if is_vowel { bounded_ratio } else { 1.0 };
        let hop_in = ((hop_out as f64) * frame_ratio).round() as usize;

        let best_in = find_best_wsola_offset(
            samples,
            in_pos,
            prev_natural_pos,
            win_size,
            search_range,
        );

        let end_idx = (out_pos + win_size).min(output.len());
        let copy_len = end_idx - out_pos;

        for i in 0..copy_len {
            let sample_val = samples[best_in + i];
            let w = hanning_window[i];
            output[out_pos + i] += sample_val * w;
            weight_sum[out_pos + i] += w;
        }

        prev_natural_pos = best_in + hop_out;
        in_pos += hop_in.max(1);
        out_pos += hop_out;
    }

    let final_len = out_pos.min(output.len());
    let mut final_output = Vec::with_capacity(final_len);

    for i in 0..final_len {
        let w = weight_sum[i];
        if w > 1e-4 {
            final_output.push((output[i] / w).max(-1.0).min(1.0));
        } else {
            final_output.push(output[i].max(-1.0).min(1.0));
        }
    }

    (final_output, was_clamped)
}

// ============================================================================
// 5. ОСНОВНОЙ МОДУЛЬ СИНХРОНИЗАЦИИ (Smart Align Execution Engine)
// ============================================================================

pub fn perform_smart_alignment_analysis(
    orig_samples: &[f32],
    dub_samples: &[f32],
    sample_rate: u32,
    original_path: &str,
    dub_path: &str,
    output_path: &str,
    config: Option<SmartAlignConfig>,
) -> Result<AlignmentResult, String> {
    let cfg = config.unwrap_or_default();
    let max_search_ms = cfg.max_search_offset_ms.unwrap_or(2000.0);
    let hop_ms = cfg.dtw_hop_size_ms.unwrap_or(10.0);
    let win_ms = cfg.dtw_window_size_ms.unwrap_or(25.0);
    let max_dev_limit = cfg.max_deviation_limit_percent.unwrap_or(20.0);

    let orig_dur_ms = (orig_samples.len() as f64 / sample_rate as f64) * 1000.0;
    let dub_dur_ms = (dub_samples.len() as f64 / sample_rate as f64) * 1000.0;

    // 1. Уровень 1: GCC-PHAT
    let (lag_ms, lag_samples, correlation_score) =
        calculate_gcc_phat_lag(orig_samples, dub_samples, sample_rate, max_search_ms);

    let win_size = ((sample_rate as f64 * win_ms / 1000.0).round() as usize).max(64);
    let hop_size = ((sample_rate as f64 * hop_ms / 1000.0).round() as usize).max(32);

    // 2. Уровень 2: VAD & Vowel Kernels
    let orig_vad = analyze_vad_and_vowels(orig_samples, sample_rate, win_size, hop_size);
    let dub_vad = analyze_vad_and_vowels(dub_samples, sample_rate, win_size, hop_size);

    let orig_vowels: Vec<bool> = orig_vad.iter().map(|v| v.is_vowel_kernel).collect();
    let dub_vowels: Vec<bool> = dub_vad.iter().map(|v| v.is_vowel_kernel).collect();

    // 3. FastDTW по MFCC признакам
    let orig_mfcc = extract_mfcc_features(orig_samples, sample_rate, win_size, hop_size, 20, 12);
    let dub_mfcc = extract_mfcc_features(dub_samples, sample_rate, win_size, hop_size, 20, 12);

    let (dtw_distance, dtw_path) =
        compute_fast_dtw_mfcc(&orig_mfcc, &dub_mfcc, &orig_vowels, &dub_vowels, hop_ms);

    // 4. Сегментная подгонка фразы
    let num_segments = ((orig_dur_ms / 400.0).round() as usize).max(3).min(12);
    let segment_dur = orig_dur_ms / (num_segments as f64);
    let mut segment_adjustments = Vec::with_capacity(num_segments);

    for seg_idx in 0..num_segments {
        let seg_orig_start = seg_idx as f64 * segment_dur;
        let seg_orig_end = ((seg_idx + 1) as f64 * segment_dur).min(orig_dur_ms);

        let start_point = dtw_path
            .iter()
            .find(|p| p.orig_time_ms >= seg_orig_start)
            .unwrap_or(&dtw_path[0]);

        let end_point = dtw_path
            .iter()
            .rfind(|p| p.orig_time_ms <= seg_orig_end)
            .unwrap_or(dtw_path.last().unwrap());

        let seg_dub_start = start_point.dub_time_ms;
        let seg_dub_end = end_point.dub_time_ms.max(seg_dub_start + 1.0);

        let orig_segment_dur = (seg_orig_end - seg_orig_start).max(1.0);
        let dub_segment_dur = (seg_dub_end - seg_dub_start).max(1.0);

        let stretch_ratio = orig_segment_dur / dub_segment_dur;
        let deviation_percent = (stretch_ratio - 1.0).abs() * 100.0;

        let frame_start_idx = (seg_orig_start / hop_ms) as usize;
        let is_vowel_kernel = orig_vowels.get(frame_start_idx).cloned().unwrap_or(false);

        segment_adjustments.push(SegmentAdjustment {
            segment_index: seg_idx,
            orig_start_ms: (seg_orig_start * 10.0).round() / 10.0,
            orig_end_ms: (seg_orig_end * 10.0).round() / 10.0,
            dub_start_ms: (seg_dub_start * 10.0).round() / 10.0,
            dub_end_ms: (seg_dub_end * 10.0).round() / 10.0,
            time_stretch_ratio: (stretch_ratio * 1000.0).round() / 1000.0,
            pitch_shift_semitones: 0.0,
            energy_similarity: (1.0 - start_point.cost.min(1.0)),
            deviation_percent: (deviation_percent * 10.0).round() / 10.0,
            is_vowel_kernel,
        });
    }

    let overall_ratio = if dub_dur_ms > 0.0 { orig_dur_ms / dub_dur_ms } else { 1.0 };
    let max_seg_dev = segment_adjustments
        .iter()
        .map(|s| s.deviation_percent)
        .fold(0.0f64, f64::max);

    let overall_dev = (overall_ratio - 1.0).abs() * 100.0;
    let max_deviation_percent = max_seg_dev.max(overall_dev);

    // Если расхождение > 20%, требуется ручная синхронизация
    let manual_sync_required = max_deviation_percent > max_dev_limit || overall_ratio < 0.80 || overall_ratio > 1.20;
    let requires_actor_re_recording = manual_sync_required;

    let warning_message = if manual_sync_required {
        Some(format!(
            "Расхождение темпа реплики составляет {:.1}% (порог {:.1}%). Установлен флаг manual_sync_required.",
            max_deviation_percent, max_dev_limit
        ))
    } else {
        None
    };

    Ok(AlignmentResult {
        original_path: original_path.to_string(),
        dub_path: dub_path.to_string(),
        output_path: output_path.to_string(),
        original_duration_ms: (orig_dur_ms * 10.0).round() / 10.0,
        dub_duration_ms: (dub_dur_ms * 10.0).round() / 10.0,
        output_duration_ms: (dub_dur_ms * 10.0).round() / 10.0,
        detected_offset_ms: (lag_ms * 10.0).round() / 10.0,
        offset_shift_ms: (lag_ms * 10.0).round() / 10.0,
        stretch_ratio: (overall_ratio * 1000.0).round() / 1000.0,
        correlation_score: (correlation_score * 100.0).round() / 100.0,
        sample_rate,
        was_stretched: (overall_ratio - 1.0).abs() > 0.02,
        manual_sync_required,
        requires_actor_re_recording,
        warning_message,
        segment_adjustments,
        dtw_distance: (dtw_distance * 1000.0).round() / 1000.0,
        original_cue_id: Some(original_path.to_string()),
        dub_cue_id: Some(dub_path.to_string()),
        detected_lag_ms: Some((lag_ms * 10.0).round() / 10.0),
        detected_lag_samples: Some(lag_samples),
        average_stretch_ratio: Some((overall_ratio * 1000.0).round() / 1000.0),
        max_deviation_percent: Some((max_deviation_percent * 10.0).round() / 10.0),
    })
}

// ============================================================================
// TAURI V2 КОМАНДЫ
// ============================================================================

/// Tauri V2 Команда вычисления смарт-выравнивания дубляжа с оригиналом
#[command]
pub async fn calculate_smart_alignment(
    _app: AppHandle,
    cache_state: State<'_, AudioBufferCache>,
    original_path: Option<String>,
    dub_path: Option<String>,
    output_path: Option<String>,
    original_cue_id: Option<String>,
    dub_cue_id: Option<String>,
    config: Option<SmartAlignConfig>,
) -> Result<AlignmentResult, String> {
    let orig_str = original_path
        .or(original_cue_id)
        .ok_or_else(|| "Укажите путь к оригинальному аудио (original_path)".to_string())?;

    let dub_str = dub_path
        .or(dub_cue_id)
        .ok_or_else(|| "Укажите путь к дубляжу (dub_path)".to_string())?;

    let out_str = output_path.unwrap_or_else(|| dub_str.clone());

    let cache_opt = Some(cache_state.inner().clone());

    tokio::task::spawn_blocking(move || {
        let orig_buf = resolve_audio_samples(&orig_str, cache_opt.as_ref())
            .map_err(|e| format!("Ошибка загрузки оригинала: {}", e))?;
        let dub_buf = resolve_audio_samples(&dub_str, cache_opt.as_ref())
            .map_err(|e| format!("Ошибка загрузки дубляжа: {}", e))?;

        let sample_rate = orig_buf.sample_rate.min(dub_buf.sample_rate);

        perform_smart_alignment_analysis(
            &orig_buf.samples,
            &dub_buf.samples,
            sample_rate,
            &orig_str,
            &dub_str,
            &out_str,
            config,
        )
    })
    .await
    .map_err(|e| format!("Ошибка выполнения фоновой задачи Smart Align: {}", e))?
}

/// Выравнивание и сохранение готового аудиоклипа на диск
#[command]
pub async fn align_vocal_clip(
    _app: AppHandle,
    cache_state: State<'_, AudioBufferCache>,
    original_clip_path: String,
    dubbed_clip_path: String,
    output_path: String,
    config: Option<SmartAlignConfig>,
) -> Result<AlignResult, String> {
    let orig_path = original_clip_path.clone();
    let dub_path = dubbed_clip_path.clone();
    let out_path = output_path.clone();
    let cfg = config.unwrap_or_default();
    let cache_opt = Some(cache_state.inner().clone());

    tokio::task::spawn_blocking(move || {
        let orig_audio = resolve_audio_samples(&orig_path, cache_opt.as_ref())?;
        let dub_audio = resolve_audio_samples(&dub_path, cache_opt.as_ref())?;

        let sample_rate = dub_audio.sample_rate;
        let orig_samples = orig_audio.samples;
        let dub_samples = dub_audio.samples;

        let mut alignment_res = perform_smart_alignment_analysis(
            &orig_samples,
            &dub_samples,
            sample_rate,
            &orig_path,
            &dub_path,
            &out_path,
            Some(cfg.clone()),
        )?;

        let win_size = ((sample_rate as f64 * 25.0 / 1000.0).round() as usize).max(64);
        let hop_size = ((sample_rate as f64 * 10.0 / 1000.0).round() as usize).max(32);
        let dub_vad = analyze_vad_and_vowels(&dub_samples, sample_rate, win_size, hop_size);
        let dub_vowels: Vec<bool> = dub_vad.iter().map(|v| v.is_vowel_kernel).collect();

        let (processed_samples, was_clamped) = wsola_time_stretch_vowel_selective(
            &dub_samples,
            &dub_vowels,
            alignment_res.stretch_ratio,
            sample_rate,
            10.0,
        );

        if was_clamped {
            alignment_res.manual_sync_required = true;
            alignment_res.requires_actor_re_recording = true;
        }

        save_mono_wav_24bit(&out_path, &processed_samples, sample_rate)?;

        let out_dur_ms = (processed_samples.len() as f64 / sample_rate as f64) * 1000.0;
        alignment_res.output_duration_ms = (out_dur_ms * 10.0).round() / 10.0;
        alignment_res.was_stretched = true;

        Ok(alignment_res)
    })
    .await
    .map_err(|e| format!("Ошибка задачи align_vocal_clip: {}", e))?
}

// ============================================================================
// UNIT-ТЕСТЫ
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gcc_phat_zero_lag() {
        let sample_rate = 48000;
        let mut sig = Vec::with_capacity(4800);
        for i in 0..4800 {
            let t = (i as f32) / (sample_rate as f32);
            sig.push((2.0 * PI * 440.0 * t).sin() * 0.8);
        }

        let (lag_ms, lag_samples, score) = calculate_gcc_phat_lag(&sig, &sig, sample_rate, 500.0);
        assert_eq!(lag_samples, 0);
        assert_eq!(lag_ms, 0.0);
        assert!(score > 0.5);
    }

    #[test]
    fn test_mfcc_extraction() {
        let sample_rate = 48000;
        let mut sig = vec![0.0f32; 4800];
        for i in 0..4800 {
            sig[i] = (2.0 * PI * 1000.0 * (i as f32 / 48000.0)).sin();
        }

        let mfcc = extract_mfcc_features(&sig, sample_rate, 1200, 480, 20, 12);
        assert!(!mfcc.is_empty());
        assert_eq!(mfcc[0].len(), 13); // 12 coeffs + energy
    }

    #[test]
    fn test_wsola_bounded_stretch() {
        let samples = vec![0.5f32; 4800];
        let vowels = vec![true; 100];
        let (stretched, clamped) = wsola_time_stretch_vowel_selective(&samples, &vowels, 1.10, 48000, 10.0);
        assert!(!stretched.is_empty());
        assert!(!clamped);

        let (_, clamped_extreme) = wsola_time_stretch_vowel_selective(&samples, &vowels, 1.40, 48000, 10.0);
        assert!(clamped_extreme);
    }
}
