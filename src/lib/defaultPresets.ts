import { MixingPreset, MixingType, MixingEffectsConfig } from '../types';

export const DEFAULT_PHASE1_ORDER = [
  'peakAdjustment',
  'spectralBalancing',
  'speechLeveler',
  'vocalSpotCleaning',
  'eqMatching',
  'deClick',
  'dePlosive',
  'deEsser',
  'denoise',
  'dereverb',
  'volumeLeveler',
  'sourceSeparation',
  'normalization'
];

export const VOICEOVER_PHASE1_ORDER = [
  'peakAdjustment',
  'spectralBalancing',
  'speechLeveler',
  'vocalSpotCleaning',
  'eqMatching',
  'deClick',
  'dePlosive',
  'deEsser',
  'denoise',
  'dereverb',
  'volumeLeveler',
  'normalization'
];

export const DEFAULT_PHASE2_ORDER = [
  'silenceSplit',
  'whisper',
  'smartAlign',
  'conflictDetection',
  'subtitleCompliance'
];

export const VOICEOVER_PHASE2_ORDER = [
  'silenceSplit',
  'conflictDetection'
];

export const DEFAULT_PHASE3_ORDER = [
  'gainMatching',
  'ducking',
  'autoFxAnalysis',
  'vocalBusProcessing'
];

export const VOICEOVER_PHASE3_ORDER = [
  'vocalBusProcessing'
];

export const DEFAULT_PHASE4_ORDER = [
  'qualityControl',
  'masteringLimiter',
  'stemExport',
  'subtitleBurn',
  'renderSettings'
];

export const VOICEOVER_PHASE4_ORDER = [
  'masteringLimiter',
  'renderSettings'
];

export const createDefaultPhase1 = (type: MixingType) => ({
  enabled: true,
  missingModelBehavior: 'fallback_dsp' as const,
  vstSteps: {},
  peakAdjustment: {
    enabled: true, // Первый шаг: безопасная подстройка громкости по самому высокому пику (-9 dBFS)
    targetPeakDb: -9.0,
    bypass: false,
  },
  normalization: {
    enabled: true, // В конце предподготовки: итоговая нормализация EBU R128 до целевого LUFS
    intelligentMode: true, // Интеллектуальный режим на базе полного спектрального анализа и классификации волн
    targetLufs: type === MixingType.DUBBING ? -23.0 : -16.0,
    noiseFloorDb: -55.0,
    upwardThresholdDb: -35.0,
    upwardRatio: 2.0,
    upwardGainDb: 6.0,
    bypass: false,
  },
  spectralBalancing: {
    enabled: true, // Включено: срез <60 Гц и >20 кГц, приведение к усредненной кривой
  },
  speechLeveler: {
    enabled: true, // Включено: компрессия + гейтирование пауз после шумодава
  },
  vocalSpotCleaning: {
    enabled: true, // Включено: точечное подавление DSR, деплосив и кликов
  },
  eqMatching: {
    enabled: true, // Включено: выравнивание АЧХ под дикторский стандарт
    profileModel: (type === MixingType.DUBBING ? 'reference_match' : 'vocal_presence') as 'flat' | 'vocal_presence' | 'warm_analog' | 'reference_match',
    bypass: false,
  },
  deClick: {
    enabled: true, // Включено: удаление щелчков и кликов
    sensitivity: type === MixingType.DUBBING ? 65 : 50,
    mouthDeClick: true,
    maxClickWidthMs: 2.0,
    detectorType: 'mouth' as 'mouth' | 'mechanical' | 'broadband',
    method: 'native_dsp' as 'native_dsp' | 'vst',
    bypass: false,
  },
  dePlosive: {
    enabled: true, // Включено: деплосив (подавление взрывных согласных)
    threshold: -18.0,
    frequencyCutoff: 80,
    bypass: false,
  },
  deEsser: {
    enabled: true, // Включено: DSR (подавление сибилянтов)
    threshold: -20.0,
    frequency: 6500,
    bypass: false,
  },
  denoise: {
    enabled: true, // Включено: шумоподавление
    strength: type === MixingType.DUBBING ? 75 : 65,
    model: (type === MixingType.DUBBING ? 'uvr_denoise_foxjoy' : 'spectral_gate') as any,
    bypass: false,
  },
  dereverb: {
    enabled: true, // Включено: дериверберация
    strength: type === MixingType.DUBBING ? 70 : 45,
    model: (type === MixingType.DUBBING ? 'reverb_foxjoy' : 'rt_dereverb_v2') as any,
    bypass: false,
  },
  volumeLeveler: {
    enabled: true, // Включено: обязательное выравнивание по громкости
    targetRms: -18.0,
    ratio: 2.0,
    bypass: false,
  },
  sourceSeparation: {
    enabled: type === MixingType.DUBBING || type === MixingType.REDUB, // Для закадра разделение отключено
    model: (type === MixingType.DUBBING ? 'htdemucs_vocals_bgm' : 'uvr_v5_vocal') as any,
    keepSeparatedStems: true,
    bypass: type === MixingType.VOICEOVER,
  }
});

export const createDefaultPhase2 = (type: MixingType) => ({
  enabled: true,
  vstSteps: {},
  alignPriority: 'original_voice' as const,
  alignToOriginalStart: type !== MixingType.VOICEOVER,
  voiceoverLeadMs: 0,
  silenceSplit: {
    enabled: true, // Делаем разрез дорожек
    thresholdDb: -35.0, // Порог включения речи (Onset)
    offsetThresholdDb: -45.0, // Порог выключения речи с гистерезисом (Offset)
    minSilenceDurationMs: type === MixingType.VOICEOVER ? 350 : 300,
    minSegmentDurationMs: 200,
    paddingPreMs: 80,
    paddingPostMs: 150,
    padSilenceMs: 80,
    exportClips: false,
    bypass: false,
  },
  whisper: {
    enabled: type !== MixingType.VOICEOVER, // Для закадра отключено
    model: 'auto' as const,
    language: 'ru',
    autoMatchSubtitles: true,
    bypass: type === MixingType.VOICEOVER,
  },
  smartAlign: {
    enabled: type !== MixingType.VOICEOVER, // Для закадра отключено
    alignMode: (type === MixingType.DUBBING ? 'tight' : type === MixingType.REDUB ? 'loose' : 'recast_tolerance') as 'tight' | 'loose' | 'recast_tolerance',
    maxStretchRatio: type === MixingType.DUBBING ? 1.15 : type === MixingType.REDUB ? 1.25 : 1.35,
    algorithm: (type === MixingType.DUBBING ? 'rubberband' : 'wsola') as 'rubberband' | 'wsola' | 'phase_vocoder',
    bypass: type === MixingType.VOICEOVER,
  },
  projectTypeRules: {
    ignoreBreathsAndSighsInVO: true,
    enforceMinSubDuration: type === MixingType.RECAST || type === MixingType.REDUB,
    fullLipSync: type === MixingType.DUBBING,
    maxStretchRatio: type === MixingType.DUBBING ? 1.15 : 1.30,
  },
  conflictDetection: {
    detectOverlaps: true, // Делаем так, чтобы дорожки друг другу не мешали
    detectGaps: type !== MixingType.VOICEOVER,
    detectShortPhrases: type === MixingType.RECAST || type === MixingType.REDUB,
    autoFixOverlaps: true, // Авто-исправление наездов дорожек друг на друга
    bypass: false,
  },
  subtitleCompliance: {
    enabled: type !== MixingType.VOICEOVER, // Для закадра отключено
    checkMissingPhrases: type !== MixingType.VOICEOVER,
    toleranceMs: 300,
    bypass: type === MixingType.VOICEOVER,
  }
});

export const createDefaultPhase3 = (type: MixingType): MixingEffectsConfig => ({
  enabled: true,
  vstSteps: {},
  gainMatching: {
    enabled: type !== MixingType.VOICEOVER, // Для закадра: соответствие громкости не смотрим, отключено
    targetDifferenceDb: type === MixingType.VOICEOVER ? 3.0 : 0.0,
    targetDialogueLufs: type === MixingType.VOICEOVER ? -16.0 : -18.0,
    physicsOffsetDb: -10.0,
    measurementMethod: 'lufs' as const,
    autoTagCategories: true,
    bypass: type === MixingType.VOICEOVER,
  },
  ducking: {
    enabled: type !== MixingType.VOICEOVER, // Для закадра дакинг отключен
    duckingDb: type === MixingType.VOICEOVER ? -16 : (type === MixingType.RECAST ? -24 : -96),
    attackMs: 100,
    releaseMs: 350,
    holdMs: 150,
    lookaheadMs: 50,
    fadeDownMs: 100,
    meDuckingDb: -1.5,
    targetStem: 'separated_voice' as const,
    recastDuckingDb: -24,
    dubbingDuckingDb: -96,
    voiceoverDuckingDb: -16,
    bypass: type === MixingType.VOICEOVER,
  },
  autoFxAnalysis: {
    enabled: false, // Пользователь: "мы не смотрим на эффекты, мы не делаем эффекты вообще"
    detectPanning: type === MixingType.DUBBING,
    detectReverb: type === MixingType.DUBBING || type === MixingType.REDUB,
    detectDelay: type === MixingType.DUBBING,
    detectSpecialFx: type === MixingType.DUBBING,
    sensitivity: 75,
    applyToDub: true,
    applyToTracks: 'all_dub' as const,
    bypass: true,
  },
  vocalBusProcessing: {
    enabled: true, // "У нас только один — это наша цепочка обработки"
    mode: 'rustDsp' as const,
    useRustDsp: true,
    nativeRack: {
      presetName: 'Студийная цепочка закадра (Studio Voiceover Rack)',
      bypass: false,
      eq: {
        enabled: true,
        hpfCutoffHz: 80,
        hpfOrder: 2,
        notchEnabled: true,
        notchFreqHz: 3200,
        notchQ: 7.0,
        notchGainDb: -4.0,
      },
      deesser: {
        enabled: true,
        frequencyHz: 6500,
        thresholdDb: -22.0,
        ratio: 4.0,
        attackMs: 1.5,
        releaseMs: 50.0,
        kneeWidthDb: 4.0,
        maxReductionDb: -12.0,
        mode: 'splitBand' as const,
      },
      saturation: {
        enabled: true,
        driveDb: 2.5,
        blend: 0.25,
        warmthBias: 0.12,
        autoGain: true,
      },
      compressor: {
        enabled: true,
        thresholdDb: -18.0,
        ratio: 2.5,
        attackMs: 25.0,
        releaseMs: 120.0,
        kneeWidthDb: 6.0,
        makeupGainDb: 2.0,
        optoCharacter: true,
      },
      exciter: {
        enabled: true,
        airFreqHz: 11000,
        airGainDb: 2.0,
        harmonicDrive: 0.15,
        airBlend: 0.60,
      },
      limiter: {
        enabled: true,
        ceilingDbtp: -1.0,
        releaseMs: 60.0,
        lookaheadMs: 1.5,
      },
    },
    vstRack: {
      presetName: 'Пользовательская цепочка VST',
      bypass: false,
      masterMix: 1.0,
      masterGainDb: 0.0,
      plugins: [],
    },
    glueCompressor: {
      enabled: false,
      threshold: -16.0,
      ratio: 4.0,
      attackMs: 10,
      releaseMs: 100,
    },
    limiter: {
      enabled: true,
      ceilingDb: -1.0,
      releaseMs: 150,
    },
    eq: {
      enabled: true,
      lowCutHz: 80,
      highShelfHz: 12000,
    },
    bypass: false,
  }
});

export const createDefaultPhase4 = (type: MixingType) => ({
  enabled: true,
  vstSteps: {},
  qualityControl: {
    enabled: type !== MixingType.VOICEOVER, // Для закадра пропускаем лишние проверки пауз/субтитров
    logClippedSegments: true,
    detectLongSilences: false,
    detectOverlappingAudios: true,
    checkMissingSubtitles: false,
    lufsTargetCheck: false,
    bypass: type === MixingType.VOICEOVER,
  },
  masteringLimiter: {
    enabled: true, // "И дальше только делаем финальный рендер видео с нашей мастер-мастерингом и трупик-лимитером. Причём мы не делаем мастеринг, мы делаем только лимитер."
    truePeakCeilingDb: -1.0, // Чтобы дорожки не вылезали по громкости за оригинал
    targetIntegratedLufs: -16.0,
    loudnessStandard: 'youtube_web' as const,
    oversampling: '4x' as const,
    dither: 'tpdf_24bit' as const,
    stereoWidth: 100, // Без мастерингового расширения стереобазы, только лимитер
    bypass: false,
  },
  stemExport: {
    enabled: type !== MixingType.VOICEOVER,
    exportFullMix: true,
    exportCleanVoice: false,
    exportMAndE: false,
    exportPerRoleStems: false,
    audioFormat: 'wav_24bit_48k' as const,
    bypass: type === MixingType.VOICEOVER,
  },
  subtitleBurn: {
    enabled: false,
    burnMode: 'hardsub_signs_only' as const,
    fontName: 'Arial',
    fontSize: 24,
    fontColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 2,
    boxBackground: false,
    backgroundColor: '#00000080',
    alignment: 'bottom' as const,
    yOffsetPx: 30,
    bypass: true,
  },
  renderSettings: {
    container: 'mp4' as const,
    videoCodec: 'libx264' as const,
    audioCodec: 'aac' as const,
    videoBitrateKbps: 6000,
    audioBitrateKbps: 320,
    resolution: '1080p' as const,
    fps: 'source' as const,
    preset: 'medium' as const,
    multiAudioTracks: false,
  }
});

export const DEFAULT_MIXING_PRESETS: MixingPreset[] = [
  {
    id: 'preset-voiceover',
    name: 'Закадр (Voiceover)',
    description: 'Запись (быстрая), не требующая особых эмоциональных вложений, сводится без эффектов.',
    type: MixingType.VOICEOVER,
    isSystem: true,
    phase1: createDefaultPhase1(MixingType.VOICEOVER),
    phase2: createDefaultPhase2(MixingType.VOICEOVER),
    phase3: createDefaultPhase3(MixingType.VOICEOVER),
    phase4: createDefaultPhase4(MixingType.VOICEOVER),
    phase1Order: [...VOICEOVER_PHASE1_ORDER],
    phase2Order: [...VOICEOVER_PHASE2_ORDER],
    phase3Order: [...VOICEOVER_PHASE3_ORDER],
    phase4Order: [...VOICEOVER_PHASE4_ORDER],
  },
  {
    id: 'preset-recast',
    name: 'Рекаст (Recast)',
    description: 'Технология, представляющая собой улучшенный вариант закадрового озвучивания. Длина переведенных реплик в рекасте соответствует длине реплик в оригинале, озвученные фразы совпадают с оригинальными по началу и концу (допускаются небольшие отклонения в синхронизации внутри длинных фраз). В рекасте озвучивается физика, прилегающая к фразам (вдохи, охи и т.п.).',
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
    description: 'Под дубляж. Липсинг по губам (с допущением небольших отклонений), эмоции, озвученные фразы совпадают с оригинальными по началу и концу, озвучивается лёгкая физика.',
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
    description: 'Полное сведение эффектов, полное повторение эмоций и озвученного, полный повтор липсинга за губами персонажа.',
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
