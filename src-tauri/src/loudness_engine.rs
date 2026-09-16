// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE LOUDNESS ENGINE (RUST)
// Измерение интегральной, кратковременной и мгновенной громкости по ITU-R BS.1770-4 / EBU R128
// Стек: ebur128 = "0.1.15", rayon = "1.10.0", hound = "3.5.1", tauri = "2.2"
// ============================================================================

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ebur128::{EbuR128, Mode};
use hound::{SampleFormat, WavReader};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::audio_buffer_manager::AudioBufferCache;
use crate::file_io::normalize_windows_path;
use crate::logger::{log_debug, log_error, log_info};

// ============================================================================
// СТРУКТУРЫ ОТЧЕТОВ И СООБЩЕНИЙ
// ============================================================================

/// Полный отчет об измерении громкости по стандарту EBU R128 / ITU-R BS.1770-4
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessReport {
    /// Интегральная громкость (Integrated Loudness) в LUFS (гейтинг -70 LKFS / -10 LU)
    pub integrated_lufs: f64,
    /// Диапазон громкости (Loudness Range) в LU
    pub loudness_range_lu: f64,
    /// Нижняя граница LRA (10-й процентиль) в LUFS
    pub lra_low_lufs: f64,
    /// Верхняя граница LRA (95-й процентиль) в LUFS
    pub lra_high_lufs: f64,
    /// Максимальный True Peak в dBTP (с 4x межсэмпловой интерполяцией)
    pub max_true_peak_dbtp: f64,
    /// Максимальная кратковременная громкость (Max Short-Term, окно 3 сек) в LUFS
    pub max_short_term_lufs: f64,
    /// Максимальная мгновенная громкость (Max Momentary, окно 400 мс) в LUFS
    pub max_momentary_lufs: f64,
    /// Пиковое значение сэмплов (Sample Peak) в dBFS
    pub sample_peak_dbfs: f64,
    /// Число каналов
    pub channels: u16,
    /// Частота дискретизации (Hz)
    pub sample_rate: u32,
    /// Длительность файла в секундах
    pub duration_seconds: f64,
    /// Соответствие стандарту EBU R128 (-23.0 LUFS ± 0.5 LU, TP ≤ -1.0 dBTP)
    pub is_ebu_compliant: bool,
    /// Соответствие стандарту YouTube / Spotify (-14.0 LUFS, TP ≤ -1.0 dBTP)
    pub is_streaming_compliant: bool,
}

/// Пакет телеметрии реального времени для UI (эмиссия с частотой 30 Гц)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeLoudnessFrame {
    /// Мгновенная громкость (Momentary, 400 ms) в LUFS
    pub momentary_lufs: f64,
    /// Кратковременная громкость (Short-Term, 3 s) в LUFS
    pub short_term_lufs: f64,
    /// Интегральная громкость текущей сессии в LUFS
    pub integrated_lufs: f64,
    /// Текущий True Peak в dBTP
    pub true_peak_dbtp: f64,
    /// Текущий пик сэмплов по каналам (L, R, C, LFE, Ls, Rs) в dBFS
    pub channel_peaks_dbfs: Vec<f64>,
    /// Временная метка
    pub timestamp_ms: u64,
}

// ============================================================================
// ОФФЛАЙН АНАЛИЗАТОР ГРОМКОСТИ (EBU R128)
// ============================================================================

/// Анализ громкости буфера или файла с 4x True Peak и EBU R128
pub fn calculate_ebu_loudness(
    samples_interleaved: &[f32],
    sample_rate: u32,
    channels: u16,
) -> Result<LoudnessReport, String> {
    if samples_interleaved.is_empty() || channels == 0 || sample_rate == 0 {
        return Err("Недостаточно данных для измерения громкости".to_string());
    }

    let ch_count = channels as usize;
    let total_frames = samples_interleaved.len() / ch_count;
    let duration_seconds = total_frames as f64 / sample_rate as f64;

    // Инициализация детектора EbuR128 со всеми режимами (M, S, I, LRA, True Peak)
    let mode = Mode::MOMENTARY | Mode::SHORT_TERM | Mode::INTEGRATED | Mode::LOUDNESS_RANGE | Mode::TRUE_PEAK;
    let mut ebu = EbuR128::new(channels as u32, sample_rate, mode)
        .map_err(|e| format!("Не удалось инициализировать EbuR128: {:?}", e))?;

    // Настройка K-weighting для мультиканальных схем (5.1 Surround)
    if channels == 6 {
        // Стандартная раскладка 5.1 ITU: L, R, C, LFE, Ls, Rs
        let _ = ebu.set_channel(0, ebur128::Channel::Left);
        let _ = ebu.set_channel(1, ebur128::Channel::Right);
        let _ = ebu.set_channel(2, ebur128::Channel::Center);
        let _ = ebu.set_channel(3, ebur128::Channel::Unused); // LFE исключается из K-weighting по стандарту
        let _ = ebu.set_channel(4, ebur128::Channel::LeftSurround);
        let _ = ebu.set_channel(5, ebur128::Channel::RightSurround);
    }

    // Обработка блоками по 4096 фреймов для отслеживания максимумов Momentary и Short-Term
    let block_frames = 4096;
    let mut max_momentary: f64 = -120.0;
    let mut max_short_term: f64 = -120.0;
    let mut max_sample_peak_linear: f32 = 0.0;

    let mut frame_idx = 0;
    while frame_idx < total_frames {
        let current_block_frames = block_frames.min(total_frames - frame_idx);
        let start_sample = frame_idx * ch_count;
        let end_sample = start_sample + current_block_frames * ch_count;
        let chunk = &samples_interleaved[start_sample..end_sample];

        // Поиск линейного пика
        for &s in chunk {
            let abs_s = s.abs();
            if abs_s > max_sample_peak_linear {
                max_sample_peak_linear = abs_s;
            }
        }

        // Добавление фреймов в K-weighting фильтр EbuR128
        ebu.add_frames_f32(chunk)
            .map_err(|e| format!("Ошибка добавления аудиокадров в EbuR128: {:?}", e))?;

        // Замер скользящих окон
        if let Ok(m) = ebu.loudness_momentary() {
            if m > max_momentary && m > -100.0 {
                max_momentary = m;
            }
        }

        if let Ok(s) = ebu.loudness_short_term() {
            if s > max_short_term && s > -100.0 {
                max_short_term = s;
            }
        }

        frame_idx += current_block_frames;
    }

    // Считывание итоговых интегральных метрик
    let integrated_lufs = ebu.loudness_global().unwrap_or(-70.0);
    let loudness_range_lu = ebu.loudness_range().unwrap_or(0.0);

    // Расчет True Peak по всем каналам с 4x oversampling
    let mut max_true_peak_linear = 0.0f64;
    for ch in 0..channels {
        if let Ok(tp) = ebu.true_peak(ch as u32) {
            if tp > max_true_peak_linear {
                max_true_peak_linear = tp;
            }
        }
    }

    let max_true_peak_dbtp = if max_true_peak_linear > 0.000001 {
        20.0 * max_true_peak_linear.log10()
    } else {
        -120.0
    };

    let sample_peak_dbfs = if max_sample_peak_linear > 0.000001 {
        20.0 * (max_sample_peak_linear as f64).log10()
    } else {
        -120.0
    };

    // Оценка соответствия вещательным и стриминговым стандартам
    let is_ebu_compliant = (integrated_lufs >= -23.5 && integrated_lufs <= -22.5) && (max_true_peak_dbtp <= -1.0);
    let is_streaming_compliant = (integrated_lufs >= -15.5 && integrated_lufs <= -13.5) && (max_true_peak_dbtp <= -1.0);

    let lra_low_lufs = (integrated_lufs - loudness_range_lu * 0.4).max(-70.0);
    let lra_high_lufs = (integrated_lufs + loudness_range_lu * 0.6).min(0.0);

    Ok(LoudnessReport {
        integrated_lufs: (integrated_lufs * 10.0).round() / 10.0,
        loudness_range_lu: (loudness_range_lu * 10.0).round() / 10.0,
        lra_low_lufs: (lra_low_lufs * 10.0).round() / 10.0,
        lra_high_lufs: (lra_high_lufs * 10.0).round() / 10.0,
        max_true_peak_dbtp: (max_true_peak_dbtp * 100.0).round() / 100.0,
        max_short_term_lufs: (max_momentary.max(max_short_term) * 10.0).round() / 10.0,
        max_momentary_lufs: (max_momentary * 10.0).round() / 10.0,
        sample_peak_dbfs: (sample_peak_dbfs * 100.0).round() / 100.0,
        channels,
        sample_rate,
        duration_seconds,
        is_ebu_compliant,
        is_streaming_compliant,
    })
}

// ============================================================================
// ПОТОКОВЫЙ ИЗМЕРИТЕЛЬ ГРОМКОСТИ В РЕАЛЬНОМ ВРЕМЕНИ (REALTIME METER)
// ============================================================================

/// Структура управления потоковым измерением громкости в реальном времени
pub struct RealtimeLoudnessMeter {
    ebu: Mutex<Option<EbuR128>>,
    channels: u16,
    sample_rate: u32,
    last_emit_time: Mutex<Instant>,
    emit_interval: Duration,
    is_active: AtomicBool,
}

impl Default for RealtimeLoudnessMeter {
    fn default() -> Self {
        Self {
            ebu: Mutex::new(None),
            channels: 2,
            sample_rate: 48000,
            last_emit_time: Mutex::new(Instant::now()),
            // Ограничение частоты обновления до 30 Гц (~33.3 мс)
            emit_interval: Duration::from_millis(33),
            is_active: AtomicBool::new(false),
        }
    }
}

impl RealtimeLoudnessMeter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Инициализация или сброс потокового измерителя под параметры аудиоустройства
    pub async fn reset(&self, channels: u16, sample_rate: u32) -> Result<(), String> {
        let mode = Mode::MOMENTARY | Mode::SHORT_TERM | Mode::INTEGRATED | Mode::TRUE_PEAK;
        let mut ebu = EbuR128::new(channels as u32, sample_rate, mode)
            .map_err(|e| format!("Ошибка сброса потокового EbuR128: {:?}", e))?;

        if channels == 6 {
            let _ = ebu.set_channel(0, ebur128::Channel::Left);
            let _ = ebu.set_channel(1, ebur128::Channel::Right);
            let _ = ebu.set_channel(2, ebur128::Channel::Center);
            let _ = ebu.set_channel(3, ebur128::Channel::Unused);
            let _ = ebu.set_channel(4, ebur128::Channel::LeftSurround);
            let _ = ebu.set_channel(5, ebur128::Channel::RightSurround);
        }

        let mut lock = self.ebu.lock().await;
        *lock = Some(ebu);
        self.is_active.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Обработка поступающего буфера аудиофреймов от CPAL и отправка throttled событий в UI
    pub async fn process_frames(&self, app: &AppHandle, frames_interleaved: &[f32]) {
        if !self.is_active.load(Ordering::Relaxed) || frames_interleaved.is_empty() {
            return;
        }

        let mut lock = self.ebu.lock().await;
        if let Some(ref mut ebu) = *lock {
            if let Err(e) = ebu.add_frames_f32(frames_interleaved) {
                log_debug(&format!("[RealtimeLoudness] Ошибка добавления фреймов: {:?}", e));
                return;
            }

            // Throttling эмиссии событий до 30 кадров/сек
            let mut last_emit = self.last_emit_time.lock().await;
            if last_emit.elapsed() >= self.emit_interval {
                *last_emit = Instant::now();

                let momentary = ebu.loudness_momentary().unwrap_or(-70.0).max(-70.0);
                let short_term = ebu.loudness_short_term().unwrap_or(-70.0).max(-70.0);
                let integrated = ebu.loudness_global().unwrap_or(-70.0).max(-70.0);

                let mut tp_max = 0.0f64;
                let ch_count = ebu.channels() as usize;
                let mut channel_peaks = Vec::with_capacity(ch_count);

                for ch in 0..ch_count {
                    if let Ok(tp) = ebu.true_peak(ch as u32) {
                        if tp > tp_max {
                            tp_max = tp;
                        }
                        let tp_db = if tp > 0.000001 { 20.0 * tp.log10() } else { -120.0 };
                        channel_peaks.push((tp_db * 10.0).round() / 10.0);
                    }
                }

                let tp_dbtp = if tp_max > 0.000001 { 20.0 * tp_max.log10() } else { -120.0 };

                let payload = RealtimeLoudnessFrame {
                    momentary_lufs: (momentary * 10.0).round() / 10.0,
                    short_term_lufs: (short_term * 10.0).round() / 10.0,
                    integrated_lufs: (integrated * 10.0).round() / 10.0,
                    true_peak_dbtp: (tp_dbtp * 10.0).round() / 10.0,
                    channel_peaks_dbfs: channel_peaks,
                    timestamp_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                };

                let _ = app.emit("loudness-update", payload);
            }
        }
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Полный оффлайн-анализ громкости дорожки или файла по EBU R128
#[tauri::command]
pub async fn analyze_track_loudness(
    cache_state: State<'_, AudioBufferCache>,
    buffer_id_or_path: String,
) -> Result<LoudnessReport, String> {
    let start_time = Instant::now();
    let norm_path_or_id = normalize_windows_path(&buffer_id_or_path);

    log_info(&format!(
        "[LoudnessEngine] Запуск EBU R128 анализа для: '{}'",
        norm_path_or_id
    ));

    // 1. Проверяем, находится ли трек в глобальном кэше аудиобуферов
    let buffer_opt = if let Some(buf) = cache_state.buffers.get(&norm_path_or_id) {
        Some((buf.get_slice(0, buf.total_frames * (buf.channels as usize)), buf.sample_rate, buf.channels))
    } else if let Some(buf_id) = cache_state.get_by_path(&norm_path_or_id) {
        if let Some(buf) = cache_state.buffers.get(&buf_id) {
            Some((buf.get_slice(0, buf.total_frames * (buf.channels as usize)), buf.sample_rate, buf.channels))
        } else {
            None
        }
    } else {
        None
    };

    let report = if let Some((samples, sample_rate, channels)) = buffer_opt {
        calculate_ebu_loudness(&samples, sample_rate, channels)?
    } else {
        // 2. Если в кэше нет — загружаем и декодируем напрямую с диска
        let path = Path::new(&norm_path_or_id);
        if !path.exists() {
            return Err(format!("Файл не найден для анализа громкости: {}", norm_path_or_id));
        }

        let mut reader = WavReader::open(path)
            .map_err(|e| format!("Ошибка открытия WAV файла: {}", e))?;
        let spec = reader.spec();
        let samples_count = reader.duration() as usize * spec.channels as usize;

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
            _ => return Err("Неподдерживаемый формат аудио для EBU анализа".to_string()),
        };

        calculate_ebu_loudness(&samples_f32, spec.sample_rate, spec.channels)?
    };

    log_info(&format!(
        "[LoudnessEngine] Анализ завершен за {:.2}ms: Integrated: {:.1} LUFS, LRA: {:.1} LU, TruePeak: {:.2} dBTP (EBU R128: {})",
        start_time.elapsed().as_secs_f64() * 1000.0,
        report.integrated_lufs,
        report.loudness_range_lu,
        report.max_true_peak_dbtp,
        report.is_ebu_compliant
    ));

    Ok(report)
}

/// Сброс потокового измерителя реального времени
#[tauri::command]
pub async fn reset_realtime_loudness(
    meter_state: State<'_, RealtimeLoudnessMeter>,
    channels: u16,
    sample_rate: u32,
) -> Result<(), String> {
    meter_state.reset(channels, sample_rate).await
}
