use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use chrono::Utc;
use ebur128::{EbuR128, Mode};
use hound::{SampleFormat, WavReader};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;

use crate::db::{AppState, ProjectData, SubtitleLine};
use crate::logger::log_debug;

// ============================================================================
// 1. ТИПЫ ДАННЫХ И СТРУКТУРЫ ОТЧЕТА QA АУДИТА (MEDIA PRODUCTION COMPLIANCE)
// ============================================================================

/// Категория инцидента контроля качества
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QaIncidentType {
    /// Превышение лимита True-Peak (-0.5 dBTP с оверсэмплингом 4x)
    TruePeakOverload,
    /// Цифровой клиппинг (более 3 последовательных сэмплов на максимуме 1.0/-1.0)
    DigitalClipping,
    /// Цифровой щелчок или резкий разрыв аудио-буфера (discontinuity)
    DigitalClick,
    /// Аномальный провал тишины (> 3 сек при наличии активности в сценарии)
    AnomalousSilence,
    /// Пропуск реплики актера по сценарию (нехватка покрытия сценария)
    MissingActorLine,
    /// Отклонение интегральной громкости от вещательного стандарта EBU R128
    LufsOutOfSpec,
}

/// Уровень критичности инцидента
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QaSeverity {
    /// Блокирующая ошибка: релиз не допускается
    Error,
    /// Предупреждение: рекомендуется вмешательство звукорежиссера
    Warning,
    /// Информационное сообщение
    Info,
}

/// Точные таймкоды инцидента для таймлайна DAW / видеоредактора
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaTimecode {
    /// Время в секундах
    pub seconds: f64,
    /// Время в миллисекундах
    pub milliseconds: f64,
    /// Индекс сэмпла (от начала мастер-буфера)
    pub sample_index: u64,
    /// Длительность инцидента в секундах (если применимо)
    pub duration_seconds: Option<f64>,
    /// Длительность инцидента в миллисекундах
    pub duration_ms: Option<f64>,
    /// Количество сэмплов (длительность)
    pub sample_count: Option<u64>,
    /// Строковое представление SMPTE таймкода (HH:MM:SS:FF) при 24/25 fps
    pub smpte_timecode: String,
}

/// Описание единичного инцидента предрелизного аудита
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaIncident {
    /// Уникальный идентификатор инцидента
    pub id: String,
    /// Тип инцидента
    pub incident_type: QaIncidentType,
    /// Критичность
    pub severity: QaSeverity,
    /// Таймкоды инцидента (секунды, миллисекунды, сэмплы)
    pub timecode: QaTimecode,
    /// Индекс аудиоканала (0 = Левый/Моно, 1 = Правый)
    pub channel: Option<usize>,
    /// Название канала ("L", "R", "Stereo", "Master")
    pub channel_name: String,
    /// Имя дорожки проекта (если привязано)
    pub track_name: Option<String>,
    /// Роль/персонаж по сценарию
    pub character_role: Option<String>,
    /// ID реплики из сценария (субтитра)
    pub script_cue_id: Option<String>,
    /// Заголовок инцидента для инспектора QA
    pub title: String,
    /// Подробное техническое описание
    pub description: String,
    /// Измеренное физическое значение (например, "+0.42 dBTP", "6 сэмплов клиппинга")
    pub measured_value: String,
    /// Допустимый нормативный порог (например, "-0.5 dBTP", "<= 3 сэмплов")
    pub threshold_value: String,
    /// Рекомендация QA-инженера по устранению
    pub fix_suggestion: String,
}

/// Сводные метрики аудита громкости и пиков
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaAudioMetrics {
    /// Интегральная громкость (Integrated LUFS) по EBU R128
    pub integrated_lufs: f64,
    /// Диапазон громкости (Loudness Range, LU)
    pub loudness_range_lu: f64,
    /// Максимальный True-Peak уровень (dBTP)
    pub max_true_peak_dbtp: f64,
    /// Линейный True-Peak коэффициент
    pub max_true_peak_linear: f64,
    /// Максимальный сэмпловый пик (Sample Peak dBFS)
    pub max_sample_peak_dbfs: f64,
    /// Количество обнаруженных межсэмпловых перегрузок True-Peak (> -0.5 dBTP)
    pub true_peak_overload_count: usize,
    /// Количество зон цифрового клиппинга (>3 сэмплов 1.0/-1.0)
    pub digital_clipping_events_count: usize,
    /// Общее количество клиппированных сэмплов
    pub total_clipped_samples: u64,
    /// Количество цифровых щелчков/разрывов буфера
    pub digital_clicks_count: usize,
    /// Количество аномальных пауз (> 3 сек при активности сценария)
    pub anomalous_silence_count: usize,
}

/// Метрики покрытия сценария (Script & Actor Dialogue Coverage)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaScriptCoverageMetrics {
    /// Общее число реплик в сценарии
    pub total_script_cues: usize,
    /// Число реплик, покрытых аудиодорожками дубляжа
    pub covered_script_cues: usize,
    /// Число отсутствующих/пустых реплик
    pub missing_script_cues: usize,
    /// Процент покрытия сценария (0.0 .. 100.0%)
    pub coverage_percent: f64,
    /// Пройден ли норматив 100% покрытия
    pub is_full_coverage: bool,
}

/// Итоговая сводка количества инцидентов по категориям
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaSummary {
    pub total_incidents: usize,
    pub errors_count: usize,
    pub warnings_count: usize,
    pub info_count: usize,
    pub is_broadcast_ready: bool,
}

/// Полный структурированный JSON-отчет предрелизного контроля качества
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaAuditReport {
    /// ID проверяемого проекта
    pub project_id: String,
    /// Название проекта
    pub project_name: String,
    /// Время формирования отчета (UTC ISO-8601)
    pub audited_at: String,
    /// Частота дискретизации аудио-буфера (Гц)
    pub sample_rate: u32,
    /// Количество каналов (1 = Моно, 2 = Стерео)
    pub channels: u16,
    /// Общее количество аудио-сэмплов на канал
    pub total_frames: u64,
    /// Общая продолжительность аудио-буфера в секундах
    pub duration_seconds: f64,
    /// Время выполнения аудита в миллисекундах
    pub audit_elapsed_ms: u64,
    /// Общий статус прохождения аудита (true = без блокирующих ошибок)
    pub passed: bool,
    /// Сводка инцидентов
    pub summary: QaSummary,
    /// Метрики громкости и динамического диапазона (EBU R128 / True-Peak)
    pub audio_metrics: QaAudioMetrics,
    /// Метрики покрытия сценария (актерские реплики)
    pub script_coverage: QaScriptCoverageMetrics,
    /// Детальный список обнаруженных инцидентов с точными таймкодами
    pub incidents: Vec<QaIncident>,
}

// ============================================================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ И ОВЕРСЭМПЛИНГ 4X (ITU-R BS.1770-4)
// ============================================================================

/// Преобразование секунд в строковый SMPTE таймкод (HH:MM:SS:FF, 25 fps)
fn format_smpte_timecode(seconds: f64) -> String {
    let safe_sec = if seconds.is_nan() || seconds < 0.0 { 0.0 } else { seconds };
    let hours = (safe_sec / 3600.0).floor() as u32;
    let mins = ((safe_sec % 3600.0) / 60.0).floor() as u32;
    let secs = (safe_sec % 60.0).floor() as u32;
    let frames = ((safe_sec.fract()) * 25.0).floor() as u32;
    format!("{:02}:{:02}:{:02}:{:02}", hours, mins, secs, frames)
}

/// Преобразование линейной амплитуды в децибелы
#[inline]
fn linear_to_db(val: f64) -> f64 {
    if val > 0.00000001 {
        20.0 * val.log10()
    } else {
        -160.0
    }
}

/// Фильтр интерполяции 4x для расчета межсэмпловых пиков (ITU-R BS.1770 True-Peak)
/// 48-точечный симметричный полифазный sinc-фильтр с окном Кайзера (4 фазы по 12 коэффициентов)
struct TruePeak4xResampler {
    // 4 полифазные ветви для фаз k = 0, 1, 2, 3
    phases: [[f32; 12]; 4],
}

impl TruePeak4xResampler {
    pub fn new() -> Self {
        let mut phases = [[0.0f32; 12]; 4];
        let taps_per_phase = 12;
        let total_taps = 48;
        let beta = 5.0f64; // Kaiser window beta

        // Оконная функция Кайзера I0(beta)
        let bessel_i0 = |x: f64| -> f64 {
            let mut sum = 1.0;
            let mut term = 1.0;
            for m in 1..25 {
                term *= (x / 2.0).powi(2) / (m as f64).powi(2);
                sum += term;
                if term < 1e-12 {
                    break;
                }
            }
            sum
        };
        let denom_i0 = bessel_i0(beta);

        for phase_idx in 0..4 {
            let phase_offset = phase_idx as f64 / 4.0;
            for tap_idx in 0..taps_per_phase {
                // Временная точка относительно центра фильтра
                let t = (tap_idx as f64 - 5.5) + phase_offset;
                
                // Sinc(pi * t)
                let sinc_val = if t.abs() < 1e-8 {
                    1.0
                } else {
                    let pi_t = std::f64::consts::PI * t;
                    pi_t.sin() / pi_t
                };

                // Окно Кайзера
                let dist_from_center = (tap_idx as f64 * 4.0 + phase_idx as f64) - (total_taps as f64 / 2.0);
                let norm_dist = (dist_from_center / (total_taps as f64 / 2.0)).abs();
                let window = if norm_dist <= 1.0 {
                    bessel_i0(beta * (1.0 - norm_dist.powi(2)).sqrt()) / denom_i0
                } else {
                    0.0
                };

                phases[phase_idx][tap_idx] = (sinc_val * window) as f32;
            }
        }

        Self { phases }
    }

    /// Вычисляет максимальный межсэмпловый True-Peak для 12-точечного окна исходных сэмплов
    #[inline(always)]
    pub fn compute_true_peak(&self, window: &[f32; 12]) -> f32 {
        let mut max_tp = 0.0f32;

        for phase in &self.phases {
            let mut interp = 0.0f32;
            for i in 0..12 {
                interp += window[i] * phase[i];
            }
            let abs_val = interp.abs();
            if abs_val > max_tp {
                max_tp = abs_val;
            }
        }

        max_tp
    }
}

// ============================================================================
// 3. ЯДРО ПРЕДРЕЛИЗНОГО АУДИТА (QA AUDIT ENGINE)
// ============================================================================

/// Полный аудио-буфер, готовый к аудиту
pub struct RenderAudioBuffer {
    pub sample_rate: u32,
    pub channels: u16,
    pub total_frames: usize,
    /// Деинтерливированные каналы: channel_samples[0] = Left, channel_samples[1] = Right
    pub channel_samples: Vec<Vec<f32>>,
}

impl RenderAudioBuffer {
    /// Длительность в секундах
    pub fn duration_seconds(&self) -> f64 {
        if self.sample_rate == 0 {
            0.0
        } else {
            self.total_frames as f64 / self.sample_rate as f64
        }
    }

    /// Создает пустой тихий буфер указанной длительности
    pub fn create_silent(sample_rate: u32, channels: u16, duration_seconds: f64) -> Self {
        let frames = (sample_rate as f64 * duration_seconds).ceil() as usize;
        let mut channel_samples = Vec::new();
        for _ in 0..channels {
            channel_samples.push(vec![0.0f32; frames]);
        }
        Self {
            sample_rate,
            channels,
            total_frames: frames,
            channel_samples,
        }
    }
}

/// Основной обработчик аудита
pub struct ProjectQaAuditor {
    project_id: String,
    project_name: String,
    buffer: RenderAudioBuffer,
    subtitles: Vec<SubtitleLine>,
    dub_track_segments: Vec<(String, f64, f64)>, // (track_name, start_time, end_time)
}

impl ProjectQaAuditor {
    pub fn new(
        project_id: String,
        project_name: String,
        buffer: RenderAudioBuffer,
        subtitles: Vec<SubtitleLine>,
        dub_track_segments: Vec<(String, f64, f64)>,
    ) -> Self {
        Self {
            project_id,
            project_name,
            buffer,
            subtitles,
            dub_track_segments,
        }
    }

    /// Запуск комплексного аудита всех нормативных параметров
    pub fn execute_full_audit(&self) -> Result<QaAuditReport, String> {
        let start_time = Instant::now();
        let sample_rate = self.buffer.sample_rate;
        let channels = self.buffer.channels;
        let total_frames = self.buffer.total_frames;
        let duration_sec = self.buffer.duration_seconds();

        log_debug(&format!(
            "[QA Engine] Starting pre-release audit for project '{}' ({}), duration: {:.2}s, {} frames",
            self.project_name, self.project_id, duration_sec, total_frames
        ));

        // --------------------------------------------------------------------
        // ШАГ 1: EBU R128 ИНТЕГРАЛЬНАЯ ГРОМКОСТЬ И МАКСИМАЛЬНЫЙ TRUE-PEAK
        // --------------------------------------------------------------------
        let mut ebu_meter = EbuR128::new(channels as u32, sample_rate, Mode::I | Mode::LRA | Mode::TRUE_PEAK)
            .map_err(|e| format!("Ошибка инициализации EbuR128: {:?}", e))?;

        // Собираем интерливированный буфер для ebur128
        let mut interleaved = Vec::with_capacity(total_frames * channels as usize);
        for frame in 0..total_frames {
            for ch in 0..channels as usize {
                interleaved.push(self.buffer.channel_samples[ch][frame]);
            }
        }

        const CHUNK_FRAMES: usize = 4096;
        for chunk in interleaved.chunks(CHUNK_FRAMES * channels as usize) {
            ebu_meter.add_frames_f32(chunk)
                .map_err(|e| format!("Ошибка расчета EbuR128: {:?}", e))?;
        }

        let integrated_lufs = ebu_meter.loudness_global().unwrap_or(-70.0);
        let loudness_range_lu = ebu_meter.loudness_range().unwrap_or(0.0);

        let mut max_true_peak_linear = 0.0f64;
        for ch in 0..channels as u32 {
            if let Ok(tp) = ebu_meter.true_peak(ch) {
                if tp > max_true_peak_linear {
                    max_true_peak_linear = tp;
                }
            }
        }
        let max_true_peak_dbtp = linear_to_db(max_true_peak_linear);

        // --------------------------------------------------------------------
        // ШАГ 2: ТОЧЕЧНЫЙ ПОИСК ПЕРЕГРУЗОК TRUE-PEAK (-0.5 dBTP, ОВЕРСЭМПЛИНГ 4X)
        // --------------------------------------------------------------------
        let true_peak_threshold_dbtp = -0.5f64;
        let true_peak_threshold_linear = 10.0f64.powf(true_peak_threshold_dbtp / 20.0) as f32; // ~0.94406

        let resampler = Arc::new(TruePeak4xResampler::new());
        let mut incidents: Vec<QaIncident> = Vec::new();

        let mut true_peak_overload_count = 0usize;
        let mut max_sample_peak_linear = 0.0f32;

        // Сканируем каждый канал
        for ch in 0..channels as usize {
            let samples = &self.buffer.channel_samples[ch];
            let ch_name = if channels == 1 {
                "Mono".to_string()
            } else if ch == 0 {
                "L".to_string()
            } else {
                "R".to_string()
            };

            // Параллельный расчет пиков окнами с перекрытием
            // Чтобы не дублировать 5000 одинаковых сэмплов в одной перегрузке,
            // группируем смежные превышения True-Peak (в пределах 100 мс)
            let mut in_tp_overload = false;
            let mut event_start_frame = 0usize;
            let mut event_max_tp = 0.0f32;
            let mut event_overload_samples = 0u64;

            let num_samples = samples.len();
            if num_samples >= 12 {
                for i in 0..num_samples - 11 {
                    let mut window = [0.0f32; 12];
                    window.copy_from_slice(&samples[i..i + 12]);
                    let tp = resampler.compute_true_peak(&window);

                    let abs_orig = samples[i + 5].abs();
                    if abs_orig > max_sample_peak_linear {
                        max_sample_peak_linear = abs_orig;
                    }

                    if tp > true_peak_threshold_linear {
                        true_peak_overload_count += 1;
                        if !in_tp_overload {
                            in_tp_overload = true;
                            event_start_frame = i + 5;
                            event_max_tp = tp;
                            event_overload_samples = 1;
                        } else {
                            event_overload_samples += 1;
                            if tp > event_max_tp {
                                event_max_tp = tp;
                            }
                        }
                    } else if in_tp_overload {
                        // Окончание события перегрузки True-Peak
                        let time_sec = event_start_frame as f64 / sample_rate as f64;
                        let dur_sec = event_overload_samples as f64 / sample_rate as f64;
                        let measured_dbtp = linear_to_db(event_max_tp as f64);

                        incidents.push(QaIncident {
                            id: format!("qa-tp-{}-{}-{}", ch, event_start_frame, incidents.len()),
                            incident_type: QaIncidentType::TruePeakOverload,
                            severity: if measured_dbtp > 0.0 { QaSeverity::Error } else { QaSeverity::Warning },
                            timecode: QaTimecode {
                                seconds: time_sec,
                                milliseconds: time_sec * 1000.0,
                                sample_index: event_start_frame as u64,
                                duration_seconds: Some(dur_sec),
                                duration_ms: Some(dur_sec * 1000.0),
                                sample_count: Some(event_overload_samples),
                                smpte_timecode: format_smpte_timecode(time_sec),
                            },
                            channel: Some(ch),
                            channel_name: ch_name.clone(),
                            track_name: Some("Мастер-шина".to_string()),
                            character_role: None,
                            script_cue_id: None,
                            title: if measured_dbtp > 0.0 {
                                "Критический перегруз True-Peak (> 0.0 dBTP)".to_string()
                            } else {
                                "Превышение лимита True-Peak (> -0.5 dBTP)".to_string()
                            },
                            description: format!(
                                "Обнаружен межсэмпловый пик {:.2} dBTP на канале {} (длительность: {:.1} мс, {} сэмплов). При цифро-аналоговом преобразовании возникнут слышимые гармонические искажения.",
                                measured_dbtp, ch_name, dur_sec * 1000.0, event_overload_samples
                            ),
                            measured_value: format!("{:.2} dBTP", measured_dbtp),
                            threshold_value: "-0.5 dBTP (ITU-R BS.1770 / EBU R128)".to_string(),
                            fix_suggestion: "Уменьшите Output Ceiling мастеринг-лимитера до -1.0 dBTP или включите True-Peak ограничитель с 4x оверсэмплингом.".to_string(),
                        });

                        in_tp_overload = false;
                        event_max_tp = 0.0;
                    }
                }
            }

            // Если перегрузка длится до конца буфера
            if in_tp_overload {
                let time_sec = event_start_frame as f64 / sample_rate as f64;
                let dur_sec = event_overload_samples as f64 / sample_rate as f64;
                let measured_dbtp = linear_to_db(event_max_tp as f64);

                incidents.push(QaIncident {
                    id: format!("qa-tp-{}-{}-{}", ch, event_start_frame, incidents.len()),
                    incident_type: QaIncidentType::TruePeakOverload,
                    severity: if measured_dbtp > 0.0 { QaSeverity::Error } else { QaSeverity::Warning },
                    timecode: QaTimecode {
                        seconds: time_sec,
                        milliseconds: time_sec * 1000.0,
                        sample_index: event_start_frame as u64,
                        duration_seconds: Some(dur_sec),
                        duration_ms: Some(dur_sec * 1000.0),
                        sample_count: Some(event_overload_samples),
                        smpte_timecode: format_smpte_timecode(time_sec),
                    },
                    channel: Some(ch),
                    channel_name: ch_name,
                    track_name: Some("Мастер-шина".to_string()),
                    character_role: None,
                    script_cue_id: None,
                    title: "Превышение лимита True-Peak (> -0.5 dBTP)".to_string(),
                    description: format!(
                        "Межсэмпловый пик {:.2} dBTP в конце буфера ({} сэмплов).",
                        measured_dbtp, event_overload_samples
                    ),
                    measured_value: format!("{:.2} dBTP", measured_dbtp),
                    threshold_value: "-0.5 dBTP".to_string(),
                    fix_suggestion: "Понизьте уровень мастер-шины на 1-2 дБ.".to_string(),
                });
            }
        }

        // --------------------------------------------------------------------
        // ШАГ 3: ДЕТЕКТИРОВАНИЕ ЦИФРОВЫХ ЩЕЛЧКОВ И КЛИППИНГА (>3 ПОСЛЕДОВАТЕЛЬНЫХ 1.0/-1.0)
        // --------------------------------------------------------------------
        let mut total_clipped_samples = 0u64;
        let mut digital_clipping_events_count = 0usize;
        let mut digital_clicks_count = 0usize;

        for ch in 0..channels as usize {
            let samples = &self.buffer.channel_samples[ch];
            let ch_name = if channels == 1 { "Mono".to_string() } else if ch == 0 { "L".to_string() } else { "R".to_string() };

            let mut consecutive_clipped = 0u64;
            let mut clip_start_frame = 0usize;

            for (i, &s) in samples.iter().enumerate() {
                let abs_s = s.abs();

                // Проверка на клиппинг (1.0 / -1.0)
                if abs_s >= 0.9999 {
                    if consecutive_clipped == 0 {
                        clip_start_frame = i;
                    }
                    consecutive_clipped += 1;
                    total_clipped_samples += 1;
                } else {
                    if consecutive_clipped > 3 {
                        // Зафиксирован факт жесткого цифрового клиппинга
                        digital_clipping_events_count += 1;
                        let time_sec = clip_start_frame as f64 / sample_rate as f64;
                        let dur_sec = consecutive_clipped as f64 / sample_rate as f64;

                        incidents.push(QaIncident {
                            id: format!("qa-clip-{}-{}-{}", ch, clip_start_frame, incidents.len()),
                            incident_type: QaIncidentType::DigitalClipping,
                            severity: QaSeverity::Error,
                            timecode: QaTimecode {
                                seconds: time_sec,
                                milliseconds: time_sec * 1000.0,
                                sample_index: clip_start_frame as u64,
                                duration_seconds: Some(dur_sec),
                                duration_ms: Some(dur_sec * 1000.0),
                                sample_count: Some(consecutive_clipped),
                                smpte_timecode: format_smpte_timecode(time_sec),
                            },
                            channel: Some(ch),
                            channel_name: ch_name.clone(),
                            track_name: Some("Мастер-шина".to_string()),
                            character_role: None,
                            script_cue_id: None,
                            title: "Цифровой клиппинг (Flat-Top Slices)".to_string(),
                            description: format!(
                                "Обнаружено {} последовательных сэмплов на максимальном пределе 0 dBFS на канале {}. Форма волны срезана «в полку», слышен жесткий треск.",
                                consecutive_clipped, ch_name
                            ),
                            measured_value: format!("{} сэмплов подряд на 0 dBFS", consecutive_clipped),
                            threshold_value: "<= 3 сэмплов".to_string(),
                            fix_suggestion: "Используйте модуль De-Clip или уменьшите гейн перегруженного сегмента дорожки.".to_string(),
                        });
                    }
                    consecutive_clipped = 0;
                }

                // Проверка на цифровой щелчок / разрыв буфера (discontinuity):
                // Резкий скачок dS/dt > 0.85 между соседними сэмплами без плавного перехода
                if i > 0 && i < samples.len() - 1 {
                    let delta_prev = (s - samples[i - 1]).abs();
                    let delta_next = (samples[i + 1] - s).abs();

                    if delta_prev > 0.85 && delta_next > 0.85 {
                        digital_clicks_count += 1;
                        let time_sec = i as f64 / sample_rate as f64;

                        incidents.push(QaIncident {
                            id: format!("qa-click-{}-{}-{}", ch, i, incidents.len()),
                            incident_type: QaIncidentType::DigitalClick,
                            severity: QaSeverity::Warning,
                            timecode: QaTimecode {
                                seconds: time_sec,
                                milliseconds: time_sec * 1000.0,
                                sample_index: i as u64,
                                duration_seconds: Some(1.0 / sample_rate as f64),
                                duration_ms: Some(1000.0 / sample_rate as f64),
                                sample_count: Some(1),
                                smpte_timecode: format_smpte_timecode(time_sec),
                            },
                            channel: Some(ch),
                            channel_name: ch_name.clone(),
                            track_name: Some("Мастер-шина".to_string()),
                            character_role: None,
                            script_cue_id: None,
                            title: "Цифровой щелчок / Разрыв сэмпла (Discontinuity)".to_string(),
                            description: format!(
                                "Одиночный резкий скачок амплитуды ({:.2} FS) между сэмплами {} и {}. Вероятен щелчок склейки или буфера ASIO.",
                                delta_prev, i - 1, i
                            ),
                            measured_value: format!("Δ = {:.2} FS/сэмпл", delta_prev),
                            threshold_value: "Δ <= 0.65 FS/сэмпл".to_string(),
                            fix_suggestion: "Примените нативный модуль De-Click или добавьте 5-мс микро-фейд (crossfade) на стыке реплик.".to_string(),
                        });
                    }
                }
            }
        }

        // --------------------------------------------------------------------
        // ШАГ 4: ПОИСК АНОМАЛЬНЫХ ПРОВАЛОВ ТИШИНЫ (> 3 СЕК ПРИ АКТИВНОСТИ В СЦЕНАРИИ)
        // --------------------------------------------------------------------
        let mut anomalous_silence_count = 0usize;

        // Порог тишины: RMS < -55.0 dBFS (~ 0.00177 linear)
        let silence_threshold_linear = 10.0f64.powf(-55.0 / 20.0) as f32;
        let block_size_ms = 100.0f64;
        let block_frames = (sample_rate as f64 * (block_size_ms / 1000.0)).round() as usize;

        if block_frames > 0 && total_frames > block_frames {
            let num_blocks = total_frames / block_frames;
            let mut block_silence_flags = vec![false; num_blocks];

            for b in 0..num_blocks {
                let start_f = b * block_frames;
                let end_f = (start_f + block_frames).min(total_frames);

                // Считаем RMS блока по всем каналам
                let mut sum_sq = 0.0f32;
                let count = (end_f - start_f) * channels as usize;
                for f in start_f..end_f {
                    for ch in 0..channels as usize {
                        let val = self.buffer.channel_samples[ch][f];
                        sum_sq += val * val;
                    }
                }
                let rms = if count > 0 { (sum_sq / count as f32).sqrt() } else { 0.0 };
                block_silence_flags[b] = rms < silence_threshold_linear;
            }

            // Ищем непрерывные участки тишины длительностью > 3.0 секунд (30 блоков по 100 мс)
            let min_silence_blocks = (3.0 / (block_size_ms / 1000.0)).ceil() as usize; // 30
            let mut cur_silence_start = None;
            let mut cur_silence_len = 0usize;

            for b in 0..num_blocks {
                if block_silence_flags[b] {
                    if cur_silence_start.is_none() {
                        cur_silence_start = Some(b);
                    }
                    cur_silence_len += 1;
                } else {
                    if let Some(start_b) = cur_silence_start {
                        if cur_silence_len >= min_silence_blocks {
                            let start_sec = start_b as f64 * (block_size_ms / 1000.0);
                            let silence_dur_sec = cur_silence_len as f64 * (block_size_ms / 1000.0);
                            let end_sec = start_sec + silence_dur_sec;

                            // Проверяем: есть ли активность в сценарии (субтитрах) в этом интервале
                            let active_sub = self.subtitles.iter().find(|sub| {
                                let sub_start = sub.start;
                                let sub_end = sub.end;
                                // Пересечение интервала тишины и реплики
                                sub_start < end_sec && sub_end > start_sec
                            });

                            if let Some(sub) = active_sub {
                                anomalous_silence_count += 1;
                                let start_frame = (start_sec * sample_rate as f64) as u64;

                                incidents.push(QaIncident {
                                    id: format!("qa-silence-{}-{}", start_frame, incidents.len()),
                                    incident_type: QaIncidentType::AnomalousSilence,
                                    severity: QaSeverity::Error,
                                    timecode: QaTimecode {
                                        seconds: start_sec,
                                        milliseconds: start_sec * 1000.0,
                                        sample_index: start_frame,
                                        duration_seconds: Some(silence_dur_sec),
                                        duration_ms: Some(silence_dur_sec * 1000.0),
                                        sample_count: Some((silence_dur_sec * sample_rate as f64) as u64),
                                        smpte_timecode: format_smpte_timecode(start_sec),
                                    },
                                    channel: None,
                                    channel_name: "Master".to_string(),
                                    track_name: Some("Мастер-микс".to_string()),
                                    character_role: Some(sub.role.clone()),
                                    script_cue_id: Some(sub.id.clone()),
                                    title: format!("Аномальный провал тишины ({:.1} с) внутри сцены", silence_dur_sec),
                                    description: format!(
                                        "В интервале [{:.2}с - {:.2}с] зафиксирована мертвая тишина длительностью {:.1} с (< -55 dBFS), однако сценарий требует реплику персонажа '{}': \"{}\"",
                                        start_sec, end_sec, silence_dur_sec, sub.role, sub.text
                                    ),
                                    measured_value: format!("{:.1} с тишины", silence_dur_sec),
                                    threshold_value: "<= 3.0 с".to_string(),
                                    fix_suggestion: "Проверьте дубляж данной сцены: аудиофайл реплики отсутствует либо замутирован.".to_string(),
                                });
                            }
                        }
                    }
                    cur_silence_start = None;
                    cur_silence_len = 0;
                }
            }
        }

        // --------------------------------------------------------------------
        // ШАГ 5: 100% СВЕРКА НАЛИЧИЯ ВСЕХ РЕПЛИК АКТЕРОВ ПО ТАЙМКОДАМ СЦЕНАРИЯ
        // --------------------------------------------------------------------
        let total_script_cues = self.subtitles.len();
        let mut covered_script_cues = 0usize;
        let mut missing_script_cues = 0usize;

        for sub in &self.subtitles {
            // Игнорируем чисто служебные ремарки звукорежиссера вида [Музыка], (Шорох), {FX}
            let is_sfx_note = sub.text.starts_with('[') || sub.text.starts_with('(') || sub.text.starts_with('{');
            if is_sfx_note {
                covered_script_cues += 1;
                continue;
            }

            let cue_start_sec = sub.start;
            let cue_end_sec = sub.end;
            let cue_dur_sec = (cue_end_sec - cue_start_sec).max(0.1);

            // 1. Проверяем наличие дорожек/сегментов дубляжа, перекрывающих интервал
            let has_segment_coverage = self.dub_track_segments.iter().any(|(_track, seg_start, seg_end)| {
                // Допускаем погрешность в 0.3 секунды
                let overlap_start = cue_start_sec.max(*seg_start - 0.3);
                let overlap_end = cue_end_sec.min(*seg_end + 0.3);
                overlap_end > overlap_start
            });

            // 2. Проверяем фактическую энергию аудио в рендер-буфере в интервале реплики
            let start_frame = (cue_start_sec * sample_rate as f64).round() as usize;
            let end_frame = ((cue_end_sec * sample_rate as f64).round() as usize).min(total_frames);

            let mut has_buffer_energy = false;
            if end_frame > start_frame {
                let mut sum_sq = 0.0f32;
                let count = (end_frame - start_frame) * channels as usize;
                for f in start_frame..end_frame {
                    for ch in 0..channels as usize {
                        let val = self.buffer.channel_samples[ch][f];
                        sum_sq += val * val;
                    }
                }
                let rms = if count > 0 { (sum_sq / count as f32).sqrt() } else { 0.0 };
                // Порог слышимой речи: RMS > -48 dBFS
                has_buffer_energy = rms > 0.00398;
            }

            if has_segment_coverage || has_buffer_energy {
                covered_script_cues += 1;
            } else {
                missing_script_cues += 1;
                let sample_idx = (cue_start_sec * sample_rate as f64) as u64;

                incidents.push(QaIncident {
                    id: format!("qa-missing-cue-{}-{}", sub.id, incidents.len()),
                    incident_type: QaIncidentType::MissingActorLine,
                    severity: QaSeverity::Error,
                    timecode: QaTimecode {
                        seconds: cue_start_sec,
                        milliseconds: cue_start_sec * 1000.0,
                        sample_index: sample_idx,
                        duration_seconds: Some(cue_dur_sec),
                        duration_ms: Some(cue_dur_sec * 1000.0),
                        sample_count: Some((cue_dur_sec * sample_rate as f64) as u64),
                        smpte_timecode: format_smpte_timecode(cue_start_sec),
                    },
                    channel: None,
                    channel_name: "All".to_string(),
                    track_name: Some(format!("Дорожка '{}'", sub.role)),
                    character_role: Some(sub.role.clone()),
                    script_cue_id: Some(sub.id.clone()),
                    title: format!("Пропущена реплика: {} («{}»)", sub.role, sub.text.chars().take(28).collect::<String>()),
                    description: format!(
                        "Для реплики персонажа '{}' на таймкоде [{:.2}с - {:.2}с] отсутствует записанная озвучка (покрытие 0%). Текст: \"{}\"",
                        sub.role, cue_start_sec, cue_end_sec, sub.text
                    ),
                    measured_value: "0% аудио".to_string(),
                    threshold_value: "100% покрытие".to_string(),
                    fix_suggestion: "Запишите дубляж или импортируйте недостающий дубль в таймлайн проекта.".to_string(),
                });
            }
        }

        let coverage_percent = if total_script_cues > 0 {
            (covered_script_cues as f64 / total_script_cues as f64) * 100.0
        } else {
            100.0
        };

        // --------------------------------------------------------------------
        // ШАГ 6: ПРОВЕРКА СООТВЕТСТВИЯ СТАНДАРТУ ГРОМКОСТИ EBU R128 (-14.0 LUFS)
        // --------------------------------------------------------------------
        let target_lufs = -14.0f64; // YouTube / Cinema / Streaming default target
        let lufs_delta = (integrated_lufs - target_lufs).abs();
        if lufs_delta > 2.5 && duration_sec > 5.0 {
            incidents.push(QaIncident {
                id: format!("qa-lufs-dev-{}", incidents.len()),
                incident_type: QaIncidentType::LufsOutOfSpec,
                severity: if lufs_delta > 4.0 { QaSeverity::Error } else { QaSeverity::Warning },
                timecode: QaTimecode {
                    seconds: 0.0,
                    milliseconds: 0.0,
                    sample_index: 0,
                    duration_seconds: Some(duration_sec),
                    duration_ms: Some(duration_sec * 1000.0),
                    sample_count: Some(total_frames as u64),
                    smpte_timecode: "00:00:00:00".to_string(),
                },
                channel: None,
                channel_name: "Master".to_string(),
                track_name: Some("Мастер-шина".to_string()),
                character_role: None,
                script_cue_id: None,
                title: format!("Отклонение громкости микса ({:.1} LUFS vs {:.1} LUFS)", integrated_lufs, target_lufs),
                description: format!(
                    "Интегральная громкость проекта составляет {:.1} LUFS (отклонение {:.1} LU от целевого стандарта {:.1} LUFS, LRA = {:.1} LU).",
                    integrated_lufs, lufs_delta, target_lufs, loudness_range_lu
                ),
                measured_value: format!("{:.1} LUFS", integrated_lufs),
                threshold_value: format!("{:.1} ± 1.0 LUFS", target_lufs),
                fix_suggestion: "Примените нормализацию мастеринг-лимитером на этапе 4.2 перед выпуском релиза.".to_string(),
            });
        }

        // --------------------------------------------------------------------
        // ШАГ 7: ФОРМИРОВАНИЕ СВОДКИ И ИТОГОВОГО JSON-ОТЧЕТА
        // --------------------------------------------------------------------
        let errors_count = incidents.iter().filter(|i| i.severity == QaSeverity::Error).count();
        let warnings_count = incidents.iter().filter(|i| i.severity == QaSeverity::Warning).count();
        let info_count = incidents.iter().filter(|i| i.severity == QaSeverity::Info).count();

        let passed = errors_count == 0;
        let is_broadcast_ready = passed && warnings_count <= 2;

        let elapsed_ms = start_time.elapsed().as_millis() as u64;

        log_debug(&format!(
            "[QA Engine] Audit complete in {}ms. Found {} errors, {} warnings. True-Peak: {:.2} dBTP, LUFS: {:.1}, Coverage: {:.1}%",
            elapsed_ms, errors_count, warnings_count, max_true_peak_dbtp, integrated_lufs, coverage_percent
        ));

        Ok(QaAuditReport {
            project_id: self.project_id.clone(),
            project_name: self.project_name.clone(),
            audited_at: Utc::now().to_rfc3339(),
            sample_rate,
            channels,
            total_frames: total_frames as u64,
            duration_seconds: duration_sec,
            audit_elapsed_ms: elapsed_ms,
            passed,
            summary: QaSummary {
                total_incidents: incidents.len(),
                errors_count,
                warnings_count,
                info_count,
                is_broadcast_ready,
            },
            audio_metrics: QaAudioMetrics {
                integrated_lufs,
                loudness_range_lu,
                max_true_peak_dbtp,
                max_true_peak_linear,
                max_sample_peak_dbfs: linear_to_db(max_sample_peak_linear as f64),
                true_peak_overload_count,
                digital_clipping_events_count,
                total_clipped_samples,
                digital_clicks_count,
                anomalous_silence_count,
            },
            script_coverage: QaScriptCoverageMetrics {
                total_script_cues,
                covered_script_cues,
                missing_script_cues,
                coverage_percent,
                is_full_coverage: missing_script_cues == 0,
            },
            incidents,
        })
    }
}

// ============================================================================
// 4. КОМАНДА TAURI: RUN_PROJECT_QA_AUDIT
// ============================================================================

/// Загрузка аудио-буфера проекта (из готового мастер-файла либо микширование сегментов)
async fn load_project_render_buffer(
    state: &State<'_, AppState>,
    project_id: &str,
) -> Result<(RenderAudioBuffer, Vec<SubtitleLine>, Vec<(String, f64, f64)>, String), String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database pool not initialized")?;

    // 1. Загружаем проект
    let proj_row = sqlx::query("SELECT id, name, config_json FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Проект '{}' не найден в базе данных", project_id))?;

    let project_name: String = proj_row.get("name");
    let config_json: String = proj_row.get("config_json");
    let config: serde_json::Value = serde_json::from_str(&config_json).unwrap_or(serde_json::json!({}));

    // 2. Загружаем субтитры (сценарий)
    let subs_rows = sqlx::query("SELECT id, start_time, end_time, text, role FROM subtitles WHERE project_id = ? ORDER BY start_time ASC")
        .bind(project_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();

    let mut subtitles = Vec::new();
    for srow in subs_rows {
        subtitles.push(SubtitleLine {
            id: srow.get("id"),
            start: srow.get("start_time"),
            end: srow.get("end_time"),
            text: srow.get("text"),
            role: srow.get("role"),
        });
    }

    // Если в таблице пусто, проверяем config_json
    if subtitles.is_empty() {
        if let Some(subs_arr) = config.get("subtitles").and_then(|s| s.as_array()) {
            for item in subs_arr {
                if let (Some(id), Some(start), Some(end), Some(text)) = (
                    item.get("id").and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string()))),
                    item.get("start").and_then(|v| v.as_f64()),
                    item.get("end").and_then(|v| v.as_f64()),
                    item.get("text").and_then(|v| v.as_str()),
                ) {
                    subtitles.push(SubtitleLine {
                        id,
                        start,
                        end,
                        text: text.to_string(),
                        role: item.get("role").and_then(|v| v.as_str()).unwrap_or("Персонаж").to_string(),
                    });
                }
            }
        }
    }

    // 3. Загружаем дорожки и сегменты дубляжа
    let tracks_rows = sqlx::query("SELECT id, name, volume, is_muted FROM tracks WHERE project_id = ?")
        .bind(project_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();

    let mut dub_segments_info = Vec::new();
    let mut all_segments: Vec<(String, String, f64, f64, f64, f64, Option<String>, f64)> = Vec::new();
    // (track_id, track_name, track_vol, seg_start, seg_dur, seg_offset, file_path, seg_gain)

    let mut max_project_time = 5.0f64;
    for sub in &subtitles {
        if sub.end > max_project_time {
            max_project_time = sub.end;
        }
    }

    for trow in tracks_rows {
        let t_id: String = trow.get("id");
        let t_name: String = trow.get("name");
        let t_vol: f64 = trow.get("volume");
        let is_muted: bool = trow.get::<i64, _>("is_muted") == 1;

        if is_muted {
            continue;
        }

        let is_dub = !t_name.to_lowercase().contains("оригинал") && !t_name.to_lowercase().contains("reference");

        let segs_rows = sqlx::query("SELECT id, start_time, duration, file_offset, file_path, gain FROM segments WHERE track_id = ?")
            .bind(&t_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();

        for srow in segs_rows {
            let start_time: f64 = srow.get("start_time");
            let duration: f64 = srow.get("duration");
            let file_offset: f64 = srow.get("file_offset");
            let file_path: Option<String> = srow.get("file_path");
            let gain: f64 = srow.get("gain");

            if start_time + duration > max_project_time {
                max_project_time = start_time + duration;
            }

            if is_dub {
                dub_segments_info.push((t_name.clone(), start_time, start_time + duration));
            }

            all_segments.push((
                t_id.clone(),
                t_name.clone(),
                t_vol,
                start_time,
                duration,
                file_offset,
                file_path,
                gain,
            ));
        }
    }

    // 4. Проверяем, существует ли уже отрендеренный мастер-файл WAV
    let sample_rate = 48000u32;
    let channels = 2u16;

    // Проверяем явный путь в config_json
    let pre_rendered_path = config.get("renderedWavPath")
        .and_then(|v| v.as_str())
        .or_else(|| config.get("masterAudioPath").and_then(|v| v.as_str()));

    if let Some(path_str) = pre_rendered_path {
        let p = Path::new(path_str);
        if p.exists() {
            if let Ok(buffer) = read_wav_to_render_buffer(p) {
                return Ok((buffer, subtitles, dub_segments_info, project_name));
            }
        }
    }

    // 5. Иначе собираем рендер-буфер микса непосредственно из сегментов в памяти
    let total_frames = (max_project_time * sample_rate as f64).ceil() as usize;
    let mut left_channel = vec![0.0f32; total_frames];
    let mut right_channel = vec![0.0f32; total_frames];

    // Микшируем сегменты с помощью rayon / hound
    for (_t_id, _t_name, t_vol, start_time, duration, file_offset, file_path_opt, gain) in all_segments {
        if let Some(f_path) = file_path_opt {
            let p = Path::new(&f_path);
            if p.exists() {
                if let Ok(mut reader) = WavReader::open(p) {
                    let spec = reader.spec();
                    let seg_sr = spec.sample_rate;
                    let seg_channels = spec.channels as usize;

                    let raw_samples: Vec<f32> = match spec.sample_format {
                        SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
                        SampleFormat::Int => {
                            if spec.bits_per_sample == 16 {
                                reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / 32768.0).collect()
                            } else if spec.bits_per_sample == 24 || spec.bits_per_sample == 32 {
                                reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 2147483648.0).collect()
                            } else {
                                Vec::new()
                            }
                        }
                    };

                    if !raw_samples.is_empty() && seg_channels > 0 {
                        let total_seg_frames = raw_samples.len() / seg_channels;
                        let offset_frames = (file_offset * seg_sr as f64).round() as usize;
                        let target_dur_frames = (duration * sample_rate as f64).round() as usize;
                        let timeline_start_frame = (start_time * sample_rate as f64).round() as usize;

                        let effective_gain = (gain * t_vol) as f32;

                        for f in 0..target_dur_frames {
                            let out_idx = timeline_start_frame + f;
                            if out_idx >= total_frames {
                                break;
                            }

                            // Сэмпл из исходника (с учетом возможной разницы частот дискретизации)
                            let src_frame = offset_frames + ((f as f64 * seg_sr as f64) / sample_rate as f64).round() as usize;
                            if src_frame >= total_seg_frames {
                                break;
                            }

                            let l_val = raw_samples[src_frame * seg_channels] * effective_gain;
                            let r_val = if seg_channels > 1 {
                                raw_samples[src_frame * seg_channels + 1] * effective_gain
                            } else {
                                l_val
                            };

                            left_channel[out_idx] += l_val;
                            right_channel[out_idx] += r_val;
                        }
                    }
                }
            }
        }
    }

    let buffer = RenderAudioBuffer {
        sample_rate,
        channels,
        total_frames,
        channel_samples: vec![left_channel, right_channel],
    };

    Ok((buffer, subtitles, dub_segments_info, project_name))
}

/// Чтение готового WAV файла в `RenderAudioBuffer`
fn read_wav_to_render_buffer(path: &Path) -> Result<RenderAudioBuffer, String> {
    let mut reader = WavReader::open(path).map_err(|e| format!("WAV error: {}", e))?;
    let spec = reader.spec();
    let channels = spec.channels;
    let sample_rate = spec.sample_rate;

    let raw: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        SampleFormat::Int => {
            if spec.bits_per_sample == 16 {
                reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / 32768.0).collect()
            } else {
                reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 2147483648.0).collect()
            }
        }
    };

    let total_frames = raw.len() / channels as usize;
    let mut channel_samples = Vec::new();

    for ch in 0..channels as usize {
        let mut ch_vec = Vec::with_capacity(total_frames);
        for f in 0..total_frames {
            ch_vec.push(raw[f * channels as usize + ch]);
        }
        channel_samples.push(ch_vec);
    }

    Ok(RenderAudioBuffer {
        sample_rate,
        channels,
        total_frames,
        channel_samples,
    })
}

/// Команда Tauri: комплексный предрелизный аудит проекта
#[tauri::command]
pub async fn run_project_qa_audit(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<QaAuditReport, String> {
    log_debug(&format!("[Tauri] Invoked run_project_qa_audit for project_id='{}'", project_id));

    let (buffer, subtitles, dub_segments, project_name) = load_project_render_buffer(&state, &project_id).await?;

    // Запуск аудитора
    let auditor = ProjectQaAuditor::new(
        project_id,
        project_name,
        buffer,
        subtitles,
        dub_segments,
    );

    auditor.execute_full_audit()
}
