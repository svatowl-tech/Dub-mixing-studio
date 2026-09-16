use std::f32::consts::PI;
use std::fs;
use std::path::Path;
use std::time::Instant;
use hound::{WavReader, WavWriter, WavSpec, SampleFormat};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use crate::logger::log_debug;

/// Режим сведения / целевой глубины дакинга
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DuckingMode {
    /// Закадр: оригинальный голос приглушается на -16 dB
    Voiceover,
    /// Рекаст: оригинальный голос приглушается на -24 dB
    Recast,
    /// Дубляж: оригинальный голос полностью вырезается / заглушается (-96 dB / Mute)
    Dubbing,
    /// Пользовательский уровень в dB
    Custom,
}

/// Тип целевой аудиодорожки
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetTrackType {
    /// Дорожка оригинального голоса (подлежит сильному дакингу в соответствии с режимом)
    OriginalDialogue,
    /// Дорожка чистой музыки и шумов (M&E) — остается нетронутой или ослабляется на -1.5 dB
    MusicAndEffects,
}

/// Временная маска активности голоса дабера (Voice Activity Mask)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceActivityMask {
    pub start_sec: f64,
    pub end_sec: f64,
}

/// Конфигурация интеллектуального сайдчейн-дакинга
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidechainDuckingConfig {
    #[serde(default = "default_ducking_mode")]
    pub mode: DuckingMode,
    #[serde(default = "default_target_track_type")]
    pub track_type: TargetTrackType,
    /// Пользовательская глубина дакинга (если mode == Custom, например -16.0 dB)
    pub custom_ducking_db: Option<f64>,
    /// Упреждение до начала фразы (по умолчанию 50 мс)
    #[serde(default = "default_lookahead_ms")]
    pub lookahead_ms: f64,
    /// Плавный спуск (Fade-down / Attack, по умолчанию 100 мс)
    #[serde(default = "default_fade_down_ms")]
    pub fade_down_ms: f64,
    /// Удержание дакинга после окончания фразы (по умолчанию 150 мс)
    #[serde(default = "default_hold_ms")]
    pub hold_ms: f64,
    /// Плавный подъем (Release, по умолчанию 350 мс, диапазон 300–500 мс)
    #[serde(default = "default_release_ms")]
    pub release_ms: f64,
    /// Опциональное легкое ослабление M&E дорожки (по умолчанию -1.5 dB, 0 = без изменений)
    #[serde(default = "default_me_ducking_db")]
    pub me_ducking_db: f64,
}

fn default_ducking_mode() -> DuckingMode {
    DuckingMode::Voiceover
}

fn default_target_track_type() -> TargetTrackType {
    TargetTrackType::OriginalDialogue
}

fn default_lookahead_ms() -> f64 {
    50.0
}

fn default_fade_down_ms() -> f64 {
    100.0
}

fn default_hold_ms() -> f64 {
    150.0
}

fn default_release_ms() -> f64 {
    350.0
}

fn default_me_ducking_db() -> f64 {
    -1.5
}

impl Default for SidechainDuckingConfig {
    fn default() -> Self {
        Self {
            mode: default_ducking_mode(),
            track_type: default_target_track_type(),
            custom_ducking_db: None,
            lookahead_ms: default_lookahead_ms(),
            fade_down_ms: default_fade_down_ms(),
            hold_ms: default_hold_ms(),
            release_ms: default_release_ms(),
            me_ducking_db: default_me_ducking_db(),
        }
    }
}

/// Результат рендеринга сайдчейн-дакинга
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckingRenderResult {
    pub input_path: String,
    pub output_path: String,
    pub total_frames: usize,
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub ducked_intervals_count: usize,
    pub min_gain_db: f64,
    pub target_ducking_db: f64,
    pub mode: DuckingMode,
    pub track_type: TargetTrackType,
    pub processing_time_ms: u64,
    pub success: bool,
    pub error: Option<String>,
}

/// Внутреннее представление расширенного интервала с таймингами огибающей
#[derive(Debug, Clone)]
struct ActiveDuckWindow {
    /// Начало фазы спуска: S - lookahead - fade_down
    t_down_start: f64,
    /// Конец фазы спуска (достижение максимального дакинга): S - lookahead
    t_down_end: f64,
    /// Окончание фазы удержания: E + hold
    t_hold_end: f64,
    /// Окончание фазы подъема (возврат к 0 dB): E + hold + release
    t_release_end: f64,
    /// Целевой линейный коэффициент усиления во время дакинга (0.0 .. 1.0)
    target_gain: f32,
}

/// S-образная кривая спуска (Fade-down / Attack)
/// t_norm от 0.0 (без ослабления = 1.0) до 1.0 (полный дакинг = target_gain)
#[inline(always)]
fn s_curve_down(t_norm: f32, target_gain: f32) -> f32 {
    let clamped = t_norm.clamp(0.0, 1.0);
    // S(x) = 0.5 * (1 + cos(pi * x)), где S(0)=1, S(1)=0, S'(0)=0, S'(1)=0
    let s = 0.5 * (1.0 + (PI * clamped).cos());
    target_gain + (1.0 - target_gain) * s
}

/// S-образная кривая подъема (Fade-up / Release)
/// t_norm от 0.0 (дакинг = target_gain) до 1.0 (возврат = 1.0)
#[inline(always)]
fn s_curve_up(t_norm: f32, target_gain: f32) -> f32 {
    let clamped = t_norm.clamp(0.0, 1.0);
    // S(x) = 0.5 * (1 - cos(pi * x)), где S(0)=0, S(1)=1, S'(0)=0, S'(1)=0
    let s = 0.5 * (1.0 - (PI * clamped).cos());
    target_gain + (1.0 - target_gain) * s
}

/// Подготовка и слияние временных интервалов активности с расчетом S-огибающей
fn prepare_duck_windows(
    masks: &[VoiceActivityMask],
    config: &SidechainDuckingConfig,
    target_gain: f32,
) -> Vec<ActiveDuckWindow> {
    if masks.is_empty() {
        return Vec::new();
    }

    // 1. Сортируем маски по времени начала
    let mut sorted_masks = masks.to_vec();
    sorted_masks.sort_by(|a, b| a.start_sec.partial_cmp(&b.start_sec).unwrap_or(std::cmp::Ordering::Equal));

    let lookahead_sec = (config.lookahead_ms / 1000.0).max(0.0);
    let fade_down_sec = (config.fade_down_ms / 1000.0).max(0.005);
    let hold_sec = (config.hold_ms / 1000.0).max(0.0);
    let release_sec = (config.release_ms / 1000.0).max(0.010);

    // 2. Объединяем близкие интервалы, если пауза между ними меньше hold + 50 мс
    let merge_threshold_sec = hold_sec + 0.050;
    let mut merged: Vec<(f64, f64)> = Vec::new();

    for m in sorted_masks {
        let s = m.start_sec.max(0.0);
        let e = m.end_sec.max(s);
        if let Some(last) = merged.last_mut() {
            if s <= last.1 + merge_threshold_sec {
                last.1 = last.1.max(e);
            } else {
                merged.push((s, e));
            }
        } else {
            merged.push((s, e));
        }
    }

    // 3. Формируем окна дакинга
    let mut windows = Vec::with_capacity(merged.len());
    for (start_sec, end_sec) in merged {
        let t_down_end = (start_sec - lookahead_sec).max(0.0);
        let t_down_start = (t_down_end - fade_down_sec).max(0.0);
        let t_hold_end = end_sec + hold_sec;
        let t_release_end = t_hold_end + release_sec;

        windows.push(ActiveDuckWindow {
            t_down_start,
            t_down_end,
            t_hold_end,
            t_release_end,
            target_gain,
        });
    }

    windows
}

/// Вычисление мгновенного значения коэффициента дакинга в момент времени `t` (сек)
#[inline(always)]
fn compute_gain_at_time(t: f64, windows: &[ActiveDuckWindow]) -> f32 {
    let mut min_gain = 1.0f32;

    for w in windows {
        if t < w.t_down_start {
            continue;
        }
        if t > w.t_release_end {
            continue;
        }

        let g = if t < w.t_down_end {
            // Фаза спуска (Attack / Fade-down)
            let dur = (w.t_down_end - w.t_down_start).max(1e-5);
            let alpha = ((t - w.t_down_start) / dur) as f32;
            s_curve_down(alpha, w.target_gain)
        } else if t <= w.t_hold_end {
            // Фаза удержания (Hold)
            w.target_gain
        } else {
            // Фаза подъема (Release / Fade-up)
            let dur = (w.t_release_end - w.t_hold_end).max(1e-5);
            let alpha = ((t - w.t_hold_end) / dur) as f32;
            s_curve_up(alpha, w.target_gain)
        };

        if g < min_gain {
            min_gain = g;
            if min_gain <= 0.0 {
                return 0.0;
            }
        }
    }

    min_gain
}

/// Определение целевого ослабления в dB в зависимости от режима и типа дорожки
pub fn resolve_ducking_depth_db(config: &SidechainDuckingConfig) -> f64 {
    match config.track_type {
        TargetTrackType::MusicAndEffects => {
            // M&E дорожка ослабляется незначительно (-1.5 dB) или не трогается
            config.me_ducking_db.clamp(-12.0, 0.0)
        }
        TargetTrackType::OriginalDialogue => {
            match config.mode {
                DuckingMode::Voiceover => -16.0,
                DuckingMode::Recast => -24.0,
                DuckingMode::Dubbing => -96.0, // Полный Mute
                DuckingMode::Custom => config.custom_ducking_db.unwrap_or(-16.0).clamp(-96.0, 0.0),
            }
        }
    }
}

/// Потоковый рендеринг дакинга аудиофайла чанками через Rayon с минимальным расходом памяти
pub fn render_sidechain_ducking_internal(
    input_path: &Path,
    output_path: &Path,
    masks: &[VoiceActivityMask],
    config: &SidechainDuckingConfig,
) -> Result<DuckingRenderResult, String> {
    let start_time = Instant::now();

    if !input_path.exists() {
        return Err(format!("Исходный аудиофайл не существует: {:?}", input_path));
    }

    let mut reader = WavReader::open(input_path)
        .map_err(|e| format!("Ошибка открытия WAV {:?}: {}", input_path, e))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let sample_rate = spec.sample_rate;

    if channels == 0 || sample_rate == 0 {
        return Err("Некорректная спецификация аудио (0 каналов или 0 Hz)".to_string());
    }

    let target_db = resolve_ducking_depth_db(config);
    let target_linear_gain = if target_db <= -90.0 {
        0.0f32
    } else {
        (10.0_f64.powf(target_db / 20.0)) as f32
    };

    let windows = prepare_duck_windows(masks, config, target_linear_gain);

    if let Some(parent) = output_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // Временный файл при перезаписи того же пути
    let is_same_file = input_path == output_path;
    let effective_output_path = if is_same_file {
        output_path.with_extension(format!("ducking_tmp_{}.wav", uuid::Uuid::new_v4()))
    } else {
        output_path.to_path_buf()
    };

    let out_spec = WavSpec {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(&effective_output_path, out_spec)
        .map_err(|e| format!("Ошибка создания выходного WAV {:?}: {}", effective_output_path, e))?;

    // Чтение и потоковая обработка блоками по 16384 фрейма (низкий footprint RAM)
    const CHUNK_FRAMES: usize = 16384;
    let chunk_samples = CHUNK_FRAMES * channels;

    let mut sample_iter = match spec.sample_format {
        SampleFormat::Float => {
            let s: Vec<f32> = reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect();
            s
        }
        SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            if bits <= 16 {
                reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / 32768.0).collect()
            } else if bits <= 24 {
                reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 8388608.0).collect()
            } else {
                reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 2147483648.0).collect()
            }
        }
    };

    let total_samples = sample_iter.len();
    let total_frames = total_samples / channels;
    let duration_sec = total_frames as f64 / sample_rate as f64;

    // Параллельная обработка чанков через Rayon
    // Разбиваем сэмплы на срезы фреймов и рассчитываем огибающую
    sample_iter
        .par_chunks_mut(chunk_samples)
        .enumerate()
        .for_each(|(chunk_idx, chunk)| {
            let start_frame = chunk_idx * CHUNK_FRAMES;
            let frames_in_chunk = chunk.len() / channels;

            for f in 0..frames_in_chunk {
                let current_frame = start_frame + f;
                let current_time = current_frame as f64 / sample_rate as f64;
                let gain = compute_gain_at_time(current_time, &windows);

                let offset = f * channels;
                for ch in 0..channels {
                    chunk[offset + ch] *= gain;
                }
            }
        });

    // Запись обработанных сэмплов в файл
    for &s in &sample_iter {
        writer.write_sample(s)
            .map_err(|e| format!("Ошибка записи сэмпла: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| format!("Ошибка завершения записи WAV: {}", e))?;

    // Если была перезапись исходного файла, безопасно перемещаем
    if is_same_file {
        if let Err(e) = fs::rename(&effective_output_path, output_path) {
            if fs::copy(&effective_output_path, output_path).is_ok() {
                let _ = fs::remove_file(&effective_output_path);
            } else {
                let _ = fs::remove_file(&effective_output_path);
                return Err(format!("Не удалось перезаписать целевой файл: {}", e));
            }
        }
    }

    let min_gain_db = if windows.is_empty() {
        0.0
    } else {
        target_db
    };

    let elapsed = start_time.elapsed().as_millis() as u64;

    log_debug(&format!(
        "render_sidechain_ducking: завершено за {} мс. Фреймов: {}, масок: {}, целевой дакинг: {:.1} dB",
        elapsed, total_frames, masks.len(), target_db
    ));

    Ok(DuckingRenderResult {
        input_path: input_path.to_string_lossy().to_string(),
        output_path: output_path.to_string_lossy().to_string(),
        total_frames,
        duration_sec,
        sample_rate,
        channels: spec.channels,
        ducked_intervals_count: windows.len(),
        min_gain_db,
        target_ducking_db: target_db,
        mode: config.mode,
        track_type: config.track_type,
        processing_time_ms: elapsed,
        success: true,
        error: None,
    })
}

/// Нативная Tauri команда интеллектуального сайдчейн-дакинга
#[tauri::command]
pub async fn render_sidechain_ducking(
    input_path: String,
    output_path: String,
    activity_masks: Vec<VoiceActivityMask>,
    config: SidechainDuckingConfig,
) -> Result<DuckingRenderResult, String> {
    let norm_in = crate::file_io::normalize_windows_path(&input_path);
    let norm_out = crate::file_io::normalize_windows_path(&output_path);

    log_debug(&format!(
        "render_sidechain_ducking: старт для {:?} -> {:?}, масок: {}, режим: {:?}",
        norm_in, norm_out, activity_masks.len(), config.mode
    ));

    tokio::task::spawn_blocking(move || {
        let p_in = Path::new(&norm_in);
        let p_out = Path::new(&norm_out);
        render_sidechain_ducking_internal(p_in, p_out, &activity_masks, &config)
    })
    .await
    .map_err(|e| e.to_string())?
}
