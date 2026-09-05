import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Upload, FileVideo, Music, Check, Trash2, ArrowRight, Play, AlertTriangle, Settings2, Sparkles, Wand2, FolderOpen } from 'lucide-react';
import { useUIState } from '../contexts/UIContext';
import { useProjectData } from '../contexts/ProjectContext';
import { useDropzone } from 'react-dropzone';
import { AudioTrack, AudioSegment, Project } from '../types';
import { getSafeFileUrl } from '../lib/utils';
import { addToWebFileCache } from '../lib/tauriLegacyWrapper';
import { IOLogger } from '../lib/ioLogger';

interface ImportedFile {
  id: string;
  name: string;
  filePath?: string;
  size: number;
  type: 'video' | 'audio';
  duration: number; // in seconds
  roleName: string;
  peaks: number[];
  isAligned: boolean;
  isDenoised: boolean;
}

export const BatchImportModal = () => {
  const { activeModal, setActiveModal } = useUIState();
  const { project, setProject } = useProjectData();

  const isOpen = activeModal === 'batchImport';

  const [videoFile, setVideoFile] = useState<ImportedFile | null>(null);
  const [audioFiles, setAudioFiles] = useState<ImportedFile[]>([]);
  const [isImportingProgress, setIsImportingProgress] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleNativePick = async (pickedFiles: { path: string, name: string }[]) => {
    setIsImportingProgress(true);
    setProgress(10);
    try {
      let count = 0;
      for (const file of pickedFiles) {
        const isVideo = file.name.endsWith('.mp4') || file.name.endsWith('.mkv') || file.name.endsWith('.avi') || file.name.endsWith('.mov');
        const isAudio = file.name.endsWith('.wav') || file.name.endsWith('.mp3') || file.name.endsWith('.flac') || file.name.endsWith('.m4a');
        
        let duration = 30.0;
        let fileSize = 10 * 1024 * 1024;

        if (window.electronAPI) {
          try {
            const infoRes = await window.electronAPI.getFileInfo(file.path);
            if (infoRes.success && infoRes.data) {
              duration = infoRes.data.duration || duration;
              fileSize = infoRes.data.size || fileSize;
            }
          } catch (e) {
            console.warn("Failed to get duration:", e);
          }
        }

        let roleName = file.name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ").replace(/\d/g, "").trim();
        roleName = roleName.charAt(0).toUpperCase() + roleName.slice(1);
        if (roleName.length > 20) roleName = roleName.substring(0, 18) + "...";

        const fileObj: ImportedFile = {
          id: Math.random().toString(36).substring(2, 11),
          name: file.name,
          filePath: file.path,
          size: fileSize,
          type: isVideo ? 'video' : 'audio',
          duration,
          roleName: isVideo ? 'Оригинал' : roleName || 'Голос ' + (audioFiles.length + 1),
          peaks: [], // Оставляем пустым для гидратора в App.tsx!
          isAligned: true,
          isDenoised: true
        };

        if (isVideo) setVideoFile(fileObj);
        else if (isAudio) {
          setAudioFiles(prev => {
            if (prev.some(p => p.name === file.name) || prev.length >= 15) return prev;
            return [...prev, fileObj];
          });
        }
        count++;
        setProgress(Math.round((count / pickedFiles.length) * 100));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsImportingProgress(false);
      setProgress(0);
    }
  };

  const openNativePicker = async () => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.openFiles({
      title: 'Выберите медиафайлы для импорта',
      filters: [
        { name: 'Медиафайлы', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wav', 'mp3', 'flac', 'm4a'] }
      ]
    });
    if (res.success && res.data && res.data.length > 0) {
      handleNativePick(res.data);
    }
  };

  const onDrop = async (acceptedFiles: File[]) => {
    for (const file of acceptedFiles) {
      const isVideo = file.type.startsWith('video/') || file.name.endsWith('.mp4') || file.name.endsWith('.mkv') || file.name.endsWith('.avi');
      const isAudio = file.type.startsWith('audio/') || file.name.endsWith('.wav') || file.name.endsWith('.mp3') || file.name.endsWith('.flac') || file.name.endsWith('.m4a');
      
      const filePath = (file as any).path || file.name;

      let duration = 30.0;
      if (window.electronAPI && filePath) {
        try {
          const infoRes = await window.electronAPI.getFileInfo(filePath);
          if (infoRes.success && infoRes.data && infoRes.data.duration) duration = infoRes.data.duration;
        } catch (e) {
          console.warn("Failed to get duration:", e);
        }
      }

      let roleName = file.name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ").replace(/\d/g, "").trim();
      roleName = roleName.charAt(0).toUpperCase() + roleName.slice(1);
      if (roleName.length > 20) roleName = roleName.substring(0, 18) + "...";

      const fileObj: ImportedFile = {
        id: Math.random().toString(36).substring(2, 11),
        name: file.name,
        filePath,
        size: file.size,
        type: isVideo ? 'video' : 'audio',
        duration,
        roleName: isVideo ? 'Оригинал' : roleName || 'Голос ' + (audioFiles.length + 1),
        peaks: [], // Оставляем пустым!
        isAligned: true,
        isDenoised: true
      };

      if (isVideo) setVideoFile(fileObj);
      else if (isAudio) {
        setAudioFiles(prev => {
          if (prev.some(p => p.name === file.name) || prev.length >= 15) return prev;
          return [...prev, fileObj];
        });
      }
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'video/*': ['.mp4', '.mkv', '.avi', '.mov'],
      'audio/*': ['.wav', '.mp3', '.flac', '.m4a']
    }
  } as any);

  if (!isOpen) return null;

  const handleClose = () => {
    setActiveModal(null);
  };

  const removeAudioFile = (id: string) => {
    setAudioFiles(prev => prev.filter(f => f.id !== id));
  };

  const updateRoleName = (id: string, value: string) => {
    setAudioFiles(prev => prev.map(f => f.id === id ? { ...f, roleName: value } : f));
  };

  const toggleAligned = (id: string) => {
    setAudioFiles(prev => prev.map(f => f.id === id ? { ...f, isAligned: !f.isAligned } : f));
  };

  const toggleDenoised = (id: string) => {
    setAudioFiles(prev => prev.map(f => f.id === id ? { ...f, isDenoised: !f.isDenoised } : f));
  };

  const executeImport = async () => {
    setIsImportingProgress(true);
    setProgress(0);

    try {
      let projectRoot = project?.projectPath;
      if (!projectRoot && videoFile?.filePath) {
         const normFPath = videoFile.filePath.replace(/\\/g, '/');
         const lastSl = normFPath.lastIndexOf('/');
         if (lastSl !== -1) {
           projectRoot = `${normFPath.substring(0, lastSl)}/${videoFile.name.replace(/\.[^/.]+$/, "")}_Project`.replace(/\\/g, '/');
         }
      }
      if (!projectRoot) projectRoot = '/StudioWorkspace/Session';

      if (window.electronAPI) await window.electronAPI.initProject(projectRoot);
      const assetsDir = `${projectRoot}/assets`.replace(/\\/g, '/');

      const newTracks: AudioTrack[] = [];
      let count = 0;

      for (const af of audioFiles) {
        let finalPath = af.filePath;
        
        // РЕАЛЬНОЕ КОПИРОВАНИЕ И РЕСЕМПЛИНГ
        if (window.electronAPI && af.filePath) {
           const copyRes = await window.electronAPI.copyFileToProject(af.filePath, assetsDir);
           if (copyRes.success && copyRes.data) finalPath = copyRes.data;
        }

        const segment: AudioSegment = {
          id: `seg-${af.id}`,
          startTime: 0,
          duration: af.duration,
          fileOffset: 0,
          fileDuration: af.duration,
          blobUrl: finalPath ? getSafeFileUrl(finalPath) : '#local-mock',
          filePath: finalPath,
          waveform: [], // ПУСТОЙ МАССИВ - триггер для реальной отрисовки волн в App.tsx!
          gain: 1.0,
          playbackRate: 1.0,
          originalFileName: af.name,
          text: 'Импортированный вокал'
        };

        newTracks.push({
          id: `track-${af.id}`,
          name: af.roleName,
          volume: 0.9,
          isMuted: false,
          isSolo: false,
          isArmed: false,
          segments: [segment],
          processing: {
            enabled: af.isDenoised,
            denoise: af.isDenoised ? { enabled: true, strength: 75, model: 'cascade_net' } : undefined,
            lufsNormalize: { enabled: true, target: -16 },
            noiseGate: { enabled: true, threshold: -45 },
            compressor: { enabled: true, threshold: -20, ratio: 4 }
          }
        });
        
        count++;
        setProgress(Math.round((count / audioFiles.length) * 100));
      }

      let finalVideoPath = videoFile?.filePath;
      let originalPeaks: number[] = [];
      let refPath: string | undefined = undefined;
      let videoDuration = videoFile?.duration || 45.0;

      if (window.electronAPI && videoFile?.filePath) {
          const copyRes = await window.electronAPI.copyFileToProject(videoFile.filePath, assetsDir);
          if (copyRes.success && copyRes.data) finalVideoPath = copyRes.data;

          const takesDir = `${projectRoot}/takes`.replace(/\\/g, '/');
          const peaksRes = await window.electronAPI.extractAudioPeaks(finalVideoPath!, takesDir);
          if (peaksRes.success && peaksRes.data) {
              originalPeaks = Array.from(peaksRes.data.peaks);
              refPath = peaksRes.data.filePath || `${takesDir}/original_audio.wav`.replace(/\\/g, '/');
              if (peaksRes.data.duration) {
                  videoDuration = peaksRes.data.duration;
              }
          }
      }

      const originalTrack: AudioTrack = {
        id: 'original-video-audio-track',
        name: 'Оригинал',
        volume: 0.8,
        isMuted: false,
        isSolo: false,
        segments: videoFile ? [{
          id: 'original-audio-seg',
          startTime: 0,
          duration: videoDuration,
          fileOffset: 0,
          fileDuration: videoDuration,
          blobUrl: refPath ? getSafeFileUrl(refPath) : '#video-orig',
          filePath: refPath || finalVideoPath || '',
          waveform: originalPeaks,
          gain: 1.0,
          playbackRate: 1.0
        }] : [],
        processing: { enabled: false }
      };

      const newProject = {
        ...(project || {}),
        id: project ? project.id : `proj-${Date.now()}`,
        name: videoFile ? videoFile.name.replace(/\.[^/.]+$/, "") : "Новое сведение",
        videoUrl: finalVideoPath ? getSafeFileUrl(finalVideoPath) : undefined,
        videoPath: finalVideoPath,
        projectPath: projectRoot,
        tracks: [originalTrack, ...newTracks],
        roles: audioFiles.map(a => a.roleName),
        originalPeaks: originalPeaks.length > 0 ? originalPeaks : undefined,
        referenceAudioPath: refPath,
        subtitles: project?.subtitles || [],
        latencyOffset: project?.latencyOffset || 0,
        audioOffsetMs: project?.audioOffsetMs || 0,
        audioSettings: project?.audioSettings || {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          bitDepth: 24,
          noiseGateThreshold: -45,
          isNoiseGateEnabled: true,
          compressorThreshold: -20,
          compressorRatio: 4,
          highPassFrequency: 80,
          isDestructive: false,
          backstageMode: 'manual',
          isBackstageEnabled: false,
        },
        originalTrackSettings: project?.originalTrackSettings || {
          enabled: true,
          uvrSeparationEnabled: false,
          uvrModel: 'htdemucs_vocals_bgm',
          vocalExtractionStatus: 'idle',
          originalVocalVolume: 0.8,
          originalInstrumentalVolume: 0.9,
          duckingEnabled: true,
          duckingThreshold: -24,
          duckingRatio: 4,
        }
      };

      setProject(newProject as any);
      setIsImportingProgress(false);
      handleClose();
    } catch (e) {
      console.error(e);
      setIsImportingProgress(false);
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
          className="absolute inset-0 bg-black/85 backdrop-blur-sm"
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="relative bg-zinc-950 border border-white/10 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="p-6 border-b border-white/5 flex items-center justify-between bg-zinc-900/50">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/20 flex items-center justify-center border border-indigo-500/30">
                <Wand2 className="w-5 h-5 text-indigo-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Пакетный импорт данных</h2>
                <p className="text-xs text-zinc-500">Автораспределение голосов дубляжа на таймлайне</p>
              </div>
            </div>
            <button onClick={handleClose} className="p-2 hover:bg-white/5 rounded-full transition-colors">
              <X className="w-6 h-6 text-zinc-500" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* Drag & Drop Space */}
             <div
               {...getRootProps()}
               className={`border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer relative ${
                 isDragActive
                   ? 'border-indigo-500 bg-indigo-500/5'
                   : 'border-white/10 hover:border-indigo-500/50 hover:bg-white/5'
               }`}
             >
               <input {...getInputProps()} />
               <Upload className="w-10 h-10 mx-auto mb-3 text-zinc-500" />
               <h3 className="text-sm font-bold text-white">Перетащите сюда файлы или кликните</h3>
               <p className="text-xs text-zinc-500 mt-1 max-w-md mx-auto">
                 Поддерживается импорт 1 видео исходника и от 1 до 15 необработанных дорожек озвучки в форматах MP4, MKV, WAV, MP3, FLAC
               </p>
               {window.electronAPI && (
                 <button
                   type="button"
                   onClick={(e) => {
                     e.stopPropagation();
                     openNativePicker();
                   }}
                   className="mt-4 px-4 py-2 bg-indigo-600/90 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg transition-all shadow-lg flex items-center gap-2 mx-auto border border-indigo-500/30"
                 >
                   <FolderOpen size={14} />
                   Выбрать файлы через проводник
                 </button>
               )}
             </div>

            {/* Importer Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Left Column: Video source */}
              <div className="md:col-span-1 space-y-4">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Исходное Видео</h3>
                {videoFile ? (
                  <div className="p-4 bg-zinc-900 border border-indigo-500/20 rounded-xl flex items-center gap-3 relative overflow-hidden group">
                    <div className="absolute top-0 left-0 w-1 h-full bg-indigo-500" />
                    <FileVideo className="w-8 h-8 text-indigo-400 flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-white truncate">{videoFile.name}</p>
                      <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                        {(videoFile.size / (1024 * 1024)).toFixed(1)} MB • {videoFile.duration.toFixed(1)}с
                      </p>
                    </div>
                    <button
                      onClick={() => setVideoFile(null)}
                      className="p-1 hover:bg-rose-500/10 text-rose-500 rounded"
                      title="Убрать"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="p-5 bg-zinc-900/40 border border-white/5 rounded-xl border-dashed text-center">
                    <p className="text-xs text-zinc-600">Видео не выбрано</p>
                  </div>
                )}

                <div className="bg-zinc-900/60 rounded-xl p-4 border border-white/5 space-y-3">
                  <span className="text-[9px] uppercase font-bold text-zinc-500 block">Инфосправка</span>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    Добавленные вами голосовые дорожки будут созданы как отдельные слои таймлайна, чтобы вы могли денойзить, компрессировать и сводить их по отдельности.
                  </p>
                </div>
              </div>

              {/* Right Column: Audio list */}
              <div className="md:col-span-2 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[10px] font-black uppercase tracking-widest text-zinc-500">
                    Голосовые дороги ({audioFiles.length})
                  </h3>
                  {audioFiles.length > 0 && (
                    <button
                      onClick={() => setAudioFiles([])}
                      className="text-xs text-rose-500 hover:underline flex items-center gap-1"
                    >
                      Сбросить все
                    </button>
                  )}
                </div>

                {audioFiles.length > 0 ? (
                  <div className="space-y-2 max-h-[35vh] overflow-y-auto pr-1">
                    {audioFiles.map((file, i) => (
                      <div
                        key={file.id}
                        className="p-3 bg-zinc-900 border border-white/5 rounded-xl flex items-center gap-3 hover:border-white/10 transition-all text-xs"
                      >
                        <Music className="w-5 h-5 text-zinc-500 flex-shrink-0" />
                        
                        {/* Name Info */}
                        <div className="min-w-0 w-1/3">
                          <p className="font-bold text-white truncate" title={file.name}>
                            {file.name}
                          </p>
                          <span className="text-[9px] text-zinc-500 font-mono">
                            {file.duration.toFixed(1)}с • {(file.size / (1024 * 1024)).toFixed(2)} MB
                          </span>
                        </div>

                        {/* Middle: Map to role */}
                        <div className="flex-1">
                          <input
                            type="text"
                            value={file.roleName}
                            onChange={(e) => updateRoleName(file.id, e.target.value)}
                            placeholder="Имя / Роль"
                            className="bg-black/40 border border-white/10 rounded px-2.5 py-1 text-xs text-white w-full font-bold focus:border-indigo-500 outline-none"
                            title="Импортировать как дорожку роли"
                          />
                        </div>

                        {/* Extra toggles for smart aligns & denoise */}
                        <div className="flex gap-2 items-center">
                          <button
                            onClick={() => toggleAligned(file.id)}
                            className={`px-2 py-1 rounded text-[9px] font-bold border transition-all ${
                              file.isAligned
                                ? 'bg-indigo-600/15 text-indigo-400 border-indigo-500/20'
                                : 'bg-black/20 text-zinc-500 border-white/5'
                            }`}
                            title="Smart Align - выравнивание вокала по таймингу"
                          >
                            Smart-Align
                          </button>

                          <button
                            onClick={() => toggleDenoised(file.id)}
                            className={`px-2 py-1 rounded text-[9px] font-bold border transition-all ${
                              file.isDenoised
                                ? 'bg-emerald-600/15 text-emerald-400 border-emerald-500/20'
                                : 'bg-black/20 text-zinc-500 border-white/5'
                            }`}
                            title="Применить пакетное удаление шумов нейросетью"
                          >
                            Денойзер
                          </button>

                          <button
                            onClick={() => removeAudioFile(file.id)}
                            className="p-1 text-zinc-500 hover:text-rose-500 rounded"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-8 bg-zinc-900/30 border border-white/5 rounded-xl text-center flex flex-col items-center justify-center">
                    <Music className="w-8 h-8 text-zinc-700 mb-2" />
                    <p className="text-xs text-zinc-600">Перетащите сюда аудиофайлы вокала</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="p-6 border-t border-white/5 bg-zinc-900/50 flex justify-between items-center">
            <div className="flex items-center gap-1.5 text-[11px] text-amber-400 bg-amber-500/5 border border-amber-500/20 px-3 py-1.5 rounded-lg max-w-sm">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>Движок импортирует до 15 дорожек голосов одновременно</span>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="px-5 py-2 rounded-xl text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                Отмена
              </button>

              {isImportingProgress ? (
                <div className="bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 rounded-xl px-6 py-2 flex items-center gap-3 font-bold text-sm min-w-[200px] justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                    <span>Сведение {progress}%</span>
                  </div>
                  <span className="text-xs font-mono">{progress}%</span>
                </div>
              ) : (
                <button
                  onClick={executeImport}
                  disabled={audioFiles.length === 0}
                  className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl text-sm font-extrabold shadow-lg shadow-indigo-600/25 transition-all flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4" /> Разложить в Студию сведения
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
