// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE ADAPTIVE DUCKING ENGINE (RUST)
// Высокоточный расчет огибающей сайдчейна с точностью до 1 сэмпла (Sample-Accurate)
// Стек: hound = "3.5.1", rayon = "1.10.0", serde, tauri = "2.2"
// ============================================================================

use std::f32::consts::PI;
use std::path::Path;
use std::time::Instant;

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;

use crate::audio_buffer_manager::AudioBufferCache;
use crate::db::AppState;
use crate::file_io::normalize_windows_path;
use crate::logger::log_info;

// ============================================================================
// МОДЕЛИ ДАННЫХ И ПАРАМЕТРЫ ДАККИНГА
// ============================================================================

/// Тип кривой интерполяции огибающей
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CurveType {
    /// Линейная интерполяция
    Linear,
    /// Экспоненциальная кривая (натуральное затухание)
    Exponential,
    /// S-образная кривая (Smooth Hermite / Cosine без щелчков и разрывов производной)
    SCurve,
}

impl Default for CurveType {
    fn default() -> Self {
        CurveType::SCurve
    }
}

/// Конфигурация параметров адаптивного сайдчейн-даккинга
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckingConfig {
    /// Глубина ослабления в dB (например, -16.0 dB для закадра, -96.0 dB для полного дубляжа)
    pub attenuation_db: f32,
    /// Предварительное упреждение перед репликой (Lookahead) в миллисекундах (обычно 30–80 мс)
    pub lookahead_ms: f32,
    /// Длительность фазы затухания (Attack) в миллисекундах (обычно 50–120 мс)
    pub attack_ms: f32,
    /// Длительность удержания уровня (Hold) в миллисекундах (обычно 100–250 мс)
    pub hold_ms: f32,
    /// Длительность фазы восстановления (Release) в миллисекундах (обычно 200–400 мс)
    pub release_ms: f32,
    /// Тип кривой переходов
    #[serde(default)]
    pub curve_type: CurveType,
}

impl Default for DuckingConfig {
    fn default() -> Self {
        Self {
            attenuation_db: -16.0,
            lookahead_ms: 50.0,
            attack_ms: 80.0,
            hold_ms: 150.0,
            release_ms: 300.0,
            curve_type: CurveType::SCurve,
        }
    }
}

/// Временной диапазон активности голоса актера (Sample-Accurate Voice Mask)
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueRange {
    /// Номер начального сэмпла (фрейма)
    pub start_sample: usize,
    /// Номер конечного сэмпла (фрейма)
    pub end_sample: usize,
}

/// Диапазон активности в секундах
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTimeRange {
    pub start_sec: f64,
    pub end_sec: f64,
}

/// Результат обработки даккинга
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckingProcessingResult {
    pub project_id: String,
    pub target_track_id: String,
    pub attenuation_db: f32,
    pub processed_frames: usize,
    pub total_cues_count: usize,
    pub duration_seconds: f64,
    pub elapsed_ms: u64,
    pub output_path: String,
    pub success: bool,
}

// ============================================================================
// МАТЕМАТИКА ИНТЕРПОЛЯЦИИ И S-ОГИБАЮЩИХ
// ============================================================================

/// Расчет коэффициента затухания (Attack) от 1.0 (0 dB) до target_gain (attenuation_db)
#[inline(always)]
fn interpolate_attack(t_norm: f32, target_gain: f32, curve: CurveType) -> f32 {
    let t = t_norm.clamp(0.0, 1.0);
    match curve {
        CurveType::Linear => 1.0 - (1.0 - target_gain) * t,
        CurveType::Exponential => {
            if target_gain <= 0.0001 {
                (1.0 - t).powi(3)
            } else {
                target_gain.powf(t)
            }
        }
        CurveType::SCurve => {
            // S-образная косинусная кривая: 0.5 * (1 + cos(pi * t))
            let s = 0.5 * (1.0 + (PI * t).cos());
            target_gain + (1.0 - target_gain) * s
        }
    }
}

/// Расчет коэффициента восстановления (Release) от target_gain до 1.0
#[inline(always)]
fn interpolate_release(t_norm: f32, target_gain: f32, curve: CurveType) -> f32 {
    let t = t_norm.clamp(0.0, 1.0);
    match curve {
        CurveType::Linear => target_gain + (1.0 - target_gain) * t,
        CurveType::Exponential => {
            if target_gain <= 0.0001 {
                t.powi(3)
            } else {
                target_gain * (1.0 / target_gain).powf(t)
            }
        }
        CurveType::SCurve => {
            // S-образная косинусная кривая восстановления: 0.5 * (1 - cos(pi * t))
            let s = 0.5 * (1.0 - (PI * t).cos());
            target_gain + (1.0 - target_gain) * s
        }
    }
}

/// Внутренний расширенный диапазон огибающей даккинга в сэмплах
#[derive(Debug, Clone)]
pub struct SampleDuckWindow {
    /// Индекс начала фазы затухания (Attack start): start - lookahead - attack
    pub attack_start_sample: usize,
    /// Индекс завершения затухания и выхода на целевой уровень: start - lookahead
    pub attack_end_sample: usize,
    /// Индекс окончания фазы удержания: end + hold
    pub hold_end_sample: usize,
    /// Индекс полного возврата уровня: end + hold + release
    pub release_end_sample: usize,
}

// ============================================================================
// ПОСТРОЕНИЕ ОГИБАЮЩЕЙ И ОБРАБОТКА СЭМПЛОВ
// ============================================================================

/// Построение и оптимизация масок активности (объединение пауз внутри предложения < 200 мс)
pub fn prepare_sample_duck_windows(
    voice_masks: &[CueRange],
    config: &DuckingConfig,
    sample_rate: u32,
) -> Vec<SampleDuckWindow> {
    if voice_masks.is_empty() {
        return Vec::new();
    }

    let mut sorted = voice_masks.to_vec();
    sorted.sort_by_key(|c| c.start_sample);

    let sr = sample_rate as f32;
    let lookahead_samples = ((config.lookahead_ms / 1000.0) * sr).round().max(0.0) as usize;
    let attack_samples = ((config.attack_ms / 1000.0) * sr).round().max(1.0) as usize;
    let hold_samples = ((config.hold_ms / 1000.0) * sr).round().max(0.0) as usize;
    let release_samples = ((config.release_ms / 1000.0) * sr).round().max(1.0) as usize;

    // Порог объединения пауз (удержание + 200 мс)
    let merge_gap_samples = hold_samples + ((0.200 * sr) as usize);

    let mut merged: Vec<CueRange> = Vec::new();
    for cue in sorted {
        if let Some(last) = merged.last_mut() {
            if cue.start_sample <= last.end_sample + merge_gap_samples {
                last.end_sample = last.end_sample.max(cue.end_sample);
            } else {
                merged.push(cue);
            }
        } else {
            merged.push(cue);
        }
    }

    let mut windows = Vec::with_capacity(merged.len());
    for cue in merged {
        let attack_end = if cue.start_sample > lookahead_samples {
            cue.start_sample - lookahead_samples
        } else {
            0
        };

        let attack_start = if attack_end > attack_samples {
            attack_end - attack_samples
        } else {
            0
        };

        let hold_end = cue.end_sample + hold_samples;
        let release_end = hold_end + release_samples;

        windows.push(SampleDuckWindow {
            attack_start_sample: attack_start,
            attack_end_sample: attack_end,
            hold_end_sample: hold_end,
            release_end_sample: release_end,
        });
    }

    windows
}

/// Генерация точной огибающей гейна (Sample-Accurate Gain Envelope)
pub fn generate_gain_envelope(
    total_frames: usize,
    windows: &[SampleDuckWindow],
    config: &DuckingConfig,
) -> Vec<f32> {
    let target_gain = if config.attenuation_db <= -90.0 {
        0.0f32
    } else {
        10.0f32.powf(config.attenuation_db / 20.0)
    };

    let mut envelope = vec![1.0f32; total_frames];

    if windows.is_empty() {
        return envelope;
    }

    // Параллельное вычисление чанками через Rayon
    const CHUNK_SIZE: usize = 4096;
    envelope
        .par_chunks_mut(CHUNK_SIZE)
        .enumerate()
        .for_each(|(chunk_idx, chunk)| {
            let chunk_start_frame = chunk_idx * CHUNK_SIZE;

            for (i, gain_val) in chunk.iter_mut().enumerate() {
                let frame = chunk_start_frame + i;
                let mut min_gain = 1.0f32;

                for w in windows {
                    if frame < w.attack_start_sample || frame > w.release_end_sample {
                        continue;
                    }

                    let g = if frame < w.attack_end_sample {
                        // Фаза Attack
                        let dur = (w.attack_end_sample - w.attack_start_sample).max(1) as f32;
                        let t = (frame - w.attack_start_sample) as f32 / dur;
                        interpolate_attack(t, target_gain, config.curve_type)
                    } else if frame <= w.hold_end_sample {
                        // Фаза Hold
                        target_gain
                    } else {
                        // Фаза Release
                        let dur = (w.release_end_sample - w.hold_end_sample).max(1) as f32;
                        let t = (frame - w.hold_end_sample) as f32 / dur;
                        interpolate_release(t, target_gain, config.curve_type)
                    };

                    if g < min_gain {
                        min_gain = g;
                        if min_gain <= 0.0 {
                            break;
                        }
                    }
                }

                *gain_val = min_gain;
            }
        });

    envelope
}

/// Многопоточный DSP-процессинг фоновой дорожки M&E (векторизованное умножение через Rayon)
pub fn process_ducking_offline(
    background_buffer: &mut [f32],
    voice_masks: &[CueRange],
    config: &DuckingConfig,
    sample_rate: u32,
    channels: u16,
) {
    if background_buffer.is_empty() || channels == 0 {
        return;
    }

    let ch = channels as usize;
    let total_frames = background_buffer.len() / ch;
    let windows = prepare_sample_duck_windows(voice_masks, config, sample_rate);
    let envelope = generate_gain_envelope(total_frames, &windows, config);

    // Векторизованное применение огибающей к многоканальному буферу
    const PARALLEL_FRAMES: usize = 4096;
    background_buffer
        .par_chunks_mut(PARALLEL_FRAMES * ch)
        .enumerate()
        .for_each(|(chunk_idx, chunk)| {
            let start_frame = chunk_idx * PARALLEL_FRAMES;
            let frames_count = chunk.len() / ch;

            for f in 0..frames_count {
                let frame_idx = start_frame + f;
                let gain = envelope[frame_idx];
                let offset = f * ch;

                for c in 0..ch {
                    chunk[offset + c] *= gain;
                }
            }
        });
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Применение адаптивного сайдчейн-даккинга к фоновой дорожке M&E в рамках проекта
#[tauri::command]
pub async fn apply_adaptive_ducking(
    db_state: State<'_, AppState>,
    cache_state: State<'_, AudioBufferCache>,
    project_id: String,
    config: DuckingConfig,
) -> Result<DuckingProcessingResult, String> {
    let start_time = Instant::now();
    log_info(&format!(
        "[DuckingEngine] Старт адаптивного даккинга для проекта '{}' (Ослабление: {:.1} dB, Атака: {:.1}ms, Релиз: {:.1}ms)",
        project_id, config.attenuation_db, config.attack_ms, config.release_ms
    ));

    // 1. Извлекаем дорожки проекта из SQLite базы данных
    let db_mutex = db_state.db.lock().await;
    let pool = db_mutex.as_ref().ok_or("База данных не инициализирована")?;

    struct TrackItem {
        id: String,
        name: String,
    }

    let track_rows = sqlx::query("SELECT id, name FROM tracks WHERE project_id = ?")
        .bind(&project_id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Ошибка загрузки треков: {}", e))?;

    let tracks: Vec<TrackItem> = track_rows
        .into_iter()
        .map(|r| TrackItem {
            id: r.get("id"),
            name: r.get("name"),
        })
        .collect();

    // Находим дорожку M&E (Music & Effects / Background) и дорожки дубляжа
    let me_track = tracks
        .iter()
        .find(|t| {
            let n = t.name.to_lowercase();
            n.contains("m&e") || n.contains("music") || n.contains("bg") || n.contains("фонов")
        })
        .or_else(|| tracks.first())
        .ok_or_else(|| "В проекте не найдено дорожек для даккинга".to_string())?;

    let me_track_id = me_track.id.clone();

    struct VoiceSegItem {
        start_time: f64,
        duration: f64,
        file_path: Option<String>,
    }

    // 2. Считываем все сегменты актерской речи со всех остальных дорожек проекта
    let voice_rows = sqlx::query(
        "SELECT s.start_time, s.duration, s.file_path FROM segments s
         JOIN tracks t ON s.track_id = t.id
         WHERE t.project_id = ? AND t.id != ?",
    )
    .bind(&project_id)
    .bind(&me_track_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Ошибка загрузки голосовых сегментов: {}", e))?;

    let voice_segments: Vec<VoiceSegItem> = voice_rows
        .into_iter()
        .map(|r| VoiceSegItem {
            start_time: r.get("start_time"),
            duration: r.get("duration"),
            file_path: r.get("file_path"),
        })
        .collect();

    struct MeSegItem {
        id: String,
        start_time: f64,
        duration: f64,
        file_path: Option<String>,
    }

    // 3. Считываем сегменты фоновой дорожки M&E
    let me_rows = sqlx::query(
        "SELECT s.id, s.start_time, s.duration, s.file_path FROM segments s
         WHERE s.track_id = ?",
    )
    .bind(&me_track_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Ошибка загрузки M&E сегментов: {}", e))?;

    let me_segments: Vec<MeSegItem> = me_rows
        .into_iter()
        .map(|r| MeSegItem {
            id: r.get("id"),
            start_time: r.get("start_time"),
            duration: r.get("duration"),
            file_path: r.get("file_path"),
        })
        .collect();

    if me_segments.is_empty() {
        return Err("На целевой дорожке M&E отсутствуют аудио-сегменты".to_string());
    }

    let target_me_seg = &me_segments[0];
    let raw_me_path = target_me_seg
        .file_path
        .as_ref()
        .ok_or_else(|| "M&E сегмент не привязан к аудиофайлу".to_string())?;

    let norm_me_path = normalize_windows_path(raw_me_path);
    let me_path = Path::new(&norm_me_path);

    if !me_path.exists() {
        return Err(format!("Файл M&E дорожки не найден на диске: {}", norm_me_path));
    }

    // 4. Открываем M&E аудиофайл
    let mut reader = WavReader::open(me_path)
        .map_err(|e| format!("Ошибка открытия M&E WAV файла: {}", e))?;
    let spec = reader.spec();
    let channels = spec.channels;
    let sample_rate = spec.sample_rate;

    // Считываем сэмплы M&E
    let mut me_samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => reader.samples::<f32>().filter_map(Result::ok).collect(),
        SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            if bits <= 16 {
                reader
                    .samples::<i16>()
                    .filter_map(Result::ok)
                    .map(|s| s as f32 / 32768.0)
                    .collect()
            } else {
                reader
                    .samples::<i32>()
                    .filter_map(Result::ok)
                    .map(|s| s as f32 / 2147483648.0)
                    .collect()
            }
        }
    };

    let total_frames = me_samples.len() / (channels as usize);
    let duration_seconds = total_frames as f64 / sample_rate as f64;

    // 5. Переводим голосовые реплики в маски CueRange (Sample-Accurate)
    let me_start_time = target_me_seg.start_time;
    let mut cue_ranges = Vec::with_capacity(voice_segments.len());

    for vseg in &voice_segments {
        let v_start = vseg.start_time - me_start_time;
        let v_end = v_start + vseg.duration;

        if v_end > 0.0 && v_start < duration_seconds {
            let start_frame = ((v_start.max(0.0)) * sample_rate as f64).round() as usize;
            let end_frame = ((v_end.min(duration_seconds)) * sample_rate as f64).round() as usize;

            if end_frame > start_frame {
                cue_ranges.push(CueRange {
                    start_sample: start_frame,
                    end_sample: end_frame,
                });
            }
        }
    }

    // 6. Выполняем быстрый многопоточный оффлайн даккинг
    process_ducking_offline(
        &mut me_samples,
        &cue_ranges,
        &config,
        sample_rate,
        channels,
    );

    // 7. Сохраняем обработанный результат в новый WAV файл (32-bit Float)
    let ducked_output_path = me_path.with_file_name(format!(
        "{}_ducked.wav",
        me_path.file_stem().and_then(|s| s.to_str()).unwrap_or("track")
    ));

    let out_spec = WavSpec {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(&ducked_output_path, out_spec)
        .map_err(|e| format!("Ошибка создания результирующего WAV файла: {}", e))?;

    for &sample in &me_samples {
        writer
            .write_sample(sample)
            .map_err(|e| format!("Ошибка записи сэмпла: {}", e))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("Ошибка финализации WAV: {}", e))?;

    let ducked_path_str = ducked_output_path.to_string_lossy().to_string();

    // Обновляем ссылку на файл в БД для M&E сегмента
    sqlx::query("UPDATE segments SET file_path = ? WHERE id = ?")
        .bind(&ducked_path_str)
        .bind(&target_me_seg.id)
        .execute(pool)
        .await
        .map_err(|e| format!("Ошибка обновления БД: {}", e))?;

    // Очищаем закэшированный старый буфер в памяти
    cache_state.remove(&norm_me_path);

    let elapsed = start_time.elapsed().as_millis() as u64;
    log_info(&format!(
        "[DuckingEngine] Сайдчейн-даккинг успешно применен за {} мс (Реплик: {}, Фреймов: {}) -> {:?}",
        elapsed,
        cue_ranges.len(),
        total_frames,
        ducked_output_path
    ));

    Ok(DuckingProcessingResult {
        project_id,
        target_track_id: me_track_id,
        attenuation_db: config.attenuation_db,
        processed_frames: total_frames,
        total_cues_count: cue_ranges.len(),
        duration_seconds,
        elapsed_ms: elapsed,
        output_path: ducked_path_str,
        success: true,
    })
}

/// Генерация превью огибающей даккинга без изменения файлов на диске (для отрисовки на таймлайне)
#[tauri::command]
pub async fn calculate_ducking_envelope_preview(
    voice_ranges: Vec<VoiceTimeRange>,
    config: DuckingConfig,
    total_duration_sec: f64,
    points_count: usize,
) -> Result<Vec<f32>, String> {
    if total_duration_sec <= 0.0 || points_count == 0 {
        return Ok(Vec::new());
    }

    let sample_rate = 1000; // Виртуальный семплрейт для быстрого превью точек
    let total_frames = (total_duration_sec * sample_rate as f64).round() as usize;

    let cue_ranges: Vec<CueRange> = voice_ranges
        .iter()
        .map(|r| CueRange {
            start_sample: (r.start_sec * sample_rate as f64).round().max(0.0) as usize,
            end_sample: (r.end_sec * sample_rate as f64).round().max(0.0) as usize,
        })
        .collect();

    let windows = prepare_sample_duck_windows(&cue_ranges, &config, sample_rate);
    let full_envelope = generate_gain_envelope(total_frames, &windows, &config);

    // Субдискретизация до запрошенного числа точек UI
    let step = (total_frames as f64 / points_count as f64).max(1.0);
    let mut preview_points = Vec::with_capacity(points_count);

    for i in 0..points_count {
        let idx = ((i as f64 * step).round() as usize).min(full_envelope.len() - 1);
        preview_points.push(full_envelope[idx]);
    }

    Ok(preview_points)
}
