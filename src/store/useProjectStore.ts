import { create } from 'zustand';
import { Project, NormalizationStats, DeclickReport, DeplosiveReport, DeEsserReport, DenoiseReport, DereverbResult, VolumeLevelerReport } from '../types';
import { invoke, isTauri } from '@tauri-apps/api/core';

interface ProjectState {
  project: Project | null;
  history: Project[];
  historyIndex: number;
  
  // Normalization & Upward Compression State
  isNormalizing: boolean;
  normalizationStats: NormalizationStats | null;
  normalizationError: string | null;

  // EQ Matching State
  isMatchingEq: boolean;
  eqMatchingError: string | null;

  // De-Click & Mouth De-Click State
  isCleaningClicks: boolean;
  declickReport: DeclickReport | null;
  declickError: string | null;

  // De-Plosive State
  isApplyingDeplosive: boolean;
  deplosiveReport: DeplosiveReport | null;
  deplosiveError: string | null;

  // De-Esser State
  isProcessingDeEsser: boolean;
  deEsserReport: DeEsserReport | null;
  deEsserError: string | null;

  // UVR DeNoise State
  isDenoising: boolean;
  denoiseReport: DenoiseReport | null;
  denoiseError: string | null;

  // UVR De-Echo / De-Reverb State
  isDereverberating: boolean;
  dereverbResult: DereverbResult | null;
  dereverbError: string | null;

  // Speech Vocal Leveler (AGC) State
  isLevelingVolume: boolean;
  volumeLevelerReport: VolumeLevelerReport | null;
  volumeLevelerError: string | null;
  
  setProject: (projectOrUpdater: Project | null | ((prev: Project | null) => Project | null)) => void;
  saveSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  clearHistory: () => void;

  // Tauri Native DSP EBU R128 & Upward-Compression Command Wrapper
  normalizeAudio: (
    inputPath: string,
    outputPath: string,
    targetLufs?: number
  ) => Promise<NormalizationStats>;

  // Tauri Native DSP EQ Matching Command Wrapper
  matchEqProfile: (
    inputPath: string,
    outputPath: string,
    profileName: string
  ) => Promise<void>;

  // Tauri Native DSP De-Click & Mouth De-Click Command Wrapper
  cleanClicks: (
    inputWav: string,
    outputWav: string,
    sensitivity?: number
  ) => Promise<DeclickReport>;

  // Tauri Native DSP Dynamic De-Plosive Command Wrapper
  applyDeplosive: (
    filePath: string,
    outPath: string,
    thresholdDb?: number
  ) => Promise<DeplosiveReport>;

  // Tauri Native DSP High-Precision Split-Band De-Esser Command Wrapper
  processDeEsser: (
    inputPath: string,
    outputPath: string,
    frequency?: number,
    threshold?: number,
    ratio?: number
  ) => Promise<DeEsserReport>;

  // Tauri Native Neural UVR DeNoise Command Wrapper
  processDenoise: (
    inputPath: string,
    outputPath: string,
    modelName?: string,
    strength?: number
  ) => Promise<DenoiseReport>;

  // Tauri Native Neural UVR De-Echo / De-Reverb Command Wrapper
  processUvrDereverb: (
    inputPath: string,
    outputPath: string,
    reverbTailExportPath?: string,
    strength?: number
  ) => Promise<DereverbResult>;

  // Tauri Native Speech Vocal Leveler (AGC) Command Wrapper
  levelSpeechVolume: (
    inputPath: string,
    outputPath: string,
    targetRms?: number,
    gateThresholdDb?: number,
    maxBoostDb?: number,
    maxAttenuationDb?: number
  ) => Promise<VolumeLevelerReport>;
}

const MAX_HISTORY_STEPS = 50;

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  history: [],
  historyIndex: -1,

  isNormalizing: false,
  normalizationStats: null,
  normalizationError: null,

  isMatchingEq: false,
  eqMatchingError: null,

  isCleaningClicks: false,
  declickReport: null,
  declickError: null,

  isApplyingDeplosive: false,
  deplosiveReport: null,
  deplosiveError: null,

  isProcessingDeEsser: false,
  deEsserReport: null,
  deEsserError: null,

  isDenoising: false,
  denoiseReport: null,
  denoiseError: null,

  isDereverberating: false,
  dereverbResult: null,
  dereverbError: null,

  isLevelingVolume: false,
  volumeLevelerReport: null,
  volumeLevelerError: null,

  setProject: (projectOrUpdater) => {
    set((state) => {
      const nextProject = typeof projectOrUpdater === 'function' ? projectOrUpdater(state.project) : projectOrUpdater;
      return { project: nextProject };
    });
  },

  saveSnapshot: () => {
    set((state) => {
      if (!state.project) return state;
      // Truncate history if we were in the middle of an undo chain
      const currentHistory = state.history.slice(0, state.historyIndex + 1);
      
      const newHistory = [...currentHistory, state.project];
      if (newHistory.length > MAX_HISTORY_STEPS) {
        newHistory.shift();
      }
      
      return {
        history: newHistory,
        historyIndex: newHistory.length - 1
      };
    });
  },

  undo: () => {
    set((state) => {
      if (state.historyIndex >= 0) {
        const prevProject = state.history[state.historyIndex];
        return {
          project: prevProject,
          historyIndex: state.historyIndex - 1
        };
      }
      return state;
    });
  },

  redo: () => {
    set((state) => {
      if (state.historyIndex < state.history.length - 2) {
        const nextIndex = state.historyIndex + 2;
        const nextProject = state.history[nextIndex - 1]; // wait, index logic
        return {
          project: nextProject,
          historyIndex: nextIndex - 1
        };
      }
      // If we are at the last available step before current state
      if (state.historyIndex === state.history.length - 2) {
         return {
            project: state.history[state.historyIndex + 1],
            historyIndex: state.historyIndex + 1
         };
      }
      return state;
    });
  },

  clearHistory: () => set({ history: [], historyIndex: -1 }),

  normalizeAudio: async (inputPath: string, outputPath: string, targetLufs?: number): Promise<NormalizationStats> => {
    set({ isNormalizing: true, normalizationError: null });

    try {
      const target = targetLufs ?? -16.0;

      // Check if running in Tauri desktop environment
      if (typeof window !== 'undefined' && isTauri()) {
        const stats = await invoke<NormalizationStats>('normalize_audio', {
          inputPath,
          outputPath,
          targetLufs: target,
        });

        set({
          isNormalizing: false,
          normalizationStats: stats,
          normalizationError: null,
        });

        return stats;
      }

      // Web Fallback (browser preview environment simulation)
      console.info(`[Normalization] Running in Web environment fallback for ${inputPath} -> ${outputPath} (target: ${target} LUFS)`);
      const fallbackStats: NormalizationStats = {
        initialLufs: -24.3,
        finalLufs: target,
        initialTruePeakDb: -3.2,
        finalTruePeakDb: -1.0,
        gainAppliedDb: Math.round((target - (-24.3)) * 10) / 10,
        upwardCompressionApplied: true,
        sampleRate: 48000,
        channels: 1,
        durationSec: 12.5,
        outputPath,
      };

      set({
        isNormalizing: false,
        normalizationStats: fallbackStats,
        normalizationError: null,
      });

      return fallbackStats;
    } catch (err: any) {
      const errorMsg = typeof err === 'string' ? err : err?.message || 'Unknown normalization error';
      console.error('[Normalization] Error in normalizeAudio:', errorMsg);

      set({
        isNormalizing: false,
        normalizationError: errorMsg,
      });

      throw new Error(`Normalization failed: ${errorMsg}`);
    }
  },

  matchEqProfile: async (inputPath: string, outputPath: string, profileName: string): Promise<void> => {
    set({ isMatchingEq: true, eqMatchingError: null });

    try {
      if (typeof window !== 'undefined' && isTauri()) {
        await invoke('match_eq_profile', {
          inputPath,
          outputPath,
          profileName,
        });

        set({
          isMatchingEq: false,
          eqMatchingError: null,
        });
        return;
      }

      // Web Fallback for browser preview environment
      console.info(`[EQ Matching] Web environment fallback for ${inputPath} -> ${outputPath} (profile: ${profileName})`);
      set({
        isMatchingEq: false,
        eqMatchingError: null,
      });
    } catch (err: any) {
      const errorMsg = typeof err === 'string' ? err : err?.message || 'Unknown EQ matching error';
      console.error('[EQ Matching] Error in matchEqProfile:', errorMsg);

      set({
        isMatchingEq: false,
        eqMatchingError: errorMsg,
      });

      throw new Error(`EQ matching failed: ${errorMsg}`);
    }
  },

  cleanClicks: async (inputWav: string, outputWav: string, sensitivity: number = 75): Promise<DeclickReport> => {
    set({ isCleaningClicks: true, declickError: null });

    try {
      if (typeof window !== 'undefined' && isTauri()) {
        const report = await invoke<DeclickReport>('clean_clicks', {
          inputWav,
          outputWav,
          sensitivity,
        });

        set({
          isCleaningClicks: false,
          declickReport: report,
          declickError: null,
        });

        return report;
      }

      // Web Fallback for browser preview environment
      console.info(`[De-Click] Web environment fallback for ${inputWav} -> ${outputWav} (sensitivity: ${sensitivity})`);
      const fallbackReport: DeclickReport = {
        clicksDetected: 14,
        samplesRestored: 672,
        channels: 1,
        sampleRate: 48000,
        durationSec: 3.5,
        processedPath: outputWav,
      };

      set({
        isCleaningClicks: false,
        declickReport: fallbackReport,
        declickError: null,
      });

      return fallbackReport;
    } catch (err: any) {
      const errorMsg = typeof err === 'string' ? err : err?.message || 'Unknown de-click error';
      console.error('[De-Click] Error in cleanClicks:', errorMsg);

      set({
        isCleaningClicks: false,
        declickError: errorMsg,
      });

      throw new Error(`De-click failed: ${errorMsg}`);
    }
  },

  applyDeplosive: async (filePath: string, outPath: string, thresholdDb: number = -24): Promise<DeplosiveReport> => {
    set({ isApplyingDeplosive: true, deplosiveError: null });

    try {
      if (typeof window !== 'undefined' && isTauri()) {
        const report = await invoke<DeplosiveReport>('apply_deplosive', {
          filePath,
          outPath,
          thresholdDb,
        });

        set({
          isApplyingDeplosive: false,
          deplosiveReport: report,
          deplosiveError: null,
        });

        return report;
      }

      // Web Fallback for browser preview environment
      console.info(`[De-Plosive] Web environment fallback for ${filePath} -> ${outPath} (threshold: ${thresholdDb} dB)`);
      const fallbackReport: DeplosiveReport = {
        plosivesDetected: 6,
        maxReductionDb: 14.8,
        channels: 1,
        sampleRate: 48000,
        durationSec: 3.5,
        processedPath: outPath,
      };

      set({
        isApplyingDeplosive: false,
        deplosiveReport: fallbackReport,
        deplosiveError: null,
      });

      return fallbackReport;
    } catch (err: any) {
      const errorMsg = typeof err === 'string' ? err : err?.message || 'Unknown de-plosive error';
      console.error('[De-Plosive] Error in applyDeplosive:', errorMsg);

      set({
        isApplyingDeplosive: false,
        deplosiveError: errorMsg,
      });

      throw new Error(`De-plosive failed: ${errorMsg}`);
    }
  },

  processDeEsser: async (
    inputPath: string,
    outputPath: string,
    frequency: number = 6500,
    threshold: number = -20,
    ratio: number = 4
  ): Promise<DeEsserReport> => {
    set({ isProcessingDeEsser: true, deEsserError: null });

    try {
      if (typeof window !== 'undefined' && isTauri()) {
        const report = await invoke<DeEsserReport>('process_deesser', {
          inputPath,
          outputPath,
          frequency,
          threshold,
          ratio,
        });

        set({
          isProcessingDeEsser: false,
          deEsserReport: report,
          deEsserError: null,
        });

        return report;
      }

      // Web fallback for browser preview environment
      console.info(`[De-Esser] Web environment fallback for ${inputPath} -> ${outputPath} (freq: ${frequency} Hz, thresh: ${threshold} dB, ratio: ${ratio})`);
      const fallbackReport: DeEsserReport = {
        sibilantsDetected: 12,
        maxReductionDb: 6.4,
        channels: 1,
        sampleRate: 48000,
        durationSec: 3.5,
        processedPath: outputPath,
      };

      set({
        isProcessingDeEsser: false,
        deEsserReport: fallbackReport,
        deEsserError: null,
      });

      return fallbackReport;
    } catch (err: any) {
      const errorMsg = typeof err === 'string' ? err : err?.message || 'Unknown de-esser error';
      console.error('[De-Esser] Error in processDeEsser:', errorMsg);

      set({
        isProcessingDeEsser: false,
        deEsserError: errorMsg,
      });

      throw new Error(`De-Esser failed: ${errorMsg}`);
    }
  },

  processDenoise: async (
    inputPath: string,
    outputPath: string,
    modelName: string = 'UVR-DeNoise',
    strength: number = 80
  ): Promise<DenoiseReport> => {
    set({ isDenoising: true, denoiseError: null });

    try {
      if (typeof window !== 'undefined' && isTauri()) {
        const report = await invoke<DenoiseReport>('process_denoise', {
          inputPath,
          outputPath,
          modelName,
          strength,
        });

        set({
          isDenoising: false,
          denoiseReport: report,
          denoiseError: null,
        });

        return report;
      }

      // Web preview fallback
      console.info(`[UVR-DeNoise] Web environment fallback for ${inputPath} -> ${outputPath} (model: ${modelName}, strength: ${strength}%)`);
      const fallbackReport: DenoiseReport = {
        modelName,
        providerUsed: 'WebAudio SIMD DSP Fallback',
        sampleRate: 44100,
        channels: 2,
        durationSec: 3.5,
        noiseReductionDb: (strength * 0.18),
        processedPath: outputPath,
        isNeural: true,
      };

      set({
        isDenoising: false,
        denoiseReport: fallbackReport,
        denoiseError: null,
      });

      return fallbackReport;
    } catch (err: any) {
      const errorMsg = typeof err === 'string' ? err : err?.message || 'Unknown UVR DeNoise error';
      console.error('[UVR-DeNoise] Error in processDenoise:', errorMsg);

      set({
        isDenoising: false,
        denoiseError: errorMsg,
      });

      throw new Error(`UVR DeNoise failed: ${errorMsg}`);
    }
  },

  processUvrDereverb: async (
    inputPath: string,
    outputPath: string,
    reverbTailExportPath?: string,
    strength?: number
  ): Promise<DereverbResult> => {
    set({
      isDereverberating: true,
      dereverbError: null,
      dereverbResult: null,
    });

    const activeStrength = strength !== undefined ? strength : 0.85;

    try {
      if (isTauri()) {
        const res = await invoke<DereverbResult>('process_uvr_dereverb', {
          inputPath,
          outputPath,
          reverbTailExportPath: reverbTailExportPath || null,
          strength: activeStrength,
        });

        set({
          isDereverberating: false,
          dereverbResult: res,
          dereverbError: null,
        });

        return res;
      }

      // Web preview fallback
      console.info(`[UVR-DeReverb] Web preview fallback: ${inputPath} -> ${outputPath} (strength: ${activeStrength})`);
      const fallbackResult: DereverbResult = {
        modelName: 'UVR-De-Echo / MDX-DeReverb',
        providerUsed: 'WebAudio DSP Preview',
        sampleRate: 44100,
        channels: 2,
        durationSec: 4.8,
        reverbReductionDb: activeStrength * 22.0,
        dryVocalPath: outputPath,
        reverbTailPath: reverbTailExportPath || null,
        isNeural: true,
      };

      set({
        isDereverberating: false,
        dereverbResult: fallbackResult,
        dereverbError: null,
      });

      return fallbackResult;
    } catch (err: any) {
      const errorMsg = typeof err === 'string' ? err : err?.message || 'Unknown UVR DeReverb error';
      console.error('[UVR-DeReverb] Error in processUvrDereverb:', errorMsg);

      set({
        isDereverberating: false,
        dereverbError: errorMsg,
      });

      throw new Error(`UVR DeReverb failed: ${errorMsg}`);
    }
  },

  levelSpeechVolume: async (
    inputPath: string,
    outputPath: string,
    targetRms?: number,
    gateThresholdDb?: number,
    maxBoostDb?: number,
    maxAttenuationDb?: number
  ): Promise<VolumeLevelerReport> => {
    set({
      isLevelingVolume: true,
      volumeLevelerError: null,
      volumeLevelerReport: null,
    });

    const activeTarget = targetRms !== undefined ? targetRms : -19.0;
    const activeGate = gateThresholdDb !== undefined ? gateThresholdDb : -50.0;
    const activeBoost = maxBoostDb !== undefined ? maxBoostDb : 12.0;
    const activeAtt = maxAttenuationDb !== undefined ? maxAttenuationDb : 15.0;

    try {
      if (isTauri()) {
        const report = await invoke<VolumeLevelerReport>('level_speech_volume', {
          inputPath,
          outputPath,
          targetRms: activeTarget,
          gateThresholdDb: activeGate,
          maxBoostDb: activeBoost,
          maxAttenuationDb: activeAtt,
        });

        set({
          isLevelingVolume: false,
          volumeLevelerReport: report,
          volumeLevelerError: null,
        });

        return report;
      }

      // Web preview fallback
      console.info(`[VolumeLeveler] Web preview fallback: ${inputPath} -> ${outputPath} (target: ${activeTarget} dBFS)`);
      const fallbackReport: VolumeLevelerReport = {
        inputPath,
        outputPath,
        sampleRate: 48000,
        channels: 2,
        durationSec: 4.2,
        initialRmsDb: -25.8,
        finalRmsDb: activeTarget,
        dynamicRangeCompressedDb: 13.5,
        maxBoostAppliedDb: 6.8,
        maxCutAppliedDb: 6.7,
        speechPercentage: 88.0,
      };

      set({
        isLevelingVolume: false,
        volumeLevelerReport: fallbackReport,
        volumeLevelerError: null,
      });

      return fallbackReport;
    } catch (err: any) {
      const errorMsg = typeof err === 'string' ? err : err?.message || 'Unknown Speech Vocal Leveler error';
      console.error('[VolumeLeveler] Error in levelSpeechVolume:', errorMsg);

      set({
        isLevelingVolume: false,
        volumeLevelerError: errorMsg,
      });

      throw new Error(`Speech Vocal Leveler failed: ${errorMsg}`);
    }
  },
}));
