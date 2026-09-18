// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE WAVEFORM BUCKET & RENDER ENGINE (RUST)
// Сверхбыстрая бакетизация аудиосэмплов, степенное сжатие динамики и генерация
// плоских массивов координат Y для Canvas за один проход на базе Rayon SIMD.
// Стек: rayon = "1.10.0", serde = "1.0", tauri = "2.2"
// ============================================================================

use std::time::Instant;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::audio_buffer_manager::AudioBufferCache;
use crate::logger::log_debug;
use crate::smart_align::resolve_audio_samples;

/// Параметры запроса бакетизации для канваса
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformBucketQuery {
    /// Идентификатор буфера в кэше или абсолютный путь к аудиофайлу
    pub buffer_id: String,
    /// Начальный индекс сэмпла на таймлайне/файле
    pub start_sample: usize,
    /// Конечный индекс сэмпла
    pub end_sample: usize,
    /// Целевая ширина Canvas в физических пикселях (с учетом devicePixelRatio)
    pub target_pixel_width: u32,
    /// Коэффициент нелинейного сжатия динамики (по умолчанию 0.6)
    #[serde(default = "default_power_curve")]
    pub power_curve: f32,
    /// Высота дорожки/Canvas в пикселях
    pub canvas_height: f32,
    /// Опциональный массив уже извлеченных пиков (если буфер на фронтенде)
    #[serde(default)]
    pub raw_peaks: Option<Vec<f32>>,
}

fn default_power_curve() -> f32 {
    0.6
}

/// Высокопроизводительный процессор генерации координат волны
pub struct WaveformBucketEngine;

impl WaveformBucketEngine {
    /// Параллельная бакетизация и расчет координат [Y_top, Y_bottom] для каждого пикселя
    pub fn process_samples_to_pixel_coords(
        samples: &[f32],
        start_sample: usize,
        end_sample: usize,
        target_pixel_width: u32,
        power_curve: f32,
        canvas_height: f32,
    ) -> Vec<f32> {
        if target_pixel_width == 0 {
            return Vec::new();
        }

        let total_samples = samples.len();
        let center_y = canvas_height * 0.5;
        let half_h = canvas_height * 0.48; // Небольшой 2% отступ сверху и снизу
        let p = if power_curve > 0.01 && power_curve < 5.0 {
            power_curve
        } else {
            0.6
        };

        if total_samples == 0 {
            // Тишина: возвращаем плоскую центральную линию
            let mut flat = vec![0.0f32; (target_pixel_width * 2) as usize];
            for i in 0..target_pixel_width as usize {
                flat[i * 2] = center_y - 0.5;
                flat[i * 2 + 1] = center_y + 0.5;
            }
            return flat;
        }

        let actual_start = start_sample.min(total_samples);
        let actual_end = end_sample.min(total_samples).max(actual_start);
        let range_len = actual_end.saturating_sub(actual_start);

        if range_len == 0 {
            let mut flat = vec![0.0f32; (target_pixel_width * 2) as usize];
            for i in 0..target_pixel_width as usize {
                flat[i * 2] = center_y - 0.5;
                flat[i * 2 + 1] = center_y + 0.5;
            }
            return flat;
        }

        let bucket_size = range_len as f64 / target_pixel_width as f64;

        // Параллельный расчет через Rayon
        let coords_pairs: Vec<(f32, f32)> = (0..target_pixel_width)
            .into_par_iter()
            .map(|px| {
                let b_start = actual_start + (px as f64 * bucket_size) as usize;
                let mut b_end = actual_start + ((px + 1) as f64 * bucket_size).ceil() as usize;
                b_end = b_end.min(actual_end);
                if b_end <= b_start {
                    b_end = (b_start + 1).min(total_samples);
                }

                let mut min_val = 0.0f32;
                let mut max_val = 0.0f32;

                if b_start < total_samples {
                    let slice = &samples[b_start..b_end.min(total_samples)];
                    for &s in slice {
                        if s < min_val {
                            min_val = s;
                        }
                        if s > max_val {
                            max_val = s;
                        }
                    }
                }

                // Нелинейное масштабирование динамики
                let sign_max = if max_val >= 0.0 { 1.0 } else { -1.0 };
                let sign_min = if min_val >= 0.0 { 1.0 } else { -1.0 };

                let scaled_max = max_val.abs().min(1.0).powf(p) * sign_max;
                let scaled_min = min_val.abs().min(1.0).powf(p) * sign_min;

                let mut y_top = (center_y - (scaled_max * half_h)).clamp(0.0, canvas_height);
                let mut y_bottom = (center_y - (scaled_min * half_h)).clamp(0.0, canvas_height);

                if y_bottom < y_top {
                    std::mem::swap(&mut y_top, &mut y_bottom);
                }

                // Минимальная толщина 1px для визуализации даже на тихих участках
                if (y_bottom - y_top) < 1.0 {
                    y_top = (center_y - 0.5).max(0.0);
                    y_bottom = (center_y + 0.5).min(canvas_height);
                }

                (y_top, y_bottom)
            })
            .collect();

        // Упаковка в плоский одномерный вектор f32: [y0_top, y0_bot, y1_top, y1_bot, ...]
        let mut flat_output = Vec::with_capacity((target_pixel_width * 2) as usize);
        for (y_top, y_bottom) in coords_pairs {
            flat_output.push(y_top);
            flat_output.push(y_bottom);
        }

        flat_output
    }
}

// ============================================================================
// TAURI V2 COMMANDS
// ============================================================================

/// Нативная команда вычисления координат отрисовки волновой формы
#[tauri::command]
pub async fn compute_waveform_render_buckets(
    query: WaveformBucketQuery,
    cache_state: State<'_, AudioBufferCache>,
) -> Result<Vec<f32>, String> {
    let start_time = Instant::now();

    // 1. Если переданы готовые raw_peaks (быстрый путь)
    if let Some(peaks) = &query.raw_peaks {
        let result = WaveformBucketEngine::process_samples_to_pixel_coords(
            peaks,
            query.start_sample,
            query.end_sample,
            query.target_pixel_width,
            query.power_curve,
            query.canvas_height,
        );
        return Ok(result);
    }

    // 2. Извлечение сэмплов из кэша памяти или файла
    let mono_buffer = resolve_audio_samples(&query.buffer_id, Some(&cache_state))
        .map_err(|e| format!("Ошибка загрузки аудиобуфера '{}': {}", query.buffer_id, e))?;

    let result = WaveformBucketEngine::process_samples_to_pixel_coords(
        &mono_buffer.samples,
        query.start_sample,
        query.end_sample,
        query.target_pixel_width,
        query.power_curve,
        query.canvas_height,
    );

    log_debug(&format!(
        "[WaveformBucketEngine] Сгенерировано {} точек ({:.2}ms) для buffer_id={}",
        result.len(),
        start_time.elapsed().as_secs_f64() * 1000.0,
        query.buffer_id
    ));

    Ok(result)
}

/// Нативная команда быстрой бакетизации переданного массива пиков
#[tauri::command]
pub async fn compute_waveform_buckets_from_peaks(
    peaks: Vec<f32>,
    target_pixel_width: u32,
    canvas_height: f32,
    power_curve: Option<f32>,
) -> Result<Vec<f32>, String> {
    let p = power_curve.unwrap_or(0.6);
    let total_len = peaks.len();
    let result = WaveformBucketEngine::process_samples_to_pixel_coords(
        &peaks,
        0,
        total_len,
        target_pixel_width,
        p,
        canvas_height,
    );
    Ok(result)
}
