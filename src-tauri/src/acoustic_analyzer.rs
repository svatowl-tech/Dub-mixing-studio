// =========================================================================================
// Акустический анализатор оригинального окружения и генератор FX-цепочки (Rust DSP)
// Стек: rustfft = "6.2.0", hound = "3.5.1"
// 
// Математические модели:
// 1. Стерео-панорама и ILD (Interaural Level Difference):
//    ILD = 20 * log10(RMS_R / RMS_L) [dB]
//    Pan = (RMS_R - RMS_L) / (RMS_R + RMS_L) in [-1.0 .. 1.0]
// 2. Direct-to-Reverberant Ratio (DRR) и оценка времени спада T60:
//    - Анализ огибающей энергии в окнах 2048 сэмплов с шагом 512.
//    - Поиск спадов после речевых атак (Schroeder backward integration / Energy Decay Curve).
//    - Оценка наклона затухания d (dB/sec) через линейную регрессию: T60 = -60 / d.
//    - DRR = 10 * log10(E_direct / E_reverberant).
//    - Reverb Wet = clamp(1 / (1 + 10^(DRR / 10)), 0.02, 0.70).
// 3. Спектральный анализ окраски (rustfft):
//    - Вычисление усредненного энергетического спектра через БПФ с окном Ханна.
//    - Спектральный центроид (Spectral Centroid) и эффективная ширина полосы (Bandwidth).
//    - Детекция полосы пропускания:
//      * Телефон / Рация: резкий срез ниже 300 Гц и выше 3400 Гц (доля энергии в полосе > 82%).
//      * Мегафон / Рупор / Шлем: узкая полоса 500–2800 Гц с выраженным резонансным пиком.
//      * Естественный голос: широкополосный спектр (HPF ~60-80 Гц, LPF ~14000-18000 Гц).
// =========================================================================================

use std::f32::consts::PI;
use std::path::Path;
use std::time::Instant;
use hound::{WavReader, SampleFormat};
use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};
use crate::logger::log_debug;

/// Целевые параметры эффектов для передачи в Web Audio API или нативный рендер
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcousticPreset {
    /// Стерео-панорама: -1.0 (полностью влево), 0.0 (центр), 1.0 (полностью вправо)
    pub pan: f32,
    /// Коэффициент подмешивания реверберации (Wet level): от 0.0 до 1.0
    pub reverb_wet: f32,
    /// Время затухания реверберации T60 в миллисекундах (100 .. 4500 ms)
    pub reverb_decay_ms: u32,
    /// Частота среза фильтра высоких частот (High-Pass Filter / Low Cut), Гц
    pub high_pass_hz: f32,
    /// Частота среза фильтра низких частот (Low-Pass Filter / High Cut), Гц
    pub low_pass_hz: f32,
}

impl Default for AcousticPreset {
    fn default() -> Self {
        Self {
            pan: 0.0,
            reverb_wet: 0.08,
            reverb_decay_ms: 350,
            high_pass_hz: 75.0,
            low_pass_hz: 16000.0,
        }
    }
}

/// Полный отчет акустического анализа с диагностическими метриками
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcousticAnalysisReport {
    /// Готовый сгенерированный пресет для цепочки эффектов
    pub preset: AcousticPreset,
    /// Межканальная разница уровней ILD (Interaural Level Difference) в dB
    pub ild_db: f32,
    /// Коэффициент фазовой когерентности / корреляции между каналами (-1.0 .. 1.0)
    pub phase_correlation: f32,
    /// Direct-to-Reverberant Ratio (DRR) в dB (отношение прямого звука к диффузному)
    pub drr_db: f32,
    /// Расчетное время спада реверберации T60 в миллисекундах
    pub t60_ms: u32,
    /// Спектральный центроид (центр тяжести спектра), Гц
    pub spectral_centroid_hz: f32,
    /// Эффективная ширина спектра (Bandwidth -3dB/-12dB), Гц
    pub bandwidth_hz: f32,
    /// Классифицированное акустическое окружение
    pub detected_environment: String,
    /// Флаг узкополосного фильтра рации / телефона (300–3400 Гц)
    pub is_narrowband_comm: bool,
    /// Флаг рупора / мегафона / шлема (узкополосный резонанс)
    pub is_resonant_horn: bool,
    /// Уверенность классификации (0.0 .. 1.0)
    pub confidence: f32,
    /// Время выполнения анализа на CPU в миллисекундах
    pub processing_time_ms: u64,
}

/// Интервал сегмента для покадрового анализа
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSegmentInterval {
    pub id: String,
    pub start_sec: f64,
    pub duration_sec: f64,
    pub text: Option<String>,
}

/// Результат акустического анализа сегмента
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentAcousticResult {
    pub segment_id: String,
    pub report: AcousticAnalysisReport,
}

// =========================================================================================
// 1. МАТЕМАТИЧЕСКИЙ АНАЛИЗ СТЕРЕО-ПАНОРАМЫ И ФАЗЫ (ILD / PANNING)
// =========================================================================================

/// Расчет среднеквадратичного значения (RMS)
#[inline(always)]
fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum_sq / samples.len() as f64).sqrt() as f32
}

/// Вычисление панорамы, ILD и фазовой кросс-корреляции между левым и правым каналами
///
/// Математика:
/// RMS_L = sqrt( (1/N) * sum(L[n]^2) )
/// RMS_R = sqrt( (1/N) * sum(R[n]^2) )
/// ILD = 20 * log10((RMS_R + 1e-7) / (RMS_L + 1e-7))
/// Pan = (RMS_R - RMS_L) / (RMS_R + RMS_L + 1e-7)  ->  [-1.0 .. +1.0]
/// CrossCorrelation = sum(L[n]*R[n]) / (sqrt(sum(L^2) * sum(R^2)) + 1e-7)
fn analyze_stereo_panning(left: &[f32], right: Option<&[f32]>) -> (f32, f32, f32) {
    let r_samples = match right {
        Some(r) if !r.is_empty() => r,
        _ => return (0.0, 0.0, 1.0), // Моно: центр, ILD = 0, корреляция = 1.0
    };

    let len = left.len().min(r_samples.len());
    if len == 0 {
        return (0.0, 0.0, 1.0);
    }

    let rms_l = compute_rms(&left[..len]);
    let rms_r = compute_rms(&r_samples[..len]);

    // Если оба канала практически тишина
    if rms_l < 1e-5 && rms_r < 1e-5 {
        return (0.0, 0.0, 1.0);
    }

    let eps = 1e-7f32;
    let ild_db = 20.0 * ((rms_r + eps) / (rms_l + eps)).log10();
    
    // Акустическая нормализация положения в стереобазе:
    // pan = -1.0 (Left), 0.0 (Center), +1.0 (Right)
    let pan_raw = (rms_r - rms_l) / (rms_r + rms_l + eps);
    let pan = pan_raw.clamp(-1.0, 1.0);

    // Межканальная взаимная корреляция (Interaural Cross-Correlation Coefficient)
    let mut sum_prod = 0.0f64;
    let mut sum_sq_l = 0.0f64;
    let mut sum_sq_r = 0.0f64;

    for i in 0..len {
        let sl = left[i] as f64;
        let sr = r_samples[i] as f64;
        sum_prod += sl * sr;
        sum_sq_l += sl * sl;
        sum_sq_r += sr * sr;
    }

    let denom = (sum_sq_l * sum_sq_r).sqrt() + 1e-9;
    let phase_correlation = (sum_prod / denom).clamp(-1.0, 1.0) as f32;

    (pan, ild_db, phase_correlation)
}

// =========================================================================================
// 2. МАТЕМАТИЧЕСКАЯ ОЦЕНКА РЕЗЕРВА ПРЯМОГО ЗВУКА И ВРЕМЕНИ СПАДА T60 (DRR / REVERB)
// =========================================================================================

/// Оценка Direct-to-Reverberant Ratio (DRR) и времени спада T60 (Schroeder / Decay Slope)
///
/// Математика:
/// Разбиваем монофонический сигнал на короткие фреймы (окна N=1024, перекрытие 50%).
/// Энергия фрейма k: E[k] = sum_{m=0}^{N-1} x[k*H + m]^2
/// В логарифмической шкале: L[k] = 10 * log10(E[k] + eps)
///
/// Определение T60:
/// Находим участки затухания после локальных максимумов (речевых взрывов и гласных):
/// L[k] линейно убывает со временем: L(t) = L_0 - d * t, где d = 60 / T60 (dB/sec).
/// Методом наименьших квадратов определяем наклон спада d:
/// d = cov(t, L) / var(t).
/// T60 = -60 / d.
///
/// Определение DRR:
/// Сравниваем пиковую энергию первого фронта (первые 50 мс прямого звука)
/// со шлейфом затухания диффузного поля (> 50 мс):
/// DRR = 10 * log10(E_early / (E_tail + eps)).
fn estimate_drr_and_t60(samples: &[f32], sample_rate: u32) -> (f32, u32, f32) {
    if samples.len() < (sample_rate as usize / 4) {
        // Слишком короткий фрагмент для надежной реверберации (< 250 мс)
        return (12.0, 250, 0.08);
    }

    let frame_size = 1024;
    let hop_size = 512;
    let num_frames = (samples.len().saturating_sub(frame_size)) / hop_size;

    if num_frames < 8 {
        return (12.0, 250, 0.08);
    }

    let frame_dur_sec = hop_size as f64 / sample_rate as f64;
    let mut energies = Vec::with_capacity(num_frames);
    let mut log_energies = Vec::with_capacity(num_frames);

    let eps = 1e-9f32;
    for k in 0..num_frames {
        let offset = k * hop_size;
        let mut e = 0.0f32;
        for m in 0..frame_size {
            let s = samples[offset + m];
            e += s * s;
        }
        energies.push(e);
        log_energies.push(10.0 * (e + eps).log10());
    }

    // Ищем участки естественного спада энергии (decay segments):
    // Точка старта спада: когда энергия фрейма была выше среднего уровня, а последующие 4-10 фреймов монотонно падают
    let mut t60_estimates = Vec::new();
    let mean_log_e = log_energies.iter().sum::<f32>() / log_energies.len() as f32;

    let mut i = 0;
    while i + 6 < num_frames {
        // Проверяем, является ли i локальным пиком
        if log_energies[i] > mean_log_e && (i == 0 || log_energies[i] >= log_energies[i - 1]) {
            // Ищем длину монотонного затухания
            let mut j = i + 1;
            while j < num_frames && j - i < 20 {
                if log_energies[j] > log_energies[j - 1] + 1.5 {
                    // Новый подъем звука (началась новая фраза), затухание прервано
                    break;
                }
                j += 1;
            }

            let decay_len = j - i;
            if decay_len >= 5 {
                // Линейная регрессия по логарифму энергии
                let mut sum_t = 0.0;
                let mut sum_l = 0.0;
                let mut sum_tt = 0.0;
                let mut sum_tl = 0.0;
                let n_points = decay_len as f64;

                for step in 0..decay_len {
                    let t = step as f64 * frame_dur_sec;
                    let l = log_energies[i + step] as f64;
                    sum_t += t;
                    sum_l += l;
                    sum_tt += t * t;
                    sum_tl += t * l;
                }

                let var_t = sum_tt - (sum_t * sum_t) / n_points;
                let cov_tl = sum_tl - (sum_t * sum_l) / n_points;

                if var_t > 1e-6 {
                    let slope = cov_tl / var_t; // dB per second (отрицательный при спаде)
                    if slope < -5.0 && slope > -400.0 {
                        let t60_est = -60.0 / slope;
                        if t60_est >= 0.10 && t60_est <= 6.0 {
                            t60_estimates.push(t60_est);
                        }
                    }
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }

    // Итоговая оценка T60 (медиана / среднее стабильных измерений)
    let t60_sec = if !t60_estimates.is_empty() {
        t60_estimates.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mid = t60_estimates.len() / 2;
        t60_estimates[mid] as f32
    } else {
        // Дефолтное значение для сухого дикторского звука
        0.32
    };

    let t60_ms = ((t60_sec * 1000.0).round() as u32).clamp(120, 5000);

    // Оценка DRR: отношение пиковой энергии речи (ранний звук) к энергии шлейфа
    let mut sorted_e = energies.clone();
    sorted_e.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let top_e_avg: f32 = sorted_e.iter().rev().take(5.max(sorted_e.len() / 10)).sum::<f32>() / 5.max(sorted_e.len() / 10) as f32;
    let low_e_avg: f32 = sorted_e.iter().take(sorted_e.len() / 2).sum::<f32>() / (sorted_e.len() / 2).max(1) as f32;

    let drr_raw = 10.0 * ((top_e_avg + eps) / (low_e_avg + eps)).log10() - 6.0;
    let drr_db = drr_raw.clamp(-12.0, 30.0);

    // Функция передачи DRR в reverb_wet:
    // DRR > 20 dB -> wet ~0.03..0.06 (очень сухой звук микрофона)
    // DRR ~ 8..14 dB -> wet ~0.10..0.18 (обычная комната)
    // DRR < 0 dB -> wet ~0.40..0.65 (пещера, храм, глубокое эхо)
    let wet_ratio = 1.0 / (1.0 + 10.0f32.powf(drr_db / 10.0));
    let reverb_wet = (wet_ratio * 1.5).clamp(0.02, 0.65);

    (drr_db, t60_ms, reverb_wet)
}

// =========================================================================================
// 3. СПЕКТРАЛЬНЫЙ АНАЛИЗ И КЛАССИФИКАЦИЯ ОКРАСКИ (RUSTFFT / SPECTRAL SHAPING)
// =========================================================================================

#[allow(dead_code)]
struct SpectralMetrics {
    centroid_hz: f32,
    bandwidth_hz: f32,
    sub_energy_ratio: f32,   // < 300 Гц
    mid_energy_ratio: f32,   // 300 - 3400 Гц (речевой телефонный диапазон)
    high_energy_ratio: f32,  // 3400 - 7500 Гц
    air_energy_ratio: f32,   // > 7500 Гц
    hpf_cutoff_hz: f32,      // Расчетная нижняя граница спектра
    lpf_cutoff_hz: f32,      // Расчетная верхняя граница спектра
    is_telephone_band: bool, // Телефон / рация
    is_megaphone: bool,      // Мегафон / рупор
}

/// Вычисление усредненного спектра мощности и формантных границ через rustfft
fn analyze_spectral_coloring(samples: &[f32], sample_rate: u32) -> SpectralMetrics {
    let fft_size = 2048;
    let hop_size = 1024;
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(fft_size);

    let num_bins = fft_size / 2 + 1;
    let freq_step = sample_rate as f32 / fft_size as f32;
    let mut avg_magnitude = vec![0.0f32; num_bins];
    let mut frame_count = 0usize;

    // Окно Ханна: w[n] = 0.5 * (1 - cos(2*pi*n / (N-1)))
    let window: Vec<f32> = (0..fft_size)
        .map(|n| 0.5 * (1.0 - (2.0 * PI * n as f32 / (fft_size - 1) as f32).cos()))
        .collect();

    let mut buffer = vec![Complex32::new(0.0, 0.0); fft_size];
    let num_frames = samples.len().saturating_sub(fft_size) / hop_size;

    for f in 0..num_frames {
        let offset = f * hop_size;
        let frame_samples = &samples[offset..offset + fft_size];

        // Проверка фрейма на достаточный уровень (пропуск тишины)
        let frame_rms = compute_rms(frame_samples);
        if frame_rms < 0.005 {
            continue;
        }

        for (i, &s) in frame_samples.iter().enumerate() {
            buffer[i] = Complex32::new(s * window[i], 0.0);
        }

        fft.process(&mut buffer);

        for i in 0..num_bins {
            let mag = buffer[i].norm();
            avg_magnitude[i] += mag;
        }
        frame_count += 1;
    }

    if frame_count > 0 {
        for mag in &mut avg_magnitude {
            *mag /= frame_count as f32;
        }
    }

    // Расчет полной энергии и распределения по полосам
    let mut total_energy = 0.0f64;
    let mut weighted_freq_sum = 0.0f64;

    let mut sub_energy = 0.0f64;  // < 300 Hz
    let mut mid_energy = 0.0f64;  // 300 .. 3400 Hz
    let mut high_energy = 0.0f64; // 3400 .. 7500 Hz
    let mut air_energy = 0.0f64;  // > 7500 Hz

    for i in 0..num_bins {
        let freq = i as f32 * freq_step;
        let mag = avg_magnitude[i] as f64;
        let pwr = mag * mag;
        total_energy += pwr;
        weighted_freq_sum += (freq as f64) * pwr;

        if freq < 300.0 {
            sub_energy += pwr;
        } else if freq <= 3400.0 {
            mid_energy += pwr;
        } else if freq <= 7500.0 {
            high_energy += pwr;
        } else {
            air_energy += pwr;
        }
    }

    let centroid_hz = if total_energy > 1e-9 {
        (weighted_freq_sum / total_energy) as f32
    } else {
        1200.0
    };

    let sub_ratio = if total_energy > 1e-9 { (sub_energy / total_energy) as f32 } else { 0.1 };
    let mid_ratio = if total_energy > 1e-9 { (mid_energy / total_energy) as f32 } else { 0.7 };
    let high_ratio = if total_energy > 1e-9 { (high_energy / total_energy) as f32 } else { 0.15 };
    let air_ratio = if total_energy > 1e-9 { (air_energy / total_energy) as f32 } else { 0.05 };

    // Расчет эффективной ширины спектра (кумулятивное распределение энергии 5%..95%)
    let mut cum_energy = 0.0f64;
    let mut hpf_cutoff = 75.0f32;
    let mut lpf_cutoff = 16000.0f32;
    let e_5 = total_energy * 0.05;
    let e_95 = total_energy * 0.95;

    for i in 0..num_bins {
        let freq = i as f32 * freq_step;
        let pwr = (avg_magnitude[i] as f64).powi(2);
        cum_energy += pwr;

        if hpf_cutoff == 75.0 && cum_energy >= e_5 {
            hpf_cutoff = freq.max(40.0);
        }
        if cum_energy >= e_95 {
            lpf_cutoff = freq.min(sample_rate as f32 / 2.0);
            break;
        }
    }

    let bandwidth_hz = (lpf_cutoff - hpf_cutoff).max(500.0);

    // Детекция специфических телефонных/радио и мегафонных фильтров:
    // Стандарт телефонного канала: 300–3400 Гц
    // Если в диапазоне 300..3400 Гц сконцентрировано более 80% энергии, а верхов (air_ratio) и саба почти нет
    let is_telephone_band = mid_ratio > 0.80 && air_ratio < 0.035 && sub_ratio < 0.06;

    // Мегафон/рупор: узкий пик в районе 1200-2600 Гц с сильным спадом низа и верха
    let is_megaphone = mid_ratio > 0.85 && sub_ratio < 0.03 && centroid_hz > 1400.0 && bandwidth_hz < 3000.0;

    // Корректировка фильтров среза в зависимости от обнаруженного типа:
    if is_telephone_band {
        hpf_cutoff = 340.0;
        lpf_cutoff = 3400.0;
    } else if is_megaphone {
        hpf_cutoff = 550.0;
        lpf_cutoff = 2800.0;
    } else {
        // Естественный голос: убираем инфразвуковой гул (HPF 60-80 Гц)
        hpf_cutoff = hpf_cutoff.clamp(50.0, 120.0);
        lpf_cutoff = lpf_cutoff.clamp(8000.0, (sample_rate as f32 / 2.0) - 500.0);
    }

    SpectralMetrics {
        centroid_hz,
        bandwidth_hz,
        sub_energy_ratio: sub_ratio,
        mid_energy_ratio: mid_ratio,
        high_energy_ratio: high_ratio,
        air_energy_ratio: air_ratio,
        hpf_cutoff_hz: hpf_cutoff,
        lpf_cutoff_hz: lpf_cutoff,
        is_telephone_band,
        is_megaphone,
    }
}

// =========================================================================================
// 4. ГЛАВНАЯ ФУНКЦИЯ АНАЛИЗА И ФОРМИРОВАНИЯ ПРЕСЕТА
// =========================================================================================

/// Выполняет полный акустический анализ переданных PCM буферов
pub fn analyze_pcm_acoustics(
    samples_left: &[f32],
    samples_right: Option<&[f32]>,
    sample_rate: u32,
) -> AcousticAnalysisReport {
    let start_time = Instant::now();

    // 1. Анализ панорамы и ILD
    let (pan, ild_db, phase_corr) = analyze_stereo_panning(samples_left, samples_right);

    // 2. Моно-микс для оценки реверберации и спектра
    let mono_samples: Vec<f32> = match samples_right {
        Some(r) if !r.is_empty() => {
            let len = samples_left.len().min(r.len());
            samples_left[..len]
                .iter()
                .zip(&r[..len])
                .map(|(&l, &r)| 0.5 * (l + r))
                .collect()
        }
        _ => samples_left.to_vec(),
    };

    // 3. DRR и T60
    let (drr_db, t60_ms, mut reverb_wet) = estimate_drr_and_t60(&mono_samples, sample_rate);

    // 4. Спектральная окраска
    let spec = analyze_spectral_coloring(&mono_samples, sample_rate);

    // 5. Классификация окружения
    let mut detected_env = String::from("Студийный чистый голос");
    let mut confidence = 0.88f32;

    if spec.is_telephone_band {
        detected_env = String::from("Телефон / Рация / Интерком (300–3400 Гц)");
        confidence = 0.94;
        reverb_wet = (reverb_wet * 0.4).min(0.08); // У телефона реверб сухой
    } else if spec.is_megaphone {
        detected_env = String::from("Мегафон / Рупор / Громкоговоритель");
        confidence = 0.92;
        reverb_wet = (reverb_wet * 0.8).max(0.15); // Мегафон имеет отражение рупора
    } else if t60_ms > 2200 || drr_db < -2.0 {
        detected_env = String::from("Большой зал / Храм / Пещера (Глубокая реверберация)");
        confidence = 0.90;
    } else if t60_ms > 900 {
        detected_env = String::from("Помещение / Комната среднего размера");
        confidence = 0.86;
    } else if drr_db > 18.0 && t60_ms < 280 {
        detected_env = String::from("Сухая дикторская кабина (Близкий микрофон)");
        confidence = 0.93;
    }

    let preset = AcousticPreset {
        pan,
        reverb_wet,
        reverb_decay_ms: t60_ms,
        high_pass_hz: spec.hpf_cutoff_hz,
        low_pass_hz: spec.lpf_cutoff_hz,
    };

    let elapsed = start_time.elapsed().as_millis() as u64;

    AcousticAnalysisReport {
        preset,
        ild_db,
        phase_correlation: phase_corr,
        drr_db,
        t60_ms,
        spectral_centroid_hz: spec.centroid_hz,
        bandwidth_hz: spec.bandwidth_hz,
        detected_environment: detected_env,
        is_narrowband_comm: spec.is_telephone_band,
        is_resonant_horn: spec.is_megaphone,
        confidence,
        processing_time_ms: elapsed,
    }
}

/// Загрузка аудиофайла и чтение нужного временного интервала
fn read_wav_segment(
    path: &Path,
    start_sec: Option<f64>,
    duration_sec: Option<f64>,
) -> Result<(Vec<f32>, Option<Vec<f32>>, u32), String> {
    let mut reader = WavReader::open(path)
        .map_err(|e| format!("Ошибка открытия WAV {:?}: {}", path, e))?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels as usize;

    if channels == 0 || sample_rate == 0 {
        return Err("Некорректная спецификация аудиофайла".to_string());
    }

    let samples_f32: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            if bits <= 16 {
                reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / 32768.0).collect()
            } else if bits <= 24 {
                reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 8388608.0).collect()
            } else {
                reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 2147483648.0).collect()
            }
        }
    };

    let total_frames = samples_f32.len() / channels;
    let start_frame = start_sec.map(|s| (s.max(0.0) * sample_rate as f64) as usize).unwrap_or(0);
    let dur_frames = duration_sec.map(|d| (d.max(0.0) * sample_rate as f64) as usize).unwrap_or(total_frames);

    let end_frame = (start_frame + dur_frames).min(total_frames);
    if start_frame >= end_frame {
        return Err("Запрошенный диапазон выходит за пределы аудиофайла".to_string());
    }

    let mut left = Vec::with_capacity(end_frame - start_frame);
    let mut right = if channels >= 2 {
        Some(Vec::with_capacity(end_frame - start_frame))
    } else {
        None
    };

    for f in start_frame..end_frame {
        let idx = f * channels;
        left.push(samples_f32[idx]);
        if let Some(ref mut r) = right {
            r.push(samples_f32[idx + 1]);
        }
    }

    Ok((left, right, sample_rate))
}

// =========================================================================================
// 5. НАЗЕМНЫЕ TAURI КОМАНДЫ (EXPOSED TO FRONTEND)
// =========================================================================================

/// Акустический анализ файла или временного окна
#[tauri::command]
pub async fn analyze_acoustic_environment(
    audio_path: String,
    start_sec: Option<f64>,
    duration_sec: Option<f64>,
) -> Result<AcousticAnalysisReport, String> {
    let norm_path = crate::file_io::normalize_windows_path(&audio_path);
    log_debug(&format!(
        "analyze_acoustic_environment: анализ файла {:?}, start={:?}, dur={:?}",
        norm_path, start_sec, duration_sec
    ));

    tokio::task::spawn_blocking(move || {
        let p = Path::new(&norm_path);
        let (left, right, sample_rate) = read_wav_segment(p, start_sec, duration_sec)?;
        let report = analyze_pcm_acoustics(&left, right.as_deref(), sample_rate);
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Пакетный акустический анализ сегментов оригинального голоса
#[tauri::command]
pub async fn analyze_segments_acoustics(
    audio_path: String,
    intervals: Vec<VoiceSegmentInterval>,
) -> Result<Vec<SegmentAcousticResult>, String> {
    let norm_path = crate::file_io::normalize_windows_path(&audio_path);
    log_debug(&format!(
        "analyze_segments_acoustics: пакетный анализ {} сегментов для {:?}",
        intervals.len(), norm_path
    ));

    tokio::task::spawn_blocking(move || {
        let p = Path::new(&norm_path);
        let mut reader = WavReader::open(p)
            .map_err(|e| format!("Ошибка открытия WAV {:?}: {}", p, e))?;
        let spec = reader.spec();
        let sample_rate = spec.sample_rate;
        let channels = spec.channels as usize;

        let samples_f32: Vec<f32> = match spec.sample_format {
            SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
            SampleFormat::Int => {
                let bits = spec.bits_per_sample;
                if bits <= 16 {
                    reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / 32768.0).collect()
                } else if bits <= 24 {
                    reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 8388608.0).collect()
                } else {
                    reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 2147483648.0).collect()
                }
            }
        };

        let total_frames = samples_f32.len() / channels;
        let mut results = Vec::with_capacity(intervals.len());

        for interval in intervals {
            let start_frame = (interval.start_sec.max(0.0) * sample_rate as f64) as usize;
            let dur_frames = (interval.duration_sec.max(0.0) * sample_rate as f64) as usize;
            let end_frame = (start_frame + dur_frames).min(total_frames);

            if start_frame >= end_frame {
                continue;
            }

            let mut left = Vec::with_capacity(end_frame - start_frame);
            let mut right = if channels >= 2 {
                Some(Vec::with_capacity(end_frame - start_frame))
            } else {
                None
            };

            for f in start_frame..end_frame {
                let idx = f * channels;
                left.push(samples_f32[idx]);
                if let Some(ref mut r) = right {
                    r.push(samples_f32[idx + 1]);
                }
            }

            let report = analyze_pcm_acoustics(&left, right.as_deref(), sample_rate);
            results.push(SegmentAcousticResult {
                segment_id: interval.id,
                report,
            });
        }

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}
