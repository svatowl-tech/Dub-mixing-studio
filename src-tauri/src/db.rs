// ============================================================================
// DUB MIXING STUDIO PRO - UNIFIED TRANSACTIONAL SQLITE STORAGE (RUST)
// ============================================================================
// Единая схема реляционной базы данных SQLite в режиме WAL с гарантированной
// ссылочной целостностью (PRAGMA foreign_keys = ON) и полной изоляцией
// транзакций через sqlx::Transaction.
//
// Исключены любые динамические интерполяции строк в SQL запросах.
// Полная совместимость между legacy db интерфейсами, project_repository
// и timeline_history_engine.
// ============================================================================

use std::collections::HashSet;
use std::fs;
use std::sync::Arc;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    Pool, Row, Sqlite,
};
use tauri::State;
use tokio::sync::Mutex;

use crate::logger::{log_debug, log_info};

// ============================================================================
// 1. APPLICATION STATE
// ============================================================================

pub struct AppState {
    pub db: Arc<Mutex<Option<Pool<Sqlite>>>>,
}

// ============================================================================
// 2. DATA TRANSFER OBJECTS (MATCHING TYPESCRIPT CONTRACTS)
// ============================================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
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
}

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub config_json: String,
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
    #[serde(flatten)]
    pub config: serde_json::Value,
    pub tracks: Vec<TrackData>,
}

// ============================================================================
// 3. DATABASE INITIALIZATION & UNIFIED SCHEMA MIGRATION
// ============================================================================

/// Синхронно-готовящийся и надежный пул базы данных SQLite.
/// Гарантирует применение PRAGMA (WAL, foreign_keys, busy_timeout)
/// и всех схем миграций до возврата пула в runtime.
pub async fn init_db(db_path: &str) -> Result<Pool<Sqlite>, sqlx::Error> {
    if let Some(parent) = std::path::Path::new(db_path).parent() {
        let _ = fs::create_dir_all(parent);
    }

    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(options)
        .await?;

    // Применение базовых настроек производительности и целостности
    sqlx::query("PRAGMA journal_mode = WAL;").execute(&pool).await?;
    sqlx::query("PRAGMA synchronous = NORMAL;").execute(&pool).await?;
    sqlx::query("PRAGMA foreign_keys = ON;").execute(&pool).await?;
    sqlx::query("PRAGMA temp_store = MEMORY;").execute(&pool).await?;
    sqlx::query("PRAGMA cache_size = -64000;").execute(&pool).await?;

    // 1. Таблица проектов
    sqlx::query("
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sample_rate INTEGER NOT NULL DEFAULT 48000,
            frame_rate REAL NOT NULL DEFAULT 24.0,
            target_lufs REAL NOT NULL DEFAULT -14.0,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            audio_offset_ms REAL NOT NULL DEFAULT 0.0,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            config_json TEXT NOT NULL DEFAULT '{}'
        );
    ").execute(&pool).await?;

    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN sample_rate INTEGER NOT NULL DEFAULT 48000;").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN frame_rate REAL NOT NULL DEFAULT 24.0;").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN target_lufs REAL NOT NULL DEFAULT -14.0;").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN created_at TEXT NOT NULL DEFAULT '';").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN audio_offset_ms REAL NOT NULL DEFAULT 0.0;").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';").execute(&pool).await;

    // 2. Таблица аудиодорожек
    sqlx::query("
        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            track_type TEXT NOT NULL DEFAULT 'Dub',
            volume REAL NOT NULL DEFAULT 1.0,
            pan REAL NOT NULL DEFAULT 0.0,
            is_muted BOOLEAN NOT NULL DEFAULT 0,
            is_solo BOOLEAN NOT NULL DEFAULT 0,
            order_index INTEGER NOT NULL DEFAULT 0
        );
    ").execute(&pool).await?;

    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN track_type TEXT NOT NULL DEFAULT 'Dub';").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN volume REAL NOT NULL DEFAULT 1.0;").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN pan REAL NOT NULL DEFAULT 0.0;").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN is_muted BOOLEAN NOT NULL DEFAULT 0;").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN is_solo BOOLEAN NOT NULL DEFAULT 0;").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0;").execute(&pool).await;

    // 3. Таблица аудиосегментов (audio_segments)
    sqlx::query("
        CREATE TABLE IF NOT EXISTS audio_segments (
            id TEXT PRIMARY KEY,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            file_path TEXT,
            start_time REAL NOT NULL DEFAULT 0.0,
            duration REAL NOT NULL DEFAULT 0.0,
            file_offset REAL NOT NULL DEFAULT 0.0,
            file_duration REAL NOT NULL DEFAULT 0.0,
            gain REAL NOT NULL DEFAULT 1.0,
            backstage_video_path TEXT,
            is_active BOOLEAN NOT NULL DEFAULT 1
        );
    ").execute(&pool).await?;

    let _ = sqlx::query("ALTER TABLE audio_segments ADD COLUMN backstage_video_path TEXT;").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE audio_segments ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT 1;").execute(&pool).await;

    // Обратная совместимость с таблицами segments и audio_clips
    sqlx::query("
        CREATE TABLE IF NOT EXISTS segments (
            id TEXT PRIMARY KEY,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            start_time REAL NOT NULL DEFAULT 0.0,
            duration REAL NOT NULL DEFAULT 0.0,
            file_offset REAL NOT NULL DEFAULT 0.0,
            file_duration REAL NOT NULL DEFAULT 0.0,
            file_path TEXT,
            backstage_video_path TEXT,
            gain REAL NOT NULL DEFAULT 1.0
        );
    ").execute(&pool).await?;
    let _ = sqlx::query("ALTER TABLE segments ADD COLUMN backstage_video_path TEXT;").execute(&pool).await;

    sqlx::query("
        CREATE TABLE IF NOT EXISTS audio_clips (
            id TEXT PRIMARY KEY,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL DEFAULT '',
            start_time_ms REAL NOT NULL DEFAULT 0.0,
            duration_ms REAL NOT NULL DEFAULT 0.0,
            source_offset_ms REAL NOT NULL DEFAULT 0.0,
            gain_db REAL NOT NULL DEFAULT 0.0,
            is_active BOOLEAN NOT NULL DEFAULT 1,
            backstage_video_path TEXT
        );
    ").execute(&pool).await?;

    // 4. Таблица субтитров
    sqlx::query("
        CREATE TABLE IF NOT EXISTS subtitles (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            character_name TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL DEFAULT '',
            start_time_ms REAL NOT NULL DEFAULT 0.0,
            end_time_ms REAL NOT NULL DEFAULT 0.0,
            matched_clip_id TEXT
        );
    ").execute(&pool).await?;

    // 5. Таблица дельт истории (history_deltas)
    sqlx::query("
        CREATE TABLE IF NOT EXISTS history_deltas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            action_description TEXT NOT NULL DEFAULT '',
            undo_patch TEXT NOT NULL DEFAULT '[]',
            redo_patch TEXT NOT NULL DEFAULT '[]',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sequence_index INTEGER NOT NULL DEFAULT 0,
            is_current BOOLEAN NOT NULL DEFAULT 0
        );
    ").execute(&pool).await?;

    // Индексы для ускорения выборок и джойнов
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_tracks_project ON tracks(project_id);").execute(&pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_audio_segments_track ON audio_segments(track_id);").execute(&pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_audio_segments_range ON audio_segments(track_id, start_time, duration);").execute(&pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_segments_track ON segments(track_id);").execute(&pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_segments_range ON segments(track_id, start_time, duration);").execute(&pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_audio_clips_track ON audio_clips(track_id);").execute(&pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_subtitles_project ON subtitles(project_id);").execute(&pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_history_deltas_proj ON history_deltas(project_id, sequence_index);").execute(&pool).await?;

    // Инициализация подсистем project_repository и timeline_history_engine
    crate::project_repository::run_project_migrations(&pool).await?;
    crate::timeline_history_engine::run_timeline_history_migrations(&pool).await?;

    log_info("Database pool initialized synchronously with strict schema and foreign key constraints.");
    Ok(pool)
}

// ============================================================================
// 4. ATOMIC TRANSACTIONAL CRUD OPERATIONS
// ============================================================================

/// Сохранение субтитров в единой атомарной транзакции с параметризованными запросами
#[tauri::command]
pub async fn save_subtitles(
    state: State<'_, AppState>,
    project_id: String,
    subtitles: Vec<SubtitleLine>,
) -> Result<(), String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    let mut tx = pool.begin().await.map_err(|e| format!("Failed to begin transaction: {}", e))?;

    // Очистка старых строк субтитров
    sqlx::query("DELETE FROM subtitles WHERE project_id = ?")
        .bind(&project_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    // Пакетная вставка новых субтитров
    for line in subtitles {
        sqlx::query("
            INSERT INTO subtitles (id, project_id, character_name, text, start_time_ms, end_time_ms, matched_clip_id)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)
        ")
        .bind(&line.id)
        .bind(&project_id)
        .bind(&line.role)
        .bind(&line.text)
        .bind(line.start * 1000.0)
        .bind(line.end * 1000.0)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| format!("Failed to commit transaction: {}", e))?;
    Ok(())
}

/// Атомарное сохранение проекта в базе данных:
/// - Обновление метаданных
/// - Параметризованный UPSERT треков и сегментов
/// - Безопасное удаление устаревших элементов без строковой конкатенации
#[tauri::command]
pub async fn save_project_to_db(
    state: State<'_, AppState>,
    payload: ProjectData,
) -> Result<(), String> {
    log_debug(&format!("save_project_to_db called for project: {} ({})", payload.name, payload.id));
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    let config_str = serde_json::to_string(&payload.config).unwrap_or_else(|_| "{}".to_string());
    let now = Utc::now().to_rfc3339();

    let sample_rate = payload
        .config
        .get("audioSettings")
        .and_then(|a| a.get("sampleRate"))
        .and_then(|s| s.as_i64())
        .unwrap_or(48000);

    let frame_rate = payload
        .config
        .get("frameRate")
        .and_then(|f| f.as_f64())
        .unwrap_or(24.0);

    let target_lufs = payload
        .config
        .get("targetLufs")
        .and_then(|l| l.as_f64())
        .unwrap_or(-14.0);

    // Начало единой транзакции SQLite
    let mut tx = pool.begin().await.map_err(|e| format!("Failed to begin transaction: {}", e))?;

    // 1. UPSERT Проекта
    sqlx::query("
        INSERT INTO projects (
            id, name, sample_rate, frame_rate, target_lufs, created_at, updated_at, audio_offset_ms, metadata_json, config_json
        ) 
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(id) DO UPDATE SET 
            name = excluded.name,
            sample_rate = excluded.sample_rate,
            frame_rate = excluded.frame_rate,
            target_lufs = excluded.target_lufs,
            updated_at = excluded.updated_at,
            audio_offset_ms = excluded.audio_offset_ms,
            metadata_json = excluded.metadata_json,
            config_json = excluded.config_json
    ")
    .bind(&payload.id)
    .bind(&payload.name)
    .bind(sample_rate)
    .bind(frame_rate)
    .bind(target_lufs)
    .bind(&now)
    .bind(&now)
    .bind(payload.audio_offset_ms.unwrap_or(0.0))
    .bind(&config_str)
    .bind(&config_str)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    // 2. Пакетная вставка / обновление дорожек и сегментов
    let mut current_track_ids: HashSet<String> = HashSet::new();

    for (order_idx, track) in payload.tracks.iter().enumerate() {
        current_track_ids.insert(track.id.clone());

        // UPSERT Track
        sqlx::query("
            INSERT INTO tracks (id, project_id, name, track_type, volume, pan, is_muted, is_solo, order_index) 
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET 
                name = excluded.name,
                volume = excluded.volume,
                is_muted = excluded.is_muted,
                order_index = excluded.order_index
        ")
        .bind(&track.id)
        .bind(&payload.id)
        .bind(&track.name)
        .bind("Dub")
        .bind(track.volume)
        .bind(0.0)
        .bind(track.is_muted)
        .bind(false)
        .bind(order_idx as i64)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        // Обработка сегментов текущей дорожки
        let mut current_seg_ids: HashSet<String> = HashSet::new();

        for seg in &track.segments {
            current_seg_ids.insert(seg.id.clone());

            // UPSERT в audio_segments
            sqlx::query("
                INSERT INTO audio_segments (
                    id, track_id, file_path, start_time, duration, file_offset, file_duration, gain, backstage_video_path, is_active
                ) 
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)
                ON CONFLICT(id) DO UPDATE SET 
                    file_path = excluded.file_path,
                    start_time = excluded.start_time,
                    duration = excluded.duration, 
                    file_offset = excluded.file_offset,
                    file_duration = excluded.file_duration, 
                    gain = excluded.gain,
                    backstage_video_path = excluded.backstage_video_path,
                    is_active = excluded.is_active
            ")
            .bind(&seg.id)
            .bind(&track.id)
            .bind(&seg.file_path)
            .bind(seg.start_time)
            .bind(seg.duration)
            .bind(seg.file_offset)
            .bind(seg.file_duration)
            .bind(seg.gain)
            .bind(&seg.backstage_video_path)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

            // Синхронизация в legacy таблицу segments
            sqlx::query("
                INSERT INTO segments (
                    id, track_id, start_time, duration, file_offset, file_duration, file_path, backstage_video_path, gain
                ) 
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(id) DO UPDATE SET 
                    start_time = excluded.start_time,
                    duration = excluded.duration, 
                    file_offset = excluded.file_offset,
                    file_duration = excluded.file_duration, 
                    file_path = excluded.file_path,
                    backstage_video_path = excluded.backstage_video_path,
                    gain = excluded.gain
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
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

            // Синхронизация в таблицу audio_clips
            let file_p = seg.file_path.clone().unwrap_or_default();
            sqlx::query("
                INSERT INTO audio_clips (
                    id, track_id, file_path, start_time_ms, duration_ms, source_offset_ms, gain_db, is_active, backstage_video_path
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)
                ON CONFLICT(id) DO UPDATE SET
                    file_path = excluded.file_path,
                    start_time_ms = excluded.start_time_ms,
                    duration_ms = excluded.duration_ms,
                    source_offset_ms = excluded.source_offset_ms,
                    gain_db = excluded.gain_db,
                    is_active = excluded.is_active,
                    backstage_video_path = excluded.backstage_video_path
            ")
            .bind(&seg.id)
            .bind(&track.id)
            .bind(&file_p)
            .bind(seg.start_time * 1000.0)
            .bind(seg.duration * 1000.0)
            .bind(seg.file_offset * 1000.0)
            .bind(if seg.gain > 0.0 { 20.0 * seg.gain.log10() } else { -96.0 })
            .bind(&seg.backstage_video_path)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }

        // Параметризованная очистка удаленных сегментов дорожки
        let existing_segs = sqlx::query("SELECT id FROM audio_segments WHERE track_id = ?")
            .bind(&track.id)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

        for s_row in existing_segs {
            let sid: String = s_row.get("id");
            if !current_seg_ids.contains(&sid) {
                sqlx::query("DELETE FROM audio_segments WHERE id = ?")
                    .bind(&sid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;

                sqlx::query("DELETE FROM segments WHERE id = ?")
                    .bind(&sid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;

                sqlx::query("DELETE FROM audio_clips WHERE id = ?")
                    .bind(&sid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    // 3. Параметризованная очистка удаленных дорожек проекта
    let existing_tracks = sqlx::query("SELECT id FROM tracks WHERE project_id = ?")
        .bind(&payload.id)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    for t_row in existing_tracks {
        let tid: String = t_row.get("id");
        if !current_track_ids.contains(&tid) {
            // Каскадное удаление трека и всех его связанных сущностей
            sqlx::query("DELETE FROM tracks WHERE id = ?")
                .bind(&tid)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Коммит транзакции
    tx.commit().await.map_err(|e| format!("Failed to commit transaction: {}", e))?;

    log_debug("save_project_to_db finished successfully in single atomic transaction");
    Ok(())
}

/// Загрузка проекта из реляционной базы
#[tauri::command]
pub async fn load_project_from_db(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ProjectData, String> {
    log_debug(&format!("load_project_from_db called for project_id: {}", project_id));
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    let proj_row = sqlx::query("
        SELECT id, name, COALESCE(NULLIF(config_json, ''), NULLIF(metadata_json, ''), '{}') as config_json, audio_offset_ms 
        FROM projects WHERE id = ?
    ")
    .bind(&project_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let proj_row = proj_row.ok_or("Project not found")?;

    let config_json: String = proj_row.get("config_json");
    let config: serde_json::Value = serde_json::from_str(&config_json).unwrap_or_else(|_| serde_json::json!({}));

    // Загрузка дорожек
    let tracks_rows = sqlx::query("SELECT id, name, volume, is_muted FROM tracks WHERE project_id = ? ORDER BY order_index ASC")
        .bind(&project_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut tracks_data = Vec::new();

    for trow in tracks_rows {
        let track_id: String = trow.get("id");

        // Загрузка сегментов дорожки с поддержкой fallback между audio_segments и segments
        let mut segs_rows = sqlx::query("
            SELECT id, start_time, duration, file_offset, file_duration, file_path, backstage_video_path, gain 
            FROM audio_segments WHERE track_id = ? ORDER BY start_time ASC
        ")
        .bind(&track_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

        if segs_rows.is_empty() {
            segs_rows = sqlx::query("
                SELECT id, start_time, duration, file_offset, file_duration, file_path, backstage_video_path, gain 
                FROM segments WHERE track_id = ? ORDER BY start_time ASC
            ")
            .bind(&track_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
        }

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
            id: track_id,
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
        config,
        tracks: tracks_data,
    })
}

/// Запрос сегментов с пространственно-временной фильтрацией по диапазону [start_range, end_range]
/// и привязке к проекту / треку. Сегмент попадает в диапазон, если:
/// start_time < end_range AND (start_time + duration) > start_range.
pub async fn query_segments_in_range_internal(
    pool: &Pool<Sqlite>,
    project_id: Option<&str>,
    track_id: Option<&str>,
    start_range: f64,
    end_range: f64,
) -> Result<Vec<SegmentData>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT 
            s.id, 
            s.start_time, 
            s.duration, 
            s.file_offset, 
            s.file_duration, 
            s.file_path, 
            s.backstage_video_path, 
            s.gain
         FROM audio_segments s
         JOIN tracks t ON s.track_id = t.id
         WHERE (?1 IS NULL OR t.project_id = ?1)
           AND (?2 IS NULL OR s.track_id = ?2)
           AND s.start_time < ?3
           AND (s.start_time + s.duration) > ?4
         ORDER BY s.start_time ASC",
    )
    .bind(project_id)
    .bind(track_id)
    .bind(end_range)
    .bind(start_range)
    .fetch_all(pool)
    .await;

    let segs_rows = match rows {
        Ok(r) => r,
        Err(_) => {
            // Fallback к таблице segments для легаси баз
            sqlx::query(
                "SELECT 
                    s.id, 
                    s.start_time, 
                    s.duration, 
                    s.file_offset, 
                    s.file_duration, 
                    s.file_path, 
                    s.backstage_video_path, 
                    s.gain
                 FROM segments s
                 JOIN tracks t ON s.track_id = t.id
                 WHERE (?1 IS NULL OR t.project_id = ?1)
                   AND (?2 IS NULL OR s.track_id = ?2)
                   AND s.start_time < ?3
                   AND (s.start_time + s.duration) > ?4
                 ORDER BY s.start_time ASC",
            )
            .bind(project_id)
            .bind(track_id)
            .bind(end_range)
            .bind(start_range)
            .fetch_all(pool)
            .await?
        }
    };

    Ok(segs_rows
        .into_iter()
        .map(|row| SegmentData {
            id: row.get("id"),
            start_time: row.get("start_time"),
            duration: row.get("duration"),
            file_offset: row.get("file_offset"),
            file_duration: row.get("file_duration"),
            file_path: row.get("file_path"),
            backstage_video_path: row.get("backstage_video_path"),
            gain: row.get("gain"),
        })
        .collect())
}

#[tauri::command]
pub async fn load_segments_in_range(
    state: State<'_, AppState>,
    project_id: Option<String>,
    track_id: Option<String>,
    start: Option<f64>,
    end: Option<f64>,
    start_time: Option<f64>,
    end_time: Option<f64>,
) -> Result<Vec<SegmentData>, String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    let s_range = start.or(start_time).unwrap_or(0.0);
    let e_range = end.or(end_time).unwrap_or(f64::MAX);

    query_segments_in_range_internal(
        pool,
        project_id.as_deref(),
        track_id.as_deref(),
        s_range,
        e_range,
    )
    .await
    .map_err(|e| format!("Failed to query segments in range: {}", e))
}

// ============================================================================
// 5. MIGRATION UTILITY
// ============================================================================

#[tauri::command]
pub async fn migrate_json_to_db(
    state: State<'_, AppState>,
    json_string: String,
) -> Result<String, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&json_string).map_err(|e| format!("Invalid JSON: {}", e))?;

    let pid = parsed.get("id").and_then(|i| i.as_str()).unwrap_or("missing_id");
    let pname = parsed.get("name").and_then(|i| i.as_str()).unwrap_or("Migrated Project");

    let mut config = parsed.clone();
    if let Some(obj) = config.as_object_mut() {
        obj.remove("tracks");
    }

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

// ============================================================================
// 6. ASSET VERIFICATION, RELINKING & HELPERS
// ============================================================================

#[tauri::command]
pub async fn generate_stress_test(
    state: State<'_, AppState>,
    project_id: String,
    track_id: String,
    project_path: String,
) -> Result<(), String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    let dub_dir = std::path::Path::new(&project_path).join(".dubstudio");
    if !dub_dir.exists() {
        fs::create_dir_all(&dub_dir).map_err(|e| e.to_string())?;
    }

    let mut tx = pool.begin().await.map_err(|e| format!("Failed to begin transaction: {}", e))?;

    for i in 0..1000 {
        let segment_id = format!("stress_{}", i);
        let start_time = (i as f64) * 2.5;
        let duration = 1.8;
        let file_path = dub_dir.join(format!("stress_{}.wav", i));
        let file_path_str = file_path.to_str().unwrap().to_string();

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
            INSERT INTO audio_segments (id, track_id, start_time, duration, file_offset, file_duration, file_path, backstage_video_path, gain, is_active) 
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)
        ")
        .bind(&segment_id)
        .bind(&track_id)
        .bind(start_time)
        .bind(duration)
        .bind(0.0)
        .bind(1.0)
        .bind(&file_path_str)
        .bind(None::<String>)
        .bind(1.0)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

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
        .bind(None::<String>)
        .bind(1.0)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| format!("Failed to commit stress test: {}", e))?;
    log_info(&format!("Generated 1000 stress test segments for project {}", project_id));
    Ok(())
}

#[tauri::command]
pub async fn find_file_by_hash(
    search_root: String,
    target_hash: String,
) -> Result<Option<String>, String> {
    let root = std::path::Path::new(&search_root);
    if !root.exists() {
        return Ok(None);
    }

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

    let segments_rows = sqlx::query("
        SELECT s.id, s.start_time, s.duration, s.file_offset, s.file_duration, s.file_path, s.backstage_video_path, s.gain 
        FROM audio_segments s
        JOIN tracks t ON s.track_id = t.id
        WHERE t.project_id = ?
    ")
    .bind(&project_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut missing_segments = Vec::new();
    let mut referenced_files = HashSet::new();

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

    let mut orphaned_files = Vec::new();
    let dub_dir = std::path::Path::new(&project_root).join(".dubstudio");
    if dub_dir.exists() {
        if let Ok(entries) = fs::read_dir(&dub_dir) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        let path_str = entry.path().to_str().unwrap_or("").to_string();
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

    let mut tx = pool.begin().await.map_err(|e| format!("Failed to begin transaction: {}", e))?;

    sqlx::query("UPDATE audio_segments SET file_path = ? WHERE id = ?")
        .bind(&new_path)
        .bind(&segment_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE segments SET file_path = ? WHERE id = ?")
        .bind(&new_path)
        .bind(&segment_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE audio_clips SET file_path = ? WHERE id = ?")
        .bind(&new_path)
        .bind(&segment_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| format!("Failed to commit relink: {}", e))?;
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

    let segments = sqlx::query("
        SELECT s.id, s.file_path FROM audio_segments s
        JOIN tracks t ON s.track_id = t.id
        WHERE t.project_id = ?
    ")
    .bind(&project_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut broken_segments = Vec::new();
    let dub_dir = std::path::Path::new(&project_root).join(".dubstudio");

    for seg in segments {
        let id: String = seg.get("id");
        let file_path: Option<String> = seg.get("file_path");
        if let Some(path_str) = file_path {
            let path = std::path::Path::new(&path_str);

            if !path.exists() {
                let file_name = path.file_name().and_then(|f| f.to_str());
                let mut found = false;

                if let (Some(name), true) = (file_name, dub_dir.exists()) {
                    if let Ok(entries) = fs::read_dir(&dub_dir) {
                        for entry in entries.flatten() {
                            if entry.file_name() == name {
                                let new_path = entry.path().to_str().unwrap().to_string();
                                let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

                                sqlx::query("UPDATE audio_segments SET file_path = ? WHERE id = ?")
                                    .bind(&new_path)
                                    .bind(&id)
                                    .execute(&mut *tx)
                                    .await
                                    .map_err(|e| e.to_string())?;

                                sqlx::query("UPDATE segments SET file_path = ? WHERE id = ?")
                                    .bind(&new_path)
                                    .bind(&id)
                                    .execute(&mut *tx)
                                    .await
                                    .map_err(|e| e.to_string())?;

                                sqlx::query("UPDATE audio_clips SET file_path = ? WHERE id = ?")
                                    .bind(&new_path)
                                    .bind(&id)
                                    .execute(&mut *tx)
                                    .await
                                    .map_err(|e| e.to_string())?;

                                tx.commit().await.map_err(|e| e.to_string())?;
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
            broken_segments.push(id);
        }
    }

    Ok(broken_segments)
}

// ============================================================================
// 6. UNIT TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_spatial_temporal_range_query() {
        let pool = init_db(":memory:").await.expect("Failed to init in-memory DB");

        // Create Project
        sqlx::query("INSERT INTO projects (id, name) VALUES ('proj_1', 'Test Project');")
            .execute(&pool)
            .await
            .unwrap();

        // Create Track
        sqlx::query("INSERT INTO tracks (id, project_id, name) VALUES ('track_1', 'proj_1', 'Voice');")
            .execute(&pool)
            .await
            .unwrap();

        // Insert Segments
        // Seg 1: 0.0 .. 5.0 (start: 0.0, dur: 5.0)
        // Seg 2: 10.0 .. 20.0 (start: 10.0, dur: 10.0)
        // Seg 3: 15.0 .. 30.0 (start: 15.0, dur: 15.0)
        // Seg 4: 40.0 .. 45.0 (start: 40.0, dur: 5.0)
        let segments = vec![
            ("seg_1", "track_1", 0.0, 5.0, 0.0, 5.0, "/path/1.wav", 1.0),
            ("seg_2", "track_1", 10.0, 10.0, 0.0, 10.0, "/path/2.wav", 0.8),
            ("seg_3", "track_1", 15.0, 15.0, 0.0, 15.0, "/path/3.wav", 1.2),
            ("seg_4", "track_1", 40.0, 5.0, 0.0, 5.0, "/path/4.wav", 1.0),
        ];

        for (id, trk, st, dur, f_off, f_dur, f_path, gain) in segments {
            sqlx::query("
                INSERT INTO audio_segments (id, track_id, start_time, duration, file_offset, file_duration, file_path, gain)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ")
            .bind(id)
            .bind(trk)
            .bind(st)
            .bind(dur)
            .bind(f_off)
            .bind(f_dur)
            .bind(f_path)
            .bind(gain)
            .execute(&pool)
            .await
            .unwrap();
        }

        // 1. Range 12.0 .. 18.0 should match seg_2 (10..20) and seg_3 (15..30)
        let res1 = query_segments_in_range_internal(&pool, Some("proj_1"), None, 12.0, 18.0)
            .await
            .unwrap();
        assert_eq!(res1.len(), 2);
        assert_eq!(res1[0].id, "seg_2");
        assert_eq!(res1[0].gain, 0.8);
        assert_eq!(res1[1].id, "seg_3");
        assert_eq!(res1[1].gain, 1.2);

        // 2. Range 0.0 .. 5.0 should match seg_1 (0..5) only
        let res2 = query_segments_in_range_internal(&pool, Some("proj_1"), None, 0.0, 5.0)
            .await
            .unwrap();
        assert_eq!(res2.len(), 1);
        assert_eq!(res2[0].id, "seg_1");

        // 3. Boundary touching: Range 5.0 .. 10.0 (between seg_1 and seg_2)
        // seg_1 ends at 5.0, seg_2 starts at 10.0 -> neither should be included
        let res3 = query_segments_in_range_internal(&pool, Some("proj_1"), None, 5.0, 10.0)
            .await
            .unwrap();
        assert_eq!(res3.len(), 0);

        // 4. Far range: 50.0 .. 60.0 -> no segments
        let res4 = query_segments_in_range_internal(&pool, Some("proj_1"), None, 50.0, 60.0)
            .await
            .unwrap();
        assert_eq!(res4.len(), 0);

        // 5. Track filter
        let res_track = query_segments_in_range_internal(&pool, None, Some("track_1"), 0.0, 100.0)
            .await
            .unwrap();
        assert_eq!(res_track.len(), 4);

        // 6. Unknown project filter -> 0
        let res_unknown = query_segments_in_range_internal(&pool, Some("unknown_proj"), None, 0.0, 100.0)
            .await
            .unwrap();
        assert_eq!(res_unknown.len(), 0);
    }
}
