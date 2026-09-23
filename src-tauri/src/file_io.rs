use std::fs;
use std::path::{Path, PathBuf};
use serde::Serialize;
use hound;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use crate::process_utils::CommandExtHide;

fn url_decode(input: &str) -> String {
    let mut bytes = Vec::new();
    let chars: Vec<u8> = input.bytes().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == b'%' && i + 2 < chars.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&chars[i+1..=i+2]).unwrap_or(""), 16) {
                bytes.push(b);
                i += 3;
                continue;
            }
        }
        bytes.push(chars[i]);
        i += 1;
    }
    String::from_utf8(bytes).unwrap_or_else(|_| input.to_string())
}

pub fn normalize_windows_path(path_str: &str) -> String {
    let mut s = path_str.trim().to_string();
    if s.is_empty() {
        return s;
    }

    // Strip asset/tauri/file URL schemes and hosts
    if s.starts_with("http://asset.localhost/") {
        s = s["http://asset.localhost/".len()..].to_string();
    } else if s.starts_with("https://asset.localhost/") {
        s = s["https://asset.localhost/".len()..].to_string();
    } else if s.starts_with("asset://localhost/") {
        s = s["asset://localhost/".len()..].to_string();
    } else if s.starts_with("asset://") {
        s = s["asset://".len()..].to_string();
    } else if s.starts_with("tauri://localhost/") {
        s = s["tauri://localhost/".len()..].to_string();
    } else if s.starts_with("file:///") {
        s = s["file:///".len()..].to_string();
    } else if s.starts_with("file://") {
        s = s["file://".len()..].to_string();
    } else if s.starts_with("file:") {
        s = s["file:".len()..].to_string();
    }

    // URL decode if needed (e.g. %20 -> space, %D0%9E... -> Cyrillic)
    if s.contains('%') {
        s = url_decode(&s);
    }

    // Handle Windows Extended Paths prefix (e.g. \\?\C:\... or \\?\UNC\server\share)
    if s.starts_with(r"\\?\UNC\") || s.starts_with("//?/UNC/") {
        s = format!(r"\\{}", &s[8..]);
    } else if s.starts_with(r"\\?\") || s.starts_with(r"\\.\") || s.starts_with("//?/") || s.starts_with("//./") {
        s = s[4..].to_string();
    }

    // If path starts with leading slash before Windows drive letter: "/C:/..." or "\C:\..." -> "C:/..."
    if (s.starts_with('/') || s.starts_with('\\')) && s.len() > 3 {
        let bytes = s.as_bytes();
        if bytes[1].is_ascii_alphabetic() && (bytes[2] == b':' || bytes[2] == b'|') {
            s = s[1..].to_string();
        }
    }

    // Replace drive pipe syntax if present: C|/ -> C:/
    if s.len() >= 2 {
        let bytes = s.as_bytes();
        if bytes[0].is_ascii_alphabetic() && bytes[1] == b'|' {
            s.replace_range(1..2, ":");
        }
    }

    #[cfg(target_os = "windows")]
    {
        if (s.starts_with('/') || s.starts_with('\\')) && !s.contains(":\\") && !s.contains(":/") {
            let path = Path::new(&s);
            let mut ancestor = path;
            let mut components = Vec::new();
            
            while !ancestor.exists() {
                if let Some(parent) = ancestor.parent() {
                    if let Some(name) = ancestor.file_name() {
                        components.push(name.to_string_lossy().to_string());
                    }
                    ancestor = parent;
                } else {
                    break;
                }
            }
            
            if ancestor.exists() {
                if let Ok(canon) = ancestor.canonicalize() {
                    let mut canon_str = canon.to_string_lossy().to_string();
                    if canon_str.starts_with(r"\\?\UNC\") {
                        canon_str = format!(r"\\{}", &canon_str[8..]);
                    } else if canon_str.starts_with(r"\\?\") {
                        canon_str = canon_str[4..].to_string();
                    }
                    let mut result_path = std::path::PathBuf::from(canon_str);
                    for comp in components.iter().rev() {
                        result_path = result_path.join(comp);
                    }
                    return result_path.to_string_lossy().to_string().replace('\\', "/");
                }
            }
        }
    }

    s.replace('\\', "/")
}

#[derive(Serialize)]
pub struct AudioFileEntry {
    pub path: String,
    pub name: String,
    pub duration: f64,
}

#[derive(Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[tauri::command]
pub fn check_file_exists(path: String) -> bool {
    let norm_path = normalize_windows_path(&path);
    Path::new(&norm_path).exists()
}

#[tauri::command]
pub fn check_file_exists(path: String) -> bool {
    let norm_path = normalize_windows_path(&path);
    Path::new(&norm_path).exists()
}

#[tauri::command]
pub fn get_file_info(path: String) -> Result<FileInfo, String> {
    let norm_path = normalize_windows_path(&path);
    let p = Path::new(&norm_path);
    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    Ok(FileInfo {
        path: norm_path.clone(),
        name: p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
        size: metadata.len(),
    })
}

#[tauri::command]
pub fn read_text_file(app_handle: AppHandle, path: String) -> Result<String, String> {
    let norm_path = normalize_windows_path(&path);
    let p = Path::new(&norm_path);

    let target_path = if !p.is_absolute() {
        if let Ok(app_data) = app_handle.path().app_data_dir() {
            let app_data_file = app_data.join(&norm_path);
            if app_data_file.exists() {
                app_data_file
            } else {
                PathBuf::from(&norm_path)
            }
        } else {
            PathBuf::from(&norm_path)
        }
    } else {
        PathBuf::from(&norm_path)
    };

    fs::read_to_string(&target_path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub fn read_binary_file(app_handle: AppHandle, path: String) -> Result<Vec<u8>, String> {
    let norm_path = normalize_windows_path(&path);
    let p = Path::new(&norm_path);

    let target_path = if !p.is_absolute() {
        if let Ok(app_data) = app_handle.path().app_data_dir() {
            let app_data_file = app_data.join(&norm_path);
            if app_data_file.exists() {
                app_data_file
            } else {
                PathBuf::from(&norm_path)
            }
        } else {
            PathBuf::from(&norm_path)
        }
    } else {
        PathBuf::from(&norm_path)
    };

    fs::read(&target_path).map_err(|e| format!("Failed to read binary file: {}", e))
}

#[tauri::command]
pub fn list_audio_files(folder_path: String) -> Result<Vec<AudioFileEntry>, String> {
    let norm_folder_path = normalize_windows_path(&folder_path);
    let mut entries = Vec::new();
    let paths = fs::read_dir(norm_folder_path).map_err(|e| e.to_string())?;

    for path_result in paths {
        if let Ok(path_entry) = path_result {
            let path = path_entry.path();
            if path.is_file() {
                let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                let is_audio = ["wav", "mp3", "flac", "ogg", "m4a", "aac", "wma", "aiff", "aif"].contains(&ext.as_str());
                if is_audio {
                    let duration = if ext == "wav" {
                        match hound::WavReader::open(&path) {
                            Ok(reader) => {
                                let spec = reader.spec();
                                reader.duration() as f64 / spec.sample_rate as f64
                            }
                            Err(_) => 0.0,
                        }
                    } else {
                        0.0
                    };

                    entries.push(AudioFileEntry {
                        path: path.to_str().unwrap_or("").to_string(),
                        name: path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
                        duration,
                    });
                }
            }
        }
    }
    Ok(entries)
}

#[tauri::command]
pub fn write_audio_file(path: String, data: Vec<u8>) -> Result<(), String> {
    let norm_path = normalize_windows_path(&path);
    fs::write(norm_path, data).map_err(|e| format!("Failed to write audio file: {}", e))
}

pub fn find_ffmpeg_path() -> String {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidates = [
                exe_dir.join("ffmpeg.exe"),
                exe_dir.join("bin").join("ffmpeg.exe"),
                exe_dir.join("bin").join("ffmpeg-x86_64-pc-windows-msvc.exe"),
                exe_dir.join("ffmpeg"),
                exe_dir.join("bin").join("ffmpeg"),
            ];
            for c in candidates {
                if c.is_file() {
                    return c.to_string_lossy().to_string();
                }
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [
            cwd.join("src-tauri").join("bin").join("ffmpeg.exe"),
            cwd.join("src-tauri").join("bin").join("ffmpeg-x86_64-pc-windows-msvc.exe"),
            cwd.join("bin").join("ffmpeg.exe"),
            cwd.join("src-tauri").join("bin").join("ffmpeg"),
            cwd.join("bin").join("ffmpeg"),
        ];
        for c in candidates {
            if c.is_file() {
                return c.to_string_lossy().to_string();
            }
        }
    }
    "ffmpeg".to_string()
}

#[tauri::command]
pub async fn save_media_recorder_take(project_path: String, role: String, data: Vec<u8>) -> Result<String, String> {
    let norm_project_path = normalize_windows_path(&project_path);
    let epoch_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    
    // Use hierarchy: {project_path}/takes/
    let takes_dir = Path::new(&norm_project_path).join("takes");
    if !takes_dir.exists() {
        fs::create_dir_all(&takes_dir).map_err(|e| e.to_string())?;
    }

    let is_backstage = role.contains("backstage");
    let file_ext = if is_backstage { "mp4" } else { "wav" };
    let file_name = format!("take_{}_{}.{}", role, epoch_ms, file_ext);
    
    // Write webm data to a temporary file in takes dir
    let temp_name = format!("temp_{}.webm", epoch_ms);
    let temp_path = takes_dir.join(&temp_name);
    fs::write(&temp_path, data).map_err(|e| e.to_string())?;

    let target_path = takes_dir.join(&file_name);

    // Use FFmpeg to convert
    let ffmpeg_bin = find_ffmpeg_path();
    let mut command = std::process::Command::new(&ffmpeg_bin);
    command.hide_window();
    command.arg("-y").arg("-i").arg(&temp_path);
    
    if is_backstage {
        command.args(&[
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "28",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-ar", "48000",
            "-ac", "1",
        ]).arg(&target_path);
    } else {
        command.args(&[
            "-ar", "48000",
            "-ac", "1",
        ]).arg(&target_path);
    }

    let status = command.output().map_err(|e| e.to_string())?;

    // Clean up temporary webm file
    let _ = fs::remove_file(&temp_path);

    if !status.status.success() {
        return Err(format!("FFmpeg failed: {}", String::from_utf8_lossy(&status.stderr)));
    }

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn init_project_folder(path: String) -> Result<(), String> {
    let norm_path = normalize_windows_path(&path);
    let project_dir = Path::new(&norm_path);
    
    // Create hierarchy
    let subdirs = ["takes", "proxies", "exports", "assets"];
    for dir in subdirs {
        let full_path = project_dir.join(dir);
        if !full_path.exists() {
            fs::create_dir_all(&full_path).map_err(|e| format!("Failed to create subdir {}: {}", dir, e))?;
        }
    }
    
    let dub_dir = project_dir.join(".dubstudio");
    if !dub_dir.exists() {
        fs::create_dir_all(&dub_dir).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn save_project_file(app_handle: AppHandle, path: String, data: String) -> Result<(), String> {
    let norm_path = normalize_windows_path(&path);
    let p = Path::new(&norm_path);

    let target_path = if !p.is_absolute() {
        if let Ok(app_data) = app_handle.path().app_data_dir() {
            let _ = fs::create_dir_all(&app_data);
            app_data.join(&norm_path)
        } else {
            PathBuf::from(&norm_path)
        }
    } else {
        PathBuf::from(&norm_path)
    };

    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            let _ = fs::create_dir_all(parent);
        }
    }

    fs::write(&target_path, data).map_err(|e| format!("Failed to save project file: {}", e))
}

#[tauri::command]
pub async fn copy_file(src: String, dest: String) -> Result<String, String> {
    let norm_src = normalize_windows_path(&src);
    let norm_dest = normalize_windows_path(&dest);
    let dest_path = Path::new(&norm_dest);
    if let Some(parent) = dest_path.parent() {
        if !parent.exists() {
            let _ = fs::create_dir_all(parent);
        }
    }
    fs::copy(&norm_src, &norm_dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    Ok(norm_dest)
}

#[tauri::command]
pub async fn copy_file_to_project(
    _app_handle: tauri::AppHandle,
    src: Option<String>,
    dest_dir: Option<String>,
    src_path: Option<String>,
    dest_path: Option<String>,
) -> Result<String, String> {
    let actual_src = src.or(src_path).ok_or("No source path provided for copy_file_to_project")?;
    let actual_dest = dest_dir.or(dest_path).ok_or("No destination provided for copy_file_to_project")?;

    let norm_src = normalize_windows_path(&actual_src);
    let norm_dest = normalize_windows_path(&actual_dest);
    let src_p = Path::new(&norm_src);

    if !src_p.exists() {
        return Err(format!("Source file does not exist: {}", norm_src));
    }

    let file_name = src_p.file_name().ok_or("Invalid source file name")?;
    
    // Check if target is directly a file (has an extension) or a directory
    let target_dest_p = Path::new(&norm_dest);
    let final_dest_path = if target_dest_p.extension().is_some() {
        PathBuf::from(&norm_dest)
    } else {
        target_dest_p.join(file_name)
    };
    
    if let Some(parent) = final_dest_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create destination parent folder: {}", e))?;
        }
    }

    // High-speed native copy without running FFmpeg for WAV, FLAC, MP3, OGG, AAC, M4A, etc.
    // Audio engine & audio_buffer_manager natively decode compressed audio via Symphonia
    // and handle sinc-resampling on the fly via rubato during playback / export.
    fs::copy(&src_p, &final_dest_path).map_err(|e| format!("Failed to copy file to project: {}", e))?;

    let dest_str = final_dest_path.to_string_lossy().to_string();
    println!("[copy_file_to_project] Fast copied {} -> {}", norm_src, dest_str);

    Ok(dest_str)
}

#[tauri::command]
pub async fn ensure_track_audio_wav(app_handle: AppHandle, file_path: String) -> Result<String, String> {
    let norm_path = normalize_windows_path(&file_path);
    let src = PathBuf::from(&norm_path);
    if !src.exists() {
        return Err(format!("Файл аудио не найден: {}", norm_path));
    }

    // 1. Если исходный файл уже является валидным WAV (любой частоты дискретизации), возвращаем его сразу
    if hound::WavReader::open(&src).is_ok() {
        return Ok(norm_path);
    }

    // 2. Если это стандартный поддерживаемый аудиоформат (WAV, MP3, FLAC, OGG, M4A, AAC, WMA),
    // наш движок (audio_buffer_manager + rubato) читает его нативно и ресэмплирует на лету.
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    if ["wav", "mp3", "flac", "ogg", "m4a", "aac", "wma", "aiff", "aif"].contains(&ext.as_str()) {
        return Ok(norm_path);
    }

    // 3. Для прочих нетипичных форматов преобразуем в .wav в той же папке через FFmpeg
    let mut dest = src.clone();
    dest.set_extension("wav");
    let dest_str = dest.to_string_lossy().to_string();

    if dest.exists() {
        if let (Ok(src_meta), Ok(dest_meta)) = (src.metadata(), dest.metadata()) {
            if let (Ok(src_mtime), Ok(dest_mtime)) = (src_meta.modified(), dest_meta.modified()) {
                if dest_mtime >= src_mtime {
                    if hound::WavReader::open(&dest).is_ok() {
                        return Ok(dest_str);
                    }
                }
            }
        }
    }

    println!("[ensure_track_audio_wav] Converting non-standard audio container {} to WAV -> {}", norm_path, dest_str);

    let mut converted = false;
    if let Ok(ffmpeg_cmd) = app_handle.shell().sidecar("ffmpeg") {
        if let Ok(out) = ffmpeg_cmd.args(&[
            "-y", "-i", &norm_path,
            "-ar", "48000", "-c:a", "pcm_s16le",
            &dest_str
        ]).output().await {
            if out.status.success() {
                converted = true;
            }
        }
    }

    if !converted {
        let ffmpeg_bin = find_ffmpeg_path();
        let out = tokio::process::Command::new(&ffmpeg_bin).hide_window().args(&[
            "-y", "-i", &norm_path,
            "-ar", "48000", "-c:a", "pcm_s16le",
            &dest_str
        ]).output().await.map_err(|e| format!("Не удалось запустить ffmpeg для конвертации: {}", e))?;

        if !out.status.success() {
            return Err(format!("Ошибка конвертации в WAV через ffmpeg: {}", String::from_utf8_lossy(&out.stderr)));
        }
    }

    Ok(dest_str)
}

/// Гарантирует, что по указанному пути находится валидный WAV файл с RIFF заголовком.
/// Если файл имеет другой формат (FLAC, MP3, AAC, M4A, OGG) или невалидный RIFF заголовок,
/// он автоматически декодируется через FFmpeg во временный WAV файл.
pub fn ensure_valid_wav_path(path: &Path) -> Result<(PathBuf, bool), String> {
    let norm_path_str = normalize_windows_path(&path.to_string_lossy());
    let src = PathBuf::from(&norm_path_str);
    if !src.exists() {
        return Err(format!("Аудиофайл не найден: {}", norm_path_str));
    }

    // 1. Быстрая проверка: можно ли открыть через hound::WavReader
    if hound::WavReader::open(&src).is_ok() {
        return Ok((src, false));
    }

    println!("[ensure_valid_wav_path] Файл {} не является валидным WAV. Автоматическая конвертация через FFmpeg...", norm_path_str);

    let epoch_nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let parent_dir = src.parent().unwrap_or(&src);
    let temp_wav = parent_dir.join(format!("dubstudio_conv_{}.wav", epoch_nanos));

    let ffmpeg_bin = find_ffmpeg_path();
    let output = std::process::Command::new(&ffmpeg_bin).hide_window()
        .arg("-y")
        .arg("-i").arg(&src)
        .arg("-ar").arg("48000")
        .arg("-ac").arg("2")
        .arg("-c:a").arg("pcm_s16le")
        .arg(&temp_wav)
        .output();

    match output {
        Ok(out) if out.status.success() && temp_wav.exists() => {
            if hound::WavReader::open(&temp_wav).is_ok() {
                println!("[ensure_valid_wav_path] Файл успешно конвертирован во временный WAV: {}", temp_wav.display());
                Ok((temp_wav, true))
            } else {
                let _ = std::fs::remove_file(&temp_wav);
                Err(format!("FFmpeg создал файл {}, но он не распознан как WAV", temp_wav.display()))
            }
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(format!("Ошибка FFmpeg при декодировании {}: {}", norm_path_str, stderr))
        }
        Err(e) => {
            Err(format!("Не удалось запустить FFmpeg ({}): {}", ffmpeg_bin, e))
        }
    }
}

#[tauri::command]
pub fn move_project_folder(old_path: String, new_path: String) -> Result<(), String> {
    let norm_old = normalize_windows_path(&old_path);
    let norm_new = normalize_windows_path(&new_path);
    std::fs::rename(&norm_old, &norm_new).map_err(|e| format!("Не удалось переместить папку проекта: {}", e))
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let norm = normalize_windows_path(&path);
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").hide_window()
            .arg(&norm)
            .spawn()
            .map_err(|e| format!("Не удалось открыть путь в проводнике: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").hide_window()
            .arg(&norm)
            .spawn()
            .map_err(|e| format!("Не удалось открыть путь: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").hide_window()
            .arg(&norm)
            .spawn()
            .map_err(|e| format!("Не удалось открыть путь: {}", e))?;
    }
    Ok(())
}
