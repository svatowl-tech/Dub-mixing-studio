use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use hound::{WavReader, WavWriter, WavSpec, SampleFormat};
use rustfft::{FftPlanner, num_complex::Complex32};
use crate::track_analysis::{TrackAnalysisReport};
use crate::logger::{log_debug, log_info};
use crate::intelligent_normalization::{ClipProcessingInput};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectralBalancingResult {
    pub track_id: String,
    pub processed_clips: Vec<SpectralClipResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectralClipResult {
    pub clip_id: String,
    pub original_path: String,
    pub processed_path: String,
}

/// Выравнивание спектра на основе анализа
#[tauri::command]
pub fn process_spectral_balancing(
    project_dir: String,
    track_id: String,
    clips: Vec<ClipProcessingInput>,
) -> Result<SpectralBalancingResult, String> {
    log_info(&format!("[SpectralBalancing] Processing track {} with {} clips", track_id, clips.len()));

    // 1. Загрузка анализа
    let norm_project_dir = crate::file_io::normalize_windows_path(&project_dir);
    let analysis_file_path = Path::new(&norm_project_dir).join(".dubstudio").join("track_analysis.json");
    
    if !analysis_file_path.exists() {
        return Err("Analysis cache not found. Run analysis first.".to_string());
    }

    let json_str = fs::read_to_string(&analysis_file_path).map_err(|e| e.to_string())?;
    let reports: Vec<TrackAnalysisReport> = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
    
    let report = reports.iter().find(|r| r.track_id == track_id)
        .ok_or_else(|| format!("Analysis for track {} not found", track_id))?;

    // 2. Создание папки для результатов
    let takes_dir = Path::new(&norm_project_dir).join("takes");
    if !takes_dir.exists() {
        let _ = fs::create_dir_all(&takes_dir);
    }

    // 3. Рассчитываем целевой фильтр (спектральную коррекцию)
    // У нас есть 64 бина усредненного спектра в отчете.
    let correction_filter = calculate_correction_filter(&report.spectral_state.spectrum_db);

    let mut processed_clips = Vec::new();

    for clip in &clips {
        let processed_path = process_single_clip_spectral(&clip, &correction_filter, &takes_dir)?;
        processed_clips.push(SpectralClipResult {
            clip_id: clip.id.clone(),
            original_path: clip.file_path.clone(),
            processed_path,
        });
    }

    Ok(SpectralBalancingResult {
        track_id,
        processed_clips,
    })
}

/// Рассчитывает коэффициент усиления для каждого частотного диапазона
fn calculate_correction_filter(current_spectrum_db: &[f32]) -> Vec<f32> {
    let num_bins = current_spectrum_db.len(); // 64
    
    // Идеальная кривая для голоса (примерная):
    // - Низкие до 200Гц: плавный спад
    // - Середина 200-4000Гц: более-менее ровно
    // - Высокие > 4000Гц: постепенный спад -3dB на октаву
    let mut target_curve = Vec::with_capacity(num_bins);
    for i in 0..num_bins {
        // Мы работаем с 64 бинами от 0 до 24000Гц (при 48к SR)
        let freq = (i as f32 / num_bins as f32) * 24000.0;
        
        let target_db = if freq < 100.0 {
            -15.0 // Срез суббаса
        } else if freq < 300.0 {
            -3.0 // Небольшой акцент на низах
        } else if freq < 3500.0 {
            0.0 // Основной диапазон
        } else {
            // Спад высоких: -3dB на октаву после 3.5kHz
            let octaves_above = (freq / 3500.0).log2();
            (-3.0 * octaves_above).max(-12.0)
        };
        target_curve.push(target_db);
    }

    // Находим "нормализационный" уровень, чтобы не задрать всю громкость вверх
    // Берем среднее значение середины (200-3000 Гц)
    let mid_start = (num_bins as f32 * 200.0 / 24000.0) as usize;
    let mid_end = (num_bins as f32 * 3000.0 / 24000.0) as usize;
    
    let mut current_mid_avg = 0.0;
    let mut count = 0;
    for i in mid_start..mid_end {
        if current_spectrum_db[i] > -100.0 {
            current_mid_avg += current_spectrum_db[i];
            count += 1;
        }
    }
    if count > 0 {
        current_mid_avg /= count as f32;
    } else {
        current_mid_avg = -40.0;
    }

    let mut correction = Vec::with_capacity(num_bins);
    for i in 0..num_bins {
        // Разница между текущим спектром и целью (с учетом общего уровня середины)
        // Мы хотим, чтобы текущий спектр совпал с target_curve
        // current[i] + gain[i] = current_mid_avg + target_curve[i]
        // gain[i] = target_curve[i] + current_mid_avg - current[i]
        
        let mut gain_db = target_curve[i] + (current_mid_avg - current_spectrum_db[i]);
        
        // Ограничиваем коррекцию, чтобы не испортить звук (+/- 12dB)
        gain_db = gain_db.clamp(-12.0, 12.0);
        
        // Добавляем HPF 60Hz и LPF 20kHz
        let freq = (i as f32 / num_bins as f32) * 24000.0;
        if freq < 60.0 {
            gain_db -= 48.0; // Резкий срез
        } else if freq > 20000.0 {
            gain_db -= 48.0; // Резкий срез
        }

        correction.push(10.0f32.powf(gain_db / 20.0));
    }

    correction
}

fn process_single_clip_spectral(
    clip: &ClipProcessingInput,
    correction_filter: &[f32],
    output_dir: &Path,
) -> Result<String, String> {
    let norm_path = crate::file_io::normalize_windows_path(&clip.file_path);
    let p = Path::new(&norm_path);
    if !p.exists() {
        return Err(format!("Clip file not found: {}", norm_path));
    }

    let mut reader = WavReader::open(p).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels as usize;

    let mut samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            if bits <= 16 {
                reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / 32768.0).collect()
            } else if bits <= 24 {
                reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 8388608.0).collect()
            } else {
                reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / i32::MAX as f32).collect()
            }
        }
    };

    // Применение эквализации через БПФ (STFT)
    let fft_size = 2048;
    let hop_size = 512; // Большое перекрытие для минимизации артефактов
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(fft_size);
    let ifft = planner.plan_fft_inverse(fft_size);
    
    // Окно Ханна
    let mut window = Vec::with_capacity(fft_size);
    use std::f32::consts::PI;
    for i in 0..fft_size {
        window.push(0.5 * (1.0 - (2.0 * PI * i as f32 / (fft_size - 1) as f32).cos()));
    }

    // Для каждого канала отдельно
    for ch in 0..channels {
        let mut ch_samples: Vec<f32> = samples.iter().enumerate()
            .filter(|(i, _)| i % channels == ch)
            .map(|(_, &s)| s)
            .collect();

        let num_samples = ch_samples.len();
        let mut output_samples = vec![0.0f32; num_samples + fft_size];
        
        let num_frames = if num_samples >= fft_size {
            (num_samples - fft_size) / hop_size + 1
        } else {
            0
        };

        for f in 0..num_frames {
            let offset = f * hop_size;
            let mut buffer: Vec<Complex32> = (0..fft_size)
                .map(|i| Complex32::new(ch_samples[offset + i] * window[i], 0.0))
                .collect();

            fft.process(&mut buffer);

            // Применяем фильтр к бинам
            // correction_filter имеет 64 значения, интерполируем их до fft_size/2
            let num_corr = correction_filter.len();
            for k in 0..=(fft_size / 2) {
                let bin_freq_ratio = k as f32 / (fft_size / 2) as f32;
                let corr_idx = (bin_freq_ratio * (num_corr - 1) as f32) as usize;
                let corr_next = (corr_idx + 1).min(num_corr - 1);
                let frac = (bin_freq_ratio * (num_corr - 1) as f32) - corr_idx as f32;
                
                let gain = correction_filter[corr_idx] * (1.0 - frac) + correction_filter[corr_next] * frac;
                
                buffer[k] *= gain;
                if k > 0 && k < fft_size / 2 {
                    buffer[fft_size - k] *= gain;
                }
            }

            ifft.process(&mut buffer);

            // Overlap-add
            let norm = 1.0 / fft_size as f32;
            for i in 0..fft_size {
                output_samples[offset + i] += buffer[i].re * norm * window[i];
            }
        }

        // Возвращаем обработанные сэмплы в основной массив
        for i in 0..num_samples {
            samples[i * channels + ch] = output_samples[i];
        }
    }

    // Сохранение
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let file_stem = p.file_stem().unwrap().to_str().unwrap();
    let output_path = output_dir.join(format!("{}_balanced_{}.wav", file_stem, timestamp));
    
    let mut writer = WavWriter::create(&output_path, spec).map_err(|e| e.to_string())?;
    for &s in &samples {
        writer.write_sample(s).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(output_path.to_str().unwrap().to_string())
}
