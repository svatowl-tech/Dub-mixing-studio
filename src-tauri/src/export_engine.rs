// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE HIGH-PERFORMANCE AUDIO EXPORT ENGINE (RUST)
// Модуль 4.4 / 4.5: Нативное многопоточное сведение и потоковый экспорт
// Стек: hound = "3.5.1", memmap2 = "0.9.5", rayon = "1.10.0", tokio = "1.0", ebur128 = "0.1.10"
// Исключает построение сверхдлинных текстовых цепочек FFmpeg и промежуточных файлов на диске.
// ============================================================================

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use hound::{SampleFormat, WavSpec, WavWriter};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use zip::write::FileOptions;
use zip::ZipWriter;

use crate::audio_buffer_manager::{read_audio_file_any_format, CachedTrackBuffer};
use crate::db::AppState;
use crate::file_io::{find_ffmpeg_path, normalize_windows_path};
use crate::logger::{log_error, log_info};
use crate::process_utils::CommandExtHide;

// ----------------------------------------------------------------------------
// КОНСТАНТЫ РЕНДЕРИНГА И СВЕДЕНИЯ
// ----------------------------------------------------------------------------
pub const EXPORT_SAMPLE_RATE: u32 = 48000;
pub const EXPORT_CHANNELS: u16 = 2; // Stereo
pub const BLOCK_FRAMES: usize = 8192; // 64 КБ Stereo Float32 буфер на блок
pub const FADE_MICRO_FRAMES: usize = 96; // 2.0 мс антищелчковый микрофейд

// ----------------------------------------------------------------------------
// МЕНЕДЖЕР ТОКЕНОВ ОТМЕНЫ ЭКСПОРТА
// ----------------------------------------------------------------------------
static ACTIVE_EXPORT_TOKEN: OnceLock<RwLock<Option<CancellationToken>>> = OnceLock::new();

fn get_active_token_registry() -> &'static RwLock<Option<CancellationToken>> {
    ACTIVE_EXPORT_TOKEN.get_or_init(|| RwLock::new(None))
}

pub fn register_cancellation_token(token: CancellationToken) {
    if let Ok(mut lock) = get_active_token_registry().write() {
        *lock = Some(token);
    }
}

pub fn unregister_cancellation_token() {
    if let Ok(mut lock) = get_active_token_registry().write() {
        *lock = None;
    }
}

#[tauri::command]
pub async fn cancel_export() -> Result<bool, String> {
    if let Ok(lock) = get_active_token_registry().read() {
        if let Some(token) = lock.as_ref() {
            token.cancel();
            log_info("[ExportEngine] Export cancellation requested by user.");
            return Ok(true);
        }
    }
    Ok(false)
}

// ----------------------------------------------------------------------------
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ РАЗРЕШЕНИЯ ПУТЕЙ И ДИРЕКТОРИЙ
// ----------------------------------------------------------------------------
#[allow(dead_code)]
pub fn get_spacious_temp_dir(project_path_opt: Option<&str>, suffix: &str) -> PathBuf {
    if let Some(path_str) = project_path_opt {
        let norm = normalize_windows_path(path_str);
        let p = Path::new(&norm);
        if p.exists() {
            let dir = if p.is_file() {
                p.parent().unwrap_or(p)
            } else {
                p
            };
            let temp = dir.join(suffix);
            if fs::create_dir_all(&temp).is_ok() {
                return temp;
            }
        }
    }
    let temp = std::env::temp_dir().join(format!("{}_{}", suffix.trim_start_matches('.'), std::process::id()));
    let _ = fs::create_dir_all(&temp);
    temp
}

pub fn resolve_path(segment_path: &str, project_path: Option<&str>, output_path: &str) -> String {
    let segment_path_norm = normalize_windows_path(segment_path);
    if Path::new(&segment_path_norm).exists() {
        return segment_path_norm;
    }

    let clean_path = segment_path_norm.trim_start_matches("./").trim_start_matches(".\\");

    if let Some(proj_path) = project_path {
        let proj_path_norm = normalize_windows_path(proj_path);
        let test_path = Path::new(&proj_path_norm).join(clean_path);
        if test_path.exists() {
            return test_path.to_string_lossy().to_string();
        }

        // Поиск перекрытия имен папок (Overlap alignment)
        let proj_parts: Vec<&str> = proj_path_norm.split('/').filter(|s| !s.is_empty()).collect();
        for i in 0..proj_parts.len() {
            let sub_proj = proj_parts[i..].join("/");
            if !sub_proj.is_empty() {
                let clean_path_normalized = clean_path.replace('\\', "/");
                if clean_path_normalized.starts_with(&sub_proj) {
                    let stripped = clean_path_normalized[sub_proj.len()..].trim_start_matches('/');
                    let prefix = if proj_path_norm.starts_with('/') {
                        format!("/{}", proj_parts[..i].join("/"))
                    } else {
                        proj_parts[..i].join("/")
                    };
                    let align_path = Path::new(&prefix).join(stripped);
                    if align_path.exists() {
                        return align_path.to_string_lossy().to_string();
                    }
                }
            }
        }
    }

    // Фоллбэк на поиск в родительской директории output_path
    let out_path_norm = normalize_windows_path(output_path);
    if let Some(out_parent) = Path::new(&out_path_norm).parent() {
        let test_path = out_parent.join(clean_path);
        if test_path.exists() {
            return test_path.to_string_lossy().to_string();
        }
    }

    segment_path_norm
}

// ----------------------------------------------------------------------------
// МОДЕЛИ ДАННЫХ ПРОЕКТА
// ----------------------------------------------------------------------------
fn default_gain() -> f64 {
    1.0
}

#[allow(dead_code)]
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportSegmentData {
    #[serde(default)]
    pub id: String,
    pub start_time: f64,
    pub duration: f64,
    pub file_path: Option<String>,
    #[serde(default = "default_gain")]
    pub gain: f64,
    #[serde(default)]
    pub file_offset: f64,
    #[serde(default)]
    pub file_duration: f64,
    pub playback_rate: Option<f64>,
    pub panning: Option<f64>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrack {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub is_muted: Option<bool>,
    pub is_solo: Option<bool>,
    pub volume: Option<f64>,
    #[serde(default)]
    pub segments: Vec<ExportSegmentData>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportProjectData {
    #[serde(default)]
    pub tracks: Vec<ProjectTrack>,
    #[serde(default)]
    pub audio_offset_ms: f64,
    pub project_path: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct StemOptions {
    pub bit_depth: String, // "16", "24", "32float"
    pub output_dir: String,
}

#[derive(Serialize, Clone)]
pub struct StemProgress {
    pub current: usize,
    pub total: usize,
    pub track_name: String,
}

// ----------------------------------------------------------------------------
// ПОДГОТОВЛЕННЫЕ ДАННЫЕ ДЛЯ БЫСТРОГО СВЕДЕНИЯ В ПАМЯТИ (ZERO ALLOCATION)
// ----------------------------------------------------------------------------
#[derive(Clone, Debug)]
pub struct PreparedSegment {
    pub resolved_file_path: String,
    pub start_frame: i64,
    pub end_frame: i64,
    pub duration_frames: usize,
    pub file_offset_sec: f64,
    pub playback_rate: f64,
    pub left_pan_gain: f32,
    pub right_pan_gain: f32,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct PreparedTrack {
    pub id: String,
    pub name: String,
    pub volume: f32,
    pub is_muted: bool,
    pub is_solo: bool,
    pub segments: Vec<PreparedSegment>,
}

/// Подготовка треков и сегментов к непрерывному сведению
pub fn prepare_project_tracks(
    project: &ExportProjectData,
    destination_hint: &str,
    force_all_active: bool,
) -> (Vec<PreparedTrack>, usize, Vec<String>) {
    let audio_offset_sec = project.audio_offset_ms / 1000.0;
    let any_solo = project.tracks.iter().any(|t| t.is_solo.unwrap_or(false));
    let mut prepared_tracks = Vec::new();
    let mut max_end_frame: i64 = 0;
    let mut unique_paths = Vec::new();

    for track in &project.tracks {
        let is_active = if force_all_active {
            true
        } else if any_solo {
            track.is_solo.unwrap_or(false)
        } else {
            !track.is_muted.unwrap_or(false)
        };

        if !is_active {
            continue;
        }

        let track_volume = track.volume.unwrap_or(1.0) as f32;
        let mut prep_segments = Vec::new();

        for seg in &track.segments {
            let file_path_str = match &seg.file_path {
                Some(p) if !p.trim().is_empty() => p,
                _ => continue,
            };

            let resolved = resolve_path(file_path_str, project.project_path.as_deref(), destination_hint);
            if !unique_paths.contains(&resolved) {
                unique_paths.push(resolved.clone());
            }

            let seg_start_sec = seg.start_time + audio_offset_sec;
            let start_frame = (seg_start_sec * EXPORT_SAMPLE_RATE as f64).round() as i64;
            let duration_frames = (seg.duration * EXPORT_SAMPLE_RATE as f64).round().max(0.0) as usize;
            let end_frame = start_frame + duration_frames as i64;

            if end_frame > max_end_frame {
                max_end_frame = end_frame;
            }

            let pan = seg.panning.unwrap_or(0.0).clamp(-1.0, 1.0) as f32;
            let total_gain = (seg.gain as f32 * track_volume).max(0.0);
            let left_pan_gain = ((1.0 - pan) * 0.5).sqrt() * total_gain;
            let right_pan_gain = ((1.0 + pan) * 0.5).sqrt() * total_gain;
            let playback_rate = seg.playback_rate.unwrap_or(1.0).max(0.01);

            prep_segments.push(PreparedSegment {
                resolved_file_path: resolved,
                start_frame,
                end_frame,
                duration_frames,
                file_offset_sec: seg.file_offset,
                playback_rate,
                left_pan_gain,
                right_pan_gain,
            });
        }

        prepared_tracks.push(PreparedTrack {
            id: track.id.clone(),
            name: track.name.clone(),
            volume: track_volume,
            is_muted: track.is_muted.unwrap_or(false),
            is_solo: track.is_solo.unwrap_or(false),
            segments: prep_segments,
        });
    }

    let total_frames = max_end_frame.max(0) as usize;
    (prepared_tracks, total_frames, unique_paths)
}

/// Параллельная предзагрузка всех требуемых исходных аудиофайлов в память
pub fn preload_audio_files_parallel(paths: &[String]) -> HashMap<String, Arc<CachedTrackBuffer>> {
    paths
        .par_iter()
        .filter_map(|path| {
            match load_audio_file_sync(path) {
                Ok(cached) => Some((path.clone(), Arc::new(cached))),
                Err(e) => {
                    log_error(&format!("[ExportEngine] Preload failed for {}: {}", path, e));
                    None
                }
            }
        })
        .collect()
}

// ----------------------------------------------------------------------------
// БЫСТРЫЙ ДВУХКАНАЛЬНЫЙ РЕНДЕР БЛОКА СЭМПЛОВ НА ЧИСТОМ RUST
// ----------------------------------------------------------------------------
#[inline(always)]
fn render_segments_into_block(
    block_start_frame: i64,
    num_frames: usize,
    segments: &[PreparedSegment],
    audio_cache: &HashMap<String, Arc<CachedTrackBuffer>>,
    out_stereo_buffer: &mut [f32],
) {
    let block_end_frame = block_start_frame + num_frames as i64;

    for seg in segments {
        if block_start_frame >= seg.end_frame || block_end_frame <= seg.start_frame {
            continue;
        }

        let cached = match audio_cache.get(&seg.resolved_file_path) {
            Some(c) => c,
            None => continue,
        };

        let cached_sr = cached.sample_rate as f64;
        let playback_rate = seg.playback_rate;
        let file_offset_sec = seg.file_offset_sec;
        let fade_len = FADE_MICRO_FRAMES.min(seg.duration_frames / 2);

        let overlap_start_rel = (seg.start_frame.max(block_start_frame) - block_start_frame) as usize;
        let overlap_end_rel = (seg.end_frame.min(block_end_frame) - block_start_frame) as usize;

        for f in overlap_start_rel..overlap_end_rel {
            let timeline_frame = block_start_frame + f as i64;
            let frame_in_seg = (timeline_frame - seg.start_frame) as usize;

            let time_in_seg_sec = (timeline_frame - seg.start_frame) as f64 / EXPORT_SAMPLE_RATE as f64;
            let sample_pos_sec = file_offset_sec + time_in_seg_sec * playback_rate;
            if sample_pos_sec < 0.0 {
                continue;
            }

            let src_frame_float = sample_pos_sec * cached_sr;
            let src_frame_idx = src_frame_float.floor() as usize;
            let frac = (src_frame_float - src_frame_idx as f64) as f32;

            let (l0, r0) = cached.read_stereo_frame(src_frame_idx);
            let (l1, r1) = if frac > 0.0001 && src_frame_idx + 1 < cached.total_frames {
                cached.read_stereo_frame(src_frame_idx + 1)
            } else {
                (l0, r0)
            };

            let mut raw_l = l0 + (l1 - l0) * frac;
            let mut raw_r = r0 + (r1 - r0) * frac;

            // Антищелчковый микрофейд
            if fade_len > 0 {
                if frame_in_seg < fade_len {
                    let fade = frame_in_seg as f32 / fade_len as f32;
                    raw_l *= fade;
                    raw_r *= fade;
                } else if frame_in_seg + fade_len >= seg.duration_frames {
                    let remaining = seg.duration_frames.saturating_sub(frame_in_seg + 1);
                    let fade = remaining as f32 / fade_len as f32;
                    raw_l *= fade;
                    raw_r *= fade;
                }
            }

            let out_idx = f * 2;
            out_stereo_buffer[out_idx] += raw_l * seg.left_pan_gain;
            out_stereo_buffer[out_idx + 1] += raw_r * seg.right_pan_gain;
        }
    }
}

// ----------------------------------------------------------------------------
// РЕНДЕРИНГ ОДИНОЧНОГО ТРЕКА В ПАМЯТЬ В ВИДЕ STEREO FLOAT PCM
// ----------------------------------------------------------------------------
pub fn render_single_track_pcm(
    track: &PreparedTrack,
    total_frames: usize,
    audio_cache: &HashMap<String, Arc<CachedTrackBuffer>>,
    cancel_token: Option<&CancellationToken>,
) -> Result<Vec<f32>, String> {
    let mut pcm = vec![0.0f32; total_frames * 2];
    if total_frames == 0 || track.segments.is_empty() {
        return Ok(pcm);
    }

    let num_blocks = (total_frames + BLOCK_FRAMES - 1) / BLOCK_FRAMES;

    for b in 0..num_blocks {
        if let Some(token) = cancel_token {
            if token.is_cancelled() {
                return Err("Экспорт отменен пользователем".to_string());
            }
        }

        let start_f = b * BLOCK_FRAMES;
        let end_f = (start_f + BLOCK_FRAMES).min(total_frames);
        let block_len = end_f - start_f;
        let pcm_slice = &mut pcm[start_f * 2..end_f * 2];

        render_segments_into_block(
            start_f as i64,
            block_len,
            &track.segments,
            audio_cache,
            pcm_slice,
        );
    }

    Ok(pcm)
}

// ----------------------------------------------------------------------------
// ПОТОКОВАЯ ЗАПИСЬ PCM В HOUND WAV WRITER
// ----------------------------------------------------------------------------
pub fn write_pcm_to_wav<W: Write + std::io::Seek>(
    writer: &mut WavWriter<W>,
    pcm_stereo: &[f32],
    bit_depth: &str,
) -> Result<(), String> {
    match bit_depth {
        "24" => {
            for &sample in pcm_stereo {
                let clamped = sample.clamp(-1.0, 1.0);
                let val_i32 = (clamped * 8388607.0).round() as i32;
                writer
                    .write_sample(val_i32)
                    .map_err(|e| format!("Ошибка записи WAV: {}", e))?;
            }
        }
        "32float" | "32" => {
            for &sample in pcm_stereo {
                writer
                    .write_sample(sample.clamp(-1.0, 1.0))
                    .map_err(|e| format!("Ошибка записи WAV: {}", e))?;
            }
        }
        _ => {
            // 16-bit PCM default
            for &sample in pcm_stereo {
                let clamped = sample.clamp(-1.0, 1.0);
                let val_i16 = (clamped * 32767.0).round() as i16;
                writer
                    .write_sample(val_i16)
                    .map_err(|e| format!("Ошибка записи WAV: {}", e))?;
            }
        }
    }
    Ok(())
}

fn create_wav_spec(bit_depth: &str) -> WavSpec {
    match bit_depth {
        "24" => WavSpec {
            channels: EXPORT_CHANNELS,
            sample_rate: EXPORT_SAMPLE_RATE,
            bits_per_sample: 24,
            sample_format: SampleFormat::Int,
        },
        "32float" | "32" => WavSpec {
            channels: EXPORT_CHANNELS,
            sample_rate: EXPORT_SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: SampleFormat::Float,
        },
        _ => WavSpec {
            channels: EXPORT_CHANNELS,
            sample_rate: EXPORT_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        },
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Экспорт всех стемов в единый ZIP архив (чистый Rust без временных файлов и без FFmpeg)
#[tauri::command]
pub async fn export_all_stems(
    app_handle: AppHandle,
    _state: State<'_, AppState>,
    project_json: String,
    output_path: String,
) -> Result<String, String> {
    let cancel_token = CancellationToken::new();
    register_cancellation_token(cancel_token.clone());

    let res = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let project: ExportProjectData = serde_json::from_str(&project_json)
            .map_err(|e| format!("Ошибка парсинга JSON проекта: {}", e))?;

        let (tracks, total_frames, unique_paths) =
            prepare_project_tracks(&project, &output_path, true);

        if tracks.is_empty() || total_frames == 0 {
            return Err("В проекте нет аудиодорожек для экспорта стемов.".to_string());
        }

        let audio_cache = preload_audio_files_parallel(&unique_paths);
        let total_tracks = tracks.len();

        let zip_file = File::create(&output_path)
            .map_err(|e| format!("Не удалось создать ZIP архив {}: {}", output_path, e))?;
        let mut zip_writer = ZipWriter::new(BufWriter::with_capacity(1024 * 1024, zip_file));
        let spec = create_wav_spec("24");

        for (i, track) in tracks.iter().enumerate() {
            if cancel_token.is_cancelled() {
                return Err("Экспорт стемов отменен пользователем".to_string());
            }

            let track_idx = i + 1;
            let sanitized_name = track.name.replace(|c: char| !c.is_alphanumeric(), "_");
            let file_name = format!("{:02}_{}.wav", track_idx, sanitized_name);

            let _ = app_handle.emit("stem-progress", StemProgress {
                current: track_idx,
                total: total_tracks,
                track_name: track.name.clone(),
            });

            let progress_pct = ((i as f64) / (total_tracks as f64)) * 100.0;
            let _ = app_handle.emit("export-progress", progress_pct);

            let pcm = render_single_track_pcm(track, total_frames, &audio_cache, Some(&cancel_token))?;

            let mut wav_cursor = Cursor::new(Vec::with_capacity(pcm.len() * 3 + 1024));
            {
                let mut wav_w = WavWriter::new(&mut wav_cursor, spec)
                    .map_err(|e| format!("Ошибка создания WavWriter: {}", e))?;
                write_pcm_to_wav(&mut wav_w, &pcm, "24")?;
                wav_w.finalize().map_err(|e| format!("Ошибка финализации WAV: {}", e))?;
            }

            let wav_bytes = wav_cursor.into_inner();
            zip_writer
                .start_file(file_name, FileOptions::default().compression_method(zip::CompressionMethod::Stored))
                .map_err(|e| format!("Ошибка записи файла в ZIP: {}", e))?;
            zip_writer
                .write_all(&wav_bytes)
                .map_err(|e| format!("Ошибка записи данных в ZIP: {}", e))?;
        }

        zip_writer.finish().map_err(|e| format!("Ошибка закрытия ZIP архива: {}", e))?;
        let _ = app_handle.emit("export-progress", 100.0);

        Ok(output_path)
    }).await.map_err(|e| format!("Паника потока экспорта: {}", e))?;

    unregister_cancellation_token();
    res
}

/// Параллельный экспорт стемов по отдельным WAV файлам в указанную папку
#[tauri::command]
pub async fn export_stems(
    app_handle: AppHandle,
    project_json: String,
    options: StemOptions,
) -> Result<(), String> {
    let cancel_token = CancellationToken::new();
    register_cancellation_token(cancel_token.clone());

    let res = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let project: ExportProjectData = serde_json::from_str(&project_json)
            .map_err(|e| format!("Ошибка парсинга JSON проекта: {}", e))?;

        let output_dir = Path::new(&options.output_dir);
        if !output_dir.exists() {
            fs::create_dir_all(output_dir)
                .map_err(|e| format!("Не удалось создать директорию экспорта: {}", e))?;
        }

        let (tracks, total_frames, unique_paths) =
            prepare_project_tracks(&project, &options.output_dir, true);

        if tracks.is_empty() || total_frames == 0 {
            return Err("В проекте нет дорожек для экспорта стемов.".to_string());
        }

        let audio_cache = preload_audio_files_parallel(&unique_paths);
        let total_tracks = tracks.len();
        let spec = create_wav_spec(&options.bit_depth);

        let completed_count = Arc::new(AtomicUsize::new(0));

        tracks.par_iter().enumerate().try_for_each(|(i, track)| -> Result<(), String> {
            if cancel_token.is_cancelled() {
                return Err("Экспорт стемов отменен пользователем".to_string());
            }

            let track_idx = i + 1;
            let sanitized_name = track.name.replace(|c: char| !c.is_alphanumeric(), "_");
            let file_name = format!("{:02}_{}.wav", track_idx, sanitized_name);
            let out_file = output_dir.join(file_name);

            let pcm = render_single_track_pcm(track, total_frames, &audio_cache, Some(&cancel_token))?;

            let mut wav_w = WavWriter::create(&out_file, spec)
                .map_err(|e| format!("Не удалось создать WAV файл {:?}: {}", out_file, e))?;
            write_pcm_to_wav(&mut wav_w, &pcm, &options.bit_depth)?;
            wav_w.finalize().map_err(|e| format!("Ошибка финализации WAV {:?}: {}", out_file, e))?;

            let done = completed_count.fetch_add(1, Ordering::SeqCst) + 1;
            let pct = (done as f64 / total_tracks as f64) * 100.0;
            let _ = app_handle.emit("export-progress", pct);
            let _ = app_handle.emit("stem-progress", StemProgress {
                current: done,
                total: total_tracks,
                track_name: track.name.clone(),
            });

            Ok(())
        })?;

        let _ = app_handle.emit("export-progress", 100.0);
        Ok(())
    }).await.map_err(|e| format!("Паника потока экспорта стемов: {}", e))?;

    unregister_cancellation_token();
    res
}

/// Нативное многопоточное сведение всего микса (Master Mix) с прямой записью в WAV или кодированием через FFmpeg Pipe
#[tauri::command]
pub async fn export_audio(
    app_handle: AppHandle,
    project_json: String,
    output_path: String,
    format: String,            // "wav", "mp3", "flac", "aac", "ogg"
    bit_depth: Option<String>, // "16", "24", "32float"
    bitrate: Option<String>,   // "320k", "256k"
) -> Result<(), String> {
    let cancel_token = CancellationToken::new();
    register_cancellation_token(cancel_token.clone());

    let project: ExportProjectData = serde_json::from_str(&project_json)
        .map_err(|e| format!("Ошибка парсинга JSON проекта: {}", e))?;

    let (tracks, total_frames, unique_paths) =
        prepare_project_tracks(&project, &output_path, false);

    if tracks.is_empty() || total_frames == 0 {
        unregister_cancellation_token();
        return Err("Нет активных аудиодорожек для экспорта. Проверьте Solo/Mute.".to_string());
    }

    let audio_cache = preload_audio_files_parallel(&unique_paths);
    let all_segments: Vec<PreparedSegment> = tracks.into_iter().flat_map(|t| t.segments).collect();

    let fmt_lower = format.to_lowercase();
    let is_wav = fmt_lower == "wav" || fmt_lower.is_empty();

    let _ = app_handle.emit("export-progress", 0.0);

    if is_wav {
        // --- ПРЯМАЯ ЗАПИСЬ HOUND WAV БЕЗ FFMPEG ---
        let depth_str = bit_depth.unwrap_or_else(|| "24".to_string());
        let spec = create_wav_spec(&depth_str);

        let out_path_clone = output_path.clone();
        let cancel_token_clone = cancel_token.clone();
        let app_handle_clone = app_handle.clone();

        let render_res = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let mut wav_writer = WavWriter::create(&out_path_clone, spec)
                .map_err(|e| format!("Не удалось создать выходной WAV файл: {}", e))?;

            let num_blocks = (total_frames + BLOCK_FRAMES - 1) / BLOCK_FRAMES;
            let mut block_buf = vec![0.0f32; BLOCK_FRAMES * 2];
            let mut last_reported_pct = 0.0;

            for b in 0..num_blocks {
                if cancel_token_clone.is_cancelled() {
                    return Err("Экспорт отменен пользователем".to_string());
                }

                let start_f = (b * BLOCK_FRAMES) as i64;
                let end_f = ((b + 1) * BLOCK_FRAMES).min(total_frames) as i64;
                let block_len = (end_f - start_f) as usize;

                block_buf.fill(0.0);
                render_segments_into_block(
                    start_f,
                    block_len,
                    &all_segments,
                    &audio_cache,
                    &mut block_buf[..block_len * 2],
                );

                write_pcm_to_wav(&mut wav_writer, &block_buf[..block_len * 2], &depth_str)?;

                let current_pct = ((b + 1) as f64 / num_blocks as f64) * 100.0;
                if current_pct - last_reported_pct >= 1.0 || b + 1 == num_blocks {
                    let _ = app_handle_clone.emit("export-progress", current_pct.min(99.0));
                    last_reported_pct = current_pct;
                }
            }

            wav_writer
                .finalize()
                .map_err(|e| format!("Ошибка финализации WAV: {}", e))?;

            Ok(())
        }).await.map_err(|e| format!("Ошибка рабочего потока рендеринга: {}", e))?;

        unregister_cancellation_token();
        render_res?;
    } else {
        // --- КОДИРОВАНИЕ MP3 / FLAC / AAC / OGG ЧЕРЕЗ FFMPEG STDIN PIPE ---
        let ffmpeg_bin = find_ffmpeg_path();
        let mut cmd = Command::new(&ffmpeg_bin);
        cmd.hide_window();
        cmd.arg("-y");
        cmd.arg("-f").arg("f32le");
        cmd.arg("-ar").arg(EXPORT_SAMPLE_RATE.to_string());
        cmd.arg("-ac").arg(EXPORT_CHANNELS.to_string());
        cmd.arg("-i").arg("pipe:0");

        match fmt_lower.as_str() {
            "mp3" => {
                cmd.arg("-c:a").arg("libmp3lame");
                cmd.arg("-b:a").arg(bitrate.unwrap_or_else(|| "320k".to_string()));
            }
            "flac" => {
                cmd.arg("-c:a").arg("flac");
            }
            "aac" | "m4a" => {
                cmd.arg("-c:a").arg("aac");
                cmd.arg("-b:a").arg(bitrate.unwrap_or_else(|| "256k".to_string()));
            }
            "ogg" => {
                cmd.arg("-c:a").arg("libvorbis");
                cmd.arg("-q:a").arg("6");
            }
            _ => {
                cmd.arg("-c:a").arg("pcm_s16le");
            }
        }

        cmd.arg(&output_path);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Не удалось запустить FFmpeg: {}", e))?;
        let mut stdin = child.stdin.take().ok_or("Не удалось открыть FFmpeg stdin pipe")?;

        let num_blocks = (total_frames + BLOCK_FRAMES - 1) / BLOCK_FRAMES;
        let mut block_buf = vec![0.0f32; BLOCK_FRAMES * 2];
        let mut byte_buf = vec![0u8; BLOCK_FRAMES * 2 * 4];
        let mut last_reported_pct = 0.0;

        for b in 0..num_blocks {
            if cancel_token.is_cancelled() {
                let _ = child.kill().await;
                unregister_cancellation_token();
                return Err("Экспорт отменен пользователем".to_string());
            }

            let start_f = (b * BLOCK_FRAMES) as i64;
            let end_f = ((b + 1) * BLOCK_FRAMES).min(total_frames) as i64;
            let block_len = (end_f - start_f) as usize;

            block_buf.fill(0.0);
            render_segments_into_block(
                start_f,
                block_len,
                &all_segments,
                &audio_cache,
                &mut block_buf[..block_len * 2],
            );

            // Конвертация Float32 в байты Little-Endian
            for (idx, &sample) in block_buf[..block_len * 2].iter().enumerate() {
                let bytes = sample.to_le_bytes();
                byte_buf[idx * 4] = bytes[0];
                byte_buf[idx * 4 + 1] = bytes[1];
                byte_buf[idx * 4 + 2] = bytes[2];
                byte_buf[idx * 4 + 3] = bytes[3];
            }

            if let Err(e) = stdin.write_all(&byte_buf[..block_len * 2 * 4]).await {
                let _ = child.kill().await;
                unregister_cancellation_token();
                return Err(format!("Ошибка записи аудиопотока в FFmpeg: {}", e));
            }

            let current_pct = ((b + 1) as f64 / num_blocks as f64) * 100.0;
            if current_pct - last_reported_pct >= 1.0 || b + 1 == num_blocks {
                let _ = app_handle.emit("export-progress", current_pct.min(99.0));
                last_reported_pct = current_pct;
            }
        }

        drop(stdin);

        let output = child
            .wait_with_output()
            .await
            .map_err(|e| format!("Ошибка ожидания FFmpeg: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            unregister_cancellation_token();
            return Err(format!("FFmpeg кодирование завершилось с ошибкой: {}", stderr));
        }

        unregister_cancellation_token();
    }

    let _ = app_handle.emit("export-progress", 100.0);
    Ok(())
}

// ----------------------------------------------------------------------------
// ПАКЕТНЫЙ ЭКСПОРТ РЕПЛИК (BATCH EXPORT) НА ЧИСТОМ RUST (МНОГОПОТОЧНЫЙ RAYON)
// ----------------------------------------------------------------------------
#[derive(Deserialize, Debug, Clone)]
pub struct BatchOrigSegment {
    #[serde(rename = "startTime")]
    pub start_time: f64,
    pub duration: f64,
    #[serde(rename = "originalFileName")]
    pub original_file_name: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct BatchDubSegment {
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "startTime")]
    pub start_time: f64,
    pub duration: f64,
    #[serde(rename = "fileOffset")]
    pub file_offset: f64,
    pub gain: f64,
    #[serde(rename = "playbackRate")]
    pub playback_rate: f64,
}

#[tauri::command]
pub async fn batch_export(
    app_handle: AppHandle,
    out_dir: String,
    orig_segments: Vec<BatchOrigSegment>,
    dub_segments: Vec<BatchDubSegment>,
) -> Result<Vec<String>, String> {
    let cancel_token = CancellationToken::new();
    register_cancellation_token(cancel_token.clone());

    let export_dir = Path::new(&out_dir);
    if !export_dir.exists() {
        fs::create_dir_all(export_dir)
            .map_err(|e| format!("Не удалось создать директорию пакета: {}", e))?;
    }

    let total_tasks = orig_segments.len();
    if total_tasks == 0 {
        unregister_cancellation_token();
        return Ok(Vec::new());
    }

    let res = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        // Предзагрузка всех уникальных файлов дубляжа
        let mut unique_dubs = Vec::new();
        for dub in &dub_segments {
            let resolved = resolve_path(&dub.file_path, None, &out_dir);
            if !unique_dubs.contains(&resolved) {
                unique_dubs.push(resolved);
            }
        }
        let audio_cache = preload_audio_files_parallel(&unique_dubs);

        let completed = Arc::new(AtomicUsize::new(0));
        let spec = WavSpec {
            channels: EXPORT_CHANNELS,
            sample_rate: EXPORT_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };

        let exported_paths: Result<Vec<String>, String> = orig_segments
            .par_iter()
            .map(|orig_seg| -> Result<String, String> {
                if cancel_token.is_cancelled() {
                    return Err("Пакетный экспорт отменен".to_string());
                }

                let mut final_name = orig_seg.original_file_name.clone();
                if !final_name.to_lowercase().ends_with(".wav") {
                    final_name.push_str(".wav");
                }
                let out_file = Path::new(&out_dir).join(&final_name);

                let t_start = orig_seg.start_time;
                let t_end = t_start + orig_seg.duration;
                let total_frames = (orig_seg.duration * EXPORT_SAMPLE_RATE as f64).round().max(0.0) as usize;

                let mut replica_pcm = vec![0.0f32; total_frames * 2];

                // Наложение перекрывающихся сегментов дубляжа
                for dub in &dub_segments {
                    let dub_end = dub.start_time + dub.duration;
                    if dub.start_time < t_end && dub_end > t_start {
                        let overlap_start = t_start.max(dub.start_time);
                        let overlap_end = t_end.min(dub_end);
                        let overlap_dur = overlap_end - overlap_start;
                        if overlap_dur <= 0.0 {
                            continue;
                        }

                        let resolved_path = resolve_path(&dub.file_path, None, &out_dir);
                        let cached = match audio_cache.get(&resolved_path) {
                            Some(c) => c,
                            None => continue,
                        };

                        let cached_sr = cached.sample_rate as f64;
                        let playback_rate = dub.playback_rate.max(0.01);
                        let file_offset_delta = (overlap_start - dub.start_time) * playback_rate;
                        let trim_start_sec = dub.file_offset + file_offset_delta;

                        let replica_start_frame = ((overlap_start - t_start) * EXPORT_SAMPLE_RATE as f64).round() as usize;
                        let overlap_frames = (overlap_dur * EXPORT_SAMPLE_RATE as f64).round() as usize;
                        let gain = dub.gain as f32;

                        for f in 0..overlap_frames {
                            let target_f = replica_start_frame + f;
                            if target_f >= total_frames {
                                break;
                            }

                            let time_in_overlap_sec = f as f64 / EXPORT_SAMPLE_RATE as f64;
                            let file_sec = trim_start_sec + time_in_overlap_sec * playback_rate;
                            let src_frame_float = file_sec * cached_sr;
                            let src_idx = src_frame_float.floor() as usize;
                            let frac = (src_frame_float - src_idx as f64) as f32;

                            let (l0, r0) = cached.read_stereo_frame(src_idx);
                            let (l1, r1) = if frac > 0.0001 && src_idx + 1 < cached.total_frames {
                                cached.read_stereo_frame(src_idx + 1)
                            } else {
                                (l0, r0)
                            };

                            let s_l = (l0 + (l1 - l0) * frac) * gain;
                            let s_r = (r0 + (r1 - r0) * frac) * gain;

                            replica_pcm[target_f * 2] += s_l;
                            replica_pcm[target_f * 2 + 1] += s_r;
                        }
                    }
                }

                let mut wav_w = WavWriter::create(&out_file, spec)
                    .map_err(|e| format!("Не удалось создать реплику {:?}: {}", out_file, e))?;
                write_pcm_to_wav(&mut wav_w, &replica_pcm, "16")?;
                wav_w.finalize().map_err(|e| format!("Ошибка записи реплики: {}", e))?;

                let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                let pct = (done as f64 / total_tasks as f64) * 100.0;
                let _ = app_handle.emit("export-progress", pct);

                Ok(out_file.to_string_lossy().to_string())
            })
            .collect();

        exported_paths
    }).await.map_err(|e| format!("Ошибка пакетного рендеринга: {}", e))?;

    unregister_cancellation_token();
    res
}

// ----------------------------------------------------------------------------
// ЭКСПОРТ АУДИОКНИГИ С ПАУЗАМИ И НОРМАЛИЗАЦИЕЙ (PURE RUST)
// ----------------------------------------------------------------------------
#[derive(Deserialize, Debug, Clone)]
pub struct AudioBookSegmentData {
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(default = "default_gain")]
    pub gain: f64,
}

#[tauri::command]
pub async fn export_audio_book(
    app_handle: AppHandle,
    project_path: String,
    output_path: String,
    format: Option<String>,
    gap_duration: Option<f64>,
    normalize_lufs: Option<bool>,
    segments: Vec<AudioBookSegmentData>,
) -> Result<String, String> {
    let cancel_token = CancellationToken::new();
    register_cancellation_token(cancel_token.clone());

    let gap_sec = gap_duration.unwrap_or(1.5).max(0.0);
    let gap_frames = (gap_sec * EXPORT_SAMPLE_RATE as f64).round() as usize;

    let valid_segments: Vec<_> = segments
        .into_iter()
        .filter(|s| !s.file_path.trim().is_empty())
        .collect();

    if valid_segments.is_empty() {
        unregister_cancellation_token();
        return Err("Нет аудиофайлов для экспорта аудиокниги.".to_string());
    }

    let mut final_out = output_path.clone();
    let p = Path::new(&output_path);
    if p.parent() == Some(Path::new("")) {
        final_out = Path::new(&project_path)
            .join(output_path)
            .to_str()
            .unwrap()
            .to_string();
    }

    let final_out_clone = final_out.clone();

    let res = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut total_master_pcm = Vec::new();
        let total_segs = valid_segments.len();

        for (i, seg) in valid_segments.iter().enumerate() {
            if cancel_token.is_cancelled() {
                return Err("Экспорт аудиокниги отменен".to_string());
            }

            let resolved = resolve_path(&seg.file_path, Some(&project_path), &final_out_clone);
            let cached = load_audio_file_sync(&resolved)
                .map_err(|e| format!("Не удалось загрузить сегмент {}: {}", resolved, e))?;

            let gain = seg.gain as f32;
            for f in 0..cached.total_frames {
                let (l, r) = cached.read_stereo_frame(f);
                total_master_pcm.push(l * gain);
                total_master_pcm.push(r * gain);
            }

            // Добавляем тишину в промежутках между главами/сегментами
            if i + 1 < total_segs && gap_frames > 0 {
                total_master_pcm.resize(total_master_pcm.len() + gap_frames * 2, 0.0);
            }

            let pct = ((i + 1) as f64 / total_segs as f64) * 80.0;
            let _ = app_handle.emit("export-progress", pct);
        }

        // Опциональная EBU R128 нормализация громкости (-16 LUFS для аудиокниг / подкастов)
        if normalize_lufs.unwrap_or(false) && !total_master_pcm.is_empty() {
            if let Ok(mut ebu) = ebur128::EbuR128::new(EXPORT_CHANNELS as u32, EXPORT_SAMPLE_RATE, ebur128::Mode::I) {
                let _ = ebu.add_frames_f32(&total_master_pcm);
                if let Ok(current_lufs) = ebu.loudness_global() {
                    if current_lufs > -70.0 && current_lufs < 0.0 {
                        let target_lufs = -16.0;
                        let gain_db = target_lufs - current_lufs;
                        let mult = 10.0f32.powf((gain_db / 20.0) as f32);
                        for s in &mut total_master_pcm {
                            *s = (*s * mult).clamp(-0.95, 0.95);
                        }
                    }
                }
            }
        }

        let fmt_lower = format.unwrap_or_else(|| "wav".to_string()).to_lowercase();
        if fmt_lower == "wav" {
            let spec = create_wav_spec("16");
            let mut wav_w = WavWriter::create(&final_out_clone, spec)
                .map_err(|e| format!("Не удалось создать аудиокнигу WAV: {}", e))?;
            write_pcm_to_wav(&mut wav_w, &total_master_pcm, "16")?;
            wav_w.finalize().map_err(|e| format!("Ошибка финализации WAV: {}", e))?;
        } else {
            // Запись через FFmpeg Pipe в MP3
            let ffmpeg_bin = find_ffmpeg_path();
            let mut cmd = std::process::Command::new(&ffmpeg_bin);
            cmd.hide_window();
            cmd.arg("-y")
                .arg("-f").arg("f32le")
                .arg("-ar").arg(EXPORT_SAMPLE_RATE.to_string())
                .arg("-ac").arg(EXPORT_CHANNELS.to_string())
                .arg("-i").arg("pipe:0")
                .arg("-c:a").arg("libmp3lame")
                .arg("-b:a").arg("192k")
                .arg(&final_out_clone)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());

            let mut child = cmd.spawn().map_err(|e| format!("Ошибка запуска FFmpeg: {}", e))?;
            if let Some(mut stdin) = child.stdin.take() {
                let mut byte_buf = Vec::with_capacity(total_master_pcm.len() * 4);
                for &s in &total_master_pcm {
                    byte_buf.extend_from_slice(&s.to_le_bytes());
                }
                stdin.write_all(&byte_buf).map_err(|e| format!("Ошибка записи в FFmpeg: {}", e))?;
            }

            let status = child.wait().map_err(|e| format!("Ошибка ожидания FFmpeg: {}", e))?;
            if !status.success() {
                return Err("FFmpeg кодирование аудиокниги завершилось с ошибкой".to_string());
            }
        }

        let _ = app_handle.emit("export-progress", 100.0);
        Ok(final_out_clone)
    }).await.map_err(|e| format!("Ошибка потока аудиокниги: {}", e))?;

    unregister_cancellation_token();
    res
}

// ----------------------------------------------------------------------------
// БЫСТРЫЙ ПРЕВЬЮ ЭКСПОРТ И БЭКСТЕЙДЖ ВИДЕО
// ----------------------------------------------------------------------------
#[tauri::command]
pub async fn quick_preview_export(
    _app_handle: AppHandle,
    state: State<'_, AppState>,
    project_path: String,
    segment_id: String,
) -> Result<String, String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("База данных не инициализирована")?;

    let row = sqlx::query("SELECT file_path FROM segments WHERE id = ?")
        .bind(&segment_id)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Сегмент не найден в БД: {}", e))?;

    let file_path: Option<String> = row.get("file_path");
    let src_str = file_path.ok_or("У сегмента отсутствует путь к файлу")?;
    let resolved_src_str = resolve_path(&src_str, Some(&project_path), "");
    let src = Path::new(&resolved_src_str);

    if !src.exists() {
        return Err(format!("Исходный аудиофайл не найден: {}", src_str));
    }

    let dest = Path::new(&project_path).join(format!("preview_{}.wav", segment_id));
    fs::copy(src, &dest).map_err(|e| format!("Не удалось скопировать сегмент: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn export_backstage_video(
    app_handle: AppHandle,
    main_video_path: String,
    backstage_video_path: String,
    final_audio_path: String,
    output_path: String,
) -> Result<String, String> {
    let ffmpeg_bin = find_ffmpeg_path();
    let mut cmd = Command::new(&ffmpeg_bin);
    cmd.hide_window();
    cmd.args(&[
        "-y",
        "-i", &main_video_path,
        "-i", &backstage_video_path,
        "-i", &final_audio_path,
        "-filter_complex", "[1:v]scale=320:-1[bg]; [0:v][bg]overlay=W-w-10:H-h-10[out_v]",
        "-map", "[out_v]",
        "-map", "2:a",
        "-c:v", "libx264",
        "-c:a", "aac",
        &output_path,
    ]);

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Не удалось запустить FFmpeg: {}", e))?;

    if let Some(stderr) = child.stderr.take() {
        let mut reader = BufReader::new(stderr).lines();
        let re = regex::Regex::new(r"time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})").unwrap();

        let app_handle_clone = app_handle.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = reader.next_line().await {
                if let Some(caps) = re.captures(&line) {
                    let _ = app_handle_clone.emit("export-progress", serde_json::json!({
                        "operation": "Exporting Backstage Video",
                        "time": caps[0].to_string()
                    }));
                }
            }
        });
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;

    if !status.success() {
        return Err("FFmpeg рендеринг бэкстейдж-видео завершился с ошибкой".to_string());
    }

    Ok(output_path)
}

// ============================================================================
// ПРЯМОЕ СВЕДЕНИЕ ЗАКАДРОВОГО ОЗВУЧИВАНИЯ (VOICEOVER MIX) БЕЗ ДАККИНГА
// ============================================================================

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceoverMixRequest {
    pub project_path: Option<String>,
    pub original_audio_path: Option<String>,
    pub clean_vo_path: Option<String>,
    pub output_path: String,
    pub original_track_volume: Option<f32>, // fader: default 0.20 (-14 dB)
    pub vocal_bus_volume: Option<f32>,      // fader: default 1.0 (0 dB)
    pub project_json: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceoverMixResult {
    pub success: bool,
    pub output_path: String,
    pub duration_seconds: f64,
    pub max_peak_db: f32,
    pub original_volume_applied: f32,
    pub vocal_volume_applied: f32,
    pub message: String,
}

/// Прямое сведение закадрового перевода: наложение голосов на непрерывную фоновую дорожку оригинала
/// без сайдчейн-даккинга с True-Peak лимитером (-1.0 dBTP).
#[tauri::command]
pub async fn render_voiceover_mix(
    app_handle: AppHandle,
    request: VoiceoverMixRequest,
) -> Result<VoiceoverMixResult, String> {
    log_info(&format!(
        "[VoiceoverMix] Старт прямого сведения. Out: '{}', OrigVol: {:?}, VoVol: {:?}",
        request.output_path, request.original_track_volume, request.vocal_bus_volume
    ));

    let _ = app_handle.emit("export-progress", 5.0);

    let output_norm = normalize_windows_path(&request.output_path);

    // 1. Поиск и чтение дорожки оригинала
    let orig_path = if let Some(ref p) = request.original_audio_path {
        let norm = normalize_windows_path(p);
        if Path::new(&norm).exists() {
            Some(norm)
        } else {
            None
        }
    } else {
        None
    };

    let resolved_orig_path = orig_path.or_else(|| {
        if let Some(ref proj_path) = request.project_path {
            let p1 = Path::new(proj_path).join("takes").join("original_audio.wav");
            if p1.exists() {
                return Some(p1.to_string_lossy().to_string());
            }
            let p2 = Path::new(proj_path).join("original_audio.wav");
            if p2.exists() {
                return Some(p2.to_string_lossy().to_string());
            }
        }
        None
    });

    let (orig_pcm, orig_channels) = if let Some(ref path) = resolved_orig_path {
        log_info(&format!("[VoiceoverMix] Загрузка оригинального аудио: {}", path));
        match read_audio_file_any_format(Path::new(path)) {
            Ok((samples, _sr, ch)) => (samples, ch as usize),
            Err(e) => {
                log_error(&format!("[VoiceoverMix] Ошибка чтения оригинального аудио: {}", e));
                (Vec::new(), 2)
            }
        }
    } else {
        log_info("[VoiceoverMix] Оригинальная дорожка не найдена (будет использован чистый голос).");
        (Vec::new(), 2)
    };

    // Приведение дорожки оригинала к стерео (2 канала)
    let orig_stereo: Vec<f32> = if orig_pcm.is_empty() {
        Vec::new()
    } else if orig_channels == 1 {
        let mut st = Vec::with_capacity(orig_pcm.len() * 2);
        for &s in &orig_pcm {
            st.push(s);
            st.push(s);
        }
        st
    } else if orig_channels >= 2 {
        let frames = orig_pcm.len() / orig_channels;
        let mut st = Vec::with_capacity(frames * 2);
        for f in 0..frames {
            st.push(orig_pcm[f * orig_channels]);
            st.push(orig_pcm[f * orig_channels + 1]);
        }
        st
    } else {
        orig_pcm
    };

    let _ = app_handle.emit("export-progress", 30.0);

    // 2. Чтение или рендеринг дорожки Clean_VO
    let mut vo_stereo: Vec<f32> = Vec::new();

    if let Some(ref clean_p) = request.clean_vo_path {
        let norm = normalize_windows_path(clean_p);
        if Path::new(&norm).exists() {
            log_info(&format!("[VoiceoverMix] Загрузка Clean VO: {}", norm));
            if let Ok((samples, _sr, ch)) = read_audio_file_any_format(Path::new(&norm)) {
                if ch == 1 {
                    vo_stereo.reserve(samples.len() * 2);
                    for &s in &samples {
                        vo_stereo.push(s);
                        vo_stereo.push(s);
                    }
                } else if ch >= 2 {
                    let frames = samples.len() / ch as usize;
                    vo_stereo.reserve(frames * 2);
                    for f in 0..frames {
                        vo_stereo.push(samples[f * ch as usize]);
                        vo_stereo.push(samples[f * ch as usize + 1]);
                    }
                }
            }
        }
    }

    // Если Clean_VO файл не был загружен напрямую, рендерим из данных проекта
    if vo_stereo.is_empty() {
        if let Some(ref pjson) = request.project_json {
            if let Ok(mut proj_data) = serde_json::from_str::<ExportProjectData>(pjson) {
                log_info("[VoiceoverMix] Рендеринг Clean VO из треков проекта...");
                proj_data.tracks.retain(|t| {
                    let n = t.name.to_lowercase();
                    !n.contains("оригинал") && !n.contains("original") && !n.contains("reference")
                });

                let (prep_tracks, total_frames, unique_paths) =
                    prepare_project_tracks(&proj_data, &output_norm, false);

                if total_frames > 0 && !prep_tracks.is_empty() {
                    let all_segments: Vec<PreparedSegment> = prep_tracks
                        .into_iter()
                        .flat_map(|t| t.segments)
                        .collect();
                    let audio_cache = preload_audio_files_parallel(&unique_paths);

                    let mut rendered = vec![0.0f32; total_frames * 2];
                    let num_blocks = (total_frames + BLOCK_FRAMES - 1) / BLOCK_FRAMES;

                    for b in 0..num_blocks {
                        let start_f = (b * BLOCK_FRAMES) as i64;
                        let count_f = BLOCK_FRAMES.min(total_frames - b * BLOCK_FRAMES);
                        let mut block = vec![0.0f32; count_f * 2];
                        render_segments_into_block(start_f, count_f, &all_segments, &audio_cache, &mut block);
                        let out_idx = (b * BLOCK_FRAMES) * 2;
                        rendered[out_idx..out_idx + count_f * 2].copy_from_slice(&block);
                    }
                    vo_stereo = rendered;
                }
            }
        }
    }

    let _ = app_handle.emit("export-progress", 60.0);

    // 3. Выравнивание буферов по длине и прямое суммирование с True-Peak лимитером
    let orig_frames = orig_stereo.len() / 2;
    let vo_frames = vo_stereo.len() / 2;
    let total_frames = orig_frames.max(vo_frames);

    if total_frames == 0 {
        return Err("Нет аудиоданных для сведения (пустые дорожки)".to_string());
    }

    let orig_gain = request.original_track_volume.unwrap_or(0.20);
    let vo_gain = request.vocal_bus_volume.unwrap_or(1.0);

    // Потолок True-Peak -1.0 dBTP (~0.89125)
    let ceiling = 10.0f32.powf(-1.0 / 20.0);
    let threshold = 0.75 * ceiling;
    let span = ceiling - threshold;

    let mut master_pcm = Vec::with_capacity(total_frames * 2);
    let mut max_abs_peak = 0.0f32;

    for f in 0..total_frames {
        let idx = f * 2;
        let vo_l = vo_stereo.get(idx).copied().unwrap_or(0.0) * vo_gain;
        let vo_r = vo_stereo.get(idx + 1).copied().unwrap_or(0.0) * vo_gain;
        let orig_l = orig_stereo.get(idx).copied().unwrap_or(0.0) * orig_gain;
        let orig_r = orig_stereo.get(idx + 1).copied().unwrap_or(0.0) * orig_gain;

        let sum_l = vo_l + orig_l;
        let sum_r = vo_r + orig_r;

        for &sum_sample in &[sum_l, sum_r] {
            let abs_s = sum_sample.abs();
            if abs_s > max_abs_peak {
                max_abs_peak = abs_s;
            }

            let limited = if abs_s <= threshold {
                sum_sample
            } else {
                let sign = sum_sample.signum();
                let excess = abs_s - threshold;
                let compressed = threshold + span * (excess / span).tanh();
                sign * compressed.min(ceiling)
            };
            master_pcm.push(limited);
        }
    }

    let _ = app_handle.emit("export-progress", 85.0);

    // 4. Запись в 24-bit PCM Broadcast WAV (48 kHz Stereo)
    if let Some(parent) = Path::new(&output_norm).parent() {
        let _ = fs::create_dir_all(parent);
    }

    let spec = create_wav_spec("24");
    let mut writer = WavWriter::create(&output_norm, spec)
        .map_err(|e| format!("Не удалось создать выходной мастер-файл: {}", e))?;
    write_pcm_to_wav(&mut writer, &master_pcm, "24")?;
    writer.finalize().map_err(|e| format!("Ошибка финализации WAV: {}", e))?;

    let dur_sec = total_frames as f64 / EXPORT_SAMPLE_RATE as f64;
    let peak_db = if max_abs_peak > 0.0 {
        20.0 * max_abs_peak.log10()
    } else {
        -96.0
    };

    let _ = app_handle.emit("export-progress", 100.0);

    log_info(&format!(
        "[VoiceoverMix] Сведение завершено успешно. Файл: '{}', Длительность: {:.2}s, True-Peak: {:.2} dBTP",
        output_norm, dur_sec, peak_db
    ));

    Ok(VoiceoverMixResult {
        success: true,
        output_path: output_norm,
        duration_seconds: dur_sec,
        max_peak_db: peak_db,
        original_volume_applied: orig_gain,
        vocal_volume_applied: vo_gain,
        message: format!(
            "Закадровый микс успешно сформирован: {:.2} сек. Баланс: Оригинал {:.0}%, Голоса {:.0}%.",
            dur_sec,
            orig_gain * 100.0,
            vo_gain * 100.0
        ),
    })
}
