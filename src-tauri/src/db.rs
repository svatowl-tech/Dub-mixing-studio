use serde::{Deserialize, Serialize};
// sync
use sqlx::{sqlite::SqlitePoolOptions, Pool, Sqlite, Row};
use std::sync::Arc;
use tokio::sync::Mutex;
use std::fs;
use tauri::State;
use hound;

use crate::logger::log_debug;

// Define an app state that holds the DB pool
pub struct AppState {
    pub db: Arc<Mutex<Option<Pool<Sqlite>>>>,
}

// --- STRUCTURES THAT MATCH TYPESCRIPT INTERFACES ---

#[derive(Serialize, Deserialize, Debug)]
pub struct SubtitleLine {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub role: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct AudioSettings {
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub output_device_id: Option<String>,
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain_control: bool,
    pub sample_rate: i64,
    pub bit_depth: i64,
    #[serde(default)]
    pub asio_mode: Option<bool>,
    // Omitting exhaustive fields to keep example minimal, but storing as JSON is foolproof
}

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub config_json: String, // AudioSettings, subs, roles dumped as JSON
}

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct TrackRow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub volume: f64,
    pub is_muted: bool,
}

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct SegmentRow {
    pub id: String,
    pub track_id: String,
    pub start_time: f64,
    pub duration: f64,
    pub file_offset: f64,
    pub file_duration: f64,
    pub file_path: Option<String>,
    pub backstage_video_path: Option<String>,
    pub gain: f64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub missing_segments: Vec<SegmentData>,
    pub orphaned_files: Vec<String>,
}

// Full Composite Structs for frontend sending
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SegmentData {
    pub id: String,
    pub start_time: f64,
    pub duration: f64,
    pub file_offset: f64,
    pub file_duration: f64,
    pub file_path: Option<String>,
    pub backstage_video_path: Option<String>,
    pub gain: f64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackData {
    pub id: String,
    pub name: String,
    pub volume: f64,
    pub is_muted: bool,
    pub segments: Vec<SegmentData>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ProjectData {
    pub id: String,
    pub name: String,
    pub audio_offset_ms: Option<f64>,
    // we use a Catch_all JSON serde approach for the flexible config
    #[serde(flatten)]
    pub config: serde_json::Value,
    pub tracks: Vec<TrackData>,
}

// --- DATABASE INITIALIZATION ---

pub async fn init_db(db_path: &str) -> Result<Pool<Sqlite>, sqlx::Error> {
    if !std::path::Path::new(db_path).exists() {
        fs::File::create(db_path).unwrap();
    }
    
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&format!("sqlite://{}", db_path))
        .await?;

    // MIGRATION: Schema Setup
    sqlx::query("
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            config_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subtitles (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            start_time REAL NOT NULL,
            end_time REAL NOT NULL,
            text TEXT NOT NULL,
            role TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            volume REAL NOT NULL DEFAULT 1.0,
            is_muted BOOLEAN NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS segments (
            id TEXT PRIMARY KEY,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            start_time REAL NOT NULL,
            duration REAL NOT NULL,
            file_offset REAL NOT NULL,
            file_duration REAL NOT NULL,
            file_path TEXT,
            backstage_video_path TEXT,
            gain REAL NOT NULL DEFAULT 1.0
        );
    ").execute(&pool).await?;

    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN audio_offset_ms REAL NOT NULL DEFAULT 0.0;").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE segments ADD COLUMN backstage_video_path TEXT;").execute(&pool).await;

    Ok(pool)
}

// --- CRUD OPERATIONS ---

#[tauri::command]
pub async fn save_subtitles(state: State<'_, AppState>, project_id: String, subtitles: Vec<SubtitleLine>) -> Result<(), String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    // Clear existing for this project to overwrite
    sqlx::query("DELETE FROM subtitles WHERE project_id = ?")
        .bind(&project_id)
        .execute(pool)
        .await.map_err(|e| e.to_string())?;

    for line in subtitles {
        sqlx::query("
            INSERT INTO subtitles (id, project_id, start_time, end_time, text, role)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ")
        .bind(&line.id)
        .bind(&project_id)
        .bind(line.start)
        .bind(line.end)
        .bind(&line.text)
        .bind(&line.role)
        .execute(pool)
        .await.map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn save_project_to_db(state: State<'_, AppState>, payload: ProjectData) -> Result<(), String> {
    log_debug(&format!("save_project_to_db called for project: {} ({})", payload.name, payload.id));
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    let config_str = serde_json::to_string(&payload.config).unwrap_or("{}".to_string());

    log_debug(&format!("Saving {} tracks...", payload.tracks.len()));

    // UPSERT Project
    sqlx::query("
        INSERT INTO projects (id, name, config_json, audio_offset_ms) 
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(id) DO UPDATE SET 
        name=excluded.name, config_json=excluded.config_json, audio_offset_ms=excluded.audio_offset_ms
    ")
    .bind(&payload.id)
    .bind(&payload.name)
    .bind(&config_str)
    .bind(payload.audio_offset_ms.unwrap_or(0.0))
    .execute(pool)
    .await.map_err(|e| e.to_string())?;

    for track in &payload.tracks {
        // UPSERT Track
        sqlx::query("
            INSERT INTO tracks (id, project_id, name, volume, is_muted) 
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(id) DO UPDATE SET 
            name=excluded.name, volume=excluded.volume, is_muted=excluded.is_muted
        ")
        .bind(&track.id)
        .bind(&payload.id)
        .bind(&track.name)
        .bind(track.volume)
        .bind(track.is_muted)
        .execute(pool)
        .await.map_err(|e| e.to_string())?;

        for seg in &track.segments {
            // UPSERT Segment
            sqlx::query("
                INSERT INTO segments (id, track_id, start_time, duration, file_offset, file_duration, file_path, backstage_video_path, gain) 
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(id) DO UPDATE SET 
                start_time=excluded.start_time, duration=excluded.duration, 
                file_offset=excluded.file_offset, file_duration=excluded.file_duration, 
                file_path=excluded.file_path, backstage_video_path=excluded.backstage_video_path, gain=excluded.gain
            ")
            .bind(&seg.id)
            .bind(&track.id)
            .bind(seg.start_time)
            .bind(seg.duration)
            .bind(seg.file_offset)
            .bind(seg.file_duration)
            .bind(&seg.file_path)
            .bind(&seg.backstage_video_path)
            .bind(seg.gain)
            .execute(pool)
            .await.map_err(|e| e.to_string())?;
        }
    }

    // --- Cleanup deleted tracks ---
    let track_ids: Vec<String> = payload.tracks.iter().map(|t| t.id.clone()).collect();
    let track_ids_str = track_ids.join("','");
    
    if !track_ids.is_empty() {
        let q_str = format!("DELETE FROM tracks WHERE project_id = ? AND id NOT IN ('{}')", track_ids_str);
        sqlx::query(&q_str).bind(&payload.id).execute(pool).await.map_err(|e| e.to_string())?;
    } else {
        sqlx::query("DELETE FROM tracks WHERE project_id = ?").bind(&payload.id).execute(pool).await.map_err(|e| e.to_string())?;
    }

    // --- Cleanup deleted segments within retained tracks ---
    for track in &payload.tracks {
        let seg_ids: Vec<String> = track.segments.iter().map(|s| s.id.clone()).collect();
        let seg_ids_str = seg_ids.join("','");
        
        if !seg_ids.is_empty() {
            let q_str = format!("DELETE FROM segments WHERE track_id = ? AND id NOT IN ('{}')", seg_ids_str);
            sqlx::query(&q_str).bind(&track.id).execute(pool).await.map_err(|e| e.to_string())?;
        } else {
            sqlx::query("DELETE FROM segments WHERE track_id = ?").bind(&track.id).execute(pool).await.map_err(|e| e.to_string())?;
        }
    }

    log_debug("save_project_to_db finished successfully");
    Ok(())
}

#[tauri::command]
pub async fn load_project_from_db(state: State<'_, AppState>, project_id: String) -> Result<ProjectData, String> {
    log_debug(&format!("load_project_from_db called for project_id: {}", project_id));
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    let proj_row = sqlx::query("SELECT id, name, config_json, audio_offset_ms FROM projects WHERE id = ?")
        .bind(&project_id)
        .fetch_optional(pool)
        .await.map_err(|e| e.to_string())?;

    let proj_row = proj_row.ok_or("Project not found")?;

    log_debug(&format!("Found project name: {}", proj_row.get::<String, _>("name")));

    let config_json: String = proj_row.get("config_json");
    let config: serde_json::Value = serde_json::from_str(&config_json).unwrap_or(serde_json::json!({}));

    // Fetch Tracks
    let tracks_rows = sqlx::query("SELECT id, name, volume, is_muted FROM tracks WHERE project_id = ?")
        .bind(&project_id)
        .fetch_all(pool)
        .await.map_err(|e| e.to_string())?;

    let mut tracks_data = Vec::new();

    for trow in tracks_rows {
        // Fetch Segments
        let segs_rows = sqlx::query("SELECT id, start_time, duration, file_offset, file_duration, file_path, backstage_video_path, gain FROM segments WHERE track_id = ?")
            .bind(trow.get::<&str, _>("id").to_string())
            .fetch_all(pool)
            .await.map_err(|e| e.to_string())?;

        let mut segments_data = Vec::new();
        for srow in segs_rows {
            segments_data.push(SegmentData {
                id: srow.get("id"),
                start_time: srow.get("start_time"),
                duration: srow.get("duration"),
                file_offset: srow.get("file_offset"),
                file_duration: srow.get("file_duration"),
                file_path: srow.get("file_path"),
                backstage_video_path: srow.get("backstage_video_path"),
                gain: srow.get("gain"),
            });
        }

        tracks_data.push(TrackData {
            id: trow.get("id"),
            name: trow.get("name"),
            volume: trow.get("volume"),
            is_muted: trow.get::<i64, _>("is_muted") == 1,
            segments: segments_data,
        });
    }

    Ok(ProjectData {
        id: proj_row.get("id"),
        name: proj_row.get("name"),
        audio_offset_ms: Some(proj_row.get("audio_offset_ms")),
        config: config,
        tracks: tracks_data,
    })
}

#[tauri::command]
pub async fn load_segments_in_range(_state: State<'_, AppState>, _project_id: String, _start: f64, _end: f64) -> Result<Vec<SegmentData>, String> {
    Ok(Vec::new())
}

// --- MIGRATION UTILITY ---

#[tauri::command]
pub async fn migrate_json_to_db(state: State<'_, AppState>, json_string: String) -> Result<String, String> {
    // 1. Parse older JSON payload directly
    let parsed: serde_json::Value = serde_json::from_str(&json_string).map_err(|e| format!("Invalid JSON: {}", e))?;
    
    // 2. Identify the project id
    let pid = parsed.get("id").and_then(|i| i.as_str()).unwrap_or("missing_id");
    let pname = parsed.get("name").and_then(|i| i.as_str()).unwrap_or("Migrated Project");

    // 3. Serialize flexible portions
    let mut config = parsed.clone();
    config.as_object_mut().unwrap().remove("tracks");

    // 4. Map directly to our standard format and save
    let mut track_vec = Vec::new();
    if let Some(tracks) = parsed.get("tracks").and_then(|t| t.as_array()) {
        for t in tracks {
            let mut seg_vec = Vec::new();
            if let Some(segs) = t.get("segments").and_then(|s| s.as_array()) {
                for s in segs {
                    seg_vec.push(SegmentData {
                        id: s.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                        start_time: s.get("startTime").and_then(|i| i.as_f64()).unwrap_or(0.0),
                        duration: s.get("duration").and_then(|i| i.as_f64()).unwrap_or(0.0),
                        file_offset: s.get("fileOffset").and_then(|i| i.as_f64()).unwrap_or(0.0),
                        file_duration: s.get("fileDuration").and_then(|i| i.as_f64()).unwrap_or(0.0),
                        file_path: s.get("filePath").and_then(|i| i.as_str()).map(|x| x.to_string()),
                        backstage_video_path: s.get("backstageVideoPath").and_then(|i| i.as_str()).map(|x| x.to_string()),
                        gain: s.get("gain").and_then(|i| i.as_f64()).unwrap_or(1.0),
                    });
                }
            }

            track_vec.push(TrackData {
                id: t.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                name: t.get("name").and_then(|i| i.as_str()).unwrap_or("Track").to_string(),
                volume: t.get("volume").and_then(|i| i.as_f64()).unwrap_or(1.0),
                is_muted: t.get("isMuted").and_then(|i| i.as_bool()).unwrap_or(false),
                segments: seg_vec,
            });
        }
    }

    let pdata = ProjectData {
        id: pid.to_string(),
        name: pname.to_string(),
        audio_offset_ms: parsed.get("audioOffsetMs").and_then(|i| i.as_f64()),
        config,
        tracks: track_vec,
    };

    save_project_to_db(state, pdata).await?;

    Ok(pid.to_string())
}

#[tauri::command]
pub async fn generate_stress_test(
    state: State<'_, AppState>, 
    project_id: String, 
    track_id: String,
    project_path: String
) -> Result<(), String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    println!("Generating stress test for project {} in {}", project_id, project_path);

    // Ensure the .dubstudio dir exists
    let dub_dir = std::path::Path::new(&project_path).join(".dubstudio");
    if !dub_dir.exists() {
        fs::create_dir_all(&dub_dir).map_err(|e| e.to_string())?;
    }

    // Insert 1000 segments
    
    for i in 0..1000 {
        let segment_id = format!("stress_{}", i);
        let start_time = (i as f64) * 2.5; // Every 2.5 seconds
        let duration = 1.8;
        let file_path = dub_dir.join(format!("stress_{}.wav", i));
        let file_path_str = file_path.to_str().unwrap().to_string();

        // Create a minimal silent WAV (44.1kHz, 16bit, mono, 1sec)
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 44100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&file_path_str, spec).map_err(|e| e.to_string())?;
        for _ in 0..44100 {
            writer.write_sample(0i16).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;

        sqlx::query("
            INSERT INTO segments (id, track_id, start_time, duration, file_offset, file_duration, file_path, backstage_video_path, gain) 
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ")
        .bind(&segment_id)
        .bind(&track_id)
        .bind(start_time)
        .bind(duration)
        .bind(0.0)
        .bind(1.0)
        .bind(&file_path_str)
        .bind(None::<String>) // backstage_video_path
        .bind(1.0)
        .execute(pool)
        .await.map_err(|e| e.to_string())?;
        
        if i % 100 == 0 {
            println!("Created {} stress segments...", i);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn find_file_by_hash(
    search_root: String,
    target_hash: String,
) -> Result<Option<String>, String> {
    let root = std::path::Path::new(&search_root);
    if !root.exists() { return Ok(None); }

    let mut stack = vec![root.to_path_buf()];
    
    while let Some(current_dir) = stack.pop() {
        if let Ok(entries) = fs::read_dir(current_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.is_file() {
                    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
                    if ext.to_lowercase() == "wav" {
                        if let Ok(content) = fs::read(&path) {
                            let digest = md5::compute(content);
                            let hash = format!("{:x}", digest);
                            if hash == target_hash {
                                return Ok(Some(path.to_str().unwrap_or("").to_string()));
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn verify_project_files(
    state: State<'_, AppState>,
    project_id: String,
    project_root: String,
) -> Result<VerificationResult, String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    // 1. Get all segments for the project
    let segments_rows = sqlx::query("SELECT s.id, s.start_time, s.duration, s.file_offset, s.file_duration, s.file_path, s.backstage_video_path, s.gain FROM segments s
         JOIN tracks t ON s.track_id = t.id
         WHERE t.project_id = ?")
         .bind(&project_id)
         .fetch_all(pool)
         .await
         .map_err(|e| e.to_string())?;

    let mut missing_segments = Vec::new();
    let mut referenced_files = std::collections::HashSet::new();

    for row in segments_rows {
        let file_path: Option<String> = row.get("file_path");
        let seg_data = SegmentData {
            id: row.get("id"),
            start_time: row.get("start_time"),
            duration: row.get("duration"),
            file_offset: row.get("file_offset"),
            file_duration: row.get("file_duration"),
            file_path: file_path.clone(),
            backstage_video_path: row.get("backstage_video_path"),
            gain: row.get("gain"),
        };

        if let Some(path_str) = file_path {
            let path = std::path::Path::new(&path_str);
            if !path.exists() {
                missing_segments.push(seg_data);
            } else {
                referenced_files.insert(path_str);
            }
        } else if seg_data.duration > 0.0 {
            missing_segments.push(seg_data);
        }
    }

    // 2. Find orphaned files in .dubstudio
    let mut orphaned_files = Vec::new();
    let dub_dir = std::path::Path::new(&project_root).join(".dubstudio");
    if dub_dir.exists() {
        if let Ok(entries) = fs::read_dir(&dub_dir) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        let path_str = entry.path().to_str().unwrap_or("").to_string();
                        // Check if ends with .wav and not in referenced_files
                        if path_str.to_lowercase().ends_with(".wav") && !referenced_files.contains(&path_str) {
                            orphaned_files.push(path_str);
                        }
                    }
                }
            }
        }
    }

    Ok(VerificationResult {
        missing_segments,
        orphaned_files,
    })
}

#[tauri::command]
pub async fn calculate_file_hash(path: String) -> Result<String, String> {
    let content = fs::read(&path).map_err(|e| format!("Failed to read file for hashing: {}", e))?;
    let digest = md5::compute(content);
    Ok(format!("{:x}", digest))
}

#[tauri::command]
pub async fn cleanup_orphaned_files(files: Vec<String>) -> Result<(), String> {
    for file in files {
        if std::path::Path::new(&file).exists() {
            fs::remove_file(&file).map_err(|e| format!("Failed to delete {}: {}", file, e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn relink_segment_file(
    state: State<'_, AppState>,
    segment_id: String,
    new_path: String,
) -> Result<(), String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    sqlx::query("UPDATE segments SET file_path = ? WHERE id = ?")
        .bind(&new_path)
        .bind(&segment_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn check_project_assets(
    state: State<'_, AppState>,
    project_id: String,
    project_root: String,
) -> Result<Vec<String>, String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    // 1. Get all segments for the project
    let segments = sqlx::query("SELECT s.id, s.file_path FROM segments s
         JOIN tracks t ON s.track_id = t.id
         WHERE t.project_id = ?")
         .bind(project_id)
         .fetch_all(pool)
         .await
         .map_err(|e| e.to_string())?;

    let mut broken_segments = Vec::new();
    let dub_dir = std::path::Path::new(&project_root).join(".dubstudio");

    // 2. Check existence and try to fix
    for seg in segments {
        let id: String = seg.get("id");
        let file_path: Option<String> = seg.get("file_path");
        if let Some(path_str) = file_path {
            let path = std::path::Path::new(&path_str);
            
            if !path.exists() {
                // Try to find in .dubstudio
                let file_name = path.file_name().and_then(|f| f.to_str());
                let mut found = false;
                
                if let (Some(name), true) = (file_name, dub_dir.exists()) {
                    if let Ok(entries) = fs::read_dir(&dub_dir) {
                        for entry in entries.flatten() {
                            if entry.file_name() == name {
                                // Found: update database
                                let new_path = entry.path().to_str().unwrap().to_string();
                                sqlx::query("UPDATE segments SET file_path = ? WHERE id = ?")
                                    .bind(&new_path)
                                    .bind(&id)
                                    .execute(pool)
                                    .await
                                    .map_err(|e| e.to_string())?;
                                found = true;
                                break;
                            }
                        }
                    }
                }
                
                if !found {
                    broken_segments.push(id.clone());
                }
            }
        } else {
            // Path is None, consider broken if duration > 0
            broken_segments.push(id);
        }
    }

    Ok(broken_segments)
}
