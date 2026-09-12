use std::path::{Path, PathBuf};
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// Конфигурация выравнивателя громкости речи (Speech Vocal Leveler / AGC)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeLevelerConfig {
    /// Целевой уровень громкости слогов (по умолчанию -19.0 dBFS, коридор -18 .. -20 dBFS)
    pub target_db: f32,
    /// Нижняя граница целевого коридора (по умолчанию -20.0 dBFS)
    pub corridor_min_db: f32,
    /// Верхняя граница целевого коридора (по умолчанию -18.0 dBFS)
    pub corridor_max_db: f32,
    /// Порог нойз-гейта для отсечки тишины и фонового шума в паузах (по умолчанию -50.0 dBFS)
    pub gate_threshold_db: f32,
    /// Длительность быстрого RMS-окна в миллисекундах для детекции слогов речи (по умолчанию 50 мс)
    pub fast_window_ms: f32,
    /// Длительность медленного RMS-окна в миллисекундах для общего контекста фразы (по умолчанию 800 мс)
    pub slow_window_ms: f32,
    /// Длительность упреждающего буфера (Lookahead) в миллисекундах (по умолчанию 15 мс)
    pub lookahead_ms: f32,
    /// Максимально допустимое усиление тихого шепота в dB (по умолчанию +12.0 dB)
    pub max_boost_db: f32,
    /// Максимально допустимое ослабление громких вскриков в dB (по умолчанию -15.0 dB)
    pub max_attenuation_db: f32,
}

impl Default for VolumeLevelerConfig {
    fn default() -> Self {
        Self {
            target_db: -19.0,
            corridor_min_db: -20.0,
            corridor_max_db: -18.0,
            gate_threshold_db: -50.0,
            fast_window_ms: 50.0,
            slow_window_ms: 800.0,
            lookahead_ms: 15.0,
            max_boost_db: 12.0,
            max_attenuation_db: 15.0,
        }
    }
}

/// Итоговый отчет о работе вокального левелера
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeLevelerReport {
    pub input_path: String,
    pub output_path: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_sec: f64,
    pub initial_rms_db: f32,
    pub final_rms_db: f32,
    pub dynamic_range_compressed_db: f32,
    pub max_boost_applied_db: f32,
    pub max_cut_applied_db: f32,
    pub speech_percentage: f32,
}

/// Скользящий накопитель суммы квадратов O(1) для быстрого и стабильного расчета RMS
pub struct RunningRms {
    window_size: usize,
    buffer: Vec<f64>,
    index: usize,
    sum_sq: f64,
    count: usize,
}

impl RunningRms {
    pub fn new(window_size: usize) -> Self {
        let size = window_size.max(1);
        Self {
            window_size: size,
            buffer: vec![0.0; size],
            index: 0,
            sum_sq: 0.0,
            count: 0,
        }
    }

    #[inline(always)]
    pub fn update(&mut self, sample: f32) -> f32 {
        let x = sample as f64;
        let x_sq = x * x;

        if self.count < self.window_size {
            self.sum_sq += x_sq;
            self.buffer[self.index] = x_sq;
            self.index = (self.index + 1) % self.window_size;
            self.count += 1;
        } else {
            let oldest = self.buffer[self.index];
            self.sum_sq = (self.sum_sq - oldest + x_sq).max(0.0);
            self.buffer[self.index] = x_sq;
            self.index = (self.index + 1) % self.window_size;
        }

        let mean_sq = self.sum_sq / (self.count as f64);
        mean_sq.sqrt() as f32
    }
}

/// Преобразование линейной амплитуды в децибелы относительно полной шкалы (dBFS)
#[inline(always)]
pub fn linear_to_db(lin: f32) -> f32 {
    if lin <= 1e-6 {
        -120.0
    } else {
        20.0 * lin.log10()
    }
}

/// Преобразование децибел в линейный коэффициент усиления
#[inline(always)]
pub fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

/// Обработка одного аудиоканала с двухоконным RMS, Lookahead буфером и анти-пампинговым гейтом
pub fn process_channel(
    samples: &[f32],
    sample_rate: u32,
    config: &VolumeLevelerConfig,
) -> (Vec<f32>, f32, f32, f32) {
    let total_samples = samples.len();
    if total_samples == 0 {
        return (Vec::new(), 0.0, 0.0, 0.0);
    }

    let sr = sample_rate as f32;
    let fast_win_samples = ((config.fast_window_ms / 1000.0) * sr).round() as usize;
    let slow_win_samples = ((config.slow_window_ms / 1000.0) * sr).round() as usize;
    let lookahead_samples = ((config.lookahead_ms / 1000.0) * sr).round() as usize;

    let mut fast_rms = RunningRms::new(fast_win_samples);
    let mut slow_rms = RunningRms::new(slow_win_samples);

    // Векторы предварительно вычисленных целевых гейнов
    let mut target_gains = Vec::with_capacity(total_samples);
    let mut speech_samples_count = 0usize;

    // --- ЭТАП 1: Двухоконный RMS-анализ и вычисление сырого Gain Target ---
    for &s in samples {
        let r_fast = fast_rms.update(s);
        let r_slow = slow_rms.update(s);

        let db_fast = linear_to_db(r_fast);
        let db_slow = linear_to_db(r_slow);

        // Проверка порога тишины (Gate ниже -50 dBFS):
        // Если сигнал ниже порога, гейн равен 1.0 (0 dB), чтобы не задирать фоновый шум
        if db_fast < config.gate_threshold_db {
            target_gains.push(1.0_f32);
        } else {
            speech_samples_count += 1;

            // Взвешенная оценка уровня слога (70% быстрый слог, 30% контекст фразы)
            let speech_level_db = 0.70 * db_fast + 0.30 * db_slow;

            let diff_db = if speech_level_db < config.corridor_min_db {
                // Слишком тихо (шепот или окончание фразы) -> требуется усиление
                (config.target_db - speech_level_db).min(config.max_boost_db)
            } else if speech_level_db > config.corridor_max_db {
                // Слишком громко (вскрик или форсированная речь) -> требуется ослабление
                (config.target_db - speech_level_db).max(-config.max_attenuation_db)
            } else {
                // Сигнал идеально находится в целевом коридоре -18 .. -20 dBFS
                0.0
            };

            target_gains.push(db_to_linear(diff_db));
        }
    }

    // --- ЭТАП 2: Баллистика и сглаживание коэффициентов гейна ---
    // Для предотвращения щелчков и эффекта модуляции ("пампинга" / "zipper noise")
    // используем асимметричный фильтр 1-го порядка с раздельными временами атаки и релиза:
    // - Атака на ослабление (fast attack = 8 мс) для мгновенного обуздания вскриков
    // - Релиз после ослабления (slow release = 350 мс) для естественного восстановления
    // - Плавное нарастание гейна (gentle boost attack = 150 мс) для шепота
    let att_coeff = 1.0 - (-1.0 / (0.008 * sr)).exp();
    let rel_coeff = 1.0 - (-1.0 / (0.350 * sr)).exp();
    let boost_coeff = 1.0 - (-1.0 / (0.150 * sr)).exp();

    let mut smoothed_gains = Vec::with_capacity(total_samples);
    let mut current_gain = 1.0_f32;

    for &tgt in &target_gains {
        let coeff = if tgt < current_gain {
            // Ослабление громкости (быстрая реакция компрессора)
            att_coeff
        } else if tgt > 1.0 {
            // Нарастание усиления тихой речи (плавный буст без шума)
            boost_coeff
        } else {
            // Возврат к нейтральному уровню 1.0
            rel_coeff
        };

        current_gain += coeff * (tgt - current_gain);
        smoothed_gains.push(current_gain);
    }

    // Дополнительный проход сглаживания скользящим треугольным фильтром для непрерывности производных
    let smooth_rad = (0.003 * sr) as usize; // 3 мс сглаживания
    if smooth_rad > 1 && smooth_rad * 2 < total_samples {
        let mut final_gains = smoothed_gains.clone();
        for i in smooth_rad..(total_samples - smooth_rad) {
            let prev = smoothed_gains[i - smooth_rad];
            let cur = smoothed_gains[i];
            let next = smoothed_gains[i + smooth_rad];
            final_gains[i] = 0.25 * prev + 0.50 * cur + 0.25 * next;
        }
        smoothed_gains = final_gains;
    }

    // --- ЭТАП 3: Lookahead Буферизация и применение гейна к сдвинутому аудио ---
    // Сигнал задерживается на lookahead_samples, а гейн берется из будущего,
    // что гарантирует 100% готовность компрессора до начала резкой атаки!
    let mut output_samples = vec![0.0_f32; total_samples];
    let mut max_boost_seen_db = 0.0_f32;
    let mut max_cut_seen_db = 0.0_f32;

    for i in 0..total_samples {
        let gain_idx = (i + lookahead_samples).min(total_samples - 1);
        let g = smoothed_gains[gain_idx];

        let g_db = linear_to_db(g);
        if g_db > max_boost_seen_db {
            max_boost_seen_db = g_db;
        }
        if g_db < max_cut_seen_db {
            max_cut_seen_db = g_db;
        }

        output_samples[i] = (samples[i] * g).clamp(-1.0, 1.0);
    }

    let speech_ratio = speech_samples_count as f32 / total_samples as f32;
    (output_samples, max_boost_seen_db, max_cut_seen_db.abs(), speech_ratio)
}

/// Чтение сэмплов из WAV файла
pub fn read_wav(path: &Path) -> Result<(Vec<Vec<f32>>, WavSpec), String> {
    let mut reader = WavReader::open(path)
        .map_err(|e| format!("Не удалось открыть WAV файл {}: {}", path.display(), e))?;
    let spec = reader.spec();

    let channels = spec.channels as usize;
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
                8  => 128.0_f32,
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
}

/// Запись аудиоданных в файл формата 32-bit Float WAV
pub fn write_wav(
    output_path: &Path,
    channels: &[Vec<f32>],
    sample_rate: u32,
) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Не удалось создать папку {}: {}", parent.display(), e))?;
    }

    let num_channels = channels.len();
    let num_samples = channels[0].len();

    let spec = WavSpec {
        channels: num_channels as u16,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output_path, spec)
        .map_err(|e| format!("Не удалось создать WAV {}: {}", output_path.display(), e))?;

    for i in 0..num_samples {
        for ch in 0..num_channels {
            writer.write_sample(channels[ch][i])
                .map_err(|e| format!("Ошибка записи сэмпла в WAV: {}", e))?;
        }
    }

    writer.finalize()
        .map_err(|e| format!("Ошибка финализации WAV файла: {}", e))?;

    Ok(())
}

/// Расчет среднеквадратичного значения (RMS) сигнала в dBFS
pub fn calculate_overall_rms_db(channels: &[Vec<f32>]) -> f32 {
    let mut total_sq = 0.0_f64;
    let mut count = 0usize;

    for ch in channels {
        for &s in ch {
            total_sq += (s as f64) * (s as f64);
            count += 1;
        }
    }

    if count == 0 {
        return -120.0;
    }

    let mean_sq = total_sq / (count as f64);
    linear_to_db(mean_sq.sqrt() as f32)
}

/// Основной исполнительный пайплайн выравнивания громкости речи с поддержкой Rayon
pub fn execute_volume_leveler(
    input_path: &Path,
    output_path: &Path,
    config: &VolumeLevelerConfig,
) -> Result<VolumeLevelerReport, String> {
    let (channels_data, spec) = read_wav(input_path)?;
    let sample_rate = spec.sample_rate;
    let num_channels = channels_data.len();
    let total_samples = channels_data[0].len();
    let duration_sec = total_samples as f64 / sample_rate as f64;

    let initial_rms_db = calculate_overall_rms_db(&channels_data);

    // Параллельная многопоточная обработка каналов через Rayon
    let processed_results: Vec<(Vec<f32>, f32, f32, f32)> = channels_data
        .into_par_iter()
        .map(|channel_samples| {
            process_channel(&channel_samples, sample_rate, config)
        })
        .collect();

    let mut output_channels: Vec<Vec<f32>> = Vec::with_capacity(num_channels);
    let mut max_boost = 0.0_f32;
    let mut max_cut = 0.0_f32;
    let mut speech_percent_sum = 0.0_f32;

    for (out_ch, b, c, sp) in processed_results {
        output_channels.push(out_ch);
        if b > max_boost { max_boost = b; }
        if c > max_cut { max_cut = c; }
        speech_percent_sum += sp;
    }

    let avg_speech_ratio = speech_percent_sum / (num_channels as f32);
    let final_rms_db = calculate_overall_rms_db(&output_channels);

    // Запись выровненного аудиофайла
    write_wav(output_path, &output_channels, sample_rate)?;

    let dynamic_range_compressed = (max_boost + max_cut).round() / 1.0;

    Ok(VolumeLevelerReport {
        input_path: input_path.to_string_lossy().to_string(),
        output_path: output_path.to_string_lossy().to_string(),
        sample_rate,
        channels: spec.channels,
        duration_sec: (duration_sec * 100.0).round() / 100.0,
        initial_rms_db: (initial_rms_db * 10.0).round() / 10.0,
        final_rms_db: (final_rms_db * 10.0).round() / 10.0,
        dynamic_range_compressed_db: dynamic_range_compressed,
        max_boost_applied_db: (max_boost * 10.0).round() / 10.0,
        max_cut_applied_db: (max_cut * 10.0).round() / 10.0,
        speech_percentage: (avg_speech_ratio * 1000.0).round() / 10.0,
    })
}

/// Пакетная многопоточная обработка массива файлов через Rayon
#[allow(dead_code)]
pub fn batch_level_speech_volume(
    file_pairs: &[(PathBuf, PathBuf)],
    config: &VolumeLevelerConfig,
) -> Vec<Result<VolumeLevelerReport, String>> {
    file_pairs
        .par_iter()
        .map(|(in_p, out_p)| {
            execute_volume_leveler(in_p, out_p, config)
        })
        .collect()
}

/// Асинхронная команда Tauri v2 для выравнивания громкости речи внутри фраз
#[tauri::command]
pub async fn level_speech_volume(
    input_path: String,
    output_path: String,
    target_rms: Option<f32>,
    gate_threshold_db: Option<f32>,
    max_boost_db: Option<f32>,
    max_attenuation_db: Option<f32>,
) -> Result<VolumeLevelerReport, String> {
    let in_p = PathBuf::from(crate::file_io::normalize_windows_path(&input_path));
    let out_p = PathBuf::from(crate::file_io::normalize_windows_path(&output_path));

    if !in_p.exists() {
        return Err(format!("Входной файл не найден: {}", in_p.display()));
    }

    let mut config = VolumeLevelerConfig::default();
    if let Some(t) = target_rms {
        config.target_db = t;
        config.corridor_min_db = t - 1.0;
        config.corridor_max_db = t + 1.0;
    }
    if let Some(g) = gate_threshold_db {
        config.gate_threshold_db = g;
    }
    if let Some(b) = max_boost_db {
        config.max_boost_db = b;
    }
    if let Some(a) = max_attenuation_db {
        config.max_attenuation_db = a;
    }

    tokio::task::spawn_blocking(move || {
        execute_volume_leveler(&in_p, &out_p, &config)
    })
    .await
    .map_err(|e| format!("Ошибка задачи Tokio при выравнивании громкости: {}", e))?
}
