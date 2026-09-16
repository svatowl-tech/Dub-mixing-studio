// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE AUDIO BUFFER SERVICE (TYPESCRIPT)
// Высокопроизводительный фронтенд-сервис для работы с нативным бэкендом аудио-буферов
// Устраняет утечки памяти, нагрузку на Garbage Collector и задержки декодирования в Webview
// ============================================================================

export interface AudioMetadataDescriptor {
  bufferId: string;
  filePath: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  totalSamples: number;
  totalFrames: number;
  isMmap: boolean;
}

export interface BufferCacheStats {
  cachedTracksCount: number;
  totalMemoryBytes: number;
  mmapBuffersCount: number;
  pcmBuffersCount: number;
}

class AudioBufferManagerService {
  private isTauriAvailable(): boolean {
    return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
  }

  /**
   * Загрузка аудиофайла на бэкенде через Zero-Copy Mmap (WAV) или нативное декодирование Symphonia (MP3/FLAC/AAC)
   * Возвращает легковесный дескриптор метаданных без перегрузки Webview тяжелыми сэмплами.
   */
  public async loadAudioFile(filePath: string): Promise<AudioMetadataDescriptor> {
    if (this.isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const meta = await invoke<AudioMetadataDescriptor>('load_audio_file', {
          filePath,
        });
        return meta;
      } catch (err) {
        console.error(`[AudioBufferService] Ошибка нативной загрузки файла '${filePath}':`, err);
        throw new Error(typeof err === 'string' ? err : (err as Error).message);
      }
    }

    // Fallback для браузерной среды разработки / превью
    return this.fallbackBrowserLoad(filePath);
  }

  /**
   * Запрос диапазона аудиосэмплов (Float32Array) из кэша разделяемой памяти Rust
   * @param bufferId UUID дескриптора буфера
   * @param startSample Индекс первого сэмпла (с учетом чередования каналов)
   * @param length Количество сэмплов для чтения
   */
  public async getAudioSlice(bufferId: string, startSample: number, length: number): Promise<Float32Array> {
    if (this.isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const rawSamples = await invoke<number[]>('get_audio_slice', {
          bufferId,
          startSample: Math.max(0, Math.floor(startSample)),
          length: Math.max(0, Math.floor(length)),
        });
        return new Float32Array(rawSamples);
      } catch (err) {
        console.error(`[AudioBufferService] Ошибка чтения аудио-среза для '${bufferId}':`, err);
        throw new Error(typeof err === 'string' ? err : (err as Error).message);
      }
    }

    // Fallback для браузерной среды
    return new Float32Array(length);
  }

  /**
   * Запрос сэмплов по точному тайм-коду (в секундах)
   */
  public async getAudioSliceByTime(
    descriptor: AudioMetadataDescriptor,
    startTimeSec: number,
    durationSec: number
  ): Promise<Float32Array> {
    const startFrame = Math.floor(Math.max(0, startTimeSec) * descriptor.sampleRate);
    const numFrames = Math.floor(Math.max(0, durationSec) * descriptor.sampleRate);
    const startSample = startFrame * descriptor.channels;
    const length = numFrames * descriptor.channels;

    return this.getAudioSlice(descriptor.bufferId, startSample, length);
  }

  /**
   * Удаление аудиобуфера из оперативной памяти при удалении или закрытии дорожки
   */
  public async unloadAudioBuffer(bufferId: string): Promise<boolean> {
    if (this.isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<boolean>('unload_audio_buffer', { bufferId });
      } catch (err) {
        console.warn(`[AudioBufferService] Ошибка выгрузки буфера '${bufferId}':`, err);
        return false;
      }
    }
    return true;
  }

  /**
   * Полная очистка глобального кэша аудиобуферов
   */
  public async clearAllBuffers(): Promise<void> {
    if (this.isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke<void>('clear_all_audio_buffers');
      } catch (err) {
        console.warn('[AudioBufferService] Ошибка очистки кэша буферов:', err);
      }
    }
  }

  /**
   * Получение статистики использования памяти кэшем
   */
  public async getCacheStats(): Promise<BufferCacheStats> {
    if (this.isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<BufferCacheStats>('get_buffer_cache_stats');
      } catch (err) {
        console.warn('[AudioBufferService] Ошибка получения статистики кэша:', err);
      }
    }

    return {
      cachedTracksCount: 0,
      totalMemoryBytes: 0,
      mmapBuffersCount: 0,
      pcmBuffersCount: 0,
    };
  }

  /**
   * Fallback-декодирование в памяти браузера (используется только в web preview)
   */
  private async fallbackBrowserLoad(filePath: string): Promise<AudioMetadataDescriptor> {
    const fakeId = `buf_web_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    return {
      bufferId: fakeId,
      filePath,
      durationSeconds: 120.0,
      sampleRate: 48000,
      channels: 2,
      bitDepth: 24,
      totalSamples: 120 * 48000 * 2,
      totalFrames: 120 * 48000,
      isMmap: false,
    };
  }
}

export const audioBufferService = new AudioBufferManagerService();
export default audioBufferService;
