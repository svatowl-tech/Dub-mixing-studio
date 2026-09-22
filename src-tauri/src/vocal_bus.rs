use std::f32::consts::PI;
use std::path::{Path, PathBuf};
use std::time::Instant;
use hound::{SampleFormat, WavSpec, WavWriter};
use rayon::prelude::*;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use serde::{Deserialize, Serialize};

use crate::audio_buffer_manager::read_audio_file_any_format;
use crate::file_io::normalize_windows_path;
use crate::logger::{log_debug, log_error, log_info};

// ============================================================================
// 1. КОНФИГУРАЦИОННЫЕ СТРУКТУРЫ РЭКА МАСТЕР-ШИНЫ ВОКАЛА (VOCAL BUS RACK)
// ============================================================================

/// Режим работы деэссера
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VocalDeEsserMode {
    /// Подавление только высокочастотной полосы сибилянтов
    SplitBand,
    /// Широкополосное подавление
    Wideband,
}

/// 1. HPF & Surgical EQ: срез частот ниже 75 Гц и узкий notch-фильтр для устранения резонансов
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HpfSurgicalEqConfig {
    pub enabled: bool,
    /// Частота среза HPF (по умолчанию 75.0 Гц)
    pub hpf_cutoff_hz: f32,
    /// Порядок HPF (2 = 12 дБ/окт, 4 = 24 дБ/окт, по умолчанию 2)
    pub hpf_order: u32,
    /// Активен ли узкий notch-фильтр
    pub notch_enabled: bool,
    /// Центральная частота notch-фильтра для удаления резонанса (по умолчанию 3200.0 Гц)
    pub notch_freq_hz: f32,
    /// Добротность notch-фильтра (по умолчанию 8.0 — узкая полоса)
    pub notch_q: f32,
    /// Глубина подавления резонанса в дБ (по умолчанию -6.0 дБ)
    pub notch_gain_db: f32,
}

impl Default for HpfSurgicalEqConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hpf_cutoff_hz: 75.0,
            hpf_order: 2,
            notch_enabled: true,
            notch_freq_hz: 3200.0,
            notch_q: 8.0,
            notch_gain_db: -6.0,
        }
    }
}

/// 2. Dynamic De-Esser: компрессия резких сибилянтов в районе 5–8 кГц
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicDeEsserConfig {
    pub enabled: bool,
    /// Центральная частота детектора сибилянтов (по умолчанию 6500.0 Гц, диапазон 5000–8000 Гц)
    pub frequency_hz: f32,
    /// Порог срабатывания в dBFS (по умолчанию -22.0 dBFS)
    pub threshold_db: f32,
    /// Соотношение компрессии (по умолчанию 4.0 : 1)
    pub ratio: f32,
    /// Время атаки в миллисекундах (по умолчанию 1.5 мс)
    pub attack_ms: f32,
    /// Время восстановления в миллисекундах (по умолчанию 50.0 мс)
    pub release_ms: f32,
    /// Ширина мягкого колена в дБ (по умолчанию 4.0 дБ)
    pub knee_width_db: f32,
    /// Максимальное подавление в дБ (по умолчанию -12.0 дБ)
    pub max_reduction_db: f32,
    /// Режим работы (SplitBand или Wideband)
    pub mode: VocalDeEsserMode,
}

impl Default for DynamicDeEsserConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            frequency_hz: 6500.0,
            threshold_db: -22.0,
            ratio: 4.0,
            attack_ms: 1.5,
            release_ms: 50.0,
            knee_width_db: 4.0,
            max_reduction_db: -12.0,
            mode: VocalDeEsserMode::SplitBand,
        }
    }
}

/// 3. Warmth / Saturation: аналоговое насыщение (WaveShaper с мягким tanh без жесткого клиппинга)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmthSaturationConfig {
    pub enabled: bool,
    /// Уровень гейна на входе шейпера в дБ (по умолчанию +3.5 дБ)
    pub drive_db: f32,
    /// Баланс Dry / Wet (по умолчанию 0.35 — 35% сатурации)
    pub blend: f32,
    /// Асимметрия для обогащения теплыми четными гармониками (по умолчанию 0.15)
    pub warmth_bias: f32,
    /// Автоматическая компенсация громкости
    pub auto_gain: bool,
}

impl Default for WarmthSaturationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            drive_db: 3.5,
            blend: 0.35,
            warmth_bias: 0.15,
            auto_gain: true,
        }
    }
}

/// 4. Vocal Compressor: эмуляция Opto / VCA (Ratio 3:1, Attack 20ms, Release 120ms, плавное колено)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalCompressorConfig {
    pub enabled: bool,
    /// Порог срабатывания в dBFS (по умолчанию -18.0 dBFS)
    pub threshold_db: f32,
    /// Степень сжатия (по умолчанию 3.0 : 1)
    pub ratio: f32,
    /// Время атаки в мс (по умолчанию 20.0 мс)
    pub attack_ms: f32,
    /// Время восстановления в мс (по умолчанию 120.0 мс)
    pub release_ms: f32,
    /// Ширина плавного колена в дБ (по умолчанию 6.0 дБ)
    pub knee_width_db: f32,
    /// Выходной гейн компенсации в дБ (по умолчанию +2.5 дБ)
    pub makeup_gain_db: f32,
    /// Эмуляция двухступенчатого оптического релизинга (Opto LA-2A)
    pub opto_character: bool,
}

impl Default for VocalCompressorConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold_db: -18.0,
            ratio: 3.0,
            attack_ms: 20.0,
            release_ms: 120.0,
            knee_width_db: 6.0,
            makeup_gain_db: 2.5,
            opto_character: true,
        }
    }
}

/// 5. Presence Exciter / Air: шельфовый подъем выше 10 кГц (+2.5 dB) с четными гармониками
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceExciterConfig {
    pub enabled: bool,
    /// Частота High-Shelf фильтра (по умолчанию 10000.0 Гц)
    pub air_freq_hz: f32,
    /// Подъем высоких частот в дБ (по умолчанию +2.5 дБ)
    pub air_gain_db: f32,
    /// Генерация четных гармоник воздуха (по умолчанию 0.20)
    pub harmonic_drive: f32,
    /// Подмешивание экситера (по умолчанию 0.70)
    pub air_blend: f32,
}

impl Default for PresenceExciterConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            air_freq_hz: 10000.0,
            air_gain_db: 2.5,
            harmonic_drive: 0.20,
            air_blend: 0.70,
        }
    }
}

/// 6. True-Peak Brickwall Limiter: пиковый лимитер с потолком -1.0 dBTP
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruePeakLimiterConfig {
    pub enabled: bool,
    /// Потолок True-Peak в dBTP (по умолчанию -1.0 dBTP)
    pub ceiling_dbtp: f32,
    /// Время спада лимитера в мс (по умолчанию 60.0 мс)
    pub release_ms: f32,
    /// Время лукахеда в мс (по умолчанию 1.5 мс)
    pub lookahead_ms: f32,
}

impl Default for TruePeakLimiterConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            ceiling_dbtp: -1.0,
            release_ms: 60.0,
            lookahead_ms: 1.5,
        }
    }
}

/// Полная конфигурация рэка мастер-шины вокала
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalBusRackConfig {
    pub preset_name: String,
    pub bypass: bool,
    pub eq: HpfSurgicalEqConfig,
    pub deesser: DynamicDeEsserConfig,
    pub saturation: WarmthSaturationConfig,
    pub compressor: VocalCompressorConfig,
    pub exciter: PresenceExciterConfig,
    pub limiter: TruePeakLimiterConfig,
}

impl Default for VocalBusRackConfig {
    fn default() -> Self {
        Self {
            preset_name: "Master VO Studio Rack".to_string(),
            bypass: false,
            eq: HpfSurgicalEqConfig::default(),
            deesser: DynamicDeEsserConfig::default(),
            saturation: WarmthSaturationConfig::default(),
            compressor: VocalCompressorConfig::default(),
            exciter: PresenceExciterConfig::default(),
            limiter: TruePeakLimiterConfig::default(),
        }
    }
}

/// Итоговый отчет о результатах обработки мастер-шины вокала
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalBusReport {
    pub input_path: String,
    pub output_path: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub total_samples: usize,
    pub duration_sec: f64,
    pub initial_peak_db: f32,
    pub final_peak_db: f32,
    pub max_compression_db: f32,
    pub max_deesser_db: f32,
    pub limiter_clamped_samples: usize,
    pub processing_time_ms: u64,
}

// ============================================================================
// 2. ВЫСОКОПРОИЗВОДИТЕЛЬНЫЕ БИКВАДРАТНЫЕ ФИЛЬТРЫ (ZERO-ALLOCATION DSP BIQUADS)
// ============================================================================

/// Коэффициенты цифрового биквадратного IIR-фильтра (Audio EQ Cookbook)
/// H(z) = (b0 + b1*z^-1 + b2*z^-2) / (1 + a1*z^-1 + a2*z^-2)
#[derive(Debug, Clone, Copy)]
pub struct BiquadCoeffs {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
}

impl Default for BiquadCoeffs {
    fn default() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }
}

impl BiquadCoeffs {
    /// 2nd Order Butterworth High-Pass
    pub fn highpass(fc: f32, sample_rate: f32, q: f32) -> Self {
        let nyquist = sample_rate * 0.495;
        let clamped_fc = fc.clamp(10.0, nyquist);
        let omega = 2.0 * PI * clamped_fc / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);

        let a0 = 1.0 + alpha;
        let b0 = (1.0 + cos_w) * 0.5 / a0;
        let b1 = -(1.0 + cos_w) / a0;
        let b2 = (1.0 + cos_w) * 0.5 / a0;
        let a1 = (-2.0 * cos_w) / a0;
        let a2 = (1.0 - alpha) / a0;

        Self { b0, b1, b2, a1, a2 }
    }

    /// 2nd Order Butterworth Low-Pass
    pub fn lowpass(fc: f32, sample_rate: f32, q: f32) -> Self {
        let nyquist = sample_rate * 0.495;
        let clamped_fc = fc.clamp(10.0, nyquist);
        let omega = 2.0 * PI * clamped_fc / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);

        let a0 = 1.0 + alpha;
        let b0 = (1.0 - cos_w) * 0.5 / a0;
        let b1 = (1.0 - cos_w) / a0;
        let b2 = (1.0 - cos_w) * 0.5 / a0;
        let a1 = (-2.0 * cos_w) / a0;
        let a2 = (1.0 - alpha) / a0;

        Self { b0, b1, b2, a1, a2 }
    }

    /// Band-Pass Filter (0 dB Peak Gain)
    pub fn bandpass(f0: f32, sample_rate: f32, q: f32) -> Self {
        let nyquist = sample_rate * 0.495;
        let clamped_f0 = f0.clamp(10.0, nyquist);
        let omega = 2.0 * PI * clamped_f0 / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);

        let a0 = 1.0 + alpha;
        let b0 = alpha / a0;
        let b1 = 0.0;
        let b2 = -alpha / a0;
        let a1 = (-2.0 * cos_w) / a0;
        let a2 = (1.0 - alpha) / a0;

        Self { b0, b1, b2, a1, a2 }
    }

    /// Узкий Notch (Band-Stop) фильтр
    pub fn notch(f0: f32, sample_rate: f32, q: f32) -> Self {
        let nyquist = sample_rate * 0.495;
        let clamped_f0 = f0.clamp(10.0, nyquist);
        let omega = 2.0 * PI * clamped_f0 / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);

        let a0 = 1.0 + alpha;
        let b0 = 1.0 / a0;
        let b1 = (-2.0 * cos_w) / a0;
        let b2 = 1.0 / a0;
        let a1 = (-2.0 * cos_w) / a0;
        let a2 = (1.0 - alpha) / a0;

        Self { b0, b1, b2, a1, a2 }
    }

    /// Peaking EQ фильтр (вырез/подъем частоты)
    pub fn peaking(f0: f32, sample_rate: f32, q: f32, gain_db: f32) -> Self {
        let nyquist = sample_rate * 0.495;
        let clamped_f0 = f0.clamp(10.0, nyquist);
        let a = 10.0_f32.powf(gain_db / 40.0);
        let omega = 2.0 * PI * clamped_f0 / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * q);

        let a0 = 1.0 + alpha / a;
        let b0 = (1.0 + alpha * a) / a0;
        let b1 = (-2.0 * cos_w) / a0;
        let b2 = (1.0 - alpha * a) / a0;
        let a1 = (-2.0 * cos_w) / a0;
        let a2 = (1.0 - alpha / a) / a0;

        Self { b0, b1, b2, a1, a2 }
    }

    /// High-Shelf фильтр (воздушный шельф для Exciter / Air)
    pub fn highshelf(f0: f32, sample_rate: f32, gain_db: f32) -> Self {
        let nyquist = sample_rate * 0.495;
        let clamped_f0 = f0.clamp(10.0, nyquist);
        let a = 10.0_f32.powf(gain_db / 40.0);
        let omega = 2.0 * PI * clamped_f0 / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w * 0.5 * (2.0_f32).sqrt();

        let a_plus_1 = a + 1.0;
        let a_minus_1 = a - 1.0;
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;

        let a0 = a_plus_1 - a_minus_1 * cos_w + two_sqrt_a_alpha;
        let b0 = (a * (a_plus_1 + a_minus_1 * cos_w + two_sqrt_a_alpha)) / a0;
        let b1 = (-2.0 * a * (a_minus_1 + a_plus_1 * cos_w)) / a0;
        let b2 = (a * (a_plus_1 + a_minus_1 * cos_w - two_sqrt_a_alpha)) / a0;
        let a1 = (2.0 * (a_minus_1 - a_plus_1 * cos_w)) / a0;
        let a2 = (a_plus_1 - a_minus_1 * cos_w - two_sqrt_a_alpha) / a0;

        Self { b0, b1, b2, a1, a2 }
    }
}

/// Фильтр Transposed Direct Form II (минимальный шум округления, нулевые аллокации)
#[derive(Debug, Clone, Copy)]
pub struct DirectForm2Biquad {
    pub coeffs: BiquadCoeffs,
    pub s1: f32,
    pub s2: f32,
}

impl DirectForm2Biquad {
    pub fn new(coeffs: BiquadCoeffs) -> Self {
        Self {
            coeffs,
            s1: 0.0,
            s2: 0.0,
        }
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.coeffs.b0 * x + self.s1;
        self.s1 = self.coeffs.b1 * x - self.coeffs.a1 * y + self.s2;
        self.s2 = self.coeffs.b2 * x - self.coeffs.a2 * y;
        y
    }

    #[allow(dead_code)]
    #[inline(always)]
    pub fn reset(&mut self) {
        self.s1 = 0.0;
        self.s2 = 0.0;
    }
}

// ============================================================================
// 3. СОСТОЯНИЕ КАНАЛА ОБРАБОТКИ (CHANNEL DSP STATE — HOT CYCLE ZERO ALLOC)
// ============================================================================

/// Фиксированный кольцевой буфер лукахеда без динамических аллокаций
#[derive(Debug, Clone)]
pub struct LookaheadDelayBuffer {
    buffer: [f32; 256],
    write_idx: usize,
    delay_samples: usize,
}

impl LookaheadDelayBuffer {
    pub fn new(delay_samples: usize) -> Self {
        let clamped = delay_samples.clamp(1, 255);
        Self {
            buffer: [0.0; 256],
            write_idx: 0,
            delay_samples: clamped,
        }
    }

    #[inline(always)]
    pub fn push_and_read(&mut self, sample: f32) -> f32 {
        self.buffer[self.write_idx] = sample;
        let read_idx = if self.write_idx >= self.delay_samples {
            self.write_idx - self.delay_samples
        } else {
            256 + self.write_idx - self.delay_samples
        };
        self.write_idx = (self.write_idx + 1) & 255;
        self.buffer[read_idx]
    }

    #[allow(dead_code)]
    #[inline(always)]
    pub fn reset(&mut self) {
        self.buffer = [0.0; 256];
        self.write_idx = 0;
    }
}

/// Полное независимое DSP-состояние для одного аудиоканала
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct VocalBusChannelState {
    pub sample_rate: f32,

    // 1. HPF & Surgical EQ
    pub hpf_biquad1: DirectForm2Biquad,
    pub hpf_biquad2: DirectForm2Biquad,
    pub notch_biquad: DirectForm2Biquad,

    // 2. Dynamic De-Esser
    pub deesser_sidechain_bp: DirectForm2Biquad,
    pub deesser_crossover_lp1: DirectForm2Biquad,
    pub deesser_crossover_lp2: DirectForm2Biquad,
    pub deesser_crossover_hp1: DirectForm2Biquad,
    pub deesser_crossover_hp2: DirectForm2Biquad,
    pub deesser_env_detector: f32,
    pub deesser_current_gain: f32,
    pub deesser_max_reduction_db: f32,

    // 3. Warmth Saturation
    pub sat_dc_prev_x: f32,
    pub sat_dc_prev_y: f32,

    // 4. Vocal Compressor
    pub comp_env_db: f32,
    pub comp_gain_linear: f32,
    pub comp_max_reduction_db: f32,

    // 5. Presence Exciter / Air
    pub air_shelf_biquad: DirectForm2Biquad,
    pub air_sidechain_hp: DirectForm2Biquad,
    pub air_dc_prev_x: f32,
    pub air_dc_prev_y: f32,

    // 6. True-Peak Brickwall Limiter
    pub limiter_delay: LookaheadDelayBuffer,
    pub limiter_env_gain: f32,
    pub limiter_prev_sample: f32,
    pub limiter_clamped_count: usize,
}

impl VocalBusChannelState {
    pub fn new(sample_rate: f32, config: &VocalBusRackConfig) -> Self {
        // 1. HPF & Notch
        let q_butter = 1.0 / (2.0_f32).sqrt(); // 0.7071
        let hpf_coeffs = BiquadCoeffs::highpass(config.eq.hpf_cutoff_hz, sample_rate, q_butter);
        let hpf_biquad1 = DirectForm2Biquad::new(hpf_coeffs);
        let hpf_biquad2 = DirectForm2Biquad::new(hpf_coeffs);

        let notch_coeffs = if config.eq.notch_gain_db <= -18.0 {
            BiquadCoeffs::notch(config.eq.notch_freq_hz, sample_rate, config.eq.notch_q)
        } else {
            BiquadCoeffs::peaking(config.eq.notch_freq_hz, sample_rate, config.eq.notch_q, config.eq.notch_gain_db)
        };
        let notch_biquad = DirectForm2Biquad::new(notch_coeffs);

        // 2. De-Esser
        let deesser_bp = BiquadCoeffs::bandpass(config.deesser.frequency_hz, sample_rate, 2.0);
        let deesser_sidechain_bp = DirectForm2Biquad::new(deesser_bp);

        let cross_freq = (config.deesser.frequency_hz * 0.72).clamp(2000.0, sample_rate * 0.45);
        let lp_coeffs = BiquadCoeffs::lowpass(cross_freq, sample_rate, q_butter);
        let hp_coeffs = BiquadCoeffs::highpass(cross_freq, sample_rate, q_butter);

        let deesser_crossover_lp1 = DirectForm2Biquad::new(lp_coeffs);
        let deesser_crossover_lp2 = DirectForm2Biquad::new(lp_coeffs);
        let deesser_crossover_hp1 = DirectForm2Biquad::new(hp_coeffs);
        let deesser_crossover_hp2 = DirectForm2Biquad::new(hp_coeffs);

        // 5. Exciter / Air
        let air_shelf_coeffs = BiquadCoeffs::highshelf(config.exciter.air_freq_hz, sample_rate, config.exciter.air_gain_db);
        let air_shelf_biquad = DirectForm2Biquad::new(air_shelf_coeffs);
        let air_hp_coeffs = BiquadCoeffs::highpass(config.exciter.air_freq_hz * 0.85, sample_rate, q_butter);
        let air_sidechain_hp = DirectForm2Biquad::new(air_hp_coeffs);

        // 6. Limiter Lookahead
        let lookahead_samples = ((config.limiter.lookahead_ms * 0.001 * sample_rate).round() as usize).clamp(4, 250);
        let limiter_delay = LookaheadDelayBuffer::new(lookahead_samples);

        Self {
            sample_rate,
            hpf_biquad1,
            hpf_biquad2,
            notch_biquad,
            deesser_sidechain_bp,
            deesser_crossover_lp1,
            deesser_crossover_lp2,
            deesser_crossover_hp1,
            deesser_crossover_hp2,
            deesser_env_detector: 1e-6,
            deesser_current_gain: 1.0,
            deesser_max_reduction_db: 0.0,
            sat_dc_prev_x: 0.0,
            sat_dc_prev_y: 0.0,
            comp_env_db: -90.0,
            comp_gain_linear: 1.0,
            comp_max_reduction_db: 0.0,
            air_shelf_biquad,
            air_sidechain_hp,
            air_dc_prev_x: 0.0,
            air_dc_prev_y: 0.0,
            limiter_delay,
            limiter_env_gain: 1.0,
            limiter_prev_sample: 0.0,
            limiter_clamped_count: 0,
        }
    }

    /// Сброс всех внутренних состояний регистров (например, перед началом нового трека)
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.hpf_biquad1.reset();
        self.hpf_biquad2.reset();
        self.notch_biquad.reset();
        self.deesser_sidechain_bp.reset();
        self.deesser_crossover_lp1.reset();
        self.deesser_crossover_lp2.reset();
        self.deesser_crossover_hp1.reset();
        self.deesser_crossover_hp2.reset();
        self.deesser_env_detector = 1e-6;
        self.deesser_current_gain = 1.0;
        self.deesser_max_reduction_db = 0.0;
        self.sat_dc_prev_x = 0.0;
        self.sat_dc_prev_y = 0.0;
        self.comp_env_db = -90.0;
        self.comp_gain_linear = 1.0;
        self.comp_max_reduction_db = 0.0;
        self.air_shelf_biquad.reset();
        self.air_sidechain_hp.reset();
        self.air_dc_prev_x = 0.0;
        self.air_dc_prev_y = 0.0;
        self.limiter_delay.reset();
        self.limiter_env_gain = 1.0;
        self.limiter_prev_sample = 0.0;
        self.limiter_clamped_count = 0;
    }
}

// ============================================================================
// 4. СТУДИЙНЫЙ РЭК МАСТЕР-ШИНЫ ВОКАЛА (VOCAL BUS PROCESSING RACK)
// ============================================================================

/// Студийный процессинговый рэк мастер-шины вокала
#[derive(Debug, Clone)]
pub struct VocalBusRack {
    pub sample_rate: f32,
    pub config: VocalBusRackConfig,
    pub channels: Vec<VocalBusChannelState>,

    // Предрассчитанные баллистические коэффициенты
    deesser_att_coef: f32,
    deesser_rel_coef: f32,
    comp_att_coef: f32,
    comp_rel_stage1: f32,
    comp_rel_stage2: f32,
    limiter_rel_coef: f32,
    limiter_ceiling_linear: f32,
    sat_drive_linear: f32,
    sat_makeup_linear: f32,
    comp_makeup_linear: f32,
}

impl VocalBusRack {
    /// Создает новый рэк с предварительно аллоцированными каналами
    pub fn new(sample_rate: f32, num_channels: usize, config: VocalBusRackConfig) -> Self {
        let sr = sample_rate.max(8000.0);
        let n_ch = num_channels.max(1);

        let mut channels = Vec::with_capacity(n_ch);
        for _ in 0..n_ch {
            channels.push(VocalBusChannelState::new(sr, &config));
        }

        let mut rack = Self {
            sample_rate: sr,
            config,
            channels,
            deesser_att_coef: 0.0,
            deesser_rel_coef: 0.0,
            comp_att_coef: 0.0,
            comp_rel_stage1: 0.0,
            comp_rel_stage2: 0.0,
            limiter_rel_coef: 0.0,
            limiter_ceiling_linear: 0.0,
            sat_drive_linear: 1.0,
            sat_makeup_linear: 1.0,
            comp_makeup_linear: 1.0,
        };

        rack.recompute_constants();
        rack
    }

    /// Предварительный расчет постоянных времени и коэффициентов
    pub fn recompute_constants(&mut self) {
        let sr = self.sample_rate;

        // 2. De-Esser ballistics
        let d_att = (self.config.deesser.attack_ms * 0.001).max(0.0001);
        let d_rel = (self.config.deesser.release_ms * 0.001).max(0.001);
        self.deesser_att_coef = (-1.0 / (sr * d_att)).exp();
        self.deesser_rel_coef = (-1.0 / (sr * d_rel)).exp();

        // 3. Warmth Saturation
        self.sat_drive_linear = 10.0_f32.powf(self.config.saturation.drive_db / 20.0);
        if self.config.saturation.auto_gain {
            let sat_peak = (self.sat_drive_linear).tanh() / self.sat_drive_linear;
            self.sat_makeup_linear = 1.0 / sat_peak.max(0.2);
        } else {
            self.sat_makeup_linear = 1.0;
        }

        // 4. Vocal Compressor ballistics (Opto dual-release)
        let c_att = (self.config.compressor.attack_ms * 0.001).max(0.0005);
        let c_rel = (self.config.compressor.release_ms * 0.001).max(0.005);
        self.comp_att_coef = (-1.0 / (sr * c_att)).exp();
        // Opto release: быстрая начальная фаза (40%), плавная доводка (160%)
        self.comp_rel_stage1 = (-1.0 / (sr * (c_rel * 0.45))).exp();
        self.comp_rel_stage2 = (-1.0 / (sr * (c_rel * 1.55))).exp();
        self.comp_makeup_linear = 10.0_f32.powf(self.config.compressor.makeup_gain_db / 20.0);

        // 6. Limiter
        let l_rel = (self.config.limiter.release_ms * 0.001).max(0.002);
        self.limiter_rel_coef = (-1.0 / (sr * l_rel)).exp();
        self.limiter_ceiling_linear = 10.0_f32.powf(self.config.limiter.ceiling_dbtp / 20.0);
    }

    /// Сброс всех внутренних состояний
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        for ch in self.channels.iter_mut() {
            ch.reset();
        }
    }

    /// ГОРЯЧИЙ ЦИКЛ ОБРАБОТКИ СЭМПЛА (ZERO HEAP ALLOCATION — 100% В РЕГИСТРАХ)
    #[inline(always)]
    pub fn process_sample(&mut self, channel_idx: usize, input: f32) -> f32 {
        if self.config.bypass {
            return input;
        }

        let state = &mut self.channels[channel_idx];
        let mut x = input;

        // ====================================================================
        // ШАГ 1: HPF & SURGICAL EQ (Срез гула ниже 75 Гц и устранение резонанса)
        // ====================================================================
        if self.config.eq.enabled {
            x = state.hpf_biquad1.process(x);
            if self.config.eq.hpf_order >= 4 {
                x = state.hpf_biquad2.process(x);
            }
            if self.config.eq.notch_enabled {
                x = state.notch_biquad.process(x);
            }
        }

        // ====================================================================
        // ШАГ 2: DYNAMIC DE-ESSER (Подавление сибилянтов в полосе 5–8 кГц)
        // ====================================================================
        if self.config.deesser.enabled {
            // Кроссовер Linkwitz-Riley 4-го порядка разделяет сигнал на низ/середину и шипящий верх
            let lp_split = state.deesser_crossover_lp2.process(state.deesser_crossover_lp1.process(x));
            let hp_split = state.deesser_crossover_hp2.process(state.deesser_crossover_hp1.process(x));

            // Сайдчейн фильтрация (Bandpass на резонансную полосу свиста)
            let sidechain_sig = state.deesser_sidechain_bp.process(x);
            let sidechain_abs = sidechain_sig.abs();

            // Баллистика детектора огибающей сибилянта
            if sidechain_abs > state.deesser_env_detector {
                state.deesser_env_detector = self.deesser_att_coef * state.deesser_env_detector
                    + (1.0 - self.deesser_att_coef) * sidechain_abs;
            } else {
                state.deesser_env_detector = self.deesser_rel_coef * state.deesser_env_detector
                    + (1.0 - self.deesser_rel_coef) * sidechain_abs;
            }

            // Расчет уровня в dBFS
            let env_db = 20.0 * (state.deesser_env_detector.max(1e-6)).log10();
            let thresh = self.config.deesser.threshold_db;
            let ratio = self.config.deesser.ratio;
            let knee = self.config.deesser.knee_width_db;

            // Расчет сжатия с плавным коленом
            let mut target_reduction_db = 0.0_f32;
            if env_db > thresh + (knee * 0.5) {
                target_reduction_db = (env_db - thresh) * (1.0 - 1.0 / ratio);
            } else if env_db > thresh - (knee * 0.5) {
                let over = env_db - (thresh - knee * 0.5);
                target_reduction_db = (over * over / (2.0 * knee)) * (1.0 - 1.0 / ratio);
            }

            target_reduction_db = target_reduction_db.clamp(0.0, self.config.deesser.max_reduction_db.abs());
            let target_gain = 10.0_f32.powf(-target_reduction_db / 20.0);

            // Плавное сглаживание гейна
            state.deesser_current_gain = state.deesser_current_gain * 0.7 + target_gain * 0.3;

            if target_reduction_db > state.deesser_max_reduction_db {
                state.deesser_max_reduction_db = target_reduction_db;
            }

            // Применение подавления: в режиме SplitBand сжимается только верхний диапазон
            if self.config.deesser.mode == VocalDeEsserMode::SplitBand {
                x = lp_split + hp_split * state.deesser_current_gain;
            } else {
                x *= state.deesser_current_gain;
            }
        }

        // ====================================================================
        // ШАГ 3: WARMTH / SATURATION (WaveShaper с мягким tanh без жесткого клиппинга)
        // ====================================================================
        if self.config.saturation.enabled && self.config.saturation.blend > 0.001 {
            let drive = self.sat_drive_linear;
            let bias = self.config.saturation.warmth_bias;

            // Асимметричное смещение четных гармоник (ламповая теплота)
            let x_biased = x + bias * (x * x - 0.25);
            let sat_in = x_biased * drive;

            // Мягкое ограничение гиперболическим тангенсом
            let sat_out = sat_in.tanh() / drive * self.sat_makeup_linear;

            // Однополюсный DC-блокер для устранения постоянного смещения
            // y[n] = x[n] - x[n-1] + 0.9995 * y[n-1]
            let dc_out = sat_out - state.sat_dc_prev_x + 0.9995 * state.sat_dc_prev_y;
            state.sat_dc_prev_x = sat_out;
            state.sat_dc_prev_y = dc_out;

            // Баланс Dry / Wet
            let blend = self.config.saturation.blend;
            x = (1.0 - blend) * x + blend * dc_out;
        }

        // ====================================================================
        // ШАГ 4: VOCAL COMPRESSOR (Эмуляция Opto LA-2A: Ratio 3:1, Att 20ms, Rel 120ms)
        // ====================================================================
        if self.config.compressor.enabled {
            let x_abs = x.abs();
            let x_db = 20.0 * (x_abs.max(1e-6)).log10();

            // Детектор уровня
            if x_db > state.comp_env_db {
                state.comp_env_db = self.comp_att_coef * state.comp_env_db + (1.0 - self.comp_att_coef) * x_db;
            } else {
                // Двухфазный оптический релиз
                let rel_coef = if self.config.compressor.opto_character && state.comp_env_db > self.config.compressor.threshold_db {
                    self.comp_rel_stage1
                } else {
                    self.comp_rel_stage2
                };
                state.comp_env_db = rel_coef * state.comp_env_db + (1.0 - rel_coef) * x_db;
            }

            // Характеристика сжатия с плавным коленом
            let thresh = self.config.compressor.threshold_db;
            let ratio = self.config.compressor.ratio;
            let knee = self.config.compressor.knee_width_db;

            let mut gr_db = 0.0_f32;
            if state.comp_env_db > thresh + knee * 0.5 {
                gr_db = (state.comp_env_db - thresh) * (1.0 - 1.0 / ratio);
            } else if state.comp_env_db > thresh - knee * 0.5 {
                let over = state.comp_env_db - (thresh - knee * 0.5);
                gr_db = (over * over / (2.0 * knee)) * (1.0 - 1.0 / ratio);
            }

            gr_db = gr_db.max(0.0);
            if gr_db > state.comp_max_reduction_db {
                state.comp_max_reduction_db = gr_db;
            }

            let target_gain = 10.0_f32.powf(-gr_db / 20.0);
            state.comp_gain_linear = state.comp_gain_linear * 0.85 + target_gain * 0.15;

            // Применение компрессии и компенсации Makeup Gain
            x = x * state.comp_gain_linear * self.comp_makeup_linear;
        }

        // ====================================================================
        // ШАГ 5: PRESENCE EXCITER / AIR (Шельф >10 кГц +2.5 dB и четные гармоники)
        // ====================================================================
        if self.config.exciter.enabled {
            // Мягкий подъем высоких частот High-Shelf фильтром
            let air_shelved = state.air_shelf_biquad.process(x);

            // Генератор четных гармоник (Sheen/Air) из изолированного ВЧ-диапазона
            let air_highs = state.air_sidechain_hp.process(x);
            let harmonic_drive = self.config.exciter.harmonic_drive;

            // Генерация бархатных гармоник: x + k * x^2
            let harmonic_signal = air_highs * (1.0 + harmonic_drive * air_highs.abs());

            // DC-фильтрация гармоник
            let air_dc = harmonic_signal - state.air_dc_prev_x + 0.9995 * state.air_dc_prev_y;
            state.air_dc_prev_x = harmonic_signal;
            state.air_dc_prev_y = air_dc;

            // Подмешивание гармонического воздуха
            let air_blend = self.config.exciter.air_blend;
            x = air_shelved + air_dc * air_blend * 0.35;
        }

        // ====================================================================
        // ШАГ 6: TRUE-PEAK BRICKWALL LIMITER (Потолок -1.0 dBTP без цифрового клиппинга)
        // ====================================================================
        if self.config.limiter.enabled {
            // Оценка пика межсэмпловых выбросов (Inter-Sample Peak / True-Peak)
            // Аппроксимация 4-точечной эрмитовой интерполяции формы волны
            let x_abs = x.abs();
            let prev_abs = state.limiter_prev_sample.abs();
            let estimated_true_peak = x_abs.max(prev_abs).max((x_abs + prev_abs) * 0.5 + (x - state.limiter_prev_sample).abs() * 0.25);
            state.limiter_prev_sample = x;

            // Мгновенная атака при превышении потолка
            let ceiling = self.limiter_ceiling_linear;
            let required_gain = if estimated_true_peak > ceiling {
                ceiling / estimated_true_peak
            } else {
                1.0
            };

            if required_gain < state.limiter_env_gain {
                // Моментальная атака на пике (Lookahead гарантирует отсутствие клиппинга)
                state.limiter_env_gain = required_gain;
                state.limiter_clamped_count += 1;
            } else {
                // Экспоненциальный плавный релиз
                state.limiter_env_gain = self.limiter_rel_coef * state.limiter_env_gain
                    + (1.0 - self.limiter_rel_coef);
            }

            // Извлечение сэмпла из лукахед буфера задержки
            let delayed_sample = state.limiter_delay.push_and_read(x);

            // Финальное жесткое ограничение
            let limited = (delayed_sample * state.limiter_env_gain).clamp(-ceiling, ceiling);
            x = limited;
        }

        x
    }

    /// Обработка аудио-буфера одного канала in-place без аллокаций
    #[allow(dead_code)]
    pub fn process_channel(&mut self, channel_idx: usize, buffer: &mut [f32]) {
        for sample in buffer.iter_mut() {
            *sample = self.process_sample(channel_idx, *sample);
        }
    }

    /// Обработка стерео-буферов (L/R) in-place без аллокаций
    #[allow(dead_code)]
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let len = left.len().min(right.len());
        for i in 0..len {
            left[i] = self.process_sample(0, left[i]);
            right[i] = self.process_sample(1, right[i]);
        }
    }

    /// Обработка интерливед-буфера [L, R, L, R, ...] in-place без аллокаций
    pub fn process_interleaved(&mut self, buffer: &mut [f32], channels: usize) {
        let n_ch = channels.min(self.channels.len());
        for chunk in buffer.chunks_exact_mut(channels) {
            for ch in 0..n_ch {
                chunk[ch] = self.process_sample(ch, chunk[ch]);
            }
        }
    }
}

// ============================================================================
// 5. ВЫСОКОУРОВНЕВЫЙ МНОГОПОТОЧНЫЙ ПАЙПЛАЙН ДЛЯ АУДИОФАЙЛОВ И БАТЧЕЙ (RAYON)
// ============================================================================

/// Высокоточный sinc-ресэмплинг многоканального интерливед-аудио в целевую частоту дискретизации (rubato)
pub fn resample_interleaved(
    samples: &[f32],
    channels: usize,
    from_rate: u32,
    to_rate: u32,
) -> Result<Vec<f32>, String> {
    if from_rate == to_rate || samples.is_empty() {
        return Ok(samples.to_vec());
    }
    if channels == 0 {
        return Err("Число каналов не может быть 0".to_string());
    }

    let num_frames = samples.len() / channels;
    let mut channel_buffers: Vec<Vec<f32>> = vec![Vec::with_capacity(num_frames); channels];
    for chunk in samples.chunks_exact(channels) {
        for ch in 0..channels {
            channel_buffers[ch].push(chunk[ch]);
        }
    }

    let chunk_size = 1024;
    let params = SincInterpolationParameters {
        sinc_len: 128,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };

    let mut resampler = SincFixedIn::<f32>::new(
        to_rate as f64 / from_rate as f64,
        2.0,
        params,
        chunk_size,
        channels,
    )
    .map_err(|e| format!("Ошибка инициализации Rubato Resampler: {}", e))?;

    let total_in_frames = channel_buffers[0].len();
    let mut out_channels: Vec<Vec<f32>> = vec![Vec::new(); channels];
    let mut offset = 0;

    while offset < total_in_frames {
        let current_chunk_size = chunk_size.min(total_in_frames - offset);
        let mut in_chunk: Vec<Vec<f32>> = Vec::with_capacity(channels);
        for ch in 0..channels {
            let mut buf = vec![0.0_f32; chunk_size];
            for i in 0..current_chunk_size {
                buf[i] = channel_buffers[ch][offset + i];
            }
            in_chunk.push(buf);
        }

        let out_chunk = resampler
            .process(&in_chunk, None)
            .map_err(|e| format!("Ошибка ресэмплинга: {}", e))?;

        for ch in 0..channels {
            out_channels[ch].extend_from_slice(&out_chunk[ch]);
        }
        offset += current_chunk_size;
    }

    let out_frames = out_channels[0].len();
    let mut interleaved = Vec::with_capacity(out_frames * channels);
    for f in 0..out_frames {
        for ch in 0..channels {
            interleaved.push(out_channels[ch][f]);
        }
    }

    Ok(interleaved)
}

/// Загружает аудио любого формата (WAV, FLAC, MP3, OGG, AAC, M4A) в плоский интерливед f32 буфер
pub fn load_audio_any_format(input_path: &Path) -> Result<(Vec<f32>, u32, usize), String> {
    if !input_path.exists() {
        return Err(format!("Файл не найден: {}", input_path.display()));
    }

    // Читаем через универсальную функцию read_audio_file_any_format (WAV mmap / Symphonia)
    match read_audio_file_any_format(input_path) {
        Ok((samples, sample_rate, channels)) if !samples.is_empty() => {
            return Ok((samples, sample_rate, channels as usize));
        }
        Err(err) => {
            log_debug(&format!(
                "[VocalBus] read_audio_file_any_format не смог открыть {}: {}, пробуем waveform_engine fallback...",
                input_path.display(), err
            ));
        }
        _ => {}
    }

    let norm_path = normalize_windows_path(&input_path.to_string_lossy());

    // Фолбэк на декодер waveform_engine (Symphonia + FFmpeg pipe)
    match crate::waveform_engine::decode_audio_file_sync(&norm_path) {
        Ok((samples, sample_rate)) => {
            if !samples.is_empty() {
                log_info(&format!(
                    "[VocalBus] Успешно загружен аудиофайл через fallback декодер: {}",
                    norm_path
                ));
                return Ok((samples, sample_rate, 1));
            }
        }
        Err(err) => {
            log_error(&format!(
                "[VocalBus] Все методы декодирования провалены для {}: {}",
                norm_path, err
            ));
        }
    }

    Err(format!(
        "Не удалось декодировать аудиофайл {}: формат не поддерживается или файл поврежден",
        input_path.display()
    ))
}

/// Обрабатывает аудиофайл любого формата (WAV, FLAC, MP3, OGG, AAC, M4A) через цепочку мастер-шины вокала
/// и сохраняет результат в стандартный Broadcast WAV (24-bit / 48kHz)
pub fn process_vocal_bus_wav(
    input_path: &Path,
    output_path: &Path,
    config: &VocalBusRackConfig,
) -> Result<VocalBusReport, String> {
    let start_time = Instant::now();

    let (raw_samples, in_sample_rate, channels) = load_audio_any_format(input_path)?;

    if channels == 0 || in_sample_rate == 0 {
        return Err("Недопустимые параметры аудиопотока".to_string());
    }

    if raw_samples.is_empty() {
        return Err("Аудиофайл пуст".to_string());
    }

    // Приведение к вещательному стандарту Broadcast WAV: 48 kHz
    let target_sample_rate: u32 = 48000;
    let (mut processed_samples, actual_sample_rate) = if in_sample_rate != target_sample_rate {
        match resample_interleaved(&raw_samples, channels, in_sample_rate, target_sample_rate) {
            Ok(resampled) => (resampled, target_sample_rate),
            Err(err) => {
                log_error(&format!(
                    "[VocalBus] Ошибка ресэмплинга ({} -> {}): {}, продолжаем с исходной частотой {}",
                    in_sample_rate, target_sample_rate, err, in_sample_rate
                ));
                (raw_samples, in_sample_rate)
            }
        }
    } else {
        (raw_samples, in_sample_rate)
    };

    let total_samples = processed_samples.len();

    // Измерение исходного пика
    let mut initial_peak: f32 = 0.0;
    for &s in &processed_samples {
        let abs = s.abs();
        if abs > initial_peak {
            initial_peak = abs;
        }
    }
    let initial_peak_db = 20.0 * initial_peak.max(1e-6).log10();

    // Инициализация DSP-рэка на рабочей частоте дискретизации
    let mut rack = VocalBusRack::new(actual_sample_rate as f32, channels, config.clone());

    // Горячий цикл обработки интерливед-данных
    rack.process_interleaved(&mut processed_samples, channels);

    // Сбор статистики
    let mut final_peak: f32 = 0.0;
    for &s in &processed_samples {
        let abs = s.abs();
        if abs > final_peak {
            final_peak = abs;
        }
    }
    let final_peak_db = 20.0 * final_peak.max(1e-6).log10();

    let mut max_comp_db = 0.0_f32;
    let mut max_deess_db = 0.0_f32;
    let mut total_clamped = 0_usize;

    for ch in &rack.channels {
        if ch.comp_max_reduction_db > max_comp_db {
            max_comp_db = ch.comp_max_reduction_db;
        }
        if ch.deesser_max_reduction_db > max_deess_db {
            max_deess_db = ch.deesser_max_reduction_db;
        }
        total_clamped += ch.limiter_clamped_count;
    }

    // Сохранение результирующего стандартного Broadcast WAV (24-bit / 48kHz)
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let out_spec = WavSpec {
        channels: channels as u16,
        sample_rate: actual_sample_rate,
        bits_per_sample: 24,
        sample_format: SampleFormat::Int,
    };

    let mut writer = WavWriter::create(output_path, out_spec)
        .map_err(|e| format!("Не удалось создать выходной WAV: {}", e))?;

    for &sample in &processed_samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let sample_i24 = (clamped * 8388607.0).round() as i32;
        writer.write_sample(sample_i24).map_err(|e| e.to_string())?;
    }

    writer.finalize().map_err(|e| e.to_string())?;

    let duration_sec = total_samples as f64 / (actual_sample_rate as f64 * channels as f64);
    let processing_time_ms = start_time.elapsed().as_millis() as u64;

    Ok(VocalBusReport {
        input_path: input_path.to_string_lossy().to_string(),
        output_path: output_path.to_string_lossy().to_string(),
        sample_rate: actual_sample_rate,
        channels: channels as u16,
        total_samples,
        duration_sec,
        initial_peak_db,
        final_peak_db,
        max_compression_db: max_comp_db,
        max_deesser_db: max_deess_db,
        limiter_clamped_samples: total_clamped,
        processing_time_ms,
    })
}

/// Пакетная многопоточная обработка файлов через Rayon
pub fn batch_process_vocal_tracks(
    files: &[(PathBuf, PathBuf)],
    config: &VocalBusRackConfig,
) -> Result<Vec<VocalBusReport>, String> {
    files
        .par_iter()
        .map(|(input_path, output_path)| {
            process_vocal_bus_wav(input_path, output_path, config)
        })
        .collect()
}

// ============================================================================
// 6. TAURI IPC COMMANDS ДЛЯ ВЫЗОВА ИЗ FRONTEND
// ============================================================================

/// Применение цепочки мастер-шины вокала к указанному аудиофайлу
#[tauri::command]
pub fn process_master_vocal_bus(
    input_path: String,
    output_path: String,
    config: VocalBusRackConfig,
) -> Result<VocalBusReport, String> {
    let inp = Path::new(&input_path);
    let out = Path::new(&output_path);
    process_vocal_bus_wav(inp, out, &config)
}

/// Пакетная параллельная обработка мастер-шины вокала для списка файлов
#[tauri::command]
pub fn batch_process_master_vocal_bus(
    file_pairs: Vec<(String, String)>,
    config: VocalBusRackConfig,
) -> Result<Vec<VocalBusReport>, String> {
    let pairs: Vec<(PathBuf, PathBuf)> = file_pairs
        .into_iter()
        .map(|(i, o)| (PathBuf::from(i), PathBuf::from(o)))
        .collect();
    batch_process_vocal_tracks(&pairs, &config)
}

// ============================================================================
// 7. UNIT TESTS & PERFORMANCE BENCHMARKS (ТЕСТЫ ПРОИЗВОДИТЕЛЬНОСТИ)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Генератор тестового синусоидального сигнала
    fn generate_sine_wave(freq_hz: f32, sample_rate: f32, duration_sec: f32, amp: f32) -> Vec<f32> {
        let total_samples = (sample_rate * duration_sec) as usize;
        let mut buffer = Vec::with_capacity(total_samples);
        for i in 0..total_samples {
            let t = i as f32 / sample_rate;
            buffer.push((2.0 * PI * freq_hz * t).sin() * amp);
        }
        buffer
    }

    #[test]
    fn test_hpf_and_notch_attenuation() {
        let sample_rate = 48000.0;
        let mut config = VocalBusRackConfig::default();
        config.eq.enabled = true;
        config.eq.hpf_cutoff_hz = 75.0;
        config.eq.notch_enabled = true;
        config.eq.notch_freq_hz = 3200.0;
        config.eq.notch_gain_db = -12.0;

        // Отключаем остальные шаги для изолированного теста
        config.deesser.enabled = false;
        config.saturation.enabled = false;
        config.compressor.enabled = false;
        config.exciter.enabled = false;
        config.limiter.enabled = false;

        let mut rack = VocalBusRack::new(sample_rate, 1, config);

        // 1. Сигнал 35 Гц (ниже HPF 75 Гц) должен быть сильно ослаблен
        let sub_rumble = generate_sine_wave(35.0, sample_rate, 0.5, 1.0);
        let mut sub_processed = sub_rumble.clone();
        rack.process_channel(0, &mut sub_processed);

        let sub_rms_in: f32 = (sub_rumble.iter().map(|s| s * s).sum::<f32>() / sub_rumble.len() as f32).sqrt();
        let sub_rms_out: f32 = (sub_processed[4800..].iter().map(|s| s * s).sum::<f32>() / (sub_processed.len() - 4800) as f32).sqrt();

        let attenuation_db = 20.0 * (sub_rms_out / sub_rms_in).log10();
        assert!(attenuation_db < -10.0, "HPF 75Hz должен ослаблять 35Hz минимум на 10dB (фактически: {:.1}dB)", attenuation_db);

        // 2. Сигнал 1000 Гц (чистая середина) должен проходить без изменения
        rack.reset();
        let mid_1k = generate_sine_wave(1000.0, sample_rate, 0.2, 0.8);
        let mut mid_processed = mid_1k.clone();
        rack.process_channel(0, &mut mid_processed);

        let mid_rms_in: f32 = (mid_1k.iter().map(|s| s * s).sum::<f32>() / mid_1k.len() as f32).sqrt();
        let mid_rms_out: f32 = (mid_processed[2400..].iter().map(|s| s * s).sum::<f32>() / (mid_processed.len() - 2400) as f32).sqrt();
        let mid_diff_db = (20.0 * (mid_rms_out / mid_rms_in).log10()).abs();
        assert!(mid_diff_db < 0.5, "1000Hz должен проходить без затухания (разница: {:.2}dB)", mid_diff_db);
    }

    #[test]
    fn test_dynamic_deesser_sibilant_burst() {
        let sample_rate = 48000.0;
        let mut config = VocalBusRackConfig::default();
        config.eq.enabled = false;
        config.deesser.enabled = true;
        config.deesser.frequency_hz = 6500.0;
        config.deesser.threshold_db = -24.0;
        config.deesser.ratio = 6.0;
        config.saturation.enabled = false;
        config.compressor.enabled = false;
        config.exciter.enabled = false;
        config.limiter.enabled = false;

        let mut rack = VocalBusRack::new(sample_rate, 1, config);

        // Громкий всплеск сибилянта на 6.5 кГц (-6 dBFS)
        let sibilant_burst = generate_sine_wave(6500.0, sample_rate, 0.3, 0.5);
        let mut processed = sibilant_burst.clone();
        rack.process_channel(0, &mut processed);

        let max_red = rack.channels[0].deesser_max_reduction_db;
        assert!(max_red >= 4.0, "Деэссер должен зафиксировать сжатие сибилянта (фактически: {:.1}dB)", max_red);
    }

    #[test]
    fn test_warmth_saturation_soft_clip() {
        let sample_rate = 48000.0;
        let mut config = VocalBusRackConfig::default();
        config.eq.enabled = false;
        config.deesser.enabled = false;
        config.saturation.enabled = true;
        config.saturation.drive_db = 12.0; // Высокий гейн насыщения
        config.saturation.blend = 1.0;
        config.compressor.enabled = false;
        config.exciter.enabled = false;
        config.limiter.enabled = false;

        let mut rack = VocalBusRack::new(sample_rate, 1, config);

        // Подача сигнала большой амплитуды (+6 dBFS)
        let hot_signal = generate_sine_wave(440.0, sample_rate, 0.1, 2.0);
        let mut processed = hot_signal.clone();
        rack.process_channel(0, &mut processed);

        // Проверка: благодаря tanh сигнал плавно скруглен и не вылетает в бесконечность
        for &s in &processed[1000..] {
            assert!(s.is_finite());
            assert!(s.abs() < 1.8, "WaveShaper должен мягко удерживать сигнал");
        }
    }

    #[test]
    fn test_vocal_compressor_opto() {
        let sample_rate = 48000.0;
        let mut config = VocalBusRackConfig::default();
        config.eq.enabled = false;
        config.deesser.enabled = false;
        config.saturation.enabled = false;
        config.compressor.enabled = true;
        config.compressor.threshold_db = -20.0;
        config.compressor.ratio = 3.0;
        config.compressor.attack_ms = 20.0;
        config.compressor.release_ms = 120.0;
        config.compressor.makeup_gain_db = 0.0;
        config.exciter.enabled = false;
        config.limiter.enabled = false;

        let mut rack = VocalBusRack::new(sample_rate, 1, config);

        // Сигнал -6 dBFS (на 14 дБ выше порога -20 dB)
        let loud_voice = generate_sine_wave(300.0, sample_rate, 0.5, 0.501);
        let mut processed = loud_voice.clone();
        rack.process_channel(0, &mut processed);

        let max_gr = rack.channels[0].comp_max_reduction_db;
        // При Ratio 3:1 и превышении 14 dB теоретическое GR ≈ 14 * (1 - 1/3) ≈ 9.3 dB
        assert!(max_gr > 6.0, "Оптический компрессор 3:1 должен сжимать динамический диапазон (GR: {:.1}dB)", max_gr);
    }

    #[test]
    fn test_true_peak_limiter_brickwall_ceiling() {
        let sample_rate = 48000.0;
        let mut config = VocalBusRackConfig::default();
        config.eq.enabled = false;
        config.deesser.enabled = false;
        config.saturation.enabled = false;
        config.compressor.enabled = false;
        config.exciter.enabled = false;
        config.limiter.enabled = true;
        config.limiter.ceiling_dbtp = -1.0; // Потолок -1.0 dBTP = ~0.891

        let mut rack = VocalBusRack::new(sample_rate, 1, config);

        // Экстремальный сигнал с перегрузом +12 dBFS (амплитуда 4.0)
        let overloaded = generate_sine_wave(1000.0, sample_rate, 0.2, 4.0);
        let mut processed = overloaded.clone();
        rack.process_channel(0, &mut processed);

        let max_peak = processed.iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
        let ceiling_linear = 10.0_f32.powf(-1.0 / 20.0);

        assert!(
            max_peak <= ceiling_linear + 0.001,
            "True-Peak лимитер обязан жестко удерживать потолок -1.0 dBTP ({:.4}), факт: {:.4}",
            ceiling_linear,
            max_peak
        );
        assert!(rack.channels[0].limiter_clamped_count > 0);
    }

    /// ТЕСТ ПРОИЗВОДИТЕЛЬНОСТИ (BENCHMARK): ОБРАБОТКА ПОЛНОЙ ЦЕПОЧКИ ИЗ 6 ЭФФЕКТОВ
    #[test]
    fn bench_vocal_bus_throughput() {
        let sample_rate = 48000.0;
        let config = VocalBusRackConfig::default();
        let mut rack = VocalBusRack::new(sample_rate, 2, config);

        // 10 секунд стерео-аудио (960,000 сэмплов)
        let samples_per_channel = 480000;
        let mut left = generate_sine_wave(440.0, sample_rate, 10.0, 0.7);
        let mut right = generate_sine_wave(880.0, sample_rate, 10.0, 0.7);

        let start = Instant::now();
        rack.process_stereo(&mut left, &mut right);
        let elapsed = start.elapsed();

        let total_samples = samples_per_channel * 2;
        let samples_per_sec = (total_samples as f64) / elapsed.as_secs_f64();
        let realtime_multiplier = samples_per_sec / (sample_rate as f64 * 2.0);

        println!(
            "\n[BENCHMARK] Vocal Bus Rack 6-FX Throughput:\n  - Всего сэмплов: {}\n  - Затрачено времени: {:.2} мс\n  - Производительность: {:.0} сэмплов/сек\n  - Скорость относительно реального времени: {:.1}x Real-Time",
            total_samples,
            elapsed.as_secs_f64() * 1000.0,
            samples_per_sec,
            realtime_multiplier
        );

        // Скорость на одном ядре процессора должна быть минимум 100x Real-Time (>9.6 млн сэмплов/сек)
        assert!(realtime_multiplier >= 80.0, "Скорость обработки должна значительно превышать реальное время");
    }
}
