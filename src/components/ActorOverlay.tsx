import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { SubtitleLine, Project } from '../types';
import Teleprompter from './Teleprompter';
import BackstageCamera from './BackstageCamera';

export const ActorOverlay = ({ 
  currentLine, 
  nextLine, 
  currentTime, 
  showWebcam, 
  webcamRef,
  isRecording,
  recordingStream,
  onClipping,
  subtitles = [],
  teleprompterMode,
  teleprompterFontSize,
  teleprompterLineHeight,
  teleprompterPacing,
  setTeleprompterFontSize,
  setTeleprompterLineHeight,
  setTeleprompterPacing,
  setTeleprompterMode,
  teleprompterPosition,
  setTeleprompterPosition,
  teleprompterSize,
  setTeleprompterSize,
  isAudiobook = false,
  isBackstageRecording = false,
  activeRole = '',
  project,
  onSettingsChange,
  onSeek,
  isWebcamSimulated
}: { 
  currentLine?: SubtitleLine, 
  nextLine?: SubtitleLine,
  currentTime: number,
  showWebcam: boolean,
  webcamRef: React.RefObject<HTMLVideoElement | null>,
  isRecording: boolean,
  recordingStream: MediaStream | null,
  onClipping?: (clipping: boolean) => void,
  subtitles?: SubtitleLine[],
  teleprompterMode: 'compact' | 'expanded',
  teleprompterFontSize: number,
  teleprompterLineHeight: number,
  teleprompterPacing: 'auto' | 'manual',
  setTeleprompterFontSize: (s: number) => void,
  setTeleprompterLineHeight: (h: number) => void,
  setTeleprompterPacing: (p: 'auto' | 'manual') => void,
  setTeleprompterMode: (m: 'compact' | 'expanded') => void,
  teleprompterPosition: { x: number, y: number },
  setTeleprompterPosition: (pos: { x: number, y: number }) => void,
  teleprompterSize: { width: number, height: number },
  setTeleprompterSize: (size: { width: number, height: number }) => void,
  isAudiobook?: boolean,
  isBackstageRecording?: boolean,
  activeRole?: string,
  project?: Project,
  onSettingsChange?: (settings: any) => void,
  onSeek?: (time: number) => void,
  isWebcamSimulated?: boolean
}) => {
  return (
    <div className="absolute inset-0 pointer-events-none z-40 overflow-hidden">
      {/* Backstage Recording Indicator */}
      {isBackstageRecording && (
        <div className="absolute top-8 right-8 flex items-center gap-2 bg-amber-600/80 backdrop-blur-md px-3 py-1.5 rounded-full border border-amber-400/50 shadow-lg animate-pulse">
          <div className="w-2 h-2 bg-white rounded-full" />
          <span className="text-[10px] font-black uppercase tracking-widest text-white">Запись бекстейджа</span>
        </div>
      )}

      {/* Teleprompter */}
      {(subtitles.length > 0 || isAudiobook) && (
        <motion.div 
          drag={teleprompterMode === 'compact'}
          dragMomentum={false}
          dragConstraints={{ left: -window.innerWidth/2, right: window.innerWidth/2, top: -window.innerHeight, bottom: 200 }}
          onDragEnd={(_, info) => {
            if (teleprompterMode === 'compact') {
              setTeleprompterPosition({ 
                x: teleprompterPosition.x + info.offset.x, 
                y: teleprompterPosition.y + info.offset.y 
              });
            }
          }}
          className={cn(
            "absolute pointer-events-auto",
            teleprompterMode === 'expanded' ? "inset-0 transition-all duration-500" : ""
          )}
          style={teleprompterMode === 'compact' ? {
            left: '50%',
            top: 'calc(100% - 240px)',
            marginLeft: -(teleprompterSize.width / 2),
            width: teleprompterSize.width,
            height: teleprompterSize.height,
          } : {}}
          animate={teleprompterMode === 'compact' ? {
            x: teleprompterPosition.x,
            y: teleprompterPosition.y
          } : {}}
        >
          <Teleprompter 
            subtitles={subtitles}
            currentTime={currentTime}
            mode={teleprompterMode}
            fontSize={teleprompterFontSize}
            lineHeight={teleprompterLineHeight}
            pacing={teleprompterPacing}
            activeRole={activeRole}
            onFontSizeChange={setTeleprompterFontSize}
            onLineHeightChange={setTeleprompterLineHeight}
            onPacingChange={setTeleprompterPacing}
            onModeChange={setTeleprompterMode}
            onResize={(w, h) => setTeleprompterSize({ width: w, height: h })}
            onSeek={onSeek}
          />
        </motion.div>
      )}

      {/* Actor Cam (PiP) */}
      <AnimatePresence>
        {showWebcam && (
          <BackstageCamera 
            webcamRef={webcamRef} 
            recordingStream={recordingStream}
            onClipping={onClipping}
            project={project}
            onSettingsChange={onSettingsChange!}
            isTimelineRecording={isRecording}
            isWebcamSimulated={isWebcamSimulated}
          />
        )}
      </AnimatePresence>

      {/* Recording Status removed as per user request */}
    </div>
  );
};

export default ActorOverlay;
