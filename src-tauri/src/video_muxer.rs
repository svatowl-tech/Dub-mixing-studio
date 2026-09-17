// ============================================================================
// DUB MIXING STUDIO PRO - FINAL VIDEO CONTAINER MUXER & ENCODER (RUST)
// Модуль 4.5: Финальный сборщик видеоконтейнера (MP4/MKV) через FFmpeg
// Стек: tokio::process::Command, tauri = "2.2", serde = "1.0"
// ============================================================================

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::db::AppState;
use crate::file_io::{find_ffmpeg_path, normalize_windows_path};
use crate::logger::{log_debug, log_error, log_info};

// ============================================================================
// КОНФИГУРАЦИЯ И СТРУКТУРЫ ДАННЫХ
// ============================================================================

/// Конфигурация для аудиодорожки внутри контейнера
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackOption {
    /// Путь к аудиофайлу
    pub file_path: String,
    /// Название дорожки (например, "Дубляж [Студия]")
    pub title: String,
    /// ISO 639-2 код языка (например, "rus", "eng", "und")
    pub language: String,
    /// Кодек: "aac", "flac", "ac3", "copy"
    pub codec: Option<String>,
    /// Битрейт в кбит/с (для aac, например 320)
    pub bitrate_kbps: Option<u32>,
    /// Флаг дорожки по умолчанию
    pub is_default: Option<bool>,
}

/// Конфигурация дорожки субтитров (Soft Sub)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrackOption {
    /// Путь к файлу субтитров (.ass или .srt)
    pub file_path: String,
    /// Название дорожки (например, "Надписи и песни", "Полные субтитры")
    pub title: String,
    /// ISO 639-2 код языка (например, "rus")
    pub language: String,
    /// Являются ли субтитры форсированными (только надписи)
    pub is_forced: Option<bool>,
    /// Флаг дорожки по умолчанию
    pub is_default: Option<bool>,
}

/// Опции видео-энкодера и мультиплексирования
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMuxOptions {
    /// Формат контейнера: "mp4", "mkv", "mov"
    pub container: String,
    /// Кодек видео: "copy", "libx264", "h264_nvenc", "hevc_nvenc", "libx265"
    pub video_codec: String,
    /// Пресет кодирования: "ultrafast", "fast", "medium", "slow", "p4", "p7"
    pub preset: Option<String>,
    /// Constant Rate Factor (CRF: 16..28) для libx264/libx265
    pub crf: Option<u32>,
    /// Целевой битрейт видео в кбит/с (при отключенном CRF)
    pub video_bitrate_kbps: Option<u32>,
    /// Разрешение: "source", "1080p", "720p", "4k"
    pub resolution: Option<String>,
    /// Кадровая частота: "source", "23.976", "24", "25", "29.97", "30", "60"
    pub fps: Option<String>,
    /// Аппаратное ускорение: "auto", "cuda", "qsv", "none"
    pub hwaccel: Option<String>,
    /// Точный диапазон рендера: время старта в секундах
    pub start_time_sec: Option<f64>,
    /// Точный диапазон рендера: продолжительность в секундах
    pub duration_sec: Option<f64>,
}

impl Default for VideoMuxOptions {
    fn default() -> Self {
        Self {
            container: "mkv".to_string(),
            video_codec: "copy".to_string(),
            preset: Some("medium".to_string()),
            crf: Some(18),
            video_bitrate_kbps: Some(8000),
            resolution: Some("source".to_string()),
            fps: Some("source".to_string()),
            hwaccel: Some("auto".to_string()),
            start_time_sec: None,
            duration_sec: None,
        }
    }
}

/// Запрос на сборку финального видео
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalRenderRequest {
    /// ID проекта
    pub project_id: String,
    /// Исходный видеофайл
    pub source_video_path: String,
    /// Целевой выходной файл (.mp4 или .mkv)
    pub output_file_path: String,
    /// Список аудиодорожек для упаковки в контейнер
    pub audio_tracks: Vec<AudioTrackOption>,
    /// Список субтитров для упаковки
    pub subtitle_tracks: Option<Vec<SubtitleTrackOption>>,
    /// Параметры видео и кодирования
    pub video_options: VideoMuxOptions,
    /// Общая продолжительность в секундах (для вычисления прогресса)
    pub total_duration_seconds: Option<f64>,
}

/// Прогресс рендера в реальном времени, отправляемый на фронтенд
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalRenderProgress {
    /// Процент завершения (0.0 .. 100.0)
    pub progress_percent: f32,
    /// Текущее время обработки (секунды)
    pub current_time_sec: f64,
    /// Общая длительность (секунды)
    pub total_duration_sec: f64,
    /// Скорость обработки (например, 2.4x или 18.5x при copy)
    pub speed: String,
    /// Текущий FPS рендера
    pub fps: f32,
    /// Текущий размер файла (байты)
    pub size_bytes: u64,
    /// Битрейт вывода (кбит/с)
    pub bitrate_kbps: f32,
    /// Статус этапа
    pub stage_description: String,
    /// Оставшееся расчетное время (ETA в секундах)
    pub eta_seconds: f64,
    /// Затраченное время с момента старта (секунды)
    pub elapsed_seconds: f64,
}

/// Результат финального рендера
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalRenderOutput {
    pub success: bool,
    pub output_file_path: String,
    pub file_size_bytes: u64,
    pub duration_seconds: f64,
    pub container: String,
    pub audio_tracks_count: usize,
    pub subtitle_tracks_count: usize,
    pub elapsed_ms: u64,
    pub average_speed: String,
    pub message: String,
}

// ============================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ И ПАРСИНГ FFMPEG
// ============================================================================

/// Парсинг строки времени FFmpeg "HH:MM:SS.ms" в секунды f64
fn parse_ffmpeg_time(time_str: &str) -> Option<f64> {
    let parts: Vec<&str> = time_str.trim().split(':').collect();
    if parts.len() == 3 {
        let hours: f64 = parts[0].parse().ok()?;
        let minutes: f64 = parts[1].parse().ok()?;
        let seconds: f64 = parts[2].parse().ok()?;
        Some(hours * 3600.0 + minutes * 60.0 + seconds)
    } else {
        None
    }
}

/// Получение длительности медиафайла через ffprobe
async fn probe_media_duration_seconds(file_path: &str) -> Option<f64> {
    let ffmpeg_bin = find_ffmpeg_path();
    let ffprobe_bin = if ffmpeg_bin.ends_with("ffmpeg.exe") {
        ffmpeg_bin.replace("ffmpeg.exe", "ffprobe.exe")
    } else if ffmpeg_bin.ends_with("ffmpeg") {
        ffmpeg_bin.replace("ffmpeg", "ffprobe")
    } else {
        "ffprobe".to_string()
    };

    let mut cmd = Command::new(&ffprobe_bin);
    cmd.arg("-v").arg("error")
        .arg("-show_entries").arg("format=duration")
        .arg("-of").arg("default=noprint_wrappers=1:nokey=1")
        .arg(file_path);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Ok(output) = cmd.output().await {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Ok(dur) = s.parse::<f64>() {
                return Some(dur);
            }
        }
    }
    None
}

// ============================================================================
// ЯДРО КОНВЕЙЕРА МУЛЬТИПЛЕКСИРОВАНИЯ И КОДИРОВАНИЯ
// ============================================================================

pub struct VideoMuxEngine;

impl VideoMuxEngine {
    /// Построение и запуск FFmpeg команды с потоковым разбором прогресса
    pub async fn execute_render(
        app_handle: AppHandle,
        request: FinalRenderRequest,
    ) -> Result<FinalRenderOutput, String> {
        let start_time = Instant::now();
        let ffmpeg_bin = find_ffmpeg_path();

        let source_video_norm = normalize_windows_path(&request.source_video_path);
        let output_file_norm = normalize_windows_path(&request.output_file_path);

        let video_path = Path::new(&source_video_norm);
        if !video_path.exists() {
            return Err(format!("Исходный видеофайл не найден: {}", source_video_norm));
        }

        // 1. Создаем целевую директорию при необходимости
        if let Some(parent) = Path::new(&output_file_norm).parent() {
            let _ = fs::create_dir_all(parent);
        }

        // 2. Определение общей длительности видео для точного прогресс-бара
        let total_duration = if let Some(d) = request.total_duration_seconds {
            d
        } else if let Some(d) = probe_media_duration_seconds(&source_video_norm).await {
            d
        } else {
            300.0 // 5 минут по умолчанию
        };

        log_info(&format!(
            "[VideoMuxEngine] Старт рендера. Видео: '{}', Выход: '{}', Длительность: {:.2}s",
            source_video_norm, output_file_norm, total_duration
        ));

        // 3. Формирование аргументов FFmpeg
        let mut cmd = Command::new(&ffmpeg_bin);
        cmd.arg("-y"); // Перезапись без запроса

        // Добавляем прогресс в машиночитаемом формате
        cmd.arg("-progress").arg("pipe:1");
        cmd.arg("-nostats");

        // Вход 0: Исходное видео
        cmd.arg("-i").arg(&source_video_norm);

        // Входы 1..N: Аудиодорожки
        let mut input_index = 1;
        let mut valid_audio_tracks = Vec::new();

        for track in &request.audio_tracks {
            let norm_path = normalize_windows_path(&track.file_path);
            if Path::new(&norm_path).exists() {
                cmd.arg("-i").arg(&norm_path);
                valid_audio_tracks.push((input_index, track.clone()));
                input_index += 1;
            } else {
                log_error(&format!("[VideoMuxEngine] Аудиофайл дорожки не найден: {}", norm_path));
            }
        }

        // Входы (N+1)..M: Дорожки субтитров
        let mut valid_subtitle_tracks = Vec::new();
        if let Some(sub_tracks) = &request.subtitle_tracks {
            for sub in sub_tracks {
                let norm_path = normalize_windows_path(&sub.file_path);
                if Path::new(&norm_path).exists() {
                    cmd.arg("-i").arg(&norm_path);
                    valid_subtitle_tracks.push((input_index, sub.clone()));
                    input_index += 1;
                }
            }
        }

        // 4. Маппинг видеопотока (-map 0:v:0)
        cmd.arg("-map").arg("0:v:0");

        // 5. Настройка видеокодека
        let v_codec = request.video_options.video_codec.to_lowercase();
        if v_codec == "copy" {
            cmd.arg("-c:v").arg("copy");
        } else {
            // Перекодирование видео
            let actual_codec = match v_codec.as_str() {
                "h264_nvenc" => "h264_nvenc",
                "hevc_nvenc" | "h265_nvenc" => "hevc_nvenc",
                "libx265" | "hevc" => "libx265",
                _ => "libx264",
            };
            cmd.arg("-c:v").arg(actual_codec);

            // Пресет
            if let Some(preset) = &request.video_options.preset {
                cmd.arg("-preset").arg(preset);
            }

            // Качество (CRF или битрейт)
            if actual_codec == "libx264" || actual_codec == "libx265" {
                let crf = request.video_options.crf.unwrap_or(18);
                cmd.arg("-crf").arg(crf.to_string());
                cmd.arg("-pix_fmt").arg("yuv420p");
            } else {
                // Для NVENC используем битрейт
                let bitrate = request.video_options.video_bitrate_kbps.unwrap_or(8000);
                cmd.arg("-b:v").arg(format!("{}k", bitrate));
                cmd.arg("-maxrate").arg(format!("{}k", bitrate * 3 / 2));
                cmd.arg("-bufsize").arg(format!("{}k", bitrate * 2));
            }

            // Масштабирование разрешения
            if let Some(res) = &request.video_options.resolution {
                match res.as_str() {
                    "1080p" => { cmd.arg("-vf").arg("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"); },
                    "720p" => { cmd.arg("-vf").arg("scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2"); },
                    "4k" => { cmd.arg("-vf").arg("scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2"); },
                    _ => {}
                }
            }

            // FPS
            if let Some(fps) = &request.video_options.fps {
                if fps != "source" {
                    cmd.arg("-r").arg(fps);
                }
            }
        }

        // 6. Маппинг и метаданные аудиодорожек
        for (out_a_idx, (in_idx, track_opt)) in valid_audio_tracks.iter().enumerate() {
            cmd.arg("-map").arg(format!("{}:a:0", in_idx));

            let a_codec = track_opt.codec.as_deref().unwrap_or("aac");
            match a_codec {
                "copy" => {
                    cmd.arg(format!("-c:a:{}", out_a_idx)).arg("copy");
                }
                "flac" => {
                    cmd.arg(format!("-c:a:{}", out_a_idx)).arg("flac");
                }
                "ac3" => {
                    let b = track_opt.bitrate_kbps.unwrap_or(384);
                    cmd.arg(format!("-c:a:{}", out_a_idx)).arg("ac3");
                    cmd.arg(format!("-b:a:{}", out_a_idx)).arg(format!("{}k", b));
                }
                _ => {
                    // AAC по умолчанию
                    let b = track_opt.bitrate_kbps.unwrap_or(320);
                    cmd.arg(format!("-c:a:{}", out_a_idx)).arg("aac");
                    cmd.arg(format!("-b:a:{}", out_a_idx)).arg(format!("{}k", b));
                }
            }

            // Метаданные: Название дорожки и Язык
            cmd.arg(format!("-metadata:s:a:{}", out_a_idx))
                .arg(format!("title={}", track_opt.title));
            cmd.arg(format!("-metadata:s:a:{}", out_a_idx))
                .arg(format!("language={}", track_opt.language));

            // Флаги Disposition (default)
            if track_opt.is_default.unwrap_or(out_a_idx == 0) {
                cmd.arg(format!("-disposition:a:{}", out_a_idx)).arg("default");
            } else {
                cmd.arg(format!("-disposition:a:{}", out_a_idx)).arg("0");
            }
        }

        // 7. Маппинг и метаданные субтитров
        for (out_s_idx, (in_idx, sub_opt)) in valid_subtitle_tracks.iter().enumerate() {
            cmd.arg("-map").arg(format!("{}:s:0?", in_idx));

            let container_lower = request.video_options.container.to_lowercase();
            if container_lower == "mkv" {
                if sub_opt.file_path.ends_with(".ass") {
                    cmd.arg(format!("-c:s:{}", out_s_idx)).arg("ass");
                } else {
                    cmd.arg(format!("-c:s:{}", out_s_idx)).arg("srt");
                }
            } else {
                // Для MP4 используется mov_text
                cmd.arg(format!("-c:s:{}", out_s_idx)).arg("mov_text");
            }

            cmd.arg(format!("-metadata:s:s:{}", out_s_idx))
                .arg(format!("title={}", sub_opt.title));
            cmd.arg(format!("-metadata:s:s:{}", out_s_idx))
                .arg(format!("language={}", sub_opt.language));

            let mut disposition = String::new();
            if sub_opt.is_default.unwrap_or(false) {
                disposition.push_str("default");
            }
            if sub_opt.is_forced.unwrap_or(false) {
                if !disposition.is_empty() { disposition.push('+'); }
                disposition.push_str("forced");
            }
            if !disposition.is_empty() {
                cmd.arg(format!("-disposition:s:{}", out_s_idx)).arg(disposition);
            }
        }

        // 8. Глобальные метаданные контейнера
        cmd.arg("-metadata").arg("encoder=DubStudio Pro DAW Video Engine 1.1");

        // Для MP4 перемещаем moov atom в начало файла для мгновенного веб-воспроизведения (FastStart)
        if request.video_options.container.to_lowercase() == "mp4" || output_file_norm.ends_with(".mp4") {
            cmd.arg("-movflags").arg("+faststart");
        }

        cmd.arg(&output_file_norm);

        // 9. Скрытие окна консоли на Windows
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        log_debug(&format!("[VideoMuxEngine] Запуск процесса FFmpeg: {:?}", cmd));

        let mut child = cmd.spawn().map_err(|e| {
            format!("Не удалось запустить бинарник FFmpeg ({}): {}", ffmpeg_bin, e)
        })?;

        let stdout = child.stdout.take().ok_or_else(|| "Не удалось захватить stdout FFmpeg".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "Не удалось захватить stderr FFmpeg".to_string())?;

        let mut reader = BufReader::new(stdout).lines();
        let mut err_reader = BufReader::new(stderr).lines();

        // Буфер для накопления последних строк stderr на случай ошибки
        let stderr_log = Arc::new(tokio::sync::Mutex::new(VecDeque::<String>::with_capacity(50)));
        let stderr_log_clone = Arc::clone(&stderr_log);

        // Фоновая задача считывания stderr
        tokio::spawn(async move {
            while let Ok(Some(line)) = err_reader.next_line().await {
                let mut log = stderr_log_clone.lock().await;
                if log.len() >= 40 {
                    log.pop_front();
                }
                log.push_back(line);
            }
        });

        // 10. Парсинг вывода `-progress pipe:1` в реальном времени
        let mut cur_out_time_sec = 0.0;
        let mut cur_fps = 0.0f32;
        let mut cur_speed = "1.0x".to_string();
        let mut cur_size = 0u64;
        let mut cur_bitrate_kbps = 0.0f32;
        let mut last_emit = Instant::now();

        while let Ok(Some(line)) = reader.next_line().await {
            let line_trim = line.trim();
            if line_trim.is_empty() {
                continue;
            }

            if let Some((k, v)) = line_trim.split_once('=') {
                match k.trim() {
                    "out_time_us" => {
                        if let Ok(us) = v.trim().parse::<i64>() {
                            cur_out_time_sec = (us as f64) / 1_000_000.0;
                        }
                    }
                    "out_time" => {
                        if let Some(sec) = parse_ffmpeg_time(v) {
                            cur_out_time_sec = sec;
                        }
                    }
                    "fps" => {
                        if let Ok(f) = v.trim().parse::<f32>() {
                            cur_fps = f;
                        }
                    }
                    "speed" => {
                        cur_speed = v.trim().to_string();
                    }
                    "total_size" => {
                        if let Ok(sz) = v.trim().parse::<u64>() {
                            cur_size = sz;
                        }
                    }
                    "bitrate" => {
                        let b_str = v.trim().trim_end_matches("kbits/s").trim();
                        if let Ok(b) = b_str.parse::<f32>() {
                            cur_bitrate_kbps = b;
                        }
                    }
                    "progress" => {
                        let is_end = v.trim() == "end";
                        let progress_pct = if is_end {
                            100.0
                        } else if total_duration > 0.0 {
                            ((cur_out_time_sec / total_duration) * 100.0).clamp(0.0, 99.5) as f32
                        } else {
                            50.0
                        };

                        let elapsed = start_time.elapsed().as_secs_f64();
                        let eta = if progress_pct > 0.0 && progress_pct < 100.0 {
                            (elapsed / (progress_pct as f64 / 100.0)) - elapsed
                        } else {
                            0.0
                        };

                        if last_emit.elapsed().as_millis() > 120 || is_end {
                            let _ = app_handle.emit(
                                "final-render-progress",
                                FinalRenderProgress {
                                    progress_percent: progress_pct,
                                    current_time_sec: cur_out_time_sec,
                                    total_duration_sec: total_duration,
                                    speed: cur_speed.clone(),
                                    fps: cur_fps,
                                    size_bytes: cur_size,
                                    bitrate_kbps: cur_bitrate_kbps,
                                    stage_description: if v_codec == "copy" {
                                        format!("Мгновенный мультиплексинг потоков ({})", cur_speed)
                                    } else {
                                        format!("Кодирование видео ({}, {:.1} fps)", cur_speed, cur_fps)
                                    },
                                    eta_seconds: eta.max(0.0),
                                    elapsed_seconds: elapsed,
                                },
                            );
                            last_emit = Instant::now();
                        }
                    }
                    _ => {}
                }
            }
        }

        // 11. Ожидание завершения процесса и проверка кода выхода
        let status = child.wait().await.map_err(|e| format!("Ошибка ожидания процесса FFmpeg: {}", e))?;

        if !status.success() {
            let log = stderr_log.lock().await;
            let log_tail = log.iter().cloned().collect::<Vec<_>>().join("\n");

            // Распознавание частых фатальных ошибок
            let detailed_error = if log_tail.contains("No space left on device") || log_tail.contains("Not enough disk space") {
                "Недостаточно свободного места на целевом диске для сохранения видеофайла."
            } else if log_tail.contains("Unknown encoder") || log_tail.contains("Cannot load nvcuda") {
                "Аппаратный кодировщик NVENC недоступен на данной видеокарте. Переключитесь на кодек libx264 или режим copy."
            } else if log_tail.contains("Invalid argument") || log_tail.contains("Conversion failed") {
                "Несовместимый формат потока или поврежденный исходный файл."
            } else {
                "Ошибка кодирования FFmpeg."
            };

            log_error(&format!(
                "[VideoMuxEngine] FFmpeg завершился с кодом ошибки: {:?}\nЛог: {}",
                status.code(), log_tail
            ));

            return Err(format!("{} Код: {:?}. Подробности:\n{}", detailed_error, status.code(), log_tail));
        }

        let out_path = Path::new(&output_file_norm);
        let file_size_bytes = fs::metadata(out_path).map(|m| m.len()).unwrap_or(cur_size);
        let elapsed_ms = start_time.elapsed().as_millis() as u64;

        log_info(&format!(
            "[VideoMuxEngine] Рендер успешно завершен за {:.2}s. Размер файла: {} байт",
            elapsed_ms as f64 / 1000.0, file_size_bytes
        ));

        Ok(FinalRenderOutput {
            success: true,
            output_file_path: output_file_norm,
            file_size_bytes,
            duration_seconds: total_duration,
            container: request.video_options.container,
            audio_tracks_count: valid_audio_tracks.len(),
            subtitle_tracks_count: valid_subtitle_tracks.len(),
            elapsed_ms,
            average_speed: cur_speed,
            message: format!(
                "Сборка видео успешно выполнена за {:.2} сек. Размер: {:.2} МБ.",
                elapsed_ms as f64 / 1000.0,
                file_size_bytes as f64 / 1048576.0
            ),
        })
    }
}

// ============================================================================
// КОМАНДА TAURI: execute_final_video_render
// ============================================================================

#[tauri::command]
pub async fn execute_final_video_render(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    request: FinalRenderRequest,
) -> Result<FinalRenderOutput, String> {
    log_debug(&format!(
        "[Tauri] execute_final_video_render: project_id='{}', out='{}', codec='{}'",
        request.project_id, request.output_file_path, request.video_options.video_codec
    ));

    VideoMuxEngine::execute_render(app_handle, request).await
}
