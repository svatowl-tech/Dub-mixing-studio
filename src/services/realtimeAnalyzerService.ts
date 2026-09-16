// ============================================================================
// DUB MIXING STUDIO PRO - REALTIME ANALYZER SERVICE (TYPESCRIPT CLIENT)
// Клиентский сервис взаимодействия с нативным Rust-модулем спектрального анализа
// и генерации Mipmap-пиков волновой формы (LOD 1x, 10x, 100x, 1000x)
// ============================================================================

import { SpectrumFramePayload, WaveformMipmap } from '../types';
import { isTauriAvailable } from '../lib/utils';

export class RealtimeAnalyzerService {
  /**
   * Запуск нативного потокового БПФ-анализатора (60 FPS)
   */
  static async startAnalyzer(sampleRate: number = 48000): Promise<void> {
    if (!isTauriAvailable()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('start_realtime_spectrum_analyzer', { sampleRate });
    } catch (err) {
      console.warn('Failed to start native spectrum analyzer:', err);
    }
  }

  /**
   * Остановка нативного потокового БПФ-анализатора
   */
  static async stopAnalyzer(): Promise<void> {
    if (!isTauriAvailable()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('stop_realtime_spectrum_analyzer');
    } catch (err) {
      console.warn('Failed to stop native spectrum analyzer:', err);
    }
  }

  /**
   * Получение текущего кадра спектра (Pull-модель)
   */
  static async getLatestSpectrumFrame(): Promise<SpectrumFramePayload | null> {
    if (!isTauriAvailable()) return null;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<SpectrumFramePayload | null>('get_latest_spectrum_frame');
    } catch (err) {
      console.warn('Failed to get latest spectrum frame:', err);
      return null;
    }
  }

  /**
   * Генерация / подгрузка Mipmap-пиков волновой формы (LOD 1x, 10x, 100x, 1000x)
   */
  static async generateWaveformMipmaps(
    bufferIdOrPath: string,
    cacheOutputPath?: string
  ): Promise<WaveformMipmap> {
    if (isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<WaveformMipmap>('generate_waveform_mipmaps', {
          bufferIdOrPath,
          cacheOutputPath
        });
      } catch (err) {
        console.warn('Native generate_waveform_mipmaps failed, falling back:', err);
      }
    }

    // Web Fallback (синтетические пики)
    return {
      sampleRate: 48000,
      totalSamples: 48000 * 3,
      durationSeconds: 3.0,
      lod1x: new Array(2250).fill(0.2),
      lod10x: new Array(225).fill(0.3),
      lod100x: new Array(23).fill(0.4),
      lod1000x: new Array(3).fill(0.5)
    };
  }
}

export const realtimeAnalyzerService = RealtimeAnalyzerService;
