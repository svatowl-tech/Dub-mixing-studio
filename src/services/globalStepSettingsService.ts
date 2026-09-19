import { MixingPreset } from '../types';
import { DEFAULT_MIXING_PRESETS } from '../lib/defaultPresets';
import { invoke as rawInvoke } from '@tauri-apps/api/core';

const GLOBAL_SETTINGS_KEY = 'dubstudio_global_step_settings_v1';
const GLOBAL_SETTINGS_FILE_NAME = 'dubstudio_global_step_settings.json';

export interface GlobalStepSettingsPayload {
  version: number;
  updatedAt: number;
  presets: MixingPreset[];
  activePresetId?: string;
}

/**
 * Service to manage persistent global step settings stored directly in the application folder and browser storage.
 */
export class GlobalStepSettingsService {
  private static cachedSettings: GlobalStepSettingsPayload | null = null;

  /**
   * Synchronously loads global step settings from localStorage or fallback defaults.
   */
  public static loadGlobalSettings(): GlobalStepSettingsPayload {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      const raw = localStorage.getItem(GLOBAL_SETTINGS_KEY);
      if (raw) {
        const parsed: GlobalStepSettingsPayload = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.presets) && parsed.presets.length > 0) {
          this.cachedSettings = parsed;
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[GlobalStepSettingsService] Error reading localStorage step settings:', e);
    }

    // Default payload from factory presets
    const defaultPayload: GlobalStepSettingsPayload = {
      version: 1,
      updatedAt: Date.now(),
      presets: JSON.parse(JSON.stringify(DEFAULT_MIXING_PRESETS)),
      activePresetId: 'preset-voiceover'
    };
    this.cachedSettings = defaultPayload;
    return defaultPayload;
  }

  /**
   * Asynchronously loads global step settings from the application directory file (in Tauri mode).
   */
  public static async initGlobalSettingsFromDisk(): Promise<GlobalStepSettingsPayload> {
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.readTextFile) {
      try {
        const fileRes = await window.electronAPI.readTextFile(GLOBAL_SETTINGS_FILE_NAME);
        if (fileRes.success && fileRes.data) {
          const parsed: GlobalStepSettingsPayload = JSON.parse(fileRes.data);
          if (parsed && Array.isArray(parsed.presets) && parsed.presets.length > 0) {
            this.cachedSettings = parsed;
            try {
              localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(parsed));
            } catch (_) {}
            console.log('[GlobalStepSettingsService] Global step settings loaded from application folder.');
            return parsed;
          }
        }
      } catch (e) {
        console.warn('[GlobalStepSettingsService] Application folder config file read warning:', e);
      }
    }
    return this.loadGlobalSettings();
  }

  /**
   * Saves updated global presets and step configurations to the application directory file & localStorage.
   */
  public static async saveGlobalSettings(presets: MixingPreset[], activePresetId?: string): Promise<boolean> {
    try {
      const payload: GlobalStepSettingsPayload = {
        version: 1,
        updatedAt: Date.now(),
        presets: JSON.parse(JSON.stringify(presets)),
        activePresetId: activePresetId || 'preset-voiceover'
      };

      this.cachedSettings = payload;

      // 1. Save to LocalStorage
      try {
        localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(payload));
      } catch (lsErr) {
        console.warn('[GlobalStepSettingsService] Failed saving to localStorage:', lsErr);
      }

      // 2. Save to App Folder via Tauri or Electron API if available
      if (typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)) {
        try {
          await rawInvoke('save_project_file', {
            path: GLOBAL_SETTINGS_FILE_NAME,
            data: JSON.stringify(payload, null, 2)
          });
          console.log('[GlobalStepSettingsService] Global step settings saved to application folder.');
        } catch (tauriErr) {
          console.warn('[GlobalStepSettingsService] Failed saving to application folder:', tauriErr);
        }
      }

      return true;
    } catch (err) {
      console.error('[GlobalStepSettingsService] Error saving global step settings:', err);
      return false;
    }
  }

  /**
   * Returns merged presets using the user's persistent global step settings as baseline.
   */
  public static getMergedPresets(): MixingPreset[] {
    const globalSettings = this.loadGlobalSettings();
    const savedPresetsMap = new Map<string, MixingPreset>();
    
    for (const p of globalSettings.presets) {
      savedPresetsMap.set(p.id, p);
    }

    const mergedPresets: MixingPreset[] = DEFAULT_MIXING_PRESETS.map(factoryPreset => {
      const saved = savedPresetsMap.get(factoryPreset.id);
      if (!saved) return JSON.parse(JSON.stringify(factoryPreset));

      // Deep merge saved step configurations on top of factory presets
      return {
        ...factoryPreset,
        ...saved,
        name: factoryPreset.name,
        description: factoryPreset.description,
        phase1: { ...factoryPreset.phase1, ...saved.phase1 },
        phase2: { ...factoryPreset.phase2, ...saved.phase2 },
        phase3: { ...factoryPreset.phase3, ...saved.phase3 },
        phase4: { ...factoryPreset.phase4, ...saved.phase4 },
        phase1Order: saved.phase1Order || factoryPreset.phase1Order,
        phase2Order: saved.phase2Order || factoryPreset.phase2Order,
        phase3Order: saved.phase3Order || factoryPreset.phase3Order,
        phase4Order: saved.phase4Order || factoryPreset.phase4Order,
      };
    });

    // Add any custom user-created presets
    for (const saved of globalSettings.presets) {
      if (!saved.isSystem && !mergedPresets.some(p => p.id === saved.id)) {
        mergedPresets.push(JSON.parse(JSON.stringify(saved)));
      }
    }

    return mergedPresets;
  }

  /**
   * Resets global step settings back to factory defaults.
   */
  public static async resetToFactoryDefaults(): Promise<MixingPreset[]> {
    try {
      localStorage.removeItem(GLOBAL_SETTINGS_KEY);
    } catch (_) {}

    this.cachedSettings = null;
    const factory = JSON.parse(JSON.stringify(DEFAULT_MIXING_PRESETS));
    await this.saveGlobalSettings(factory, 'preset-voiceover');
    return factory;
  }
}
