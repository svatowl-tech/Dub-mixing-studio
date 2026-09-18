// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE SILENCE VAD ENGINE (RUST)
// Сверхбыстрый многопоточный Voice Activity Detector (VAD) и нарезчик по тишине
// Стек: rayon = "1.10.0", hound = "3.5.1", serde = "1.0", tauri = "2.2"
// ============================================================================

use std::path::Path;
use std::time::Instant;

use hound::{SampleFormat, WavReader};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::audio_buffer_manager::AudioBufferCache;
use crate::file_io::normalize_windows_path;
use crate::logger::log_info;

/// Конфигурация параметров Voice Activity Detection (VAD)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VadConfig {
    /// Порог входа в речь (Onset Threshold), например -32.0 dBFS
    pub onset_threshold_db: f32,
    /// Порог выхода в тишину (Offset Threshold с гистерезисом), например -42.0 dBFS
    pub offset_threshold_db: f32,
    /// Размер скользящего окна RMS в сэмплах (например, 960 для 20 мс при 48 кГц)
    pub window_size_samples: usize,
    /// Шаг сдвига окна (Hop size) в сэмплах (например, 480 для 10 мс при 48 кГц)
    pub hop_size_samples: usize,
    /// Минимальная длительность валидной фразы речи в миллисекундах (например, 180 мс)
    pub min_speech_duration_ms: u64,
    /// Минимальная длительность тишины между репликами для разделения в миллисекундах (например, 250 мс)
    pub min_silence_duration_ms: u64,
    /// Защитный отступ перед началом фразы (Safety Pre-padding) в миллисекундах (например, 80 мс)
    pub pre_padding_ms: u64,
    /// Защитный отступ после окончания фразы (Safety Post-padding) в миллисекундах (например, 150 мс)
    pub post_padding_ms: u64,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            onset_threshold_db: -35.0,
            offset_threshold_db: -45.0,
            window_size_samples: 960,  // 20 ms @ 48kHz
            hop_size_samples: 480,     // 10 ms @ 48kHz
            min_speech_duration_ms: 180,
            min_silence_duration_ms: 250,
            pre_padding_ms: 80,
            post_padding_ms: 150,
        }
    }
}

/// Выходная речевая область аудиодорожки
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRegion {
    /// Время старта в секундах (с учетом защитного отступа и границ)
    pub start: f64,
    /// Время окончания в секундах
    pub end: f64,
    /// Итоговая длительность в секундах
    pub duration: f64,
    /// Средний уровень энергии реплики в dBFS
    pub average_db: f32,
    /// Пиковый уровень громкости в dBFS
    pub peak_db: f32,
    /// Опциональный путь к аудиофайлу
    pub file_path: Option<String>,
}

/// Внутренние состояния двухпорогового автомата гистерезиса
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VadState {
    Silence,
    PossibleSpeech,
    Speech,
    PossibleSilence,
}

/// Основной алгоритмический процессор VAD
pub struct NativeVadProcessor;

impl NativeVadProcessor {
    /// Преобразование многоканального аудио в монофонический поток с санитизацией
    pub fn downmix_to_mono(interleaved_samples: &[f32], channels: u16) -> Vec<f32> {
        let ch = channels.max(1) as usize;
        if ch == 1 {
            interleaved_samples
                .iter()
                .map(|&s| if s.is_finite() { s.clamp(-1.0, 1.0) } else { 0.0 })
                .collect()
        } else {
            let total_frames = interleaved_samples.len() / ch;
            let inv_ch = 1.0 / ch as f32;
            let mut mono = Vec::with_capacity(total_frames);
            for frame_idx in 0..total_frames {
                let mut sum = 0.0f32;
                let offset = frame_idx * ch;
                for c in 0..ch {
                    let s = interleaved_samples[offset + c];
                    if s.is_finite() {
                        sum += s;
                    }
                }
                mono.push((sum * inv_ch).clamp(-1.0, 1.0));
            }
            mono
        }
    }

    /// Параллельный расчет RMS энергии по перекрывающимся окнам (через Rayon)
    pub fn compute_windowed_energy_db(
        mono_samples: &[f32],
        window_size: usize,
        hop_size: usize,
    ) -> Vec<f32> {
        let total_samples = mono_samples.len();
        if total_samples < window_size || window_size == 0 || hop_size == 0 {
            if total_samples > 0 {
                // Если сэмплов меньше размера окна — считаем одиночный RMS
                let sum_sq: f32 = mono_samples.iter().map(|&s| s * s).sum();
                let rms = (sum_sq / total_samples as f32).sqrt();
                let db = 20.0 * (rms + 1e-9).log10();
                return vec![db];
            }
            return Vec::new();
        }

        let num_frames = (total_samples - window_size) / hop_size + 1;
        let inv_win = 1.0 / window_size as f32;

        // Параллельный расчет кадров RMS в пуле потоков Rayon
        (0..num_frames)
            .into_par_iter()
            .map(|frame_idx| {
                let start = frame_idx * hop_size;
                let end = start + window_size;
                let win_slice = &mono_samples[start..end];

                let mut sum_sq = 0.0f32;
                for &s in win_slice {
                    sum_sq += s * s;
                }
                let rms = (sum_sq * inv_win).sqrt();
                20.0 * (rms + 1e-9).log10()
            })
            .collect()
    }

    /// Быстрое скользящее среднее (Moving Average) с кольцевым аккумулятором за O(1) на шаг
    pub fn apply_moving_average(db_frames: &[f32], smooth_window: usize) -> Vec<f32> {
        let len = db_frames.len();
        if len == 0 {
            return Vec::new();
        }
        let w = smooth_window.max(1).min(len);
        if w <= 1 {
            return db_frames.to_vec();
        }

        let mut smoothed = Vec::with_capacity(len);
        let half_w = w / 2;
        let inv_w = 1.0 / w as f32;

        let mut sum = 0.0f32;
        // Начальное заполнение окна
        for i in 0..w {
            let idx = (i as isize - half_w as isize).clamp(0, (len - 1) as isize) as usize;
            sum += db_frames[idx];
        }
        smoothed.push(sum * inv_w);

        for i in 1..len {
            let remove_idx = (i as isize - 1 - half_w as isize).clamp(0, (len - 1) as isize) as usize;
            let add_idx = (i as isize + half_w as isize).clamp(0, (len - 1) as isize) as usize;
            sum += db_frames[add_idx] - db_frames[remove_idx];
            smoothed.push(sum * inv_w);
        }

        smoothed
    }

    /// Двухпороговый автомат состояний (Hysteresis State Machine)
    pub fn extract_raw_speech_intervals(
        smoothed_db: &[f32],
        onset_db: f32,
        offset_db: f32,
        confirm_frames: usize,
    ) -> Vec<(usize, usize)> {
        let mut intervals: Vec<(usize, usize)> = Vec::new();
        let mut state = VadState::Silence;
        let mut speech_start_frame = 0;
        let mut pending_counter = 0;

        for (frame_idx, &val) in smoothed_db.iter().enumerate() {
            match state {
                VadState::Silence => {
                    if val >= onset_db {
                        state = VadState::PossibleSpeech;
                        speech_start_frame = frame_idx;
                        pending_counter = 1;
                    }
                }
                VadState::PossibleSpeech => {
                    if val >= onset_db {
                        pending_counter += 1;
                        if pending_counter >= confirm_frames {
                            state = VadState::Speech;
                        }
                    } else if val < offset_db {
                        // Ложное срабатывание (кратковременный щелчок)
                        state = VadState::Silence;
                        pending_counter = 0;
                    }
                }
                VadState::Speech => {
                    if val < offset_db {
                        state = VadState::PossibleSilence;
                        pending_counter = 1;
                    }
                }
                VadState::PossibleSilence => {
                    if val < offset_db {
                        pending_counter += 1;
                        if pending_counter >= confirm_frames {
                            // Подтвержденная пауза — фиксируем реплику
                            intervals.push((speech_start_frame, frame_idx.saturating_sub(pending_counter)));
                            state = VadState::Silence;
                            pending_counter = 0;
                        }
                    } else if val >= onset_db {
                        // Голос возобновился
                        state = VadState::Speech;
                        pending_counter = 0;
                    }
                }
            }
        }

        // Если файл закончился в состоянии речи
        if state == VadState::Speech || state == VadState::PossibleSilence {
            let last_frame = smoothed_db.len().saturating_sub(1);
            intervals.push((speech_start_frame, last_frame));
        }

        intervals
    }

    /// Полный цикл детекции речевых областей (VAD Pipeline)
    pub fn process_vad(
        mono_samples: &[f32],
        sample_rate: u32,
        config: &VadConfig,
    ) -> Vec<SpeechRegion> {
        let total_samples = mono_samples.len();
        if total_samples == 0 || sample_rate == 0 {
            return Vec::new();
        }

        let total_duration = total_samples as f64 / sample_rate as f64;

        // 1. Проверка на абсолютную тишину во всем файле
        let mut max_abs = 0.0f32;
        for &s in mono_samples {
            let a = s.abs();
            if a > max_abs {
                max_abs = a;
            }
        }
        if max_abs <= 0.00001 {
            return Vec::new();
        }

        let window_size = config.window_size_samples.max(64);
        let hop_size = config.hop_size_samples.max(16);

        // 2. Расчет покадровой энергии RMS в dB
        let raw_db = Self::compute_windowed_energy_db(mono_samples, window_size, hop_size);
        if raw_db.is_empty() {
            return vec![SpeechRegion {
                start: 0.0,
                end: total_duration,
                duration: total_duration,
                average_db: -20.0,
                peak_db: 20.0 * max_abs.log10(),
                file_path: None,
            }];
        }

        // 3. Сглаживание скользящим окном (окно ~50 мс: w = (0.05 * sr) / hop_size)
        let smooth_w = ((0.05 * sample_rate as f64) / hop_size as f64).round() as usize;
        let smoothed_db = Self::apply_moving_average(&raw_db, smooth_w.max(3));

        // 4. Двухпороговый гистерезис Onset / Offset
        let confirm_frames = ((0.02 * sample_rate as f64) / hop_size as f64).round() as usize;
        let raw_intervals = Self::extract_raw_speech_intervals(
            &smoothed_db,
            config.onset_threshold_db,
            config.offset_threshold_db,
            confirm_frames.max(2),
        );

        if raw_intervals.is_empty() {
            return Vec::new();
        }

        // 5. Преобразование кадров в секунды
        let frame_to_sec = |f: usize| -> f64 {
            ((f * hop_size) as f64 / sample_rate as f64).min(total_duration)
        };

        let time_spans: Vec<(f64, f64)> = raw_intervals
            .into_iter()
            .map(|(sf, ef)| (frame_to_sec(sf), frame_to_sec(ef) + (window_size as f64 / sample_rate as f64)))
            .collect();

        // 6. Слияние пауз короче min_silence_duration_ms
        let min_silence_sec = config.min_silence_duration_ms as f64 / 1000.0;
        let mut merged_spans: Vec<(f64, f64)> = Vec::new();
        if !time_spans.is_empty() {
            let mut current = time_spans[0];
            for next in time_spans.into_iter().skip(1) {
                let pause = next.0 - current.1;
                if pause < min_silence_sec {
                    current.1 = next.1.max(current.1);
                } else {
                    merged_spans.push(current);
                    current = next;
                }
            }
            merged_spans.push(current);
        }

        // 7. Фильтрация фраз короче min_speech_duration_ms
        let min_speech_sec = config.min_speech_duration_ms as f64 / 1000.0;
        let valid_spans: Vec<(f64, f64)> = merged_spans
            .into_iter()
            .filter(|(s, e)| (e - s) >= min_speech_sec)
            .collect();

        if valid_spans.is_empty() {
            return Vec::new();
        }

        // 8. Применение защитных отступов (Pre/Post Padding) и разрешение наложений
        let pre_pad_sec = config.pre_padding_ms as f64 / 1000.0;
        let post_pad_sec = config.post_padding_ms as f64 / 1000.0;

        let mut padded_spans: Vec<(f64, f64)> = valid_spans
            .into_iter()
            .map(|(s, e)| {
                let ps = (s - pre_pad_sec).max(0.0);
                let pe = (e + post_pad_sec).min(total_duration);
                (ps, pe)
            })
            .collect();

        // Разрешение взаимных наездов между соседними сегментами (Cross-collision midpoint resolution)
        for i in 0..padded_spans.len().saturating_sub(1) {
            if padded_spans[i].1 > padded_spans[i + 1].0 {
                let mid = (padded_spans[i].1 + padded_spans[i + 1].0) * 0.5;
                padded_spans[i].1 = mid;
                padded_spans[i + 1].0 = mid;
            }
        }

        // 9. Расчет точных пиков и среднего уровня энергии для каждого финального сегмента
        let mut speech_regions: Vec<SpeechRegion> = Vec::with_capacity(padded_spans.len());
        for (s_sec, e_sec) in padded_spans {
            let dur = (e_sec - s_sec).max(0.01);
            let s_idx = ((s_sec * sample_rate as f64).floor() as usize).min(total_samples);
            let e_idx = ((e_sec * sample_rate as f64).ceil() as usize).min(total_samples);

            let slice = &mono_samples[s_idx..e_idx];
            let mut peak_val = 0.0f32;
            let mut sum_sq = 0.0f32;

            if !slice.is_empty() {
                for &v in slice {
                    let abs_v = v.abs();
                    if abs_v > peak_val {
                        peak_val = abs_v;
                    }
                    sum_sq += v * v;
                }
                let seg_rms = (sum_sq / slice.len() as f32).sqrt();
                let avg_db = (20.0 * (seg_rms + 1e-9).log10()).clamp(-100.0, 0.0);
                let peak_db = (20.0 * (peak_val + 1e-9).log10()).clamp(-100.0, 0.0);

                speech_regions.push(SpeechRegion {
                    start: (s_sec * 1000.0).round() / 1000.0,
                    end: (e_sec * 1000.0).round() / 1000.0,
                    duration: (dur * 1000.0).round() / 1000.0,
                    average_db: (avg_db * 10.0).round() / 10.0,
                    peak_db: (peak_db * 10.0).round() / 10.0,
                    file_path: None,
                });
            }
        }

        speech_regions
    }
}

// ============================================================================
// TAURI V2 COMMAND
// ============================================================================

/// Нативная команда детекции речевых областей (VAD)
#[tauri::command]
pub async fn detect_speech_regions(
    cache_state: State<'_, AudioBufferCache>,
    buffer_id_or_path: String,
    config: VadConfig,
) -> Result<Vec<SpeechRegion>, String> {
    let start_time = Instant::now();
    let norm_path_or_id = normalize_windows_path(&buffer_id_or_path);

    log_info(&format!(
        "[SilenceVadEngine] Запуск высокоскоростного VAD анализа для: '{}' (Onset: {:.1} dB, Offset: {:.1} dB)",
        norm_path_or_id, config.onset_threshold_db, config.offset_threshold_db
    ));

    // 1. Попытка извлечения из кэша памяти AudioBufferManager (Zero Disk I/O)
    let buffer_opt = if let Some(buf) = cache_state.buffers.get(&norm_path_or_id) {
        Some((
            buf.get_slice(0, buf.total_frames * (buf.channels as usize)),
            buf.sample_rate,
            buf.channels,
        ))
    } else if let Some(buf_id) = cache_state.get_by_path(&norm_path_or_id) {
        if let Some(buf) = cache_state.buffers.get(&buf_id) {
            Some((
                buf.get_slice(0, buf.total_frames * (buf.channels as usize)),
                buf.sample_rate,
                buf.channels,
            ))
        } else {
            None
        }
    } else {
        None
    };

    let (samples_interleaved, sample_rate, channels) = if let Some(tup) = buffer_opt {
        tup
    } else {
        // 2. Fallback: прямое чтение аудиофайла с накопителя
        let path = Path::new(&norm_path_or_id);
        if !path.exists() {
            return Err(format!("Файл не найден для VAD анализа: {}", norm_path_or_id));
        }

        let mut reader = WavReader::open(path)
            .map_err(|e| format!("Ошибка открытия WAV файла: {}", e))?;
        let spec = reader.spec();

        let samples_f32: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
            (SampleFormat::Float, 32) => reader
                .samples::<f32>()
                .filter_map(Result::ok)
                .collect(),
            (SampleFormat::Int, 16) => reader
                .samples::<i16>()
                .filter_map(Result::ok)
                .map(|s| s as f32 / 32768.0)
                .collect(),
            (SampleFormat::Int, 24) | (SampleFormat::Int, 32) => reader
                .samples::<i32>()
                .filter_map(Result::ok)
                .map(|s| s as f32 / 2147483648.0)
                .collect(),
            _ => return Err("Неподдерживаемый формат аудио для VAD анализа".to_string()),
        };

        (samples_f32, spec.sample_rate, spec.channels)
    };

    // 3. Даунмикс в моно
    let mono = NativeVadProcessor::downmix_to_mono(&samples_interleaved, channels);

    // 4. Запуск параллельного VAD пайплайна
    let regions = NativeVadProcessor::process_vad(&mono, sample_rate, &config);

    log_info(&format!(
        "[SilenceVadEngine] VAD завершен за {:.2}ms. Найдено {} речевых сегментов (Сэмплов: {})",
        start_time.elapsed().as_secs_f64() * 1000.0,
        regions.len(),
        mono.len()
    ));

    Ok(regions)
}
