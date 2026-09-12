use std::fs;
// sync
use std::path::Path;
use serde::Serialize;
use hound;

pub fn normalize_windows_path(path_str: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        if (path_str.starts_with('/') || path_str.starts_with('\\')) && !path_str.contains(":\\") && !path_str.contains(":/") {
            let path = Path::new(path_str);
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
                    if canon_str.starts_with(r"\\?\") {
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
    path_str.to_string()
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
pub fn read_text_file(path: String) -> Result<String, String> {
    let norm_path = normalize_windows_path(&path);
    fs::read_to_string(norm_path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    let norm_path = normalize_windows_path(&path);
    fs::read(norm_path).map_err(|e| format!("Failed to read binary file: {}", e))
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
                let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
                if ext.to_lowercase() == "wav" {
                    // Try to get duration using hound
                    let duration = match hound::WavReader::open(&path) {
                        Ok(reader) => {
                            let spec = reader.spec();
                            reader.duration() as f64 / spec.sample_rate as f64
                        }
                        Err(_) => 0.0,
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
    command.arg("-y").arg("-i").arg(temp_path.to_str().unwrap());
    
    if is_backstage {
        command.args(&[
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "28",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-ar", "48000",
            "-ac", "1",
            target_path.to_str().unwrap()
        ]);
    } else {
        command.args(&[
            "-ar", "48000",
            "-ac", "1",
            target_path.to_str().unwrap()
        ]);
    }

    let status = command.output().map_err(|e| e.to_string())?;

    // Clean up temporary webm file
    let _ = fs::remove_file(&temp_path);

    if !status.status.success() {
        return Err(format!("FFmpeg failed: {}", String::from_utf8_lossy(&status.stderr)));
    }

    Ok(target_path.to_str().unwrap().to_string())
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
    
    // Support legacy .dubstudio for compatibility with older takes if needed, 
    // but the app should transition to 'takes' folder.
    let dub_dir = project_dir.join(".dubstudio");
    if !dub_dir.exists() {
        fs::create_dir_all(&dub_dir).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn save_project_file(path: String, data: String) -> Result<(), String> {
    let norm_path = normalize_windows_path(&path);
    fs::write(norm_path, data).map_err(|e| format!("Failed to save project file: {}", e))
}

#[tauri::command]
pub async fn copy_file_to_project(app_handle: tauri::AppHandle, src: String, dest_dir: String) -> Result<String, String> {
    use std::fs;
    use std::path::Path;
    use tauri_plugin_shell::ShellExt;

    let norm_src = normalize_windows_path(&src);
    let norm_dest_dir = normalize_windows_path(&dest_dir);
    let src_path = Path::new(&norm_src);
    let file_name = src_path.file_name().ok_or("Invalid source file name")?;
    
    let mut dest_path = Path::new(&norm_dest_dir).join(file_name);
    
    if let Some(parent) = dest_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create destination parent folder: {}", e))?;
        }
    }

    let ext = src_path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    let is_audio = ["wav", "mp3", "flac", "ogg", "m4a", "aac", "wma"].contains(&ext.as_str());

    if is_audio {
        if let Ok(ffprobe_cmd) = app_handle.shell().sidecar("ffprobe") {
            if let Ok(output) = ffprobe_cmd.args(&[
                "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=sample_rate",
                "-of", "default=noprint_wrappers=1:nokey=1",
                &norm_src,
            ]).output().await {
                if output.status.success() {
                    let stdout_str = String::from_utf8_lossy(&output.stdout);
                    if let Ok(sr) = stdout_str.trim().parse::<u32>() {
                        if sr != 48000 {
                            // КРИТИЧЕСКИ ВАЖНО: Меняем расширение на wav для совместимости с pcm_s16le
                            dest_path.set_extension("wav");
                            
                            println!("[copy_file_to_project] Resampling from {}Hz to 48000Hz...", sr);
                            if let Ok(ffmpeg_cmd) = app_handle.shell().sidecar("ffmpeg") {
                                if let Ok(out) = ffmpeg_cmd.args(&[
                                    "-y", "-i", &norm_src,
                                    "-ar", "48000", "-c:a", "pcm_s16le", 
                                    dest_path.to_str().unwrap()
                                ]).output().await {
                                    if out.status.success() {
                                        return Ok(dest_path.to_str().unwrap().to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Фоллбэк, если ресемплинг не нужен или не удался
    let fallback_dest = Path::new(&norm_dest_dir).join(file_name);
    fs::copy(&norm_src, &fallback_dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    Ok(fallback_dest.to_str().unwrap().to_string())
}
