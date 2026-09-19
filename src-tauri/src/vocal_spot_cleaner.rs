use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use hound::{WavReader, WavWriter, SampleFormat};
use crate::track_analysis::{TrackAnalysisReport};
use crate::logger::{log_info};
use crate::intelligent_normalization::{ClipProcessingInput};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotCleanerResult {
    pub track_id: String,
    pub processed_clips: Vec<SpotClipResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotClipResult {
    pub clip_id: String,
    pub original_path: String,
    pub processed_path: String,
}

/// Точечная очистка голоса (De-esser, Plosive reduction, Click removal)
#[tauri::command]
pub fn process_vocal_spot_cleaning(
    project_dir: String,
    track_id: String,
    clips: Vec<ClipProcessingInput>,
) -> Result<SpotCleanerResult, String> {
    log_info(&format!("[SpotCleaner] Processing track {} with {} clips", track_id, clips.len()));

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
        let processed_path = process_single_clip_spot_cleaning(clip, report, &takes_dir)?;
        processed_clips.push(SpotClipResult {
            clip_id: clip.id.clone(),
            original_path: clip.file_path.clone(),
            processed_path,
        });
    }

    Ok(SpotCleanerResult {
        track_id,
        processed_clips,
    })
}

fn process_single_clip_spot_cleaning(
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

    let num_samples = samples.len();
    
    // Параметры для фильтров
    // Sibilant filter (Peaking EQ 6kHz, Q=2.0, Gain=-12dB)
    // Plosive filter (HPF 150Hz)
    
    // Вспомогательные переменные для фильтров (для сглаживания переходов)
    let mut lp_state = vec![0.0f32; channels]; // Для HPF
    let mut hp_state = vec![0.0f32; channels]; // Для HPF
    
    // Коэффициенты HPF 150Hz (простой 1-полюсный)
    let fc = 150.0f32;
    let dt = 1.0 / sample_rate as f32;
    let tau = 1.0 / (2.0 * std::f32::consts::PI * fc);
    let alpha = tau / (tau + dt);

    for i in (0..num_samples).step_by(channels) {
        let clip_time_ms = (i / channels) as f64 * 1000.0 / sample_rate as f64;
        let timeline_time_ms = clip.start_time_ms + clip_time_ms;

        let segment = report.segments.iter().find(|s| {
            timeline_time_ms >= s.start_ms && timeline_time_ms < (s.start_ms + s.duration_ms)
        });

        if let Some(seg) = segment {
            // 1. Подавление взрывных согласных (Plosive reduction)
            if seg.is_plosive {
                for ch in 0..channels {
                    if i + ch < num_samples {
                        let x = samples[i + ch];
                        // High Pass Filter
                        let y = alpha * (hp_state[ch] + x - lp_state[ch]);
                        lp_state[ch] = x;
                        hp_state[ch] = y;
                        samples[i + ch] = y;
                    }
                }
            } else {
                // Сбрасываем состояние фильтра плавно
                for ch in 0..channels {
                    if i + ch < num_samples {
                        lp_state[ch] = samples[i + ch];
                        hp_state[ch] = 0.0;
                    }
                }
            }

            // 2. Де-эссер (De-esser) - Срез высоких частот в сибилянтах
            if seg.is_sibilant {
                for ch in 0..channels {
                    if i + ch < num_samples {
                        // Очень простой софт-лимитер высоких частот или просто понижение гейна
                        // В идеале нужен динамический EQ, но для точечной очистки 
                        // можно просто приглушить весь сегмент или применить LPF
                        samples[i + ch] *= 0.5; // -6dB на сибилянтах
                    }
                }
            }

            // 3. Подавление кликов (Click removal)
            if seg.is_click {
                for ch in 0..channels {
                    if i + ch < num_samples {
                        // Для кликов просто ограничиваем амплитуду до среднего уровня сегмента
                        let limit = 10.0f32.powf((seg.avg_rms_db + 6.0) / 20.0);
                        if samples[i + ch].abs() > limit {
                            samples[i + ch] = samples[i + ch].signum() * limit;
                        }
                    }
                }
            }
        }
    }

    // Сохранение
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let file_stem = p.file_stem().unwrap().to_str().unwrap();
    let output_path = output_dir.join(format!("{}_cleaned_{}.wav", file_stem, timestamp));
    
    let mut writer = WavWriter::create(&output_path, spec).map_err(|e| e.to_string())?;
    for &s in &samples {
        writer.write_sample(s).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(output_path.to_str().unwrap().to_string())
}
