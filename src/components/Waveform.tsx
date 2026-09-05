import React, { useEffect, useRef } from 'react';
import { logger } from '../lib/logger';

export const Waveform = ({ peaks, color = '#3b82f6' }: { peaks: number[], color?: string }) => {
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
      
      // Find maximum peak to normalize the visual waveform
      let maxPeak = 0.0001;
      for (let i = 0; i < peaks.length; i++) {
          if (peaks[i] > maxPeak) maxPeak = peaks[i];
      }
      const scaleFactor = 1 / maxPeak;

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
          
          const normalizedPeak = maxVal * scaleFactor;
          const visualPeak = Math.pow(normalizedPeak, 0.6); // slight curve boost for lower sounds
          
          const x = i * (barWidth + barGap) + barWidth / 2;
          const h = Math.max(2, visualPeak * height * 0.85); // ensure thin visible line for low amplitude
          const y1 = (height - h) / 2;
          const y2 = y1 + h;
          
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
  }, [peaks, color]);

  return <canvas ref={canvasRef} className="w-full h-full opacity-60 pointer-events-none block" />;
};

