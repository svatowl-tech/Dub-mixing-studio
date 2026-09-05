import React from 'react';
import { motion } from 'framer-motion';
import { Circle, Square, Repeat, ZoomOut, ZoomIn, Layers, Video, Sliders } from 'lucide-react';
import { cn } from '../lib/utils';
import VUMeter from './VUMeter';

interface TransportControlsProps {
  isRecording: boolean;
  onToggleRecord: () => void;
  recordingStream: MediaStream | null;
  onClipping: (clipping: boolean) => void;
  isLooping: boolean;
  onToggleLoop: () => void;
  onFitToWidth: () => void;
  isAutoHeight: boolean;
  onToggleAutoHeight: () => void;
  zoomLevel: number;
  onZoomChange: (zoom: number) => void;
  isBackstageRecording: boolean;
  onToggleBackstage: () => void;
  backstageMode?: 'parallel' | 'manual';
  isVideoFloatingOpen?: boolean;
  onToggleVideoFloating?: () => void;
  hasVideo?: boolean;
  children?: React.ReactNode;
}

const TransportControls: React.FC<TransportControlsProps> = ({
  isRecording,
  onToggleRecord,
  recordingStream,
  onClipping,
  isLooping,
  onToggleLoop,
  onFitToWidth,
  isAutoHeight,
  onToggleAutoHeight,
  zoomLevel,
  onZoomChange,
  isBackstageRecording,
  onToggleBackstage,
  backstageMode = 'parallel',
  isVideoFloatingOpen = true,
  onToggleVideoFloating,
  hasVideo = false,
  children
}) => {
  return (
    <div className="h-14 border-b border-white/5 flex items-center justify-between px-4 bg-zinc-900/80 backdrop-blur-md">
      <div className="flex items-center gap-4">
        <motion.button 
          onClick={onToggleRecord}
          animate={isRecording ? { 
            scale: [1, 1.02, 1], 
            boxShadow: ["0px 0px 0px rgba(244,63,94,0)", "0px 0px 20px rgba(244,63,94,0.3)", "0px 0px 0px rgba(244,63,94,0)"] 
          } : {}}
          transition={{ repeat: isRecording ? Infinity : 0, duration: 2 }}
          className={cn(
            "flex items-center gap-2 px-6 h-9 rounded-xl text-xs font-black tracking-tighter transition-all shadow-lg active:scale-95",
            isRecording 
              ? "bg-rose-500 text-white ring-2 ring-rose-500/30" 
              : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-white/5"
          )}
        >
          <div className={cn(
            "w-3 h-3 flex items-center justify-center rounded-sm transition-all",
            isRecording ? "bg-white" : "bg-rose-500"
          )}>
            {isRecording ? (
              <Square className="w-2 h-2 text-rose-500 fill-current" />
            ) : (
              <Circle className="w-2 h-2 text-white fill-current" />
            )}
          </div>
          {isRecording ? "СТОП" : "ЗАПИСЬ"}
        </motion.button>

        {isRecording && (
          <div className="w-48 h-9 bg-black/20 rounded-xl px-2 flex items-center border border-white/5">
            <VUMeter 
              stream={recordingStream} 
              onClipping={onClipping} 
            />
          </div>
        )}
      </div>
      
      {children && (
        <div className="flex-1 px-4 self-stretch hidden md:block">
          {children}
        </div>
      )}

      <div className="flex items-center gap-1.5 shrink-0">
        <button 
          onClick={onToggleLoop}
          className={cn(
            "w-9 h-9 flex items-center justify-center rounded-xl transition-all",
            isLooping ? "bg-indigo-600 text-white shadow-[0_0_10px_rgba(99,102,241,0.5)]" : "hover:bg-white/5 text-zinc-400"
          )}
          title="Повтор"
        >
          <Repeat className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-white/10 mx-0.5" />
        <button 
          onClick={onFitToWidth}
          className="px-3 h-9 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-[10px] font-bold text-zinc-400 hover:text-white transition-colors border border-white/5 uppercase tracking-wider"
          title="По ширине"
        >
          ПО ШИРИНЕ
        </button>
        <button 
          onClick={onToggleAutoHeight}
          className={cn(
            "px-3 h-9 rounded-xl text-[10px] font-bold transition-all border border-white/5 uppercase tracking-wider",
            isAutoHeight 
              ? "bg-indigo-600 text-white shadow-[0_0_10px_rgba(99,102,241,0.5)]" 
              : "bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white"
          )}
          title="Авто-высота таймлайна"
        >
          ПО ВЫСОТЕ
        </button>
        <div className="w-px h-4 bg-white/10 mx-0.5" />
        <button onClick={() => onZoomChange(Math.max(10, zoomLevel * 0.8))} className="w-9 h-9 flex items-center justify-center hover:bg-white/5 rounded-xl text-zinc-400" title="Уменьшить"><ZoomOut className="w-4 h-4" /></button>
        <div className="px-2 flex items-center h-9">
          <input 
            type="range" 
            min="10" 
            max="2000" 
            step="1"
            value={zoomLevel ?? 100} 
            onChange={(e) => onZoomChange(Number(e.target.value))}
            className="w-24 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            title="Масштаб таймлайна"
          />
        </div>
        <button onClick={() => onZoomChange(Math.min(2000, zoomLevel * 1.2))} className="w-9 h-9 flex items-center justify-center hover:bg-white/5 rounded-xl text-zinc-400" title="Увеличить"><ZoomIn className="w-4 h-4" /></button>
        <div className="w-px h-4 bg-white/10 mx-1" />
        <button className="w-9 h-9 flex items-center justify-center hover:bg-white/5 rounded-xl text-zinc-400"><Layers className="w-4 h-4" /></button>
        {hasVideo && onToggleVideoFloating && (
          <>
            <div className="w-px h-4 bg-white/10 mx-1" />
            <button 
              onClick={onToggleVideoFloating}
              className={cn(
                "w-9 h-9 flex items-center justify-center rounded-xl transition-all",
                isVideoFloatingOpen ? "bg-indigo-600 text-white shadow-[0_0_10px_rgba(99,102,241,0.5)]" : "hover:bg-white/5 text-zinc-400"
              )}
              title="Показать/скрыть видео-монитор"
            >
              <Video className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default TransportControls;
