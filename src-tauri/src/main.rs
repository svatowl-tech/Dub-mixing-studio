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

use audio_engine::{get_audio_devices, start_recording, stop_recording, force_stop_all, check_crashes, AudioState, AudioRecorder};
use logger::log_debug;
use vst_host::{
    scan_plugins, load_plugin, unload_plugin, process_audio_block,
    get_plugin_parameters, set_plugin_parameter, get_plugin_state,
    set_plugin_state, open_plugin_editor, close_plugin_editor,
    SharedVstHostState,
};
use normalization::normalize_audio;
use eq_matching::match_eq_profile;
use declick::clean_clicks;
use deplosive::apply_deplosive;
use deesser::process_deesser;
use uvr_denoise::process_denoise;
use uvr_dereverb::process_uvr_dereverb;
use volume_leveler::level_speech_volume;
use source_separation::{separate_audio_stems, cancel_source_separation};
use audio_separator::{check_audio_separator_status, install_audio_separator_pkg, run_audio_separator_cmd};
use export_engine::{export_audio, export_stems, export_all_stems, quick_preview_export, batch_export, export_audio_book, export_backstage_video};
use db::{AppState, init_db, save_project_to_db, load_project_from_db, migrate_json_to_db, save_subtitles, generate_stress_test, load_segments_in_range, check_project_assets, verify_project_files, cleanup_orphaned_files, relink_segment_file, calculate_file_hash, find_file_by_hash};
use waveform_engine::{extract_audio_peaks_bin, generate_waveform_peaks};
use file_io::{read_text_file, read_binary_file, list_audio_files, write_audio_file, init_project_folder, get_file_info, save_media_recorder_take, save_project_file, copy_file_to_project};
use media_processor::{create_proxy_video, mux_video, merge_segments, merge_project_segments, render_final_video, concat_backstage_videos, get_media_info, extract_mkv_assets, create_blank_video, apply_audio_effect};

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

            Ok(())
        })
        .manage(app_state)
        .manage(vst_state)
        .manage(AudioState {
            recorder: std::sync::Mutex::new(AudioRecorder::default()),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            open_devtools,
            get_audio_devices,
            start_recording,
            stop_recording,
            force_stop_all,
            check_crashes,
            scan_plugins,
            load_plugin,
            unload_plugin,
            process_audio_block,
            get_plugin_parameters,
            set_plugin_parameter,
            get_plugin_state,
            set_plugin_state,
            open_plugin_editor,
            close_plugin_editor,
            export_audio,
            export_stems,
            save_project_to_db,
            load_project_from_db,
            migrate_json_to_db,
            extract_audio_peaks_bin,
            generate_waveform_peaks,
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
            match_eq_profile,
            clean_clicks,
            apply_deplosive,
            process_deesser,
            process_denoise,
            process_uvr_dereverb,
            level_speech_volume,
            separate_audio_stems,
            cancel_source_separation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// EOF

