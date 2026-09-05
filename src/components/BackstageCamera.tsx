import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { cn } from '../lib/utils';
import { Repeat } from 'lucide-react';
import VUMeter from './VUMeter';

interface BackstageCameraProps {
  webcamRef: React.RefObject<HTMLVideoElement | null>;
  recordingStream: MediaStream | null;
  onClipping?: (c: boolean) => void;
  project: any;
  onSettingsChange: (settings: any) => void;
  onRunStressTest?: () => void;
  isTimelineRecording?: boolean;
  isWebcamSimulated?: boolean;
}

export const BackstageCamera: React.FC<BackstageCameraProps> = ({
  webcamRef,
  recordingStream,
  onClipping,
  project,
  onSettingsChange,
  isTimelineRecording,
  isWebcamSimulated
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const continuousRecorderRef = useRef<MediaRecorder | null>(null);
  const continuousChunksRef = useRef<{blob: Blob, time: number}[]>([]);
  
  const autoMode = project?.audioSettings?.backstageMode === 'parallel';

  // Continuous recording buffer for "Save last 30s"
  useEffect(() => {
    if (!webcamRef.current?.srcObject) return;
    
    let localAudioStream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;

    const setupStream = async () => {
      try {
        const streamToRecord = (webcamRef.current?.srcObject as MediaStream) || recordingStream;
        if (!streamToRecord) return;
        
        const tracks = [...streamToRecord.getTracks()];
        const backstageAudioId = project?.audioSettings?.backstageAudioDeviceId;

        if (backstageAudioId !== "none") {
           const audioConstraint = backstageAudioId && backstageAudioId !== 'default' 
             ? { deviceId: { ideal: backstageAudioId } } 
             : project?.audioSettings?.deviceId ? { deviceId: { ideal: project.audioSettings.deviceId } } : true;
             
           try {
             localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
             if (localAudioStream) {
                const audioTracks = localAudioStream.getAudioTracks();
                if (audioTracks.length > 0) {
                  // Пытаемся заменить существующие аудиодорожки, если они есть
                  const existingAudio = tracks.findIndex(t => t.kind === 'audio');
                  if (existingAudio !== -1) {
                    tracks[existingAudio] = audioTracks[0];
                  } else {
                    tracks.push(audioTracks[0]);
                  }
                }
             }
           } catch (audioErr) {
             console.warn("Failed to get separate backstage audio, continuing with existing tracks:", audioErr);
           }
        }
        
        const getMimeType = () => {
          const types = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
          return types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
        };

        const combinedStream = new MediaStream(tracks);
        recorder = new MediaRecorder(combinedStream, { 
          mimeType: getMimeType(),
          videoBitsPerSecond: project?.audioSettings?.webcamBitrate || 5000000,
          audioBitsPerSecond: 128000
        });
        continuousRecorderRef.current = recorder;
        
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            continuousChunksRef.current.push({ blob: e.data, time: Date.now() });
            
            // Оставляем только чанки за последние 30 секунд
            const thirtySecondsAgo = Date.now() - 30000;
            continuousChunksRef.current = continuousChunksRef.current.filter(c => c.time > thirtySecondsAgo);
            
            // Жесткий лимит на количество чанков (например, 35) чтобы не переполнять память
            if (continuousChunksRef.current.length > 35) {
              continuousChunksRef.current = continuousChunksRef.current.slice(-35);
            }
          }
        };
        
        recorder.start(1000); // 1 second timeslices
      } catch (e) {
        console.error("Continuous recorder failed:", e);
      }
    };

    setupStream();
      
    return () => {
      if (recorder && recorder.state === 'recording') recorder.stop();
      if (localAudioStream) localAudioStream.getTracks().forEach(t => t.stop());
    };
  }, [webcamRef.current?.srcObject, project?.audioSettings?.backstageAudioDeviceId]);

  const toggleAutoMode = () => {
    onSettingsChange({
      ...project?.audioSettings,
      backstageMode: autoMode ? 'manual' : 'parallel'
    });
  };

  const startManual = async (force: boolean = false) => {
    if ((!force && autoMode) || !webcamRef.current?.srcObject) return;
    
    try {
      const streamToRecord = (webcamRef.current.srcObject as MediaStream) || recordingStream;
      const tracks = [...streamToRecord.getTracks()];
      const backstageAudioId = project?.audioSettings?.backstageAudioDeviceId;

      if (backstageAudioId !== "none") {
         const audioConstraint = backstageAudioId && backstageAudioId !== 'default' 
           ? { deviceId: { ideal: backstageAudioId } } 
           : project?.audioSettings?.deviceId ? { deviceId: { ideal: project.audioSettings.deviceId } } : true;
           
         try {
           const localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
           if (localAudioStream) {
              const audioTracks = localAudioStream.getAudioTracks();
              if (audioTracks.length > 0) {
                const existingAudio = tracks.findIndex(t => t.kind === 'audio');
                if (existingAudio !== -1) {
                  tracks[existingAudio] = audioTracks[0];
                } else {
                  tracks.push(audioTracks[0]);
                }
              }
           }
         } catch (audioErr) {
           console.warn("Manual: Failed to get separate backstage audio:", audioErr);
         }
      }
      
      const getMimeType = () => {
        const types = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
        return types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
      };

      const combinedStream = new MediaStream(tracks);
      const recorder = new MediaRecorder(combinedStream, { 
        mimeType: getMimeType(),
        videoBitsPerSecond: project?.audioSettings?.webcamBitrate || 5000000,
        audioBitsPerSecond: 128000
      });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      
      recorder.onstop = async () => {
        if (!chunksRef.current.length) return;
        const videoBlob = new Blob(chunksRef.current, { type: 'video/webm' });
        
        if (videoBlob.size < 1000) {
          console.warn("[BackstageCamera] Manual backstage recording too short, ignoring");
          return;
        }

        const backstagePath = project?.audioSettings?.backstageFolderPath || (project?.projectPath ? `${project?.projectPath}/backstage`.replace(/\\/g, '/') : null);
        if (backstagePath && window.electronAPI) {
          try {
            const arrayBuffer = await videoBlob.arrayBuffer();
            const res = await window.electronAPI.saveTake({
              projectPath: backstagePath,
              role: 'backstage_manual',
              startTime: Date.now() / 1000,
              audioData: new Uint8Array(arrayBuffer)
            });
            if (res.success && res.data) {
              console.log(`[BackstageCamera] Manual backstage recording saved to: ${res.data.filePath}`);
            }
          } catch (e) {
            console.error("[BackstageCamera] Failed to save manual backstage recording:", e);
          }
        }
      };
      
      recorder.start(1000);
      setIsRecording(true);
    } catch (e) {
      console.error("Failed to start manual recording:", e);
    }
  };

  const stopManual = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const saveLast30s = async () => {
    if (continuousChunksRef.current.length === 0) {
      alert("Нет данных для сохранения (подождите пару секунд).");
      return;
    }
    
    // Save only last 30s
    const saveCutoff = Date.now() - 30000;
    const blobs = continuousChunksRef.current.filter(c => c.time >= saveCutoff).map(c => c.blob);
    
    if (blobs.length === 0) {
      alert("Недостаточно данных за последние 30 секунд.");
      return;
    }

    const videoBlob = new Blob(blobs, { type: 'video/webm' });
    const backstagePath = project?.audioSettings?.backstageFolderPath || (project?.projectPath ? `${project?.projectPath}/backstage`.replace(/\\/g, '/') : null);
    
    if (backstagePath && window.electronAPI) {
      try {
        const arrayBuffer = await videoBlob.arrayBuffer();
        const res = await window.electronAPI.saveTake({
          projectPath: backstagePath,
          role: 'backstage_30s',
          startTime: Date.now() / 1000,
          audioData: new Uint8Array(arrayBuffer)
        });
        
        if (res.success && res.data) {
          alert(`Последние 30 секунд сохранены!\nФайл: ${res.data.filePath}\n\nВы можете найти его в папке 'takes' вашего проекта.`);
        } else {
          alert("Последние 30 секунд сохранены в папке 'takes'.");
        }
      } catch (e) {
        console.error("Failed to save 30s:", e);
      }
    } else {
      alert("Скачивание последней записи (браузерный режим)...");
      const url = URL.createObjectURL(videoBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "backstage_30s.webm";
      a.click();
    }
  };

  // In parallel auto-mode, useAudioEngine already automates backstage recording perfectly 
  // directly aligned with the segment timeline.
  // No duplicate recording effect is needed here.

  return (
    <motion.div 
      drag
      dragMomentum={false}
      initial={{ opacity: 0, x: 20, scale: 0.8 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 20, scale: 0.8 }}
      className="absolute flex flex-col bottom-8 right-8 w-72 bg-zinc-900 rounded-2xl border border-white/20 overflow-hidden shadow-2xl pointer-events-auto group cursor-grab active:cursor-grabbing"
    >
      <div className="relative aspect-video w-full bg-black">
        <video ref={webcamRef} autoPlay playsInline muted className="w-full h-full object-cover mirror" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none" />
        
        {isWebcamSimulated && (
          <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-zinc-950/85 border border-amber-500/40 backdrop-blur-sm px-2 py-1 rounded text-[10px] text-amber-400 font-bold shadow-md select-none">
            <span>⚠️</span>
            <span>Камера симулируется</span>
          </div>
        )}

        {(isRecording || autoMode) && (
          <div className="absolute top-3 right-3 flex items-center gap-2">
            <div className="w-2 h-2 bg-rose-500 rounded-full animate-pulse" />
            <span className="text-[10px] font-black uppercase tracking-widest text-white drop-shadow-md">
              {autoMode ? "Авто" : "Запись"}
            </span>
          </div>
        )}

        <div className="absolute bottom-3 right-3 pointer-events-none">
          <VUMeter stream={recordingStream} onClipping={onClipping} />
        </div>
      </div>

      <div className="p-2 flex items-center justify-between bg-zinc-900/90 border-t border-white/10 gap-1" onMouseDown={e => e.stopPropagation()}>
        <button 
          onClick={() => isRecording ? stopManual() : startManual()}
          disabled={autoMode}
          className={cn(
            "flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1.5",
            autoMode ? "opacity-50 cursor-not-allowed bg-zinc-800 text-zinc-500" :
            isRecording 
              ? "bg-rose-500/20 text-rose-400 hover:bg-rose-500/30" 
              : "bg-white/5 text-white hover:bg-white/10"
          )}
        >
          <div className={cn("w-2 h-2 rounded-full", isRecording ? "bg-rose-500" : "bg-zinc-400")} />
          {isRecording ? "Стоп" : "Запись"}
        </button>

        <button 
          onClick={toggleAutoMode}
          className={cn(
            "px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all border",
            autoMode 
              ? "bg-indigo-600/20 border-indigo-500/30 text-indigo-400" 
              : "bg-white/5 border-transparent text-zinc-400 hover:text-white"
          )}
          title="Авто-запись (синхронно с дубляжом)"
        >
          АВТО
        </button>

        <button 
          onClick={saveLast30s}
          className="px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 rounded-lg transition-colors border border-amber-500/20 text-[10px] font-bold flex items-center gap-1.5"
          title="Сохранить последние 30 сек"
        >
          <Repeat className="w-3 h-3" />
          30c
        </button>
      </div>
    </motion.div>
  );
};

export default BackstageCamera;
