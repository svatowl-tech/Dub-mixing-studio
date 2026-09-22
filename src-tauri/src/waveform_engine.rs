use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

use rayon::prelude::*;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::logger::log_debug;
use crate::process_utils::CommandExtHide;

async fn get_video_duration(app_handle: &AppHandle, file_path: &str) -> Result<f64, String> {
    let norm_file_path = crate::file_io::normalize_windows_path(file_path);
    if let Ok(ffprobe_cmd) = app_handle.shell().sidecar("ffprobe") {
        if let Ok(output) = ffprobe_cmd
            .args(&[
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                &norm_file_path,
            ])
            .output()
            .await
        {
            if output.status.success() {
                let duration_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if let Ok(d) = duration_str.parse::<f64>() {
                    return Ok(d);
                }
            }
        }
    }

    let fallback = tokio::process::Command::new("ffprobe")
        .hide_window()
        .args(&[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &norm_file_path,
        ])
        .output()
        .await;

    if let Ok(fo) = fallback {
        if fo.status.success() {
            let duration_str = String::from_utf8_lossy(&fo.stdout).trim().to_string();
            return duration_str
                .parse::<f64>()
                .map_err(|_| format!("Failed to parse duration: {}", duration_str));
        }
    }

    Err("ffprobe duration check failed".to_string())
}

/// Native in-memory decoding of audio files (MP3, FLAC, OGG, AAC, WAV, etc.) via Symphonia
fn decode_audio_symphonia(file_path: &str) -> Result<(Vec<f32>, u32), String> {
    let path = Path::new(file_path);
    let file = File::open(path).map_err(|e| format!("Failed to open file for Symphonia: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let format_opts = FormatOptions::default();
    let metadata_opts = MetadataOptions::default();
    let decoder_opts = DecoderOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| format!("Symphonia format probe failed: {}", e))?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "No valid audio track found by Symphonia".to_string())?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(48000);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Symphonia decoder init failed: {}", e))?;

    let mut pcm_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(pkt) => pkt,
            Err(SymphoniaError::IoError(ref err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(audio_buf_ref) => match audio_buf_ref {
                AudioBufferRef::F32(buf) => {
                    let num_frames = buf.frames();
                    let num_channels = buf.spec().channels.count();
                    if num_channels == 1 {
                        pcm_samples.extend_from_slice(buf.chan(0));
                    } else {
                        let inv_ch = 1.0 / num_channels as f32;
                        for frame in 0..num_frames {
                            let mut sum = 0.0f32;
                            for ch in 0..num_channels {
                                sum += buf.chan(ch)[frame];
                            }
                            pcm_samples.push(sum * inv_ch);
                        }
                    }
                }
                AudioBufferRef::S16(buf) => {
                    let num_frames = buf.frames();
                    let num_channels = buf.spec().channels.count();
                    let scale = 1.0 / 32768.0;
                    let inv_ch = 1.0 / num_channels as f32;
                    for frame in 0..num_frames {
                        let mut sum = 0.0f32;
                        for ch in 0..num_channels {
                            sum += buf.chan(ch)[frame] as f32 * scale;
                        }
                        pcm_samples.push(sum * inv_ch);
                    }
                }
                AudioBufferRef::S24(buf) => {
                    let num_frames = buf.frames();
                    let num_channels = buf.spec().channels.count();
                    let scale = 1.0 / 8388608.0;
                    let inv_ch = 1.0 / num_channels as f32;
                    for frame in 0..num_frames {
                        let mut sum = 0.0f32;
                        for ch in 0..num_channels {
                            sum += buf.chan(ch)[frame].0 as f32 * scale;
                        }
                        pcm_samples.push(sum * inv_ch);
                    }
                }
                AudioBufferRef::S32(buf) => {
                    let num_frames = buf.frames();
                    let num_channels = buf.spec().channels.count();
                    let scale = 1.0 / 2147483648.0;
                    let inv_ch = 1.0 / num_channels as f32;
                    for frame in 0..num_frames {
                        let mut sum = 0.0f32;
                        for ch in 0..num_channels {
                            sum += buf.chan(ch)[frame] as f32 * scale;
                        }
                        pcm_samples.push(sum * inv_ch);
                    }
                }
                AudioBufferRef::U8(buf) => {
                    let num_frames = buf.frames();
                    let num_channels = buf.spec().channels.count();
                    let inv_ch = 1.0 / num_channels as f32;
                    for frame in 0..num_frames {
                        let mut sum = 0.0f32;
                        for ch in 0..num_channels {
                            sum += (buf.chan(ch)[frame] as f32 - 128.0) / 128.0;
                        }
                        pcm_samples.push(sum * inv_ch);
                    }
                }
                _ => {}
            },
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(_) => break,
        }
    }

    if pcm_samples.is_empty() {
        return Err("No samples extracted by Symphonia".to_string());
    }

    Ok((pcm_samples, sample_rate))
}

/// In-memory streaming decoding via FFmpeg stdout pipe (`pipe:1`), reading f32le 48kHz mono PCM in 64 KB chunks
fn decode_ffmpeg_stdout_pipe(file_path: &str) -> Result<(Vec<f32>, u32), String> {
    let norm_path = crate::file_io::normalize_windows_path(file_path);
    let ffmpeg_bin = crate::file_io::find_ffmpeg_path();

    let sync_filters = "aresample=async=1:min_hard_comp=0.100000:first_pts=0";

    let mut child = Command::new(&ffmpeg_bin)
        .hide_window()
        .args(&[
            "-v",
            "quiet",
            "-i",
            &norm_path,
            "-vn",
            "-af",
            sync_filters,
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn FFmpeg ({}): {}", ffmpeg_bin, e))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or("Failed to open FFmpeg stdout pipe")?;
    let mut chunk = [0u8; 65536]; // 64 KB streaming chunk
    let mut byte_buf = Vec::with_capacity(1024 * 1024);
    let mut pcm_samples = Vec::new();

    while let Ok(n) = stdout.read(&mut chunk) {
        if n == 0 {
            break;
        }
        byte_buf.extend_from_slice(&chunk[..n]);

        let complete_floats = byte_buf.len() / 4;
        if complete_floats > 0 {
            let bytes_to_process = complete_floats * 4;
            for i in 0..complete_floats {
                let idx = i * 4;
                let b = [
                    byte_buf[idx],
                    byte_buf[idx + 1],
                    byte_buf[idx + 2],
                    byte_buf[idx + 3],
                ];
                pcm_samples.push(f32::from_le_bytes(b));
            }
            byte_buf.drain(0..bytes_to_process);
        }
    }

    let _ = child.wait();

    if pcm_samples.is_empty() {
        return Err(format!(
            "FFmpeg stdout decoding yielded 0 samples for {}",
            file_path
        ));
    }

    Ok((pcm_samples, 48000))
}

/// Decodes audio or video file directly into PCM samples in memory with ZERO temporary files
pub fn decode_audio_file_sync(file_path: &str) -> Result<(Vec<f32>, u32), String> {
    let norm_path = crate::file_io::normalize_windows_path(file_path);
    let path = Path::new(&norm_path);

    let is_video = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lower = ext.to_lowercase();
            matches!(
                lower.as_str(),
                "mp4"
                    | "mkv"
                    | "avi"
                    | "mov"
                    | "webm"
                    | "flv"
                    | "ts"
                    | "m4v"
                    | "wmv"
                    | "3gp"
                    | "ogv"
                    | "mpg"
                    | "mpeg"
            )
        })
        .unwrap_or(false);

    if !is_video {
        if let Ok(res) = decode_audio_symphonia(&norm_path) {
            return Ok(res);
        }
        log_debug(&format!(
            "Symphonia decoding failed for {}, falling back to FFmpeg stdout pipe...",
            norm_path
        ));
    }

    decode_ffmpeg_stdout_pipe(&norm_path)
}

/// Parallel vectorized calculation of RMS peaks using Rayon
pub fn calculate_rms_peaks_parallel(samples: &[f32], points: usize) -> Vec<f32> {
    if samples.is_empty() {
        return vec![0.0; points.max(1)];
    }

    let pts = points.max(1);

    (0..pts)
        .into_par_iter()
        .map(|i| {
            let start_norm = i as f64 / pts as f64;
            let end_norm = (i + 1) as f64 / pts as f64;

            let start_idx = (start_norm * samples.len() as f64) as usize;
            let end_idx = ((end_norm * samples.len() as f64) as usize).min(samples.len());

            let start_idx = start_idx.min(samples.len());
            let end_idx = end_idx.clamp(start_idx, samples.len());

            if start_idx >= end_idx {
                return 0.0;
            }

            let chunk = &samples[start_idx..end_idx];
            let mut sum_squares = 0.0f32;

            for &s in chunk {
                sum_squares += s * s;
            }

            if chunk.is_empty() {
                0.0
            } else {
                (sum_squares / chunk.len() as f32).sqrt()
            }
        })
        .collect()
}

pub fn generate_waveform_peaks_internal(
    file_path: &str,
    points: usize,
) -> Result<Vec<f32>, String> {
    let (samples, _sample_rate) = decode_audio_file_sync(file_path)?;
    Ok(calculate_rms_peaks_parallel(&samples, points))
}

/// Helper to extract original audio track from video to target WAV path using FFmpeg sidecar (with fallback)
async fn extract_audio_from_video_ffmpeg(
    app_handle: &AppHandle,
    video_path: &str,
    dest_path: &Path,
) -> Result<(), String> {
    let norm_video = crate::file_io::normalize_windows_path(video_path);
    let dest_str = crate::file_io::normalize_windows_path(&dest_path.to_string_lossy());

    let mut extracted = false;
    if let Ok(ffmpeg_cmd) = app_handle.shell().sidecar("ffmpeg") {
        if let Ok(output) = ffmpeg_cmd
            .args(&[
                "-y",
                "-i",
                &norm_video,
                "-vn",
                "-ac",
                "2",
                "-ar",
                "48000",
                "-c:a",
                "pcm_s16le",
                &dest_str,
            ])
            .output()
            .await
        {
            if output.status.success() {
                extracted = true;
            } else {
                log_debug(&format!(
                    "FFmpeg sidecar extraction failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }
    }

    if !extracted {
        let ffmpeg_bin = crate::file_io::find_ffmpeg_path();
        let output = tokio::process::Command::new(&ffmpeg_bin)
            .hide_window()
            .args(&[
                "-y",
                "-i",
                &norm_video,
                "-vn",
                "-ac",
                "2",
                "-ar",
                "48000",
                "-c:a",
                "pcm_s16le",
                &dest_str,
            ])
            .output()
            .await
            .map_err(|e| format!("Не удалось запустить FFmpeg ({}): {}", ffmpeg_bin, e))?;

        if !output.status.success() {
            return Err(format!(
                "Ошибка извлечения original_audio.wav через FFmpeg: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    Ok(())
}

/// Tauri command to ensure original_audio.wav is extracted and exists in {project_path}/takes/
#[tauri::command]
pub async fn ensure_original_audio_extracted(
    app_handle: AppHandle,
    project_path: String,
    video_path: String,
) -> Result<String, String> {
    let norm_project_path = crate::file_io::normalize_windows_path(&project_path);
    let norm_video_path = crate::file_io::normalize_windows_path(&video_path);

    log_debug(&format!(
        "ensure_original_audio_extracted: project_path={}, video_path={}",
        norm_project_path, norm_video_path
    ));

    let proj_p = Path::new(&norm_project_path);
    let takes_dir = if proj_p.ends_with("takes") {
        proj_p.to_path_buf()
    } else {
        proj_p.join("takes")
    };

    if !takes_dir.exists() {
        std::fs::create_dir_all(&takes_dir).map_err(|e| {
            format!(
                "Не удалось создать директорию takes {:?}: {}",
                takes_dir, e
            )
        })?;
    }

    let target_wav = takes_dir.join("original_audio.wav");
    let dest_str = crate::file_io::normalize_windows_path(&target_wav.to_string_lossy());

    let is_valid = if target_wav.exists() {
        match std::fs::metadata(&target_wav) {
            Ok(meta) => meta.len() > 1024,
            Err(_) => false,
        }
    } else {
        false
    };

    if !is_valid {
        if !Path::new(&norm_video_path).exists() {
            return Err(format!(
                "Исходный видеофайл не найден: {}",
                norm_video_path
            ));
        }

        log_debug(&format!(
            "Extracting original audio track from {} to {}",
            norm_video_path, dest_str
        ));

        extract_audio_from_video_ffmpeg(&app_handle, &norm_video_path, &target_wav).await?;

        if !target_wav.exists() {
            return Err(format!(
                "Файл {} не был создан после выполнения FFmpeg",
                dest_str
            ));
        }

        let meta = std::fs::metadata(&target_wav)
            .map_err(|e| format!("Не удалось прочитать метаданные {}: {}", dest_str, e))?;
        if meta.len() <= 1024 {
            return Err(format!(
                "Файл {} пуст или поврежден ({} байт)",
                dest_str,
                meta.len()
            ));
        }

        // Also duplicate to project root if project_path was root directory
        if !proj_p.ends_with("takes") {
            let root_wav = proj_p.join("original_audio.wav");
            if !root_wav.exists() {
                let _ = std::fs::copy(&target_wav, &root_wav);
            }
        }
    }

    Ok(dest_str)
}

#[tauri::command]
pub async fn extract_audio_peaks_bin(
    app_handle: AppHandle,
    file_path: String,
    output_dir: String,
) -> Result<Vec<u8>, String> {
    let norm_file_path = crate::file_io::normalize_windows_path(&file_path);
    let norm_output_dir = crate::file_io::normalize_windows_path(&output_dir);
    log_debug(&format!(
        "extract_audio_peaks_bin called for: {}, output_dir: {}",
        norm_file_path, norm_output_dir
    ));

    // 1. If output_dir is provided, guarantee {output_dir}/takes/ exists and extract original_audio.wav
    let decode_target_path = if !norm_output_dir.trim().is_empty() {
        let out_p = Path::new(&norm_output_dir);
        let takes_dir = if out_p.ends_with("takes") {
            out_p.to_path_buf()
        } else {
            out_p.join("takes")
        };

        if !takes_dir.exists() {
            if let Err(e) = std::fs::create_dir_all(&takes_dir) {
                log_debug(&format!("Failed to create takes dir {:?}: {}", takes_dir, e));
            }
        }

        let target_wav = takes_dir.join("original_audio.wav");
        let dest_str = crate::file_io::normalize_windows_path(&target_wav.to_string_lossy());

        let needs_extract = if target_wav.exists() {
            std::fs::metadata(&target_wav)
                .map(|m| m.len() <= 1024)
                .unwrap_or(true)
        } else {
            true
        };

        if needs_extract {
            log_debug(&format!("Extracting original_audio.wav to: {}", dest_str));
            extract_audio_from_video_ffmpeg(&app_handle, &norm_file_path, &target_wav).await?;
        }

        // Verification check before proceeding: ensure file exists and is > 1024 bytes
        if !target_wav.exists() {
            return Err(format!("Файл original_audio.wav не найден по пути {}", dest_str));
        }

        let meta = std::fs::metadata(&target_wav)
            .map_err(|e| format!("Не удалось получить метаданные {}: {}", dest_str, e))?;
        if meta.len() <= 1024 {
            return Err(format!(
                "Файл {} пуст или поврежден ({} байт)",
                dest_str,
                meta.len()
            ));
        }

        // Also duplicate to project root if output_dir is project root
        if !out_p.ends_with("takes") {
            let root_wav = out_p.join("original_audio.wav");
            if !root_wav.exists() {
                let _ = std::fs::copy(&target_wav, &root_wav);
            }
        }

        dest_str
    } else {
        norm_file_path.clone()
    };

    let video_duration = get_video_duration(&app_handle, &norm_file_path).await.ok();

    let target_path_clone = decode_target_path.clone();
    let (samples, sample_rate) = tokio::task::spawn_blocking(move || {
        decode_audio_file_sync(&target_path_clone)
    })
    .await
    .map_err(|e| format!("Task execution error: {}", e))??;

    let audio_duration = samples.len() as f64 / sample_rate as f64;
    if let Some(v_dur) = video_duration {
        let diff = (audio_duration - v_dur).abs();
        if diff > 0.010 {
            log_debug(&format!(
                "!!! SYNC WARNING !!! Audio duration ({:.4}s) differs from Video duration ({:.4}s) by {:.1}ms.",
                audio_duration, v_dur, diff * 1000.0
            ));
        } else {
            log_debug(&format!("Extraction sync: diff {:.2}ms", diff * 1000.0));
        }
    }

    let points_per_second = 50.0;
    let v_dur = video_duration.unwrap_or(audio_duration);
    let points = ((v_dur * points_per_second) as usize).max(100);

    let float_peaks = calculate_rms_peaks_parallel(&samples, points);

    let peaks_u8: Vec<u8> = float_peaks
        .into_iter()
        .map(|p| (p.abs().sqrt().min(1.0) * 255.0) as u8)
        .collect();

    log_debug(&format!(
        "Generated {} peaks for {}",
        peaks_u8.len(),
        norm_file_path
    ));

    Ok(peaks_u8)
}

#[tauri::command]
pub async fn generate_waveform_peaks(
    _app_handle: AppHandle,
    file_path: String,
    points: usize,
) -> Result<Vec<f32>, String> {
    let norm_path = crate::file_io::normalize_windows_path(&file_path);
    log_debug(&format!(
        "generate_waveform_peaks called for: {}, points: {}",
        norm_path, points
    ));

    tokio::task::spawn_blocking(move || {
        generate_waveform_peaks_internal(&norm_path, points)
    })
    .await
    .map_err(|e| format!("Task execution error: {}", e))?
}

#[tauri::command]
pub fn generate_waveform_peaks_from_pcm(
    samples: Vec<f32>,
    points: usize,
) -> Result<Vec<f32>, String> {
    Ok(calculate_rms_peaks_parallel(&samples, points))
}
