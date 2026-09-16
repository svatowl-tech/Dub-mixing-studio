/**
 * Утилиты маппинга частот, цветовых палитр и форматирования для отрисовки спектрограмм
 */

export function freqToY(
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

export function yToFreq(
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

export function getColorRgb(
  db: number,
  minDb: number,
  maxDb: number,
  palette: 'audition' | 'inferno' | 'magma' | 'plasma' | 'viridis' | 'cyberpunk' | 'grayscale',
  gamma: number = 1.0
): [number, number, number] {
  let t = (db - minDb) / (maxDb - minDb);
  t = Math.max(0, Math.min(1, t));
  if (gamma !== 1.0) {
    t = Math.pow(t, gamma);
  }

  switch (palette) {
    case 'audition': {
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

export function formatFreqLabel(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

export function freqToNote(hz: number): string {
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
