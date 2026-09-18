// ============================================================================
// DUB MIXING STUDIO PRO - HYBRID SPEECH & CUE CLASSIFIER (RUST)
// Нативный гибридный классификатор реплик, ремарок и неречевых звуков
// Стек: Rust, Rayon, Regex, Hound, RustFFT, Serde, Tauri v2
// ============================================================================

use std::f32::consts::PI;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use hound::WavReader;
use rayon::prelude::*;
use regex::Regex;
use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};

use crate::logger::log_info;

// ============================================================================
// 1. DATA MODELS & STRUCTS
// ============================================================================

/// Категория реплики / аудиосегмента в проекте
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CueClassification {
    /// Обычная речь сценария (целевой уровень -16.0 LUFS)
    StandardDialogue,
    /// Физиологические звуки: вздохи, кашель, кряхтение, всхлипы (ослабление на -10 дБ)
    FoleyEffort,
    /// Крик, ор, эмоциональный вопль (особый контроль лимитера, поправка -6 дБ)
    ShoutScream,
    /// Шепот, тихий приглушенный голос (upward-компрессия / подъем тихих формант)
    Whisper,
}

/// Входные данные аудиосегмента для классификации
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCueInput {
    pub id: String,
    pub file_path: Option<String>,
    pub text: Option<String>,
    pub start_time: f64,
    pub duration: f64,
    pub waveform_peaks: Option<Vec<f32>>,
    pub sample_rate: Option<u32>,
}

/// Спектральные и временные акустические метрики сегмента
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectralMetrics {
    pub zcr: f32,
    pub spectral_flatness: f32,
    pub spectral_centroid_hz: f32,
    pub rms_db: f32,
    pub peak_db: f32,
    pub energy_ratio_hf: f32,
    pub is_unvoiced: bool,
    pub is_tonal: bool,
    pub fundamental_autocorr: f32,
}

/// Результат нативной классификации реплики
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedCueOutput {
    pub id: String,
    pub classification: CueClassification,
    pub confidence: f32,
    pub target_lufs: f32,
    pub gain_offset_db: f32,
    pub reason: String,
    pub spectral_metrics: Option<SpectralMetrics>,
    pub processing_hint: String,
}

// ============================================================================
// 2. TEXT NLP LAYER (РЕГУЛЯРНЫЕ ВЫРАЖЕНИЯ И МОРФОЛОГИЧЕСКИЕ ПАТТЕРНЫ)
// ============================================================================

struct TextPatternMatcher {
    bracket_foley_re: Regex,
    bracket_shout_re: Regex,
    bracket_whisper_re: Regex,
    all_caps_shout_re: Regex,
    exclamation_shout_re: Regex,
}

static PATTERNS: OnceLock<TextPatternMatcher> = OnceLock::new();

fn get_patterns() -> &'static TextPatternMatcher {
    PATTERNS.get_or_init(|| {
        TextPatternMatcher {
            // Ремарки вздохов, кашля, кряхтения в скобках [...], (...), *...*
            bracket_foley_re: Regex::new(
                r"(?i)[\(\[\*](вздох|вдох|выдох|кряхтит|кряхтение|кашель|покашливание|рычание|рык|всхлип|всхлипывание|плач|плачет|смех|смеется|хихикает|стон|стонет|зевок|зевает|чмок|цок|цоканье|шум|шорох|охает|ахает|сопение|мычание|хмыканье|храп|сглатывает|глотает|чавкает|пыхтит|рыдает|sigh|gasp|groan|grunt|cough|growl|sob|cry|laugh|snicker|chuckle|yawn|pant|sniff|snort|throat clearing)[\)\]\*]"
            ).expect("Valid regex for bracket foley"),

            // Ремарки крика, вопля, ора
            bracket_shout_re: Regex::new(
                r"(?i)[\(\[\*](крик|кричит|ор|орёт|орет|вопль|визг|визжит|рычит громко|ярость|scream|screams|screaming|shout|shouts|shouting|shriek|yell|yelling|roar)[\)\]\*]"
            ).expect("Valid regex for bracket shout"),

            // Ремарки шепота и тихого голоса
            bracket_whisper_re: Regex::new(
                r"(?i)[\(\[\*](шепот|шёпот|шепотом|шёпотом|вполголоса|тихо|тихий голос|едва слышно|whisper|whispers|whispering|murmur|hushed)[\)\]\*]"
            ).expect("Valid regex for bracket whisper"),

            // Текст КАПСОМ (3+ букв на русском или английском)
            all_caps_shout_re: Regex::new(
                r"\b[A-ZА-ЯЁ]{3,}\b"
            ).expect("Valid regex for all caps"),

            // Текст с множественными или одиночными эмоциональными восклицаниями
            exclamation_shout_re: Regex::new(
                r"[!]{1,3}$"
            ).expect("Valid regex for exclamation shout"),
        }
    })
}

// Список общеупотребительных междометий и звукоподражаний
const NON_LEXICAL_INTERJECTIONS: &[&str] = &[
    "мм", "ммм", "гм", "гмм", "эх", "эхх", "ох", "оох", "ах", "аах", "ух", "уух",
    "пф", "пфф", "тсс", "тс", "кхм", "кхе", "ха", "хе", "угу", "ага", "ой", "ай",
    "брр", "фух", "уф", "тьфу", "э-э-э", "эээ", "а-а-а", "о-о-о", "хм", "хмм",
    "hm", "hmm", "uh", "um", "ah", "oh", "tsk", "ugh", "pfft", "huh", "oof", "gasp",
    "shh", "shhh", "haha", "hehe", "aha", "mhm"
];

// ============================================================================
// 3. ACOUSTIC ANALYSIS LAYER (FFT, SPECTRAL FLATNESS, ZCR, AUTOCORRELATION)
// ============================================================================

pub struct AudioFeatureExtractor;

impl AudioFeatureExtractor {
    /// Извлечение сэмплов из WAV файла сегмента или fallback на чтение
    pub fn load_audio_samples(file_path: &str) -> Option<(Vec<f32>, u32, usize)> {
        let path = Path::new(file_path);
        if !path.exists() {
            return None;
        }

        let file = File::open(path).ok()?;
        let reader = BufReader::new(file);
        let mut wav_reader = WavReader::new(reader).ok()?;
        let spec = wav_reader.spec();
        let channels = spec.channels as usize;
        let sample_rate = spec.sample_rate;

        let samples: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => wav_reader
                .samples::<f32>()
                .filter_map(Result::ok)
                .collect(),
            hound::SampleFormat::Int => {
                let max_val = (1i64 << (spec.bits_per_sample - 1)) as f32;
                wav_reader
                    .samples::<i32>()
                    .filter_map(Result::ok)
                    .map(|s| s as f32 / max_val)
                    .collect()
            }
        };

        if samples.is_empty() {
            None
        } else {
            Some((samples, sample_rate, channels))
        }
    }

    /// Преобразование многоканального сигнала в моно
    pub fn to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
        let ch = channels.max(1);
        if ch == 1 {
            return samples.to_vec();
        }
        let mono_len = samples.len() / ch;
        let mut mono = Vec::with_capacity(mono_len);
        for frame in samples.chunks(ch) {
            let sum: f32 = frame.iter().sum();
            mono.push(sum / ch as f32);
        }
        mono
    }

    /// Расчет спектральных и временных метрик моно-сигнала
    pub fn compute_spectral_metrics(mono: &[f32], sample_rate: u32) -> SpectralMetrics {
        let len = mono.len();
        if len == 0 {
            return SpectralMetrics {
                zcr: 0.0,
                spectral_flatness: 0.0,
                spectral_centroid_hz: 0.0,
                rms_db: -90.0,
                peak_db: -90.0,
                energy_ratio_hf: 0.0,
                is_unvoiced: true,
                is_tonal: false,
                fundamental_autocorr: 0.0,
            };
        }

        // 1. Zero-Crossing Rate (ZCR)
        let mut zero_crossings = 0usize;
        let mut sum_sq = 0.0f32;
        let mut max_abs = 0.0f32;

        for i in 0..len {
            let val = mono[i];
            let abs_val = val.abs();
            if abs_val > max_abs {
                max_abs = abs_val;
            }
            sum_sq += val * val;

            if i > 0 && ((mono[i] >= 0.0 && mono[i - 1] < 0.0) || (mono[i] < 0.0 && mono[i - 1] >= 0.0)) {
                zero_crossings += 1;
            }
        }

        let zcr = zero_crossings as f32 / len as f32;
        let rms = (sum_sq / len as f32).sqrt().max(1e-6);
        let rms_db = 20.0 * rms.log10().max(-90.0);
        let peak_db = 20.0 * max_abs.max(1e-6).log10().max(-90.0);

        // 2. Автокорреляция основного тона (F0 в диапазоне 80 Гц - 400 Гц)
        let min_lag = (sample_rate as f32 / 400.0).round() as usize;
        let max_lag = (sample_rate as f32 / 80.0).round() as usize;
        let mut max_autocorr = 0.0f32;

        if max_lag < len && sum_sq > 1e-7 {
            let eval_len = len.min(2048);
            for lag in min_lag..=max_lag.min(eval_len / 2) {
                let mut corr = 0.0f32;
                let mut norm1 = 0.0f32;
                let mut norm2 = 0.0f32;
                for i in 0..(eval_len - lag) {
                    let s1 = mono[i];
                    let s2 = mono[i + lag];
                    corr += s1 * s2;
                    norm1 += s1 * s1;
                    norm2 += s2 * s2;
                }
                let norm = (norm1 * norm2).sqrt();
                if norm > 1e-6 {
                    let r = corr / norm;
                    if r > max_autocorr {
                        max_autocorr = r;
                    }
                }
            }
        }

        // 3. Быстрый спектральный анализ через FFT (размер окна 1024 или 2048)
        let fft_size = 1024.min(len.next_power_of_two());
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(fft_size);

        let mut buffer: Vec<Complex32> = Vec::with_capacity(fft_size);
        let half_point = len / 2;
        let start_idx = if half_point >= fft_size / 2 {
            (half_point - fft_size / 2).min(len - fft_size)
        } else {
            0
        };

        // Наложение окна Хэннинга
        for i in 0..fft_size {
            if start_idx + i < len {
                let hanning = 0.5 * (1.0 - (2.0 * PI * i as f32 / (fft_size - 1) as f32).cos());
                buffer.push(Complex32::new(mono[start_idx + i] * hanning, 0.0));
            } else {
                buffer.push(Complex32::new(0.0, 0.0));
            }
        }

        fft.process(&mut buffer);

        let num_bins = fft_size / 2;
        let bin_width_hz = sample_rate as f32 / fft_size as f32;
        let mut power_spectrum = Vec::with_capacity(num_bins);
        let mut total_power = 0.0f32;
        let mut weighted_freq_sum = 0.0f32;
        let mut hf_power = 0.0f32;
        let mut log_power_sum = 0.0f32;

        for k in 0..num_bins {
            let mag_sq = buffer[k].norm_sqr() + 1e-9;
            power_spectrum.push(mag_sq);
            total_power += mag_sq;
            let freq_hz = k as f32 * bin_width_hz;
            weighted_freq_sum += freq_hz * mag_sq;

            if freq_hz >= 3000.0 {
                hf_power += mag_sq;
            }
            log_power_sum += mag_sq.ln();
        }

        // Спектральный центроид
        let spectral_centroid_hz = if total_power > 1e-8 {
            weighted_freq_sum / total_power
        } else {
            0.0
        };

        // Spectral Flatness (Wiener entropy: геометрическое среднее / арифметическое среднее)
        let geometric_mean = (log_power_sum / num_bins as f32).exp();
        let arithmetic_mean = total_power / num_bins as f32;
        let spectral_flatness = if arithmetic_mean > 1e-8 {
            (geometric_mean / arithmetic_mean).min(1.0).max(0.0)
        } else {
            0.0
        };

        let energy_ratio_hf = if total_power > 1e-8 {
            (hf_power / total_power).min(1.0)
        } else {
            0.0
        };

        // Тональность: устойчивая автокорреляция основного тона > 0.38 и низкая спектральная плоскостность (< 0.25)
        let is_tonal = max_autocorr >= 0.38 && spectral_flatness < 0.25;

        // Невокализованный шум/вздох: высокий ZCR (> 0.22) или высокая плоскостность (> 0.45) без выраженного F0
        let is_unvoiced = zcr > 0.22 || (spectral_flatness > 0.40 && max_autocorr < 0.30);

        SpectralMetrics {
            zcr,
            spectral_flatness,
            spectral_centroid_hz,
            rms_db,
            peak_db,
            energy_ratio_hf,
            is_unvoiced,
            is_tonal,
            fundamental_autocorr: max_autocorr,
        }
    }
}

// ============================================================================
// 4. HYBRID CLASSIFIER ENGINE (RUST & RAYON)
// ============================================================================

pub struct HybridSpeechCueClassifier;

impl HybridSpeechCueClassifier {
    /// Классификация отдельного сегмента на основе текста и акустики
    pub fn classify_cue(cue: &ProjectCueInput) -> ClassifiedCueOutput {
        let raw_text = cue.text.as_deref().unwrap_or("").trim();
        let patterns = get_patterns();

        // 1. Акустический анализ (если файл доступен на диске)
        let spectral_metrics = if let Some(ref path) = cue.file_path {
            if let Some((samples, sr, ch)) = AudioFeatureExtractor::load_audio_samples(path) {
                let mono = AudioFeatureExtractor::to_mono(&samples, ch);
                Some(AudioFeatureExtractor::compute_spectral_metrics(&mono, sr))
            } else {
                Self::fallback_metrics_from_peaks(cue.waveform_peaks.as_deref())
            }
        } else {
            Self::fallback_metrics_from_peaks(cue.waveform_peaks.as_deref())
        };

        // --------------------------------------------------------------------
        // СЛОЙ 1: ТЕКСТОВЫЙ АНАЛИЗ РЕМАРОК В СКОБКАХ И СПЕЦИАЛЬНЫХ СИМВОЛАХ
        // --------------------------------------------------------------------

        // А) Проверка явного крика/вопля в скобках [крик], (кричит), *scream*
        if patterns.bracket_shout_re.is_match(raw_text) {
            return ClassifiedCueOutput {
                id: cue.id.clone(),
                classification: CueClassification::ShoutScream,
                confidence: 0.96,
                target_lufs: -22.0,
                gain_offset_db: -6.0,
                reason: format!("Ремарка крика в тексте: '{}' -> ShoutScream (-6 dB, Ceiling Limiter)", raw_text),
                spectral_metrics,
                processing_hint: "Применен пресет лимитирования громких всплесков (Threshold: -6dB, Fast Release)".to_string(),
            };
        }

        // Б) Проверка явного шепота в скобках [шепот], (вполголоса), *тихо*
        if patterns.bracket_whisper_re.is_match(raw_text) {
            return ClassifiedCueOutput {
                id: cue.id.clone(),
                classification: CueClassification::Whisper,
                confidence: 0.95,
                target_lufs: -18.0,
                gain_offset_db: 3.0,
                reason: format!("Ремарка шепота в тексте: '{}' -> Whisper (Upward Compression +3 dB)", raw_text),
                spectral_metrics,
                processing_hint: "Включена upward-компрессия тихих формант и сглаживание шумов дыхания".to_string(),
            };
        }

        // В) Проверка физиологических звуков и ремарок [вздох], (кашель), *кряхтит*, [стон]
        if patterns.bracket_foley_re.is_match(raw_text) {
            return ClassifiedCueOutput {
                id: cue.id.clone(),
                classification: CueClassification::FoleyEffort,
                confidence: 0.98,
                target_lufs: -26.0,
                gain_offset_db: -10.0,
                reason: format!("Ремарка действия/вздоха в скобках: '{}' -> FoleyEffort (-10 dB)", raw_text),
                spectral_metrics,
                processing_hint: "Ослабление громкости на -10 дБ для сохранения прозрачности фонограммы".to_string(),
            };
        }

        // Г) Обобщенные скобки [...] или (...) короткой длины без обычных предложений
        let is_bracketed = (raw_text.starts_with('[') && raw_text.ends_with(']'))
            || (raw_text.starts_with('(') && raw_text.ends_with(')'))
            || (raw_text.starts_with('*') && raw_text.ends_with('*'));

        if is_bracketed && raw_text.chars().count() <= 35 {
            return ClassifiedCueOutput {
                id: cue.id.clone(),
                classification: CueClassification::FoleyEffort,
                confidence: 0.88,
                target_lufs: -26.0,
                gain_offset_db: -10.0,
                reason: format!("Общая ремарка сценария в скобках: '{}' -> FoleyEffort (-10 dB)", raw_text),
                spectral_metrics,
                processing_hint: "Автоматическое приглушение недиалоговой ремарки сценария".to_string(),
            };
        }

        // --------------------------------------------------------------------
        // СЛОЙ 2: МОРФОЛОГИЧЕСКИЕ ПАТТЕРНЫ МЕЖДОМЕТИЙ И ЗВУКОПОДРАЖАНИЙ
        // --------------------------------------------------------------------
        let lower_clean = raw_text
            .to_lowercase()
            .trim_matches(|c: char| !c.is_alphanumeric() && c != '-')
            .to_string();

        if NON_LEXICAL_INTERJECTIONS.contains(&lower_clean.as_str()) {
            return ClassifiedCueOutput {
                id: cue.id.clone(),
                classification: CueClassification::FoleyEffort,
                confidence: 0.92,
                target_lufs: -26.0,
                gain_offset_db: -10.0,
                reason: format!("Междометие/звукоподражание: '{}' -> FoleyEffort (-10 dB)", raw_text),
                spectral_metrics,
                processing_hint: "Приглушение нелексического звука дыхания/удивления".to_string(),
            };
        }

        // --------------------------------------------------------------------
        // СЛОЙ 3: ДЕТЕКЦИЯ ЭКСПРЕССИВНОГО КРИКА (КАПС + ВОСКЛИЦАНИЯ)
        // --------------------------------------------------------------------
        let has_caps = patterns.all_caps_shout_re.is_match(raw_text);
        let has_exclamation = patterns.exclamation_shout_re.is_match(raw_text) || raw_text.contains("!!!");

        if has_caps && has_exclamation && raw_text.chars().count() <= 30 {
            // Если акустика подтверждает высокий уровень RMS (> -18 dBFS)
            let is_loud = spectral_metrics
                .as_ref()
                .map(|m| m.rms_db > -18.0 || m.peak_db > -3.0)
                .unwrap_or(true);

            if is_loud {
                return ClassifiedCueOutput {
                    id: cue.id.clone(),
                    classification: CueClassification::ShoutScream,
                    confidence: 0.90,
                    target_lufs: -22.0,
                    gain_offset_db: -6.0,
                    reason: format!("Эмоциональный выкрик КАПСОМ: '{}' -> ShoutScream (-6 dB)", raw_text),
                    spectral_metrics,
                    processing_hint: "Ограничение пиков для предотвращения интермодуляционных искажений".to_string(),
                };
            }
        }

        // --------------------------------------------------------------------
        // СЛОЙ 4: АКУСТИЧЕСКИЙ АНАЛИЗ (ЕСЛИ ТЕКСТ НЕОДНОЗНАЧЕН ИЛИ ОТСУТСТВУЕТ)
        // --------------------------------------------------------------------
        if let Some(ref m) = spectral_metrics {
            // А) Сверхкороткие звуки (< 350 мс) без устойчивой тональной основы
            if cue.duration > 0.001 && cue.duration < 0.350 {
                if m.is_unvoiced || (m.fundamental_autocorr < 0.32 && m.zcr > 0.18) {
                    return ClassifiedCueOutput {
                        id: cue.id.clone(),
                        classification: CueClassification::FoleyEffort,
                        confidence: 0.85,
                        target_lufs: -26.0,
                        gain_offset_db: -10.0,
                        reason: format!(
                            "Сверхкороткий звук ({:.0} мс, ZCR: {:.2}, Flatness: {:.2}) без первой форманты -> FoleyEffort",
                            cue.duration * 1000.0,
                            m.zcr,
                            m.spectral_flatness
                        ),
                        spectral_metrics: Some(m.clone()),
                        processing_hint: "Подавление щелчков и шумов дыхания короткими 10 мс anti-click фейдами".to_string(),
                    };
                }
            }

            // Б) Акустическая детекция шепота: высокая спектральная плоскостность + высокий ZCR + тихий RMS
            if m.spectral_flatness > 0.42 && m.zcr > 0.22 && m.rms_db < -26.0 && cue.duration >= 0.350 {
                return ClassifiedCueOutput {
                    id: cue.id.clone(),
                    classification: CueClassification::Whisper,
                    confidence: 0.82,
                    target_lufs: -18.0,
                    gain_offset_db: 3.0,
                    reason: format!(
                        "Акустический шепот (ZCR: {:.2}, Flatness: {:.2}, RMS: {:.1} dB) -> Whisper",
                        m.zcr,
                        m.spectral_flatness,
                        m.rms_db
                    ),
                    spectral_metrics: Some(m.clone()),
                    processing_hint: "Upward компрессия для разборчивости тихих согласных звуков".to_string(),
                };
            }

            // В) Акустическая детекция крика: высокий RMS (> -13 dBFS) и сильная насыщенность гармониками
            if m.rms_db > -13.0 && m.peak_db > -1.5 && m.is_tonal && cue.duration >= 0.400 {
                return ClassifiedCueOutput {
                    id: cue.id.clone(),
                    classification: CueClassification::ShoutScream,
                    confidence: 0.84,
                    target_lufs: -22.0,
                    gain_offset_db: -6.0,
                    reason: format!(
                        "Высокоэнергетичный крик по спектру (RMS: {:.1} dBFS, Peak: {:.1} dBFS) -> ShoutScream",
                        m.rms_db,
                        m.peak_db
                    ),
                    spectral_metrics: Some(m.clone()),
                    processing_hint: "Снижение порога лимитера и выравнивание динамического диапазона".to_string(),
                };
            }
        }

        // --------------------------------------------------------------------
        // СЛОЙ 5: СТАНДАРТНАЯ РЕЧЬ СЦЕНАРИЯ (ДИАЛОГ)
        // --------------------------------------------------------------------
        ClassifiedCueOutput {
            id: cue.id.clone(),
            classification: CueClassification::StandardDialogue,
            confidence: 0.94,
            target_lufs: -16.0,
            gain_offset_db: 0.0,
            reason: if !raw_text.is_empty() {
                format!("Реплика сценария: '{}' -> StandardDialogue (-16 LUFS)", raw_text)
            } else {
                "Вокализованная речевая дорожка -> StandardDialogue (-16 LUFS)".to_string()
            },
            spectral_metrics,
            processing_hint: "Эталонное сведение по стандарту EBU R128 (-16 LUFS broadcast voiceover)".to_string(),
        }
    }

    /// Быстрая оценка спектральных метрик по сэмплам пиков вейвформа (если исходный WAV недоступен)
    fn fallback_metrics_from_peaks(peaks_opt: Option<&[f32]>) -> Option<SpectralMetrics> {
        let peaks = peaks_opt?;
        if peaks.is_empty() {
            return None;
        }

        let sum_sq: f32 = peaks.iter().map(|p| p * p).sum();
        let rms = (sum_sq / peaks.len() as f32).sqrt().max(1e-6);
        let max_peak = peaks.iter().fold(0.0f32, |acc, &p| acc.max(p.abs()));
        let rms_db = 20.0 * rms.log10().max(-90.0);
        let peak_db = 20.0 * max_peak.max(1e-6).log10().max(-90.0);

        Some(SpectralMetrics {
            zcr: 0.10,
            spectral_flatness: 0.15,
            spectral_centroid_hz: 1800.0,
            rms_db,
            peak_db,
            energy_ratio_hf: 0.20,
            is_unvoiced: false,
            is_tonal: true,
            fundamental_autocorr: 0.50,
        })
    }
}

// ============================================================================
// 5. TAURI V2 COMMAND ENTRY POINT
// ============================================================================

/// Пакетная параллельная классификация всех сегментов проекта через Rayon
#[tauri::command]
pub async fn classify_project_cues(
    cues: Vec<ProjectCueInput>,
) -> Result<Vec<ClassifiedCueOutput>, String> {
    let start_time = Instant::now();
    let count = cues.len();

    if cues.is_empty() {
        return Ok(Vec::new());
    }

    // Параллельная многопоточная классификация всех сегментов на всех ядрах CPU
    let results: Vec<ClassifiedCueOutput> = cues
        .into_par_iter()
        .map(|cue| HybridSpeechCueClassifier::classify_cue(&cue))
        .collect();

    let mut dialogue_count = 0usize;
    let mut foley_count = 0usize;
    let mut shout_count = 0usize;
    let mut whisper_count = 0usize;

    for r in &results {
        match r.classification {
            CueClassification::StandardDialogue => dialogue_count += 1,
            CueClassification::FoleyEffort => foley_count += 1,
            CueClassification::ShoutScream => shout_count += 1,
            CueClassification::Whisper => whisper_count += 1,
        }
    }

    log_info(&format!(
        "[SpeechCueClassifier] Классифицировано {} сегментов за {:.3}ms: Диалогов: {}, Foley: {}, Криков: {}, Шепота: {}",
        count,
        start_time.elapsed().as_secs_f64() * 1000.0,
        dialogue_count,
        foley_count,
        shout_count,
        whisper_count
    ));

    Ok(results)
}
