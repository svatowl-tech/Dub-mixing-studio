/**
 * High-performance DSP Bridge invoking native Rust audio DSP algorithms.
 * Direct bridge to src-tauri/src/ modules:
 * - normalization.rs (EBU R128 Loudness Normalization & Upward Compression)
 * - eq_matching.rs (FFT & Spectral Profile Matching)
 * - declick.rs (LPC / Rayon Click & Pop Elimination)
 * - deplosive.rs (Biquad Plosive Attenuation)
 * - deesser.rs (Split-Band Linkwitz-Riley De-Essing)
 * - uvr_denoise.rs (Spectral Subtraction Denoise)
 * - uvr_dereverb.rs (Transient Decay Dereverberation)
 * - volume_leveler.rs (Vocal Leveler AGC)
 * - dsp_waveform.rs (Waveform Peak Shape DSP transformations)
 */
import { invoke } from '@tauri-apps/api/core';

export interface NormalizationStats {
  initialLufs: number;
  finalLufs: number;
  initialTruePeakDb: number;
  finalTruePeakDb: number;
  gainAppliedDb: number;
  upwardCompressionApplied: boolean;
  sampleRate: number;
  channels: number;
  durationSec: number;
  outputPath: string;
}

export interface DeclickReport {
  clicksDetected: number;
  samplesRestored: number;
  channels: number;
  sampleRate: number;
  durationSec: number;
  processedPath: string;
}

export interface DeplosiveReport {
  plosivesDetected: number;
  maxReductionDb: number;
  channels: number;
  sampleRate: number;
  durationSec: number;
  processedPath: string;
}

export interface DeEsserReport {
  sibilantsDetected: number;
  maxReductionDb: number;
  channels: number;
  sampleRate: number;
  durationSec: number;
  processedPath: string;
}

export interface VolumeLevelerReport {
  inputPath: string;
  outputPath: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  initialRmsDb: number;
  finalRmsDb: number;
  dynamicRangeCompressedDb: number;
  maxBoostAppliedDb: number;
  maxCutAppliedDb: number;
  speechPercentage: number;
}

export interface WaveformUpwardResult {
  newWaveform: number[];
  updatedGain: number;
  boostedSamplesCount: number;
  initialLufs: number;
  finalLufs: number;
}

export interface WaveformTransformResult {
  waveform: number[];
  affectedCount: number;
}

// 1. Normalization & Upward Compression
export async function normalizeAudioNative(
  inputPath: string,
  outputPath: string,
  targetLufs?: number
): Promise<NormalizationStats> {
  return await invoke<NormalizationStats>('normalize_audio', {
    inputPath,
    outputPath,
    targetLufs,
  });
}

export async function estimateLufsFromPcmNative(
  peaks: number[],
  gain?: number
): Promise<number> {
  return await invoke<number>('estimate_lufs_from_pcm', {
    peaks,
    gain,
  });
}

export async function applyWaveformUpwardCompressionNative(params: {
  waveform: number[];
  currentGain: number;
  targetLufs: number;
  noiseFloorDb: number;
  upwardThresholdDb: number;
  upwardGainDb: number;
  upwardRatio: number;
}): Promise<WaveformUpwardResult> {
  return await invoke<WaveformUpwardResult>('apply_waveform_upward_compression', params);
}

// 2. EQ Matching
export async function matchEqProfileNative(
  inputPath: string,
  outputPath: string,
  profileName: string
): Promise<void> {
  return await invoke<void>('match_eq_profile', {
    inputPath,
    outputPath,
    profileName,
  });
}

export async function transformWaveformEqNative(
  waveform: number[],
  profile: string
): Promise<WaveformTransformResult> {
  return await invoke<WaveformTransformResult>('transform_waveform_eq', {
    waveform,
    profile,
  });
}

// 3. De-Click
export async function cleanClicksNative(
  inputWav: string,
  outputWav: string,
  sensitivity: number
): Promise<DeclickReport> {
  return await invoke<DeclickReport>('clean_clicks', {
    inputWav,
    outputWav,
    sensitivity,
  });
}

export async function transformWaveformDeclickNative(
  waveform: number[],
  sensitivity: number
): Promise<WaveformTransformResult> {
  return await invoke<WaveformTransformResult>('transform_waveform_declick', {
    waveform,
    sensitivity,
  });
}

// 4. De-Plosive
export async function applyDeplosiveNative(
  filePath: string,
  outPath: string,
  thresholdDb: number
): Promise<DeplosiveReport> {
  return await invoke<DeplosiveReport>('apply_deplosive', {
    filePath,
    outPath,
    thresholdDb,
  });
}

export async function transformWaveformDeplosiveNative(
  waveform: number[],
  cutoffHz: number,
  thresholdDb: number
): Promise<WaveformTransformResult> {
  return await invoke<WaveformTransformResult>('transform_waveform_deplosive', {
    waveform,
    cutoffHz,
    thresholdDb,
  });
}

// 5. De-Esser
export async function processDeesserNative(
  inputPath: string,
  outputPath: string,
  frequency: number,
  threshold: number,
  ratio: number
): Promise<DeEsserReport> {
  return await invoke<DeEsserReport>('process_deesser', {
    inputPath,
    outputPath,
    frequency,
    threshold,
    ratio,
  });
}

export async function transformWaveformDeesserNative(
  waveform: number[],
  frequency: number,
  thresholdDb: number
): Promise<WaveformTransformResult> {
  return await invoke<WaveformTransformResult>('transform_waveform_deesser', {
    waveform,
    frequency,
    thresholdDb,
  });
}

// 6. Denoise
export async function processDenoiseNative(
  inputPath: string,
  outputPath: string,
  strength: number,
  model?: string
): Promise<void> {
  return await invoke<void>('process_denoise', {
    inputPath,
    outputPath,
    strength,
    model,
  });
}

export async function transformWaveformDenoiseNative(
  waveform: number[],
  strength: number
): Promise<WaveformTransformResult> {
  return await invoke<WaveformTransformResult>('transform_waveform_denoise', {
    waveform,
    strength,
  });
}

// 7. De-Reverb
export async function processUvrDereverbNative(
  inputPath: string,
  outputPath: string,
  strength: number,
  model?: string
): Promise<void> {
  return await invoke<void>('process_uvr_dereverb', {
    inputPath,
    outputPath,
    strength,
    model,
  });
}

export async function transformWaveformDereverbNative(
  waveform: number[],
  strength: number
): Promise<WaveformTransformResult> {
  return await invoke<WaveformTransformResult>('transform_waveform_dereverb', {
    waveform,
    strength,
  });
}

// 8. Volume Leveler
export async function levelSpeechVolumeNative(params: {
  inputPath: string;
  outputPath: string;
  targetRms?: number;
  gateThresholdDb?: number;
  maxBoostDb?: number;
  maxAttenuationDb?: number;
}): Promise<VolumeLevelerReport> {
  return await invoke<VolumeLevelerReport>('level_speech_volume', params);
}

export async function transformWaveformLevelerNative(
  waveform: number[],
  ratio: number
): Promise<WaveformTransformResult> {
  return await invoke<WaveformTransformResult>('transform_waveform_leveler', {
    waveform,
    ratio,
  });
}
