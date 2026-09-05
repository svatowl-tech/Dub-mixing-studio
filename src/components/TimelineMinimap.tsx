import React, { useRef, useEffect } from 'react';
import { Project } from '../types';
import { useTimelineData } from '../contexts/TimelineContext';

interface TimelineMinimapProps {
  project: Project;
  duration: number;
  onSeek: (time: number) => void;
  visibleRange: { start: number, end: number };
}

const MinimapPlayhead: React.FC<{ duration: number; visibleRange: { start: number, end: number } }> = ({ duration, visibleRange }) => {
  const { currentTime } = useTimelineData();
  
  const viewportLeft = duration > 0 ? (visibleRange.start / duration) * 100 : 0;
  const viewportWidth = duration > 0 ? ((visibleRange.end - visibleRange.start) / duration) * 100 : 100;
  const playheadPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <>
      <div 
        className="absolute top-0 bottom-0 w-full pointer-events-none"
        style={{ transform: `translateX(${viewportLeft}%)` }}
      >
        <div 
          className="absolute top-0 bottom-0 border-x border-white/20 bg-white/5"
          style={{ width: `${viewportWidth}%` }}
        />
      </div>

      <div 
        className="absolute top-0 bottom-0 w-full pointer-events-none z-10"
        style={{ transform: `translateX(${playheadPercent}%)` }}
      >
        <div className="absolute top-0 bottom-0 w-[2px] bg-rose-500 -ml-[1px]" />
        <div className="absolute top-0 left-0 -ml-[3px] w-2 h-2 bg-rose-500 rounded-full" />
      </div>
    </>
  );
};

export const TimelineMinimap = React.memo(({
  project,
  duration,
  onSeek,
  visibleRange
}: TimelineMinimapProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Draw background
    ctx.fillStyle = '#09090b'; // zinc-950
    ctx.fillRect(0, 0, width, height);

    // Draw tracks/segments
    const trackHeight = height / (project.tracks.length || 1);
    
    project.tracks.forEach((track, idx) => {
      const y = idx * trackHeight;
      const isOriginal = track.name === 'Оригинал' || track.name === 'Originals';
      
      ctx.fillStyle = isOriginal ? 'rgba(79, 70, 229, 0.2)' : 'rgba(161, 161, 170, 0.1)';
      ctx.fillRect(0, y, width, trackHeight - 1);

      track.segments.forEach(seg => {
        const x = (seg.startTime / duration) * width;
        const w = (seg.duration / duration) * width;
        
        ctx.fillStyle = isOriginal ? '#6366f1' : '#f43f5e';
        // Draw slightly thinner than the track height
        ctx.fillRect(x, y + 2, Math.max(1, w), trackHeight - 4);
      });
    });

  }, [project, duration]);

  const handleInteraction = (e: React.MouseEvent | React.TouchEvent) => {
    if (!containerRef.current || duration <= 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const time = (x / rect.width) * duration;
    onSeek(time);
  };

  return (
    <div 
      className="h-full border-b border-zinc-800 bg-zinc-950 relative cursor-pointer group select-none flex-1 w-full overflow-hidden"
      ref={containerRef}
      onMouseDown={(e) => {
        if (e.button === 0) handleInteraction(e);
      }}
      onMouseMove={(e) => {
        if (e.buttons === 1) handleInteraction(e);
      }}
      onTouchMove={handleInteraction}
    >
      <canvas 
        ref={canvasRef}
        className="w-full h-full opacity-60 group-hover:opacity-100 transition-opacity"
      />
      
      <MinimapPlayhead duration={duration} visibleRange={visibleRange} />
    </div>
  );
}, (prev, next) => {
  return prev.project === next.project &&
         prev.duration === next.duration &&
         prev.visibleRange.start === next.visibleRange.start &&
         prev.visibleRange.end === next.visibleRange.end;
});
