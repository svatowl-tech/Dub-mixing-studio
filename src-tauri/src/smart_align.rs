// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE SMART ALIGN & DTW ENGINE (RUST)
// Модуль сопоставления таймингов дубляжа, GCC-PHAT кросс-корреляции и DTW
// Стек: rustfft = "6.2.0", hound = "3.5.1", rayon = "1.10.0", tauri = "2.11"
// ============================================================================

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;


use tauri::{command, AppHandle, State};

use crate::audio_buffer_manager::AudioBufferCache;


// ============================================================================
// СТРУКТУРЫ ДАННЫХ И ТИПЫ ВОЗВРАТА (TypeScript-совместимые структуры)
// ============================================================================

/// Точка деформации времени в оптимальном пути DTW
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DtwPoint {
    pub orig_index: usize,
    pub dub_index: usize,
    pub orig_time_ms: f64,
    pub dub_time_ms: f64,
    pub cost: f32,
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
}

/// Итоговая структура подгонки таймингов (Alignment Adjustment)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentAdjustment {
    pub original_cue_id: String,
    pub dub_cue_id: String,
    pub detected_lag_ms: f64,
    pub detected_lag_samples: i64,
    pub correlation_score: f32,
    pub average_stretch_ratio: f64,
    pub max_deviation_percent: f64,
    pub requires_actor_re_recording: bool,
    pub warning_message: Option<String>,
    pub segment_adjustments: Vec<SegmentAdjustment>,
    pub dtw_distance: f32,
    pub sample_rate: u32,
    pub original_duration_ms: f64,
    pub dub_duration_ms: f64,
}

/// Результат полного файлового выравнивания вокального клипа (для совместимости)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignResult {
    pub original_path: String,
    pub dubbed_path: String,
    pub output_path: String,
    pub original_duration_ms: f64,
    pub dubbed_duration_ms: f64,
    pub output_duration_ms: f64,
    pub detected_offset_ms: f64,
    pub stretch_ratio: f64,
    pub correlation_score: f32,
    pub sample_rate: u32,
    pub was_stretched: bool,
    pub requires_actor_re_recording: bool,
    pub alignment_adjustment: Option<AlignmentAdjustment>,
}

/// Конфигурация параметров нативного Smart Align
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartAlignConfig {
    pub min_stretch_ratio: Option<f64>,        // e.g. 0.75
    pub max_stretch_ratio: Option<f64>,        // e.g. 1.25
    pub stretch_threshold_percent: Option<f64>, // e.g. 15.0%
    pub max_deviation_limit_percent: Option<f64>, // e.g. 25.0% (порог флага requires_actor_re_recording)
    pub align_offset: Option<bool>,            // true
    pub max_search_offset_ms: Option<f64>,     // e.g. 2000.0 ms
    pub dtw_hop_size_ms: Option<f64>,          // e.g. 10.0 ms
    pub dtw_window_size_ms: Option<f64>,       // e.g. 25.0 ms
}

impl Default for SmartAlignConfig {
    fn default() -> Self {
        Self {
            min_stretch_ratio: Some(0.75),
            max_stretch_ratio: Some(1.25),
            stretch_threshold_percent: Some(15.0),
            max_deviation_limit_percent: Some(25.0),
            align_offset: Some(true),
            max_search_offset_ms: Some(2000.0),
            dtw_hop_size_ms: Some(10.0),
            dtw_window_size_ms: Some(25.0),
        }
    }
}

// ============================================================================
// ЗАГРУЗКА АУДИО И ИЗВЛЕЧЕНИЕ СЭМПЛОВ
// ============================================================================

/// Внутренний аудио-буфер моно f32
pub struct MonoAudioBuffer {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// Загрузка аудио как моно f32 из пути к файлу или ID аудиобуфера в кэше
pub fn resolve_audio_samples(
    buffer_id_or_path: &str,
    cache: Option<&AudioBufferCache>,
) -> Result<MonoAudioBuffer, String> {
    // 1. Попытка получить из кэша
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

        // Поиск по пути в кэше
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

    // 2. Чтение напрямую из WAV файла на диске
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

/// Сохранение моно f32 в 24-bit PCM WAV
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
// 1. АЛГОРИТМ GCC-PHAT (Generalized Cross-Correlation with Phase Transform)
// ============================================================================

/// Вычисляет точный временной лаг (в миллисекундах и сэмплах) между двумя сигналами
/// с использованием FFT и фазовой нормализации (PHAT weighting).
/// Фазовая трансформация устраняет амплитудную зависимость и различия тембров/микрофонов.
pub fn calculate_gcc_phat_lag(
    orig: &[f32],
    dub: &[f32],
    sample_rate: u32,
    max_search_offset_ms: f64,
) -> (f64, i64, f32) {
    if orig.is_empty() || dub.is_empty() || sample_rate == 0 {
        return (0.0, 0, 0.0);
    }

    // Для быстрого и точного нахождения лага ограничиваем сигналы анализом начала фразы (до 8 секунд)
    let max_analyze_samples = (sample_rate as usize * 8).min(orig.len().max(dub.len()));
    let orig_len = orig.len().min(max_analyze_samples);
    let dub_len = dub.len().min(max_analyze_samples);

    // Минимальный размер БПФ (следующая степень двойки от суммы длин для линейной корреляции)
    let total_len = orig_len + dub_len;
    let fft_size = total_len.next_power_of_two().max(2048);

    let mut planner = FftPlanner::<f32>::new();
    let fft_forward = planner.plan_fft_forward(fft_size);
    let fft_inverse = planner.plan_fft_inverse(fft_size);

    // Подготовка комплексных буферов
    let mut orig_fft: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); fft_size];
    let mut dub_fft: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); fft_size];

    // Применяем окно Хэннинга на входные срезы для устранения краевых скачков
    for (i, &s) in orig[..orig_len].iter().enumerate() {
        let w = 0.5 * (1.0 - (2.0 * PI * (i as f32) / (orig_len as f32 - 1.0)).cos());
        orig_fft[i] = Complex::new(s * w, 0.0);
    }

    for (i, &s) in dub[..dub_len].iter().enumerate() {
        let w = 0.5 * (1.0 - (2.0 * PI * (i as f32) / (dub_len as f32 - 1.0)).cos());
        dub_fft[i] = Complex::new(s * w, 0.0);
    }

    // 1. Прямое БПФ для обоих сигналов
    fft_forward.process(&mut orig_fft);
    fft_forward.process(&mut dub_fft);

    // 2. Кросс-спектральная плотность с фазовой нормализацией GCC-PHAT:
    // G_phat(f) = (X1(f) * conj(X2(f))) / (|X1(f) * conj(X2(f))| + eps)
    let mut cross_spectrum: Vec<Complex<f32>> = Vec::with_capacity(fft_size);
    let eps = 1e-6f32;

    for i in 0..fft_size {
        let c = orig_fft[i] * dub_fft[i].conj();
        let mag = (c.re * c.re + c.im * c.im).sqrt() + eps;
        cross_spectrum.push(Complex::new(c.re / mag, c.im / mag));
    }

    // 3. Обратное БПФ для получения функции взаимной корреляции (GCC-PHAT)
    fft_inverse.process(&mut cross_spectrum);

    // Нормализуем масштаб IFFT
    let norm_factor = 1.0 / (fft_size as f32);
    let gcc_corr: Vec<f32> = cross_spectrum.iter().map(|c| c.re * norm_factor).collect();

    // 4. Поиск пика в пределах заданного окна задержки max_search_offset_ms
    let max_lag_samples = ((max_search_offset_ms / 1000.0) * (sample_rate as f64)).round() as i64;
    let max_lag_samples = max_lag_samples.min((fft_size / 2) as i64);

    let mut best_lag_samples: i64 = 0;
    let mut max_val: f32 = -1.0;

    // Циклическая корреляция: положительные лаги в [0 .. fft_size/2], отрицательные в [fft_size - max_lag .. fft_size]
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

    // Оценка уверенности корреляции (0.0 .. 1.0)
    let mean_corr: f32 = gcc_corr.iter().map(|v| v.abs()).sum::<f32>() / (gcc_corr.len() as f32);
    let peak_to_noise = if mean_corr > 1e-6 {
        (max_val / mean_corr) / 25.0
    } else {
        0.0
    };
    let score = (peak_to_noise).min(1.0).max(0.0);

    let lag_ms = (best_lag_samples as f64 / sample_rate as f64) * 1000.0;

    (lag_ms, best_lag_samples, score)
}

// ============================================================================
// 2. ДИНАМИЧЕСКОЕ ПРОГРАММИРОВАНИЕ (DTW) ПО ОГИБАЮЩИМ ЭНЕРГИИ
// ============================================================================

/// Извлечение сглаженного логарифмического вектора энергии реплики (Log-RMS Energy Envelope)
pub fn compute_feature_energy_envelope(
    samples: &[f32],
    sample_rate: u32,
    window_ms: f64,
    hop_ms: f64,
) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let win_size = ((sample_rate as f64 * window_ms / 1000.0).round() as usize).max(32);
    let hop_size = ((sample_rate as f64 * hop_ms / 1000.0).round() as usize).max(16);

    let num_frames = if samples.len() >= win_size {
        (samples.len() - win_size) / hop_size + 1
    } else {
        1
    };

    let mut energy_vec = Vec::with_capacity(num_frames);

    for i in 0..num_frames {
        let start = i * hop_size;
        let end = (start + win_size).min(samples.len());
        let frame = &samples[start..end];

        let sum_sq: f32 = frame.iter().map(|&s| s * s).sum();
        let rms = (sum_sq / (frame.len() as f32)).sqrt();

        // Логарифмическая шкала энергии для приближения к восприятию громкости
        let log_energy = (rms + 1e-5).ln();
        energy_vec.push(log_energy);
    }

    // Нормализация вектора энергии к диапазону [0.0 .. 1.0]
    let min_val = energy_vec.iter().cloned().fold(f32::INFINITY, f32::min);
    let max_val = energy_vec.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let range = (max_val - min_val).max(1e-4);

    energy_vec.iter_mut().for_each(|v| {
        *v = (*v - min_val) / range;
    });

    energy_vec
}

/// Вычисление оптимального пути выравнивания (Warping Path) методом DTW
pub fn compute_dynamic_time_warping(
    orig_features: &[f32],
    dub_features: &[f32],
    hop_ms: f64,
) -> (f32, Vec<DtwPoint>) {
    let n = orig_features.len();
    let m = dub_features.len();

    if n == 0 || m == 0 {
        return (0.0, Vec::new());
    }

    // Матрица накопленной стоимости DTW (Cost Matrix)
    // Используем плоский вектор для максимальной производительности в кэше процессора
    let mut dtw = vec![f32::INFINITY; (n + 1) * (m + 1)];
    let get_idx = |i: usize, j: usize| i * (m + 1) + j;

    dtw[get_idx(0, 0)] = 0.0;

    // Ограничение окна Сакое-Чиба (Sakoe-Chiba Band) для предотвращения патологических искажений
    let max_window_drift = ((n.max(m) as f64) * 0.40).ceil() as usize;

    for i in 1..=n {
        let orig_val = orig_features[i - 1];
        let j_start = 1.max(if i > max_window_drift { i - max_window_drift } else { 1 });
        let j_end = m.min(i + max_window_drift);

        for j in j_start..=j_end {
            let dub_val = dub_features[j - 1];
            // Евклидово расстояние между значениями энергии
            let cost = (orig_val - dub_val).abs();

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
    let normalized_distance = if (n + m) > 0 {
        total_cost / ((n + m) as f32)
    } else {
        0.0
    };

    // Обратный ход (Backtracking) для построения оптимального пути
    let mut path = Vec::new();
    let mut i = n;
    let mut j = m;

    while i > 0 && j > 0 {
        let orig_time = (i - 1) as f64 * hop_ms;
        let dub_time = (j - 1) as f64 * hop_ms;
        let cost = (orig_features[i - 1] - dub_features[j - 1]).abs();

        path.push(DtwPoint {
            orig_index: i - 1,
            dub_index: j - 1,
            orig_time_ms: orig_time,
            dub_time_ms: dub_time,
            cost,
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
    (normalized_distance, path)
}

/// Разбиение DTW-пути на локальные сегменты фразы с расчетом Stretch Ratio и отклонений
pub fn calculate_segment_adjustments(
    dtw_path: &[DtwPoint],
    orig_dur_ms: f64,
    _dub_dur_ms: f64,
    num_subsegments: usize,
) -> Vec<SegmentAdjustment> {
    if dtw_path.is_empty() || num_subsegments == 0 {
        return Vec::new();
    }

    let segment_dur = orig_dur_ms / (num_subsegments as f64);
    let mut adjustments = Vec::with_capacity(num_subsegments);

    for seg_idx in 0..num_subsegments {
        let seg_orig_start = seg_idx as f64 * segment_dur;
        let seg_orig_end = ((seg_idx + 1) as f64 * segment_dur).min(orig_dur_ms);

        // Находим соответствующие точки в DTW пути
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

        let orig_segment_duration = (seg_orig_end - seg_orig_start).max(1.0);
        let dub_segment_duration = (seg_dub_end - seg_dub_start).max(1.0);

        // Коэффициент растяжения/сжатия: отношение целевой (оригинальной) длины к дублю
        let stretch_ratio = orig_segment_duration / dub_segment_duration;

        // Отклонение в процентах (|ratio - 1.0| * 100%)
        let deviation_percent = (stretch_ratio - 1.0).abs() * 100.0;

        // Среднее сходство энергии на этом участке
        let matched_costs: Vec<f32> = dtw_path
            .iter()
            .filter(|p| p.orig_time_ms >= seg_orig_start && p.orig_time_ms <= seg_orig_end)
            .map(|p| p.cost)
            .collect();

        let avg_cost = if !matched_costs.is_empty() {
            matched_costs.iter().sum::<f32>() / (matched_costs.len() as f32)
        } else {
            0.0
        };

        let energy_similarity = (1.0 - avg_cost).max(0.0).min(1.0);

        adjustments.push(SegmentAdjustment {
            segment_index: seg_idx,
            orig_start_ms: (seg_orig_start * 10.0).round() / 10.0,
            orig_end_ms: (seg_orig_end * 10.0).round() / 10.0,
            dub_start_ms: (seg_dub_start * 10.0).round() / 10.0,
            dub_end_ms: (seg_dub_end * 10.0).round() / 10.0,
            time_stretch_ratio: (stretch_ratio * 1000.0).round() / 1000.0,
            pitch_shift_semitones: 0.0, // WSOLA/Phase Vocoder pitch-neutral
            energy_similarity: (energy_similarity * 100.0).round() / 100.0,
            deviation_percent: (deviation_percent * 10.0).round() / 10.0,
        });
    }

    adjustments
}

// ============================================================================
// 3. WSOLA TIME-STRETCH АЛГОРИТМ (WAVEFORM SIMILARITY OVERLAP-ADD)
// ============================================================================

/// Поиск позиции с максимальным сходством формы волны
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

/// Высококачественное растяжение/сжатие речи WSOLA
pub fn wsola_time_stretch(samples: &[f32], rate: f64, sample_rate: u32) -> Vec<f32> {
    if samples.is_empty() || (rate - 1.0).abs() < 0.005 {
        return samples.to_vec();
    }

    let rate = rate.max(0.5).min(2.0); // Защитный диапазон

    let win_size = ((sample_rate as f64) * 0.025).round() as usize;
    let win_size = (win_size / 2) * 2;
    let hop_out = win_size / 2;
    let hop_in = ((hop_out as f64) * rate).round() as usize;
    let search_range = win_size / 2;

    let mut hanning_window = vec![0.0f32; win_size];
    for i in 0..win_size {
        hanning_window[i] =
            0.5 * (1.0 - (2.0 * PI * (i as f32) / (win_size as f32 - 1.0)).cos());
    }

    let estimated_out_len = ((samples.len() as f64) / rate).ceil() as usize + win_size * 2;
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
        prev_natural_pos = hop_in;
        in_pos = hop_in;
        out_pos = hop_out;
    }

    while in_pos + win_size + search_range < samples.len() {
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
        in_pos += hop_in;
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

    final_output
}

// ============================================================================
// 4. ГЛАВНАЯ ЛОГИКА СОПОСТАВЛЕНИЯ ТАЙМИНГОВ (SMART ALIGN ENGINE)
// ============================================================================

/// Полный анализ сопоставления между оригинальной репликой и дублем (GCC-PHAT + DTW)
pub fn perform_smart_alignment_analysis(
    orig_samples: &[f32],
    dub_samples: &[f32],
    sample_rate: u32,
    original_cue_id: &str,
    dub_cue_id: &str,
    config: Option<SmartAlignConfig>,
) -> Result<AlignmentAdjustment, String> {
    let cfg = config.unwrap_or_default();
    let max_search_ms = cfg.max_search_offset_ms.unwrap_or(2000.0);
    let hop_ms = cfg.dtw_hop_size_ms.unwrap_or(10.0);
    let win_ms = cfg.dtw_window_size_ms.unwrap_or(25.0);
    let max_dev_limit = cfg.max_deviation_limit_percent.unwrap_or(25.0);

    let orig_dur_ms = (orig_samples.len() as f64 / sample_rate as f64) * 1000.0;
    let dub_dur_ms = (dub_samples.len() as f64 / sample_rate as f64) * 1000.0;

    // 1. GCC-PHAT кросс-корреляция: определение временного сдвига
    let (lag_ms, lag_samples, correlation_score) =
        calculate_gcc_phat_lag(orig_samples, dub_samples, sample_rate, max_search_ms);

    // 2. Вычисление огибающих энергии для DTW
    let orig_energy = compute_feature_energy_envelope(orig_samples, sample_rate, win_ms, hop_ms);
    let dub_energy = compute_feature_energy_envelope(dub_samples, sample_rate, win_ms, hop_ms);

    // 3. Dynamic Time Warping (DTW)
    let (dtw_distance, dtw_path) = compute_dynamic_time_warping(&orig_energy, &dub_energy, hop_ms);

    // 4. Сегментный расчет (делим реплику на 4-8 смысловых под-сегментов)
    let num_segments = ((orig_dur_ms / 400.0).round() as usize).max(3).min(10);
    let segment_adjustments =
        calculate_segment_adjustments(&dtw_path, orig_dur_ms, dub_dur_ms, num_segments);

    // 5. Оценка максимального расхождения и проверка порога >25%
    let overall_ratio = if dub_dur_ms > 0.0 {
        orig_dur_ms / dub_dur_ms
    } else {
        1.0
    };

    let max_seg_dev = segment_adjustments
        .iter()
        .map(|s| s.deviation_percent)
        .fold(0.0f64, f64::max);

    let overall_dev = (overall_ratio - 1.0).abs() * 100.0;
    let max_deviation_percent = max_seg_dev.max(overall_dev);

    // Если расхождение превышает 25%, взводим флаг предупреждения перезаписи
    let requires_actor_re_recording = max_deviation_percent > max_dev_limit;

    let warning_message = if requires_actor_re_recording {
        Some(format!(
            "Расхождение темпа реплики составляет {:.1}% (лимит {:.1}%). Рекомендуется перезапись дубля актером во избежание деградации тембра.",
            max_deviation_percent, max_dev_limit
        ))
    } else {
        None
    };

    Ok(AlignmentAdjustment {
        original_cue_id: original_cue_id.to_string(),
        dub_cue_id: dub_cue_id.to_string(),
        detected_lag_ms: (lag_ms * 10.0).round() / 10.0,
        detected_lag_samples: lag_samples,
        correlation_score: (correlation_score * 100.0).round() / 100.0,
        average_stretch_ratio: (overall_ratio * 1000.0).round() / 1000.0,
        max_deviation_percent: (max_deviation_percent * 10.0).round() / 10.0,
        requires_actor_re_recording,
        warning_message,
        segment_adjustments,
        dtw_distance: (dtw_distance * 1000.0).round() / 1000.0,
        sample_rate,
        original_duration_ms: (orig_dur_ms * 10.0).round() / 10.0,
        dub_duration_ms: (dub_dur_ms * 10.0).round() / 10.0,
    })
}

// ============================================================================
// TAURI V2 КОМАНДЫ
// ============================================================================

/// Вычисление интеллектуального выравнивания таймингов (GCC-PHAT + DTW + Time Stretch Ratio)
#[command]
pub async fn calculate_smart_alignment(
    _app: AppHandle,
    cache_state: State<'_, AudioBufferCache>,
    original_cue_id: String,
    dub_cue_id: String,
    config: Option<SmartAlignConfig>,
) -> Result<AlignmentAdjustment, String> {
    let orig_id = original_cue_id.clone();
    let dub_id = dub_cue_id.clone();
    let cache_clone = cache_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let orig_buf = resolve_audio_samples(&orig_id, Some(&cache_clone))
            .map_err(|e| format!("Ошибка оригинального трека: {}", e))?;
        let dub_buf = resolve_audio_samples(&dub_id, Some(&cache_clone))
            .map_err(|e| format!("Ошибка трека дубляжа: {}", e))?;

        let sample_rate = orig_buf.sample_rate.min(dub_buf.sample_rate);
        perform_smart_alignment_analysis(
            &orig_buf.samples,
            &dub_buf.samples,
            sample_rate,
            &orig_id,
            &dub_id,
            config,
        )
    })
    .await
    .map_err(|e| format!("Ошибка задачи calculate_smart_alignment: {}", e))?
}

/// Выравнивание и рендер вокального клипа с сохранением файла
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
    let cfg = config.clone().unwrap_or_default();
    let cache_clone = cache_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let orig_audio = resolve_audio_samples(&orig_path, Some(&cache_clone))?;
        let dub_audio = resolve_audio_samples(&dub_path, Some(&cache_clone))?;

        let sample_rate = dub_audio.sample_rate;
        let orig_samples = orig_audio.samples;
        let mut dub_samples = dub_audio.samples;

        // Выполняем точный анализ GCC-PHAT + DTW
        let adjustment = perform_smart_alignment_analysis(
            &orig_samples,
            &dub_samples,
            sample_rate,
            &orig_path,
            &dub_path,
            Some(cfg.clone()),
        )?;

        let mut was_stretched = false;
        let mut final_stretch_ratio = adjustment.average_stretch_ratio;

        // Если расхождение НЕ превышает критический предел (>25%), выполняем бережное WSOLA-выравнивание
        if !adjustment.requires_actor_re_recording {
            let stretch_thresh = cfg.stretch_threshold_percent.unwrap_or(15.0) / 100.0;
            let min_stretch = cfg.min_stretch_ratio.unwrap_or(0.75);
            let max_stretch = cfg.max_stretch_ratio.unwrap_or(1.25);

            let diff_ratio = (final_stretch_ratio - 1.0).abs();
            if diff_ratio > stretch_thresh {
                let clamped_ratio = final_stretch_ratio.max(min_stretch).min(max_stretch);
                dub_samples = wsola_time_stretch(&dub_samples, clamped_ratio, sample_rate);
                was_stretched = true;
                final_stretch_ratio = clamped_ratio;
            }
        }

        // Сохраняем обработанный 24-bit WAV
        save_mono_wav_24bit(&out_path, &dub_samples, sample_rate)?;

        let out_dur_ms = (dub_samples.len() as f64 / sample_rate as f64) * 1000.0;

        Ok(AlignResult {
            original_path: orig_path,
            dubbed_path: dub_path,
            output_path: out_path,
            original_duration_ms: adjustment.original_duration_ms,
            dubbed_duration_ms: adjustment.dub_duration_ms,
            output_duration_ms: (out_dur_ms * 10.0).round() / 10.0,
            detected_offset_ms: adjustment.detected_lag_ms,
            stretch_ratio: (final_stretch_ratio * 1000.0).round() / 1000.0,
            correlation_score: adjustment.correlation_score,
            sample_rate,
            was_stretched,
            requires_actor_re_recording: adjustment.requires_actor_re_recording,
            alignment_adjustment: Some(adjustment),
        })
    })
    .await
    .map_err(|e| format!("Ошибка вызова задачи align_vocal_clip: {}", e))?
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
    fn test_dtw_energy_matching() {
        let env1 = vec![0.1, 0.3, 0.8, 0.9, 0.4, 0.1];
        let env2 = vec![0.1, 0.2, 0.7, 0.9, 0.5, 0.1];

        let (distance, path) = compute_dynamic_time_warping(&env1, &env2, 10.0);
        assert!(distance < 0.2);
        assert!(!path.is_empty());
    }

    #[test]
    fn test_extreme_deviation_protection() {
        let sample_rate = 48000;
        let orig = vec![0.5f32; 48000];      // 1.0 секунда
        let dub_extreme = vec![0.5f32; 65000]; // 1.35 секунды (+35% расхождение)

        let result = perform_smart_alignment_analysis(
            &orig,
            &dub_extreme,
            sample_rate,
            "orig_1",
            "dub_1",
            None,
        ).unwrap();

        assert!(result.max_deviation_percent > 25.0);
        assert!(result.requires_actor_re_recording);
        assert!(result.warning_message.is_some());
    }
}
