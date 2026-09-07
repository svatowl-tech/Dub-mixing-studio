import React, { useEffect, useRef } from 'react';

export const VirtualizedWaveform = ({ 
  peaks, 
  zoom, 
  duration, 
  color, 
  visibleRange: vRange, 
  isRelative = false,
  segmentOffset = 0,
  segmentStartTime = 0,
  audioOffsetMs = 0,
  gain = 1,
  trackVolume = 1,
  scaleMode = 'real',
  visualGain = 1,
}: { 
  peaks: number[], 
  zoom: number, 
  duration: number, 
  color: string, 
  visibleRange: { start: number, end: number }, 
  isRelative?: boolean,
  segmentOffset?: number, // fileOffset in the segment
  segmentStartTime?: number, // startTime on the timeline
  audioOffsetMs?: number, // global project offset
  gain?: number,
  trackVolume?: number,
  scaleMode?: 'real' | 'normalized',
  visualGain?: number,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Apply project-wide offset to visual start time
    const adjustedStartTime = segmentStartTime + (audioOffsetMs / 1000);
    
    // Calculate what part of the audio to draw
    let drawStart = vRange.start;
    let drawEnd = vRange.end;

    if (isRelative) {
      // For segments, visibleRange is timeline time (e.g. 10s to 30s)
      // adjustedStartTime might be 15s. So the local visible start is -5 to 15.
      // We only care about positive local time [0, duration]
      const localVisibleStart = Math.max(0, vRange.start - adjustedStartTime);
      const localVisibleEnd = Math.min(duration, vRange.end - adjustedStartTime);
      
      if (localVisibleStart >= localVisibleEnd) {
        // Completely out of view
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = 'none';
        return;
      }
      canvas.style.display = 'block';

      drawStart = localVisibleStart;
      drawEnd = localVisibleEnd;
    }
    
    // Add a bit of padding so we don't have artifacts at the edges when scrolling
    const padding = 20 / zoom; // 20 pixels padding
    drawStart = Math.max(0, drawStart - padding);
    drawEnd = Math.min(duration, drawEnd + padding);
    
    const width = Math.max(1, (drawEnd - drawStart) * zoom);
    const height = canvas.parentElement?.clientHeight || 48;
    
    const dpr = window.devicePixelRatio || 1;
    // Prevent giant canvases that crash the browser
    if (width > 32000) {
      console.warn("Waveform width exceeded 32000px, truncating.", width);
    }
    const safeWidth = Math.min(32000, width);
    
    canvas.width = safeWidth * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${safeWidth}px`;
    canvas.style.height = `${height}px`;
    
    if (isRelative) {
      canvas.style.left = `${(drawStart) * zoom}px`;
    } else {
      canvas.style.left = `${drawStart * zoom}px`;
    }
    
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, safeWidth, height);
    
    if (!peaks || peaks.length === 0 || duration <= 0) return;
    
    let scaleFactor = 1.0;
    if (scaleMode === 'normalized') {
      let maxPeak = 0.0001; 
      for (let i = 0; i < peaks.length; i++) { 
        if (peaks[i] > maxPeak) maxPeak = peaks[i]; 
      }
      scaleFactor = 1 / maxPeak;
    }

    const effectiveGain = (gain ?? 1.0) * (trackVolume ?? 1.0) * (visualGain ?? 1.0);

    const totalPeaks = peaks.length;
    const peaksPerSecond = totalPeaks / duration;
    
    const startIdx = Math.max(0, Math.floor((drawStart + segmentOffset) * peaksPerSecond));
    const endIdx = Math.min(totalPeaks, Math.ceil((drawEnd + segmentOffset) * peaksPerSecond));
    
    const drawPoints: { x: number, yTop: number, yBottom: number, isClipping: boolean }[] = [];
    
    for (let i = startIdx; i < endIdx; i++) {
      const rawPeak = peaks[i] || 0;
      let visualPeak = 0;
      let isClipping = false;

      if (scaleMode === 'normalized') {
        const normalizedPeak = rawPeak * scaleFactor * (visualGain ?? 1.0);
        visualPeak = Math.pow(Math.min(1.0, Math.max(0, normalizedPeak)), 0.7);
        isClipping = normalizedPeak > 1.05;
      } else {
        // REAL MODE: True linear amplitude relative to 0 dBFS (1.0 = Digital Full Scale)
        // Reflects real volume of the track and clip gain.
        const effectiveAmp = rawPeak * effectiveGain;
        isClipping = effectiveAmp > 1.001;
        visualPeak = Math.min(1.0, Math.max(0, effectiveAmp));
      }

      const localTime = (i / peaksPerSecond) - segmentOffset;
      const x = (localTime - drawStart) * zoom;
      
      // Real amplitude mapping:
      // Maximum full-scale (1.0 = 0 dBFS) uses 94% of the track height (3% margin top & bottom).
      // If visualPeak is 0 (silence), height is 0 (displays clean center zero reference line).
      const maxSpan = height * 0.94;
      const h = visualPeak > 0.0005 ? Math.max(1.5, visualPeak * maxSpan) : 0;
      const yTop = (height - h) / 2;
      const yBottom = (height + h) / 2;
      
      drawPoints.push({ x, yTop, yBottom, isClipping });
    }

    // Helper for beautiful translucent gradient fills
    const getRgbaColor = (hexOrRgb: string, alpha: number): string => {
      if (hexOrRgb.startsWith('rgba')) {
        return hexOrRgb.replace(/[\d.]+\)$/, `${alpha})`);
      }
      if (hexOrRgb.startsWith('rgb')) {
        return hexOrRgb.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
      }
      if (hexOrRgb.startsWith('#')) {
        const hex = hexOrRgb.replace('#', '');
        let r = 0, g = 0, b = 0;
        if (hex.length === 3) {
          r = parseInt(hex[0] + hex[0], 16);
          g = parseInt(hex[1] + hex[1], 16);
          b = parseInt(hex[2] + hex[2], 16);
        } else if (hex.length === 6) {
          r = parseInt(hex.substring(0, 2), 16);
          g = parseInt(hex.substring(2, 4), 16);
          b = parseInt(hex.substring(4, 6), 16);
        } else if (hex.length === 8) {
          r = parseInt(hex.substring(0, 2), 16);
          g = parseInt(hex.substring(2, 4), 16);
          b = parseInt(hex.substring(4, 6), 16);
        } else {
          return hexOrRgb;
        }
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
      return hexOrRgb;
    };

    // Draw a subtle middle-zero reference line, like professional DAWs
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(safeWidth, height / 2);
    ctx.strokeStyle = getRgbaColor(color, 0.18);
    ctx.lineWidth = 1;
    ctx.stroke();

    if (drawPoints.length > 1) {
      // 1. Draw continuous filled polygon for the main body
      const fillGradient = ctx.createLinearGradient(0, height * 0.05, 0, height * 0.95);
      fillGradient.addColorStop(0, getRgbaColor(color, 0.08));  // slight outer fade
      fillGradient.addColorStop(0.3, getRgbaColor(color, 0.45)); // rich inner body
      fillGradient.addColorStop(0.5, getRgbaColor(color, 0.55)); // brightest center
      fillGradient.addColorStop(0.7, getRgbaColor(color, 0.45));
      fillGradient.addColorStop(1, getRgbaColor(color, 0.08));

      ctx.beginPath();
      ctx.moveTo(drawPoints[0].x, drawPoints[0].yTop);
      for (let i = 1; i < drawPoints.length; i++) {
        ctx.lineTo(drawPoints[i].x, drawPoints[i].yTop);
      }
      // Loop backwards to draw the bottom half
      for (let i = drawPoints.length - 1; i >= 0; i--) {
        ctx.lineTo(drawPoints[i].x, drawPoints[i].yBottom);
      }
      ctx.closePath();
      ctx.fillStyle = fillGradient;
      ctx.fill();

      // 2. Draw sharp glowing top-line contour
      ctx.beginPath();
      ctx.moveTo(drawPoints[0].x, drawPoints[0].yTop);
      for (let i = 1; i < drawPoints.length; i++) {
        ctx.lineTo(drawPoints[i].x, drawPoints[i].yTop);
      }
      ctx.strokeStyle = getRgbaColor(color, 0.85); // High intensity outline
      ctx.lineWidth = 1.3;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // 3. Draw sharp glowing bottom-line contour
      ctx.beginPath();
      ctx.moveTo(drawPoints[0].x, drawPoints[0].yBottom);
      for (let i = 1; i < drawPoints.length; i++) {
        ctx.lineTo(drawPoints[i].x, drawPoints[i].yBottom);
      }
      ctx.strokeStyle = getRgbaColor(color, 0.85);
      ctx.lineWidth = 1.3;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // 4. Digital clipping indicators (> 0 dBFS)
      const hasClipping = drawPoints.some(p => p.isClipping);
      if (hasClipping) {
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.95)'; // Rose-500 clipping alert
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        for (let i = 0; i < drawPoints.length; i++) {
          if (drawPoints[i].isClipping) {
            ctx.moveTo(drawPoints[i].x - 1, drawPoints[i].yTop);
            ctx.lineTo(drawPoints[i].x + 1, drawPoints[i].yTop);
            ctx.moveTo(drawPoints[i].x - 1, drawPoints[i].yBottom);
            ctx.lineTo(drawPoints[i].x + 1, drawPoints[i].yBottom);
          }
        }
        ctx.stroke();
      }
    } else if (drawPoints.length === 1) {
      // Fallback for single data point
      ctx.beginPath();
      ctx.moveTo(drawPoints[0].x, drawPoints[0].yTop);
      ctx.lineTo(drawPoints[0].x, drawPoints[0].yBottom);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [peaks, zoom, duration, color, vRange, isRelative, segmentOffset, segmentStartTime, audioOffsetMs, gain, trackVolume, scaleMode, visualGain]);
  
  return <canvas ref={canvasRef} className="absolute top-0 h-full pointer-events-none" />;
};

export default VirtualizedWaveform;
