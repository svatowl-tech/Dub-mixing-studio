import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { DenoiseProgressPayload, DenoiseReport } from '../types';

export interface DenoiseState {
  // Флаг активного процесса нейросетевого шумоподавления
  isDenoising: boolean;
  
  // Текущий прогресс обработки в реальном времени (0-100%)
  progress: DenoiseProgressPayload | null;
  
  // Итоговый отчет о результатах обработки
  report: DenoiseReport | null;
  
  // Текст ошибки при сбое
  error: string | null;
  
  // Выбранная модель нейросети
  selectedModel: string;
  
  // Сила подавления шума (0..100)
  strength: number;
  
  // Действия Zustand
  setSelectedModel: (model: string) => void;
  setStrength: (strength: number) => void;
  resetDenoiseState: () => void;
  
  // Подписка на событие прогресса "denoise-progress" от Tauri v2 бэкенда
  initDenoiseProgressListener: () => Promise<UnlistenFn | undefined>;
  
  // Запуск нейросетевого шумоподавления UVR DeNoise
  processDenoise: (
    inputPath: string,
    outputPath: string,
    modelName?: string,
    strength?: number
  ) => Promise<DenoiseReport>;
}

// Проверка доступности нативной среды Tauri v2
const isTauriAvailable = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
};

export const useDenoiseStore = create<DenoiseState>((set, get) => ({
  isDenoising: false,
  progress: null,
  report: null,
  error: null,
  selectedModel: 'UVR-DeNoise',
  strength: 80,

  setSelectedModel: (model: string) => set({ selectedModel: model }),
  setStrength: (strength: number) => set({ strength: Math.max(0, Math.min(100, strength)) }),
  
  resetDenoiseState: () => set({
    isDenoising: false,
    progress: null,
    report: null,
    error: null,
  }),

  initDenoiseProgressListener: async () => {
    if (!isTauriAvailable()) {
      return undefined;
    }

    try {
      const unlisten = await listen<DenoiseProgressPayload>('denoise-progress', (event) => {
        set({ progress: event.payload });
      });
      return unlisten;
    } catch (err) {
      console.warn('[useDenoiseStore] Не удалось подписаться на событие denoise-progress:', err);
      return undefined;
    }
  },

  processDenoise: async (
    inputPath: string,
    outputPath: string,
    modelName?: string,
    strength?: number
  ): Promise<DenoiseReport> => {
    const activeModel = modelName ?? get().selectedModel;
    const activeStrength = strength ?? get().strength;

    set({
      isDenoising: true,
      error: null,
      report: null,
      progress: {
        percent: 0,
        currentFrame: 0,
        totalFrames: 100,
        stage: 'Инициализация сессии UVR DeNoise...',
      },
    });

    let unlisten: UnlistenFn | undefined;

    try {
      // Инициализация подписки на прогресс инференса
      unlisten = await get().initDenoiseProgressListener();

      if (isTauriAvailable()) {
        const result = await invoke<DenoiseReport>('process_denoise', {
          inputPath,
          outputPath,
          modelName: activeModel,
          strength: activeStrength,
        });

        set({
          isDenoising: false,
          report: result,
          error: null,
          progress: {
            percent: 100,
            currentFrame: 100,
            totalFrames: 100,
            stage: 'Обработка завершена!',
          },
        });

        return result;
      }

      // Браузерный / превью фолбэк для среды песочницы
      console.info(
        `[useDenoiseStore] Превью окружение (Web). Симуляция UVR DeNoise (${activeModel}, сила ${activeStrength}%) для: ${inputPath} -> ${outputPath}`
      );

      // Имитация шагов прогресса для интерактивного тестирования в веб-превью
      for (let p = 15; p <= 90; p += 25) {
        await new Promise((res) => setTimeout(res, 200));
        set({
          progress: {
            percent: p,
            currentFrame: p * 100,
            totalFrames: 10000,
            stage: `Инференс спектрограмм UVR (${p}%)...`,
          },
        });
      }

      const mockReport: DenoiseReport = {
        modelName: activeModel,
        providerUsed: 'WebAssembly Audio Worklet (Preview)',
        sampleRate: 44100,
        channels: 2,
        durationSec: 4.8,
        noiseReductionDb: (activeStrength * 0.18),
        processedPath: outputPath,
        isNeural: true,
      };

      set({
        isDenoising: false,
        report: mockReport,
        error: null,
        progress: {
          percent: 100,
          currentFrame: 10000,
          totalFrames: 10000,
          stage: 'Шумоподавление успешно завершено!',
        },
      });

      return mockReport;
    } catch (err: any) {
      const errorMsg =
        typeof err === 'string'
          ? err
          : err?.message || 'Неизвестная ошибка при шумоподавлении UVR DeNoise';
      console.error('[useDenoiseStore] Ошибка шумоподавления:', errorMsg);

      set({
        isDenoising: false,
        error: errorMsg,
      });

      throw new Error(`UVR DeNoise завершился с ошибкой: ${errorMsg}`);
    } finally {
      if (unlisten) {
        unlisten();
      }
    }
  },
}));
