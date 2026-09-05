import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface SeparatorStatus {
  python_found: boolean;
  python_cmd: string;
  pip_found: boolean;
  separator_installed: boolean;
  version: string;
  cuda_available: boolean;
}

export interface SeparatorProgress {
  percent: number;
  stage: string;
  log_line: string;
}

const isTauriAvailable = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
};

export class AudioSeparatorService {
  private static progressListener: UnlistenFn | null = null;
  private static logListener: UnlistenFn | null = null;
  private static completeListener: UnlistenFn | null = null;

  /**
   * Проверить статус установки Python и библиотеки audio-separator
   */
  static async checkStatus(): Promise<SeparatorStatus> {
    const defaultStatus: SeparatorStatus = {
      python_found: false,
      python_cmd: '',
      pip_found: false,
      separator_installed: false,
      version: '',
      cuda_available: false,
    };

    if (!isTauriAvailable()) {
      return defaultStatus;
    }

    try {
      return await invoke<SeparatorStatus>('check_audio_separator_status');
    } catch (e) {
      console.warn('Failed to check audio-separator status:', e);
      return defaultStatus;
    }
  }

  /**
   * Начать установку audio-separator
   */
  static async startInstall(useGpu: boolean): Promise<string> {
    if (!isTauriAvailable()) {
      throw new Error('Установка audio-separator поддерживается только в десктопном приложении DubStudio.');
    }
    return await invoke<string>('install_audio_separator_pkg', { useGpu });
  }

  /**
   * Подписаться на логи установки
   */
  static async listenToInstallLogs(onLog: (line: string) => void, onComplete: () => void): Promise<() => void> {
    this.cleanupInstallListeners();

    if (!isTauriAvailable()) {
      return () => {};
    }

    try {
      const unlistenLog = await listen<string>('separator-install-log', (event) => {
        onLog(event.payload);
      });

      const unlistenComplete = await listen<boolean>('separator-install-complete', () => {
        onComplete();
      });

      this.logListener = unlistenLog;
      this.completeListener = unlistenComplete;

      return () => {
        this.cleanupInstallListeners();
      };
    } catch (e) {
      console.warn('Cannot listen to separator install logs:', e);
      return () => {};
    }
  }

  private static cleanupInstallListeners() {
    if (this.logListener) {
      this.logListener();
      this.logListener = null;
    }
    if (this.completeListener) {
      this.completeListener();
      this.completeListener = null;
    }
  }

  /**
   * Запустить процесс обработки/разделения аудио
   */
  static async runSeparation(
    inputFile: string,
    modelFilename: string,
    outputDir: string,
    useGpu: boolean,
    denoise: boolean,
    onProgress?: (progress: SeparatorProgress) => void
  ): Promise<string> {
    if (this.progressListener) {
      this.progressListener();
      this.progressListener = null;
    }

    if (!isTauriAvailable()) {
      throw new Error('Разделение аудио поддерживается только в десктопном приложении DubStudio.');
    }

    if (onProgress) {
      try {
        this.progressListener = await listen<SeparatorProgress>('separator-progress', (event) => {
          onProgress(event.payload);
        });
      } catch (e) {
        console.warn('Cannot listen to separator progress:', e);
      }
    }

    try {
      const result = await invoke<string>('run_audio_separator_cmd', {
        inputFile,
        modelFilename,
        outputDir,
        useGpu,
        denoise,
      });
      return result;
    } finally {
      if (this.progressListener) {
        this.progressListener();
        this.progressListener = null;
      }
    }
  }
}
