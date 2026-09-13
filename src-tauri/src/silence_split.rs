use std::path::{Path, PathBuf};
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};

/// Конфигурация алгоритма VAD и нарезки по тишине (Silence Split)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceSplitConfig {
    /// Порог включения детекции речи (Onset Threshold, по умолчанию -35.0 dBFS)
    pub onset_threshold_db: Option<f32>,
    /// Порог выключения детекции речи с гистерезисом (Offset Threshold, по умолчанию -45.0 dBFS)
    pub offset_threshold_db: Option<f32>,
    /// Базовый порог тишины (если передан с фронтенда: onset = threshold, offset = threshold - 10 dB)
    pub threshold_db: Option<f32>,
    /// Минимальная длительность паузы между репликами для разделения (в мс, по умолчанию 300 мс)
    pub min_silence_duration_ms: Option<u64>,
    /// Минимальная длительность валидной фразы речи (в мс, по умолчанию 200 мс)
    pub min_speech_duration_ms: Option<u64>,
    /// Защитный отступ перед началом фразы (Padding Pre, в мс, по умолчанию 80 мс)
    pub padding_pre_ms: Option<u64>,
    /// Защитный отступ после окончания фразы (Padding Post, в мс, по умолчанию 150 мс)
    pub padding_post_ms: Option<u64>,
    /// Экспортировать нарезанные аудиоклипы в отдельные WAV файлы
    pub export_clips: Option<bool>,
    /// Размер окна RMS энергии в мс (по умолчанию 20.0 мс)
    pub window_size_ms: Option<f32>,
    /// Шаг окна (Hop) в мс (по умолчанию 10.0 мс)
    pub hop_size_ms: Option<f32>,
}

impl Default for SilenceSplitConfig {
    fn default() -> Self {
        Self {
            onset_threshold_db: Some(-35.0),
            offset_threshold_db: Some(-45.0),
            threshold_db: None,
            min_silence_duration_ms: Some(300),
            min_speech_duration_ms: Some(200),
            padding_pre_ms: Some(80),
            padding_post_ms: Some(150),
            export_clips: Some(false),
            window_size_ms: Some(20.0),
            hop_size_ms: Some(10.0),
        }
    }
}

/// Нарезанный речевой сегмент аудиодорожки
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCueSegment {
    /// Уникальный идентификатор реплики
    pub id: String,
    /// Время начала сегмента в миллисекундах (с учетом защитного отступа)
    pub start_ms: u64,
    /// Время окончания сегмента в миллисекундах (с учетом защитного отступа)
    pub end_ms: u64,
    /// Начальный сэмпл в исходном аудиофайле
    pub sample_start: usize,
    /// Конечный сэмпл в исходном аудиофайле
    pub sample_end: usize,
    /// Время старта в секундах
    pub start_sec: f64,
    /// Время окончания в секундах
    pub end_sec: f64,
    /// Длительность сегмента в миллисекундах
    pub duration_ms: u64,
    /// Путь к экспортированному WAV файлу сегмента (если был экспортирован)
    pub file_path: Option<String>,
    /// Средний уровень энергии реплики в dBFS
    pub average_db: f32,
    /// Пиковый уровень громкости в dBFS
    pub peak_db: f32,
}

/// Итоговый отчет о работе VAD и нарезки по тишине
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceSplitReport {
    pub input_path: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub total_duration_sec: f64,
    pub total_samples: usize,
    pub segments_count: usize,
    pub segments: Vec<AudioCueSegment>,
    pub total_speech_duration_ms: u64,
    pub speech_ratio: f32,
    pub noise_floor_db: f32,
    pub onset_threshold_db: f32,
    pub offset_threshold_db: f32,
}

/// Вспомогательная структура сырого интервала речи (в сэмплах)
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
struct RawSpeechInterval {
    raw_start: usize,
    raw_end: usize,
    padded_start: usize,
    padded_end: usize,
}

/// Перевод линейной амплитуды в dBFS
#[inline]
fn linear_to_db(linear: f32) -> f32 {
    if linear > 1e-7 {
        20.0 * linear.log10()
    } else {
        -120.0
    }
}

/// Основной алгоритмический расчет VAD и нарезки на реплики
pub fn detect_speech_segments(
    mono_samples: &[f32],
    sample_rate: u32,
    config: &SilenceSplitConfig,
) -> (Vec<AudioCueSegment>, f32, f32, f32) {
    let total_samples = mono_samples.len();
    if total_samples == 0 || sample_rate == 0 {
        return (Vec::new(), -120.0, -35.0, -45.0);
    }

    let window_ms = config.window_size_ms.unwrap_or(20.0).max(5.0);
    let hop_ms = config.hop_size_ms.unwrap_or(10.0).max(2.0);

    let window_size = ((window_ms / 1000.0) * sample_rate as f32).round().max(1.0) as usize;
    let hop_size = ((hop_ms / 1000.0) * sample_rate as f32).round().max(1.0) as usize;

    // Определение порогов включения/выключения с гистерезисом
    let (onset_db, offset_db) = match (config.onset_threshold_db, config.offset_threshold_db, config.threshold_db) {
        (Some(on), Some(off), _) => (on, off.min(on)),
        (Some(on), None, _) => (on, (on - 10.0).min(-10.0)),
        (None, Some(off), _) => ((off + 10.0).min(0.0), off),
        (None, None, Some(base)) => (base, (base - 10.0).min(-10.0)),
        (None, None, None) => (-35.0, -45.0),
    };

    let min_silence_ms = config.min_silence_duration_ms.unwrap_or(300);
    let min_speech_ms = config.min_speech_duration_ms.unwrap_or(200);
    let pad_pre_ms = config.padding_pre_ms.unwrap_or(80);
    let pad_post_ms = config.padding_post_ms.unwrap_or(150);

    let min_silence_samples = ((min_silence_ms as f64 / 1000.0) * sample_rate as f64).round() as usize;
    let min_speech_samples = ((min_speech_ms as f64 / 1000.0) * sample_rate as f64).round() as usize;
    let pad_pre_samples = ((pad_pre_ms as f64 / 1000.0) * sample_rate as f64).round() as usize;
    let pad_post_samples = ((pad_post_ms as f64 / 1000.0) * sample_rate as f64).round() as usize;

    // 1. Расчет кратковременной энергии (RMS) по скользящим окнам 20 мс с шагом 10 мс
    let num_frames = if total_samples < window_size {
        0
    } else {
        (total_samples - window_size) / hop_size + 1
    };

    if num_frames == 0 {
        // Если аудио короче 1 окна, анализируем весь буфер целиком
        let mut sum_sq = 0.0_f32;
        for &s in mono_samples {
            sum_sq += s * s;
        }
        let rms = (sum_sq / total_samples as f32).sqrt();
        let db = linear_to_db(rms);
        if db >= onset_db && total_samples >= min_speech_samples {
            let seg = AudioCueSegment {
                id: "cue_1".to_string(),
                start_ms: 0,
                end_ms: ((total_samples as f64 / sample_rate as f64) * 1000.0).round() as u64,
                sample_start: 0,
                sample_end: total_samples,
                start_sec: 0.0,
                end_sec: total_samples as f64 / sample_rate as f64,
                duration_ms: ((total_samples as f64 / sample_rate as f64) * 1000.0).round() as u64,
                file_path: None,
                average_db: db,
                peak_db: db,
            };
            return (vec![seg], db, onset_db, offset_db);
        } else {
            return (Vec::new(), db, onset_db, offset_db);
        }
    }

    let mut frame_dbs: Vec<f32> = Vec::with_capacity(num_frames);
    let inv_window_size = 1.0 / window_size as f32;

    for i in 0..num_frames {
        let start = i * hop_size;
        let end = start + window_size;
        let mut sum_sq = 0.0_f32;
        for j in start..end {
            let s = mono_samples[j];
            sum_sq += s * s;
        }
        let rms = (sum_sq * inv_window_size).sqrt();
        frame_dbs.push(linear_to_db(rms));
    }

    // Оценка уровня фонового шума (10-й перцентиль)
    let mut sorted_dbs = frame_dbs.clone();
    sorted_dbs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let noise_floor_idx = (num_frames as f32 * 0.10).floor() as usize;
    let noise_floor_db = sorted_dbs[noise_floor_idx.min(num_frames - 1)];

    // 2. Двухпороговый VAD с гистерезисом (State Machine)
    let mut raw_intervals: Vec<(usize, usize)> = Vec::new();
    let mut in_speech = false;
    let mut speech_start_frame = 0;

    for (frame_idx, &db) in frame_dbs.iter().enumerate() {
        if !in_speech {
            // Порог включения (Onset): голос начинается, если энергия превысила onset_db
            if db >= onset_db {
                in_speech = true;
                speech_start_frame = frame_idx;
            }
        } else {
            // Порог выключения (Offset / Hysteresis): голос удерживается, пока энергия выше offset_db
            if db < offset_db {
                in_speech = false;
                let sample_start = speech_start_frame * hop_size;
                let sample_end = (frame_idx * hop_size + window_size).min(total_samples);
                raw_intervals.push((sample_start, sample_end));
            }
        }
    }

    // Если аудио закончилось во время активной речи
    if in_speech {
        let sample_start = speech_start_frame * hop_size;
        let sample_end = total_samples;
        raw_intervals.push((sample_start, sample_end));
    }

    if raw_intervals.is_empty() {
        return (Vec::new(), noise_floor_db, onset_db, offset_db);
    }

    // 3. Слияние коротких пауз внутри реплик (< min_silence_samples)
    let mut merged_intervals: Vec<(usize, usize)> = Vec::new();
    let mut current = raw_intervals[0];

    for next in raw_intervals.into_iter().skip(1) {
        if next.0 <= current.1 + min_silence_samples {
            // Пауза меньше минимальной для разреза -> объединяем реплики
            current.1 = next.1.max(current.1);
        } else {
            merged_intervals.push(current);
            current = next;
        }
    }
    merged_intervals.push(current);

    // 4. Фильтрация слишком коротких всплесков шума (< min_speech_samples)
    let valid_intervals: Vec<(usize, usize)> = merged_intervals
        .into_iter()
        .filter(|(start, end)| end.saturating_sub(*start) >= min_speech_samples)
        .collect();

    if valid_intervals.is_empty() {
        return (Vec::new(), noise_floor_db, onset_db, offset_db);
    }

    // 5. Применение защитных отступов (Padding / Margins):
    // 80 мс до начала фразы (для сохранения согласных и вдохов)
    // 150 мс после окончания фразы (для затухания и хвостовых согласных)
    // С обязательным предотвращением наложения (Overlap Resolution) между соседними репликами.
    let mut cue_intervals: Vec<RawSpeechInterval> = Vec::with_capacity(valid_intervals.len());

    for (idx, &(raw_start, raw_end)) in valid_intervals.iter().enumerate() {
        let preliminary_start = raw_start.saturating_sub(pad_pre_samples);
        let preliminary_end = (raw_end + pad_post_samples).min(total_samples);

        let mut actual_start = preliminary_start;
        if idx > 0 {
            let prev_idx = idx - 1;
            let prev_raw_end = cue_intervals[prev_idx].raw_end;
            if actual_start < cue_intervals[prev_idx].padded_end {
                // Возникло пересечение отступов двух соседних реплик!
                // Разделяем точку стыка строго посередине между чистыми концами фраз
                if prev_raw_end >= raw_start {
                    let midpoint = raw_start;
                    cue_intervals[prev_idx].padded_end = midpoint;
                    actual_start = midpoint;
                } else {
                    let midpoint = (prev_raw_end + raw_start) / 2;
                    cue_intervals[prev_idx].padded_end = midpoint.min(cue_intervals[prev_idx].padded_end);
                    actual_start = midpoint;
                }
            }
        }

        cue_intervals.push(RawSpeechInterval {
            raw_start,
            raw_end,
            padded_start: actual_start,
            padded_end: preliminary_end,
        });
    }

    // 6. Формирование финальных структур AudioCueSegment с расчетом средних и пиковых dB
    let mut final_segments: Vec<AudioCueSegment> = Vec::with_capacity(cue_intervals.len());

    for (i, item) in cue_intervals.into_iter().enumerate() {
        let s_start = item.padded_start;
        let s_end = item.padded_end.max(s_start + 1).min(total_samples);
        let length = s_end - s_start;

        let mut sum_sq = 0.0_f32;
        let mut peak_val = 0.0_f32;

        for sample_idx in s_start..s_end {
            let val = mono_samples[sample_idx];
            let abs_val = val.abs();
            if abs_val > peak_val {
                peak_val = abs_val;
            }
            sum_sq += val * val;
        }

        let segment_rms = (sum_sq / length as f32).sqrt();
        let avg_db = linear_to_db(segment_rms);
        let peak_db = linear_to_db(peak_val);

        let start_sec = s_start as f64 / sample_rate as f64;
        let end_sec = s_end as f64 / sample_rate as f64;
        let start_ms = (start_sec * 1000.0).round() as u64;
        let end_ms = (end_sec * 1000.0).round() as u64;
        let duration_ms = end_ms.saturating_sub(start_ms);

        final_segments.push(AudioCueSegment {
            id: format!("cue_{}", i + 1),
            start_ms,
            end_ms,
            sample_start: s_start,
            sample_end: s_end,
            start_sec: (start_sec * 1000.0).round() / 1000.0,
            end_sec: (end_sec * 1000.0).round() / 1000.0,
            duration_ms,
            file_path: None,
            average_db: (avg_db * 10.0).round() / 10.0,
            peak_db: (peak_db * 10.0).round() / 10.0,
        });
    }

    (final_segments, noise_floor_db, onset_db, offset_db)
}

/// Чтение многоканального WAV файла
pub fn read_wav(path: &Path) -> Result<(Vec<Vec<f32>>, WavSpec), String> {
    let (wav_path, is_temp) = crate::file_io::ensure_valid_wav_path(path)?;
    let res = (|| -> Result<(Vec<Vec<f32>>, WavSpec), String> {
        let mut reader = WavReader::open(&wav_path)
            .map_err(|e| format!("Не удалось открыть WAV файл {}: {}", wav_path.display(), e))?;
        let spec = reader.spec();

        let channels = spec.channels as usize;
        if channels == 0 {
            return Err("Количество каналов в WAV файле равно 0".to_string());
        }
        let mut channel_buffers: Vec<Vec<f32>> = vec![Vec::new(); channels];

        match spec.sample_format {
            SampleFormat::Float => {
                let mut ch = 0;
                for s in reader.samples::<f32>() {
                    channel_buffers[ch].push(s.unwrap_or(0.0));
                    ch = (ch + 1) % channels;
                }
            }
            SampleFormat::Int => {
                let scale = match spec.bits_per_sample {
                    16 => 32768.0_f32,
                    24 => 8388608.0_f32,
                    32 => 2147483648.0_f32,
                    8 => 128.0_f32,
                    b => return Err(format!("Неподдерживаемая разрядность сэмпла: {} бит", b)),
                };
                let mut ch = 0;
                for s in reader.samples::<i32>() {
                    channel_buffers[ch].push(s.unwrap_or(0) as f32 / scale);
                    ch = (ch + 1) % channels;
                }
            }
        }

        Ok((channel_buffers, spec))
    })();

    if is_temp {
        let _ = std::fs::remove_file(&wav_path);
    }

    res
}

/// Запись среза многоканального аудио в отдельный WAV файл
pub fn write_segment_wav(
    output_path: &Path,
    channels: &[Vec<f32>],
    sample_start: usize,
    sample_end: usize,
    sample_rate: u32,
) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Не удалось создать папку {}: {}", parent.display(), e))?;
    }

    let num_channels = channels.len();
    if num_channels == 0 {
        return Err("Нет каналов для записи".to_string());
    }

    let clamped_start = sample_start.min(channels[0].len());
    let clamped_end = sample_end.min(channels[0].len()).max(clamped_start);

    let spec = WavSpec {
        channels: num_channels as u16,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output_path, spec)
        .map_err(|e| format!("Не удалось создать сегмент WAV {}: {}", output_path.display(), e))?;

    for i in clamped_start..clamped_end {
        for ch in 0..num_channels {
            let s = channels[ch].get(i).copied().unwrap_or(0.0);
            writer.write_sample(s).map_err(|e| format!("Ошибка записи сэмпла: {}", e))?;
        }
    }

    writer.finalize().map_err(|e| format!("Ошибка финализации WAV {}: {}", output_path.display(), e))?;
    Ok(())
}

/// Главная функция процессинга и нарезки дорожки по тишине (Tauri v2 Command)
#[tauri::command]
pub async fn split_by_silence(
    input_path: String,
    config: Option<SilenceSplitConfig>,
    output_dir: Option<String>,
) -> Result<SilenceSplitReport, String> {
    let cfg = config.unwrap_or_default();
    let in_path = PathBuf::from(&input_path);
    if !in_path.exists() {
        return Err(format!("Исходный аудиофайл не найден: {}", input_path));
    }

    println!("[SilenceSplit] ▶ Старт VAD нарезки по тишине для: {}", in_path.display());

    let (channels, spec) = read_wav(&in_path)?;
    let sample_rate = spec.sample_rate;
    let num_channels = spec.channels;
    let total_samples = if !channels.is_empty() { channels[0].len() } else { 0 };
    let total_duration_sec = total_samples as f64 / sample_rate as f64;

    // Смешивание каналов в моно для анализа VAD
    let mut mono_samples = vec![0.0_f32; total_samples];
    let inv_ch = 1.0 / channels.len() as f32;
    for ch_buf in &channels {
        for (i, &s) in ch_buf.iter().enumerate() {
            mono_samples[i] += s * inv_ch;
        }
    }

    let (mut segments, noise_floor_db, onset_db, offset_db) =
        detect_speech_segments(&mono_samples, sample_rate, &cfg);

    // Экспорт нарезанных сегментов в WAV файлы (если запрошено или указана папка)
    let should_export = cfg.export_clips.unwrap_or(false) || output_dir.is_some();
    if should_export && !segments.is_empty() {
        let target_dir = match output_dir {
            Some(dir) => PathBuf::from(dir),
            None => in_path.parent().unwrap_or_else(|| Path::new(".")).join("cues"),
        };
        std::fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Не удалось создать директорию для клипов: {}", e))?;

        let file_stem = in_path.file_stem().and_then(|s| s.to_str()).unwrap_or("track");

        for seg in &mut segments {
            let seg_filename = format!(
                "{}_cue_{}_{}ms_{}ms.wav",
                file_stem,
                seg.id,
                seg.start_ms,
                seg.end_ms
            );
            let seg_path = target_dir.join(seg_filename);
            write_segment_wav(
                &seg_path,
                &channels,
                seg.sample_start,
                seg.sample_end,
                sample_rate,
            )?;
            seg.file_path = Some(seg_path.to_string_lossy().to_string());
        }
    }

    let total_speech_duration_ms: u64 = segments.iter().map(|s| s.duration_ms).sum();
    let speech_ratio = if total_duration_sec > 0.0 {
        ((total_speech_duration_ms as f64 / 1000.0) / total_duration_sec) as f32
    } else {
        0.0
    };

    println!(
        "[SilenceSplit] ✓ Успешно: сформировано {} фраз, общая речь: {:.2} сек ({:.1}%), Noise Floor: {:.1} dB",
        segments.len(),
        total_speech_duration_ms as f64 / 1000.0,
        speech_ratio * 100.0,
        noise_floor_db
    );

    Ok(SilenceSplitReport {
        input_path,
        sample_rate,
        channels: num_channels,
        total_duration_sec,
        total_samples,
        segments_count: segments.len(),
        segments,
        total_speech_duration_ms,
        speech_ratio: (speech_ratio * 1000.0).round() / 1000.0,
        noise_floor_db: (noise_floor_db * 10.0).round() / 10.0,
        onset_threshold_db: onset_db,
        offset_threshold_db: offset_db,
    })
}

/// Обёртка для VAD анализа речевых пауз (Tauri v2 Command)
#[tauri::command]
pub async fn process_vad_split(
    input_path: String,
    threshold_db: Option<f32>,
    min_silence_duration_ms: Option<u64>,
    speech_pad_ms: Option<u64>,
) -> Result<SilenceSplitReport, String> {
    let mut cfg = SilenceSplitConfig::default();
    if let Some(t) = threshold_db {
        cfg.onset_threshold_db = Some(t);
        cfg.offset_threshold_db = Some(t - 10.0);
    }
    if let Some(ms) = min_silence_duration_ms {
        cfg.min_silence_duration_ms = Some(ms);
    }
    if let Some(pad) = speech_pad_ms {
        cfg.padding_pre_ms = Some(pad);
        cfg.padding_post_ms = Some(pad);
    }
    split_by_silence(input_path, Some(cfg), None).await
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    /// Генератор тестового синусоидального тона заданной частоты, амплитуды и длительности
    fn generate_sine_wave(sample_rate: u32, duration_sec: f32, freq_hz: f32, amplitude: f32) -> Vec<f32> {
        let total_samples = (sample_rate as f32 * duration_sec) as usize;
        let mut samples = Vec::with_capacity(total_samples);
        for i in 0..total_samples {
            let t = i as f32 / sample_rate as f32;
            let sample = amplitude * (2.0 * PI * freq_hz * t).sin();
            samples.push(sample);
        }
        samples
    }

    /// Краевой случай 1: Абсолютная тишина (все сэмплы 0.0)
    #[test]
    fn test_absolute_silence() {
        let sr = 48000;
        let silence_samples = vec![0.0_f32; sr as usize * 3]; // 3 секунды тишины
        let config = SilenceSplitConfig::default();

        let (segments, noise_floor, _, _) = detect_speech_segments(&silence_samples, sr, &config);

        assert_eq!(segments.len(), 0, "В абсолютной тишине не должно быть создано реплик");
        assert!(noise_floor <= -100.0, "Noise floor тишины должен быть минимальным");
    }

    /// Краевой случай 2: Непрерывный громкий крик / звук без единой паузы (5 секунд громкого синуса 0.8)
    #[test]
    fn test_continuous_loud_speech_no_pauses() {
        let sr = 48000;
        let loud_samples = generate_sine_wave(sr, 5.0, 440.0, 0.8); // -1.9 dBFS
        let config = SilenceSplitConfig::default();

        let (segments, _, onset_db, _) = detect_speech_segments(&loud_samples, sr, &config);

        assert_eq!(segments.len(), 1, "Непрерывный звук без пауз должен сформировать ровно 1 сегмент");
        assert_eq!(segments[0].sample_start, 0);
        assert_eq!(segments[0].sample_end, loud_samples.len());
        assert!(segments[0].average_db > onset_db);
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 5000);
    }

    /// Краевой случай 3: Короткий щелчок / всплеск (< min_speech_duration_ms = 200 мс)
    #[test]
    fn test_short_click_discarded() {
        let sr = 48000;
        let mut samples = vec![0.0_f32; sr as usize * 2]; // 2 секунды тишины
        // Вставляем короткий импульс длительностью 80 мс (меньше 200 мс)
        let click = generate_sine_wave(sr, 0.08, 1000.0, 0.5);
        let insert_pos = sr as usize / 2;
        for (i, &s) in click.iter().enumerate() {
            samples[insert_pos + i] = s;
        }

        let config = SilenceSplitConfig {
            min_speech_duration_ms: Some(200),
            ..Default::default()
        };

        let (segments, _, _, _) = detect_speech_segments(&samples, sr, &config);
        assert_eq!(segments.len(), 0, "Короткий импульс меньше 200 мс должен быть отфильтрован VAD");
    }

    /// Краевой случай 4: Короткая пауза (< min_silence_duration_ms = 300 мс) между словами должна объединяться
    #[test]
    fn test_short_pause_merged() {
        let sr = 48000;
        let mut samples = Vec::new();

        // 1 сек речь + 150 мс тишина (меньше 300 мс) + 1 сек речь
        samples.extend(generate_sine_wave(sr, 1.0, 440.0, 0.6));
        samples.extend(vec![0.0_f32; (sr as f32 * 0.15) as usize]);
        samples.extend(generate_sine_wave(sr, 1.0, 440.0, 0.6));

        let config = SilenceSplitConfig {
            min_silence_duration_ms: Some(300),
            min_speech_duration_ms: Some(200),
            padding_pre_ms: Some(80),
            padding_post_ms: Some(150),
            ..Default::default()
        };

        let (segments, _, _, _) = detect_speech_segments(&samples, sr, &config);
        assert_eq!(segments.len(), 1, "Реплики с микропаузой < 300 мс должны объединиться в один сегмент");
    }

    /// Краевой случай 5: Стандартный диалог с длинной паузой (> 300 мс) и защитными отступами (Padding)
    #[test]
    fn test_dialogue_split_with_padding() {
        let sr = 48000;
        let mut samples = Vec::new();

        // 500 мс тишина в начале
        samples.extend(vec![0.0_f32; (sr as f32 * 0.5) as usize]);
        // Фраза 1: 1.0 сек
        samples.extend(generate_sine_wave(sr, 1.0, 300.0, 0.7));
        // Пауза 600 мс (> 300 мс)
        samples.extend(vec![0.0_f32; (sr as f32 * 0.6) as usize]);
        // Фраза 2: 1.0 сек
        samples.extend(generate_sine_wave(sr, 1.0, 300.0, 0.7));
        // 500 мс тишина в конце
        samples.extend(vec![0.0_f32; (sr as f32 * 0.5) as usize]);

        let config = SilenceSplitConfig {
            min_silence_duration_ms: Some(300),
            min_speech_duration_ms: Some(200),
            padding_pre_ms: Some(80),
            padding_post_ms: Some(150),
            ..Default::default()
        };

        let (segments, _, _, _) = detect_speech_segments(&samples, sr, &config);
        assert_eq!(segments.len(), 2, "Должно быть нарезано ровно 2 реплики");

        // Проверка отступов: старт первой фразы должен начаться раньше ~на 80 мс
        // Сырая фраза началась на 500 мс, значит с padding_pre_ms=80 старт ~420 мс
        assert!(segments[0].start_ms <= 430 && segments[0].start_ms >= 410, "Старт первой фразы с pre-padding: {} мс", segments[0].start_ms);
        assert!(segments[0].sample_end < segments[1].sample_start, "Сегменты не должны перекрываться");
    }

    /// Краевой случай 6: Разрешение наложения отступов (Overlap Resolution)
    #[test]
    fn test_overlap_resolution_near_phrases() {
        let sr = 48000;
        let mut samples = Vec::new();

        // Фраза 1: 1 сек
        samples.extend(generate_sine_wave(sr, 1.0, 440.0, 0.7));
        // Пауза 320 мс (чуть больше min_silence=300, но меньше суммы pre 80ms + post 150ms = 230ms)
        samples.extend(vec![0.0_f32; (sr as f32 * 0.32) as usize]);
        // Фраза 2: 1 сек
        samples.extend(generate_sine_wave(sr, 1.0, 440.0, 0.7));

        let config = SilenceSplitConfig {
            min_silence_duration_ms: Some(300),
            min_speech_duration_ms: Some(200),
            padding_pre_ms: Some(80),
            padding_post_ms: Some(150),
            ..Default::default()
        };

        let (segments, _, _, _) = detect_speech_segments(&samples, sr, &config);
        assert_eq!(segments.len(), 2, "Должно быть 2 реплики");
        assert!(
            segments[0].sample_end <= segments[1].sample_start,
            "Конец первой фразы ({}) должен быть <= старта второй фразы ({})",
            segments[0].sample_end,
            segments[1].sample_start
        );
    }
}
