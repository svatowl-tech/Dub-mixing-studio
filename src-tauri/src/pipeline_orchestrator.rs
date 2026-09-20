// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE PIPELINE STATE MACHINE & ORCHESTRATOR
// Автономный нативный конечный автомат конвейера сведения в Tokio
// Стек: tokio = "1.0", serde = "1.0", tauri = "2.2", dashmap = "6.1.0"
// Гарантия: автономная работа без разрыва при закрытии/перезагрузке фронтенда
// ============================================================================

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use crate::audio_buffer_manager::AudioBufferCache;
use crate::declick::process_clean_clicks;
use crate::ducking_engine::{process_ducking_offline, CueRange, CurveType, DuckingConfig};
use crate::eq_matching::process_match_eq_profile;
use crate::mastering_limiter::{
    process_mastering_limiter, DitherType, MasteringLimiterConfig, MasteringStandard,
};
use crate::normalization::{process_normalization, process_peak_adjustment};
use crate::silence_split::{detect_speech_segments, SilenceSplitConfig};
use crate::smart_align::{
    perform_smart_alignment_analysis, resolve_audio_samples, wsola_time_stretch, SmartAlignConfig,
};
use crate::uvr_denoise::denoise_audio_task;
use crate::vocal_bus::{process_vocal_bus_wav, VocalBusRackConfig};

// ============================================================================
// ФАЗЫ И ТЕЛЕМЕТРИЯ КОНВЕЙЕРА СВЕДЕНИЯ
// ============================================================================

/// Фазы конвейера сведения звука
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
#[allow(non_camel_case_types)]
pub enum PipelinePhase {
    #[serde(rename = "Phase1_Preprocessing")]
    Phase1_Preprocessing = 1,
    #[serde(rename = "Phase2_TimingAlignment")]
    Phase2_TimingAlignment = 2,
    #[serde(rename = "Phase3_MixingAndAutoFX")]
    Phase3_MixingAndAutoFX = 3,
    #[serde(rename = "Phase4_FinalMastering")]
    Phase4_FinalMastering = 4,
}

#[allow(dead_code)]
impl PipelinePhase {
    pub fn from_u8(val: u8) -> Self {
        match val {
            1 => PipelinePhase::Phase1_Preprocessing,
            2 => PipelinePhase::Phase2_TimingAlignment,
            3 => PipelinePhase::Phase3_MixingAndAutoFX,
            4 => PipelinePhase::Phase4_FinalMastering,
            _ => PipelinePhase::Phase1_Preprocessing,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            PipelinePhase::Phase1_Preprocessing => "Фаза 1: Предобработка и очистка",
            PipelinePhase::Phase2_TimingAlignment => "Фаза 2: Синхронизация и тайминг",
            PipelinePhase::Phase3_MixingAndAutoFX => "Фаза 3: Сведение и автоматическая обработка",
            PipelinePhase::Phase4_FinalMastering => "Фаза 4: Финальный мастеринг и лимитер",
        }
    }
}

/// Потоковая телеметрия, отправляемая во фронтенд через событие 'pipeline-telemetry'
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTelemetry {
    pub current_phase: u8,
    pub step_name: String,
    pub overall_progress: f32,
    pub step_progress: f32,
    pub log_message: String,
    pub elapsed_seconds: u64,
}

/// Статус выполнения конвейера для запроса из фронтенда
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStatusResponse {
    pub execution_id: String,
    pub project_id: String,
    pub current_phase: u8,
    pub current_step: String,
    pub overall_progress: f32,
    pub is_running: bool,
    pub is_paused: bool,
    pub is_cancelled: bool,
    pub elapsed_seconds: u64,
    pub output_files: Vec<String>,
}

// ============================================================================
// КОНФИГУРАЦИЯ КОНВЕЙЕРА (ВХОДНЫЕ ПАРАМЕТРЫ)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineConfig {
    pub execution_id: Option<String>,
    pub project_name: Option<String>,
    
    // Входные аудиопути
    pub original_audio_path: Option<String>,
    #[serde(default)]
    pub voice_audio_paths: Vec<String>,
    pub background_music_path: Option<String>,
    pub output_directory: Option<String>,

    // Фаза 1: Предобработка
    pub target_dialogue_lufs: Option<f64>,
    pub eq_profile: Option<String>,
    pub declick_sensitivity: Option<f32>,
    pub denoise_model: Option<String>,
    pub denoise_strength: Option<f32>,

    // Фаза 2: Синхронизация
    pub vad_onset_db: Option<f32>,
    pub vad_offset_db: Option<f32>,
    pub smart_align_max_stretch: Option<f64>,

    // Фаза 3: Сведение
    pub ducking_attenuation_db: Option<f32>,
    pub ducking_attack_ms: Option<f32>,
    pub ducking_release_ms: Option<f32>,
    pub vocal_bus_hpf_hz: Option<f32>,
    pub vocal_bus_warmth_db: Option<f32>,
    pub vocal_bus_compression_ratio: Option<f32>,

    // Фаза 4: Мастеринг
    pub master_target_lufs: Option<f64>,
    pub master_true_peak_ceiling: Option<f64>,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            execution_id: None,
            project_name: None,
            original_audio_path: None,
            voice_audio_paths: Vec::new(),
            background_music_path: None,
            output_directory: None,
            target_dialogue_lufs: Some(-16.0),
            eq_profile: Some("warm_broadcast".to_string()),
            declick_sensitivity: Some(50.0),
            denoise_model: Some("spectral_gate".to_string()),
            denoise_strength: Some(80.0),
            vad_onset_db: Some(-35.0),
            vad_offset_db: Some(-45.0),
            smart_align_max_stretch: Some(0.25),
            ducking_attenuation_db: Some(-14.0),
            ducking_attack_ms: Some(50.0),
            ducking_release_ms: Some(250.0),
            vocal_bus_hpf_hz: Some(75.0),
            vocal_bus_warmth_db: Some(2.0),
            vocal_bus_compression_ratio: Some(3.0),
            master_target_lufs: Some(-14.0),
            master_true_peak_ceiling: Some(-1.0),
        }
    }
}

// ============================================================================
// ДЕСКРИПТОР И СТЕЙТ ВЫПОЛНЕНИЯ В ПАМЯТИ
// ============================================================================

pub struct PipelineExecutionHandle {
    pub execution_id: String,
    pub project_id: String,
    pub cancellation_token: CancellationToken,
    pub is_paused: Arc<AtomicBool>,
    pub pause_notify: Arc<tokio::sync::Notify>,
    pub start_time: Instant,
    pub current_phase: Arc<AtomicU8>,
    pub current_step: Arc<RwLock<String>>,
    pub overall_progress_x100: Arc<AtomicU32>,
    pub is_finished: Arc<AtomicBool>,
    pub output_files: Arc<RwLock<Vec<String>>>,
}

impl PipelineExecutionHandle {
    pub fn new(execution_id: String, project_id: String) -> Self {
        Self {
            execution_id,
            project_id,
            cancellation_token: CancellationToken::new(),
            is_paused: Arc::new(AtomicBool::new(false)),
            pause_notify: Arc::new(tokio::sync::Notify::new()),
            start_time: Instant::now(),
            current_phase: Arc::new(AtomicU8::new(1)),
            current_step: Arc::new(RwLock::new("Инициализация".to_string())),
            overall_progress_x100: Arc::new(AtomicU32::new(0)),
            is_finished: Arc::new(AtomicBool::new(false)),
            output_files: Arc::new(RwLock::new(Vec::new())),
        }
    }
}

pub struct PipelineOrchestratorState {
    pub executions: Arc<DashMap<String, Arc<PipelineExecutionHandle>>>,
}

impl PipelineOrchestratorState {
    pub fn new() -> Self {
        Self {
            executions: Arc::new(DashMap::new()),
        }
    }
}

// ============================================================================
// ВНУТРЕННИЙ TASK-РАННЕР И STATE MACHINE ПЕРЕХОДОВ
// ============================================================================

/// Проверка паузы и отмены с асинхронным ожиданием
async fn check_pause_and_cancel(
    handle: &PipelineExecutionHandle,
) -> Result<(), String> {
    if handle.cancellation_token.is_cancelled() {
        return Err("Конвейер сведения прерван пользователем".to_string());
    }

    while handle.is_paused.load(Ordering::SeqCst) {
        if handle.cancellation_token.is_cancelled() {
            return Err("Конвейер сведения отменен во время паузы".to_string());
        }
        tokio::select! {
            _ = handle.pause_notify.notified() => {},
            _ = handle.cancellation_token.cancelled() => {
                return Err("Конвейер сведения отменен во время паузы".to_string());
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(150)) => {}
        }
    }

    if handle.cancellation_token.is_cancelled() {
        return Err("Конвейер сведения прерван пользователем".to_string());
    }

    Ok(())
}

/// Отправка телеметрии во фронтенд и обновление атомарного состояния
fn emit_telemetry(
    app: &AppHandle,
    handle: &PipelineExecutionHandle,
    phase: PipelinePhase,
    step_name: &str,
    overall_progress: f32,
    step_progress: f32,
    log_msg: &str,
) {
    let phase_u8 = phase as u8;
    handle.current_phase.store(phase_u8, Ordering::SeqCst);
    if let Ok(mut lock) = handle.current_step.write() {
        *lock = step_name.to_string();
    }
    let p_int = (overall_progress.clamp(0.0, 100.0) * 100.0).round() as u32;
    handle.overall_progress_x100.store(p_int, Ordering::SeqCst);

    let telemetry = PipelineTelemetry {
        current_phase: phase_u8,
        step_name: step_name.to_string(),
        overall_progress,
        step_progress,
        log_message: log_msg.to_string(),
        elapsed_seconds: handle.start_time.elapsed().as_secs(),
    };

    let _ = app.emit("pipeline-telemetry", &telemetry);
    println!(
        "[Pipeline #{}] [{}%] [Phase {} - {}] {}",
        handle.execution_id, overall_progress as u32, phase_u8, step_name, log_msg
    );
}

/// Основной рабочий цикл фонового конвейера
async fn run_native_pipeline(
    app: AppHandle,
    handle: Arc<PipelineExecutionHandle>,
    audio_cache: AudioBufferCache,
    settings: PipelineConfig,
) -> Result<(), String> {
    let execution_id = handle.execution_id.clone();
    let workspace_dir = match &settings.output_directory {
        Some(dir) => PathBuf::from(dir),
        None => std::env::temp_dir().join(format!("dubstudio_pipeline_{}", execution_id)),
    };

    if !workspace_dir.exists() {
        fs::create_dir_all(&workspace_dir)
            .map_err(|e| format!("Не удалось создать рабочий каталог {}: {}", workspace_dir.display(), e))?;
    }

    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase1_Preprocessing,
        "Инициализация конвейера",
        1.0,
        100.0,
        &format!("Рабочая область подготовлена: {}", workspace_dir.display()),
    );

    // Подготовка исходного голосового файла для обработки
    let raw_voice_path = settings.voice_audio_paths.first().cloned();
    let working_voice_wav = workspace_dir.join("voice_working.wav");

    if let Some(ref in_voice) = raw_voice_path {
        let p = Path::new(in_voice);
        if p.exists() {
            let _ = fs::copy(p, &working_voice_wav);
        }
    }

    // ========================================================================
    // ФАЗА 1: ПРЕДОБРАБОТКА И ОЧИСТКА АУДИО (PHASE 1: PREPROCESSING)
    // ========================================================================
    // Шаг 1.1: Пиковая подстройка громкости по самому высокому пику (-9 dBFS)
    check_pause_and_cancel(&handle).await?;
    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase1_Preprocessing,
        "Шаг 1.1: Пиковая подстройка громкости (-9 dBFS)",
        5.0,
        0.0,
        "Старт подстройки громкости по пику -9.0 dBFS...",
    );

    let peak_out = workspace_dir.join("01_peak_adjusted.wav");

    if working_voice_wav.exists() {
        match process_peak_adjustment(&working_voice_wav, &peak_out, -9.0) {
            Ok(stats) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase1_Preprocessing,
                    "Шаг 1.1: Пиковая подстройка громкости (-9 dBFS)",
                    10.0,
                    100.0,
                    &format!("Пиковая подстройка завершена: пик приведен к -9.0 dBFS (исходный {:.1} dBFS, гейн: {:+.1} dB)", stats.initial_peak_db, stats.gain_applied_db),
                );
            }
            Err(e) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase1_Preprocessing,
                    "Шаг 1.1: Пиковая подстройка громкости (-9 dBFS)",
                    10.0,
                    100.0,
                    &format!("Внимание при пиковой подстройке: {}. Переход к следующему шагу.", e),
                );
                let _ = fs::copy(&working_voice_wav, &peak_out);
            }
        }
    } else {
        emit_telemetry(
            &app,
            &handle,
            PipelinePhase::Phase1_Preprocessing,
            "Шаг 1.1: Пиковая подстройка громкости (-9 dBFS)",
            10.0,
            100.0,
            "Исходный голос не найден на диске, пропуск шага 1.1",
        );
    }

    // Шаг 1.2: EQ Matching
    check_pause_and_cancel(&handle).await?;
    let eq_input = if peak_out.exists() { peak_out } else { working_voice_wav.clone() };
    let eq_out = workspace_dir.join("02_eq_matched.wav");
    let eq_profile = settings.eq_profile.as_deref().unwrap_or("warm_broadcast");

    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase1_Preprocessing,
        "Шаг 1.2: EQ Matching спектральный баланс",
        15.0,
        0.0,
        &format!("Применение спектрального профиля '{}'...", eq_profile),
    );

    if eq_input.exists() {
        match process_match_eq_profile(&eq_input, &eq_out, eq_profile) {
            Ok(_) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase1_Preprocessing,
                    "Шаг 1.2: EQ Matching спектральный баланс",
                    18.0,
                    100.0,
                    "Спектральное соответствие успешно рассчитано через OLA FFT",
                );
            }
            Err(e) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase1_Preprocessing,
                    "Шаг 1.2: EQ Matching спектральный баланс",
                    18.0,
                    100.0,
                    &format!("Профиль EQ: {}. Перенос аудио без искажений.", e),
                );
                let _ = fs::copy(&eq_input, &eq_out);
            }
        }
    }

    // Шаг 1.3: De-Clicking
    check_pause_and_cancel(&handle).await?;
    let declick_in = if eq_out.exists() { eq_out } else { eq_input };
    let declick_out = workspace_dir.join("03_declicked.wav");
    let declick_sens = settings.declick_sensitivity.unwrap_or(50.0);

    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase1_Preprocessing,
        "Шаг 1.3: Удаление артефактов и кликов (De-Click)",
        20.0,
        0.0,
        &format!("Многопоточный поиск и очистка щелчков (Чувствительность: {:.1}%)...", declick_sens),
    );

    if declick_in.exists() {
        match process_clean_clicks(&declick_in, &declick_out, declick_sens) {
            Ok(rep) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase1_Preprocessing,
                    "Шаг 1.3: Удаление артефактов и кликов (De-Click)",
                    22.0,
                    100.0,
                    &format!("Устранено {} щелчков (восстановлено {} сэмплов)", rep.clicks_detected, rep.samples_restored),
                );
            }
            Err(e) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase1_Preprocessing,
                    "Шаг 1.3: Удаление артефактов и кликов (De-Click)",
                    22.0,
                    100.0,
                    &format!("Внимание De-Click: {}. Использован предыдущий буфер.", e),
                );
                let _ = fs::copy(&declick_in, &declick_out);
            }
        }
    }

    // Шаг 1.4: UVR De-Noise
    check_pause_and_cancel(&handle).await?;
    let denoise_in = if declick_out.exists() { declick_out } else { declick_in };
    let denoise_out = workspace_dir.join("04_denoised.wav");
    let denoise_model = settings.denoise_model.clone();
    let denoise_strength = settings.denoise_strength;

    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase1_Preprocessing,
        "Шаг 1.4: Нейросетевое шумоподавление (UVR De-Noise)",
        24.0,
        0.0,
        "Запуск спектрального подавления шума...",
    );

    if denoise_in.exists() {
        match denoise_audio_task(app.clone(), denoise_in.clone(), denoise_out.clone(), denoise_model, denoise_strength).await {
            Ok(rep) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase1_Preprocessing,
                    "Шаг 1.4: Нейросетевое шумоподавление (UVR De-Noise)",
                    27.0,
                    100.0,
                    &format!("Шумоподавление выполнено: снижение шума на {:.1} dB", rep.noise_reduction_db),
                );
            }
            Err(e) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase1_Preprocessing,
                    "Шаг 1.4: Нейросетевое шумоподавление (UVR De-Noise)",
                    27.0,
                    100.0,
                    &format!("Пропуск UVR нейросети ({}), сохранение исходного сигнала.", e),
                );
                let _ = fs::copy(&denoise_in, &denoise_out);
            }
        }
    }

    // Шаг 1.5: Итоговая EBU R128 Нормализация громкости (в самом конце предподготовки)
    check_pause_and_cancel(&handle).await?;
    let norm_in = if denoise_out.exists() { denoise_out.clone() } else { denoise_in.clone() };
    let norm_out = workspace_dir.join("05_normalized.wav");
    let target_lufs = settings.target_dialogue_lufs.unwrap_or(-16.0);

    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase1_Preprocessing,
        "Шаг 1.5: Итоговая EBU R128 Нормализация громкости",
        28.0,
        0.0,
        &format!("Финальная нормализация очищенной речи до целевых {:.1} LUFS...", target_lufs),
    );

    if norm_in.exists() {
        match process_normalization(&norm_in, &norm_out, target_lufs) {
            Ok(stats) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase1_Preprocessing,
                    "Шаг 1.5: Итоговая EBU R128 Нормализация громкости",
                    30.0,
                    100.0,
                    &format!("Нормализация завершена: {:.1} LUFS (Пик: {:.1} dBFS, гейн: {:+.1} dB)", stats.final_lufs, stats.final_true_peak_db, stats.gain_applied_db),
                );
            }
            Err(e) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase1_Preprocessing,
                    "Шаг 1.5: Итоговая EBU R128 Нормализация громкости",
                    30.0,
                    100.0,
                    &format!("Внимание при итоговой нормализации: {}. Использован чистый сигнал.", e),
                );
                let _ = fs::copy(&norm_in, &norm_out);
            }
        }
    } else {
        let _ = fs::copy(&working_voice_wav, &norm_out);
    }

    // ========================================================================
    // ФАЗА 2: СИНХРОНИЗАЦИЯ И ТАЙМИНГ (PHASE 2: TIMING ALIGNMENT)
    // ========================================================================
    check_pause_and_cancel(&handle).await?;
    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase2_TimingAlignment,
        "Шаг 2.1: VAD сегментация и разбивка реплик",
        35.0,
        0.0,
        "Анализ пауз речи и генерация голосовых масок...",
    );

    let phase2_input = if norm_out.exists() { norm_out } else if denoise_out.exists() { denoise_out } else { denoise_in };
    let mut speech_cues = Vec::new();
    let mut _sample_rate_detected = 48000u32;

    if phase2_input.exists() {
        if let Ok(audio) = resolve_audio_samples(&phase2_input.to_string_lossy(), Some(&audio_cache)) {
            _sample_rate_detected = audio.sample_rate;
            let mut vad_cfg = SilenceSplitConfig::default();
            vad_cfg.onset_threshold_db = settings.vad_onset_db;
            vad_cfg.offset_threshold_db = settings.vad_offset_db;

            let (cues, _, _, _) = detect_speech_segments(&audio.samples, audio.sample_rate, &vad_cfg);
            emit_telemetry(
                &app,
                &handle,
                PipelinePhase::Phase2_TimingAlignment,
                "Шаг 2.1: VAD сегментация и разбивка реплик",
                45.0,
                100.0,
                &format!("Обнаружено {} речевых сегментов для точного даккинга и тайминга", cues.len()),
            );
            speech_cues = cues;
        }
    }

    // Шаг 2.2: Smart Alignment (Синхронизация по оригиналу)
    check_pause_and_cancel(&handle).await?;
    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase2_TimingAlignment,
        "Шаг 2.2: Smart Alignment (GCC-PHAT + DTW + WSOLA)",
        48.0,
        0.0,
        "Выравнивание фонетических задержек по оригинальной дорожке...",
    );

    let aligned_voice_out = workspace_dir.join("05_smart_aligned.wav");
    if let (Some(ref orig_str), true) = (&settings.original_audio_path, phase2_input.exists()) {
        let orig_path = Path::new(orig_str);
        if orig_path.exists() {
            let orig_res = resolve_audio_samples(orig_str, Some(&audio_cache));
            let dub_res = resolve_audio_samples(&phase2_input.to_string_lossy(), Some(&audio_cache));

            if let (Ok(orig_audio), Ok(dub_audio)) = (orig_res, dub_res) {
                let align_cfg = SmartAlignConfig {
                    max_stretch_ratio: settings.smart_align_max_stretch.map(|s| 1.0 + s),
                    min_stretch_ratio: settings.smart_align_max_stretch.map(|s| 1.0 - s),
                    ..Default::default()
                };

                if let Ok(analysis) = perform_smart_alignment_analysis(
                    &orig_audio.samples,
                    &dub_audio.samples,
                    dub_audio.sample_rate,
                    orig_str,
                    &phase2_input.to_string_lossy(),
                    Some(align_cfg),
                ) {
                    emit_telemetry(
                        &app,
                        &handle,
                        PipelinePhase::Phase2_TimingAlignment,
                        "Шаг 2.2: Smart Alignment (GCC-PHAT + DTW + WSOLA)",
                        55.0,
                        50.0,
                        &format!("Коррекция задержки: {:.1} мс, растяжение: {:.2}x", analysis.detected_lag_ms, analysis.average_stretch_ratio),
                    );

                    let stretched = wsola_time_stretch(&dub_audio.samples, analysis.average_stretch_ratio, dub_audio.sample_rate);
                    let _ = crate::smart_align::save_mono_wav_24bit(&aligned_voice_out, &stretched, dub_audio.sample_rate);
                }
            }
        }
    }

    if !aligned_voice_out.exists() {
        let _ = fs::copy(&phase2_input, &aligned_voice_out);
        emit_telemetry(
            &app,
            &handle,
            PipelinePhase::Phase2_TimingAlignment,
            "Шаг 2.2: Smart Alignment (GCC-PHAT + DTW + WSOLA)",
            58.0,
            100.0,
            "Синхронизация завершена (исходный тайминг сохранен)",
        );
    }

    // ========================================================================
    // ФАЗА 3: СВЕДЕНИЕ И АВТОМАТИЧЕСКАЯ ОБРАБОТКА (PHASE 3: MIXING & AUTO FX)
    // ========================================================================
    check_pause_and_cancel(&handle).await?;
    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase3_MixingAndAutoFX,
        "Шаг 3.1: Адаптивный сайдчейн-даккинг фоновой дорожки M&E",
        60.0,
        0.0,
        "Генерация плавной огибающей подавления фона под реплики актера...",
    );

    let ducked_music_out = workspace_dir.join("06_music_ducked.wav");
    if let Some(ref bg_str) = settings.background_music_path {
        let bg_path = Path::new(bg_str);
        if bg_path.exists() {
            if let Ok(mut bg_audio) = resolve_audio_samples(bg_str, Some(&audio_cache)) {
                let cue_ranges: Vec<CueRange> = speech_cues
                    .iter()
                    .map(|c| CueRange {
                        start_sample: c.sample_start,
                        end_sample: c.sample_end,
                    })
                    .collect();

                let mut duck_cfg = DuckingConfig::default();
                if let Some(att) = settings.ducking_attenuation_db { duck_cfg.attenuation_db = att; }
                if let Some(att_ms) = settings.ducking_attack_ms { duck_cfg.attack_ms = att_ms; }
                if let Some(rel_ms) = settings.ducking_release_ms { duck_cfg.release_ms = rel_ms; }
                duck_cfg.curve_type = CurveType::SCurve;

                process_ducking_offline(
                    &mut bg_audio.samples,
                    &cue_ranges,
                    &duck_cfg,
                    bg_audio.sample_rate,
                    1,
                );

                let _ = crate::smart_align::save_mono_wav_24bit(&ducked_music_out, &bg_audio.samples, bg_audio.sample_rate);
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase3_MixingAndAutoFX,
                    "Шаг 3.1: Адаптивный сайдчейн-даккинг фоновой дорожки M&E",
                    68.0,
                    100.0,
                    &format!("Даккинг применен: глубина {:.1} dB для {} реплик", duck_cfg.attenuation_db, cue_ranges.len()),
                );
            }
        }
    }

    // Шаг 3.2: Обработка вокальной мастер-шины (Vocal Bus Rack)
    check_pause_and_cancel(&handle).await?;
    let vocal_bus_in = if aligned_voice_out.exists() { aligned_voice_out } else { phase2_input };
    let vocal_bus_out = workspace_dir.join("07_vocal_bus_mastered.wav");

    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase3_MixingAndAutoFX,
        "Шаг 3.2: Мастер-рэк вокала (Vocal Bus Rack)",
        70.0,
        0.0,
        "Применение цепочки HPF, De-Esser, Saturation, Opto Compressor, Exciter...",
    );

    if vocal_bus_in.exists() {
        let mut rack_cfg = VocalBusRackConfig::default();
        if let Some(hpf) = settings.vocal_bus_hpf_hz { rack_cfg.eq.hpf_cutoff_hz = hpf; }
        if let Some(warmth) = settings.vocal_bus_warmth_db { rack_cfg.saturation.drive_db = warmth; }
        if let Some(comp_r) = settings.vocal_bus_compression_ratio { rack_cfg.compressor.ratio = comp_r; }

        match process_vocal_bus_wav(&vocal_bus_in, &vocal_bus_out, &rack_cfg) {
            Ok(rep) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase3_MixingAndAutoFX,
                    "Шаг 3.2: Мастер-рэк вокала (Vocal Bus Rack)",
                    82.0,
                    100.0,
                    &format!("Вокальная шина обработана: Макс. компрессия {:.1} dB, Деэссер: {:.1} dB", rep.max_compression_db, rep.max_deesser_db),
                );
            }
            Err(e) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase3_MixingAndAutoFX,
                    "Шаг 3.2: Мастер-рэк вокала (Vocal Bus Rack)",
                    82.0,
                    100.0,
                    &format!("Ошибка рэка вокала: {}. Использован прямой вход.", e),
                );
                let _ = fs::copy(&vocal_bus_in, &vocal_bus_out);
            }
        }
    }

    // ========================================================================
    // ФАЗА 4: ФИНАЛЬНЫЙ МАСТЕРИНГ И ЛИМИТЕР (PHASE 4: FINAL MASTERING)
    // ========================================================================
    check_pause_and_cancel(&handle).await?;
    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase4_FinalMastering,
        "Шаг 4.1: Финальный EBU R128 мастеринг и 4x True-Peak лимитер",
        85.0,
        0.0,
        "Двухпроходная нормализация громкости и оверсэмплинг True Peak...",
    );

    let master_in = if vocal_bus_out.exists() { vocal_bus_out } else { vocal_bus_in };
    let final_master_out = workspace_dir.join("FINAL_MASTER_DUB.wav");

    let mut master_cfg = MasteringLimiterConfig::default();
    master_cfg.standard = MasteringStandard::YoutubeWeb;
    master_cfg.target_lufs = settings.master_target_lufs.or(Some(-14.0));
    master_cfg.true_peak_ceiling_db = settings.master_true_peak_ceiling.or(Some(-1.0));
    master_cfg.oversampling_factor = Some(4);
    master_cfg.dither = Some(DitherType::Tpdf24Bit);

    if master_in.exists() {
        match process_mastering_limiter(&master_in, &final_master_out, master_cfg) {
            Ok(stats) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase4_FinalMastering,
                    "Шаг 4.1: Финальный EBU R128 мастеринг и 4x True-Peak лимитер",
                    98.0,
                    100.0,
                    &format!("Мастеринг завершен: {:.1} LUFS, True-Peak: {:.2} dBTP (Ограничено пиков: {})", stats.final_integrated_lufs, stats.final_true_peak_dbtp, stats.total_limited_events),
                );
            }
            Err(e) => {
                emit_telemetry(
                    &app,
                    &handle,
                    PipelinePhase::Phase4_FinalMastering,
                    "Шаг 4.1: Финальный EBU R128 мастеринг и 4x True-Peak лимитер",
                    98.0,
                    100.0,
                    &format!("Внимание мастеринга: {}. Копирование готового файла.", e),
                );
                let _ = fs::copy(&master_in, &final_master_out);
            }
        }
    }

    // Сохранение списка выходных файлов
    if let Ok(mut lock) = handle.output_files.write() {
        lock.clear();
        if final_master_out.exists() {
            lock.push(final_master_out.to_string_lossy().to_string());
        }
        if ducked_music_out.exists() {
            lock.push(ducked_music_out.to_string_lossy().to_string());
        }
    }

    handle.is_finished.store(true, Ordering::SeqCst);
    emit_telemetry(
        &app,
        &handle,
        PipelinePhase::Phase4_FinalMastering,
        "Завершено",
        100.0,
        100.0,
        &format!("Конвейер сведения успешно завершен за {} сек. Готов мастер-файл: {}", handle.start_time.elapsed().as_secs(), final_master_out.display()),
    );

    Ok(())
}

// ============================================================================
// TAURI V2 КОМАНДЫ ДЛЯ ФРОНТЕНДА
// ============================================================================

/// Запуск полного конвейера сведения в автономной задаче Tokio
#[command]
pub async fn start_pipeline_execution(
    app: AppHandle,
    state: State<'_, PipelineOrchestratorState>,
    audio_cache: State<'_, AudioBufferCache>,
    project_id: String,
    settings: PipelineConfig,
) -> Result<String, String> {
    let execution_id = settings
        .execution_id
        .clone()
        .unwrap_or_else(|| format!("exec_{}_{}", project_id, Instant::now().elapsed().as_millis()));

    // Проверяем, не запущена ли уже задача для данного execution_id
    if let Some(existing) = state.executions.get(&execution_id) {
        if !existing.is_finished.load(Ordering::SeqCst) && !existing.cancellation_token.is_cancelled() {
            return Ok(execution_id);
        }
    }

    let handle = Arc::new(PipelineExecutionHandle::new(execution_id.clone(), project_id));
    state.executions.insert(execution_id.clone(), handle.clone());

    let app_clone = app.clone();
    let audio_cache_clone = audio_cache.inner().clone();
    let handle_clone = handle.clone();

    // Запуск полностью изолированного таска Tokio
    tokio::spawn(async move {
        let exec_id = handle_clone.execution_id.clone();
        match run_native_pipeline(app_clone.clone(), handle_clone.clone(), audio_cache_clone, settings).await {
            Ok(_) => {
                println!("[Pipeline Orchestrator] Выполнение #{} завершено успешно!", exec_id);
            }
            Err(e) => {
                eprintln!("[Pipeline Orchestrator] Ошибка выполнения #{}: {}", exec_id, e);
                emit_telemetry(
                    &app_clone,
                    &handle_clone,
                    PipelinePhase::from_u8(handle_clone.current_phase.load(Ordering::SeqCst)),
                    "Ошибка выполнения",
                    handle_clone.overall_progress_x100.load(Ordering::SeqCst) as f32 / 100.0,
                    0.0,
                    &format!("Сбой конвейера: {}", e),
                );
            }
        }
    });

    Ok(execution_id)
}

/// Отмена выполнения конвейера сведения по execution_id через CancellationToken
#[command]
pub async fn cancel_pipeline_execution(
    state: State<'_, PipelineOrchestratorState>,
    execution_id: String,
) -> Result<bool, String> {
    if let Some(handle) = state.executions.get(&execution_id) {
        handle.cancellation_token.cancel();
        handle.pause_notify.notify_waiters();
        Ok(true)
    } else {
        Err(format!("Процесс сведения с ID '{}' не найден", execution_id))
    }
}

/// Пауза конвейера сведения
#[command]
pub async fn pause_pipeline_execution(
    state: State<'_, PipelineOrchestratorState>,
    execution_id: String,
) -> Result<bool, String> {
    if let Some(handle) = state.executions.get(&execution_id) {
        handle.is_paused.store(true, Ordering::SeqCst);
        Ok(true)
    } else {
        Err(format!("Процесс сведения с ID '{}' не найден", execution_id))
    }
}

/// Возобновление конвейера сведения после паузы
#[command]
pub async fn resume_pipeline_execution(
    state: State<'_, PipelineOrchestratorState>,
    execution_id: String,
) -> Result<bool, String> {
    if let Some(handle) = state.executions.get(&execution_id) {
        handle.is_paused.store(false, Ordering::SeqCst);
        handle.pause_notify.notify_waiters();
        Ok(true)
    } else {
        Err(format!("Процесс сведения с ID '{}' не найден", execution_id))
    }
}

/// Получение текущего статуса конвейера
#[command]
pub async fn get_pipeline_status(
    state: State<'_, PipelineOrchestratorState>,
    execution_id: String,
) -> Result<PipelineStatusResponse, String> {
    if let Some(handle) = state.executions.get(&execution_id) {
        let step_name = handle
            .current_step
            .read()
            .map(|s| s.clone())
            .unwrap_or_else(|_| "Неизвестно".to_string());

        let out_files = handle
            .output_files
            .read()
            .map(|f| f.clone())
            .unwrap_or_else(|_| Vec::new());

        let progress = (handle.overall_progress_x100.load(Ordering::SeqCst) as f32) / 100.0;
        let is_running = !handle.is_finished.load(Ordering::SeqCst) && !handle.cancellation_token.is_cancelled();

        Ok(PipelineStatusResponse {
            execution_id: handle.execution_id.clone(),
            project_id: handle.project_id.clone(),
            current_phase: handle.current_phase.load(Ordering::SeqCst),
            current_step: step_name,
            overall_progress: progress,
            is_running,
            is_paused: handle.is_paused.load(Ordering::SeqCst),
            is_cancelled: handle.cancellation_token.is_cancelled(),
            elapsed_seconds: handle.start_time.elapsed().as_secs(),
            output_files: out_files,
        })
    } else {
        Err(format!("Процесс сведения с ID '{}' не найден", execution_id))
    }
}
