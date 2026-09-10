use tauri::{AppHandle, Emitter, Manager};
use std::process::Stdio;
use std::path::Path;
use std::time::SystemTime;
use std::sync::Arc;
use tokio::sync::Mutex;
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
            "--upgrade".to_string(),
            "audio-separator[gpu]".to_string(),
            "onnxruntime-gpu".to_string()
        ]
    } else {
        vec![
            "-m".to_string(), 
            "pip".to_string(), 
            "install".to_string(),
            "--upgrade".to_string(),
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
                let _ = app_handle_progress.emit("separator-install-complete", false);
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
        let exit_status = child.wait().await;
        let success = exit_status.map(|s| s.success()).unwrap_or(false);
        let _ = app_handle_progress.emit("separator-install-complete", success);
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

    // 1. Быстрый стерео/фазовый сплиттер (DSP) без необходимости установки Python / ONNX
    if model_filename == "fast_dsp_splitter" {
        let base_name = path_input.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
        let vocals_out = Path::new(&norm_output_dir).join(format!("{}_(Vocals)_fast_dsp.wav", base_name));
        let music_out = Path::new(&norm_output_dir).join(format!("{}_(Instrumental)_fast_dsp.wav", base_name));
        
        let vocals_str = vocals_out.to_string_lossy().to_string();
        let music_str = music_out.to_string_lossy().to_string();

        let _ = app_handle.emit("separator-progress", SeparatorProgress {
            percent: 25.0,
            stage: "DSP фазовое разделение...".to_string(),
            log_line: "Выделение центрального голосового канала...".to_string(),
        });

        // Голос: центральный канал (M = L + R) с полосовым голосовым фильтром 160-7500 Гц
        let _ = std::process::Command::new("ffmpeg")
            .args(&[
                "-y",
                "-i", &norm_input,
                "-af", "pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,highpass=f=160,lowpass=f=7500",
                &vocals_str
            ])
            .output();

        let _ = app_handle.emit("separator-progress", SeparatorProgress {
            percent: 65.0,
            stage: "DSP фазовое разделение...".to_string(),
            log_line: "Подавление центрального канала (фонограмма/музыка)...".to_string(),
        });

        // Музыка / M&E: противофазное подавление центра (S = L - R)
        let _ = std::process::Command::new("ffmpeg")
            .args(&[
                "-y",
                "-i", &norm_input,
                "-af", "pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0",
                &music_str
            ])
            .output();

        let _ = app_handle.emit("separator-progress", SeparatorProgress {
            percent: 100.0,
            stage: "Готово!".to_string(),
            log_line: "DSP разделение успешно завершено".to_string(),
        });

        return Ok(vocals_str);
    }

    // 2. Проверка доступности Python и пакета audio-separator
    let status = check_audio_separator_status(app_handle.clone()).await?;
    if !status.python_found {
        return Err("Python 3 не обнаружен в вашей системе. Для использования ИИ моделей (UVR5/Demucs) установите Python 3.10+ и зависимости, либо переключитесь на 'Быстрый стерео/фазовый сплиттер (DSP)'.".to_string());
    }
    if !status.separator_installed {
        return Err("Пакет audio-separator не установлен в среде Python. Нажмите кнопку 'Установить audio-separator' в панели UVR5 или выберите 'Быстрый стерео/фазовый сплиттер (DSP)'.".to_string());
    }

    let python_cmd = status.python_cmd;

    // Сохраним список файлов в выходной директории ДО запуска, чтобы найти новые файлы
    let pre_files = get_files_in_dir(&norm_output_dir);

    // Python runner script: использует API audio_separator.separator.Separator напрямую
    // Это исключает любые ошибки аргументов CLI (--cpu, --use_gpu, --denoise true)
    let py_runner = r#"
import sys, os, json, traceback

input_file = sys.argv[1]
model_filename = sys.argv[2]
output_dir = sys.argv[3]
use_gpu = sys.argv[4].lower() == 'true'
denoise = sys.argv[5].lower() == 'true'

if not use_gpu:
    os.environ['CUDA_VISIBLE_DEVICES'] = ''

try:
    from audio_separator.separator import Separator
    os.makedirs(output_dir, exist_ok=True)
    
    kwargs = {
        'output_dir': output_dir,
        'output_format': 'WAV',
    }
    if denoise:
        kwargs['mdx_params'] = {'denoise': True}
        
    try:
        separator = Separator(**kwargs)
    except Exception:
        separator = Separator(output_dir=output_dir, output_format='WAV')

    print(f'Loading model: {model_filename}...')
    separator.load_model(model_filename)
    print(f'Separating: {input_file}...')
    outputs = separator.separate(input_file)
    print('SUCCESS_OUTPUT_FILES:' + json.dumps(outputs))
except Exception:
    traceback.print_exc()
    sys.exit(1)
"#;

    let mut cmd = tokio::process::Command::new(&python_cmd);
    cmd.args(&[
        "-c",
        py_runner,
        &norm_input,
        &model_filename,
        &norm_output_dir,
        if use_gpu { "true" } else { "false" },
        if denoise { "true" } else { "false" },
    ]);
    cmd.env("PYTHONIOENCODING", "utf-8");
    if !use_gpu {
        cmd.env("CUDA_VISIBLE_DEVICES", "");
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Запуск процесса разделения
    let mut child = cmd.spawn()
        .map_err(|e| format!("Не удалось запустить процесс Python audio-separator: {}", e))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let log_history = Arc::new(Mutex::new(Vec::<String>::new()));
    let output_files_found = Arc::new(Mutex::new(Vec::<String>::new()));

    let log_history_clone = log_history.clone();
    let output_files_clone = output_files_found.clone();
    let app_handle_prog = app_handle.clone();
    let model_filename_clone = model_filename.clone();

    // Прогресс бар, парсинг логов и сохранение вывода для отладки
    let monitor_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                line_res = stdout_reader.next_line() => {
                    match line_res {
                        Ok(Some(line)) => {
                            if line.starts_with("SUCCESS_OUTPUT_FILES:") {
                                let json_part = &line["SUCCESS_OUTPUT_FILES:".len()..];
                                if let Ok(parsed) = serde_json::from_str::<Vec<String>>(json_part) {
                                    let mut out = output_files_clone.lock().await;
                                    *out = parsed;
                                }
                            } else {
                                parse_and_emit_progress(&app_handle_prog, &line, &model_filename_clone);
                            }
                            let mut history = log_history_clone.lock().await;
                            if history.len() > 60 { history.remove(0); }
                            history.push(line);
                        }
                        _ => break,
                    }
                }
                line_res = stderr_reader.next_line() => {
                    match line_res {
                        Ok(Some(line)) => {
                            parse_and_emit_progress(&app_handle_prog, &line, &model_filename_clone);
                            let mut history = log_history_clone.lock().await;
                            if history.len() > 60 { history.remove(0); }
                            history.push(line);
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    let status_code = child.wait().await.map_err(|e| e.to_string())?;
    let _ = monitor_task.await;

    if !status_code.success() {
        let history = log_history.lock().await;
        let last_logs = history.join("\n");
        let diagnostic = if last_logs.contains("No module named 'audio_separator'") {
            "Библиотека audio-separator не найдена в текущем Python окружении. Нажмите кнопку 'Установить audio-separator'.".to_string()
        } else if last_logs.contains("No module named 'onnxruntime'") || last_logs.contains("onnxruntime") {
            "Отсутствует библиотека onnxruntime или onnxruntime-gpu. Переустановите зависимости через кнопку 'Установить audio-separator'.".to_string()
        } else if last_logs.contains("CUDA") || last_logs.contains("OutOfMemory") || last_logs.contains("out of memory") {
            "Недостаточно видеопамяти GPU (CUDA). Отключите 'GPU CUDA' или выберите более компактную модель.".to_string()
        } else if last_logs.contains("ConnectionError") || last_logs.contains("HTTPError") || last_logs.contains("huggingface") || last_logs.contains("download") {
            "Ошибка загрузки модели с HuggingFace/GitHub. Проверьте подключение к сети интернет.".to_string()
        } else if last_logs.contains("unrecognized arguments") {
            "Несовместимые аргументы CLI audio-separator.".to_string()
        } else {
            format!("Процесс audio-separator завершился с кодом ошибки {}", status_code.code().unwrap_or(-1))
        };

        return Err(format!(
            "{}\n\nПодробности ошибки:\n{}",
            diagnostic,
            if last_logs.trim().is_empty() { "Нет вывода от процесса" } else { &last_logs }
        ));
    }

    // 1. Проверяем файлы из SUCCESS_OUTPUT_FILES
    {
        let parsed_files = output_files_found.lock().await;
        if !parsed_files.is_empty() {
            if let Some(vocal_file) = parsed_files.iter().find(|f| f.contains("Vocals") || f.contains("vocals") || f.contains("voice")) {
                let full_path = if Path::new(vocal_file).is_absolute() {
                    vocal_file.clone()
                } else {
                    Path::new(&norm_output_dir).join(vocal_file).to_string_lossy().to_string()
                };
                if Path::new(&full_path).exists() {
                    return Ok(full_path);
                }
            }
            if let Some(first_file) = parsed_files.first() {
                let full_path = if Path::new(first_file).is_absolute() {
                    first_file.clone()
                } else {
                    Path::new(&norm_output_dir).join(first_file).to_string_lossy().to_string()
                };
                if Path::new(&full_path).exists() {
                    return Ok(full_path);
                }
            }
        }
    }

    // 2. Ищем новые файлы в output_dir
    let post_files = get_files_in_dir(&norm_output_dir);
    let mut new_files: Vec<String> = post_files.iter()
        .filter(|f| !pre_files.contains(*f))
        .cloned()
        .collect();

    new_files.sort_by(|a, b| {
        let meta_a = std::fs::metadata(a).map(|m| m.modified().unwrap_or(SystemTime::UNIX_EPOCH)).unwrap_or(SystemTime::UNIX_EPOCH);
        let meta_b = std::fs::metadata(b).map(|m| m.modified().unwrap_or(SystemTime::UNIX_EPOCH)).unwrap_or(SystemTime::UNIX_EPOCH);
        meta_b.cmp(&meta_a)
    });

    if let Some(vocal_file) = new_files.iter().find(|f| f.contains("Vocals") || f.contains("vocals") || f.contains("voice")) {
        return Ok(vocal_file.clone());
    }

    if let Some(new_file) = new_files.first() {
        return Ok(new_file.clone());
    }

    // 3. Ищем последний модифицированный файл с похожим именем
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

    if let Some(vocal_file) = matched_files.iter().find(|f| f.contains("Vocals") || f.contains("vocals") || f.contains("voice")) {
        return Ok(vocal_file.clone());
    }

    if let Some(matched) = matched_files.first() {
        return Ok(matched.clone());
    }

    Err("Не удалось обнаружить результат разделения в выходной папке. Проверьте права доступа и свободное место на диске.".to_string())
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
