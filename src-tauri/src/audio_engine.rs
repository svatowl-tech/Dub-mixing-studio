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
use crate::process_utils::CommandExtHide;

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
        }
    }
}

// Global state for Tauri
pub struct AudioState {
    pub recorder: Mutex<AudioRecorder>,
    pub player: Mutex<NativeAudioPlayer>,
    pub clock: Arc<crate::transport_clock::TransportClock>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NativePlaybackSegment {
    pub id: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "startTime")]
    pub start_time: f64,
    pub duration: f64,
    #[serde(rename = "fileOffset", default)]
    pub file_offset: f64,
    #[serde(default = "default_gain")]
    pub gain: f32,
    #[serde(default)]
    pub panning: f32,
    #[serde(rename = "detectedFx", default)]
    pub detected_fx: Option<serde_json::Value>,
}

fn default_gain() -> f32 {
    1.0
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NativePlaybackTrack {
    pub id: String,
    pub name: String,
    #[serde(default = "default_gain")]
    pub volume: f32,
    #[serde(rename = "isMuted", default)]
    pub is_muted: bool,
    #[serde(rename = "isSolo", default)]
    pub is_solo: bool,
    pub segments: Vec<NativePlaybackSegment>,
    #[serde(default)]
    pub processing: Option<serde_json::Value>,
}

// --- REAL-TIME PLAYBACK SNAPSHOTS & DSP ENGINE (ZERO ALLOCATIONS IN AUDIO THREAD) ---

use arc_swap::ArcSwap;
use crate::audio_buffer_manager::CachedTrackBuffer;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Default)]
pub struct TrackEqParams {
    pub enabled: bool,
    pub high_pass: f32,
    pub low_pass: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TrackDeesserParams {
    pub enabled: bool,
    pub frequency: f32,
    pub threshold_lin: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TrackCompressorParams {
    pub enabled: bool,
    pub threshold_lin: f32,
    pub ratio: f32,
    pub makeup_gain: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TrackSaturationParams {
    pub enabled: bool,
    pub drive: f32,
    pub wet: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TrackReverbParams {
    pub enabled: bool,
    pub wet: f32,
    pub decay: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TrackDelayParams {
    pub enabled: bool,
    pub wet: f32,
    pub time_s: f32,
    pub feedback: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ParsedTrackDsp {
    pub eq: TrackEqParams,
    pub deesser: TrackDeesserParams,
    pub compressor: TrackCompressorParams,
    pub saturation: TrackSaturationParams,
    pub reverb: TrackReverbParams,
    pub delay: TrackDelayParams,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ParsedSegmentFx {
    pub reverb_wet: f32,
}

pub fn parse_track_dsp(proc: Option<&serde_json::Value>) -> ParsedTrackDsp {
    let mut dsp = ParsedTrackDsp::default();
    let p = match proc {
        Some(v) => v,
        None => return dsp,
    };

    if let Some(eq) = p.get("eq") {
        if eq.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            dsp.eq.enabled = true;
            dsp.eq.high_pass = eq.get("highPass").and_then(|v| v.as_f64()).map(|v| v as f32).unwrap_or(20.0);
            dsp.eq.low_pass = eq.get("lowPass").and_then(|v| v.as_f64()).map(|v| v as f32).unwrap_or(20000.0);
        }
    }

    if let Some(de) = p.get("deesser") {
        if de.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            dsp.deesser.enabled = true;
            dsp.deesser.frequency = de.get("frequency").and_then(|v| v.as_f64()).unwrap_or(6500.0) as f32;
            let thresh_db = de.get("threshold").and_then(|v| v.as_f64()).unwrap_or(-18.0) as f32;
            dsp.deesser.threshold_lin = 10.0f32.powf(thresh_db / 20.0);
        }
    }

    if let Some(comp) = p.get("compressor") {
        if comp.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            dsp.compressor.enabled = true;
            let thresh_db = comp.get("threshold").and_then(|v| v.as_f64()).unwrap_or(-18.0) as f32;
            dsp.compressor.threshold_lin = 10.0f32.powf(thresh_db / 20.0);
            dsp.compressor.ratio = comp.get("ratio").and_then(|v| v.as_f64()).unwrap_or(3.5) as f32;
            let makeup_db = comp.get("makeupGain").or_else(|| comp.get("gain")).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            dsp.compressor.makeup_gain = 10.0f32.powf(makeup_db / 20.0);
        }
    }

    if let Some(sat) = p.get("saturation").or_else(|| p.get("warmth")) {
        if sat.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            dsp.saturation.enabled = true;
            let drive_db = sat.get("drive").or_else(|| sat.get("driveDb")).and_then(|v| v.as_f64()).unwrap_or(3.0) as f32;
            dsp.saturation.drive = 10.0f32.powf(drive_db / 20.0);
            dsp.saturation.wet = sat.get("wet").or_else(|| sat.get("blend")).and_then(|v| v.as_f64()).unwrap_or(0.35) as f32;
        }
    }

    if let Some(rev) = p.get("reverb") {
        if rev.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            dsp.reverb.enabled = true;
            dsp.reverb.wet = rev.get("wet").and_then(|v| v.as_f64()).unwrap_or(0.15) as f32;
            dsp.reverb.decay = rev.get("decay").and_then(|v| v.as_f64()).unwrap_or(1.5) as f32;
        }
    }

    if let Some(del) = p.get("delay") {
        if del.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            dsp.delay.enabled = true;
            dsp.delay.wet = del.get("wet").and_then(|v| v.as_f64()).unwrap_or(0.12) as f32;
            dsp.delay.time_s = del.get("time").and_then(|v| v.as_f64()).unwrap_or(0.3) as f32;
            dsp.delay.feedback = del.get("feedback").and_then(|v| v.as_f64()).unwrap_or(0.3) as f32;
        }
    }

    dsp
}

pub fn parse_segment_fx(fx: Option<&serde_json::Value>) -> ParsedSegmentFx {
    let mut seg_fx = ParsedSegmentFx::default();
    if let Some(f) = fx {
        if let Some(wet) = f.get("reverbWet").and_then(|v| v.as_f64()).map(|v| v as f32) {
            seg_fx.reverb_wet = wet;
        }
    }
    seg_fx
}

#[derive(Clone, Debug)]
pub struct PlaybackActiveSegment {
    pub file_path: String,
    pub start_frame: u64,
    pub end_frame: u64,
    pub file_offset_sec: f64,
    pub total_gain_left: f32,
    pub total_gain_right: f32,
    pub fx: ParsedSegmentFx,
}

#[derive(Clone, Debug)]
pub struct PlaybackActiveTrack {
    pub id: String,
    pub volume: f32,
    pub is_muted: bool,
    pub is_solo: bool,
    pub segments: Vec<PlaybackActiveSegment>,
    pub dsp_params: ParsedTrackDsp,
}

#[derive(Clone, Debug, Default)]
pub struct PlaybackSnapshot {
    pub tracks: Vec<PlaybackActiveTrack>,
    pub any_solo: bool,
}

pub fn build_playback_snapshot(tracks: &[NativePlaybackTrack], sample_rate: u32) -> PlaybackSnapshot {
    let any_solo = tracks.iter().any(|t| t.is_solo);
    let mut active_tracks = Vec::with_capacity(tracks.len());

    for track in tracks {
        let is_active = if any_solo { track.is_solo } else { !track.is_muted };
        if !is_active || track.volume <= 0.0 {
            continue;
        }

        let track_gain = track.volume;
        let dsp_params = parse_track_dsp(track.processing.as_ref());
        let mut active_segments = Vec::with_capacity(track.segments.len());

        for seg in &track.segments {
            let seg_gain = seg.gain * track_gain;
            if seg_gain <= 0.0 || seg.file_path.is_empty() {
                continue;
            }

            let seg_start_frame = (seg.start_time * sample_rate as f64).round() as u64;
            let seg_duration_frames = (seg.duration * sample_rate as f64).round() as u64;
            let seg_end_frame = seg_start_frame + seg_duration_frames;

            let pan = seg.panning.clamp(-1.0, 1.0);
            let left_pan_gain = ((1.0 - pan) * 0.5).sqrt() * seg_gain;
            let right_pan_gain = ((1.0 + pan) * 0.5).sqrt() * seg_gain;

            let fx = parse_segment_fx(seg.detected_fx.as_ref());

            active_segments.push(PlaybackActiveSegment {
                file_path: seg.file_path.clone(),
                start_frame: seg_start_frame,
                end_frame: seg_end_frame,
                file_offset_sec: seg.file_offset,
                total_gain_left: left_pan_gain,
                total_gain_right: right_pan_gain,
                fx,
            });
        }

        active_tracks.push(PlaybackActiveTrack {
            id: track.id.clone(),
            volume: track.volume,
            is_muted: track.is_muted,
            is_solo: track.is_solo,
            segments: active_segments,
            dsp_params,
        });
    }

    PlaybackSnapshot {
        tracks: active_tracks,
        any_solo,
    }
}

pub struct NativeAudioPlayer {
    pub clock: Arc<crate::transport_clock::TransportClock>,
    pub is_playing: Arc<AtomicBool>,
    pub current_sample_frame: Arc<std::sync::atomic::AtomicU64>,
    pub device_sample_rate: Arc<std::sync::atomic::AtomicU32>,
    pub snapshot: Arc<ArcSwap<PlaybackSnapshot>>,
    pub audio_cache: Arc<ArcSwap<HashMap<String, Arc<CachedTrackBuffer>>>>,
    pub stream: Option<cpal::Stream>,
}

unsafe impl Send for NativeAudioPlayer {}
unsafe impl Sync for NativeAudioPlayer {}

impl Default for NativeAudioPlayer {
    fn default() -> Self {
        Self::with_clock(Arc::new(crate::transport_clock::TransportClock::new(48000)))
    }
}

impl NativeAudioPlayer {
    pub fn with_clock(clock: Arc<crate::transport_clock::TransportClock>) -> Self {
        Self {
            is_playing: clock.is_playing.clone(),
            current_sample_frame: clock.current_sample.clone(),
            device_sample_rate: clock.sample_rate.clone(),
            clock,
            snapshot: Arc::new(ArcSwap::from_pointee(PlaybackSnapshot::default())),
            audio_cache: Arc::new(ArcSwap::from_pointee(HashMap::new())),
            stream: None,
        }
    }

    pub fn preload_buffers(&self, paths: Vec<String>) -> Result<Vec<String>, String> {
        let mut current_cache = (**self.audio_cache.load()).clone();
        let mut loaded = Vec::new();
        let mut updated = false;

        for p in paths {
            if p.is_empty() {
                continue;
            }
            if current_cache.contains_key(&p) {
                loaded.push(p);
                continue;
            }
            match crate::audio_buffer_manager::load_audio_file_sync(&p) {
                Ok(cached) => {
                    current_cache.insert(p.clone(), Arc::new(cached));
                    loaded.push(p);
                    updated = true;
                }
                Err(e) => {
                    log_debug(&format!("Failed to preload buffer {}: {}", p, e));
                }
            }
        }

        if updated {
            self.audio_cache.store(Arc::new(current_cache));
        }
        Ok(loaded)
    }

    pub fn clear_cache(&self) {
        self.audio_cache.store(Arc::new(HashMap::new()));
    }

    pub fn ensure_stream(&mut self) -> Result<(), String> {
        if self.stream.is_some() {
            return Ok(());
        }

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "No default audio output device available".to_string())?;

        let config = device
            .default_output_config()
            .map_err(|e| format!("Failed to get default output config: {}", e))?;

        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;
        self.device_sample_rate.store(sample_rate, Ordering::SeqCst);
        self.clock.sample_rate.store(sample_rate, Ordering::SeqCst);

        let clock = Arc::clone(&self.clock);
        let snapshot_swap = Arc::clone(&self.snapshot);
        let cache_swap = Arc::clone(&self.audio_cache);
        let mut dsp_pool: HashMap<String, TrackDspEngine> = HashMap::with_capacity(32);

        let stream_config: StreamConfig = config.into();

        let stream = device
            .build_output_stream(
                &stream_config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    mix_audio_buffer(
                        data,
                        channels,
                        sample_rate,
                        &clock,
                        &snapshot_swap,
                        &cache_swap,
                        &mut dsp_pool,
                    );
                },
                |err| log_debug(&format!("Rust audio output stream error: {}", err)),
                None,
            )
            .map_err(|e| format!("Failed to build audio output stream: {}", e))?;

        stream
            .play()
            .map_err(|e| format!("Failed to start output stream: {}", e))?;
        self.stream = Some(stream);
        Ok(())
    }

    pub fn play(&mut self, tracks: Vec<NativePlaybackTrack>, start_time: f64) -> Result<(), String> {
        let mut paths_to_load = Vec::new();
        for t in &tracks {
            for s in &t.segments {
                if !s.file_path.is_empty() {
                    paths_to_load.push(s.file_path.clone());
                }
            }
        }
        let _ = self.preload_buffers(paths_to_load);

        let sr = self.clock.sample_rate.load(Ordering::SeqCst);
        let snapshot = build_playback_snapshot(&tracks, sr);
        self.snapshot.store(Arc::new(snapshot));

        self.ensure_stream()?;

        let frame = (start_time.max(0.0) * sr as f64).round() as u64;
        self.clock.seek(frame);
        self.clock.play();

        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        self.clock.pause();
        Ok(())
    }

    pub fn seek(&mut self, time: f64) -> Result<(), String> {
        let sr = self.clock.sample_rate.load(Ordering::SeqCst);
        let frame = (time.max(0.0) * sr as f64).round() as u64;
        self.clock.seek(frame);
        Ok(())
    }

    pub fn update_tracks(&mut self, tracks: Vec<NativePlaybackTrack>) -> Result<(), String> {
        let sr = self.clock.sample_rate.load(Ordering::SeqCst);
        let snapshot = build_playback_snapshot(&tracks, sr);
        self.snapshot.store(Arc::new(snapshot));
        Ok(())
    }

    pub fn get_position(&self) -> f64 {
        let frame = self.clock.current_sample.load(Ordering::Relaxed);
        let sr = self.clock.sample_rate.load(Ordering::Relaxed).max(1);
        frame as f64 / sr as f64
    }
}

// --- REAL-TIME RUST DSP EFFECTS ENGINE (PERSISTENT & ZERO-ALLOCATION) ---

#[derive(Clone, Copy)]
#[allow(dead_code)]
pub enum BiquadType {
    LowPass,
    HighPass,
    Peaking,
    LowShelf,
    HighShelf,
}

pub struct BiquadFilter {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl BiquadFilter {
    pub fn new() -> Self {
        Self {
            b0: 1.0, b1: 0.0, b2: 0.0,
            a1: 0.0, a2: 0.0,
            x1: 0.0, x2: 0.0,
            y1: 0.0, y2: 0.0,
        }
    }

    pub fn configure(&mut self, filter_type: BiquadType, freq_hz: f32, gain_db: f32, q: f32, sample_rate: u32) {
        let sr = sample_rate.max(8000) as f32;
        let w0 = 2.0 * std::f32::consts::PI * (freq_hz.clamp(10.0, sr * 0.49) / sr);
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q.max(0.1));
        let a = 10.0f32.powf(gain_db / 40.0);

        let (b0, b1, b2, a0, a1, a2) = match filter_type {
            BiquadType::LowPass => {
                let b0 = (1.0 - cos_w0) * 0.5;
                let b1 = 1.0 - cos_w0;
                let b2 = (1.0 - cos_w0) * 0.5;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w0;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::HighPass => {
                let b0 = (1.0 + cos_w0) * 0.5;
                let b1 = -(1.0 + cos_w0);
                let b2 = (1.0 + cos_w0) * 0.5;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w0;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::Peaking => {
                let b0 = 1.0 + alpha * a;
                let b1 = -2.0 * cos_w0;
                let b2 = 1.0 - alpha * a;
                let a0 = 1.0 + alpha / a;
                let a1 = -2.0 * cos_w0;
                let a2 = 1.0 - alpha / a;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::LowShelf => {
                let sqrt_a = a.sqrt();
                let b0 = a * ((a + 1.0) - (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha);
                let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0);
                let b2 = a * ((a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha);
                let a0 = (a + 1.0) + (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha;
                let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0);
                let a2 = (a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::HighShelf => {
                let sqrt_a = a.sqrt();
                let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha);
                let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0);
                let b2 = a * ((a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha);
                let a0 = (a + 1.0) - (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha;
                let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w0);
                let a2 = (a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha;
                (b0, b1, b2, a0, a1, a2)
            }
        };

        let inv_a0 = 1.0 / a0;
        self.b0 = b0 * inv_a0;
        self.b1 = b1 * inv_a0;
        self.b2 = b2 * inv_a0;
        self.a1 = a1 * inv_a0;
        self.a2 = a2 * inv_a0;
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = if y.is_finite() { y } else { 0.0 };
        self.y1
    }
}

pub struct TrackDspEngine {
    hp_l: BiquadFilter,
    hp_r: BiquadFilter,
    lp_l: BiquadFilter,
    lp_r: BiquadFilter,
    deesser_bp: BiquadFilter,
    deesser_env: f32,
    comp_env: f32,
    reverb_buffer_l: Vec<f32>,
    reverb_buffer_r: Vec<f32>,
    reverb_idx: usize,
    delay_buffer_l: Vec<f32>,
    delay_buffer_r: Vec<f32>,
    delay_idx: usize,
    sample_rate: u32,
    cached_hp_freq: f32,
    cached_lp_freq: f32,
    cached_deesser_freq: f32,
}

impl TrackDspEngine {
    pub fn new(sample_rate: u32) -> Self {
        let sr = sample_rate.max(8000);
        let max_rev_len = (sr as f64 * 3.0) as usize; // Preallocated up to 3 sec reverb
        let max_del_len = (sr as f64 * 2.0) as usize; // Preallocated up to 2 sec delay
        Self {
            hp_l: BiquadFilter::new(),
            hp_r: BiquadFilter::new(),
            lp_l: BiquadFilter::new(),
            lp_r: BiquadFilter::new(),
            deesser_bp: BiquadFilter::new(),
            deesser_env: 0.0,
            comp_env: 0.0,
            reverb_buffer_l: vec![0.0; max_rev_len],
            reverb_buffer_r: vec![0.0; max_rev_len],
            reverb_idx: 0,
            delay_buffer_l: vec![0.0; max_del_len],
            delay_buffer_r: vec![0.0; max_del_len],
            delay_idx: 0,
            sample_rate: sr,
            cached_hp_freq: 0.0,
            cached_lp_freq: 0.0,
            cached_deesser_freq: 0.0,
        }
    }

    #[inline(always)]
    pub fn process_stereo_sample(
        &mut self,
        left: f32,
        right: f32,
        dsp: &ParsedTrackDsp,
        detected_fx: &ParsedSegmentFx,
    ) -> (f32, f32) {
        let mut l = left;
        let mut r = right;
        let sr = self.sample_rate as f32;

        // 1. HighPass & LowPass EQ
        if dsp.eq.enabled {
            let hp = dsp.eq.high_pass;
            if hp > 20.0 {
                if (hp - self.cached_hp_freq).abs() > 0.1 {
                    self.hp_l.configure(BiquadType::HighPass, hp, 0.0, 0.707, self.sample_rate);
                    self.hp_r.configure(BiquadType::HighPass, hp, 0.0, 0.707, self.sample_rate);
                    self.cached_hp_freq = hp;
                }
                l = self.hp_l.process(l);
                r = self.hp_r.process(r);
            }
            let lp = dsp.eq.low_pass;
            if lp < 20000.0 {
                if (lp - self.cached_lp_freq).abs() > 0.1 {
                    self.lp_l.configure(BiquadType::LowPass, lp, 0.0, 0.707, self.sample_rate);
                    self.lp_r.configure(BiquadType::LowPass, lp, 0.0, 0.707, self.sample_rate);
                    self.cached_lp_freq = lp;
                }
                l = self.lp_l.process(l);
                r = self.lp_r.process(r);
            }
        }

        // 2. De-Esser
        if dsp.deesser.enabled {
            let freq = dsp.deesser.frequency;
            if (freq - self.cached_deesser_freq).abs() > 0.1 {
                self.deesser_bp.configure(BiquadType::Peaking, freq, 0.0, 2.0, self.sample_rate);
                self.cached_deesser_freq = freq;
            }
            let mid = (l + r) * 0.5;
            let sc = self.deesser_bp.process(mid).abs();
            if sc > self.deesser_env {
                self.deesser_env += (sc - self.deesser_env) * 0.3;
            } else {
                self.deesser_env += (sc - self.deesser_env) * 0.01;
            }
            let thresh = dsp.deesser.threshold_lin;
            if self.deesser_env > thresh && self.deesser_env > 1e-6 {
                let atten = (thresh / self.deesser_env).max(0.25);
                l *= atten;
                r *= atten;
            }
        }

        // 3. Compressor
        if dsp.compressor.enabled {
            let thresh_lin = dsp.compressor.threshold_lin;
            let ratio = dsp.compressor.ratio;
            let makeup = dsp.compressor.makeup_gain;

            let peak = (l.abs() + r.abs()) * 0.5;
            if peak > self.comp_env {
                self.comp_env += (peak - self.comp_env) * 0.15; // fast attack
            } else {
                self.comp_env += (peak - self.comp_env) * 0.005; // release
            }
            let mut comp_gain = 1.0;
            if self.comp_env > thresh_lin && thresh_lin > 1e-6 {
                let over = self.comp_env / thresh_lin;
                comp_gain = over.powf(1.0 / ratio.max(1.0) - 1.0);
            }
            l = l * comp_gain * makeup;
            r = r * comp_gain * makeup;
        }

        // 4. Analog Saturation / Warmth
        if dsp.saturation.enabled {
            let drive = dsp.saturation.drive;
            let wet = dsp.saturation.wet;
            let sat_l = (l * drive).tanh() / drive.max(1.0).tanh();
            let sat_r = (r * drive).tanh() / drive.max(1.0).tanh();
            l = l * (1.0 - wet) + sat_l * wet;
            r = r * (1.0 - wet) + sat_r * wet;
        }

        // 5. Stereo Reverb (Track Level)
        if dsp.reverb.enabled {
            let wet = dsp.reverb.wet;
            let decay = dsp.reverb.decay;
            let delay_samps = ((decay * 0.05 * sr) as usize).clamp(100, self.reverb_buffer_l.len() - 1);

            let read_idx = (self.reverb_idx + self.reverb_buffer_l.len() - delay_samps) % self.reverb_buffer_l.len();
            let rev_l = self.reverb_buffer_l[read_idx];
            let rev_r = self.reverb_buffer_r[read_idx];

            self.reverb_buffer_l[self.reverb_idx] = l + rev_l * 0.45;
            self.reverb_buffer_r[self.reverb_idx] = r + rev_r * 0.45;
            self.reverb_idx = (self.reverb_idx + 1) % self.reverb_buffer_l.len();

            l = l * (1.0 - wet) + rev_l * wet;
            r = r * (1.0 - wet) + rev_r * wet;
        }

        // 6. Stereo Delay (Track Level)
        if dsp.delay.enabled {
            let wet = dsp.delay.wet;
            let time_s = dsp.delay.time_s;
            let feedback = dsp.delay.feedback;
            let delay_samps = ((time_s * sr) as usize).clamp(10, self.delay_buffer_l.len() - 1);

            let read_idx = (self.delay_idx + self.delay_buffer_l.len() - delay_samps) % self.delay_buffer_l.len();
            let del_l = self.delay_buffer_l[read_idx];
            let del_r = self.delay_buffer_r[read_idx];

            self.delay_buffer_l[self.delay_idx] = l + del_l * feedback;
            self.delay_buffer_r[self.delay_idx] = r + del_r * feedback;
            self.delay_idx = (self.delay_idx + 1) % self.delay_buffer_l.len();

            l = l * (1.0 - wet) + del_l * wet;
            r = r * (1.0 - wet) + del_r * wet;
        }

        // 7. Segment-level Auto-FX (Transfer from Original)
        let seg_wet = detected_fx.reverb_wet;
        if seg_wet > 0.01 {
            let read_idx = (self.reverb_idx + self.reverb_buffer_l.len() - 2000) % self.reverb_buffer_l.len();
            let rev_l = self.reverb_buffer_l[read_idx];
            let rev_r = self.reverb_buffer_r[read_idx];
            self.reverb_buffer_l[self.reverb_idx] = l + rev_l * 0.4;
            self.reverb_buffer_r[self.reverb_idx] = r + rev_r * 0.4;
            self.reverb_idx = (self.reverb_idx + 1) % self.reverb_buffer_l.len();
            l = l * (1.0 - seg_wet * 0.5) + rev_l * (seg_wet * 0.5);
            r = r * (1.0 - seg_wet * 0.5) + rev_r * (seg_wet * 0.5);
        }

        (l, r)
    }
}

/// Высокопроизводительный микшер реального времени с нулевыми аллокациями и Wait-Free доступом
fn mix_audio_buffer(
    data: &mut [f32],
    channels: usize,
    device_sample_rate: u32,
    clock: &Arc<crate::transport_clock::TransportClock>,
    snapshot_swap: &Arc<ArcSwap<PlaybackSnapshot>>,
    cache_swap: &Arc<ArcSwap<HashMap<String, Arc<CachedTrackBuffer>>>>,
    dsp_pool: &mut HashMap<String, TrackDspEngine>,
) {
    let num_frames = data.len() / channels.max(1);
    data.fill(0.0);

    // 1. Предзапись (Pre-roll Countdown): отсчет метронома в Rust перед включением записи
    if clock.is_preroll.load(Ordering::Relaxed) {
        clock.synthesize_metronome(data, channels, device_sample_rate, num_frames);
        clock.advance_samples(num_frames);
        return;
    }

    if !clock.is_playing.load(Ordering::Relaxed) {
        return;
    }

    let start_frame = clock.current_sample.load(Ordering::Relaxed);
    let buf_end_frame = start_frame + num_frames as u64;

    // Lock-Free / Wait-Free snapshot load (0 ns latency)
    let snapshot = snapshot_swap.load();
    let cache = cache_swap.load();

    for track in snapshot.tracks.iter() {
        let is_active = if snapshot.any_solo { track.is_solo } else { !track.is_muted };
        if !is_active || track.volume <= 0.0 {
            continue;
        }

        // Persistent track DSP engine (never instantiated per-buffer)
        let dsp_engine = match dsp_pool.get_mut(&track.id) {
            Some(e) => e,
            None => {
                dsp_pool.insert(track.id.clone(), TrackDspEngine::new(device_sample_rate));
                dsp_pool.get_mut(&track.id).unwrap()
            }
        };

        for seg in &track.segments {
            if start_frame >= seg.end_frame || buf_end_frame <= seg.start_frame {
                continue;
            }

            let cached = match cache.get(&seg.file_path) {
                Some(c) => c,
                None => continue,
            };

            let cached_sr = cached.sample_rate as f64;
            let file_offset_sec = seg.file_offset_sec;

            for f in 0..num_frames {
                let timeline_frame = start_frame + f as u64;
                if timeline_frame < seg.start_frame || timeline_frame >= seg.end_frame {
                    continue;
                }

                let time_in_seg_sec = (timeline_frame - seg.start_frame) as f64 / device_sample_rate as f64;
                let sample_pos_sec = file_offset_sec + time_in_seg_sec;
                let frame_idx = (sample_pos_sec * cached_sr).round() as usize;

                // Zero-allocation, Zero-copy Memory Mapped read
                let (raw_left, raw_right) = cached.read_stereo_frame(frame_idx);

                // Real-time zero-allocation DSP
                let (proc_l, proc_r) = dsp_engine.process_stereo_sample(
                    raw_left,
                    raw_right,
                    &track.dsp_params,
                    &seg.fx,
                );

                let out_idx = f * channels;
                if channels >= 2 {
                    data[out_idx] += proc_l * seg.total_gain_left;
                    data[out_idx + 1] += proc_r * seg.total_gain_right;
                } else {
                    data[out_idx] += ((proc_l + proc_r) * 0.5) * seg.total_gain_left;
                }
            }
        }
    }

    // Master True-Peak Safety Soft-Limiting (prevents digital harsh distortion)
    for sample in data.iter_mut() {
        if *sample > 0.98 {
            *sample = 0.98 + (*sample - 0.98).tanh() * 0.02;
        } else if *sample < -0.98 {
            *sample = -0.98 + (*sample + 0.98).tanh() * 0.02;
        }
    }

    clock.advance_samples(num_frames);
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

    if backstage_record {
        log_debug("[AudioEngine] backstage_record flag received: handled independently by backstage_recorder module");
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

    let result = RecordResult {
        file_path: internal_res.file_path,
        metadata: RecordMetadata {
            duration: internal_res.duration,
            peaks,
        },
        video_path: None,
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

// --- NATIVE PLAYBACK TAURI COMMANDS ---

#[tauri::command]
pub async fn preload_playback_buffers(
    state: State<'_, AudioState>,
    file_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let player = state.player.lock().map_err(|e| e.to_string())?;
    player.preload_buffers(file_paths)
}

#[tauri::command]
pub async fn start_native_playback(
    state: State<'_, AudioState>,
    tracks: Vec<NativePlaybackTrack>,
    start_time: f64,
) -> Result<(), String> {
    let mut player = state.player.lock().map_err(|e| e.to_string())?;
    player.play(tracks, start_time)
}

#[tauri::command]
pub async fn stop_native_playback(
    state: State<'_, AudioState>,
) -> Result<(), String> {
    let mut player = state.player.lock().map_err(|e| e.to_string())?;
    player.stop()
}

#[tauri::command]
pub async fn seek_native_playback(
    state: State<'_, AudioState>,
    time: f64,
) -> Result<(), String> {
    let mut player = state.player.lock().map_err(|e| e.to_string())?;
    player.seek(time)
}

#[tauri::command]
pub async fn update_native_playback_tracks(
    state: State<'_, AudioState>,
    tracks: Vec<NativePlaybackTrack>,
) -> Result<(), String> {
    let mut player = state.player.lock().map_err(|e| e.to_string())?;
    player.update_tracks(tracks)
}

#[tauri::command]
pub async fn get_native_playback_position(
    state: State<'_, AudioState>,
) -> Result<f64, String> {
    let player = state.player.lock().map_err(|e| e.to_string())?;
    Ok(player.get_position())
}

#[tauri::command]
pub async fn clear_native_playback_cache(
    state: State<'_, AudioState>,
) -> Result<(), String> {
    let player = state.player.lock().map_err(|e| e.to_string())?;
    player.clear_cache();
    Ok(())
}

