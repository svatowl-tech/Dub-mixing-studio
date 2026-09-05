use tauri::{AppHandle, Emitter, Manager};
use std::process::Stdio;
use std::path::Path;
use std::time::SystemTime;
use tokio::io::{AsyncBufReadExt, BufReader};
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct SeparatorStatus {
    pub python_found: bool,
    pub python_cmd: String,
    pub pip_found: bool,
    pub separator_installed: bool,
    pub version: String,
    pub cuda_available: bool,
}

#[derive(Serialize, Clone)]
struct SeparatorProgress {
    pub percent: f64,
    pub stage: String,
    pub log_line: String,
}

// Поиск команды Python на системе (сначала проверяем ai_env, затем системный)
fn find_python(app_handle: &AppHandle) -> Option<String> {
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let ai_env_py = if cfg!(target_os = "windows") {
            resource_dir.join("ai_env").join("python").join("python.exe")
        } else {
            resource_dir.join("ai_env").join("python").join("bin").join("python3")
        };
        
        if ai_env_py.exists() {
            return Some(ai_env_py.to_string_lossy().to_string());
        }
    }

    // Fallback for dev environment (e.g. `npm run tauri dev`)
    if let Ok(cwd) = std::env::current_dir() {
        let dev_ai_env_py = if cfg!(target_os = "windows") {
            cwd.join("ai_env").join("python").join("python.exe")
        } else {
            cwd.join("ai_env").join("python").join("bin").join("python3")
        };
        if dev_ai_env_py.exists() {
            return Some(dev_ai_env_py.to_string_lossy().to_string());
        }
        
        let dev_ai_env_py_src_tauri = if cfg!(target_os = "windows") {
            cwd.join("src-tauri").join("ai_env").join("python").join("python.exe")
        } else {
            cwd.join("src-tauri").join("ai_env").join("python").join("bin").join("python3")
        };
        if dev_ai_env_py_src_tauri.exists() {
            return Some(dev_ai_env_py_src_tauri.to_string_lossy().to_string());
        }
    }

    for cmd in &["python3", "python", "py"] {
        if let Ok(output) = std::process::Command::new(cmd).arg("--version").output() {
            if output.status.success() {
                return Some(cmd.to_string());
            }
        }
    }
    None
}

// Поиск команды pip на системе
fn find_pip(python_cmd: &str) -> Option<String> {
    // Сначала проверим модуль pip через выбранный питон
    if let Ok(output) = std::process::Command::new(python_cmd)
        .args(&["-m", "pip", "--version"])
        .output() {
        if output.status.success() {
            return Some(format!("{} -m pip", python_cmd));
        }
    }
    
    // Иначе попробуем напрямую pip3 / pip
    for cmd in &["pip3", "pip"] {
        if let Ok(output) = std::process::Command::new(cmd).arg("--version").output() {
            if output.status.success() {
                return Some(cmd.to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub async fn check_audio_separator_status(app_handle: AppHandle) -> Result<SeparatorStatus, String> {
    let python_cmd = find_python(&app_handle).unwrap_or_default();
    let python_found = !python_cmd.is_empty();
    
    let mut pip_found = false;
    let mut separator_installed = false;
    let mut version = String::new();
    let mut cuda_available = false;

    if python_found {
        if let Some(_cmd) = find_pip(&python_cmd) {
            pip_found = true;
        }

        // Проверим установлен ли пакет audio-separator и импортируется ли он
        let check_cmd = if python_cmd == "py" {
            std::process::Command::new("py")
                .args(&["-3", "-c", "import audio_separator; print(audio_separator.__version__)"])
                .output()
        } else {
            std::process::Command::new(&python_cmd)
                .args(&["-c", "import audio_separator; print(audio_separator.__version__ if hasattr(audio_separator, '__version__') else 'unknown')"])
                .output()
        };

        if let Ok(output) = check_cmd {
            if output.status.success() {
                separator_installed = true;
                version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            }
        }

        // Проверим доступность CUDA/GPU через PyTorch
        let torch_cmd = std::process::Command::new(&python_cmd)
            .args(&["-c", "import torch; print(torch.cuda.is_available())"])
            .output();
        if let Ok(output) = torch_cmd {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
                cuda_available = stdout == "true";
            }
        }
    }

    Ok(SeparatorStatus {
        python_found,
        python_cmd,
        pip_found,
        separator_installed,
        version,
        cuda_available,
    })
}

#[tauri::command]
pub async fn install_audio_separator_pkg(app_handle: AppHandle, use_gpu: bool) -> Result<String, String> {
    let status = check_audio_separator_status(app_handle.clone()).await?;
    if !status.python_found {
        return Err("Python не найден в вашей системе. Пожалуйста, установите Python 3.10+ и добавьте его в PATH.".to_string());
    }

    let python_cmd = status.python_cmd;
    
    // Собираем аргументы для pip
    let args = if use_gpu {
        // Установка PyTorch с CUDA + audio-separator с GPU зависимостями
        vec![
            "-m".to_string(), 
            "pip".to_string(), 
            "install".to_string(),
            "audio-separator[gpu]".to_string(),
            "onnxruntime-gpu".to_string()
        ]
    } else {
        vec![
            "-m".to_string(), 
            "pip".to_string(), 
            "install".to_string(),
            "audio-separator[cpu]".to_string()
        ]
    };

    let app_handle_progress = app_handle.clone();
    let python_cmd_clone = python_cmd.clone();
    
    // Запускаем процесс установки
    tauri::async_runtime::spawn(async move {
        let mut child = match tokio::process::Command::new(&python_cmd_clone)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app_handle_progress.emit("separator-install-log", format!("Ошибка запуска pip: {}", e));
                return;
            }
        };

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        
        let mut stdout_reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();

        loop {
            tokio::select! {
                line = stdout_reader.next_line() => {
                    match line {
                        Ok(Some(l)) => {
                            let _ = app_handle_progress.emit("separator-install-log", format!("STDOUT: {}", l));
                        }
                        _ => break,
                    }
                }
                line = stderr_reader.next_line() => {
                    match line {
                        Ok(Some(l)) => {
                            let _ = app_handle_progress.emit("separator-install-log", format!("STDERR: {}", l));
                        }
                        _ => {}
                    }
                }
            }
        }
        let _ = app_handle_progress.emit("separator-install-complete", true);
    });

    Ok("Установка запущена в фоновом режиме".to_string())
}

#[tauri::command]
pub async fn run_audio_separator_cmd(
    app_handle: AppHandle,
    input_file: String,
    model_filename: String,
    output_dir: String,
    use_gpu: bool,
    denoise: bool,
) -> Result<String, String> {
    let norm_input = crate::file_io::normalize_windows_path(&input_file);
    let norm_output_dir = crate::file_io::normalize_windows_path(&output_dir);
    
    let path_input = Path::new(&norm_input);
    if !path_input.exists() {
        return Err(format!("Файл {} не существует", norm_input));
    }

    // Создаем директорию для вывода, если ее нет
    if !norm_output_dir.is_empty() {
        let _ = std::fs::create_dir_all(&norm_output_dir);
    }

    let status = check_audio_separator_status(app_handle.clone()).await?;
    let python_cmd = if status.python_found { status.python_cmd } else { "python".to_string() };

    // Будем запускать CLI через python -m audio_separator.cli
    let mut args = vec![
        "-m".to_string(),
        "audio_separator.cli".to_string(),
        norm_input.clone(),
        "--model_filename".to_string(),
        model_filename.clone(),
        "--output_dir".to_string(),
        norm_output_dir.clone(),
        "--output_format".to_string(),
        "WAV".to_string(),
    ];

    if use_gpu {
        args.push("--use_gpu".to_string());
    } else {
        // Явно отключаем gpu если не просили
        args.push("--cpu".to_string());
    }

    if denoise {
        args.push("--denoise".to_string());
        args.push("true".to_string());
    }

    // Сохраним список файлов в выходной директории ДО запуска, чтобы найти новые файлы
    let pre_files = get_files_in_dir(&norm_output_dir);

    let app_handle_prog = app_handle.clone();
    let model_filename_clone = model_filename.clone();

    // Запуск процесса разделения
    let mut child = tokio::process::Command::new(&python_cmd)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Не удалось запустить audio-separator: {}", e))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    // Прогресс бар и парсинг
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                line_res = stdout_reader.next_line() => {
                    match line_res {
                        Ok(Some(line)) => {
                            parse_and_emit_progress(&app_handle_prog, &line, &model_filename_clone);
                        }
                        _ => break,
                    }
                }
                line_res = stderr_reader.next_line() => {
                    match line_res {
                        Ok(Some(line)) => {
                            parse_and_emit_progress(&app_handle_prog, &line, &model_filename_clone);
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    // Ожидаем завершения (для синхронного таури-вызова, либо вернем промис)
    // Так как это асинхронная команда Tauri, мы можем подождать окончание процесса здесь
    let status_code = child.wait().await.map_err(|e| e.to_string())?;
    
    if !status_code.success() {
        return Err("Процесс audio-separator завершился с ошибкой. Проверьте установку зависимостей и ONNX моделей.".to_string());
    }

    // Ищем получившийся файл в output_dir
    let post_files = get_files_in_dir(&norm_output_dir);
    
    // Ищем новые файлы, которые появились в процессе
    let mut new_files: Vec<String> = post_files.iter()
        .filter(|f| !pre_files.contains(*f))
        .cloned()
        .collect();

    // Сортируем по времени модификации (самые новые первыми)
    new_files.sort_by(|a, b| {
        let meta_a = std::fs::metadata(a).map(|m| m.modified().unwrap_or(SystemTime::UNIX_EPOCH)).unwrap_or(SystemTime::UNIX_EPOCH);
        let meta_b = std::fs::metadata(b).map(|m| m.modified().unwrap_or(SystemTime::UNIX_EPOCH)).unwrap_or(SystemTime::UNIX_EPOCH);
        meta_b.cmp(&meta_a)
    });

    if let Some(new_file) = new_files.first() {
        return Ok(new_file.clone());
    }

    // Если новые файлы не найдены (например, файл перезаписался), ищем последний модифицированный файл с похожим именем
    let input_base_name = path_input.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let mut matched_files: Vec<String> = post_files.iter()
        .filter(|f| {
            let p = Path::new(f);
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            name.contains(input_base_name)
        })
        .cloned()
        .collect();

    matched_files.sort_by(|a, b| {
        let meta_a = std::fs::metadata(a).map(|m| m.modified().unwrap_or(SystemTime::UNIX_EPOCH)).unwrap_or(SystemTime::UNIX_EPOCH);
        let meta_b = std::fs::metadata(b).map(|m| m.modified().unwrap_or(SystemTime::UNIX_EPOCH)).unwrap_or(SystemTime::UNIX_EPOCH);
        meta_b.cmp(&meta_a)
    });

    if let Some(matched) = matched_files.first() {
        return Ok(matched.clone());
    }

    Err("Не удалось локализовать выходной файл обработки audio-separator".to_string())
}

fn get_files_in_dir(dir: &str) -> Vec<String> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries {
            if let Ok(e) = entry {
                if let Ok(file_type) = e.file_type() {
                    if file_type.is_file() {
                        if let Some(p) = e.path().to_str() {
                            files.push(p.to_string());
                        }
                    }
                }
            }
        }
    }
    files
}

// Парсинг консольного вывода и передача прогресса на UI
fn parse_and_emit_progress(app_handle: &AppHandle, line: &str, model: &str) {
    let line_lower = line.to_lowercase();
    let mut percent = 0.0;
    let stage;

    // Ищем проценты в строке (например: 15% или 0.15)
    if line_lower.contains("downloading") || line_lower.contains("download") {
        stage = "Скачивание модели...".to_string();
        if let Some(p) = parse_percentage(&line_lower) {
            percent = p;
        }
    } else if line_lower.contains("loading model") {
        stage = "Загрузка ONNX модели в память...".to_string();
        percent = 5.0;
    } else if line_lower.contains("separating") || line_lower.contains("processing") || line_lower.contains("running") {
        stage = format!("Нейросетевая обработка ({})", model);
        if let Some(p) = parse_percentage(&line_lower) {
            percent = 10.0 + (p * 0.85); // переводим диапазон детекции в 10-95%
        } else {
            percent = 40.0;
        }
    } else if line_lower.contains("saving") || line_lower.contains("writing") {
        stage = "Сохранение очищенного файла...".to_string();
        percent = 95.0;
    } else if line_lower.contains("completed") || line_lower.contains("success") {
        stage = "Готово!".to_string();
        percent = 100.0;
    } else {
        // Обычная строка лога
        stage = "Анализ звука...".to_string();
        if let Some(p) = parse_percentage(&line_lower) {
            percent = p;
        }
    }

    let _ = app_handle.emit("separator-progress", SeparatorProgress {
        percent,
        stage,
        log_line: line.to_string(),
    });
}

fn parse_percentage(line: &str) -> Option<f64> {
    // Ищем подстроку с %
    if let Some(idx) = line.find('%') {
        let start = line[..idx].rfind(|c: char| !c.is_digit(10) && c != '.');
        let num_str = match start {
            Some(s_idx) => &line[s_idx + 1..idx],
            None => &line[..idx],
        };
        if let Ok(val) = num_str.trim().parse::<f64>() {
            return Some(val);
        }
    }
    
    // Ищем прогресс типа "10/100" или "0.45"
    None
}
