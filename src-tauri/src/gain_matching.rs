use std::path::{Path, PathBuf};
use std::f32::consts::PI;
use std::fs;
use serde::{Deserialize, Serialize};
use hound::{WavReader, WavWriter, WavSpec, SampleFormat};
use ebur128::{EbuR128, Mode};
use crate::logger::log_debug;

/// Классификация реплик / аудиосегментов по типу контента
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeechCategory {
    /// Обычная речь сценария (нормализация к -16 LUFS или -18 dBFS RMS)
    Dialogue,
    /// Нетекстовые звуки: вздохи, кряхтение, кашель, рычание, всхлипывания, охи
    /// (автоматическое ослабление на -10 дБ относительно диалога)
    FoleySFX,
}

/// Входной сегмент с метаданными субтитров и параметрами
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotatedSegment {
    pub id: String,
    pub file_path: String,
    #[serde(default)]
    pub output_path: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub start_time: Option<f64>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub category: Option<SpeechCategory>,
    #[serde(default)]
    pub target_dialogue_lufs: Option<f64>, // по умолчанию -16.0 LUFS
    #[serde(default)]
    pub foley_offset_db: Option<f64>,     // по умолчанию -10.0 dB
    #[serde(default)]
    pub fade_ms: Option<f64>,             // по умолчанию 10.0 ms
}

/// Отчет по обработке отдельного сегмента
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedSegmentResult {
    pub id: String,
    pub file_path: String,
    pub output_path: String,
    pub category: SpeechCategory,
    pub initial_lufs: f64,
    pub target_lufs: f64,
    pub applied_gain_db: f64,
    pub linear_multiplier: f64,
    pub final_lufs: f64,
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub fade_samples: usize,
    pub classification_reason: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Итоговый сводный результат пакетной обработки
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartGainMatchingBatchResult {
    pub results: Vec<ProcessedSegmentResult>,
    pub total_processed: usize,
    pub dialogue_count: usize,
    pub foley_count: usize,
    pub avg_dialogue_gain_db: f64,
    pub avg_foley_gain_db: f64,
}

/// Определение категории реплики по тексту субтитров и акустическим эвристикам Whisper
pub fn classify_segment_intent(
    explicit_category: Option<SpeechCategory>,
    text_opt: Option<&str>,
    duration_sec: f64,
    samples: &[f32],
    channels: usize,
    sample_rate: u32,
) -> (SpeechCategory, String) {
    if let Some(cat) = explicit_category {
        return (cat, "Категория задана пользователем".to_string());
    }

    let text = text_opt.unwrap_or("").trim();

    // 1. Проверка тегов субтитров: скобки [...], (...), *...*, <...>
    let is_bracketed = (text.starts_with('[') && text.ends_with(']'))
        || (text.starts_with('(') && text.ends_with(')'))
        || (text.starts_with('*') && text.ends_with('*'))
        || (text.starts_with('<') && text.ends_with('>'));

    let lower_text = text.to_lowercase();

    let foley_keywords = [
        // Русские теги и описания физиологических звуков
        "вздох", "вдох", "выдох", "кряхтит", "кряхтение", "кашель", "покашливание",
        "рычание", "рык", "всхлип", "всхлипывание", "плач", "плачет", "смех", "смеется",
        "хихикает", "стон", "стонет", "зевок", "зевает", "чмок", "цок", "цоканье",
        "шум", "шорох", "крик", "визг", "охает", "ахает", "сопение", "мычание",
        "хмыканье", "храп", "сглатывает", "глотает", "чавкает", "пыхтит", "рыдает",
        // Английские теги Whisper / субтитров
        "sigh", "sighs", "gasp", "gasps", "groan", "groans", "grunt", "grunts",
        "cough", "coughs", "growl", "growls", "sob", "sobs", "cry", "cries",
        "laugh", "laughs", "snicker", "snickers", "chuckle", "chuckles", "yawn", "yawns",
        "pant", "pants", "panting", "sniff", "sniffs", "sniffle", "scream", "screams",
        "shriek", "moan", "moans", "grunt", "throat clearing", "whisper", "snort"
    ];

    if is_bracketed {
        for &kw in &foley_keywords {
            if lower_text.contains(kw) {
                return (
                    SpeechCategory::FoleySFX,
                    format!("Тег субтитров в скобках содержит '{}' -> FoleySFX", kw),
                );
            }
        }
        // Любой тег в скобках длиной < 35 символов без буквенных слов сценария
        if lower_text.len() < 35 {
            return (
                SpeechCategory::FoleySFX,
                format!("Ремарка в скобках '{}' -> FoleySFX", text),
            );
        }
    } else {
        // Проверка вхождений тегов со звездочками или встроенных пометок, например *крик* или [вздох]
        for &kw in &foley_keywords {
            if lower_text.contains(&format!("*{}*", kw))
                || lower_text.contains(&format!("[{}]", kw))
                || lower_text.contains(&format!("({})", kw))
            {
                return (
                    SpeechCategory::FoleySFX,
                    format!("Встроенный маркер субтитра '*{}*' -> FoleySFX", kw),
                );
            }
        }
    }

    // 2. Междометия и короткие нетекстовые звуки (звукоподражания)
    let non_lexical_tokens = [
        "мм", "ммм", "гм", "гмм", "эх", "эхх", "ох", "оох", "ах", "ух",
        "пф", "тсс", "тс", "кхм", "кхе", "ха", "хе", "угу", "ага",
        "hm", "hmm", "uh", "um", "ah", "oh", "tsk", "ugh", "pfft", "huh"
    ];
    let stripped = lower_text.trim_matches(|c: char| !c.is_alphanumeric());
    if non_lexical_tokens.contains(&stripped) {
        return (
            SpeechCategory::FoleySFX,
            format!("Нетекстовое междометие '{}' -> FoleySFX", text),
        );
    }

    // 3. Эвристики Whisper для коротких звуков (< 400 мс)
    if duration_sec > 0.001 && duration_sec < 0.400 {
        // Если текст отсутствует или содержит только знаки пунктуации
        if text.is_empty() || stripped.is_empty() {
            return (
                SpeechCategory::FoleySFX,
                format!("Короткий аудиосегмент ({:.0} мс) без распознанного текста -> FoleySFX", duration_sec * 1000.0),
            );
        }

        // Акустический анализ периодичности / вокализации (Voice Activity & Harmonic Vowels)
        // Гласные звуки (vowels) имеют четкую периодичность (автокорреляция > 0.35) и умеренный ZCR.
        // Шум дыхания, кряхтение, вздохи, кашель и щелчки имеют высокий ZCR (> 0.22) и низкую автокорреляцию.
        let is_unvoiced_noise = check_if_unvoiced_or_noise(samples, channels, sample_rate);
        if is_unvoiced_noise {
            return (
                SpeechCategory::FoleySFX,
                format!("Короткий звук ({:.0} мс) с признаками невокализованного шума/вздоха -> FoleySFX", duration_sec * 1000.0),
            );
        }
    }

    (SpeechCategory::Dialogue, "Обычная реплика сценария -> Dialogue".to_string())
}

/// Акустическая проверка: отсутствие устойчивых гармонических гласных (высокий ZCR или низкая автокорреляция)
fn check_if_unvoiced_or_noise(samples: &[f32], channels: usize, sample_rate: u32) -> bool {
    let mono_len = samples.len() / channels.max(1);
    if mono_len < 128 {
        return true;
    }

    // Получаем моно-сэмплы
    let mut mono: Vec<f32> = Vec::with_capacity(mono_len);
    for frame in samples.chunks(channels) {
        let sum: f32 = frame.iter().sum();
        mono.push(sum / channels as f32);
    }

    // 1. Zero-Crossing Rate (ZCR)
    let mut zero_crossings = 0;
    for i in 1..mono.len() {
        if (mono[i] >= 0.0 && mono[i - 1] < 0.0) || (mono[i] < 0.0 && mono[i - 1] >= 0.0) {
            zero_crossings += 1;
        }
    }
    let zcr = zero_crossings as f32 / mono.len() as f32;

    // Высокий ZCR (> 0.22) характерен для шипящих звуков, выдохов, вздохов и микрофонных шорохов
    if zcr > 0.22 {
        return true;
    }

    // 2. Максимальный пик автокорреляции в диапазоне частоты основного тона речи (80 Гц - 400 Гц)
    let min_lag = (sample_rate as f32 / 400.0).round() as usize;
    let max_lag = (sample_rate as f32 / 80.0).round() as usize;

    if max_lag >= mono.len() {
        return false;
    }

    let mut energy = 0.0f32;
    for &s in &mono {
        energy += s * s;
    }
    if energy < 1e-6 {
        return true; // практически тишина
    }

    let mut max_corr = 0.0f32;
    for lag in min_lag..=max_lag {
        let mut corr = 0.0f32;
        let mut n = 0;
        for i in 0..(mono.len() - lag) {
            corr += mono[i] * mono[i + lag];
            n += 1;
        }
        if n > 0 {
            let norm_corr = corr / energy;
            if norm_corr > max_corr {
                max_corr = norm_corr;
            }
        }
    }

    // Если нет четкой периодичности (max_corr < 0.32), это шум дыхания/вздох/кашель
    max_corr < 0.32
}

/// Измерение громкости через EBU R128 с надежным фоллбэком на RMS для сверхкоротких файлов (< 400 мс)
pub fn measure_audio_loudness_lufs(
    samples: &[f32],
    channels: u16,
    sample_rate: u32,
) -> Result<f64, String> {
    if samples.is_empty() {
        return Ok(-70.0);
    }

    let total_frames = samples.len() / channels as usize;
    let duration_sec = total_frames as f64 / sample_rate as f64;

    // EBU R128 требует хотя бы 400 мс для интегрального блока громкости
    if duration_sec >= 0.400 {
        if let Ok(mut meter) = EbuR128::new(channels as u32, sample_rate, Mode::I) {
            if meter.add_frames_f32(samples).is_ok() {
                if let Ok(lufs) = meter.loudness_global() {
                    if !lufs.is_nan() && lufs > -70.0 && lufs < 10.0 {
                        return Ok(lufs);
                    }
                }
            }
        }
    }

    // Фоллбэк: ITU-R BS.1770 / RMS взвешенное измерение
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    let mean_sq = sum_sq / samples.len() as f64;
    let rms = mean_sq.sqrt();

    if rms > 1e-6 {
        // Калибровка RMS к LUFS шкале: для синуса 0 dBFS RMS ≈ -3.01 dB, LUFS ≈ -3.0
        let rms_db = 20.0 * rms.log10();
        Ok((rms_db - 0.5).clamp(-70.0, 0.0))
    } else {
        Ok(-70.0)
    }
}

/// Применение плавного Fade-In и Fade-Out (Half-Cosine S-Curve) для предотвращения щелчков
pub fn apply_smooth_fades(
    samples: &mut [f32],
    channels: usize,
    sample_rate: u32,
    fade_ms: f64,
) -> usize {
    let total_frames = samples.len() / channels;
    if total_frames <= 2 {
        return 0;
    }

    let target_fade_frames = ((sample_rate as f64 * (fade_ms / 1000.0)).round() as usize).max(1);
    let fade_frames = target_fade_frames.min(total_frames / 2);

    if fade_frames == 0 {
        return 0;
    }

    // Fade-In: 0.5 * (1.0 - cos(pi * i / N))
    for f in 0..fade_frames {
        let alpha = f as f32 / fade_frames as f32;
        let gain = 0.5 * (1.0 - (PI * alpha).cos());
        for ch in 0..channels {
            samples[f * channels + ch] *= gain;
        }
    }

    // Fade-Out: 0.5 * (1.0 + cos(pi * j / N))
    for f in 0..fade_frames {
        let alpha = f as f32 / fade_frames as f32;
        let gain = 0.5 * (1.0 + (PI * alpha).cos());
        let frame_idx = total_frames - fade_frames + f;
        for ch in 0..channels {
            samples[frame_idx * channels + ch] *= gain;
        }
    }

    fade_frames
}

/// Чтение сэмплов из WAV файла в 32-битный float буфер
pub fn read_wav_samples(path: &Path) -> Result<(Vec<f32>, WavSpec), String> {
    let mut reader = WavReader::open(path)
        .map_err(|e| format!("Не удалось открыть WAV {:?}: {}", path, e))?;
    let spec = reader.spec();

    let samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        SampleFormat::Int => match spec.bits_per_sample {
            16 => reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / 32768.0).collect(),
            24 => reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 8388608.0).collect(),
            32 => reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 2147483648.0).collect(),
            8  => reader.samples::<i8>().map(|s| s.unwrap_or(0) as f32 / 128.0).collect(),
            b => return Err(format!("Неподдерживаемая разрядность: {} бит", b)),
        },
    };

    Ok((samples, spec))
}

/// Запись сэмплов в WAV файл (32-bit float для максимального динамического диапазона без клиппинга)
pub fn write_wav_samples(path: &Path, samples: &[f32], spec: WavSpec) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let out_spec = WavSpec {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(path, out_spec)
        .map_err(|e| format!("Ошибка создания файла {:?}: {}", path, e))?;

    for &s in samples {
        writer.write_sample(s)
            .map_err(|e| format!("Ошибка записи сэмпла в {:?}: {}", path, e))?;
    }

    writer.finalize()
        .map_err(|e| format!("Ошибка финализации WAV {:?}: {}", path, e))?;

    Ok(())
}

/// Интеллектуальный гейн-стейджинг отдельного аудиосегмента
pub fn process_single_segment_gain_matching(
    segment: &AnnotatedSegment,
) -> ProcessedSegmentResult {
    let input_path_str = crate::file_io::normalize_windows_path(&segment.file_path);
    let input_path = Path::new(&input_path_str);

    let output_path_str = segment.output_path.as_ref()
        .map(|p| crate::file_io::normalize_windows_path(p))
        .unwrap_or_else(|| input_path_str.clone());
    let output_path = Path::new(&output_path_str);

    if !input_path.exists() {
        return ProcessedSegmentResult {
            id: segment.id.clone(),
            file_path: input_path_str,
            output_path: output_path_str,
            category: segment.category.unwrap_or(SpeechCategory::Dialogue),
            initial_lufs: -70.0,
            target_lufs: segment.target_dialogue_lufs.unwrap_or(-16.0),
            applied_gain_db: 0.0,
            linear_multiplier: 1.0,
            final_lufs: -70.0,
            duration_sec: 0.0,
            sample_rate: 48000,
            channels: 1,
            fade_samples: 0,
            classification_reason: "Файл не найден на диске".to_string(),
            success: false,
            error: Some("Аудиофайл не существует".to_string()),
        };
    }

    // 1. Чтение сэмплов исходного файла
    let (mut samples, spec) = match read_wav_samples(input_path) {
        Ok(res) => res,
        Err(e) => {
            return ProcessedSegmentResult {
                id: segment.id.clone(),
                file_path: input_path_str,
                output_path: output_path_str,
                category: segment.category.unwrap_or(SpeechCategory::Dialogue),
                initial_lufs: -70.0,
                target_lufs: segment.target_dialogue_lufs.unwrap_or(-16.0),
                applied_gain_db: 0.0,
                linear_multiplier: 1.0,
                final_lufs: -70.0,
                duration_sec: 0.0,
                sample_rate: 48000,
                channels: 1,
                fade_samples: 0,
                classification_reason: "Ошибка чтения WAV".to_string(),
                success: false,
                error: Some(e),
            };
        }
    };

    let channels = spec.channels as usize;
    let sample_rate = spec.sample_rate;
    let total_frames = samples.len() / channels.max(1);
    let duration_sec = total_frames as f64 / sample_rate as f64;

    // 2. Классификация реплики (Dialogue vs FoleySFX)
    let (category, reason) = classify_segment_intent(
        segment.category,
        segment.text.as_deref(),
        duration_sec,
        &samples,
        channels,
        sample_rate,
    );

    // 3. Измерение исходного уровня громкости (EBU R128 LUFS или RMS)
    let initial_lufs = measure_audio_loudness_lufs(&samples, spec.channels, sample_rate)
        .unwrap_or(-24.0);

    // 4. Расчет целевой громкости
    let base_dialogue_target = segment.target_dialogue_lufs.unwrap_or(-16.0);
    let foley_offset = segment.foley_offset_db.unwrap_or(-10.0);

    let target_lufs = match category {
        SpeechCategory::Dialogue => base_dialogue_target,
        SpeechCategory::FoleySFX => base_dialogue_target + foley_offset,
    };

    // 5. Расчет дельты усиления
    let applied_gain_db = if initial_lufs > -65.0 {
        (target_lufs - initial_lufs).clamp(-30.0, 30.0)
    } else {
        0.0
    };
    let linear_multiplier = 10.0_f64.powf(applied_gain_db / 20.0);
    let linear_gain_f32 = linear_multiplier as f32;

    // 6. Применение коэффициента усиления с мягким True-Peak лимитированием
    for s in samples.iter_mut() {
        let val = *s * linear_gain_f32;
        // Soft-knee tanh сатурация выше -0.5 dBFS (0.944) для защиты от цифрового клиппинга
        if val > 0.944 {
            let over = val - 0.944;
            *s = 0.944 + 0.05 * (over / 0.05).tanh();
        } else if val < -0.944 {
            let over = val + 0.944;
            *s = -0.944 + 0.05 * (over / 0.05).tanh();
        } else {
            *s = val;
        }
    }

    // 7. Применение плавных 10 мс фейдов (Fade-In / Fade-Out) для предотвращения щелчков
    let fade_ms = segment.fade_ms.unwrap_or(10.0);
    let fade_samples = apply_smooth_fades(&mut samples, channels, sample_rate, fade_ms);

    // 8. Контрольное измерение итоговой громкости
    let final_lufs = measure_audio_loudness_lufs(&samples, spec.channels, sample_rate)
        .unwrap_or(target_lufs);

    // 9. Сохранение файла на диск
    // Если пишем поверх исходного файла, используем безопасную временную запись
    let write_res = if input_path_str == output_path_str {
        let temp_file = PathBuf::from(format!("{}.gm_tmp.wav", output_path_str));
        match write_wav_samples(&temp_file, &samples, spec) {
            Ok(()) => {
                if let Err(e) = fs::rename(&temp_file, output_path) {
                    // Если rename не сработал (разные тома), пробуем copy + remove
                    if fs::copy(&temp_file, output_path).is_ok() {
                        let _ = fs::remove_file(&temp_file);
                        Ok(())
                    } else {
                        let _ = fs::remove_file(&temp_file);
                        Err(format!("Не удалось перезаписать аудиофайл: {}", e))
                    }
                } else {
                    Ok(())
                }
            }
            Err(e) => Err(e),
        }
    } else {
        write_wav_samples(output_path, &samples, spec)
    };

    if let Err(e) = write_res {
        return ProcessedSegmentResult {
            id: segment.id.clone(),
            file_path: input_path_str,
            output_path: output_path_str,
            category,
            initial_lufs,
            target_lufs,
            applied_gain_db,
            linear_multiplier,
            final_lufs,
            duration_sec,
            sample_rate,
            channels: spec.channels,
            fade_samples,
            classification_reason: reason,
            success: false,
            error: Some(e),
        };
    }

    ProcessedSegmentResult {
        id: segment.id.clone(),
        file_path: input_path_str,
        output_path: output_path_str,
        category,
        initial_lufs,
        target_lufs,
        applied_gain_db,
        linear_multiplier,
        final_lufs,
        duration_sec,
        sample_rate,
        channels: spec.channels,
        fade_samples,
        classification_reason: reason,
        success: true,
        error: None,
    }
}

/// Нативная Tauri команда интеллектуального выравнивания громкости по метаданным субтитров
#[tauri::command]
pub async fn apply_smart_gain_matching(
    segments: Vec<AnnotatedSegment>,
) -> Result<SmartGainMatchingBatchResult, String> {
    log_debug(&format!(
        "apply_smart_gain_matching: старт обработки {} сегментов",
        segments.len()
    ));

    tokio::task::spawn_blocking(move || {
        let total = segments.len();
        let mut results = Vec::with_capacity(total);
        let mut dialogue_count = 0;
        let mut foley_count = 0;
        let mut total_dialogue_gain = 0.0f64;
        let mut total_foley_gain = 0.0f64;

        for seg in segments {
            let res = process_single_segment_gain_matching(&seg);
            if res.success {
                match res.category {
                    SpeechCategory::Dialogue => {
                        dialogue_count += 1;
                        total_dialogue_gain += res.applied_gain_db;
                    }
                    SpeechCategory::FoleySFX => {
                        foley_count += 1;
                        total_foley_gain += res.applied_gain_db;
                    }
                }
            }
            results.push(res);
        }

        let avg_dialogue_gain_db = if dialogue_count > 0 {
            total_dialogue_gain / dialogue_count as f64
        } else {
            0.0
        };

        let avg_foley_gain_db = if foley_count > 0 {
            total_foley_gain / foley_count as f64
        } else {
            0.0
        };

        log_debug(&format!(
            "apply_smart_gain_matching: завершено {} сегментов (диалогов: {}, foley/физики: {})",
            total, dialogue_count, foley_count
        ));

        Ok(SmartGainMatchingBatchResult {
            results,
            total_processed: total,
            dialogue_count,
            foley_count,
            avg_dialogue_gain_db,
            avg_foley_gain_db,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
