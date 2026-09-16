import { invoke, isTauri } from '@tauri-apps/api/core';

export interface SpectrogramFrame {
  time: number; // in seconds
  magnitudes: number[]; // dBFS values for each frequency bin (0 to -140 dB)
  peakFreq: number;
  peakDb: number;
}

export interface SpectrogramData {
  frames: SpectrogramFrame[];
  sampleRate: number;
  duration: number;
  fftSize: number;
  hopSize: number;
  freqStep: number;
  maxFreq: number;
  minDb: number;
  maxDb: number;
  globalPeakFreq: number;
  globalPeakDb: number;
  detectedCutoffFreq: number;
  estimatedNoiseFloorDb: number;
  hasLowRumble: boolean;
  hasSibilanceIssue: boolean;
}

/**
 * Вызов нативного Rust движка спектрального анализа через Tauri
 */
export async function computeSpectrogramFromFile(
  filePath: string,
  offsetSec?: number,
  durationSec?: number,
  fftSize: number = 2048,
  hopRatio: number = 0.25
): Promise<SpectrogramData> {
  if (!isTauri()) {
    throw new Error('Rust спектральный анализ доступен только в нативном Tauri окружении');
  }

  return await invoke<SpectrogramData>('compute_spectrogram_from_file', {
    filePath,
    offsetSec: offsetSec ?? null,
    durationSec: durationSec ?? null,
    fftSize,
    hopRatio,
  });
}

/**
 * Расчет спектрограммы из массива PCM сэмплов в памяти через Rust движок
 */
export async function computeSpectrogramFromPcm(
  samples: Float32Array | number[],
  sampleRate: number,
  fftSize: number = 2048,
  hopRatio: number = 0.25
): Promise<SpectrogramData> {
  if (!isTauri()) {
    throw new Error('Rust спектральный анализ доступен только в нативном Tauri окружении');
  }

  const samplesArray = samples instanceof Float32Array ? Array.from(samples) : samples;

  return await invoke<SpectrogramData>('compute_spectrogram_from_pcm', {
    samples: samplesArray,
    sampleRate,
    fftSize,
    hopRatio,
  });
}

export function formatFreqLabel(hz: number): string {
  if (hz >= 1000) {
    return `${(hz / 1000).toFixed(1)} кГц`;
  }
  return `${Math.round(hz)} Гц`;
}
