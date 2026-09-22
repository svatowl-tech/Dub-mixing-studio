#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod process_utils;
mod acoustic_analyzer;
mod audio_buffer_manager;
mod audio_engine;
mod audio_separator;
mod backstage_recorder;
mod conflict_detection;
mod db;
mod declick;
mod deesser;
mod deplosive;
mod dsp_waveform;
mod ducking_engine;
mod eq_matching;
mod export_engine;
mod file_io;
mod gain_matching;
mod intelligent_normalization;
mod logger;
mod loudness_engine;
mod mastering_limiter;
mod media_processor;
mod model_manager;
mod normalization;
mod pipeline_orchestrator;
mod project_repository;
mod project_type_rules;
mod qa_audit;
mod realtime_analyzer;
mod sidechain_ducking;
mod silence_split;
mod silence_vad_engine;
mod smart_align;
mod source_separation;
mod spectral_analysis;
mod spectral_balancing;
mod speech_cue_classifier;
mod speech_leveler;
mod stem_export;
mod subtitle_compiler;
mod subtitle_engine;
mod subtitle_fuzzy_engine;
mod timeline_culling_engine;
mod timeline_history_engine;
mod timing_compliance_engine;
mod track_analysis;
mod transport_clock;
mod uvr_denoise;
mod uvr_dereverb;
mod video_muxer;
mod vocal_bus;
mod vocal_rack_dsp;
mod vocal_spot_cleaner;
mod volume_leveler;
mod vst_host;
mod waveform_bucket_engine;
mod waveform_engine;
mod whisper_engine;

use acoustic_analyzer::{analyze_acoustic_environment, analyze_segments_acoustics};
use audio_buffer_manager::{
    clear_all_audio_buffers, get_audio_slice, get_buffer_cache_stats, load_audio_file,
    unload_audio_buffer, AudioBufferCache,
};
use audio_engine::{
    check_crashes, clear_native_playback_cache, force_stop_all, get_audio_devices,
    get_native_playback_position, preload_playback_buffers, seek_native_playback,
    start_native_playback, start_recording, stop_native_playback, stop_recording,
    update_native_playback_tracks, AudioRecorder, AudioState, NativeAudioPlayer,
};
use audio_separator::{
    check_audio_separator_status, install_audio_separator_pkg, run_audio_separator_cmd,
};
use backstage_recorder::{
    force_stop_backstage, is_backstage_recording, start_backstage_recording,
    stop_backstage_recording, BackstageState,
};
use conflict_detection::validate_timeline_compliance;
use db::{
    calculate_file_hash, check_project_assets, cleanup_orphaned_files, find_file_by_hash,
    generate_stress_test, init_db, load_project_from_db, load_segments_in_range,
    migrate_json_to_db, relink_segment_file, save_project_to_db, save_subtitles,
    verify_project_files, AppState,
};
use declick::clean_clicks;
use deesser::process_deesser;
use deplosive::apply_deplosive;
use dsp_waveform::{
    transform_waveform_declick, transform_waveform_deesser, transform_waveform_deplosive,
    transform_waveform_denoise, transform_waveform_dereverb, transform_waveform_eq,
    transform_waveform_leveler,
};
use ducking_engine::{apply_adaptive_ducking, calculate_ducking_envelope_preview};
use eq_matching::match_eq_profile;
use export_engine::{
    batch_export, cancel_export, export_all_stems, export_audio, export_audio_book,
    export_backstage_video, export_stems, quick_preview_export, render_voiceover_mix,
};
use file_io::{
    copy_file, copy_file_to_project, ensure_track_audio_wav, get_file_info, init_project_folder,
    list_audio_files, move_project_folder, open_path, read_binary_file, read_text_file,
    save_media_recorder_take, save_project_file, write_audio_file,
};
use gain_matching::apply_smart_gain_matching;
use intelligent_normalization::process_intelligent_normalization_with_clips;
use logger::log_debug;
use loudness_engine::{analyze_track_loudness, reset_realtime_loudness, RealtimeLoudnessMeter};
use mastering_limiter::apply_mastering_limiter;
use media_processor::{
    apply_audio_effect, concat_backstage_videos, create_blank_video, create_proxy_video,
    extract_mkv_assets, get_media_info, merge_project_segments, merge_segments, mux_video,
    process_media_effect, render_final_video,
};
use model_manager::{
    cancel_model_download, check_model_installed, delete_ai_model, download_ai_model,
    get_available_models_info, open_models_directory,
};
use normalization::{
    adjust_peak_audio, apply_waveform_upward_compression, estimate_lufs_from_pcm, normalize_audio,
};
use pipeline_orchestrator::{
    cancel_pipeline_execution, get_pipeline_status, pause_pipeline_execution,
    resume_pipeline_execution, start_pipeline_execution, PipelineOrchestratorState,
};
use project_repository::{
    delete_project, list_all_projects, load_project_by_id, redo_project_action,
    save_project_atomic, undo_project_action,
};
use project_type_rules::validate_and_adjust_project_rules;
use qa_audit::run_project_qa_audit;
use realtime_analyzer::{
    generate_waveform_mipmaps, get_latest_spectrum_frame, start_realtime_spectrum_analyzer,
    stop_realtime_spectrum_analyzer, RealtimeAnalyzerState,
};
use sidechain_ducking::render_sidechain_ducking;
use silence_split::{process_vad_split, split_by_silence};
use silence_vad_engine::detect_speech_regions;
use smart_align::{align_vocal_clip, calculate_smart_alignment};
use source_separation::{cancel_source_separation, separate_audio_stems};
use spectral_analysis::{compute_spectrogram_from_file, compute_spectrogram_from_pcm};
use spectral_balancing::process_spectral_balancing;
use speech_cue_classifier::classify_project_cues;
use speech_leveler::process_speech_leveler;
use stem_export::export_project_stems;
use subtitle_compiler::{compile_and_validate_subtitles, parse_subtitles_native};
use subtitle_engine::{
    burn_subtitles_to_video, generate_ass_subtitle_file, process_subtitle_burn_stage,
};
use subtitle_fuzzy_engine::{match_transcription_with_script, parse_subtitle_file_native};
use timeline_culling_engine::{
    clear_timeline_culling_cache, get_timeline_visible_peaks, set_timeline_culling_tracks,
    TimelineCullingState,
};
use timeline_history_engine::{
    clear_timeline_history, get_timeline_history_status, init_timeline_history_base,
    record_timeline_action, redo_timeline_action, undo_timeline_action,
};
use timing_compliance_engine::audit_project_timing;
use track_analysis::{analyze_voice_tracks, load_track_analysis};
use transport_clock::{
    start_tick_worker, transport_clear_loop, transport_get_snapshot, transport_pause,
    transport_play, transport_seek, transport_seek_ms, transport_set_loop,
    transport_start_preroll, transport_stop_preroll, transport_ui_ack, TransportClock,
};
use uvr_denoise::process_denoise;
use uvr_dereverb::process_uvr_dereverb;
use video_muxer::execute_final_video_render;
use vocal_bus::{batch_process_master_vocal_bus, process_master_vocal_bus};
use vocal_rack_dsp::{
    get_rack_state, load_vst3_plugin_to_rack, reset_rack, set_rack_parameters,
    SharedVocalRackManager, VocalRackManager,
};
use vocal_spot_cleaner::process_vocal_spot_cleaning;
use volume_leveler::level_speech_volume;
use vst_host::{
    batch_process_vst_chain, close_plugin_editor, get_plugin_parameters, get_plugin_state,
    load_plugin, open_plugin_editor, process_audio_block, scan_plugins, scan_plugins_with_paths,
    set_plugin_parameter, set_plugin_state, unload_plugin, SharedVstHostState, VstHostState,
};
use waveform_bucket_engine::{
    compute_waveform_buckets_from_peaks, compute_waveform_render_buckets,
};
use waveform_engine::{
    ensure_original_audio_extracted, extract_audio_peaks_bin, generate_waveform_peaks,
    generate_waveform_peaks_from_pcm,
};
use whisper_engine::transcribe_and_match_script;

use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog;
use tokio::sync::Mutex;

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    #[cfg(debug_assertions)]
    window.open_devtools();

    #[cfg(not(debug_assertions))]
    window.open_devtools();
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

    // Shared state container for SQLite DB pool
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
        .setup(move |app| {
            log_debug("--- APPLICATION STARTUP ---");
            let app_handle = app.handle().clone();

            // Resolve and ensure app data directory exists
            let app_data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| {
                std::env::temp_dir().join("dubstudio_data")
            });
            let _ = std::fs::create_dir_all(&app_data_dir);
            let db_path = app_data_dir.join("dev.db");
            let db_path_str = db_path.to_string_lossy().to_string();

            // Synchronously block on SQLite Database initialization and schema migrations
            // Guarantees pool is fully prepared before any UI requests are handled.
            match tauri::async_runtime::block_on(init_db(&db_path_str)) {
                Ok(pool) => {
                    let state = app_handle.state::<AppState>();
                    let mut db_lock = tauri::async_runtime::block_on(state.db.lock());
                    *db_lock = Some(pool);
                    log_debug(&format!(
                        "SQLx Database initialized and migrations applied successfully at {}",
                        db_path_str
                    ));
                }
                Err(e) => {
                    let err_msg = format!("Failed to initialize database: {}", e);
                    eprintln!("{}", err_msg);
                    log_debug(&err_msg);
                }
            }

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
        .manage(BackstageState::default())
        .manage(AudioState {
            recorder: std::sync::Mutex::new(AudioRecorder::default()),
            player: std::sync::Mutex::new(player),
            clock: transport_clock.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            copy_file,
            open_devtools,
            get_audio_devices,
            start_recording,
            stop_recording,
            force_stop_all,
            start_backstage_recording,
            stop_backstage_recording,
            is_backstage_recording,
            force_stop_backstage,
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
            cancel_export,
            quick_preview_export,
            batch_export,
            export_audio_book,
            render_voiceover_mix,
            analyze_voice_tracks,
            load_track_analysis,
            process_intelligent_normalization_with_clips,
            process_spectral_balancing,
            process_speech_leveler,
            process_vocal_spot_cleaning,
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
            adjust_peak_audio,
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
            check_model_installed,
            detect_speech_regions,
            audit_project_timing,
            compute_waveform_render_buckets,
            compute_waveform_buckets_from_peaks,
            parse_subtitle_file_native,
            match_transcription_with_script,
            classify_project_cues,
            ensure_original_audio_extracted
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
