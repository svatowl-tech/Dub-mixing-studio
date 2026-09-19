use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use hound::{WavReader, WavWriter, WavSpec, SampleFormat};
use crate::track_analysis::{TrackAnalysisReport, WaveformClassification};
use crate::logger::{log_debug, log_info};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelligentNormResult {
    pub track_id: String,
    pub output_path: String,
    pub clips_processed: usize,
}

/// Применяет интеллектуальную нормализацию к дорожке на основе данных анализа
#[tauri::command]
pub async fn process_intelligent_normalization(
    project_dir: String,
    track_id: String,
) -> Result<Vec<IntelligentNormResult>, String> {
    log_info(&format!("[IntelligentNorm] Starting for track: {}", track_id));

    // 1. Загрузка отчета анализа
    let norm_project_dir = crate::file_io::normalize_windows_path(&project_dir);
    let analysis_file_path = Path::new(&norm_project_dir).join(".dubstudio").join("track_analysis.json");
    
    if !analysis_file_path.exists() {
        return Err("Analysis cache not found. Please run track analysis first.".to_string());
    }

    let json_str = fs::read_to_string(&analysis_file_path).map_err(|e| e.to_string())?;
    let reports: Vec<TrackAnalysisReport> = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
    
    let report = reports.iter().find(|r| r.track_id == track_id)
        .ok_or_else(|| format!("Analysis for track {} not found", track_id))?;

    // Нам нужны данные о клипах этой дорожки. 
    // Поскольку команда вызывается из контекста проекта, нам нужно получить текущее состояние клипов.
    // Для этого воспользуемся загрузкой проекта (или передадим клипы в аргументах).
    // Учитывая архитектуру, лучше передать список клипов для обработки.
    
    // Но так как у нас есть проект в БД, мы можем его вытянуть, если нужно.
    // Однако для модуля 1.1 допустим, что мы работаем с файлами напрямую или передаем их.
    // Вернемся к main.rs чтобы посмотреть как вызываются другие DSP команды.
    
    Err("Implementation requires clip list. Please use process_intelligent_normalization_with_clips".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelligentClipResult {
    pub clip_id: String,
    pub original_path: String,
    pub processed_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelligentNormResult {
    pub track_id: String,
    pub processed_clips: Vec<IntelligentClipResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipProcessingInput {
    pub id: String,
    pub file_path: String,
    pub start_time_ms: f64,
    pub duration_ms: f64,
    pub source_offset_ms: f64,
}

#[tauri::command]
pub fn process_intelligent_normalization_with_clips(
    project_dir: String,
    track_id: String,
    clips: Vec<ClipProcessingInput>,
) -> Result<IntelligentNormResult, String> {
    log_info(&format!("[IntelligentNorm] Processing track {} with {} clips", track_id, clips.len()));

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
        let processed_path = process_single_clip_intelligently(clip, report, &takes_dir)?;
        processed_clips.push(IntelligentClipResult {
            clip_id: clip.id.clone(),
            original_path: clip.file_path.clone(),
            processed_path,
        });
    }

    Ok(IntelligentNormResult {
        track_id,
        processed_clips,
    })
}

fn process_single_clip_intelligently(
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
    let channels = spec.channels;

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

    let speech_target_db = -24.0f32;
    let quiet_target_db = -35.0f32;
    let limiter_threshold_db = -9.0f32;
    let limiter_threshold_lin = 10.0f32.powf(limiter_threshold_db / 20.0);

    let window_size_ms = 200.0;
    let samples_per_window = (window_size_ms / 1000.0 * sample_rate as f64) as usize;
    
    let num_samples = samples.len();
    let mut gain_envelope = vec![1.0f32; num_samples];

    let total_windows = (num_samples as f64 / (samples_per_window as f64 * channels as f64)).ceil() as usize;
    
    let mut last_gain = 1.0f32;

    for w in 0..total_windows {
        let window_start_sample = w * samples_per_window * channels as usize;
        if window_start_sample >= num_samples { break; }
        let window_end_sample = (window_start_sample + samples_per_window * channels as usize).min(num_samples);
        
        let clip_time_ms = w as f64 * window_size_ms;
        let timeline_time_ms = clip.start_time_ms + clip_time_ms; // Мы уже учитываем source_offset при чтении если бы мы читали кусок, но здесь мы читаем весь файл клипа. 
        // ВАЖНО: отчет анализа построен по таймлайну. 
        // Клип на таймлайне занимает [start_time_ms, start_time_ms + duration_ms]

        let segment = report.segments.iter().find(|s| {
            timeline_time_ms >= s.start_ms && timeline_time_ms < (s.start_ms + s.duration_ms)
        });

        let target_gain = if let Some(seg) = segment {
            match seg.classification {
                WaveformClassification::Silence | WaveformClassification::Noise => 1.0f32,
                WaveformClassification::QuietFragment => {
                    if seg.avg_rms_db < quiet_target_db {
                        let diff_db = quiet_target_db - seg.avg_rms_db;
                        10.0f32.powf(diff_db / 20.0).min(15.8)
                    } else {
                        1.0f32
                    }
                }
                WaveformClassification::Speech => {
                    if seg.avg_rms_db < speech_target_db {
                        let diff_db = speech_target_db - seg.avg_rms_db;
                        10.0f32.powf(diff_db / 20.0).min(31.6)
                    } else {
                        1.0f32
                    }
                }
            }
        } else {
            1.0f32
        };

        for i in window_start_sample..window_end_sample {
            let progress = (i - window_start_sample) as f32 / (window_end_sample - window_start_sample) as f32;
            gain_envelope[i] = last_gain * (1.0 - progress) + target_gain * progress;
        }
        last_gain = target_gain;
    }

    for i in 0..num_samples {
        let mut s = samples[i] * gain_envelope[i];
        
        if s > limiter_threshold_lin {
            s = limiter_threshold_lin;
        } else if s < -limiter_threshold_lin {
            s = -limiter_threshold_lin;
        }
        
        samples[i] = s;
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let file_stem = p.file_stem().unwrap().to_str().unwrap();
    let output_path = output_dir.join(format!("{}_intnorm_{}.wav", file_stem, timestamp));
    
    let mut writer = WavWriter::create(&output_path, spec).map_err(|e| e.to_string())?;
    for &s in &samples {
        writer.write_sample(s).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(output_path.to_str().unwrap().to_string())
}

