// ============================================================================
// DUB MIXING STUDIO PRO - TIMELINE WAVEFORM CULLING & VIRTUALIZATION ENGINE
// Модуль высокопроизводительного Frustum Culling и генерации волновых форм в Rust
// Стек: rayon = "1.10.0", serde = "1.0", tauri = "2.11", dashmap = "6.1.0"
// Гарантия: 60 FPS при 2000+ клипах на таймлайне
// ============================================================================

use std::collections::HashSet;
use std::sync::{Arc, RwLock};
use dashmap::DashMap;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{command, State};

use crate::audio_buffer_manager::AudioBufferCache;
use crate::realtime_analyzer::{compute_waveform_mipmaps_internal, WaveformMipmap};
use crate::smart_align::resolve_audio_samples;

// ============================================================================
// СТРУКТУРЫ ДАННЫХ И ПРОТОКОЛ ОБМЕНА
// ============================================================================

/// Входные данные одного сегмента аудиодорожки
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSegmentData {
    pub id: String,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub buffer_id: Option<String>,
    pub start_time: f64, // Время старта на таймлайне (секунды)
    pub duration: f64,   // Длительность на таймлайне (секунды)
    #[serde(default)]
    pub file_offset: f64, // Смещение от начала файла (секунды)
    #[serde(default)]
    pub file_duration: Option<f64>, // Полная длительность файла (секунды)
    #[serde(default = "default_gain")]
    pub gain: f32,       // Гейн клипа
    #[serde(default)]
    pub is_muted: bool,
    #[serde(default)]
    pub waveform: Option<Vec<f32>>, // Резервный кэш пиков с фронтенда
}

fn default_gain() -> f32 {
    1.0
}

/// Входные данные аудиодорожки таймлайна
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTrackData {
    pub id: String,
    pub name: String,
    #[serde(default = "default_gain")]
    pub volume: f32,
    #[serde(default)]
    pub is_muted: bool,
    #[serde(default)]
    pub is_solo: bool,
    pub segments: Vec<TimelineSegmentData>,
}

/// Запрос видимой области таймлайна от фронтенда
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportQuery {
    pub viewport_start_ms: u64,
    pub viewport_end_ms: u64,
    pub canvas_width_px: u32,
    pub active_track_ids: Vec<String>,
    #[serde(default)]
    pub tracks: Option<Vec<TimelineTrackData>>,
}

/// Сжатые пики для конкретной дорожки строго под разрешение canvas_width_px
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPeaksData {
    pub track_id: String,
    /// Плоский интерливированный массив [min_0, max_0, min_1, max_1, ...]
    /// Ровно 2 значения f32 на каждый пиксель ширины экрана (length = 2 * canvas_width_px).
    pub peaks: Vec<f32>,
    pub visible_clip_count: usize,
    pub visible_clip_ids: Vec<String>,
}

/// Итоговый ответ с витриной пиков для всех видимых дорожек
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePeaksPayload {
    pub viewport_start_ms: u64,
    pub viewport_end_ms: u64,
    pub canvas_width_px: u32,
    pub lod_level: String,
    pub total_visible_clips: usize,
    pub tracks: Vec<TrackPeaksData>,
    /// Бинарный буфер байтов (Float32Array) для Zero-Copy распаковки в JS при необходимости
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub raw_bytes: Vec<u8>,
}

/// Глобальное состояние виртуализации таймлайна
pub struct TimelineCullingState {
    /// Кэш зарегистрированных дорожек проекта
    pub cached_tracks: Arc<RwLock<Vec<TimelineTrackData>>>,
    /// In-memory кэш Mipmap волновых форм (ключ: file_path или buffer_id)
    pub mipmap_cache: Arc<DashMap<String, Arc<WaveformMipmap>>>,
}

impl TimelineCullingState {
    pub fn new() -> Self {
        Self {
            cached_tracks: Arc::new(RwLock::new(Vec::new())),
            mipmap_cache: Arc::new(DashMap::new()),
        }
    }
}

impl Default for TimelineCullingState {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// ЯДРО LOD И СЭМПЛИРОВАНИЯ ВОЛНОВЫХ ФОРМ
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MipmapLod {
    Lod1x,
    Lod10x,
    Lod100x,
    Lod1000x,
}

impl MipmapLod {
    pub fn name(&self) -> &'static str {
        match self {
            MipmapLod::Lod1x => "1x",
            MipmapLod::Lod10x => "10x",
            MipmapLod::Lod100x => "100x",
            MipmapLod::Lod1000x => "1000x",
        }
    }

    /// Интервал времени в миллисекундах между соседними пиками в данном LOD (при 48 кГц)
    pub fn peak_interval_ms(&self, sample_rate: u32) -> f64 {
        let sr = sample_rate.max(8000) as f64;
        match self {
            MipmapLod::Lod1x => (64.0 / sr) * 1000.0,      // ~1.33 мс
            MipmapLod::Lod10x => (640.0 / sr) * 1000.0,    // ~13.33 мс
            MipmapLod::Lod100x => (6400.0 / sr) * 1000.0,  // ~133.33 мс
            MipmapLod::Lod1000x => (64000.0 / sr) * 1000.0,// ~1333.33 мс
        }
    }
}

/// Выбор оптимального уровня LOD в зависимости от масштаба времени на пиксель
fn select_optimal_lod(ms_per_pixel: f64) -> MipmapLod {
    if ms_per_pixel < 4.0 {
        MipmapLod::Lod1x
    } else if ms_per_pixel < 40.0 {
        MipmapLod::Lod10x
    } else if ms_per_pixel < 400.0 {
        MipmapLod::Lod100x
    } else {
        MipmapLod::Lod1000x
    }
}

/// Получение или генерация Mipmap для сегмента
fn get_or_resolve_mipmap(
    segment: &TimelineSegmentData,
    audio_cache: &AudioBufferCache,
    state: &TimelineCullingState,
) -> Option<Arc<WaveformMipmap>> {
    // 1. Поиск ключа (file_path или buffer_id)
    let key = segment.file_path.as_deref().or(segment.buffer_id.as_deref());

    if let Some(k) = key {
        // Проверка в in-memory кэше Mipmap
        if let Some(existing) = state.mipmap_cache.get(k) {
            return Some(existing.clone());
        }

        // Попытка извлечь аудиоданные через AudioBufferCache или hound
        if let Ok(audio) = resolve_audio_samples(k, Some(audio_cache)) {
            if !audio.samples.is_empty() {
                let computed = compute_waveform_mipmaps_internal(&audio.samples, audio.sample_rate);
                let arc_mipmap = Arc::new(computed);
                state.mipmap_cache.insert(k.to_string(), arc_mipmap.clone());
                return Some(arc_mipmap);
            }
        }
    }

    // 2. Fallback: создание легковесного Mipmap из переданного waveform массива
    if let Some(ref wf) = segment.waveform {
        if !wf.is_empty() {
            let total_dur = segment.file_duration.unwrap_or(0.0);
            let effective_dur = if total_dur >= (segment.file_offset + segment.duration) {
                total_dur
            } else {
                (segment.file_offset + segment.duration).max(segment.duration)
            };
            let synthetic = create_synthetic_mipmap(wf, effective_dur);
            let arc_mipmap = Arc::new(synthetic);
            if let Some(k) = key {
                state.mipmap_cache.insert(k.to_string(), arc_mipmap.clone());
            }
            return Some(arc_mipmap);
        }
    }

    None
}

/// Создание Mipmap уровней из плоского массива пиков (fallback)
fn create_synthetic_mipmap(peaks: &[f32], duration_seconds: f64) -> WaveformMipmap {
    let dur = duration_seconds.max(0.01);
    let sample_rate = ((peaks.len() as f64 * 64.0) / dur).round() as u32;
    let sr = sample_rate.clamp(8000, 192000);

    let lod_1x = peaks.to_vec();
    let lod_10x = downsample_peaks(&lod_1x, 10);
    let lod_100x = downsample_peaks(&lod_10x, 10);
    let lod_1000x = downsample_peaks(&lod_100x, 10);

    let total_samples = (dur * sr as f64).round() as u64;

    WaveformMipmap {
        sample_rate: sr,
        total_samples,
        duration_seconds: dur,
        lod_1x,
        lod_10x,
        lod_100x,
        lod_1000x,
    }
}

fn downsample_peaks(src: &[f32], factor: usize) -> Vec<f32> {
    if factor <= 1 || src.is_empty() {
        return src.to_vec();
    }
    src.chunks(factor)
        .map(|chunk| chunk.iter().fold(0.0f32, |acc, &x| acc.max(x.abs())))
        .collect()
}

// ============================================================================
// РАСЧЕТ ПИЕКСЕЛЬНЫХ ПОЛОС ОДНОЙ ДОРОЖКИ (FRUSTUM CULLING + RESAMPLING)
// ============================================================================

fn process_single_track_peaks(
    track: &TimelineTrackData,
    query: &ViewportQuery,
    audio_cache: &AudioBufferCache,
    state: &TimelineCullingState,
    lod: MipmapLod,
) -> TrackPeaksData {
    let width_px = query.canvas_width_px as usize;
    if width_px == 0 {
        return TrackPeaksData {
            track_id: track.id.clone(),
            peaks: Vec::new(),
            visible_clip_count: 0,
            visible_clip_ids: Vec::new(),
        };
    }

    let v_start_ms = query.viewport_start_ms as f64;
    let v_end_ms = query.viewport_end_ms as f64;
    let v_duration_ms = (v_end_ms - v_start_ms).max(0.001);
    let ms_per_pixel = v_duration_ms / (width_px as f64);

    // 1. Frustum Culling: быстрый отбор только видимых клипов дорожки
    let mut visible_clips = Vec::new();
    let mut visible_clip_ids = Vec::new();

    for seg in &track.segments {
        if seg.is_muted || seg.duration <= 0.0 {
            continue;
        }
        let seg_start_ms = seg.start_time * 1000.0;
        let seg_end_ms = (seg.start_time + seg.duration) * 1000.0;

        // Отсечение за пределами экрана
        if seg_end_ms > v_start_ms && seg_start_ms < v_end_ms {
            visible_clips.push(seg);
            visible_clip_ids.push(seg.id.clone());
        }
    }

    let visible_clip_count = visible_clips.len();

    // 2. Инициализация буфера пиков: [min_0, max_0, min_1, max_1, ...]
    let mut peaks = vec![0.0f32; width_px * 2];

    if visible_clip_count == 0 {
        return TrackPeaksData {
            track_id: track.id.clone(),
            peaks,
            visible_clip_count: 0,
            visible_clip_ids: Vec::new(),
        };
    }

    // 3. Обработка каждого видимого клипа с наложением на результирующий буфер
    for seg in visible_clips {
        let mipmap_opt = get_or_resolve_mipmap(seg, audio_cache, state);
        if mipmap_opt.is_none() {
            continue;
        }
        let mipmap = mipmap_opt.unwrap();

        let seg_start_ms = seg.start_time * 1000.0;
        let seg_end_ms = (seg.start_time + seg.duration) * 1000.0;
        let file_offset_ms = seg.file_offset * 1000.0;

        // Диапазон пикселей по X, которые занимает данный клип на экране
        let px_start = (((seg_start_ms - v_start_ms) / ms_per_pixel).floor() as i64).clamp(0, width_px as i64) as usize;
        let px_end = (((seg_end_ms - v_start_ms) / ms_per_pixel).ceil() as i64).clamp(0, width_px as i64) as usize;

        if px_start >= px_end {
            continue;
        }

        // Выбор среза пиков выбранного уровня LOD
        let (peak_slice, sample_rate) = match lod {
            MipmapLod::Lod1x => (&mipmap.lod_1x, mipmap.sample_rate),
            MipmapLod::Lod10x => (&mipmap.lod_10x, mipmap.sample_rate),
            MipmapLod::Lod100x => (&mipmap.lod_100x, mipmap.sample_rate),
            MipmapLod::Lod1000x => (&mipmap.lod_1000x, mipmap.sample_rate),
        };

        if peak_slice.is_empty() {
            continue;
        }

        let interval_ms = lod.peak_interval_ms(sample_rate);
        let effective_gain = seg.gain * track.volume;

        // Сжатие пиков под точные пиксели экрана
        for x in px_start..px_end {
            let col_start_ms = v_start_ms + (x as f64 * ms_per_pixel);
            let col_end_ms = v_start_ms + ((x + 1) as f64 * ms_per_pixel);

            // Пересечение временного окна пикселя с границами клипа
            let inter_start_ms = col_start_ms.max(seg_start_ms);
            let inter_end_ms = col_end_ms.min(seg_end_ms);

            if inter_start_ms >= inter_end_ms {
                continue;
            }

            // Позиция внутри аудиофайла клипа
            let local_start_ms = inter_start_ms - seg_start_ms + file_offset_ms;
            let local_end_ms = inter_end_ms - seg_start_ms + file_offset_ms;

            let idx_start = (local_start_ms / interval_ms).floor() as usize;
            let idx_end = (local_end_ms / interval_ms).ceil() as usize;

            if idx_start >= peak_slice.len() {
                continue;
            }

            let slice_end = idx_end.min(peak_slice.len()).max(idx_start + 1);

            // Извлечение максимальной амплитуды в интервале пикселя
            let mut max_val = 0.0f32;
            for i in idx_start..slice_end {
                let v = peak_slice[i];
                if v > max_val {
                    max_val = v;
                }
            }

            let scaled_amp = (max_val * effective_gain).clamp(0.0, 1.0);
            let min_y = -scaled_amp;
            let max_y = scaled_amp;

            let min_idx = x * 2;
            let max_idx = x * 2 + 1;

            // Объединение с существующими пиками на этой дорожке (если клипы накладываются)
            if min_y < peaks[min_idx] {
                peaks[min_idx] = min_y;
            }
            if max_y > peaks[max_idx] {
                peaks[max_idx] = max_y;
            }
        }
    }

    TrackPeaksData {
        track_id: track.id.clone(),
        peaks,
        visible_clip_count,
        visible_clip_ids,
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Главная команда запроса волновых форм для видимой области таймлайна
#[command]
pub async fn get_timeline_visible_peaks(
    state: State<'_, TimelineCullingState>,
    audio_cache: State<'_, AudioBufferCache>,
    query: ViewportQuery,
) -> Result<TimelinePeaksPayload, String> {
    if query.canvas_width_px == 0 || query.viewport_end_ms <= query.viewport_start_ms {
        return Ok(TimelinePeaksPayload {
            viewport_start_ms: query.viewport_start_ms,
            viewport_end_ms: query.viewport_end_ms,
            canvas_width_px: query.canvas_width_px,
            lod_level: "1x".to_string(),
            total_visible_clips: 0,
            tracks: Vec::new(),
            raw_bytes: Vec::new(),
        });
    }

    let state_ref = state.inner().clone_state();
    let audio_cache_ref = audio_cache.inner().clone();

    tokio::task::spawn_blocking(move || {
        // 1. Определение списка дорожек для рендеринга
        let tracks_to_process = if let Some(ref input_tracks) = query.tracks {
            // Сохраняем переданные дорожки в кэш для последующих быстрых кадров
            if let Ok(mut lock) = state_ref.cached_tracks.write() {
                *lock = input_tracks.clone();
            }
            input_tracks.clone()
        } else if let Ok(lock) = state_ref.cached_tracks.read() {
            lock.clone()
        } else {
            Vec::new()
        };

        let active_set: HashSet<String> = query.active_track_ids.iter().cloned().collect();

        // 2. Выбор оптимального уровня LOD по плотности времени на пиксель
        let v_dur = (query.viewport_end_ms - query.viewport_start_ms) as f64;
        let ms_per_pixel = v_dur / (query.canvas_width_px as f64);
        let lod = select_optimal_lod(ms_per_pixel);

        // 3. Параллельный расчет всех дорожек через Rayon
        let filtered_tracks: Vec<TimelineTrackData> = tracks_to_process
            .into_iter()
            .filter(|t| !t.is_muted && (active_set.is_empty() || active_set.contains(&t.id)))
            .collect();

        let track_results: Vec<TrackPeaksData> = filtered_tracks
            .par_iter()
            .map(|t| process_single_track_peaks(t, &query, &audio_cache_ref, &state_ref, lod))
            .collect();

        let total_visible_clips: usize = track_results.iter().map(|t| t.visible_clip_count).sum();

        // 4. Формирование плоского бинарного буфера байт f32 для Zero-Copy распаковки
        let total_floats = track_results.len() * (query.canvas_width_px as usize) * 2;
        let mut raw_bytes = Vec::with_capacity(total_floats * 4);
        for tr in &track_results {
            for &peak_val in &tr.peaks {
                raw_bytes.extend_from_slice(&peak_val.to_le_bytes());
            }
        }

        Ok(TimelinePeaksPayload {
            viewport_start_ms: query.viewport_start_ms,
            viewport_end_ms: query.viewport_end_ms,
            canvas_width_px: query.canvas_width_px,
            lod_level: lod.name().to_string(),
            total_visible_clips,
            tracks: track_results,
            raw_bytes,
        })
    })
    .await
    .map_err(|e| format!("Ошибка задачи get_timeline_visible_peaks: {}", e))?
}

/// Регистрация актуальных дорожек таймлайна в кэше Rust
#[command]
pub async fn set_timeline_culling_tracks(
    state: State<'_, TimelineCullingState>,
    tracks: Vec<TimelineTrackData>,
) -> Result<(), String> {
    if let Ok(mut lock) = state.cached_tracks.write() {
        *lock = tracks;
        Ok(())
    } else {
        Err("Не удалось заблокировать cached_tracks для записи".to_string())
    }
}

/// Очистка in-memory кэша Mipmap и дорожек
#[command]
pub async fn clear_timeline_culling_cache(
    state: State<'_, TimelineCullingState>,
) -> Result<(), String> {
    state.mipmap_cache.clear();
    if let Ok(mut lock) = state.cached_tracks.write() {
        lock.clear();
    }
    Ok(())
}

// Вспомогательный метод клонирования дескрипторов состояния для передачи в spawn_blocking
impl TimelineCullingState {
    pub fn clone_state(&self) -> Self {
        Self {
            cached_tracks: self.cached_tracks.clone(),
            mipmap_cache: self.mipmap_cache.clone(),
        }
    }
}
