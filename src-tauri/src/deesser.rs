use std::path::Path;
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use biquad::{Biquad, Coefficients, DirectForm2Transposed, Hertz, ToHertz, Type, Q_BUTTERWORTH_F32};

/// Режим работы деэссера
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeEsserMode {
    /// Split-Band: подавление гейна только в высокочастотной полосе сибилянтов
    SplitBand,
    /// Wideband: широкополосное подавление всего сигнала во время сибилянта
    Wideband,
}

/// Отчет о результатах деэссинга аудиофайла
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeEsserReport {
    pub sibilants_detected: usize,
    pub max_reduction_db: f32,
    pub channels: u16,
    pub sample_rate: u32,
    pub duration_sec: f64,
    pub processed_path: String,
}

/// Фильтры и состояние детектора для одного аудиоканала
#[derive(Debug, Clone)]
struct ChannelState {
    /// Сайдчейн полосовой фильтр (Bandpass)
    sidechain_filter: DirectForm2Transposed<f32>,
    /// Кроссовер Low-Pass (Linkwitz-Riley 4-го порядка: два каскадных фильтра Баттерворта 2-го порядка)
    lp1: DirectForm2Transposed<f32>,
    lp2: DirectForm2Transposed<f32>,
    /// Кроссовер High-Pass (Linkwitz-Riley 4-го порядка: два каскадных фильтра Баттерворта 2-го порядка)
    hp1: DirectForm2Transposed<f32>,
    hp2: DirectForm2Transposed<f32>,
    /// Текущее среднеквадратичное значение мощности (RMS power state)
    rms_power: f32,
    /// Сглаженное текущее значение коэффициента усиления (gain factor 0.0..1.0)
    current_gain: f32,
}

/// Высокоточный спектральный / полосный деэссер (Split-Band De-Esser)
pub struct DeEsser {
    sample_rate: f32,
    frequency: f32,
    threshold_db: f32,
    ratio: f32,
    knee_width_db: f32,
    mode: DeEsserMode,
    channels: Vec<ChannelState>,
    // Коэффициенты баллистики RMS детектора
    alpha_att: f32,
    alpha_rel: f32,
    // Коэффициенты баллистики для плавного гейна (устранение кликов)
    alpha_gain_att: f32,
    alpha_gain_rel: f32,
    // Статистика
    sibilants_count: usize,
    max_reduction_db: f32,
    in_sibilant: bool,
}

impl DeEsser {
    /// Создает новый экземпляр DeEsser с заданными параметрами:
    /// - `sample_rate`: Частота дискретизации аудио (например, 44100.0 или 48000.0 Гц)
    /// - `frequency`: Центральная частота сайдчейн-фильтра сибилянтов (по умолчанию 6500.0 Гц)
    /// - `threshold`: Порог срабатывания в dBFS (например, -20.0 dBFS)
    /// - `ratio`: Степень сжатия компрессора (например, 4.0 или 6.0)
    pub fn new(sample_rate: f32, frequency: f32, threshold: f32, ratio: f32) -> Self {
        Self::with_channels(sample_rate, frequency, threshold, ratio, 2)
    }

    /// Создает экземпляр с заданным числом каналов (моно, стерео или многоканальный)
    pub fn with_channels(
        sample_rate: f32,
        frequency: f32,
        threshold: f32,
        ratio: f32,
        num_channels: usize,
    ) -> Self {
        let sr = if sample_rate <= 0.0 { 48000.0 } else { sample_rate };
        let freq = if frequency <= 0.0 { 6500.0 } else { frequency };
        let thresh = if threshold == 0.0 { -20.0 } else { threshold };
        let rat = if ratio < 1.1 { 4.0 } else { ratio };

        // Быстрая атака RMS: 1.5 мс
        let tau_att = 0.0015_f32;
        let alpha_att = (-1.0 / (sr * tau_att)).exp();

        // Релиз RMS: 50 мс
        let tau_rel = 0.050_f32;
        let alpha_rel = (-1.0 / (sr * tau_rel)).exp();

        // Сглаживание изменения гейна (Gain smoothing: 1 мс атака, 15 мс релиз)
        let alpha_gain_att = (-1.0 / (sr * 0.0010)).exp();
        let alpha_gain_rel = (-1.0 / (sr * 0.0150)).exp();

        let channels_count = num_channels.max(1);
        let mut channels = Vec::with_capacity(channels_count);

        for _ in 0..channels_count {
            channels.push(Self::create_channel_state(sr, freq));
        }

        Self {
            sample_rate: sr,
            frequency: freq,
            threshold_db: thresh,
            ratio: rat,
            knee_width_db: 6.0,
            mode: DeEsserMode::SplitBand,
            channels,
            alpha_att,
            alpha_rel,
            alpha_gain_att,
            alpha_gain_rel,
            sibilants_count: 0,
            max_reduction_db: 0.0,
            in_sibilant: false,
        }
    }

    /// Устанавливает ширину плавного soft-knee сжатия в децибелах
    pub fn set_knee_width(&mut self, knee_db: f32) {
        self.knee_width_db = knee_db.clamp(1.0, 18.0);
    }

    /// Устанавливает режим работы: SplitBand или Wideband
    pub fn set_mode(&mut self, mode: DeEsserMode) {
        self.mode = mode;
    }

    /// Вспомогательный метод для инициализации DSP фильтров канала через crate biquad
    fn create_channel_state(sample_rate: f32, frequency: f32) -> ChannelState {
        let nyquist = sample_rate * 0.49;
        let clamped_freq = frequency.clamp(1000.0, nyquist - 200.0);

        let fs = Hertz::<f32>::from_hz(sample_rate).unwrap_or_else(|_| 48000.0_f32.hz());
        let f0 = Hertz::<f32>::from_hz(clamped_freq).unwrap_or_else(|_| 6500.0_f32.hz());

        // 1. Сайдчейн: Bandpass фильтр с добротностью Q = 2.0 на заданной частоте (по умолчанию 6.5 кГц)
        let bp_coeffs = Coefficients::<f32>::from_params(Type::BandPass, fs, f0, 2.0)
            .unwrap_or_else(|_| {
                Coefficients::<f32>::from_params(Type::BandPass, fs, 6500.0_f32.hz(), 2.0).unwrap()
            });
        let sidechain_filter = DirectForm2Transposed::<f32>::new(bp_coeffs);

        // 2. Кроссовер частота для Split-Band: точка сопряжения низких частот и шипящих согласных
        // Рекомендуемое значение: ~0.72 от центральной частоты детектора (для 6.5 кГц -> ~4.7 кГц)
        let cross_freq = (clamped_freq * 0.72).clamp(2000.0, nyquist - 400.0);
        let f_cross = Hertz::<f32>::from_hz(cross_freq).unwrap_or_else(|_| 4680.0_f32.hz());

        // Linkwitz-Riley 4-го порядка (LR-4) = каскад из двух идентичных Butterworth 2-го порядка (Q ≈ 0.707)
        // Гарантирует абсолютно линейное сложение LP + HP = 1.0 (flat response) без фазовых артефактов
        let lp_coeffs = Coefficients::<f32>::from_params(Type::LowPass, fs, f_cross, Q_BUTTERWORTH_F32)
            .unwrap();
        let hp_coeffs = Coefficients::<f32>::from_params(Type::HighPass, fs, f_cross, Q_BUTTERWORTH_F32)
            .unwrap();

        let lp1 = DirectForm2Transposed::<f32>::new(lp_coeffs);
        let lp2 = DirectForm2Transposed::<f32>::new(lp_coeffs);
        let hp1 = DirectForm2Transposed::<f32>::new(hp_coeffs);
        let hp2 = DirectForm2Transposed::<f32>::new(hp_coeffs);

        ChannelState {
            sidechain_filter,
            lp1,
            lp2,
            hp1,
            hp2,
            rms_power: 1e-10,
            current_gain: 1.0,
        }
    }

    /// Вычисляет коэффициент ослабления гейна (Gain Reduction) с мягким коленом (Soft-Knee)
    #[inline]
    fn compute_gain_reduction_db(&self, level_db: f32) -> f32 {
        let half_knee = self.knee_width_db * 0.5;
        let delta = level_db - self.threshold_db;

        if delta <= -half_knee {
            // Уровень ниже порога и зоны soft-knee: сжатия нет
            0.0
        } else if delta >= half_knee {
            // Уровень выше зоны soft-knee: стандартное линейное сжатие по ratio
            (1.0 - 1.0 / self.ratio) * delta
        } else {
            // Зона плавного soft-knee: квадратичный переход без резких изломов характеристики
            let knee_input = delta + half_knee;
            (1.0 - 1.0 / self.ratio) * (knee_input * knee_input) / (2.0 * self.knee_width_db)
        }
    }

    /// Обработка одного аудиофрейма (среза сэмплов для всех каналов в текущий момент времени).
    /// Срез модифицируется in-place.
    /// Длина `frame` определяет число активных каналов (1 для моно, 2 для стерео).
    pub fn process_frame(&mut self, frame: &mut [f32]) {
        let frame_len = frame.len();
        if frame_len == 0 {
            return;
        }

        // При необходимости динамически расширяем внутреннее состояние каналов
        while self.channels.len() < frame_len {
            self.channels.push(Self::create_channel_state(self.sample_rate, self.frequency));
        }

        // 1. Сайдчейн-анализ и вычисление RMS мощности для каждого канала
        let mut max_level_db = -120.0_f32;
        let mut channel_levels = [0.0_f32; 8];

        for (ch, sample) in frame.iter().enumerate().take(frame_len) {
            let state = &mut self.channels[ch];
            
            // Фильтрация сайдчейна полосовым фильтром (Bandpass 6.5 кГц, Q=2.0)
            let sc_sample = state.sidechain_filter.run(*sample);
            let instant_power = sc_sample * sc_sample;

            // RMS детектор с баллистикой атаки (1.5 мс) и релиза (50 мс)
            if instant_power > state.rms_power {
                state.rms_power = self.alpha_att * state.rms_power + (1.0 - self.alpha_att) * instant_power;
            } else {
                state.rms_power = self.alpha_rel * state.rms_power + (1.0 - self.alpha_rel) * instant_power;
            }

            // Перевод RMS мощности в уровень dBFS
            let level_db = 10.0 * (state.rms_power + 1e-12).log10();
            if ch < 8 {
                channel_levels[ch] = level_db;
            }
            if level_db > max_level_db {
                max_level_db = level_db;
            }
        }

        // Для стерео/многоканала используем связанный детектор (Stereo Linking),
        // чтобы избежать смещения стереопанорамы во время произнесения согласных «С», «З», «Щ»
        let detection_level_db = if frame_len > 1 { max_level_db } else { channel_levels[0] };

        // 2. Расчет Gain Reduction с Soft-Knee
        let gr_db = self.compute_gain_reduction_db(detection_level_db);
        let target_gain = 10.0_f32.powf(-gr_db / 20.0);

        // Статистика детекции сибилянтов
        if gr_db > 1.2 {
            if !self.in_sibilant {
                self.sibilants_count += 1;
                self.in_sibilant = true;
            }
            if gr_db > self.max_reduction_db {
                self.max_reduction_db = gr_db;
            }
        } else if self.in_sibilant && gr_db < 0.3 {
            self.in_sibilant = false;
        }

        // 3. Плавная интерполяция гейна и применение сжатия к каналам
        for (ch, sample) in frame.iter_mut().enumerate().take(frame_len) {
            let state = &mut self.channels[ch];

            // Сглаживание гейна для предотвращения щелчков (anti-click gain filter)
            if target_gain < state.current_gain {
                state.current_gain = self.alpha_gain_att * state.current_gain + (1.0 - self.alpha_gain_att) * target_gain;
            } else {
                state.current_gain = self.alpha_gain_rel * state.current_gain + (1.0 - self.alpha_gain_rel) * target_gain;
            }
            let g = state.current_gain;

            let in_val = *sample;
            match self.mode {
                DeEsserMode::SplitBand => {
                    // Разделение через Linkwitz-Riley 4-го порядка
                    // НЧ составляющая голоса проходит без изменений
                    let low = state.lp2.run(state.lp1.run(in_val));
                    // ВЧ составляющая (сибилянты) ослабляется на вычисленный гейн
                    let high = state.hp2.run(state.hp1.run(in_val));
                    *sample = low + g * high;
                }
                DeEsserMode::Wideband => {
                    // Широкополосное ослабление всего сигнала
                    *sample = in_val * g;
                }
            }
        }
    }

    /// Сбрасывает фильтры и внутренние состояния каналов
    pub fn reset(&mut self) {
        for state in &mut self.channels {
            state.sidechain_filter.reset();
            state.lp1.reset();
            state.lp2.reset();
            state.hp1.reset();
            state.hp2.reset();
            state.rms_power = 1e-10;
            state.current_gain = 1.0;
        }
        self.in_sibilant = false;
    }

    /// Возвращает общее количество обнаруженных и обработанных сибилянтов
    pub fn sibilants_detected(&self) -> usize {
        self.sibilants_count
    }

    /// Возвращает максимальное достигнутое ослабление в дБ
    pub fn max_reduction_db(&self) -> f32 {
        self.max_reduction_db
    }
}

/// Чтение сэмплов из WAV файла в нормализованный буфер f32 [-1.0, 1.0] с чередованием каналов
fn read_wav_interleaved_f32(path: &Path) -> Result<(Vec<f32>, WavSpec), String> {
    let mut reader = WavReader::open(path)
        .map_err(|e| format!("Не удалось открыть WAV файл {}: {}", path.display(), e))?;
    let spec = reader.spec();

    if spec.channels == 0 || spec.sample_rate == 0 {
        return Err("Некорректный WAV: число каналов или sample rate равен нулю".to_string());
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
                b => return Err(format!("Неподдерживаемая разрядность: {} бит", b)),
            }
        }
    };

    Ok((samples, spec))
}

/// Выполняет синхронную обработку WAV файла деэссером
pub fn process_deesser_file(
    input_path: &Path,
    output_path: &Path,
    frequency: f32,
    threshold: f32,
    ratio: f32,
) -> Result<DeEsserReport, String> {
    if !input_path.exists() {
        return Err(format!("Входной файл не существует: {}", input_path.display()));
    }

    let (mut interleaved_samples, spec) = read_wav_interleaved_f32(input_path)?;
    let channels = spec.channels as usize;
    let sample_rate = spec.sample_rate;
    let total_frames = interleaved_samples.len() / channels;
    let duration_sec = total_frames as f64 / sample_rate as f64;

    // Инициализируем высокоточный DeEsser для данного файла
    let mut deesser = DeEsser::with_channels(
        sample_rate as f32,
        frequency,
        threshold,
        ratio,
        channels,
    );

    // Обработка по фреймам через метод process_frame(&mut [f32])
    let mut frame = vec![0.0_f32; channels];
    for f in 0..total_frames {
        let frame_start = f * channels;
        for ch in 0..channels {
            frame[ch] = interleaved_samples[frame_start + ch];
        }

        deesser.process_frame(&mut frame);

        for ch in 0..channels {
            interleaved_samples[frame_start + ch] = frame[ch];
        }
    }

    // Создание родительской директории при необходимости
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Не удалось создать директорию вывода: {}", e))?;
    }

    // Запись результата в 32-bit Float WAV для сохранения полного динамического диапазона без клиппинга
    let out_spec = WavSpec {
        channels: spec.channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output_path, out_spec)
        .map_err(|e| format!("Не удалось создать выходной файл {}: {}", output_path.display(), e))?;

    for sample in interleaved_samples {
        writer.write_sample(sample)
            .map_err(|e| format!("Ошибка записи сэмпла WAV: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| format!("Ошибка финализации WAV файла: {}", e))?;

    Ok(DeEsserReport {
        sibilants_detected: deesser.sibilants_detected(),
        max_reduction_db: (deesser.max_reduction_db() * 10.0).round() / 10.0,
        channels: spec.channels,
        sample_rate,
        duration_sec: (duration_sec * 100.0).round() / 100.0,
        processed_path: output_path.to_string_lossy().to_string(),
    })
}

/// Команда Tauri v2: process_deesser
///
/// Аргументы:
/// - `input_path`: Путь к входному WAV файлу
/// - `output_path`: Путь к выходному обработанному WAV файлу
/// - `frequency`: Центральная частота сайдчейна (например, 6500.0 Гц)
/// - `threshold`: Порог компрессии в dBFS (например, -20.0 dBFS)
/// - `ratio`: Степень сжатия компрессора (например, 4.0 или 6.0)
#[tauri::command]
pub async fn process_deesser(
    input_path: String,
    output_path: String,
    frequency: f32,
    threshold: f32,
    ratio: f32,
) -> Result<DeEsserReport, String> {
    let in_p = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&input_path));
    let out_p = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&output_path));

    tokio::task::spawn_blocking(move || {
        process_deesser_file(&in_p, &out_p, frequency, threshold, ratio)
    })
    .await
    .map_err(|e| format!("Ошибка выполнения задачи De-Esser: {}", e))?
}
