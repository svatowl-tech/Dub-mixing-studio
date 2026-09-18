import React, { useEffect, useRef } from 'react';
import { logger } from '../lib/logger';
import { computeWaveformBucketsFromPeaks, renderNativeWaveformCoordsToCanvas } from '../lib/waveformBridge';

export const Waveform = ({ 
  peaks, 
  color = '#3b82f6',
  scaleMode = 'real',
  gain = 1,
  powerCurve = 0.6
}: { 
  peaks: number[] | Float32Array, 
  color?: string,
  scaleMode?: 'real' | 'normalized',
  gain?: number,
  powerCurve?: number
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    if (!peaks || peaks.length === 0) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let isCancelled = false;

    const draw = async () => {
      if (!canvas || isCancelled) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width <= 0 || height <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.floor(width * dpr);
      const targetHeight = Math.floor(height * dpr);

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      // Вычисление координат Y в Rust (Rayon SIMD) с нелинейным степенным сжатием
      const coords = await computeWaveformBucketsFromPeaks(
        peaks,
        targetWidth,
        targetHeight,
        powerCurve
      );

      if (isCancelled || !canvas) return;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, targetWidth, targetHeight);

      // Отрисовка за ОДИН проход ctx.stroke() без JS аллокаций
      renderNativeWaveformCoordsToCanvas(ctx, coords, color, Math.max(1, dpr * 1.2));
    };

    draw();

    const resizeObserver = new ResizeObserver(() => {
      draw();
    });
    resizeObserver.observe(canvas);

    return () => {
      isCancelled = true;
      resizeObserver.disconnect();
    };
  }, [peaks, color, scaleMode, gain, powerCurve]);

  return <canvas ref={canvasRef} className="w-full h-full opacity-60 pointer-events-none block" />;
};


