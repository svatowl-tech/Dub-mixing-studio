// Модуль правил типов проектов (projectTypeRules) и валидации тайминга.
// Стек: serde = "1.0", tauri = "2.2"

use serde::{Deserialize, Serialize};
use tauri::command;

/// Тип проекта дубляжа / озвучивания
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectType {
    /// Закадр: Голос актера начинается с опережением на 150-250 мс (lead-in) и завершается на 200-300 мс раньше оригинала
    VoiceOver,
    /// Редаб / Рекаст: Длина фразы обязана строго покрывать субтитр сценария (допуск +-100 мс), недопустимы провисания
    Recast,
    /// Полный дубляж: Старт строго совпадает с артикуляцией рта (точность до 30 мс), финал совпадает со смыканием губ
    Dubbing,
}

/// Входной сегмент реплики (дабера или оригинала/субтитра)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueSegment {
    pub id: String,
    pub start_ms: f64,
    pub end_ms: f64,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub track_id: Option<String>,
    #[serde(default)]
    pub subtitle_start_ms: Option<f64>,
    #[serde(default)]
    pub subtitle_end_ms: Option<f64>,
    #[serde(default)]
    pub matched_original_id: Option<String>,
}

/// Тип предупреждения/проблемы тайминга
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WarningLevel {
    Info,
    Warning,
    Critical,
}

/// Инструкция по автоматической корректировке тайминга реплики
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentInstruction {
    pub segment_id: String,
    pub current_start_ms: f64,
    pub current_end_ms: f64,
    pub current_duration_ms: f64,

    pub recommended_start_ms: f64,
    pub recommended_end_ms: f64,
    pub recommended_duration_ms: f64,

    pub offset_shift_ms: f64,      // Величина рекомендуемого сдвига по времени (плюс = вправо, минус = влево)
    pub stretch_ratio: f64,        // Рекомендуемый коэффициент WSOLA-растяжения (1.0 = без стретча)

    pub is_valid: bool,            // Соответствует ли фраза правилам типа проекта
    pub warning_level: WarningLevel,
    pub rule_applied: String,      // Какое правило сработало
    pub message: String,           // Текстовое описание проблемы и рекомендации для интерфейса
}

/// Поиск ближайшего оригинального сегмента к даб-сегменту
fn find_matching_original_cue<'a>(
    cue: &CueSegment,
    originals: &'a [CueSegment],
) -> Option<&'a CueSegment> {
    if let Some(ref orig_id) = cue.matched_original_id {
        if let Some(found) = originals.iter().find(|o| &o.id == orig_id) {
            return Some(found);
        }
    }

    // Ищем по максимальному перекрытию во времени или минимальному расстоянию
    let mut best_match: Option<&'a CueSegment> = None;
    let mut min_distance = f64::MAX;

    for orig in originals {
        // Проверяем перекрытие
        let overlap_start = cue.start_ms.max(orig.start_ms);
        let overlap_end = cue.end_ms.min(orig.end_ms);
        let overlap = (overlap_end - overlap_start).max(0.0);

        if overlap > 0.0 {
            return Some(orig);
        }

        // Если перекрытия нет, вычисляем расстояние между центрами
        let cue_center = (cue.start_ms + cue.end_ms) / 2.0;
        let orig_center = (orig.start_ms + orig.end_ms) / 2.0;
        let dist = (cue_center - orig_center).abs();

        if dist < min_distance && dist < 3000.0 {
            // Ограничение поиска в радиусе 3 секунд
            min_distance = dist;
            best_match = Some(orig);
        }
    }

    best_match
}

/// Главная функция валидации и расчета авто-коррекции тайминга в зависимости от типа проекта
pub fn apply_project_rules(
    segments: Vec<CueSegment>,
    project_type: ProjectType,
    original_cues: Vec<CueSegment>,
) -> Vec<AdjustmentInstruction> {
    let mut instructions = Vec::with_capacity(segments.len());

    for seg in segments {
        let cur_dur = (seg.end_ms - seg.start_ms).max(10.0);
        let matched_orig = find_matching_original_cue(&seg, &original_cues);

        // Используем таймкоды субтитра, если они привязаны, либо оригинальный вокальный кью
        let ref_start_ms = seg.subtitle_start_ms.or_else(|| matched_orig.map(|o| o.start_ms));
        let ref_end_ms = seg.subtitle_end_ms.or_else(|| matched_orig.map(|o| o.end_ms));

        match project_type {
            // -------------------------------------------------------------------------------------
            // 1. ЗАКАДР (VoiceOver)
            // Правило: Голос дабера вступает на 150–250 мс ПОЗЖЕ старта оригинального спикера (lead-in)
            // и завершается на 200–300 мс РАНЬШЕ финала оригинальной реплики, чтобы зритель слышал оригинальные эмоции.
            // -------------------------------------------------------------------------------------
            ProjectType::VoiceOver => {
                let target_lead_in = 200.0; // мс после старта оригинала (150-250 мс)
                let target_tail_clearance = 250.0; // мс до конца оригинала (200-300 мс)

                if let (Some(orig_s), Some(orig_e)) = (ref_start_ms, ref_end_ms) {
                    let ideal_start = orig_s + target_lead_in;
                    let ideal_end = (orig_e - target_tail_clearance).max(ideal_start + 100.0);
                    let target_dur = (ideal_end - ideal_start).max(100.0);

                    let start_diff = seg.start_ms - ideal_start; // Насколько раньше/позже стартует
                    let end_diff = seg.end_ms - (orig_e - target_tail_clearance);

                    let mut is_valid = true;
                    let mut warning_level = WarningLevel::Info;
                    let mut message = "Тайминг закадра идеален: сохранен отступ старта и хвоста оригинала.".to_string();

                    // Проверяем нарушение правил закадра:
                    // Если дабер залез на старт раньше оригинала (start < orig_s + 100ms)
                    if seg.start_ms < orig_s + 100.0 {
                        is_valid = false;
                        warning_level = WarningLevel::Warning;
                        message = format!(
                            "Голос дабера заглушает старт оригинала (раньше на {:.0} мс). Рекомендуется сдвинуть вправо на +{:.0} мс.",
                            (orig_s + target_lead_in) - seg.start_ms,
                            -start_diff
                        );
                    } else if seg.end_ms > orig_e - 50.0 {
                        // Дабер звучит дольше оригинала или перекрывает его конец
                        is_valid = false;
                        warning_level = WarningLevel::Warning;
                        message = format!(
                            "Голос дабера перекрывает хвост оригинала (на {:.0} мс). Рекомендуется ускорить или подрезать.",
                            seg.end_ms - (orig_e - target_tail_clearance)
                        );
                    }

                    let offset_shift = ideal_start - seg.start_ms;
                    let raw_stretch = cur_dur / target_dur;
                    // Для закадра стретч мягкий: 0.90 .. 1.15
                    let stretch_ratio = if (raw_stretch - 1.0).abs() > 0.15 {
                        (raw_stretch.max(0.90).min(1.15) * 1000.0).round() / 1000.0
                    } else {
                        1.0
                    };

                    let rec_dur = cur_dur / stretch_ratio;
                    let rec_start = seg.start_ms + offset_shift;
                    let rec_end = rec_start + rec_dur;

                    instructions.push(AdjustmentInstruction {
                        segment_id: seg.id.clone(),
                        current_start_ms: seg.start_ms,
                        current_end_ms: seg.end_ms,
                        current_duration_ms: cur_dur,
                        recommended_start_ms: rec_start,
                        recommended_end_ms: rec_end,
                        recommended_duration_ms: rec_dur,
                        offset_shift_ms: (offset_shift * 10.0).round() / 10.0,
                        stretch_ratio,
                        is_valid,
                        warning_level,
                        rule_applied: "VoiceOver Lead-in/Tail Clearance".to_string(),
                        message,
                    });
                } else {
                    // Нет референса - оставляем без изменений
                    instructions.push(AdjustmentInstruction {
                        segment_id: seg.id.clone(),
                        current_start_ms: seg.start_ms,
                        current_end_ms: seg.end_ms,
                        current_duration_ms: cur_dur,
                        recommended_start_ms: seg.start_ms,
                        recommended_end_ms: seg.end_ms,
                        recommended_duration_ms: cur_dur,
                        offset_shift_ms: 0.0,
                        stretch_ratio: 1.0,
                        is_valid: true,
                        warning_level: WarningLevel::Info,
                        rule_applied: "VoiceOver Standalone".to_string(),
                        message: "Референсный оригинальный сигнал или субтитр не найден.".to_string(),
                    });
                }
            }

            // -------------------------------------------------------------------------------------
            // 2. РЕДАБ / РЕКАСТ (Recast)
            // Правило: Длина фразы обязана строго покрывать субтитр сценария (допуск +-100 мс).
            // Недопустимы провисания текста (когда актер замолчал задолго до конца саба).
            // -------------------------------------------------------------------------------------
            ProjectType::Recast => {
                if let (Some(sub_s), Some(sub_e)) = (ref_start_ms, ref_end_ms) {
                    let sub_dur = (sub_e - sub_s).max(100.0);
                    let tolerance_ms = 100.0;

                    let start_diff = seg.start_ms - sub_s;
                    let end_diff = seg.end_ms - sub_e;
                    let dur_diff = cur_dur - sub_dur;

                    let mut is_valid = true;
                    let mut warning_level = WarningLevel::Info;
                    let mut message = "Фраза полностью и точно покрывает таймлайн субтитра сценария.".to_string();

                    if cur_dur < sub_dur - tolerance_ms {
                        // Фраза слишком короткая (провисание текста)
                        is_valid = false;
                        warning_level = WarningLevel::Critical;
                        message = format!(
                            "Провисание текста Рекаста! Фраза короче субтитра на {:.0} мс. Необходим Time-Stretch 1.15x или переозвучка.",
                            -dur_diff
                        );
                    } else if cur_dur > sub_dur + tolerance_ms {
                        // Фраза длиннее субтитра
                        is_valid = false;
                        warning_level = WarningLevel::Warning;
                        message = format!(
                            "Фраза длиннее субтитра на {:.0} мс. Рекомендуется поджать через WSOLA.",
                            dur_diff
                        );
                    } else if start_diff.abs() > tolerance_ms {
                        is_valid = false;
                        warning_level = WarningLevel::Warning;
                        message = format!(
                            "Сдвиг старта относительно саба на {:.0} мс. Рекомендуется выровнять на таймкод субтитра.",
                            start_diff
                        );
                    }

                    let offset_shift = sub_s - seg.start_ms;
                    let raw_stretch = cur_dur / sub_dur;
                    let stretch_ratio = if dur_diff.abs() > tolerance_ms {
                        (raw_stretch.max(0.85).min(1.20) * 1000.0).round() / 1000.0
                    } else {
                        1.0
                    };

                    let rec_dur = cur_dur / stretch_ratio;
                    let rec_start = sub_s;
                    let rec_end = rec_start + rec_dur;

                    instructions.push(AdjustmentInstruction {
                        segment_id: seg.id.clone(),
                        current_start_ms: seg.start_ms,
                        current_end_ms: seg.end_ms,
                        current_duration_ms: cur_dur,
                        recommended_start_ms: rec_start,
                        recommended_end_ms: rec_end,
                        recommended_duration_ms: rec_dur,
                        offset_shift_ms: (offset_shift * 10.0).round() / 10.0,
                        stretch_ratio,
                        is_valid,
                        warning_level,
                        rule_applied: "Recast Subtitle Strict Coverage (+-100ms)".to_string(),
                        message,
                    });
                } else {
                    instructions.push(AdjustmentInstruction {
                        segment_id: seg.id.clone(),
                        current_start_ms: seg.start_ms,
                        current_end_ms: seg.end_ms,
                        current_duration_ms: cur_dur,
                        recommended_start_ms: seg.start_ms,
                        recommended_end_ms: seg.end_ms,
                        recommended_duration_ms: cur_dur,
                        offset_shift_ms: 0.0,
                        stretch_ratio: 1.0,
                        is_valid: false,
                        warning_level: WarningLevel::Warning,
                        rule_applied: "Recast Subtitle Check".to_string(),
                        message: "Для проверки рекаста отсутствует привязка к субтитру сценария!".to_string(),
                    });
                }
            }

            // -------------------------------------------------------------------------------------
            // 3. ПОЛНЫЙ ДУБЛЯЖ (Dubbing / Lip-Sync)
            // Правило: Старт строго совпадает с раскрытием рта персонажа (по VAD оригинала, точность до 30 мс),
            // финал строго совпадает со смыканием губ (полный липсинг).
            // -------------------------------------------------------------------------------------
            ProjectType::Dubbing => {
                if let (Some(orig_s), Some(orig_e)) = (ref_start_ms, ref_end_ms) {
                    let orig_dur = (orig_e - orig_s).max(50.0);
                    let lipsync_tolerance_ms = 30.0; // Высокая точность 30 мс

                    let start_diff = seg.start_ms - orig_s;
                    let end_diff = seg.end_ms - orig_e;

                    let mut is_valid = true;
                    let mut warning_level = WarningLevel::Info;
                    let mut message = "Идеальный липсинг: артикуляция совпадает с оригинальным видеорядом.".to_string();

                    if start_diff.abs() > lipsync_tolerance_ms || end_diff.abs() > lipsync_tolerance_ms {
                        is_valid = false;
                        warning_level = if start_diff.abs() > 80.0 || end_diff.abs() > 80.0 {
                            WarningLevel::Critical
                        } else {
                            WarningLevel::Warning
                        };

                        message = format!(
                            "Рассинхрон липсинга (старт: {:+.0} мс, финал: {:+.0} мс). Примените WSOLA выравнивание по точкам рта.",
                            start_diff, end_diff
                        );
                    }

                    let offset_shift = orig_s - seg.start_ms;
                    let raw_stretch = cur_dur / orig_dur;
                    let stretch_ratio = (raw_stretch.max(0.85).min(1.20) * 1000.0).round() / 1000.0;

                    let rec_dur = cur_dur / stretch_ratio;
                    let rec_start = orig_s;
                    let rec_end = rec_start + rec_dur;

                    instructions.push(AdjustmentInstruction {
                        segment_id: seg.id.clone(),
                        current_start_ms: seg.start_ms,
                        current_end_ms: seg.end_ms,
                        current_duration_ms: cur_dur,
                        recommended_start_ms: rec_start,
                        recommended_end_ms: rec_end,
                        recommended_duration_ms: rec_dur,
                        offset_shift_ms: (offset_shift * 10.0).round() / 10.0,
                        stretch_ratio,
                        is_valid,
                        warning_level,
                        rule_applied: "Dubbing Lip-Sync Match (<=30ms)".to_string(),
                        message,
                    });
                } else {
                    instructions.push(AdjustmentInstruction {
                        segment_id: seg.id.clone(),
                        current_start_ms: seg.start_ms,
                        current_end_ms: seg.end_ms,
                        current_duration_ms: cur_dur,
                        recommended_start_ms: seg.start_ms,
                        recommended_end_ms: seg.end_ms,
                        recommended_duration_ms: cur_dur,
                        offset_shift_ms: 0.0,
                        stretch_ratio: 1.0,
                        is_valid: false,
                        warning_level: WarningLevel::Critical,
                        rule_applied: "Dubbing Lip-Sync Check".to_string(),
                        message: "Для полного дубляжа обязательна оригинальная вокальная дорожка для липсинга!".to_string(),
                    });
                }
            }
        }
    }

    instructions
}

// -------------------------------------------------------------------------------------------------
// Tauri v2 Команда
// -------------------------------------------------------------------------------------------------

/// Команда Tauri: Применение правил валидации и авто-коррекции тайминга в зависимости от типа проекта
#[command]
pub fn validate_and_adjust_project_rules(
    segments: Vec<CueSegment>,
    project_type: ProjectType,
    original_cues: Vec<CueSegment>,
) -> Result<Vec<AdjustmentInstruction>, String> {
    Ok(apply_project_rules(segments, project_type, original_cues))
}

// -------------------------------------------------------------------------------------------------
// Unit-тесты
// -------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_voiceover_leadin_rule() {
        // Оригинал: 1000..3000 мс
        let orig = vec![CueSegment {
            id: "orig_1".to_string(),
            start_ms: 1000.0,
            end_ms: 3000.0,
            text: None,
            track_id: None,
            subtitle_start_ms: None,
            subtitle_end_ms: None,
            matched_original_id: None,
        }];

        // Дабер стартует слишком рано: 1050..2700 мс (меньше 150-250 мс lead-in)
        let dub = vec![CueSegment {
            id: "dub_1".to_string(),
            start_ms: 1050.0,
            end_ms: 2700.0,
            text: Some("Привет".to_string()),
            track_id: Some("track_1".to_string()),
            subtitle_start_ms: None,
            subtitle_end_ms: None,
            matched_original_id: Some("orig_1".to_string()),
        }];

        let res = apply_project_rules(dub, ProjectType::VoiceOver, orig);
        assert_eq!(res.len(), 1);
        let instr = &res[0];
        // Рекомендованный старт: orig_start + 200 = 1200 мс
        assert_eq!(instr.recommended_start_ms, 1200.0);
        assert!(!instr.is_valid); // Слишком рано, поэтому warning
    }

    #[test]
    fn test_recast_short_phrase_warning() {
        // Субтитр длится 2000 мс: 1000..3000 мс
        // Дабер наговорил только 1200 мс: 1000..2200 мс (провисание текста > 100 мс)
        let dub = vec![CueSegment {
            id: "dub_short".to_string(),
            start_ms: 1000.0,
            end_ms: 2200.0,
            text: Some("Короткая фраза".to_string()),
            track_id: None,
            subtitle_start_ms: Some(1000.0),
            subtitle_end_ms: Some(3000.0),
            matched_original_id: None,
        }];

        let res = apply_project_rules(dub, ProjectType::Recast, vec![]);
        assert_eq!(res.len(), 1);
        let instr = &res[0];
        assert_eq!(instr.warning_level, WarningLevel::Critical);
        assert!(!instr.is_valid);
        assert!(instr.stretch_ratio < 1.0); // Должен предложить растяжение
    }

    #[test]
    fn test_dubbing_lipsync_precision() {
        // Липсинг: оригинал 1000..2000 мс
        let orig = vec![CueSegment {
            id: "orig_lip".to_string(),
            start_ms: 1000.0,
            end_ms: 2000.0,
            text: None,
            track_id: None,
            subtitle_start_ms: None,
            subtitle_end_ms: None,
            matched_original_id: None,
        }];

        // Дабер: 1020..2015 мс (в пределах до 30 мс)
        let dub = vec![CueSegment {
            id: "dub_lip".to_string(),
            start_ms: 1020.0,
            end_ms: 2015.0,
            text: None,
            track_id: None,
            subtitle_start_ms: None,
            subtitle_end_ms: None,
            matched_original_id: Some("orig_lip".to_string()),
        }];

        let res = apply_project_rules(dub, ProjectType::Dubbing, orig);
        assert_eq!(res.len(), 1);
        assert!(res[0].is_valid);
        assert_eq!(res[0].warning_level, WarningLevel::Info);
    }
}
