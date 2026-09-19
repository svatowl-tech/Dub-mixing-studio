use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use hound::{WavReader, WavWriter, SampleFormat};
use crate::track_analysis::{TrackAnalysisReport, WaveformClassification};
use crate::logger::{log_info};
use crate::intelligent_normalization::{ClipProcessingInput};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechLevelerResult {
    pub track_id: String,
    pub processed_clips: Vec<LevelerClipResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelerClipResult {
    pub clip_id: String,
    pub original_path: String,
    pub processed_path: String,
}

/// Уровнемер речи (Speech Leveler) с компрессией и гейтированием
#[tauri::command]
pub fn process_speech_leveler(
    project_dir: String,
    track_id: String,
    clips: Vec<ClipProcessingInput>,
) -> Result<SpeechLevelerResult, String> {
    log_info(&format!("[SpeechLeveler] Processing track {} with {} clips", track_id, clips.len()));

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

    let mut processed_clips = Vec::new();

    for clip in &clips {
        let processed_path = process_single_clip_leveler(clip, report, &takes_dir)?;
        processed_clips.push(LevelerClipResult {
            clip_id: clip.id.clone(),
            original_path: clip.file_path.clone(),
            processed_path,
        });
    }

    Ok(SpeechLevelerResult {
        track_id,
        processed_clips,
    })
}

fn process_single_clip_leveler(
    clip: &ClipProcessingInput,
    report: &TrackAnalysisReport,
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

    // Настройки компрессора (RComp-style из задания)
    let threshold_db = -12.2f32;
    let ratio = 3.44f32;
    let attack_ms = 5.0f32;
    let release_ms = 250.0f32;
    let makeup_gain_db = 4.7f32;
    let makeup_gain_lin = 10.0f32.powf(makeup_gain_db / 20.0);

    // Параметры для баллистики
    let sr = sample_rate as f32;
    let attack_coeff = 1.0 - (-1.0 / (sr * (attack_ms * 0.001))).exp();
    let release_coeff = 1.0 - (-1.0 / (sr * (release_ms * 0.001))).exp();

    let mut envelope_db = -90.0f32;
    
    // Классификатор (окно 200мс)
    let _window_size_ms = 200.0;
    let _samples_per_window = (_window_size_ms / 1000.0 * sample_rate as f64) as usize;
    let num_samples = samples.len();

    // Проходим по сэмплам
    for i in (0..num_samples).step_by(channels) {
        // Определяем классификацию для текущего момента времени
        let clip_time_ms = (i / channels) as f64 * 1000.0 / sample_rate as f64;
        let timeline_time_ms = clip.start_time_ms + clip_time_ms;

        let segment = report.segments.iter().find(|s| {
            timeline_time_ms >= s.start_ms && timeline_time_ms < (s.start_ms + s.duration_ms)
        });

        let classification = segment.map(|s| s.classification.clone()).unwrap_or(WaveformClassification::Silence);

        // Если это шум или тишина после шумодава - отрезаем (гейтируем)
        if classification == WaveformClassification::Silence || classification == WaveformClassification::Noise {
            for ch in 0..channels {
                if i + ch < num_samples {
                    samples[i + ch] = 0.0;
                }
            }
            // Сбрасываем детектор компрессора медленно
            envelope_db += (-90.0 - envelope_db) * release_coeff;
            continue;
        }

        // Обработка компрессором для Speech и QuietFragment
        // Берем макс амплитуду по всем каналам для детектора
        let mut max_abs = 0.0f32;
        for ch in 0..channels {
            if i + ch < num_samples {
                max_abs = max_abs.max(samples[i + ch].abs());
            }
        }
        let input_db = 20.0 * max_abs.max(1e-6).log10();

        // Баллистика
        if input_db > envelope_db {
            envelope_db += (input_db - envelope_db) * attack_coeff;
        } else {
            envelope_db += (input_db - envelope_db) * release_coeff;
        }

        // Коэффициент сжатия
        let mut gr_db = 0.0f32;
        if envelope_db > threshold_db {
            gr_db = -(envelope_db - threshold_db) * (1.0 - 1.0 / ratio);
        }
        let gr_lin = 10.0f32.powf(gr_db / 20.0);

        // Применяем подавление и макияжный гейн
        for ch in 0..channels {
            if i + ch < num_samples {
                samples[i + ch] *= gr_lin * makeup_gain_lin;
            }
        }
    }

    // Сохранение
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let file_stem = p.file_stem().unwrap().to_str().unwrap();
    let output_path = output_dir.join(format!("{}_leveled_{}.wav", file_stem, timestamp));
    
    let mut writer = WavWriter::create(&output_path, spec).map_err(|e| e.to_string())?;
    for &s in &samples {
        writer.write_sample(s).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(output_path.to_str().unwrap().to_string())
}
