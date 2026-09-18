// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE WAVEFORM CANVAS (REACT)
// Сверхкомпактный компонент отрисовки плоского бинарного буфера координат из Rust
// Отрисовывает миллионы сэмплов за ОДИН проход ctx.stroke() с 0% GC нагрузкой
// ============================================================================

import React, { useEffect, useRef, memo } from 'react';
import { computeWaveformRenderBuckets, computeWaveformBucketsFromPeaks, renderNativeWaveformCoordsToCanvas } from '../lib/waveformBridge';

export interface NativeWaveformCanvasProps {
  /** Идентификатор буфера в кэше Rust или путь к файлу */
  bufferId?: string;
  /** Опциональный массив пиков с фронтенда (fallback) */
  peaks?: number[] | Float32Array;
  /** Начальный индекс сэмпла */
  startSample?: number;
  /** Конечный индекс сэмпла */
  endSample?: number;
  /** Цвет волновой формы */
  color?: string;
  /** Толщина линий */
  lineWidth?: number;
  /** Коэффициент степенного сжатия динамики (по умолчанию 0.6) */
  powerCurve?: number;
  /** Дополнительные CSS классы */
  className?: string;
}

export const NativeWaveformCanvas: React.FC<NativeWaveformCanvasProps> = memo(({
  bufferId,
  peaks,
  startSample = 0,
  endSample,
  color = '#38bdf8',
  lineWidth = 1.5,
  powerCurve = 0.6,
  className = 'w-full h-full'
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isCancelled = false;

    const renderWaveform = async () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width <= 0 || height <= 0 || isCancelled) return;

      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.floor(width * dpr);
      const targetHeight = Math.floor(height * dpr);

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) return;

      let coords: Float32Array;

      if (bufferId && bufferId !== 'raw_peaks') {
        // Нативный вызов Rust с поиском сэмплов в AudioBufferCache и Rayon бакетизацией
        coords = await computeWaveformRenderBuckets({
          bufferId,
          startSample,
          endSample: endSample ?? 100_000_000,
          targetPixelWidth: targetWidth,
          canvasHeight: targetHeight,
          powerCurve,
          rawPeaks: peaks ? (peaks instanceof Float32Array ? Array.from(peaks) : peaks) : undefined
        });
      } else if (peaks && peaks.length > 0) {
        coords = await computeWaveformBucketsFromPeaks(
          peaks,
          targetWidth,
          targetHeight,
          powerCurve
        );
      } else {
        return;
      }

      if (isCancelled || !canvas) return;

      // Сброс трансформации под физические пиксели
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, targetWidth, targetHeight);

      // Отрисовка плоского буфера [y_top, y_bot, ...] за ОДИН проход ctx.stroke()
      renderNativeWaveformCoordsToCanvas(ctx, coords, color, Math.max(1, lineWidth * dpr));
    };

    renderWaveform();

    const resizeObserver = new ResizeObserver(() => {
      renderWaveform();
    });
    resizeObserver.observe(canvas);

    return () => {
      isCancelled = true;
      resizeObserver.disconnect();
    };
  }, [bufferId, peaks, startSample, endSample, color, lineWidth, powerCurve]);

  return (
    <canvas 
      ref={canvasRef} 
      className={`pointer-events-none block ${className}`} 
    />
  );
});

NativeWaveformCanvas.displayName = 'NativeWaveformCanvas';
export default NativeWaveformCanvas;
