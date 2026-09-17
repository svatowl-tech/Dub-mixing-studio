import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { AudioTrack, AudioSegment } from '../types';
import { getTimelineVisiblePeaks, renderTrackPeaksToCanvas, TimelineTrackData } from '../lib/waveformBridge';

interface TrackWaveformCanvasProps {
  track: AudioTrack;
  zoom: number;
  visibleRange: { start: number; end: number };
  audioOffsetMs?: number;
  height?: number;
  color?: string;
  visualGain?: number;
}

/**
 * Высокопроизводительный канвас волновых форм дорожки.
 * Заменяет сотни отдельных канвасов на клипах ОДНИМ легким канвасом на всю дорожку.
 * Использует Rust Frustum Culling и LOD Mipmaps для поддержания 60 FPS при 2000+ клипах.
 */
export const TrackWaveformCanvas: React.FC<TrackWaveformCanvasProps> = React.memo(({
  track,
  zoom,
  visibleRange,
  audioOffsetMs = 0,
  height = 80,
  color = '#60a5fa',
  visualGain = 1.0,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const pendingRafRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateWidth = () => {
      const parent = canvas.parentElement;
      if (parent) {
        setCanvasWidth(parent.clientWidth);
      }
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    if (canvas.parentElement) {
      observer.observe(canvas.parentElement);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasWidth <= 0 || height <= 0 || !visibleRange) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    if (pendingRafRef.current) {
      cancelAnimationFrame(pendingRafRef.current);
    }

    pendingRafRef.current = requestAnimationFrame(async () => {
      const dpr = window.devicePixelRatio || 1;
      const targetWidth = canvasWidth * dpr;
      const targetHeight = height * dpr;

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        canvas.style.width = `${canvasWidth}px`;
        canvas.style.height = `${height}px`;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, canvasWidth, height);

      // Подготовка данных для Rust Culling Engine
      const offsetSec = audioOffsetMs / 1000;
      const vStartMs = Math.max(0, Math.floor((visibleRange.start - offsetSec) * 1000));
      const vEndMs = Math.max(1, Math.ceil((visibleRange.end - offsetSec) * 1000));

      const rustTrack: TimelineTrackData = {
        id: track.id,
        name: track.name,
        volume: track.volume ?? 1.0,
        isMuted: track.isMuted,
        isSolo: track.isSolo,
        segments: track.segments.map((seg: AudioSegment) => ({
          id: seg.id,
          filePath: seg.filePath,
          bufferId: (seg as any).bufferId,
          startTime: seg.startTime,
          duration: seg.duration,
          fileOffset: seg.fileOffset ?? 0,
          gain: seg.gain ?? 1.0,
          isMuted: (seg as any).isMuted ?? false,
          waveform: seg.waveform,
        })),
      };

      try {
        const payload = await getTimelineVisiblePeaks({
          viewportStartMs: vStartMs,
          viewportEndMs: vEndMs,
          canvasWidthPx: canvasWidth,
          activeTrackIds: [track.id],
          tracks: [rustTrack],
        });

        const trackResult = payload.tracks.find((t) => t.trackId === track.id);
        if (trackResult && trackResult.peaks.length > 0) {
          renderTrackPeaksToCanvas(ctx, trackResult.peaks, 0, height, {
            color,
            fillGradient: true,
            style: 'envelope',
            visualGain,
            centerLine: false,
            verticalMargin: 6,
          });
        }
      } catch (err) {
        console.warn('Rust timeline culling error:', err);
      }
    });

    return () => {
      if (pendingRafRef.current) {
        cancelAnimationFrame(pendingRafRef.current);
      }
    };
  }, [track, zoom, visibleRange, audioOffsetMs, height, color, visualGain, canvasWidth]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none z-0 opacity-80"
    />
  );
});

TrackWaveformCanvas.displayName = 'TrackWaveformCanvas';
export default TrackWaveformCanvas;
