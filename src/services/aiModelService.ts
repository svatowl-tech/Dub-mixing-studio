import { listen, UnlistenFn } from '@tauri-apps/api/event';

export const safeInvoke = async <T = any>(cmd: string, args?: any): Promise<T> => {
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) {
    throw new Error('Tauri API недоступна в браузере');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<T>(cmd, args);
};

export type ModelCategory = 'separation' | 'dereverb' | 'denoise' | 'whisper' | 'vocal_match';

export interface ModelCatalogItem {
  id: string;
  name: string;
  filename: string;
  category: ModelCategory;
  description: string;
  size_mb: number;
  recommended_for: string;
  urls: string[];
  is_installed: boolean;
  installed_bytes?: number;
  local_path?: string;
}

export interface ModelDownloadProgress {
  id: string;
  filename: string;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
  status: 'starting' | 'downloading' | 'verifying' | 'completed' | 'error' | 'cancelled';
  error_message?: string;
}

// Fallback каталог для веб-превью и автономного режима
export const FALLBACK_CATALOG: ModelCatalogItem[] = [
  // 1. Separation
  {
    id: 'uvr_mdx_voc_ft',
    name: 'UVR-MDX-NET Voc_FT',
    filename: 'UVR-MDX-NET-Voc_FT.onnx',
    category: 'separation',
    description: 'Золотой стандарт изоляции вокала. Быстрое извлечение чистого голоса без артефактов.',
    size_mb: 60.5,
    recommended_for: 'Основная модель для отделения голоса дубляжа от оригинальной дорожки',
    urls: [
      'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx',
      'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Voc_FT.onnx',
      'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-MDX-NET-Voc_FT.onnx'
    ],
    is_installed: false
  },
  {
    id: 'uvr_mdx_inst_hq3',
    name: 'UVR-MDX-NET Inst_HQ_3',
    filename: 'UVR-MDX-NET-Inst_HQ_3.onnx',
    category: 'separation',
    description: 'Высокоточное удаление вокала и извлечение фонограммы / минусовки / SFX.',
    size_mb: 60.5,
    recommended_for: 'Подготовка фоновой музыки и шумов (M&E) для подмешивания дубляжа',
    urls: [
      'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx',
      'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Inst_HQ_3.onnx',
      'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx'
    ],
    is_installed: false
  },
  {
    id: 'kim_vocal_2',
    name: 'Kim Vocal 2 (MDX-Net)',
    filename: 'Kim_Vocal_2.onnx',
    category: 'separation',
    description: 'Специализированная модель с минимальным просачиванием бэков и тяжелых синтов.',
    size_mb: 65.2,
    recommended_for: 'Сложные саундтреки с хором, дабстепом и плотным фоном',
    urls: [
      'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx',
      'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/Kim_Vocal_2.onnx',
      'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/Kim_Vocal_2.onnx'
    ],
    is_installed: false
  },
  {
    id: 'htdemucs_ft',
    name: 'HTDemucs v4 Fine-Tuned',
    filename: 'htdemucs_ft.yaml',
    category: 'separation',
    description: 'Гибридный трансформер Demucs: делит дорожку на 4 изолированных стема (вокал, бас, барабаны, прочее).',
    size_mb: 79.8,
    recommended_for: 'Глубокая многодорожечная реставрация фильма и видеоряда',
    urls: [
      'https://huggingface.co/dokodesuka/htdemucs_ft/resolve/main/htdemucs_ft.yaml',
      'https://raw.githubusercontent.com/facebookresearch/demucs/main/demucs/remote/htdemucs_ft.yaml'
    ],
    is_installed: false
  },
  {
    id: 'htdemucs',
    name: 'HTDemucs v4 Standard',
    filename: 'htdemucs.yaml',
    category: 'separation',
    description: 'Стандартная универсальная модель Demucs для быстрого разделения трека.',
    size_mb: 79.8,
    recommended_for: 'Универсальное разделение мультфильмов и сериалов',
    urls: [
      'https://raw.githubusercontent.com/facebookresearch/demucs/main/demucs/remote/htdemucs.yaml'
    ],
    is_installed: false
  },
  {
    id: 'htdemucs_vocals_bgm',
    name: 'HTDemucs Vocals + BGM',
    filename: 'htdemucs_vocals_bgm.yaml',
    category: 'separation',
    description: 'Оптимизированная версия Demucs для быстрой изоляции вокала от фона.',
    size_mb: 79.8,
    recommended_for: 'Экспресс-разделение дубляжа и фоновой музыки',
    urls: [
      'https://raw.githubusercontent.com/facebookresearch/demucs/main/demucs/remote/htdemucs_ft.yaml'
    ],
    is_installed: false
  },
  {
    id: 'mdx23c_8step',
    name: 'MDX23C 8-Step Vocal FT',
    filename: 'MDX23C-8Step-VocFT.onnx',
    category: 'separation',
    description: 'Высокоточная модель MDX23C для удаления инструментала и бэк-вокала.',
    size_mb: 115.0,
    recommended_for: 'Вокальные треки с плотным инструментальным сопровождением',
    urls: [
      'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDX23C/MDX23C-8Step-VocFT.onnx'
    ],
    is_installed: false
  },
  {
    id: 'hp_karaoke_uvr',
    name: '5_HP Karaoke UVR',
    filename: '5_HP-Karaoke-UVR.onnx',
    category: 'separation',
    description: 'Специализированный алгоритм извлечения чистого минуса и караоке.',
    size_mb: 60.5,
    recommended_for: 'Создание качественной фонограммы без остатков бэк-вокала',
    urls: [
      'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/5_HP-Karaoke-UVR.onnx'
    ],
    is_installed: false
  },
  {
    id: 'mel_band_roformer_vocals',
    name: 'Mel-Band Roformer Vocals',
    filename: 'mel_band_roformer_vocals_fv2.ckpt',
    category: 'separation',
    description: 'SOTA модель нейро-сепарации нового поколения. Максимальный SNR и натуральный верхний диапазон.',
    size_mb: 182.0,
    recommended_for: 'Профессиональный студийный мастеринг и бескомпромиссная чистота голоса',
    urls: [
      'https://huggingface.co/KimberleyJSN/melbandroformer/resolve/main/MelBandRoformer.ckpt',
      'https://huggingface.co/anvuew/MelBandRoformer/resolve/main/MelBandRoformer.ckpt'
    ],
    is_installed: false
  },
  {
    id: 'bs_roformer_viperx',
    name: 'BS-Roformer Viperx 1297',
    filename: 'aufr33_jarredou_BS_Roformer.ckpt',
    category: 'separation',
    description: 'Улучшенная архитектура Roformer с оптимизацией фазового отклика.',
    size_mb: 171.5,
    recommended_for: 'Кинематографические миксы с объемной звуковой сценой',
    urls: [
      'https://huggingface.co/anvuew/BS-RoFormer/resolve/main/bs_roformer_anvuew_sdr_12.45.ckpt',
      'https://huggingface.co/jarredou/aufr33-jarredou_BS-Roformer_Viperx_1297/resolve/main/model.ckpt'
    ],
    is_installed: false
  },

  // 2. Dereverb
  {
    id: 'reverb_foxjoy',
    name: 'Reverb HQ (FoxJoy)',
    filename: 'Reverb_HQ_By_FoxJoy.onnx',
    category: 'dereverb',
    description: 'Студийное устранение комнатного эха, реверберационных хвостов и ранних переотражений.',
    size_mb: 64.8,
    recommended_for: 'Дикторские записи, сделанные в обычных не заглушенных комнатах',
    urls: [
      'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Reverb_HQ_By_FoxJoy.onnx',
      'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/Reverb_HQ_By_FoxJoy.onnx',
      'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/Reverb_HQ_By_FoxJoy.onnx'
    ],
    is_installed: false
  },
  {
    id: 'uvr_deecho_normal',
    name: 'UVR De-Echo Normal',
    filename: 'UVR-De-Echo-Normal.pth',
    category: 'dereverb',
    description: 'Мягкое подавление порхающего эха без истончения низких и средних частот.',
    size_mb: 44.5,
    recommended_for: 'Легкое эхо в помещениях со шторами и коврами',
    urls: [
      'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-De-Echo-Normal.pth',
      'https://huggingface.co/Delik/uvr5_weights/resolve/main/VR-DeEchoNormal.pth'
    ],
    is_installed: false
  },
  {
    id: 'uvr_deecho_aggressive',
    name: 'UVR De-Echo Aggressive',
    filename: 'UVR-De-Echo-Aggressive.pth',
    category: 'dereverb',
    description: 'Агрессивное удаление жесткого эха от голых стен, стекла и плитки.',
    size_mb: 44.5,
    recommended_for: 'Записи в пустых помещениях и сложных акустических условиях',
    urls: [
      'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-De-Echo-Aggressive.pth',
      'https://huggingface.co/Delik/uvr5_weights/resolve/main/VR-DeEchoAggressive.pth'
    ],
    is_installed: false
  },
  {
    id: 'mdx_dereverb_room',
    name: 'MDX Room DeReverb',
    filename: 'UVR-DeEcho-DeReverb.pth',
    category: 'dereverb',
    description: 'Устранение специфического «коробочного» резонанса комнат малого объема.',
    size_mb: 55.2,
    recommended_for: 'Очистка записей с накамерных и петличных микрофонов',
    urls: [
      'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-DeEcho-DeReverb.pth'
    ],
    is_installed: false
  },

  // 3. Denoise
  {
    id: 'uvr_denoise_foxjoy',
    name: 'VR-DeNoise FoxJoy (Вокал / Речь)',
    filename: 'VR-DeNoise-FoxJoy.onnx',
    category: 'denoise',
    description: 'Флагманская модель FoxJoy для глубокой очистки речевого вокала от фонового шума.',
    size_mb: 44.8,
    recommended_for: 'Основной выбор для профессиональной очистки дикторских дорожек',
    urls: [
      'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/VR-DeNoise-FoxJoy.onnx',
      'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/VR-DeNoise-FoxJoy.onnx'
    ],
    is_installed: false
  },
  {
    id: 'deepfilternet3',
    name: 'DeepFilterNet 3 ONNX',
    filename: 'df_dec.onnx',
    category: 'denoise',
    description: 'Инновационный перцептивный шумоподавитель на базе глубоких сверточных сетей.',
    size_mb: 25.4,
    recommended_for: 'Быстрая высококачественная очистка речи без металлического призвука',
    urls: [
      'https://huggingface.co/niobures/DeepFilterNet/resolve/main/models/onnx/Audio-Cleaner/df_dec.onnx'
    ],
    is_installed: false
  },
  {
    id: 'uvr_denoise_full',
    name: 'UVR-DeNoise Full (Глубокое подавление)',
    filename: 'UVR-DeNoise-Full.onnx',
    category: 'denoise',
    description: 'Бескомпромиссная глубокая очистка сложного шипящего и гудящего шума.',
    size_mb: 52.0,
    recommended_for: 'Сильно зашумленные репортажные и архивные аудиозаписи',
    urls: [
      'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-DeNoise-Full.onnx'
    ],
    is_installed: false
  },
  {
    id: 'uvr_denoise_lite',
    name: 'VR-DeNoise Lite (Быстрая очистка)',
    filename: 'UVR-DeNoise-Lite.onnx',
    category: 'denoise',
    description: 'Легкая модель для оперативного подавления постоянного шума с низким расходом ресурсов.',
    size_mb: 28.5,
    recommended_for: 'Быстрый рендеринг на слабых видеокартах и процессорах',
    urls: [
      'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-DeNoise-Lite.onnx'
    ],
    is_installed: false
  },
  {
    id: 'cascade_net',
    name: 'Cascade-Net Dual Denoise',
    filename: 'cascade_net.onnx',
    category: 'denoise',
    description: 'Двухкаскадный нейрофильтр шума для тяжелых промышленных и уличных шумов.',
    size_mb: 64.0,
    recommended_for: 'Уличный шум, кондиционеры и толпа на заднем плане',
    urls: [
      'https://huggingface.co/niobures/DeepFilterNet/resolve/main/models/onnx/Audio-Cleaner/cascade_net.onnx'
    ],
    is_installed: false
  },
  {
    id: 'uvr_denoise',
    name: 'UVR DeNoise HQ',
    filename: 'UVR-DeNoise.pth',
    category: 'denoise',
    description: 'Глубокое нейросетевое шумоподавление фонового гула, шума вентиляторов и шипения.',
    size_mb: 44.8,
    recommended_for: 'Основное шумоподавление при подготовке вокала к сведению',
    urls: [
      'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-DeNoise.pth'
    ],
    is_installed: false
  },
  {
    id: 'silero_vad',
    name: 'Silero Voice Activity Detector',
    filename: 'silero_vad.onnx',
    category: 'denoise',
    description: 'Нейросетевой детектор голосовой активности. Точно находит границы слов и пауз.',
    size_mb: 1.8,
    recommended_for: 'Автоматическая нарезка дорожек на реплики и удаление фонового шума в паузах',
    urls: [
      'https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx',
      'https://huggingface.co/snakers4/silero-vad/resolve/main/silero_vad.onnx'
    ],
    is_installed: false
  },
  {
    id: 'rnnoise_neural',
    name: 'RNNoise Neural Gate',
    filename: 'rnn_model.onnx',
    category: 'denoise',
    description: 'Сверхлегкий рекуррентный фильтр шума в реальном времени с нулевой задержкой.',
    size_mb: 1.5,
    recommended_for: 'Мониторинг при записи и быстрый гейтинг на слабых ПК',
    urls: [
      'https://huggingface.co/niobures/RNNoise/resolve/main/models/ailia-models/rnn_model.onnx'
    ],
    is_installed: false
  },

  // 4. Whisper
  {
    id: 'whisper_tiny',
    name: 'Whisper Tiny GGML',
    filename: 'ggml-tiny.bin',
    category: 'whisper',
    description: 'Быстрое распознавание речи с минимальным расходом ресурсов.',
    size_mb: 74.8,
    recommended_for: 'Моментальная черновая транскрибация и выравнивание таймингов',
    urls: [
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
    ],
    is_installed: false
  },
  {
    id: 'whisper_base',
    name: 'Whisper Base GGML',
    filename: 'ggml-base.bin',
    category: 'whisper',
    description: 'Оптимальный баланс скорости и точности для дубляжа и синхронизации субтитров.',
    size_mb: 141.5,
    recommended_for: 'Рекомендуемая модель по умолчанию для мультиязычного дубляжа',
    urls: [
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
    ],
    is_installed: false
  },
  {
    id: 'whisper_small',
    name: 'Whisper Small GGML',
    filename: 'ggml-small.bin',
    category: 'whisper',
    description: 'Повышенная точность для зашумленной речи, акцентов и сложных терминов.',
    size_mb: 466.0,
    recommended_for: 'Точная укладка текста при дубляже документальных фильмов и диалогов',
    urls: [
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin'
    ],
    is_installed: false
  },
  {
    id: 'whisper_medium',
    name: 'Whisper Medium GGML',
    filename: 'ggml-medium.bin',
    category: 'whisper',
    description: 'Высокоточная многоязычная модель для профессиональной расшифровки диалогов.',
    size_mb: 1530.0,
    recommended_for: 'Сложные звуковые дорожки со специфической лексикой',
    urls: [
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin'
    ],
    is_installed: false
  },
  {
    id: 'whisper_large_turbo',
    name: 'Whisper Large v3 Turbo',
    filename: 'ggml-large-v3-turbo.bin',
    category: 'whisper',
    description: 'Топовая нейромодель Whisper v3 Turbo. Максимальная точность пунктуации и таймкодов.',
    size_mb: 1620.0,
    recommended_for: 'Студийная автоматическая транскрипция с идеальной точностью',
    urls: [
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'
    ],
    is_installed: false
  },

  // 5. Vocal Match
  {
    id: 'vocal_spectral_matcher',
    name: 'Matchering Vocal Curve Matcher',
    filename: 'vocal_spectral_matcher.onnx',
    category: 'vocal_match',
    description: 'Встроенный нативный 4096-точечный FFT алгоритм сопоставления спектральных кривых (vocal_presence / warm_analog / reference). Встроен в движок программы.',
    size_mb: 0.0,
    recommended_for: 'Подгонка тембра голоса дублера под оригинального актера фильма (не требует внешней загрузки)',
    urls: [],
    is_installed: true,
    installed_bytes: 1024,
    local_path: 'built-in-dsp'
  },
  {
    id: 'voicefixer_fe',
    name: 'VoiceFixer Harmonic Restorer',
    filename: 'vf.ckpt',
    category: 'vocal_match',
    description: 'Восстановление потерянных высоких частот (air-band), выравнивание формант и динамическая сатурация вокала.',
    size_mb: 112.0,
    recommended_for: 'Придание вокалу дорогого студийного «лампового» блеска перед сведением',
    urls: [
      'https://huggingface.co/cqchangm/voicefixer/resolve/main/vf.ckpt'
    ],
    is_installed: false
  },
  {
    id: 'vocal_timbre_transfer',
    name: 'Neural Timbre & Dynamic Transfer',
    filename: 'vocal_timbre_transfer.onnx',
    category: 'vocal_match',
    description: 'Сравнение спектра и перенос тембрального баланса дубляжа к референсу оригинальной дорожки через нативное DSP-ядро.',
    size_mb: 0.0,
    recommended_for: 'Бесшовное вклеивание переозвученных реплик в исходный микс (встроено в DSP)',
    urls: [],
    is_installed: true,
    installed_bytes: 1024,
    local_path: 'built-in-dsp'
  }
];

export class AIModelService {
  private static instance: AIModelService;
  private listeners: Array<(models: ModelCatalogItem[]) => void> = [];
  private cachedModels: ModelCatalogItem[] = [...FALLBACK_CATALOG];
  private unlistenProgress: UnlistenFn | null = null;
  private activeProgress: Map<string, ModelDownloadProgress> = new Map();

  private constructor() {
    this.initEventListeners();
    this.refreshModels();
  }

  public static getInstance(): AIModelService {
    if (!AIModelService.instance) {
      AIModelService.instance = new AIModelService();
    }
    return AIModelService.instance;
  }

  private async initEventListeners() {
    try {
      if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
        this.unlistenProgress = await listen<ModelDownloadProgress>('model_download_progress', (event) => {
          const payload = event.payload;
          this.activeProgress.set(payload.id, payload);

          if (payload.status === 'completed' || payload.status === 'error' || payload.status === 'cancelled') {
            this.refreshModels();
          }
          this.notifyListeners();
        });
      }
    } catch (e) {
      console.warn('[AIModelService] Не удалось подписаться на Tauri events:', e);
    }
  }

  public subscribe(listener: (models: ModelCatalogItem[]) => void): () => void {
    this.listeners.push(listener);
    listener(this.cachedModels);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener([...this.cachedModels]);
      } catch (err) {
        console.error('[AIModelService] Ошибка в слушателе:', err);
      }
    }
  }

  public async refreshModels(): Promise<ModelCatalogItem[]> {
    try {
      const nativeModels = await safeInvoke<ModelCatalogItem[]>('get_available_models_info');
      if (Array.isArray(nativeModels) && nativeModels.length > 0) {
        this.cachedModels = nativeModels;
      } else {
        // Проверяем сохраненные статусы в локальном хранилище для веб-режима
        const saved = localStorage.getItem('dub_installed_models');
        if (saved) {
          const installedSet = new Set<string>(JSON.parse(saved));
          this.cachedModels = FALLBACK_CATALOG.map((m) => ({
            ...m,
            is_installed: installedSet.has(m.id) || installedSet.has(m.filename)
          }));
        }
      }
    } catch (err) {
      console.warn('[AIModelService] safeInvoke get_available_models_info failed, using fallback catalog:', err);
    }

    this.notifyListeners();
    return this.cachedModels;
  }

  public getModels(): ModelCatalogItem[] {
    return [...this.cachedModels];
  }

  public getModelsByCategory(category: ModelCategory): ModelCatalogItem[] {
    return this.cachedModels.filter((m) => m.category === category);
  }

  public getModelInfo(idOrFilename: string): ModelCatalogItem | undefined {
    if (!idOrFilename) return undefined;
    const clean = idOrFilename.trim().toLowerCase().replace(/\.(onnx|pth|bin|ckpt|yaml)$/i, '').replace(/[-_]/g, '');
    return this.cachedModels.find((m) => {
      const mId = m.id.toLowerCase().replace(/[-_]/g, '');
      const mFile = m.filename.toLowerCase().replace(/\.(onnx|pth|bin|ckpt|yaml)$/i, '').replace(/[-_]/g, '');
      const mName = m.name.toLowerCase().replace(/[-_\s]/g, '');
      return mId === clean || mFile === clean || clean === mId || clean === mFile || mName.includes(clean);
    });
  }

  public isModelInstalled(idOrFilename: string): boolean {
    if (!idOrFilename) return false;
    const builtInDSP = [
      'spectral_gate', 'deep_noise', 'intel_ai_denoise',
      'rt_dereverb_v2', 'room_cleaner_neural', 'adaptive_gate',
      'fast_dsp_splitter', 'vocal_spectral_matcher', 'vocal_timbre_transfer',
      'web-stt', 'auto'
    ];
    if (builtInDSP.includes(idOrFilename.trim().toLowerCase())) {
      return true;
    }

    const clean = idOrFilename.trim().toLowerCase().replace(/\.(onnx|pth|bin|ckpt|yaml)$/i, '').replace(/[-_]/g, '');
    const item = this.cachedModels.find((m) => {
      const mId = m.id.toLowerCase().replace(/[-_]/g, '');
      const mFile = m.filename.toLowerCase().replace(/\.(onnx|pth|bin|ckpt|yaml)$/i, '').replace(/[-_]/g, '');
      const mName = m.name.toLowerCase().replace(/[-_\s]/g, '');
      return mId === clean || mFile === clean || mName.includes(clean) || clean.includes(mId) || clean.includes(mFile);
    });
    return item ? Boolean(item.is_installed) : false;
  }

  public async checkModelInstalled(idOrFilename: string): Promise<boolean> {
    if (!idOrFilename) return false;
    try {
      const res = await safeInvoke<boolean>('check_model_installed', { filename: idOrFilename });
      if (typeof res === 'boolean') {
        if (res) {
          // Update cached state
          const m = this.cachedModels.find(item => item.id === idOrFilename || item.filename === idOrFilename);
          if (m) m.is_installed = true;
        }
        return res;
      }
    } catch {
      // Fall back to local/cached check
    }
    return this.isModelInstalled(idOrFilename);
  }

  public getDownloadProgress(modelId: string): ModelDownloadProgress | undefined {
    return this.activeProgress.get(modelId);
  }

  public async downloadModel(modelId: string, customUrl?: string): Promise<string> {
    const model = this.cachedModels.find((m) => m.id === modelId || m.filename === modelId);
    if (!model) {
      throw new Error(`Модель с идентификатором '${modelId}' не найдена`);
    }

    // Встроенные DSP-алгоритмы не требуют сетевой загрузки
    if (model.local_path === 'built-in-dsp' || model.id === 'vocal_spectral_matcher' || model.id === 'vocal_timbre_transfer') {
      model.is_installed = true;
      model.local_path = 'built-in-dsp';
      this.notifyListeners();
      return 'built-in-dsp';
    }

    const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

    if (isTauri) {
      try {
        const result = await safeInvoke<string>('download_ai_model', {
          modelId: model.id,
          customUrl: customUrl || null
        });

        if (result) {
          await this.refreshModels();
          return result;
        }
      } catch (e: any) {
        console.error('[AIModelService] Native download error:', e);
        const errMsg = typeof e === 'string' ? e : (e?.message || 'Ошибка загрузки модели через нативный движок');
        this.activeProgress.set(model.id, {
          id: model.id,
          filename: model.filename,
          downloaded_bytes: 0,
          total_bytes: Math.floor(model.size_mb * 1024 * 1024),
          percent: 0,
          status: 'error',
          error_message: errMsg
        });
        this.notifyListeners();
        throw new Error(errMsg);
      }
    }

    // Fallback: симуляция скачивания в веб-режиме (только для браузерного превью без Tauri)
    return new Promise((resolve) => {
      let progress = 0;
      const interval = setInterval(() => {
        progress += 15;
        this.activeProgress.set(model.id, {
          id: model.id,
          filename: model.filename,
          downloaded_bytes: Math.floor((model.size_mb * 1024 * 1024 * progress) / 100),
          total_bytes: Math.floor(model.size_mb * 1024 * 1024),
          percent: Math.min(progress, 100),
          status: progress >= 100 ? 'completed' : 'downloading'
        });
        this.notifyListeners();

        if (progress >= 100) {
          clearInterval(interval);
          model.is_installed = true;
          const saved = localStorage.getItem('dub_installed_models');
          const installedSet = new Set<string>(saved ? JSON.parse(saved) : []);
          installedSet.add(model.id);
          installedSet.add(model.filename);
          localStorage.setItem('dub_installed_models', JSON.stringify(Array.from(installedSet)));
          this.refreshModels();
          resolve(model.filename);
        }
      }, 300);
    });
  }

  public async cancelDownload(modelId: string): Promise<boolean> {
    try {
      const res = await safeInvoke<boolean>('cancel_model_download', { modelId });
      this.activeProgress.delete(modelId);
      this.notifyListeners();
      return !!res;
    } catch (e) {
      this.activeProgress.delete(modelId);
      this.notifyListeners();
      return true;
    }
  }

  public async deleteModel(filename: string): Promise<boolean> {
    try {
      const res = await safeInvoke<boolean>('delete_ai_model', { filename });
      await this.refreshModels();
      return !!res;
    } catch (e) {
      console.warn('[AIModelService] delete_ai_model safeInvoke failed, fallback to local state:', e);
      const saved = localStorage.getItem('dub_installed_models');
      if (saved) {
        const installedSet = new Set<string>(JSON.parse(saved));
        installedSet.delete(filename);
        const item = this.cachedModels.find((m) => m.filename === filename);
        if (item) installedSet.delete(item.id);
        localStorage.setItem('dub_installed_models', JSON.stringify(Array.from(installedSet)));
      }
      await this.refreshModels();
      return true;
    }
  }

  public async openModelsDirectory(): Promise<string> {
    try {
      const path = await safeInvoke<string>('open_models_directory');
      return path || 'Папка моделей';
    } catch (e) {
      console.warn('Не удалось открыть папку моделей:', e);
      return '';
    }
  }
}

export const aiModelService = AIModelService.getInstance();
