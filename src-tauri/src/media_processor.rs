// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE MEDIA PROCESSOR (RUST)
// ============================================================================
// Модуль реальных мультимедийных задач:
// 1. Аппаратный муксинг видео- и аудиоконтейнеров (MKV, MP4, WebM) с детекцией GPU.
// 2. Генерация легковесных прокси-видео для быстрого превью на таймлайне.
// 3. Извлечение дорожек субтитров (SRT, VTT, ASS) и аудиодорожек из контейнеров.
// 4. Сведение и склейка PCM аудиосегментов с генерацией пиков волноформы.
// 5. Маршрутизация задач DSP и нейросетевого инференса (UVR5 DeNoise / DeReverb)
//    без псевдо-фильтров эквализации.
// ============================================================================

use std::fs;
use std::path::{Path, PathBuf};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::db::AppState;
use crate::logger::{log_debug, log_error, log_info};
use crate::process_utils::CommandExtHide;
use crate::waveform_engine::generate_waveform_peaks;

#[derive(Serialize, Clone, Debug)]
pub struct MediaProgress {
    pub time: String,
    pub percent: f64,
    pub operation: String,
}

#[derive(Serialize, Debug)]
pub struct MergeResult {
    pub file_path: String,
    pub peaks: Vec<f32>,
    pub duration: f64,
}

#[derive(Deserialize, Debug)]
pub struct Segment {
    pub path: String,
    pub start_time: f64,
    pub duration: f64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioEffectConfig {
    pub effect_type: String, // "normalization", "declick", "smarteq", "denoise", "dereverb", "spectral_gate"
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
    #[allow(dead_code)]
    #[serde(rename = "separationModel")]
    pub separation_model: Option<String>,
}

// ============================================================================
// 1. ИСПОЛНИТЕЛЬ FFMPEG С ПРОГРЕСС-ТРЕКИНГОМ И ДЕТЕКЦИЕЙ АППАРАТНОГО УСКОРЕНИЯ
// ============================================================================

/// Запуск FFmpeg в режиме sidecar с разбором stderr в реальном времени и генерацией событий прогресса
pub(crate) async fn run_ffmpeg_with_progress(
    app_handle: AppHandle,
    args: Vec<String>,
    operation_name: String,
    duration_secs: Option<f64>,
) -> Result<(), String> {
    let mut shell_args = vec!["-hide_banner".to_string(), "-stats".to_string()];
    let normalized_args: Vec<String> = args
        .into_iter()
        .map(|arg| crate::file_io::normalize_windows_path(&arg))
        .collect();
    shell_args.extend(normalized_args);

    log_info(&format!(
        "Запуск FFmpeg Sidecar [{}] с аргументами: {:?}",
        operation_name, shell_args
    ));

    let sidecar_command = app_handle
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| {
            let err_msg = format!("Ошибка создания команды FFmpeg sidecar: {}", e);
            log_error(&err_msg);
            err_msg
        })?
        .args(&shell_args);

    let (mut rx, _child) = sidecar_command.spawn().map_err(|e| {
        let err_msg = format!("Ошибка запуска процесса FFmpeg: {}", e);
        log_error(&err_msg);
        err_msg
    })?;

    // Регулярное выражение для извлечения текущего времени обработки: time=00:00:00.00
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
                        if total > 0.0 {
                            (current_secs / total * 100.0).clamp(0.0, 100.0)
                        } else {
                            0.0
                        }
                    } else {
                        0.0
                    };

                    let _ = app_handle.emit(
                        "media-progress",
                        MediaProgress {
                            time: format!("{:02}:{:02}:{:02}", h as i32, m as i32, s as i32),
                            percent,
                            operation: operation_name.clone(),
                        },
                    );
                    let _ = app_handle.emit("export-progress", percent);
                }
            }
            CommandEvent::Stdout(line_bytes) => {
                let line = String::from_utf8_lossy(&line_bytes);
                log_info(&format!("[FFmpeg STDOUT] {}", line.trim_end()));
            }
            CommandEvent::Error(err) => {
                log_error(&format!("[FFmpeg Command Error] {}", err));
            }
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

/// Автоматическое определение поддерживаемого аппаратного видеокодека (NVENC, AMF, QSV, либо программный x264)
async fn get_hw_encoder(app_handle: &AppHandle) -> String {
    let output_result = app_handle
        .shell()
        .sidecar("ffmpeg")
        .map(|cmd| cmd.args(["-encoders"]));

    if let Ok(cmd) = output_result {
        if let Ok(out) = cmd.output().await {
            let out_str = String::from_utf8_lossy(&out.stdout);
            if out_str.contains("h264_nvenc") {
                return "h264_nvenc".to_string();
            }
            if out_str.contains("h264_amf") {
                return "h264_amf".to_string();
            }
            if out_str.contains("h264_qsv") {
                return "h264_qsv".to_string();
            }
        }
    }
    "libx264".to_string()
}

// ============================================================================
// 2. МУЛЬТИМЕДИЙНЫЕ ОПЕРАЦИИ: ПРОКСИ, МУКСИНГ, ИЗВЛЕЧЕНИЕ ПОТОКОВ
// ============================================================================

/// Объединение фоновых видеофрагментов бэкстейджа без повторного кодирования (stream copy)
#[tauri::command]
pub async fn concat_backstage_videos(
    video_paths: Vec<String>,
    output_path: String,
) -> Result<String, String> {
    if video_paths.is_empty() {
        return Err("Нет видеофайлов для объединения".to_string());
    }

    let mut file_list = String::new();
    for path in &video_paths {
        let norm = crate::file_io::normalize_windows_path(path);
        let escaped_path = norm.replace("'", "'\\''");
        file_list.push_str(&format!("file '{}'\n", escaped_path));
    }

    let out_norm = crate::file_io::normalize_windows_path(&output_path);
    let out_path = Path::new(&out_norm);
    let parent_dir = out_path.parent().unwrap_or(out_path);
    let temp_file_path = parent_dir.join(format!("backstage_list_{}.txt", std::process::id()));
    fs::write(&temp_file_path, file_list).map_err(|e| e.to_string())?;

    let ffmpeg_bin = crate::file_io::find_ffmpeg_path();
    let output = std::process::Command::new(&ffmpeg_bin)
        .hide_window()
        .args(&[
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            temp_file_path.to_str().unwrap(),
            "-c",
            "copy",
            &out_norm,
        ])
        .output()
        .map_err(|e| e.to_string())?;

    let _ = fs::remove_file(temp_file_path);

    if !output.status.success() {
        return Err(format!(
            "Ошибка конкатенации FFmpeg: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(out_norm)
}

/// Получение детальной технической информации о медиафайле через FFprobe (JSON)
#[tauri::command]
pub async fn get_media_info(app_handle: AppHandle, path: String) -> Result<String, String> {
    let normalized_path = crate::file_io::normalize_windows_path(&path);

    let sidecar_command = app_handle
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| format!("Ошибка создания команды FFprobe sidecar: {}", e))?
        .args(vec![
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &normalized_path,
        ]);

    let output = sidecar_command
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(err_msg);
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Извлечение дорожек видео, выбранного аудиопотока и дорожки субтитров из контейнера MKV/MP4
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
    let norm_input = crate::file_io::normalize_windows_path(&input_path);
    let norm_video = crate::file_io::normalize_windows_path(&video_output);

    let mut args = vec!["-y".to_string(), "-i".to_string(), norm_input];

    args.push("-map".to_string());
    args.push("0:v:0".to_string());

    args.push("-map".to_string());
    args.push(format!("0:{}", audio_index));

    args.push("-c:v".to_string());
    args.push("copy".to_string());
    args.push("-c:a".to_string());
    args.push("aac".to_string());
    args.push("-movflags".to_string());
    args.push("faststart".to_string());
    args.push(norm_video.clone());

    if let (Some(s_idx), Some(s_out)) = (sub_index, sub_output) {
        let norm_sub = crate::file_io::normalize_windows_path(&s_out);
        args.push("-map".to_string());
        args.push(format!("0:{}", s_idx));
        args.push("-c:s".to_string());
        if norm_sub.ends_with(".srt") {
            args.push("srt".to_string());
        } else if norm_sub.ends_with(".vtt") {
            args.push("webvtt".to_string());
        } else if norm_sub.ends_with(".ass") {
            args.push("ass".to_string());
        } else {
            args.push("copy".to_string());
        }
        args.push(norm_sub);
    }

    run_ffmpeg_with_progress(
        app_handle,
        args,
        "Извлечение медиапотоков MKV".to_string(),
        duration,
    )
    .await?;

    Ok(norm_video)
}

/// Создание оптимизированного прокси-видео 360p с ультрабыстрым пресетом для мгновенного скраббинга
#[tauri::command]
pub async fn create_proxy_video(
    app_handle: AppHandle,
    input_path: String,
    output_path: String,
    duration: Option<f64>,
) -> Result<String, String> {
    let norm_input = crate::file_io::normalize_windows_path(&input_path);
    let norm_output = crate::file_io::normalize_windows_path(&output_path);

    if Path::new(&norm_output).exists() {
        return Ok(norm_output);
    }

    let app_handle_spawn = app_handle.clone();
    let input_path_spawn = norm_input;
    let output_path_spawn = norm_output.clone();

    tokio::spawn(async move {
        let args = vec![
            "-y".to_string(),
            "-i".to_string(),
            input_path_spawn,
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "ultrafast".to_string(),
            "-crf".to_string(),
            "30".to_string(),
            "-vf".to_string(),
            "scale=-2:360".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "128k".to_string(),
            output_path_spawn.clone(),
        ];

        if let Err(e) = run_ffmpeg_with_progress(
            app_handle_spawn.clone(),
            args,
            "Генерация прокси-видео".to_string(),
            duration,
        )
        .await
        {
            log_error(&format!("Ошибка FFmpeg при создании прокси-видео: {}", e));
            let _ = app_handle_spawn.emit("proxy-error", e);
        } else {
            let _ = app_handle_spawn.emit("proxy-ready", &output_path_spawn);
        }
    });

    Ok("Generating".to_string())
}

/// Аппаратный или прямой муксинг видеопотока с мастер-аудиодорожкой
#[tauri::command]
pub async fn mux_video(
    app_handle: AppHandle,
    video_input: String,
    audio_input: String,
    output_path: String,
    duration: Option<f64>,
) -> Result<String, String> {
    let norm_video = crate::file_io::normalize_windows_path(&video_input);
    let norm_audio = crate::file_io::normalize_windows_path(&audio_input);
    let norm_output = crate::file_io::normalize_windows_path(&output_path);

    let args = vec![
        "-y".to_string(),
        "-i".to_string(),
        norm_video,
        "-i".to_string(),
        norm_audio,
        "-c:v".to_string(),
        "copy".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "1:a:0".to_string(),
        "-shortest".to_string(),
        "-movflags".to_string(),
        "faststart".to_string(),
        norm_output.clone(),
    ];

    run_ffmpeg_with_progress(
        app_handle,
        args,
        "Муксинг видео и аудио".to_string(),
        duration,
    )
    .await?;

    Ok(norm_output)
}

/// Создание черного тестового видео с тишиной заданной длительности
#[tauri::command]
pub async fn create_blank_video(duration: f64, output_path: String) -> Result<String, String> {
    let norm_output = crate::file_io::normalize_windows_path(&output_path);
    let ffmpeg_bin = crate::file_io::find_ffmpeg_path();
    let output = std::process::Command::new(&ffmpeg_bin)
        .hide_window()
        .args(&[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=1280x720:r=24",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=cl=mono:r=48000",
            "-t",
            &duration.to_string(),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            &norm_output,
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!(
            "Ошибка создания тестового видео FFmpeg: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(norm_output)
}

/// Финальный рендеринг видео с балансировкой громкости оригинальной дорожки и дубляжа
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
    let norm_video = crate::file_io::normalize_windows_path(&original_video);
    let norm_dub = crate::file_io::normalize_windows_path(&master_dub);
    let norm_output = crate::file_io::normalize_windows_path(&output_path);

    log_debug(&format!("Рендеринг финального видео в: {}", norm_output));
    let encoder = get_hw_encoder(&app_handle).await;

    let filter = format!(
        "[0:a]volume={}[bg]; [1:a]volume={}[dub]; [bg][dub]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]",
        bg_volume, dub_volume
    );

    let args = vec![
        "-y".to_string(),
        "-i".to_string(),
        norm_video,
        "-i".to_string(),
        norm_dub,
        "-filter_complex".to_string(),
        filter,
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "[a]".to_string(),
        "-c:v".to_string(),
        encoder,
        "-c:a".to_string(),
        "aac".to_string(),
        "-metadata".to_string(),
        format!("title={}", title),
        "-metadata".to_string(),
        format!("artist={}", artist),
        norm_output.clone(),
    ];

    run_ffmpeg_with_progress(
        app_handle,
        args,
        "Финальный рендеринг видео".to_string(),
        None,
    )
    .await?;

    Ok(norm_output)
}

// ============================================================================
// 3. СВЕДЕНИЕ СЕГМЕНТОВ И PCM СШИВКА С ТОЧНОСТЬЮ ДО СЭМПЛА
// ============================================================================

/// Объединение выбранных аудиосегментов на дорожке с обновлением базы данных SQLite и генерацией пиков
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
    let pool = mutex.as_ref().ok_or("База данных не инициализирована")?;

    let mut file_paths = Vec::new();
    let mut total_duration = 0.0;
    let mut min_start_time = f64::MAX;

    for id in &segment_ids {
        let mut row = sqlx::query("SELECT file_path, duration, start_time FROM audio_segments WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

        if row.is_none() {
            row = sqlx::query("SELECT file_path, duration, start_time FROM segments WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        }

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
        return Err("Не найдены корректные сегменты для объединения".to_string());
    }

    let out_norm = crate::file_io::normalize_windows_path(&output_path);
    let out_path = Path::new(&out_norm);
    let parent_dir = out_path.parent().unwrap_or(out_path);
    let concat_file_path = parent_dir.join(format!("concat_{}.txt", project_id));
    let mut concat_content = String::new();
    for p in &file_paths {
        let p_norm = crate::file_io::normalize_windows_path(p);
        let escaped = p_norm.replace("'", "'\\''");
        concat_content.push_str(&format!("file '{}'\n", escaped));
    }

    fs::write(&concat_file_path, concat_content).map_err(|e| e.to_string())?;

    let args = vec![
        "-y".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        concat_file_path.to_str().unwrap().to_string(),
        "-c".to_string(),
        "copy".to_string(),
        out_norm.clone(),
    ];

    run_ffmpeg_with_progress(
        app_handle.clone(),
        args,
        "Объединение аудиосегментов".to_string(),
        Some(total_duration),
    )
    .await?;

    let peaks = generate_waveform_peaks(app_handle.clone(), out_norm.clone(), 1024).await?;

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    for id in &segment_ids {
        sqlx::query("DELETE FROM audio_segments WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

        sqlx::query("DELETE FROM segments WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

        sqlx::query("DELETE FROM audio_clips WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    let new_seg_id = format!("merged_{}", uuid::Uuid::new_v4());

    sqlx::query("
        INSERT INTO audio_segments (id, track_id, start_time, duration, file_offset, file_duration, file_path, gain, is_active)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
    ")
    .bind(&new_seg_id)
    .bind(&track_id)
    .bind(min_start_time)
    .bind(total_duration)
    .bind(0.0)
    .bind(total_duration)
    .bind(&out_norm)
    .bind(1.0)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

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
    .bind(&out_norm)
    .bind(1.0)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    let _ = fs::remove_file(concat_file_path);

    Ok(MergeResult {
        file_path: out_norm,
        peaks,
        duration: total_duration,
    })
}

/// Точная поканальная PCM-сшивка аудиосегментов проекта с заполнением пауз нулевыми сэмплами
#[tauri::command]
pub async fn merge_project_segments(
    segments: Vec<Segment>,
    total_duration: f64,
    output_path: String,
) -> Result<String, String> {
    use hound::{WavReader, WavWriter};

    if segments.is_empty() {
        return Err("Нет сегментов для сведения".to_string());
    }

    let mut sorted_segments = segments;
    sorted_segments.sort_by(|a, b| a.start_time.partial_cmp(&b.start_time).unwrap());

    let first_valid_path = sorted_segments
        .iter()
        .find(|s| Path::new(&s.path).exists())
        .ok_or("Не найдены валидные аудиофайлы сегментов на диске")?;

    let reader = WavReader::open(&first_valid_path.path)
        .map_err(|e| format!("Ошибка открытия эталонного аудиосегмента: {}", e))?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;

    let out_norm = crate::file_io::normalize_windows_path(&output_path);
    let mut writer = WavWriter::create(&out_norm, spec)
        .map_err(|e| format!("Ошибка создания выходного мастер-файла WAV: {}", e))?;

    let mut current_pos_samples: u64 = 0;

    for seg in sorted_segments {
        let seg_start_samples = (seg.start_time * sample_rate as f64) as u64;

        if seg_start_samples > current_pos_samples {
            let silence_len = seg_start_samples - current_pos_samples;
            for _ in 0..silence_len {
                writer.write_sample(0i16).map_err(|e| e.to_string())?;
            }
            current_pos_samples = seg_start_samples;
        }

        if let Ok(mut seg_reader) = WavReader::open(&seg.path) {
            for sample in seg_reader.samples::<i16>() {
                let s = sample.map_err(|e| e.to_string())?;
                writer.write_sample(s).map_err(|e| e.to_string())?;
                current_pos_samples += 1;
            }
        } else {
            let dur_samples = (seg.duration * sample_rate as f64) as u64;
            for _ in 0..dur_samples {
                writer.write_sample(0i16).map_err(|e| e.to_string())?;
            }
            current_pos_samples += dur_samples;
        }
    }

    let total_samples = (total_duration * sample_rate as f64) as u64;
    if total_samples > current_pos_samples {
        let remaining = total_samples - current_pos_samples;
        for _ in 0..remaining {
            writer.write_sample(0i16).map_err(|e| e.to_string())?;
        }
    }

    writer.finalize().map_err(|e| e.to_string())?;
    Ok(out_norm)
}

// ============================================================================
// 4. МАРШРУТИЗАЦИЯ ЭФФЕКТОВ И НАСТОЯЩИЙ НЕЙРОСЕТЕВОЙ / DSP ИНФЕРЕНС
// ============================================================================

/// Применение аудиоэффекта:
/// 1. Все нейросетевые задачи (шумоподавление, дереверберация) направляются
///    в нативные ONNX Runtime пайплайны (`uvr_denoise`, `uvr_dereverb`).
/// 2. Задачи разделения источников звука исключены из псевдо-фильтров и должны
///    вызываться через модуль `source_separation::separate_audio_stems`.
/// 3. Алгоритмическое шумоподавление доступно строго через явный профиль `spectral_gate`.
#[tauri::command]
pub async fn apply_audio_effect(
    app_handle: AppHandle,
    input_path: String,
    output_path: String,
    config: AudioEffectConfig,
) -> Result<String, String> {
    let norm_input = crate::file_io::normalize_windows_path(&input_path);
    let norm_output = crate::file_io::normalize_windows_path(&output_path);

    log_info(&format!(
        "--- [apply_audio_effect] Запуск обработки аудио ---\nВходной файл: {}\nВыходной файл: {}\nТип операции: {}",
        norm_input, norm_output, config.effect_type
    ));

    // Запрет псевдо-разделения в apply_audio_effect:
    if config.effect_type == "separation" || config.effect_type == "separation_instruments" {
        return Err(
            "Разделение источников (Вокал / Инструменты) выполняется исключительно через нейросетевой инференс Demucs / UVR5 в модуле source_separation::separate_audio_stems".to_string()
        );
    }

    // 1. Нейросетевое шумоподавление UVR / RNNoise (ONNX Runtime)
    if config.effect_type == "denoise" {
        let model = config.denoise_model.clone().unwrap_or_default();
        let is_algorithmic = model == "spectral_gate" || model == "afftdn" || model == "algorithmic";

        if is_algorithmic {
            log_info("Выбран алгоритмический Spectral Gate шумоподавитель (FFmpeg afftdn)");
            let args = vec![
                "-y".to_string(),
                "-i".to_string(),
                norm_input.clone(),
                "-af".to_string(),
                "afftdn=nf=-25:om=o:tn=1".to_string(),
                norm_output.clone(),
            ];
            run_ffmpeg_with_progress(
                app_handle,
                args,
                "Алгоритмический Spectral Gate".to_string(),
                None,
            )
            .await?;
            return Ok(norm_output);
        }

        log_info(&format!(
            "Вызов реального нейросетевого шумоподавления UVR DeNoise (ONNX Runtime): {:?}",
            config.denoise_model
        ));
        let strength = config.denoise_strength.map(|s| (s / 100.0) as f32);

        let report = crate::uvr_denoise::process_denoise(
            app_handle,
            norm_input.clone(),
            norm_output.clone(),
            config.denoise_model,
            strength,
        )
        .await?;

        if report.processed_path != norm_output && Path::new(&report.processed_path).exists() {
            fs::copy(&report.processed_path, &norm_output)
                .map_err(|e| format!("Не удалось скопировать очищенный файл в {}: {}", norm_output, e))?;
        }
        return Ok(norm_output);
    }

    // 2. Нейросетевое удаление реверберации и комнатного эха UVR DeReverb (ONNX Runtime)
    if config.effect_type == "dereverb" || config.effect_type == "deecho" {
        log_info(&format!(
            "Вызов реального нейросетевого деревербератора UVR DeReverb (ONNX Runtime): {:?}",
            config.dereverb_model
        ));
        let strength = config.dereverb_strength.map(|s| (s / 100.0) as f32);

        let report = crate::uvr_dereverb::process_uvr_dereverb(
            app_handle,
            norm_input.clone(),
            norm_output.clone(),
            None,
            strength,
            config.dereverb_model,
        )
        .await?;

        if report.dry_vocal_path != norm_output && Path::new(&report.dry_vocal_path).exists() {
            fs::copy(&report.dry_vocal_path, &norm_output)
                .map_err(|e| format!("Не удалось скопировать сухой вокал в {}: {}", norm_output, e))?;
        }
        return Ok(norm_output);
    }

    // 3. Честные студийные алгоритмы DSP (Нормализация, Declick, SmartEQ)
    let mut filters = Vec::new();

    if config.effect_type == "normalization" {
        log_info("Применение стандартной EBU R128 нормализации и динамического компрессора:");
        if let (Some(thresh), Some(gain), Some(ratio)) = (
            config.upward_threshold,
            config.upward_gain,
            config.upward_ratio,
        ) {
            filters.push(format!(
                "acompressor=threshold={}dB:ratio={}:makeup={}dB:attack=5:release=50",
                thresh, ratio, gain
            ));
        }
        let lufs = config.target_lufs.unwrap_or(-16.0);
        filters.push(format!("loudnorm=I={}:TP=-1.5:LRA=11", lufs));
    } else if config.effect_type == "declick" {
        let sens = config.sensitivity.unwrap_or(50.0);
        let threshold = (10.0 - (sens / 100.0) * 9.0).clamp(0.1, 15.0);
        let window = (config.max_click_width_ms.unwrap_or(2.0) * 10.0).clamp(1.0, 100.0);
        log_info(&format!(
            "Применение студийного Declick: чувствительность {}, порог {}, окно {}",
            sens, threshold, window
        ));
        filters.push(format!(
            "adeclick=window={}:overlap=75:arorder=2:threshold={}:burst=2:method=a",
            window as u32, threshold
        ));
    } else if config.effect_type == "smarteq" {
        let profile = config.eq_profile.unwrap_or_else(|| "flat".to_string());
        log_info(&format!("Применение SmartEQ профиля: {}", profile));

        match profile.as_str() {
            "vocal_presence" => {
                filters.push("highpass=f=80:width_type=h:width=24".to_string());
                filters.push("equalizer=f=400:width_type=o:width=1:g=-3".to_string());
                filters.push("equalizer=f=4000:width_type=o:width=1:g=3".to_string());
                filters.push("equalizer=f=8000:width_type=o:width=1:g=2".to_string());
                filters.push("deesser=i=0.5:m=0.5:f=0.5:s=o".to_string());
            }
            "warm_analog" => {
                filters.push("highpass=f=60:width_type=h:width=24".to_string());
                filters.push("equalizer=f=150:width_type=o:width=1:g=2".to_string());
                filters.push("equalizer=f=2000:width_type=o:width=1:g=-2".to_string());
                filters.push("compand=attacks=0:points=-80/-80|-20/-20|0/-10".to_string());
            }
            "reference_match" => {
                filters.push("highpass=f=80:width_type=h:width=24".to_string());
                filters.push("equalizer=f=250:width_type=o:width=1:g=-2".to_string());
                filters.push("equalizer=f=2500:width_type=o:width=1.5:g=2".to_string());
                filters.push("equalizer=f=6000:width_type=o:width=1:g=4".to_string());
                filters.push("acompressor=threshold=-15dB:ratio=4:attack=5:release=50:makeup=4".to_string());
            }
            "flat" | _ => {
                filters.push("highpass=f=40".to_string());
            }
        }
    }

    let filter_str = filters.join(",");
    let args = if filter_str.is_empty() {
        vec![
            "-y".to_string(),
            "-i".to_string(),
            norm_input.clone(),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
            norm_output.clone(),
        ]
    } else {
        vec![
            "-y".to_string(),
            "-i".to_string(),
            norm_input.clone(),
            "-af".to_string(),
            filter_str,
            norm_output.clone(),
        ]
    };

    run_ffmpeg_with_progress(
        app_handle,
        args,
        format!("Применение DSP эффекта: {}", config.effect_type),
        None,
    )
    .await?;

    Ok(norm_output)
}

/// Обработка мастеринговой DSP цепочки дорожки (нормализация, эквализация, компрессия)
#[tauri::command]
pub async fn process_media_effect(
    app_handle: AppHandle,
    input_path: String,
    output_path: String,
    effect_type: String,
    params: Option<serde_json::Value>,
) -> Result<String, String> {
    let in_norm = crate::file_io::normalize_windows_path(&input_path);
    let out_norm = crate::file_io::normalize_windows_path(&output_path);

    log_info(&format!(
        "[process_media_effect] ▶ Тип: {}, Вход: {}, Выход: {}",
        effect_type, in_norm, out_norm
    ));

    if effect_type == "normalize" || effect_type == "normalization" {
        let target_lufs = params
            .as_ref()
            .and_then(|p| p.get("targetLufs").or_else(|| p.get("target_lufs")))
            .and_then(|v| v.as_f64())
            .unwrap_or(-16.0);

        let in_buf = PathBuf::from(&in_norm);
        let out_buf = PathBuf::from(&out_norm);
        return tokio::task::spawn_blocking(move || {
            crate::normalization::process_normalization(&in_buf, &out_buf, target_lufs)
                .map(|s| s.output_path)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let mut filters = Vec::new();

    if effect_type == "vocal_dsp_chain" || effect_type == "eq_comp" {
        let low_cut = params
            .as_ref()
            .and_then(|p| p.get("lowCut").or_else(|| p.get("low_cut")))
            .and_then(|v| v.as_f64())
            .unwrap_or(80.0);
        let high_cut = params
            .as_ref()
            .and_then(|p| p.get("highCut").or_else(|| p.get("high_cut")))
            .and_then(|v| v.as_f64())
            .unwrap_or(18000.0);
        let mid_gain_db = params
            .as_ref()
            .and_then(|p| p.get("midGainDb").or_else(|| p.get("mid_gain_db")))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let comp_threshold = params
            .as_ref()
            .and_then(|p| p.get("compThreshold").or_else(|| p.get("comp_threshold")))
            .and_then(|v| v.as_f64())
            .unwrap_or(-18.0);
        let comp_ratio = params
            .as_ref()
            .and_then(|p| p.get("compRatio").or_else(|| p.get("comp_ratio")))
            .and_then(|v| v.as_f64())
            .unwrap_or(3.0);

        if low_cut > 15.0 {
            filters.push(format!("highpass=f={}", low_cut));
        }
        if high_cut < 22000.0 {
            filters.push(format!("lowpass=f={}", high_cut));
        }
        if mid_gain_db.abs() > 0.05 {
            filters.push(format!(
                "equalizer=f=3000:width_type=o:width=1.5:g={}",
                mid_gain_db
            ));
        }
        if comp_ratio > 1.05 {
            filters.push(format!(
                "acompressor=threshold={}dB:ratio={}:attack=10:release=100:makeup=2",
                comp_threshold, comp_ratio
            ));
        }
    }

    let filter_str = filters.join(",");
    let args = if filter_str.is_empty() {
        vec![
            "-y".to_string(),
            "-i".to_string(),
            in_norm.clone(),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
            out_norm.clone(),
        ]
    } else {
        vec![
            "-y".to_string(),
            "-i".to_string(),
            in_norm.clone(),
            "-af".to_string(),
            filter_str,
            out_norm.clone(),
        ]
    };

    run_ffmpeg_with_progress(
        app_handle,
        args,
        format!("Применение DSP эффекта: {}", effect_type),
        None,
    )
    .await?;

    Ok(out_norm)
}
