// ============================================================================
// DUB MIXING STUDIO PRO - REACT HOOK: USE VU METER
// Нативный хук телеметрии уровней звука (ASIO/CPAL/VU Meter) с Peak Hold decay (20 dB/s)
// ============================================================================

import { useEffect, useState, useRef, useCallback } from 'react';
import { isTauriAvailable } from '../lib/utils';

export interface VuMeterPayload {
  rms: number;
  peak: number;
  loudness_lufs?: number;
}

export interface MasterMeterPayload {
  rms: number;
  peak: number;
  loudness_lufs?: number;
  vocal_bus_rms?: number;
  vocal_bus_peak?: number;
  bus_type?: 'master' | 'vocal_bus' | 'input';
}

export interface RealtimeLoudnessFrame {
  momentaryLufs: number;
  shortTermLufs: number;
  integratedLufs: number;
  truePeakDbtp: number;
  channelPeaksDbfs: number[];
  timestampMs: number;
}

export interface UseVUMeterOptions {
  busType?: 'master' | 'vocal_bus' | 'input' | 'track';
  stream?: MediaStream | null;
  enabled?: boolean;
  rms?: number;
  peak?: number;
  loudnessLufs?: number;
  directRms?: number;
  directPeak?: number;
  directLufs?: number;
  onClipping?: (clipping: boolean) => void;
}

export interface UseVUMeterReturn {
  rms: number;
  peak: number;
  peakHold: number;
  loudnessLufs: number;
  isClipping: boolean;
  levelDb: number;
  levelNorm: number;
  peakHoldNorm: number;
  resetClipping: () => void;
}

/**
 * Преобразование линеаризованной амплитуды (0..1+) в dBFS (-60..0+)
 */
export const linearToDbfs = (linear: number): number => {
  if (linear <= 0.000001) return -60.0;
  const db = 20 * Math.log10(linear);
  return Math.max(-60.0, db);
};

/**
 * Нормализация dBFS (-60..0 dB) в диапазон 0.0 .. 1.0 для отображения шкалы
 */
export const dbfsToNorm = (dbfs: number): number => {
  return Math.max(0.0, Math.min(1.0, (dbfs + 60.0) / 60.0));
};

export const useVUMeter = (options: UseVUMeterOptions = {}): UseVUMeterReturn => {
  const {
    busType = 'input',
    stream = null,
    enabled = true,
    rms: propRms,
    peak: propPeak,
    loudnessLufs: propLufs,
    directRms,
    directPeak,
    directLufs,
    onClipping,
  } = options;

  const effectiveRms = propRms ?? directRms;
  const effectivePeak = propPeak ?? directPeak;
  const effectiveLufs = propLufs ?? directLufs;

  const [meterState, setMeterState] = useState<{
    rms: number;
    peak: number;
    peakHold: number;
    loudnessLufs: number;
    isClipping: boolean;
  }>({
    rms: 0,
    peak: 0,
    peakHold: 0,
    loudnessLufs: -70,
    isClipping: false,
  });

  // Refs для анимационного цикла и расчета спада Peak Hold (20 dB/s)
  const targetRmsRef = useRef<number>(0);
  const targetPeakRef = useRef<number>(0);
  const targetLufsRef = useRef<number>(-70);
  
  const currentRmsRef = useRef<number>(0);
  const currentPeakRef = useRef<number>(0);
  const peakHoldRef = useRef<number>(0);
  const lastUpdateTimeRef = useRef<number>(performance.now());
  const isClippingRef = useRef<boolean>(false);
  const clipHoldTimeRef = useRef<number>(0);
  const animFrameRef = useRef<number>(0);

  // Обработка прямых пропсов
  useEffect(() => {
    if (effectiveRms !== undefined) targetRmsRef.current = effectiveRms;
    if (effectivePeak !== undefined) targetPeakRef.current = effectivePeak;
    if (effectiveLufs !== undefined) targetLufsRef.current = effectiveLufs;
  }, [effectiveRms, effectivePeak, effectiveLufs]);

  // Сброс клиппинга
  const resetClipping = useCallback(() => {
    isClippingRef.current = false;
    clipHoldTimeRef.current = 0;
    setMeterState((prev) => ({ ...prev, isClipping: false }));
  }, []);

  // Web Audio API fallback (для браузера при наличии MediaStream)
  useEffect(() => {
    if (!enabled || !stream || isTauriAvailable()) return;

    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let animId: number = 0;

    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtxClass) return;

      audioCtx = new AudioCtxClass();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      const buffer = new Float32Array(analyser.fftSize);

      const updateWebAudio = () => {
        if (!analyser) return;
        analyser.getFloatTimeDomainData(buffer);

        let maxVal = 0;
        let sumSq = 0;
        for (let i = 0; i < buffer.length; i++) {
          const val = Math.abs(buffer[i]);
          if (val > maxVal) maxVal = val;
          sumSq += val * val;
        }

        const rms = Math.sqrt(sumSq / buffer.length);
        targetRmsRef.current = rms;
        targetPeakRef.current = maxVal;

        animId = requestAnimationFrame(updateWebAudio);
      };

      updateWebAudio();
    } catch (err) {
      console.warn('[useVUMeter] Web Audio fallback initialization error:', err);
    }

    return () => {
      if (animId) cancelAnimationFrame(animId);
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
    };
  }, [enabled, stream]);

  // Нативные подписки Tauri (vu-meter / master-meter-update / loudness-update)
  useEffect(() => {
    if (!enabled || !isTauriAvailable()) return;

    let unlistenVu: (() => void) | null = null;
    let unlistenMaster: (() => void) | null = null;
    let unlistenLoudness: (() => void) | null = null;
    let isSubscribed = true;

    const setupListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // 1. Подписка на 'vu-meter' (микрофон / входной канал)
        unlistenVu = await listen<VuMeterPayload>('vu-meter', (event) => {
          if (!isSubscribed) return;
          const { rms, peak, loudness_lufs } = event.payload;
          if (busType === 'input' || busType === 'track') {
            targetRmsRef.current = rms;
            targetPeakRef.current = peak;
            if (loudness_lufs !== undefined) targetLufsRef.current = loudness_lufs;
          }
        });

        // 2. Подписка на 'master-meter-update' (мастер и вокальный рэк)
        unlistenMaster = await listen<MasterMeterPayload>('master-meter-update', (event) => {
          if (!isSubscribed) return;
          const payload = event.payload;
          if (busType === 'vocal_bus' && payload.vocal_bus_rms !== undefined) {
            targetRmsRef.current = payload.vocal_bus_rms;
            targetPeakRef.current = payload.vocal_bus_peak ?? payload.vocal_bus_rms;
          } else if (busType === 'master' || payload.bus_type === 'master') {
            targetRmsRef.current = payload.rms;
            targetPeakRef.current = payload.peak;
          }
          if (payload.loudness_lufs !== undefined) {
            targetLufsRef.current = payload.loudness_lufs;
          }
        });

        // 3. Резервная подписка на 'loudness-update'
        unlistenLoudness = await listen<RealtimeLoudnessFrame>('loudness-update', (event) => {
          if (!isSubscribed) return;
          const payload = event.payload;
          targetLufsRef.current = payload.momentaryLufs;
          if (busType === 'master') {
            const maxChPeak = Math.max(...(payload.channelPeaksDbfs || [-120]), -120);
            const linearPeak = maxChPeak > -120 ? Math.pow(10, maxChPeak / 20) : 0;
            if (targetPeakRef.current === 0) {
              targetPeakRef.current = linearPeak;
            }
          }
        });
      } catch (err) {
        console.warn('[useVUMeter] Failed to register Tauri meter events:', err);
      }
    };

    setupListeners();

    return () => {
      isSubscribed = false;
      if (unlistenVu) unlistenVu();
      if (unlistenMaster) unlistenMaster();
      if (unlistenLoudness) unlistenLoudness();
    };
  }, [enabled, busType]);

  // Основной цикл сглаживания уровней и спада Peak Hold (20 dB/s)
  useEffect(() => {
    if (!enabled) return;

    const animateMeter = (now: number) => {
      const dt = Math.max(0.001, Math.min(0.1, (now - lastUpdateTimeRef.current) / 1000.0));
      lastUpdateTimeRef.current = now;

      // 1. Сглаживание RMS (быстрая атака, плавный релиз)
      const targetRms = targetRmsRef.current;
      const currentRms = currentRmsRef.current;
      const rmsAlpha = targetRms > currentRms ? 0.6 : Math.min(1.0, 15.0 * dt);
      currentRmsRef.current = currentRms + (targetRms - currentRms) * rmsAlpha;

      // 2. Текущий Peak
      const targetPeak = targetPeakRef.current;
      currentPeakRef.current = targetPeak;

      // 3. Расчет Peak Hold с коэффициентом спада 20 dB/sec (линейный множитель 10^(-dt))
      const decayFactor = Math.pow(10, -1.0 * dt); // -20 dB в секунду
      let currentPeakHold = peakHoldRef.current * decayFactor;

      if (targetPeak >= currentPeakHold) {
        currentPeakHold = targetPeak;
      }
      if (currentPeakHold < 0.000001) {
        currentPeakHold = 0;
      }
      peakHoldRef.current = currentPeakHold;

      // 4. Индикация клиппинга (>= 0.99 linear или >= -0.1 dBFS)
      if (targetPeak >= 0.99) {
        if (!isClippingRef.current) {
          isClippingRef.current = true;
          onClipping?.(true);
        }
        clipHoldTimeRef.current = now;
      } else if (isClippingRef.current && now - clipHoldTimeRef.current > 1500) {
        isClippingRef.current = false;
      }

      setMeterState({
        rms: currentRmsRef.current,
        peak: currentPeakRef.current,
        peakHold: peakHoldRef.current,
        loudnessLufs: targetLufsRef.current,
        isClipping: isClippingRef.current,
      });

      animFrameRef.current = requestAnimationFrame(animateMeter);
    };

    animFrameRef.current = requestAnimationFrame(animateMeter);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [enabled, onClipping]);

  const levelDb = linearToDbfs(meterState.rms);
  const levelNorm = dbfsToNorm(levelDb);

  const peakHoldDb = linearToDbfs(meterState.peakHold);
  const peakHoldNorm = dbfsToNorm(peakHoldDb);

  return {
    rms: meterState.rms,
    peak: meterState.peak,
    peakHold: meterState.peakHold,
    loudnessLufs: meterState.loudnessLufs,
    isClipping: meterState.isClipping,
    levelDb,
    levelNorm,
    peakHoldNorm,
    resetClipping,
  };
};

export default useVUMeter;
