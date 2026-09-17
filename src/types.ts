export interface SubtitleLine {
  id: string;
  start: number; // seconds
  end: number;   // seconds
  text: string;
  role: string;
  needsFix?: boolean;
  fixComment?: string;
}

export interface AudioSettings {
  deviceId?: string;
  outputDeviceId?: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  sampleRate: number;
  bitDepth: 16 | 24 | 32;
  channelIndex?: number;
  asioMode?: boolean; // Experimental low-latency raw ASIO/WASAPI Exclusive mode
  host?: string; // ASIO, WASAPI, etc.
  limiterEnabled?: boolean;
  limiterThreshold?: number; // dB
  // New effects parameters
  noiseGateThreshold: number; // dB
  isNoiseGateEnabled: boolean;
  compressorThreshold: number; // dB
  compressorRatio: number;
  highPassFrequency: number; // Hz
  isDestructive: boolean; // Whether to save processed audio
  webcamDeviceId?: string;
  backstageAudioDeviceId?: string;
  webcamResolutionX?: number;
  webcamResolutionY?: number;
  webcamBitrate?: number; // in bits per second
  webcamExportOverlay?: boolean; // Whether to export with overlay or just raw backstage video
  backstageFolderPath?: string;
  backstageMode: 'parallel' | 'manual';
  isBackstageEnabled: boolean;
  keyMap?: KeyMap;
  vstFolders?: string[];
  exportSettings?: {
    mp3Bitrate: number;
    flacCompression: number;
    sampleRate: number;
  };
  playOriginalTrackSegments?: boolean;
}

export interface HotkeyAction {
  label: string;
  code: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export type KeyMap = Record<string, HotkeyAction>;

export interface Fix {
  id: string;
  segmentId?: string; // Связь с сегментом, если найден
  timestamp: number; // В секундах
  actor: string;
  comment: string;
  isResolved: boolean;
}

export interface Marker {
  id: string;
  time: number; // seconds
  label?: string;
  color?: string;
}

export interface ProjectUIState {
  zoomLevel?: number;
  timelineHeight?: number;
  sidebarWidth?: number;
  teleprompterMode?: 'compact' | 'expanded';
  teleprompterFontSize?: number;
  teleprompterLineHeight?: number;
  teleprompterPacing?: 'auto' | 'manual';
  teleprompterSpeed?: number;
  teleprompterPosition?: { x: number; y: number };
  teleprompterSize?: { width: number; height: number };
  showFixes?: boolean;
}

export interface Project {
  id: string;
  name: string;
  videoUrl?: string;
  videoPath?: string; // Local path for Electron
  referenceAudioPath?: string; // Path to reference audio for shadowing
  documentPath?: string; // Path to .txt or .pdf
  documentContent?: string; // Cached content for .txt
  projectPath?: string; // Root folder for project files
  originalPeaks?: number[]; // Waveform peaks for original audio
  subtitles: SubtitleLine[];
  roles: string[];
  selectedRole?: string;
  tracks: AudioTrack[];
  markers?: Marker[]; // Timeline bookmarks
  latencyOffset: number; // ms
  audioOffsetMs: number; // New global offset for latency compensation
  audioSettings: AudioSettings;
  duration?: number; // Total project duration in seconds
  fixes?: Fix[]; // Сделаем опциональным
  uiState?: ProjectUIState;
  originalTrackSettings?: OriginalTrackSettings;
  masterVolume?: number;
  activePresetId?: string; // Активный ID пресета сведения
  customPresets?: MixingPreset[]; // Пользовательские пресеты сведения
  mixingType?: MixingType;
}

export interface AudioTrack {
  id: string;
  name: string;
  type?: 'original' | 'voice' | 'music' | 'effects' | 'dub';
  filePath?: string;
  audioUrl?: string;
  segments: AudioSegment[];
  volume: number;
  isMuted: boolean;
  isSolo?: boolean;
  isArmed?: boolean;
  isProcessingEnabled?: boolean;
  processing?: TrackProcessing;
  height?: number;
}

export interface TrackProcessing {
  enabled: boolean;
  realtimeMonitor?: boolean; // Real-time monitoring of result (excluding heavy neural models)
  denoise?: {
    enabled: boolean;
    strength: number; // 0..100
    model: 'deep_noise' | 'spectral_gate' | 'rnnoise' | 'intel_ai_denoise' | 'uvr_denoise_lite' | 'uvr_denoise_foxjoy' | 'uvr_denoise_full' | 'deepfilternet3' | 'cascade_net';
  };
  dereverb?: {
    enabled: boolean;
    strength: number; // 0..100
    model: 'rt_dereverb_v2' | 'room_cleaner_neural' | 'adaptive_gate' | 'uvr_deecho_normal' | 'uvr_deecho_aggressive' | 'reverb_foxjoy' | 'mdx_dereverb_room';
  };
  vstPlugins?: VstPluginInstance[];
  lufsNormalize?: {
    enabled: boolean;
    target?: number; // Default -16
  };
  noiseGate?: {
    enabled: boolean;
    threshold?: number; // dB
  };
  compressor?: {
    enabled: boolean;
    threshold?: number;
    ratio?: number;
    attack?: number; // ms
    release?: number; // ms
  };
  deesser?: {
    enabled: boolean;
    threshold?: number; // dB
    frequency?: number; // Hz
  };
  reverb?: {
    enabled: boolean;
    decay?: number; // s
    wet?: number; // 0..1
  };
  delay?: {
    enabled: boolean;
    time?: number; // s
    feedback?: number; // 0..1
    wet?: number; // 0..1
  };
  eq?: {
    enabled: boolean;
    highPass?: number; // Hz
    lowPass?: number; // Hz
    bands?: EqBand[];
  };
  fades?: {
    enabled: boolean;
    duration?: number; // ms
  };
  limiter?: {
    enabled: boolean;
    ceilingDb?: number;
    releaseMs?: number;
  };
  saturation?: {
    enabled: boolean;
    driveDb?: number;
    blend?: number;
    warmthBias?: number;
  };
}

export interface EqBand {
  id: string;
  freq: number;
  gain: number;
  q: number;
  type: 'lowshelf' | 'peaking' | 'highshelf' | 'notch' | 'highpass' | 'lowpass';
}

export interface VstPluginInstance {
  id: string;
  name: string;
  bypass: boolean;
  pluginPath: string;
  vstVersion: 'VST2' | 'VST3' | 'AU';
  parameters: Record<number, number>; // paramId -> value 0..1
  storedState?: string; // base64 chunk
  latencyMs?: number;
}

export interface OriginalTrackSettings {
  enabled: boolean;
  uvrSeparationEnabled: boolean;
  uvrModel: 'uvr_v5_vocal' | 'htdemucs_vocals_bgm' | 'mdx_net_karaoke';
  vocalExtractionStatus: 'idle' | 'processing' | 'done' | 'failed';
  originalVocalVolume: number; // 0..1
  originalInstrumentalVolume: number; // 0..1
  duckingEnabled: boolean;
  duckingThreshold: number; // dB
  duckingRatio: number; // 1..10
}


export interface AudioSegment {
  id: string;
  startTime: number; // Start on timeline (seconds)
  duration: number; // Visible duration on timeline (seconds)
  fileOffset: number; // Offset from start of recorded file (seconds)
  fileDuration: number; // Total duration of the recorded file (seconds)
  blobUrl: string;
  filePath?: string; // Local path for Electron
  sourceFilePath?: string; // Original raw recording path (for 1-click rollback)
  backupFilePath?: string; // Previous version before last effect applied
  processedEffectName?: string; // Badge for last applied effect (e.g., 'VR Denoise', 'Denoise', 'VR De-Echo', 'SmartEQ')
  backstageVideoPath?: string; // Local path for backstage recording
  waveform?: number[]; // Normalized peaks for visualization
  gain: number;
  playbackRate: number; // For Smart Align (Time Stretching)
  originalFileName?: string; // For bulk import/export
  text?: string;
  fadeIn?: number; // Fade in duration (seconds)
  fadeOut?: number; // Fade out duration (seconds)
  panning?: number; // Stereo panning: -1.0 (left) to 1.0 (right)
  isExtractingWaveform?: boolean; // Temporary state for async loaded waveforms

  // Метки и параметры тайминга / выравнивания (Фаза 2)
  timingWarning?: 'overlap' | 'too_short' | 'too_long' | 'desync' | 'missing' | 'none';
  timingWarningDetail?: string;
  targetStartTime?: number; // Целевой тайминг старта по оригинальному голосу
  targetDuration?: number; // Целевая длительность по оригинальной фразе/сабу
  alignedWithOriginal?: boolean; // Старт фразы синхронизирован с оригинальной дорожкой
  whisperText?: string; // Распознанный текст через Whisper
  whisperConfidence?: number; // Уверенность распознавания (0..1)
  matchedSubId?: string; // ID связанной строки субтитров

  // Метки и параметры сведения (Фаза 3)
  voiceCategory?: 'dialogue' | 'physics'; // 'dialogue' (есть сабы) или 'physics' (крики, кряхтение, звуки без сабов)
  measuredLufs?: number; // Измеренный уровень громкости LUFS / RMS
  appliedGainDb?: number; // Примененная поправка громкости в dB
  isDucked?: boolean; // Находится ли под воздействием автодакинга
  appliedDuckingDb?: number; // Глубина подавления оригинального звука
  detectedFx?: {
    reverbWet?: number; // 0..1
    reverbDecay?: number; // sec
    delayTimeMs?: number;
    delayFeedback?: number; // 0..1
    specialFxType?: 'none' | 'telephone' | 'radio' | 'tv' | 'robot' | 'megaphone';
    panning?: number; // -1..1
    acousticPreset?: {
      pan: number;
      reverbWet: number;
      reverbDecayMs: number;
      highPassHz: number;
      lowPassHz: number;
    };
    ildDb?: number;
    phaseCorrelation?: number;
    drrDb?: number;
    t60Ms?: number;
    spectralCentroidHz?: number;
    bandwidthHz?: number;
    detectedEnvironment?: string;
  };
}

// Зафиксированная проблема тайминга для инспектора и звукорежиссера
export interface TimingIssue {
  id: string;
  type: 'overlap' | 'too_short' | 'too_long' | 'desync' | 'missing';
  trackId: string;
  trackName: string;
  segmentId?: string;
  timestamp: number;
  duration?: number;
  title: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  originalStart?: number;
  matchedSubText?: string;
  targetDuration?: number;
  actualDuration?: number;
  canAutoFix: boolean;
}

export interface BridgeResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ==========================================
// ТИПЫ И НАСТРОЙКИ ДЛЯ СВЕДЕНИЯ СЕРИЙ (4 ЭТАПА)
// ==========================================

export enum MixingType {
  VOICEOVER = 'voiceover', // Закадр — быстрая запись, сводится без эффектов
  RECAST = 'recast',       // Рекаст — улучшенный закадр (длина совпадает, старт/энд совпадают, вдохи/охи озвучены)
  REDUB = 'redub',         // Редаб — под дубляж (липсинг с допущениями, эмоции, легкая физика)
  DUBBING = 'dubbing',     // Дубляж — полное сведение эффектов, повторение эмоций и липсинга
}

export interface VstStepConfig {
  id: string;
  name: string;
  bypass: boolean;
  plugins: VstPluginInstance[];
}

// Этап 1: Предобработка (Preprocessing)
export interface PrepProcessingConfig {
  enabled: boolean;
  vstSteps?: Record<string, VstStepConfig>;
  // Поведение при отсутствии скачанной нейросетевой модели: DSP-фоллбэк или пропуск шага
  missingModelBehavior?: 'fallback_dsp' | 'skip';
  
  // Нормализация громкости (Target LUFS)
  normalization: {
    enabled: boolean;
    targetLufs: number; // Рекомендуемые: -16 LUFS (web) или -23 LUFS (TV)
    noiseFloorDb: number; // Порог фонового шума в dB
    upwardThresholdDb: number; // Порог подтяжки тихих фраз (апвард компрессия) в dB
    upwardRatio: number; // Степень сжатия для тихих звуков
    upwardGainDb: number; // Усиление тихих звуков в dB
    bypass: boolean;
  };
  
  // Приведение АЧХ к одному знаменателю (EQ Matching / Tone profiling / Neural Voice Matching)
  eqMatching: {
    enabled: boolean;
    profileModel: 'flat' | 'vocal_presence' | 'warm_analog' | 'reference_match' | 'vocal_spectral_matcher' | 'voicefixer_fe' | 'vocal_timbre_transfer';
    targetProfilePath?: string;
    bypass: boolean;
  };
  
  // Чистка кликов, щелчков и слюней
  deClick: {
    enabled: boolean;
    sensitivity: number; // 0..100
    mouthDeClick: boolean; // Очистка звуков слюны (Mouth De-click)
    maxClickWidthMs: number; // макс ширина щелчка в мс
    detectorType: 'mouth' | 'mechanical' | 'broadband';
    method: 'native_dsp' | 'vst';
    bypass: boolean;
    vstPluginId?: string; // Возможность сделать через внешний VST
  };
  
  // Взрывные согласные (Plosive removal / De-plosive)
  dePlosive: {
    enabled: boolean;
    threshold: number; // dB
    frequencyCutoff: number; // Hz
    bypass: boolean;
  };
  
  // Де-эссер (De-esser) — сглаживание свистящих С, Ш
  deEsser: {
    enabled: boolean;
    threshold: number; // dB
    frequency: number; // Hz
    bypass: boolean;
    ratio?: number;
    mode?: 'split_band' | 'wideband';
    vstPluginId?: string;
  };
  
  // Шумоподавление (AI / Спектральное / VR Architecture)
  denoise: {
    enabled: boolean;
    strength: number; // 0..100
    model: 'deep_noise' | 'spectral_gate' | 'rnnoise' | 'intel_ai_denoise' | 'uvr_denoise_lite' | 'uvr_denoise_foxjoy' | 'uvr_denoise_full' | 'deepfilternet3';
    bypass: boolean;
  };
  
  // Чистка от эха и реверберации помещения (DSP / VR Architecture)
  dereverb: {
    enabled: boolean;
    strength: number; // 0..100
    model: 'rt_dereverb_v2' | 'room_cleaner_neural' | 'adaptive_gate' | 'uvr_deecho_normal' | 'uvr_deecho_aggressive' | 'reverb_foxjoy' | 'mdx_dereverb_room';
    bypass: boolean;
  };
  
  // Выравнивание громкости внутри записанных фраз (AGC/Leveler)
  volumeLeveler: {
    enabled: boolean;
    targetRms: number; // dB
    ratio: number;
    bypass: boolean;
  };
  
  // Разделение оригинального трека из видео на голос и музыку (UVR / Demucs / M&E)
  sourceSeparation: {
    enabled: boolean;
    model: 'htdemucs_vocals_bgm' | 'uvr_v5_vocal' | 'mdx_net_karaoke' | 'MDX23C-8Step-VocFT.onnx' | 'UVR-MDX-NET-Voc_FT.onnx' | '5_HP-Karaoke-UVR.onnx' | 'fast_dsp_splitter' | 'mel_band_roformer_vocals' | 'htdemucs_ft';
    keepSeparatedStems: boolean;
    bypass: boolean;
  };
}

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
  outputPath?: string;
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

export interface DenoiseProgressPayload {
  percent: number;
  currentFrame: number;
  totalFrames: number;
  stage: string;
}

export interface DenoiseReport {
  modelName: string;
  providerUsed: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  noiseReductionDb: number;
  processedPath: string;
  isNeural: boolean;
}

export interface DereverbProgressPayload {
  percent: number;
  currentFrame: number;
  totalFrames: number;
  stage: string;
}

export interface DereverbResult {
  modelName: string;
  providerUsed: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  reverbReductionDb: number;
  dryVocalPath: string;
  reverbTailPath?: string | null;
  isNeural: boolean;
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

export interface SeparationResult {
  vocalsPath: string;
  noVocalsPath: string;
  modelName: string;
  durationSec: number;
}

export interface SeparationProgressPayload {
  percent: number;
  stage: string;
  logLine: string;
}

// Этап 2: Тайминг и выравнивание (Timing & Alignment)
export interface TimingAlignmentConfig {
  enabled: boolean;
  vstSteps?: Record<string, VstStepConfig>;
  
  // Приоритет выравнивания: оригинальная дорожка с голосами (Вокал) или субтитры
  alignPriority: 'original_voice' | 'subtitles';
  alignToOriginalStart: boolean; // Старт дабера и оригинала синхронизированы в одну точку
  voiceoverLeadMs: number; // Смещение начала для закадра (мс, по умолчанию 0)

  // Разделение записанной единой дороги на отдельные фразы по тишине (VAD & Silence Split)
  silenceSplit: {
    enabled: boolean;
    thresholdDb: number; // порог включения речи (Onset) в dB, например, -35 dB
    offsetThresholdDb?: number; // порог выключения речи с гистерезисом (Offset) в dB, например, -45 dB
    minSilenceDurationMs: number; // минимальная длина тишины для сплита, мс (300 мс)
    minSegmentDurationMs: number; // минимальная длина фрагмента (200 мс)
    paddingPreMs?: number; // защитный отступ перед началом фразы (80 мс)
    paddingPostMs?: number; // защитный отступ после окончания фразы (150 мс)
    padSilenceMs?: number; // отступ до и после фразы (legacy)
    exportClips?: boolean; // экспорт нарезанных клипов в отдельные WAV файлы
    bypass: boolean;
  };
  
  // Распознавание каждой фразы через Whisper и сопоставление со сценарием
  whisper: {
    enabled: boolean;
    model: 'whisper-base' | 'whisper-small' | 'whisper-medium' | 'whisper-large-v3' | 'web-stt' | 'auto';
    language: string; // 'ru', 'en', 'ja', 'auto'
    autoMatchSubtitles: boolean; // Автоматическое сопоставление распознанной фразы с субтитрами
    bypass: boolean;
  };

  // Сравнение с оригинальными фразами по длительности и выравнивание (Time Stretching / Smart Align)
  smartAlign: {
    enabled: boolean;
    alignMode: 'tight' | 'loose' | 'recast_tolerance'; // степень точности липсинга и позиций
    maxStretchRatio: number; // например, 1.3 (+30% максимум растяжения/сжатия)
    algorithm: 'rubberband' | 'wsola' | 'phase_vocoder';
    bypass: boolean;
  };
  
  // Правила типов проектов (Закадр / Рекаст / Редаб / Дубляж)
  projectTypeRules: {
    ignoreBreathsAndSighsInVO: boolean; // Закадр: охи/вздохи/физика не озвучиваются, длительность свободна
    enforceMinSubDuration: boolean; // Рекаст/Редаб: длительность фразы не меньше саба (больше можно, меньше нельзя)
    fullLipSync: boolean; // Дубляж: полное озвучание с полным липсинком и подгонкой рта
    maxStretchRatio: number; // Лимит растяжения/сжатия для липсинга
  };

  // Детектирование конфликтов: наезды друг на друга, пропуски, недотяг по времени
  conflictDetection: {
    detectOverlaps: boolean; // Наезды реплик друг на друга
    detectGaps: boolean; // Пропуски фраз по субтитрам
    detectShortPhrases: boolean; // Фраза короче субтитра (для рекаста/редаба)
    autoFixOverlaps: boolean; // Автоматическое устранение наездов
    bypass: boolean;
  };

  // Сравнение с субтитрами (проверка на пропуски фраз)
  subtitleCompliance: {
    enabled: boolean;
    checkMissingPhrases: boolean;
    toleranceMs: number; // допустимое расхождение временных меток субтитров и аудио
    bypass: boolean;
  };
}

/** Нарезанный речевой сегмент из Rust VAD модуля */
export interface AudioCueSegment {
  id: string;
  startMs: number;
  endMs: number;
  sampleStart: number;
  sampleEnd: number;
  startSec: number;
  endSec: number;
  durationMs: number;
  filePath?: string;
  averageDb: number;
  peakDb: number;
}

/** Итоговый отчет о работе Rust VAD нарезки по тишине */
export interface SilenceSplitReport {
  inputPath: string;
  sampleRate: number;
  channels: number;
  totalDurationSec: number;
  totalSamples: number;
  segmentsCount: number;
  segments: AudioCueSegment[];
  totalSpeechDurationMs: number;
  speechRatio: number;
  noiseFloorDb: number;
  onsetThresholdDb: number;
  offsetThresholdDb: number;
}

/** Элемент транскрипции Whisper */
export interface TranscriptItem {
  text: string;
  startTimestampMs: number;
  endTimestampMs: number;
  confidence: number;
  matchedScriptId?: string;
  matchedScriptText?: string;
  matchSimilarity?: number;
}

/** Конфигурация запуска Whisper транскрибации */
export interface WhisperTranscribeConfig {
  modelPath?: string;
  modelType?: string;
  language?: string;
  nThreads?: number;
  translate?: boolean;
  temperature?: number;
  scriptLines?: Array<{
    id: string;
    text: string;
    startTimestampMs?: number;
    endTimestampMs?: number;
    role?: string;
  }>;
  autoMatchScript?: boolean;
  minSimilarityThreshold?: number;
}

/** Результат работы нативного Whisper распознавания речи */
export interface WhisperTranscriptionResult {
  audioPath: string;
  durationMs: number;
  items: TranscriptItem[];
  fullText: string;
  modelUsed: string;
  averageConfidence: number;
}

/** Точка деформации времени в оптимальном пути DTW */
export interface DtwPoint {
  origIndex: number;
  dubIndex: number;
  origTimeMs: number;
  dubTimeMs: number;
  cost: number;
}

/** Сегментная подгонка фразы */
export interface SegmentAdjustment {
  segmentIndex: number;
  origStartMs: number;
  origEndMs: number;
  dubStartMs: number;
  dubEndMs: number;
  timeStretchRatio: number;
  pitchShiftSemitones: number;
  energySimilarity: number;
  deviationPercent: number;
}

/** Итоговая структура подгонки таймингов (Alignment Adjustment) из Rust GCC-PHAT + DTW */
export interface AlignmentAdjustment {
  originalCueId: string;
  dubCueId: string;
  detectedLagMs: number;
  detectedLagSamples: number;
  correlationScore: number;
  averageStretchRatio: number;
  maxDeviationPercent: number;
  requiresActorReRecording: boolean;
  warningMessage?: string;
  segmentAdjustments: SegmentAdjustment[];
  dtwDistance: number;
  sampleRate: number;
  originalDurationMs: number;
  dubDurationMs: number;
}

/** Кадр спектра реального времени (60 FPS) из нативного Rust FFT */
export interface SpectrumFramePayload {
  bands: number[];
  peak: number;
  rms: number;
  dominantFreqHz: number;
  timestampMs: number;
}

/** Набор уровней детализации волновой формы (LOD Mipmap: 1x, 10x, 100x, 1000x) */
export interface WaveformMipmap {
  sampleRate: number;
  totalSamples: number;
  durationSeconds: number;
  lod1x: number[];
  lod10x: number[];
  lod100x: number[];
  lod1000x: number[];
}

/** Результат нативного тайм-алигнмента Smart Align (GCC-PHAT + WSOLA Time-Stretch) */
export interface SmartAlignResult {
  originalPath: string;
  dubbedPath: string;
  outputPath: string;
  originalDurationMs: number;
  dubbedDurationMs: number;
  outputDurationMs: number;
  detectedOffsetMs: number;
  stretchRatio: number;
  correlationScore: number;
  sampleRate: number;
  wasStretched: boolean;
  requiresActorReRecording?: boolean;
  alignmentAdjustment?: AlignmentAdjustment;
}

/** Конфигурация параметров нативного Smart Align */
export interface SmartAlignNativeConfig {
  minStretchRatio?: number;
  maxStretchRatio?: number;
  stretchThresholdPercent?: number;
  maxDeviationLimitPercent?: number;
  alignOffset?: boolean;
  maxSearchOffsetMs?: number;
  dtwHopSizeMs?: number;
  dtwWindowSizeMs?: number;
}

/** Входной сегмент реплики для валидации правил проекта */
export interface CueSegment {
  id: string;
  startMs: number;
  endMs: number;
  text?: string;
  trackId?: string;
  subtitleStartMs?: number;
  subtitleEndMs?: number;
  matchedOriginalId?: string;
}

/** Тип проекта для валидации правил (Rust ProjectType) */
export type ProjectTypeRuleKind = 'voice_over' | 'recast' | 'dubbing';

/** Уровень предупреждения */
export type WarningLevel = 'info' | 'warning' | 'critical';

/** Инструкция по корректировке тайминга (Rust AdjustmentInstruction) */
export interface AdjustmentInstruction {
  segmentId: string;
  currentStartMs: number;
  currentEndMs: number;
  currentDurationMs: number;
  recommendedStartMs: number;
  recommendedEndMs: number;
  recommendedDurationMs: number;
  offsetShiftMs: number;
  stretchRatio: number;
  isValid: boolean;
  warningLevel: WarningLevel;
  ruleApplied: string;
  message: string;
}

/** Типы коллизий на таймлайне */
export type ConflictType = 'clashing' | 'script_gap' | 'timing_drift' | 'track_overlap';
export type ConflictSeverity = 'info' | 'warning' | 'critical';

export interface SuggestedFix {
  fixType: string;
  targetSegmentId?: string;
  targetSubtitleId?: string;
  recommendedShiftMs: number;
  recommendedStretchRatio: number;
  autoApplied: boolean;
  explanation: string;
}

export interface ConflictReport {
  id: string;
  conflictType: ConflictType;
  severity: ConflictSeverity;
  timeStartMs: number;
  timeEndMs: number;
  affectedTrackIds: string[];
  affectedSegmentIds: string[];
  affectedSubtitleId?: string;
  characterName?: string;
  message: string;
  suggestedFix: SuggestedFix;
}

export interface TimelineAudioClipInput {
  id: string;
  trackId: string;
  characterId?: string;
  characterName?: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  subtitleId?: string;
  isDialogOverlapAllowed: boolean;
  isMuted: boolean;
}

export interface TimelineSubtitleInput {
  id: string;
  startMs: number;
  endMs: number;
  characterName?: string;
  text: string;
}

export interface TimelineValidationOptions {
  minGapMs?: number;
  timingDriftThresholdMs?: number;
  autoResolveMinorClashes?: boolean;
}

export interface TimelineValidationSummary {
  executionTimeUs: number;
  totalCuesAnalyzed: number;
  totalSubtitlesAnalyzed: number;
  totalConflicts: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  conflicts: ConflictReport[];
  autoResolvedCount: number;
}

// Этап 3: Сведение и Авто-эффекты (Mixing & Effects)
export interface AuditionVocalBusChainConfig {
  presetName: string; // 'Audition Master VO Chain'
  bypass?: boolean;
  // Slot 1: Ozone 11 Stabilizer
  ozoneStabilizer: {
    enabled: boolean;
    shape: number; // 0..100
    speed: number; // 0..100
    smoothness: number; // 0..100
    bypass: boolean;
  };
  // Slot 2: RCompressor Stereo
  rCompressor: {
    enabled: boolean;
    threshold: number; // -12.2 dB
    ratio: number; // 4.7 : 1
    attackMs: number; // 149.6 ms
    releaseMs: number; // 120 ms
    gainDb: number; // +3.44 dB
    warmth: number; // Opto/Electro warm analog character
    bypass: boolean;
  };
  // Slot 3: soothe2_x64
  soothe2: {
    enabled: boolean;
    depth: number; // 5.27
    sharpness: number; // 3.31
    selectivity: number; // 4.07
    band1Freq: number; // 328.8 Hz
    band1Sens: number; // 5.94
    band3Freq: number; // 3489.5 Hz
    band3Sens: number; // 6.20
    bypass: boolean;
  };
  // Slot 4: Pro-Q 4
  proQ4: {
    enabled: boolean;
    highPassFreq: number; // 80 Hz
    lowCutSlope: number; // 12 dB/oct
    airShelfFreq: number; // 12000 Hz
    airShelfGain: number; // +1.5 dB
    notchResonanceFreq: number; // 3200 Hz
    notchCutDb: number; // -2.0 dB
    bypass: boolean;
  };
  // Slot 5: RBass Stereo
  rBass: {
    enabled: boolean;
    frequency: number; // 43 Hz
    intensity: number; // 5.0
    originalBassDb: number; // -2.0 dB
    bypass: boolean;
  };
  // Slot 6: Fresh Air
  freshAir: {
    enabled: boolean;
    midAir: number; // 24% (presence lift 3k-7k)
    highAir: number; // 32% (shimmer 12k-20k)
    bypass: boolean;
  };
  // Slot 7: RVox Stereo
  rVox: {
    enabled: boolean;
    compression: number; // -9.5 dB
    gateThreshold: number; // -80 dB
    gainDb: number; // 0.0 dB
    bypass: boolean;
  };
  // Slot 8: Pro-DS
  proDS: {
    enabled: boolean;
    threshold: number; // -24 dB
    range: number; // -8 dB
    frequency: number; // 10000 Hz
    wideBand: boolean;
    bypass: boolean;
  };
}

// ----------------------------------------------------------------------------
// Пользовательский VST-рэк для мастер-шины (цепочка внешних VST2/VST3 плагинов)
// ----------------------------------------------------------------------------
export interface VstRackSlot {
  id: string;
  pluginId?: string;
  name: string;
  pluginPath: string;
  vstVersion: 'VST2' | 'VST3' | 'AU';
  category?: string;
  manufacturer?: string;
  enabled: boolean;
  bypass: boolean;
  mix: number; // 0..1 (dry/wet)
  gainDb: number; // -24..+24 dB
  parameters: Record<string | number, number>; // paramId or paramIndex -> value
  latencyMs?: number;
}

export interface VstRackConfig {
  presetName: string;
  bypass: boolean;
  masterMix: number; // 0..1
  masterGainDb: number; // -12..+12 dB
  plugins: VstRackSlot[];
}

// ----------------------------------------------------------------------------
// Студийный виртуальный рэк эффектов на нативном Rust DSP (vocal_rack_dsp.rs)
// ----------------------------------------------------------------------------

export interface NativeEqBandConfig {
  enabled: boolean;
  freqHz: number;
  gainDb: number;
  q: number;
}

export interface NativeParametricEqConfig {
  enabled: boolean;
  bypass: boolean;
  lowCut: NativeEqBandConfig;
  lowShelf: NativeEqBandConfig;
  peaking: NativeEqBandConfig;
  highShelf: NativeEqBandConfig;
}

export interface NativeCompressorConfig {
  enabled: boolean;
  bypass: boolean;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  kneeDb: number;
  makeupGainDb: number;
  optoMode: boolean;
}

export interface NativeDeEsserConfig {
  enabled: boolean;
  bypass: boolean;
  freqHz: number;
  q: number;
  thresholdDb: number;
  ratio: number;
  maxReductionDb: number;
  attackMs: number;
  releaseMs: number;
  splitBand: boolean;
}

export type NativeSaturationType = 'softTanh' | 'tubeAnalog' | 'tapeWarmth';

export interface NativeSaturatorConfig {
  enabled: boolean;
  bypass: boolean;
  driveDb: number;
  saturationType: NativeSaturationType;
  warmthBias: number;
  mix: number;
  outputGainDb: number;
}

export interface NativeVst3SlotConfig {
  enabled: boolean;
  bypass: boolean;
  pluginPath: string;
  pluginName: string;
  instanceId?: string | null;
  mix: number;
  gainDb: number;
  parameters: Record<number, number>;
}

export interface NativeRackState {
  trackId: string;
  bypassAll: boolean;
  masterGainDb: number;
  eq: NativeParametricEqConfig;
  compressor: NativeCompressorConfig;
  deesser: NativeDeEsserConfig;
  saturator: NativeSaturatorConfig;
  vst3: NativeVst3SlotConfig;
}

// ----------------------------------------------------------------------------
// Студийный DSP-рэк мастер-шины вокала (высокопроизводительный движок на чистом Rust)
// ----------------------------------------------------------------------------
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

export interface MixingEffectsConfig {
  enabled: boolean;
  vstSteps?: Record<string, VstStepConfig>;
  
  // Выравнивание громкости: Сабы (реплики) строго одинаковы по целевой громкости,
  // Звуки без сабов (физика: крики, кряхтение, вздохи) делаются на -10 дБ тише
  gainMatching: {
    enabled: boolean;
    targetDifferenceDb: number; // Общий оффсет голоса (например 0 dB)
    targetDialogueLufs: number; // Целевая громкость реплик с сабами (-18.0 dBFS / -16.0 LUFS)
    physicsOffsetDb: number; // Разница громкости для звуков физики/криков без сабов (-10.0 dB по умолчанию)
    measurementMethod: 'lufs' | 'rms' | 'peak';
    autoTagCategories: boolean; // Размечать в сегментах тип (dialogue / physics)
    bypass: boolean;
  };
  
  // Дакинг (Ducking) оригинальных реплик под наш голос (дубляж/рекаст/закадр)
  ducking: {
    enabled: boolean;
    duckingDb: number; // на сколько опускать оригинальные реплики (например, -16 dB для закадра, -24 dB для рекаста, -96 dB / Mute для дубляжа)
    attackMs: number; // Плавность входа / Fade-down (мс, по умолчанию 100 мс)
    releaseMs: number; // Плавность восстановления (мс, по умолчанию 350 мс)
    holdMs: number; // Удержание дакинга во время пауз внутри фразы (мс, по умолчанию 150 мс)
    targetStem: 'separated_voice' | 'all_original' | 'music_bgm';
    recastDuckingDb: number; // Дакинг для рекаста (-24 dB)
    dubbingDuckingDb: number; // Дакинг для полного дубляжа (-96 dB / Mute)
    voiceoverDuckingDb: number; // Дакинг для закадра (-16 dB)
    lookaheadMs?: number; // Упреждение до начала фразы (мс, по умолчанию 50 мс)
    fadeDownMs?: number; // S-кривая спуска (мс, по умолчанию 100 мс)
    meDuckingDb?: number; // Ослабление дорожки музыки/шумов M&E (-1.5 dB или 0)
    bypass: boolean;
  };
  
  // Авто-анализ оригинальной дорожки на эффекты (реверберация, дилей, радио, телефон, ТВ, робот, панорама)
  autoFxAnalysis: {
    enabled: boolean;
    detectPanning: boolean;
    detectReverb: boolean;
    detectDelay: boolean;
    detectSpecialFx: boolean; // телефонные разговоры, ТВ, радио, робот, мегафон
    sensitivity: number; // Чувствительность алгоритма (0..100)
    applyToDub: boolean; // автоматически применять аналогичные эффекты к нашим дублям
    applyToTracks: 'all_dub' | 'matching_role' | 'selected';
    bypass: boolean;
  };
  
  // Обработка мастер-шины голоса (Студийный рэк на Rust DSP ИЛИ пользовательская цепочка VST-плагинов)
  vocalBusProcessing: {
    enabled: boolean;
    mode: 'rustDsp' | 'vstRack'; // Переключатель: собственный студийный рэк на Rust или кастомная цепочка VST
    useRustDsp?: boolean;
    nativeRack?: VocalBusRackConfig;
    vstRack?: VstRackConfig;
    chain?: AuditionVocalBusChainConfig;
    glueCompressor: {
      enabled: boolean;
      threshold: number; // dB
      ratio: number;
      attackMs: number;
      releaseMs: number;
    };
    limiter: {
      enabled: boolean;
      ceilingDb: number; // dB
      releaseMs: number;
    };
    eq: {
      enabled: boolean;
      lowCutHz: number;
      highShelfHz: number;
    };
    vstPlugins?: VstPluginInstance[]; // Поддержка VST на мастер-шине голосов
    bypass: boolean;
  };
}

// Запись аудита выполнения шагов сведения для логгера
export interface MixingAuditEntry {
  id: string;
  timestamp: number;
  stageName: string;
  stepId: 'gainMatching' | 'ducking' | 'autoFxAnalysis' | 'vocalBusProcessing' | 'qualityControl' | 'masteringLimiter' | 'stemExport' | 'subtitleBurn' | 'renderSettings' | string;
  status: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  details?: {
    trackName?: string;
    segmentId?: string;
    category?: 'dialogue' | 'physics';
    timeRange?: string;
    targetDb?: number;
    adjustedGainDb?: number;
    duckingDb?: number;
    detectedFx?: string;
    detectedEnv?: string;
    preset?: any;
    vstPluginName?: string;
    measuredValue?: string;
    fixSuggestion?: string;
  };
}

// ============================================================================
// ПРЕДРЕЛИЗНЫЙ АУДИТ И КОНТРОЛЬ КАЧЕСТВА (PRE-RELEASE QA AUDIT - RUST ENGINE)
// ============================================================================

export type QaIncidentType = 
  | 'true_peak_overload' 
  | 'digital_clipping' 
  | 'digital_click' 
  | 'anomalous_silence' 
  | 'missing_actor_line' 
  | 'lufs_out_of_spec';

export type QaSeverity = 'error' | 'warning' | 'info';

export interface QaTimecode {
  seconds: number;
  milliseconds: number;
  sampleIndex: number;
  durationSeconds?: number;
  durationMs?: number;
  sampleCount?: number;
  smpteTimecode: string;
}

export interface QaIncident {
  id: string;
  incidentType: QaIncidentType;
  severity: QaSeverity;
  timecode: QaTimecode;
  channel?: number;
  channelName: string;
  trackName?: string;
  characterRole?: string;
  scriptCueId?: string;
  title: string;
  description: string;
  measuredValue: string;
  thresholdValue: string;
  fixSuggestion: string;
}

export interface QaAudioMetrics {
  integratedLufs: number;
  loudnessRangeLu: number;
  maxTruePeakDbtp: number;
  maxTruePeakLinear: number;
  maxSamplePeakDbfs: number;
  truePeakOverloadCount: number;
  digitalClippingEventsCount: number;
  totalClippedSamples: number;
  digitalClicksCount: number;
  anomalousSilenceCount: number;
}

export interface QaScriptCoverageMetrics {
  totalScriptCues: number;
  coveredScriptCues: number;
  missingScriptCues: number;
  coveragePercent: number;
  isFullCoverage: boolean;
}

export interface QaSummary {
  totalIncidents: number;
  errorsCount: number;
  warningsCount: number;
  infoCount: number;
  isBroadcastReady: boolean;
}

export interface QaAuditReport {
  projectId: string;
  projectName: string;
  auditedAt: string;
  sampleRate: number;
  channels: number;
  totalFrames: number;
  durationSeconds: number;
  auditElapsedMs: number;
  passed: boolean;
  summary: QaSummary;
  audioMetrics: QaAudioMetrics;
  scriptCoverage: QaScriptCoverageMetrics;
  incidents: QaIncident[];
}

export interface MasteringStats {
  standardApplied: string;
  initialIntegratedLufs: number;
  initialTruePeakDbtp: number;
  initialLoudnessRangeLu: number;
  targetIntegratedLufs: number;
  finalIntegratedLufs: number;
  finalTruePeakDbtp: number;
  finalLoudnessRangeLu: number;
  truePeakCeilingDbtp: number;
  normalizationGainAppliedDb: number;
  maxGainReductionDb: number;
  totalLimitedEvents: number;
  isCompliant: boolean;
  sampleRate: number;
  channels: number;
  durationSec: number;
  referenceTrackLufs?: number | null;
  outputPath: string;
}

// Замечание или ошибка при контроле качества (QA)
export interface QualityControlIssue {
  id: string;
  type: 'clipping' | 'silence' | 'overlap' | 'missing_sub' | 'lufs_deviation' | 'true_peak' | 'click';
  severity: 'error' | 'warning' | 'info';
  time: number; // секунды на таймлайне
  duration?: number;
  trackName: string;
  segmentId?: string;
  subId?: string;
  title: string;
  description: string;
  fixSuggestion?: string;
  measuredValue?: string;
  isResolved?: boolean;
  rawIncident?: QaIncident;
}

// Результат выполнения финального рендера
export interface FinalRenderResult {
  success: boolean;
  videoBlobUrl?: string;
  videoFileName?: string;
  videoDuration: number;
  stems: Array<{
    id: string;
    name: string;
    format: string;
    blobUrl: string;
    fileName: string;
    sizeBytes: number;
  }>;
  subtitlesFiles: Array<{
    format: 'srt' | 'ass';
    blobUrl: string;
    fileName: string;
  }>;
  qaReport: {
    issuesCount: number;
    errorsCount: number;
    warningsCount: number;
    integratedLufs: number;
    maxTruePeakDb: number;
    passed: boolean;
  };
  durationSeconds: number;
  renderedAt: number;
}

// Этап 4: Финальный рендер и экспорт (Final Mix & Render)
export interface FinalMixConfig {
  enabled: boolean;
  vstSteps?: Record<string, VstStepConfig>;
  
  // 1. Отсмотр и анализ косяков (Quality Control / QA)
  qualityControl: {
    enabled: boolean;
    logClippedSegments: boolean; // логирование клиппинга/перегрузки (> -0.5 dBTP)
    detectLongSilences: boolean; // детекция затянувшейся тишины (> 4 сек)
    detectOverlappingAudios: boolean; // пересечения реплик
    checkMissingSubtitles?: boolean; // поиск пропущенных не озвученных фраз
    lufsTargetCheck?: boolean; // соответствие целевому стандарту громкости
    bypass: boolean;
  };

  // 2. Мастеринг шина и True-Peak лимитер
  masteringLimiter: {
    enabled: boolean;
    truePeakCeilingDb: number; // -1.0 dBTP (стандарт)
    targetIntegratedLufs: number; // -14.0 LUFS (YouTube/Web), -23.0 (EBU R128), -16.0 (Podcast)
    loudnessStandard: 'original_match' | 'youtube_web' | 'ebu_r128' | 'streaming_podcast' | 'custom';
    oversampling: '2x' | '4x' | '8x';
    dither: 'none' | 'tpdf_16bit' | 'tpdf_24bit';
    stereoWidth: number; // 100%
    bypass: boolean;
  };

  // 3. Экспорт стемов (Stem Mixdown)
  stemExport: {
    enabled: boolean;
    exportFullMix: boolean; // Полный сведенный микс (Голос + Музыка/Фон)
    exportCleanVoice: boolean; // Только чистая голосовая дорожка дубляжа
    exportMAndE: boolean; // Чистый M&E (Music & Effects)
    exportPerRoleStems: boolean; // Раздельные дорожки персонажей
    audioFormat: 'wav_24bit_48k' | 'wav_16bit_44k' | 'mp3_320k' | 'flac' | 'aac';
    bypass: boolean;
  };
  
  // 4. Зашивание (впекание) субтитров надписей в видео
  subtitleBurn: {
    enabled: boolean;
    burnMode?: 'hardsub_all' | 'hardsub_signs_only' | 'softsub_stream' | 'none';
    fontName: string;
    fontSize: number;
    fontColor: string; // HEX
    outlineColor?: string; // HEX
    outlineWidth?: number; // px
    boxBackground?: boolean;
    backgroundColor?: string; // HEX с прозрачностью (например, #00000080)
    alignment: 'bottom' | 'top' | 'middle';
    yOffsetPx?: number;
    bypass: boolean;
  };
  
  // 5. Параметры качества рендера
  renderSettings: {
    container?: 'mp4' | 'mkv' | 'mov' | 'audio_only';
    videoCodec: 'h264_nvenc' | 'libx264' | 'hevc_nvenc' | 'copy';
    audioCodec: 'aac' | 'mp3' | 'pcm';
    videoBitrateKbps: number;
    audioBitrateKbps: number;
    resolution: '1080p' | '720p' | '4k' | 'source';
    fps: 'source' | '23.976' | '24' | '25' | '29.97' | '30' | '60';
    preset?: 'ultrafast' | 'fast' | 'medium' | 'slow';
    multiAudioTracks?: boolean; // Мультидорожечный контейнер (Дубляж + Оригинал)
  };
}

// Полный пресет сведения серии
export interface MixingPreset {
  id: string;
  name: string;
  description: string;
  type: MixingType;
  isSystem?: boolean; // Системный (встроенный) или пользовательский пресет
  
  phase1: PrepProcessingConfig;
  phase2: TimingAlignmentConfig;
  phase3: MixingEffectsConfig;
  phase4: FinalMixConfig;

  // Порядок шагов внутри каждой фазы обработки
  phase1Order?: string[];
  phase2Order?: string[];
  phase3Order?: string[];
  phase4Order?: string[];
}

// ============================================================================
// SQLITE NATIVE PROJECT REPOSITORY DTOs
// ============================================================================

export interface AudioClipPayload {
  id: string;
  filePath: string;
  startTimeMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  gainDb: number;
  isActive: boolean;
  backstageVideoPath?: string | null;
}

export interface RackPresetPayload {
  id: string;
  fxChainJson: string;
}

export interface TrackPayload {
  id: string;
  name: string;
  trackType: string;
  volume: number;
  pan: number;
  isMuted: boolean;
  isSolo: boolean;
  orderIndex: number;
  clips: AudioClipPayload[];
  rackPreset?: RackPresetPayload | null;
}

export interface SubtitlePayload {
  id: string;
  characterName: string;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  matchedClipId?: string | null;
}

export interface FullProjectPayload {
  id: string;
  name: string;
  sampleRate: number;
  frameRate: number;
  targetLufs: number;
  createdAt: string;
  updatedAt: string;
  audioOffsetMs: number;
  metadata: Record<string, any>;
  tracks: TrackPayload[];
  subtitles: SubtitlePayload[];
}

export interface ProjectSaveResult {
  projectId: string;
  updatedAt: string;
  canUndo: boolean;
  canRedo: boolean;
  snapshotSequence: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  sampleRate: number;
  frameRate: number;
  targetLufs: number;
  createdAt: string;
  updatedAt: string;
  trackCount: number;
  clipCount: number;
  subtitleCount: number;
}

declare global {
  interface Window {
    electronAPI: {
      openVideo: () => Promise<BridgeResponse<{ path: string, name: string, projectPath: string, size: number }>>;
      createProxyVideo: (videoPath: string, projectPath: string) => Promise<BridgeResponse<string>>;
      openSubtitles: () => Promise<BridgeResponse<{ path: string, name: string, parsed: { roles: string[], subtitles: any[] } }>>;
      extractAudioPeaks: (videoPath: string, projectPath: string) => Promise<BridgeResponse<{ filePath: string, peaks: Float32Array, duration: number }>>;
      saveTake: (data: { projectPath: string, role: string, startTime: number, audioData: Uint8Array }) => Promise<BridgeResponse<{ filePath: string, peaks: Float32Array }>>;
      exportAudio: (options: any) => Promise<BridgeResponse<{ success: boolean }>>;
      renderFinalVideo: (options: {
        originalVideo: string,
        masterDub: string,
        bgVolume: number,
        dubVolume: number,
        outputPath: string,
        title?: string,
        artist?: string,
      }) => Promise<BridgeResponse<{ success: boolean }>>;
      initProject: (projectPath: string) => Promise<BridgeResponse<void>>;
      generateStressTest: (projectId: string, trackId: string, projectPath: string) => Promise<BridgeResponse<void>>;
      loadSegmentsInRange: (trackId: string, startTime: number, endTime: number) => Promise<BridgeResponse<any[]>>;
      saveProjectJson: (data: { projectPath: string, projectData: Project }) => Promise<BridgeResponse<boolean>>;
      loadProjectJson: (projectPath: string) => Promise<BridgeResponse<Project>>;
      copyFileToProject: (src: string, destDir: string) => Promise<BridgeResponse<string>>;
      importLegacyJson: (jsonString: string) => Promise<BridgeResponse<string>>;
      muxVideo: (data: { videoPath: string, audioPath: string, outputPath: string, duration?: number }) => Promise<BridgeResponse<{ success: boolean }>>;
      quickPreviewExport: (data: { projectPath: string, segmentId: string }) => Promise<BridgeResponse<{ success: boolean }>>;
      requestPermissions: () => Promise<BridgeResponse<boolean>>;
      onExportProgress: (callback: (progress: number) => void) => () => void;
      getAudioDevices: () => Promise<BridgeResponse<{ id: string, name: string, host: string, sampleRate: number, channels: number }[]>>;
      startAsioRecording: (device: string, sampleRate: number, bufferSize: number, trackId: string, segmentId: string, startTime: number, hostName?: string, channelIndex?: number, backstageRecord?: boolean, videoDevice?: string | null, audioDevice?: string | null, projectPath?: string | null, gateEnabled?: boolean, gateThreshold?: number, limiterEnabled?: boolean, limiterThreshold?: number) => Promise<BridgeResponse<void>>;
      checkCrashes: () => Promise<BridgeResponse<any[]>>;
      generateWaveformPeaks: (data: { filePath: string, points: number }) => Promise<BridgeResponse<number[]>>;
      getFileInfo: (filePath: string) => Promise<BridgeResponse<{ path: string, name: string, projectPath: string, size: number, duration: number }>>;
      stopAsioRecording: () => Promise<BridgeResponse<{ filePath: string, videoPath?: string, metadata: { peaks: Float32Array, duration: number } }>>;
      openFile: (options: { title: string, filters: { name: string, extensions: string[] }[] }) => Promise<BridgeResponse<{ path: string, name: string, content?: string }>>;
      openFiles: (options: { title: string, filters: { name: string, extensions: string[] }[] }) => Promise<BridgeResponse<{ path: string, name: string }[]>>;
      saveFile: (options: { title: string, defaultPath: string, filters: { name: string, extensions: string[] }[] }) => Promise<BridgeResponse<string>>;
      openFolder: () => Promise<BridgeResponse<string>>;
      getAudioFiles: (folderPath: string) => Promise<BridgeResponse<{ path: string, name: string, duration: number, peaks: number[] }[]>>;
      batchExport: (options: { 
        outDir: string; 
        origSegments: { startTime: number; duration: number; originalFileName: string }[];
        dubSegments: { filePath: string; startTime: number; duration: number; fileOffset: number; gain: number; playbackRate: number }[];
      }) => Promise<BridgeResponse<string[]>>;
      exportAudioBook: (options: any) => Promise<BridgeResponse<{ success: boolean, path?: string }>>;
      exportAllStems: (args: { projectJson: string, outputPath: string }) => Promise<BridgeResponse<string>>;
      exportStems: (options: { projectData: any, outputDir: string, bitDepth?: string }) => Promise<BridgeResponse<string[]>>;
      onStemProgress: (callback: (data: { current: number, total: number, trackName: string }) => void) => () => void;
      onMediaProgress: (callback: (data: { time: string, percent: number, operation: string }) => void) => () => void;
      mergeSegments: (data: { segments: { filePath: string, startTime: number, gain: number }[], outputPath: string }) => Promise<BridgeResponse<{ filePath: string, duration: number, peaks: Float32Array }>>;
      mergeProjectSegments: (data: { projectPath: string, trackId: string, segments: string[] }) => Promise<BridgeResponse<string>>;
      readTextFile: (path: string) => Promise<BridgeResponse<string>>;
      readBinaryFile: (path: string) => Promise<BridgeResponse<Uint8Array>>;
      verifyProjectFiles: (projectId: string, projectRoot: string) => Promise<BridgeResponse<{ missingSegments: any[], orphanedFiles: string[] }>>;
      calculateFileHash: (path: string) => Promise<BridgeResponse<string>>;
      findFileByHash: (searchRoot: string, targetHash: string) => Promise<BridgeResponse<string | null>>;
      relinkSegmentFile: (segmentId: string, newPath: string) => Promise<BridgeResponse<void>>;
      cleanupOrphanedFiles: (files: string[]) => Promise<BridgeResponse<void>>;
      concatBackstageVideos: (data: { videoPaths: string[], outputPath: string, backstageMode?: string, isBackstageEnabled?: boolean }) => Promise<BridgeResponse<string>>;
      exportBackstageVideo: (data: { mainVideoPath: string, backstageVideoPath: string, finalAudioPath: string, outputPath: string, webcamExportOverlay?: boolean }) => Promise<BridgeResponse<string>>;
      moveProject: (oldPath: string, newPath: string) => Promise<BridgeResponse<boolean>>;
      openPath: (path: string) => Promise<BridgeResponse<void>>;
      forceStopAll: () => Promise<BridgeResponse<void>>;
      getMediaInfo: (path: string) => Promise<BridgeResponse<string>>;
      extractMkvAssets: (data: { inputPath: string, videoOutput: string, subOutput?: string, audioIndex: number, subIndex?: number, duration?: number }) => Promise<BridgeResponse<string>>;
      createBlankVideo: (duration: number, outputPath: string) => Promise<BridgeResponse<string>>;
    };
  }
}
