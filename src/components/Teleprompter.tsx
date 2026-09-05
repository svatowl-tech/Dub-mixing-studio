import React, { useState, useRef, useEffect } from 'react';
import { Minus, Plus, ArrowUp, ArrowDown, Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { SubtitleLine } from '../types';

export const Teleprompter = ({ 
  subtitles, 
  currentTime, 
  mode,
  fontSize,
  lineHeight,
  pacing,
  activeRole,
  onFontSizeChange,
  onLineHeightChange,
  onPacingChange,
  onModeChange,
  onResize,
  onSeek
}: { 
  subtitles: SubtitleLine[], 
  currentTime: number,
  mode: 'compact' | 'expanded',
  fontSize: number,
  lineHeight: number,
  pacing: 'auto' | 'manual',
  activeRole: string,
  onFontSizeChange: (size: number) => void,
  onLineHeightChange: (height: number) => void,
  onPacingChange: (pacing: 'auto' | 'manual') => void,
  onModeChange: (mode: 'compact' | 'expanded') => void,
  onResize?: (width: number, height: number) => void,
  onSeek?: (time: number) => void
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [manualOffset, setManualOffset] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const [userInteracting, setUserInteracting] = useState(false);
  const interactionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const activeLine = subtitles.find(s => currentTime >= s.start && currentTime <= s.end && s.role === activeRole);
  const nextActiveLine = subtitles.find(s => s.start > currentTime && s.role === activeRole);

  const handleInteraction = () => {
    setUserInteracting(true);
    if (interactionTimeoutRef.current) clearTimeout(interactionTimeoutRef.current);
    interactionTimeoutRef.current = setTimeout(() => {
      setUserInteracting(false);
    }, 2000);
  };

  const timeToNext = nextActiveLine ? Math.max(0, nextActiveLine.start - currentTime) : null;

  const handleResizeStart = (e: React.MouseEvent | React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = containerRef.current?.parentElement?.clientWidth || 0;
    const startHeight = containerRef.current?.parentElement?.clientHeight || 0;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (onResize) {
        const newWidth = startWidth + (moveEvent.clientX - startX);
        const newHeight = startHeight + (moveEvent.clientY - startY);
        onResize(Math.max(300, newWidth), Math.max(100, newHeight));
      }
    };

    const onMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const activeLineIdRef = useRef<string | null>(null);

  const targetId = activeLine?.id || nextActiveLine?.id || null;

  // Auto-scroll logic (Optimized: trigger scroll only when active segment target ID changes)
  useEffect(() => {
    if (pacing === 'auto' && containerRef.current && !userInteracting && targetId) {
      if (targetId !== activeLineIdRef.current) {
        activeLineIdRef.current = targetId;
        // Small delay to ensure node is rendered in React first
        setTimeout(() => {
          const element = document.getElementById(`tp-line-${targetId}`);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 50);
      }
    } else if (!targetId) {
      activeLineIdRef.current = null;
    }
  }, [targetId, pacing, userInteracting]);

  // Handle keyboard pacing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (pacing === 'manual') {
        if (e.key === 'ArrowDown') setManualOffset(prev => prev + 20);
        if (e.key === 'ArrowUp') setManualOffset(prev => Math.max(0, prev - 20));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pacing]);

  const handleWheel = (e: WheelEvent) => {
    if (pacing === 'manual') {
      e.preventDefault();
      setManualOffset(prev => Math.max(0, prev + e.deltaY));
    }
  };

  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (container) {
      container.addEventListener('wheel', handleWheel as any, { passive: false });
      return () => container.removeEventListener('wheel', handleWheel as any);
    }
  }, [pacing]);

  // Find current line index (for optimization/virtualization)
  const currentLineIndex = subtitles.findIndex(s => currentTime >= s.start && currentTime <= s.end && s.role === activeRole);
  
  let targetIndex = currentLineIndex;
  if (targetIndex === -1 && nextActiveLine) {
    targetIndex = subtitles.findIndex(s => s.id === nextActiveLine.id);
  }
  if (targetIndex === -1) {
    targetIndex = 0;
  }

  // Slice subtitles to keep only a small window around the active index
  // This ensures lightning fast 60 fps rendering even with thousands of subtitles!
  const visibleSubtitles = subtitles.slice(
    Math.max(0, targetIndex - 6),
    Math.min(subtitles.length, targetIndex + 10)
  );

  return (
    <div 
      className={cn(
        "relative overflow-hidden pointer-events-auto",
        mode === 'expanded' ? "absolute inset-0 bg-black/60 backdrop-blur-sm z-[60] p-12 transition-all duration-500" : "w-full max-w-3xl mx-auto h-48 bg-black/70 backdrop-blur-md border border-white/10 rounded-2xl p-4 shadow-2xl"
      )}
    >
      {/* Controls Overlay */}
      <div 
        className="absolute top-4 right-4 flex items-center gap-2 z-10"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {timeToNext !== null && (
          <div className="bg-indigo-900/50 text-indigo-200 px-3 py-1 rounded-full text-xs font-mono font-bold mr-4">
            Далее: {timeToNext.toFixed(1)}с
          </div>
        )}
        <div className="flex bg-black/50 rounded-lg p-1 border border-white/10">
          <button onClick={() => onFontSizeChange(Math.max(12, fontSize - 2))} className="p-1.5 hover:bg-white/10 rounded transition-colors"><Minus className="w-3.5 h-3.5 text-white/70" /></button>
          <span className="flex items-center px-2 text-[10px] font-black text-white/50 w-10 justify-center">{fontSize}px</span>
          <button onClick={() => onFontSizeChange(Math.min(120, fontSize + 2))} className="p-1.5 hover:bg-white/10 rounded transition-colors"><Plus className="w-3.5 h-3.5 text-white/70" /></button>
        </div>
        
        <div className="flex bg-black/50 rounded-lg p-1 border border-white/10">
          <button onClick={() => onLineHeightChange(Math.max(1, lineHeight - 0.1))} className="p-1.5 hover:bg-white/10 rounded transition-colors"><ArrowDown className="w-3.5 h-3.5 text-white/70" /></button>
          <span className="flex items-center px-2 text-[10px] font-black text-white/50 w-8 justify-center">{lineHeight.toFixed(1)}</span>
          <button onClick={() => onLineHeightChange(Math.min(3, lineHeight + 0.1))} className="p-1.5 hover:bg-white/10 rounded transition-colors"><ArrowUp className="w-3.5 h-3.5 text-white/70" /></button>
        </div>

        <button 
          onClick={() => onPacingChange(pacing === 'auto' ? 'manual' : 'auto')}
          className={cn("px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all border", 
            pacing === 'manual' ? "bg-orange-500 border-orange-400 text-white shadow-[0_0_15px_rgba(249,115,22,0.3)]" : "bg-black/50 border-white/10 text-white/50 hover:bg-white/10")}
        >
          {pacing === 'auto' ? 'Авто' : 'Ручн.'}
        </button>

        <button 
          onClick={() => onModeChange(mode === 'compact' ? 'expanded' : 'compact')}
          className="p-1.5 bg-black/50 border border-white/10 rounded-lg hover:bg-white/10 transition-colors text-white/70"
        >
          {mode === 'expanded' ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
      </div>

      {/* Resize Handle */}
      {mode === 'compact' && (
        <div 
          className="absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize z-20 flex items-center justify-center group/resize"
          onPointerDown={handleResizeStart}
        >
          <div className="w-1.5 h-1.5 bg-white/20 rounded-full group-hover/resize:bg-indigo-500 transition-colors" />
        </div>
      )}

      {/* Focus Line */}
      <div className="absolute top-1/2 left-0 right-0 h-px bg-indigo-500/40 z-10 pointer-events-none flex items-center justify-between px-4">
        <div className="text-[8px] font-black uppercase tracking-widest text-indigo-400/60 bg-black/50 px-2 py-0.5 rounded border border-indigo-500/20">Фокус</div>
        <div className="flex-1 mx-4 h-px bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />
        <div className="text-[8px] font-black uppercase tracking-widest text-indigo-400/60 bg-black/50 px-2 py-0.5 rounded border border-indigo-500/20">Фокус</div>
      </div>

      <div 
        ref={containerRef}
        className="h-full overflow-y-auto no-scrollbar scroll-smooth"
        onWheel={() => {
          if (pacing === 'auto') handleInteraction();
        }}
        onTouchMove={() => {
          if (pacing === 'auto') handleInteraction();
        }}
      >
        <div 
          className={cn(
            "space-y-8 max-w-4xl mx-auto text-center transition-transform duration-100 ease-out",
            mode === 'expanded' ? "py-[50vh]" : "py-24"
          )}
          style={{ 
            transform: pacing === 'manual' ? `translateY(${-manualOffset}px)` : 'none'
          }}
        >
          {visibleSubtitles.map(line => {
            const isSelectedRole = line.role === activeRole;
            const isCurrent = currentTime >= line.start && currentTime <= line.end && isSelectedRole;
            return (
              <div 
                key={line.id}
                id={`tp-line-${line.id}`}
                onClick={() => {
                  if (onSeek) onSeek(line.start);
                }}
                className={cn(
                  "transition-all duration-300 px-8 cursor-pointer hover:bg-white/5 rounded-lg",
                  isSelectedRole 
                    ? (isCurrent ? "text-white scale-110 opacity-100 drop-shadow-[0_0_20px_rgba(255,255,255,0.3)]" : "text-white/70 opacity-70") 
                    : "text-zinc-600 opacity-30 scale-90"
                )}
                style={{ 
                  fontSize: isSelectedRole ? `${fontSize}px` : `${fontSize * 0.7}px`, 
                  lineHeight: lineHeight 
                }}
              >
                {line.text}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default Teleprompter;
