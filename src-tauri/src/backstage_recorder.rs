// ============================================================================
// DUB MIXING STUDIO PRO - BACKSTAGE VIDEO RECORDER (RUST)
// ============================================================================
// Изолированный контроллер захвата видеокамеры/веб-камеры (Backstage Take).
// Полностью отделен от низколатентного аудиодвижка CPAL/WASAPI/ASIO, чтобы
// сбои драйверов DirectShow, дропы видеокадров и перегрузки GPU/CPU
// не влияли на запись звука дубляжа.
// ============================================================================

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::logger::{log_debug, log_error, log_info};
use crate::process_utils::CommandExtHide;

/// Состояние и дескриптор фоновой видеозаписи
pub struct BackstageVideoRecorder {
    pub is_recording: Arc<AtomicBool>,
    pub child: Option<std::process::Child>,
    pub current_video_path: Option<PathBuf>,
    pub start_time: Option<Instant>,
}

unsafe impl Send for BackstageVideoRecorder {}
unsafe impl Sync for BackstageVideoRecorder {}

impl Default for BackstageVideoRecorder {
    fn default() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            child: None,
            current_video_path: None,
            start_time: None,
        }
    }
}

/// Глобальное состояние для внедрения через Tauri State
pub struct BackstageState {
    pub recorder: Mutex<BackstageVideoRecorder>,
}

impl Default for BackstageState {
    fn default() -> Self {
        Self {
            recorder: Mutex::new(BackstageVideoRecorder::default()),
        }
    }
}

/// Старт изолированной видеозаписи с веб-камеры через FFmpeg с пониженным приоритетом
#[tauri::command]
pub async fn start_backstage_recording(
    state: State<'_, BackstageState>,
    video_device: String,
    audio_device: Option<String>,
    project_path: Option<String>,
) -> Result<String, String> {
    log_info(&format!(
        "--- [Backstage] Инициализация видеозаписи --- Камера: {}, Аудио: {:?}, Проект: {:?}",
        video_device, audio_device, project_path
    ));

    let mut recorder = state.recorder.lock().map_err(|e| e.to_string())?;

    if recorder.is_recording.load(Ordering::SeqCst) {
        log_error("[Backstage] Видеозапись уже запущена!");
        return Err("Backstage video recording is already active".to_string());
    }

    // Определяем каталог для сохранения дублей
    let storage_dir = if let Some(ref p) = project_path {
        let path = PathBuf::from(p).join("takes");
        if !path.exists() {
            let _ = fs::create_dir_all(&path);
        }
        path
    } else {
        let temp_takes = std::env::temp_dir().join("dubstudio_takes");
        if !temp_takes.exists() {
            let _ = fs::create_dir_all(&temp_takes);
        }
        temp_takes
    };

    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    let video_path = storage_dir.join(format!("backstage_{}.mp4", epoch_ms));
    let video_path_str = video_path.to_string_lossy().to_string();

    let ffmpeg_bin = crate::file_io::find_ffmpeg_path();

    // 1. Сборка аргументов FFmpeg в зависимости от платформы
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Threading::{SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS};

        let log_path = std::env::temp_dir().join(format!("backstage_ffmpeg_{}.log", epoch_ms));
        let stderr_file = fs::File::create(&log_path)
            .unwrap_or_else(|_| fs::File::create("nul").unwrap());

        let input_spec = if let Some(ref a_dev) = audio_device {
            if a_dev != "none" && !a_dev.is_empty() {
                format!("video={}:audio={}", video_device, a_dev)
            } else {
                format!("video={}", video_device)
            }
        } else {
            format!("video={}", video_device)
        };

        let mut args = vec![
            "-hide_banner".to_string(),
            "-y".to_string(),
            "-f".to_string(),
            "dshow".to_string(),
            "-rtbufsize".to_string(),
            "100M".to_string(),
            "-i".to_string(),
            input_spec,
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "ultrafast".to_string(),
            "-tune".to_string(),
            "zerolatency".to_string(),
            "-crf".to_string(),
            "28".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
        ];

        if let Some(ref a_dev) = audio_device {
            if a_dev != "none" && !a_dev.is_empty() {
                args.push("-c:a".to_string());
                args.push("aac".to_string());
                args.push("-b:a".to_string());
                args.push("128k".to_string());
            }
        }

        args.push(video_path_str.clone());

        let mut command = std::process::Command::new(&ffmpeg_bin);
        command
            .hide_window()
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stderr(stderr_file);

        command
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let mut args = vec![
            "-hide_banner".to_string(),
            "-y".to_string(),
        ];

        if cfg!(target_os = "macos") {
            args.push("-f".to_string());
            args.push("avfoundation".to_string());
            let input_spec = if let Some(ref a_dev) = audio_device {
                if a_dev != "none" && !a_dev.is_empty() {
                    format!("{}:{}", video_device, a_dev)
                } else {
                    format!("{}:none", video_device)
                }
            } else {
                format!("{}:none", video_device)
            };
            args.push("-i".to_string());
            args.push(input_spec);
        } else {
            args.push("-f".to_string());
            args.push("v4l2".to_string());
            args.push("-i".to_string());
            args.push(video_device.clone());

            if let Some(ref a_dev) = audio_device {
                if a_dev != "none" && !a_dev.is_empty() {
                    args.push("-f".to_string());
                    args.push("alsa".to_string());
                    args.push("-i".to_string());
                    args.push(a_dev.clone());
                }
            }
        }

        args.push("-c:v".to_string());
        args.push("libx264".to_string());
        args.push("-preset".to_string());
        args.push("ultrafast".to_string());
        args.push("-tune".to_string());
        args.push("zerolatency".to_string());
        args.push("-crf".to_string());
        args.push("28".to_string());
        args.push("-pix_fmt".to_string());
        args.push("yuv420p".to_string());

        if let Some(ref a_dev) = audio_device {
            if a_dev != "none" && !a_dev.is_empty() {
                args.push("-c:a".to_string());
                args.push("aac".to_string());
                args.push("-b:a".to_string());
                args.push("128k".to_string());
            }
        }

        args.push(video_path_str.clone());

        let mut command = std::process::Command::new(&ffmpeg_bin);
        command
            .hide_window()
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());

        command
    };

    // 2. Запуск процесса видеозаписи
    let child = cmd.spawn().map_err(|e| {
        let err = format!("Не удалось запустить процесс видеозаписи FFmpeg: {}", e);
        log_error(&err);
        err
    })?;

    // 3. Установка низкого приоритета на Windows во избежание конкуренции с аудиопотоком CPAL
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Threading::{SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS};

        unsafe {
            let handle = HANDLE(child.as_raw_handle() as *mut std::ffi::c_void);
            let _ = SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS);
        }
        log_debug("[Backstage] Приоритет FFmpeg процесса установлен в BELOW_NORMAL_PRIORITY_CLASS");
    }

    recorder.child = Some(child);
    recorder.current_video_path = Some(video_path);
    recorder.start_time = Some(Instant::now());
    recorder.is_recording.store(true, Ordering::SeqCst);

    log_info(&format!(
        "[Backstage] Видеозапись успешно стартовала: {}",
        video_path_str
    ));

    Ok(video_path_str)
}

/// Корректная остановка видеозаписи с мягкой отправкой 'q' в stdin и таймаутом завершения
#[tauri::command]
pub async fn stop_backstage_recording(
    state: State<'_, BackstageState>,
) -> Result<Option<String>, String> {
    log_info("--- [Backstage] Остановка видеозаписи ---");

    let mut recorder = state.recorder.lock().map_err(|e| e.to_string())?;

    if !recorder.is_recording.load(Ordering::SeqCst) {
        log_debug("[Backstage] Видеозапись не активна");
        return Ok(None);
    }

    recorder.is_recording.store(false, Ordering::SeqCst);

    let mut child = recorder.child.take();
    let video_path = recorder.current_video_path.take();
    recorder.start_time = None;

    if let Some(mut c) = child {
        log_debug("[Backstage] Отправка команды мягкого завершения 'q' в stdin FFmpeg");
        if let Some(mut stdin) = c.stdin.take() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }

        // Ожидание завершения с таймаутом 4 секунды
        let start_wait = Instant::now();
        let timeout = Duration::from_secs(4);
        let mut exited = false;

        while start_wait.elapsed() < timeout {
            match c.try_wait() {
                Ok(Some(status)) => {
                    log_info(&format!(
                        "[Backstage] FFmpeg видеопроцесс корректно завершился со статусом: {:?}",
                        status
                    ));
                    exited = true;
                    break;
                }
                Ok(None) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) => {
                    log_error(&format!("[Backstage] Ошибка try_wait(): {}", e));
                    break;
                }
            }
        }

        if !exited {
            log_error("[Backstage] Таймаут завершения FFmpeg! Принудительное завершение kill()");
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    let final_path_str = video_path.and_then(|p| {
        if p.exists() {
            Some(p.to_string_lossy().to_string())
        } else {
            None
        }
    });

    log_info(&format!(
        "[Backstage] Видеозапись остановлена. Итоговый файл: {:?}",
        final_path_str
    ));

    Ok(final_path_str)
}

/// Проверка статуса фоновой видеозаписи
#[tauri::command]
pub async fn is_backstage_recording(state: State<'_, BackstageState>) -> Result<bool, String> {
    let recorder = state.recorder.lock().map_err(|e| e.to_string())?;
    Ok(recorder.is_recording.load(Ordering::SeqCst))
}

/// Аварийная остановка видеозаписи
#[tauri::command]
pub async fn force_stop_backstage(state: State<'_, BackstageState>) -> Result<(), String> {
    log_info("[Backstage] Аварийная остановка видеозаписи force_stop_backstage");
    let mut recorder = state.recorder.lock().map_err(|e| e.to_string())?;
    recorder.is_recording.store(false, Ordering::SeqCst);
    if let Some(mut c) = recorder.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    recorder.current_video_path = None;
    recorder.start_time = None;
    Ok(())
}
