/**
 * Waveform bridge for high-performance peak generation using Rust.
 */
import { invoke } from '@tauri-apps/api/core';

export async function generateWaveformPeaks(filePath: string, points: number = 100): Promise<number[]> {
  return await invoke<number[]>('generate_waveform_peaks', {
    filePath,
    points,
  });
}

export async function generateWaveformPeaksFromPcm(samples: Float32Array | number[], points: number = 100): Promise<number[]> {
  const sampleArr = samples instanceof Float32Array ? Array.from(samples) : samples;
  return await invoke<number[]>('generate_waveform_peaks_from_pcm', {
    samples: sampleArr,
    points,
  });
}

export async function generateWaveformPeaksFromBlob(blob: Blob, points: number = 100): Promise<number[]> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.getChannelData(0);
  const peaks = await generateWaveformPeaksFromPcm(channelData, points);
  await audioCtx.close();
  return peaks;
}
