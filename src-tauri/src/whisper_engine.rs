// Rust модуль распознавания речи OpenAI Whisper (whisper-rs)
// с квантованными GGML моделями, универсальным декодированием аудио и ресэмплингом в 16 кГц моно через Rubato,
// нечетким сопоставлением со сценарием (Fuzzy / Levenshtein Matcher) и потоковой передачей прогресса в UI.

use hound::{SampleFormat, WavReader};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{command, AppHandle, Emitter};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Модели Whisper
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WhisperModelType {
    WhisperTiny,
    WhisperBase,
    WhisperSmall,
    WhisperMedium,
    WhisperLargeV3,
    Custom(String),
}

impl Default for WhisperModelType {
    fn default() -> Self {
        WhisperModelType::WhisperBase
    }
}

/// Строка сценария (ASS, SRT, DOCX, JSON) для сопоставления
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptItem {
    pub id: String,
    pub text: String,
    pub start_timestamp_ms: Option<i64>,
    pub end_timestamp_ms: Option<i64>,
    pub role: Option<String>,
}

/// Транскрибированный фрагмент фразы / сегмент
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptItem {
    pub text: String,
    pub start_timestamp_ms: i64,
    pub end_timestamp_ms: i64,
    pub confidence: f32,
    pub matched_script_id: Option<String>,
    pub matched_script_text: Option<String>,
    pub match_similarity: Option<f32>,
}

/// Конфигурация запуска Whisper транскрибации
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperTranscribeConfig {
    pub model_path: Option<String>,
    pub model_type: Option<String>,
    pub language: Option<String>, // "ru", "en", "auto"
    pub n_threads: Option<i32>,
    pub translate: Option<bool>,
    pub temperature: Option<f32>,
    pub script_lines: Option<Vec<ScriptItem>>,
    pub auto_match_script: Option<bool>,
    pub min_similarity_threshold: Option<f32>, // e.g. 0.40 (40%)
}

/// Итоговый результат транскрибации и сопоставления
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperTranscriptionResult {
    pub audio_path: String,
    pub duration_ms: i64,
    pub items: Vec<TranscriptItem>,
    pub full_text: String,
    pub model_used: String,
    pub average_confidence: f32,
}

/// Событие прогресса для UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperProgressEvent {
    pub progress: i32,
    pub stage: String,
}

// -------------------------------------------------------------------------------------------------
// Декодирование аудио и Ресэмплинг (Rubato + Hound + Symphonia)
// -------------------------------------------------------------------------------------------------

/// Декодирование любого аудиоформата (WAV, MP3, FLAC, OGG, AAC, M4A) в моно PCM сэмплы f32
pub fn load_audio_any_format<P: AsRef<Path>>(file_path: P) -> Result<(Vec<f32>, u32), String> {
    let path = file_path.as_ref();

    if !path.exists() {
        return Err(format!("Аудиофайл не найден: {:?}", path));
    }

    // 1. Быстрый путь для WAV файлов через Hound
    if let Ok(mut reader) = WavReader::open(path) {
        let spec = reader.spec();
        let channels = spec.channels as usize;
        let sample_rate = spec.sample_rate;

        if channels > 0 {
            let raw_mono: Vec<f32> = match spec.sample_format {
                SampleFormat::Float => {
                    let samples: Vec<f32> = reader.samples::<f32>().filter_map(|s| s.ok()).collect();
                    if channels == 1 {
                        samples
                    } else {
                        samples
                            .chunks(channels)
                            .map(|chunk| chunk.iter().sum::<f32>() / (channels as f32))
                            .collect()
                    }
                }
                SampleFormat::Int => {
                    let bits = spec.bits_per_sample;
                    let max_val = match bits {
                        0..=16 => 32768.0f32,
                        17..=24 => 8388608.0f32,
                        _ => 2147483648.0f32,
                    };
                    let samples: Vec<f32> = reader
                        .samples::<i32>()
                        .filter_map(|s| s.ok())
                        .map(|s| (s as f32) / max_val)
                        .collect();
                    if channels == 1 {
                        samples
                    } else {
                        samples
                            .chunks(channels)
                            .map(|chunk| chunk.iter().sum::<f32>() / (channels as f32))
                            .collect()
                    }
                }
            };
            if !raw_mono.is_empty() {
                return Ok((raw_mono, sample_rate));
            }
        }
    }

    // 2. Универсальное декодирование через Symphonia для MP3, FLAC, OGG, M4A, AAC
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Не удалось открыть аудиофайл {:?}: {}", path, e))?;

    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let format_opts = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    let metadata_opts = MetadataOptions::default();
    let decoder_opts = DecoderOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| format!("Ошибка определения формата аудио {:?}: {}", path, e))?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "Аудиодорожки не найдены в файле".to_string())?;

    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Ошибка создания декодера: {}", e))?;

    let track_id = track.id;
    let mut mono_samples = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(ref err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => continue,
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                let spec = *audio_buf.spec();
                let mut sample_buf = SampleBuffer::<f32>::new(audio_buf.capacity() as u64, spec);
                sample_buf.copy_interleaved_ref(audio_buf);

                let samples = sample_buf.samples();
                let ch_count = spec.channels.count();

                if ch_count == 1 {
                    mono_samples.extend_from_slice(samples);
                } else {
                    for chunk in samples.chunks(ch_count) {
                        let avg: f32 = chunk.iter().sum::<f32>() / (ch_count as f32);
                        mono_samples.push(avg);
                    }
                }
            }
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(_) => break,
        }
    }

    if mono_samples.is_empty() {
        return Err("Не удалось извлечь PCM сэмплы из аудиофайла".to_string());
    }

    Ok((mono_samples, sample_rate))
}

/// Загрузка любого аудио и конвертация строго в 16 000 Гц моно Vec<f32>
pub fn load_audio_as_16k_mono<P: AsRef<Path>>(file_path: P) -> Result<Vec<f32>, String> {
    let (raw_mono, sample_rate) = load_audio_any_format(file_path)?;

    if raw_mono.is_empty() {
        return Ok(Vec::new());
    }

    if sample_rate == 16000 {
        return Ok(raw_mono);
    }

    resample_audio_rubato(&raw_mono, sample_rate as usize, 16000)
}

/// Высококачественный ресэмплинг аудио-вектора в целевую частоту (16 kHz) через Rubato
pub fn resample_audio_rubato(
    samples: &[f32],
    from_rate: usize,
    to_rate: usize,
) -> Result<Vec<f32>, String> {
    if from_rate == to_rate || samples.is_empty() {
        return Ok(samples.to_vec());
    }

    let chunk_size = 1024;

    let params = SincInterpolationParameters {
        sinc_len: 64,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };

    let mut resampler = SincFixedIn::<f32>::new(
        to_rate as f64 / from_rate as f64,
        2.0,
        params,
        chunk_size,
        1,
    )
    .map_err(|e| format!("Ошибка инициализации Rubato Resampler: {}", e))?;

    let mut output: Vec<f32> = Vec::with_capacity(
        ((samples.len() as f64) * (to_rate as f64 / from_rate as f64)) as usize + 2048,
    );

    let mut input_channel = Vec::with_capacity(chunk_size);

    for sample in samples {
        input_channel.push(*sample);
        if input_channel.len() == chunk_size {
            let waves_in = vec![input_channel.clone()];
            let waves_out = resampler
                .process(&waves_in, None)
                .map_err(|e| format!("Ошибка ресэмплинга: {}", e))?;
            if let Some(out_chan) = waves_out.get(0) {
                output.extend_from_slice(out_chan);
            }
            input_channel.clear();
        }
    }

    if !input_channel.is_empty() {
        let pad_len = chunk_size - input_channel.len();
        input_channel.extend(std::iter::repeat(0.0f32).take(pad_len));
        let waves_in = vec![input_channel];
        if let Ok(waves_out) = resampler.process(&waves_in, None) {
            if let Some(out_chan) = waves_out.get(0) {
                output.extend_from_slice(out_chan);
            }
        }
    }

    Ok(output)
}

// -------------------------------------------------------------------------------------------------
// Поиск моделей Whisper GGML на диске
// -------------------------------------------------------------------------------------------------

/// Разрешение локального пути к квантованной модели GGML (resources/models/whisper/ и другие пути)
pub fn resolve_model_path(model_type_or_path: Option<&str>) -> Result<PathBuf, String> {
    let default_name = match model_type_or_path {
        Some("whisper-tiny") | Some("tiny") => "ggml-tiny.bin",
        Some("whisper-base") | Some("base") => "ggml-base.bin",
        Some("whisper-small") | Some("small") => "ggml-small.bin",
        Some("whisper-medium") | Some("medium") => "ggml-medium.bin",
        Some("whisper-large-v3") | Some("large") => "ggml-large-v3.bin",
        Some(custom) if custom.ends_with(".bin") => custom,
        Some(custom) => custom,
        None => "ggml-base.bin",
    };

    let p = Path::new(default_name);
    if p.exists() && p.is_file() {
        return Ok(p.to_path_buf());
    }

    let mut search_paths = vec![
        PathBuf::from(default_name),
        PathBuf::from("resources").join("models").join("whisper").join(default_name),
        PathBuf::from("resources").join("models").join(default_name),
        PathBuf::from("models").join("whisper").join(default_name),
        PathBuf::from("models").join(default_name),
        PathBuf::from("src-tauri").join("resources").join("models").join("whisper").join(default_name),
        PathBuf::from("src-tauri").join("models").join(default_name),
        PathBuf::from("..").join("resources").join("models").join("whisper").join(default_name),
        PathBuf::from("..").join("models").join(default_name),
    ];

    if let Ok(appdata) = std::env::var("APPDATA") {
        search_paths.push(
            PathBuf::from(appdata)
                .join("com.dubmixingstudio.desktop")
                .join("models")
                .join("whisper")
                .join(default_name),
        );
        search_paths.push(
            PathBuf::from(appdata)
                .join("com.dubmixingstudio.desktop")
                .join("models")
                .join(default_name),
        );
    }
    if let Ok(home) = std::env::var("HOME") {
        search_paths.push(
            PathBuf::from(&home)
                .join(".local")
                .join("share")
                .join("com.dubmixingstudio.desktop")
                .join("models")
                .join("whisper")
                .join(default_name),
        );
        search_paths.push(
            PathBuf::from(&home)
                .join("Library")
                .join("Application Support")
                .join("com.dubmixingstudio.desktop")
                .join("models")
                .join("whisper")
                .join(default_name),
        );
    }

    for path in search_paths {
        if path.exists() && path.is_file() {
            return Ok(path);
        }
    }

    // Возвращаем целевой путь в resources/models/whisper/
    Ok(PathBuf::from("resources").join("models").join("whisper").join(default_name))
}

// -------------------------------------------------------------------------------------------------
// Fuzzy Matcher: Расчет Левенштейна и сопоставление фразы со сценарием
// -------------------------------------------------------------------------------------------------

/// Нормализация текста для сопоставления
pub fn normalize_text_for_match(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
}

/// Вычисление расстояния Левенштейна
pub fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let len_a = a_chars.len();
    let len_b = b_chars.len();

    if len_a == 0 {
        return len_b;
    }
    if len_b == 0 {
        return len_a;
    }

    let mut prev_row: Vec<usize> = (0..=len_b).collect();
    let mut curr_row: Vec<usize> = vec![0; len_b + 1];

    for i in 0..len_a {
        curr_row[0] = i + 1;
        for j in 0..len_b {
            let cost = if a_chars[i] == b_chars[j] { 0 } else { 1 };
            curr_row[j + 1] = std::cmp::min(
                std::cmp::min(curr_row[j] + 1, prev_row[j + 1] + 1),
                prev_row[j] + cost,
            );
        }
        prev_row.copy_from_slice(&curr_row);
    }

    prev_row[len_b]
}

/// Вычисление коэффициента сходства (0.0 .. 1.0)
pub fn calculate_similarity(a: &str, b: &str) -> f32 {
    let norm_a = normalize_text_for_match(a);
    let norm_b = normalize_text_for_match(b);

    if norm_a.is_empty() && norm_b.is_empty() {
        return 1.0;
    }
    if norm_a.is_empty() || norm_b.is_empty() {
        return 0.0;
    }
    if norm_a == norm_b {
        return 1.0;
    }

    if norm_a.contains(&norm_b) || norm_b.contains(&norm_a) {
        let shorter = norm_a.len().min(norm_b.len()) as f32;
        let longer = norm_a.len().max(norm_b.len()) as f32;
        return (0.8 + 0.2 * (shorter / longer)).min(1.0);
    }

    let max_len = norm_a.chars().count().max(norm_b.chars().count());
    let dist = levenshtein_distance(&norm_a, &norm_b);

    let score = 1.0 - (dist as f32 / max_len as f32);
    score.max(0.0).min(1.0)
}

/// Сопоставление массива распознанных сегментов с оригинальным сценарием
pub fn match_transcripts_with_script(
    items: &mut [TranscriptItem],
    script_lines: &[ScriptItem],
    min_threshold: f32,
) {
    if script_lines.is_empty() {
        return;
    }

    for item in items.iter_mut() {
        let mut best_match: Option<&ScriptItem> = None;
        let mut best_score: f32 = 0.0;

        for script in script_lines {
            let mut score = calculate_similarity(&item.text, &script.text);

            if let (Some(s_start), Some(s_end)) = (script.start_timestamp_ms, script.end_timestamp_ms) {
                let start_diff = (item.start_timestamp_ms - s_start).abs();
                let end_diff = (item.end_timestamp_ms - s_end).abs();
                if start_diff < 1500 && end_diff < 1500 {
                    score = (score + 0.15).min(1.0);
                } else if start_diff < 4000 {
                    score = (score + 0.05).min(1.0);
                }
            }

            if score > best_score {
                best_score = score;
                best_match = Some(script);
            }
        }

        if best_score >= min_threshold {
            if let Some(matched) = best_match {
                item.matched_script_id = Some(matched.id.clone());
                item.matched_script_text = Some(matched.text.clone());
                item.match_similarity = Some((best_score * 100.0).round() / 100.0);
            }
        }
    }
}

// -------------------------------------------------------------------------------------------------
// Движок инференса OpenAI Whisper (whisper-rs)
// -------------------------------------------------------------------------------------------------

/// Вычисление средней уверенности (confidence) для сегмента Whisper
fn get_segment_confidence(state: &whisper_rs::WhisperState, segment_idx: i32) -> f32 {
    if let Ok(num_tokens) = state.full_n_tokens(segment_idx) {
        if num_tokens > 0 {
            let mut sum_p = 0.0f32;
            let mut count = 0;
            for t in 0..num_tokens {
                if let Ok(prob) = state.full_get_token_prob(segment_idx, t) {
                    sum_p += prob;
                    count += 1;
                }
            }
            if count > 0 {
                return (sum_p / count as f32).clamp(0.0, 1.0);
            }
        }
    }
    0.92
}

/// Функция запуска локального инференса Whisper с трансляцией прогресса в UI
pub fn run_whisper_transcription(
    app_handle: Option<&AppHandle>,
    audio_path: &str,
    config: WhisperTranscribeConfig,
) -> Result<WhisperTranscriptionResult, String> {
    // Вспомогательная функция отправки прогресса в UI
    let emit_progress = |pct: i32, stage_str: &str| {
        if let Some(handle) = app_handle {
            let _ = handle.emit(
                "whisper-progress",
                WhisperProgressEvent {
                    progress: pct,
                    stage: stage_str.to_string(),
                },
            );
        }
    };

    emit_progress(5, "Загрузка и ресэмплинг аудио");

    // 1. Чтение и ресэмплинг входного аудио в 16 000 Гц моно Vec<f32>
    let p = Path::new(audio_path);
    if !p.exists() {
        return Err(format!("Аудиофайл не найден: {}", audio_path));
    }

    let samples = load_audio_as_16k_mono(p)?;
    if samples.is_empty() {
        return Err("Загруженный аудиофайл пуст или не содержит сэмплов".to_string());
    }

    let duration_ms = ((samples.len() as f64 / 16000.0) * 1000.0) as i64;
    emit_progress(15, "Поиск локальной модели Whisper GGML");

    // 2. Разрешение пути к бинарной модели GGML
    let model_type_str = config.model_type.as_deref().or(config.model_path.as_deref());
    let model_path = resolve_model_path(model_type_str)?;

    if !model_path.exists() {
        return Err(format!(
            "Файл модели Whisper GGML не найден по пути: {:?}. Пожалуйста, скачайте модель (например, ggml-base.bin или ggml-small.bin) в директорию resources/models/whisper/",
            model_path
        ));
    }

    let model_name = model_path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("ggml-base.bin")
        .to_string();

    let model_path_str = model_path
        .to_str()
        .ok_or_else(|| format!("Некорректный путь к модели: {:?}", model_path))?;

    emit_progress(25, "Инициализация WhisperContext и загрузка модели");

    // 3. Создание WhisperContext и WhisperState с обработкой ошибок памяти
    let ctx_params = WhisperContextParameters::default();
    let ctx = WhisperContext::new_with_params(model_path_str, ctx_params)
        .map_err(|e| format!(" Ошибка загрузки модели Whisper из {:?}: {}", model_path, e))?;

    let mut state = ctx.create_state().map_err(|e| {
        format!(
            " Ошибка выделения памяти/создания WhisperState для инференса: {}",
            e
        )
    })?;

    // 4. Настройка параметров инференса (Язык: "ru", Word-level timestamps, треды)
    let lang = config.language.as_deref().unwrap_or("ru");
    let n_threads = config.n_threads.unwrap_or(4).max(1);

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(n_threads);
    params.set_language(Some(lang));
    params.set_token_timestamps(true); // Word-level timestamps
    params.set_split_on_word(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_translate(config.translate.unwrap_or(false));

    if let Some(temp) = config.temperature {
        params.set_temperature(temp);
    }

    // Потоковая передача прогресса инференса
    if let Some(handle) = app_handle {
        let handle_clone = handle.clone();
        params.set_progress_callback_safe(move |pct| {
            let mapped_pct = 25 + ((pct as f32 / 100.0) * 65.0) as i32; // Масштабируем 0..100% в диапазон 25..90%
            let _ = handle_clone.emit(
                "whisper-progress",
                WhisperProgressEvent {
                    progress: mapped_pct,
                    stage: format!("Инференс Whisper: {}%", pct),
                },
            );
        });
    }

    emit_progress(30, "Запуск распознавания речи Whisper...");

    // 5. Выполнение локального инференса
    state
        .full(params, &samples[..])
        .map_err(|e| format!(" Ошибка во время выполнения инференса Whisper: {}", e))?;

    emit_progress(90, "Извлечение распознанных сегментов");

    // 6. Извлечение результатов распознавания
    let num_segments = state
        .full_n_segments()
        .map_err(|e| format!("Ошибка чтения сегментов из WhisperState: {}", e))?;

    let mut transcript_items = Vec::with_capacity(num_segments as usize);

    for i in 0..num_segments {
        if let Ok(text) = state.full_get_segment_text(i) {
            let start_t = state.full_get_segment_t0(i).unwrap_or(0) * 10; // whisper timestamp unit is 10ms
            let end_t = state.full_get_segment_t1(i).unwrap_or(0) * 10;
            let trimmed = text.trim().to_string();

            if !trimmed.is_empty() {
                let confidence = get_segment_confidence(&state, i);

                transcript_items.push(TranscriptItem {
                    text: trimmed,
                    start_timestamp_ms: start_t,
                    end_timestamp_ms: end_t,
                    confidence: (confidence * 100.0).round() / 100.0,
                    matched_script_id: None,
                    matched_script_text: None,
                    match_similarity: None,
                });
            }
        }
    }

    // 7. Сопоставление с оригинальным сценарием (Fuzzy Matcher)
    let auto_match = config.auto_match_script.unwrap_or(true);
    let min_sim = config.min_similarity_threshold.unwrap_or(0.40);

    if auto_match {
        if let Some(ref script_lines) = config.script_lines {
            emit_progress(95, "Нечеткое сопоставление со сценарием (Fuzzy Matcher)");
            match_transcripts_with_script(&mut transcript_items, script_lines, min_sim);
        }
    }

    let full_text = transcript_items
        .iter()
        .map(|it| it.text.as_str())
        .collect::<Vec<&str>>()
        .join(" ");

    let avg_conf = if !transcript_items.is_empty() {
        transcript_items.iter().map(|it| it.confidence).sum::<f32>() / (transcript_items.len() as f32)
    } else {
        0.0
    };

    emit_progress(100, "Распознавание завершено");

    Ok(WhisperTranscriptionResult {
        audio_path: audio_path.to_string(),
        duration_ms,
        items: transcript_items,
        full_text,
        model_used: model_name,
        average_confidence: (avg_conf * 100.0).round() / 100.0,
    })
}

// -------------------------------------------------------------------------------------------------
// Tauri V2 Commands
// -------------------------------------------------------------------------------------------------

/// Tauri команда: Локальное распознавание речи через Whisper и сопоставление со сценарием
#[command]
pub async fn transcribe_and_match_script(
    app_handle: AppHandle,
    audio_path: String,
    config: WhisperTranscribeConfig,
) -> Result<WhisperTranscriptionResult, String> {
    tokio::task::spawn_blocking(move || {
        run_whisper_transcription(Some(&app_handle), &audio_path, config)
    })
    .await
    .map_err(|e| format!("Ошибка фонового потока Whisper: {}", e))?
}

// -------------------------------------------------------------------------------------------------
// Unit-тесты
// -------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_levenshtein_distance() {
        assert_eq!(levenshtein_distance("привет", "привет"), 0);
        assert_eq!(levenshtein_distance("привет", "привет мир"), 4);
        assert_eq!(levenshtein_distance("корова", "корона"), 1);
    }

    #[test]
    fn test_similarity_score() {
        let sim1 = calculate_similarity("Привет, как дела?", "привет как дела");
        assert!(sim1 > 0.95);

        let sim2 = calculate_similarity("Добрый вечер", "Спокойной ночи");
        assert!(sim2 < 0.5);

        let sim3 = calculate_similarity("Сэр, мы готовы к взлету!", "Мы готовы к взлету");
        assert!(sim3 > 0.7);
    }

    #[test]
    fn test_resample_rubato_identity() {
        let samples = vec![0.0f32, 0.5, 1.0, 0.5, 0.0, -0.5, -1.0, -0.5];
        let resampled = resample_audio_rubato(&samples, 16000, 16000).unwrap();
        assert_eq!(resampled.len(), samples.len());
    }

    #[test]
    fn test_script_matching() {
        let mut items = vec![TranscriptItem {
            text: "Да пребудет с тобой сила".to_string(),
            start_timestamp_ms: 1200,
            end_timestamp_ms: 3500,
            confidence: 0.95,
            matched_script_id: None,
            matched_script_text: None,
            match_similarity: None,
        }];

        let script = vec![
            ScriptItem {
                id: "sub_1".to_string(),
                text: "Привет всем".to_string(),
                start_timestamp_ms: Some(0),
                end_timestamp_ms: Some(1000),
                role: None,
            },
            ScriptItem {
                id: "sub_2".to_string(),
                text: "Да пребудет с тобой Великая Сила!".to_string(),
                start_timestamp_ms: Some(1250),
                end_timestamp_ms: Some(3600),
                role: None,
            },
        ];

        match_transcripts_with_script(&mut items, &script, 0.4);
        assert_eq!(items[0].matched_script_id, Some("sub_2".to_string()));
        assert!(items[0].match_similarity.unwrap() > 0.6);
    }
}
