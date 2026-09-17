// ============================================================================
// DUB MIXING STUDIO PRO - HIGH PERFORMANCE SUBTITLE COMPILER & LINTER
// Сверхбыстрый нативный компилятор, валидатор и линтер ASS / SRT / VTT
// Стек: regex = "1.10/1.11", chrono = "0.4", serde = "1.0", tauri = "2.2"
// ============================================================================

use std::cmp::Ordering;
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{command, State};

use crate::db::{AppState, SubtitleLine};
use sqlx::Row;

// ============================================================================
// 1. DATA STRUCTURES & CONFIGURATION
// ============================================================================

/// Поддерживаемые форматы вывода субтитров
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubtitleFormat {
    #[serde(alias = "ASS", alias = "ass")]
    Ass,
    #[serde(alias = "SRT", alias = "srt")]
    Srt,
    #[serde(alias = "VTT", alias = "vtt")]
    Vtt,
}

impl SubtitleFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            SubtitleFormat::Ass => "ass",
            SubtitleFormat::Srt => "srt",
            SubtitleFormat::Vtt => "vtt",
        }
    }

    pub fn mime_type(&self) -> &'static str {
        match self {
            SubtitleFormat::Ass => "text/x-ssa",
            SubtitleFormat::Srt => "application/x-subrip",
            SubtitleFormat::Vtt => "text/vtt",
        }
    }
}

/// Конфигурация стилизации и рендеринга ASS v4.00+
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssStyleConfig {
    pub font_name: String,
    pub font_size: f64,
    pub primary_color: String,    // Hex "#FFFFFF" или ASS "&H00FFFFFF&"
    pub secondary_color: String,  // Вторичный цвет для караоке-хайлайта
    pub outline_color: String,    // Цвет обводки
    pub shadow_color: String,     // Цвет тени
    pub outline_width: f64,       // Толщина обводки в пикселях
    pub shadow_depth: f64,        // Дистанция тени в пикселях
    pub alignment: u32,           // Выравнивание An1..An9 (numpad-стиль)
    pub margin_left: i32,
    pub margin_right: i32,
    pub margin_vertical: i32,
    pub play_res_x: u32,          // Базовое разрешение PlayResX (1920)
    pub play_res_y: u32,          // Базовое разрешение PlayResY (1080)
    pub smart_wrap: bool,         // Включить автоматический перенос строк
    pub max_line_length: usize,   // Максимум символов в одной строке (38)
}

impl Default for AssStyleConfig {
    fn default() -> Self {
        Self {
            font_name: "Arial".to_string(),
            font_size: 48.0,
            primary_color: "#FFFFFF".to_string(),
            secondary_color: "#00E5FF".to_string(), // Золотисто-голубой для караоке
            outline_color: "#000000".to_string(),
            shadow_color: "#80000000".to_string(), // Полупрозрачная черная тень
            outline_width: 2.5,
            shadow_depth: 1.2,
            alignment: 2, // 2 = Bottom Center
            margin_left: 40,
            margin_right: 40,
            margin_vertical: 45,
            play_res_x: 1920,
            play_res_y: 1080,
            smart_wrap: true,
            max_line_length: 38,
        }
    }
}

// ============================================================================
// 2. LINTER & REPORT STRUCTURES
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueSeverity {
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinterIssueType {
    HighCps,         // Скорость чтения > 20 CPS
    TooShort,        // Длительность < 0.8 сек
    TooLong,         // Длительность > 7.0 сек
    InvalidDuration, // end <= start
    TimeOverlap,     // Наезд таймкодов строк друг на друга
    EmptyText,       // Пустой текст реплики
    UnclosedTag,     // Незакрытые скобки {} или теги
}

/// Запись о проблеме валидации субтитров
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleLinterIssue {
    pub line_id: String,
    pub line_index: usize,
    pub issue_type: LinterIssueType,
    pub severity: IssueSeverity,
    pub message: String,
    pub start: f64,
    pub end: f64,
    pub measured_value: Option<f64>,
    pub threshold: Option<f64>,
}

/// Статистические метрики контента субтитров
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleReportStats {
    pub total_lines: usize,
    pub total_duration: f64,
    pub average_cps: f64,
    pub max_cps: f64,
    pub overlap_count: usize,
    pub warning_count: usize,
    pub error_count: usize,
}

/// Итоговый отчет компиляции и валидации субтитров
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledSubtitleReport {
    pub project_id: String,
    pub format: SubtitleFormat,
    pub compiled_content: String,
    pub total_lines: usize,
    pub is_valid: bool,
    pub warnings: Vec<SubtitleLinterIssue>,
    pub errors: Vec<SubtitleLinterIssue>,
    pub stats: SubtitleReportStats,
}

/// Результат быстрого нативного парсинга файла субтитров
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSubtitlesNative {
    pub roles: Vec<String>,
    pub subtitles: Vec<SubtitleLine>,
}

// ============================================================================
// 3. COLOR & TIMECODE CONVERSIONS (ROBUST / ZERO-CRASH)
// ============================================================================

/// Преобразует HEX (#RRGGBB или #AARRGGBB) в формат цвета ASS: &HAABBGGRR&
/// В формате ASS: Alpha &H00 - непрозрачный, &HFF - полностью прозрачный.
pub fn hex_to_ass_color(hex: &str, default_alpha: &str) -> String {
    let clean = hex.trim().trim_start_matches('&').trim_start_matches('H').trim_start_matches('#').trim_end_matches('&');
    match clean.len() {
        6 => {
            let r = &clean[0..2];
            let g = &clean[2..4];
            let b = &clean[4..6];
            format!("&H{}{}{}{}&", default_alpha, b, g, r)
        }
        8 => {
            let a = &clean[0..2];
            let r = &clean[2..4];
            let g = &clean[4..6];
            let b = &clean[6..8];
            format!("&H{}{}{}{}&", a, b, g, r)
        }
        3 => {
            let r = format!("{}{}", &clean[0..1], &clean[0..1]);
            let g = format!("{}{}", &clean[1..2], &clean[1..2]);
            let b = format!("{}{}", &clean[2..3], &clean[2..3]);
            format!("&H{}{}{}{}&", default_alpha, b, g, r)
        }
        _ => {
            // Если уже передан валидный ASS цвет
            if hex.starts_with("&H") && hex.ends_with('&') {
                hex.to_string()
            } else {
                format!("&H{}FFFFFF&", default_alpha)
            }
        }
    }
}

/// Высокоточное форматирование секунд в таймкод ASS: H:MM:SS.cs (сотые секунды)
/// Поддерживает таймкоды через полночь (h >= 24) без сброса или паники.
pub fn format_ass_time(seconds: f64) -> String {
    let safe_sec = seconds.max(0.0);
    let total_cs = (safe_sec * 100.0).round() as u64;
    let cs = total_cs % 100;
    let total_s = total_cs / 100;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{}:{:02}:{:02}.{:02}", h, m, s, cs)
}

/// Высокоточное форматирование секунд в таймкод SRT: HH:MM:SS,mmm (миллисекунды)
pub fn format_srt_time(seconds: f64) -> String {
    let safe_sec = seconds.max(0.0);
    let total_ms = (safe_sec * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
}

/// Высокоточное форматирование секунд в таймкод WebVTT: HH:MM:SS.mmm (миллисекунды через точку)
pub fn format_vtt_time(seconds: f64) -> String {
    let safe_sec = seconds.max(0.0);
    let total_ms = (safe_sec * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms)
}

/// Парсинг строки таймкода ASS/SRT/VTT в секунды
pub fn parse_timecode_to_seconds(tc: &str) -> Option<f64> {
    let clean = tc.trim();
    // 00:00:00.00 или 00:00:00,000
    let parts: Vec<&str> = clean.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().ok()?;
        let m: f64 = parts[1].parse().ok()?;
        let sec_part = parts[2].replace(',', ".");
        let s: f64 = sec_part.parse().ok()?;
        Some(h * 3600.0 + m * 60.0 + s)
    } else if parts.len() == 2 {
        let m: f64 = parts[0].parse().ok()?;
        let sec_part = parts[1].replace(',', ".");
        let s: f64 = sec_part.parse().ok()?;
        Some(m * 60.0 + s)
    } else {
        None
    }
}

// ============================================================================
// 4. SMART LINE WRAP (УМНЫЙ ПЕРЕНОС СТРОК)
// ============================================================================

/// Список коротких союзов и предлогов (русский и английский), которые нельзя оставлять
/// висячими в конце строки перед переносом.
const ORPHAN_TOKENS: &[&str] = &[
    "в", "во", "к", "ко", "с", "со", "у", "о", "об", "обо", "на", "за", "из", "из-за", "из-под",
    "по", "под", "над", "до", "от", "для", "без", "про", "через", "при", "сквозь",
    "и", "а", "но", "да", "или", "что", "как", "где", "то", "не", "ни", "бы", "ли", "же",
    "a", "an", "the", "in", "on", "at", "to", "for", "with", "by", "from", "of", "and", "or", "but", "so", "if",
];

/// Выполняет типографически грамотный перенос строк (Smart Line Wrap) по знакам препинания
/// и синтаксическим группам без разрыва устойчивых выражений и висячих предлогов.
pub fn smart_line_wrap(text: &str, max_line_len: usize) -> String {
    let clean_text = text.trim();
    // Если уже есть явный перенос строки, не меняем структуру
    if clean_text.contains('\n') || clean_text.contains("\\N") || clean_text.contains("\\n") {
        return clean_text.to_string();
    }

    // Подсчет видимых символов (без тегов {...})
    let tag_re = Regex::new(r"\{[^}]*\}").unwrap();
    let visible_chars: String = tag_re.replace_all(clean_text, "").to_string();
    if visible_chars.chars().count() <= max_line_len {
        return clean_text.to_string();
    }

    let words: Vec<&str> = clean_text.split_whitespace().collect();
    if words.len() <= 2 {
        return clean_text.to_string();
    }

    // Поиск оптимальной точки разбиения
    let total_len = clean_text.chars().count();
    let mid_point = total_len / 2;

    let mut best_split_idx = 0;
    let mut best_score = -10000.0;

    let mut current_char_count = 0;

    for i in 0..(words.len() - 1) {
        let word = words[i];
        current_char_count += word.chars().count() + 1; // + пробел

        let line1_len = current_char_count;
        let line2_len = total_len.saturating_sub(line1_len);

        // Базовый штраф за дисбаланс длин строк
        let balance_diff = (line1_len as f64 - line2_len as f64).abs();
        let mut score = 100.0 - balance_diff * 1.5;

        // Штраф, если строка превышает лимит
        if line1_len > max_line_len {
            score -= (line1_len - max_line_len) as f64 * 4.0;
        }
        if line2_len > max_line_len {
            score -= (line2_len - max_line_len) as f64 * 4.0;
        }

        // Преимущество знакам препинания в конце первого слова
        if word.ends_with('.') || word.ends_with('!') || word.ends_with('?') || word.ends_with("...") {
            score += 50.0;
        } else if word.ends_with(',') || word.ends_with(';') || word.ends_with(':') || word.ends_with("—") || word.ends_with('-') {
            score += 35.0;
        }

        // Штраф, если слово в конце первой строки — висячий предлог/союз
        let clean_word_lower = word.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
        if ORPHAN_TOKENS.contains(&clean_word_lower.as_str()) {
            score -= 60.0;
        }

        // Преимущество, если следующее слово начинает новое предложение или оборот (союз)
        let next_word_clean = words[i + 1].trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
        if ["что", "чтобы", "если", "когда", "потому", "хотя", "который", "which", "because", "that"].contains(&next_word_clean.as_str()) {
            score += 20.0;
        }

        // Близость к середине текста
        let dist_from_mid = ((line1_len as isize) - (mid_point as isize)).abs() as f64;
        score -= dist_from_mid * 0.8;

        if score > best_score {
            best_score = score;
            best_split_idx = i;
        }
    }

    if best_split_idx > 0 && best_split_idx < words.len() - 1 {
        let line1 = words[..=best_split_idx].join(" ");
        let line2 = words[(best_split_idx + 1)..].join(" ");
        format!("{}\n{}", line1, line2)
    } else {
        clean_text.to_string()
    }
}

// ============================================================================
// 5. TAG PARSING, POSITIONING & KARAOKE COMPILATION
// ============================================================================

/// Обрабатывает позиционирование `\pos(x,y)` и выравнивание `\an` для надписей/вывесок
pub fn format_ass_dialogue_text(raw_text: &str, role: &str, play_res_x: u32, play_res_y: u32) -> String {
    let role_lower = role.to_lowercase();
    let text_trimmed = raw_text.trim();

    // 1. Нормализация переводов строк в ASS формат \N
    let mut text = text_trimmed
        .replace("\r\n", "\\N")
        .replace('\n', "\\N")
        .replace("\\n", "\\N");

    // 2. Детекция и генерация караоке-тегов \k<cs>
    // Поддержка синтаксиса [k:25]слово или |25|слово -> {\k25}слово
    let karaoke_bracket_re = Regex::new(r"\[k:\s*(\d+)\]").unwrap();
    if karaoke_bracket_re.is_match(&text) {
        text = karaoke_bracket_re.replace_all(&text, "{\\k$1}").to_string();
    }
    let karaoke_pipe_re = Regex::new(r"\|(\d+)\|").unwrap();
    if karaoke_pipe_re.is_match(&text) {
        text = karaoke_pipe_re.replace_all(&text, "{\\k$1}").to_string();
    }

    // 3. Детекция явных позиционных тегов [pos: x, y] или [pos:x,y]
    let pos_tag_re = Regex::new(r"\[pos:\s*(\d+)\s*,\s*(\d+)\s*\]").unwrap();
    if let Some(caps) = pos_tag_re.captures(&text) {
        let x = &caps[1];
        let y = &caps[2];
        let stripped = pos_tag_re.replace(&text, "").to_string();
        return format!("{{\\pos({},{})}}{}", x, y, stripped.trim());
    }

    // 4. Проверка категорий надписей и вывесок (Signs / On-Screen)
    let is_sign = role_lower.contains("sign")
        || role_lower.contains("вывеска")
        || role_lower.contains("надпись")
        || role_lower.contains("титры")
        || role_lower.contains("onscreen")
        || role_lower.contains("screen")
        || text.starts_with("[Надпись:")
        || text.starts_with("[Титры:");

    // Если это надпись/вывеска и нет явных тегов {\pos} или {\an}, добавляем {\an8} (верх центр)
    if is_sign && !text.contains("{\\pos") && !text.contains("{\\an") {
        let default_y = (play_res_y as f64 * 0.12).round() as u32; // 12% от верха экрана
        let center_x = play_res_x / 2;
        text = format!("{{\\pos({},{})}}{}", center_x, default_y, text);
    }

    text
}

/// Преобразует ASS теги в чистый текст или HTML-теги `<i>`, `<b>` для форматов SRT и VTT
pub fn convert_ass_tags_to_markup(text: &str, target_format: SubtitleFormat) -> String {
    // 1. Замена переводов строк ASS \N и \n на обычные \n
    let mut result = text
        .replace("\\N", "\n")
        .replace("\\n", "\n")
        .replace("\\h", " ");

    // 2. Обработка тегов курсива {\i1} и {\i0} -> <i>...</i>
    let italic_on_re = Regex::new(r"\{\\i1\}").unwrap();
    let italic_off_re = Regex::new(r"\{\\i0\}").unwrap();
    let italic_toggle_re = Regex::new(r"\{\\i\}").unwrap();

    let has_italic = italic_on_re.is_match(&result) || italic_toggle_re.is_match(&result);

    result = italic_on_re.replace_all(&result, "<i>").to_string();
    result = italic_off_re.replace_all(&result, "</i>").to_string();
    result = italic_toggle_re.replace_all(&result, "<i>").to_string();

    // 3. Обработка тегов жирного {\b1} и {\b0} -> <b>...</b>
    let bold_on_re = Regex::new(r"\{\\b1\}").unwrap();
    let bold_off_re = Regex::new(r"\{\\b0\}").unwrap();
    result = bold_on_re.replace_all(&result, "<b>").to_string();
    result = bold_off_re.replace_all(&result, "</b>").to_string();

    // 4. Очистка всех остальных ASS override-тегов: {\...}
    let all_tags_re = Regex::new(r"\{[^}]*\}").unwrap();
    result = all_tags_re.replace_all(&result, "").to_string();

    // 5. Если для SRT/VTT не закрыт тег курсива или жирного
    if has_italic && !result.contains("</i>") {
        result.push_str("</i>");
    }

    // 6. Для чистого текста при необходимости
    if target_format == SubtitleFormat::Srt {
        // SRT отлично поддерживает <i> и <b>
    } else if target_format == SubtitleFormat::Vtt {
        // WebVTT поддерживает <i>, <b>, <u>
    }

    result.trim().to_string()
}

/// Удаляет все теги для точного подсчета символов при расчете CPS
pub fn strip_all_tags(text: &str) -> String {
    let tag_re = Regex::new(r"\{[^}]*\}|<[^>]*>").unwrap();
    let stripped = tag_re.replace_all(text, "").to_string();
    stripped
        .replace("\\N", " ")
        .replace("\\n", " ")
        .replace('\n', " ")
        .replace('\r', " ")
        .trim()
        .to_string()
}

// ============================================================================
// 6. SUBTITLE LINTER & COMPLIANCE VALIDATOR
// ============================================================================

/// Полная валидация субтитров согласно строгим стандартам телевещания и стриминга
pub fn lint_subtitles(
    subtitles: &[SubtitleLine],
    max_cps_threshold: f64,
    min_duration_sec: f64,
    max_duration_sec: f64,
) -> (Vec<SubtitleLinterIssue>, Vec<SubtitleLinterIssue>, SubtitleReportStats) {
    let mut warnings = Vec::new();
    let mut errors = Vec::new();

    let total_lines = subtitles.len();
    if total_lines == 0 {
        return (
            warnings,
            errors,
            SubtitleReportStats {
                total_lines: 0,
                total_duration: 0.0,
                average_cps: 0.0,
                max_cps: 0.0,
                overlap_count: 0,
                warning_count: 0,
                error_count: 0,
            },
        );
    }

    let mut total_duration = 0.0;
    let mut total_chars = 0usize;
    let mut max_cps = 0.0f64;
    let mut overlap_count = 0usize;

    // Вспомогательный индекс для сортировки по времени старта
    let mut indexed_subs: Vec<(usize, &SubtitleLine)> = subtitles.iter().enumerate().collect();
    indexed_subs.sort_by(|a, b| a.1.start.partial_cmp(&b.1.start).unwrap_or(Ordering::Equal));

    // 1. Проверка каждой отдельной строки
    for (orig_idx, sub) in &indexed_subs {
        let idx = *orig_idx;
        let duration = sub.end - sub.start;
        let visible_text = strip_all_tags(&sub.text);
        let char_count = visible_text.chars().count();

        // Проверка корректности таймкода
        if duration <= 0.0 {
            errors.push(SubtitleLinterIssue {
                line_id: sub.id.clone(),
                line_index: idx + 1,
                issue_type: LinterIssueType::InvalidDuration,
                severity: IssueSeverity::Error,
                message: format!(
                    "Недопустимая длительность: {:.2} сек. Таймкод окончания ({:.2}s) меньше или равен началу ({:.2}s).",
                    duration, sub.end, sub.start
                ),
                start: sub.start,
                end: sub.end,
                measured_value: Some(duration),
                threshold: Some(0.0),
            });
            continue;
        }

        total_duration += duration;
        total_chars += char_count;

        // Проверка пустого текста
        if visible_text.trim().is_empty() {
            warnings.push(SubtitleLinterIssue {
                line_id: sub.id.clone(),
                line_index: idx + 1,
                issue_type: LinterIssueType::EmptyText,
                severity: IssueSeverity::Warning,
                message: "Строка субтитров не содержит видимого текста.".to_string(),
                start: sub.start,
                end: sub.end,
                measured_value: None,
                threshold: None,
            });
        }

        // Проверка незакрытых фигурных скобок ASS тегов
        let open_braces = sub.text.matches('{').count();
        let close_braces = sub.text.matches('}').count();
        if open_braces != close_braces {
            errors.push(SubtitleLinterIssue {
                line_id: sub.id.clone(),
                line_index: idx + 1,
                issue_type: LinterIssueType::UnclosedTag,
                severity: IssueSeverity::Error,
                message: format!(
                    "Синтаксическая ошибка ASS: количество открывающих '{{' ({}) не совпадает с закрывающими '}}' ({}).",
                    open_braces, close_braces
                ),
                start: sub.start,
                end: sub.end,
                measured_value: None,
                threshold: None,
            });
        }

        // Расчет скорости чтения (CPS - Characters Per Second)
        let cps = if duration > 0.0 {
            char_count as f64 / duration
        } else {
            0.0
        };

        if cps > max_cps {
            max_cps = cps;
        }

        if cps > max_cps_threshold {
            warnings.push(SubtitleLinterIssue {
                line_id: sub.id.clone(),
                line_index: idx + 1,
                issue_type: LinterIssueType::HighCps,
                severity: IssueSeverity::Warning,
                message: format!(
                    "Превышение скорости чтения: {:.1} симв/сек при нормативе <= {:.1} CPS (символов: {}, длительность: {:.2}s).",
                    cps, max_cps_threshold, char_count, duration
                ),
                start: sub.start,
                end: sub.end,
                measured_value: Some(cps),
                threshold: Some(max_cps_threshold),
            });
        }

        // Проверка минимальной длительности (0.8 сек)
        if duration < min_duration_sec {
            warnings.push(SubtitleLinterIssue {
                line_id: sub.id.clone(),
                line_index: idx + 1,
                issue_type: LinterIssueType::TooShort,
                severity: IssueSeverity::Warning,
                message: format!(
                    "Длительность строки слишком мала: {:.2} сек (минимальный порог: {:.1} сек).",
                    duration, min_duration_sec
                ),
                start: sub.start,
                end: sub.end,
                measured_value: Some(duration),
                threshold: Some(min_duration_sec),
            });
        }

        // Проверка максимальной длительности (7.0 сек)
        if duration > max_duration_sec {
            warnings.push(SubtitleLinterIssue {
                line_id: sub.id.clone(),
                line_index: idx + 1,
                issue_type: LinterIssueType::TooLong,
                severity: IssueSeverity::Warning,
                message: format!(
                    "Длительность строки слишком велика: {:.2} сек (максимальный порог: {:.1} сек). Рекомендуется разбиение реплики.",
                    duration, max_duration_sec
                ),
                start: sub.start,
                end: sub.end,
                measured_value: Some(duration),
                threshold: Some(max_duration_sec),
            });
        }
    }

    // 2. Поиск наездов таймкодов (Overlaps)
    for i in 0..(indexed_subs.len().saturating_sub(1)) {
        let (idx_curr, curr) = indexed_subs[i];
        let (idx_next, next) = indexed_subs[i + 1];

        // Наезд: текущая строка заканчивается позже старта следующей (с допуском 2 мс)
        if curr.end > next.start + 0.002 {
            let overlap_sec = curr.end - next.start;
            overlap_count += 1;
            warnings.push(SubtitleLinterIssue {
                line_id: curr.id.clone(),
                line_index: idx_curr + 1,
                issue_type: LinterIssueType::TimeOverlap,
                severity: IssueSeverity::Warning,
                message: format!(
                    "Наезд таймкода: строка #{} (конец {:.2}s) перекрывает строку #{} (старт {:.2}s) на {:.3} сек.",
                    idx_curr + 1, curr.end, idx_next + 1, next.start, overlap_sec
                ),
                start: curr.start,
                end: curr.end,
                measured_value: Some(overlap_sec),
                threshold: Some(0.0),
            });
        }
    }

    let average_cps = if total_duration > 0.0 {
        total_chars as f64 / total_duration
    } else {
        0.0
    };

    let stats = SubtitleReportStats {
        total_lines,
        total_duration,
        average_cps,
        max_cps,
        overlap_count,
        warning_count: warnings.len(),
        error_count: errors.len(),
    };

    (warnings, errors, stats)
}

// ============================================================================
// 7. COMPILERS FOR ASS, SRT, AND VTT
// ============================================================================

/// Компилирует субтитры в спецификацию Advanced SubStation Alpha (.ass v4.00+)
pub fn compile_to_ass(
    subtitles: &[SubtitleLine],
    config: &AssStyleConfig,
    title: Option<&str>,
) -> String {
    let font_name = &config.font_name;
    let font_size = config.font_size;
    let ass_primary = hex_to_ass_color(&config.primary_color, "00");
    let ass_secondary = hex_to_ass_color(&config.secondary_color, "00");
    let ass_outline = hex_to_ass_color(&config.outline_color, "00");
    let ass_shadow = hex_to_ass_color(&config.shadow_color, "80");
    let outline_w = config.outline_width;
    let shadow_d = config.shadow_depth;
    let default_align = config.alignment;
    let margin_l = config.margin_left;
    let margin_r = config.margin_right;
    let margin_v = config.margin_vertical;
    let play_res_x = config.play_res_x;
    let play_res_y = config.play_res_y;

    let script_title = title.unwrap_or("DubStudio Pro Master Subtitles");

    // Цветовые палитры для ролей
    let signs_color = "&H0032D6FF&";    // Янтарно-золотистый для вывесок/титров
    let narrator_color = "&H00E6FFFF&"; // Теплый закадровый голос
    let whisper_color = "&H00D0D0D0&";  // Серебристый шепот
    let karaoke_sec = "&H0000FFFF&";    // Вторичный цвет караоке (желтый)

    let mut ass = String::with_capacity(subtitles.len() * 120 + 2048);

    // 1. [Script Info]
    let timestamp_str = Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string();
    ass.push_str("[Script Info]\n");
    ass.push_str("; Script generated by DubStudio Pro ASS/SRT Native High-Precision Compiler\n");
    ass.push_str(&format!("; Compiled At: {}\n", timestamp_str));
    ass.push_str(&format!("Title: {}\n", script_title));
    ass.push_str("ScriptType: v4.00+\n");
    ass.push_str("WrapStyle: 0\n");
    ass.push_str("ScaledBorderAndShadow: yes\n");
    ass.push_str("YCbCr Matrix: TV.709\n");
    ass.push_str(&format!("PlayResX: {}\n", play_res_x));
    ass.push_str(&format!("PlayResY: {}\n", play_res_y));
    ass.push_str("\n");

    // 2. [V4+ Styles]
    ass.push_str("[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");

    // Основной стиль диалогов
    ass.push_str(&format!(
        "Style: Default,{},{:.1},{},{},{},{},0,0,0,0,100,100,0,0,1,{:.1},{:.1},{},{},{},{},1\n",
        font_name, font_size, ass_primary, ass_secondary, ass_outline, ass_shadow, outline_w, shadow_d, default_align, margin_l, margin_r, margin_v
    ));
    ass.push_str(&format!(
        "Style: ActorDialogue,{},{:.1},{},{},{},{},0,0,0,0,100,100,0,0,1,{:.1},{:.1},{},{},{},{},1\n",
        font_name, font_size, ass_primary, ass_secondary, ass_outline, ass_shadow, outline_w, shadow_d, default_align, margin_l, margin_r, margin_v
    ));

    // Закадровый диктор (Narrator / Voiceover) - курсив
    ass.push_str(&format!(
        "Style: Voiceover,{},{:.1},{},{},{},{},0,-1,0,0,100,100,0,0,1,{:.1},{:.1},{},{},{},{},1\n",
        font_name, font_size * 0.96, narrator_color, ass_secondary, ass_outline, ass_shadow, outline_w, shadow_d, default_align, margin_l, margin_r, margin_v + 10
    ));
    ass.push_str(&format!(
        "Style: Narrator,{},{:.1},{},{},{},{},0,-1,0,0,100,100,0,0,1,{:.1},{:.1},{},{},{},{},1\n",
        font_name, font_size * 0.96, narrator_color, ass_secondary, ass_outline, ass_shadow, outline_w, shadow_d, default_align, margin_l, margin_r, margin_v + 10
    ));

    // Шепот / Внутренний голос
    ass.push_str(&format!(
        "Style: Whisper,{},{:.1},{},{},{},{},0,-1,0,0,100,100,0,0,1,{:.1},{:.1},{},{},{},{},1\n",
        font_name, font_size * 0.88, whisper_color, ass_secondary, ass_outline, ass_shadow, outline_w * 0.85, shadow_d, default_align, margin_l, margin_r, margin_v
    ));

    // Надписи, вывески, экранный текст (Signs) - жирный, золотистый, выравнивание 8 (верх центр)
    ass.push_str(&format!(
        "Style: Signs,{},{:.1},{},{},{},{},-1,0,0,0,100,100,0,0,1,{:.1},{:.1},8,{},{},45,1\n",
        font_name, font_size * 1.05, signs_color, ass_secondary, ass_outline, ass_shadow, outline_w * 1.35, shadow_d * 1.2, margin_l, margin_r
    ));
    ass.push_str(&format!(
        "Style: OnScreen,{},{:.1},{},{},{},{},-1,0,0,0,100,100,0,0,1,{:.1},{:.1},8,{},{},45,1\n",
        font_name, font_size * 1.05, signs_color, ass_secondary, ass_outline, ass_shadow, outline_w * 1.35, shadow_d * 1.2, margin_l, margin_r
    ));

    // Караоке-стиль с контрастным SecondaryColour для подсветки слогов актера \k<duration>
    ass.push_str(&format!(
        "Style: Karaoke,{},{:.1},{},{},{},{},-1,0,0,0,100,100,0,0,1,{:.1},{:.1},{},{},{},{},1\n",
        font_name, font_size * 1.05, ass_primary, karaoke_sec, ass_outline, ass_shadow, outline_w * 1.2, shadow_d, default_align, margin_l, margin_r, margin_v
    ));

    // Титры / Заголовки (Title) - центрированный крупный
    ass.push_str(&format!(
        "Style: Title,{},{:.1},{},{},{},{},-1,0,0,0,100,100,0,0,1,{:.1},{:.1},5,{},{},40,1\n",
        font_name, font_size * 1.30, ass_primary, ass_secondary, ass_outline, ass_shadow, outline_w * 1.5, shadow_d * 1.5, margin_l, margin_r
    ));

    ass.push_str("\n");

    // 3. [Events]
    ass.push_str("[Events]\n");
    ass.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    for sub in subtitles {
        let role_clean = sub.role.trim();
        let role_lower = role_clean.to_lowercase();

        // Определение стиля строки
        let is_sign = role_lower.contains("sign")
            || role_lower.contains("вывеска")
            || role_lower.contains("надпись")
            || role_lower.contains("титры")
            || role_lower.contains("onscreen")
            || sub.text.starts_with("[Надпись:")
            || sub.text.starts_with("[Титры:");

        let is_voiceover = role_lower.contains("narrator")
            || role_lower.contains("диктор")
            || role_lower.contains("закадр")
            || role_lower.contains("voiceover")
            || role_lower.contains("vo");

        let is_whisper = role_lower.contains("whisper")
            || role_lower.contains("шепот")
            || role_lower.contains("мысли");

        let is_karaoke = role_lower.contains("karaoke")
            || role_lower.contains("караоке")
            || sub.text.contains("{\\k")
            || sub.text.contains("[k:");

        let style_name = if is_karaoke {
            "Karaoke"
        } else if is_sign {
            "Signs"
        } else if is_voiceover {
            "Voiceover"
        } else if is_whisper {
            "Whisper"
        } else {
            "ActorDialogue"
        };

        // Умный перенос строк, если включен в конфигурации
        let text_wrapped = if config.smart_wrap {
            smart_line_wrap(&sub.text, config.max_line_length)
        } else {
            sub.text.clone()
        };

        // Форматирование тегов \pos и \k
        let formatted_text = format_ass_dialogue_text(&text_wrapped, &sub.role, play_res_x, play_res_y);

        // Экранирование запятых в имени актера для сохранения структуры CSV ASS
        let safe_actor_name = role_clean.replace(',', " ");

        let start_time = format_ass_time(sub.start);
        let end_time = format_ass_time(sub.end);

        ass.push_str(&format!(
            "Dialogue: 0,{},{},{},{},0,0,0,,{}\n",
            start_time, end_time, style_name, safe_actor_name, formatted_text
        ));
    }

    ass
}

/// Компилирует субтитры в формат SubRip (.srt)
pub fn compile_to_srt(subtitles: &[SubtitleLine], smart_wrap: bool, max_line_len: usize) -> String {
    let mut srt = String::with_capacity(subtitles.len() * 80);

    for (idx, sub) in subtitles.iter().enumerate() {
        srt.push_str(&format!("{}\n", idx + 1));
        srt.push_str(&format!(
            "{} --> {}\n",
            format_srt_time(sub.start),
            format_srt_time(sub.end)
        ));

        let text_wrapped = if smart_wrap {
            smart_line_wrap(&sub.text, max_line_len)
        } else {
            sub.text.clone()
        };

        // Преобразование ASS-тегов в чистый текст / <i>...</i>
        let converted = convert_ass_tags_to_markup(&text_wrapped, SubtitleFormat::Srt);
        srt.push_str(&converted);
        srt.push_str("\n\n");
    }

    srt
}

/// Компилирует субтитры в формат WebVTT (.vtt)
pub fn compile_to_vtt(subtitles: &[SubtitleLine], smart_wrap: bool, max_line_len: usize) -> String {
    let mut vtt = String::with_capacity(subtitles.len() * 85 + 32);
    vtt.push_str("WEBVTT\n\n");

    for (idx, sub) in subtitles.iter().enumerate() {
        vtt.push_str(&format!("{}\n", idx + 1));
        vtt.push_str(&format!(
            "{} --> {}\n",
            format_vtt_time(sub.start),
            format_vtt_time(sub.end)
        ));

        let text_wrapped = if smart_wrap {
            smart_line_wrap(&sub.text, max_line_len)
        } else {
            sub.text.clone()
        };

        let converted = convert_ass_tags_to_markup(&text_wrapped, SubtitleFormat::Vtt);
        vtt.push_str(&converted);
        vtt.push_str("\n\n");
    }

    vtt
}

/// Универсальный компилятор субтитров по выбранному формату
pub fn compile_subtitles(
    subtitles: &[SubtitleLine],
    format: SubtitleFormat,
    config: &AssStyleConfig,
    title: Option<&str>,
) -> String {
    match format {
        SubtitleFormat::Ass => compile_to_ass(subtitles, config, title),
        SubtitleFormat::Srt => compile_to_srt(subtitles, config.smart_wrap, config.max_line_length),
        SubtitleFormat::Vtt => compile_to_vtt(subtitles, config.smart_wrap, config.max_line_length),
    }
}

// ============================================================================
// 8. FAST NATIVE PARSER (REPLACING JS ASS-COMPILER)
// ============================================================================

/// Быстрый нативный разбор ASS файлов без вызова тяжелых JS библиотек
pub fn parse_ass_native(content: &str) -> ParsedSubtitlesNative {
    let mut subtitles = Vec::new();
    let mut roles_set = std::collections::HashSet::new();

    let mut in_events = false;
    let mut format_cols: Vec<String> = Vec::new();

    let tag_re = Regex::new(r"\{[^}]*\}").unwrap();

    for line in content.lines() {
        let line_trimmed = line.trim();
        if line_trimmed.starts_with('[') && line_trimmed.ends_with(']') {
            in_events = line_trimmed.eq_ignore_ascii_case("[Events]");
            continue;
        }

        if !in_events {
            continue;
        }

        if line_trimmed.to_lowercase().starts_with("format:") {
            let cols_str = &line_trimmed[7..];
            format_cols = cols_str.split(',').map(|c| c.trim().to_lowercase()).collect();
            continue;
        }

        if line_trimmed.to_lowercase().starts_with("dialogue:") {
            let data_str = &line_trimmed[9..].trim();
            // Разделяем максимум по числу колонок (Text - последняя, может содержать запятые)
            let max_splits = if format_cols.is_empty() { 10 } else { format_cols.len() };
            let parts: Vec<&str> = data_str.splitn(max_splits, ',').collect();

            let mut start_sec = 0.0f64;
            let mut end_sec = 0.0f64;
            let mut role = "Default".to_string();
            let mut raw_text = "";

            if format_cols.is_empty() {
                // Стандартный формат: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
                if parts.len() >= 10 {
                    start_sec = parse_timecode_to_seconds(parts[1]).unwrap_or(0.0);
                    end_sec = parse_timecode_to_seconds(parts[2]).unwrap_or(0.0);
                    let name = parts[4].trim();
                    let style = parts[3].trim();
                    role = if !name.is_empty() { name.to_string() } else { style.to_string() };
                    raw_text = parts[9];
                }
            } else {
                for (col_idx, col_name) in format_cols.iter().enumerate() {
                    if col_idx >= parts.len() {
                        break;
                    }
                    let val = parts[col_idx].trim();
                    match col_name.as_str() {
                        "start" => start_sec = parse_timecode_to_seconds(val).unwrap_or(0.0),
                        "end" => end_sec = parse_timecode_to_seconds(val).unwrap_or(0.0),
                        "name" => {
                            if !val.is_empty() {
                                role = val.to_string();
                            }
                        }
                        "style" => {
                            if role == "Default" && !val.is_empty() {
                                role = val.to_string();
                            }
                        }
                        "text" => raw_text = parts[col_idx],
                        _ => {}
                    }
                }
            }

            // Очистка тегов и нормализация переводов строк
            let clean_text = tag_re
                .replace_all(raw_text, "")
                .replace("\\N", "\n")
                .replace("\\n", "\n")
                .replace("\\h", " ")
                .trim()
                .to_string();

            roles_set.insert(role.clone());
            let line_id = format!("ass_{}", subtitles.len());

            subtitles.push(SubtitleLine {
                id: line_id,
                start: start_sec,
                end: end_sec,
                text: clean_text,
                role,
            });
        }
    }

    let mut roles: Vec<String> = roles_set.into_iter().collect();
    roles.sort();
    if roles.is_empty() {
        roles.push("Default".to_string());
    }

    ParsedSubtitlesNative { roles, subtitles }
}

/// Быстрый нативный разбор SRT файлов
pub fn parse_srt_native(content: &str) -> ParsedSubtitlesNative {
    let mut subtitles = Vec::new();
    let time_re = Regex::new(r"(\d{1,2}:\d{2}:\d{2}[,\.]\d{2,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{2,3})").unwrap();
    let html_tag_re = Regex::new(r"<[^>]*>").unwrap();

    let blocks: Vec<&str> = content.split("\n\n").collect();

    for (b_idx, block) in blocks.iter().enumerate() {
        let lines: Vec<&str> = block.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        if lines.is_empty() {
            continue;
        }

        let mut time_line_idx = None;
        let mut start_sec = 0.0f64;
        let mut end_sec = 0.0f64;

        for (l_idx, line) in lines.iter().enumerate() {
            if let Some(caps) = time_re.captures(line) {
                if let (Some(s_str), Some(e_str)) = (caps.get(1), caps.get(2)) {
                    start_sec = parse_timecode_to_seconds(s_str.as_str()).unwrap_or(0.0);
                    end_sec = parse_timecode_to_seconds(e_str.as_str()).unwrap_or(0.0);
                    time_line_idx = Some(l_idx);
                    break;
                }
            }
        }

        if let Some(t_idx) = time_line_idx {
            let text_lines = &lines[(t_idx + 1)..];
            let raw_text = text_lines.join("\n");
            let clean_text = html_tag_re.replace_all(&raw_text, "").trim().to_string();

            subtitles.push(SubtitleLine {
                id: format!("srt_{}", b_idx),
                start: start_sec,
                end: end_sec,
                text: clean_text,
                role: "Default".to_string(),
            });
        }
    }

    ParsedSubtitlesNative {
        roles: vec!["Default".to_string()],
        subtitles,
    }
}

// ============================================================================
// 9. TAURI V2 COMMANDS
// ============================================================================

/// Основная команда Tauri для компиляции и полной валидации субтитров проекта
#[command]
pub async fn compile_and_validate_subtitles(
    state: State<'_, AppState>,
    project_id: String,
    format: SubtitleFormat,
    custom_subtitles: Option<Vec<SubtitleLine>>,
) -> Result<CompiledSubtitleReport, String> {
    // 1. Получение субтитров: либо переданных напрямую, либо из БД Sqlite
    let mut subtitles: Vec<SubtitleLine> = if let Some(subs) = custom_subtitles {
        subs
    } else {
        Vec::new()
    };

    if subtitles.is_empty() {
        let mutex = state.db.lock().await;
        if let Some(ref pool) = *mutex {
            // Попытка получить субтитры из таблицы `subtitles`
            let rows = sqlx::query(
                "SELECT id, start_time, end_time, text, role FROM subtitles WHERE project_id = ? ORDER BY start_time ASC"
            )
            .bind(&project_id)
            .fetch_all(pool)
            .await;

            if let Ok(records) = rows {
                for r in records {
                    let id: String = r.get("id");
                    let start: f64 = r.get("start_time");
                    let end: f64 = r.get("end_time");
                    let text: String = r.get("text");
                    let role: String = r.get("role");
                    subtitles.push(SubtitleLine { id, start, end, text, role });
                }
            }

            // Если таблица `subtitles` пуста, проверяем config_json в projects
            if subtitles.is_empty() {
                let proj_row = sqlx::query("SELECT config_json FROM projects WHERE id = ?")
                    .bind(&project_id)
                    .fetch_optional(pool)
                    .await
                    .ok()
                    .flatten();

                if let Some(row) = proj_row {
                    let config_str: String = row.get("config_json");
                    if let Ok(parsed_json) = serde_json::from_str::<serde_json::Value>(&config_str) {
                        if let Some(arr) = parsed_json.get("subtitles").and_then(|v| v.as_array()) {
                            for item in arr {
                                if let Ok(line) = serde_json::from_value::<SubtitleLine>(item.clone()) {
                                    subtitles.push(line);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Валидация через Subtitle Linter (норматив 20 CPS, 0.8s - 7.0s)
    let (warnings, errors, stats) = lint_subtitles(&subtitles, 20.0, 0.8, 7.0);

    // 3. Компиляция в целевой формат
    let config = AssStyleConfig::default();
    let compiled_content = compile_subtitles(&subtitles, format, &config, Some(&format!("Project {}", project_id)));
    let is_valid = errors.is_empty();

    Ok(CompiledSubtitleReport {
        project_id,
        format,
        compiled_content,
        total_lines: subtitles.len(),
        is_valid,
        warnings,
        errors,
        stats,
    })
}

/// Нативный парсинг субтитров ASS/SRT без использования JS
#[command]
pub async fn parse_subtitles_native(content: String) -> Result<ParsedSubtitlesNative, String> {
    if content.contains("[Script Info]") || content.contains("[Events]") {
        Ok(parse_ass_native(&content))
    } else if content.contains("-->") {
        Ok(parse_srt_native(&content))
    } else {
        Err("Неподдерживаемый формат субтитров. Используйте ASS или SRT.".to_string())
    }
}

// ============================================================================
// 10. UNIT TESTS (EDGES CASES, OVERLAPS, MIDNIGHT, SMART WRAP, TAG ESCAPING)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timecode_across_midnight() {
        // Тест таймкодов более 24 часов (через полночь): 24:00:03.25 = 86403.25 секунд
        let sec = 86403.25;
        let ass_tc = format_ass_time(sec);
        assert_eq!(ass_tc, "24:00:03.25");

        let srt_tc = format_srt_time(sec);
        assert_eq!(srt_tc, "24:00:03,250");

        let vtt_tc = format_vtt_time(sec);
        assert_eq!(vtt_tc, "24:00:03.250");

        let parsed = parse_timecode_to_seconds("24:00:03.25").unwrap();
        assert!((parsed - 86403.25).abs() < 0.001);
    }

    #[test]
    fn test_ass_escaping_commas_and_braces() {
        let subs = vec![
            SubtitleLine {
                id: "sub_1".to_string(),
                start: 1.0,
                end: 3.5,
                text: "Привет, дорогой друг! Как дела?".to_string(),
                role: "Иванов, Иван".to_string(), // Запятая в имени актера
            },
            SubtitleLine {
                id: "sub_2".to_string(),
                start: 4.0,
                end: 6.0,
                text: "Текст с фигурными скобками {спецэффект} и запятыми, много запятых.".to_string(),
                role: "Default".to_string(),
            },
        ];

        let config = AssStyleConfig {
            smart_wrap: false,
            ..Default::default()
        };
        let ass_output = compile_to_ass(&subs, &config, None);

        // Имя актера не должно содержать запятой в поле Name строки Dialogue:
        assert!(ass_output.contains("Иванов  Иван") || ass_output.contains("Иванов Иван"));
        // Текст во второй реплике должен сохранить скобки и запятые
        assert!(ass_output.contains("Текст с фигурными скобками {спецэффект}"));
    }

    #[test]
    fn test_smart_line_wrap_russian_preposition() {
        // Тест: предлог 'в' не должен оставаться висячим в конце первой строки
        let long_line = "Мы отправились в длительное путешествие по северным землям королевства.";
        let wrapped = smart_line_wrap(long_line, 35);
        let lines: Vec<&str> = wrapped.split('\n').collect();

        assert_eq!(lines.len(), 2);
        // Первая строка не должна заканчиваться на 'в'
        assert!(!lines[0].ends_with(" в"));
        // Проверяем, что текст не потерял слова
        assert_eq!(lines.join(" "), long_line);
    }

    #[test]
    fn test_smart_line_wrap_punctuation_priority() {
        let text_with_comma = "Осторожно, двери закрываются, следующая станция Охотный ряд.";
        let wrapped = smart_line_wrap(text_with_comma, 38);
        assert!(wrapped.contains('\n'));
        let lines: Vec<&str> = wrapped.split('\n').collect();
        assert_eq!(lines.len(), 2);
        // Разбиение должно произойти по запятой
        assert!(lines[0].ends_with(','));
    }

    #[test]
    fn test_pos_and_karaoke_tag_generation() {
        let subs = vec![
            SubtitleLine {
                id: "sign_1".to_string(),
                start: 10.0,
                end: 15.0,
                text: "[pos: 960, 180] ОСТОРОЖНО: ВЫСОКОЕ НАПРЯЖЕНИЕ".to_string(),
                role: "Sign".to_string(),
            },
            SubtitleLine {
                id: "karaoke_1".to_string(),
                start: 20.0,
                end: 25.0,
                text: "[k: 30]Ла-[k: 40]ла-[k: 50]ла".to_string(),
                role: "Karaoke".to_string(),
            },
        ];

        let config = AssStyleConfig::default();
        let ass = compile_to_ass(&subs, &config, None);

        // Проверяем тег {\pos(960,180)}
        assert!(ass.contains("{\\pos(960,180)}"));
        // Проверяем караоке теги {\k30}Ла-{\k40}ла-{\k50}ла
        assert!(ass.contains("{\\k30}Ла-{\\k40}ла-{\\k50}ла"));
        // Проверяем стиль Karaoke
        assert!(ass.contains("Style: Karaoke"));
    }

    #[test]
    fn test_subtitle_linter_cps_and_overlaps() {
        let subs = vec![
            // 1. Слишком короткая строка (< 0.8s) и высокий CPS (> 20)
            SubtitleLine {
                id: "1".to_string(),
                start: 1.0,
                end: 1.5, // 0.5s, 30 символов -> 60 CPS!
                text: "Очень длинный текст на полсекунды!".to_string(),
                role: "Default".to_string(),
            },
            // 2. Наезд таймкода на строку 1 (старт 1.3s, а строка 1 кончается в 1.5s)
            SubtitleLine {
                id: "2".to_string(),
                start: 1.3,
                end: 5.0,
                text: "Вторая реплика с наездом на первую.".to_string(),
                role: "Default".to_string(),
            },
            // 3. Слишком длинная строка (> 7.0s)
            SubtitleLine {
                id: "3".to_string(),
                start: 10.0,
                end: 18.0, // 8.0s
                text: "Очень долгая фраза.".to_string(),
                role: "Default".to_string(),
            },
        ];

        let (warnings, errors, stats) = lint_subtitles(&subs, 20.0, 0.8, 7.0);

        // Должны быть предупреждения: HighCps, TooShort, TimeOverlap, TooLong
        assert!(warnings.iter().any(|w| w.issue_type == LinterIssueType::HighCps));
        assert!(warnings.iter().any(|w| w.issue_type == LinterIssueType::TooShort));
        assert!(warnings.iter().any(|w| w.issue_type == LinterIssueType::TimeOverlap));
        assert!(warnings.iter().any(|w| w.issue_type == LinterIssueType::TooLong));
        assert_eq!(stats.overlap_count, 1);
        assert_eq!(errors.len(), 0); // Нет фатальных ошибок длительности <= 0
    }

    #[test]
    fn test_export_conversions() {
        let subs = vec![
            SubtitleLine {
                id: "1".to_string(),
                start: 0.0,
                end: 2.5,
                text: "{\\i1}Закадровый голос{\\i0} говорит: привет!".to_string(),
                role: "Voiceover".to_string(),
            },
        ];

        let srt = compile_to_srt(&subs, false, 40);
        assert!(srt.contains("00:00:00,000 --> 00:00:02,500"));
        assert!(srt.contains("<i>Закадровый голос</i> говорит: привет!"));

        let vtt = compile_to_vtt(&subs, false, 40);
        assert!(vtt.starts_with("WEBVTT"));
        assert!(vtt.contains("00:00:00.000 --> 00:00:02.500"));
        assert!(vtt.contains("<i>Закадровый голос</i> говорит: привет!"));
    }
}
