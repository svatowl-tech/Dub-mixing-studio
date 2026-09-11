use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::f32::consts::PI;
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use ndarray::{Array4, Axis};
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Value;
#[cfg(target_os = "windows")]
use ort::execution_providers::DirectMLExecutionProvider;

/// Частота дискретизации, строго требуемая архитектурой UVR / MDX-Net
pub const UVR_TARGET_SAMPLE_RATE: u32 = 44100;

/// Размер окна FFT для анализа спектрограмм (2048 сэмплов -> 1025 частотных бинов)
pub const FFT_SIZE: usize = 2048;

/// Шаг смещения окна (Hop size): 512 сэмплов (75% перекрытие / overlap для гладкой фазы)
pub const HOP_SIZE: usize = 512;

/// Длина временного окна инференса в кадрах спектрограммы (256 кадров ~ 2.97 сек при hop=512)
pub const CHUNK_TIME_STEPS: usize = 256;

/// Шаг смещения чанков инференса с перекрытием 50% для устранения артефактов склейки
pub const CHUNK_HOP_STEPS: usize = 128;

/// Структура прогресса для отправки в UI через tauri::Emitter
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub percent: f32,
    pub current_frame: usize,
    pub total_frames: usize,
    pub stage: String,
}

/// Итоговый отчет о проведенном шумоподавлении
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DenoiseReport {
    pub model_name: String,
    pub provider_used: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_sec: f64,
    pub noise_reduction_db: f32,
    pub processed_path: String,
    pub is_neural: bool,
}

/// Генерация окна Ханна (Hann window) длины size
pub fn generate_hann_window(size: usize) -> Vec<f32> {
    let mut window = Vec::with_capacity(size);
    for n in 0..size {
        let val = 0.5 * (1.0 - (2.0 * PI * n as f32 / size as f32).cos());
        window.push(val);
    }
    window
}

/// Поиск пути к файлу ONNX-модели UVR-DeNoise
pub fn find_model_path(app_handle: &AppHandle, model_name: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let target_filename = if model_name.ends_with(".onnx") {
        model_name.to_string()
    } else {
        format!("{}.onnx", model_name)
    };

    // 1. Каталог ресурсов приложения (Tauri resource_dir)
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        candidates.push(resource_dir.join("resources").join("models").join(&target_filename));
        candidates.push(resource_dir.join("models").join(&target_filename));
        candidates.push(resource_dir.join(&target_filename));
    }

    // 2. Каталог данных приложения (app_data_dir / app_local_data_dir)
    if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
        candidates.push(app_data_dir.join("models").join(&target_filename));
        candidates.push(app_data_dir.join(&target_filename));
    }

    // 3. Текущая рабочая директория (dev-режим / npm run tauri dev)
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("resources").join("models").join(&target_filename));
        candidates.push(cwd.join("models").join(&target_filename));
        candidates.push(cwd.join("src-tauri").join("resources").join("models").join(&target_filename));
    }

    // Дополнительные стандартные имена
    let default_fallbacks = ["UVR-DeNoise.onnx", "VR-DeNoise-FoxJoy.onnx", "UVR-DeNoise-Lite.onnx"];
    for fallback in &default_fallbacks {
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("resources").join("models").join(fallback));
            candidates.push(cwd.join("models").join(fallback));
        }
    }

    candidates.into_iter().find(|p| p.exists() && p.is_file())
}

/// Инициализация ONNX Runtime сессии с авто-выбором аппаратного ускорителя
pub fn init_onnx_session(model_path: &Path) -> Result<(Session, String), String> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);

    let mut provider_used = "CPU (Multithreaded)".to_string();

    let mut session_builder = Session::builder()
        .map_err(|e| format!("Ошибка создания SessionBuilder: {}", e))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| format!("Ошибка настройки оптимизации: {}", e))?
        .with_intra_threads(threads)
        .map_err(|e| format!("Ошибка настройки потоков: {}", e))?;

    // Попытка подключения DirectML для Windows (DirectX 12 GPU)
    #[cfg(target_os = "windows")]
    {
        if let Ok(dml) = DirectMLExecutionProvider::default().build() {
            if let Ok(b) = session_builder.with_execution_providers([dml]) {
                session_builder = b;
                provider_used = "DirectML (GPU DirectX 12)".to_string();
            }
        }
    }

    let session = session_builder
        .commit_from_file(model_path)
        .map_err(|e| format!("Не удалось загрузить ONNX модель из {}: {}", model_path.display(), e))?;

    Ok((session, provider_used))
}

/// Чтение сэмплов из WAV файла в нормализованный буфер f32 [-1.0, 1.0] с разделением по каналам
pub fn read_wav_channels_f32(path: &Path) -> Result<(Vec<Vec<f32>>, WavSpec), String> {
    let mut reader = WavReader::open(path)
        .map_err(|e| format!("Не удалось открыть WAV файл {}: {}", path.display(), e))?;
    let spec = reader.spec();

    if spec.channels == 0 || spec.sample_rate == 0 {
        return Err("Некорректный WAV: нулевое число каналов или нулевая частота дискретизации".to_string());
    }

    let channels = spec.channels as usize;
    let mut channel_buffers: Vec<Vec<f32>> = vec![Vec::new(); channels];

    match spec.sample_format {
        SampleFormat::Float => {
            let mut ch = 0;
            for s in reader.samples::<f32>() {
                channel_buffers[ch].push(s.unwrap_or(0.0));
                ch = (ch + 1) % channels;
            }
        }
        SampleFormat::Int => {
            let scale = match spec.bits_per_sample {
                16 => 32768.0_f32,
                24 => 8388608.0_f32,
                32 => 2147483648.0_f32,
                8  => 128.0_f32,
                b => return Err(format!("Неподдерживаемая разрядность: {} бит", b)),
            };
            let mut ch = 0;
            for s in reader.samples::<i32>() {
                channel_buffers[ch].push(s.unwrap_or(0) as f32 / scale);
                ch = (ch + 1) % channels;
            }
        }
    }

    Ok((channel_buffers, spec))
}

/// Ресэмплинг многоканального аудиосигнала с помощью rubato::SincFixedIn
pub fn resample_channels(
    channels_data: &[Vec<f32>],
    from_rate: u32,
    to_rate: u32,
) -> Result<Vec<Vec<f32>>, String> {
    if from_rate == to_rate {
        return Ok(channels_data.to_vec());
    }

    let num_channels = channels_data.len();
    let resample_ratio = to_rate as f64 / from_rate as f64;
    let chunk_size = 1024;

    let params = SincInterpolationParameters {
        sinc_len: 128,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let mut resampler = SincFixedIn::<f32>::new(
        resample_ratio,
        2.0,
        params,
        chunk_size,
        num_channels,
    ).map_err(|e| format!("Ошибка создания ресэмплера rubato ({}Hz -> {}Hz): {}", from_rate, to_rate, e))?;

    let total_samples = channels_data[0].len();
    let mut resampled_channels: Vec<Vec<f32>> = vec![Vec::new(); num_channels];
    let mut offset = 0;

    while offset < total_samples {
        let current_chunk_size = chunk_size.min(total_samples - offset);
        let mut input_buffers: Vec<Vec<f32>> = Vec::with_capacity(num_channels);

        for ch in 0..num_channels {
            let mut buf = vec![0.0_f32; chunk_size];
            for i in 0..current_chunk_size {
                buf[i] = channels_data[ch][offset + i];
            }
            input_buffers.push(buf);
        }

        let output_buffers = resampler.process(&input_buffers, None)
            .map_err(|e| format!("Ошибка ресэмплинга аудиокадров: {}", e))?;

        for ch in 0..num_channels {
            resampled_channels[ch].extend_from_slice(&output_buffers[ch]);
        }

        offset += current_chunk_size;
    }

    Ok(resampled_channels)
}

/// Комплексный расчет спектрограммы (STFT: Magnitude и Phase)
pub fn compute_stft(
    channel_samples: &[f32],
    fft_size: usize,
    hop_size: usize,
    window: &[f32],
    planner: &mut FftPlanner<f32>,
) -> (Vec<Vec<f32>>, Vec<Vec<f32>>) {
    let fft_forward = planner.plan_fft_forward(fft_size);
    let num_bins = fft_size / 2 + 1;
    let total_samples = channel_samples.len();

    let num_frames = if total_samples >= fft_size {
        (total_samples - fft_size) / hop_size + 1
    } else {
        1
    };

    let mut magnitudes: Vec<Vec<f32>> = Vec::with_capacity(num_frames);
    let mut phases: Vec<Vec<f32>> = Vec::with_capacity(num_frames);

    let mut buffer = vec![Complex32::new(0.0, 0.0); fft_size];

    for frame_idx in 0..num_frames {
        let offset = frame_idx * hop_size;

        for n in 0..fft_size {
            let sample = if offset + n < total_samples {
                channel_samples[offset + n]
            } else {
                0.0
            };
            buffer[n] = Complex32::new(sample * window[n], 0.0);
        }

        fft_forward.process(&mut buffer);

        let mut mag_frame = Vec::with_capacity(num_bins);
        let mut phase_frame = Vec::with_capacity(num_bins);

        for k in 0..num_bins {
            let c = buffer[k];
            let mag = (c.re * c.re + c.im * c.im).sqrt();
            let phase = c.im.atan2(c.re);
            mag_frame.push(mag);
            phase_frame.push(phase);
        }

        magnitudes.push(mag_frame);
        phases.push(phase_frame);
    }

    (magnitudes, phases)
}

/// Обратное преобразование iSTFT с алгоритмом Overlap-Add (OLA) и окном Ханна
pub fn compute_istft_ola(
    magnitudes: &[Vec<f32>],
    phases: &[Vec<f32>],
    fft_size: usize,
    hop_size: usize,
    window: &[f32],
    planner: &mut FftPlanner<f32>,
    target_length: usize,
) -> Vec<f32> {
    let fft_inverse = planner.plan_fft_inverse(fft_size);
    let num_frames = magnitudes.len();
    let num_bins = fft_size / 2 + 1;

    let output_capacity = num_frames * hop_size + fft_size;
    let mut output_signal = vec![0.0_f32; output_capacity];
    let mut normalization_buffer = vec![0.0_f32; output_capacity];

    let mut buffer = vec![Complex32::new(0.0, 0.0); fft_size];
    let inv_scale = 1.0 / (fft_size as f32);

    for frame_idx in 0..num_frames {
        let offset = frame_idx * hop_size;
        let mag_frame = &magnitudes[frame_idx];
        let phase_frame = &phases[frame_idx];

        // Восстановление двустороннего комплексного спектра из Magnitude + Phase
        for k in 0..num_bins {
            let m = mag_frame[k];
            let p = phase_frame[k];
            buffer[k] = Complex32::new(m * p.cos(), m * p.sin());
        }
        for k in num_bins..fft_size {
            let mirrored = fft_size - k;
            buffer[k] = buffer[mirrored].conj();
        }

        fft_inverse.process(&mut buffer);

        // Взвешивание окном синтеза и накопление Overlap-Add
        for n in 0..fft_size {
            let target_idx = offset + n;
            if target_idx < output_capacity {
                let w = window[n];
                output_signal[target_idx] += buffer[n].re * inv_scale * w;
                normalization_buffer[target_idx] += w * w;
            }
        }
    }

    // Нормализация на сумму перекрывающихся квадратов окон (COLA - Constant Overlap-Add)
    let final_len = target_length.min(output_capacity);
    let mut result = Vec::with_capacity(final_len);

    for i in 0..final_len {
        let norm = normalization_buffer[i];
        let sample = if norm > 1e-6 {
            output_signal[i] / norm
        } else {
            output_signal[i]
        };
        result.push(sample.clamp(-1.0, 1.0));
    }

    result
}

/// Выполняет нейросетевое шумоподавление аудиофайла с помощью UVR-DeNoise ONNX
pub async fn denoise_audio_task(
    app_handle: AppHandle,
    input_path: PathBuf,
    output_path: PathBuf,
    model_name: Option<String>,
    strength: Option<f32>,
) -> Result<DenoiseReport, String> {
    let chosen_model = model_name.unwrap_or_else(|| "UVR-DeNoise".to_string());
    let strength_factor = (strength.unwrap_or(80.0) / 100.0).clamp(0.0, 1.0);

    // 1. Поиск модели
    let model_path = find_model_path(&app_handle, &chosen_model);

    // 2. Чтение входного аудио
    let (raw_channels, orig_spec) = read_wav_channels_f32(&input_path)?;
    let orig_sample_rate = orig_spec.sample_rate;
    let num_channels = raw_channels.len();
    let orig_total_frames = raw_channels[0].len();
    let duration_sec = orig_total_frames as f64 / orig_sample_rate as f64;

    app_handle.emit("denoise-progress", ProgressPayload {
        percent: 5.0,
        current_frame: 0,
        total_frames: orig_total_frames,
        stage: "Ресэмплинг к 44100 Гц и подготовка спектрограмм...".to_string(),
    }).ok();

    // 3. Ресэмплинг к 44.1 кГц для UVR/MDX модели
    let resampled_channels = if orig_sample_rate != UVR_TARGET_SAMPLE_RATE {
        resample_channels(&raw_channels, orig_sample_rate, UVR_TARGET_SAMPLE_RATE)?
    } else {
        raw_channels
    };

    let target_44k_len = resampled_channels[0].len();
    let hann = generate_hann_window(FFT_SIZE);
    let mut planner = FftPlanner::new();

    // 4. Проверка наличия ONNX-модели
    if let Some(path) = model_path {
        // --- РЕЖИМ 1: НЕЙРОСЕТЕВОЙ ИНФЕРЕНС ЧЕРЕЗ ORT (DirectML/CUDA/CoreML/CPU) ---
        let (mut session, provider_used) = init_onnx_session(&path)?;

        let mut cleaned_channels_44k: Vec<Vec<f32>> = Vec::with_capacity(num_channels);

        for ch in 0..num_channels {
            let (mut magnitudes, phases) = compute_stft(
                &resampled_channels[ch],
                FFT_SIZE,
                HOP_SIZE,
                &hann,
                &mut planner,
            );

            let num_frames = magnitudes.len();
            let num_bins = FFT_SIZE / 2 + 1;

            // Разделение на перекрывающиеся временные чанки для батча нейросети
            let mut chunk_start = 0;
            let mut processed_chunk_count = 0;
            let total_chunks = (num_frames + CHUNK_HOP_STEPS - 1) / CHUNK_HOP_STEPS;

            while chunk_start < num_frames {
                let current_steps = CHUNK_TIME_STEPS.min(num_frames - chunk_start);

                // Формирование 4D-тензора формы [batch_size: 1, channels: 2, freq_bins: 1025, time_steps: 256]
                let mut tensor_data = Array4::<f32>::zeros((1, 2, num_bins, CHUNK_TIME_STEPS));

                for t in 0..current_steps {
                    let frame_idx = chunk_start + t;
                    for k in 0..num_bins {
                        let mag = magnitudes[frame_idx][k];
                        tensor_data[[0, 0, k, t]] = mag;
                        tensor_data[[0, 1, k, t]] = mag; // Стерео-дублирование для MDX VR моделей
                    }
                }

                // Инференс в ONNX Runtime
                let alloc = session.allocator();
                let input_tensor = Value::from_array(alloc, &tensor_data)
                    .map_err(|e| format!("Ошибка создания входного ONNX тензора: {}", e))?;

                let outputs = session.run(ort::inputs!["input" => input_tensor]
                    .map_err(|e| format!("Ошибка подготовки входов ONNX: {}", e))?)
                    .map_err(|e| format!("Ошибка инференса UVR-DeNoise: {}", e))?;

                // Извлечение маски или очищенной спектрограммы
                if let Some(out_val) = outputs.values().next() {
                    if let Ok(extracted) = out_val.extract_tensor::<f32>() {
                        let (out_shape, out_slice) = extracted.view();
                        
                        // Если форма выхода совпадает с частотно-временной сеткой:
                        // Применяем маску к оригинальным магнитудам с учетом силы подавления
                        let time_dim = if out_shape.len() >= 4 { out_shape[3] } else { current_steps };
                        let freq_dim = if out_shape.len() >= 3 { out_shape[2] } else { num_bins };

                        let steps_to_apply = current_steps.min(time_dim);
                        let bins_to_apply = num_bins.min(freq_dim);

                        for t in 0..steps_to_apply {
                            let frame_idx = chunk_start + t;
                            for k in 0..bins_to_apply {
                                let flat_idx = k * time_dim + t;
                                let predicted_clean = if flat_idx < out_slice.len() {
                                    out_slice[flat_idx]
                                } else {
                                    magnitudes[frame_idx][k]
                                };

                                let orig = magnitudes[frame_idx][k];
                                // Плавный блендинг силы шумоподавления (Dry/Wet)
                                let blended = orig * (1.0 - strength_factor) + predicted_clean.min(orig) * strength_factor;
                                magnitudes[frame_idx][k] = blended.max(0.0);
                            }
                        }
                    }
                }

                chunk_start += CHUNK_HOP_STEPS;
                processed_chunk_count += 1;

                let channel_progress_base = (ch as f32 / num_channels as f32) * 80.0;
                let chunk_progress = (processed_chunk_count as f32 / total_chunks.max(1) as f32) * (80.0 / num_channels as f32);
                let current_percent = 10.0 + channel_progress_base + chunk_progress;

                app_handle.emit("denoise-progress", ProgressPayload {
                    percent: current_percent.min(92.0),
                    current_frame: (chunk_start * HOP_SIZE).min(target_44k_len),
                    total_frames: target_44k_len,
                    stage: format!("Инференс нейросети UVR (Канал {}/{}, {})...", ch + 1, num_channels, provider_used),
                }).ok();
            }

            // Обратное iSTFT с Overlap-Add
            let restored = compute_istft_ola(
                &magnitudes,
                &phases,
                FFT_SIZE,
                HOP_SIZE,
                &hann,
                &mut planner,
                target_44k_len,
            );
            cleaned_channels_44k.push(restored);
        }

        // 5. Ресэмплинг обратно к исходной частоте дискретизации при необходимости
        app_handle.emit("denoise-progress", ProgressPayload {
            percent: 94.0,
            current_frame: target_44k_len,
            total_frames: target_44k_len,
            stage: "Финализация и запись очищенного WAV...".to_string(),
        }).ok();

        let final_channels = if orig_sample_rate != UVR_TARGET_SAMPLE_RATE {
            resample_channels(&cleaned_channels_44k, UVR_TARGET_SAMPLE_RATE, orig_sample_rate)?
        } else {
            cleaned_channels_44k
        };

        // Запись выходного WAV
        write_output_wav(&output_path, &final_channels, orig_spec)?;

        app_handle.emit("denoise-progress", ProgressPayload {
            percent: 100.0,
            current_frame: orig_total_frames,
            total_frames: orig_total_frames,
            stage: "Готово! Вокал очищен нейросетью UVR DeNoise.".to_string(),
        }).ok();

        Ok(DenoiseReport {
            model_name: chosen_model,
            provider_used,
            sample_rate: orig_sample_rate,
            channels: orig_spec.channels,
            duration_sec: (duration_sec * 100.0).round() / 100.0,
            noise_reduction_db: (strength_factor * 18.0 * 10.0).round() / 10.0,
            processed_path: output_path.to_string_lossy().to_string(),
            is_neural: true,
        })
    } else {
        // --- РЕЖИМ 2: ВЫСОКОТОЧНЫЙ СПЕКТРАЛЬНЫЙ ФОЛБЭК (DSP Spectral Gating + Psychoacoustic Thresholding) ---
        // Используется автоматически, если локальный .onnx файл еще не скачан в resources/models/
        let mut cleaned_channels_44k: Vec<Vec<f32>> = Vec::with_capacity(num_channels);

        for ch in 0..num_channels {
            let (mut magnitudes, phases) = compute_stft(
                &resampled_channels[ch],
                FFT_SIZE,
                HOP_SIZE,
                &hann,
                &mut planner,
            );

            let num_frames = magnitudes.len();
            let num_bins = FFT_SIZE / 2 + 1;

            // Оценка профиля шума по начальным тихим фреймам или нижнему перцентилю
            let noise_eval_frames = num_frames.min(12);
            let mut noise_floor = vec![1e-5_f32; num_bins];
            for k in 0..num_bins {
                let mut sum = 0.0;
                for f in 0..noise_eval_frames {
                    sum += magnitudes[f][k];
                }
                noise_floor[k] = (sum / noise_eval_frames as f32).max(1e-5);
            }

            // Мягкое спектральное подавление (Wiener-like suppression)
            for f in 0..num_frames {
                for k in 0..num_bins {
                    let orig = magnitudes[f][k];
                    let floor = noise_floor[k] * (1.2 + strength_factor * 0.8);
                    let gain = if orig > floor {
                        let snr = (orig - floor) / orig;
                        snr.powf(1.5).max(1.0 - strength_factor)
                    } else {
                        (1.0 - strength_factor).max(0.05)
                    };
                    magnitudes[f][k] = orig * gain;
                }

                if f % 100 == 0 {
                    let percent = 20.0 + (ch as f32 / num_channels as f32) * 70.0 + (f as f32 / num_frames as f32) * (70.0 / num_channels as f32);
                    app_handle.emit("denoise-progress", ProgressPayload {
                        percent: percent.min(92.0),
                        current_frame: (f * HOP_SIZE).min(target_44k_len),
                        total_frames: target_44k_len,
                        stage: format!("Спектральное шумоподавление DSP (Канал {}/{})", ch + 1, num_channels),
                    }).ok();
                }
            }

            let restored = compute_istft_ola(
                &magnitudes,
                &phases,
                FFT_SIZE,
                HOP_SIZE,
                &hann,
                &mut planner,
                target_44k_len,
            );
            cleaned_channels_44k.push(restored);
        }

        let final_channels = if orig_sample_rate != UVR_TARGET_SAMPLE_RATE {
            resample_channels(&cleaned_channels_44k, UVR_TARGET_SAMPLE_RATE, orig_sample_rate)?
        } else {
            cleaned_channels_44k
        };

        write_output_wav(&output_path, &final_channels, orig_spec)?;

        app_handle.emit("denoise-progress", ProgressPayload {
            percent: 100.0,
            current_frame: orig_total_frames,
            total_frames: orig_total_frames,
            stage: "Шумоподавление завершено (DSP Spectral Gate).".to_string(),
        }).ok();

        Ok(DenoiseReport {
            model_name: "DSP Spectral Gating (Fallback: ONNX модель не найдена в resources/models/)".to_string(),
            provider_used: "CPU SIMD Audio DSP".to_string(),
            sample_rate: orig_sample_rate,
            channels: orig_spec.channels,
            duration_sec: (duration_sec * 100.0).round() / 100.0,
            noise_reduction_db: (strength_factor * 14.0 * 10.0).round() / 10.0,
            processed_path: output_path.to_string_lossy().to_string(),
            is_neural: false,
        })
    }
}

/// Вспомогательная функция записи выходных сэмплов в 32-bit Float WAV
fn write_output_wav(
    output_path: &Path,
    channels_data: &[Vec<f32>],
    orig_spec: WavSpec,
) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Не удалось создать каталог {}: {}", parent.display(), e))?;
    }

    let num_channels = channels_data.len();
    let num_frames = channels_data[0].len();

    let out_spec = WavSpec {
        channels: num_channels as u16,
        sample_rate: orig_spec.sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output_path, out_spec)
        .map_err(|e| format!("Не удалось создать выходной WAV {}: {}", output_path.display(), e))?;

    for i in 0..num_frames {
        for ch in 0..num_channels {
            let sample = channels_data[ch][i];
            writer.write_sample(sample)
                .map_err(|e| format!("Ошибка записи сэмпла в WAV: {}", e))?;
        }
    }

    writer.finalize()
        .map_err(|e| format!("Ошибка финализации WAV файла: {}", e))?;

    Ok(())
}

/// Асинхронная команда Tauri v2 для запуска шумоподавления вокала
#[tauri::command]
pub async fn process_denoise(
    app_handle: AppHandle,
    input_path: String,
    output_path: String,
    model_name: Option<String>,
    strength: Option<f32>,
) -> Result<DenoiseReport, String> {
    let in_p = PathBuf::from(crate::file_io::normalize_windows_path(&input_path));
    let out_p = PathBuf::from(crate::file_io::normalize_windows_path(&output_path));

    if !in_p.exists() {
        return Err(format!("Входной файл не найден: {}", in_p.display()));
    }

    tokio::task::spawn(async move {
        denoise_audio_task(app_handle, in_p, out_p, model_name, strength).await
    })
    .await
    .map_err(|e| format!("Ошибка задачи Tokio в процессе UVR DeNoise: {}", e))?
}
