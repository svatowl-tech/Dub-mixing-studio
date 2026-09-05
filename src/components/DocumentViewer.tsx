import React, { useEffect, useRef, useState } from 'react';
import { 
  FileText, 
  Settings, 
  Maximize2, 
  Minimize2, 
  Type, 
  AlignLeft, 
  Zap,
  Layout
} from 'lucide-react';
import { cn } from '../lib/utils';
import { SubtitleLine } from '../types';
import { useSyncScriptScroll } from '../hooks/useSyncScriptScroll';

export const DocumentViewer = ({ 
  subtitles, 
  currentTime, 
  activeRole,
  onSeek,
  fontSize,
  lineHeight,
  pacing,
  mode,
  onFontSizeChange,
  onLineHeightChange,
  onPacingChange,
  onModeChange
}: { 
  subtitles: SubtitleLine[], 
  currentTime: number,
  activeRole: string,
  onSeek: (time: number) => void,
  fontSize: number,
  lineHeight: number,
  pacing: 'auto' | 'manual',
  mode: 'compact' | 'expanded',
  onFontSizeChange: (s: number) => void,
  onLineHeightChange: (h: number) => void,
  onPacingChange: (p: 'auto' | 'manual') => void,
  onModeChange: (m: 'compact' | 'expanded') => void
}) => {
  // Prioritize selection that matches the active role if multiple lines overlap
  const currentLineIndex = subtitles.findIndex(s => {
    const isTimeMatch = currentTime >= s.start && currentTime <= s.end;
    return isTimeMatch && (s.role === activeRole || !activeRole);
  }) || subtitles.findIndex(s => currentTime >= s.start && currentTime <= s.end);
  const containerRef = useRef<HTMLDivElement>(null);

  const { handleManualInteraction } = useSyncScriptScroll(currentTime, subtitles, containerRef);

  return (
    <div 
      className="flex flex-col h-full bg-zinc-950 border-l border-zinc-800 shadow-2xl z-20"
      onWheel={handleManualInteraction}
      onTouchMove={handleManualInteraction}
    >
      {/* Document Header */}
      <div className="h-14 border-b border-zinc-800 bg-zinc-900/50 flex items-center px-6 justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-500/10 rounded-lg flex items-center justify-center text-indigo-400">
            <FileText size={18} />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-black uppercase tracking-widest text-white">Редактор сценария</span>
            <span className="text-[10px] text-zinc-500 font-medium">
              {subtitles.length} строк • {Math.floor(currentTime / 60)}:{(currentTime % 60).toFixed(0).padStart(2, '0')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button 
            onClick={() => onModeChange(mode === 'compact' ? 'expanded' : 'compact')}
            className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-all"
            title="Переключить вид"
          >
            {mode === 'compact' ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
          </button>
          <div className="w-px h-6 bg-zinc-800 mx-1" />
          <button className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-all">
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Script Controls */}
      <div className="p-4 border-b border-zinc-800 bg-zinc-900/30 flex items-center gap-4">
        <div className="flex items-center gap-2 bg-black/40 p-1 rounded-lg border border-white/5">
          <button 
            onClick={() => onFontSizeChange(Math.max(12, fontSize - 2))}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors"
          >
            <Type size={14} className="scale-75" />
          </button>
          <span className="text-[10px] font-mono text-zinc-500 w-6 text-center">{fontSize}</span>
          <button 
            onClick={() => onFontSizeChange(Math.min(48, fontSize + 2))}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors"
          >
            <Type size={14} className="scale-110" />
          </button>
        </div>

        <div className="flex items-center gap-2 bg-black/40 p-1 rounded-lg border border-white/5">
          <button 
            onClick={() => onPacingChange(pacing === 'auto' ? 'manual' : 'auto')}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded text-[10px] font-black uppercase tracking-widest transition-all",
              pacing === 'auto' ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20" : "text-zinc-400 hover:text-white hover:bg-zinc-800"
            )}
          >
            <Zap size={12} fill={pacing === 'auto' ? "currentColor" : "none"} />
            {pacing === 'auto' ? 'Авто' : 'Ручн.'}
          </button>
        </div>
      </div>

      {/* Script Content */}
      <div ref={containerRef} className="flex-1 overflow-y-auto p-8 space-y-6 scroll-smooth no-scrollbar">
        {subtitles.map((line, idx) => {
          const isActive = idx === currentLineIndex;
          const isPast = currentTime > line.end;
          
          return (
            <div 
              key={idx}
              id={line.id || `sub-${line.start.toFixed(3)}`}
              onClick={() => onSeek(line.start)}
              className={cn(
                "group relative p-6 rounded-2xl transition-all duration-500 cursor-pointer border",
                line.needsFix
                  ? "bg-rose-500/10 border-rose-500/30 shadow-[0_0_40px_rgba(244,63,94,0.05)]"
                  : isActive 
                    ? "bg-indigo-500/10 border-indigo-500/30 shadow-[0_0_40px_rgba(99,102,241,0.05)]" 
                    : isPast 
                      ? "opacity-40 border-transparent hover:opacity-60" 
                      : "border-transparent hover:bg-white/5",
                isActive && line.needsFix && "ring-2 ring-rose-500 ring-offset-2 ring-offset-zinc-950"
              )}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className={cn(
                    "text-[10px] font-black uppercase tracking-[0.2em] px-2 py-0.5 rounded",
                    isActive ? "bg-indigo-500 text-white" : "text-zinc-500 bg-zinc-800"
                  )}>
                    {line.role || 'Актёр'}
                  </span>
                  <span className="text-[10px] font-mono text-zinc-600">
                    {Math.floor(line.start / 60)}:{(line.start % 60).toFixed(0).padStart(2, '0')}
                  </span>
                </div>
                {isActive && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-ping" />
                    <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Активно</span>
                  </div>
                )}
              </div>
              <p 
                className={cn(
                  "font-medium leading-relaxed transition-all duration-500",
                  isActive ? "text-white" : "text-zinc-400"
                )}
                style={{ fontSize: `${fontSize}px`, lineHeight: lineHeight }}
              >
                {line.text}
              </p>
              
              {line.needsFix && line.fixComment && (
                <div className="mt-4 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-200">
                  <span className="block text-[10px] font-bold uppercase tracking-widest opacity-60 mb-1">Правка от куратора</span>
                  <span className="text-sm">{line.fixComment}</span>
                </div>
              )}
              
              {/* Progress Bar for Active Line */}
              {isActive && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800 overflow-hidden rounded-b-2xl">
                  <div 
                    className="h-full bg-indigo-500 transition-all duration-100 ease-linear"
                    style={{ width: `${((currentTime - line.start) / (line.end - line.start)) * 100}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DocumentViewer;
