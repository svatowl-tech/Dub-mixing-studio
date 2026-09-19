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

export interface IntelligentClipResult {
  clipId: string;
  originalPath: string;
  processedPath: string;
}

export interface IntelligentNormResult {
  trackId: string;
  processedClips: IntelligentClipResult[];
}

export interface SpectralClipResult {
  clipId: string;
  originalPath: string;
  processedPath: string;
}

export interface SpectralBalancingResult {
  trackId: string;
  processedClips: SpectralClipResult[];
}

export interface LevelerClipResult {
  clipId: string;
  originalPath: string;
  processedPath: string;
}

export interface SpeechLevelerResult {
  trackId: string;
  processedClips: LevelerClipResult[];
}

export interface SpotClipResult {
  clipId: string;
  originalPath: string;
  processedPath: string;
}

export interface SpotCleanerResult {
  trackId: string;
  processedClips: SpotClipResult[];
}

export interface ClipProcessingInput {
  id: string;
  filePath: string;
  startTimeMs: number;
  durationMs: number;
  sourceOffsetMs: number;
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

// ============================================================================
// Phase 1.1: Intelligent Track Analysis & Normalization
// ============================================================================

export type WaveformClassification = 'silence' | 'noise' | 'quietFragment' | 'speech';

export interface TrackAnalysisSegment {
  startMs: number;
  durationMs: number;
  classification: WaveformClassification;
  avgRmsDb: number;
  peakDb: number;
  isSibilant: boolean;
  isPlosive: boolean;
  isClick: boolean;
}

export interface TrackSpectralState {
  avgLowsDb: number;
  avgMidsDb: number;
  avgHighsDb: number;
  peakFreq: number;
  peakFreqDb: number;
  lowBassBoosted: boolean;
  lowBassAttenuated: boolean;
  highTrebleBoosted: boolean;
  resonanceDetected: boolean;
  spectralCentroidHz: number;
  spectrumDb: number[];
}

export interface TrackAnalysisReport {
  trackId: string;
  trackName: string;
  segments: TrackAnalysisSegment[];
  spectralState: TrackSpectralState;
  analysisTimestamp: number;
}

export interface ClipAnalysisInput {
  id: string;
  filePath: string;
  startTimeMs: number;
  durationMs: number;
  sourceOffsetMs?: number;
}

export interface TrackAnalysisInput {
  id: string;
  name: string;
  trackType: string;
  clips: ClipAnalysisInput[];
}

export async function analyzeVoiceTracksNative(
  projectDir: string,
  tracks: TrackAnalysisInput[]
): Promise<TrackAnalysisReport[]> {
  return await invoke<TrackAnalysisReport[]>('analyze_voice_tracks', {
    projectDir,
    tracks,
  });
}

export async function loadTrackAnalysisNative(
  projectDir: string
): Promise<TrackAnalysisReport[]> {
  return await invoke<TrackAnalysisReport[]>('load_track_analysis', {
    projectDir,
  });
}

export async function processIntelligentNormalizationWithClipsNative(
  projectDir: string,
  trackId: string,
  clips: ClipProcessingInput[]
): Promise<IntelligentNormResult> {
  return await invoke<IntelligentNormResult>('process_intelligent_normalization_with_clips', {
    projectDir,
    trackId,
    clips,
  });
}

export async function processSpectralBalancingNative(
  projectDir: string,
  trackId: string,
  clips: ClipProcessingInput[]
): Promise<SpectralBalancingResult> {
  return await invoke<SpectralBalancingResult>('process_spectral_balancing', {
    projectDir,
    trackId,
    clips,
  });
}

export async function processSpeechLevelerNative(
  projectDir: string,
  trackId: string,
  clips: ClipProcessingInput[]
): Promise<SpeechLevelerResult> {
  return await invoke<SpeechLevelerResult>('process_speech_leveler', {
    projectDir,
    trackId,
    clips,
  });
}

export async function processVocalSpotCleaningNative(
  projectDir: string,
  trackId: string,
  clips: ClipProcessingInput[]
): Promise<SpotCleanerResult> {
  return await invoke<SpotCleanerResult>('process_vocal_spot_cleaning', {
    projectDir,
    trackId,
    clips,
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

// 9. Smart Gain Matching by Subtitles & Speech Cue Classifier
export * from './speechClassifierBridge';
export type SpeechCategory = 'dialogue' | 'foleySfx';

export interface AnnotatedSegment {
  id: string;
  filePath: string;
  outputPath?: string;
  text?: string;
  startTime?: number;
  duration?: number;
  category?: SpeechCategory;
  targetDialogueLufs?: number;
  foleyOffsetDb?: number;
  fadeMs?: number;
}

export interface ProcessedSegmentResult {
  id: string;
  filePath: string;
  outputPath: string;
  category: SpeechCategory;
  initialLufs: number;
  targetLufs: number;
  appliedGainDb: number;
  linearMultiplier: number;
  finalLufs: number;
  durationSec: number;
  sampleRate: number;
  channels: number;
  fadeSamples: number;
  classificationReason: string;
  success: boolean;
  error?: string;
}

export interface SmartGainMatchingBatchResult {
  results: ProcessedSegmentResult[];
  totalProcessed: number;
  dialogueCount: number;
  foleyCount: number;
  avgDialogueGainDb: number;
  avgFoleyGainDb: number;
}

export async function applySmartGainMatchingNative(
  segments: AnnotatedSegment[]
): Promise<SmartGainMatchingBatchResult> {
  return await invoke<SmartGainMatchingBatchResult>('apply_smart_gain_matching', {
    segments,
  });
}

// 10. Intelligent Sidechain Ducking Engine
export type DuckingMode = 'voiceover' | 'recast' | 'dubbing' | 'custom';
export type TargetTrackType = 'originalDialogue' | 'musicAndEffects';

export interface VoiceActivityMask {
  startSec: number;
  endSec: number;
}

export interface SidechainDuckingConfig {
  mode: DuckingMode;
  trackType: TargetTrackType;
  customDuckingDb?: number;
  lookaheadMs?: number;
  fadeDownMs?: number;
  holdMs?: number;
  releaseMs?: number;
  meDuckingDb?: number;
}

export interface DuckingRenderResult {
  inputPath: string;
  outputPath: string;
  totalFrames: number;
  durationSec: number;
  sampleRate: number;
  channels: number;
  duckedIntervalsCount: number;
  minGainDb: number;
  targetDuckingDb: number;
  mode: DuckingMode;
  trackType: TargetTrackType;
  processingTimeMs: number;
  success: boolean;
  error?: string;
}

export async function renderSidechainDuckingNative(
  inputPath: string,
  outputPath: string,
  activityMasks: VoiceActivityMask[],
  config: SidechainDuckingConfig
): Promise<DuckingRenderResult> {
  return await invoke<DuckingRenderResult>('render_sidechain_ducking', {
    inputPath,
    outputPath,
    activityMasks,
    config,
  });
}

// ============================================================================
// Phase 3.3: Acoustic Environment Analysis & FX Chain Generation (Rust DSP)
// ============================================================================

export interface AcousticPreset {
  pan: number; // -1.0 .. 0.0 .. 1.0
  reverbWet: number; // 0.0 .. 1.0
  reverbDecayMs: number; // ms
  highPassHz: number; // Hz
  lowPassHz: number; // Hz
}

export interface AcousticAnalysisReport {
  preset: AcousticPreset;
  ildDb: number;
  phaseCorrelation: number;
  drrDb: number;
  t60Ms: number;
  spectralCentroidHz: number;
  bandwidthHz: number;
  detectedEnvironment: string;
  isNarrowbandComm: boolean;
  isResonantHorn: boolean;
  confidence: number;
  processingTimeMs: number;
}

export interface VoiceSegmentInterval {
  id: string;
  startSec: number;
  durationSec: number;
  text?: string;
}

export interface SegmentAcousticResult {
  segmentId: string;
  report: AcousticAnalysisReport;
}

export async function analyzeAcousticEnvironmentNative(
  audioPath: string,
  startSec?: number,
  durationSec?: number
): Promise<AcousticAnalysisReport> {
  return await invoke<AcousticAnalysisReport>('analyze_acoustic_environment', {
    audioPath,
    startSec,
    durationSec,
  });
}

export async function analyzeSegmentsAcousticsNative(
  audioPath: string,
  intervals: VoiceSegmentInterval[]
): Promise<SegmentAcousticResult[]> {
  return await invoke<SegmentAcousticResult[]>('analyze_segments_acoustics', {
    audioPath,
    intervals,
  });
}

// ============================================================================
// Phase 3.4: Master Vocal Bus Studio DSP Rack (Rust 6-FX Chain Engine)
// ============================================================================

export type VocalDeEsserMode = 'splitBand' | 'wideband';

export interface HpfSurgicalEqConfig {
  enabled: boolean;
  hpfCutoffHz: number;
  hpfOrder: number;
  notchEnabled: boolean;
  notchFreqHz: number;
  notchQ: number;
  notchGainDb: number;
}

export interface DynamicDeEsserConfig {
  enabled: boolean;
  frequencyHz: number;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  kneeWidthDb: number;
  maxReductionDb: number;
  mode: VocalDeEsserMode;
}

export interface WarmthSaturationConfig {
  enabled: boolean;
  driveDb: number;
  blend: number;
  warmthBias: number;
  autoGain: boolean;
}

export interface VocalCompressorConfig {
  enabled: boolean;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  kneeWidthDb: number;
  makeupGainDb: number;
  optoCharacter: boolean;
}

export interface PresenceExciterConfig {
  enabled: boolean;
  airFreqHz: number;
  airGainDb: number;
  harmonicDrive: number;
  airBlend: number;
}

export interface TruePeakLimiterConfig {
  enabled: boolean;
  ceilingDbtp: number;
  releaseMs: number;
  lookaheadMs: number;
}

export interface VocalBusRackConfig {
  presetName: string;
  bypass: boolean;
  eq: HpfSurgicalEqConfig;
  deesser: DynamicDeEsserConfig;
  saturation: WarmthSaturationConfig;
  compressor: VocalCompressorConfig;
  exciter: PresenceExciterConfig;
  limiter: TruePeakLimiterConfig;
}

export interface VocalBusReport {
  inputPath: string;
  outputPath: string;
  sampleRate: number;
  channels: number;
  totalSamples: number;
  durationSec: number;
  initialPeakDb: number;
  finalPeakDb: number;
  maxCompressionDb: number;
  maxDeesserDb: number;
  limiterClampedSamples: number;
  processingTimeMs: number;
}

export async function processMasterVocalBusNative(
  inputPath: string,
  outputPath: string,
  config: VocalBusRackConfig
): Promise<VocalBusReport> {
  return await invoke<VocalBusReport>('process_master_vocal_bus', {
    inputPath,
    outputPath,
    config,
  });
}

export async function batchProcessMasterVocalBusNative(
  filePairs: [string, string][],
  config: VocalBusRackConfig
): Promise<VocalBusReport[]> {
  return await invoke<VocalBusReport[]>('batch_process_master_vocal_bus', {
    filePairs,
    config,
  });
}


