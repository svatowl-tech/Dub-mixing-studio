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
}: { 
  peaks: number[], 
  zoom: number, 
  duration: number, 
  color: string, 
  visibleRange: { start: number, end: number }, 
  isRelative?: boolean,
  segmentOffset?: number, // fileOffset in the segment
  segmentStartTime?: number, // startTime on the timeline
  audioOffsetMs?: number // global project offset
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
    
    // Find the maximum peak for normalization
    let maxPeak = 0.0001; 
    for (let i = 0; i < peaks.length; i++) { 
        if (peaks[i] > maxPeak) maxPeak = peaks[i]; 
    }
    
    const scaleFactor = 1 / maxPeak;

    const totalPeaks = peaks.length;
    const peaksPerSecond = totalPeaks / duration;
    
    const startIdx = Math.max(0, Math.floor((drawStart + segmentOffset) * peaksPerSecond));
    const endIdx = Math.min(totalPeaks, Math.ceil((drawEnd + segmentOffset) * peaksPerSecond));
    
    const drawPoints: { x: number, yTop: number, yBottom: number }[] = [];
    
    for (let i = startIdx; i < endIdx; i++) {
      const normalizedPeak = peaks[i] * scaleFactor;
      // Mild log scale to make soft sounds visible while keeping loud parts under control
      const visualPeak = Math.pow(normalizedPeak, 0.55); 

      const localTime = (i / peaksPerSecond) - segmentOffset;
      const x = (localTime - drawStart) * zoom;
      
      // Leave 8% vertical margin so the outlines never clip the track container border
      const h = Math.max(1.5, visualPeak * (height * 0.84));
      const yTop = (height - h) / 2;
      const yBottom = (height + h) / 2;
      
      drawPoints.push({ x, yTop, yBottom });
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

    // Draw a very subtle middle-zero reference line, like professional DAWs
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(safeWidth, height / 2);
    ctx.strokeStyle = getRgbaColor(color, 0.15);
    ctx.lineWidth = 1;
    ctx.stroke();

    if (drawPoints.length > 1) {
      // 1. Draw continuous filled polygon for the main body
      const fillGradient = ctx.createLinearGradient(0, height * 0.08, 0, height * 0.92);
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

      // 2. Draw extremely sharp glowing top-line contour
      ctx.beginPath();
      ctx.moveTo(drawPoints[0].x, drawPoints[0].yTop);
      for (let i = 1; i < drawPoints.length; i++) {
        ctx.lineTo(drawPoints[i].x, drawPoints[i].yTop);
      }
      ctx.strokeStyle = getRgbaColor(color, 0.85); // High intensity outline
      ctx.lineWidth = 1.3;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // 3. Draw extremely sharp glowing bottom-line contour
      ctx.beginPath();
      ctx.moveTo(drawPoints[0].x, drawPoints[0].yBottom);
      for (let i = 1; i < drawPoints.length; i++) {
        ctx.lineTo(drawPoints[i].x, drawPoints[i].yBottom);
      }
      ctx.strokeStyle = getRgbaColor(color, 0.85);
      ctx.lineWidth = 1.3;
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else if (drawPoints.length === 1) {
      // Fallback for single data point
      ctx.beginPath();
      ctx.moveTo(drawPoints[0].x, drawPoints[0].yTop);
      ctx.lineTo(drawPoints[0].x, drawPoints[0].yBottom);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [peaks, zoom, duration, color, vRange, isRelative, segmentOffset, segmentStartTime, audioOffsetMs]);
  
  return <canvas ref={canvasRef} className="absolute top-0 h-full pointer-events-none" />;
};

export default VirtualizedWaveform;
