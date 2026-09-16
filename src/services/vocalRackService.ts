import { invoke } from '@tauri-apps/api/core';
import { NativeRackState, NativeSaturationType } from '../types';
import { isTauriAvailable } from '../lib/utils';

/**
 * Создание дефолтной конфигурации студийного рэка для дорожки
 */
export function createDefaultNativeRackState(trackId: string): NativeRackState {
  return {
    trackId,
    bypassAll: false,
    masterGainDb: 0.0,
    eq: {
      enabled: true,
      bypass: false,
      lowCut: {
        enabled: true,
        freqHz: 80,
        gainDb: 0,
        q: 0.707,
      },
      lowShelf: {
        enabled: true,
        freqHz: 220,
        gainDb: 0,
        q: 0.707,
      },
      peaking: {
        enabled: true,
        freqHz: 3200,
        gainDb: 0,
        q: 1.2,
      },
      highShelf: {
        enabled: true,
        freqHz: 11000,
        gainDb: 1.5,
        q: 0.707,
      },
    },
    compressor: {
      enabled: true,
      bypass: false,
      thresholdDb: -18,
      ratio: 3.5,
      attackMs: 12,
      releaseMs: 120,
      kneeDb: 4.0,
      makeupGainDb: 2.5,
      optoMode: true,
    },
    deesser: {
      enabled: true,
      bypass: false,
      freqHz: 6500,
      q: 2.0,
      thresholdDb: -22,
      ratio: 4.0,
      maxReductionDb: -10,
      attackMs: 1.5,
      releaseMs: 45,
      splitBand: true,
    },
    saturator: {
      enabled: true,
      bypass: false,
      driveDb: 3.5,
      saturationType: 'softTanh',
      warmthBias: 0.12,
      mix: 0.40,
      outputGainDb: 0.0,
    },
    vst3: {
      enabled: false,
      bypass: false,
      pluginPath: '',
      pluginName: '',
      instanceId: null,
      mix: 1.0,
      gainDb: 0.0,
      parameters: {},
    },
  };
}

class VocalRackService {
  private localRacks: Map<string, NativeRackState> = new Map();

  /**
   * Обновление параметров рэка дорожки в Rust DSP движке
   */
  async setRackParameters(trackId: string, rackState: NativeRackState, sampleRate: number = 48000): Promise<void> {
    this.localRacks.set(trackId, { ...rackState, trackId });

    if (!isTauriAvailable()) {
      return;
    }

    try {
      await invoke('set_rack_parameters', {
        trackId,
        rackState,
        sampleRate,
      });
    } catch (err) {
      console.error(`[VocalRackService] Error setting rack parameters for track ${trackId}:`, err);
      throw err;
    }
  }

  /**
   * Загрузка VST3-плагина в слот 5 рэка дорожки
   */
  async loadVst3PluginToRack(
    trackId: string,
    slotIndex: number,
    pluginPath: string
  ): Promise<string> {
    if (!isTauriAvailable()) {
      const mockId = `mock_vst3_${Date.now()}`;
      const state = this.getRackState(trackId);
      state.vst3 = {
        enabled: true,
        bypass: false,
        pluginPath,
        pluginName: pluginPath.split(/[/\\]/).pop() || 'Plugin',
        instanceId: mockId,
        mix: 1.0,
        gainDb: 0.0,
        parameters: {},
      };
      this.localRacks.set(trackId, state);
      return mockId;
    }

    try {
      const instanceId = await invoke<string>('load_vst3_plugin_to_rack', {
        trackId,
        slotIndex,
        pluginPath,
      });

      // Обновляем локальное состояние
      const state = await this.fetchRackStateFromBackend(trackId);
      if (state) {
        this.localRacks.set(trackId, state);
      }
      return instanceId;
    } catch (err) {
      console.error(`[VocalRackService] Error loading VST3 plugin into rack for track ${trackId}:`, err);
      throw err;
    }
  }

  /**
   * Получение текущего состояния рэка дорожки (из кэша или бэкенда)
   */
  getRackState(trackId: string): NativeRackState {
    if (!this.localRacks.has(trackId)) {
      this.localRacks.set(trackId, createDefaultNativeRackState(trackId));
    }
    return this.localRacks.get(trackId)!;
  }

  /**
   * Синхронизация состояния рэка с нативным Rust движком
   */
  async fetchRackStateFromBackend(trackId: string): Promise<NativeRackState | null> {
    if (!isTauriAvailable()) {
      return this.getRackState(trackId);
    }

    try {
      const state = await invoke<NativeRackState | null>('get_rack_state', {
        trackId,
      });
      if (state) {
        this.localRacks.set(trackId, state);
        return state;
      }
      return null;
    } catch (err) {
      console.error(`[VocalRackService] Error getting rack state from backend:`, err);
      return this.getRackState(trackId);
    }
  }

  /**
   * Сброс рэка дорожки в заводские настройки
   */
  async resetRack(trackId: string): Promise<NativeRackState> {
    if (!isTauriAvailable()) {
      const defaultState = createDefaultNativeRackState(trackId);
      this.localRacks.set(trackId, defaultState);
      return defaultState;
    }

    try {
      const resetState = await invoke<NativeRackState>('reset_rack', {
        trackId,
      });
      this.localRacks.set(trackId, resetState);
      return resetState;
    } catch (err) {
      console.error(`[VocalRackService] Error resetting rack:`, err);
      const defaultState = createDefaultNativeRackState(trackId);
      this.localRacks.set(trackId, defaultState);
      return defaultState;
    }
  }
}

export const vocalRackService = new VocalRackService();
export default vocalRackService;
