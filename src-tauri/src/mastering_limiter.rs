use std::path::Path;
use std::fmt;
use std::error::Error;
use serde::{Deserialize, Serialize};
use hound::{WavReader, WavWriter, WavSpec, SampleFormat};
use ebur128::{EbuR128, Mode};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction
};

/// Mastering broadcast & streaming standards supported by the engine
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MasteringStandard {
    /// YouTube / Spotify / Tidal / Apple Music / Web Streaming: -14.0 LUFS (±0.5), True-Peak -1.0 dBTP
    YoutubeWeb,
    /// EBU R128 (European Broadcast Union / TV / Radio): -23.0 LUFS (±0.5), True-Peak -1.0 dBTP
    EbuR128,
    /// Film / Movie reference matching: dynamically match the integrated LUFS of the original reference track
    OriginalMatch,
    /// Relative Dub Balance: Dub sits +3.5 to +4.5 dB above the original reference track for optimal speech clarity
    OriginalRelative,
    /// Custom target loudness and ceiling
    Custom,
}

impl Default for MasteringStandard {
    fn default() -> Self {
        MasteringStandard::OriginalRelative
    }
}

impl MasteringStandard {
    pub fn target_lufs(&self) -> f64 {
        match self {
            MasteringStandard::YoutubeWeb => -14.0,
            MasteringStandard::EbuR128 => -23.0,
            MasteringStandard::OriginalMatch => -14.0, // fallback if reference is absent
            MasteringStandard::OriginalRelative => -10.5, // fallback if reference is absent (-14.5 + 4.0)
            MasteringStandard::Custom => -14.0,
        }
    }

    pub fn true_peak_ceiling_db(&self) -> f64 {
        match self {
            MasteringStandard::YoutubeWeb => -1.0,
            MasteringStandard::EbuR128 => -1.0,
            MasteringStandard::OriginalMatch => -1.0,
            MasteringStandard::OriginalRelative => -1.0,
            MasteringStandard::Custom => -1.0,
        }
    }
}

/// Dithering type applied before final quantization
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DitherType {
    None,
    Tpdf16Bit,
    Tpdf24Bit,
}

impl Default for DitherType {
    fn default() -> Self {
        DitherType::Tpdf24Bit
    }
}

/// Comprehensive mastering configuration parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasteringLimiterConfig {
    pub standard: MasteringStandard,
    pub target_lufs: Option<f64>,
    pub true_peak_ceiling_db: Option<f64>,
    pub lookahead_ms: Option<f64>,
    pub release_ms: Option<f64>,
    pub oversampling_factor: Option<u32>, // 1, 2, 4 (default 4x)
    pub dither: Option<DitherType>,
    pub reference_audio_path: Option<String>,
    pub relative_gain_db: Option<f64>, // e.g. +4.0 dB relative to original reference track (3.5 - 4.5 dB standard)
}

impl Default for MasteringLimiterConfig {
    fn default() -> Self {
        Self {
            standard: MasteringStandard::OriginalRelative,
            target_lufs: None,
            true_peak_ceiling_db: Some(-1.0),
            lookahead_ms: Some(5.0),
            release_ms: Some(50.0),
            oversampling_factor: Some(4),
            dither: Some(DitherType::Tpdf24Bit),
            reference_audio_path: None,
            relative_gain_db: Some(4.0),
        }
    }
}

/// Telemetry and audit metrics generated after mastering
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasteringStats {
    pub standard_applied: String,
    pub initial_integrated_lufs: f64,
    pub initial_true_peak_dbtp: f64,
    pub initial_loudness_range_lu: f64,
    pub target_integrated_lufs: f64,
    pub final_integrated_lufs: f64,
    pub final_true_peak_dbtp: f64,
    pub final_loudness_range_lu: f64,
    pub true_peak_ceiling_dbtp: f64,
    pub normalization_gain_applied_db: f64,
    pub max_gain_reduction_db: f64,
    pub total_limited_events: usize,
    pub is_compliant: bool,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_sec: f64,
    pub reference_track_lufs: Option<f64>,
    pub relative_offset_applied_db: Option<f64>,
    pub output_path: String,
}

/// Loudness comparison report between original reference track and dub master mix
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessComparisonReport {
    pub original_lufs: f64,
    pub original_peak_db: f64,
    pub original_lra: f64,
    pub master_lufs: f64,
    pub master_peak_db: f64,
    pub master_lra: f64,
    pub current_delta_db: f64,
    pub recommended_delta_db: f64,
    pub target_master_lufs: f64,
    pub recommended_gain_adjustment_db: f64,
    pub readability_status: String, // "optimal" (3.5 - 4.5 dB), "too_quiet", "too_loud"
    pub recommendation_text: String,
}

#[derive(Debug)]
pub enum MasteringError {
    IoError(std::io::Error),
    HoundError(hound::Error),
    EbuError(String),
    ResampleError(String),
    InvalidData(String),
}

impl fmt::Display for MasteringError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MasteringError::IoError(e) => write!(f, "Mastering I/O Error: {}", e),
            MasteringError::HoundError(e) => write!(f, "Mastering WAV Error: {}", e),
            MasteringError::EbuError(e) => write!(f, "EBU R128 Error: {}", e),
            MasteringError::ResampleError(e) => write!(f, "Rubato 4x Resampler Error: {}", e),
            MasteringError::InvalidData(e) => write!(f, "Invalid Data: {}", e),
        }
    }
}

impl Error for MasteringError {}

impl From<std::io::Error> for MasteringError {
    fn from(err: std::io::Error) -> Self {
        MasteringError::IoError(err)
    }
}

impl From<hound::Error> for MasteringError {
    fn from(err: hound::Error) -> Self {
        MasteringError::HoundError(err)
    }
}

// =========================================================================
// DSP MATH & HELPER FUNCTIONS
// =========================================================================

#[inline(always)]
pub fn linear_to_db(linear: f64) -> f64 {
    if linear > 1e-12 {
        20.0 * linear.log10()
    } else {
        -240.0
    }
}

#[inline(always)]
pub fn db_to_linear(db: f64) -> f64 {
    10.0_f64.powf(db / 20.0)
}

/// Simple fast PRNG for TPDF (Triangular Probability Density Function) dithering
struct FastPrng {
    state: u64,
}

impl FastPrng {
    fn new(seed: u64) -> Self {
        Self { state: if seed == 0 { 0x853c49e6748fea9b } else { seed } }
    }

    #[inline(always)]
    fn next_f32(&mut self) -> f32 {
        // Xorshift64star
        self.state ^= self.state >> 12;
        self.state ^= self.state << 25;
        self.state ^= self.state >> 27;
        let val = self.state.wrapping_mul(0x2545F4914F6CDD1D);
        // Map to [-1.0, 1.0]
        ((val as f64 / u64::MAX as f64) * 2.0 - 1.0) as f32
    }

    /// Generate triangular distributed noise in range [-1.0, 1.0] LSB
    #[inline(always)]
    fn tpdf_noise(&mut self) -> f32 {
        // Sum of two independent uniform random variables yields triangular distribution
        let r1 = self.next_f32() * 0.5;
        let r2 = self.next_f32() * 0.5;
        r1 + r2
    }
}

/// Measures the Integrated Loudness (LUFS) and True-Peak of an audio file using EBU R128
pub fn analyze_file_ebur128(file_path: &Path) -> Result<(f64, f64, f64), MasteringError> {
    let (wav_path, is_temp) = crate::file_io::ensure_valid_wav_path(file_path)
        .map_err(|e| MasteringError::InvalidData(e))?;

    let mut reader = WavReader::open(&wav_path)?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let sample_rate = spec.sample_rate;

    if channels == 0 || sample_rate == 0 {
        return Err(MasteringError::InvalidData("Invalid audio spec".into()));
    }

    let mut meter = EbuR128::new(channels as u32, sample_rate, Mode::I | Mode::TRUE_PEAK | Mode::LRA)
        .map_err(|e| MasteringError::EbuError(format!("{:?}", e)))?;

    let mut chunk_buf = Vec::with_capacity(4096 * channels);
    match spec.sample_format {
        SampleFormat::Float => {
            for sample in reader.samples::<f32>() {
                chunk_buf.push(sample.unwrap_or(0.0));
                if chunk_buf.len() == 4096 * channels {
                    meter.add_frames_f32(&chunk_buf)
                        .map_err(|e| MasteringError::EbuError(format!("{:?}", e)))?;
                    chunk_buf.clear();
                }
            }
        }
        SampleFormat::Int => {
            let divisor = match spec.bits_per_sample {
                16 => 32768.0_f32,
                24 => 8388608.0_f32,
                32 => 2147483648.0_f32,
                8  => 128.0_f32,
                _ => 32768.0_f32,
            };
            for sample in reader.samples::<i32>() {
                chunk_buf.push(sample.unwrap_or(0) as f32 / divisor);
                if chunk_buf.len() == 4096 * channels {
                    meter.add_frames_f32(&chunk_buf)
                        .map_err(|e| MasteringError::EbuError(format!("{:?}", e)))?;
                    chunk_buf.clear();
                }
            }
        }
    }

    if !chunk_buf.is_empty() {
        meter.add_frames_f32(&chunk_buf)
            .map_err(|e| MasteringError::EbuError(format!("{:?}", e)))?;
    }

    if is_temp {
        let _ = std::fs::remove_file(&wav_path);
    }

    let integrated_lufs = meter.loudness_global().unwrap_or(-70.0);
    let lra = meter.loudness_range().unwrap_or(0.0);

    let mut max_tp = 0.0_f64;
    for ch in 0..channels as u32 {
        if let Ok(tp) = meter.true_peak(ch) {
            if tp > max_tp {
                max_tp = tp;
            }
        }
    }
    let true_peak_db = linear_to_db(max_tp);

    Ok((
        if integrated_lufs.is_nan() || integrated_lufs < -70.0 { -70.0 } else { integrated_lufs },
        true_peak_db,
        if lra.is_nan() { 0.0 } else { lra }
    ))
}

// =========================================================================
// 4X OVERSAMPLED BRICKWALL TRUE-PEAK LIMITER CORE
// =========================================================================

/// 4x Oversampling True-Peak Peak Extractor using Rubato Sinc Resampler
///
/// Mathematical concept:
/// Standard sample peak meters only sample the continuous audio waveform at discrete intervals $t = n \cdot T_s$.
/// When two consecutive samples have high amplitude with opposite or same phase, the continuous analog
/// reconstructive waveform (after D/A sinc reconstruction) can overshoot the discrete samples by up to +3.0 dB.
/// By upsampling 4x ($Fs \to 4 Fs$), inter-sample peaks are captured with >99.9% accuracy as mandated by ITU-R BS.1770-4.
pub struct TruePeak4xDetector {
    resampler: SincFixedIn<f32>,
    chunk_size: usize,
    channels: usize,
}

impl TruePeak4xDetector {
    pub fn new(channels: usize, _sample_rate: u32) -> Result<Self, MasteringError> {
        let chunk_size = 1024;
        let params = SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff: 0.96,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };

        let resampler = SincFixedIn::<f32>::new(
            4.0, // 4x upsampling
            1.5,
            params,
            chunk_size,
            channels,
        ).map_err(|e| MasteringError::ResampleError(format!("Failed to create 4x Sinc Resampler for True-Peak detection: {}", e)))?;

        Ok(Self {
            resampler,
            chunk_size,
            channels,
        })
    }

    /// Upsamples multi-channel audio buffer 4x and computes the instantaneous multi-channel linked peak envelope profile.
    pub fn compute_4x_peak_profile(&mut self, deinterleaved_channels: &[Vec<f32>]) -> Result<Vec<f32>, MasteringError> {
        let total_frames = deinterleaved_channels[0].len();
        let mut peak_profile_1x = vec![0.0_f32; total_frames];
        let mut offset = 0;

        while offset < total_frames {
            let current_chunk_size = self.chunk_size.min(total_frames - offset);
            let mut input_buffers: Vec<Vec<f32>> = Vec::with_capacity(self.channels);

            for ch in 0..self.channels {
                let mut buf = vec![0.0_f32; self.chunk_size];
                for i in 0..current_chunk_size {
                    buf[i] = deinterleaved_channels[ch][offset + i];
                }
                input_buffers.push(buf);
            }

            let upsampled_chunks = self.resampler.process(&input_buffers, None)
                .map_err(|e| MasteringError::ResampleError(format!("Rubato 4x upsampling error: {}", e)))?;

            let upsampled_len = upsampled_chunks[0].len();
            let frames_in_chunk = current_chunk_size;

            // For each 1x base frame, find the maximum absolute peak among its 4 oversampled sub-samples across all channels
            for frame_idx in 0..frames_in_chunk {
                let mut max_abs = 0.0_f32;
                let start_4x = frame_idx * 4;
                let end_4x = (start_4x + 4).min(upsampled_len);

                for sub_idx in start_4x..end_4x {
                    for ch in 0..self.channels {
                        let sample_abs = upsampled_chunks[ch][sub_idx].abs();
                        if sample_abs > max_abs {
                            max_abs = sample_abs;
                        }
                    }
                }

                // Also include the original 1x samples to ensure no sample point is ever underestimated
                for ch in 0..self.channels {
                    let s_abs = deinterleaved_channels[ch][offset + frame_idx].abs();
                    if s_abs > max_abs {
                        max_abs = s_abs;
                    }
                }

                peak_profile_1x[offset + frame_idx] = max_abs;
            }

            offset += current_chunk_size;
        }

        Ok(peak_profile_1x)
    }
}

// =========================================================================
// LOOKAHEAD LIMITER GAIN COMPUTER WITH PROGRAM-DEPENDENT DUAL RELEASE
// =========================================================================

/// Lookahead Brickwall Limiter Engine
///
/// Principles:
/// 1. 5 ms Lookahead Buffer: Delays the audio signal so the gain reduction envelope can begin
///    smoothly attenuating BEFORE the true peak arrives at the output.
/// 2. Soft-Knee Compression: Prevents harsh transient clipping by starting compression within
///    a 1.0 dB window below the hard ceiling.
/// 3. Program-Dependent Exponential Release: Fast recovery (25 ms) for brief isolated transients,
///    slow recovery (150-250 ms) for prolonged loud sections to completely eliminate audible "breathing" or "pumping".
pub struct LookaheadLimiter {
    lookahead_frames: usize,
    sample_rate: u32,
    ceiling_linear: f32,
    knee_width_db: f32,
    fast_release_coeff: f32,
    slow_release_coeff: f32,
    delay_buffers: Vec<Vec<f32>>,
    delay_write_ptr: usize,
}

impl LookaheadLimiter {
    pub fn new(
        channels: usize,
        sample_rate: u32,
        ceiling_dbtp: f64,
        lookahead_ms: f64,
        release_ms: f64,
    ) -> Self {
        let lookahead_frames = ((lookahead_ms / 1000.0) * sample_rate as f64).round().max(16.0) as usize;
        let ceiling_linear = db_to_linear(ceiling_dbtp) as f32;

        let fast_rel_time = (release_ms * 0.4 / 1000.0).max(0.015) as f32;
        let slow_rel_time = (release_ms * 3.0 / 1000.0).max(0.120) as f32;

        // Exponential release coefficients: g(n) = g(n-1) * coeff + 1.0 * (1 - coeff)
        let fast_release_coeff = (-1.0 / (sample_rate as f32 * fast_rel_time)).exp();
        let slow_release_coeff = (-1.0 / (sample_rate as f32 * slow_rel_time)).exp();

        let delay_buffers = vec![vec![0.0_f32; lookahead_frames]; channels];

        Self {
            lookahead_frames,
            sample_rate,
            ceiling_linear,
            knee_width_db: 1.0,
            fast_release_coeff,
            slow_release_coeff,
            delay_buffers,
            delay_write_ptr: 0,
        }
    }

    /// Computes the instantaneous gain attenuation profile using 5 ms lookahead over the 4x peak profile.
    pub fn compute_gain_profile(&self, peak_profile: &[f32]) -> (Vec<f32>, f32, usize) {
        let total_frames = peak_profile.len();
        let mut target_gains = vec![1.0_f32; total_frames];
        let mut limited_events = 0_usize;
        let mut max_gr_db = 0.0_f32;

        let knee_lower_linear = self.ceiling_linear * db_to_linear(-self.knee_width_db as f64) as f32;

        // Step 1: Compute static instantaneous gain reduction for each frame based on peak magnitude
        for i in 0..total_frames {
            let peak = peak_profile[i];
            if peak > self.ceiling_linear {
                // Hard over-ceiling: exact attenuation required to bring peak down to ceiling
                let gr = self.ceiling_linear / peak;
                target_gains[i] = gr;
                limited_events += 1;
            } else if peak > knee_lower_linear {
                // Soft knee transition: quadratic interpolation
                let x_db = linear_to_db(peak as f64) as f32;
                let ceiling_db = linear_to_db(self.ceiling_linear as f64) as f32;
                let knee_start_db = ceiling_db - self.knee_width_db;
                
                let delta = x_db - knee_start_db;
                let over = (delta * delta) / (4.0 * self.knee_width_db);
                let out_db = x_db - over;
                let target_lin = db_to_linear(out_db as f64) as f32;
                let gr = target_lin / peak;
                target_gains[i] = gr.min(1.0);
            } else {
                target_gains[i] = 1.0;
            }
        }

        // Step 2: Lookahead minimum filter across the [n, n + lookahead] window
        // This ensures the gain drops ahead of time so the transient hits already attenuated
        let mut lookahead_gains = vec![1.0_f32; total_frames];
        for i in 0..total_frames {
            let end_idx = (i + self.lookahead_frames).min(total_frames);
            let mut min_g = 1.0_f32;
            for k in i..end_idx {
                if target_gains[k] < min_g {
                    min_g = target_gains[k];
                }
            }
            lookahead_gains[i] = min_g;
        }

        // Step 3: Ballistics smoothing with program-dependent dual release
        let mut smoothed_gains = vec![1.0_f32; total_frames];
        let mut current_gain = 1.0_f32;
        let mut sustained_reduction_counter = 0_usize;

        for i in 0..total_frames {
            let target_g = lookahead_gains[i];

            if target_g < current_gain {
                // Instantaneous lookahead attack: smooth downward tracking
                current_gain = target_g;
                sustained_reduction_counter += 1;
            } else {
                // Release phase: choose coefficient based on sustained compression history
                // Short transient spikes release quickly; sustained compression releases slowly
                let is_sustained = sustained_reduction_counter > (self.sample_rate as usize / 50); // > 20ms
                let rel_coeff = if is_sustained {
                    self.slow_release_coeff
                } else {
                    self.fast_release_coeff
                };

                current_gain = current_gain * rel_coeff + 1.0_f32 * (1.0_f32 - rel_coeff);
                if current_gain > 1.0 {
                    current_gain = 1.0;
                    sustained_reduction_counter = 0;
                }
            }

            smoothed_gains[i] = current_gain;

            let gr_db = -linear_to_db(current_gain as f64) as f32;
            if gr_db > max_gr_db {
                max_gr_db = gr_db;
            }
        }

        (smoothed_gains, max_gr_db, limited_events)
    }

    /// Processes multi-channel audio by applying the 5 ms delay line and multiplying by the gain profile.
    pub fn process_channels(
        &mut self,
        input_channels: &[Vec<f32>],
        gain_profile: &[f32],
        dither_type: DitherType,
    ) -> Vec<Vec<f32>> {
        let channels = input_channels.len();
        let total_frames = input_channels[0].len();
        let mut output_channels = vec![vec![0.0_f32; total_frames]; channels];
        let mut prng = FastPrng::new(0x1337_CAFE_BABE_F00D);

        // LSB step for dithering
        let dither_scale = match dither_type {
            DitherType::None => 0.0_f32,
            DitherType::Tpdf16Bit => 1.0_f32 / 32768.0_f32,
            DitherType::Tpdf24Bit => 1.0_f32 / 8388608.0_f32,
        };

        for frame in 0..total_frames {
            let gain = gain_profile[frame];

            for ch in 0..channels {
                // 1. Read delayed sample from circular lookahead buffer
                let delayed_sample = self.delay_buffers[ch][self.delay_write_ptr];

                // 2. Write new input sample into delay buffer
                self.delay_buffers[ch][self.delay_write_ptr] = input_channels[ch][frame];

                // 3. Apply lookahead gain reduction
                let mut limited_sample = delayed_sample * gain;

                // 4. Hard safety brickwall clamping at ceiling
                if limited_sample.abs() > self.ceiling_linear {
                    limited_sample = limited_sample.signum() * self.ceiling_linear;
                }

                // 5. Apply TPDF Dithering
                if dither_scale > 0.0 {
                    let dither = prng.tpdf_noise() * dither_scale * 0.5;
                    limited_sample = (limited_sample + dither).clamp(-self.ceiling_linear, self.ceiling_linear);
                }

                output_channels[ch][frame] = limited_sample;
            }

            self.delay_write_ptr = (self.delay_write_ptr + 1) % self.lookahead_frames;
        }

        output_channels
    }
}

// =========================================================================
// COMPLETE HIGH-PRECISION MASTERING WORKFLOW
// =========================================================================

/// Executes complete 2-pass broadcast loudness normalization and 4x True-Peak brickwall limiting.
pub fn process_mastering_limiter(
    input_path: &Path,
    output_path: &Path,
    config: MasteringLimiterConfig,
) -> Result<MasteringStats, MasteringError> {
    if !input_path.exists() {
        return Err(MasteringError::InvalidData(format!("Input file does not exist: {}", input_path.display())));
    }

    // 1. Determine Target Loudness based on Standard or Reference Audio
    let mut target_lufs = config.target_lufs.unwrap_or_else(|| config.standard.target_lufs());
    let mut detected_ref_lufs = None;
    let mut relative_offset_applied = None;

    if config.standard == MasteringStandard::OriginalRelative || config.standard == MasteringStandard::OriginalMatch || config.relative_gain_db.is_some() {
        if let Some(ref_path_str) = &config.reference_audio_path {
            let ref_path = Path::new(ref_path_str);
            if ref_path.exists() {
                if let Ok((ref_lufs, _, _)) = analyze_file_ebur128(ref_path) {
                    if ref_lufs > -60.0 {
                        detected_ref_lufs = Some(ref_lufs);
                        if config.standard == MasteringStandard::OriginalRelative || config.relative_gain_db.is_some() {
                            let rel_offset = config.relative_gain_db.unwrap_or(4.0);
                            target_lufs = (ref_lufs + rel_offset).clamp(-30.0, -8.0);
                            relative_offset_applied = Some(rel_offset);
                        } else if config.standard == MasteringStandard::OriginalMatch {
                            target_lufs = ref_lufs;
                        }
                    }
                }
            }
        }
    }

    let ceiling_dbtp = config.true_peak_ceiling_db.unwrap_or_else(|| config.standard.true_peak_ceiling_db());
    let lookahead_ms = config.lookahead_ms.unwrap_or(5.0);
    let release_ms = config.release_ms.unwrap_or(50.0);
    let dither_type = config.dither.unwrap_or(DitherType::Tpdf24Bit);

    // 2. Open WAV file and extract audio
    let (wav_path, is_temp) = crate::file_io::ensure_valid_wav_path(input_path)
        .map_err(|e| MasteringError::InvalidData(e))?;

    let mut reader = WavReader::open(&wav_path)?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let sample_rate = spec.sample_rate;

    if channels == 0 || sample_rate == 0 {
        return Err(MasteringError::InvalidData("Invalid audio spec".into()));
    }

    // Extract deinterleaved float channels
    let mut deinterleaved: Vec<Vec<f32>> = vec![Vec::new(); channels];
    match spec.sample_format {
        SampleFormat::Float => {
            let mut ch = 0;
            for sample in reader.samples::<f32>() {
                deinterleaved[ch].push(sample.unwrap_or(0.0));
                ch = (ch + 1) % channels;
            }
        }
        SampleFormat::Int => {
            let divisor = match spec.bits_per_sample {
                16 => 32768.0_f32,
                24 => 8388608.0_f32,
                32 => 2147483648.0_f32,
                8  => 128.0_f32,
                _ => 32768.0_f32,
            };
            let mut ch = 0;
            for sample in reader.samples::<i32>() {
                deinterleaved[ch].push(sample.unwrap_or(0) as f32 / divisor);
                ch = (ch + 1) % channels;
            }
        }
    }

    if is_temp {
        let _ = std::fs::remove_file(&wav_path);
    }

    let total_frames = deinterleaved[0].len();
    if total_frames == 0 {
        return Err(MasteringError::InvalidData("Audio file has 0 samples".into()));
    }
    let duration_sec = total_frames as f64 / sample_rate as f64;

    // 3. Initial EBU R128 Loudness and True-Peak Analysis (Pre-Mastering)
    let (initial_lufs, initial_tp_db, initial_lra) = {
        let mut meter = EbuR128::new(channels as u32, sample_rate, Mode::I | Mode::TRUE_PEAK | Mode::LRA)
            .map_err(|e| MasteringError::EbuError(format!("{:?}", e)))?;

        let mut interleaved = Vec::with_capacity(4096 * channels);
        for frame in 0..total_frames {
            for ch in 0..channels {
                interleaved.push(deinterleaved[ch][frame]);
            }
            if interleaved.len() >= 4096 * channels {
                meter.add_frames_f32(&interleaved)
                    .map_err(|e| MasteringError::EbuError(format!("{:?}", e)))?;
                interleaved.clear();
            }
        }
        if !interleaved.is_empty() {
            meter.add_frames_f32(&interleaved)
                .map_err(|e| MasteringError::EbuError(format!("{:?}", e)))?;
        }

        let lufs = meter.loudness_global().unwrap_or(-70.0);
        let lra = meter.loudness_range().unwrap_or(0.0);
        let mut max_tp = 0.0_f64;
        for ch in 0..channels as u32 {
            if let Ok(tp) = meter.true_peak(ch) {
                if tp > max_tp { max_tp = tp; }
            }
        }
        (
            if lufs.is_nan() || lufs < -70.0 { -70.0 } else { lufs },
            linear_to_db(max_tp),
            if lra.is_nan() { 0.0 } else { lra }
        )
    };

    // 4. Calculate Normalization Gain Factor
    let norm_gain_db = if initial_lufs > -68.0 {
        (target_lufs - initial_lufs).clamp(-30.0, 18.0)
    } else {
        0.0
    };
    let norm_gain_linear = db_to_linear(norm_gain_db) as f32;

    // Apply base normalization gain to all channels
    let mut normalized_channels = deinterleaved;
    for ch in 0..channels {
        for frame in 0..total_frames {
            normalized_channels[ch][frame] *= norm_gain_linear;
        }
    }

    // 5. 4x Oversampled True-Peak Detection via Rubato Sinc Resampler
    let mut detector = TruePeak4xDetector::new(channels, sample_rate)?;
    let peak_profile_4x = detector.compute_4x_peak_profile(&normalized_channels)?;

    // 6. Lookahead Limiting (5 ms Lookahead Delay Buffer + Dual-Release Ballistics)
    let mut limiter = LookaheadLimiter::new(
        channels,
        sample_rate,
        ceiling_dbtp,
        lookahead_ms,
        release_ms,
    );

    let (gain_profile, max_gain_reduction_db, total_limited_events) = limiter.compute_gain_profile(&peak_profile_4x);
    let mastered_channels = limiter.process_channels(&normalized_channels, &gain_profile, dither_type);

    // 7. Post-Mastering EBU R128 Compliance Verification
    let (final_lufs, final_tp_db, final_lra) = {
        let mut meter = EbuR128::new(channels as u32, sample_rate, Mode::I | Mode::TRUE_PEAK | Mode::LRA)
            .map_err(|e| MasteringError::EbuError(format!("{:?}", e)))?;

        let mut interleaved = Vec::with_capacity(4096 * channels);
        for frame in 0..total_frames {
            for ch in 0..channels {
                interleaved.push(mastered_channels[ch][frame]);
            }
            if interleaved.len() >= 4096 * channels {
                meter.add_frames_f32(&interleaved)
                    .map_err(|e| MasteringError::EbuError(format!("{:?}", e)))?;
                interleaved.clear();
            }
        }
        if !interleaved.is_empty() {
            meter.add_frames_f32(&interleaved)
                .map_err(|e| MasteringError::EbuError(format!("{:?}", e)))?;
        }

        let lufs = meter.loudness_global().unwrap_or(target_lufs);
        let lra = meter.loudness_range().unwrap_or(0.0);
        let mut max_tp = 0.0_f64;
        for ch in 0..channels as u32 {
            if let Ok(tp) = meter.true_peak(ch) {
                if tp > max_tp { max_tp = tp; }
            }
        }
        (
            if lufs.is_nan() { target_lufs } else { lufs },
            linear_to_db(max_tp),
            if lra.is_nan() { 0.0 } else { lra }
        )
    };

    // 8. Write Mastered 32-bit Float WAV File
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let out_spec = WavSpec {
        channels: channels as u16,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(output_path, out_spec)?;
    for frame in 0..total_frames {
        for ch in 0..channels {
            writer.write_sample(mastered_channels[ch][frame])?;
        }
    }
    writer.finalize()?;

    // 9. Compliance Check
    let lufs_diff = (final_lufs - target_lufs).abs();
    let is_compliant = lufs_diff <= 0.6 && final_tp_db <= (ceiling_dbtp + 0.1);

    let standard_applied_str = match config.standard {
        MasteringStandard::YoutubeWeb => "YouTube / Web Streaming (-14 LUFS, -1.0 dBTP)",
        MasteringStandard::EbuR128 => "EBU R128 European Broadcast (-23.0 LUFS, -1.0 dBTP)",
        MasteringStandard::OriginalMatch => "Original Film Reference Match (-1.0 dBTP)",
        MasteringStandard::OriginalRelative => "Auto Dub Clarity (+3.5..+4.5 dB over Original)",
        MasteringStandard::Custom => "Custom Mastering Preset",
    };

    Ok(MasteringStats {
        standard_applied: standard_applied_str.to_string(),
        initial_integrated_lufs: (initial_lufs * 10.0).round() / 10.0,
        initial_true_peak_dbtp: (initial_tp_db * 100.0).round() / 100.0,
        initial_loudness_range_lu: (initial_lra * 10.0).round() / 10.0,
        target_integrated_lufs: (target_lufs * 10.0).round() / 10.0,
        final_integrated_lufs: (final_lufs * 10.0).round() / 10.0,
        final_true_peak_dbtp: (final_tp_db * 100.0).round() / 100.0,
        final_loudness_range_lu: (final_lra * 10.0).round() / 10.0,
        true_peak_ceiling_dbtp: ceiling_dbtp,
        normalization_gain_applied_db: (norm_gain_db * 10.0).round() / 10.0,
        max_gain_reduction_db: (max_gain_reduction_db as f64 * 10.0).round() / 10.0,
        total_limited_events,
        is_compliant,
        sample_rate,
        channels: channels as u16,
        duration_sec: (duration_sec * 100.0).round() / 100.0,
        reference_track_lufs: detected_ref_lufs.map(|v| (v * 10.0).round() / 10.0),
        relative_offset_applied_db: relative_offset_applied,
        output_path: output_path.to_string_lossy().to_string(),
    })
}

// =========================================================================
// TAURI COMMANDS
// =========================================================================

/// Tauri command to apply full mastering limiter and loudness normalization to a file
#[tauri::command]
pub async fn apply_mastering_limiter(
    input_path: String,
    output_path: String,
    standard: Option<String>,
    target_lufs: Option<f64>,
    true_peak_ceiling_db: Option<f64>,
    reference_path: Option<String>,
    relative_gain_db: Option<f64>,
    lookahead_ms: Option<f64>,
    oversampling: Option<String>,
    dither: Option<String>,
) -> Result<MasteringStats, String> {
    let in_path_buf = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&input_path));
    let out_path_buf = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&output_path));

    let parsed_standard = match standard.as_deref() {
        Some("ebu_r128") | Some("EbuR128") => MasteringStandard::EbuR128,
        Some("original_match") | Some("OriginalMatch") => MasteringStandard::OriginalMatch,
        Some("original_relative") | Some("OriginalRelative") => MasteringStandard::OriginalRelative,
        Some("custom") | Some("Custom") => MasteringStandard::Custom,
        _ => MasteringStandard::OriginalRelative,
    };

    let parsed_dither = match dither.as_deref() {
        Some("none") | Some("None") => DitherType::None,
        Some("tpdf_16bit") => DitherType::Tpdf16Bit,
        _ => DitherType::Tpdf24Bit,
    };

    let oversampling_factor = match oversampling.as_deref() {
        Some("2x") => 2,
        Some("1x") => 1,
        _ => 4,
    };

    let config = MasteringLimiterConfig {
        standard: parsed_standard,
        target_lufs,
        true_peak_ceiling_db,
        lookahead_ms: lookahead_ms.or(Some(5.0)),
        release_ms: Some(50.0),
        oversampling_factor: Some(oversampling_factor),
        dither: Some(parsed_dither),
        reference_audio_path: reference_path.map(|p| crate::file_io::normalize_windows_path(&p)),
        relative_gain_db: relative_gain_db.or(Some(4.0)),
    };

    tokio::task::spawn_blocking(move || {
        process_mastering_limiter(&in_path_buf, &out_path_buf, config)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Mastering task join failed: {}", e))?
}

/// Tauri command to analyze and compare loudness between Original Reference Track and Master Mix Track
#[tauri::command]
pub async fn compare_tracks_loudness(
    original_path: String,
    master_path: String,
    target_relative_db: Option<f64>,
) -> Result<LoudnessComparisonReport, String> {
    let orig_p = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&original_path));
    let mast_p = std::path::PathBuf::from(crate::file_io::normalize_windows_path(&master_path));

    let recommended_delta_db = target_relative_db.unwrap_or(4.0); // Standard optimal dub offset: 3.5 - 4.5 dB

    tokio::task::spawn_blocking(move || {
        if !orig_p.exists() {
            return Err(format!("Original audio file does not exist: {}", orig_p.display()));
        }
        if !mast_p.exists() {
            return Err(format!("Master audio file does not exist: {}", mast_p.display()));
        }

        let (orig_lufs, orig_peak_db, orig_lra) = analyze_file_ebur128(&orig_p)
            .map_err(|e| format!("Failed to analyze original track: {:?}", e))?;
        let (mast_lufs, mast_peak_db, mast_lra) = analyze_file_ebur128(&mast_p)
            .map_err(|e| format!("Failed to analyze master mix track: {:?}", e))?;

        let target_master_lufs = ((orig_lufs + recommended_delta_db) * 10.0).round() / 10.0;
        let recommended_gain_adjustment_db = ((target_master_lufs - mast_lufs) * 10.0).round() / 10.0;

        let readability_status = if (3.4..=4.6).contains(&(mast_lufs - orig_lufs)) {
            "optimal".to_string()
        } else if (mast_lufs - orig_lufs) < 3.4 {
            "too_quiet".to_string()
        } else {
            "too_loud".to_string()
        };

        let recommendation_text = match readability_status.as_str() {
            "optimal" => format!(
                "Идеальный баланс! Мастер-микс громче оригинала на {:.1} dB (стандарт читаемости: 3.5–4.5 dB). Речь звучит отчётливо и чисто.",
                mast_lufs - orig_lufs
            ),
            "too_quiet" => format!(
                "Мастер-микс тихий относительно оригинала (дельта {:.1} dB). Рекомендуется поднять громкость на {:+.1} dB до цели {:.1} LUFS.",
                mast_lufs - orig_lufs,
                recommended_gain_adjustment_db,
                target_master_lufs
            ),
            _ => format!(
                "Мастер-микс громче стандарта (дельта {:.1} dB). Рекомендуется уменьшить гейн на {:.1} dB для предотвращения перегрузки.",
                mast_lufs - orig_lufs,
                recommended_gain_adjustment_db.abs()
            ),
        };

        Ok(LoudnessComparisonReport {
            original_lufs: (orig_lufs * 10.0).round() / 10.0,
            original_peak_db: (orig_peak_db * 10.0).round() / 10.0,
            original_lra: (orig_lra * 10.0).round() / 10.0,
            master_lufs: (mast_lufs * 10.0).round() / 10.0,
            master_peak_db: (mast_peak_db * 10.0).round() / 10.0,
            master_lra: (mast_lra * 10.0).round() / 10.0,
            current_delta_db: ((mast_lufs - orig_lufs) * 10.0).round() / 10.0,
            recommended_delta_db: (recommended_delta_db * 10.0).round() / 10.0,
            target_master_lufs,
            recommended_gain_adjustment_db,
            readability_status,
            recommendation_text,
        })
    })
    .await
    .map_err(|e| format!("Comparison task join failed: {}", e))?
}
