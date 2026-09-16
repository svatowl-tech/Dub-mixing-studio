// ============================================================================
// DUB MIXING STUDIO PRO - REACT HOOK: USE REALTIME SPECTRUM
// Высокопроизводительный React-хук для рендеринга БПФ-спектра на <canvas>
// без ререндеров React-дерева и просадки FPS
// ============================================================================

import React, { useEffect, useRef, useCallback } from 'react';
import { SpectrumFramePayload } from '../types';
import { realtimeAnalyzerService } from '../services/realtimeAnalyzerService';
import { isTauriAvailable } from '../lib/utils';

export interface UseRealtimeSpectrumOptions {
  enabled?: boolean;
  sampleRate?: number;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  mode?: 'bars' | 'curve' | 'gradient' | 'octave';
  primaryColor?: string;
  secondaryColor?: string;
  minDb?: number; // e.g. -90
  maxDb?: number; // e.g. 0
  onFrame?: (frame: SpectrumFramePayload) => void;
}

export interface UseRealtimeSpectrumReturn {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  renderFrameToCanvas: (canvas: HTMLCanvasElement, frame: SpectrumFramePayload) => void;
}

export const useRealtimeSpectrum = (
  options: UseRealtimeSpectrumOptions = {}
): UseRealtimeSpectrumReturn => {
  const {
    enabled = true,
    sampleRate = 48000,
    canvasRef,
    mode = 'bars',
    primaryColor = '#3b82f6',
    secondaryColor = '#60a5fa',
    minDb = -90,
    maxDb = 0,
    onFrame,
  } = options;

  const latestFrameRef = useRef<SpectrumFramePayload>({
    bands: new Array(64).fill(-90),
    peak: 0,
    rms: 0,
    dominantFreqHz: 0,
    timestampMs: Date.now(),
  });

  const animFrameIdRef = useRef<number | null>(null);
  const isListeningRef = useRef<boolean>(false);
  const unlistenFnRef = useRef<(() => void) | null>(null);

  // Прямой рендер кадра на Canvas без прохождения через React reconciliation
  const renderFrameToCanvas = useCallback(
    (canvas: HTMLCanvasElement, frame: SpectrumFramePayload) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      if (width === 0 || height === 0) return;

      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const bands = frame.bands;
      const numBands = bands.length;
      if (numBands === 0) {
        ctx.restore();
        return;
      }

      const dbRange = Math.max(1, maxDb - minDb);

      if (mode === 'curve') {
        // Плавная спектральная кривая (Filled Spline Curve)
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, primaryColor);
        gradient.addColorStop(0.7, secondaryColor);
        gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

        ctx.fillStyle = gradient;
        ctx.strokeStyle = primaryColor;
        ctx.lineWidth = 2;

        ctx.beginPath();
        ctx.moveTo(0, height);

        for (let i = 0; i < numBands; i++) {
          const x = (i / (numBands - 1)) * width;
          const normalized = Math.max(0, Math.min(1, (bands[i] - minDb) / dbRange));
          const y = height - normalized * height;

          if (i === 0) {
            ctx.lineTo(x, y);
          } else {
            const prevX = ((i - 1) / (numBands - 1)) * width;
            const prevNorm = Math.max(0, Math.min(1, (bands[i - 1] - minDb) / dbRange));
            const prevY = height - prevNorm * height;
            const cpX = (prevX + x) / 2;
            ctx.quadraticCurveTo(cpX, prevY, x, y);
          }
        }

        ctx.lineTo(width, height);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        // Логарифмические спектральные полосы (64 Bars с закругленными верхушками)
        const barSpacing = 1.5;
        const totalSpacing = barSpacing * (numBands - 1);
        const barWidth = Math.max(1.5, (width - totalSpacing) / numBands);

        for (let i = 0; i < numBands; i++) {
          const x = i * (barWidth + barSpacing);
          const normalized = Math.max(0, Math.min(1, (bands[i] - minDb) / dbRange));
          const barHeight = Math.max(2, normalized * height);
          const y = height - barHeight;

          // Вертикальный цветовой градиент для полосы
          const barGrad = ctx.createLinearGradient(0, y, 0, height);
          barGrad.addColorStop(0, primaryColor);
          barGrad.addColorStop(1, secondaryColor);

          ctx.fillStyle = barGrad;

          // Закругленный прямоугольник
          const radius = Math.min(barWidth / 2, 2);
          ctx.beginPath();
          ctx.moveTo(x + radius, y);
          ctx.lineTo(x + barWidth - radius, y);
          ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
          ctx.lineTo(x + barWidth, height);
          ctx.lineTo(x, height);
          ctx.lineTo(x, y + radius);
          ctx.quadraticCurveTo(x, y, x + radius, y);
          ctx.closePath();
          ctx.fill();
        }
      }

      ctx.restore();
    },
    [maxDb, minDb, mode, primaryColor, secondaryColor]
  );

  // Цикл отрисовки на requestAnimationFrame (60 FPS без ререндеров React)
  useEffect(() => {
    if (!enabled) return;

    let isRunning = true;

    const renderLoop = () => {
      if (!isRunning) return;

      if (canvasRef?.current) {
        renderFrameToCanvas(canvasRef.current, latestFrameRef.current);
      }

      animFrameIdRef.current = requestAnimationFrame(renderLoop);
    };

    animFrameIdRef.current = requestAnimationFrame(renderLoop);

    return () => {
      isRunning = false;
      if (animFrameIdRef.current !== null) {
        cancelAnimationFrame(animFrameIdRef.current);
      }
    };
  }, [enabled, canvasRef, renderFrameToCanvas]);

  // Подписка на нативный Tauri Event `spectrum-frame`
  useEffect(() => {
    if (!enabled) return;

    let isSubscribed = true;

    const setupListener = async () => {
      if (isTauriAvailable()) {
        try {
          const { listen } = await import('@tauri-apps/api/event');
          const unlisten = await listen<SpectrumFramePayload>('spectrum-frame', (event) => {
            if (!isSubscribed) return;
            latestFrameRef.current = event.payload;
            if (onFrame) {
              onFrame(event.payload);
            }
          });
          unlistenFnRef.current = unlisten;
          isListeningRef.current = true;
        } catch (err) {
          console.warn('Failed to listen to spectrum-frame event:', err);
        }
      } else {
        // Fallback симуляция для браузерного режима
        const interval = setInterval(() => {
          if (!isSubscribed) return;
          const fakeBands = new Array(64).fill(0).map((_, idx) => {
            const base = -60 + Math.sin(Date.now() * 0.005 + idx * 0.2) * 20;
            return Math.max(-90, Math.min(0, base));
          });
          const fakePayload: SpectrumFramePayload = {
            bands: fakeBands,
            peak: 0.7,
            rms: 0.4,
            dominantFreqHz: 440,
            timestampMs: Date.now(),
          };
          latestFrameRef.current = fakePayload;
          if (onFrame) onFrame(fakePayload);
        }, 16);

        return () => clearInterval(interval);
      }
    };

    const cleanupPromise = setupListener();

    return () => {
      isSubscribed = false;
      if (unlistenFnRef.current) {
        unlistenFnRef.current();
        unlistenFnRef.current = null;
      }
      cleanupPromise?.then((fn) => fn && fn());
    };
  }, [enabled, onFrame]);

  const start = useCallback(async () => {
    await realtimeAnalyzerService.startAnalyzer(sampleRate);
  }, [sampleRate]);

  const stop = useCallback(async () => {
    await realtimeAnalyzerService.stopAnalyzer();
  }, []);

  return {
    start,
    stop,
    renderFrameToCanvas,
  };
};
