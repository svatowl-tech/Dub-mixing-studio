use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use hound::{WavReader, SampleFormat};
use rustfft::{FftPlanner, num_complex::Complex32};
use crate::logger::{log_debug, log_info};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAnalysisInput {
    pub id: String,
    pub file_path: String,
    pub start_time_ms: f64,
    pub duration_ms: f64,
    pub source_offset_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackAnalysisInput {
    pub id: String,
    pub name: String,
    pub track_type: String,
    pub clips: Vec<ClipAnalysisInput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WaveformClassification {
    Silence,         // Полная тишина
    Noise,           // Постоянный фоновый шум
    QuietFragment,   // Тихие фрагменты (вздохи, шорохи, клики)
    Speech,          // Реплики (активный голос)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackAnalysisSegment {
    pub start_ms: f64,
    pub duration_ms: f64,
    pub classification: WaveformClassification,
    pub avg_rms_db: f32,
    pub peak_db: f32,
    pub is_sibilant: bool,
    pub is_plosive: bool,
    pub is_click: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSpectralState {
    pub avg_lows_db: f32,       // Низкие частоты (< 250 Гц)
    pub avg_mids_db: f32,       // Средние частоты (250 - 4000 Гц)
    pub avg_highs_db: f32,      // Высокие частоты (> 4000 Гц)
    pub peak_freq: f32,         // Выраженная частота (резонанс)
    pub peak_freq_db: f32,
    pub low_bass_boosted: bool, // Завышенные низкие
    pub low_bass_attenuated: bool, // Пониженные низкие
    pub high_treble_boosted: bool, // Завышенные высокие
    pub resonance_detected: bool, // Обнаружен ли резонансный пик
    pub spectral_centroid_hz: f32, // Спектральный центроид
    pub spectrum_db: Vec<f32>,     // Усредненный спектр (64 бина)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackAnalysisReport {
    pub track_id: String,
    pub track_name: String,
    pub segments: Vec<TrackAnalysisSegment>,
    pub spectral_state: TrackSpectralState,
    pub analysis_timestamp: u64,
}

/// Простой внутренний контейнер для покадровых результатов анализа файла
struct AnalyzedFrame {
    time_ms: f64,
    rms_db: f32,
    peak_db: f32,
    classification: WaveformClassification,
    spectral_centroid: f32,
    magnitudes: Vec<f32>, // Амплитуды частот БПФ
    is_sibilant: bool,
    is_plosive: bool,
    is_click: bool,
}

/// Генерация окна Ханна (Hann Window)
fn generate_hann_window(size: usize) -> Vec<f32> {
    use std::f32::consts::PI;
    let mut window = Vec::with_capacity(size);
    for i in 0..size {
        window.push(0.5 * (1.0 - (2.0 * PI * i as f32 / (size - 1) as f32).cos()));
    }
    window
}

/// Чтение и декодирование WAV файла в моно f32 сэмплы
fn read_wav_mono(file_path: &str, source_offset_ms: f64, duration_ms: f64) -> Result<(Vec<f32>, u32), String> {
    let norm_path = crate::file_io::normalize_windows_path(file_path);
    let p = Path::new(&norm_path);
    if !p.exists() {
        return Err(format!("File does not exist: {}", norm_path));
    }

    let mut reader = WavReader::open(p).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels as usize;

    if channels == 0 {
        return Err("Audio channels are 0".to_string());
    }

    // Рассчитываем оффсет в сэмплах
    let start_sample = ((source_offset_ms / 1000.0) * sample_rate as f64) as usize * channels;
    let max_samples = ((duration_ms / 1000.0) * sample_rate as f64) as usize * channels;

    let raw_samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Float => {
            reader.samples::<f32>()
                .skip(start_sample)
                .take(max_samples)
                .map(|s| s.unwrap_or(0.0))
                .collect()
        }
        SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            if bits <= 16 {
                reader.samples::<i16>()
                    .skip(start_sample)
                    .take(max_samples)
                    .map(|s| s.unwrap_or(0) as f32 / 32768.0)
                    .collect()
            } else if bits <= 24 {
                reader.samples::<i32>()
                    .skip(start_sample)
                    .take(max_samples)
                    .map(|s| s.unwrap_or(0) as f32 / 8388608.0)
                    .collect()
            } else {
                reader.samples::<i32>()
                    .skip(start_sample)
                    .take(max_samples)
                    .map(|s| s.unwrap_or(0) as f32 / i32::MAX as f32)
                    .collect()
            }
        }
    };

    // Смешивание стерео в моно
    if channels > 1 {
        let mono_len = raw_samples.len() / channels;
        let mut mono = Vec::with_capacity(mono_len);
        let scale = 1.0 / channels as f32;
        for i in 0..mono_len {
            let mut sum = 0.0f32;
            for ch in 0..channels {
                sum += raw_samples[i * channels + ch];
            }
            mono.push(sum * scale);
        }
        Ok((mono, sample_rate))
    } else {
        Ok((raw_samples, sample_rate))
    }
}

/// Анализ отдельного аудиофайла (клипа)
fn analyze_audio_clip(
    file_path: &str,
    source_offset_ms: f64,
    clip_duration_ms: f64,
    clip_start_timeline_ms: f64,
) -> Result<Vec<AnalyzedFrame>, String> {
    let (samples, sample_rate) = read_wav_mono(file_path, source_offset_ms, clip_duration_ms)?;
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let fft_size = 2048;
    let hop_size = 1024; // 50% перекрытие
    let window = generate_hann_window(fft_size);
    let num_bins = fft_size / 2;
    let freq_step = sample_rate as f32 / fft_size as f32;

    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(fft_size);
    let mut scratch = vec![Complex32::new(0.0, 0.0); fft.get_inplace_scratch_len()];

    let num_samples = samples.len();
    let num_frames = if num_samples >= fft_size {
        (num_samples - fft_size) / hop_size + 1
    } else {
        0
    };

    let mut analyzed_frames = Vec::with_capacity(num_frames);

    for f in 0..num_frames {
        let offset = f * hop_size;
        let time_sec = (offset as f64 + fft_size as f64 / 2.0) / sample_rate as f64;
        let time_timeline_ms = clip_start_timeline_ms + (time_sec * 1000.0);

        // Применяем окно
        let mut buffer = vec![Complex32::new(0.0, 0.0); fft_size];
        let mut sum_sq = 0.0f64;
        let mut peak_val = 0.0f32;

        for i in 0..fft_size {
            let s = samples[offset + i];
            sum_sq += (s as f64) * (s as f64);
            if s.abs() > peak_val {
                peak_val = s.abs();
            }
            buffer[i] = Complex32::new(s * window[i], 0.0);
        }

        // Вычисляем RMS
        let rms = (sum_sq / fft_size as f64).sqrt() as f32;
        let rms_db = if rms > 1e-7 {
            (20.0 * rms.log10()).max(-120.0)
        } else {
            -120.0
        };

        let peak_db = if peak_val > 1e-7 {
            (20.0 * peak_val.log10()).max(-120.0)
        } else {
            -120.0
        };

        // Запускаем БПФ
        fft.process_with_scratch(&mut buffer, &mut scratch);

        // Спектральные характеристики
        let mut magnitudes = Vec::with_capacity(num_bins);
        let mut sum_mag = 0.0f32;
        let mut sum_freq_mag = 0.0f32;
        let norm_factor = (fft_size / 2) as f32;

        // Для геометрического среднего (Spectral Flatness)
        let mut sum_ln_mag = 0.0f64;

        for k in 0..num_bins {
            let c = buffer[k];
            let mag = (c.re * c.re + c.im * c.im).sqrt() / norm_factor;
            magnitudes.push(mag);

            sum_mag += mag;
            let freq = k as f32 * freq_step;
            sum_freq_mag += freq * mag;

            sum_ln_mag += (mag + 1e-7f32).ln() as f64;
        }

        let spectral_centroid = if sum_mag > 1e-6 {
            sum_freq_mag / sum_mag
        } else {
            0.0
        };

        // Геометрическое среднее делить на арифметическое среднее
        let arith_mean = sum_mag / num_bins as f32;
        let geom_mean = (sum_ln_mag / num_bins as f64).exp() as f32;
        let spectral_flatness = if arith_mean > 1e-7 {
            (geom_mean / arith_mean).clamp(0.0, 1.0)
        } else {
            0.0
        };

        // КЛАССИФИКАЦИЯ ЗВУКОВОЙ ВОЛНЫ
        let classification = if rms_db < -70.0 {
            WaveformClassification::Silence
        } else if spectral_flatness > 0.38 && rms_db < -38.0 {
            WaveformClassification::Noise // Спектрально плоский фоновый шум
        } else if rms_db >= -36.0 {
            WaveformClassification::Speech // Четкий сильный голос
        } else if rms_db >= -48.0 && spectral_flatness < 0.22 {
            WaveformClassification::Speech // Тихое гармоническое произношение
        } else if rms_db < -48.0 && spectral_flatness < 0.22 {
            WaveformClassification::QuietFragment // Вздохи, шепоты, тонкие клики
        } else {
            WaveformClassification::QuietFragment // Прочие тихие звуки
        };

        // ДЕТЕКЦИЯ АНОМАЛИЙ (Sibilants, Plosives, Clicks)
        let mut is_sibilant = false;
        let mut is_plosive = false;
        let mut is_click = false;

        if classification != WaveformClassification::Silence {
            // 1. Поиск сибилянтов (4k-10k)
            let mut high_energy = 0.0f32;
            let mut mid_energy = 0.0f32;
            for k in 0..num_bins {
                let freq = k as f32 * freq_step;
                let mag = magnitudes[k];
                if freq >= 5000.0 && freq <= 10000.0 {
                    high_energy += mag;
                } else if freq >= 1000.0 && freq <= 3000.0 {
                    mid_energy += mag;
                }
            }
            if high_energy > mid_energy * 2.0 && spectral_centroid > 5500.0 {
                is_sibilant = true;
            }

            // 2. Поиск взрывных (40-150Hz)
            let mut low_energy = 0.0f32;
            for k in 0..num_bins {
                let freq = k as f32 * freq_step;
                let mag = magnitudes[k];
                if freq >= 40.0 && freq <= 150.0 {
                    low_energy += mag;
                }
            }
            // Если в низах энергии много больше чем в средних (во время речи)
            if low_energy > mid_energy * 4.0 && classification == WaveformClassification::Speech {
                is_plosive = true;
            }

            // 3. Поиск кликов (Sharp transients)
            let crest_factor = peak_val / (rms + 1e-9);
            if crest_factor > 8.0 && spectral_flatness > 0.4 {
                is_click = true;
            }
        }

        analyzed_frames.push(AnalyzedFrame {
            time_ms: time_timeline_ms,
            rms_db,
            peak_db,
            classification,
            spectral_centroid,
            magnitudes,
            is_sibilant,
            is_plosive,
            is_click,
        });
    }

    Ok(analyzed_frames)
}

/// Основной метод анализа всех голосовых дорожек
#[tauri::command]
pub fn analyze_voice_tracks(
    project_dir: String,
    tracks: Vec<TrackAnalysisInput>,
) -> Result<Vec<TrackAnalysisReport>, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    log_info(&format!("[TrackAnalysis] Starting analysis for {} tracks. Project path: {}", tracks.len(), project_dir));

    // Отфильтруем оригиналы
    let voice_tracks: Vec<&TrackAnalysisInput> = tracks.iter()
        .filter(|t| {
            let name_lower = t.name.to_lowercase();
            let type_lower = t.track_type.to_lowercase();
            let id_lower = t.id.to_lowercase();
            !name_lower.contains("original") && 
            !type_lower.contains("original") && 
            !id_lower.contains("original") &&
            type_lower != "originaldialogue" &&
            type_lower != "musicandeffects"
        })
        .collect();

    let mut reports = Vec::new();

    for track in voice_tracks {
        log_info(&format!("[TrackAnalysis] Analyzing track: {} ({})", track.name, track.id));

        // 1. Сбор всех покадровых результатов по клипам на дорожке
        let mut all_frames: Vec<AnalyzedFrame> = Vec::new();

        for clip in &track.clips {
            log_debug(&format!("[TrackAnalysis] Loading clip file: {}", clip.file_path));
            match analyze_audio_clip(
                &clip.file_path,
                clip.source_offset_ms.unwrap_or(0.0),
                clip.duration_ms,
                clip.start_time_ms,
            ) {
                Ok(frames) => {
                    all_frames.extend(frames);
                }
                Err(err) => {
                    log_debug(&format!("[TrackAnalysis] Warning: failed to analyze clip {}: {}", clip.id, err));
                }
            }
        }

        // Если кадров вообще нет (пустая дорожка)
        if all_frames.is_empty() {
            let empty_report = TrackAnalysisReport {
                track_id: track.id.clone(),
                track_name: track.name.clone(),
                segments: Vec::new(),
                spectral_state: TrackSpectralState {
                    avg_lows_db: -120.0,
                    avg_mids_db: -120.0,
                    avg_highs_db: -120.0,
                    peak_freq: 0.0,
                    peak_freq_db: -120.0,
                    low_bass_boosted: false,
                    low_bass_attenuated: false,
                    high_treble_boosted: false,
                    resonance_detected: false,
                    spectral_centroid_hz: 0.0,
                },
                analysis_timestamp: now,
            };
            reports.push(empty_report);
            continue;
        }

        // Сортируем кадры по временной шкале проекта
        all_frames.sort_by(|a, b| a.time_ms.partial_cmp(&b.time_ms).unwrap());

        // 2. Расчет спектрального состояния дорожки (на основе фреймов, классифицированных как Speech)
        let speech_frames: Vec<&AnalyzedFrame> = all_frames.iter()
            .filter(|f| f.classification == WaveformClassification::Speech)
            .collect();

        let spectral_state = if !speech_frames.is_empty() {
            let num_bins = speech_frames[0].magnitudes.len();
            let mut avg_magnitudes = vec![0.0f32; num_bins];

            let mut total_centroid = 0.0f32;

            for f in &speech_frames {
                total_centroid += f.spectral_centroid;
                for k in 0..num_bins {
                    avg_magnitudes[k] += f.magnitudes[k];
                }
            }

            for k in 0..num_bins {
                avg_magnitudes[k] /= speech_frames.len() as f32;
            }

            let avg_centroid = total_centroid / speech_frames.len() as f32;

            // Рассчитываем частотный шаг БПФ (предположим 48000Hz по умолчанию)
            let freq_step = 48000.0f32 / (num_bins * 2) as f32;

            let mut lows_sum = 0.0f32;
            let mut lows_count = 0usize;
            let mut mids_sum = 0.0f32;
            let mut mids_count = 0usize;
            let mut highs_sum = 0.0f32;
            let mut highs_count = 0usize;

            let mut peak_freq = 0.0f32;
            let mut peak_mag = -1.0f32;

            for k in 0..num_bins {
                let freq = k as f32 * freq_step;
                let mag = avg_magnitudes[k];

                if freq >= 40.0 && freq < 250.0 {
                    lows_sum += mag;
                    lows_count += 1;
                } else if freq >= 250.0 && freq < 4000.0 {
                    mids_sum += mag;
                    mids_count += 1;
                } else if freq >= 4000.0 && freq <= 16000.0 {
                    highs_sum += mag;
                    highs_count += 1;
                }

                if freq >= 80.0 && freq <= 8000.0 && mag > peak_mag {
                    peak_mag = mag;
                    peak_freq = freq;
                }
            }

            let to_db = |mag: f32| -> f32 {
                if mag > 1e-7 {
                    (20.0 * mag.log10()).max(-120.0)
                } else {
                    -120.0
                }
            };

            let avg_lows_db = to_db(if lows_count > 0 { lows_sum / lows_count as f32 } else { 0.0 });
            let avg_mids_db = to_db(if mids_count > 0 { mids_sum / mids_count as f32 } else { 0.0 });
            let avg_highs_db = to_db(if highs_count > 0 { highs_sum / highs_count as f32 } else { 0.0 });
            let peak_freq_db = to_db(peak_mag);

            // Определение спектральных аномалий (завышенные/пониженные басы, сибилянты, резонансы)
            let low_bass_boosted = avg_lows_db > avg_mids_db + 8.0;
            let low_bass_attenuated = avg_lows_db < avg_mids_db - 15.0;
            let high_treble_boosted = avg_highs_db > avg_mids_db + 5.0;

            // Поиск острых резонансных пиков в спектре (сравниваем bin с соседними)
            let mut resonance_detected = false;
            if num_bins > 12 {
                for i in 6..(num_bins - 6) {
                    let mag = avg_magnitudes[i];
                    let freq = i as f32 * freq_step;
                    if freq < 100.0 || freq > 4000.0 {
                        continue;
                    }
                    // Считаем среднее окружение
                    let mut env_sum = 0.0f32;
                    for j in -5..=5 {
                        if j != 0 {
                            env_sum += avg_magnitudes[(i as i32 + j) as usize];
                        }
                    }
                    let env_avg = env_sum / 10.0;
                    if env_avg > 1e-6 && mag > env_avg * 3.5 { // Пик выше окружения в 3.5+ раза (примерно +11 dB)
                        resonance_detected = true;
                        break;
                    }
                }
            }

            TrackSpectralState {
                avg_lows_db,
                avg_mids_db,
                avg_highs_db,
                peak_freq,
                peak_freq_db,
                low_bass_boosted,
                low_bass_attenuated,
                high_treble_boosted,
                resonance_detected,
                spectral_centroid_hz: avg_centroid,
                spectrum_db: {
                    // Ресемплируем 1024 бина в 64 для компактности отчета
                    let mut resampled = Vec::with_capacity(64);
                    let bins_per_resample = num_bins / 64;
                    for i in 0..64 {
                        let start = i * bins_per_resample;
                        let end = (i + 1) * bins_per_resample;
                        let mut sum_mag = 0.0f32;
                        for k in start..end {
                            sum_mag += avg_magnitudes[k];
                        }
                        resampled.push(to_db(sum_mag / bins_per_resample as f32));
                    }
                    resampled
                },
            }
        } else {
            // Если реплик нет, берем среднее по всем кадрам
            TrackSpectralState {
                avg_lows_db: -90.0,
                avg_mids_db: -90.0,
                avg_highs_db: -90.0,
                peak_freq: 0.0,
                peak_freq_db: -90.0,
                low_bass_boosted: false,
                low_bass_attenuated: false,
                high_treble_boosted: false,
                resonance_detected: false,
                spectral_centroid_hz: 0.0,
                spectrum_db: vec![-90.0; 64],
            }
        };

        // 3. Квантование таймлайна на шаги по 200 миллисекунд
        let step_size_ms = 200.0;
        let max_time_ms = track.clips.iter()
            .map(|c| c.start_time_ms + c.duration_ms)
            .fold(0.0f64, |a, b| a.max(b));

        let num_steps = (max_time_ms / step_size_ms).ceil() as usize;
        let mut segments = Vec::with_capacity(num_steps);

        for step in 0..num_steps {
            let start_ms = step as f64 * step_size_ms;
            let end_ms = start_ms + step_size_ms;

            // Находим фреймы, попадающие в данный интервал
            let step_frames: Vec<&AnalyzedFrame> = all_frames.iter()
                .filter(|f| f.time_ms >= start_ms && f.time_ms < end_ms)
                .collect();

            if step_frames.is_empty() {
                // Если нет клипа на этом участке - тишина
                segments.push(TrackAnalysisSegment {
                    start_ms,
                    duration_ms: step_size_ms,
                    classification: WaveformClassification::Silence,
                    avg_rms_db: -120.0,
                    peak_db: -120.0,
                    is_sibilant: false,
                    is_plosive: false,
                    is_click: false,
                });
            } else {
                // Вычисляем средние параметры
                let mut total_rms_lin = 0.0f32;
                let mut max_peak = -120.0f32;

                // Для голосования классификации (с приоритетами: Speech > QuietFragment > Noise > Silence)
                let mut count_speech = 0usize;
                let mut count_quiet = 0usize;
                let mut count_noise = 0usize;
                let mut count_silence = 0usize;

                for f in &step_frames {
                    total_rms_lin += 10.0f32.powf(f.rms_db / 20.0);
                    if f.peak_db > max_peak {
                        max_peak = f.peak_db;
                    }

                    match f.classification {
                        WaveformClassification::Speech => count_speech += 1,
                        WaveformClassification::QuietFragment => count_quiet += 1,
                        WaveformClassification::Noise => count_noise += 1,
                        WaveformClassification::Silence => count_silence += 1,
                    }
                }

                let avg_rms_lin = total_rms_lin / step_frames.len() as f32;
                let avg_rms_db = if avg_rms_lin > 1e-7 {
                    20.0 * avg_rms_lin.log10()
                } else {
                    -120.0
                };

                // Приоритетное голосование за класс сегмента
                let classification = if count_speech > 0 {
                    WaveformClassification::Speech
                } else if count_quiet > 0 {
                    WaveformClassification::QuietFragment
                } else if count_noise > 0 {
                    WaveformClassification::Noise
                } else {
                    WaveformClassification::Silence
                };

                let is_sibilant = step_frames.iter().any(|f| f.is_sibilant);
                let is_plosive = step_frames.iter().any(|f| f.is_plosive);
                let is_click = step_frames.iter().any(|f| f.is_click);

                segments.push(TrackAnalysisSegment {
                    start_ms,
                    duration_ms: step_size_ms,
                    classification,
                    avg_rms_db,
                    peak_db: max_peak,
                    is_sibilant,
                    is_plosive,
                    is_click,
                });
            }
        }

        reports.push(TrackAnalysisReport {
            track_id: track.id,
            track_name: track.name,
            segments,
            spectral_state,
            analysis_timestamp: now,
        });
    }

    // 4. Запись отчета на диск проекта в папку .dubstudio/track_analysis.json
    let norm_project_dir = crate::file_io::normalize_windows_path(&project_dir);
    let project_path = Path::new(&norm_project_dir);
    let dubstudio_path = project_path.join(".dubstudio");
    if !dubstudio_path.exists() {
        let _ = fs::create_dir_all(&dubstudio_path);
    }
    let analysis_file_path = dubstudio_path.join("track_analysis.json");

    match serde_json::to_string_pretty(&reports) {
        Ok(json_str) => {
            if let Err(e) = fs::write(&analysis_file_path, json_str) {
                log_debug(&format!("[TrackAnalysis] Warning: failed to write track analysis file: {}", e));
            } else {
                log_info(&format!("[TrackAnalysis] Successfully saved analysis cache to: {}", analysis_file_path.display()));
            }
        }
        Err(e) => {
            log_debug(&format!("[TrackAnalysis] Warning: failed to serialize reports: {}", e));
        }
    }

    Ok(reports)
}

/// Загрузка кэшированного отчета анализа с диска
#[tauri::command]
pub fn load_track_analysis(project_dir: String) -> Result<Vec<TrackAnalysisReport>, String> {
    let norm_project_dir = crate::file_io::normalize_windows_path(&project_dir);
    let project_path = Path::new(&norm_project_dir);
    let analysis_file_path = project_path.join(".dubstudio").join("track_analysis.json");

    if !analysis_file_path.exists() {
        return Err("Analysis cache file does not exist".to_string());
    }

    let json_str = fs::read_to_string(&analysis_file_path)
        .map_err(|e| format!("Failed to read analysis file: {}", e))?;

    let reports: Vec<TrackAnalysisReport> = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse analysis JSON: {}", e))?;

    Ok(reports)
}
