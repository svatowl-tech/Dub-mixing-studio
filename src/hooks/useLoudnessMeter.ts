// ============================================================================
// DUB MIXING STUDIO PRO - REACT HOOK: USE LOUDNESS METER (REACT 18+)
// Реактивный хук для подключения к нативным событиям EBU R128 с троттлингом (30 FPS)
// ============================================================================

import { useEffect, useState, useRef, useCallback } from 'react';
import { RealtimeLoudnessFrame, LoudnessReport, loudnessService } from '../services/loudnessService';

export interface UseLoudnessMeterOptions {
  enabled?: boolean;
  channels?: number;
  sampleRate?: number;
  onPeakOverload?: (peakDbtp: number) => void;
}

export interface UseLoudnessMeterReturn {
  momentaryLufs: number;
  shortTermLufs: number;
  integratedLufs: number;
  truePeakDbtp: number;
  channelPeaksDbfs: number[];
  isOverloaded: boolean;
  lastUpdated: number;
  resetMeter: () => Promise<void>;
  analyzeOffline: (bufferIdOrPath: string) => Promise<LoudnessReport>;
}

export const useLoudnessMeter = (options: UseLoudnessMeterOptions = {}): UseLoudnessMeterReturn => {
  const { enabled = true, channels = 2, sampleRate = 48000, onPeakOverload } = options;

  const [frame, setFrame] = useState<RealtimeLoudnessFrame>({
    momentaryLufs: -70.0,
    shortTermLufs: -70.0,
    integratedLufs: -70.0,
    truePeakDbtp: -120.0,
    channelPeaksDbfs: [ -120.0, -120.0 ],
    timestampMs: Date.now(),
  });

  const [isOverloaded, setIsOverloaded] = useState(false);
  const overloadTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Сброс измерителя
  const resetMeter = useCallback(async () => {
    await loudnessService.resetRealtimeLoudness(channels, sampleRate);
    setFrame({
      momentaryLufs: -70.0,
      shortTermLufs: -70.0,
      integratedLufs: -70.0,
      truePeakDbtp: -120.0,
      channelPeaksDbfs: new Array(channels).fill(-120.0),
      timestampMs: Date.now(),
    });
    setIsOverloaded(false);
  }, [channels, sampleRate]);

  // Оффлайн анализ
  const analyzeOffline = useCallback(async (bufferIdOrPath: string): Promise<LoudnessReport> => {
    return await loudnessService.analyzeTrackLoudness(bufferIdOrPath);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let unlisten: (() => void) | null = null;
    let isSubscribed = true;

    const setupListener = async () => {
      const isTauri = typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
      if (!isTauri) return;

      try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlistenFn = await listen<RealtimeLoudnessFrame>('loudness-update', (event) => {
          if (!isSubscribed) return;
          const data = event.payload;
          setFrame(data);

          // Проверка на превышение вещательного True Peak порога (-1.0 dBTP / 0.0 dBTP)
          if (data.truePeakDbtp > -1.0) {
            setIsOverloaded(true);
            if (onPeakOverload) {
              onPeakOverload(data.truePeakDbtp);
            }

            if (overloadTimerRef.current) {
              clearTimeout(overloadTimerRef.current);
            }
            overloadTimerRef.current = setTimeout(() => {
              if (isSubscribed) setIsOverloaded(false);
            }, 1500);
          }
        });

        unlisten = unlistenFn;
      } catch (err) {
        console.warn('[useLoudnessMeter] Не удалось подписаться на loudness-update:', err);
      }
    };

    setupListener();

    return () => {
      isSubscribed = false;
      if (unlisten) unlisten();
      if (overloadTimerRef.current) clearTimeout(overloadTimerRef.current);
    };
  }, [enabled, onPeakOverload]);

  return {
    momentaryLufs: frame.momentaryLufs,
    shortTermLufs: frame.shortTermLufs,
    integratedLufs: frame.integratedLufs,
    truePeakDbtp: frame.truePeakDbtp,
    channelPeaksDbfs: frame.channelPeaksDbfs,
    isOverloaded,
    lastUpdated: frame.timestampMs,
    resetMeter,
    analyzeOffline,
  };
};

export default useLoudnessMeter;
