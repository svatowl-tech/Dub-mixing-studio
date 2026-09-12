import React, { useCallback, useRef, useEffect } from 'react';
import { logger } from '../lib/logger';
import { IOLogger } from '../lib/ioLogger';
import { Project, AudioTrack, SubtitleLine } from '../types';
import { getGlobalAudioSettings, getSafeFileUrl } from '../lib/utils';
import { UniversalParserService } from '../services/UniversalParserService';

export const useProjectImport = (
  project: Project | null,
  setProject: React.Dispatch<React.SetStateAction<Project | null>>,
  setDuration: (duration: number) => void,
  setIsExporting?: (exp: boolean) => void,
  setExportProgress?: (prog: number) => void,
  setExportOperation?: (op: string) => void
) => {
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const [mkvImportData, setMkvImportData] = React.useState<{ videoPath: string, videoName: string, mediaInfo: any } | null>(null);

  const createDefaultProject = (name: string, path: string): Project => ({
    id: Math.random().toString(36).substr(2, 9),
    name,
    projectPath: path,
    subtitles: [],
    roles: [],
    tracks: [
      { id: '1', name: 'Dubs 1', segments: [], volume: 1, isMuted: false },
      { id: '2', name: 'Dubs 2', segments: [], volume: 1, isMuted: false }
    ],
    latencyOffset: 0,
    audioOffsetMs: 0,
    audioSettings: getGlobalAudioSettings()
  });

  const handleSelectVideo = useCallback(async () => {
    if (!window.electronAPI) return;
    IOLogger.log('MEDIA', 'handleSelectVideo', 'START');
    logger.info("Opening video selection dialog");
    const videoDataRes = await window.electronAPI.openVideo();
    if (!isMounted.current) return;
    if (!videoDataRes.success || !videoDataRes.data) {
      logger.warn("Video selection cancelled");
      IOLogger.log('MEDIA', 'handleSelectVideo', 'ERROR', null, 'User cancelled');
      return;
    }
    const videoData = videoDataRes.data;
    IOLogger.log('MEDIA', 'handleSelectVideo', 'SUCCESS', { path: videoData.path, size: videoData.size });
    
    logger.info(`Selected video: ${videoData.path}`);
    
    // Check if MKV
    if (videoData.path.toLowerCase().endsWith('.mkv')) {
      logger.info(`MKV file detected: ${videoData.path}, fetching media info...`);
      const infoRes = await window.electronAPI.getMediaInfo(videoData.path);
      logger.info(`getMediaInfo response success: ${infoRes.success}`);
      
      if (infoRes.success && infoRes.data) {
        try {
          const parsedInfo = JSON.parse(infoRes.data);
          logger.info(`Parsed media info successfully, streams count: ${parsedInfo.streams?.length}`);
          setMkvImportData({
            videoPath: videoData.path,
            videoName: videoData.name,
            mediaInfo: parsedInfo
          });
          return; // Stop here, wait for modal
        } catch (e) {
          logger.error('Failed to parse media info JSON', e);
        }
      } else {
        logger.error(`getMediaInfo failed or no data:`, infoRes);
        logger.error(`Error details:`, infoRes.error);
        alert(`Не удалось прочитать MKV файл. Ошибка: ${infoRes.error}`);
        return; // Don't continue if MKV parsing fails
      }
    }
    
    logger.info(`Proceeding to import video: ${videoData.path}`);
    await continueImportVideo(videoData.path, videoData.name);
  }, [project, setProject, setDuration, createDefaultProject]);

  const continueImportVideo = async (originalVideoPath: string, videoName: string, subImportedPath?: string) => {
    if (!window.electronAPI) return;
    
    // Choose where to create the project
    let finalProjectRoot = project?.projectPath;
    if (!finalProjectRoot) {
      // Auto-create folder based on video path
      const isWin = originalVideoPath.includes('\\');
      const sep = isWin ? '\\' : '/';
      const lastSepIndex = originalVideoPath.lastIndexOf(sep);
      const videoDir = lastSepIndex !== -1 ? originalVideoPath.substring(0, lastSepIndex) : '';
      const videoNameWithoutExt = videoName.replace(/\.[^/.]+$/, "");
      
      finalProjectRoot = videoDir ? `${videoDir}${sep}${videoNameWithoutExt}_Project` : `${videoNameWithoutExt}_Project`;
    }

    // Initialize subdirs
    await window.electronAPI.initProject(finalProjectRoot);
    if (!isMounted.current) return;
    
    // Copy video to /assets
    const assetsDir = `${finalProjectRoot}/assets`.replace(/\\/g, '/');
    const copyRes = await window.electronAPI.copyFileToProject(originalVideoPath, assetsDir);
    if (!isMounted.current) return;
    const finalVideoPath = copyRes.success && copyRes.data ? copyRes.data : originalVideoPath;

    let initialSubtitles: SubtitleLine[] = project?.subtitles || [];
    let initialRoles: string[] = project?.roles || [];
    
    if (subImportedPath) {
       try {
         const res = await window.electronAPI.readTextFile(subImportedPath);
         if (res.success && res.data) {
            const parsed = await UniversalParserService.parse(res.data, subImportedPath);
            if (parsed && parsed.length > 0) {
                initialSubtitles = parsed;
                initialRoles = Array.from(new Set(parsed.map(s => s.role)));
                if (initialRoles.length === 0) initialRoles = ['Default'];
            }
         }
       } catch (err) {
         logger.error("Failed to load extracted subtitles", err);
       }
    }

    const currentProject = project || createDefaultProject(videoName.replace(/\.[^/.]+$/, ""), finalProjectRoot);
    
    let updatedTracks = [...currentProject.tracks];
    if (!updatedTracks.find(t => t.name === 'Оригинал')) {
      const approxDuration = currentProject.duration || 300;
      updatedTracks.unshift({ // Put original at top
        id: 'originals-track',
        name: 'Оригинал',
        volume: 1,
        isMuted: false,
        segments: [{
          id: 'original-audio-seg',
          startTime: 0,
          duration: approxDuration,
          fileOffset: 0,
          fileDuration: approxDuration,
          blobUrl: getSafeFileUrl(finalVideoPath),
          filePath: finalVideoPath,
          gain: 1,
          playbackRate: 1,
          waveform: Array.from({ length: 200 }, () => 0.15 + Math.random() * 0.2)
        }]
      });
    }

    const updatedProject: Project = { 
      ...currentProject, 
      videoPath: finalVideoPath, 
      videoUrl: getSafeFileUrl(finalVideoPath), 
      projectPath: finalProjectRoot,
      tracks: updatedTracks,
      subtitles: initialSubtitles,
      roles: initialRoles,
      selectedRole: initialRoles[0] || currentProject.selectedRole,
      audioSettings: {
        ...(currentProject.audioSettings || getGlobalAudioSettings()),
        playOriginalTrackSegments: false
      }
    };
    
    setProject(updatedProject);
    
    // Extract audio peaks in the background
    try {
      logger.info("Extracting audio peaks...");
      const takesDir = `${finalProjectRoot}/takes`.replace(/\\/g, '/');
      
      const audioDataRes = await window.electronAPI.extractAudioPeaks(finalVideoPath, takesDir);
      if (!isMounted.current) return;
      
      if (audioDataRes.success && audioDataRes.data) {
        const audioData = audioDataRes.data;
        logger.info("Audio peaks extracted successfully");
        const refPath = audioData.filePath || `${takesDir}/original_audio.wav`.replace(/\\/g, '/');
        
        setProject(prev => {
          if (!prev) return prev;
          return { 
            ...prev, 
            originalPeaks: Array.from(audioData.peaks),
            referenceAudioPath: refPath,
            tracks: prev.tracks.map(t => {
              if (t.name === 'Оригинал') {
                return {
                  ...t,
                  segments: [{
                    id: 'original-audio-seg',
                    startTime: 0,
                    duration: audioData.duration || 999999,
                    fileOffset: 0,
                    fileDuration: audioData.duration,
                    blobUrl: getSafeFileUrl(refPath),
                    filePath: refPath,
                    gain: 1,
                    playbackRate: 1,
                    waveform: Array.from(audioData.peaks)
                  }]
                };
              }
              return t;
            })
          };
        });
        if (audioData.duration) {
          setDuration(audioData.duration);
        }
      }
    } catch (e) {
      logger.error("Failed to extract peaks:", e);
    }
  };

  const handleMkvConfirm = async (audioIndex: number, subIndex?: number) => {
    if (!mkvImportData || !window.electronAPI) return;
    const { videoPath, videoName, mediaInfo } = mkvImportData;
    setMkvImportData(null);
    
    let duration = 0;
    if (mediaInfo.format && mediaInfo.format.duration) {
        duration = parseFloat(mediaInfo.format.duration);
    }
    
    if (setIsExporting) setIsExporting(true);
    if (setExportProgress) setExportProgress(0);
    if (setExportOperation) setExportOperation('Decoding MKV to MP4...');

    logger.info(`Extracting MKV: video=${videoPath}, audioIndex=${audioIndex}, subIndex=${subIndex}, duration=${duration}`);
    
    let isWin = videoPath.includes('\\');
    let sep = isWin ? '\\' : '/';
    let dir = videoPath.substring(0, videoPath.lastIndexOf(sep));
    let base = videoName.substring(0, videoName.lastIndexOf('.'));
    let outMp4 = `${dir}${sep}${base}_extracted.mp4`;
    let outSub = subIndex !== undefined ? `${dir}${sep}${base}_extracted.srt` : undefined;

    logger.info(`Extract output paths generated: outMp4=${outMp4}, outSub=${outSub}`);

    IOLogger.log('MEDIA', 'extractMkvAssets', 'START', { videoPath, audioIndex, subIndex });
    try {
        const res = await window.electronAPI.extractMkvAssets({
            inputPath: videoPath,
            videoOutput: outMp4,
            subOutput: outSub,
            audioIndex,
            subIndex,
            duration: duration > 0 ? duration : undefined
        });

        logger.info(`extractMkvAssets response: success=${res.success}`, res);

        if (setIsExporting) setIsExporting(false);

        if (res.success) {
           IOLogger.log('MEDIA', 'extractMkvAssets', 'SUCCESS', { outMp4, outSub });
           logger.info(`MKV extraction successful, continuing import with: outMp4=${outMp4}, outSub=${outSub}`);
           await continueImportVideo(outMp4, `${base}_extracted.mp4`, outSub);
        } else {
           IOLogger.log('MEDIA', 'extractMkvAssets', 'ERROR', null, res.error);
           logger.error('Failed to extract MKV', res.error);
           alert(`Ошибка декодирования MKV: ${res.error}`);
        }
    } catch (e) {
        if (setIsExporting) setIsExporting(false);
        IOLogger.log('MEDIA', 'extractMkvAssets', 'ERROR', null, String(e));
        logger.error('MKV extraction exception', e);
        alert(`Ошибка декодирования MKV: ${e}`);
    }
  };

  const handleMkvCancel = () => {
    setMkvImportData(null);
  };

  return { handleSelectVideo, mkvImportData, handleMkvConfirm, handleMkvCancel };
};
