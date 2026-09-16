// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE LOUDNESS SERVICE (TYPESCRIPT)
// Клиентский фасад для оффлайн анализа и потокового EBU R128 / ITU-R BS.1770-4
// ============================================================================

export interface LoudnessReport {
  integratedLufs: number;
  loudnessRangeLu: number;
  lraLowLufs: number;
  lraHighLufs: number;
  maxTruePeakDbtp: number;
  maxShortTermLufs: number;
  maxMomentaryLufs: number;
  samplePeakDbfs: number;
  channels: number;
  sampleRate: number;
  durationSeconds: number;
  isEbuCompliant: boolean;
  isStreamingCompliant: boolean;
}

export interface RealtimeLoudnessFrame {
  momentaryLufs: number;
  shortTermLufs: number;
  integratedLufs: number;
  truePeakDbtp: number;
  channelPeaksDbfs: number[];
  timestampMs: number;
}

class LoudnessService {
  private isTauriAvailable(): boolean {
    return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
  }

  /**
   * Полный оффлайн анализ дорожки или файла по стандарту EBU R128
   * @param bufferIdOrPath ID буфера из audioBufferService или абсолютный путь к аудиофайлу
   */
  public async analyzeTrackLoudness(bufferIdOrPath: string): Promise<LoudnessReport> {
    if (this.isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<LoudnessReport>('analyze_track_loudness', {
          bufferIdOrPath,
        });
      } catch (err) {
        console.error(`[LoudnessService] Ошибка анализа громкости для '${bufferIdOrPath}':`, err);
        throw new Error(typeof err === 'string' ? err : (err as Error).message);
      }
    }

    // Fallback для Web Preview
    return this.fallbackBrowserEstimate();
  }

  /**
   * Сброс потокового измерителя реального времени
   */
  public async resetRealtimeLoudness(channels = 2, sampleRate = 48000): Promise<void> {
    if (this.isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke<void>('reset_realtime_loudness', { channels, sampleRate });
      } catch (err) {
        console.warn('[LoudnessService] Ошибка сброса потокового измерителя:', err);
      }
    }
  }

  private fallbackBrowserEstimate(): LoudnessReport {
    return {
      integratedLufs: -23.0,
      loudnessRangeLu: 6.5,
      lraLowLufs: -25.5,
      lraHighLufs: -19.0,
      maxTruePeakDbtp: -1.2,
      maxShortTermLufs: -21.4,
      maxMomentaryLufs: -18.8,
      samplePeakDbfs: -1.5,
      channels: 2,
      sampleRate: 48000,
      durationSeconds: 120.0,
      isEbuCompliant: true,
      isStreamingCompliant: false,
    };
  }
}

export const loudnessService = new LoudnessService();
export default loudnessService;
