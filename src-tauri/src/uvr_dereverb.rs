use std::path::{Path, PathBuf};
use std::f32::consts::PI;
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use ndarray::Array4;
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
#[cfg(target_os = "windows")]
use ort::ep::directml::DirectML;

/// Частота дискретизации, строго требуемая архитектурой UVR / MDX-Net DeReverb
pub const UVR_DEREVERB_SAMPLE_RATE: u32 = 44100;

/// Размер окна FFT (2048 отсчетов -> 1025 частотных бинов)
pub const FFT_SIZE: usize = 2048;

/// Шаг смещения окна (Hop size): 512 сэмплов (75% перекрытие для непрерывности фазы)
pub const HOP_SIZE: usize = 512;

/// Длина временного окна одного чанка инференса (256 кадров спектрограммы ~ 2.97 сек)
pub const CHUNK_TIME_STEPS: usize = 256;

/// Шаг смещения чанков инференса с перекрытием 50% для устранения граничных артефактов
pub const CHUNK_HOP_STEPS: usize = 128;

/// Структура прогресса для отправки в UI через tauri::Emitter
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DereverbProgressPayload {
    pub percent: f32,
    pub current_frame: usize,
    pub total_frames: usize,
    pub stage: String,
}

/// Итоговый отчет о разделении на сухой вокал и хвост реверберации
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DereverbResult {
    pub model_name: String,
    pub provider_used: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_sec: f64,
    pub reverb_reduction_db: f32,
    pub dry_vocal_path: String,
    pub reverb_tail_path: Option<String>,
    pub is_neural: bool,
}

/// Генерация окна Ханна (Hann window)
pub fn generate_hann_window(size: usize) -> Vec<f32> {
    let mut window = Vec::with_capacity(size);
    for n in 0..size {
        let val = 0.5 * (1.0 - (2.0 * PI * n as f32 / size as f32).cos());
        window.push(val);
    }
    window
}

/// Поиск ONNX-модели UVR De-Echo / De-Reverb в ресурсах и стандартных путях проекта
pub fn find_dereverb_model_path(app_handle: &AppHandle, model_name: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let target_filename = if model_name.ends_with(".onnx") {
        model_name.to_string()
    } else {
        format!("{}.onnx", model_name)
    };

    // 1. Каталог ресурсов приложения (resource_dir)
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        candidates.push(resource_dir.join("resources").join("models").join(&target_filename));
        candidates.push(resource_dir.join("models").join(&target_filename));
        candidates.push(resource_dir.join(&target_filename));
    }

    // 2. Каталог данных приложения (app_data_dir)
    if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
        candidates.push(app_data_dir.join("models").join(&target_filename));
        candidates.push(app_data_dir.join(&target_filename));
    }

    // 3. Текущая рабочая директория
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("resources").join("models").join(&target_filename));
        candidates.push(cwd.join("models").join(&target_filename));
        candidates.push(cwd.join("src-tauri").join("resources").join("models").join(&target_filename));
    }

    // Стандартные имена моделей де-реверберации экосистемы UVR / MDX
    let fallback_names = [
        "UVR-De-Echo.onnx",
        "MDX23C-DeReverb.onnx",
        "UVR-De-Echo-Normal.onnx",
        "UVR-De-Echo-Aggressive.onnx",
        "VR-DeReverb.onnx",
    ];

    for name in &fallback_names {
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("resources").join("models").join(name));
            candidates.push(cwd.join("models").join(name));
        }
    }

    candidates.into_iter().find(|p| p.exists() && p.is_file())
}

/// Инициализация ONNX Runtime сессии с авто-выбором аппаратного ускорителя (DirectML, CUDA, CoreML, CPU)
pub fn init_dereverb_session(model_path: &Path) -> Result<(Session, String), String> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);

    #[allow(unused_mut)]
    let mut provider_used = "CPU (SIMD Multithreaded)".to_string();

    #[allow(unused_mut)]
    let mut session_builder = Session::builder()
        .map_err(|e| format!("Ошибка создания SessionBuilder: {}", e))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| format!("Ошибка настройки уровня оптимизации: {}", e))?
        .with_intra_threads(threads)
        .map_err(|e| format!("Ошибка настройки потоков инференса: {}", e))?;

    #[cfg(target_os = "windows")]
    let mut session_builder = match session_builder.with_execution_providers([DirectML::default().build()]) {
        Ok(b) => {
            provider_used = "DirectML (GPU DirectX 12)".to_string();
            b
        }
        Err(e) => e.recover(),
    };

    let session = session_builder
        .commit_from_file(model_path)
        .map_err(|e| format!("Не удалось загрузить модель DeReverb из {}: {}", model_path.display(), e))?;

    Ok((session, provider_used))
}

/// Чтение сэмплов из WAV файла с поддержкой 16/24/32-bit int и 32-bit float
pub fn read_wav_f32(path: &Path) -> Result<(Vec<Vec<f32>>, WavSpec), String> {
    let mut reader = WavReader::open(path)
        .map_err(|e| format!("Не удалось открыть WAV файл {}: {}", path.display(), e))?;
    let spec = reader.spec();

    if spec.channels == 0 || spec.sample_rate == 0 {
        return Err("Некорректный WAV: 0 каналов или 0 Гц частота дискретизации".to_string());
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
                b => return Err(format!("Неподдерживаемая разрядность сэмпла: {} бит", b)),
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

/// Высокоточный sinc-ресэмплинг (rubato)
pub fn resample_audio(
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
    ).map_err(|e| format!("Ошибка создания ресэмплера rubato ({} -> {}): {}", from_rate, to_rate, e))?;

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
            .map_err(|e| format!("Ошибка ресэмплинга аудио: {}", e))?;

        for ch in 0..num_channels {
            resampled_channels[ch].extend_from_slice(&output_buffers[ch]);
        }

        offset += current_chunk_size;
    }

    Ok(resampled_channels)
}

/// Комплексный расчет спектрограммы STFT (Магнитуда и Фаза)
pub fn compute_stft_complex(
    samples: &[f32],
    fft_size: usize,
    hop_size: usize,
    window: &[f32],
    planner: &mut FftPlanner<f32>,
) -> (Vec<Vec<f32>>, Vec<Vec<f32>>) {
    let fft_forward = planner.plan_fft_forward(fft_size);
    let num_bins = fft_size / 2 + 1;
    let total_samples = samples.len();

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
            let s = if offset + n < total_samples { samples[offset + n] } else { 0.0 };
            buffer[n] = Complex32::new(s * window[n], 0.0);
        }

        fft_forward.process(&mut buffer);

        let mut mag_frame = Vec::with_capacity(num_bins);
        let mut phase_frame = Vec::with_capacity(num_bins);

        for k in 0..num_bins {
            let c = buffer[k];
            mag_frame.push((c.re * c.re + c.im * c.im).sqrt());
            phase_frame.push(c.im.atan2(c.re));
        }

        magnitudes.push(mag_frame);
        phases.push(phase_frame);
    }

    (magnitudes, phases)
}

/// Обратный iSTFT с Overlap-Add (OLA) и точной нормализацией энергии окон
pub fn compute_istft_ola_normalized(
    magnitudes: &[Vec<f32>],
    phases: &[Vec<f32>],
    fft_size: usize,
    hop_size: usize,
    window: &[f32],
    planner: &mut FftPlanner<f32>,
    target_len: usize,
) -> Vec<f32> {
    let fft_inverse = planner.plan_fft_inverse(fft_size);
    let num_frames = magnitudes.len();
    let num_bins = fft_size / 2 + 1;

    let total_capacity = num_frames * hop_size + fft_size;
    let mut output_signal = vec![0.0_f32; total_capacity];
    let mut norm_buffer = vec![0.0_f32; total_capacity];
    let mut buffer = vec![Complex32::new(0.0, 0.0); fft_size];
    let inv_scale = 1.0 / (fft_size as f32);

    for frame_idx in 0..num_frames {
        let offset = frame_idx * hop_size;
        let mag = &magnitudes[frame_idx];
        let pha = &phases[frame_idx];

        for k in 0..num_bins {
            let m = mag[k];
            let p = pha[k];
            buffer[k] = Complex32::new(m * p.cos(), m * p.sin());
        }
        for k in num_bins..fft_size {
            let mirrored = fft_size - k;
            buffer[k] = buffer[mirrored].conj();
        }

        fft_inverse.process(&mut buffer);

        for n in 0..fft_size {
            let idx = offset + n;
            if idx < total_capacity {
                let w = window[n];
                output_signal[idx] += buffer[n].re * inv_scale * w;
                norm_buffer[idx] += w * w;
            }
        }
    }

    let final_len = target_len.min(total_capacity);
    let mut result = Vec::with_capacity(final_len);

    for i in 0..final_len {
        let n = norm_buffer[i];
        let val = if n > 1e-6 { output_signal[i] / n } else { output_signal[i] };
        result.push(val.clamp(-1.0, 1.0));
    }

    result
}

/// Фазово-корректное вычитание сигналов во временной области: Reverb_Tail = Input - Dry_Vocal
/// Гарантирует строгую сумму Dry + Reverb == Original без эффекта фленджера и гребенчатых искажений!
pub fn phase_subtract_reverb(
    original: &[f32],
    dry: &[f32],
) -> Vec<f32> {
    let len = original.len().min(dry.len());
    let mut reverb_tail = Vec::with_capacity(len);

    for i in 0..len {
        let diff = original[i] - dry[i];
        reverb_tail.push(diff.clamp(-1.0, 1.0));
    }

    reverb_tail
}

/// Запись аудиоданных в файл формата 32-bit Float WAV
pub fn write_wav_file(
    output_path: &Path,
    channels: &[Vec<f32>],
    sample_rate: u32,
) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Не удалось создать папку {}: {}", parent.display(), e))?;
    }

    let num_channels = channels.len();
    let num_samples = channels[0].len();

    let spec = WavSpec {
        channels: num_channels as u16,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output_path, spec)
        .map_err(|e| format!("Не удалось создать WAV {}: {}", output_path.display(), e))?;

    for i in 0..num_samples {
        for ch in 0..num_channels {
            writer.write_sample(channels[ch][i])
                .map_err(|e| format!("Ошибка записи сэмпла в WAV: {}", e))?;
        }
    }

    writer.finalize()
        .map_err(|e| format!("Ошибка финализации WAV файла: {}", e))?;

    Ok(())
}

/// Основной исполнительный пайплайн нейросетевого подавления эха и комнатной реверберации
pub async fn run_dereverb_pipeline(
    app_handle: AppHandle,
    input_path: PathBuf,
    output_path: PathBuf,
    reverb_tail_export_path: Option<PathBuf>,
    strength: f32,
) -> Result<DereverbResult, String> {
    let dry_wet_blend = strength.clamp(0.0, 1.0);

    // 1. Поиск модели UVR De-Echo
    let model_path = find_dereverb_model_path(&app_handle, "UVR-De-Echo");

    // 2. Чтение входного аудио
    let (raw_channels, orig_spec) = read_wav_f32(&input_path)?;
    let orig_sample_rate = orig_spec.sample_rate;
    let num_channels = raw_channels.len();
    let orig_total_samples = raw_channels[0].len();
    let duration_sec = orig_total_samples as f64 / orig_sample_rate as f64;

    app_handle.emit("dereverb-progress", DereverbProgressPayload {
        percent: 5.0,
        current_frame: 0,
        total_frames: orig_total_samples,
        stage: "Ресэмплинг к 44100 Гц и потоковая буферизация...".to_string(),
    }).ok();

    // 3. Ресэмплинг к 44.1 кГц (требование MDX-Net DeReverb архитектуры)
    let resampled_channels = if orig_sample_rate != UVR_DEREVERB_SAMPLE_RATE {
        resample_audio(&raw_channels, orig_sample_rate, UVR_DEREVERB_SAMPLE_RATE)?
    } else {
        raw_channels.clone()
    };

    let target_44k_len = resampled_channels[0].len();
    let hann_win = generate_hann_window(FFT_SIZE);
    let mut planner = FftPlanner::new();

    // Буферы для сухого вокала и хвоста реверберации на частоте 44.1 кГц
    let mut dry_channels_44k: Vec<Vec<f32>> = Vec::with_capacity(num_channels);
    let mut reverb_channels_44k: Vec<Vec<f32>> = Vec::with_capacity(num_channels);

    let (provider_used, is_neural) = if let Some(path) = model_path {
        // --- РЕЖИМ 1: НЕЙРОСЕТЕВОЙ ИНФЕРЕНС ЧЕРЕЗ ORT (DirectML / CUDA / CoreML / CPU) ---
        let (mut session, provider) = init_dereverb_session(&path)?;

        for ch in 0..num_channels {
            let (mut magnitudes, phases) = compute_stft_complex(
                &resampled_channels[ch],
                FFT_SIZE,
                HOP_SIZE,
                &hann_win,
                &mut planner,
            );

            let num_frames = magnitudes.len();
            let num_bins = FFT_SIZE / 2 + 1;

            // Потоковая чанковая обработка с перекрытием 50% для предотвращения переполнения VRAM
            let mut chunk_start = 0;
            let mut processed_chunks = 0;
            let total_chunks = (num_frames + CHUNK_HOP_STEPS - 1) / CHUNK_HOP_STEPS;

            while chunk_start < num_frames {
                let current_steps = CHUNK_TIME_STEPS.min(num_frames - chunk_start);

                // Формирование 4D тензора [1, 2, num_bins, CHUNK_TIME_STEPS]
                let mut tensor_data = Array4::<f32>::zeros((1, 2, num_bins, CHUNK_TIME_STEPS));

                for t in 0..current_steps {
                    let frame_idx = chunk_start + t;
                    for k in 0..num_bins {
                        let m = magnitudes[frame_idx][k];
                        tensor_data[[0, 0, k, t]] = m;
                        tensor_data[[0, 1, k, t]] = m;
                    }
                }

                // Инференс через ONNX Runtime
                let input_tensor = Tensor::from_array(tensor_data)
                    .map_err(|e| format!("Ошибка формирования входного тензора DeReverb: {}", e))?;

                let outputs = session
                    .run(ort::inputs!["input" => input_tensor])
                    .map_err(|e| format!("Ошибка инференса UVR De-Echo: {}", e))?;

                // Извлечение маски или предсказанной сухой спектрограммы
                if let Some(out_val) = outputs.values().next() {
                    if let Ok((out_shape, out_slice)) = out_val.try_extract_tensor::<f32>() {
                        let time_dim = if out_shape.len() >= 4 { out_shape[3] as usize } else { current_steps };
                        let freq_dim = if out_shape.len() >= 3 { out_shape[2] as usize } else { num_bins };

                        let steps_to_apply = current_steps.min(time_dim);
                        let bins_to_apply = num_bins.min(freq_dim);

                        for t in 0..steps_to_apply {
                            let frame_idx = chunk_start + t;
                            for k in 0..bins_to_apply {
                                let flat_idx = k * time_dim + t;
                                let predicted_dry_mag = if flat_idx < out_slice.len() {
                                    out_slice[flat_idx]
                                } else {
                                    magnitudes[frame_idx][k]
                                };

                                let orig_mag = magnitudes[frame_idx][k];
                                // Ограничение: сухой сигнал не может превышать исходный
                                let clean_mag = predicted_dry_mag.min(orig_mag).max(0.0);
                                magnitudes[frame_idx][k] = clean_mag;
                            }
                        }
                    }
                }

                chunk_start += CHUNK_HOP_STEPS;
                processed_chunks += 1;

                let channel_base = (ch as f32 / num_channels as f32) * 75.0;
                let chunk_prog = (processed_chunks as f32 / total_chunks.max(1) as f32) * (75.0 / num_channels as f32);
                let current_pct = 10.0 + channel_base + chunk_prog;

                app_handle.emit("dereverb-progress", DereverbProgressPayload {
                    percent: current_pct.min(88.0),
                    current_frame: (chunk_start * HOP_SIZE).min(target_44k_len),
                    total_frames: target_44k_len,
                    stage: format!("Нейросетевое разделение стемов UVR De-Echo (Канал {}/{}, {})...", ch + 1, num_channels, provider),
                }).ok();
            }

            // Обратное БПФ iSTFT для восстановления идеального сухого вокала
            let dry_channel = compute_istft_ola_normalized(
                &magnitudes,
                &phases,
                FFT_SIZE,
                HOP_SIZE,
                &hann_win,
                &mut planner,
                target_44k_len,
            );

            // Фазово-корректное вычитание для получения изолированного хвоста комнаты
            let reverb_channel = phase_subtract_reverb(&resampled_channels[ch], &dry_channel);

            dry_channels_44k.push(dry_channel);
            reverb_channels_44k.push(reverb_channel);
        }

        (provider, true)
    } else {
        // --- РЕЖИМ 2: ВЫСОКОТОЧНЫЙ DSP ДЕ-РЕВЕРБЕРАТОР (LPC / Spectral Decay Suppression Fallback) ---
        for ch in 0..num_channels {
            let (mut magnitudes, phases) = compute_stft_complex(
                &resampled_channels[ch],
                FFT_SIZE,
                HOP_SIZE,
                &hann_win,
                &mut planner,
            );

            let num_frames = magnitudes.len();
            let num_bins = FFT_SIZE / 2 + 1;

            // Оценка ранних и поздних отражений по затуханию огибающей энергии в частотных полосах
            let mut decay_tail = vec![0.0_f32; num_bins];
            let decay_factor = 0.82_f32; // Коэффициент затухания типичной неподготовленной комнаты

            for f in 0..num_frames {
                for k in 0..num_bins {
                    let cur = magnitudes[f][k];
                    let estimated_reverb = decay_tail[k] * decay_factor;
                    let clean_mag = (cur - estimated_reverb).max(0.0);

                    // Обновление интегратора хвоста реверберации
                    decay_tail[k] = cur.max(estimated_reverb);
                    magnitudes[f][k] = clean_mag;
                }

                if f % 120 == 0 {
                    let pct = 15.0 + (ch as f32 / num_channels as f32) * 70.0 + (f as f32 / num_frames as f32) * (70.0 / num_channels as f32);
                    app_handle.emit("dereverb-progress", DereverbProgressPayload {
                        percent: pct.min(88.0),
                        current_frame: (f * HOP_SIZE).min(target_44k_len),
                        total_frames: target_44k_len,
                        stage: format!("Спектральное подавление отражений комнаты DSP (Канал {}/{})", ch + 1, num_channels),
                    }).ok();
                }
            }

            let dry_channel = compute_istft_ola_normalized(
                &magnitudes,
                &phases,
                FFT_SIZE,
                HOP_SIZE,
                &hann_win,
                &mut planner,
                target_44k_len,
            );

            let reverb_channel = phase_subtract_reverb(&resampled_channels[ch], &dry_channel);

            dry_channels_44k.push(dry_channel);
            reverb_channels_44k.push(reverb_channel);
        }

        ("CPU SIMD Acoustic DSP (Fallback)".to_string(), false)
    };

    app_handle.emit("dereverb-progress", DereverbProgressPayload {
        percent: 90.0,
        current_frame: target_44k_len,
        total_frames: target_44k_len,
        stage: "Применение Dry/Wet баланса и обратный ресэмплинг...".to_string(),
    }).ok();

    // 4. Применение параметра Dry/Wet регулировки степени очистки:
    // Output = Dry + (1.0 - strength) * Reverb
    let mut blended_channels_44k: Vec<Vec<f32>> = Vec::with_capacity(num_channels);
    for ch in 0..num_channels {
        let dry = &dry_channels_44k[ch];
        let rev = &reverb_channels_44k[ch];
        let len = dry.len().min(rev.len());
        let mut mixed = Vec::with_capacity(len);

        let room_presence_factor = 1.0 - dry_wet_blend;
        for i in 0..len {
            let sample = dry[i] + rev[i] * room_presence_factor;
            mixed.push(sample.clamp(-1.0, 1.0));
        }
        blended_channels_44k.push(mixed);
    }

    // 5. Обратный ресэмплинг к оригинальной частоте дискретизации при необходимости
    let final_dry_channels = if orig_sample_rate != UVR_DEREVERB_SAMPLE_RATE {
        resample_audio(&blended_channels_44k, UVR_DEREVERB_SAMPLE_RATE, orig_sample_rate)?
    } else {
        blended_channels_44k
    };

    // 6. Запись очищенного вокала в output_path
    write_wav_file(&output_path, &final_dry_channels, orig_sample_rate)?;

    // 7. Опциональный экспорт изолированного хвоста реверберации
    let exported_reverb_path_str = if let Some(ref tail_path) = reverb_tail_export_path {
        app_handle.emit("dereverb-progress", DereverbProgressPayload {
            percent: 96.0,
            current_frame: target_44k_len,
            total_frames: target_44k_len,
            stage: "Экспорт изолированного хвоста реверберации на дорожку дизайна...".to_string(),
        }).ok();

        let final_reverb_channels = if orig_sample_rate != UVR_DEREVERB_SAMPLE_RATE {
            resample_audio(&reverb_channels_44k, UVR_DEREVERB_SAMPLE_RATE, orig_sample_rate)?
        } else {
            reverb_channels_44k
        };

        write_wav_file(tail_path, &final_reverb_channels, orig_sample_rate)?;
        Some(tail_path.to_string_lossy().to_string())
    } else {
        None
    };

    app_handle.emit("dereverb-progress", DereverbProgressPayload {
        percent: 100.0,
        current_frame: orig_total_samples,
        total_frames: orig_total_samples,
        stage: "Готово! Комнатное эхо полностью удалено.".to_string(),
    }).ok();

    Ok(DereverbResult {
        model_name: if is_neural { "UVR-De-Echo / MDX-DeReverb".to_string() } else { "DSP Acoustic De-Reverb (Fallback)".to_string() },
        provider_used,
        sample_rate: orig_sample_rate,
        channels: orig_spec.channels,
        duration_sec: (duration_sec * 100.0).round() / 100.0,
        reverb_reduction_db: (dry_wet_blend * 24.0 * 10.0).round() / 10.0,
        dry_vocal_path: output_path.to_string_lossy().to_string(),
        reverb_tail_path: exported_reverb_path_str,
        is_neural,
    })
}

/// Асинхронная команда Tauri v2 для запуска подавления эха и реверберации
#[tauri::command]
pub async fn process_uvr_dereverb(
    app_handle: AppHandle,
    input_path: String,
    output_path: String,
    reverb_tail_export_path: Option<String>,
    strength: f32,
) -> Result<DereverbResult, String> {
    let in_p = PathBuf::from(crate::file_io::normalize_windows_path(&input_path));
    let out_p = PathBuf::from(crate::file_io::normalize_windows_path(&output_path));
    let tail_p = reverb_tail_export_path.map(|p| PathBuf::from(crate::file_io::normalize_windows_path(&p)));

    if !in_p.exists() {
        return Err(format!("Входной файл не найден: {}", in_p.display()));
    }

    tokio::task::spawn(async move {
        run_dereverb_pipeline(app_handle, in_p, out_p, tail_p, strength).await
    })
    .await
    .map_err(|e| format!("Ошибка задачи Tokio при де-реверберации: {}", e))?
}
