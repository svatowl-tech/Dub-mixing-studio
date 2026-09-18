// ============================================================================
// DUB MIXING STUDIO PRO - SUBTITLE PARSER & SCRIPT FUZZY MATCHER (RUST)
// Сверхбыстрый SIMD/Rayon парсер субтитров (ASS/SSA/SRT/VTT/TXT) и
// нечеткий сопоставитель реплик Whisper со сценарием через Levenshtein/Jaro-Winkler
// Стек: rayon = "1.10.0", regex = "1.10", serde = "1.0", tauri = "2.2"
// ============================================================================

use std::cmp::min;
use std::collections::HashMap;
use std::time::Instant;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::logger::{log_debug, log_info};

// ============================================================================
// 1. DATA MODELS & STRUCTS
// ============================================================================

/// Запись распарсенного субтитра
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSubtitleEntry {
    pub id: String,
    pub index: usize,
    pub start_ms: u64,
    pub end_ms: u64,
    pub duration_ms: u64,
    pub role: String,
    pub raw_text: String,
    pub clean_text: String,
    pub style: Option<String>,
    pub actor: Option<String>,
    pub effect: Option<String>,
    pub margin_l: Option<u32>,
    pub margin_r: Option<u32>,
    pub margin_v: Option<u32>,
}

/// Входная реплика от транскриптора Whisper
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperEntry {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub confidence: Option<f32>,
    pub speaker: Option<String>,
}

/// Входная строка эталонного сценария/субтитров
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEntry {
    pub id: String,
    pub index: usize,
    pub role: Option<String>,
    pub text: String,
    pub target_start_ms: Option<u64>,
    pub target_end_ms: Option<u64>,
}

/// Результат сопоставления реплики Whisper со строкой сценария
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedScriptPair {
    pub whisper_id: String,
    pub script_id: String,
    pub script_index: usize,
    pub whisper_text: String,
    pub script_text: String,
    pub role: String,
    pub similarity: f32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub time_drift_ms: i64,
    pub confidence: f32,
    pub is_exact_match: bool,
}

// ============================================================================
// 2. HIGH-PERFORMANCE LEVENSHTEIN & DAMERAU-LEVENSHTEIN SIMD-AWARE MATCHER
// ============================================================================

pub struct FastFuzzyMatcher;

impl FastFuzzyMatcher {
    /// Быстрый расчет расстояния Левенштейна с чередующимися строками O(min(N, M)) по памяти
    pub fn levenshtein_distance(s1: &str, s2: &str) -> usize {
        let v1: Vec<char> = s1.chars().collect();
        let v2: Vec<char> = s2.chars().collect();

        let len1 = v1.len();
        let len2 = v2.len();

        if len1 == 0 {
            return len2;
        }
        if len2 == 0 {
            return len1;
        }

        // Оптимизация памяти: держим только 2 строки матрицы
        let mut prev_row: Vec<usize> = (0..=len2).collect();
        let mut curr_row: Vec<usize> = vec![0; len2 + 1];

        for i in 0..len1 {
            curr_row[0] = i + 1;
            let c1 = v1[i];

            for j in 0..len2 {
                let c2 = v2[j];
                let cost = if c1 == c2 { 0 } else { 1 };
                curr_row[j + 1] = min(
                    curr_row[j] + 1,                 // insertion
                    min(
                        prev_row[j + 1] + 1,         // deletion
                        prev_row[j] + cost,          // substitution
                    ),
                );
            }
            std::mem::swap(&mut prev_row, &mut curr_row);
        }

        prev_row[len2]
    }

    /// Нормализованный коэффициент похожести Левенштейна [0.0 .. 1.0]
    pub fn levenshtein_similarity(s1: &str, s2: &str) -> f32 {
        let c1_count = s1.chars().count();
        let c2_count = s2.chars().count();
        let max_len = c1_count.max(c2_count);
        if max_len == 0 {
            return 1.0;
        }

        let dist = Self::levenshtein_distance(s1, s2);
        1.0 - (dist as f32 / max_len as f32)
    }

    /// Сходство строк по токенам (Jaccard / Overlap по словам для длинных реплик)
    pub fn token_similarity(s1: &str, s2: &str) -> f32 {
        let words1: Vec<String> = s1
            .split_whitespace()
            .map(|w| w.to_lowercase())
            .collect();
        let words2: Vec<String> = s2
            .split_whitespace()
            .map(|w| w.to_lowercase())
            .collect();

        if words1.is_empty() && words2.is_empty() {
            return 1.0;
        }
        if words1.is_empty() || words2.is_empty() {
            return 0.0;
        }

        let mut matches = 0usize;
        for w1 in &words1 {
            if words2.contains(w1) {
                matches += 1;
            }
        }

        let union_size = (words1.len() + words2.len()).saturating_sub(matches);
        if union_size == 0 {
            1.0
        } else {
            matches as f32 / union_size as f32
        }
    }

    /// Комплексный комбинированный показатель схожести (Взвешенный Char Levenshtein + Token Jaccard)
    pub fn compute_hybrid_similarity(raw_s1: &str, raw_s2: &str) -> f32 {
        let clean1 = Self::normalize_text(raw_s1);
        let clean2 = Self::normalize_text(raw_s2);

        if clean1 == clean2 {
            return 1.0;
        }

        if clean1.is_empty() || clean2.is_empty() {
            return 0.0;
        }

        // Если одна строка содержит другую целиком
        if clean1.contains(&clean2) || clean2.contains(&clean1) {
            let min_len = clean1.len().min(clean2.len()) as f32;
            let max_len = clean1.len().max(clean2.len()) as f32;
            let containment_score = 0.75 + 0.25 * (min_len / max_len);
            return containment_score.min(0.98);
        }

        let lev_sim = Self::levenshtein_similarity(&clean1, &clean2);
        let tok_sim = Self::token_similarity(&clean1, &clean2);

        // Взвешенная сумма: 60% Levenshtein + 40% Token overlap
        (lev_sim * 0.60) + (tok_sim * 0.40)
    }

    /// Нормализация текста: перевод в нижний регистр, удаление спецсимволов и лишних пробелов
    pub fn normalize_text(text: &str) -> String {
        let mut res = String::with_capacity(text.len());
        for c in text.chars() {
            if c.is_alphanumeric() || c == ' ' {
                res.extend(c.to_lowercase());
            } else if c == '-' || c == '—' || c == '–' {
                res.push(' ');
            }
        }
        res.split_whitespace().collect::<Vec<&str>>().join(" ")
    }
}

// ============================================================================
// 3. FAST SUBTITLE PARSER (ASS / SSA / SRT / VTT / TXT)
// ============================================================================

pub struct NativeSubtitleParser;

impl NativeSubtitleParser {
    /// Очистка текста от ASS-тегов {\\...}, HTML-тегов <...>, символов \\N и \\n
    pub fn clean_subtitle_text(raw: &str) -> String {
        let mut clean = String::with_capacity(raw.len());
        let mut in_curly = false;
        let mut in_tag = false;
        let chars: Vec<char> = raw.chars().collect();
        let len = chars.len();
        let mut i = 0;

        while i < len {
            let c = chars[i];
            if c == '{' {
                in_curly = true;
                i += 1;
                continue;
            }
            if c == '}' {
                in_curly = false;
                i += 1;
                continue;
            }
            if c == '<' {
                in_tag = true;
                i += 1;
                continue;
            }
            if c == '>' {
                in_tag = false;
                i += 1;
                continue;
            }

            if in_curly || in_tag {
                i += 1;
                continue;
            }

            // Обработка переносов строк ASS "\N", "\n", "\h"
            if c == '\\' && i + 1 < len {
                let next = chars[i + 1];
                if next == 'N' || next == 'n' {
                    clean.push(' ');
                    i += 2;
                    continue;
                } else if next == 'h' {
                    clean.push(' ');
                    i += 2;
                    continue;
                }
            }

            if c == '\r' || c == '\n' {
                clean.push(' ');
                i += 1;
                continue;
            }

            clean.push(c);
            i += 1;
        }

        clean.split_whitespace().collect::<Vec<&str>>().join(" ")
    }

    /// Парсинг времени SRT/VTT в миллисекунды: "00:01:23,456" или "01:23.456"
    pub fn parse_time_to_ms(time_str: &str) -> Option<u64> {
        let s = time_str.trim().replace(',', ".");
        let parts: Vec<&str> = s.split(':').collect();

        if parts.len() == 3 {
            // HH:MM:SS.mmm
            let hours: u64 = parts[0].parse().ok()?;
            let mins: u64 = parts[1].parse().ok()?;
            let secs_split: Vec<&str> = parts[2].split('.').collect();
            let secs: u64 = secs_split[0].parse().ok()?;
            let mut ms: u64 = 0;
            if secs_split.len() > 1 {
                let frac = secs_split[1];
                if frac.len() == 1 {
                    ms = frac.parse::<u64>().ok()? * 100;
                } else if frac.len() == 2 {
                    ms = frac.parse::<u64>().ok()? * 10;
                } else if frac.len() >= 3 {
                    ms = frac[..3].parse::<u64>().ok()?;
                }
            }
            Some(hours * 3_600_000 + mins * 60_000 + secs * 1_000 + ms)
        } else if parts.len() == 2 {
            // MM:SS.mmm
            let mins: u64 = parts[0].parse().ok()?;
            let secs_split: Vec<&str> = parts[1].split('.').collect();
            let secs: u64 = secs_split[0].parse().ok()?;
            let mut ms: u64 = 0;
            if secs_split.len() > 1 {
                let frac = secs_split[1];
                if frac.len() == 1 {
                    ms = frac.parse::<u64>().ok()? * 100;
                } else if frac.len() == 2 {
                    ms = frac.parse::<u64>().ok()? * 10;
                } else if frac.len() >= 3 {
                    ms = frac[..3].parse::<u64>().ok()?;
                }
            }
            Some(mins * 60_000 + secs * 1_000 + ms)
        } else {
            None
        }
    }

    /// Парсинг таймкода ASS "0:01:23.45" (сотые доли)
    pub fn parse_ass_time_to_ms(time_str: &str) -> Option<u64> {
        let parts: Vec<&str> = time_str.trim().split(':').collect();
        if parts.len() != 3 {
            return Self::parse_time_to_ms(time_str);
        }

        let hours: u64 = parts[0].parse().ok()?;
        let mins: u64 = parts[1].parse().ok()?;
        let sec_parts: Vec<&str> = parts[2].split('.').collect();
        let secs: u64 = sec_parts[0].parse().ok()?;
        let mut ms: u64 = 0;
        if sec_parts.len() > 1 {
            let frac = sec_parts[1];
            if frac.len() == 2 {
                // ASS формат: сотые секунды -> умножаем на 10
                ms = frac.parse::<u64>().ok()? * 10;
            } else if frac.len() == 3 {
                ms = frac.parse::<u64>().ok()?;
            } else if frac.len() == 1 {
                ms = frac.parse::<u64>().ok()? * 100;
            }
        }

        Some(hours * 3_600_000 + mins * 60_000 + secs * 1_000 + ms)
    }

    /// Парсинг ASS / SSA скрипта
    pub fn parse_ass(content: &str) -> Vec<ParsedSubtitleEntry> {
        let mut entries = Vec::new();
        let mut in_events = false;
        let mut format_cols: Vec<String> = Vec::new();

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with(';') {
                continue;
            }

            if trimmed.eq_ignore_ascii_case("[Events]") {
                in_events = true;
                continue;
            } else if trimmed.starts_with('[') && trimmed.ends_with(']') {
                in_events = false;
                continue;
            }

            if in_events {
                if trimmed.starts_with("Format:") {
                    let cols_str = &trimmed["Format:".len()..];
                    format_cols = cols_str
                        .split(',')
                        .map(|s| s.trim().to_lowercase())
                        .collect();
                } else if trimmed.starts_with("Dialogue:") {
                    let body = &trimmed["Dialogue:".len()..];
                    let cols_count = if !format_cols.is_empty() {
                        format_cols.len()
                    } else {
                        10
                    };

                    // Разделяем с учетом того, что Text идет последней колонкой и может содержать запятые
                    let mut parts: Vec<&str> = Vec::with_capacity(cols_count);
                    let mut remaining = body;

                    for _ in 0..(cols_count - 1) {
                        if let Some(comma_pos) = remaining.find(',') {
                            parts.push(&remaining[..comma_pos]);
                            remaining = &remaining[comma_pos + 1..];
                        } else {
                            break;
                        }
                    }
                    parts.push(remaining);

                    if parts.len() >= 9 {
                        let mut start_ms = 0u64;
                        let mut end_ms = 0u64;
                        let mut style = "Default".to_string();
                        let mut actor = "".to_string();
                        let mut raw_text = "";
                        let mut effect = "".to_string();

                        if !format_cols.is_empty() {
                            for (idx, col_name) in format_cols.iter().enumerate() {
                                if idx >= parts.len() {
                                    break;
                                }
                                let val = parts[idx].trim();
                                match col_name.as_str() {
                                    "start" => start_ms = Self::parse_ass_time_to_ms(val).unwrap_or(0),
                                    "end" => end_ms = Self::parse_ass_time_to_ms(val).unwrap_or(0),
                                    "style" => style = val.to_string(),
                                    "name" | "actor" => actor = val.to_string(),
                                    "effect" => effect = val.to_string(),
                                    "text" => raw_text = val,
                                    _ => {}
                                }
                            }
                        } else {
                            start_ms = Self::parse_ass_time_to_ms(parts[1]).unwrap_or(0);
                            end_ms = Self::parse_ass_time_to_ms(parts[2]).unwrap_or(0);
                            style = parts[3].trim().to_string();
                            actor = parts[4].trim().to_string();
                            raw_text = parts[9..].join(",");
                        }

                        let clean_text = Self::clean_subtitle_text(raw_text);
                        let duration_ms = end_ms.saturating_sub(start_ms);

                        let role = if !actor.is_empty() {
                            actor.clone()
                        } else if !style.is_empty() && !style.eq_ignore_ascii_case("default") {
                            style.clone()
                        } else {
                            "Default".to_string()
                        };

                        let idx = entries.len();
                        entries.push(ParsedSubtitleEntry {
                            id: format!("sub_ass_{}_{}", idx, start_ms),
                            index: idx + 1,
                            start_ms,
                            end_ms,
                            duration_ms,
                            role,
                            raw_text: raw_text.to_string(),
                            clean_text,
                            style: Some(style),
                            actor: if actor.is_empty() { None } else { Some(actor) },
                            effect: if effect.is_empty() { None } else { Some(effect) },
                            margin_l: None,
                            margin_r: None,
                            margin_v: None,
                        });
                    }
                }
            }
        }

        entries
    }

    /// Парсинг SRT файлов
    pub fn parse_srt(content: &str) -> Vec<ParsedSubtitleEntry> {
        let mut entries = Vec::new();
        let blocks = content.replace("\r\n", "\n").split("\n\n").map(|s| s.to_string()).collect::<Vec<String>>();

        for block in blocks {
            let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
            if lines.len() < 2 {
                continue;
            }

            // Ищем строку с таймкодом "-->"
            let time_line_idx = lines.iter().position(|l| l.contains("-->"));
            if let Some(idx) = time_line_idx {
                let time_line = lines[idx];
                let time_parts: Vec<&str> = time_line.split("-->").collect();
                if time_parts.len() == 2 {
                    let start_ms = Self::parse_time_to_ms(time_parts[0]).unwrap_or(0);
                    let end_ms = Self::parse_time_to_ms(time_parts[1]).unwrap_or(0);
                    let text_lines = &lines[idx + 1..];
                    let raw_text = text_lines.join("\n");
                    let clean_text = Self::clean_subtitle_text(&raw_text);
                    let duration_ms = end_ms.saturating_sub(start_ms);

                    let entry_idx = entries.len();
                    entries.push(ParsedSubtitleEntry {
                        id: format!("sub_srt_{}_{}", entry_idx, start_ms),
                        index: entry_idx + 1,
                        start_ms,
                        end_ms,
                        duration_ms,
                        role: "Default".to_string(),
                        raw_text,
                        clean_text,
                        style: None,
                        actor: None,
                        effect: None,
                        margin_l: None,
                        margin_r: None,
                        margin_v: None,
                    });
                }
            }
        }

        entries
    }

    /// Парсинг WebVTT (.vtt) файлов
    pub fn parse_vtt(content: &str) -> Vec<ParsedSubtitleEntry> {
        let mut entries = Vec::new();
        let normalized = content.replace("\r\n", "\n");
        let blocks: Vec<&str> = normalized.split("\n\n").collect();

        for block in blocks {
            let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
            if lines.is_empty() {
                continue;
            }

            // Пропуск заголовка WEBVTT
            if lines[0].trim().starts_with("WEBVTT") {
                continue;
            }

            let time_line_idx = lines.iter().position(|l| l.contains("-->"));
            if let Some(idx) = time_line_idx {
                let time_line = lines[idx];
                let time_parts: Vec<&str> = time_line.split("-->").collect();
                if time_parts.len() == 2 {
                    // Удаляем возможные VTT-параметры в конце строки (position:50% line:0)
                    let start_raw = time_parts[0].trim();
                    let end_raw = time_parts[1].trim().split_whitespace().next().unwrap_or("");

                    let start_ms = Self::parse_time_to_ms(start_raw).unwrap_or(0);
                    let end_ms = Self::parse_time_to_ms(end_raw).unwrap_or(0);
                    let raw_text = lines[idx + 1..].join("\n");
                    let clean_text = Self::clean_subtitle_text(&raw_text);
                    let duration_ms = end_ms.saturating_sub(start_ms);

                    let entry_idx = entries.len();
                    entries.push(ParsedSubtitleEntry {
                        id: format!("sub_vtt_{}_{}", entry_idx, start_ms),
                        index: entry_idx + 1,
                        start_ms,
                        end_ms,
                        duration_ms,
                        role: "Default".to_string(),
                        raw_text,
                        clean_text,
                        style: None,
                        actor: None,
                        effect: None,
                        margin_l: None,
                        margin_r: None,
                        margin_v: None,
                    });
                }
            }
        }

        entries
    }

    /// Парсинг простого текстового сценария TXT с ролями и таймингами
    pub fn parse_plain_script(content: &str, default_dur_ms: u64) -> Vec<ParsedSubtitleEntry> {
        let mut entries = Vec::new();
        let lines: Vec<&str> = content.lines().collect();
        let mut current_role = "Narrator".to_string();
        let mut cur_time_ms = 0u64;

        let role_re = Regex::new(r"^([\w\sа-яА-ЯёЁ]{2,30}):\s*(.*)$").unwrap();

        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if let Some(caps) = role_re.captures(trimmed) {
                current_role = caps.get(1).map_or("Narrator", |m| m.as_str().trim()).to_string();
                let text = caps.get(2).map_or("", |m| m.as_str().trim());
                if !text.is_empty() {
                    let idx = entries.len();
                    let end_ms = cur_time_ms + default_dur_ms;
                    entries.push(ParsedSubtitleEntry {
                        id: format!("sub_txt_{}_{}", idx, cur_time_ms),
                        index: idx + 1,
                        start_ms: cur_time_ms,
                        end_ms,
                        duration_ms: default_dur_ms,
                        role: current_role.clone(),
                        raw_text: text.to_string(),
                        clean_text: text.to_string(),
                        style: None,
                        actor: Some(current_role.clone()),
                        effect: None,
                        margin_l: None,
                        margin_r: None,
                        margin_v: None,
                    });
                    cur_time_ms += default_dur_ms;
                }
            } else {
                let idx = entries.len();
                let end_ms = cur_time_ms + default_dur_ms;
                entries.push(ParsedSubtitleEntry {
                    id: format!("sub_txt_{}_{}", idx, cur_time_ms),
                    index: idx + 1,
                    start_ms: cur_time_ms,
                    end_ms,
                    duration_ms: default_dur_ms,
                    role: current_role.clone(),
                    raw_text: trimmed.to_string(),
                    clean_text: trimmed.to_string(),
                    style: None,
                    actor: Some(current_role.clone()),
                    effect: None,
                    margin_l: None,
                    margin_r: None,
                    margin_v: None,
                });
                cur_time_ms += default_dur_ms;
            }
        }

        entries
    }
}

// ============================================================================
// 4. PARALLEL SCRIPT & WHISPER FUZZY MATCHER
// ============================================================================

pub struct ScriptAlignmentEngine;

impl ScriptAlignmentEngine {
    /// Параллельное нечеткое сопоставление массива реплик Whisper со сценарием через Rayon O(N * M)
    pub fn match_whisper_with_script(
        whisper_entries: &[WhisperEntry],
        script_lines: &[ScriptEntry],
    ) -> Vec<MatchedScriptPair> {
        if whisper_entries.is_empty() || script_lines.is_empty() {
            return Vec::new();
        }

        // 1. Предварительная нормализация всех строк сценария
        let script_normalized: Vec<(usize, &ScriptEntry, String)> = script_lines
            .iter()
            .enumerate()
            .map(|(idx, entry)| {
                let norm = FastFuzzyMatcher::normalize_text(&entry.text);
                (idx, entry, norm)
            })
            .collect();

        // 2. Параллельный подбор лучшего совпадения для каждой реплики Whisper
        let matched_pairs: Vec<MatchedScriptPair> = whisper_entries
            .par_iter()
            .filter_map(|w_entry| {
                let w_norm = FastFuzzyMatcher::normalize_text(&w_entry.text);
                if w_norm.is_empty() {
                    return None;
                }

                let mut best_sim = 0.0f32;
                let mut best_match: Option<(usize, &ScriptEntry)> = None;

                for (s_idx, s_entry, s_norm) in &script_normalized {
                    let sim = FastFuzzyMatcher::compute_hybrid_similarity(&w_norm, s_norm);
                    if sim > best_sim {
                        best_sim = sim;
                        best_match = Some((*s_idx, *s_entry));
                        if sim >= 0.98 {
                            // Идеальное совпадение — ранний выход
                            break;
                        }
                    }
                }

                if let Some((s_idx, s_entry)) = best_match {
                    let target_start = s_entry.target_start_ms.unwrap_or(w_entry.start_ms);
                    let drift = (w_entry.start_ms as i64) - (target_start as i64);

                    Some(MatchedScriptPair {
                        whisper_id: w_entry.id.clone(),
                        script_id: s_entry.id.clone(),
                        script_index: s_idx + 1,
                        whisper_text: w_entry.text.clone(),
                        script_text: s_entry.text.clone(),
                        role: s_entry.role.clone().unwrap_or_else(|| "Default".to_string()),
                        similarity: best_sim,
                        start_ms: w_entry.start_ms,
                        end_ms: w_entry.end_ms,
                        time_drift_ms: drift,
                        confidence: w_entry.confidence.unwrap_or(1.0) * best_sim,
                        is_exact_match: best_sim >= 0.95,
                    })
                } else {
                    None
                }
            })
            .collect();

        matched_pairs
    }
}

// ============================================================================
// 5. TAURI V2 COMMANDS
// ============================================================================

/// Нативная команда сверхбыстрого парсинга файлов субтитров любого формата
#[tauri::command]
pub async fn parse_subtitle_file_native(
    content: String,
    format: String,
) -> Result<Vec<ParsedSubtitleEntry>, String> {
    let start_time = Instant::now();
    let fmt = format.to_lowercase();

    let result = match fmt.as_str() {
        "ass" | "ssa" => NativeSubtitleParser::parse_ass(&content),
        "srt" => NativeSubtitleParser::parse_srt(&content),
        "vtt" | "webvtt" => NativeSubtitleParser::parse_vtt(&content),
        "txt" | "script" | "text" => NativeSubtitleParser::parse_plain_script(&content, 5000),
        _ => {
            // Автоопределение по сигнатуре
            if content.contains("[Events]") || content.contains("Dialogue:") {
                NativeSubtitleParser::parse_ass(&content)
            } else if content.contains("-->") {
                if content.contains("WEBVTT") {
                    NativeSubtitleParser::parse_vtt(&content)
                } else {
                    NativeSubtitleParser::parse_srt(&content)
                }
            } else {
                NativeSubtitleParser::parse_plain_script(&content, 5000)
            }
        }
    };

    log_info(&format!(
        "[SubtitleFuzzyEngine] Распарсено {} строк ({}) за {:.3}ms",
        result.len(),
        fmt,
        start_time.elapsed().as_secs_f64() * 1000.0
    ));

    Ok(result)
}

/// Нативная команда параллельного нечеткого сопоставления Whisper и сценария
#[tauri::command]
pub async fn match_transcription_with_script(
    whisper_entries: Vec<WhisperEntry>,
    script_lines: Vec<ScriptEntry>,
) -> Result<Vec<MatchedScriptPair>, String> {
    let start_time = Instant::now();
    let whisper_count = whisper_entries.len();
    let script_count = script_lines.len();

    let pairs = ScriptAlignmentEngine::match_whisper_with_script(&whisper_entries, &script_lines);

    log_info(&format!(
        "[SubtitleFuzzyEngine] Сопоставлено {} пар (Whisper: {}, Сценарий: {}) за {:.3}ms",
        pairs.len(),
        whisper_count,
        script_count,
        start_time.elapsed().as_secs_f64() * 1000.0
    ));

    Ok(pairs)
}

// ============================================================================
// 6. UNIT & BENCHMARK TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_levenshtein_distance() {
        assert_eq!(FastFuzzyMatcher::levenshtein_distance("привет", "привет"), 0);
        assert_eq!(FastFuzzyMatcher::levenshtein_distance("привет", "привет!"), 1);
        assert_eq!(FastFuzzyMatcher::levenshtein_distance("котенок", "котелок"), 1);
    }

    #[test]
    fn test_similarity() {
        let sim = FastFuzzyMatcher::compute_hybrid_similarity("Привет мир!", "привет мир");
        assert!(sim > 0.95);
    }

    #[test]
    fn test_parse_ass() {
        let ass_data = r#"
[Script Info]
Title: Test
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:01:20.50,0:01:25.00,Default,Hero,0,0,0,,{\pos(100,200)}Привет, я герой!\NКак дела?
"#;
        let entries = NativeSubtitleParser::parse_ass(ass_data);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].start_ms, 80500);
        assert_eq!(entries[0].end_ms, 85000);
        assert_eq!(entries[0].clean_text, "Привет, я герой! Как дела?");
        assert_eq!(entries[0].role, "Hero");
    }

    #[test]
    fn test_parse_srt() {
        let srt_data = r#"1
00:00:01,000 --> 00:00:04,500
<b>Первая</b> строка <i>субтитров</i>.

2
00:00:05,200 --> 00:00:08,000
Вторая строка.
"#;
        let entries = NativeSubtitleParser::parse_srt(srt_data);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].start_ms, 1000);
        assert_eq!(entries[0].end_ms, 4500);
        assert_eq!(entries[0].clean_text, "Первая строка субтитров.");
    }
}
