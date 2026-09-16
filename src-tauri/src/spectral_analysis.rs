use hound::{SampleFormat, WavReader};
use rayon::prelude::*;
use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;
use std::path::Path;
use crate::logger::log_debug;

/// Одиночный кадр спектрограммы
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrogramFrame {
    pub time: f32, // в секундах
    pub magnitudes: Vec<f32>, // dBFS значения для каждого частотного бина (0 до -140 dB)
    pub peak_freq: f32,
    pub peak_db: f32,
}

/// Итоговые данные STFT спектрограммы
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrogramData {
    pub frames: Vec<SpectrogramFrame>,
    pub sample_rate: u32,
    pub duration: f32,
    pub fft_size: usize,
    pub hop_size: usize,
    pub freq_step: f32,
    pub max_freq: f32,
    pub min_db: f32,
    pub max_db: f32,
    pub global_peak_freq: f32,
    pub global_peak_db: f32,
    pub detected_cutoff_freq: f32, // например 16000 для MP3 128kbps, 20000 для 320kbps, 22050/24000 для Lossless
    pub estimated_noise_floor_db: f32,
    pub has_low_rumble: bool, // энергия < 60Hz
    pub has_sibilance_issue: bool, // избыточная энергия 5-8kHz
}

/// Генерация окна Ханна (Hann Window)
pub fn generate_hann_window(size: usize) -> Vec<f32> {
    if size <= 1 {
        return vec![1.0; size];
    }
    let mut window = Vec::with_capacity(size);
    for i in 0..size {
        let val = 0.5 * (1.0 - (2.0 * PI * i as f32 / (size - 1) as f32).cos());
        window.push(val);
    }
    window
}

/// Расчет спектрограммы из PCM сэмплов f32 с помощью rustfft и rayon
pub fn compute_spectrogram_internal(
    samples: &[f32],
    sample_rate: u32,
    fft_size: usize,
    hop_ratio: f32,
) -> SpectrogramData {
    let num_samples = samples.len();
    let duration = num_samples as f32 / sample_rate as f32;
    let hop_size = ((fft_size as f32 * hop_ratio).floor() as usize).max(64);
    let window = generate_hann_window(fft_size);
    let num_bins = fft_size / 2;
    let freq_step = sample_rate as f32 / fft_size as f32;
    let max_freq = sample_rate as f32 / 2.0;

    // Рассчитываем количество временных срезов (окон)
    let num_frames = if num_samples >= fft_size {
        (num_samples - fft_size) / hop_size + 1
    } else {
        0
    };

    if num_frames == 0 {
        return SpectrogramData {
            frames: Vec::new(),
            sample_rate,
            duration,
            fft_size,
            hop_size,
            freq_step,
            max_freq,
            min_db: -120.0,
            max_db: 0.0,
            global_peak_freq: 0.0,
            global_peak_db: -120.0,
            detected_cutoff_freq: max_freq,
            estimated_noise_floor_db: -90.0,
            has_low_rumble: false,
            has_sibilance_issue: false,
        };
    }

    // Параллельный расчет кадров через Rayon
    let window_ref = &window;
    let samples_ref = samples;

    let frames_calc: Vec<(SpectrogramFrame, f32, f32, f32, f32, Vec<f32>)> = (0..num_frames)
        .into_par_iter()
        .map_init(
            || {
                let mut planner = FftPlanner::new();
                let fft = planner.plan_fft_forward(fft_size);
                let scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];
                let buffer = vec![Complex32::new(0.0, 0.0); fft_size];
                (fft, scratch, buffer)
            },
            |(fft, scratch, buffer), frame_idx| {
                let offset = frame_idx * hop_size;
                let time = (offset as f32 + fft_size as f32 / 2.0) / sample_rate as f32;

                for i in 0..fft_size {
                    buffer[i] = Complex32::new(samples_ref[offset + i] * window_ref[i], 0.0);
                }

                fft.process_with_scratch(buffer, scratch);

                let mut magnitudes = Vec::with_capacity(num_bins);
                let mut frame_peak_db = -160.0f32;
                let mut frame_peak_freq = 0.0f32;
                let mut frame_min_db = 0.0f32;

                let mut low_rumble = 0.0f32;
                let mut mid_voice = 0.0f32;
                let mut high_sibilance = 0.0f32;
                let mut bin_energies = vec![0.0f32; num_bins];

                let norm_factor = (fft_size / 2) as f32;

                for k in 0..num_bins {
                    let c = buffer[k];
                    let mag = (c.re * c.re + c.im * c.im).sqrt() / norm_factor;
                    let db = if mag > 1e-7 {
                        (20.0 * mag.log10()).max(-130.0)
                    } else {
                        -130.0
                    };
                    magnitudes.push(db);

                    let freq = k as f32 * freq_step;

                    if db > frame_peak_db {
                        frame_peak_db = db;
                        frame_peak_freq = freq;
                    }

                    if k == 0 || db < frame_min_db {
                        frame_min_db = db;
                    }

                    if freq < 60.0 {
                        low_rumble += mag;
                    } else if freq >= 200.0 && freq <= 3500.0 {
                        mid_voice += mag;
                    } else if freq >= 5000.0 && freq <= 8500.0 {
                        high_sibilance += mag;
                    }

                    bin_energies[k] = mag;
                }

                let frame = SpectrogramFrame {
                    time,
                    magnitudes,
                    peak_freq: frame_peak_freq,
                    peak_db: frame_peak_db,
                };

                (frame, frame_min_db, low_rumble, mid_voice, high_sibilance, bin_energies)
            },
        )
        .collect();

    let mut frames = Vec::with_capacity(num_frames);
    let mut global_peak_db = -160.0f32;
    let mut global_peak_freq = 0.0f32;
    let mut total_noise_floor = 0.0f32;
    let mut low_rumble_total = 0.0f32;
    let mut mid_voice_total = 0.0f32;
    let mut high_sibilance_total = 0.0f32;
    let mut ultra_high_energy_bins = vec![0.0f32; num_bins];

    for (frame, frame_min_db, low_rumble, mid_voice, high_sibilance, bin_energies) in frames_calc {
        if frame.peak_db > global_peak_db {
            global_peak_db = frame.peak_db;
            global_peak_freq = frame.peak_freq;
        }

        total_noise_floor += frame_min_db;
        low_rumble_total += low_rumble;
        mid_voice_total += mid_voice;
        high_sibilance_total += high_sibilance;

        for k in 0..num_bins {
            ultra_high_energy_bins[k] += bin_energies[k];
        }

        frames.push(frame);
    }

    let frames_len = frames.len().max(1) as f32;
    let mut detected_cutoff_freq = max_freq;
    let mid_energy_avg = (mid_voice_total / (frames_len * (3300.0 / freq_step)).max(1.0)).max(1e-5);
    let cutoff_threshold = mid_energy_avg * 0.0005;

    let scan_start = (num_bins as f32 * 0.4).floor() as usize;
    for k in (scan_start..num_bins).rev() {
        let avg_bin_energy = ultra_high_energy_bins[k] / frames_len;
        if avg_bin_energy > cutoff_threshold {
            let freq = (k as f32 * freq_step / 100.0).round() * 100.0;
            detected_cutoff_freq = max_freq.min(freq);
            break;
        }
    }

    let estimated_noise_floor_db = ((total_noise_floor / frames_len) * 10.0).round() / 10.0;
    let has_low_rumble = low_rumble_total > (mid_voice_total * 0.25);
    let has_sibilance_issue = high_sibilance_total > (mid_voice_total * 0.55);

    SpectrogramData {
        frames,
        sample_rate,
        duration,
        fft_size,
        hop_size,
        freq_step,
        max_freq,
        min_db: -120.0,
        max_db: 0.0,
        global_peak_freq: global_peak_freq.round(),
        global_peak_db: (global_peak_db * 10.0).round() / 10.0,
        detected_cutoff_freq,
        estimated_noise_floor_db,
        has_low_rumble,
        has_sibilance_issue,
    }
}

/// Загрузка аудиофайла (WAV/FLAC/MP3) в моно f32 сэмплы
pub fn load_audio_samples<P: AsRef<Path>>(path: P) -> Result<(Vec<f32>, u32), String> {
    let path_ref = path.as_ref();
    if !path_ref.exists() {
        return Err(format!("Файл не существует: {:?}", path_ref));
    }

    let is_wav = path_ref
        .extension()
        .and_then(|s| s.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("wav"))
        .unwrap_or(false);

    if is_wav {
        if let Ok(mut reader) = WavReader::open(path_ref) {
            let spec = reader.spec();
            let channels = spec.channels as usize;
            if channels == 0 {
                return Err("Каналы аудио равны 0".to_string());
            }

            let samples: Vec<f32> = match spec.sample_format {
                SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
                SampleFormat::Int => {
                    let bits = spec.bits_per_sample;
                    if bits <= 16 {
                        reader
                            .samples::<i16>()
                            .map(|s| s.unwrap_or(0) as f32 / 32768.0)
                            .collect()
                    } else if bits <= 24 {
                        reader
                            .samples::<i32>()
                            .map(|s| s.unwrap_or(0) as f32 / 8388608.0)
                            .collect()
                    } else {
                        reader
                            .samples::<i32>()
                            .map(|s| s.unwrap_or(0) as f32 / i32::MAX as f32)
                            .collect()
                    }
                }
            };

            // Микшируем многоканальное аудио в моно
            if channels > 1 {
                let mono_len = samples.len() / channels;
                let mut mono = Vec::with_capacity(mono_len);
                let scale = 1.0 / channels as f32;
                for i in 0..mono_len {
                    let mut sum = 0.0f32;
                    for ch in 0..channels {
                        sum += samples[i * channels + ch];
                    }
                    mono.push(sum * scale);
                }
                return Ok((mono, spec.sample_rate));
            } else {
                return Ok((samples, spec.sample_rate));
            }
        }
    }

    // Если это не WAV или hound не смог прочитать, читаем через FFmpeg в 48000 Hz моно WAV
    let temp_wav = std::env::temp_dir().join(format!("spec_decode_{}.wav", uuid::Uuid::new_v4()));
    let temp_wav_str = temp_wav.to_string_lossy().to_string();
    let norm_path = crate::file_io::normalize_windows_path(&path_ref.to_string_lossy());

    let output = std::process::Command::new("ffmpeg")
        .args(&[
            "-y",
            "-v", "quiet",
            "-i", &norm_path,
            "-vn",
            "-ac", "1",
            "-ar", "48000",
            &temp_wav_str,
        ])
        .output();

    match output {
        Ok(out) if out.status.success() && temp_wav.exists() => {
            let res = load_audio_samples(&temp_wav);
            let _ = std::fs::remove_file(&temp_wav);
            res
        }
        _ => {
            let _ = std::fs::remove_file(&temp_wav);
            Err(format!("Не удалось декодировать аудиофайл {:?}", path_ref))
        }
    }
}

/// Нативная Tauri команда для расчета спектрограммы из файла на диске
#[tauri::command]
pub async fn compute_spectrogram_from_file(
    file_path: String,
    offset_sec: Option<f32>,
    duration_sec: Option<f32>,
    fft_size: Option<usize>,
    hop_ratio: Option<f32>,
) -> Result<SpectrogramData, String> {
    let norm_path = crate::file_io::normalize_windows_path(&file_path);
    let fft_sz = fft_size.unwrap_or(2048).clamp(256, 8192);
    let hop_rt = hop_ratio.unwrap_or(0.25).clamp(0.05, 1.0);

    tokio::task::spawn_blocking(move || {
        let (full_samples, sample_rate) = load_audio_samples(&norm_path)?;

        let start_sample = if let Some(off) = offset_sec {
            ((off * sample_rate as f32).max(0.0) as usize).min(full_samples.len())
        } else {
            0
        };

        let end_sample = if let Some(dur) = duration_sec {
            (start_sample + (dur * sample_rate as f32) as usize).min(full_samples.len())
        } else {
            full_samples.len()
        };

        let slice = if start_sample < end_sample {
            &full_samples[start_sample..end_sample]
        } else {
            &full_samples[..]
        };

        log_debug(&format!(
            "compute_spectrogram_from_file: samples={}, sr={}, fft={}, hop={}",
            slice.len(), sample_rate, fft_sz, hop_rt
        ));

        Ok(compute_spectrogram_internal(slice, sample_rate, fft_sz, hop_rt))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Нативная Tauri команда для расчета спектрограммы из сырого массива PCM сэмплов f32
#[tauri::command]
pub async fn compute_spectrogram_from_pcm(
    samples: Vec<f32>,
    sample_rate: u32,
    fft_size: Option<usize>,
    hop_ratio: Option<f32>,
) -> Result<SpectrogramData, String> {
    let fft_sz = fft_size.unwrap_or(2048).clamp(256, 8192);
    let hop_rt = hop_ratio.unwrap_or(0.25).clamp(0.05, 1.0);

    tokio::task::spawn_blocking(move || {
        Ok(compute_spectrogram_internal(&samples, sample_rate, fft_sz, hop_rt))
    })
    .await
    .map_err(|e| e.to_string())?
}
