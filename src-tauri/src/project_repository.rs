// ============================================================================
// DUB MIXING STUDIO PRO - TRANSACTIONAL SQLITE PROJECT REPOSITORY (RUST)
// Высокопроизводительный транзакционный репозиторий проектов на SQLite/SQLx
// Полная ликвидация дублирующего слоя IndexedDB/LocalStorage.
// Исключены блокировки мьютекса (Deadlocks) и SQLite Busy Lock при Undo/Redo.
// ============================================================================

use std::collections::HashSet;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Row, Sqlite};
use tauri::{command, State};

use crate::db::AppState;
use crate::logger::{log_debug, log_info};

// ============================================================================
// 1. DATA TRANSFER OBJECTS (DTO / IPC PAYLOADS)
// ============================================================================

/// Полный пейлоад аудио-клипа (сегмента)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioClipPayload {
    pub id: String,
    pub file_path: String,
    pub start_time_ms: f64,
    pub duration_ms: f64,
    #[serde(default)]
    pub source_offset_ms: f64,
    #[serde(default)]
    pub gain_db: f64,
    #[serde(default = "default_true")]
    pub is_active: bool,
    #[serde(default)]
    pub backstage_video_path: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Пейлоад пресета рэка дорожки
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RackPresetPayload {
    pub id: String,
    pub fx_chain_json: String,
}

/// Пейлоад аудио-дорожки
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPayload {
    pub id: String,
    pub name: String,
    #[serde(default = "default_dub_type")]
    pub track_type: String,
    #[serde(default = "default_one")]
    pub volume: f64,
    #[serde(default)]
    pub pan: f64,
    #[serde(default)]
    pub is_muted: bool,
    #[serde(default)]
    pub is_solo: bool,
    #[serde(default)]
    pub order_index: i64,
    #[serde(default)]
    pub clips: Vec<AudioClipPayload>,
    #[serde(default)]
    pub rack_preset: Option<RackPresetPayload>,
}

fn default_dub_type() -> String {
    "Dub".to_string()
}

fn default_one() -> f64 {
    1.0
}

/// Пейлоад строки субтитров
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlePayload {
    pub id: String,
    pub character_name: String,
    pub text: String,
    pub start_time_ms: f64,
    pub end_time_ms: f64,
    #[serde(default)]
    pub matched_clip_id: Option<String>,
}

/// Главный полный атомарный пейлоад проекта
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullProjectPayload {
    pub id: String,
    pub name: String,
    #[serde(default = "default_sample_rate")]
    pub sample_rate: i64,
    #[serde(default = "default_frame_rate")]
    pub frame_rate: f64,
    #[serde(default = "default_target_lufs")]
    pub target_lufs: f64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub audio_offset_ms: f64,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub tracks: Vec<TrackPayload>,
    #[serde(default)]
    pub subtitles: Vec<SubtitlePayload>,
}

fn default_sample_rate() -> i64 {
    48000
}

fn default_frame_rate() -> f64 {
    24.0
}

fn default_target_lufs() -> f64 {
    -14.0
}

/// Результат сохранения проекта с реактивной информацией о состоянии истории
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSaveResult {
    pub project_id: String,
    pub updated_at: String,
    pub can_undo: bool,
    pub can_redo: bool,
    pub snapshot_sequence: i64,
}

/// Краткая сводка по проекту для списков
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub sample_rate: i64,
    pub frame_rate: f64,
    pub target_lufs: f64,
    pub created_at: String,
    pub updated_at: String,
    pub track_count: i64,
    pub clip_count: i64,
    pub subtitle_count: i64,
}

// ============================================================================
// 2. БЕЗОПАСНОЕ ИЗВЛЕЧЕНИЕ ПУЛА БАЗЫ ДАННЫХ (БЕЗ УДЕРЖАНИЯ MutexGuard)
// ============================================================================

/// Метод получения пула соединений без удержания tokio::sync::MutexGuard
/// на протяжении транзакции. Клонирует Pool<Sqlite> (дешевый Arc) и немедленно освобождает мьютекс.
pub async fn get_db_pool(state: &State<'_, AppState>) -> Result<Pool<Sqlite>, String> {
    let guard = state.db.lock().await;
    let pool = guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "Database not initialized".to_string())?;
    drop(guard); // Явно освобождаем MutexGuard, чтобы не блокировать параллельные потоки
    Ok(pool)
}

// ============================================================================
// 3. ИНИЦИАЛИЗАЦИЯ И МИГРАЦИЯ ТАБЛИЦ БАЗЫ ДАННЫХ
// ============================================================================

pub async fn run_project_migrations(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    // Включение WAL режима, PRAGMA busy_timeout и внешних ключей
    sqlx::query("PRAGMA journal_mode = WAL;").execute(pool).await?;
    sqlx::query("PRAGMA busy_timeout = 10000;").execute(pool).await?;
    sqlx::query("PRAGMA synchronous = NORMAL;").execute(pool).await?;
    sqlx::query("PRAGMA foreign_keys = ON;").execute(pool).await?;
    sqlx::query("PRAGMA temp_store = MEMORY;").execute(pool).await?;

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
    ").execute(pool).await?;

    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN sample_rate INTEGER NOT NULL DEFAULT 48000;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN frame_rate REAL NOT NULL DEFAULT 24.0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN target_lufs REAL NOT NULL DEFAULT -14.0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN created_at TEXT NOT NULL DEFAULT '';").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN audio_offset_ms REAL NOT NULL DEFAULT 0.0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE projects ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';").execute(pool).await;

    // 2. Таблица дорожек
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
    ").execute(pool).await?;

    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN track_type TEXT NOT NULL DEFAULT 'Dub';").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN volume REAL NOT NULL DEFAULT 1.0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN pan REAL NOT NULL DEFAULT 0.0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN is_muted BOOLEAN NOT NULL DEFAULT 0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN is_solo BOOLEAN NOT NULL DEFAULT 0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE tracks ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0;").execute(pool).await;

    // 3. Таблица аудио-клипов
    sqlx::query("
        CREATE TABLE IF NOT EXISTS audio_clips (
            id TEXT PRIMARY KEY,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            start_time_ms REAL NOT NULL,
            duration_ms REAL NOT NULL,
            source_offset_ms REAL NOT NULL DEFAULT 0.0,
            gain_db REAL NOT NULL DEFAULT 0.0,
            is_active BOOLEAN NOT NULL DEFAULT 1,
            backstage_video_path TEXT
        );
    ").execute(pool).await?;

    let _ = sqlx::query("ALTER TABLE audio_clips ADD COLUMN source_offset_ms REAL NOT NULL DEFAULT 0.0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE audio_clips ADD COLUMN gain_db REAL NOT NULL DEFAULT 0.0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE audio_clips ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT 1;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE audio_clips ADD COLUMN backstage_video_path TEXT;").execute(pool).await;

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
    ").execute(pool).await?;

    let _ = sqlx::query("ALTER TABLE subtitles ADD COLUMN character_name TEXT NOT NULL DEFAULT '';").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE subtitles ADD COLUMN text TEXT NOT NULL DEFAULT '';").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE subtitles ADD COLUMN start_time_ms REAL NOT NULL DEFAULT 0.0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE subtitles ADD COLUMN end_time_ms REAL NOT NULL DEFAULT 0.0;").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE subtitles ADD COLUMN matched_clip_id TEXT;").execute(pool).await;

    // 5. Таблица пресетов рэков
    sqlx::query("
        CREATE TABLE IF NOT EXISTS rack_presets (
            id TEXT PRIMARY KEY,
            track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            fx_chain_json TEXT NOT NULL
        );
    ").execute(pool).await?;

    // 6. Таблицы снапшотов и дельт истории для транзакционного Undo/Redo
    sqlx::query("
        CREATE TABLE IF NOT EXISTS history_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            action_name TEXT NOT NULL,
            state_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            sequence_index INTEGER NOT NULL,
            is_current BOOLEAN NOT NULL DEFAULT 0
        );
    ").execute(pool).await?;

    sqlx::query("
        CREATE TABLE IF NOT EXISTS history_deltas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            action_description TEXT NOT NULL DEFAULT '',
            undo_patch TEXT NOT NULL DEFAULT '[]',
            redo_patch TEXT NOT NULL DEFAULT '[]',
            state_json TEXT NOT NULL DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sequence_index INTEGER NOT NULL DEFAULT 0,
            is_current BOOLEAN NOT NULL DEFAULT 0
        );
    ").execute(pool).await?;

    let _ = sqlx::query("ALTER TABLE history_deltas ADD COLUMN state_json TEXT NOT NULL DEFAULT '{}';").execute(pool).await;

    // Индексы для ускорения работы
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_tracks_project ON tracks(project_id);").execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_clips_track ON audio_clips(track_id);").execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_subtitles_project ON subtitles(project_id);").execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_history_proj_seq ON history_snapshots(project_id, sequence_index);").execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_history_deltas_proj ON history_deltas(project_id, sequence_index);").execute(pool).await?;

    log_info("Project repository SQLite migrations executed with WAL mode and busy_timeout=10000.");
    Ok(())
}

// ============================================================================
// 4. РЕАЛИЗАЦИЯ ТРАНЗАКЦИОННОГО СОХРАНЕНИЯ, ЧТЕНИЯ И ИСТОРИИ
// ============================================================================

/// Сохранение структурных сущностей проекта (проекты, треки, клипы, пресеты, субтитры)
async fn execute_save_project_body(
    conn: &mut sqlx::SqliteConnection,
    project: &FullProjectPayload,
) -> Result<(), sqlx::Error> {
    let now = Utc::now().to_rfc3339();
    let created_at = if project.created_at.is_empty() {
        now.clone()
    } else {
        project.created_at.clone()
    };
    let updated_at = now.clone();
    let meta_str = serde_json::to_string(&project.metadata).unwrap_or_else(|_| "{}".to_string());

    // 1. UPSERT Project
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
    .bind(&project.id)
    .bind(&project.name)
    .bind(project.sample_rate)
    .bind(project.frame_rate)
    .bind(project.target_lufs)
    .bind(&created_at)
    .bind(&updated_at)
    .bind(project.audio_offset_ms)
    .bind(&meta_str)
    .bind(&meta_str)
    .execute(&mut *conn)
    .await?;

    // 2. Обработка Tracks & Clips
    let mut current_track_ids = HashSet::new();

    for (idx, track) in project.tracks.iter().enumerate() {
        current_track_ids.insert(track.id.clone());

        sqlx::query("
            INSERT INTO tracks (
                id, project_id, name, track_type, volume, pan, is_muted, is_solo, order_index
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                track_type = excluded.track_type,
                volume = excluded.volume,
                pan = excluded.pan,
                is_muted = excluded.is_muted,
                is_solo = excluded.is_solo,
                order_index = excluded.order_index
        ")
        .bind(&track.id)
        .bind(&project.id)
        .bind(&track.name)
        .bind(&track.track_type)
        .bind(track.volume)
        .bind(track.pan)
        .bind(track.is_muted)
        .bind(track.is_solo)
        .bind(if track.order_index != 0 { track.order_index } else { idx as i64 })
        .execute(&mut *conn)
        .await?;

        let mut current_clip_ids = HashSet::new();
        for clip in &track.clips {
            current_clip_ids.insert(clip.id.clone());

            sqlx::query("
                INSERT INTO audio_clips (
                    id, track_id, file_path, start_time_ms, duration_ms, source_offset_ms, gain_db, is_active, backstage_video_path
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(id) DO UPDATE SET
                    file_path = excluded.file_path,
                    start_time_ms = excluded.start_time_ms,
                    duration_ms = excluded.duration_ms,
                    source_offset_ms = excluded.source_offset_ms,
                    gain_db = excluded.gain_db,
                    is_active = excluded.is_active,
                    backstage_video_path = excluded.backstage_video_path
            ")
            .bind(&clip.id)
            .bind(&track.id)
            .bind(&clip.file_path)
            .bind(clip.start_time_ms)
            .bind(clip.duration_ms)
            .bind(clip.source_offset_ms)
            .bind(clip.gain_db)
            .bind(clip.is_active)
            .bind(&clip.backstage_video_path)
            .execute(&mut *conn)
            .await?;
        }

        // Удаление удаленных клипов
        let existing_clips = sqlx::query("SELECT id FROM audio_clips WHERE track_id = ?")
            .bind(&track.id)
            .fetch_all(&mut *conn)
            .await?;

        for c_row in existing_clips {
            let cid: String = c_row.get("id");
            if !current_clip_ids.contains(&cid) {
                sqlx::query("DELETE FROM audio_clips WHERE id = ?")
                    .bind(&cid)
                    .execute(&mut *conn)
                    .await?;
            }
        }

        if let Some(preset) = &track.rack_preset {
            sqlx::query("
                INSERT INTO rack_presets (id, track_id, fx_chain_json)
                VALUES (?1, ?2, ?3)
                ON CONFLICT(id) DO UPDATE SET
                    fx_chain_json = excluded.fx_chain_json
            ")
            .bind(&preset.id)
            .bind(&track.id)
            .bind(&preset.fx_chain_json)
            .execute(&mut *conn)
            .await?;
        }
    }

    // Удаление удаленных дорожек
    let existing_tracks = sqlx::query("SELECT id FROM tracks WHERE project_id = ?")
        .bind(&project.id)
        .fetch_all(&mut *conn)
        .await?;

    for t_row in existing_tracks {
        let tid: String = t_row.get("id");
        if !current_track_ids.contains(&tid) {
            sqlx::query("DELETE FROM tracks WHERE id = ?")
                .bind(&tid)
                .execute(&mut *conn)
                .await?;
        }
    }

    // 3. Субтитры
    let mut current_sub_ids = HashSet::new();
    for sub in &project.subtitles {
        current_sub_ids.insert(sub.id.clone());

        sqlx::query("
            INSERT INTO subtitles (
                id, project_id, character_name, text, start_time_ms, end_time_ms, matched_clip_id
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                character_name = excluded.character_name,
                text = excluded.text,
                start_time_ms = excluded.start_time_ms,
                end_time_ms = excluded.end_time_ms,
                matched_clip_id = excluded.matched_clip_id
        ")
        .bind(&sub.id)
        .bind(&project.id)
        .bind(&sub.character_name)
        .bind(&sub.text)
        .bind(sub.start_time_ms)
        .bind(sub.end_time_ms)
        .bind(&sub.matched_clip_id)
        .execute(&mut *conn)
        .await?;
    }

    let existing_subs = sqlx::query("SELECT id FROM subtitles WHERE project_id = ?")
        .bind(&project.id)
        .fetch_all(&mut *conn)
        .await?;

    for s_row in existing_subs {
        let sid: String = s_row.get("id");
        if !current_sub_ids.contains(&sid) {
            sqlx::query("DELETE FROM subtitles WHERE id = ?")
                .bind(&sid)
                .execute(&mut *conn)
                .await?;
        }
    }

    Ok(())
}

/// Запись дельта-снапшота истории проекта с защитой от переполнения стека (лимит 200 шагов)
async fn record_history_snapshot(
    conn: &mut sqlx::SqliteConnection,
    project: &FullProjectPayload,
    action_name: &str,
) -> Result<ProjectSaveResult, sqlx::Error> {
    let now = Utc::now().to_rfc3339();

    // 1. Получаем текущую последовательность
    let current_snap = sqlx::query("
        SELECT sequence_index FROM history_snapshots 
        WHERE project_id = ? AND is_current = 1 
        ORDER BY sequence_index DESC LIMIT 1
    ")
    .bind(&project.id)
    .fetch_optional(&mut *conn)
    .await?;

    let next_sequence = match current_snap {
        Some(row) => {
            let cur_seq: i64 = row.get("sequence_index");
            // Очищаем ветку Redo при совершении нового действия
            sqlx::query("DELETE FROM history_snapshots WHERE project_id = ? AND sequence_index > ?")
                .bind(&project.id)
                .bind(cur_seq)
                .execute(&mut *conn)
                .await?;
            sqlx::query("DELETE FROM history_deltas WHERE project_id = ? AND sequence_index > ?")
                .bind(&project.id)
                .bind(cur_seq)
                .execute(&mut *conn)
                .await?;
            cur_seq + 1
        }
        None => 1,
    };

    // 2. Сбрасываем флаг is_current с предыдущих записей
    sqlx::query("UPDATE history_snapshots SET is_current = 0 WHERE project_id = ?")
        .bind(&project.id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE history_deltas SET is_current = 0 WHERE project_id = ?")
        .bind(&project.id)
        .execute(&mut *conn)
        .await?;

    // 3. Сериализуем текущее состояние
    let state_json = serde_json::to_string(project).unwrap_or_else(|_| "{}".to_string());

    // 4. Сохраняем в history_snapshots и history_deltas
    sqlx::query("
        INSERT INTO history_snapshots (
            project_id, action_name, state_json, created_at, sequence_index, is_current
        )
        VALUES (?1, ?2, ?3, ?4, ?5, 1)
    ")
    .bind(&project.id)
    .bind(action_name)
    .bind(&state_json)
    .bind(&now)
    .bind(next_sequence)
    .execute(&mut *conn)
    .await?;

    sqlx::query("
        INSERT INTO history_deltas (
            project_id, action_description, undo_patch, redo_patch, state_json, created_at, sequence_index, is_current
        )
        VALUES (?1, ?2, '[]', '[]', ?3, ?4, ?5, 1)
    ")
    .bind(&project.id)
    .bind(action_name)
    .bind(&state_json)
    .bind(&now)
    .bind(next_sequence)
    .execute(&mut *conn)
    .await?;

    // 5. Ограничение стека истории: строгий лимит 200 последних снимков
    sqlx::query("
        DELETE FROM history_snapshots 
        WHERE project_id = ? AND sequence_index < (? - 200)
    ")
    .bind(&project.id)
    .bind(next_sequence)
    .execute(&mut *conn)
    .await?;

    sqlx::query("
        DELETE FROM history_deltas 
        WHERE project_id = ? AND sequence_index < (? - 200)
    ")
    .bind(&project.id)
    .bind(next_sequence)
    .execute(&mut *conn)
    .await?;

    let can_undo = next_sequence > 1;
    let can_redo = false;

    Ok(ProjectSaveResult {
        project_id: project.id.clone(),
        updated_at: now,
        can_undo,
        can_redo,
        snapshot_sequence: next_sequence,
    })
}

/// Загрузка полного состояния проекта из базы
pub async fn execute_load_project(
    pool: &Pool<Sqlite>,
    project_id: &str,
) -> Result<FullProjectPayload, sqlx::Error> {
    let proj_row = sqlx::query("
        SELECT id, name, sample_rate, frame_rate, target_lufs, created_at, updated_at, audio_offset_ms, metadata_json, config_json
        FROM projects WHERE id = ?
    ")
    .bind(project_id)
    .fetch_optional(pool)
    .await?;

    let proj_row = proj_row.ok_or_else(|| sqlx::Error::RowNotFound)?;

    let meta_json_str: String = proj_row.try_get("metadata_json").unwrap_or_else(|_| "{}".to_string());
    let config_json_str: String = proj_row.try_get("config_json").unwrap_or_else(|_| "{}".to_string());

    let metadata: serde_json::Value = if meta_json_str.trim().is_empty() || meta_json_str == "{}" {
        serde_json::from_str(&config_json_str).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::from_str(&meta_json_str).unwrap_or_else(|_| serde_json::json!({}))
    };

    // Загрузка дорожек
    let track_rows = sqlx::query("
        SELECT id, name, track_type, volume, pan, is_muted, is_solo, order_index
        FROM tracks WHERE project_id = ? ORDER BY order_index ASC
    ")
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    let mut tracks_payload = Vec::with_capacity(track_rows.len());

    for trow in track_rows {
        let track_id: String = trow.get("id");

        // Загрузка клипов
        let clip_rows = sqlx::query("
            SELECT id, file_path, start_time_ms, duration_ms, source_offset_ms, gain_db, is_active, backstage_video_path
            FROM audio_clips WHERE track_id = ? ORDER BY start_time_ms ASC
        ")
        .bind(&track_id)
        .fetch_all(pool)
        .await?;

        let mut clips = Vec::with_capacity(clip_rows.len());
        for crow in clip_rows {
            clips.push(AudioClipPayload {
                id: crow.get("id"),
                file_path: crow.get("file_path"),
                start_time_ms: crow.get("start_time_ms"),
                duration_ms: crow.get("duration_ms"),
                source_offset_ms: crow.get("source_offset_ms"),
                gain_db: crow.get("gain_db"),
                is_active: crow.get::<i64, _>("is_active") == 1,
                backstage_video_path: crow.get("backstage_video_path"),
            });
        }

        // Загрузка пресета рэка
        let rack_row = sqlx::query("SELECT id, fx_chain_json FROM rack_presets WHERE track_id = ?")
            .bind(&track_id)
            .fetch_optional(pool)
            .await?;

        let rack_preset = rack_row.map(|r| RackPresetPayload {
            id: r.get("id"),
            fx_chain_json: r.get("fx_chain_json"),
        });

        tracks_payload.push(TrackPayload {
            id: track_id,
            name: trow.get("name"),
            track_type: trow.get("track_type"),
            volume: trow.get("volume"),
            pan: trow.get("pan"),
            is_muted: trow.get::<i64, _>("is_muted") == 1,
            is_solo: trow.get::<i64, _>("is_solo") == 1,
            order_index: trow.get("order_index"),
            clips,
            rack_preset,
        });
    }

    // Загрузка субтитров
    let sub_rows = sqlx::query("
        SELECT id, character_name, text, start_time_ms, end_time_ms, matched_clip_id
        FROM subtitles WHERE project_id = ? ORDER BY start_time_ms ASC
    ")
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    let mut subtitles = Vec::with_capacity(sub_rows.len());
    for srow in sub_rows {
        subtitles.push(SubtitlePayload {
            id: srow.get("id"),
            character_name: srow.get("character_name"),
            text: srow.get("text"),
            start_time_ms: srow.get("start_time_ms"),
            end_time_ms: srow.get("end_time_ms"),
            matched_clip_id: srow.get("matched_clip_id"),
        });
    }

    Ok(FullProjectPayload {
        id: proj_row.get("id"),
        name: proj_row.get("name"),
        sample_rate: proj_row.get("sample_rate"),
        frame_rate: proj_row.get("frame_rate"),
        target_lufs: proj_row.get("target_lufs"),
        created_at: proj_row.get("created_at"),
        updated_at: proj_row.get("updated_at"),
        audio_offset_ms: proj_row.get("audio_offset_ms"),
        metadata,
        tracks: tracks_payload,
        subtitles,
    })
}

// ============================================================================
// 5. TAURI V2 КОМАНДЫ (COMMAND HANDLERS)
// ============================================================================

/// Атомарное сохранение всего проекта в базе с поддержкой BEGIN IMMEDIATE
#[command]
pub async fn save_project_atomic(
    state: State<'_, AppState>,
    project: FullProjectPayload,
    action_name: Option<String>,
) -> Result<ProjectSaveResult, String> {
    let pool = get_db_pool(&state).await?;
    let act_name = action_name.unwrap_or_else(|| "Save Project".to_string());

    log_debug(&format!(
        "save_project_atomic for '{}' (ID: {}) with {} tracks, {} subs",
        project.name, project.id, project.tracks.len(), project.subtitles.len()
    ));

    let mut conn = pool.acquire().await.map_err(|e| format!("Failed to acquire connection: {}", e))?;
    sqlx::query("BEGIN IMMEDIATE;").execute(&mut *conn).await.map_err(|e| format!("Failed to begin transaction: {}", e))?;

    if let Err(e) = execute_save_project_body(&mut conn, &project).await {
        let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
        return Err(format!("Atomic save error: {}", e));
    }

    let save_res = match record_history_snapshot(&mut conn, &project, &act_name).await {
        Ok(res) => res,
        Err(e) => {
            let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
            return Err(format!("Failed to record history snapshot: {}", e));
        }
    };

    sqlx::query("COMMIT;").execute(&mut *conn).await.map_err(|e| format!("Failed to commit save transaction: {}", e))?;

    log_info(&format!("Project '{}' saved atomically to SQLite.", project.name));
    Ok(save_res)
}

/// Загрузка проекта по ID
#[command]
pub async fn load_project_by_id(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<FullProjectPayload, String> {
    let pool = get_db_pool(&state).await?;

    log_debug(&format!("load_project_by_id: {}", project_id));
    execute_load_project(&pool, &project_id)
        .await
        .map_err(|e| format!("Failed to load project {}: {}", project_id, e))
}

/// Откат действия (Undo) в рамках проекта с BEGIN IMMEDIATE
#[command]
pub async fn undo_project_action(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<FullProjectPayload, String> {
    let pool = get_db_pool(&state).await?;

    let mut conn = pool.acquire().await.map_err(|e| format!("Failed to acquire connection: {}", e))?;
    sqlx::query("BEGIN IMMEDIATE;").execute(&mut *conn).await.map_err(|e| format!("Failed to begin transaction: {}", e))?;

    // 1. Извлекаем текущий указатель
    let current_row = sqlx::query("
        SELECT sequence_index FROM history_snapshots
        WHERE project_id = ? AND is_current = 1
        ORDER BY sequence_index DESC LIMIT 1
    ")
    .bind(&project_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    let cur_seq: i64 = match current_row {
        Some(r) => r.get("sequence_index"),
        None => {
            let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
            return Err("No current history state found".to_string());
        }
    };

    if cur_seq <= 1 {
        let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
        return Err("Cannot undo: already at the earliest state".to_string());
    }

    let target_seq = cur_seq - 1;

    // 2. Ищем целевой снимок
    let target_snap = sqlx::query("
        SELECT state_json FROM history_snapshots
        WHERE project_id = ? AND sequence_index = ?
    ")
    .bind(&project_id)
    .bind(target_seq)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    let target_snap = match target_snap {
        Some(r) => r,
        None => {
            sqlx::query("
                SELECT state_json FROM history_deltas
                WHERE project_id = ? AND sequence_index = ?
            ")
            .bind(&project_id)
            .bind(target_seq)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Target undo snapshot not found".to_string())?
        }
    };

    let state_json: String = target_snap.get("state_json");

    let restored_payload: FullProjectPayload = serde_json::from_str(&state_json)
        .map_err(|e| format!("Corrupted snapshot JSON: {}", e))?;

    // 3. Восстанавливаем сущности в базе данных
    if let Err(e) = execute_save_project_body(&mut conn, &restored_payload).await {
        let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
        return Err(format!("Failed to restore project tables during undo: {}", e));
    }

    // 4. Обновляем указатели
    sqlx::query("UPDATE history_snapshots SET is_current = 0 WHERE project_id = ?")
        .bind(&project_id)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE history_snapshots SET is_current = 1 WHERE project_id = ? AND sequence_index = ?")
        .bind(&project_id)
        .bind(target_seq)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE history_deltas SET is_current = 0 WHERE project_id = ?")
        .bind(&project_id)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE history_deltas SET is_current = 1 WHERE project_id = ? AND sequence_index = ?")
        .bind(&project_id)
        .bind(target_seq)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("COMMIT;").execute(&mut *conn).await.map_err(|e| format!("Failed to commit undo: {}", e))?;

    log_info(&format!("Undo applied successfully for project {}. Restored to seq {}.", project_id, target_seq));
    Ok(restored_payload)
}

/// Повтор действия (Redo) в рамках проекта с BEGIN IMMEDIATE
#[command]
pub async fn redo_project_action(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<FullProjectPayload, String> {
    let pool = get_db_pool(&state).await?;

    let mut conn = pool.acquire().await.map_err(|e| format!("Failed to acquire connection: {}", e))?;
    sqlx::query("BEGIN IMMEDIATE;").execute(&mut *conn).await.map_err(|e| format!("Failed to begin transaction: {}", e))?;

    let current_row = sqlx::query("
        SELECT sequence_index FROM history_snapshots
        WHERE project_id = ? AND is_current = 1
        ORDER BY sequence_index DESC LIMIT 1
    ")
    .bind(&project_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    let cur_seq: i64 = match current_row {
        Some(r) => r.get("sequence_index"),
        None => {
            let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
            return Err("No current history state found".to_string());
        }
    };

    let target_seq = cur_seq + 1;

    let target_snap = sqlx::query("
        SELECT state_json FROM history_snapshots
        WHERE project_id = ? AND sequence_index = ?
    ")
    .bind(&project_id)
    .bind(target_seq)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    let target_snap = match target_snap {
        Some(r) => r,
        None => {
            sqlx::query("
                SELECT state_json FROM history_deltas
                WHERE project_id = ? AND sequence_index = ?
            ")
            .bind(&project_id)
            .bind(target_seq)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Cannot redo: already at the newest state".to_string())?
        }
    };

    let state_json: String = target_snap.get("state_json");

    let restored_payload: FullProjectPayload = serde_json::from_str(&state_json)
        .map_err(|e| format!("Corrupted snapshot JSON: {}", e))?;

    if let Err(e) = execute_save_project_body(&mut conn, &restored_payload).await {
        let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
        return Err(format!("Failed to restore project tables during redo: {}", e));
    }

    sqlx::query("UPDATE history_snapshots SET is_current = 0 WHERE project_id = ?")
        .bind(&project_id)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE history_snapshots SET is_current = 1 WHERE project_id = ? AND sequence_index = ?")
        .bind(&project_id)
        .bind(target_seq)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE history_deltas SET is_current = 0 WHERE project_id = ?")
        .bind(&project_id)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE history_deltas SET is_current = 1 WHERE project_id = ? AND sequence_index = ?")
        .bind(&project_id)
        .bind(target_seq)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("COMMIT;").execute(&mut *conn).await.map_err(|e| format!("Failed to commit redo: {}", e))?;

    log_info(&format!("Redo applied successfully for project {}. Advanced to seq {}.", project_id, target_seq));
    Ok(restored_payload)
}

/// Получение списка всех проектов в локальной базе
#[command]
pub async fn list_all_projects(
    state: State<'_, AppState>,
) -> Result<Vec<ProjectSummary>, String> {
    let pool = get_db_pool(&state).await?;

    let rows = sqlx::query("
        SELECT 
            p.id, p.name, p.sample_rate, p.frame_rate, p.target_lufs, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM tracks t WHERE t.project_id = p.id) as track_count,
            (SELECT COUNT(*) FROM audio_clips c JOIN tracks t ON c.track_id = t.id WHERE t.project_id = p.id) as clip_count,
            (SELECT COUNT(*) FROM subtitles s WHERE s.project_id = p.id) as subtitle_count
        FROM projects p
        ORDER BY p.updated_at DESC
    ")
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut summaries = Vec::new();
    for r in rows {
        summaries.push(ProjectSummary {
            id: r.get("id"),
            name: r.get("name"),
            sample_rate: r.get("sample_rate"),
            frame_rate: r.get("frame_rate"),
            target_lufs: r.get("target_lufs"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            track_count: r.get("track_count"),
            clip_count: r.get("clip_count"),
            subtitle_count: r.get("subtitle_count"),
        });
    }

    Ok(summaries)
}

/// Удаление проекта по ID (каскадно удаляет все связанные треки, клипы и субтитры)
#[command]
pub async fn delete_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    let pool = get_db_pool(&state).await?;

    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(&project_id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    log_info(&format!("Project {} deleted from SQLite.", project_id));
    Ok(())
}
