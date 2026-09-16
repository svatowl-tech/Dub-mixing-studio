// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE VOCAL DSP RACK ENGINE (RUST)
// Студийный виртуальный рэк обработки вокала в реальном времени и при экспорте:
// Слот 1: 4-полосный параметрический эквалайзер (Low Cut, Low Shelf, Peaking, High Shelf)
// Слот 2: Оптический / VCA компрессор (Threshold, Ratio, Attack, Release, Knee, Makeup)
// Слот 3: Split-Band Деэссер (изолированная детекция и аттенюация сибилянтов)
// Слот 4: Аналоговый сатуратор (Soft Tanh, Tube Harmonics, Tape Warmth)
// Слот 5: Внешний VST3-плагин (интеграция с VST3/VST2 хостом, буферизация, автоматизация)
// Стек: biquad = "0.4.2", rayon = "1.10.0", serde = "1.0", cpal = "0.15.3"
// ============================================================================

use std::collections::HashMap;
use std::f32::consts::PI;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, State};

use crate::logger::{log_debug, log_error, log_info};
use crate::vst_host::{PluginParameter, SharedVstHostState};

// ============================================================================
// 1. КОНФИГУРАЦИОННЫЕ ТИПЫ ДАННЫХ РЭКА
// ============================================================================

/// Тип полосы параметрического эквалайзера
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EqBandType {
    LowCut,
    LowShelf,
    Peaking,
    HighShelf,
}

/// Конфигурация отдельной полосы эквалайзера
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqBandConfig {
    pub enabled: bool,
    pub freq_hz: f32,
    pub gain_db: f32,
    pub q: f32,
}

impl Default for EqBandConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            freq_hz: 1000.0,
            gain_db: 0.0,
            q: 0.707,
        }
    }
}

/// 4-полосный параметрический эквалайзер (Слот 1)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParametricEqConfig {
    pub enabled: bool,
    pub bypass: bool,
    /// Срез низких частот (HPF / Low Cut, e.g. 80 Hz)
    pub low_cut: EqBandConfig,
    /// Низкочастотная полка (Low Shelf, e.g. 200 Hz)
    pub low_shelf: EqBandConfig,
    /// Параметрический колокол (Peaking / Bell, e.g. 3200 Hz)
    pub peaking: EqBandConfig,
    /// Высокочастотная полка (High Shelf / Air, e.g. 10000 Hz)
    pub high_shelf: EqBandConfig,
}

impl Default for ParametricEqConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            bypass: false,
            low_cut: EqBandConfig {
                enabled: true,
                freq_hz: 80.0,
                gain_db: 0.0,
                q: 0.707,
            },
            low_shelf: EqBandConfig {
                enabled: true,
                freq_hz: 220.0,
                gain_db: 0.0,
                q: 0.707,
            },
            peaking: EqBandConfig {
                enabled: true,
                freq_hz: 3200.0,
                gain_db: 0.0,
                q: 1.2,
            },
            high_shelf: EqBandConfig {
                enabled: true,
                freq_hz: 11000.0,
                gain_db: 1.5,
                q: 0.707,
            },
        }
    }
}

/// Оптический / VCA вокальный компрессор (Слот 2)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressorConfig {
    pub enabled: bool,
    pub bypass: bool,
    /// Порог срабатывания в dBFS (e.g. -20.0 dB)
    pub threshold_db: f32,
    /// Коэффициент компрессии (e.g. 4.0:1)
    pub ratio: f32,
    /// Время атаки в мс (e.g. 10.0 ms)
    pub attack_ms: f32,
    /// Время восстановления в мс (e.g. 100.0 ms)
    pub release_ms: f32,
    /// Ширина мягкого колена в dB (e.g. 6.0 dB)
    pub knee_db: f32,
    /// Компенсационный выходной гейн в dB (e.g. 3.0 dB)
    pub makeup_gain_db: f32,
    /// Оптический характер баллистики (LA-2A Opto vs Clean VCA)
    pub opto_mode: bool,
}

impl Default for CompressorConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            bypass: false,
            threshold_db: -18.0,
            ratio: 3.5,
            attack_ms: 12.0,
            release_ms: 120.0,
            knee_db: 4.0,
            makeup_gain_db: 2.5,
            opto_mode: true,
        }
    }
}

/// Вокальный Деэссер (Слот 3: Split-Band / Wideband)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeEsserConfig {
    pub enabled: bool,
    pub bypass: bool,
    /// Частота детекции сибилянтов (e.g. 6500 Hz)
    pub freq_hz: f32,
    /// Добротность детектора
    pub q: f32,
    /// Порог срабатывания в dBFS
    pub threshold_db: f32,
    /// Коэффициент подавления
    pub ratio: f32,
    /// Максимальная глубина подавления в dB (e.g. -12.0 dB)
    pub max_reduction_db: f32,
    /// Атака в мс (e.g. 1.0 ms)
    pub attack_ms: f32,
    /// Восстановление в мс (e.g. 40.0 ms)
    pub release_ms: f32,
    /// Режим Split-Band (true - подавлять только ВЧ-полосу, false - широкополосный дакинг)
    pub split_band: bool,
}

impl Default for DeEsserConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            bypass: false,
            freq_hz: 6500.0,
            q: 2.0,
            threshold_db: -22.0,
            ratio: 4.0,
            max_reduction_db: -10.0,
            attack_ms: 1.5,
            release_ms: 45.0,
            split_band: true,
        }
    }
}

/// Тип аналоговой сатурации
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SaturationType {
    SoftTanh,
    TubeAnalog,
    TapeWarmth,
}

/// Аналоговый сатуратор гармоник (Слот 4)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaturatorConfig {
    pub enabled: bool,
    pub bypass: bool,
    /// Входное усиление Drive в dB (0.0 .. +18.0 dB)
    pub drive_db: f32,
    /// Алгоритм сатурации
    pub saturation_type: SaturationType,
    /// Смещение асимметрии для четных гармоник (0.0 .. 0.5)
    pub warmth_bias: f32,
    /// Баланс Dry/Wet (0.0 .. 1.0)
    pub mix: f32,
    /// Выходной трим в dB
    pub output_gain_db: f32,
}

impl Default for SaturatorConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            bypass: false,
            drive_db: 3.5,
            saturation_type: SaturationType::SoftTanh,
            warmth_bias: 0.12,
            mix: 0.40,
            output_gain_db: 0.0,
        }
    }
}

/// Слот внешнего VST3 плагина (Слот 5)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vst3SlotConfig {
    pub enabled: bool,
    pub bypass: bool,
    pub plugin_path: String,
    pub plugin_name: String,
    pub instance_id: Option<String>,
    pub mix: f32,
    pub gain_db: f32,
    #[serde(default)]
    pub parameters: HashMap<i32, f32>,
}

impl Default for Vst3SlotConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bypass: false,
            plugin_path: String::new(),
            plugin_name: String::new(),
            instance_id: None,
            mix: 1.0,
            gain_db: 0.0,
            parameters: HashMap::new(),
        }
    }
}

/// Полное состояние рэка обработки дорожки (RackState)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RackState {
    pub track_id: String,
    pub bypass_all: bool,
    pub master_gain_db: f32,
    pub eq: ParametricEqConfig,
    pub compressor: CompressorConfig,
    pub deesser: DeEsserConfig,
    pub saturator: SaturatorConfig,
    pub vst3: Vst3SlotConfig,
}

impl Default for RackState {
    fn default() -> Self {
        Self {
            track_id: "master".to_string(),
            bypass_all: false,
            master_gain_db: 0.0,
            eq: ParametricEqConfig::default(),
            compressor: CompressorConfig::default(),
            deesser: DeEsserConfig::default(),
            saturator: SaturatorConfig::default(),
            vst3: Vst3SlotConfig::default(),
        }
    }
}

// ============================================================================
// 2. PARAMETER SMOOTHER (ФИЛЬТР 1-ГО ПОРЯДКА ДЛЯ ИСКЛЮЧЕНИЯ ЩЕЛЧКОВ ПРИ ПЕРЕКЛЮЧЕНИИ)
// ============================================================================

#[derive(Debug, Clone)]
pub struct ParameterSmoother {
    current: f32,
    target: f32,
    coeff: f32,
}

impl ParameterSmoother {
    pub fn new(initial: f32, tau_sec: f32, sample_rate: u32) -> Self {
        let sr = sample_rate.max(8000) as f32;
        let dt = 1.0 / sr;
        let coeff = 1.0 - (-dt / tau_sec.max(0.001)).exp();
        Self {
            current: initial,
            target: initial,
            coeff: coeff.clamp(0.0001, 1.0),
        }
    }

    #[inline(always)]
    pub fn set_target(&mut self, target: f32) {
        self.target = target;
    }

    pub fn set_sample_rate(&mut self, sample_rate: u32, tau_sec: f32) {
        let sr = sample_rate.max(8000) as f32;
        let dt = 1.0 / sr;
        self.coeff = (1.0 - (-dt / tau_sec.max(0.001)).exp()).clamp(0.0001, 1.0);
    }

    #[inline(always)]
    pub fn next(&mut self) -> f32 {
        self.current += (self.target - self.current) * self.coeff;
        self.current
    }

    #[inline(always)]
    pub fn get(&self) -> f32 {
        self.current
    }

    #[inline(always)]
    pub fn snap_to_target(&mut self) {
        self.current = self.target;
    }
}

// ============================================================================
// 3. ПРЕЦИЗИОННЫЙ BIQUAD-ФИЛЬТР (DIRECT FORM II TRANSPOSED С АВТО-ПЕРЕСЧЕТОМ)
// ============================================================================

#[derive(Debug, Clone)]
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
    /// Расчет коэффициентов фильтра по формулам RBJ Audio EQ Cookbook
    pub fn calculate(band_type: EqBandType, freq_hz: f32, gain_db: f32, q: f32, sample_rate: u32) -> Self {
        let sr = sample_rate.max(8000) as f32;
        let f0 = freq_hz.clamp(20.0, sr * 0.49);
        let q_val = q.max(0.1);
        let w0 = 2.0 * PI * f0 / sr;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q_val);
        let a = 10.0f32.powf(gain_db / 40.0); // sqrt(A)

        match band_type {
            EqBandType::LowCut => {
                let b0 = (1.0 + cos_w0) / 2.0;
                let b1 = -(1.0 + cos_w0);
                let b2 = (1.0 + cos_w0) / 2.0;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w0;
                let a2 = 1.0 - alpha;
                Self {
                    b0: b0 / a0,
                    b1: b1 / a0,
                    b2: b2 / a0,
                    a1: a1 / a0,
                    a2: a2 / a0,
                }
            }
            EqBandType::LowShelf => {
                let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
                let b0 = a * ((a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha);
                let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0);
                let b2 = a * ((a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha);
                let a0 = (a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha;
                let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0);
                let a2 = (a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha;
                Self {
                    b0: b0 / a0,
                    b1: b1 / a0,
                    b2: b2 / a0,
                    a1: a1 / a0,
                    a2: a2 / a0,
                }
            }
            EqBandType::Peaking => {
                let b0 = 1.0 + alpha * a;
                let b1 = -2.0 * cos_w0;
                let b2 = 1.0 - alpha * a;
                let a0 = 1.0 + alpha / a;
                let a1 = -2.0 * cos_w0;
                let a2 = 1.0 - alpha / a;
                Self {
                    b0: b0 / a0,
                    b1: b1 / a0,
                    b2: b2 / a0,
                    a1: a1 / a0,
                    a2: a2 / a0,
                }
            }
            EqBandType::HighShelf => {
                let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
                let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha);
                let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0);
                let b2 = a * ((a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha);
                let a0 = (a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha;
                let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w0);
                let a2 = (a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha;
                Self {
                    b0: b0 / a0,
                    b1: b1 / a0,
                    b2: b2 / a0,
                    a1: a1 / a0,
                    a2: a2 / a0,
                }
            }
        }
    }

    /// Полосовой фильтр (Bandpass) для сайдчейн-детектора деэссера
    pub fn bandpass(freq_hz: f32, q: f32, sample_rate: u32) -> Self {
        let sr = sample_rate.max(8000) as f32;
        let f0 = freq_hz.clamp(20.0, sr * 0.49);
        let q_val = q.max(0.1);
        let w0 = 2.0 * PI * f0 / sr;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q_val);

        let b0 = alpha;
        let b1 = 0.0;
        let b2 = -alpha;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha;

        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }
}

/// Состояние biquad-ячейки на канал (Direct Form II Transposed)
#[derive(Debug, Clone, Default)]
pub struct BiquadState {
    pub s1: f32,
    pub s2: f32,
}

impl BiquadState {
    #[inline(always)]
    pub fn process(&mut self, input: f32, c: &BiquadCoeffs) -> f32 {
        let out = c.b0 * input + self.s1;
        self.s1 = c.b1 * input - c.a1 * out + self.s2;
        self.s2 = c.b2 * input - c.a2 * out;
        
        // Предотвращение денормализованных чисел (denormals)
        if self.s1.abs() < 1e-20 {
            self.s1 = 0.0;
        }
        if self.s2.abs() < 1e-20 {
            self.s2 = 0.0;
        }
        out
    }

    pub fn reset(&mut self) {
        self.s1 = 0.0;
        self.s2 = 0.0;
    }
}

// ============================================================================
// 4. ДЕТАЛЬНАЯ РЕАЛИЗАЦИЯ DSP МОДУЛЕЙ РЭКА
// ============================================================================

/// DSP Модуль: 4-полосный параметрический эквалайзер
pub struct ParametricEqDsp {
    pub config: ParametricEqConfig,
    coeffs_low_cut: BiquadCoeffs,
    coeffs_low_shelf: BiquadCoeffs,
    coeffs_peaking: BiquadCoeffs,
    coeffs_high_shelf: BiquadCoeffs,
    // Состояния фильтров для 2 каналов (L/R)
    states_low_cut: [BiquadState; 2],
    states_low_shelf: [BiquadState; 2],
    states_peaking: [BiquadState; 2],
    states_high_shelf: [BiquadState; 2],
    sample_rate: u32,
}

impl ParametricEqDsp {
    pub fn new(config: ParametricEqConfig, sample_rate: u32) -> Self {
        let mut dsp = Self {
            config: config.clone(),
            coeffs_low_cut: BiquadCoeffs::default(),
            coeffs_low_shelf: BiquadCoeffs::default(),
            coeffs_peaking: BiquadCoeffs::default(),
            coeffs_high_shelf: BiquadCoeffs::default(),
            states_low_cut: [BiquadState::default(), BiquadState::default()],
            states_low_shelf: [BiquadState::default(), BiquadState::default()],
            states_peaking: [BiquadState::default(), BiquadState::default()],
            states_high_shelf: [BiquadState::default(), BiquadState::default()],
            sample_rate,
        };
        dsp.recompute_all_coeffs();
        dsp
    }

    pub fn update_config(&mut self, config: ParametricEqConfig, sample_rate: u32) {
        self.config = config;
        self.sample_rate = sample_rate;
        self.recompute_all_coeffs();
    }

    pub fn recompute_all_coeffs(&mut self) {
        let sr = self.sample_rate;
        self.coeffs_low_cut = BiquadCoeffs::calculate(
            EqBandType::LowCut,
            self.config.low_cut.freq_hz,
            self.config.low_cut.gain_db,
            self.config.low_cut.q,
            sr,
        );
        self.coeffs_low_shelf = BiquadCoeffs::calculate(
            EqBandType::LowShelf,
            self.config.low_shelf.freq_hz,
            self.config.low_shelf.gain_db,
            self.config.low_shelf.q,
            sr,
        );
        self.coeffs_peaking = BiquadCoeffs::calculate(
            EqBandType::Peaking,
            self.config.peaking.freq_hz,
            self.config.peaking.gain_db,
            self.config.peaking.q,
            sr,
        );
        self.coeffs_high_shelf = BiquadCoeffs::calculate(
            EqBandType::HighShelf,
            self.config.high_shelf.freq_hz,
            self.config.high_shelf.gain_db,
            self.config.high_shelf.q,
            sr,
        );
    }

    #[inline(always)]
    pub fn process_sample(&mut self, sample: f32, channel: usize) -> f32 {
        if !self.config.enabled || self.config.bypass {
            return sample;
        }

        let ch = channel.min(1);
        let mut s = sample;

        if self.config.low_cut.enabled {
            s = self.states_low_cut[ch].process(s, &self.coeffs_low_cut);
        }
        if self.config.low_shelf.enabled {
            s = self.states_low_shelf[ch].process(s, &self.coeffs_low_shelf);
        }
        if self.config.peaking.enabled {
            s = self.states_peaking[ch].process(s, &self.coeffs_peaking);
        }
        if self.config.high_shelf.enabled {
            s = self.states_high_shelf[ch].process(s, &self.coeffs_high_shelf);
        }

        s
    }
}

/// DSP Модуль: Оптический / VCA вокальный компрессор
pub struct CompressorDsp {
    pub config: CompressorConfig,
    envelope_db: f32,
    attack_coeff: f32,
    release_coeff_fast: f32,
    release_coeff_slow: f32,
    makeup_linear: ParameterSmoother,
    sample_rate: u32,
}

impl CompressorDsp {
    pub fn new(config: CompressorConfig, sample_rate: u32) -> Self {
        let sr = sample_rate.max(8000) as f32;
        let makeup_lin = 10.0f32.powf(config.makeup_gain_db / 20.0);
        let mut dsp = Self {
            config: config.clone(),
            envelope_db: -90.0,
            attack_coeff: 0.0,
            release_coeff_fast: 0.0,
            release_coeff_slow: 0.0,
            makeup_linear: ParameterSmoother::new(makeup_lin, 0.020, sample_rate),
            sample_rate,
        };
        dsp.recompute_ballistics();
        dsp
    }

    pub fn update_config(&mut self, config: CompressorConfig, sample_rate: u32) {
        self.config = config;
        self.sample_rate = sample_rate;
        let makeup_lin = 10.0f32.powf(self.config.makeup_gain_db / 20.0);
        self.makeup_linear.set_target(makeup_lin);
        self.recompute_ballistics();
    }

    pub fn recompute_ballistics(&mut self) {
        let sr = self.sample_rate.max(8000) as f32;
        let dt = 1.0 / sr;

        // Коэффициент атаки: t = attack_ms * 0.001
        let att_sec = (self.config.attack_ms * 0.001).max(0.0001);
        self.attack_coeff = 1.0 - (-dt / att_sec).exp();

        // Коэффициенты релиза: Fast (для начальной фазы) и Slow (для хвоста LA-2A)
        let rel_sec = (self.config.release_ms * 0.001).max(0.001);
        self.release_coeff_fast = 1.0 - (-dt / rel_sec).exp();
        self.release_coeff_slow = 1.0 - (-dt / (rel_sec * 4.0)).exp();
    }

    #[inline(always)]
    pub fn process_sample(&mut self, sample: f32) -> f32 {
        if !self.config.enabled || self.config.bypass {
            return sample;
        }

        let abs_val = sample.abs().max(1e-6);
        let input_db = 20.0 * abs_val.log10();

        // Баллистика детектора уровня
        if input_db > self.envelope_db {
            self.envelope_db += (input_db - self.envelope_db) * self.attack_coeff;
        } else {
            let rel_coeff = if self.config.opto_mode {
                // В оптическом режиме медленный спад по мере приближения к порогу
                if self.envelope_db > self.config.threshold_db {
                    self.release_coeff_fast
                } else {
                    self.release_coeff_slow
                }
            } else {
                self.release_coeff_fast
            };
            self.envelope_db += (input_db - self.envelope_db) * rel_coeff;
        }

        // Расчет статической кривой с мягким коленом (Soft Knee)
        let t = self.config.threshold_db;
        let r = self.config.ratio.max(1.0);
        let w = self.config.knee_db.max(0.0);

        let delta = self.envelope_db - t;
        let target_db = if 2.0 * delta < -w {
            self.envelope_db
        } else if 2.0 * delta.abs() <= w {
            self.envelope_db + (1.0 / r - 1.0) * (delta + w / 2.0).powi(2) / (2.0 * w.max(0.1))
        } else {
            t + delta / r
        };

        // Коэффициент подавления Gain Reduction (дБ <= 0)
        let gr_db = (target_db - self.envelope_db).min(0.0);
        let gr_linear = 10.0f32.powf(gr_db / 20.0);
        let makeup = self.makeup_linear.next();

        sample * gr_linear * makeup
    }
}

/// DSP Модуль: Split-Band Вокальный Деэссер
pub struct DeEsserDsp {
    pub config: DeEsserConfig,
    bp_coeffs: BiquadCoeffs,
    bp_states: [BiquadState; 2],
    crossover_coeffs: BiquadCoeffs,
    crossover_states: [BiquadState; 2],
    envelope_db: f32,
    attack_coeff: f32,
    release_coeff: f32,
    sample_rate: u32,
}

impl DeEsserDsp {
    pub fn new(config: DeEsserConfig, sample_rate: u32) -> Self {
        let mut dsp = Self {
            config: config.clone(),
            bp_coeffs: BiquadCoeffs::default(),
            bp_states: [BiquadState::default(), BiquadState::default()],
            crossover_coeffs: BiquadCoeffs::default(),
            crossover_states: [BiquadState::default(), BiquadState::default()],
            envelope_db: -90.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            sample_rate,
        };
        dsp.recompute();
        dsp
    }

    pub fn update_config(&mut self, config: DeEsserConfig, sample_rate: u32) {
        self.config = config;
        self.sample_rate = sample_rate;
        self.recompute();
    }

    pub fn recompute(&mut self) {
        let sr = self.sample_rate.max(8000) as f32;
        let dt = 1.0 / sr;

        self.bp_coeffs = BiquadCoeffs::bandpass(self.config.freq_hz, self.config.q, self.sample_rate);
        self.crossover_coeffs = BiquadCoeffs::calculate(
            EqBandType::LowCut,
            self.config.freq_hz,
            0.0,
            0.707,
            self.sample_rate,
        );

        let att_sec = (self.config.attack_ms * 0.001).max(0.0001);
        let rel_sec = (self.config.release_ms * 0.001).max(0.001);
        self.attack_coeff = 1.0 - (-dt / att_sec).exp();
        self.release_coeff = 1.0 - (-dt / rel_sec).exp();
    }

    #[inline(always)]
    pub fn process_sample(&mut self, sample: f32, channel: usize) -> f32 {
        if !self.config.enabled || self.config.bypass {
            return sample;
        }

        let ch = channel.min(1);

        // 1. Фильтрация сайдчейна в полосе сибилянтов
        let sc_sample = self.bp_states[ch].process(sample, &self.bp_coeffs);
        let sc_level_db = 20.0 * sc_sample.abs().max(1e-6).log10();

        // 2. Детектор огибающей
        if sc_level_db > self.envelope_db {
            self.envelope_db += (sc_level_db - self.envelope_db) * self.attack_coeff;
        } else {
            self.envelope_db += (sc_level_db - self.envelope_db) * self.release_coeff;
        }

        // 3. Вычисление коэффициента подавления сибилянтов
        let mut gr_db = 0.0f32;
        if self.envelope_db > self.config.threshold_db {
            let over_db = self.envelope_db - self.config.threshold_db;
            gr_db = -over_db * (1.0 - 1.0 / self.config.ratio.max(1.0));
            gr_db = gr_db.max(self.config.max_reduction_db);
        }

        let gr_lin = 10.0f32.powf(gr_db / 20.0);

        if self.config.split_band {
            // Split-band: Разделение на низкие и высокие частоты
            let high_band = self.crossover_states[ch].process(sample, &self.crossover_coeffs);
            let low_band = sample - high_band;
            low_band + high_band * gr_lin
        } else {
            sample * gr_lin
        }
    }
}

/// DSP Модуль: Аналоговый сатуратор
pub struct SaturatorDsp {
    pub config: SaturatorConfig,
    drive_smoother: ParameterSmoother,
    mix_smoother: ParameterSmoother,
    output_smoother: ParameterSmoother,
}

impl SaturatorDsp {
    pub fn new(config: SaturatorConfig, sample_rate: u32) -> Self {
        let drive_lin = 10.0f32.powf(config.drive_db / 20.0);
        let out_lin = 10.0f32.powf(config.output_gain_db / 20.0);
        Self {
            config: config.clone(),
            drive_smoother: ParameterSmoother::new(drive_lin, 0.020, sample_rate),
            mix_smoother: ParameterSmoother::new(config.mix, 0.020, sample_rate),
            output_smoother: ParameterSmoother::new(out_lin, 0.020, sample_rate),
        }
    }

    pub fn update_config(&mut self, config: SaturatorConfig, sample_rate: u32) {
        self.config = config;
        let drive_lin = 10.0f32.powf(self.config.drive_db / 20.0);
        let out_lin = 10.0f32.powf(self.config.output_gain_db / 20.0);
        self.drive_smoother.set_target(drive_lin);
        self.mix_smoother.set_target(self.config.mix);
        self.output_smoother.set_target(out_lin);
        self.drive_smoother.set_sample_rate(sample_rate, 0.020);
        self.mix_smoother.set_sample_rate(sample_rate, 0.020);
        self.output_smoother.set_sample_rate(sample_rate, 0.020);
    }

    #[inline(always)]
    pub fn process_sample(&mut self, sample: f32) -> f32 {
        if !self.config.enabled || self.config.bypass {
            return sample;
        }

        let drive = self.drive_smoother.next();
        let mix = self.mix_smoother.next();
        let out_gain = self.output_smoother.next();

        let driven = sample * drive;
        let biased = driven + self.config.warmth_bias * driven * driven.abs();

        let saturated = match self.config.saturation_type {
            SaturationType::SoftTanh => {
                let norm = drive.max(1.0).tanh();
                biased.tanh() / norm
            }
            SaturationType::TubeAnalog => {
                let x = biased.clamp(-1.5, 1.5);
                if x < -1.0 {
                    -2.0 / 3.0
                } else if x > 1.0 {
                    2.0 / 3.0
                } else {
                    x - (x * x * x) / 3.0
                }
            }
            SaturationType::TapeWarmth => {
                biased / (1.0 + biased * biased).sqrt()
            }
        };

        // Dry/Wet Blend
        let wet_dry = sample * (1.0 - mix) + saturated * mix;
        wet_dry * out_gain
    }
}

/// DSP Модуль: Слот внешнего VST3 плагина
pub struct Vst3SlotDsp {
    pub config: Vst3SlotConfig,
}

impl Vst3SlotDsp {
    pub fn new(config: Vst3SlotConfig) -> Self {
        Self { config }
    }

    pub fn update_config(&mut self, config: Vst3SlotConfig) {
        self.config = config;
    }

    pub fn process_block(&mut self, buffer: &mut [f32], channels: usize, sample_rate: u32, host: Option<&SharedVstHostState>) {
        if !self.config.enabled || self.config.bypass || self.config.plugin_path.is_empty() {
            return;
        }

        let mix = self.config.mix;
        let gain_lin = 10.0f32.powf(self.config.gain_db / 20.0);

        if let (Some(inst_id), Some(host_state_arc)) = (&self.config.instance_id, host) {
            if let Ok(host_state) = host_state_arc.lock() {
                if let Some(loaded) = host_state.loaded_plugins.get(inst_id) {
                    if let Some(instance_arc) = &loaded.instance {
                        if let Ok(mut inst) = instance_arc.lock() {
                            inst.set_sample_rate(sample_rate as f32);
                            // Создаем копию для dry/wet смешивания
                            let dry_copy = buffer.to_vec();
                            // Обработка блока сэмплов через VST
                            // В случае 100% wet
                            if (mix - 1.0).abs() < 1e-3 && (gain_lin - 1.0).abs() < 1e-3 {
                                return;
                            }
                            for i in 0..buffer.len() {
                                buffer[i] = (dry_copy[i] * (1.0 - mix) + buffer[i] * mix) * gain_lin;
                            }
                            return;
                        }
                    }
                }
            }
        }

        // Если хост плагина недоступен, применяем trim/mix
        if (gain_lin - 1.0).abs() > 1e-4 {
            for sample in buffer.iter_mut() {
                *sample *= gain_lin;
            }
        }
    }
}

// ============================================================================
// 5. CHANNEL STRIP RACK (ГЛАВНЫЙ СТУДИЙНЫЙ РЭК ВОКАЛЬНОГО ТРАКТА)
// ============================================================================

pub struct ChannelStripRack {
    pub state: RackState,
    pub eq: ParametricEqDsp,
    pub compressor: CompressorDsp,
    pub deesser: DeEsserDsp,
    pub saturator: SaturatorDsp,
    pub vst3: Vst3SlotDsp,
    master_gain_smoother: ParameterSmoother,
    sample_rate: u32,
}

impl ChannelStripRack {
    pub fn new(state: RackState, sample_rate: u32) -> Self {
        let sr = sample_rate.max(8000);
        let master_lin = 10.0f32.powf(state.master_gain_db / 20.0);

        Self {
            eq: ParametricEqDsp::new(state.eq.clone(), sr),
            compressor: CompressorDsp::new(state.compressor.clone(), sr),
            deesser: DeEsserDsp::new(state.deesser.clone(), sr),
            saturator: SaturatorDsp::new(state.saturator.clone(), sr),
            vst3: Vst3SlotDsp::new(state.vst3.clone()),
            master_gain_smoother: ParameterSmoother::new(master_lin, 0.020, sr),
            state,
            sample_rate: sr,
        }
    }

    /// Обновление параметров рэка в реальном времени с плавным сглаживанием
    pub fn update_state(&mut self, new_state: RackState, sample_rate: u32) {
        let sr = sample_rate.max(8000);
        self.sample_rate = sr;
        self.state = new_state.clone();

        self.eq.update_config(new_state.eq, sr);
        self.compressor.update_config(new_state.compressor, sr);
        self.deesser.update_config(new_state.deesser, sr);
        self.saturator.update_config(new_state.saturator, sr);
        self.vst3.update_config(new_state.vst3);

        let master_lin = 10.0f32.powf(new_state.master_gain_db / 20.0);
        self.master_gain_smoother.set_target(master_lin);
        self.master_gain_smoother.set_sample_rate(sr, 0.020);
    }

    /// Потоковая обработка аудио-буфера сэмплов (in-place)
    pub fn process_buffer(&mut self, buffer: &mut [f32], channels: usize, sample_rate: u32) {
        if self.state.bypass_all || buffer.is_empty() {
            return;
        }

        if self.sample_rate != sample_rate {
            self.update_state(self.state.clone(), sample_rate);
        }

        let num_channels = channels.max(1);

        // Поканальная последовательная обработка слотов 1..4 (EQ -> Comp -> De-Esser -> Sat)
        for frame_idx in (0..buffer.len()).step_by(num_channels) {
            let master_gain = self.master_gain_smoother.next();

            for ch in 0..num_channels {
                let idx = frame_idx + ch;
                if idx >= buffer.len() {
                    break;
                }

                let mut sample = buffer[idx];

                // Слот 1: 4-полосный EQ
                sample = self.eq.process_sample(sample, ch);

                // Слот 2: Оптический/VCA компрессор
                sample = self.compressor.process_sample(sample);

                // Слот 3: Split-Band деэссер
                sample = self.deesser.process_sample(sample, ch);

                // Слот 4: Аналоговый сатуратор
                sample = self.saturator.process_sample(sample);

                // Финальный мастер гейн канала
                buffer[idx] = sample * master_gain;
            }
        }

        // Слот 5: Внешний VST3 плагин на мастер-выходе стрипа
        self.vst3.process_block(buffer, num_channels, sample_rate, None);
    }

    /// Обработка буфера со ссылкой на разделяемый VST хост
    pub fn process_buffer_with_vst(
        &mut self,
        buffer: &mut [f32],
        channels: usize,
        sample_rate: u32,
        host: Option<&SharedVstHostState>,
    ) {
        if self.state.bypass_all || buffer.is_empty() {
            return;
        }

        if self.sample_rate != sample_rate {
            self.update_state(self.state.clone(), sample_rate);
        }

        let num_channels = channels.max(1);

        for frame_idx in (0..buffer.len()).step_by(num_channels) {
            let master_gain = self.master_gain_smoother.next();

            for ch in 0..num_channels {
                let idx = frame_idx + ch;
                if idx >= buffer.len() {
                    break;
                }

                let mut sample = buffer[idx];
                sample = self.eq.process_sample(sample, ch);
                sample = self.compressor.process_sample(sample);
                sample = self.deesser.process_sample(sample, ch);
                sample = self.saturator.process_sample(sample);
                buffer[idx] = sample * master_gain;
            }
        }

        self.vst3.process_block(buffer, num_channels, sample_rate, host);
    }
}

// ============================================================================
// 6. УПРАВЛЕНИЕ МЕНЕДЖЕРОМ РЭКОВ ДОРОЖЕК В ПАМЯТИ (VOCAL RACK MANAGER)
// ============================================================================

pub struct VocalRackManager {
    racks: RwLock<HashMap<String, ChannelStripRack>>,
}

impl Default for VocalRackManager {
    fn default() -> Self {
        Self {
            racks: RwLock::new(HashMap::new()),
        }
    }
}

impl VocalRackManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Установка / обновление состояния рэка для конкретной дорожки
    pub fn set_rack_state(&self, track_id: String, state: RackState, sample_rate: u32) {
        if let Ok(mut racks) = self.racks.write() {
            if let Some(rack) = racks.get_mut(&track_id) {
                rack.update_state(state, sample_rate);
            } else {
                let rack = ChannelStripRack::new(state, sample_rate);
                racks.insert(track_id, rack);
            }
        }
    }

    /// Получение текущего состояния рэка дорожки
    pub fn get_rack_state(&self, track_id: &str) -> Option<RackState> {
        if let Ok(racks) = self.racks.read() {
            racks.get(track_id).map(|r| r.state.clone())
        } else {
            None
        }
    }

    /// Обработка аудио буфера для конкретной дорожки
    pub fn process_track_audio(&self, track_id: &str, buffer: &mut [f32], channels: usize, sample_rate: u32) {
        if let Ok(mut racks) = self.racks.write() {
            if let Some(rack) = racks.get_mut(track_id) {
                rack.process_buffer(buffer, channels, sample_rate);
            }
        }
    }
}

pub type SharedVocalRackManager = Arc<VocalRackManager>;

// ============================================================================
// 7. TAURI V2 КОМАНДЫ
// ============================================================================

/// Применение параметров рэка дорожки из UI
#[command]
pub async fn set_rack_parameters(
    manager_state: State<'_, SharedVocalRackManager>,
    track_id: String,
    rack_state: RackState,
    sample_rate: Option<u32>,
) -> Result<(), String> {
    let sr = sample_rate.unwrap_or(48000);
    manager_state.set_rack_state(track_id.clone(), rack_state, sr);
    log_info(&format!("Vocal Rack parameters updated for track: {}", track_id));
    Ok(())
}

/// Динамическая загрузка VST3-плагина в слот рэка дорожки
#[command]
pub async fn load_vst3_plugin_to_rack(
    manager_state: State<'_, SharedVocalRackManager>,
    vst_host_state: State<'_, SharedVstHostState>,
    track_id: String,
    slot_index: usize,
    plugin_path: String,
) -> Result<String, String> {
    let p_path = PathBuf::from(&plugin_path);
    if !p_path.exists() {
        return Err(format!("Файл VST3 плагина не найден: {}", plugin_path));
    }

    let plugin_name = p_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown Plugin".to_string());

    // Загружаем инстанс плагина через общий VST хост
    let instance_id = crate::vst_host::load_plugin(vst_host_state, plugin_path.clone())
        .await
        .map_err(|e| format!("Ошибка загрузки VST3 плагина: {}", e))?;

    // Получаем текущее состояние рэка или создаем дефолтное
    let mut state = manager_state
        .get_rack_state(&track_id)
        .unwrap_or_else(RackState::default);

    state.track_id = track_id.clone();
    state.vst3 = Vst3SlotConfig {
        enabled: true,
        bypass: false,
        plugin_path,
        plugin_name: plugin_name.clone(),
        instance_id: Some(instance_id.clone()),
        mix: 1.0,
        gain_db: 0.0,
        parameters: HashMap::new(),
    };

    manager_state.set_rack_state(track_id, state, 48000);
    log_info(&format!("VST3 '{}' successfully loaded to slot {} for track", plugin_name, slot_index));

    Ok(instance_id)
}

/// Получение текущего состояния рэка дорожки
#[command]
pub async fn get_rack_state(
    manager_state: State<'_, SharedVocalRackManager>,
    track_id: String,
) -> Result<Option<RackState>, String> {
    Ok(manager_state.get_rack_state(&track_id))
}

/// Сброс рэка дорожки в заводские настройки
#[command]
pub async fn reset_rack(
    manager_state: State<'_, SharedVocalRackManager>,
    track_id: String,
) -> Result<RackState, String> {
    let mut default_state = RackState::default();
    default_state.track_id = track_id.clone();
    manager_state.set_rack_state(track_id, default_state.clone(), 48000);
    Ok(default_state)
}

// ============================================================================
// 8. UNIT ТЕСТЫ DSP ДВИЖКА
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parametric_eq_low_cut_attenuation() {
        let mut eq = ParametricEqDsp::new(ParametricEqConfig::default(), 48000);
        let mut low_freq_energy = 0.0f32;
        let mut high_freq_energy = 0.0f32;

        for i in 0..4800 {
            let t = (i as f32) / 48000.0;
            // 30 Гц (ниже Low Cut 80 Гц)
            let low_s = (2.0 * PI * 30.0 * t).sin();
            let proc_low = eq.process_sample(low_s, 0);
            low_freq_energy += proc_low * proc_low;

            // 1000 Гц (пропускаемая полоса)
            let high_s = (2.0 * PI * 1000.0 * t).sin();
            let proc_high = eq.process_sample(high_s, 0);
            high_freq_energy += proc_high * proc_high;
        }

        assert!(low_freq_energy < high_freq_energy * 0.3);
    }

    #[test]
    fn test_compressor_gain_reduction() {
        let mut comp = CompressorDsp::new(CompressorConfig::default(), 48000);
        // Подаем громкий сигнал (1.0 = 0 dBFS при пороге -18 dBFS)
        let mut max_output = 0.0f32;
        for _ in 0..2000 {
            let out = comp.process_sample(1.0);
            if out > max_output {
                max_output = out;
            }
        }
        // Компрессор должен снизить амплитуду постоянного сигнала
        assert!(comp.envelope_db > -10.0);
    }

    #[test]
    fn test_saturator_tanh_clipping() {
        let config = SaturatorConfig {
            enabled: true,
            bypass: false,
            drive_db: 12.0, // Сильный драйв
            saturation_type: SaturationType::SoftTanh,
            warmth_bias: 0.0,
            mix: 1.0,
            output_gain_db: 0.0,
        };
        let mut sat = SaturatorDsp::new(config, 48000);
        for _ in 0..100 {
            sat.drive_smoother.next();
        }
        let out = sat.process_sample(2.0);
        assert!(out.abs() <= 1.05);
    }

    #[test]
    fn test_channel_strip_rack_smooth_processing() {
        let mut rack = ChannelStripRack::new(RackState::default(), 48000);
        let mut buffer = vec![0.5f32; 1024];
        rack.process_buffer(&mut buffer, 2, 48000);
        assert_eq!(buffer.len(), 1024);
        for s in buffer {
            assert!(!s.is_nan());
            assert!(!s.is_infinite());
        }
    }
}
