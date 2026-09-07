import { MixingPreset, MixingType } from '../types';

export const DEFAULT_PHASE1_ORDER = [
  'normalization',
  'eqMatching',
  'deClick',
  'dePlosive',
  'deEsser',
  'denoise',
  'dereverb',
  'volumeLeveler',
  'sourceSeparation'
];

export const DEFAULT_PHASE2_ORDER = [
  'silenceSplit',
  'whisper',
  'smartAlign',
  'conflictDetection',
  'subtitleCompliance'
];

export const DEFAULT_PHASE3_ORDER = [
  'gainMatching',
  'ducking',
  'autoFxAnalysis',
  'vocalBusProcessing'
];

export const DEFAULT_PHASE4_ORDER = [
  'qualityControl',
  'subtitleBurn',
  'renderSettings'
];

export const createDefaultPhase1 = (type: MixingType) => ({
  enabled: true,
  vstSteps: {},
  normalization: {
    enabled: type !== MixingType.VOICEOVER,
    targetLufs: type === MixingType.DUBBING ? -23.0 : -16.0,
    noiseFloorDb: -55.0,
    upwardThresholdDb: -35.0,
    upwardRatio: 2.0,
    upwardGainDb: 6.0,
    bypass: false,
  },
  eqMatching: {
    enabled: type === MixingType.DUBBING || type === MixingType.REDUB,
    profileModel: (type === MixingType.DUBBING ? 'reference_match' : 'vocal_presence') as 'flat' | 'vocal_presence' | 'warm_analog' | 'reference_match',
    bypass: false,
  },
  deClick: {
    enabled: type !== MixingType.VOICEOVER,
    sensitivity: type === MixingType.DUBBING ? 65 : 40,
    mouthDeClick: type === MixingType.DUBBING || type === MixingType.REDUB,
    maxClickWidthMs: 2.0,
    detectorType: (type === MixingType.DUBBING || type === MixingType.REDUB ? 'mouth' : 'mechanical') as 'mouth' | 'mechanical' | 'broadband',
    method: 'native_dsp' as 'native_dsp' | 'vst',
    bypass: false,
  },
  dePlosive: {
    enabled: type !== MixingType.VOICEOVER,
    threshold: -18.0,
    frequencyCutoff: 80,
    bypass: false,
  },
  deEsser: {
    enabled: type === MixingType.DUBBING || type === MixingType.REDUB,
    threshold: -20.0,
    frequency: 6500,
    bypass: false,
  },
  denoise: {
    enabled: type !== MixingType.VOICEOVER,
    strength: type === MixingType.DUBBING ? 75 : 50,
    model: (type === MixingType.DUBBING ? 'deep_noise' : 'spectral_gate') as any,
    bypass: false,
  },
  dereverb: {
    enabled: type === MixingType.DUBBING || type === MixingType.REDUB,
    strength: type === MixingType.DUBBING ? 70 : 40,
    model: (type === MixingType.DUBBING ? 'room_cleaner_neural' : 'rt_dereverb_v2') as any,
    bypass: false,
  },
  volumeLeveler: {
    enabled: type !== MixingType.VOICEOVER,
    targetRms: -18.0,
    ratio: 2.0,
    bypass: false,
  },
  sourceSeparation: {
    enabled: type === MixingType.DUBBING || type === MixingType.REDUB,
    model: (type === MixingType.DUBBING ? 'htdemucs_vocals_bgm' : 'uvr_v5_vocal') as any,
    keepSeparatedStems: true,
    bypass: false,
  }
});

export const createDefaultPhase2 = (type: MixingType) => ({
  enabled: true, // Включаем для всех типов, так как даже для закадра нужно синхронизировать старт фраз
  vstSteps: {},
  alignPriority: 'original_voice' as const,
  alignToOriginalStart: true,
  voiceoverLeadMs: 0,
  silenceSplit: {
    enabled: true,
    thresholdDb: -42.0,
    minSilenceDurationMs: type === MixingType.VOICEOVER ? 450 : 350,
    minSegmentDurationMs: 180,
    padSilenceMs: 40,
    bypass: false,
  },
  whisper: {
    enabled: true,
    model: 'auto' as const,
    language: 'ru',
    autoMatchSubtitles: true,
    bypass: false,
  },
  smartAlign: {
    enabled: true,
    alignMode: (type === MixingType.DUBBING ? 'tight' : type === MixingType.REDUB ? 'loose' : 'recast_tolerance') as 'tight' | 'loose' | 'recast_tolerance',
    maxStretchRatio: type === MixingType.DUBBING ? 1.15 : type === MixingType.REDUB ? 1.25 : 1.35,
    algorithm: (type === MixingType.DUBBING ? 'rubberband' : 'wsola') as 'rubberband' | 'wsola' | 'phase_vocoder',
    bypass: false,
  },
  projectTypeRules: {
    ignoreBreathsAndSighsInVO: type === MixingType.VOICEOVER,
    enforceMinSubDuration: type === MixingType.RECAST || type === MixingType.REDUB,
    fullLipSync: type === MixingType.DUBBING,
    maxStretchRatio: type === MixingType.DUBBING ? 1.15 : 1.30,
  },
  conflictDetection: {
    detectOverlaps: true,
    detectGaps: type !== MixingType.VOICEOVER,
    detectShortPhrases: type === MixingType.RECAST || type === MixingType.REDUB,
    autoFixOverlaps: true,
    bypass: false,
  },
  subtitleCompliance: {
    enabled: true,
    checkMissingPhrases: true,
    toleranceMs: 300,
    bypass: false,
  }
});

export const createDefaultPhase3 = (type: MixingType) => ({
  enabled: true,
  vstSteps: {},
  gainMatching: {
    enabled: true,
    targetDifferenceDb: type === MixingType.VOICEOVER ? 3.0 : 0.0,
    bypass: false,
  },
  ducking: {
    enabled: type === MixingType.VOICEOVER || type === MixingType.RECAST,
    duckingDb: type === MixingType.VOICEOVER ? -10 : -15,
    attackMs: 50,
    releaseMs: 350,
    holdMs: 500,
    bypass: false,
  },
  autoFxAnalysis: {
    enabled: type === MixingType.DUBBING || type === MixingType.REDUB,
    detectPanning: type === MixingType.DUBBING || type === MixingType.REDUB,
    detectReverb: type === MixingType.DUBBING || type === MixingType.REDUB,
    detectSpecialFx: type === MixingType.DUBBING,
    applyToDub: true,
    bypass: false,
  },
  vocalBusProcessing: {
    enabled: type === MixingType.DUBBING || type === MixingType.REDUB,
    glueCompressor: {
      enabled: type === MixingType.DUBBING,
      threshold: -16.0,
      ratio: 4.0,
      attackMs: 10,
      releaseMs: 100,
    },
    limiter: {
      enabled: type === MixingType.DUBBING || type === MixingType.REDUB,
      ceilingDb: -1.0,
      releaseMs: 150,
    },
    eq: {
      enabled: type === MixingType.DUBBING,
      lowCutHz: 75,
      highShelfHz: 12000,
    },
    bypass: false,
  }
});

export const createDefaultPhase4 = (type: MixingType) => ({
  enabled: true,
  vstSteps: {},
  qualityControl: {
    enabled: true,
    logClippedSegments: true,
    detectLongSilences: type === MixingType.DUBBING,
    detectOverlappingAudios: true,
    bypass: false,
  },
  subtitleBurn: {
    enabled: false,
    fontName: 'Arial',
    fontSize: 24,
    fontColor: '#FFFFFF',
    backgroundColor: '#00000080',
    alignment: 'bottom' as 'bottom' | 'top' | 'middle',
    bypass: false,
  },
  renderSettings: {
    videoCodec: 'libx264' as 'h264_nvenc' | 'libx264' | 'hevc_nvenc' | 'copy',
    audioCodec: 'aac' as 'aac' | 'mp3' | 'pcm',
    videoBitrateKbps: 5000,
    audioBitrateKbps: 320,
    resolution: '1080p' as '1080p' | '720p' | '4k' | 'source',
    fps: 'source' as 'source' | '30' | '60',
  }
});

export const DEFAULT_MIXING_PRESETS: MixingPreset[] = [
  {
    id: 'preset-voiceover',
    name: 'Закадр (Voiceover)',
    description: 'Быстрое закадровое озвучивание. Запись сводится напрямую с фоновым звуком без сложных эффектов.',
    type: MixingType.VOICEOVER,
    isSystem: true,
    phase1: createDefaultPhase1(MixingType.VOICEOVER),
    phase2: createDefaultPhase2(MixingType.VOICEOVER),
    phase3: createDefaultPhase3(MixingType.VOICEOVER),
    phase4: createDefaultPhase4(MixingType.VOICEOVER),
    phase1Order: [...DEFAULT_PHASE1_ORDER],
    phase2Order: [...DEFAULT_PHASE2_ORDER],
    phase3Order: [...DEFAULT_PHASE3_ORDER],
    phase4Order: [...DEFAULT_PHASE4_ORDER],
  },
  {
    id: 'preset-recast',
    name: 'Рекаст (Recast)',
    description: 'Улучшенный закадр. Длина реплик совпадает с оригиналом, озвучивается базовая физика дыхания и вдохов.',
    type: MixingType.RECAST,
    isSystem: true,
    phase1: createDefaultPhase1(MixingType.RECAST),
    phase2: createDefaultPhase2(MixingType.RECAST),
    phase3: createDefaultPhase3(MixingType.RECAST),
    phase4: createDefaultPhase4(MixingType.RECAST),
    phase1Order: [...DEFAULT_PHASE1_ORDER],
    phase2Order: [...DEFAULT_PHASE2_ORDER],
    phase3Order: [...DEFAULT_PHASE3_ORDER],
    phase4Order: [...DEFAULT_PHASE4_ORDER],
  },
  {
    id: 'preset-redub',
    name: 'Редаб (Redub)',
    description: 'Облегченный дубляж. Базовый липсинг, передача эмоций, совпадение фаз с оригиналом.',
    type: MixingType.REDUB,
    isSystem: true,
    phase1: createDefaultPhase1(MixingType.REDUB),
    phase2: createDefaultPhase2(MixingType.REDUB),
    phase3: createDefaultPhase3(MixingType.REDUB),
    phase4: createDefaultPhase4(MixingType.REDUB),
    phase1Order: [...DEFAULT_PHASE1_ORDER],
    phase2Order: [...DEFAULT_PHASE2_ORDER],
    phase3Order: [...DEFAULT_PHASE3_ORDER],
    phase4Order: [...DEFAULT_PHASE4_ORDER],
  },
  {
    id: 'preset-dubbing',
    name: 'Дубляж (Dubbing)',
    description: 'Максимально детальное сведение. Полное совпадение липсинга, повторение пространственных эффектов, чистка и спектральное шумоподавление.',
    type: MixingType.DUBBING,
    isSystem: true,
    phase1: createDefaultPhase1(MixingType.DUBBING),
    phase2: createDefaultPhase2(MixingType.DUBBING),
    phase3: createDefaultPhase3(MixingType.DUBBING),
    phase4: createDefaultPhase4(MixingType.DUBBING),
    phase1Order: [...DEFAULT_PHASE1_ORDER],
    phase2Order: [...DEFAULT_PHASE2_ORDER],
    phase3Order: [...DEFAULT_PHASE3_ORDER],
    phase4Order: [...DEFAULT_PHASE4_ORDER],
  }
];
