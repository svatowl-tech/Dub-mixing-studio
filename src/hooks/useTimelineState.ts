import { useState, useRef, useEffect, useCallback, RefObject } from 'react';
import { Project } from '../types';
import { playbackEngine } from '../services/playbackEngine';
import { logger } from '../lib/logger';

export const useTimelineState = (
  project: Project | null,
  duration: number,
  setDuration: (d: number) => void,
  videoRef: RefObject<HTMLVideoElement | null>,
  referenceAudioRef: RefObject<HTMLAudioElement | null>
) => {
  const [currentTime, setCurrentTime] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [loopRange, setLoopRange] = useState<{ start: number, end: number } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportOperation, setExportOperation] = useState('');
  const [timelineHeight, setTimelineHeight] = useState(65);
  const [isAutoHeight, setIsAutoHeight] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [isRippleEnabled, setIsRippleEnabled] = useState(false);
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([]);
  const [videoError, setVideoError] = useState<string | null>(null);

  const isPlayingRef = useRef(false);
  const currentTimeRef = useRef(0);
  const isTogglingPlayRef = useRef(false);
  const tracksRef = useRef(project?.tracks || []);

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
  useEffect(() => { tracksRef.current = project?.tracks || []; }, [project?.tracks]);

  const timelineRef = useRef<HTMLDivElement>(null);

  const handleSeek = useCallback(async (time: number) => {
    logger.debug(`Seeking to ${time.toFixed(3)}s`);
    const safeTime = Math.max(0, Math.min(duration, time));
    if (videoRef.current) videoRef.current.currentTime = safeTime;
    if (referenceAudioRef.current) referenceAudioRef.current.currentTime = safeTime;
    setCurrentTime(safeTime);
    
    if (project) {
      await playbackEngine.seek(safeTime, project.tracks);
    }
  }, [duration, project, videoRef, referenceAudioRef]);

  const togglePlay = useCallback(async () => {
    if (isTogglingPlayRef.current) return;
    isTogglingPlayRef.current = true;
    logger.info(`Toggling play: current state is ${isPlayingRef.current ? 'playing' : 'stopped'}`);

    try {
      if (isPlayingRef.current) {
        videoRef.current?.pause();
        referenceAudioRef.current?.pause();
        playbackEngine.stop();
        setIsPlaying(false);
      } else {
        setIsPlaying(true);
        if (videoRef.current && !videoError) {
          try {
            await videoRef.current.play();
          } catch (error: any) {
            if (error.name !== 'AbortError') {
              console.warn("Video element play failed, continuing with audio playback:", error);
            }
          }
        }
        if (referenceAudioRef.current) {
          referenceAudioRef.current.play().catch(() => {});
        }
        if (project) {
          const tracksToPlay = [...project.tracks];
          const originalsTrack = project.tracks.find(t => t.name === 'Оригинал');
          
          if (project.referenceAudioPath && (!originalsTrack || originalsTrack.segments.length === 0)) {
            const refPath = project.referenceAudioPath;
            const fullPath = refPath.startsWith('./') && project.projectPath 
              ? `${project.projectPath}/${refPath.slice(2)}` 
              : refPath;
            
            tracksToPlay.push({
              id: 'reference-track',
              name: 'Reference',
              volume: originalsTrack?.volume ?? 1.0,
              isMuted: originalsTrack?.isMuted ?? false,
              isSolo: originalsTrack?.isSolo ?? false,
              segments: [{
                id: 'reference-seg',
                startTime: 0,
                duration: duration,
                filePath: fullPath
              }]
            } as any);
          }
          playbackEngine.play(tracksToPlay, currentTimeRef.current).catch(console.error);
        }
      }
    } finally {
      setTimeout(() => {
        isTogglingPlayRef.current = false;
      }, 100);
    }
  }, [project, duration, videoError, videoRef, referenceAudioRef]);

  const handleFitToWidth = useCallback((containerWidth?: number) => {
    const width = containerWidth || (typeof window !== 'undefined' ? window.innerWidth - 300 : 1000);
    if (duration > 0) {
      const actualContainerWidth = width - 100; // padding
      const newZoom = actualContainerWidth / duration;
      setZoomLevel(Math.max(10, Math.min(newZoom, 2000)));
    }
  }, [duration]);

  // Sync playback engine and timeline with hardware Transport Clock Master (Rust)
  useEffect(() => {
    if (!isPlaying) return;

    const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

    let isCleanedUp = false;
    let unlistenTick: (() => void) | null = null;
    let rafId: number | null = null;
    let lastRenderTime = 0;
    let lastAckTime = 0;

    const processTick = async (time: number) => {
      if (!isPlayingRef.current || isCleanedUp) return;

      // Loop Logic
      if (isLooping && loopRange && time >= loopRange.end) {
        time = loopRange.start;
        if (videoRef.current) videoRef.current.currentTime = time;
        if (referenceAudioRef.current) referenceAudioRef.current.currentTime = time;
        await playbackEngine.seek(time, tracksRef.current);
      }

      // Check if reached duration limit without video
      if (duration > 0 && time > duration) {
        togglePlay();
        return;
      }

      currentTimeRef.current = time;
      await playbackEngine.tick(time, tracksRef.current);

      // Synchronize video player drift (> 35 ms)
      if (videoRef.current && !videoRef.current.seeking) {
        const drift = Math.abs(videoRef.current.currentTime - time);
        if (drift > 0.035) {
          videoRef.current.currentTime = time;
        }
      }
      if (referenceAudioRef.current) {
        const drift = Math.abs(referenceAudioRef.current.currentTime - time);
        if (drift > 0.035) {
          referenceAudioRef.current.currentTime = time;
        }
      }

      // Throttle React state render to ~40fps (25ms) to prevent JS thread stalls
      const now = performance.now();
      if (now - lastRenderTime >= 25) {
        lastRenderTime = now;
        setCurrentTime(time);
      }
    };

    if (isTauri) {
      import('@tauri-apps/api/event').then(({ listen }) => {
        if (isCleanedUp) return;
        listen<any>('transport-tick', (event) => {
          if (isCleanedUp) return;
          const snap = event.payload;
          processTick(snap.timeSec);

          const now = performance.now();
          if (now - lastAckTime >= 30) {
            lastAckTime = now;
            import('@tauri-apps/api/core').then(({ invoke }) => {
              invoke('transport_ui_ack').catch(() => {});
            }).catch(() => {});
          }
        }).then((fn) => {
          if (isCleanedUp) {
            fn();
          } else {
            unlistenTick = fn;
          }
        });
      });
    } else {
      // Browser RAF fallback
      let lastClock = performance.now();
      const syncRaf = async () => {
        if (!isPlayingRef.current || isCleanedUp) return;

        const now = performance.now();
        const deltaSec = (now - lastClock) / 1000;
        lastClock = now;

        let time: number;
        if (videoRef.current && !videoRef.current.paused && !isNaN(videoRef.current.currentTime)) {
          time = videoRef.current.currentTime;
        } else {
          time = currentTimeRef.current + deltaSec;
        }

        await processTick(time);
        if (!isCleanedUp && isPlayingRef.current) {
          rafId = requestAnimationFrame(syncRaf);
        }
      };
      rafId = requestAnimationFrame(syncRaf);
    }

    return () => {
      isCleanedUp = true;
      if (unlistenTick) unlistenTick();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isPlaying, isLooping, loopRange, duration, togglePlay, videoRef, referenceAudioRef]);

  // Synchronize loop region with Rust hardware Transport Clock
  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
    if (!isTauri) return;

    if (isLooping && loopRange) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        const sr = 48000;
        invoke('transport_set_loop', {
          startSample: Math.round(loopRange.start * sr),
          endSample: Math.round(loopRange.end * sr),
          enabled: true,
        }).catch(() => {});
      }).catch(() => {});
    } else {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('transport_clear_loop').catch(() => {});
      }).catch(() => {});
    }
  }, [isLooping, loopRange]);

  // Preload audio buffers for project tracks in the background
  useEffect(() => {
    if (project?.tracks && project.tracks.length > 0) {
      playbackEngine.preloadProjectBuffers(project.tracks).catch(console.warn);
    }
  }, [project?.tracks]);

  // Update playback engine when video playback rate changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleRateChange = async () => {
      if (project) {
        await playbackEngine.updateTracks(project.tracks);
      }
    };

    video.addEventListener('ratechange', handleRateChange);
    return () => {
      video.removeEventListener('ratechange', handleRateChange);
    };
  }, [videoRef, project]);

  return {
    currentTime, setCurrentTime,
    zoomLevel, setZoomLevel,
    isPlaying, setIsPlaying,
    isLooping, setIsLooping,
    loopRange, setLoopRange,
    isExporting, setIsExporting,
    exportProgress, setExportProgress,
    exportOperation, setExportOperation,
    timelineHeight, setTimelineHeight,
    isAutoHeight, setIsAutoHeight,
    sidebarWidth, setSidebarWidth,
    isRippleEnabled, setIsRippleEnabled,
    selectedSegmentIds, setSelectedSegmentIds,
    videoError, setVideoError,
    handleSeek,
    togglePlay,
    handleFitToWidth,
    isPlayingRef,
    currentTimeRef,
    timelineRef
  };
};
