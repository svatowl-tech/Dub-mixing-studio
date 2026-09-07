import React, { useState, useEffect } from 'react';
import { GripVertical, Trash2, RotateCcw, Scissors, Edit3, Maximize, Volume2, Video, Copy, ClipboardPaste, AlertTriangle, CheckCircle2, Wand2, Activity } from 'lucide-react';
import { cn } from '../lib/utils';
import { AudioSegment } from '../types';
import { VirtualizedWaveform } from './VirtualizedWaveform';
import { SmartAlignService } from '../services/smartAlignService';
import { ContextMenu } from './ContextMenu';
import { logger } from '../lib/logger';
import { SpectralAnalysisModal } from './SpectralAnalysisModal';

export const AudioSegmentView = React.memo(({ 
  seg, 
  trackId,
  zoom, 
  audioOffsetMs, 
  timelineVisibleRange,
  onUpdateSegment,
  onDeleteSegment,
  snapTime,
  onSnapLine,
  onSplitSegment,
  onDuplicateSegment,
  isSelected,
  onSelectSegment,
  onCopySegments,
  onCutSegments,
  onPasteSegments,
  onGlueSegments,
  currentTimeRef,
  autoFadeIn = 0,
  autoFadeOut = 0,
  trackVolume,
  waveformScaleMode = 'real',
  waveformVisualGain = 1
}: { 
  seg: AudioSegment, 
  trackId: string,
  zoom: number, 
  audioOffsetMs: number,
  timelineVisibleRange?: { start: number, end: number },
  onUpdateSegment: (trackId: string, segmentId: string, updates: Partial<AudioSegment>, targetTrackId?: string) => void,
  onDeleteSegment?: (trackId: string, segmentId: string) => void,
  snapTime: (time: number, excludeId?: string) => { time: number, snapped: boolean },
  onSnapLine: (time: number | null) => void,
  onSplitSegment?: (trackId: string, segmentId: string, time: number) => void,
  onDuplicateSegment?: (trackId: string, segmentId: string, newStartTime: number) => void,
  isSelected?: boolean,
  onSelectSegment?: (segmentId: string, multi: boolean) => void,
  onCopySegments?: () => void,
  onCutSegments?: () => void,
  onPasteSegments?: () => void,
  onGlueSegments?: () => void,
  currentTimeRef?: React.MutableRefObject<number>,
  autoFadeIn?: number,
  autoFadeOut?: number,
  trackVolume?: number,
  waveformScaleMode?: 'real' | 'normalized',
  waveformVisualGain?: number,
  key?: string | number
}) => {
  const [isResizing, setIsResizing] = useState<'left' | 'right' | 'drag' | 'slip' | null>(null);
  const [showVolume, setShowVolume] = useState(false);
  const [isAligning, setIsAligning] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null);
  const [activeLineDrag, setActiveLineDrag] = useState<'volume' | 'panning' | null>(null);
  const [showSpectralAnalysis, setShowSpectralAnalysis] = useState(false);

  const handleLineMouseDown = (e: React.MouseEvent, type: 'volume' | 'panning') => {
    e.stopPropagation();
    e.preventDefault();
    
    if (onSelectSegment) onSelectSegment(seg.id, e.shiftKey);
    setActiveLineDrag(type);

    const segmentEl = e.currentTarget.parentElement;
    if (!segmentEl) return;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const rect = segmentEl.getBoundingClientRect();
      const clientY = moveEvent.clientY;
      const relativeY = (clientY - rect.top) / rect.height;

      if (type === 'volume') {
        // Upper zone: 10% to 45% of height mapping to 2.0 down to 0.0 gain
        const clampedY = Math.max(0.10, Math.min(0.45, relativeY));
        const t = (0.45 - clampedY) / (0.45 - 0.10); // 0 at 45% (mute), 1 at 10% (max volume)
        const newGain = t * 2.0;
        const roundedGain = Math.round(newGain * 100) / 100;
        onUpdateSegment(trackId, seg.id, { gain: roundedGain });
      } else {
        // Lower zone: 55% to 90% of height mapping to -1.0 to 1.0 panning
        const clampedY = Math.max(0.55, Math.min(0.90, relativeY));
        const t = (clampedY - 0.725) / 0.175; // 0 at 72.5% (center), -1 at 55% (L), 1 at 90% (R)
        const newPanning = Math.max(-1, Math.min(1, t));
        const roundedPanning = Math.round(newPanning * 20) / 20; // steps of 0.05
        onUpdateSegment(trackId, seg.id, { panning: roundedPanning });
      }
    };

    const handleMouseUp = () => {
      setActiveLineDrag(null);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isSelected && onSelectSegment) {
      onSelectSegment(seg.id, false);
    }
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleMouseDown = (e: React.MouseEvent, side: 'left' | 'right' | 'drag') => {
    e.stopPropagation();
    
    let currentMode: 'left' | 'right' | 'drag' | 'slip' = side;
    if (side === 'drag' && e.altKey) {
      currentMode = 'slip';
    }
    
    setIsResizing(currentMode);
    
    const startX = e.clientX;
    const initialStartTime = seg.startTime;
    const initialDuration = seg.duration;
    const initialFileOffset = seg.fileOffset;
    
    // For duplicate
    let hasDuplicated = false;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaT = deltaX / zoom;

      if (currentMode === 'left') {
        const rawStartTime = Math.max(0, initialStartTime + deltaT);
        const { time: snappedStartTime, snapped } = moveEvent.shiftKey ? { time: rawStartTime, snapped: false } : snapTime(rawStartTime, seg.id);
        onSnapLine(snapped ? snappedStartTime : null);
        
        let actualDeltaT = snappedStartTime - initialStartTime;
        
        // Ensure we don't trim past the available fileOffset
        actualDeltaT = Math.max(actualDeltaT, -initialFileOffset);
        // Ensure we don't shrink the duration below 0.1s
        if (initialDuration - actualDeltaT < 0.1) {
            actualDeltaT = initialDuration - 0.1;
        }

        const finalStartTime = initialStartTime + actualDeltaT;
        const newDuration = initialDuration - actualDeltaT;
        const newFileOffset = initialFileOffset + actualDeltaT;
        
        // Ensure we don't trim past the file end, with 2ms tolerance for float precision
        if (Math.abs(actualDeltaT) > 0.001) {
          if (newFileOffset + newDuration <= (seg.fileDuration || seg.duration) + 0.002) {
            onUpdateSegment(trackId, seg.id, { 
              startTime: finalStartTime, 
              duration: newDuration, 
              fileOffset: newFileOffset 
            });
          }
        }
      } else if (side === 'right') {
        const rawEndTime = initialStartTime + initialDuration + deltaT;
        const { time: snappedEndTime, snapped } = moveEvent.shiftKey ? { time: rawEndTime, snapped: false } : snapTime(rawEndTime, seg.id);
        onSnapLine(snapped ? snappedEndTime : null);
        
        let actualDeltaT = snappedEndTime - (initialStartTime + initialDuration);
        
        // Don't drag beyond available file end!
        const maxDeltaT = (seg.fileDuration || seg.duration) - (initialFileOffset + initialDuration);
        actualDeltaT = Math.min(actualDeltaT, maxDeltaT);
        
        const newDuration = Math.max(0.1, initialDuration + actualDeltaT);
        
        // Ensure we don't trim past the file end, with 2ms tolerance for float precision
        if (Math.abs(actualDeltaT) > 0.001) {
          if (initialFileOffset + newDuration <= (seg.fileDuration || seg.duration) + 0.002) {
            onUpdateSegment(trackId, seg.id, { duration: newDuration });
          }
        }
      } else if (currentMode === 'slip') {
        const newFileOffset = Math.max(0, initialFileOffset - deltaT);
        if (newFileOffset + initialDuration <= seg.fileDuration) {
          onUpdateSegment(trackId, seg.id, { fileOffset: newFileOffset });
        }
      } else if (currentMode === 'drag') {
        const rawStart = Math.max(0, initialStartTime + deltaT);
        const rawEnd = rawStart + initialDuration;
        
        const snapStart = moveEvent.shiftKey ? { time: rawStart, snapped: false } : snapTime(rawStart, seg.id);
        const snapEnd = moveEvent.shiftKey ? { time: rawEnd, snapped: false } : snapTime(rawEnd, seg.id);
        
        let finalStart = rawStart;
        let snapLineTime = null;

        if (snapStart.snapped && snapEnd.snapped) {
           if (Math.abs(snapStart.time - rawStart) < Math.abs(snapEnd.time - rawEnd)) {
               finalStart = snapStart.time;
               snapLineTime = snapStart.time;
           } else {
               finalStart = snapEnd.time - initialDuration;
               snapLineTime = snapEnd.time;
           }
        } else if (snapStart.snapped) {
           finalStart = snapStart.time;
           snapLineTime = snapStart.time;
        } else if (snapEnd.snapped) {
           finalStart = snapEnd.time - initialDuration;
           snapLineTime = snapEnd.time;
        }

        onSnapLine(snapLineTime);
        
        let targetTrackId: string | undefined = undefined;
        const trackContainers = document.querySelectorAll('.timeline-track');
        trackContainers.forEach(container => {
          const rect = container.getBoundingClientRect();
          if (moveEvent.clientY >= rect.top && moveEvent.clientY <= rect.bottom && 
              moveEvent.clientX >= rect.left && moveEvent.clientX <= rect.right) {
            targetTrackId = container.getAttribute('data-track-id') || undefined;
          }
        });

        if (moveEvent.ctrlKey && !hasDuplicated && onDuplicateSegment) {
          hasDuplicated = true;
          onDuplicateSegment(trackId, seg.id, finalStart);
        } else if (!hasDuplicated) {
          onUpdateSegment(trackId, seg.id, { startTime: finalStart }, targetTrackId);
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizing(null);
      onSnapLine(null);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleFadeMouseDown = (e: React.MouseEvent, type: 'in' | 'out') => {
    e.stopPropagation();
    const startX = e.clientX;
    const initialFade = type === 'in' ? (seg.fadeIn || 0) : (seg.fadeOut || 0);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaT = deltaX / zoom;
      
      let newFade = initialFade;
      if (type === 'in') {
        newFade = Math.max(0, Math.min(seg.duration, initialFade + deltaT));
        onUpdateSegment(trackId, seg.id, { fadeIn: newFade });
      } else {
        newFade = Math.max(0, Math.min(seg.duration, initialFade - deltaT));
        onUpdateSegment(trackId, seg.id, { fadeOut: newFade });
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  if (timelineVisibleRange) {
    const startOffset = seg.startTime + (audioOffsetMs / 1000);
    const endOffset = startOffset + seg.duration;
    // Buffer of 5 seconds to prevent flickering on scroll/seek
    if (endOffset < timelineVisibleRange.start - 5 || startOffset > timelineVisibleRange.end + 5) {
      return (
        <div 
          className="absolute h-full pointer-events-none opacity-0"
          style={{ 
            left: `${startOffset * zoom}px`, 
            width: `${seg.duration * zoom}px` 
          }}
        />
      );
    }
  }

  const currentGain = seg.gain ?? 1.0;
  const currentPanning = seg.panning ?? 0.0;
  // Volume zone is at top 10% to 45% of height
  const volumeY = 10 + (1 - (currentGain / 2)) * 35;
  // Panning zone is at bottom 55% to 90% of height
  const panningY = 72.5 + currentPanning * 17.5;

  return (
    <div 
      onMouseDown={(e) => {
        if (onSelectSegment) onSelectSegment(seg.id, e.shiftKey);
        handleMouseDown(e, 'drag');
      }}
      onContextMenu={handleContextMenu}
      className={cn(
        "absolute h-full flex items-center overflow-hidden transition-all group cursor-move pointer-events-auto",
        "bg-indigo-500/40 border-x border-indigo-500/60 z-10 shadow-[0_0_10px_rgba(99,102,241,0.2)]",
        isSelected && "ring-2 ring-white ring-inset",
        seg.timingWarning === 'overlap' && "border-2 !border-rose-500 !bg-rose-950/60 !shadow-[0_0_15px_rgba(244,63,94,0.5)] z-20",
        seg.timingWarning === 'too_short' && "border-2 !border-amber-500 !bg-amber-950/60 !shadow-[0_0_15px_rgba(245,158,11,0.5)] z-20",
        seg.timingWarning === 'desync' && "border-2 !border-orange-500 !bg-orange-950/60 !shadow-[0_0_15px_rgba(249,115,22,0.5)] z-20"
      )}
      style={{ 
        left: `${(seg.startTime + (audioOffsetMs / 1000)) * zoom}px`, 
        width: `${seg.duration * zoom}px` 
      }}
    >
      {seg.waveform && timelineVisibleRange && (
        <VirtualizedWaveform 
          peaks={seg.waveform} 
          zoom={zoom} 
          duration={seg.fileDuration || seg.duration} 
          color="#60a5fa" 
          visibleRange={timelineVisibleRange}
          isRelative={true}
          segmentOffset={seg.fileOffset || 0}
          segmentStartTime={seg.startTime}
          audioOffsetMs={audioOffsetMs}
          gain={seg.gain ?? 1}
          trackVolume={trackVolume ?? 1}
          scaleMode={waveformScaleMode}
          visualGain={waveformVisualGain}
        />
      )}

      {/* Zone Watermarks */}
      <div className="absolute top-1.5 left-2 text-[7px] font-black text-yellow-400/25 select-none pointer-events-none tracking-wider">ГРОМКОСТЬ</div>
      <div className="absolute bottom-1.5 left-2 text-[7px] font-black text-sky-400/25 select-none pointer-events-none tracking-wider">ПАНОРАМА</div>

      {/* Zone Separator */}
      <div className="absolute top-1/2 left-0 right-0 border-t border-dashed border-zinc-700/30 pointer-events-none z-10" />

      {/* Automation Lines: Volume (Yellow) and Panning (Blue) */}
      <div 
        onMouseDown={(e) => handleLineMouseDown(e, 'volume')}
        className="absolute left-0 right-0 h-4 z-20 cursor-ns-resize group/vol-line flex items-center pointer-events-auto"
        style={{ top: `calc(${volumeY}% - 8px)` }}
        title={`Громкость: ${Math.round(currentGain * 100)}% (Перетащите вверх/вниз)`}
      >
        <div className="w-full h-[1.5px] bg-yellow-400 opacity-80 shadow-[0_0_4px_rgba(250,204,21,0.6)] group-hover/vol-line:h-[3px] group-hover/vol-line:opacity-100 transition-all" />
        <div className="absolute left-1/4 -translate-x-1/2 w-2 h-2 rounded-full bg-yellow-400 border border-zinc-950 scale-0 group-hover/vol-line:scale-100 transition-transform shadow" />
      </div>

      <div 
        onMouseDown={(e) => handleLineMouseDown(e, 'panning')}
        className="absolute left-0 right-0 h-4 z-20 cursor-ns-resize group/pan-line flex items-center pointer-events-auto"
        style={{ top: `calc(${panningY}% - 8px)` }}
        title={`Панорама: ${currentPanning === 0 ? 'Центр' : currentPanning < 0 ? `L${Math.round(Math.abs(currentPanning) * 100)}` : `R${Math.round(currentPanning * 100)}`} (Перетащите вверх/вниз)`}
      >
        <div className="w-full h-[1.5px] bg-sky-400 opacity-80 shadow-[0_0_4px_rgba(56,189,248,0.6)] group-hover/pan-line:h-[3px] group-hover/pan-line:opacity-100 transition-all" />
        <div className="absolute left-3/4 -translate-x-1/2 w-2 h-2 rounded-full bg-sky-400 border border-zinc-950 scale-0 group-hover/pan-line:scale-100 transition-transform shadow" />
      </div>

      {activeLineDrag && (
        <div className={cn(
          "absolute left-1/2 -translate-x-1/2 top-1.5 px-2 py-0.5 rounded text-[9px] font-black z-30 pointer-events-none shadow-lg backdrop-blur-sm select-none",
          activeLineDrag === 'volume' ? "bg-yellow-400 text-zinc-950" : "bg-sky-400 text-zinc-950"
        )}>
          {activeLineDrag === 'volume' 
            ? `Громкость: ${Math.round(currentGain * 100)}%` 
            : `Панорама: ${currentPanning === 0 
                ? 'Центр' 
                : currentPanning < 0 
                  ? `L${Math.round(Math.abs(currentPanning) * 100)}` 
                  : `R${Math.round(currentPanning * 100)}`}`
          }
        </div>
      )}

      {/* Segment Volume Level Badge */}
      <div 
        className="absolute right-1.5 bottom-1.5 px-1.5 py-0.5 rounded bg-zinc-950/80 border border-zinc-800/40 text-[8px] font-mono text-zinc-400 pointer-events-none flex items-center gap-1 z-10"
        title="Громкость фрагмента"
      >
        <span className="w-1 h-1 rounded-full bg-yellow-400" />
        <span>Фрагмент: {(() => {
          const sDb = currentGain <= 0.001 ? -30 : Math.max(-30, Math.min(30, 20 * Math.log10(currentGain)));
          const dbStr = sDb <= -29.9 ? 'Mute' : `${sDb > 0 ? '+' : ''}${Math.round(sDb)} dB`;
          return `${dbStr} (${Math.round(currentGain * 100)}%)`;
        })()}</span>
      </div>
      
      {/* Segment Info */}
      <div className="absolute inset-0 flex items-center justify-between px-2 pointer-events-none">
        <div className="flex items-center gap-1">
          {seg.backstageVideoPath && (
            <span className="p-[2px] rounded bg-purple-500/80 text-white" title={`Есть backstage видео: ${seg.backstageVideoPath}`}>
              <Video className="w-2.5 h-2.5" />
            </span>
          )}
          {seg.text && (
            <span className="text-[7px] font-black bg-black/40 px-1 rounded text-indigo-300">
              {seg.text}
            </span>
          )}
          {seg.timingWarning && (
            <span 
              className={cn(
                "text-[7px] font-black px-1.5 py-0.2 rounded flex items-center gap-0.5 shadow cursor-pointer",
                seg.timingWarning === 'overlap' && "bg-rose-600 text-white animate-pulse",
                seg.timingWarning === 'too_short' && "bg-amber-500 text-black",
                seg.timingWarning === 'desync' && "bg-orange-600 text-white"
              )}
              title={seg.timingWarningDetail || 'Проблема тайминга'}
            >
              <AlertTriangle className="w-2 h-2" />
              {seg.timingWarning === 'overlap' && 'Наезд'}
              {seg.timingWarning === 'too_short' && 'Короче саба'}
              {seg.timingWarning === 'desync' && 'Рассинхрон'}
            </span>
          )}
          {seg.alignedWithOriginal && !seg.timingWarning && (
            <span 
              className="text-[7px] font-black bg-emerald-600/60 px-1 py-0.2 rounded text-emerald-200 flex items-center gap-0.5"
              title="Старт фразы выровнен по оригинальному голосу"
            >
              <CheckCircle2 className="w-2 h-2" />
              Синхрон
            </span>
          )}
          {seg.gain !== 1 && (
            <span className="text-[7px] font-black bg-emerald-600/60 px-1 rounded text-white" title="Громкость">
              {Math.round(seg.gain * 100)}%
            </span>
          )}
          {seg.panning !== undefined && seg.panning !== 0 && (
            <span className="text-[7px] font-black bg-blue-600/60 px-1 rounded text-white" title="Стереопанорама">
              {seg.panning < 0 ? `L${Math.round(Math.abs(seg.panning) * 100)}` : `R${Math.round(seg.panning * 100)}`}
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-auto">
          <div className="relative">
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setShowVolume(!showVolume);
              }}
              className={cn(
                "p-0.5 rounded hover:bg-white/10 transition-colors",
                (seg.gain !== 1 || (seg.panning !== undefined && seg.panning !== 0)) ? "text-emerald-400" : "text-zinc-500"
              )}
              title="Настройки фразы"
            >
              <Volume2 className="w-3 h-3" />
            </button>
            {showVolume && (
              <div 
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 p-3 bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl z-50 flex flex-col gap-3 w-40 text-left cursor-default pointer-events-auto"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">Громкость</span>
                    <span className="text-[9px] font-mono text-emerald-400 font-bold">{Math.round((seg.gain ?? 1.0) * 100)}%</span>
                  </div>
                  <input 
                    type="range" min="0" max="2" step="0.02"
                    value={seg.gain ?? 1.0}
                    onChange={(e) => onUpdateSegment(trackId, seg.id, { gain: parseFloat(e.target.value) })}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                  />
                </div>
                
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">Панорама</span>
                    <span className="text-[9px] font-mono text-indigo-400 font-bold">
                      {seg.panning === undefined || seg.panning === 0 
                        ? 'C' 
                        : seg.panning < 0 
                          ? `L${Math.round(Math.abs(seg.panning) * 100)}` 
                          : `R${Math.round(seg.panning * 100)}`
                      }
                    </span>
                  </div>
                  <input 
                    type="range" min="-1" max="1" step="0.05"
                    value={seg.panning ?? 0.0}
                    onChange={(e) => onUpdateSegment(trackId, seg.id, { panning: parseFloat(e.target.value) })}
                    className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  />
                  <div className="flex justify-between text-[7px] text-zinc-500 mt-0.5 font-mono">
                    <span>L</span>
                    <span>C</span>
                    <span>R</span>
                  </div>
                </div>

                <div className="flex justify-end border-t border-zinc-900 pt-1.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdateSegment(trackId, seg.id, { gain: 1.0, panning: 0.0 });
                    }}
                    className="text-[8px] font-bold text-zinc-500 hover:text-zinc-300 transition-colors uppercase tracking-widest"
                  >
                    Сбросить
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Trim Handles */}
      <div 
        onMouseDown={(e) => handleMouseDown(e, 'left')}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-indigo-400/50 flex items-center justify-center"
        title="Обрезать начало"
      >
          <GripVertical className="w-2 h-2 text-white/50" />
        </div>
        <div 
          onMouseDown={(e) => handleMouseDown(e, 'right')}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-indigo-400/50 flex items-center justify-center"
          title="Обрезать конец"
        >
          <GripVertical className="w-2 h-2 text-white/50" />
        </div>
          
      {/* Fade Handles */}
      <div 
        onMouseDown={(e) => handleFadeMouseDown(e, 'in')}
        className="absolute top-0 w-3 h-3 cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center justify-center"
        style={{ left: `${(seg.fadeIn || 0) * zoom}px`, transform: 'translateX(-50%)' }}
        title="Нарастание (Fade In)"
      >
        <div className="w-1.5 h-1.5 bg-white rounded-full shadow-sm" />
      </div>
      <div 
        onMouseDown={(e) => handleFadeMouseDown(e, 'out')}
        className="absolute top-0 w-3 h-3 cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center justify-center"
        style={{ right: `${(seg.fadeOut || 0) * zoom}px`, transform: 'translateX(50%)' }}
        title="Затухание (Fade Out)"
      >
        <div className="w-1.5 h-1.5 bg-white rounded-full shadow-sm" />
      </div>
          
      {/* Fade Visualizers */}
      {(seg.fadeIn || autoFadeIn) > 0 && (
        <div 
          className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-black/50 to-transparent pointer-events-none z-10"
          style={{ width: `${Math.max(seg.fadeIn || 0, autoFadeIn) * zoom}px` }}
        >
          <svg className="w-full h-full opacity-50">
            <line x1="0" y1="100%" x2="100%" y2="0" stroke="white" strokeWidth="1" strokeDasharray="2,2" />
          </svg>
        </div>
      )}
      {(seg.fadeOut || autoFadeOut) > 0 && (
        <div 
          className="absolute top-0 bottom-0 right-0 bg-gradient-to-l from-black/50 to-transparent pointer-events-none z-10"
          style={{ width: `${Math.max(seg.fadeOut || 0, autoFadeOut) * zoom}px` }}
        >
          <svg className="w-full h-full opacity-50">
            <line x1="0" y1="0" x2="100%" y2="100%" stroke="white" strokeWidth="1" strokeDasharray="2,2" />
          </svg>
        </div>
      )}

      {contextMenu && (
        <ContextMenu 
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: "Скопировать",
              icon: <Copy className="w-3.5 h-3.5 text-zinc-400" />,
              disabled: !onCopySegments,
              onClick: () => onCopySegments?.()
            },
            {
              label: "Вырезать",
              icon: <Scissors className="w-3.5 h-3.5 text-zinc-400" />,
              disabled: !onCutSegments,
              onClick: () => onCutSegments?.()
            },
            {
              label: "Вставить",
              icon: <ClipboardPaste className="w-3.5 h-3.5 text-zinc-400" />,
              disabled: !onPasteSegments,
              onClick: () => onPasteSegments?.()
            },
            {
              label: "Спектральный анализ",
              icon: <Activity className="w-3.5 h-3.5 text-purple-400" />,
              onClick: () => setShowSpectralAnalysis(true)
            },
            {
              label: "Нормализовать громкость",
              icon: <Maximize className="w-3.5 h-3.5 text-emerald-400" />,
              onClick: () => onUpdateSegment(trackId, seg.id, { gain: 1.0 })
            },
            {
              label: "Пересчитать пики волны (по файлу)",
              icon: <RotateCcw className="w-3.5 h-3.5 text-sky-400" />,
              onClick: () => onUpdateSegment(trackId, seg.id, { waveform: [] })
            },
            {
              label: "Разделить (в плейхеде)",
              icon: <Scissors className="w-3.5 h-3.5 text-zinc-400" />,
              disabled: !onSplitSegment || !currentTimeRef,
              onClick: () => {
                if (onSplitSegment && currentTimeRef) {
                  onSplitSegment(trackId, seg.id, currentTimeRef.current);
                }
              }
            },
            {
              label: "Переименовать / Коммент",
              icon: <Edit3 className="w-3.5 h-3.5 text-zinc-400" />,
              onClick: () => {
                const newText = prompt("Введите комментарий к дублю:", seg.text || "");
                if (newText !== null) onUpdateSegment(trackId, seg.id, { text: newText });
              }
            },
            ...(seg.targetStartTime !== undefined ? [{
              label: "Синхронизировать начало по оригиналу",
              icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />,
              onClick: () => {
                if (seg.targetStartTime !== undefined) {
                  onUpdateSegment(trackId, seg.id, { 
                    startTime: seg.targetStartTime,
                    alignedWithOriginal: true,
                    timingWarning: undefined,
                    timingWarningDetail: undefined
                  });
                }
              }
            }] : []),
            ...(seg.timingWarning === 'overlap' ? [{
              label: "Устранить наезд (сдвинуть в стык)",
              icon: <Wand2 className="w-3.5 h-3.5 text-amber-400" />,
              onClick: () => {
                onUpdateSegment(trackId, seg.id, {
                  startTime: seg.startTime + 0.35,
                  timingWarning: undefined,
                  timingWarningDetail: undefined
                });
              }
            }] : []),
            ...(seg.timingWarning ? [{
              label: "Снять метку предупреждения",
              icon: <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />,
              onClick: () => {
                onUpdateSegment(trackId, seg.id, {
                  timingWarning: undefined,
                  timingWarningDetail: undefined
                });
              }
            }] : []),
            ...(onGlueSegments ? [{
              label: "Склеить выделенные (Glue)",
              icon: <Volume2 className="w-3.5 h-3.5 text-indigo-400" />,
              onClick: () => onGlueSegments()
            }] : []),
            {
              label: "Удалить сегмент",
              icon: <Trash2 className="w-3.5 h-3.5 text-rose-400" />,
              variant: 'danger',
              onClick: () => onDeleteSegment?.(trackId, seg.id)
            }
          ]}
        />
      )}

      {showSpectralAnalysis && (
        <SpectralAnalysisModal
          segment={seg}
          onClose={() => setShowSpectralAnalysis(false)}
          onUpdateSegment={onUpdateSegment}
        />
      )}
    </div>
  );
});

export default AudioSegmentView;
