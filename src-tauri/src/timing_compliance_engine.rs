// ============================================================================
// DUB MIXING STUDIO PRO - TIMING COMPLIANCE & SPATIAL SWEEP-LINE ENGINE (RUST)
// Высокопроизводительный пространственный аудит коллизий, наездов, недотягов
// и рассинхрона таймлайна с субтитрами за O((N + M) log(N + M)) на базе Rayon.
// Стек: rayon = "1.10.0", serde = "1.0", tauri = "2.2"
// ============================================================================

use std::collections::HashMap;
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::logger::log_info;

/// Типы фиксируемых проблем тайминга
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimingIssueType {
    /// Наезд сегмента на соседний сегмент на той же дорожке (Clash)
    Overlap,
    /// Фраза дублера короче субтитра / оригинала больше допуска (Underrun)
    TooShort,
    /// Фраза дублера длиннее субтитра / оригинала больше допуска (Overrun)
    TooLong,
    /// Пропущенная строка субтитров (нет озвученного дубля на таймлайне)
    Missing,
    /// Опережение или запаздывание старта фразы относительно оригинала/саба
    LeadLagDelta,
    /// Избыточные сибилянты (свистящие)
    SibilantExcess,
    /// Взрывные согласные (Plosives/P-pops)
    PlosiveDetected,
    /// Щелчки или артефакты (Clicks)
    ClickFound,
}

/// Итоговая запись аудита соответствия таймингов
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingIssue {
    /// Уникальный идентификатор проблемы
    pub id: String,
    /// Категория проблемы
    pub issue_type: TimingIssueType,
    /// Идентификатор дорожки
    pub track_id: String,
    /// Имя дорожки
    pub track_name: Option<String>,
    /// Идентификатор сегмента (если применимо)
    pub segment_id: Option<String>,
    /// Таймкод начала в миллисекундах
    pub time_start_ms: u64,
    /// Таймкод окончания в миллисекундах
    pub time_end_ms: u64,
    /// Дельта расхождения в миллисекундах (отрицательная - недотяг/опережение, положительная - перетяг/опоздание)
    pub delta_ms: i64,
    /// Человекочитаемое описание проблемы
    pub message: String,
    /// Уровень важности: "error" | "warning" | "info"
    pub severity: String,
    /// Доступно ли автоматическое исправление в 1 клик
    pub can_auto_fix: bool,
    /// Текст связанного субтитра
    pub matched_sub_text: Option<String>,
    /// Целевая длительность в миллисекундах (по субтитрам или оригиналу)
    pub target_duration_ms: Option<u64>,
    /// Фактическая длительность в миллисекундах
    pub actual_duration_ms: Option<u64>,
}

/// Входные данные сегмента дорожки для аудита
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentAuditInput {
    pub id: String,
    pub start_time_ms: u64,
    pub duration_ms: u64,
    pub text: Option<String>,
    pub matched_sub_id: Option<String>,
    pub file_offset_ms: Option<u64>,
    pub file_duration_ms: Option<u64>,
    pub is_sibilant: Option<bool>,
    pub is_plosive: Option<bool>,
    pub is_click: Option<bool>,
}

/// Входные данные дорожки проекта для аудита
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackAuditInput {
    pub id: String,
    pub name: String,
    pub role: Option<String>,
    pub segments: Vec<SegmentAuditInput>,
}

/// Входная строка субтитров сценария
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleAuditInput {
    pub id: String,
    pub start_time_ms: u64,
    pub end_time_ms: u64,
    pub role: Option<String>,
    pub text: String,
}

/// Интервальная структура речи для Sweep-Line сканирования
#[derive(Debug, Clone, Copy)]
struct SpeechSpan {
    start_ms: u64,
    end_ms: u64,
}

/// Тип события для Sweep-Line сканирования
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventType {
    SpeechStart,
    SpeechEnd,
}

#[derive(Debug, Clone, Copy)]
struct SweepEvent {
    time_ms: u64,
    event_type: EventType,
}

/// Алгоритмический Sweep-Line процессор пространственного тайминга
pub struct TimingSweepLineProcessor;

impl TimingSweepLineProcessor {
    /// Проверка дорожки на внутренние коллизии/наезды за O(K log K)
    pub fn check_track_internal_overlaps(
        track: &TrackAuditInput,
        overlap_tolerance_ms: u64,
    ) -> Vec<TimingIssue> {
        let mut issues = Vec::new();
        if track.segments.len() < 2 {
            return issues;
        }

        // 1. Быстрая сортировка сегментов по таймкоду начала
        let mut sorted_segs: Vec<&SegmentAuditInput> = track.segments.iter().collect();
        sorted_segs.sort_by(|a, b| a.start_time_ms.cmp(&b.start_time_ms));

        // 2. Однопроходный скан Sweep-Line по соседним интервалам
        for i in 1..sorted_segs.len() {
            let prev = sorted_segs[i - 1];
            let curr = sorted_segs[i];
            let prev_end = prev.start_time_ms.saturating_add(prev.duration_ms);

            if curr.start_time_ms + overlap_tolerance_ms < prev_end {
                let overlap_dur = prev_end.saturating_sub(curr.start_time_ms);
                let start_sec = curr.start_time_ms as f64 / 1000.0;
                let overlap_sec = overlap_dur as f64 / 1000.0;

                issues.push(TimingIssue {
                    id: format!("val_overlap_{}", curr.id),
                    issue_type: TimingIssueType::Overlap,
                    track_id: track.id.clone(),
                    track_name: Some(track.name.clone()),
                    segment_id: Some(curr.id.clone()),
                    time_start_ms: curr.start_time_ms,
                    time_end_ms: prev_end,
                    delta_ms: overlap_dur as i64,
                    message: format!(
                        "Реплика на дорожке \"{}\" наезжает на предыдущую на {:.2} с (таймкод: {:02}:{:04.1})",
                        track.name,
                        overlap_sec,
                        (start_sec / 60.0).floor() as u32,
                        start_sec % 60.0
                    ),
                    severity: "error".to_string(),
                    can_auto_fix: true,
                    matched_sub_text: curr.text.clone(),
                    target_duration_ms: None,
                    actual_duration_ms: Some(curr.duration_ms),
                });
            }
        }

        issues
    }

    /// Слияние всех речевых интервалов всех дорожек через Sweep-Line за O(N log N)
    pub fn merge_all_dub_spans(tracks: &[TrackAuditInput]) -> Vec<SpeechSpan> {
        let mut events: Vec<SweepEvent> = Vec::new();

        for track in tracks {
            for seg in &track.segments {
                let start = seg.start_time_ms;
                let end = start.saturating_add(seg.duration_ms);
                if end > start {
                    events.push(SweepEvent {
                        time_ms: start,
                        event_type: EventType::SpeechStart,
                    });
                    events.push(SweepEvent {
                        time_ms: end,
                        event_type: EventType::SpeechEnd,
                    });
                }
            }
        }

        if events.is_empty() {
            return Vec::new();
        }

        // Сортировка событий Sweep-Line: если время совпадает, Start идет перед End
        events.sort_by(|a, b| {
            if a.time_ms == b.time_ms {
                match (a.event_type, b.event_type) {
                    (EventType::SpeechStart, EventType::SpeechEnd) => std::cmp::Ordering::Less,
                    (EventType::SpeechEnd, EventType::SpeechStart) => std::cmp::Ordering::Greater,
                    _ => std::cmp::Ordering::Equal,
                }
            } else {
                a.time_ms.cmp(&b.time_ms)
            }
        });

        let mut merged_spans = Vec::new();
        let mut active_count = 0usize;
        let mut current_start = 0u64;

        for ev in events {
            match ev.event_type {
                EventType::SpeechStart => {
                    if active_count == 0 {
                        current_start = ev.time_ms;
                    }
                    active_count += 1;
                }
                EventType::SpeechEnd => {
                    active_count = active_count.saturating_sub(1);
                    if active_count == 0 {
                        merged_spans.push(SpeechSpan {
                            start_ms: current_start,
                            end_ms: ev.time_ms,
                        });
                    }
                }
            }
        }

        merged_spans
    }

    /// Проверка пропущенных субтитров сценария через двоичный поиск по объединенным спанам речи
    pub fn check_missing_subtitles(
        subtitles: &[SubtitleAuditInput],
        merged_spans: &[SpeechSpan],
        default_track_id: &str,
        max_proximity_ms: u64,
    ) -> Vec<TimingIssue> {
        if subtitles.is_empty() {
            return Vec::new();
        }

        if merged_spans.is_empty() {
            return subtitles
                .iter()
                .map(|sub| {
                    let start_sec = sub.start_time_ms as f64 / 1000.0;
                    let dur_ms = sub.end_time_ms.saturating_sub(sub.start_time_ms);
                    TimingIssue {
                        id: format!("val_miss_{}", sub.id),
                        issue_type: TimingIssueType::Missing,
                        track_id: default_track_id.to_string(),
                        track_name: sub.role.clone().or_else(|| Some("Общая".to_string())),
                        segment_id: None,
                        time_start_ms: sub.start_time_ms,
                        time_end_ms: sub.end_time_ms,
                        delta_ms: -(dur_ms as i64),
                        message: format!(
                            "Субтитр не имеет озвученного дубля на таймкоде {:02}:{:04.1}: \"{}\"",
                            (start_sec / 60.0).floor() as u32,
                            start_sec % 60.0,
                            if sub.text.chars().count() > 45 {
                                format!("{}...", sub.text.chars().take(45).collect::<String>())
                            } else {
                                sub.text.clone()
                            }
                        ),
                        severity: "info".to_string(),
                        can_auto_fix: false,
                        matched_sub_text: Some(sub.text.clone()),
                        target_duration_ms: Some(dur_ms),
                        actual_duration_ms: Some(0),
                    }
                })
                .collect();
        }

        // Параллельная проверка субтитров через двоичный поиск по отсортированным спанам O(M log K)
        subtitles
            .par_iter()
            .filter_map(|sub| {
                let sub_start = sub.start_time_ms;
                let sub_end = sub.end_time_ms;
                let dur_ms = sub_end.saturating_sub(sub_start);

                let search_min = sub_start.saturating_sub(max_proximity_ms);
                let search_max = sub_end.saturating_add(max_proximity_ms);

                // Двоичный поиск первого спана, который заканчивается >= search_min
                let idx = merged_spans.partition_point(|span| span.end_ms < search_min);

                let mut has_speech = false;
                for span in &merged_spans[idx..] {
                    if span.start_ms > search_max {
                        break;
                    }
                    // Проверяем пересечение с допустимым окном
                    if span.end_ms >= search_min && span.start_ms <= search_max {
                        has_speech = true;
                        break;
                    }
                }

                if !has_speech {
                    let start_sec = sub_start as f64 / 1000.0;
                    Some(TimingIssue {
                        id: format!("val_miss_{}", sub.id),
                        issue_type: TimingIssueType::Missing,
                        track_id: default_track_id.to_string(),
                        track_name: sub.role.clone().or_else(|| Some("Общая".to_string())),
                        segment_id: None,
                        time_start_ms: sub_start,
                        time_end_ms: sub_end,
                        delta_ms: -(dur_ms as i64),
                        message: format!(
                            "Субтитр не имеет озвученного дубля на таймкоде {:02}:{:04.1}: \"{}\"",
                            (start_sec / 60.0).floor() as u32,
                            start_sec % 60.0,
                            if sub.text.chars().count() > 45 {
                                format!("{}...", sub.text.chars().take(45).collect::<String>())
                            } else {
                                sub.text.clone()
                            }
                        ),
                        severity: "info".to_string(),
                        can_auto_fix: false,
                        matched_sub_text: Some(sub.text.clone()),
                        target_duration_ms: Some(dur_ms),
                        actual_duration_ms: Some(0),
                    })
                } else {
                    None
                }
            })
            .collect()
    }

    /// Быстрый аудит синхронизации длительностей и старта фраз относительно субтитров
    pub fn audit_subtitle_synchronization(
        track: &TrackAuditInput,
        subtitles_sorted: &[SubtitleAuditInput],
        subtitles_by_id: &HashMap<String, &SubtitleAuditInput>,
        tolerance_ms: u64,
    ) -> Vec<TimingIssue> {
        let mut issues = Vec::new();
        if track.segments.is_empty() || subtitles_sorted.is_empty() {
            return issues;
        }

        for seg in &track.segments {
            let seg_start = seg.start_time_ms;
            let seg_dur = seg.duration_ms;
            let seg_end = seg_start.saturating_add(seg_dur);

            // 1. Поиск связанного субтитра: сначала по ID, затем по пространственному совпадению
            let matched_sub: Option<&SubtitleAuditInput> = if let Some(sub_id) = &seg.matched_sub_id {
                subtitles_by_id.get(sub_id).copied()
            } else {
                // Поиск пересечения через двоичный поиск по началу субтитра
                let p_idx = subtitles_sorted.partition_point(|s| s.end_time_ms + 750 < seg_start);
                let mut best_match: Option<&SubtitleAuditInput> = None;
                let mut min_diff = u64::MAX;

                for sub in &subtitles_sorted[p_idx..] {
                    if sub.start_time_ms > seg_end + 15000 {
                        break;
                    }

                    // Пересечение временных рамок с допуском 750 мс
                    let overlaps = seg_start <= sub.end_time_ms + 750 && seg_end + 750 >= sub.start_time_ms;

                    if overlaps {
                        // Если роль совпадает с именем дорожки — идеальное совпадение
                        if let (Some(role), Some(t_role)) = (&sub.role, &track.role) {
                            if role.eq_ignore_ascii_case(t_role) {
                                best_match = Some(sub);
                                break;
                            }
                        }
                        if best_match.is_none() {
                            best_match = Some(sub);
                        }
                    } else {
                        let diff = if seg_start > sub.start_time_ms {
                            seg_start - sub.start_time_ms
                        } else {
                            sub.start_time_ms - seg_start
                        };
                        if diff < min_diff && diff <= 15000 {
                            min_diff = diff;
                            if best_match.is_none() {
                                best_match = Some(sub);
                            }
                        }
                    }
                }

                best_match
            };

            if let Some(sub) = matched_sub {
                let sub_dur = sub.end_time_ms.saturating_sub(sub.start_time_ms);

                // 2. Проверка недотяга (Underrun / TooShort): фраза заметно короче субтитра
                if sub_dur > seg_dur + tolerance_ms {
                    let diff_ms = sub_dur.saturating_sub(seg_dur);
                    let diff_sec = diff_ms as f64 / 1000.0;
                    let seg_sec = seg_dur as f64 / 1000.0;
                    let sub_sec = sub_dur as f64 / 1000.0;

                    issues.push(TimingIssue {
                        id: format!("val_short_{}", seg.id),
                        issue_type: TimingIssueType::TooShort,
                        track_id: track.id.clone(),
                        track_name: Some(track.name.clone()),
                        segment_id: Some(seg.id.clone()),
                        time_start_ms: seg_start,
                        time_end_ms: seg_end,
                        delta_ms: -(diff_ms as i64),
                        message: format!(
                            "Фраза на \"{}\" короче субтитра: {:.2} с против {:.2} с (недотяг {:.2} с)",
                            track.name, seg_sec, sub_sec, diff_sec
                        ),
                        severity: "warning".to_string(),
                        can_auto_fix: true,
                        matched_sub_text: Some(sub.text.clone()),
                        target_duration_ms: Some(sub_dur),
                        actual_duration_ms: Some(seg_dur),
                    });
                }
                // 3. Проверка перетяга (Overrun / TooLong)
                else if seg_dur > sub_dur + tolerance_ms + 400 {
                    let diff_ms = seg_dur.saturating_sub(sub_dur);
                    let diff_sec = diff_ms as f64 / 1000.0;
                    let seg_sec = seg_dur as f64 / 1000.0;
                    let sub_sec = sub_dur as f64 / 1000.0;

                    issues.push(TimingIssue {
                        id: format!("val_long_{}", seg.id),
                        issue_type: TimingIssueType::TooLong,
                        track_id: track.id.clone(),
                        track_name: Some(track.name.clone()),
                        segment_id: Some(seg.id.clone()),
                        time_start_ms: seg_start,
                        time_end_ms: seg_end,
                        delta_ms: diff_ms as i64,
                        message: format!(
                            "Фраза на \"{}\" длиннее субтитра: {:.2} с против {:.2} с (перетяг {:.2} с)",
                            track.name, seg_sec, sub_sec, diff_sec
                        ),
                        severity: "warning".to_string(),
                        can_auto_fix: true,
                        matched_sub_text: Some(sub.text.clone()),
                        target_duration_ms: Some(sub_dur),
                        actual_duration_ms: Some(seg_dur),
                    });
                }

                // 4. Расчет опережения/запаздывания старта фразы (Lead/Lag Delta)
                let start_delta = (seg_start as i64) - (sub.start_time_ms as i64);
                if start_delta.abs() > (tolerance_ms as i64 + 150) {
                    let delta_sec = (start_delta.abs() as f64) / 1000.0;
                    let status_str = if start_delta > 0 { "опаздывает" } else { "опережает" };

                    issues.push(TimingIssue {
                        id: format!("val_drift_{}", seg.id),
                        issue_type: TimingIssueType::LeadLagDelta,
                        track_id: track.id.clone(),
                        track_name: Some(track.name.clone()),
                        segment_id: Some(seg.id.clone()),
                        time_start_ms: seg_start,
                        time_end_ms: seg_end,
                        delta_ms: start_delta,
                        message: format!(
                            "Старт реплики на \"{}\" {} на {:.2} с относительно таймкода сценария",
                            track.name, status_str, delta_sec
                        ),
                        severity: "info".to_string(),
                        can_auto_fix: true,
                        matched_sub_text: Some(sub.text.clone()),
                        target_duration_ms: Some(sub_dur),
                        actual_duration_ms: Some(seg_dur),
                    });
                }
            }

            // 5. Проверка на акустические аномалии (из нашего анализатора)
            if seg.is_sibilant.unwrap_or(false) {
                issues.push(TimingIssue {
                    id: format!("val_sib_{}", seg.id),
                    issue_type: TimingIssueType::SibilantExcess,
                    track_id: track.id.clone(),
                    track_name: Some(track.name.clone()),
                    segment_id: Some(seg.id.clone()),
                    time_start_ms: seg_start,
                    time_end_ms: seg_end,
                    delta_ms: 0,
                    message: format!("На дорожке \"{}\" обнаружены избыточные сибилянты (свистящие)", track.name),
                    severity: "info".to_string(),
                    can_auto_fix: true,
                    matched_sub_text: seg.text.clone(),
                    target_duration_ms: None,
                    actual_duration_ms: Some(seg_dur),
                });
            }

            if seg.is_plosive.unwrap_or(false) {
                issues.push(TimingIssue {
                    id: format!("val_plo_{}", seg.id),
                    issue_type: TimingIssueType::PlosiveDetected,
                    track_id: track.id.clone(),
                    track_name: Some(track.name.clone()),
                    segment_id: Some(seg.id.clone()),
                    time_start_ms: seg_start,
                    time_end_ms: seg_end,
                    delta_ms: 0,
                    message: format!("На дорожке \"{}\" обнаружены взрывные согласные (P-pops)", track.name),
                    severity: "info".to_string(),
                    can_auto_fix: true,
                    matched_sub_text: seg.text.clone(),
                    target_duration_ms: None,
                    actual_duration_ms: Some(seg_dur),
                });
            }

            if seg.is_click.unwrap_or(false) {
                issues.push(TimingIssue {
                    id: format!("val_clk_{}", seg.id),
                    issue_type: TimingIssueType::ClickFound,
                    track_id: track.id.clone(),
                    track_name: Some(track.name.clone()),
                    segment_id: Some(seg.id.clone()),
                    time_start_ms: seg_start,
                    time_end_ms: seg_end,
                    delta_ms: 0,
                    message: format!("На дорожке \"{}\" обнаружены щелчки или артефакты", track.name),
                    severity: "info".to_string(),
                    can_auto_fix: true,
                    matched_sub_text: seg.text.clone(),
                    target_duration_ms: None,
                    actual_duration_ms: Some(seg_dur),
                });
            }
        }

        issues
    }
}

// ============================================================================
// TAURI V2 COMMAND
// ============================================================================

/// Нативная команда сверхбыстрого пространственного аудита таймингов
#[tauri::command]
pub async fn audit_project_timing(
    tracks: Vec<TrackAuditInput>,
    subtitles: Vec<SubtitleAuditInput>,
    tolerance_ms: Option<u64>,
) -> Result<Vec<TimingIssue>, String> {
    let start_time = Instant::now();
    let tol_ms = tolerance_ms.unwrap_or(200);

    // 1. Фильтрация треков дубляжа (исключаем служебные/оригинальные треки)
    let dub_tracks: Vec<TrackAuditInput> = tracks
        .into_iter()
        .filter(|t| {
            let n = t.name.to_lowercase();
            !n.contains("оригинал") && !n.contains("музыка") && !n.contains("фонограмма")
        })
        .collect();

    // 2. Сортировка субтитров по времени старта
    let mut subtitles_sorted = subtitles.clone();
    subtitles_sorted.sort_by_key(|s| s.start_time_ms);

    let mut subtitles_by_id: HashMap<String, &SubtitleAuditInput> = HashMap::with_capacity(subtitles_sorted.len());
    for sub in &subtitles_sorted {
        subtitles_by_id.insert(sub.id.clone(), sub);
    }

    // 3. Параллельная проверка внутренних коллизий (Clashes / Overlaps) на каждой дорожке через Rayon
    let overlap_issues: Vec<TimingIssue> = dub_tracks
        .par_iter()
        .flat_map(|track| TimingSweepLineProcessor::check_track_internal_overlaps(track, 30))
        .collect();

    // 4. Параллельный аудит соответствия субтитрам (Underruns / Overruns / Drift) через Rayon
    let sync_issues: Vec<TimingIssue> = dub_tracks
        .par_iter()
        .flat_map(|track| {
            TimingSweepLineProcessor::audit_subtitle_synchronization(
                track,
                &subtitles_sorted,
                &subtitles_by_id,
                tol_ms,
            )
        })
        .collect();

    // 5. Поиск пропущенных строк субтитров сценария через Sweep-Line слияние речевых зон
    let merged_speech_spans = TimingSweepLineProcessor::merge_all_dub_spans(&dub_tracks);
    let default_track_id = dub_tracks.first().map(|t| t.id.as_str()).unwrap_or("general_track");
    let missing_sub_issues = TimingSweepLineProcessor::check_missing_subtitles(
        &subtitles_sorted,
        &merged_speech_spans,
        default_track_id,
        2000,
    );

    // 6. Объединение всех найденных проблем
    let total_issues_count = overlap_issues.len() + sync_issues.len() + missing_sub_issues.len();
    let mut all_issues = Vec::with_capacity(total_issues_count);
    all_issues.extend(overlap_issues);
    all_issues.extend(sync_issues);
    all_issues.extend(missing_sub_issues);

    // Сортировка итогового списка по таймкоду начала
    all_issues.sort_by_key(|i| i.time_start_ms);

    log_info(&format!(
        "[TimingComplianceEngine] Sweep-Line аудит завершен за {:.3}ms. Обнаружено {} проблем (Дорожек: {}, Субтитров: {})",
        start_time.elapsed().as_secs_f64() * 1000.0,
        all_issues.len(),
        dub_tracks.len(),
        subtitles_sorted.len()
    ));

    Ok(all_issues)
}
