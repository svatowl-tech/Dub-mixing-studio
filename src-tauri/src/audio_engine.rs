use ebur128::{EbuR128, Mode};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, StreamConfig};
use crossbeam_channel::{bounded, Receiver, Sender};
use ringbuf::RingBuffer;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State, Manager};
use rubato::{Resampler, SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction};
use crate::logger::log_debug;

// --- DATA STRUCTURES ---

#[derive(Serialize, Clone)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub host: String, // "ASIO", "WASAPI", "CoreAudio" etc.
    pub default_sample_rate: u32,
    pub max_input_channels: u16,
}

#[derive(Serialize, Clone)]
pub struct VuMeterPayload {
    pub rms: f32,
    pub peak: f32,
    pub loudness_lufs: f32,
}

#[derive(Serialize, Clone)]
pub struct RecordMetadata {
    pub duration: f64,
    pub peaks: Vec<f32>,
}

#[derive(Serialize, Clone)]
pub struct RecordResult {
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub metadata: RecordMetadata,
    #[serde(rename = "videoPath")]
    pub video_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InternalRecordResult {
    pub file_path: String,
    pub duration: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecoveryData {
    pub file_path: String,
    pub track_id: String,
    pub segment_id: String,
    pub sample_rate: u32,
    pub start_time: f64,
}

// Manages the recording stream lifecycle
pub struct AudioRecorder {
    pub is_recording: Arc<AtomicBool>,
    writer_handle: Option<tokio::task::JoinHandle<Result<InternalRecordResult, String>>>,
    pub current_lock_path: Option<std::path::PathBuf>,
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
    pub video_child: Option<std::process::Child>,
    pub current_video_path: Option<std::path::PathBuf>,
}

unsafe impl Send for AudioRecorder {}
unsafe impl Sync for AudioRecorder {}

impl Default for AudioRecorder {
    fn default() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            writer_handle: None,
            current_lock_path: None,
            stop_tx: None,
            video_child: None,
            current_video_path: None,
        }
    }
}

// Global state for Tauri
pub struct AudioState {
    pub recorder: Mutex<AudioRecorder>,
}

// --- NOISE GATE LOGIC ---

struct NoiseGate {
    threshold: f32,
    attack_coef: f32,
    release_coef: f32,
    current_gain: f32,
    envelope: f32,
    enabled: bool,
    // Start Bypass logic: keep gate open for first 10 seconds to record Room Tone
    initial_bypass_samples: usize,
}

impl NoiseGate {
    fn new(sample_rate: f32, threshold_db: f32, attack_ms: f32, release_ms: f32, enabled: bool) -> Self {
        let threshold = 10.0f32.powf(threshold_db / 20.0);
        let attack_coef = 1.0 - (-1.0 / (attack_ms * 0.001 * sample_rate)).exp();
        let release_coef = 1.0 - (-1.0 / (release_ms * 0.001 * sample_rate)).exp();
        
        Self {
            threshold,
            attack_coef,
            release_coef,
            current_gain: 0.0,
            envelope: 0.0,
            enabled,
            initial_bypass_samples: (sample_rate * 10.0) as usize, // 10 seconds of room tone at start
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        if !self.enabled {
            return sample;
        }

        // --- RULE: Initial Bypass ---
        // For the first 10 seconds of recording, always let everything through.
        if self.initial_bypass_samples > 0 {
            self.initial_bypass_samples -= 1;
            // Smoothly keep/move gain to 1.0
            self.current_gain += (1.0 - self.current_gain) * self.attack_coef;
            return sample * self.current_gain;
        }

        let abs_sample = sample.abs();
        
        // Envelope follower
        if abs_sample > self.envelope {
            self.envelope = abs_sample;
        } else {
            self.envelope += (abs_sample - self.envelope) * self.release_coef;
        }

        let target_gain = if self.envelope > self.threshold { 1.0 } else { 0.0 };
        
        // Smooth the gain transition
        let coef = if target_gain > self.current_gain { self.attack_coef } else { self.release_coef };
        self.current_gain += (target_gain - self.current_gain) * coef;
        
        sample * self.current_gain
    }
}

// --- LIMITER LOGIC ---

struct Limiter {
    threshold: f32,
    release_coef: f32,
    envelope: f32,
    enabled: bool,
}

impl Limiter {
    fn new(sample_rate: f32, threshold_db: f32, release_ms: f32, enabled: bool) -> Self {
        let threshold = 10.0f32.powf(threshold_db / 20.0);
        let release_coef = (-1.0 / (release_ms * 0.001 * sample_rate)).exp();
        
        Self {
            threshold,
            release_coef,
            envelope: threshold,
            enabled,
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        if !self.enabled {
            return sample;
        }

        let abs_sample = sample.abs();
        
        if abs_sample > self.envelope {
            self.envelope = abs_sample; // Instant attack to prevent clipping
        } else {
            self.envelope = self.threshold + (self.envelope - self.threshold) * self.release_coef;
        }

        let mut gain = 1.0;
        if self.envelope > self.threshold {
            gain = self.threshold / self.envelope;
        }

        sample * gain
    }
}

// --- TAURI COMMANDS ---

#[tauri::command]
pub fn get_audio_devices() -> Result<Vec<AudioDevice>, String> {
    log_debug("get_audio_devices called");

    #[cfg(windows)]
    {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            ).ok();
        }
    }

    let mut devices = Vec::new();
    let available_hosts = cpal::available_hosts();
    log_debug(&format!("Available audio hosts: {:?}", available_hosts));

    for host_id in available_hosts {
        let host = match cpal::host_from_id(host_id) {
            Ok(h) => h,
            Err(e) => {
                log_debug(&format!("Error getting host {:?}: {}", host_id, e));
                continue;
            }
        };
        
        let host_name = match host_id {
            #[cfg(target_os = "windows")]
            cpal::HostId::Asio => "ASIO".to_string(),
            _ => {
                let name = format!("{:?}", host_id);
                if name.eq_ignore_ascii_case("wasapi") {
                    "WASAPI".to_string()
                } else {
                    name
                }
            }
        };

        log_debug(&format!("Enumerating devices for host: {}", host_name));

        if let Ok(input_devices) = host.input_devices() {
            for device in input_devices {
                if let Ok(name) = device.name() {
                    let default_config = device.default_input_config().ok();
                    let channels = default_config.as_ref().map(|c| c.channels()).unwrap_or(0);
                    let sample_rate = default_config.as_ref().map(|c| c.sample_rate().0).unwrap_or(0);

                    log_debug(&format!("  Found device: '{}', Channels: {}, SampleRate: {}", name, channels, sample_rate));

                    // Add only devices with inputs
                    if channels > 0 {
                        devices.push(AudioDevice {
                            id: name.clone(), 
                            name,
                            host: host_name.clone(),
                            default_sample_rate: sample_rate,
                            max_input_channels: channels,
                        });
                    }
                }
            }
        }
    }

    log_debug(&format!("get_audio_devices found {} devices total", devices.len()));
    Ok(devices)
}

// sync

#[tauri::command]
pub async fn start_recording(
    app_handle: AppHandle,
    state: State<'_, AudioState>,
    device_name: String,
    host_name: String,
    sample_rate: u32,
    _buffer_size: u32,
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
    limiter_enabled: bool,
    limiter_threshold: f32,
) -> Result<(), String> {
    log_debug(&format!("--- START_RECORDING INITIATED ---"));
    log_debug(&format!("Device: {}, Host: {}, SF: {}, Ch: {}, Backstage: {}, Gate: {} ({}dB), Limiter: {} ({}dB), Project: {:?}", 
        device_name, host_name, sample_rate, channel_index, backstage_record, gate_enabled, gate_threshold.unwrap_or(-45.0), limiter_enabled, limiter_threshold, project_path));

    // ... (keep system init code)
    #[cfg(windows)]
    {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            ).ok();
        }
    }

    let mut recorder = state.recorder.lock().map_err(|_| "Mutex locked".to_string())?;

    if recorder.is_recording.load(Ordering::Relaxed) {
        return Err("Recording is already in progress".to_string());
    }

    // Determine storage directory
    let storage_dir = if let Some(ref p) = project_path {
        let path = std::path::PathBuf::from(p).join("takes");
        if !path.exists() {
            let _ = std::fs::create_dir_all(&path);
        }
        path
    } else {
        std::env::temp_dir()
    };

    let epoch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    // Spawn video recording if requested
    if backstage_record {
        if let Some(ref device) = video_device {
            let video_path = storage_dir.join(format!("backstage_{}.mp4", epoch_ms));
            
            log_debug(&format!("Spawning backstage video recording: {:?}", video_path));
            
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                use windows::Win32::System::Threading::{SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS};
                use std::os::windows::io::AsRawHandle;
                use windows::Win32::Foundation::HANDLE;

                let log_path = std::env::temp_dir().join(format!("dubstudio_ffmpeg_log_{}.txt", epoch_ms));
                let stderr_file = std::fs::File::create(&log_path)
                    .unwrap_or_else(|_| std::fs::File::create("nul").unwrap());
                    
                log_debug(&format!("FFmpeg ffmpeg log file: {:?}", log_path));

                let input_str = if let Some(ref a_device) = audio_device {
                    if a_device != "none" {
                        format!("video={}:audio={}", device, a_device)
                    } else {
                        format!("video={}", device)
                    }
                } else {
                    format!("video={}", device)
                };

                let mut ffmpeg_args = vec![
                    "-f".to_string(), "dshow".to_string(),
                    "-i".to_string(), input_str,
                    "-c:v".to_string(), "libx264".to_string(),
                    "-preset".to_string(), "ultrafast".to_string(),
                    "-crf".to_string(), "28".to_string(),
                    "-pix_fmt".to_string(), "yuv420p".to_string()
                ];
                
                if let Some(ref a_device) = audio_device {
                    if a_device != "none" {
                        ffmpeg_args.push("-c:a".to_string());
                        ffmpeg_args.push("aac".to_string());
                        ffmpeg_args.push("-b:a".to_string());
                        ffmpeg_args.push("192k".to_string());
                    }
                }
                
                ffmpeg_args.push("-y".to_string());
                ffmpeg_args.push(video_path.to_str().ok_or("Invalid path")?.to_string());

                let child = std::process::Command::new("ffmpeg")
                    .args(&ffmpeg_args)
                    .stdin(std::process::Stdio::piped())
                    .stderr(stderr_file)
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .spawn();

                match child {
                    Ok(c) => {
                        unsafe {
                            let handle = HANDLE(c.as_raw_handle() as *mut std::ffi::c_void);
                            let _ = SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS);
                        }
                        recorder.video_child = Some(c);
                        recorder.current_video_path = Some(video_path);
                        log_debug("FFmpeg (video) spawned successfully with low priority");
                    }
                    Err(e) => {
                        log_debug(&format!("Failed to spawn FFmpeg (video): {}", e));
                        // We don't fail the whole recording if video fails, but we log it
                    }
                }
            }

            #[cfg(not(windows))]
            {
                // Fallback for non-windows (assuming avfoundation or v4l2)
                let mut args = vec![];
                if cfg!(target_os = "macos") {
                    args.push("-f".to_string());
                    args.push("avfoundation".to_string());
                    
                    let input_str = if let Some(ref a_device) = audio_device {
                        if a_device != "none" {
                            format!("{}:{}", device, a_device)
                        } else {
                            format!("{}:none", device)
                        }
                    } else {
                        format!("{}:none", device)
                    };
                    args.push("-i".to_string());
                    args.push(input_str);
                } else {
                    args.push("-f".to_string());
                    args.push("v4l2".to_string());
                    args.push("-i".to_string());
                    args.push(device.clone());
                    
                    if let Some(ref a_device) = audio_device {
                        if a_device != "none" {
                            args.push("-f".to_string());
                            args.push("alsa".to_string());
                            args.push("-i".to_string());
                            args.push(a_device.clone());
                        }
                    }
                };

                args.push("-c:v".to_string());
                args.push("libx264".to_string());
                args.push("-preset".to_string());
                args.push("ultrafast".to_string());
                
                if let Some(ref a_device) = audio_device {
                    if a_device != "none" {
                        args.push("-c:a".to_string());
                        args.push("aac".to_string());
                        args.push("-b:a".to_string());
                        args.push("192k".to_string());
                    }
                }
                
                args.push("-y".to_string());
                args.push(video_path.to_str().ok_or("Invalid path")?.to_string());

                let child = std::process::Command::new("ffmpeg")
                    .args(&args)
                    .stdin(std::process::Stdio::piped())
                    .spawn();

                match child {
                    Ok(c) => {
                        recorder.video_child = Some(c);
                        recorder.current_video_path = Some(video_path);
                    }
                    Err(e) => {
                        log_debug(&format!("Failed to spawn FFmpeg (video): {}", e));
                    }
                }
            }
        }
    }

    let is_recording_signal = Arc::new(AtomicBool::new(true));
    let stop_signal = Arc::clone(&is_recording_signal);

    // 1. Lock-free channel for UI telemetry (Vu Meter)
    let (tx, rx): (Sender<VuMeterPayload>, Receiver<VuMeterPayload>) = bounded(100);

    // 2. Lock-free RingBuffer for RAW Audio stream between ASIO thread and Writer Thread.
    let ringbuf = RingBuffer::<f32>::new((sample_rate * 10) as usize);
    let (mut prod, mut cons) = ringbuf.split();

    let (init_tx, init_rx) = std::sync::mpsc::channel();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel();

    // 3. Spawn Disk Writer thread
    let file_path = storage_dir.join(format!("take_{}.wav", epoch_ms));
    let path_clone = file_path.to_string_lossy().into_owned();
    log_debug(&format!("Recording file path: {}", path_clone));
    
    // Create .lock file for Crash Recovery
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let recovery_dir = app_data_dir.join("recovery");
    std::fs::create_dir_all(&recovery_dir).map_err(|e| e.to_string())?;
    
    let lock_path = recovery_dir.join(format!("rec_{}.lock", epoch_ms));
    log_debug(&format!("Recovery lock file path: {:?}", lock_path));
    let recovery_data = RecoveryData {
        file_path: path_clone.clone(),
        track_id: track_id.clone(),
        segment_id: segment_id.clone(),
        sample_rate,
        start_time,
    };
    
    let lock_content = serde_json::to_string(&recovery_data).map_err(|e| e.to_string())?;
    std::fs::write(&lock_path, lock_content).map_err(|e| e.to_string())?;

    let path_for_writer = path_clone.clone();
    let writer_handle = tokio::task::spawn_blocking(move || {
        log_debug("Disk Writer thread: Started loop");
        let spec = hound::WavSpec {
            channels: 1, // We downmix correctly to mono
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        
        let mut writer = match hound::WavWriter::create(&path_for_writer, spec) {
            Ok(w) => {
                log_debug("Disk Writer thread: WavWriter created successfully (32-bit Float)");
                w
            },
            Err(e) => {
                log_debug(&format!("Disk Writer thread: WavWriter creation ERROR: {}", e));
                return Err(e.to_string())
            }
        };
        
        let mut total_samples = 0;
        let mut last_log_samples = 0;

        let trim_limit = (sample_rate as f32 * 0.100) as usize; // 100ms end trim
        let fade_limit = (sample_rate as f32 * 0.010) as usize; // 10ms fade out
        let mut delay_buffer = std::collections::VecDeque::with_capacity(trim_limit + fade_limit + 1024);

        loop {
            let mut read_something = false;
            
            while let Some(sample) = cons.pop() {
                delay_buffer.push_back(sample);
                if delay_buffer.len() > trim_limit + fade_limit {
                    if let Some(s) = delay_buffer.pop_front() {
                        if let Err(e) = writer.write_sample(s) {
                            log_debug(&format!("Disk Writer thread: write_sample ERROR: {}", e));
                            return Err(e.to_string());
                        }
                        total_samples += 1;
                    }
                }
                read_something = true;
            }

            if total_samples - last_log_samples >= 48000 {
                log_debug(&format!("Disk Writer thread: Written {} samples so far...", total_samples));
                last_log_samples = total_samples;
            }

            if !stop_signal.load(Ordering::Relaxed) && cons.is_empty() {
                log_debug("Disk Writer thread: received stop signal and buffer is empty.");
                
                // End Trim: discard last 100ms
                let actual_data_len = delay_buffer.len().saturating_sub(trim_limit);
                delay_buffer.truncate(actual_data_len);
                
                // Fade Out: apply to last 10ms of remaining data
                let current_len = delay_buffer.len();
                if current_len > 0 {
                    let fade_count = fade_limit.min(current_len);
                    let start_fade_idx = current_len - fade_count;
                    for i in 0..fade_count {
                        let gain = (fade_count - i) as f32 / fade_count as f32;
                        if let Some(s) = delay_buffer.get_mut(start_fade_idx + i) {
                            *s *= gain;
                        }
                    }
                }

                // Flush remaining delay buffer
                while let Some(s) = delay_buffer.pop_front() {
                    if let Err(e) = writer.write_sample(s) {
                        log_debug(&format!("Disk Writer thread: final write_sample ERROR: {}", e));
                        return Err(e.to_string());
                    }
                    total_samples += 1;
                }

                break;
            }

            if !read_something {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }

        log_debug(&format!("Disk Writer thread: Finalizing WAV. Total samples: {}", total_samples));
        if let Err(e) = writer.finalize() {
            log_debug(&format!("Disk Writer thread: finalize() ERROR: {}", e));
            return Err(e.to_string());
        }
        log_debug("Disk Writer thread: WAV finalized successfully.");

        let duration = total_samples as f64 / sample_rate as f64;
        Ok(InternalRecordResult { 
            file_path: path_for_writer, 
            duration 
        })
    });

    log_debug("Spawned Disk Writer thread");

    let device_name_c = device_name.clone();
    let host_name_c = host_name.clone();

    // Trigger any implicit initializations cpal does when grabbing hosts
    let available_hosts = cpal::available_hosts();

    // Search for the specific host requested by the frontend
    let mut host_id = cpal::default_host().id();
    for id in &available_hosts {
        let id_name = match id {
            #[cfg(target_os = "windows")]
            cpal::HostId::Asio => "ASIO".to_string(),
            _ => {
                let name = format!("{:?}", id);
                if name.eq_ignore_ascii_case("wasapi") {
                    "WASAPI".to_string()
                } else {
                    name
                }
            }
        };
        if id_name.to_uppercase() == host_name_c.to_uppercase() {
            host_id = *id;
            break;
        }
    }
    
    log_debug(&format!("Selected Host ID: {:?}", host_id));
    let host = match cpal::host_from_id(host_id) {
        Ok(h) => h,
        Err(e) => { 
            log_debug(&format!("Host from ID ERROR: {}", e));
            return Err(e.to_string());
        }
    };

    log_debug("Querying input devices on Main Thread...");
    let device = match host.input_devices() {
        Ok(devices) => {
            let mut found_device = None;
            let target_cleaned = device_name_c.replace('\0', "").trim().to_lowercase();
            
            log_debug(&format!("Searching for device: '{}' (cleaned)", target_cleaned));

            // 1. Try exact (cleaned) match
            for d in host.input_devices().unwrap_or_else(|_| devices) {
                let d_name = d.name().unwrap_or_default();
                let d_name_cleaned = d_name.replace('\0', "").trim().to_lowercase();
                
                if d_name_cleaned == target_cleaned {
                    log_debug(&format!("   Found exact match: '{}'", d_name));
                    found_device = Some(d);
                    break;
                }
            }

            // 2. If 'ASIO' or 'default' or 'NULL' is requested, try host default
            if found_device.is_none() && (target_cleaned == "asio" || target_cleaned == "default" || target_cleaned.is_empty()) {
                log_debug("Requested generic device, trying host default...");
                found_device = host.default_input_device();
            }

            // 3. Fallback: Contains match
            if found_device.is_none() {
                if let Ok(devices_iter) = host.input_devices() {
                    for d in devices_iter {
                        let d_name = d.name().unwrap_or_default().to_lowercase();
                        if d_name.contains(&target_cleaned) || target_cleaned.contains(&d_name) {
                            log_debug(&format!("   Found fuzzy/contains match: '{}'", d_name));
                            found_device = Some(d);
                            break;
                        }
                    }
                }
            }

            // 4. Ultimate Fallback: Just take the first one with inputs
            if found_device.is_none() {
                log_debug("No match found. Taking the first available input device as a last resort.");
                if let Ok(mut devices_iter) = host.input_devices() {
                    found_device = devices_iter.next();
                }
            }

            match found_device {
                Some(d) => d,
                None => { 
                    log_debug("Device not found in Main Thread list (even after fallbacks)");
                    return Err("Device not found".into());
                }
            }
        },
        Err(e) => { 
            log_debug(&format!("input_devices() ERROR: {}", e));
            return Err(e.to_string());
        }
    };

    log_debug("Querying default input config on Main Thread...");
    let default_config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => { 
            log_debug(&format!("default_input_config() ERROR: {}", e));
            return Err(e.to_string());
        }
    };

    let device_channels = default_config.channels() as usize;
    let hardware_sample_rate = default_config.sample_rate().0;

    let config = StreamConfig {
        channels: default_config.channels(),
        sample_rate: cpal::SampleRate(hardware_sample_rate),
        buffer_size: BufferSize::Default, // Auto-config to prevent driver crash
    };

    let sample_format = default_config.sample_format();
    log_debug(&format!("Extracted Sample Format: {:?}", sample_format));

    log_debug(&format!("Starting ASIO/OS OS Thread for Realtime audio callbacks"));

    // 4. Start Realtime Recording on highly protected continuous OS Thread!
    std::thread::spawn(move || {
        log_debug("Inside Realtime thread: Thread Started. Building stream directly...");
        
        // Always try to initialize COM, helps with ASIO stream creation inside standard threads
        #[cfg(windows)]
        {
            log_debug("Inside Realtime thread: Running CoInitializeEx");
            unsafe {
                let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED).ok();
            }
        }

        let err_fn = |err| {
            let emsg = format!("Audio stream error: {}", err);
            eprintln!("{}", emsg);
            log_debug(&format!("CRITICAL STREAM CALLBACK ERROR: {}", emsg));
        };
        
        macro_rules! build_stream {
            ($sample_type:ty, $cast_fn:expr) => {{
                let mut channel_data = Vec::new();
                let mut lufs_meter = EbuR128::new(1, sample_rate, Mode::S).expect("Failed to init LUFS");
                
                let mut maybe_resampler = if hardware_sample_rate != sample_rate {
                    log_debug(&format!("Sample rate mismatch detected. Active resampling... (HW: {}Hz -> Project: {}Hz)", hardware_sample_rate, sample_rate));
                    let params = SincInterpolationParameters {
                        sinc_len: 128,
                        f_cutoff: 0.95,
                        interpolation: SincInterpolationType::Linear,
                        oversampling_factor: 256,
                        window: WindowFunction::BlackmanHarris2,
                    };
                    match SincFixedIn::<f32>::new(
                        sample_rate as f64 / hardware_sample_rate as f64,
                        2.0,
                        params,
                        1024,
                        1,
                    ) {
                        Ok(r) => Some(r),
                        Err(e) => {
                            log_debug(&format!("Failed to initialize resampler: {}", e));
                            return;
                        }
                    }
                } else {
                    None
                };

                let mut input_resample_buf = Vec::new();

                let mut gate = NoiseGate::new(
                    sample_rate as f32,
                    gate_threshold.unwrap_or(-45.0),
                    5.0,   // 5ms attack
                    150.0, // 150ms release
                    gate_enabled
                );
                
                let mut limiter = Limiter::new(
                    sample_rate as f32,
                    limiter_threshold,
                    150.0, // 150ms release
                    limiter_enabled
                );

                // Counters for Smart Trimming (Start Delay + Fade In)
                let mut skipped_samples = 0usize;
                let skip_limit = (sample_rate as f32 * 0.150) as usize; // 150ms start delay
                let mut fade_in_samples = 0usize;
                let fade_limit = (sample_rate as f32 * 0.010) as usize; // 10ms fade in

                device.build_input_stream(
                    &config,
                    move |data: &[$sample_type], _: &cpal::InputCallbackInfo| {
                        channel_data.clear();
                        let mut sum_squares = 0.0;
                        let mut peak = 0.0_f32;
                        let mut num_frames = 0;

                        for (i, &sample) in data.iter().enumerate() {
                            if i % device_channels == channel_index as usize {
                                let sample_f32 = $cast_fn(sample);
                                
                                let mut process_and_push = |s: f32| {
                                    let mut s = gate.process(s);
                                    s = limiter.process(s);
                                    
                                    sum_squares += s * s;
                                    let abs_sample = s.abs();
                                    if abs_sample > peak { peak = abs_sample; }
                                    
                                    // Apply Smart Trimming / Start Delay
                                    if skipped_samples < skip_limit {
                                        skipped_samples += 1;
                                    } else {
                                        let mut final_s = s;
                                        // Apply Fade In
                                        if fade_in_samples < fade_limit {
                                            let gain = fade_in_samples as f32 / fade_limit as f32;
                                            final_s *= gain;
                                            fade_in_samples += 1;
                                        }
                                        let _ = prod.push(final_s);
                                    }
                                    
                                    channel_data.push(s);
                                    num_frames += 1;
                                };

                                if let Some(ref mut resampler) = maybe_resampler {
                                    input_resample_buf.push(sample_f32);
                                    if input_resample_buf.len() >= resampler.input_frames_next() {
                                        let input_vec: Vec<Vec<f32>> = vec![input_resample_buf.drain(0..resampler.input_frames_next()).collect()];
                                        if let Ok(resampled) = resampler.process(&input_vec, None) {
                                            for &s in &resampled[0] {
                                                process_and_push(s);
                                            }
                                        }
                                    }
                                } else {
                                    process_and_push(sample_f32);
                                }
                            }
                        }

                        if num_frames > 0 {
                            let rms = (sum_squares / num_frames as f32).sqrt();
                            let _ = lufs_meter.add_frames_f32(&channel_data);
                            let loudness_lufs = lufs_meter.loudness_shortterm().unwrap_or(-70.0) as f32;
                            let _ = tx.try_send(VuMeterPayload { rms, peak, loudness_lufs });
                        }
                    },
                    err_fn,
                    None,
                )
            }};
        }

        let stream = match sample_format {
            cpal::SampleFormat::F32 => build_stream!(f32, |s: f32| s),
            cpal::SampleFormat::I16 => build_stream!(i16, |s: i16| (s as f32) / std::i16::MAX as f32),
            cpal::SampleFormat::I32 => build_stream!(i32, |s: i32| (s as f32) / std::i32::MAX as f32),
            cpal::SampleFormat::U16 => build_stream!(u16, |s: u16| ((s as f32) - 32768.0) / 32768.0),
            _ => { 
                log_debug(&format!("Inside Realtime thread: Unsupported sample format error: {:?}", sample_format));
                let _ = init_tx.send(Err(format!("Unsupported sample format: {:?}", sample_format))); return; 
            }
        };

        log_debug("Inside Realtime thread: Stream built successfully. Unwrapping... ");
        let stream = match stream {
            Ok(s) => s,
            Err(e) => { 
                log_debug(&format!("Inside Realtime thread: stream build ERROR: {}", e));
                let _ = init_tx.send(Err(e.to_string())); return; 
            }
        };

        log_debug("Inside Realtime thread: Stream play()...");
        if let Err(e) = stream.play() {
            log_debug(&format!("Inside Realtime thread: Stream play() ERROR: {}", e));
            let _ = init_tx.send(Err(e.to_string()));
            return;
        }

        log_debug("Inside Realtime thread: Realtime recording active! Alerting controller.");

        // Send Success state back to main controller
        let _ = init_tx.send(Ok(()));

        // Sleep/Block indefinitely to continuously host ASIO COM object
        let _ = stop_rx.recv();
        
        // Exiting the context drops the ASIO object on its own isolated thread
        log_debug("Inside Realtime thread: Stop Signal Received, Dropping stream!");
        drop(stream);
        log_debug("Inside Realtime thread: Stream Drop completed.");
    });

    log_debug("Waiting for init_rx response from Thread...");
    match init_rx.recv().unwrap_or_else(|_| {
        log_debug("init_rx channel died entirely! Panic inside initialization thread!");
        Err("Audio setup panicked internally".into())
    }) {
        Ok(()) => {
            log_debug("init_rx returned OK! Front-end is good.");
            // Spawn regular thread to forward events from channel to Tauri front-end
            thread::spawn(move || {
                while let Ok(payload) = rx.recv() {
                    let _ = app_handle.emit("vu-meter", payload);
                }
            });

            recorder.stop_tx = Some(stop_tx);
            recorder.writer_handle = Some(writer_handle);
            recorder.is_recording = is_recording_signal;
            recorder.current_lock_path = Some(lock_path);

            log_debug("start_recording finished successfully!");
            Ok(())
        },
        Err(e) => {
            log_debug(&format!("init_rx returned ERROR! Error: {}", e));
            Err(format!("Audio failed to start: {}", e))
        },
    }
}

#[tauri::command]
pub async fn stop_recording(state: State<'_, AudioState>) -> Result<RecordResult, String> {
    log_debug("--- STOP_RECORDING INITIATED ---");
    let writer_handle = {
        let mut recorder = state.recorder.lock().map_err(|_| "Mutex locked".to_string())?;
        
        if !recorder.is_recording.load(Ordering::Relaxed) {
            log_debug("stop_recording: Not currently recording.");
            return Err("Recording has not been started".to_string());
        }

        // Change atomic flag -> Causes writer background thread to drain loop and `.finalize()` WAV
        log_debug("stop_recording: Setting is_recording to false");
        recorder.is_recording.store(false, Ordering::Relaxed);
        
        // Alert the active audio OS thread to tear down cleanly
        log_debug("stop_recording: Dropping stop_tx");
        let _ = recorder.stop_tx.take(); 
        
        recorder.writer_handle.take()
    };

    // Ensure we block the Tauri async function UNTIL disk writing is entirely completed 
    // guaranteeing safe playback readiness format on frontend
    log_debug("stop_recording: Waiting for writer_handle to finish...");
    let internal_res = if let Some(handle) = writer_handle {
        match handle.await.map_err(|e| e.to_string())? {
            Ok(res) => {
                log_debug(&format!("stop_recording: Writer handle finished OK. File: {}, Duration: {}", res.file_path, res.duration));
                res
            },
            Err(e) => {
                log_debug(&format!("stop_recording: Writer handle finished with ERROR: {}", e));
                return Err(e);
            }
        }
    } else {
        log_debug("stop_recording: writer_handle was None!");
        return Err("Could not retrieve background writer tracking".to_string());
    };

    // Generate peaks for the recorded file
    let peaks = crate::waveform_engine::generate_waveform_peaks_internal(&internal_res.file_path, 1024)
        .unwrap_or_default();

    // Stop video recording if active
    let video_path = {
        let mut recorder = state.recorder.lock().map_err(|_| "Mutex locked".to_string())?;
        if let Some(mut child) = recorder.video_child.take() {
            log_debug("Stopping backstage video recording (ffmpeg) gracefully");
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                let _ = stdin.write_all(b"q\n");
                let _ = stdin.flush();
            }
            // Wait for ffmpeg to finish saving the file (with timeout to prevent freezing)
            let mut wait_count = 0;
            while wait_count < 50 { // 5 seconds max
                if let Ok(Some(_)) = child.try_wait() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
                wait_count += 1;
            }
            let _ = child.kill(); // Ensure it's dead after timeout
            let _ = child.wait();
        }
        recorder.current_video_path.take().map(|p| p.to_string_lossy().into_owned())
    };

    let result = RecordResult {
        file_path: internal_res.file_path,
        metadata: RecordMetadata {
            duration: internal_res.duration,
            peaks,
        },
        video_path,
    };

    // Remove lock file on success
    if let Some(lock_path) = {
        let mut recorder = state.recorder.lock().map_err(|_| "Mutex locked".to_string())?;
        recorder.current_lock_path.take()
    } {
        log_debug(&format!("stop_recording: Removing lock file: {:?}", lock_path));
        let _ = std::fs::remove_file(lock_path);
    }

    log_debug("--- STOP_RECORDING COMPLETED ---");
    Ok(result)
}

#[tauri::command]
pub async fn force_stop_all(state: State<'_, AudioState>) -> Result<(), String> {
    log_debug("--- FORCE_STOP_ALL INITIATED ---");
    let mut recorder = state.recorder.lock().map_err(|_| "Mutex locked".to_string())?;
    
    recorder.is_recording.store(false, Ordering::Relaxed);
    let _ = recorder.stop_tx.take();
    let _ = recorder.writer_handle.take();
    
    if let Some(mut child) = recorder.video_child.take() {
        let _ = child.kill();
    }
    recorder.current_video_path.take();
    recorder.current_lock_path.take();
    
    log_debug("--- FORCE_STOP_ALL COMPLETED ---");
    Ok(())
}

#[tauri::command]
pub async fn check_crashes(app_handle: AppHandle) -> Result<Vec<RecoveryData>, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let recovery_dir = app_data_dir.join("recovery");
    
    if !recovery_dir.exists() {
        return Ok(Vec::new());
    }

    let mut recovered = Vec::new();
    let entries = std::fs::read_dir(recovery_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        
        if path.extension().and_then(|s| s.to_str()) == Some("lock") {
            let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let data: RecoveryData = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            
            let wav_path = std::path::Path::new(&data.file_path);
            if wav_path.exists() {
                // Fix headers
                if let Err(e) = fix_wav_header(wav_path) {
                    eprintln!("Failed to fix WAV header for {:?}: {}", wav_path, e);
                } else {
                    recovered.push(data);
                }
            }
            
            // Delete lock file after processing
            let _ = std::fs::remove_file(path);
        }
    }

    Ok(recovered)
}

fn fix_wav_header(path: &std::path::Path) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;

    let file_size = file.metadata().map_err(|e| e.to_string())?.len();
    if file_size < 44 {
        return Err("File too small to be a WAV".to_string());
    }

    let chunk_size = (file_size - 8) as u32;
    let data_size = (file_size - 44) as u32;

    // Update ChunkSize at offset 4
    file.seek(SeekFrom::Start(4)).map_err(|e| e.to_string())?;
    file.write_all(&chunk_size.to_le_bytes()).map_err(|e| e.to_string())?;

    // Update DataSize at offset 40
    file.seek(SeekFrom::Start(40)).map_err(|e| e.to_string())?;
    file.write_all(&data_size.to_le_bytes()).map_err(|e| e.to_string())?;

    Ok(())
}

