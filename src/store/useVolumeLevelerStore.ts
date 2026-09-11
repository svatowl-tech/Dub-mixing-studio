import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { VolumeLevelerReport } from '../types';

export interface VolumeLevelerState {
  isLeveling: boolean;
  report: VolumeLevelerReport | null;
  error: string | null;

  // Параметры алгоритма
  targetRms: number;
  gateThresholdDb: number;
  maxBoostDb: number;
  maxAttenuationDb: number;

  setTargetRms: (target: number) => void;
  setGateThresholdDb: (gate: number) => void;
  setMaxBoostDb: (boost: number) => void;
  setMaxAttenuationDb: (attenuation: number) => void;
  resetLevelerState: () => void;

  levelSpeechVolume: (
    inputPath: string,
    outputPath: string,
    targetRms?: number,
    gateThresholdDb?: number,
    maxBoostDb?: number,
    maxAttenuationDb?: number
  ) => Promise<VolumeLevelerReport>;
}

const isTauriAvailable = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
};

export const useVolumeLevelerStore = create<VolumeLevelerState>((set, get) => ({
  isLeveling: false,
  report: null,
  error: null,

  targetRms: -19.0,
  gateThresholdDb: -50.0,
  maxBoostDb: 12.0,
  maxAttenuationDb: 15.0,

  setTargetRms: (target: number) => set({ targetRms: target }),
  setGateThresholdDb: (gate: number) => set({ gateThresholdDb: gate }),
  setMaxBoostDb: (boost: number) => set({ maxBoostDb: boost }),
  setMaxAttenuationDb: (attenuation: number) => set({ maxAttenuationDb: attenuation }),
  resetLevelerState: () => set({ isLeveling: false, report: null, error: null }),

  levelSpeechVolume: async (
    inputPath: string,
    outputPath: string,
    targetRms?: number,
    gateThresholdDb?: number,
    maxBoostDb?: number,
    maxAttenuationDb?: number
  ): Promise<VolumeLevelerReport> => {
    const tRms = targetRms !== undefined ? targetRms : get().targetRms;
    const gThresh = gateThresholdDb !== undefined ? gateThresholdDb : get().gateThresholdDb;
    const mBoost = maxBoostDb !== undefined ? maxBoostDb : get().maxBoostDb;
    const mAtt = maxAttenuationDb !== undefined ? maxAttenuationDb : get().maxAttenuationDb;

    set({ isLeveling: true, error: null, report: null });

    try {
      if (isTauriAvailable()) {
        const report = await invoke<VolumeLevelerReport>('level_speech_volume', {
          inputPath,
          outputPath,
          targetRms: tRms,
          gateThresholdDb: gThresh,
          maxBoostDb: mBoost,
          maxAttenuationDb: mAtt,
        });

        set({
          isLeveling: false,
          report,
          error: null,
        });

        return report;
      }

      // Web preview fallback для работы в браузере
      console.info(
        `[useVolumeLevelerStore] Web fallback: ${inputPath} -> ${outputPath} (target: ${tRms} dBFS)`
      );

      await new Promise((r) => setTimeout(r, 220));

      const mockReport: VolumeLevelerReport = {
        inputPath,
        outputPath,
        sampleRate: 48000,
        channels: 2,
        durationSec: 4.5,
        initialRmsDb: -26.4,
        finalRmsDb: tRms,
        dynamicRangeCompressedDb: 14.2,
        maxBoostAppliedDb: 7.4,
        maxCutAppliedDb: 6.8,
        speechPercentage: 86.5,
      };

      set({
        isLeveling: false,
        report: mockReport,
        error: null,
      });

      return mockReport;
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || 'Ошибка выравнивания громкости речи';
      console.error('[useVolumeLevelerStore] Ошибка:', msg);

      set({
        isLeveling: false,
        error: msg,
      });

      throw new Error(`Speech Vocal Leveler failed: ${msg}`);
    }
  },
}));
