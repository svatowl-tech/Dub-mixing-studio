// ============================================================================
// DUB MIXING STUDIO PRO - TIMELINE HISTORY ENGINE (RUST / SQLITE)
// Модуль высокоскоростного дельта-хранилища Undo/Redo в SQLite.
// Хранение истории действий в виде легковесных прямых и обратных патчей
// (RFC 6902 JSON-Patch diff) с моментальным применением на уровне транзакций.
// ============================================================================

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Pool, Row, Sqlite};
use std::sync::Arc;
use tauri::{command, State};

use crate::db::AppState;
use crate::logger::{log_debug, log_error, log_info};
use crate::timeline_culling_engine::TimelineTrackData;

// ============================================================================
// 1. DATA TRANSFER OBJECTS (DTOs & JSON-PATCH ENGINE)
// ============================================================================

/// Запись в таблице `timeline_history`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineHistoryEntry {
    pub id: i64,
    pub project_id: String,
    pub action_description: String,
    pub undo_patch: String,
    pub redo_patch: String,
    pub created_at: String,
}

/// Статус стека истории проекта (для реактивного UI: кнопки, горячие клавиши)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    pub project_id: String,
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_action_description: Option<String>,
    pub redo_action_description: Option<String>,
    pub total_undo_steps: usize,
    pub total_redo_steps: usize,
    pub current_pointer_id: Option<i64>,
}

/// Ответ при выполнении Undo/Redo/Push
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineHistoryResponse {
    pub success: bool,
    pub status: HistoryStatus,
    /// Восстановленное состояние дорожек таймлайна (если было применено)
    pub tracks: Option<Vec<TimelineTrackData>>,
    pub applied_action: Option<String>,
}

/// RFC 6902 JSON Patch операция
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PatchOpType {
    Add,
    Remove,
    Replace,
    Move,
    Copy,
    Test,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonPatchOp {
    pub op: PatchOpType,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

pub type JsonPatch = Vec<JsonPatchOp>;

// ============================================================================
// 2. ИНИЦИАЛИЗАЦИЯ И МИГРАЦИЯ ТАБЛИЦ ИСТОРИИ
// ============================================================================

/// Создание таблицы timeline_history и указателя текущей позиции
pub async fn run_timeline_history_migrations(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    // 1. Основная таблица истории действий согласно ТЗ
    sqlx::query("
        CREATE TABLE IF NOT EXISTS timeline_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            action_description TEXT NOT NULL,
            undo_patch TEXT NOT NULL,
            redo_patch TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    ").execute(pool).await?;

    // 2. Индекс по project_id для мгновенных выборок
    sqlx::query("
        CREATE INDEX IF NOT EXISTS idx_timeline_history_project_id 
        ON timeline_history(project_id, id);
    ").execute(pool).await?;

    // 3. Таблица указателя текущего состояния истории (Timeline History Pointer)
    sqlx::query("
        CREATE TABLE IF NOT EXISTS timeline_history_state (
            project_id TEXT PRIMARY KEY,
            current_history_id INTEGER,
            current_state_json TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    ").execute(pool).await?;

    log_info("Timeline History SQLite migrations executed successfully.");
    Ok(())
}

// ============================================================================
// 3. ВЫСОКОСКОРОСТНОЙ JSON-PATCH ДВИЖОК
// ============================================================================

/// Вычисляет двунаправленный RFC 6902 патч между двумя JSON-состояниями (old_val -> new_val).
/// Возвращает (undo_patch: new -> old, redo_patch: old -> new).
pub fn create_json_patch_diff(old_val: &Value, new_val: &Value) -> (JsonPatch, JsonPatch) {
    let mut forward_ops = Vec::new();
    let mut reverse_ops = Vec::new();

    diff_values("", old_val, new_val, &mut forward_ops, &mut reverse_ops);

    (reverse_ops, forward_ops)
}

fn diff_values(
    path: &str,
    old_val: &Value,
    new_val: &Value,
    forward: &mut Vec<JsonPatchOp>,
    reverse: &mut Vec<JsonPatchOp>,
) {
    if old_val == new_val {
        return;
    }

    match (old_val, new_val) {
        (Value::Object(old_map), Value::Object(new_map)) => {
            // Удаленные ключи
            for (key, val) in old_map {
                let sub_path = format!("{}/{}", path, escape_json_pointer(key));
                if !new_map.contains_key(key) {
                    forward.push(JsonPatchOp {
                        op: PatchOpType::Remove,
                        path: sub_path.clone(),
                        from: None,
                        value: None,
                    });
                    reverse.push(JsonPatchOp {
                        op: PatchOpType::Add,
                        path: sub_path,
                        from: None,
                        value: Some(val.clone()),
                    });
                }
            }

            // Добавленные ключи
            for (key, val) in new_map {
                let sub_path = format!("{}/{}", path, escape_json_pointer(key));
                if !old_map.contains_key(key) {
                    forward.push(JsonPatchOp {
                        op: PatchOpType::Add,
                        path: sub_path.clone(),
                        from: None,
                        value: Some(val.clone()),
                    });
                    reverse.push(JsonPatchOp {
                        op: PatchOpType::Remove,
                        path: sub_path,
                        from: None,
                        value: None,
                    });
                }
            }

            // Измененные общие ключи
            for (key, old_sub) in old_map {
                if let Some(new_sub) = new_map.get(key) {
                    if old_sub != new_sub {
                        let sub_path = format!("{}/{}", path, escape_json_pointer(key));
                        diff_values(&sub_path, old_sub, new_sub, forward, reverse);
                    }
                }
            }
        }
        (Value::Array(old_arr), Value::Array(new_arr)) => {
            // Для массивов сегментов или дорожек: если длина совпадает или близка,
            // оптимизируем по элементам, иначе заменяем массив целиком для надежности.
            if old_arr.len() == new_arr.len() {
                for i in 0..old_arr.len() {
                    let sub_path = format!("{}/{}", path, i);
                    if old_arr[i] != new_arr[i] {
                        diff_values(&sub_path, &old_arr[i], &new_arr[i], forward, reverse);
                    }
                }
            } else {
                // Прямой Replace массива
                forward.push(JsonPatchOp {
                    op: PatchOpType::Replace,
                    path: path.to_string(),
                    from: None,
                    value: Some(new_val.clone()),
                });
                reverse.push(JsonPatchOp {
                    op: PatchOpType::Replace,
                    path: path.to_string(),
                    from: None,
                    value: Some(old_val.clone()),
                });
            }
        }
        _ => {
            // Примитивы: число, строка, булево
            forward.push(JsonPatchOp {
                op: PatchOpType::Replace,
                path: path.to_string(),
                from: None,
                value: Some(new_val.clone()),
            });
            reverse.push(JsonPatchOp {
                op: PatchOpType::Replace,
                path: path.to_string(),
                from: None,
                value: Some(old_val.clone()),
            });
        }
    }
}

fn escape_json_pointer(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

fn unescape_json_pointer(s: &str) -> String {
    s.replace("~1", "/").replace("~0", "~")
}

/// Применяет RFC 6902 JSON Patch к документу Value
pub fn apply_json_patch(target: &mut Value, patch: &[JsonPatchOp]) -> Result<(), String> {
    for op in patch {
        match op.op {
            PatchOpType::Add => {
                let val = op.value.as_ref().ok_or("Add operation requires value")?;
                patch_add(target, &op.path, val.clone())?;
            }
            PatchOpType::Remove => {
                patch_remove(target, &op.path)?;
            }
            PatchOpType::Replace => {
                let val = op.value.as_ref().ok_or("Replace operation requires value")?;
                patch_replace(target, &op.path, val.clone())?;
            }
            PatchOpType::Move => {
                let from = op.from.as_ref().ok_or("Move operation requires 'from'")?;
                let val = patch_remove(target, from)?;
                patch_add(target, &op.path, val)?;
            }
            PatchOpType::Copy => {
                let from = op.from.as_ref().ok_or("Copy operation requires 'from'")?;
                let val = patch_get(target, from)?.clone();
                patch_add(target, &op.path, val)?;
            }
            PatchOpType::Test => {
                let expected = op.value.as_ref().ok_or("Test operation requires value")?;
                let actual = patch_get(target, &op.path)?;
                if actual != expected {
                    return Err(format!("Test failed at path {}", op.path));
                }
            }
        }
    }
    Ok(())
}

fn split_pointer(path: &str) -> Vec<String> {
    if path.is_empty() {
        return Vec::new();
    }
    let trimmed = path.strip_prefix('/').unwrap_or(path);
    if trimmed.is_empty() {
        return Vec::new();
    }
    trimmed.split('/').map(unescape_json_pointer).collect()
}

fn patch_get<'a>(target: &'a Value, path: &str) -> Result<&'a Value, String> {
    let tokens = split_pointer(path);
    let mut cur = target;
    for token in tokens {
        match cur {
            Value::Object(map) => {
                cur = map.get(&token).ok_or_else(|| format!("Key '{}' not found", token))?;
            }
            Value::Array(arr) => {
                let idx: usize = token.parse().map_err(|_| format!("Invalid array index '{}'", token))?;
                cur = arr.get(idx).ok_or_else(|| format!("Index {} out of bounds", idx))?;
            }
            _ => return Err(format!("Cannot traverse into primitive at '{}'", token)),
        }
    }
    Ok(cur)
}

fn patch_replace(target: &mut Value, path: &str, new_value: Value) -> Result<(), String> {
    let tokens = split_pointer(path);
    if tokens.is_empty() {
        *target = new_value;
        return Ok(());
    }

    let (parent_tokens, last_token) = tokens.split_at(tokens.len() - 1);
    let mut cur = target;

    for token in parent_tokens {
        match cur {
            Value::Object(map) => {
                cur = map.get_mut(token).ok_or_else(|| format!("Key '{}' not found", token))?;
            }
            Value::Array(arr) => {
                let idx: usize = token.parse().map_err(|_| format!("Invalid index '{}'", token))?;
                cur = arr.get_mut(idx).ok_or_else(|| format!("Index {} out of bounds", idx))?;
            }
            _ => return Err("Invalid path traversal".to_string()),
        }
    }

    let last = &last_token[0];
    match cur {
        Value::Object(map) => {
            if map.contains_key(last) {
                map.insert(last.clone(), new_value);
                Ok(())
            } else {
                Err(format!("Replace target '{}' does not exist in object", last))
            }
        }
        Value::Array(arr) => {
            let idx: usize = last.parse().map_err(|_| format!("Invalid array index '{}'", last))?;
            if idx < arr.len() {
                arr[idx] = new_value;
                Ok(())
            } else {
                Err(format!("Index {} out of bounds for replace", idx))
            }
        }
        _ => Err("Target parent is not a container".to_string()),
    }
}

fn patch_add(target: &mut Value, path: &str, new_value: Value) -> Result<(), String> {
    let tokens = split_pointer(path);
    if tokens.is_empty() {
        *target = new_value;
        return Ok(());
    }

    let (parent_tokens, last_token) = tokens.split_at(tokens.len() - 1);
    let mut cur = target;

    for token in parent_tokens {
        match cur {
            Value::Object(map) => {
                cur = map.get_mut(token).ok_or_else(|| format!("Key '{}' not found", token))?;
            }
            Value::Array(arr) => {
                let idx: usize = token.parse().map_err(|_| format!("Invalid index '{}'", token))?;
                cur = arr.get_mut(idx).ok_or_else(|| format!("Index {} out of bounds", idx))?;
            }
            _ => return Err("Invalid path traversal".to_string()),
        }
    }

    let last = &last_token[0];
    match cur {
        Value::Object(map) => {
            map.insert(last.clone(), new_value);
            Ok(())
        }
        Value::Array(arr) => {
            if last == "-" {
                arr.push(new_value);
                Ok(())
            } else {
                let idx: usize = last.parse().map_err(|_| format!("Invalid array index '{}'", last))?;
                if idx <= arr.len() {
                    arr.insert(idx, new_value);
                    Ok(())
                } else {
                    Err(format!("Array index {} out of bounds for insert", idx))
                }
            }
        }
        _ => Err("Target parent is not a container".to_string()),
    }
}

fn patch_remove(target: &mut Value, path: &str) -> Result<Value, String> {
    let tokens = split_pointer(path);
    if tokens.is_empty() {
        return Err("Cannot remove root".to_string());
    }

    let (parent_tokens, last_token) = tokens.split_at(tokens.len() - 1);
    let mut cur = target;

    for token in parent_tokens {
        match cur {
            Value::Object(map) => {
                cur = map.get_mut(token).ok_or_else(|| format!("Key '{}' not found", token))?;
            }
            Value::Array(arr) => {
                let idx: usize = token.parse().map_err(|_| format!("Invalid index '{}'", token))?;
                cur = arr.get_mut(idx).ok_or_else(|| format!("Index {} out of bounds", idx))?;
            }
            _ => return Err("Invalid path traversal".to_string()),
        }
    }

    let last = &last_token[0];
    match cur {
        Value::Object(map) => {
            map.remove(last).ok_or_else(|| format!("Key '{}' not found to remove", last))
        }
        Value::Array(arr) => {
            let idx: usize = last.parse().map_err(|_| format!("Invalid array index '{}'", last))?;
            if idx < arr.len() {
                Ok(arr.remove(idx))
            } else {
                Err(format!("Index {} out of bounds to remove", idx))
            }
        }
        _ => Err("Target parent is not a container".to_string()),
    }
}

// ============================================================================
// 4. ТРАНЗАКЦИОННЫЙ UNDO / REDO ДВИЖОК ДЛЯ TIMELINE
// ============================================================================

/// Запись нового действия в историю с автоматическим вычислением дельты
pub async fn record_timeline_action_internal(
    pool: &Pool<Sqlite>,
    project_id: &str,
    action_description: &str,
    new_tracks: &[TimelineTrackData],
) -> Result<HistoryStatus, String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    // Получаем текущее состояние
    let state_row = sqlx::query("
        SELECT current_history_id, current_state_json
        FROM timeline_history_state
        WHERE project_id = ?
    ")
    .bind(project_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    let new_state_val = serde_json::to_value(new_tracks).map_err(|e| e.to_string())?;
    let new_state_json = serde_json::to_string(&new_state_val).map_err(|e| e.to_string())?;

    let (cur_hist_id, old_state_val) = match state_row {
        Some(r) => {
            let hist_id: Option<i64> = r.get("current_history_id");
            let st_json: String = r.get("current_state_json");
            let st_val: Value = serde_json::from_str(&st_json).unwrap_or(Value::Array(Vec::new()));
            (hist_id, st_val)
        }
        None => (None, Value::Array(Vec::new())),
    };

    // Если состояние не изменилось - не плодим дубликат
    if old_state_val == new_state_val {
        tx.rollback().await.map_err(|e| e.to_string())?;
        return get_timeline_history_status_internal(pool, project_id).await;
    }

    // Если указатель был где-то в прошлом (после серии Undo), отсекаем ветку Redo
    if let Some(pointer_id) = cur_hist_id {
        sqlx::query("DELETE FROM timeline_history WHERE project_id = ? AND id > ?")
            .bind(project_id)
            .bind(pointer_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        // Если указатель пустой (были в самом начале)
        let count_row = sqlx::query("SELECT COUNT(*) as cnt FROM timeline_history WHERE project_id = ?")
            .bind(project_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        let cnt: i64 = count_row.get("cnt");
        if cnt > 0 {
            sqlx::query("DELETE FROM timeline_history WHERE project_id = ?")
                .bind(project_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Вычисляем прямую и обратную дельту (RFC 6902 Patch)
    let (undo_patch_ops, redo_patch_ops) = create_json_patch_diff(&old_state_val, &new_state_val);
    let undo_patch_str = serde_json::to_string(&undo_patch_ops).unwrap_or_else(|_| "[]".to_string());
    let redo_patch_str = serde_json::to_string(&redo_patch_ops).unwrap_or_else(|_| "[]".to_string());

    // Вставляем запись в timeline_history
    let ins_res = sqlx::query("
        INSERT INTO timeline_history (project_id, action_description, undo_patch, redo_patch, created_at)
        VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
    ")
    .bind(project_id)
    .bind(action_description)
    .bind(&undo_patch_str)
    .bind(&redo_patch_str)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    let new_history_id = ins_res.last_insert_rowid();

    // Обновляем текущее состояние в timeline_history_state
    sqlx::query("
        INSERT INTO timeline_history_state (project_id, current_history_id, current_state_json, updated_at)
        VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
        ON CONFLICT(project_id) DO UPDATE SET
            current_history_id = excluded.current_history_id,
            current_state_json = excluded.current_state_json,
            updated_at = excluded.updated_at
    ")
    .bind(project_id)
    .bind(new_history_id)
    .bind(&new_state_json)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    // Ограничиваем историю 100 действиями для экономии места
    let max_history = 100i64;
    sqlx::query("
        DELETE FROM timeline_history 
        WHERE project_id = ? AND id NOT IN (
            SELECT id FROM timeline_history 
            WHERE project_id = ? 
            ORDER BY id DESC 
            LIMIT ?
        )
    ")
    .bind(project_id)
    .bind(project_id)
    .bind(max_history)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    log_debug(&format!(
        "Recorded timeline action '{}' (history_id={}) for project {}",
        action_description, new_history_id, project_id
    ));

    get_timeline_history_status_internal(pool, project_id).await
}

/// Выполнение операции Undo
pub async fn undo_timeline_action_internal(
    pool: &Pool<Sqlite>,
    project_id: &str,
) -> Result<TimelineHistoryResponse, String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    // Получаем текущую позицию
    let state_row = sqlx::query("
        SELECT current_history_id, current_state_json
        FROM timeline_history_state
        WHERE project_id = ?
    ")
    .bind(project_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    let (cur_id, cur_state_json) = match state_row {
        Some(r) => {
            let hid: Option<i64> = r.get("current_history_id");
            let sjson: String = r.get("current_state_json");
            (hid, sjson)
        }
        None => return Err("No history initialized for this project".to_string()),
    };

    let target_id = match cur_id {
        Some(id) => id,
        None => return Err("Cannot undo: already at earliest state".to_string()),
    };

    // Загружаем патч отката для target_id
    let entry_row = sqlx::query("
        SELECT id, action_description, undo_patch
        FROM timeline_history
        WHERE project_id = ? AND id = ?
    ")
    .bind(project_id)
    .bind(target_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    let entry_row = match entry_row {
        Some(r) => r,
        None => return Err("History entry not found".to_string()),
    };

    let action_description: String = entry_row.get("action_description");
    let undo_patch_str: String = entry_row.get("undo_patch");

    let undo_ops: JsonPatch = serde_json::from_str(&undo_patch_str)
        .map_err(|e| format!("Failed to parse undo patch: {}", e))?;

    let mut current_val: Value = serde_json::from_str(&cur_state_json)
        .map_err(|e| format!("Failed to parse current state JSON: {}", e))?;

    // Применяем откат
    apply_json_patch(&mut current_val, &undo_ops)
        .map_err(|e| format!("Failed to apply undo patch: {}", e))?;

    // Находим предыдущий id в timeline_history
    let prev_row = sqlx::query("
        SELECT id FROM timeline_history
        WHERE project_id = ? AND id < ?
        ORDER BY id DESC
        LIMIT 1
    ")
    .bind(project_id)
    .bind(target_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    let prev_id: Option<i64> = prev_row.map(|r| r.get("id"));
    let updated_json = serde_json::to_string(&current_val).map_err(|e| e.to_string())?;

    // Обновляем состояние указателя
    sqlx::query("
        UPDATE timeline_history_state
        SET current_history_id = ?, current_state_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ?
    ")
    .bind(prev_id)
    .bind(&updated_json)
    .bind(project_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    let restored_tracks: Vec<TimelineTrackData> = serde_json::from_value(current_val)
        .map_err(|e| format!("Failed to deserialize restored tracks: {}", e))?;

    let status = get_timeline_history_status_internal(pool, project_id).await?;

    log_info(&format!(
        "Undo applied: '{}' (restored to id={:?}) for project {}",
        action_description, prev_id, project_id
    ));

    Ok(TimelineHistoryResponse {
        success: true,
        status,
        tracks: Some(restored_tracks),
        applied_action: Some(action_description),
    })
}

/// Выполнение операции Redo
pub async fn redo_timeline_action_internal(
    pool: &Pool<Sqlite>,
    project_id: &str,
) -> Result<TimelineHistoryResponse, String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    let state_row = sqlx::query("
        SELECT current_history_id, current_state_json
        FROM timeline_history_state
        WHERE project_id = ?
    ")
    .bind(project_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    let (cur_id, cur_state_json) = match state_row {
        Some(r) => {
            let hid: Option<i64> = r.get("current_history_id");
            let sjson: String = r.get("current_state_json");
            (hid, sjson)
        }
        None => return Err("No history initialized for this project".to_string()),
    };

    // Ищем следующее действие вперед
    let next_row = match cur_id {
        Some(id) => {
            sqlx::query("
                SELECT id, action_description, redo_patch
                FROM timeline_history
                WHERE project_id = ? AND id > ?
                ORDER BY id ASC
                LIMIT 1
            ")
            .bind(project_id)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
        }
        None => {
            sqlx::query("
                SELECT id, action_description, redo_patch
                FROM timeline_history
                WHERE project_id = ?
                ORDER BY id ASC
                LIMIT 1
            ")
            .bind(project_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
        }
    };

    let next_row = match next_row {
        Some(r) => r,
        None => return Err("Cannot redo: already at newest state".to_string()),
    };

    let next_id: i64 = next_row.get("id");
    let action_description: String = next_row.get("action_description");
    let redo_patch_str: String = next_row.get("redo_patch");

    let redo_ops: JsonPatch = serde_json::from_str(&redo_patch_str)
        .map_err(|e| format!("Failed to parse redo patch: {}", e))?;

    let mut current_val: Value = serde_json::from_str(&cur_state_json)
        .map_err(|e| format!("Failed to parse current state JSON: {}", e))?;

    // Применяем прямой патч (Redo)
    apply_json_patch(&mut current_val, &redo_ops)
        .map_err(|e| format!("Failed to apply redo patch: {}", e))?;

    let updated_json = serde_json::to_string(&current_val).map_err(|e| e.to_string())?;

    // Обновляем указатель на next_id
    sqlx::query("
        UPDATE timeline_history_state
        SET current_history_id = ?, current_state_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ?
    ")
    .bind(next_id)
    .bind(&updated_json)
    .bind(project_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    let restored_tracks: Vec<TimelineTrackData> = serde_json::from_value(current_val)
        .map_err(|e| format!("Failed to deserialize restored tracks: {}", e))?;

    let status = get_timeline_history_status_internal(pool, project_id).await?;

    log_info(&format!(
        "Redo applied: '{}' (restored to id={}) for project {}",
        action_description, next_id, project_id
    ));

    Ok(TimelineHistoryResponse {
        success: true,
        status,
        tracks: Some(restored_tracks),
        applied_action: Some(action_description),
    })
}

/// Получение статуса стека Undo / Redo
pub async fn get_timeline_history_status_internal(
    pool: &Pool<Sqlite>,
    project_id: &str,
) -> Result<HistoryStatus, String> {
    let state_row = sqlx::query("
        SELECT current_history_id
        FROM timeline_history_state
        WHERE project_id = ?
    ")
    .bind(project_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let cur_id: Option<i64> = state_row.and_then(|r| r.get("current_history_id"));

    // Количество шагов Undo и описание
    let (can_undo, total_undo, undo_desc) = match cur_id {
        Some(id) => {
            let row = sqlx::query("
                SELECT COUNT(*) as cnt FROM timeline_history 
                WHERE project_id = ? AND id <= ?
            ")
            .bind(project_id)
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
            let cnt: i64 = row.get("cnt");

            let desc_row = sqlx::query("
                SELECT action_description FROM timeline_history 
                WHERE project_id = ? AND id = ?
            ")
            .bind(project_id)
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

            let desc = desc_row.map(|r| r.get("action_description"));
            (cnt > 0, cnt as usize, desc)
        }
        None => (false, 0, None),
    };

    // Количество шагов Redo и описание
    let (can_redo, total_redo, redo_desc) = match cur_id {
        Some(id) => {
            let row = sqlx::query("
                SELECT COUNT(*) as cnt FROM timeline_history 
                WHERE project_id = ? AND id > ?
            ")
            .bind(project_id)
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
            let cnt: i64 = row.get("cnt");

            let desc_row = sqlx::query("
                SELECT action_description FROM timeline_history 
                WHERE project_id = ? AND id > ? 
                ORDER BY id ASC LIMIT 1
            ")
            .bind(project_id)
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

            let desc = desc_row.map(|r| r.get("action_description"));
            (cnt > 0, cnt as usize, desc)
        }
        None => {
            let row = sqlx::query("
                SELECT COUNT(*) as cnt FROM timeline_history 
                WHERE project_id = ?
            ")
            .bind(project_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
            let cnt: i64 = row.get("cnt");

            let desc_row = sqlx::query("
                SELECT action_description FROM timeline_history 
                WHERE project_id = ? 
                ORDER BY id ASC LIMIT 1
            ")
            .bind(project_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

            let desc = desc_row.map(|r| r.get("action_description"));
            (cnt > 0, cnt as usize, desc)
        }
    };

    Ok(HistoryStatus {
        project_id: project_id.to_string(),
        can_undo,
        can_redo,
        undo_action_description: undo_desc,
        redo_action_description: redo_desc,
        total_undo_steps: total_undo,
        total_redo_steps: total_redo,
        current_pointer_id: cur_id,
    })
}

/// Инициализация начального состояния (без добавления в undo-стек)
pub async fn init_timeline_history_base_internal(
    pool: &Pool<Sqlite>,
    project_id: &str,
    tracks: &[TimelineTrackData],
) -> Result<(), String> {
    let state_val = serde_json::to_value(tracks).map_err(|e| e.to_string())?;
    let state_json = serde_json::to_string(&state_val).map_err(|e| e.to_string())?;

    sqlx::query("
        INSERT INTO timeline_history_state (project_id, current_history_id, current_state_json, updated_at)
        VALUES (?1, NULL, ?2, CURRENT_TIMESTAMP)
        ON CONFLICT(project_id) DO UPDATE SET
            current_history_id = NULL,
            current_state_json = excluded.current_state_json,
            updated_at = excluded.updated_at
    ")
    .bind(project_id)
    .bind(&state_json)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM timeline_history WHERE project_id = ?")
        .bind(project_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    log_info(&format!("Timeline history initialized base state for project {}", project_id));
    Ok(())
}

// ============================================================================
// 5. TAURI V2 IPC COMMANDS
// ============================================================================

/// Запись действия в историю таймлайна
#[command]
pub async fn record_timeline_action(
    state: State<'_, AppState>,
    project_id: String,
    action_description: String,
    tracks: Vec<TimelineTrackData>,
) -> Result<HistoryStatus, String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    record_timeline_action_internal(pool, &project_id, &action_description, &tracks).await
}

/// Выполнить Undo для проекта
#[command]
pub async fn undo_timeline_action(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<TimelineHistoryResponse, String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    undo_timeline_action_internal(pool, &project_id).await
}

/// Выполнить Redo для проекта
#[command]
pub async fn redo_timeline_action(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<TimelineHistoryResponse, String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    redo_timeline_action_internal(pool, &project_id).await
}

/// Запросить текущий статус Undo/Redo (canUndo, canRedo, descriptions)
#[command]
pub async fn get_timeline_history_status(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<HistoryStatus, String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    get_timeline_history_status_internal(pool, &project_id).await
}

/// Инициализация базового состояния (при загрузке или создании проекта)
#[command]
pub async fn init_timeline_history_base(
    state: State<'_, AppState>,
    project_id: String,
    tracks: Vec<TimelineTrackData>,
) -> Result<(), String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    init_timeline_history_base_internal(pool, &project_id, &tracks).await
}

/// Очистить историю проекта
#[command]
pub async fn clear_timeline_history(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    let mutex = state.db.lock().await;
    let pool = mutex.as_ref().ok_or("Database not initialized")?;

    sqlx::query("DELETE FROM timeline_history WHERE project_id = ?")
        .bind(&project_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM timeline_history_state WHERE project_id = ?")
        .bind(&project_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ============================================================================
// 6. МОДУЛЬНЫЕ ТЕСТЫ (RFC 6902, ДЕЛЬТА-ПАТЧИ, ТРАНЗАКЦИОННОСТЬ)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_patch_diff_and_apply_primitive_changes() {
        let old_state = json!({
            "volume": 0.8,
            "isMuted": false,
            "name": "Track 1"
        });

        let new_state = json!({
            "volume": 1.0,
            "isMuted": true,
            "name": "Track 1"
        });

        let (undo_patch, redo_patch) = create_json_patch_diff(&old_state, &new_state);
        assert!(!redo_patch.is_empty());
        assert!(!undo_patch.is_empty());

        // Apply Redo: old -> new
        let mut state = old_state.clone();
        apply_json_patch(&mut state, &redo_patch).expect("Redo apply failed");
        assert_eq!(state, new_state);

        // Apply Undo: new -> old
        apply_json_patch(&mut state, &undo_patch).expect("Undo apply failed");
        assert_eq!(state, old_state);
    }

    #[test]
    fn test_patch_diff_and_apply_array_segments() {
        let old_tracks = json!([
            {
                "id": "track-1",
                "name": "Dub",
                "volume": 1.0,
                "isMuted": false,
                "isSolo": false,
                "segments": [
                    { "id": "seg-1", "startTime": 0.0, "duration": 4.5, "gain": 1.0 }
                ]
            }
        ]);

        let new_tracks = json!([
            {
                "id": "track-1",
                "name": "Dub",
                "volume": 1.0,
                "isMuted": false,
                "isSolo": false,
                "segments": [
                    { "id": "seg-1", "startTime": 0.0, "duration": 2.0, "gain": 1.0 },
                    { "id": "seg-2", "startTime": 2.0, "duration": 2.5, "gain": 1.0 }
                ]
            }
        ]);

        let (undo_patch, redo_patch) = create_json_patch_diff(&old_tracks, &new_tracks);

        let mut current = old_tracks.clone();
        apply_json_patch(&mut current, &redo_patch).expect("Redo apply failed");
        assert_eq!(current, new_tracks);

        apply_json_patch(&mut current, &undo_patch).expect("Undo apply failed");
        assert_eq!(current, old_tracks);
    }

    #[test]
    fn test_patch_json_pointer_escaping() {
        assert_eq!(escape_json_pointer("a/b~c"), "a~1b~0c");
        assert_eq!(unescape_json_pointer("a~1b~0c"), "a/b~c");
    }
}
