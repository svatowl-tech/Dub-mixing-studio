import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { DereverbProgressPayload, DereverbResult } from '../types';

export interface DereverbState {
  // Флаг активного процесса нейросетевого удаления эха
  isDereverberating: boolean;

  // Текущий статус и процент выполнения в реальном времени
  progress: DereverbProgressPayload | null;

  // Итоговый отчет о результатах 2-стемного разделения
  result: DereverbResult | null;

  // Текст ошибки при сбое
  error: string | null;

  // Степень очистки от реверберации: 0.0 (без изменений) .. 1.0 (полный Dry)
  dryWetBlend: number;

  // Опция сохранения изолированного хвоста комнаты на отдельную дорожку
  exportReverbTail: boolean;

  // Выбранная модель нейросети
  selectedModel: string;

  // Действия
  setDryWetBlend: (blend: number) => void;
  setExportReverbTail: (exportTail: boolean) => void;
  setSelectedModel: (model: string) => void;
  resetDereverbState: () => void;

  // Подписка на нативное событие прогресса "dereverb-progress"
  initDereverbProgressListener: () => Promise<UnlistenFn | undefined>;

  // Вызов нативной команды Tauri v2
  processUvrDereverb: (
    inputPath: string,
    outputPath: string,
    reverbTailExportPath?: string,
    strength?: number
  ) => Promise<DereverbResult>;
}

// Проверка доступности нативной среды Tauri v2
const isTauriAvailable = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
};

export const useDereverbStore = create<DereverbState>((set, get) => ({
  isDereverberating: false,
  progress: null,
  result: null,
  error: null,
  dryWetBlend: 0.85,
  exportReverbTail: false,
  selectedModel: 'UVR-De-Echo',

  setDryWetBlend: (blend: number) => set({ dryWetBlend: Math.max(0, Math.min(1, blend)) }),
  setExportReverbTail: (exportTail: boolean) => set({ exportReverbTail: exportTail }),
  setSelectedModel: (model: string) => set({ selectedModel: model }),

  resetDereverbState: () => set({
    isDereverberating: false,
    progress: null,
    result: null,
    error: null,
  }),

  initDereverbProgressListener: async () => {
    if (!isTauriAvailable()) {
      return undefined;
    }

    try {
      const unlisten = await listen<DereverbProgressPayload>('dereverb-progress', (event) => {
        set({ progress: event.payload });
      });
      return unlisten;
    } catch (err) {
      console.warn('[useDereverbStore] Не удалось подписаться на dereverb-progress:', err);
      return undefined;
    }
  },

  processUvrDereverb: async (
    inputPath: string,
    outputPath: string,
    reverbTailExportPath?: string,
    strength?: number
  ): Promise<DereverbResult> => {
    const activeBlend = strength !== undefined ? strength : get().dryWetBlend;

    set({
      isDereverberating: true,
      error: null,
      result: null,
      progress: {
        percent: 0,
        currentFrame: 0,
        totalFrames: 100,
        stage: 'Инициализация нейросети UVR De-Echo...',
      },
    });

    let unlisten: UnlistenFn | undefined;

    try {
      unlisten = await get().initDereverbProgressListener();

      if (isTauriAvailable()) {
        const res = await invoke<DereverbResult>('process_uvr_dereverb', {
          inputPath,
          outputPath,
          reverbTailExportPath: reverbTailExportPath || null,
          strength: activeBlend,
        });

        set({
          isDereverberating: false,
          result: res,
          error: null,
          progress: {
            percent: 100,
            currentFrame: 100,
            totalFrames: 100,
            stage: 'Удаление эха успешно завершено!',
          },
        });

        return res;
      }

      // Web preview fallback для интерфейса песочницы
      console.info(
        `[useDereverbStore] Web preview fallback: ${inputPath} -> ${outputPath} (blend: ${(activeBlend * 100).toFixed(0)}%)`
      );

      for (let p = 20; p <= 90; p += 25) {
        await new Promise((r) => setTimeout(r, 180));
        set({
          progress: {
            percent: p,
            currentFrame: p * 100,
            totalFrames: 10000,
            stage: `Разделение Dry / Reverb спектрограмм (${p}%)...`,
          },
        });
      }

      const mockRes: DereverbResult = {
        modelName: get().selectedModel,
        providerUsed: 'WebAudio DSP (Preview)',
        sampleRate: 44100,
        channels: 2,
        durationSec: 5.2,
        reverbReductionDb: activeBlend * 22.0,
        dryVocalPath: outputPath,
        reverbTailPath: reverbTailExportPath || null,
        isNeural: true,
      };

      set({
        isDereverberating: false,
        result: mockRes,
        error: null,
        progress: {
          percent: 100,
          currentFrame: 10000,
          totalFrames: 10000,
          stage: 'Де-реверберация завершена!',
        },
      });

      return mockRes;
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || 'Ошибка де-реверберации';
      console.error('[useDereverbStore] Ошибка:', msg);

      set({
        isDereverberating: false,
        error: msg,
      });

      throw new Error(`UVR De-Reverb failed: ${msg}`);
    } finally {
      if (unlisten) {
        unlisten();
      }
    }
  },
}));
