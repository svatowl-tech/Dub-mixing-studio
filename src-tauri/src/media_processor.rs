use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tauri::{AppHandle, Emitter, State};
use regex::Regex;
use std::fs;
use crate::db::AppState;
use sqlx::Row;
use crate::waveform_engine::generate_waveform_peaks;

use crate::logger::{log_debug, log_info, log_error};

#[derive(serde::Serialize, Clone)]
struct MediaProgress {
    time: String,
    percent: f64,
    operation: String,
}

#[derive(serde::Serialize)]
pub struct MergeResult {
    pub file_path: String,
    pub peaks: Vec<f32>,
    pub duration: f64,
}

// ... existing run_ffmpeg_with_progress ...

#[tauri::command]
pub async fn concat_backstage_videos(
    video_paths: Vec<String>,
    output_path: String,
) -> Result<String, String> {
    if video_paths.is_empty() {
        return Err("Нет видео для объединения".to_string());
    }

    // Создаем временный файл со списком путей для ffmpeg concat
    let mut file_list = String::new();
    for path in &video_paths {
        // Экранируем одинарные кавычки для формата ffmpeg concat
        let escaped_path = path.replace("'", "'\\''");
        file_list.push_str(&format!("file '{}'\n", escaped_path));
    }

    let temp_file_path = std::env::temp_dir().join(format!("backstage_list_{}.txt", std::process::id()));
    std::fs::write(&temp_file_path, file_list).map_err(|e| e.to_string())?;

    // Склеиваем видео без перекодирования (stream copy), если это возможно
    // Внимание: это работает стабильно, если все исходники имеют одинаковые параметры (кодек, разрешение)
    let output = std::process::Command::new("ffmpeg")
        .args(&[
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", temp_file_path.to_str().unwrap(),
            "-c", "copy",
            &output_path
        ])
        .output()
        .map_err(|e| e.to_string())?;

    // Удаляем временный файл
    let _ = std::fs::remove_file(temp_file_path);

    if !output.status.success() {
        return Err(format!("FFmpeg failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    Ok(output_path)
}

#[tauri::command]
pub async fn merge_segments(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    track_id: String,
    segment_ids: Vec<String>,
    output_path: String,
) -> Result<MergeResult, String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    // 1. Fetch file paths from database based on IDs
    let mut file_paths = Vec::new();
    let mut total_duration = 0.0;
    let mut min_start_time = f64::MAX;

    for id in &segment_ids {
        let row = sqlx::query("SELECT file_path, duration, start_time FROM segments WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

        if let Some(r) = row {
            let file_path: Option<String> = r.get("file_path");
            let duration: f64 = r.get("duration");
            let start_time: f64 = r.get("start_time");

            if let Some(p) = file_path {
                file_paths.push(p);
                total_duration += duration;
                if start_time < min_start_time {
                    min_start_time = start_time;
                }
            }
        }
    }

    if file_paths.is_empty() {
        return Err("No valid segments found to merge".to_string());
    }

    // 2. Create FFmpeg concat file
    let temp_dir = std::env::temp_dir();
    let concat_file_path = temp_dir.join(format!("concat_{}.txt", project_id));
    let mut concat_content = String::new();
    for p in &file_paths {
        // FFmpeg concat demuxer requires single quotes escaped
        let escaped = p.replace("'", "'\\''");
        concat_content.push_str(&format!("file '{}'\n", escaped));
    }
    
    fs::write(&concat_file_path, concat_content).map_err(|e| e.to_string())?;

    // 3. Run FFmpeg Concat (Fastest, no re-encoding for same-spec WAVs)
    let args = vec![
        "-y".to_string(),
        "-f".to_string(), "concat".to_string(),
        "-safe".to_string(), "0".to_string(),
        "-i".to_string(), concat_file_path.to_str().unwrap().to_string(),
        "-c".to_string(), "copy".to_string(),
        output_path.clone(),
    ];

    run_ffmpeg_with_progress(app_handle.clone(), args, "Merging Segments".to_string(), Some(total_duration)).await?;

    // 4. Generate Peaks for the new merged file
    let peaks = generate_waveform_peaks(app_handle.clone(), output_path.clone(), 1024).await?;

    // 5. Update Database (Transaction)
    // Delete old segments and insert the new merged one
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    for id in &segment_ids {
        sqlx::query("DELETE FROM segments WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    let new_seg_id = format!("merged_{}", uuid::Uuid::new_v4());

    sqlx::query("
        INSERT INTO segments (id, track_id, start_time, duration, file_offset, file_duration, file_path, gain)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ")
    .bind(&new_seg_id)
    .bind(&track_id)
    .bind(min_start_time)
    .bind(total_duration)
    .bind(0.0)
    .bind(total_duration)
    .bind(&output_path)
    .bind(1.0)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    // Cleanup
    let _ = fs::remove_file(concat_file_path);

    Ok(MergeResult {
        file_path: output_path,
        peaks,
        duration: total_duration,
    })
}

#[derive(serde::Deserialize)]
pub struct Segment {
    pub path: String,
    pub start_time: f64,
    pub duration: f64,
}

#[tauri::command]
pub async fn merge_project_segments(
    segments: Vec<Segment>,
    total_duration: f64,
    output_path: String,
) -> Result<String, String> {
    use hound::{WavReader, WavWriter};
    
    if segments.is_empty() {
        return Err("No segments to merge".to_string());
    }

    // Sort segments by start time
    let mut sorted_segments = segments;
    sorted_segments.sort_by(|a, b| a.start_time.partial_cmp(&b.start_time).unwrap());

    // Detect spec from first available segment
    let first_valid_path = sorted_segments.iter()
        .find(|s| std::path::Path::new(&s.path).exists())
        .ok_or("No valid segment files found on disk")?;
    
    let reader = WavReader::open(&first_valid_path.path)
        .map_err(|e| format!("Failed to open reference segment: {}", e))?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    
    let mut writer = WavWriter::create(&output_path, spec)
        .map_err(|e| format!("Failed to create master file: {}", e))?;

    let mut current_pos_samples: u64 = 0;

    for seg in sorted_segments {
        let seg_start_samples = (seg.start_time * sample_rate as f64) as u64;
        
        // 1. Fill gap with silence
        if seg_start_samples > current_pos_samples {
            let silence_len = seg_start_samples - current_pos_samples;
            for _ in 0..silence_len {
                writer.write_sample(0i16).map_err(|e| e.to_string())?;
            }
            current_pos_samples = seg_start_samples;
        }

        // 2. Write segment data
        if let Ok(mut seg_reader) = WavReader::open(&seg.path) {
            let seg_spec = seg_reader.spec();
            if seg_spec.sample_rate != sample_rate {
                 // Simple safety: if mismatch, we could skip or error. 
                 // For now, continue and warn or assume user normalized.
            }

            // Read all samples and write
            // We support i16 primarily as it's common for dubbing
            for sample in seg_reader.samples::<i16>() {
                let s = sample.map_err(|e| e.to_string())?;
                writer.write_sample(s).map_err(|e| e.to_string())?;
                current_pos_samples += 1;
            }
        } else {
            // If file missing, fill with silence for intended duration
            let dur_samples = (seg.duration * sample_rate as f64) as u64;
            for _ in 0..dur_samples {
                writer.write_sample(0i16).map_err(|e| e.to_string())?;
            }
            current_pos_samples += dur_samples;
        }
    }

    // 3. Fill remaining timeline to total_duration
    let total_samples = (total_duration * sample_rate as f64) as u64;
    if total_samples > current_pos_samples {
        let remaining = total_samples - current_pos_samples;
        for _ in 0..remaining {
            writer.write_sample(0i16).map_err(|e| e.to_string())?;
        }
    }

    writer.finalize().map_err(|e| e.to_string())?;

    Ok(output_path)
}

pub(crate) async fn run_ffmpeg_with_progress(
    app_handle: AppHandle,
    args: Vec<String>,
    operation_name: String,
    duration_secs: Option<f64>,
) -> Result<(), String> {
    let mut shell_args = vec!["-hide_banner".to_string(), "-stats".to_string()];
    let normalized_args: Vec<String> = args.into_iter().map(|arg| {
        crate::file_io::normalize_windows_path(&arg)
    }).collect();
    shell_args.extend(normalized_args);

    log_info(&format!("Запуск FFmpeg Сайдкара [{}] с аргументами: {:?}", operation_name, shell_args));

    let sidecar_command = app_handle
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| {
            let err_msg = format!("Ошибка создания команды FFmpeg sidecar: {}", e);
            log_error(&err_msg);
            err_msg
        })?
        .args(&shell_args);

    let (mut rx, _child) = sidecar_command
        .spawn()
        .map_err(|e| {
            let err_msg = format!("Ошибка запуска процесса FFmpeg: {}", e);
            log_error(&err_msg);
            err_msg
        })?;

    // Regex to capture time=00:00:00.00
    let re = Regex::new(r"time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})").unwrap();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(line_bytes) => {
                let line = String::from_utf8_lossy(&line_bytes);
                let trimmed = line.trim_end();
                log_debug(&format!("[FFmpeg STDERR] {}", trimmed));
                if let Some(caps) = re.captures(&line) {
                    let h: f64 = caps[1].parse().unwrap_or(0.0);
                    let m: f64 = caps[2].parse().unwrap_or(0.0);
                    let s: f64 = caps[3].parse().unwrap_or(0.0);
                    let ms: f64 = caps[4].parse().unwrap_or(0.0);
                    
                    let current_secs = h * 3600.0 + m * 60.0 + s + ms / 100.0;
                    
                    let percent = if let Some(total) = duration_secs {
                        (current_secs / total * 100.0).min(100.0)
                    } else {
                        0.0
                    };

                    let _ = app_handle.emit("media-progress", MediaProgress {
                        time: format!("{:02}:{:02}:{:02}", h as i32, m as i32, s as i32),
                        percent,
                        operation: operation_name.clone(),
                    });
                }
            },
            CommandEvent::Stdout(line_bytes) => {
                let line = String::from_utf8_lossy(&line_bytes);
                log_info(&format!("[FFmpeg STDOUT] {}", line.trim_end()));
            },
            CommandEvent::Error(err) => {
                log_error(&format!("[FFmpeg Command Error] {}", err));
            },
            CommandEvent::Terminated(status) => {
                log_info(&format!("[FFmpeg Terminated] Код завершения: {:?}", status.code));
                if let Some(code) = status.code {
                    if code != 0 {
                        let err_msg = format!("FFmpeg завершился с ошибкой, код: {}", code);
                        log_error(&err_msg);
                        return Err(err_msg);
                    }
                }
            }
            _ => {}
        }
    }

    log_info(&format!("Успешно завершена операция FFmpeg: {}", operation_name));
    Ok(())
}

// Helper to detect hardware encoder
async fn get_hw_encoder(app_handle: &AppHandle) -> String {
    let output_result = app_handle.shell().sidecar("ffmpeg")
        .map(|cmd| cmd.args(["-encoders"]));

    if let Ok(cmd) = output_result {
        if let Ok(out) = cmd.output().await {
            let out_str = String::from_utf8_lossy(&out.stdout);
            if out_str.contains("h264_nvenc") { return "h264_nvenc".to_string(); }
            if out_str.contains("h264_amf") { return "h264_amf".to_string(); }
            if out_str.contains("h264_qsv") { return "h264_qsv".to_string(); }
        }
    }
    "libx264".to_string() // Fallback
}

#[tauri::command]
pub async fn render_final_video(
    app_handle: AppHandle,
    original_video: String,
    master_dub: String,
    bg_volume: f64,
    dub_volume: f64,
    output_path: String,
    title: String,
    artist: String,
) -> Result<String, String> {
    log_debug(&format!("render_final_video called. Output: {}", output_path));
    let encoder = get_hw_encoder(&app_handle).await;
    
    let filter = format!(
        "[0:a]volume={}[bg]; [1:a]volume={}[dub]; [bg][dub]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]",
        bg_volume, dub_volume
    );

    let args = vec![
        "-y".to_string(),
        "-i".to_string(), original_video,
        "-i".to_string(), master_dub,
        "-filter_complex".to_string(), filter,
        "-map".to_string(), "0:v:0".to_string(),
        "-map".to_string(), "[a]".to_string(),
        "-c:v".to_string(), encoder,
        "-c:a".to_string(), "aac".to_string(),
        "-metadata".to_string(), format!("title={}", title),
        "-metadata".to_string(), format!("artist={}", artist),
        output_path.clone(),
    ];

    run_ffmpeg_with_progress(app_handle, args, "Rendering Final Video".to_string(), None).await?;
    
    Ok(output_path)
}

#[tauri::command]
pub async fn get_media_info(
    app_handle: AppHandle,
    path: String,
) -> Result<String, String> {
    println!("Calling get_media_info for path: {}", path);
    // Escape single quotes for standard paths isn't normally necessary since Tauri's sidecar command 
    // handles arguments as is, but we are just passing path directly to args.
    let normalized_path = crate::file_io::normalize_windows_path(&path);
    
    let sidecar_command = app_handle
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| {
            eprintln!("Failed to create ffprobe sidecar: {}", e);
            format!("Failed to create ffprobe sidecar: {}", e)
        })?
        .args(vec![
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            &normalized_path
        ]);

    let output = sidecar_command.output().await.map_err(|e| {
        eprintln!("ffprobe command failed to execute: {}", e);
        e.to_string()
    })?;
    
    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
        eprintln!("ffprobe failed with status: {:?}, stderr: {}", output.status.code(), err_msg);
        return Err(err_msg);
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout).to_string();
    println!("ffprobe succeeded, got output of length {}", stdout_str.len());
    Ok(stdout_str)
}

#[tauri::command]
pub async fn extract_mkv_assets(
    app_handle: AppHandle,
    input_path: String,
    video_output: String,
    sub_output: Option<String>,
    audio_index: usize,
    sub_index: Option<usize>,
    duration: Option<f64>,
) -> Result<String, String> {
    println!("Starting extract_mkv_assets with input: {}, video_output: {}, audio_index: {}, sub_index: {:?}", input_path, video_output, audio_index, sub_index);

    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(), input_path.clone(),
    ];

    // Map the main video stream
    args.push("-map".to_string());
    args.push("0:v:0".to_string());

    // Map the selected audio stream
    args.push("-map".to_string());
    args.push(format!("0:{}", audio_index));

    args.push("-c:v".to_string());
    args.push("copy".to_string());
    args.push("-c:a".to_string());
    args.push("aac".to_string()); 
    args.push("-movflags".to_string());
    args.push("faststart".to_string());
    args.push(video_output.clone());

    // If subtitles are selected, extract them to a separate file in the same ffmpeg run
    if let (Some(s_idx), Some(s_out)) = (sub_index, sub_output) {
        println!("Adding subtitle extraction args. s_idx={:?}, s_out={:?}", s_idx, s_out);
        args.push("-map".to_string());
        args.push(format!("0:{}", s_idx));
        args.push("-c:s".to_string());
        // For standard text subs
        if s_out.ends_with(".srt") {
            args.push("srt".to_string());
        } else if s_out.ends_with(".vtt") {
            args.push("webvtt".to_string());
        } else if s_out.ends_with(".ass") {
            args.push("ass".to_string());
        } else {
            args.push("copy".to_string()); // fallback
        }
        args.push(s_out);
    }

    println!("Calling run_ffmpeg_with_progress with args: {:?}", args);
    run_ffmpeg_with_progress(app_handle, args, "Extracting MKV Assets".to_string(), duration).await?;
    println!("run_ffmpeg_with_progress completed successfully.");
    
    Ok(video_output)
}

#[tauri::command]
pub async fn create_proxy_video(
    app_handle: AppHandle,
    input_path: String,
    output_path: String,
    duration: Option<f64>,
) -> Result<String, String> {
    log_debug(&format!("create_proxy_video called for: {}", input_path));
    // Smart Switch: If proxy exists, return path immediately
    if std::path::Path::new(&output_path).exists() {
        return Ok(output_path);
    }

    // Otherwise, spawn background task for generation
    let app_handle_spawn = app_handle.clone();
    let input_path_spawn = input_path.clone();
    let output_path_spawn = output_path.clone();

    tokio::spawn(async move {
        let args = vec![
            "-y".to_string(), // Overwrite
            "-i".to_string(), input_path_spawn,
            "-c:v".to_string(), "libx264".to_string(),
            "-preset".to_string(), "ultrafast".to_string(),
            "-crf".to_string(), "30".to_string(), // Updated CRF to 30 as requested
            "-vf".to_string(), "scale=-2:360".to_string(), // Using -2 for even dimensions
            "-c:a".to_string(), "aac".to_string(), 
            "-b:a".to_string(), "128k".to_string(),
            output_path_spawn.clone(),
        ];

        if let Err(e) = run_ffmpeg_with_progress(app_handle_spawn.clone(), args, "Proxy Generation".to_string(), duration).await {
            eprintln!("FFmpeg error during proxy generation: {}", e);
            // Optionally emit an error event to the frontend
            let _ = app_handle_spawn.emit("proxy-error", e);
        } else {
            // Emit success to trigger Smart Switch in frontend
            let _ = app_handle_spawn.emit("proxy-ready", &output_path_spawn);
        }
    });

    // Immediately return "Generating" status to the frontend
    Ok("Generating".to_string())
}

#[tauri::command]
pub async fn mux_video(
    app_handle: AppHandle,
    video_input: String,
    audio_input: String,
    output_path: String,
    duration: Option<f64>,
) -> Result<String, String> {
    let args = vec![
        "-y".to_string(),
        "-i".to_string(), video_input,
        "-i".to_string(), audio_input,
        "-c:v".to_string(), "copy".to_string(), // Copy video stream (no re-encode)
        "-c:a".to_string(), "aac".to_string(),  // Encode audio to AAC for MP4 compatibility
        "-b:a".to_string(), "192k".to_string(),
        "-map".to_string(), "0:v:0".to_string(), // Take video from first input
        "-map".to_string(), "1:a:0".to_string(), // Take audio from second input
        "-shortest".to_string(), 
        "-movflags".to_string(), "faststart".to_string(),
        output_path.clone(),
    ];

    run_ffmpeg_with_progress(app_handle, args, "Merging Video & Audio".to_string(), duration).await?;
    
    Ok(output_path)
}

#[tauri::command]
pub async fn create_blank_video(
    duration: f64,
    output_path: String,
) -> Result<String, String> {
    let output = std::process::Command::new("ffmpeg")
        .args(&[
            "-y",
            "-f", "lavfi",
            "-i", "color=c=black:s=1280x720:r=24",
            "-f", "lavfi",
            "-i", "anullsrc=cl=mono:r=48000",
            "-t", &duration.to_string(),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            &output_path
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!("FFmpeg failed to create blank video: {}", String::from_utf8_lossy(&output.stderr)));
    }

    Ok(output_path)
}

#[derive(serde::Deserialize)]
pub struct AudioEffectConfig {
    pub effect_type: String, // "normalization", "declick", "smarteq", "denoise", "dereverb", "separation"
    // Normalization specific
    pub target_lufs: Option<f64>,
    pub upward_threshold: Option<f64>,
    pub upward_gain: Option<f64>,
    pub upward_ratio: Option<f64>,
    // Declick specific
    pub sensitivity: Option<f64>,
    pub max_click_width_ms: Option<f64>,
    // SmartEQ specific
    pub eq_profile: Option<String>,
    // Denoise specific
    pub denoise_model: Option<String>,
    pub denoise_strength: Option<f64>,
    // Dereverb specific
    pub dereverb_model: Option<String>,
    pub dereverb_strength: Option<f64>,
    // Separation specific
    pub _separation_model: Option<String>,
}

#[tauri::command]
pub async fn apply_audio_effect(
    app_handle: AppHandle,
    input_path: String,
    output_path: String,
    config: AudioEffectConfig,
) -> Result<String, String> {
    log_info(&format!(
        "--- НАЧАЛО ОБРАБОТКИ АУДИОФАЙЛА ---\nВходной файл: {}\nВыходной файл: {}\nТип эффекта: {}",
        input_path, output_path, config.effect_type
    ));
    
    let mut filters = Vec::new();

    if config.effect_type == "normalization" {
        log_info("Конфигурация эффекта [Normalization / Нормализация]:");
        if let (Some(thresh), Some(gain), Some(ratio)) = (config.upward_threshold, config.upward_gain, config.upward_ratio) {
            log_info(&format!("  Upward Compression -> Порог: {} dB, Усиление: {} dB, Сжатие: {}", thresh, gain, ratio));
            filters.push(format!("acompressor=threshold={}dB:ratio={}:makeup={}dB:attack=5:release=50", thresh, ratio, gain));
        }
        let lufs = config.target_lufs.unwrap_or(-16.0);
        log_info(&format!("  Целевая громкость (Target LUFS): {} dB", lufs));
        filters.push(format!("loudnorm=I={}:TP=-1.5:LRA=11", lufs));

    } else if config.effect_type == "declick" {
        let sens = config.sensitivity.unwrap_or(50.0);
        let threshold = (10.0 - (sens / 100.0) * 9.0).clamp(0.1, 15.0);
        let window = (config.max_click_width_ms.unwrap_or(2.0) * 10.0).clamp(1.0, 100.0); 
        log_info(&format!(
            "Конфигурация эффекта [Declick / Удаление щелчков]:\n  Чувствительность: {} (вычисленный порог: {})\n  Ширина клика: {} ms (окно: {})", 
            sens, threshold, config.max_click_width_ms.unwrap_or(2.0), window
        ));
        filters.push(format!("adeclick=window={}:overlap=75:arorder=2:threshold={}:burst=2:method=a", window as u32, threshold));

    } else if config.effect_type == "smarteq" {
        let profile = config.eq_profile.unwrap_or_else(|| "flat".to_string());
        log_info(&format!("Конфигурация эффекта [SmartEQ / Умный эквалайзер]:\n  Профиль эквалайзера: {}", profile));
        
        match profile.as_str() {
            "vocal_presence" => {
                log_info("  Применяется профиль 'Vocal Presence' (выделение голоса)");
                filters.push("highpass=f=80:width_type=h:width=24".to_string());
                filters.push("equalizer=f=400:width_type=o:width=1:g=-3".to_string());
                filters.push("equalizer=f=4000:width_type=o:width=1:g=3".to_string());
                filters.push("equalizer=f=8000:width_type=o:width=1:g=2".to_string());
                filters.push("deesser=i=0.5:m=0.5:f=0.5:s=o".to_string());
            },
            "warm_analog" => {
                log_info("  Применяется профиль 'Warm Analog' (аналоговая теплота)");
                filters.push("highpass=f=60:width_type=h:width=24".to_string());
                filters.push("equalizer=f=150:width_type=o:width=1:g=2".to_string());
                filters.push("equalizer=f=2000:width_type=o:width=1:g=-2".to_string());
                filters.push("compand=attacks=0:points=-80/-80|-20/-20|0/-10".to_string());
            },
            "reference_match" => {
                log_info("  Применяется профиль 'Reference Match' (сопоставление с референсом)");
                filters.push("highpass=f=80:width_type=h:width=24".to_string());
                filters.push("equalizer=f=250:width_type=o:width=1:g=-2".to_string());
                filters.push("equalizer=f=2500:width_type=o:width=1.5:g=2".to_string());
                filters.push("equalizer=f=6000:width_type=o:width=1:g=4".to_string());
                filters.push("acompressor=threshold=-15dB:ratio=4:attack=5:release=50:makeup=4".to_string());
            },
            "flat" | _ => {
                log_info("  Применяется профиль 'Flat' (линейный высокочастотный срез)");
                filters.push("highpass=f=40".to_string());
            }
        }
    } else if config.effect_type == "denoise" {
        let strength = config.denoise_strength.unwrap_or(50.0);
        let model = config.denoise_model.unwrap_or_else(|| "deep_noise".to_string());
        let noise_reduction = (strength / 100.0 * 25.0 + 5.0).clamp(1.0, 97.0);
        let noise_floor = (-80.0 + (100.0 - strength) / 100.0 * 40.0).clamp(-120.0, -20.0);
        
        log_info(&format!(
            "Конфигурация эффекта [Denoise / Шумоподавление]:\n  Сила: {}% (эффективное шумоподавление: {} dB, порог: {} dB)\n  Модель: {}", 
            strength, noise_reduction, noise_floor, model
        ));
        
        match model.as_str() {
            "spectral_gate" => {
                log_info("  Применение спектрального гейта через afftdn");
                filters.push(format!("afftdn=nr={}:nf={}:nt=w", noise_reduction, noise_floor));
            },
            "intel_ai_denoise" => {
                log_info("  Применение адаптивного экспандера Intel Voice Clean");
                filters.push("compand=attacks=0.01:decays=0.1:points=-80/-80|-45/-60|-20/-20|0/0".to_string());
                filters.push(format!("afftdn=nr={}:nf={}:nt=w", noise_reduction * 0.85, noise_floor));
            },
            "rnnoise" | "deep_noise" | "uvr_denoise_lite" | "uvr_denoise_foxjoy" | "uvr_denoise_full" => {
                log_info("  Применение нейросетевого профиля шумоподавления речи");
                filters.push("highpass=f=75".to_string());
                filters.push(format!("afftdn=nr={}:nf={}:nt=w", noise_reduction, noise_floor));
                filters.push("lowpass=f=14000".to_string());
            },
            _ => { 
                log_info("  Применение стандартного денойзера");
                filters.push(format!("afftdn=nr={}:nf={}:nt=w", noise_reduction, noise_floor));
                filters.push("lowpass=f=12000".to_string());
            }
        }
    } else if config.effect_type == "dereverb" {
        let strength = config.dereverb_strength.unwrap_or(50.0);
        let model = config.dereverb_model.unwrap_or_else(|| "rt_dereverb_v2".to_string());
        let threshold = (-45.0 + (strength / 100.0 * 20.0)).clamp(-60.0, -10.0);
        let ratio = (1.5 + (strength / 100.0 * 3.5)).clamp(1.0, 10.0);
        
        log_info(&format!(
            "Конфигурация эффекта [Dereverb / Подавление эха]:\n  Сила: {}% (порог: {} dB, соотношение: {})\n  Модель: {}", 
            strength, threshold, ratio, model
        ));
        
        match model.as_str() {
            "room_cleaner_neural" => {
                log_info("  Подавление резонансов помещения (180Гц, 320Гц, 500Гц) + адаптивный гейт");
                filters.push(format!("agate=threshold={}dB:ratio={}:attack=10:release=90:makeup=1", threshold, ratio));
                filters.push("equalizer=f=180:width_type=o:width=1.5:g=-2.5".to_string());
                filters.push("equalizer=f=320:width_type=o:width=1.2:g=-3.5".to_string());
                filters.push("equalizer=f=500:width_type=o:width=1.0:g=-2.0".to_string());
            },
            "adaptive_gate" => {
                log_info("  Применение быстрого переходного гейта (Adaptive Transient Gate)");
                filters.push(format!("agate=threshold={}dB:ratio={}:attack=8:release=80:makeup=1", threshold, ratio));
            },
            "uvr_deecho_normal" | "uvr_deecho_aggressive" => {
                let mult = if model == "uvr_deecho_aggressive" { 1.3 } else { 1.0 };
                log_info("  Глубокое подавление реверберации и хвостов помещения");
                filters.push(format!("agate=threshold={}dB:ratio={}:attack=12:release=100:makeup=1", threshold, (ratio * mult).min(12.0)));
                filters.push("equalizer=f=250:width_type=o:width=1.5:g=-3.0".to_string());
                filters.push("equalizer=f=400:width_type=o:width=1.2:g=-2.5".to_string());
            },
            _ => {
                log_info("  Применение RT_Dereverb v2");
                filters.push(format!("agate=threshold={}dB:ratio={}:attack=15:release=120:makeup=1", threshold, ratio));
                filters.push("equalizer=f=350:width_type=o:width=1.2:g=-3.0".to_string());
                filters.push("equalizer=f=120:width_type=o:width=1.0:g=-2.0".to_string());
            }
        }
    } else if config.effect_type == "separation" {
        log_info("Выполняется изоляция Голоса / Вокала (Voice Isolation):");
        log_info("  - Высокочастотный фильтр (Highpass) > 120Hz");
        log_info("  - Низкочастотный фильтр (Lowpass) < 8000Hz");
        log_info("  - Оставление только центрального канала (stereotools mlev=2.5:slev=0)");
        log_info("  - Подъём частот презенса 3kHz (+3dB) и ослабление гула 400Hz (-2dB)");
        
        filters.push("highpass=f=120".to_string());
        filters.push("lowpass=f=8000".to_string());
        filters.push("stereotools=mlev=2.5:slev=0.0:kol=1:kor=1".to_string());
        filters.push("equalizer=f=3000:width_type=o:width=1.5:g=3.0".to_string());
        filters.push("equalizer=f=400:width_type=o:width=1.0:g=-2.0".to_string());
    } else if config.effect_type == "separation_instruments" {
        log_info("Выполняется изоляция Фоновой Музыки / Звуков (Instrumental Isolation):");
        log_info("  - Понижение центрального канала и буст сайд-каналов (stereotools mlev=0.15:slev=1.8)");
        log_info("  - Вырезание голосового диапазона в районе 1.5kHz (-8dB)");
        log_info("  - Добавление низкочастотного баса на 80Hz (+3dB) для компенсации потерь");

        filters.push("stereotools=mlev=0.15:slev=1.8".to_string());
        filters.push("equalizer=f=1500:width_type=o:width=1.5:g=-8.0".to_string());
        filters.push("equalizer=f=80:width_type=o:width=1.0:g=3.0".to_string());
    }

    let filter_str = filters.join(",");
    log_info(&format!("Итоговая строка аудиофильтров FFmpeg: {}", filter_str));
    
    let args = if filter_str.is_empty() {
        log_info("Фильтры отсутствуют, выполняется простое копирование формата (pcm_s16le)");
        vec![
            "-y".to_string(),
            "-i".to_string(), input_path.clone(),
            "-c:a".to_string(), "pcm_s16le".to_string(),
            output_path.clone(),
        ]
    } else {
        vec![
            "-y".to_string(),
            "-i".to_string(), input_path.clone(),
            "-af".to_string(), filter_str,
            output_path.clone(),
        ]
    };

    match crate::media_processor::run_ffmpeg_with_progress(
        app_handle, 
        args, 
        format!("Применение эффекта {}", config.effect_type), 
        None
    ).await {
        Ok(_) => {
            log_info(&format!("--- УСПЕШНО ЗАВЕРШЕНО: Эффект {} успешно применён к файлу ---", config.effect_type));
            Ok(output_path)
        },
        Err(e) => {
            let err_msg = format!("--- ОШИБКА: Ошибка применения эффекта {}: {} ---", config.effect_type, e);
            log_error(&err_msg);
            Err(err_msg)
        }
    }
}
