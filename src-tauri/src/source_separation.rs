use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{broadcast, Mutex};

/// Глобальный идентификатор запущенного дочернего процесса разделения (PID)
static CURRENT_SEPARATION_PID: AtomicU32 = AtomicU32::new(0);

/// Глобальный канал передачи сигнала отмены
static CANCEL_SENDER: OnceLock<Mutex<Option<broadcast::Sender<()>>>> = OnceLock::new();

fn cancel_sender_mutex() -> &'static Mutex<Option<broadcast::Sender<()>>> {
    CANCEL_SENDER.get_or_init(|| Mutex::new(None))
}

/// Результат разделения оригинального аудио на вокал и инструментальную подложку (M&E)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparationResult {
    /// Путь к файлу с изолированным вокалом (чистый голос)
    pub vocals_path: String,
    /// Путь к файлу без вокала (фонограмма / M&E подложка)
    pub no_vocals_path: String,
    /// Имя использованной модели (UVR-MDX-NET-Voc_FT, htdemucs и др.)
    pub model_name: String,
    /// Длительность обработанного файла в секундах
    pub duration_sec: f64,
}

/// Детализированный прогресс разделения стемов
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparationProgressPayload {
    pub percent: f64,
    pub stage: String,
    pub log_line: String,
}

/// Поиск каталога с локально вшитыми или скачанными моделями UVR
pub fn find_models_dir(app_handle: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        candidates.push(res_dir.join("models"));
        candidates.push(res_dir.join("resources").join("models"));
        candidates.push(res_dir.join("ai_env").join("models"));
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("models"));
            candidates.push(exe_dir.join("resources").join("models"));
            candidates.push(exe_dir.join("ai_env").join("models"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("models"));
        candidates.push(cwd.join("resources").join("models"));
        candidates.push(cwd.join("src-tauri").join("models"));
        candidates.push(cwd.join("src-tauri").join("resources").join("models"));
    }
    if let Ok(data_dir) = app_handle.path().app_data_dir() {
        candidates.push(data_dir.join("models"));
    }
    candidates.into_iter().find(|p| p.is_dir())
}

/// Поиск встроенного интерпретатора Python (`bin/python` в каталоге приложения)
pub fn find_embedded_python(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let mut search_paths: Vec<PathBuf> = Vec::new();

    // 1. Проверяем каталог ресурсов Tauri
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        search_paths.push(res_dir.join("bin").join("python"));
        search_paths.push(res_dir.join("bin").join("python.exe"));
        search_paths.push(res_dir.join("ai_env").join("bin").join("python"));
        search_paths.push(res_dir.join("ai_env").join("bin").join("python3"));
        search_paths.push(res_dir.join("ai_env").join("python").join("python.exe"));
        search_paths.push(res_dir.join("ai_env").join("python").join("bin").join("python3"));
    }

    // 2. Проверяем каталог исполняемого файла приложения (портативный режим)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            search_paths.push(exe_dir.join("bin").join("python"));
            search_paths.push(exe_dir.join("bin").join("python.exe"));
            search_paths.push(exe_dir.join("ai_env").join("bin").join("python"));
            search_paths.push(exe_dir.join("ai_env").join("bin").join("python3"));
            search_paths.push(exe_dir.join("ai_env").join("python").join("python.exe"));
            search_paths.push(exe_dir.join("ai_env").join("python").join("bin").join("python3"));
        }
    }

    // 3. Проверяем текущую рабочую директорию (режим разработки / dev)
    if let Ok(cwd) = std::env::current_dir() {
        search_paths.push(cwd.join("bin").join("python"));
        search_paths.push(cwd.join("bin").join("python.exe"));
        search_paths.push(cwd.join("src-tauri").join("bin").join("python"));
        search_paths.push(cwd.join("src-tauri").join("bin").join("python.exe"));
        search_paths.push(cwd.join("ai_env").join("bin").join("python"));
        search_paths.push(cwd.join("ai_env").join("bin").join("python3"));
        search_paths.push(cwd.join("ai_env").join("python").join("python.exe"));
        search_paths.push(cwd.join("ai_env").join("python").join("bin").join("python3"));
        search_paths.push(cwd.join("src-tauri").join("ai_env").join("bin").join("python"));
        search_paths.push(cwd.join("src-tauri").join("ai_env").join("python").join("python.exe"));
        search_paths.push(cwd.join("src-tauri").join("ai_env").join("python").join("bin").join("python3"));
    }

    // 4. Проверяем локальные данные приложения (AppLocalData)
    if let Ok(data_dir) = app_handle.path().app_local_data_dir() {
        search_paths.push(data_dir.join("bin").join("python"));
        search_paths.push(data_dir.join("bin").join("python.exe"));
        search_paths.push(data_dir.join("ai_env").join("bin").join("python"));
        search_paths.push(data_dir.join("ai_env").join("python").join("python.exe"));
    }

    for path in search_paths {
        if path.is_file() {
            return Ok(path);
        }
    }

    // 5. Fallback на системный Python, если встроенный переносной не обнаружен
    for cmd in &["python3", "python", "py"] {
        if let Ok(output) = std::process::Command::new(cmd).arg("--version").output() {
            if output.status.success() {
                return Ok(PathBuf::from(cmd));
            }
        }
    }

    Err("Интерпретатор Python не найден ни во встроенном каталоге bin/python, ни в системном PATH".to_string())
}

/// Асинхронный запуск локального процесса разделения аудио на стемы (Demucs / UVR MDX-NET)
#[tauri::command]
pub async fn separate_audio_stems(
    app_handle: AppHandle,
    input_path: String,
    output_dir: Option<String>,
    model_name: Option<String>,
    use_gpu: Option<bool>,
) -> Result<SeparationResult, String> {
    let norm_input = crate::file_io::normalize_windows_path(&input_path);
    let input_p = Path::new(&norm_input);

    if !input_p.exists() {
        return Err(format!("Входной медиафайл не существует: {}", norm_input));
    }

    // Определение директории сохранения результатов
    let target_out_dir = match output_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(crate::file_io::normalize_windows_path(&d)),
        _ => input_p.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from(".")),
    };

    std::fs::create_dir_all(&target_out_dir)
        .map_err(|e| format!("Не удалось создать выходную папку {}: {}", target_out_dir.display(), e))?;

    let model_to_use = model_name.unwrap_or_else(|| "UVR-MDX-NET-Voc_FT".to_string());
    let gpu_enabled = use_gpu.unwrap_or(true);

    // 1. Поиск встроенного Python
    let python_bin = find_embedded_python(&app_handle)?;
    let python_str = python_bin.to_string_lossy().to_string();

    // 2. Инициализация канала отмены
    let (cancel_tx, mut cancel_rx) = broadcast::channel::<()>(1);
    {
        let mut sender_guard = cancel_sender_mutex().lock().await;
        *sender_guard = Some(cancel_tx);
    }

    // Оповещение UI о начале инициализации
    let _ = app_handle.emit("separation-progress", 0.0_f64);
    let _ = app_handle.emit("separation-progress-detail", SeparationProgressPayload {
        percent: 0.0,
        stage: "Инициализация нейросети...".to_string(),
        log_line: format!("Запуск модели {} через {}", model_to_use, python_str),
    });

    // 3. Формирование команды запуска скрипта инференса через Python API Separator:
    let models_dir_arg = find_models_dir(&app_handle)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let py_runner = r#"
import sys, os, json, traceback

input_file = sys.argv[1]
model_name = sys.argv[2]
output_dir = sys.argv[3]
use_gpu = sys.argv[4].lower() == 'true'
models_dir = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] != '' else None

if not use_gpu:
    os.environ['CUDA_VISIBLE_DEVICES'] = ''

try:
    from audio_separator.separator import Separator
    os.makedirs(output_dir, exist_ok=True)

    kwargs = {
        'output_dir': output_dir,
        'output_format': 'WAV',
    }
    if models_dir:
        kwargs['model_file_dir'] = models_dir

    separator = Separator(**kwargs)
    print(f'Loading model: {model_name}...', flush=True)
    separator.load_model(model_name)
    print(f'Separating: {input_file}...', flush=True)
    outputs = separator.separate(input_file)
    print('SUCCESS_OUTPUT_FILES:' + json.dumps(outputs), flush=True)
except Exception:
    traceback.print_exc()
    sys.exit(1)
"#;

    let mut cmd = tokio::process::Command::new(&python_str);
    cmd.args(&[
        "-c",
        py_runner,
        &norm_input,
        &model_to_use,
        &target_out_dir.to_string_lossy(),
        if gpu_enabled { "true" } else { "false" },
        &models_dir_arg,
    ]);

    if !gpu_enabled {
        cmd.env("CUDA_VISIBLE_DEVICES", "");
    }

    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // 4. Запуск дочернего процесса
    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Не удалось запустить процесс Python ({}) для разделения аудио: {}",
            python_str, e
        )
    })?;

    let pid = child.id().unwrap_or(0);
    CURRENT_SEPARATION_PID.store(pid, Ordering::SeqCst);

    let stdout = child.stdout.take().ok_or("Не удалось перехватить stdout процесса")?;
    let stderr = child.stderr.take().ok_or("Не удалось перехватить stderr процесса")?;

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    // Регулярное выражение для парсинга "Progress: 45%" или "45%"
    let progress_re = Arc::new(Regex::new(r"(?i)(?:progress:\s*(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%)").unwrap());

    let app_handle_prog = app_handle.clone();
    let logs_history = Arc::new(Mutex::new(Vec::<String>::new()));
    let logs_history_task = logs_history.clone();
    let re_clone = progress_re.clone();

    // 5. Потоковый мониторинг stdout/stderr в реальном времени
    let monitor_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                line_res = stdout_reader.next_line() => {
                    match line_res {
                        Ok(Some(line)) => {
                            parse_and_emit_line(&app_handle_prog, &line, &re_clone);
                            let mut logs = logs_history_task.lock().await;
                            if logs.len() > 100 { logs.remove(0); }
                            logs.push(line);
                        }
                        _ => break,
                    }
                }
                line_res = stderr_reader.next_line() => {
                    match line_res {
                        Ok(Some(line)) => {
                            parse_and_emit_line(&app_handle_prog, &line, &re_clone);
                            let mut logs = logs_history_task.lock().await;
                            if logs.len() > 100 { logs.remove(0); }
                            logs.push(line);
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    // 6. Ожидание завершения или получение сигнала отмены
    let wait_result = tokio::select! {
        res = child.wait() => {
            res.map_err(|e| format!("Ошибка ожидания процесса: {}", e))
        }
        cancel_res = cancel_rx.recv() => {
            if cancel_res.is_ok() {
                // Корректное завершение процесса (kill child process)
                let _ = child.kill().await;
                #[cfg(windows)]
                if pid > 0 {
                    let _ = std::process::Command::new("taskkill")
                        .args(&["/F", "/PID", &pid.to_string(), "/T"])
                        .output();
                }
                CURRENT_SEPARATION_PID.store(0, Ordering::SeqCst);
                return Err("Разделение аудио на стемы отменено пользователем".to_string());
            } else {
                child.wait().await.map_err(|e| format!("Ошибка ожидания процесса: {}", e))
            }
        }
    };

    let status_code = wait_result?;
    let _ = monitor_task.await;
    CURRENT_SEPARATION_PID.store(0, Ordering::SeqCst);

    if !status_code.success() {
        let history = logs_history.lock().await;
        let last_logs = history.join("\n");
        return Err(format!(
            "Процесс разделения аудио завершился с кодом ошибки {}.\n\nДиагностика:\n{}",
            status_code.code().unwrap_or(-1),
            if last_logs.trim().is_empty() { "Нет вывода процесса" } else { &last_logs }
        ));
    }

    // 7. Поиск и финализация созданных файлов: vocals.wav и no_vocals.wav
    let vocals_dest = target_out_dir.join("vocals.wav");
    let no_vocals_dest = target_out_dir.join("no_vocals.wav");

    resolve_and_standardize_stems(&target_out_dir, &vocals_dest, &no_vocals_dest)?;

    let _ = app_handle.emit("separation-progress", 100.0_f64);
    let _ = app_handle.emit("separation-progress-detail", SeparationProgressPayload {
        percent: 100.0,
        stage: "Готово!".to_string(),
        log_line: "Стемы vocals.wav и no_vocals.wav успешно созданы".to_string(),
    });

    // Расчет длительности полученного WAV файла
    let duration_sec = get_wav_duration(&vocals_dest).unwrap_or(0.0);

    Ok(SeparationResult {
        vocals_path: vocals_dest.to_string_lossy().to_string(),
        no_vocals_path: no_vocals_dest.to_string_lossy().to_string(),
        model_name: model_to_use,
        duration_sec: (duration_sec * 100.0).round() / 100.0,
    })
}

/// Парсинг процента выполнения и отправка событий в вебвью
fn parse_and_emit_line(app_handle: &AppHandle, line: &str, re: &Regex) {
    let mut percent: Option<f64> = None;

    if let Some(caps) = re.captures(line) {
        let num_str = caps.get(1).or_else(|| caps.get(2)).map(|m| m.as_str()).unwrap_or("");
        if let Ok(val) = num_str.parse::<f64>() {
            percent = Some(val.clamp(0.0, 100.0));
        }
    }

    let line_lower = line.to_lowercase();
    let stage = if line_lower.contains("download") {
        "Загрузка весов нейросети...".to_string()
    } else if line_lower.contains("loading model") {
        "Инициализация модели в памяти...".to_string()
    } else if line_lower.contains("separat") || line_lower.contains("infer") {
        "Нейросетевое разделение стемов...".to_string()
    } else if line_lower.contains("writing") || line_lower.contains("saving") {
        "Запись WAV дорожек...".to_string()
    } else {
        "Обработка аудио...".to_string()
    };

    if let Some(p) = percent {
        // Требование: шлет события в вебвью через window.emit("separation-progress", percent)
        let _ = app_handle.emit("separation-progress", p);
    }

    let _ = app_handle.emit("separation-progress-detail", SeparationProgressPayload {
        percent: percent.unwrap_or(0.0),
        stage,
        log_line: line.to_string(),
    });
}

/// Поиск созданных стемов в выходной папке и стандартизация их в vocals.wav и no_vocals.wav
fn resolve_and_standardize_stems(
    out_dir: &Path,
    vocals_dest: &Path,
    no_vocals_dest: &Path,
) -> Result<(), String> {
    if vocals_dest.exists() && no_vocals_dest.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(out_dir)
        .map_err(|e| format!("Не удалось прочитать директорию {}: {}", out_dir.display(), e))?;

    let mut found_vocals: Option<PathBuf> = None;
    let mut found_no_vocals: Option<PathBuf> = None;

    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() {
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();

            if name.ends_with(".wav") {
                if (name.contains("vocals") || name.contains("vocal") || name.contains("voice"))
                    && !name.contains("no_vocals")
                    && !name.contains("instrumental")
                {
                    found_vocals = Some(p.clone());
                } else if name.contains("no_vocals")
                    || name.contains("instrumental")
                    || name.contains("instruments")
                    || name.contains("music")
                    || name.contains("accompaniment")
                {
                    found_no_vocals = Some(p.clone());
                }
            }
        }
    }

    // Если найден файл вокала и он не равен vocals.wav, переименовываем / копируем
    if let Some(src_voc) = found_vocals {
        if src_voc != vocals_dest {
            let _ = std::fs::copy(&src_voc, vocals_dest);
        }
    }

    // Если найден инструментальный файл и он не равен no_vocals.wav, переименовываем / копируем
    if let Some(src_inst) = found_no_vocals {
        if src_inst != no_vocals_dest {
            let _ = std::fs::copy(&src_inst, no_vocals_dest);
        }
    }

    if !vocals_dest.exists() || !no_vocals_dest.exists() {
        return Err(format!(
            "Не удалось сформировать оба стема vocals.wav и no_vocals.wav в директории {}",
            out_dir.display()
        ));
    }

    Ok(())
}

/// Расчет длительности WAV файла через hound
fn get_wav_duration(path: &Path) -> Option<f64> {
    let reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    let samples = reader.duration();
    Some(samples as f64 / spec.sample_rate as f64)
}

/// Принудительная отмена операции разделения стемов пользователем (kill child process)
#[tauri::command]
pub async fn cancel_source_separation() -> Result<bool, String> {
    // 1. Отправляем сигнал в broadcast канал
    let mut sender_guard = cancel_sender_mutex().lock().await;
    if let Some(sender) = sender_guard.take() {
        let _ = sender.send(());
    }

    // 2. Дополнительно уничтожаем процесс по PID
    let pid = CURRENT_SEPARATION_PID.swap(0, Ordering::SeqCst);
    if pid > 0 {
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(&["/F", "/PID", &pid.to_string(), "/T"])
                .output();
        }

        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill")
                .args(&["-9", &pid.to_string()])
                .output();
        }
    }

    Ok(true)
}
