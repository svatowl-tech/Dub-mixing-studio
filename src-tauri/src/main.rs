#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_engine;
mod export_engine;
mod db;
mod waveform_engine;
mod file_io;
mod media_processor;
mod logger;
mod vst_host;
mod audio_separator;
mod normalization;
mod eq_matching;
mod declick;
mod deplosive;
mod deesser;
mod uvr_denoise;
mod uvr_dereverb;
mod volume_leveler;
mod source_separation;
mod silence_split;
mod whisper_engine;
mod smart_align;
mod project_type_rules;
mod conflict_detection;
mod spectral_analysis;
mod dsp_waveform;
mod gain_matching;
mod sidechain_ducking;
mod acoustic_analyzer;
mod vocal_bus;
mod qa_audit;
mod mastering_limiter;
mod subtitle_engine;
mod stem_export;
mod video_muxer;
mod audio_buffer_manager;
mod loudness_engine;
mod ducking_engine;
mod realtime_analyzer;
mod vocal_rack_dsp;
mod project_repository;
mod transport_clock;
mod timeline_culling_engine;
mod pipeline_orchestrator;
mod subtitle_compiler;
mod timeline_history_engine;
mod model_manager;

use subtitle_compiler::{compile_and_validate_subtitles, parse_subtitles_native};
use model_manager::{
    cancel_model_download, check_model_installed, delete_ai_model, download_ai_model,
    get_available_models_info, open_models_directory,
};
use timeline_history_engine::{
    clear_timeline_history, get_timeline_history_status, init_timeline_history_base,
    record_timeline_action, redo_timeline_action, undo_timeline_action,
};

use pipeline_orchestrator::{
    cancel_pipeline_execution, get_pipeline_status, pause_pipeline_execution,
    resume_pipeline_execution, start_pipeline_execution, PipelineOrchestratorState,
};

use timeline_culling_engine::{
    get_timeline_visible_peaks, set_timeline_culling_tracks, clear_timeline_culling_cache,
    TimelineCullingState,
};

use transport_clock::{
    transport_play, transport_pause, transport_seek, transport_seek_ms,
    transport_set_loop, transport_clear_loop, transport_start_preroll,
    transport_stop_preroll, transport_get_snapshot, transport_ui_ack,
    start_tick_worker, TransportClock,
};

use project_repository::{
    save_project_atomic, load_project_by_id, undo_project_action, redo_project_action,
    list_all_projects, delete_project,
};

use audio_engine::{
    get_audio_devices, start_recording, stop_recording, force_stop_all, check_crashes,
    preload_playback_buffers, start_native_playback, stop_native_playback,
    seek_native_playback, update_native_playback_tracks, get_native_playback_position,
    clear_native_playback_cache, AudioState, AudioRecorder, NativeAudioPlayer
};
use logger::log_debug;
use vst_host::{
    scan_plugins, scan_plugins_with_paths, load_plugin, unload_plugin, process_audio_block,
    get_plugin_parameters, set_plugin_parameter, get_plugin_state,
    set_plugin_state, open_plugin_editor, close_plugin_editor,
    batch_process_vst_chain,
    SharedVstHostState, VstHostState,
};
use normalization::{normalize_audio, estimate_lufs_from_pcm, apply_waveform_upward_compression};
use eq_matching::match_eq_profile;
use declick::clean_clicks;
use deplosive::apply_deplosive;
use deesser::process_deesser;
use uvr_denoise::process_denoise;
use uvr_dereverb::process_uvr_dereverb;
use volume_leveler::level_speech_volume;
use source_separation::{separate_audio_stems, cancel_source_separation};
use silence_split::{split_by_silence, process_vad_split};
use whisper_engine::transcribe_and_match_script;
use smart_align::{align_vocal_clip, calculate_smart_alignment};
use project_type_rules::validate_and_adjust_project_rules;
use conflict_detection::validate_timeline_compliance;
use audio_separator::{check_audio_separator_status, install_audio_separator_pkg, run_audio_separator_cmd};
use export_engine::{export_audio, export_stems, export_all_stems, quick_preview_export, batch_export, export_audio_book, export_backstage_video};
use db::{AppState, init_db, save_project_to_db, load_project_from_db, migrate_json_to_db, save_subtitles, generate_stress_test, load_segments_in_range, check_project_assets, verify_project_files, cleanup_orphaned_files, relink_segment_file, calculate_file_hash, find_file_by_hash};
use waveform_engine::{extract_audio_peaks_bin, generate_waveform_peaks, generate_waveform_peaks_from_pcm};
use file_io::{read_text_file, read_binary_file, list_audio_files, write_audio_file, init_project_folder, get_file_info, save_media_recorder_take, save_project_file, copy_file_to_project, ensure_track_audio_wav, move_project_folder, open_path};
use media_processor::{create_proxy_video, mux_video, merge_segments, merge_project_segments, render_final_video, concat_backstage_videos, get_media_info, extract_mkv_assets, create_blank_video, apply_audio_effect, process_media_effect};
use spectral_analysis::{compute_spectrogram_from_file, compute_spectrogram_from_pcm};
use dsp_waveform::{
    transform_waveform_eq,
    transform_waveform_declick,
    transform_waveform_deplosive,
    transform_waveform_deesser,
    transform_waveform_denoise,
    transform_waveform_dereverb,
    transform_waveform_leveler,
};
use gain_matching::apply_smart_gain_matching;
use sidechain_ducking::render_sidechain_ducking;
use acoustic_analyzer::{analyze_acoustic_environment, analyze_segments_acoustics};
use vocal_bus::{process_master_vocal_bus, batch_process_master_vocal_bus};
use qa_audit::run_project_qa_audit;
use mastering_limiter::apply_mastering_limiter;
use subtitle_engine::{generate_ass_subtitle_file, burn_subtitles_to_video, process_subtitle_burn_stage};
use stem_export::export_project_stems;
use video_muxer::execute_final_video_render;
use audio_buffer_manager::{
    load_audio_file, get_audio_slice, unload_audio_buffer, clear_all_audio_buffers,
    get_buffer_cache_stats, AudioBufferCache
};
use loudness_engine::{
    analyze_track_loudness, reset_realtime_loudness, RealtimeLoudnessMeter
};
use ducking_engine::{
    apply_adaptive_ducking, calculate_ducking_envelope_preview
};
use realtime_analyzer::{
    start_realtime_spectrum_analyzer, stop_realtime_spectrum_analyzer,
    get_latest_spectrum_frame, generate_waveform_mipmaps, RealtimeAnalyzerState
};
use vocal_rack_dsp::{
    set_rack_parameters, load_vst3_plugin_to_rack, get_rack_state, reset_rack,
    VocalRackManager, SharedVocalRackManager
};

use std::sync::Arc;
use tokio::sync::Mutex;
use tauri_plugin_dialog;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Listener};

#[derive(Deserialize, Debug)]
#[serde(tag = "action", content = "data", rename_all = "snake_case")]
enum DubstudioAction {
    #[serde(rename_all = "camelCase")]
    ExtractAudioPeaks { file_path: String, output_dir: String },
    #[serde(rename_all = "camelCase")]
    StartRecording {
        device_name: String,
        host_name: String,
        sample_rate: u32,
        buffer_size: u32,
        track_id: String,
        segment_id: String,
        start_time: f64,
        channel_index: u32,
        backstage_record: bool,
        video_device: Option<String>,
        audio_device: Option<String>,
        project_path: Option<String>,
        gate_enabled: bool,
        gate_threshold: Option<f32>,
        limiter_enabled: Option<bool>,
        limiter_threshold: Option<f32>,
    },
    #[serde(rename_all = "camelCase")]
    StopRecording {},
    #[serde(rename_all = "camelCase")]
    ForceStopAll {},
}

#[derive(Serialize, Clone)]
struct DubstudioResult {
    action: String,
    success: bool,
    data: serde_json::Value,
    error: Option<String>,
    request_id: Option<String>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    #[cfg(debug_assertions)]
    window.open_devtools();
    
    #[cfg(not(debug_assertions))]
    window.open_devtools(); // Try forcing it in release mode too (requires devtools feature)
}

fn main() {
    // Setup global panic hook to capture any fatal panics and log them
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("Dub Mixing Studio fatal startup error:\n{}", info);
        eprintln!("{}", msg);
        let temp_log = std::env::temp_dir().join("dubstudio_crash.log");
        let _ = std::fs::write(&temp_log, &msg);
        
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::core::HSTRING;
            use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
            let title = HSTRING::from("Dub Mixing Studio - Crash");
            let text = HSTRING::from(msg);
            let _ = MessageBoxW(None, &text, &title, MB_OK | MB_ICONERROR);
        }
    }));

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        // Initialize COM for the UI thread safely
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    // Shared empty state initially
    let app_state = AppState {
        db: Arc::new(Mutex::new(None)),
    };

    let vst_state: SharedVstHostState = Arc::new(std::sync::Mutex::new(VstHostState::default()));

    let transport_clock = Arc::new(TransportClock::new(48000));
    let player = NativeAudioPlayer::with_clock(transport_clock.clone());
    let transport_clock_setup = transport_clock.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            log_debug("--- APPLICATION STARTUP ---");
            let app_handle = app.handle().clone();
            
            // Register event listener for long-running actions
            let app_handle_events = app_handle.clone();
            app.listen("dubstudio-action", move |event| {
                let app_handle = app_handle_events.clone();
                let event_str = event.payload();
                
                // We need to parse the payload and request_id if present
                #[derive(Deserialize)]
                struct EventWrapper {
                    #[serde(flatten)]
                    action: DubstudioAction,
                    request_id: Option<String>,
                }

                let wrapper: Result<EventWrapper, _> = serde_json::from_str(event_str);
                
                if let Ok(w) = wrapper {
                    let request_id = w.request_id.clone();
                    let action_type = match &w.action {
                        DubstudioAction::ExtractAudioPeaks { .. } => "extract_audio_peaks",
                        DubstudioAction::StartRecording { .. } => "start_recording",
                        DubstudioAction::StopRecording { .. } => "stop_recording",
                        DubstudioAction::ForceStopAll { .. } => "force_stop_all",
                    }.to_string();

                    tauri::async_runtime::spawn(async move {
                        let result: Result<serde_json::Value, String> = match w.action {
                            DubstudioAction::ExtractAudioPeaks { file_path, output_dir } => {
                                extract_audio_peaks_bin(app_handle.clone(), file_path, output_dir)
                                    .await.map(|v| serde_json::to_value(v).unwrap())
                            },
                            DubstudioAction::StartRecording { 
                                device_name, host_name, sample_rate, buffer_size, track_id, segment_id, 
                                start_time, channel_index, backstage_record, video_device, 
                                audio_device, project_path, gate_enabled, gate_threshold, limiter_enabled, limiter_threshold
                            } => {
                                println!("Rust received start_recording action for dev: {}", device_name);
                                let state = app_handle.state::<AudioState>();
                                let res = start_recording(
                                    app_handle.clone(), state, device_name, host_name, sample_rate, 
                                    buffer_size, track_id, segment_id, start_time, channel_index, 
                                    backstage_record, video_device, audio_device, project_path, 
                                    gate_enabled, gate_threshold, limiter_enabled.unwrap_or(false), limiter_threshold.unwrap_or(-9.0)
                                ).await;

                                if res.is_ok() {
                                    println!("Recording started successfully, emitting recording-started event");
                                    let _ = app_handle.emit("recording-started", serde_json::json!({}));
                                }

                                res.map(|_| serde_json::Value::Null)
                            },
                            DubstudioAction::StopRecording { .. } => {
                                let state = app_handle.state::<AudioState>();
                                stop_recording(state).await.map(|v| serde_json::to_value(v).unwrap())
                            },
                            DubstudioAction::ForceStopAll { .. } => {
                                let state = app_handle.state::<AudioState>();
                                force_stop_all(state).await.map(|_| serde_json::Value::Null)
                            }
                        };

                        let (success, data, error) = match result {
                            Ok(d) => (true, d, None),
                            Err(e) => (false, serde_json::Value::Null, Some(e)),
                        };

                        let _ = app_handle.emit("dubstudio-result", DubstudioResult {
                            action: action_type,
                            success,
                            data,
                            error,
                            request_id,
                        });
                    });
                } else {
                    eprintln!("Failed to parse dubstudio-action: {}", event_str);
                }
            });

            // Use Tauri 2.0 path resolver safely without panicking
            use tauri::Manager;
            let app_data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| {
                std::env::temp_dir().join("dubstudio_data")
            });
            let _ = std::fs::create_dir_all(&app_data_dir);
            let db_path = app_data_dir.join("dev.db");
            let db_path_str = db_path.to_string_lossy().to_string();

            tauri::async_runtime::spawn(async move {
                // Initialize database asynchronously 
                match init_db(&db_path_str).await {
                    Ok(pool) => {
                        let state = app_handle.state::<AppState>();
                        let mut db_lock = state.db.lock().await;
                        *db_lock = Some(pool);
                        println!("SQLx Database initialized successfully at {}", db_path_str);
                    }
                    Err(e) => {
                        eprintln!("Failed to initialize DB: {}", e);
                    }
                }
            });

            // Start the 60 Hz Hardware Master Clock Tick Thread
            start_tick_worker(transport_clock_setup.clone(), app_handle.clone());

            Ok(())
        })
        .manage(app_state)
        .manage(vst_state)
        .manage(AudioBufferCache::new())
        .manage(RealtimeLoudnessMeter::new())
        .manage(RealtimeAnalyzerState::default())
        .manage(Arc::new(VocalRackManager::new()) as SharedVocalRackManager)
        .manage(TimelineCullingState::new())
        .manage(PipelineOrchestratorState::new())
        .manage(AudioState {
            recorder: std::sync::Mutex::new(AudioRecorder::default()),
            player: std::sync::Mutex::new(player),
            clock: transport_clock.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            open_devtools,
            get_audio_devices,
            start_recording,
            stop_recording,
            force_stop_all,
            check_crashes,
            preload_playback_buffers,
            start_native_playback,
            stop_native_playback,
            seek_native_playback,
            update_native_playback_tracks,
            get_native_playback_position,
            clear_native_playback_cache,
            scan_plugins,
            scan_plugins_with_paths,
            load_plugin,
            unload_plugin,
            process_audio_block,
            get_plugin_parameters,
            set_plugin_parameter,
            get_plugin_state,
            set_plugin_state,
            open_plugin_editor,
            close_plugin_editor,
            batch_process_vst_chain,
            export_audio,
            export_stems,
            save_project_to_db,
            load_project_from_db,
            migrate_json_to_db,
            extract_audio_peaks_bin,
            generate_waveform_peaks,
            generate_waveform_peaks_from_pcm,
            read_text_file,
            read_binary_file,
            list_audio_files,
            write_audio_file,
            init_project_folder,
            get_file_info,
            save_media_recorder_take,
            save_project_file,
            copy_file_to_project,
            save_subtitles,
            generate_stress_test,
            load_segments_in_range,
            check_project_assets,
            verify_project_files,
            cleanup_orphaned_files,
            relink_segment_file,
            calculate_file_hash,
            find_file_by_hash,
            create_proxy_video,
            mux_video,
            render_final_video,
            merge_segments,
            merge_project_segments,
            export_all_stems,
            quick_preview_export,
            batch_export,
            export_audio_book,
            export_backstage_video,
            concat_backstage_videos,
            get_media_info,
            extract_mkv_assets,
            create_blank_video,
            apply_audio_effect,
            check_audio_separator_status,
            install_audio_separator_pkg,
            run_audio_separator_cmd,
            normalize_audio,
            estimate_lufs_from_pcm,
            apply_waveform_upward_compression,
            match_eq_profile,
            clean_clicks,
            apply_deplosive,
            process_deesser,
            process_denoise,
            process_uvr_dereverb,
            level_speech_volume,
            ensure_track_audio_wav,
            separate_audio_stems,
            cancel_source_separation,
            split_by_silence,
            transcribe_and_match_script,
            align_vocal_clip,
            calculate_smart_alignment,
            validate_and_adjust_project_rules,
            validate_timeline_compliance,
            process_media_effect,
            process_vad_split,
            move_project_folder,
            open_path,
            compute_spectrogram_from_file,
            compute_spectrogram_from_pcm,
            transform_waveform_eq,
            transform_waveform_declick,
            transform_waveform_deplosive,
            transform_waveform_deesser,
            transform_waveform_denoise,
            transform_waveform_dereverb,
            transform_waveform_leveler,
            apply_smart_gain_matching,
            render_sidechain_ducking,
            analyze_acoustic_environment,
            analyze_segments_acoustics,
            process_master_vocal_bus,
            batch_process_master_vocal_bus,
            run_project_qa_audit,
            apply_mastering_limiter,
            generate_ass_subtitle_file,
            burn_subtitles_to_video,
            process_subtitle_burn_stage,
            export_project_stems,
            execute_final_video_render,
            load_audio_file,
            get_audio_slice,
            unload_audio_buffer,
            clear_all_audio_buffers,
            get_buffer_cache_stats,
            analyze_track_loudness,
            reset_realtime_loudness,
            apply_adaptive_ducking,
            calculate_ducking_envelope_preview,
            start_realtime_spectrum_analyzer,
            stop_realtime_spectrum_analyzer,
            get_latest_spectrum_frame,
            generate_waveform_mipmaps,
            set_rack_parameters,
            load_vst3_plugin_to_rack,
            get_rack_state,
            reset_rack,
            save_project_atomic,
            load_project_by_id,
            undo_project_action,
            redo_project_action,
            list_all_projects,
            delete_project,
            transport_play,
            transport_pause,
            transport_seek,
            transport_seek_ms,
            transport_set_loop,
            transport_clear_loop,
            transport_start_preroll,
            transport_stop_preroll,
            transport_get_snapshot,
            transport_ui_ack,
            get_timeline_visible_peaks,
            set_timeline_culling_tracks,
            clear_timeline_culling_cache,
            start_pipeline_execution,
            cancel_pipeline_execution,
            pause_pipeline_execution,
            resume_pipeline_execution,
            get_pipeline_status,
            compile_and_validate_subtitles,
            parse_subtitles_native,
            record_timeline_action,
            undo_timeline_action,
            redo_timeline_action,
            get_timeline_history_status,
            init_timeline_history_base,
            clear_timeline_history,
            get_available_models_info,
            download_ai_model,
            cancel_model_download,
            delete_ai_model,
            open_models_directory,
            check_model_installed
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// EOF

