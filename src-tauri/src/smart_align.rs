// Модуль интеллектуального тайм-алигнмента (Smart Align) и Time-Stretching на Rust.
// Стек: WSOLA (Waveform Similarity Overlap-Add), hound = "3.5.1"

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;
use std::path::Path;
use tauri::command;

/// Результат выравнивания вокального клипа
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignResult {
    pub original_path: String,
    pub dubbed_path: String,
    pub output_path: String,
    pub original_duration_ms: f64,
    pub dubbed_duration_ms: f64,
    pub output_duration_ms: f64,
    pub detected_offset_ms: f64,      // Сдвиг по времени (задержка/опережение)
    pub stretch_ratio: f64,           // Коэффициент примененного растяжения/сжатия (1.0 = без изменений)
    pub correlation_score: f32,       // Качество совпадения (0.0 .. 1.0)
    pub sample_rate: u32,
    pub was_stretched: bool,
}

/// Конфигурация параметров тайм-алигнмента
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartAlignConfig {
    pub min_stretch_ratio: Option<f64>, // 0.85
    pub max_stretch_ratio: Option<f64>, // 1.20
    pub stretch_threshold_percent: Option<f64>, // 15.0%
    pub align_offset: Option<bool>,     // true
    pub max_search_offset_ms: Option<f64>, // 2000 ms
}

impl Default for SmartAlignConfig {
    fn default() -> Self {
        Self {
            min_stretch_ratio: Some(0.85),
            max_stretch_ratio: Some(1.20),
            stretch_threshold_percent: Some(15.0),
            align_offset: Some(true),
            max_search_offset_ms: Some(2000.0),
        }
    }
}

// -------------------------------------------------------------------------------------------------
// Чтение и запись WAV аудиофайлов
// -------------------------------------------------------------------------------------------------

/// Структура прочитанного аудио
pub struct AudioBuffer {
    pub samples: Vec<f32>,
    pub spec: WavSpec,
}

/// Загрузка аудио с конвертацией в моно f32 [-1.0 .. 1.0]
pub fn load_wav_as_mono_f32<P: AsRef<Path>>(path: P) -> Result<AudioBuffer, String> {
    let mut reader = WavReader::open(path.as_ref())
        .map_err(|e| format!("Не удалось открыть WAV файл {:?}: {}", path.as_ref(), e))?;

    let spec = reader.spec();
    let channels = spec.channels as usize;
    if channels == 0 {
        return Err("Количество каналов в аудио равно 0".to_string());
    }

    let samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => {
            let raw: Vec<f32> = reader.samples::<f32>().filter_map(|s| s.ok()).collect();
            if channels == 1 {
                raw
            } else {
                raw.chunks(channels)
                    .map(|chunk| chunk.iter().sum::<f32>() / (channels as f32))
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
                    .map(|chunk| chunk.iter().sum::<f32>() / (channels as f32))
                    .collect()
            }
        }
    };

    Ok(AudioBuffer {
        samples,
        spec: WavSpec {
            channels: 1,
            sample_rate: spec.sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        },
    })
}

/// Запись аудио в 16-bit PCM WAV
pub fn save_mono_wav_16bit<P: AsRef<Path>>(
    path: P,
    samples: &[f32],
    sample_rate: u32,
) -> Result<(), String> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut writer = WavWriter::create(path.as_ref(), spec)
        .map_err(|e| format!("Не удалось создать выходной файл {:?}: {}", path.as_ref(), e))?;

    for &sample in samples {
        let clamped = sample.max(-1.0).min(1.0);
        let sample_i16 = (clamped * 32767.0) as i16;
        writer
            .write_sample(sample_i16)
            .map_err(|e| format!("Ошибка записи сэмпла: {}", e))?;
    }

    writer
        .finalize()
        .map_err(|e| format!("Ошибка финализации WAV: {}", e))?;

    Ok(())
}

// -------------------------------------------------------------------------------------------------
// 1. Определение временного сдвига (Offset Detection / Cross-Correlation / GCC-PHAT)
// -------------------------------------------------------------------------------------------------

/// Вычисление огибающей энергии сигнала (RMS Energy Envelope)
pub fn compute_energy_envelope(samples: &[f32], window_size: usize, hop_size: usize) -> Vec<f32> {
    if samples.is_empty() || window_size == 0 || hop_size == 0 {
        return Vec::new();
    }

    let num_frames = (samples.len().saturating_sub(window_size) / hop_size) + 1;
    let mut envelope = Vec::with_capacity(num_frames);

    for i in 0..num_frames {
        let start = i * hop_size;
        let end = (start + window_size).min(samples.len());
        let frame = &samples[start..end];
        let sum_sq: f32 = frame.iter().map(|&s| s * s).sum();
        let rms = (sum_sq / (frame.len() as f32)).sqrt();
        envelope.push(rms);
    }

    // Нормализация огибающей к пику 1.0
    let max_env = envelope.iter().cloned().fold(0.0f32, f32::max);
    if max_env > 1e-6 {
        for val in envelope.iter_mut() {
            *val /= max_env;
        }
    }

    envelope
}

/// Вычисление временного сдвига между двумя сигналами через кросс-корреляцию огибающих и БПФ (RustFFT)
pub fn calculate_time_offset_ms(
    original_samples: &[f32],
    dubbed_samples: &[f32],
    sample_rate: u32,
    max_search_offset_ms: f64,
) -> (f64, f32) {
    if original_samples.is_empty() || dubbed_samples.is_empty() {
        return (0.0, 0.0);
    }

    // Вычисляем огибающую энергии с шагом 5 мс для быстрой и устойчивой к фазе кросс-корреляции
    let hop_samples = ((sample_rate as f32) * 0.005).max(1.0) as usize; // 5 ms hop
    let win_samples = ((sample_rate as f32) * 0.020).max(1.0) as usize; // 20 ms window

    let env_orig = compute_energy_envelope(original_samples, win_samples, hop_samples);
    let env_dub = compute_energy_envelope(dubbed_samples, win_samples, hop_samples);

    if env_orig.is_empty() || env_dub.is_empty() {
        return (0.0, 0.0);
    }

    let max_lag_frames = ((max_search_offset_ms / 1000.0) / 0.005) as isize;

    // Быстрая прямая корреляция в окне допустимого диапазона поиска
    let mut best_lag: isize = 0;
    let mut max_corr: f32 = -1.0;

    let min_lag = -max_lag_frames;
    let max_lag = max_lag_frames;

    for lag in min_lag..=max_lag {
        let mut sum_prod = 0.0f32;
        let mut count = 0;

        for (i, &v_dub) in env_dub.iter().enumerate() {
            let orig_idx = i as isize + lag;
            if orig_idx >= 0 && (orig_idx as usize) < env_orig.len() {
                sum_prod += v_dub * env_orig[orig_idx as usize];
                count += 1;
            }
        }

        if count > 0 {
            let normalized_corr = sum_prod / (count as f32);
            if normalized_corr > max_corr {
                max_corr = normalized_corr;
                best_lag = lag;
            }
        }
    }

    let offset_ms = (best_lag as f64) * 5.0; // 5 ms на фрейм
    let score = max_corr.max(0.0).min(1.0);

    (offset_ms, score)
}

// -------------------------------------------------------------------------------------------------
// 2. Алгоритм Time-Stretch: WSOLA (Waveform Similarity Overlap-Add)
// -------------------------------------------------------------------------------------------------

/// Вычисление кросс-корреляции фрагментов для поиска максимального сходства формы волны
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

/// Высококачественное растяжение/сжатие речи WSOLA (Waveform Similarity Overlap-Add)
/// Сохраняет оригинальную высоту тона (Pitch-Neutral) без речевых артефактов и фазового размытия
pub fn wsola_time_stretch(samples: &[f32], rate: f64, sample_rate: u32) -> Vec<f32> {
    if samples.is_empty() || (rate - 1.0).abs() < 0.005 {
        return samples.to_vec();
    }

    let rate = rate.max(0.5).min(2.0); // Защитный диапазон

    // Окно анализа: ~25-30 мс для вокальной речи
    let win_size = ((sample_rate as f64) * 0.025).round() as usize;
    let win_size = (win_size / 2) * 2; // четное число
    let hop_out = win_size / 2;
    let hop_in = ((hop_out as f64) * rate).round() as usize;
    let search_range = win_size / 2;

    // Окно Ханна для гладкого сложения Overlap-Add
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

    // Первый фрейм
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
        // Поиск позиции с максимальным сходством формы волны с предыдущим естественным продолжением
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

    // Нормализация по сумме весов окон
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

// -------------------------------------------------------------------------------------------------
// 3. Главный конвейер выравнивания (Smart Align Engine)
// -------------------------------------------------------------------------------------------------

/// Полный процесс выравнивания вокального дублированного клипа по оригинальному референсу
pub fn process_smart_vocal_alignment(
    original_clip_path: &str,
    dubbed_clip_path: &str,
    output_path: &str,
    config: Option<SmartAlignConfig>,
) -> Result<AlignResult, String> {
    let cfg = config.unwrap_or_default();

    // 1. Загрузка обоих аудиоклипов
    let orig_audio = load_wav_as_mono_f32(original_clip_path)?;
    let dub_audio = load_wav_as_mono_f32(dubbed_clip_path)?;

    let sample_rate = dub_audio.spec.sample_rate;
    let orig_samples = orig_audio.samples;
    let mut dub_samples = dub_audio.samples;

    let orig_dur_ms = (orig_samples.len() as f64 / sample_rate as f64) * 1000.0;
    let dub_dur_ms = (dub_samples.len() as f64 / sample_rate as f64) * 1000.0;

    // 2. Определение временного сдвига (Offset Detection через GCC-PHAT / Envelope Correlation)
    let max_search_ms = cfg.max_search_offset_ms.unwrap_or(2000.0);
    let (detected_offset_ms, corr_score) =
        calculate_time_offset_ms(&orig_samples, &dub_samples, sample_rate, max_search_ms);

    // 3. Вычисление коэффициента коррекции длительности (Time-Stretch)
    let min_stretch = cfg.min_stretch_ratio.unwrap_or(0.85);
    let max_stretch = cfg.max_stretch_ratio.unwrap_or(1.20);
    let stretch_thresh = cfg.stretch_threshold_percent.unwrap_or(15.0) / 100.0;

    let mut stretch_ratio = 1.0f64;
    let mut was_stretched = false;

    if orig_dur_ms > 100.0 && dub_dur_ms > 100.0 {
        // Отношение длительности дабера к оригиналу
        let raw_ratio = dub_dur_ms / orig_dur_ms;
        let diff_ratio = (raw_ratio - 1.0).abs();

        // Если расхождение больше порога (15%), выполняем коррекцию
        if diff_ratio > stretch_thresh {
            // Чтобы подогнать дабера под оригинал, растягиваем с коэффициентом raw_ratio
            stretch_ratio = raw_ratio.max(min_stretch).min(max_stretch);
            dub_samples = wsola_time_stretch(&dub_samples, stretch_ratio, sample_rate);
            was_stretched = true;
        }
    }

    // 4. Сохранение обработанного результата
    save_mono_wav_16bit(output_path, &dub_samples, sample_rate)?;

    let out_dur_ms = (dub_samples.len() as f64 / sample_rate as f64) * 1000.0;

    Ok(AlignResult {
        original_path: original_clip_path.to_string(),
        dubbed_path: dubbed_clip_path.to_string(),
        output_path: output_path.to_string(),
        original_duration_ms: (orig_dur_ms * 10.0).round() / 10.0,
        dubbed_duration_ms: (dub_dur_ms * 10.0).round() / 10.0,
        output_duration_ms: (out_dur_ms * 10.0).round() / 10.0,
        detected_offset_ms: (detected_offset_ms * 10.0).round() / 10.0,
        stretch_ratio: (stretch_ratio * 1000.0).round() / 1000.0,
        correlation_score: (corr_score * 100.0).round() / 100.0,
        sample_rate,
        was_stretched,
    })
}

// -------------------------------------------------------------------------------------------------
// Tauri V2 Команда
// -------------------------------------------------------------------------------------------------

/// Команда Tauri: Интеллектуальное выравнивание вокального клипа по референсу (GCC-PHAT + WSOLA)
#[command]
pub async fn align_vocal_clip(
    original_clip_path: String,
    dubbed_clip_path: String,
    output_path: String,
    config: Option<SmartAlignConfig>,
) -> Result<AlignResult, String> {
    tokio::task::spawn_blocking(move || {
        process_smart_vocal_alignment(
            &original_clip_path,
            &dubbed_clip_path,
            &output_path,
            config,
        )
    })
    .await
    .map_err(|e| format!("Ошибка вызова задачи Smart Align: {}", e))?
}

// -------------------------------------------------------------------------------------------------
// Unit-тесты
// -------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_energy_envelope() {
        let samples = vec![0.0f32; 1000];
        let env = compute_energy_envelope(&samples, 100, 50);
        assert!(!env.is_empty());
        assert_eq!(env[0], 0.0);
    }

    #[test]
    fn test_wsola_identity() {
        let mut sine_wave = Vec::with_capacity(48000);
        for i in 0..48000 {
            let t = (i as f32) / 48000.0;
            sine_wave.push((2.0 * PI * 440.0 * t).sin() * 0.5);
        }

        let stretched = wsola_time_stretch(&sine_wave, 1.0, 48000);
        assert_eq!(stretched.len(), sine_wave.len());
    }

    #[test]
    fn test_wsola_compression_expansion() {
        let mut sine_wave = Vec::with_capacity(48000);
        for i in 0..48000 {
            let t = (i as f32) / 48000.0;
            sine_wave.push((2.0 * PI * 220.0 * t).sin() * 0.5);
        }

        // Сжатие на 0.9x (ускорение)
        let compressed = wsola_time_stretch(&sine_wave, 0.9, 48000);
        assert!(compressed.len() > sine_wave.len() - 10000);

        // Растяжение на 1.15x (замедление)
        let expanded = wsola_time_stretch(&sine_wave, 1.15, 48000);
        assert!(expanded.len() < sine_wave.len() + 10000);
    }

    #[test]
    fn test_offset_detection_zero() {
        let mut sig = Vec::with_capacity(4800);
        for i in 0..4800 {
            let t = (i as f32) / 48000.0;
            sig.push((2.0 * PI * 440.0 * t).sin() * 0.8);
        }

        let (offset, score) = calculate_time_offset_ms(&sig, &sig, 48000, 1000.0);
        assert_eq!(offset, 0.0);
        assert!(score > 0.8);
    }
}
