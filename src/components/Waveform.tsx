import React, { useEffect, useRef } from 'react';
import { logger } from '../lib/logger';

export const Waveform = ({ 
  peaks, 
  color = '#3b82f6',
  scaleMode = 'real',
  gain = 1
}: { 
  peaks: number[], 
  color?: string,
  scaleMode?: 'real' | 'normalized',
  gain?: number
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      logger.debug("Waveform: canvas is null");
      return;
    }
    if (!peaks || peaks.length === 0) {
      logger.debug("Waveform: peaks are empty or undefined", { length: peaks?.length });
      return;
    }
    logger.debug(`Waveform: drawing peaks. Length: ${peaks.length}, color: ${color}`);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      if (!canvas) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return; // Wait for layout

      const dpr = window.devicePixelRatio || 1;

      // Always reset canvas size properly for high DPI
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.resetTransform();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);
      
      let scaleFactor = 1.0;
      if (scaleMode === 'normalized') {
        let maxPeak = 0.0001;
        for (let i = 0; i < peaks.length; i++) {
          if (peaks[i] > maxPeak) maxPeak = peaks[i];
        }
        scaleFactor = 1 / maxPeak;
      }

      // Draw beautiful, spaced vertical bars with rounded caps like professional DAWs
      const barWidth = 2;
      const barGap = 1.5;
      const numBars = Math.floor(width / (barWidth + barGap));

      if (numBars > 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth = barWidth;
        ctx.lineCap = 'round';
        
        ctx.beginPath();
        const bucketSize = peaks.length / numBars;
        for (let i = 0; i < numBars; i++) {
          const startIdx = Math.floor(i * bucketSize);
          let endIdx = Math.floor((i + 1) * bucketSize);
          if (endIdx === startIdx) endIdx = startIdx + 1; // ensure we grab at least one sample
          endIdx = Math.min(peaks.length, endIdx);
          
          let maxVal = 0;
          for (let j = startIdx; j < endIdx; j++) {
            if (peaks[j] > maxVal) maxVal = peaks[j];
          }
          
          let visualPeak = 0;
          if (scaleMode === 'normalized') {
            const normalizedPeak = maxVal * scaleFactor;
            visualPeak = Math.pow(Math.min(1.0, Math.max(0, normalizedPeak)), 0.6);
          } else {
            // Real amplitude proportional to 0 dBFS
            visualPeak = Math.min(1.0, Math.max(0, maxVal * gain));
          }
          
          const x = i * (barWidth + barGap) + barWidth / 2;
          const h = visualPeak > 0.001 ? Math.max(1.5, visualPeak * height * 0.94) : 0;
          const y1 = (height - h) / 2;
          const y2 = (height + h) / 2;
          
          ctx.moveTo(x, y1);
          ctx.lineTo(x, y2);
        }
        ctx.stroke();
      }
    };

    draw();

    // Redraw if resized
    const resizeObserver = new ResizeObserver(() => {
      draw();
    });
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
    };
  }, [peaks, color, scaleMode, gain]);

  return <canvas ref={canvasRef} className="w-full h-full opacity-60 pointer-events-none block" />;
};

