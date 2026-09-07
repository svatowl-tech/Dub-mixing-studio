/**
 * Spectral Analysis & STFT (Short-Time Fourier Transform) Engine
 * Designed for professional audio inspection (similar to Adobe Audition / iZotope RX).
 */

export interface SpectrogramFrame {
  time: number; // in seconds
  magnitudes: Float32Array; // dBFS values for each frequency bin (0 to -140 dB)
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
  detectedCutoffFreq: number; // e.g. 16000 for MP3 128kbps, 20000 for 320kbps, 22050/24000 for Lossless
  estimatedNoiseFloorDb: number;
  hasLowRumble: boolean; // energy < 60Hz
  hasSibilanceIssue: boolean; // excessive 5-8kHz energy
}

// Precomputed Hann window cache
const windowCache = new Map<number, Float32Array>();

function getHannWindow(size: number): Float32Array {
  if (windowCache.has(size)) return windowCache.get(size)!;
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  windowCache.set(size, win);
  return win;
}

// Fast Radix-2 Cooley-Tukey In-Place FFT
function inPlaceFFT(real: Float32Array, imag: Float32Array, n: number) {
  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tempR = real[i]; real[i] = real[j]; real[j] = tempR;
      const tempI = imag[i]; imag[i] = imag[j]; imag[j] = tempI;
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // Butterfly computation
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepR = Math.cos(angle);
    const wStepI = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wR = 1;
      let wI = 0;
      for (let k = 0; k < halfLen; k++) {
        const uR = real[i + k];
        const uI = imag[i + k];
        const vR = real[i + k + halfLen] * wR - imag[i + k + halfLen] * wI;
        const vI = real[i + k + halfLen] * wI + imag[i + k + halfLen] * wR;

        real[i + k] = uR + vR;
        imag[i + k] = uI + vI;
        real[i + k + halfLen] = uR - vR;
        imag[i + k + halfLen] = uI - vI;

        const nextWR = wR * wStepR - wI * wStepI;
        wI = wR * wStepI + wI * wStepR;
        wR = nextWR;
      }
    }
  }
}

export class SpectralAnalysisService {
  /**
   * Computes high-resolution STFT spectrogram from Float32Array PCM samples
   */
  static computeSpectrogram(
    samples: Float32Array,
    sampleRate: number,
    fftSize: number = 2048,
    hopRatio: number = 0.25 // 75% overlap for super sharp time resolution
  ): SpectrogramData {
    const numSamples = samples.length;
    const duration = numSamples / sampleRate;
    const hopSize = Math.max(64, Math.floor(fftSize * hopRatio));
    const window = getHannWindow(fftSize);
    const numBins = fftSize / 2;
    const freqStep = sampleRate / fftSize;
    const maxFreq = sampleRate / 2;

    const realBuffer = new Float32Array(fftSize);
    const imagBuffer = new Float32Array(fftSize);

    const frames: SpectrogramFrame[] = [];
    let globalPeakDb = -160;
    let globalPeakFreq = 0;
    let totalNoiseFloor = 0;
    let noiseFramesCount = 0;

    // Track energy distribution for quality checks
    let lowRumbleEnergy = 0;
    let midVoiceEnergy = 0;
    let highSibilanceEnergy = 0;
    let ultraHighEnergyBins = new Float32Array(numBins);

    for (let offset = 0; offset + fftSize <= numSamples; offset += hopSize) {
      const time = (offset + fftSize / 2) / sampleRate;

      // Apply Hann window
      for (let i = 0; i < fftSize; i++) {
        realBuffer[i] = samples[offset + i] * window[i];
        imagBuffer[i] = 0;
      }

      // Compute FFT
      inPlaceFFT(realBuffer, imagBuffer, fftSize);

      const magnitudes = new Float32Array(numBins);
      let framePeakDb = -160;
      let framePeakFreq = 0;
      let frameMinDb = 0;

      for (let k = 0; k < numBins; k++) {
        const r = realBuffer[k];
        const im = imagBuffer[k];
        // Normalized magnitude
        const mag = Math.sqrt(r * r + im * im) / (fftSize / 2);
        // Convert to dBFS (floor at -130 dB)
        const db = mag > 1e-7 ? Math.max(-130, 20 * Math.log10(mag)) : -130;
        magnitudes[k] = db;

        const freq = k * freqStep;

        if (db > framePeakDb) {
          framePeakDb = db;
          framePeakFreq = freq;
        }

        if (k === 0 || db < frameMinDb) {
          frameMinDb = db;
        }

        // Energy bins for quality diagnosis
        if (freq < 60) lowRumbleEnergy += mag;
        else if (freq >= 200 && freq <= 3500) midVoiceEnergy += mag;
        else if (freq >= 5000 && freq <= 8500) highSibilanceEnergy += mag;

        ultraHighEnergyBins[k] += mag;
      }

      if (framePeakDb > globalPeakDb) {
        globalPeakDb = framePeakDb;
        globalPeakFreq = framePeakFreq;
      }

      totalNoiseFloor += frameMinDb;
      noiseFramesCount++;

      frames.push({
        time,
        magnitudes,
        peakFreq: framePeakFreq,
        peakDb: framePeakDb
      });
    }

    // Detect frequency cutoff (lossy compression artifact detection)
    // Scan backwards from Nyquist to find where energy drops significantly below the mid-band
    let detectedCutoffFreq = maxFreq;
    const midEnergyAvg = (midVoiceEnergy / Math.max(1, frames.length * (3300 / freqStep))) || 1e-5;
    const cutoffThreshold = midEnergyAvg * 0.0005;

    for (let k = numBins - 1; k >= Math.floor(numBins * 0.4); k--) {
      const avgBinEnergy = ultraHighEnergyBins[k] / Math.max(1, frames.length);
      if (avgBinEnergy > cutoffThreshold) {
        detectedCutoffFreq = Math.min(maxFreq, Math.round((k * freqStep) / 100) * 100);
        break;
      }
    }

    const estimatedNoiseFloorDb = noiseFramesCount > 0 
      ? Math.round((totalNoiseFloor / noiseFramesCount) * 10) / 10 
      : -90;

    const hasLowRumble = lowRumbleEnergy > (midVoiceEnergy * 0.25);
    const hasSibilanceIssue = highSibilanceEnergy > (midVoiceEnergy * 0.55);

    return {
      frames,
      sampleRate,
      duration,
      fftSize,
      hopSize,
      freqStep,
      maxFreq,
      minDb: -120,
      maxDb: 0,
      globalPeakFreq: Math.round(globalPeakFreq),
      globalPeakDb: Math.round(globalPeakDb * 10) / 10,
      detectedCutoffFreq,
      estimatedNoiseFloorDb,
      hasLowRumble,
      hasSibilanceIssue
    };
  }

  /**
   * Converts frequency (Hz) to Y pixel position based on scale type
   */
  static freqToY(
    freq: number,
    height: number,
    minFreq: number,
    maxFreq: number,
    scale: 'mel' | 'log' | 'linear'
  ): number {
    if (freq <= minFreq) return height;
    if (freq >= maxFreq) return 0;

    if (scale === 'linear') {
      const ratio = (freq - minFreq) / (maxFreq - minFreq);
      return height * (1 - ratio);
    }

    if (scale === 'log') {
      const safeMin = Math.max(20, minFreq);
      const safeFreq = Math.max(safeMin, freq);
      const logMin = Math.log10(safeMin);
      const logMax = Math.log10(maxFreq);
      const logVal = Math.log10(safeFreq);
      const ratio = (logVal - logMin) / (logMax - logMin);
      return height * (1 - ratio);
    }

    // Mel Scale (Adobe Audition default perceptual frequency distribution)
    const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
    const melMin = hzToMel(minFreq);
    const melMax = hzToMel(maxFreq);
    const melVal = hzToMel(freq);
    const ratio = (melVal - melMin) / (melMax - melMin);
    return height * (1 - ratio);
  }

  /**
   * Converts Y pixel position back to frequency (Hz)
   */
  static yToFreq(
    y: number,
    height: number,
    minFreq: number,
    maxFreq: number,
    scale: 'mel' | 'log' | 'linear'
  ): number {
    const ratio = 1 - Math.max(0, Math.min(1, y / height));

    if (scale === 'linear') {
      return minFreq + ratio * (maxFreq - minFreq);
    }

    if (scale === 'log') {
      const safeMin = Math.max(20, minFreq);
      const logMin = Math.log10(safeMin);
      const logMax = Math.log10(maxFreq);
      const logVal = logMin + ratio * (logMax - logMin);
      return Math.pow(10, logVal);
    }

    // Mel Scale Inverse
    const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
    const melToHz = (mel: number) => 700 * (Math.pow(10, mel / 2595) - 1);
    const melMin = hzToMel(minFreq);
    const melMax = hzToMel(maxFreq);
    const melVal = melMin + ratio * (melMax - melMin);
    return melToHz(melVal);
  }

  /**
   * Maps a decibel value to an RGB color tuple using selected colormap
   */
  static getColorRgb(
    db: number,
    minDb: number,
    maxDb: number,
    palette: 'audition' | 'inferno' | 'magma' | 'plasma' | 'viridis' | 'cyberpunk' | 'grayscale',
    gamma: number = 1.0
  ): [number, number, number] {
    // Normalize normalized value between 0 (silent/dark) and 1 (loud/hot)
    let t = (db - minDb) / (maxDb - minDb);
    t = Math.max(0, Math.min(1, t));
    if (gamma !== 1.0) {
      t = Math.pow(t, gamma);
    }

    switch (palette) {
      case 'audition': {
        // Adobe Audition Classic: #08031d -> #350b63 -> #80168b -> #d43b2f -> #fa8c16 -> #fed330 -> #ffffff
        if (t < 0.15) {
          const u = t / 0.15;
          return [
            Math.round(8 + u * (53 - 8)),
            Math.round(3 + u * (11 - 3)),
            Math.round(29 + u * (99 - 29))
          ];
        } else if (t < 0.4) {
          const u = (t - 0.15) / 0.25;
          return [
            Math.round(53 + u * (128 - 53)),
            Math.round(11 + u * (22 - 11)),
            Math.round(99 + u * (139 - 99))
          ];
        } else if (t < 0.65) {
          const u = (t - 0.4) / 0.25;
          return [
            Math.round(128 + u * (212 - 128)),
            Math.round(22 + u * (59 - 22)),
            Math.round(139 + u * (47 - 139))
          ];
        } else if (t < 0.85) {
          const u = (t - 0.65) / 0.2;
          return [
            Math.round(212 + u * (254 - 212)),
            Math.round(59 + u * (211 - 59)),
            Math.round(47 + u * (48 - 47))
          ];
        } else {
          const u = (t - 0.85) / 0.15;
          return [
            Math.round(254 + u * (255 - 254)),
            Math.round(211 + u * (255 - 211)),
            Math.round(48 + u * (255 - 48))
          ];
        }
      }

      case 'inferno': {
        // Perceptually uniform Inferno
        const r = Math.min(255, Math.max(0, Math.round(255 * Math.pow(t, 0.75) * 1.2)));
        const g = Math.min(255, Math.max(0, Math.round(255 * Math.pow(Math.max(0, t - 0.2) / 0.8, 1.4))));
        const b = Math.min(255, Math.max(0, Math.round(255 * (t < 0.3 ? t * 2 : Math.max(0, 1 - (t - 0.3) * 1.5)))));
        return [r, g, b];
      }

      case 'magma': {
        const r = Math.min(255, Math.round(255 * (t < 0.5 ? t * 1.5 : 0.75 + (t - 0.5) * 0.5)));
        const g = Math.min(255, Math.round(255 * Math.pow(Math.max(0, t - 0.3) / 0.7, 1.8)));
        const b = Math.min(255, Math.round(255 * (t < 0.25 ? t * 3.5 : Math.max(0, 0.87 - t * 0.8))));
        return [r, g, b];
      }

      case 'plasma': {
        const r = Math.min(255, Math.round(255 * (t < 0.6 ? 0.2 + t * 1.2 : 0.92 + (t - 0.6) * 0.2)));
        const g = Math.min(255, Math.round(255 * Math.pow(t, 1.6)));
        const b = Math.min(255, Math.round(255 * (t < 0.4 ? 0.5 + t * 1.2 : Math.max(0, 1 - (t - 0.4) * 1.6))));
        return [r, g, b];
      }

      case 'viridis': {
        const r = Math.min(255, Math.round(255 * (t < 0.5 ? 0.27 + t * 0.3 : 0.42 + (t - 0.5) * 1.16)));
        const g = Math.min(255, Math.round(255 * (t < 0.7 ? 0.05 + t * 1.1 : 0.82 + (t - 0.7) * 0.6)));
        const b = Math.min(255, Math.round(255 * (t < 0.4 ? 0.33 + t * 0.8 : Math.max(0.1, 0.65 - (t - 0.4) * 0.9))));
        return [r, g, b];
      }

      case 'cyberpunk': {
        // Deep obsidian -> hot neon cyan -> magenta -> neon yellow
        if (t < 0.35) {
          const u = t / 0.35;
          return [Math.round(10 * (1 - u)), Math.round(u * 220), Math.round(u * 255)];
        } else if (t < 0.75) {
          const u = (t - 0.35) / 0.4;
          return [Math.round(u * 255), Math.round(220 * (1 - u)), Math.round(255 * (1 - u * 0.3))];
        } else {
          const u = (t - 0.75) / 0.25;
          return [255, Math.round(u * 255), Math.round(178 * (1 - u))];
        }
      }

      case 'grayscale':
      default: {
        const val = Math.round(t * 255);
        return [val, val, val];
      }
    }
  }

  /**
   * Formats frequency for professional axis markings (e.g., 20 Hz, 1 kHz, 16 kHz)
   */
  static formatFreqLabel(hz: number): string {
    if (hz >= 1000) {
      const k = hz / 1000;
      return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
    }
    return `${Math.round(hz)} Hz`;
  }

  /**
   * Converts frequency in Hz to closest musical note name (e.g. 440 Hz -> A4 +0c)
   */
  static freqToNote(hz: number): string {
    if (hz < 16.35) return '';
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const midiNum = 69 + 12 * Math.log2(hz / 440);
    const roundedMidi = Math.round(midiNum);
    const noteIndex = ((roundedMidi % 12) + 12) % 12;
    const octave = Math.floor(roundedMidi / 12) - 1;
    const cents = Math.round((midiNum - roundedMidi) * 100);
    const centsStr = cents > 0 ? `+${cents}c` : cents < 0 ? `${cents}c` : '';
    return `${noteNames[noteIndex]}${octave} ${centsStr}`.trim();
  }
}
