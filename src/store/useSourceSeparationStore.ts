import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { SeparationProgressPayload, SeparationResult } from '../types';

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  architecture: 'mdx-net' | 'demucs' | 'vr' | 'dsp';
}

export const SEPARATION_MODELS: ModelInfo[] = [
  {
    id: 'UVR-MDX-NET-Voc_FT',
    name: 'UVR MDX-NET Voc_FT (Основная)',
    description: 'Высокоточная модель для кристальной изоляции речи и вокала из фильмов и песен',
    architecture: 'mdx-net',
  },
  {
    id: 'htdemucs',
    name: 'Demucs v4 (Hybrid Transformer)',
    description: 'Мощное многокомпонентное разделение трека на вокал, ударные, бас и прочие инструменты',
    architecture: 'demucs',
  },
  {
    id: 'MDX23C-8Step-VocFT.onnx',
    name: 'MDX23C 8-Step VocFT',
    description: 'Ускоренная нейросеть MDX23C с минимальным количеством артефактов на высоких частотах',
    architecture: 'mdx-net',
  },
  {
    id: '5_HP-Karaoke-UVR.onnx',
    name: '5_HP Karaoke UVR (Фонограмма / M&E)',
    description: 'Оптимизирована для удаления вокала и создания идеальной инструментальной подложки',
    architecture: 'vr',
  },
  {
    id: 'fast_dsp_splitter',
    name: 'Быстрый DSP фазовый сплиттер (Без ИИ)',
    description: 'Мгновенное противофазное разделение центрального канала без видеокарты и Python',
    architecture: 'dsp',
  },
];

export interface SourceSeparationState {
  // Флаг активного выполнения процесса разделения
  isSeparating: boolean;

  // Прогресс выполнения в процентах (0-100)
  progress: number;

  // Текущая стадия обработки ("Загрузка весов...", "Инференс...", "Запись стемов...")
  stage: string;

  // Последняя строка лога из stdout/stderr Python процесса
  logLine: string;

  // Выбранная модель разделения
  selectedModel: string;

  // Использовать ли аппаратное ускорение GPU (CUDA / DirectML)
  useGpu: boolean;

  // Результат разделения (пути к vocals.wav и no_vocals.wav)
  result: SeparationResult | null;

  // Ошибка выполнения
  error: string | null;

  // Список доступных моделей
  availableModels: ModelInfo[];

  // Установка модели
  setSelectedModel: (model: string) => void;

  // Переключение GPU
  setUseGpu: (useGpu: boolean) => void;

  // Сброс состояния
  resetState: () => void;

  // Запуск разделения аудио на стемы
  startSeparation: (
    inputPath: string,
    outputDir?: string,
    modelName?: string
  ) => Promise<SeparationResult>;

  // Принудительная отмена процесса (kill child process)
  cancelSeparation: () => Promise<void>;

  // Инициализация подписок на события Tauri
  initProgressListener: () => Promise<UnlistenFn | undefined>;
}

// Проверка доступности нативной среды Tauri v2
const isTauriAvailable = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
};

export const useSourceSeparationStore = create<SourceSeparationState>((set, get) => {
  let activeUnlistenProg: UnlistenFn | null = null;
  let activeUnlistenDetail: UnlistenFn | null = null;

  const cleanupListeners = () => {
    if (activeUnlistenProg) {
      activeUnlistenProg();
      activeUnlistenProg = null;
    }
    if (activeUnlistenDetail) {
      activeUnlistenDetail();
      activeUnlistenDetail = null;
    }
  };

  return {
    isSeparating: false,
    progress: 0,
    stage: '',
    logLine: '',
    selectedModel: 'UVR-MDX-NET-Voc_FT',
    useGpu: true,
    result: null,
    error: null,
    availableModels: SEPARATION_MODELS,

    setSelectedModel: (model: string) => set({ selectedModel: model }),
    setUseGpu: (useGpu: boolean) => set({ useGpu }),

    resetState: () => {
      cleanupListeners();
      set({
        isSeparating: false,
        progress: 0,
        stage: '',
        logLine: '',
        result: null,
        error: null,
      });
    },

    initProgressListener: async () => {
      if (!isTauriAvailable()) return undefined;

      try {
        // Подписка на базовое событие процентов: window.emit("separation-progress", percent)
        const unlistenProg = await listen<number | { percent: number }>(
          'separation-progress',
          (event) => {
            const pct =
              typeof event.payload === 'number'
                ? event.payload
                : event.payload.percent;
            set({ progress: Math.min(100, Math.max(0, Math.round(pct))) });
          }
        );

        // Подписка на детализированный прогресс (стадия, лог-строка)
        const unlistenDetail = await listen<SeparationProgressPayload>(
          'separation-progress-detail',
          (event) => {
            set({
              stage: event.payload.stage,
              logLine: event.payload.logLine,
              progress: Math.min(100, Math.max(0, Math.round(event.payload.percent))),
            });
          }
        );

        activeUnlistenProg = unlistenProg;
        activeUnlistenDetail = unlistenDetail;

        return () => {
          unlistenProg();
          unlistenDetail();
        };
      } catch (err) {
        console.warn('[useSourceSeparationStore] Не удалось подписаться на события:', err);
        return undefined;
      }
    },

    startSeparation: async (
      inputPath: string,
      outputDir?: string,
      modelName?: string
    ): Promise<SeparationResult> => {
      const model = modelName ?? get().selectedModel;
      const useGpu = get().useGpu;

      set({
        isSeparating: true,
        progress: 0,
        stage: 'Инициализация процесса...',
        logLine: `Подготовка запуска ${model}...`,
        error: null,
        result: null,
      });

      // Инициализируем слушатели событий
      await get().initProgressListener();

      // Обработка в браузерном режиме / превью без нативного Tauri бэкенда
      if (!isTauriAvailable()) {
        const steps = [
          { pct: 15, stage: 'Загрузка весов модели UVR MDX-NET...', line: 'Loading model checkpoint...' },
          { pct: 40, stage: 'Инференс нейросети (MDX-NET)...', line: 'Separating audio frames chunk 1/4...' },
          { pct: 75, stage: 'Инференс нейросети (MDX-NET)...', line: 'Separating audio frames chunk 3/4...' },
          { pct: 90, stage: 'Запись WAV файлов vocals.wav и no_vocals.wav...', line: 'Saving isolated stems...' },
          { pct: 100, stage: 'Готово!', line: 'Separation complete.' },
        ];

        for (const s of steps) {
          await new Promise((res) => setTimeout(res, 280));
          set({ progress: s.pct, stage: s.stage, logLine: s.line });
        }

        const mockResult: SeparationResult = {
          vocalsPath: inputPath ? inputPath.replace(/\.[^.]+$/, '_vocals.wav') : 'vocals.wav',
          noVocalsPath: inputPath ? inputPath.replace(/\.[^.]+$/, '_no_vocals.wav') : 'no_vocals.wav',
          modelName: model,
          durationSec: 124.5,
        };

        set({
          isSeparating: false,
          progress: 100,
          result: mockResult,
        });

        cleanupListeners();
        return mockResult;
      }

      // Вызов нативной Tauri команды ядра Rust
      try {
        const result = await invoke<SeparationResult>('separate_audio_stems', {
          inputPath,
          outputDir,
          modelName: model,
          useGpu,
        });

        set({
          isSeparating: false,
          progress: 100,
          stage: 'Готово!',
          logLine: 'Стемы vocals.wav и no_vocals.wav успешно созданы',
          result,
          error: null,
        });

        return result;
      } catch (err: any) {
        const errorMsg =
          typeof err === 'string'
            ? err
            : err?.message || 'Неизвестная ошибка при разделении аудио';

        set({
          isSeparating: false,
          error: errorMsg,
          stage: 'Ошибка',
          logLine: errorMsg,
        });

        throw new Error(errorMsg);
      } finally {
        cleanupListeners();
      }
    },

    cancelSeparation: async (): Promise<void> => {
      if (isTauriAvailable()) {
        try {
          await invoke<boolean>('cancel_source_separation');
        } catch (err) {
          console.warn('[useSourceSeparationStore] Ошибка при отмене процесса:', err);
        }
      }

      cleanupListeners();

      set({
        isSeparating: false,
        stage: 'Отменено',
        logLine: 'Операция отменена пользователем',
        error: 'Операция разделения аудио была прервана пользователем',
      });
    },
  };
});
