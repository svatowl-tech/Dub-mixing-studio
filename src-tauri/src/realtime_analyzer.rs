// ============================================================================
// DUB MIXING STUDIO PRO - REALTIME SPECTRUM & MIPMAP WAVEFORM ENGINE (RUST)
// Модуль потокового БПФ спектрального анализа (Blackman-Harris 2048, 60 FPS)
// и генерации Mipmap-пиков волновой формы (LOD 1x, 10x, 100x, 1000x)
// Стек: rustfft = "6.2.0", ringbuf = "0.2", rayon = "1.10.0", hound = "3.5.1", tauri = "2.11"
// ============================================================================


use rayon::prelude::*;
use ringbuf::RingBuffer;
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{command, AppHandle, Emitter, State};

use crate::audio_buffer_manager::AudioBufferCache;
use crate::logger::log_info;

pub const FFT_SIZE: usize = 2048;
pub const NUM_OCTAVE_BANDS: usize = 64;
pub const RING_BUFFER_CAPACITY: usize = 32768;

// ============================================================================
// СТРУКТУРЫ ДАННЫХ И ТИПЫ ВОЗВРАТА
// ============================================================================

/// Кадр спектра реального времени (60 FPS)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrumFramePayload {
    /// Логарифмические октавные полосы (от -90 dBFS до 0 dBFS)
    pub bands: Vec<f32>,
    /// Пиковая амплитуда (0.0 .. 1.0)
    pub peak: f32,
    /// RMS значение (0.0 .. 1.0)
    pub rms: f32,
    /// Частота доминирующего пика в Гц
    pub dominant_freq_hz: f32,
    /// Временная метка кадра (мс)
    pub timestamp_ms: u64,
}

/// Набор уровней детализации волновой формы (LOD Mipmap)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformMipmap {
    pub sample_rate: u32,
    pub total_samples: u64,
    pub duration_seconds: f64,
    /// LOD 1x: 1 сэмпл на каждые ~64 сэмпла (~750 точек/сек)
    pub lod_1x: Vec<f32>,
    /// LOD 10x: (~75 точек/сек)
    pub lod_10x: Vec<f32>,
    /// LOD 100x: (~7.5 точек/сек)
    pub lod_100x: Vec<f32>,
    /// LOD 1000x: мини-карта (~0.75 точек/сек)
    pub lod_1000x: Vec<f32>,
}

/// Метаданные кэша Mipmap волновой формы на диске
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformMipmapHeader {
    pub magic: [u8; 4], // b"DUBW"
    pub version: u32,   // 1
    pub sample_rate: u32,
    pub total_samples: u64,
    pub duration_seconds: f64,
    pub len_1x: u32,
    pub len_10x: u32,
    pub len_100x: u32,
    pub len_1000x: u32,
}

// ============================================================================
// СПЕКТРАЛЬНЫЙ АНАЛИЗАТОР (BLACKMAN-HARRIS 2048 + 64 LOG BANDS + ATTACK/DECAY)
// ============================================================================

pub struct SpectralDspProcessor {
    fft_size: usize,
    sample_rate: u32,
    window_blackman_harris: Vec<f32>,
    fft_planner: FftPlanner<f32>,
    band_indices: Vec<(usize, usize)>, // (start_bin, end_bin) для каждой октавной полосы
    smoothed_bands: Vec<f32>,
    smoothed_peak: f32,
    attack_coeff: f32,
    decay_coeff: f32,
}

impl SpectralDspProcessor {
    pub fn new(fft_size: usize, sample_rate: u32, num_bands: usize) -> Self {
        let mut window = Vec::with_capacity(fft_size);
        // 4-членное окно Блэкмана-Харриса (a0=0.35875, a1=0.48829, a2=0.14128, a3=0.01168)
        let a0 = 0.35875f32;
        let a1 = 0.48829f32;
        let a2 = 0.14128f32;
        let a3 = 0.01168f32;
        let n_minus_1 = (fft_size - 1) as f32;

        for i in 0..fft_size {
            let z = (i as f32) / n_minus_1;
            let val = a0
                - a1 * (2.0 * PI * z).cos()
                + a2 * (4.0 * PI * z).cos()
                - a3 * (6.0 * PI * z).cos();
            window.push(val);
        }

        // Логарифмическое распределение полос частот от 20 Гц до 20000 Гц
        let min_freq = 20.0f32;
        let max_freq = (sample_rate as f32 / 2.0).min(20000.0);
        let freq_step = sample_rate as f32 / fft_size as f32;
        let num_bins = fft_size / 2;

        let mut band_indices = Vec::with_capacity(num_bands);
        for b in 0..num_bands {
            let f_low = min_freq * (max_freq / min_freq).powf((b as f32) / (num_bands as f32));
            let f_high = min_freq * (max_freq / min_freq).powf(((b + 1) as f32) / (num_bands as f32));

            let mut start_bin = (f_low / freq_step).floor() as usize;
            let mut end_bin = (f_high / freq_step).ceil() as usize;

            if start_bin >= num_bins {
                start_bin = num_bins.saturating_sub(1);
            }
            if end_bin > num_bins {
                end_bin = num_bins;
            }
            if end_bin <= start_bin {
                end_bin = (start_bin + 1).min(num_bins);
            }

            band_indices.push((start_bin, end_bin));
        }

        // Коэффициенты сглаживания: Attack 10ms, Decay 150ms при вызове с частотой 60 Гц (dt ≈ 16.67ms)
        let dt = 1.0 / 60.0;
        let attack_coeff = 1.0 - (-dt / 0.010_f32).exp();
        let decay_coeff = 1.0 - (-dt / 0.150_f32).exp();

        Self {
            fft_size,
            sample_rate,
            window_blackman_harris: window,
            fft_planner: FftPlanner::new(),
            band_indices,
            smoothed_bands: vec![-90.0; num_bands],
            smoothed_peak: 0.0,
            attack_coeff,
            decay_coeff,
        }
    }

    pub fn process_frame(&mut self, input_samples: &[f32]) -> SpectrumFramePayload {
        let mut complex_buffer: Vec<Complex<f32>> = Vec::with_capacity(self.fft_size);

        let input_len = input_samples.len();
        let mut sum_sq = 0.0f32;
        let mut peak_val = 0.0f32;

        for i in 0..self.fft_size {
            let sample = if i < input_len {
                input_samples[i]
            } else {
                0.0f32
            };
            let abs_s = sample.abs();
            if abs_s > peak_val {
                peak_val = abs_s;
            }
            sum_sq += sample * sample;

            let windowed = sample * self.window_blackman_harris[i];
            complex_buffer.push(Complex::new(windowed, 0.0));
        }

        let rms_val = (sum_sq / (self.fft_size as f32)).sqrt();

        // Прямое БПФ
        let fft = self.fft_planner.plan_fft_forward(self.fft_size);
        fft.process(&mut complex_buffer);

        let num_bins = self.fft_size / 2;
        let freq_step = self.sample_rate as f32 / self.fft_size as f32;
        let norm_factor = 2.0 / (self.fft_size as f32);

        // Находим спектральную плотность и доминирующий пик
        let mut max_mag = 0.0f32;
        let mut max_bin = 0usize;

        let mut bin_magnitudes = Vec::with_capacity(num_bins);
        for i in 0..num_bins {
            let c = complex_buffer[i];
            let mag = (c.re * c.re + c.im * c.im).sqrt() * norm_factor;
            bin_magnitudes.push(mag);

            if mag > max_mag {
                max_mag = mag;
                max_bin = i;
            }
        }

        let dominant_freq = (max_bin as f32) * freq_step;

        // Группировка в логарифмические октавные полосы (дБ от -90 до 0)
        let num_bands = self.band_indices.len();
        let mut raw_bands_db = Vec::with_capacity(num_bands);

        for &(start_bin, end_bin) in &self.band_indices {
            let mut band_energy = 0.0f32;
            let count = (end_bin - start_bin).max(1);

            for b in start_bin..end_bin {
                if b < bin_magnitudes.len() {
                    let m = bin_magnitudes[b];
                    band_energy += m * m;
                }
            }

            let band_rms = (band_energy / count as f32).sqrt();
            let db = if band_rms > 1e-5 {
                20.0 * band_rms.log10()
            } else {
                -90.0
            };
            raw_bands_db.push(db.clamp(-90.0, 0.0));
        }

        // Баллистическое сглаживание: Attack (10ms) / Decay (150ms)
        for b in 0..num_bands {
            let target_db = raw_bands_db[b];
            let current_db = self.smoothed_bands[b];

            if target_db > current_db {
                self.smoothed_bands[b] = current_db + (target_db - current_db) * self.attack_coeff;
            } else {
                self.smoothed_bands[b] = current_db + (target_db - current_db) * self.decay_coeff;
            }
        }

        if peak_val > self.smoothed_peak {
            self.smoothed_peak = self.smoothed_peak + (peak_val - self.smoothed_peak) * self.attack_coeff;
        } else {
            self.smoothed_peak = self.smoothed_peak + (peak_val - self.smoothed_peak) * self.decay_coeff;
        }

        SpectrumFramePayload {
            bands: self.smoothed_bands.clone(),
            peak: (self.smoothed_peak * 1000.0).round() / 1000.0,
            rms: (rms_val * 1000.0).round() / 1000.0,
            dominant_freq_hz: (dominant_freq * 10.0).round() / 10.0,
            timestamp_ms: chrono::Utc::now().timestamp_millis() as u64,
        }
    }
}

// ============================================================================
// СИСТЕМА УПРАВЛЕНИЯ ПОТОКОВЫМ АНАЛИЗАТОРОМ (LOCK-FREE RING BUFFER + TAURI EMIT)
// ============================================================================

pub struct RealtimeAnalyzerState {
    pub is_active: Arc<AtomicBool>,
    pub sample_rate: Arc<AtomicU32>,
    pub producer: Arc<Mutex<Option<ringbuf::Producer<f32>>>>,
    pub latest_frame: Arc<Mutex<Option<SpectrumFramePayload>>>,
}

impl Default for RealtimeAnalyzerState {
    fn default() -> Self {
        Self {
            is_active: Arc::new(AtomicBool::new(false)),
            sample_rate: Arc::new(AtomicU32::new(48000)),
            producer: Arc::new(Mutex::new(None)),
            latest_frame: Arc::new(Mutex::new(None)),
        }
    }
}

impl RealtimeAnalyzerState {
    /// Быстрая неблокирующая подача сэмплов из CPAL/аудио-движка в анализатор
    pub fn push_samples_lockfree(&self, samples: &[f32], channels: usize) {
        if !self.is_active.load(Ordering::Relaxed) {
            return;
        }

        if let Ok(mut prod_guard) = self.producer.try_lock() {
            if let Some(ref mut prod) = *prod_guard {
                if channels > 1 {
                    for chunk in samples.chunks(channels) {
                        let mono = chunk.iter().sum::<f32>() / (channels as f32);
                        let _ = prod.push(mono);
                    }
                } else {
                    for &s in samples {
                        let _ = prod.push(s);
                    }
                }
            }
        }
    }
}

/// Запуск фонового потока спектрального анализа с жесткой частотой 60 Гц
pub fn start_spectral_analyzer_worker(
    app: AppHandle,
    state: &RealtimeAnalyzerState,
    sample_rate: u32,
) {
    state.sample_rate.store(sample_rate, Ordering::SeqCst);
    state.is_active.store(true, Ordering::SeqCst);

    let ring = RingBuffer::<f32>::new(RING_BUFFER_CAPACITY);
    let (prod, mut cons) = ring.split();

    if let Ok(mut prod_guard) = state.producer.lock() {
        *prod_guard = Some(prod);
    }

    let is_active = Arc::clone(&state.is_active);
    let latest_frame_storage = Arc::clone(&state.latest_frame);

    std::thread::spawn(move || {
        log_info("Realtime Spectrum Analyzer worker started (60 FPS)");
        let mut dsp = SpectralDspProcessor::new(FFT_SIZE, sample_rate, NUM_OCTAVE_BANDS);
        let mut fft_input_buffer = vec![0.0f32; FFT_SIZE];
        let mut recent_samples_window = vec![0.0f32; FFT_SIZE];

        let target_frame_duration = Duration::from_micros(16666); // ~60 FPS (16.66 ms)

        while is_active.load(Ordering::Relaxed) {
            let start_instant = std::time::Instant::now();

            // Вычитываем все накопившиеся сэмплы из кольцевого буфера
            let mut _read_count = 0usize;
            while let Some(sample) = cons.pop() {
                recent_samples_window.rotate_left(1);
                recent_samples_window[FFT_SIZE - 1] = sample;
                _read_count += 1;
            }

            // Копируем окно для БПФ анализа
            fft_input_buffer.copy_from_slice(&recent_samples_window);

            // Обработка БПФ кадра
            let frame = dsp.process_frame(&fft_input_buffer);

            // Сохраняем в разделяемое состояние
            if let Ok(mut lf) = latest_frame_storage.try_lock() {
                *lf = Some(frame.clone());
            }

            // Передаем компактный кадр спектра во фронтенд через событие Tauri Event
            let _ = app.emit("spectrum-frame", &frame);

            // Поддержание строгого тайминга 60 Гц
            let elapsed = start_instant.elapsed();
            if elapsed < target_frame_duration {
                std::thread::sleep(target_frame_duration - elapsed);
            }
        }

        log_info("Realtime Spectrum Analyzer worker stopped");
    });
}

// ============================================================================
// 4. ГЕНЕРАЦИЯ И КЭШИРОВАНИЕ MIPMAP-ПИКОВ ВОЛНОВОЙ ФОРМЫ (LOD 1x, 10x, 100x, 1000x)
// ============================================================================

/// Расчет Mipmap-уровней для сэмплов волновой формы
pub fn compute_waveform_mipmaps_internal(samples: &[f32], sample_rate: u32) -> WaveformMipmap {
    let total_samples = samples.len() as u64;
    let duration_seconds = total_samples as f64 / sample_rate as f64;

    if samples.is_empty() {
        return WaveformMipmap {
            sample_rate,
            total_samples: 0,
            duration_seconds: 0.0,
            lod_1x: Vec::new(),
            lod_10x: Vec::new(),
            lod_100x: Vec::new(),
            lod_1000x: Vec::new(),
        };
    }

    // Базовый шаг сжатия: 64 сэмпла на пик (~750 точек на секунду при 48 кГц)
    let block_size_1x = 64usize;
    let num_peaks_1x = (samples.len() + block_size_1x - 1) / block_size_1x;

    let lod_1x: Vec<f32> = (0..num_peaks_1x)
        .into_par_iter()
        .map(|i| {
            let start = i * block_size_1x;
            let end = (start + block_size_1x).min(samples.len());
            let mut peak = 0.0f32;
            for j in start..end {
                let abs_v = samples[j].abs();
                if abs_v > peak {
                    peak = abs_v;
                }
            }
            peak.min(1.0)
        })
        .collect();

    // LOD 10x: сжатие 10:1 из lod_1x
    let num_peaks_10x = (lod_1x.len() + 9) / 10;
    let lod_10x: Vec<f32> = (0..num_peaks_10x)
        .into_par_iter()
        .map(|i| {
            let start = i * 10;
            let end = (start + 10).min(lod_1x.len());
            let mut peak = 0.0f32;
            for j in start..end {
                if lod_1x[j] > peak {
                    peak = lod_1x[j];
                }
            }
            peak
        })
        .collect();

    // LOD 100x: сжатие 10:1 из lod_10x
    let num_peaks_100x = (lod_10x.len() + 9) / 10;
    let lod_100x: Vec<f32> = (0..num_peaks_100x)
        .into_par_iter()
        .map(|i| {
            let start = i * 10;
            let end = (start + 10).min(lod_10x.len());
            let mut peak = 0.0f32;
            for j in start..end {
                if lod_10x[j] > peak {
                    peak = lod_10x[j];
                }
            }
            peak
        })
        .collect();

    // LOD 1000x: сжатие 10:1 из lod_100x (для Minimap)
    let num_peaks_1000x = (lod_100x.len() + 9) / 10;
    let lod_1000x: Vec<f32> = (0..num_peaks_1000x)
        .into_par_iter()
        .map(|i| {
            let start = i * 10;
            let end = (start + 10).min(lod_100x.len());
            let mut peak = 0.0f32;
            for j in start..end {
                if lod_100x[j] > peak {
                    peak = lod_100x[j];
                }
            }
            peak
        })
        .collect();

    WaveformMipmap {
        sample_rate,
        total_samples,
        duration_seconds,
        lod_1x,
        lod_10x,
        lod_100x,
        lod_1000x,
    }
}

/// Сохранение Mipmap волновой формы в компактный бинарный кэш на диске
pub fn save_waveform_mipmap_cache<P: AsRef<Path>>(
    cache_path: P,
    mipmap: &WaveformMipmap,
) -> Result<(), String> {
    let mut file = File::create(cache_path.as_ref())
        .map_err(|e| format!("Не удалось создать файл кэша пиков {:?}: {}", cache_path.as_ref(), e))?;

    // Заголовок DUBW
    file.write_all(b"DUBW").map_err(|e| e.to_string())?;
    file.write_all(&1u32.to_le_bytes()).map_err(|e| e.to_string())?; // version
    file.write_all(&mipmap.sample_rate.to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&mipmap.total_samples.to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&mipmap.duration_seconds.to_le_bytes()).map_err(|e| e.to_string())?;

    // Длины списков LOD
    file.write_all(&(mipmap.lod_1x.len() as u32).to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&(mipmap.lod_10x.len() as u32).to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&(mipmap.lod_100x.len() as u32).to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&(mipmap.lod_1000x.len() as u32).to_le_bytes()).map_err(|e| e.to_string())?;

    // Сохранение значений пиков в 8-битном формате (0..255) для ультра-быстрой подгрузки
    let write_lod = |f: &mut File, lod: &[f32]| -> Result<(), String> {
        let bytes: Vec<u8> = lod.iter().map(|&v| (v.clamp(0.0, 1.0) * 255.0).round() as u8).collect();
        f.write_all(&bytes).map_err(|e| e.to_string())
    };

    write_lod(&mut file, &mipmap.lod_1x)?;
    write_lod(&mut file, &mipmap.lod_10x)?;
    write_lod(&mut file, &mipmap.lod_1000x)?;
    write_lod(&mut file, &mipmap.lod_100x)?;

    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Быстрая загрузка Mipmap волновой формы из бинарного кэша
pub fn load_waveform_mipmap_cache<P: AsRef<Path>>(cache_path: P) -> Result<WaveformMipmap, String> {
    let mut file = File::open(cache_path.as_ref())
        .map_err(|e| format!("Не удалось открыть файл кэша {:?}: {}", cache_path.as_ref(), e))?;

    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic != b"DUBW" {
        return Err("Неверный формат заголовка кэша пиков (ожидался DUBW)".to_string());
    }

    let mut u32_buf = [0u8; 4];
    let mut u64_buf = [0u8; 8];

    file.read_exact(&mut u32_buf).map_err(|e| e.to_string())?;
    let _version = u32::from_le_bytes(u32_buf);

    file.read_exact(&mut u32_buf).map_err(|e| e.to_string())?;
    let sample_rate = u32::from_le_bytes(u32_buf);

    file.read_exact(&mut u64_buf).map_err(|e| e.to_string())?;
    let total_samples = u64::from_le_bytes(u64_buf);

    file.read_exact(&mut u64_buf).map_err(|e| e.to_string())?;
    let duration_seconds = f64::from_le_bytes(u64_buf);

    file.read_exact(&mut u32_buf).map_err(|e| e.to_string())?;
    let len_1x = u32::from_le_bytes(u32_buf) as usize;

    file.read_exact(&mut u32_buf).map_err(|e| e.to_string())?;
    let len_10x = u32::from_le_bytes(u32_buf) as usize;

    file.read_exact(&mut u32_buf).map_err(|e| e.to_string())?;
    let len_100x = u32::from_le_bytes(u32_buf) as usize;

    file.read_exact(&mut u32_buf).map_err(|e| e.to_string())?;
    let len_1000x = u32::from_le_bytes(u32_buf) as usize;

    let read_lod = |f: &mut File, len: usize| -> Result<Vec<f32>, String> {
        let mut buf = vec![0u8; len];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf.into_iter().map(|b| (b as f32) / 255.0).collect())
    };

    let lod_1x = read_lod(&mut file, len_1x)?;
    let lod_10x = read_lod(&mut file, len_10x)?;
    let lod_100x = read_lod(&mut file, len_100x)?;
    let lod_1000x = read_lod(&mut file, len_1000x)?;

    Ok(WaveformMipmap {
        sample_rate,
        total_samples,
        duration_seconds,
        lod_1x,
        lod_10x,
        lod_100x,
        lod_1000x,
    })
}

// ============================================================================
// TAURI V2 КОМАНДЫ
// ============================================================================

/// Запуск потокового анализатора спектра
#[command]
pub async fn start_realtime_spectrum_analyzer(
    app: AppHandle,
    state: State<'_, RealtimeAnalyzerState>,
    sample_rate: Option<u32>,
) -> Result<(), String> {
    let sr = sample_rate.unwrap_or(48000);
    start_spectral_analyzer_worker(app, &state, sr);
    Ok(())
}

/// Остановка потокового анализатора спектра
#[command]
pub async fn stop_realtime_spectrum_analyzer(
    state: State<'_, RealtimeAnalyzerState>,
) -> Result<(), String> {
    state.is_active.store(false, Ordering::SeqCst);
    if let Ok(mut prod) = state.producer.lock() {
        *prod = None;
    }
    Ok(())
}

/// Получение последнего кадра спектра (Pull-модель)
#[command]
pub async fn get_latest_spectrum_frame(
    state: State<'_, RealtimeAnalyzerState>,
) -> Result<Option<SpectrumFramePayload>, String> {
    if let Ok(guard) = state.latest_frame.lock() {
        Ok(guard.clone())
    } else {
        Ok(None)
    }
}

/// Генерация и кэширование Mipmap волновой формы для аудиофайла или ID буфера
#[command]
pub async fn generate_waveform_mipmaps(
    cache_state: State<'_, AudioBufferCache>,
    buffer_id_or_path: String,
    cache_output_path: Option<String>,
) -> Result<WaveformMipmap, String> {
    let source = buffer_id_or_path.clone();
    let cache_clone = cache_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        // 1. Попытка загрузить из дискового кэша, если он уже существует
        if let Some(ref cpath) = cache_output_path {
            if Path::new(cpath).exists() {
                if let Ok(cached_mipmap) = load_waveform_mipmap_cache(cpath) {
                    return Ok(cached_mipmap);
                }
            }
        }

        // 2. Получение сэмплов из AudioBufferCache или с диска
        let audio_buf = crate::smart_align::resolve_audio_samples(&source, Some(&cache_clone))
            .map_err(|e| format!("Не удалось извлечь сэмплы для генерации mipmap: {}", e))?;

        // 3. Расчет 4-х уровней LOD
        let mipmap = compute_waveform_mipmaps_internal(&audio_buf.samples, audio_buf.sample_rate);

        // 4. Кэширование на диск при необходимости
        if let Some(ref cpath) = cache_output_path {
            let _ = save_waveform_mipmap_cache(cpath, &mipmap);
        }

        Ok(mipmap)
    })
    .await
    .map_err(|e| format!("Ошибка задачи generate_waveform_mipmaps: {}", e))?
}

// ============================================================================
// UNIT-ТЕСТЫ
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blackman_harris_window_properties() {
        let dsp = SpectralDspProcessor::new(2048, 48000, 64);
        assert_eq!(dsp.window_blackman_harris.len(), 2048);
        assert!(dsp.window_blackman_harris[0] < 0.001);
        assert!((dsp.window_blackman_harris[1024] - 1.0).abs() < 0.05);
    }

    #[test]
    fn test_log_octave_bands_range() {
        let dsp = SpectralDspProcessor::new(2048, 48000, 64);
        assert_eq!(dsp.band_indices.len(), 64);
        let first = dsp.band_indices[0];
        let last = dsp.band_indices[63];
        assert!(first.0 < last.0);
        assert!(last.1 <= 1024);
    }

    #[test]
    fn test_waveform_mipmap_lod_reduction() {
        let sample_rate = 48000;
        let mut samples = vec![0.0f32; 48000 * 2]; // 2 секунды
        for i in 0..samples.len() {
            samples[i] = ((i as f32) / 100.0).sin() * 0.9;
        }

        let mipmap = compute_waveform_mipmaps_internal(&samples, sample_rate);
        assert_eq!(mipmap.sample_rate, 48000);
        assert!(mipmap.lod_1x.len() > mipmap.lod_10x.len());
        assert!(mipmap.lod_10x.len() > mipmap.lod_100x.len());
        assert!(mipmap.lod_100x.len() > mipmap.lod_1000x.len());
    }
}
