use serde::{Deserialize, Serialize};
use std::f32::consts::PI;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformTransformResult {
    pub waveform: Vec<f32>,
    pub affected_count: usize,
}

/// Applies EQ profile shape to waveform peaks
#[tauri::command]
pub fn transform_waveform_eq(mut waveform: Vec<f32>, profile: String) -> WaveformTransformResult {
    let len = waveform.len();
    if len == 0 {
        return WaveformTransformResult { waveform, affected_count: 0 };
    }

    match profile.as_str() {
        "vocal_presence" => {
            for (i, v) in waveform.iter_mut().enumerate() {
                let spectral_factor = 1.0 + 0.12 * ((i as f32 / len as f32) * PI * 4.0).sin();
                *v = (*v * spectral_factor).clamp(0.0, 1.0);
            }
        }
        "warm_analog" => {
            for (i, v) in waveform.iter_mut().enumerate() {
                let spectral_factor = 1.05 + 0.08 * ((i as f32 / len as f32) * PI * 2.0).cos();
                *v = (*v * spectral_factor).clamp(0.0, 1.0);
            }
        }
        "flat" => {
            for v in waveform.iter_mut() {
                *v = (*v * 0.98).min(0.95);
            }
        }
        _ => {
            for (i, v) in waveform.iter_mut().enumerate() {
                let match_factor = 1.0 + 0.07 * ((i as f32) * 0.1).sin();
                *v = (*v * match_factor).clamp(0.0, 1.0);
            }
        }
    }

    WaveformTransformResult {
        affected_count: len,
        waveform,
    }
}

/// Interpolates clicks/discontinuities on waveform peaks
#[tauri::command]
pub fn transform_waveform_declick(mut waveform: Vec<f32>, sensitivity: f32) -> WaveformTransformResult {
    let len = waveform.len();
    if len <= 2 {
        return WaveformTransformResult { waveform, affected_count: 0 };
    }

    let threshold_delta = 0.45 - (sensitivity / 100.0) * 0.25;
    let mut clicks_count = 0;

    for i in 1..len - 1 {
        let prev = waveform[i - 1];
        let curr = waveform[i];
        let next = waveform[i + 1];

        let spike_delta = curr - (prev + next) / 2.0;
        if spike_delta > threshold_delta {
            waveform[i] = (prev + next) / 2.0;
            clicks_count += 1;
        }
    }

    WaveformTransformResult {
        waveform,
        affected_count: clicks_count,
    }
}

/// Compresses low-frequency plosives on waveform peaks
#[tauri::command]
pub fn transform_waveform_deplosive(mut waveform: Vec<f32>, _cutoff_hz: f32, _threshold_db: f32) -> WaveformTransformResult {
    let mut reduced_count = 0;
    for v in waveform.iter_mut() {
        if *v > 0.88 {
            reduced_count += 1;
            *v = 0.78 + (*v - 0.88) * 0.25;
        }
    }

    WaveformTransformResult {
        waveform,
        affected_count: reduced_count,
    }
}

/// Softens high-frequency sibilants on waveform peaks
#[tauri::command]
pub fn transform_waveform_deesser(mut waveform: Vec<f32>, _frequency: f32, _threshold_db: f32) -> WaveformTransformResult {
    let mut softened_count = 0;
    for v in waveform.iter_mut() {
        if *v > 0.75 {
            softened_count += 1;
            *v = 0.70 + (*v - 0.75) * 0.4;
        }
    }

    WaveformTransformResult {
        waveform,
        affected_count: softened_count,
    }
}

/// Expands downward / suppresses noise floor on waveform peaks
#[tauri::command]
pub fn transform_waveform_denoise(mut waveform: Vec<f32>, strength: f32) -> WaveformTransformResult {
    let noise_gate_threshold = 0.03 + (strength / 100.0) * 0.05;
    let factor = 1.0 - strength / 100.0;
    let mut suppressed_count = 0;

    for v in waveform.iter_mut() {
        if *v < noise_gate_threshold {
            *v = *v * factor;
            suppressed_count += 1;
        }
    }

    WaveformTransformResult {
        waveform,
        affected_count: suppressed_count,
    }
}

/// Attenuates diffuse decay tail after peaks on waveform peaks
#[tauri::command]
pub fn transform_waveform_dereverb(mut waveform: Vec<f32>, strength: f32) -> WaveformTransformResult {
    let len = waveform.len();
    if len <= 2 {
        return WaveformTransformResult { waveform, affected_count: 0 };
    }

    let att_factor = 1.0 - (strength / 100.0) * 0.18;
    let mut modified_count = 0;

    for i in 1..len {
        if waveform[i] < waveform[i - 1] && waveform[i] > 0.05 {
            waveform[i] = waveform[i] * att_factor;
            modified_count += 1;
        }
    }

    WaveformTransformResult {
        waveform,
        affected_count: modified_count,
    }
}

/// Levels syllables / phrase dynamics on waveform peaks
#[tauri::command]
pub fn transform_waveform_leveler(mut waveform: Vec<f32>, ratio: f32) -> WaveformTransformResult {
    let len = waveform.len();
    if len == 0 {
        return WaveformTransformResult { waveform, affected_count: 0 };
    }

    let sum: f32 = waveform.iter().sum();
    let avg = if len > 0 { sum / len as f32 } else { 0.3 };
    let r = ratio.max(1.5);

    for v in waveform.iter_mut() {
        if *v <= 0.01 {
            continue;
        }
        let deviation = *v - avg;
        *v = (avg + deviation / r).clamp(0.0, 1.0);
    }

    WaveformTransformResult {
        waveform,
        affected_count: len,
    }
}
