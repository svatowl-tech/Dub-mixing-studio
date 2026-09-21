import React, { useRef, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTimelineData } from '../contexts/TimelineContext';
import { playbackEngine } from '../services/playbackEngine';
import { 
  Play, 
  Pause, 
  Circle, 
  Square, 
  Repeat,
  Archive,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Magnet,
  Activity,
  Sliders,
  Volume2,
  VolumeX,
  AlertTriangle,
  Wand2,
  Search,
  Headphones,
  RotateCcw
} from 'lucide-react';
import { cn, isTauriAvailable } from '../lib/utils';
import { Project, AudioTrack, AudioSegment } from '../types';
import TrackHeader from './TrackHeader';
import TimelineCanvas from './TimelineCanvas';
import AudioSegmentView from './AudioSegmentView';
import { TimelineMinimap } from './TimelineMinimap';

import VirtualizedWaveform from './VirtualizedWaveform';


import VUMeter from './VUMeter';

export const Playhead = ({ zoom }: { zoom: number }) => {
  const { currentTime } = useTimelineData();
  return (
    <div 
      className="absolute top-0 bottom-0 w-px bg-rose-500 z-50 pointer-events-none shadow-[0_0_15px_rgba(244,63,94,0.5)]"
      style={{ left: `${currentTime * zoom}px` }}
    >
      <div className="absolute -top-1 -left-1.5 w-3 h-3 bg-rose-500 rotate-45 shadow-lg" />
      <div className="absolute top-0 bottom-0 -left-1 w-2 bg-rose-500/10" />
    </div>
  );
};


export const CurrentTimeDisplay = () => {
  const { currentTime } = useTimelineData();
  return (
    <span className="text-xl font-mono font-bold text-indigo-400 tracking-widest leading-none">
      {Math.floor(currentTime / 60).toString().padStart(2, '0')}:
      {Math.floor(currentTime % 60).toString().padStart(2, '0')}:
      {Math.floor((currentTime % 1) * 30).toString().padStart(2, '0')}
    </span>
  );
};


export const TimelineAutoScroller = ({ timelineRef, isPlaying, zoom }: any) => {
  const { currentTime } = useTimelineData();
  
  useEffect(() => {
    if (!timelineRef.current) return;
    const el = timelineRef.current;
    const scrollLeft = el.scrollLeft;
    const clientWidth = el.clientWidth;
    const currentX = currentTime * zoom;
    
    // Auto-scroll if playhead goes beyond 95% of visible width, or behind current view
    const isOutRight = currentX > scrollLeft + clientWidth * 0.95;
    const isOutLeft = currentX < scrollLeft;

    if (isOutRight || isOutLeft) {
      if (isPlaying) {
        // Simple assignment during playback for a clean "page turn" or to follow along instantly
        el.scrollLeft = Math.max(0, currentX - clientWidth * 0.1);
      }
    }
  }, [currentTime, isPlaying, zoom, timelineRef]);
  return null;
};

interface LiveRecordingSegmentProps {
  recordingStartTime?: number;
  currentTime: number;
  zoom: number;
  recordingPeaks?: number[];
  timelineWidth?: number;
}

const LiveRecordingSegment = ({ recordingStartTime, zoom, recordingPeaks, timelineWidth }: Omit<LiveRecordingSegmentProps, 'currentTime'>) => {
  const { currentTime } = useTimelineData();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !recordingPeaks?.length) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    
    // Resize canvas if needed
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    // Show last N peaks that fit the width
    const maxPeaks = Math.floor(width / 3);
    const peaksToShow = recordingPeaks.slice(-maxPeaks);
    const step = width / (maxPeaks || 1);

    peaksToShow.forEach((p: number, i: number) => {
      const x = i * step;
      const peakHeight = Math.max(2, p * height * 0.8);
      ctx.moveTo(x, height / 2 - peakHeight / 2);
      ctx.lineTo(x, height / 2 + peakHeight / 2);
    });
    ctx.stroke();
    ctx.restore();
  }, [recordingPeaks, timelineWidth, zoom]);

  if (recordingStartTime === undefined) return null;
  
  return (
    <div 
      className="absolute top-0 bottom-0 bg-rose-500/20 border-l-2 border-rose-500 z-10 overflow-hidden"
      style={{ 
        left: `${recordingStartTime * zoom}px`, 
        width: `${Math.max(0, currentTime - recordingStartTime) * zoom}px`
      }}
    >
      <canvas 
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
      <div className="absolute top-2 left-2 flex items-center gap-2 bg-black/40 px-2 py-0.5 rounded backdrop-blur-sm border border-rose-500/30">
        <div className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
        <span className="text-[9px] font-black text-rose-500 uppercase tracking-tighter">Эфир</span>
      </div>
    </div>
  );
};

interface TrackRowProps {
  track: AudioTrack;
  project: Project;
  zoom: number;
  selectedSegmentIds: string[];
  onUpdateSegment: (trackId: string, segmentId: string, updates: Partial<AudioSegment>, targetTrackId?: string) => void;
  onDeleteSegment?: (trackId: string, segmentId: string) => void;
  snapTime: (time: number, excludeSegmentId?: string) => { time: number; snapped: boolean };
  setSnapLine: (time: number | null) => void;
  onSplitSegment?: (trackId: string, segmentId: string, time: number) => void;
  onDuplicateSegment?: (trackId: string, segmentId: string, newStartTime: number) => void;
  onSelectSegment?: (segmentId: string, multi: boolean) => void;
  onCopySegments?: () => void;
  onCutSegments?: () => void;
  onPasteSegments?: () => void;
  onGlueSegments?: () => void;
  currentTimeRef: React.MutableRefObject<number>;
  timelineVisibleRange: { start: number; end: number };
  waveformScaleMode?: 'real' | 'normalized';
  waveformVisualGain?: number;
}

const TrackRow = React.memo(({ 
  track, 
  project, 
  zoom, 
  selectedSegmentIds, 
  onUpdateSegment, 
  onDeleteSegment, 
  snapTime, 
  setSnapLine, 
  onSplitSegment, 
  onDuplicateSegment, 
  onSelectSegment, 
  onCopySegments,
  onCutSegments,
  onPasteSegments,
  onGlueSegments,
  currentTimeRef,
  timelineVisibleRange,
  waveformScaleMode = 'real',
  waveformVisualGain = 1.0
}: TrackRowProps) => {
  const segmentsWithFades = React.useMemo(() => {
    // 1. Sort all segments first
    const sortedSegs = [...track.segments].sort((a: AudioSegment, b: AudioSegment) => a.startTime - b.startTime);
    
    // 2. Calculate fades linearly over sorted array
    const allSegmentsWithFades = sortedSegs.map((segment: AudioSegment, idxInSorted: number) => {
      const prevSeg = idxInSorted > 0 ? sortedSegs[idxInSorted - 1] : null;
      const nextSeg = idxInSorted < sortedSegs.length - 1 ? sortedSegs[idxInSorted + 1] : null;

      let autoFadeIn = 0;
      let autoFadeOut = 0;

      if (prevSeg && prevSeg.startTime + prevSeg.duration > segment.startTime) {
        autoFadeIn = Math.max(0, (prevSeg.startTime + prevSeg.duration) - segment.startTime);
      }
      if (nextSeg && segment.startTime + segment.duration > nextSeg.startTime) {
        autoFadeOut = Math.max(0, (segment.startTime + segment.duration) - nextSeg.startTime);
      }

      return { segment, autoFadeIn, autoFadeOut };
    });

    // 3. Filter by visible range
    if (!timelineVisibleRange) return allSegmentsWithFades;

    return allSegmentsWithFades.filter(({ segment }) => 
      segment.startTime < timelineVisibleRange.end && (segment.startTime + segment.duration) > timelineVisibleRange.start
    );
  }, [track.segments, timelineVisibleRange]);

  return (
    <div className="border-b border-white/5 relative group timeline-track pointer-events-none" data-track-id={track.id} style={{ height: track.height || 80 }}>
      {/* Track Background Grid */}
      <div className="absolute inset-0 pointer-events-none opacity-20 bg-[linear-gradient(to_right,#ffffff05_1px,transparent_1px)]" style={{ backgroundSize: `${zoom}px 100%` }} />
      
      {/* Audio Segments */}
      {segmentsWithFades.map(({ segment, autoFadeIn, autoFadeOut }) => (
        <AudioSegmentView 
          key={segment.id}
          seg={segment}
          trackId={track.id}
          zoom={zoom}
          audioOffsetMs={project.audioOffsetMs}
          timelineVisibleRange={timelineVisibleRange}
          onUpdateSegment={onUpdateSegment}
          onDeleteSegment={onDeleteSegment}
          snapTime={snapTime}
          onSnapLine={setSnapLine}
          onSplitSegment={onSplitSegment}
          onDuplicateSegment={onDuplicateSegment}
          isSelected={selectedSegmentIds.includes(segment.id)}
          onSelectSegment={onSelectSegment}
          onCopySegments={onCopySegments}
          onCutSegments={onCutSegments}
          onPasteSegments={onPasteSegments}
          onGlueSegments={(selectedSegmentIds.length > 1 && selectedSegmentIds.includes(segment.id)) ? onGlueSegments : undefined}
          currentTimeRef={currentTimeRef}
          autoFadeIn={autoFadeIn}
          autoFadeOut={autoFadeOut}
          trackVolume={track.volume}
          waveformScaleMode={waveformScaleMode}
          waveformVisualGain={waveformVisualGain}
        />
      ))}
    </div>
  );
});

export const AdvancedTimeline = ({ 
  project, 
  duration, 
  isPlaying, 
  isRecording, 
  onPlayPause, 
  onRecord, 
  onSeek, 
  onZoom, 
  zoom,
  onUpdateSegment,
  onDeleteSegment,
  loopRange,
  onSetLoopRange,
  onUpdateTrack,
  onUpdateAllTracks,
  onDeleteTrack,
  onAddTrack,
  onArmTrack,
  onSplitSegment,
  onDuplicateSegment,
  isLooping,
  onToggleLoop,
  isRippleEnabled,
  onToggleRipple,
  selectedSegmentIds = [],
  onSelectSegment,
  onSelectBatchSegments,
  onClearSelection,
  onCopySegments,
  onCutSegments,
  onPasteSegments,
  onGlueSegments,
  recordingPeaks,
  recordingStartTime,
  onOpenProcessing,
  onUpdateMasterVolume,
  onUpdateVocalBusVolume,
  onUpdateVocalBusMuted,
  onOpenVocalBusSettings,
  currentTimeRef
}: { 
  project: Project, 
  duration: number, 
  isPlaying: boolean, 
  isRecording: boolean, 
  onPlayPause: () => void, 
  onRecord: () => void, 
  onSeek: (time: number) => void, 
  onZoom: (zoom: number) => void, 
  zoom: number,
  onUpdateSegment: (trackId: string, segmentId: string, updates: Partial<AudioSegment>, targetTrackId?: string) => void,
  onDeleteSegment?: (trackId: string, segmentId: string) => void,
  loopRange: { start: number, end: number } | null,
  onSetLoopRange: (range: { start: number, end: number } | null) => void,
  onUpdateTrack: (trackId: string, updates: Partial<AudioTrack>) => void,
  onUpdateAllTracks?: (updates: Partial<AudioTrack>) => void,
  onDeleteTrack?: (trackId: string) => void,
  onAddTrack?: () => void,
  onArmTrack?: (trackId: string) => void,
  onSplitSegment?: (trackId: string, segmentId: string, time: number) => void,
  onDuplicateSegment?: (trackId: string, segmentId: string, newStartTime: number) => void,
  isLooping: boolean,
  onToggleLoop: () => void,
  isRippleEnabled?: boolean,
  onToggleRipple?: () => void,
  selectedSegmentIds?: string[],
  onSelectSegment?: (segmentId: string, multi: boolean) => void,
  onSelectBatchSegments?: (segmentIds: string[], multi?: boolean) => void,
  onClearSelection?: () => void,
  onCopySegments?: () => void,
  onCutSegments?: () => void,
  onPasteSegments?: () => void,
  onGlueSegments?: () => void,
  recordingPeaks?: number[],
  recordingStartTime?: number,
  onOpenProcessing?: (id: string) => void,
  onUpdateMasterVolume?: (vol: number) => void,
  onUpdateVocalBusVolume?: (vol: number) => void,
  onUpdateVocalBusMuted?: (muted: boolean) => void,
  onOpenVocalBusSettings?: () => void,
  currentTimeRef: React.MutableRefObject<number>
}) => {
  const handleSeek = (time: number, autoScroll: boolean = true) => {
    onSeek(time);
    
    // Force scroll to center the new position only if autoScroll is enabled
    if (autoScroll && timelineRef.current) {
      const scrollTarget = (time * zoom) - (timelineRef.current.clientWidth / 2);
      timelineRef.current.scrollTo({
        left: Math.max(0, scrollTarget),
        behavior: 'instant' 
      });
    }
  };

  if (!project) return null;

  const { currentTime } = useTimelineData();
  const timelineRef = useRef<HTMLDivElement>(null);
  const trackHeadersRef = useRef<HTMLDivElement>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [isSelectingRange, setIsSelectingRange] = useState(false);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [isMarqueeSelecting, setIsMarqueeSelecting] = useState(false);
  const [marqueeStart, setMarqueeStart] = useState<{ x: number, y: number } | null>(null);
  const [marqueeCurrent, setMarqueeCurrent] = useState<{ x: number, y: number } | null>(null);
  const [waveformScaleMode, setWaveformScaleMode] = useState<'real' | 'normalized'>('real');
  const [waveformVisualGain, setWaveformVisualGain] = useState<number>(1.0);

  const [isSnapEnabled, setIsSnapEnabled] = useState(true);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const lastScrubTimeRef = useRef<number | null>(null);

  // Find all unique, sorted fix timestamps (unsatisfied fixes)
  const sortedFixTimes = React.useMemo(() => {
    const fixTimes: number[] = [];
    if (project.subtitles) {
      project.subtitles.forEach(sub => {
        if (sub.needsFix) {
          fixTimes.push(sub.start);
        }
      });
    }
    if (project.fixes) {
      project.fixes.forEach(fix => {
        if (!fix.isResolved) {
          fixTimes.push(fix.timestamp);
        }
      });
    }
    return Array.from(new Set(fixTimes)).sort((a, b) => a - b);
  }, [project.fixes, project.subtitles]);

  const handleJumpToNextFix = () => {
    if (sortedFixTimes.length === 0) return;
    const buffer = 0.1; // 100ms
    let nextFixTime = sortedFixTimes.find(t => t > currentTime + buffer);
    if (nextFixTime === undefined) {
      nextFixTime = sortedFixTimes[0];
    }
    handleSeek(nextFixTime, true);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('syncScroll'));
    }, 50);
  };

  const sortedTracks = React.useMemo(() => {
    return [...project.tracks].sort((a, b) => {
      if (a.name === 'Оригинал') return -1;
      if (b.name === 'Оригинал') return 1;
      return 0;
    });
  }, [project.tracks]);

  // Vocal tracks (all dubbing/speech tracks excluding original reference)
  const vocalTracks = React.useMemo(() => {
    return sortedTracks.filter(t => {
      const name = (t.name || '').toLowerCase();
      return t.type !== 'original' && !name.includes('оригинал') && !name.includes('original') && !name.includes('reference') && !name.includes('звуки');
    });
  }, [sortedTracks]);

  // Aggregated vocal segments for visual rendering in the Vocal Bus Lane
  const allVocalSegments = React.useMemo(() => {
    const list: Array<{ seg: AudioSegment; track: AudioTrack }> = [];
    vocalTracks.forEach(t => {
      t.segments.forEach(s => {
        list.push({ seg: s, track: t });
      });
    });
    return list.sort((a, b) => a.seg.startTime - b.seg.startTime);
  }, [vocalTracks]);

  const zoomRef = useRef(zoom);
  const sortedTracksRef = useRef(sortedTracks);
  const onZoomRef = useRef(onZoom);
  const onUpdateAllTracksRef = useRef(onUpdateAllTracks);
  const onUpdateTrackRef = useRef(onUpdateTrack);

  useEffect(() => {
    zoomRef.current = zoom;
    sortedTracksRef.current = sortedTracks;
    onZoomRef.current = onZoom;
    onUpdateAllTracksRef.current = onUpdateAllTracks;
    onUpdateTrackRef.current = onUpdateTrack;
  }, [zoom, sortedTracks, onZoom, onUpdateAllTracks, onUpdateTrack]);

  const getSnapPoints = React.useCallback((excludeSegmentId?: string) => {
    const points = new Set<number>();
    project.subtitles.forEach(sub => {
      points.add(sub.start);
      points.add(sub.end);
    });
    sortedTracks.forEach(track => {
      track.segments.forEach(seg => {
        if (seg.id !== excludeSegmentId) {
          points.add(seg.startTime);
          points.add(seg.startTime + seg.duration);
        }
      });
    });
    return Array.from(points);
  }, [project.subtitles, sortedTracks]);

  const snapTime = React.useCallback((time: number, excludeSegmentId?: string): { time: number, snapped: boolean } => {
    if (!isSnapEnabled) return { time, snapped: false };
    
    const threshold = 10 / zoom;
    let closestTime = time;
    let minDiff = threshold;
    let snapped = false;

    const snapPoints = getSnapPoints(excludeSegmentId);
    for (const pt of snapPoints) {
      const diff = Math.abs(time - pt);
      if (diff < minDiff) {
        minDiff = diff;
        closestTime = pt;
        snapped = true;
      }
    }

    const gridStep = zoom > 300 ? 0.01 : zoom > 100 ? 0.05 : zoom > 50 ? 0.1 : 0.5;
    const gridPt = Math.round(time / gridStep) * gridStep;
    const gridDiff = Math.abs(time - gridPt);
    if (gridDiff < minDiff && gridDiff < (10 / zoom)) {
      minDiff = gridDiff;
      closestTime = gridPt;
      snapped = true;
    }

    return { time: closestTime, snapped };
  }, [isSnapEnabled, zoom, getSnapPoints]);

  const [masterStream, setMasterStream] = useState<MediaStream | null>(null);
  const [vocalBusStream, setVocalBusStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (isPlaying) {
      setMasterStream(playbackEngine.getMasterStream());
      setVocalBusStream(playbackEngine.getVocalBusStream());
    }
  }, [isPlaying]);

  useEffect(() => {
    return () => {
      // Upon unmounting the timeline, we ensure any long running backend operations 
      // triggered by this session are halted via native Tauri invocation.
      if (isTauriAvailable()) {
        invoke('force_stop_all').catch(console.error);
      }
    };
  }, []);

  const [timelineVisibleRange, setTimelineVisibleRange] = useState({ start: 0, end: 30 });
  const prevZoomRef = useRef(zoom);

  const updateVisibleRange = React.useCallback(() => {
    if (!timelineRef.current) return;
    const scrollLeft = timelineRef.current.scrollLeft;
    const clientWidth = timelineRef.current.clientWidth;
    const start = scrollLeft / zoom;
    const end = (scrollLeft + clientWidth) / zoom;
    setTimelineVisibleRange({ start, end });
  }, [zoom]);

  React.useLayoutEffect(() => {
    let shouldUpdate = true;
    if (timelineRef.current && prevZoomRef.current !== zoom) {
      // Calculate the time at the center of the current view
      const scrollLeft = timelineRef.current.scrollLeft;
      const clientWidth = timelineRef.current.clientWidth;
      const centerTime = (scrollLeft + clientWidth / 2) / prevZoomRef.current;
      
      // Set the new scrollLeft to keep the center time in the middle
      const newScrollLeft = centerTime * zoom - clientWidth / 2;
      timelineRef.current.scrollLeft = Math.max(0, newScrollLeft);
      
      prevZoomRef.current = zoom;
      updateVisibleRange();
      shouldUpdate = false;
    }
    
    if (shouldUpdate) {
      updateVisibleRange();
    }
  }, [zoom, project, updateVisibleRange]);

  React.useLayoutEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      updateVisibleRange();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateVisibleRange]);

  /* Auto-scroll moved to component */

  const handleTimelineInteraction = (e: React.MouseEvent | React.TouchEvent, isMouseMove: boolean = false) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left + timelineRef.current.scrollLeft;
    const time = x / zoom;
    
    if (e.shiftKey || isSelectingRange) {
      if (selectionStart === null) {
        setSelectionStart(time);
        setIsSelectingRange(true);
      } else {
        onSetLoopRange({
          start: Math.min(selectionStart, time),
          end: Math.max(selectionStart, time)
        });
      }
    } else {
      const { time: snappedTime, snapped } = snapTime(time);
      const targetTime = Math.max(0, Math.min(duration, snappedTime));
      
      if (isMouseMove) {
        if (lastScrubTimeRef.current !== null) {
          if (Math.abs(lastScrubTimeRef.current - targetTime) < 0.01) return;
        }
        lastScrubTimeRef.current = targetTime;
        handleSeek(targetTime, false);
      } else {
        lastScrubTimeRef.current = targetTime;
        handleSeek(targetTime, false);
      }
      setSnapLine(snapped ? snappedTime : null);
    }
  };

  useEffect(() => {
    const handleWheelNative = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
        onZoomRef.current(Math.max(10, Math.min(1000, zoomRef.current * zoomDelta)));
      } else if (e.altKey) {
        e.preventDefault();
        const heightDelta = e.deltaY > 0 ? -10 : 10;
        if (onUpdateAllTracksRef.current) {
          onUpdateAllTracksRef.current({ height: Math.max(60, (sortedTracksRef.current[0]?.height || 80) + heightDelta) });
        } else {
          sortedTracksRef.current.forEach(track => {
            onUpdateTrackRef.current(track.id, { height: Math.max(60, (track.height || 80) + heightDelta) });
          });
        }
      } else {
        // Horizontal scroll with normal wheel
        if (timelineRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          // Limit delta to avoid "infinite" scroll feel on some mice
          const delta = Math.max(-500, Math.min(500, e.deltaY));
          timelineRef.current.scrollLeft += delta;
        }
      }
    };

    const el = timelineRef.current;
    if (el) {
      el.addEventListener('wheel', handleWheelNative, { passive: false });
      return () => el.removeEventListener('wheel', handleWheelNative);
    }
  }, []); // Run only once to attach event listener

  // Synchronize scrolling
  useEffect(() => {
    const timelineEl = timelineRef.current;
    const headerEl = trackHeadersRef.current;
    
    if (!timelineEl || !headerEl) return;

    let isSyncingLeft = false;
    let isSyncingRight = false;
    
    const handleTimelineScroll = () => {
      if (!isSyncingLeft) {
        isSyncingRight = true;
        headerEl.scrollTop = timelineEl.scrollTop;
        if (updateVisibleRange) updateVisibleRange();
      }
      isSyncingLeft = false;
    };
    
    const handleHeaderScroll = () => {
      if (!isSyncingRight) {
        isSyncingLeft = true;
        timelineEl.scrollTop = headerEl.scrollTop;
      }
      isSyncingRight = false;
    };

    timelineEl.addEventListener('scroll', handleTimelineScroll);
    headerEl.addEventListener('scroll', handleHeaderScroll);
    
    return () => {
      timelineEl.removeEventListener('scroll', handleTimelineScroll);
      headerEl.removeEventListener('scroll', handleHeaderScroll);
    };
  }, [updateVisibleRange]);

  const handleDoubleClick = (e: React.MouseEvent) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (rect && e.clientY - rect.top > 40) {
      onClearSelection?.();
    }
  };

  // Find the armed track for the live recording overlay
  const recordingTrackIndex = sortedTracks.findIndex(t => t.isArmed) !== -1 
    ? sortedTracks.findIndex(t => t.isArmed)
    : sortedTracks.findIndex(t => t.name !== 'Оригинал');

  return (
    <div className="flex-1 flex flex-col bg-zinc-950 border-t border-zinc-800 select-none min-h-0 min-w-0">
      {/* DAW Transport Bar */}
      <div className="h-14 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-md flex items-center z-50">
        <div className="flex items-center gap-4 px-6">
          <div className="flex items-center bg-black/40 rounded-lg p-1 border border-white/5">
            <button 
              onClick={onPlayPause}
              className={cn(
                "w-10 h-10 rounded-md flex items-center justify-center transition-all",
                isPlaying ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20" : "text-zinc-400 hover:text-white hover:bg-zinc-800"
              )}
            >
              {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
            </button>
            <button 
              onClick={onRecord}
              className={cn(
                "w-10 h-10 rounded-md flex items-center justify-center transition-all",
                isRecording ? "bg-rose-500 text-white shadow-lg shadow-rose-500/20 animate-pulse" : "text-zinc-400 hover:text-rose-500 hover:bg-zinc-800"
              )}
            >
              {isRecording ? <Square size={18} fill="currentColor" /> : <Circle size={18} fill="currentColor" />}
            </button>
            <button 
              onClick={onToggleLoop}
              className={cn(
                "w-10 h-10 rounded-md flex items-center justify-center transition-all",
                isLooping ? "bg-amber-500 text-white shadow-lg shadow-amber-500/20" : "text-zinc-400 hover:text-amber-500 hover:bg-zinc-800"
              )}
            >
              <Repeat size={18} />
            </button>
            <button 
              onClick={() => setIsSnapEnabled(!isSnapEnabled)}
              className={cn(
                "w-10 h-10 rounded-md flex items-center justify-center transition-all ml-2",
                isSnapEnabled ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20" : "text-zinc-400 hover:text-indigo-500 hover:bg-zinc-800"
              )}
              title="Магнит (Snapping)"
            >
              <Magnet size={18} />
            </button>
            {onToggleRipple && (
              <button 
                onClick={onToggleRipple}
                className={cn(
                  "w-10 h-10 rounded-md flex items-center justify-center transition-all ml-2",
                  isRippleEnabled ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20" : "text-zinc-400 hover:text-indigo-500 hover:bg-zinc-800"
                )}
                title="Ripple Edit (Сдвиг сегментов при удалении/изменении длины)"
              >
                <ChevronRight size={18} />
              </button>
            )}
            <button 
              onClick={() => setWaveformScaleMode(prev => prev === 'real' ? 'normalized' : 'real')}
              className={cn(
                "h-10 px-2.5 rounded-md flex items-center gap-1.5 transition-all ml-2 text-xs font-semibold",
                waveformScaleMode === 'real' 
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm" 
                  : "bg-zinc-800 text-zinc-400 hover:text-white border border-white/5"
              )}
              title={waveformScaleMode === 'real' 
                ? "Реальная громкость (0 dBFS) — показывает истинную высоту и громкость сигнала без искусственного растягивания. Кликните для переключения на авто-высоту." 
                : "Авто-масштабирование — растягивает тихие звуки по высоте. Кликните для переключения на реальную шкалу громкости."}
            >
              <Activity size={15} className={waveformScaleMode === 'real' ? "text-emerald-400" : "text-zinc-400"} />
              <span className="text-[11px] font-mono tracking-tight hidden sm:inline">
                {waveformScaleMode === 'real' ? "Реал. громкость" : "Авто-высота"}
              </span>
            </button>
          </div>

          {sortedFixTimes.length > 0 && (
            <button
              onClick={handleJumpToNextFix}
              className="flex items-center gap-1.5 px-3 h-10 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400 text-xs font-bold transition-all shadow-md active:scale-95 shrink-0"
              title="Перейти к следующему исправлению (фиксу)"
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
              </span>
              <span>К СЛЕД. ФИКСУ</span>
              <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-[10px] text-rose-300 font-black">
                {sortedFixTimes.length}
              </span>
            </button>
          )}

          <div className="flex flex-col items-center justify-center bg-black/60 px-4 py-1 rounded border border-white/5 min-w-[140px]">
            <span className="text-[10px] font-black text-zinc-500 uppercase tracking-tighter leading-none mb-1">Текущее время</span>
            <CurrentTimeDisplay />
          </div>
        </div>

        {/* Minimap positioned to the right of current time */}
        {duration > 0 && (
          <div className="flex-1 h-full pl-2">
            <TimelineMinimap 
              project={project}
              duration={duration}
              onSeek={handleSeek}
              visibleRange={timelineVisibleRange}
            />
          </div>
        )}
      </div>

      {/* Interactive Pipeline Pause Banners */}
      {project.pipelineState === 'paused_conflicts' && (
        <div className="bg-rose-950/90 border-b border-rose-500/40 px-5 py-2.5 flex items-center justify-between z-50 shrink-0 animate-in fade-in">
          <div className="flex items-center gap-3 min-w-0">
            <span className="p-1.5 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-400 shrink-0 animate-pulse">
              <AlertTriangle className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-black uppercase tracking-wider text-rose-200 flex items-center gap-2">
                <span>Пауза конвейера: Наезды реплик</span>
                <span className="px-1.5 py-0.2 rounded bg-rose-500/30 text-rose-300 font-mono text-[10px]">
                  {project.pipelinePauseInfo?.conflictCount ?? allVocalSegments.filter(s => s.seg.timingWarning === 'overlap').length} конфликтов
                </span>
              </div>
              <p className="text-[10px] text-zinc-300 truncate">
                Реплики с коллизиями подсвечены красным на таймлайне. Подвиньте их вручную или используйте авто-фикс.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {allVocalSegments.some(s => s.seg.timingWarning === 'overlap') && (
              <button
                onClick={() => {
                  const firstConflict = allVocalSegments.find(s => s.seg.timingWarning === 'overlap');
                  if (firstConflict) handleSeek(firstConflict.seg.startTime, true);
                }}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                title="Перемотать к первому наезду"
              >
                <Search className="w-3 h-3" />
                <span>К наезду</span>
              </button>
            )}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('pipeline_autofix_overlaps'))}
              className="px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer active:scale-95"
              title="Автоматически раздвинуть наезжающие сегменты"
            >
              <Wand2 className="w-3 h-3" />
              <span>Авто-фикс</span>
            </button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('pipeline_resume_conflicts'))}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-black flex items-center gap-1.5 transition-all shadow-md shadow-emerald-950/40 cursor-pointer active:scale-95"
            >
              <Play className="w-3.5 h-3.5 fill-white" />
              <span>Продолжить конвейер</span>
            </button>
          </div>
        </div>
      )}

      {project.pipelineState === 'paused_loudness_balance' && (
        <div className="bg-indigo-950/90 border-b border-indigo-500/40 px-5 py-2 flex items-center justify-between z-50 shrink-0 animate-in fade-in">
          <div className="flex items-center gap-3 min-w-0">
            <span className="p-1.5 rounded-lg bg-indigo-500/20 border border-indigo-500/40 text-indigo-400 shrink-0 animate-pulse">
              <Headphones className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-black uppercase tracking-wider text-indigo-200">
                Пауза конвейера: Контроль баланса громкости голосов к оригиналу
              </div>
              <p className="text-[10px] text-zinc-300 truncate">
                Сведение завершено. Прослушайте с начала и подстройте уровень мастер-шины вокала перед мастерингом.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => {
                handleSeek(0, true);
                if (!isPlaying) onPlayPause();
              }}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer active:scale-95"
              title="Перемотать на 0:00 и включить воспроизведение"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Слушать с 0:00</span>
            </button>

            {/* Быстрый регулятор вокальной шины прямо на таймлайне */}
            <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-zinc-900/90 border border-indigo-500/30">
              <Volume2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <div className="flex flex-col">
                <div className="flex justify-between items-center text-[9px] font-mono leading-none mb-1">
                  <span className="text-zinc-400">Шина вокала:</span>
                  <span className="text-indigo-300 font-bold ml-1">
                    {Math.round((project.vocalBusVolume ?? 1.0) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.01}
                  value={project.vocalBusVolume ?? 1.0}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onUpdateVocalBusVolume?.(val);
                  }}
                  className="w-24 h-1 bg-zinc-800 rounded appearance-none cursor-pointer accent-indigo-500"
                />
              </div>
            </div>

            <button
              onClick={() => window.dispatchEvent(new CustomEvent('pipeline_resume_render'))}
              className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-emerald-600 hover:from-indigo-500 hover:to-emerald-500 text-white text-[11px] font-black flex items-center gap-1.5 transition-all shadow-md shadow-indigo-950/40 cursor-pointer active:scale-95"
            >
              <Play className="w-3.5 h-3.5 fill-white" />
              <span>Продолжить конвейер (Мастеринг)</span>
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative min-h-0">
        {/* Track Headers Column */}
        <div className="w-64 border-r border-zinc-800 bg-zinc-950 flex flex-col z-40 relative min-h-0">
          <div className="h-10 min-h-10 border-b border-zinc-800 bg-zinc-900/50 flex items-center px-4 relative z-50">
            <span className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Дорожки</span>
          </div>
          <div 
            ref={trackHeadersRef}
            className="flex-1 overflow-y-auto min-h-0 no-scrollbar bg-zinc-950"
          >
            {sortedTracks.map(track => (
              <TrackHeader 
                key={track.id} 
                track={track} 
                isMuted={track.isMuted} 
                isSoloed={!!track.isSolo} 
                volume={track.volume} 
                onMute={(id) => onUpdateTrack(id, { isMuted: !track.isMuted })} 
                onSolo={(id) => onUpdateTrack && onUpdateTrack(id, { isSolo: !track.isSolo })} 
                onVolumeChange={(id, vol) => onUpdateTrack && onUpdateTrack(id, { volume: vol })} 
                onArm={(id) => onArmTrack && onArmTrack(id)}
                onRename={(id, name) => onUpdateTrack && onUpdateTrack(id, { name })}
                onClear={(id) => onUpdateTrack(id, { segments: [] })}
                onDelete={(id) => onDeleteTrack?.(id)}
                onUpdateProcessing={(id, processing) => onUpdateTrack(id, { processing })}
                onHeightChange={(id, height) => onUpdateTrack(id, { height })}
                onSelectSegment={onSelectSegment}
                onSelectBatchSegments={onSelectBatchSegments}
                onOpenProcessing={onOpenProcessing}
                onUpdateTrack={onUpdateTrack}
              />
            ))}
            {onAddTrack && (
              <button 
                onClick={onAddTrack}
                className="w-full h-10 border-t border-zinc-800 bg-zinc-900/30 flex items-center justify-center gap-2 hover:bg-zinc-800 transition-colors text-zinc-500 hover:text-zinc-300 shrink-0"
              >
                <Circle size={10} className="text-zinc-600" />
                <span className="text-[10px] font-black uppercase tracking-widest">+ Добавить дорожку</span>
              </button>
            )}

            {/* Vocal Bus Track Header (Мастер-шина вокала) */}
            <div className="w-full h-[95px] border-t border-indigo-900/60 bg-gradient-to-r from-indigo-950/40 via-zinc-900 to-zinc-900 p-3 pt-3 flex flex-col justify-between relative shrink-0">
               <div className="flex items-center justify-between">
                 <div className="flex items-center gap-1.5 min-w-0">
                   <span className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                     BUS
                   </span>
                   <span className="text-[10px] font-black uppercase tracking-wider text-indigo-300 truncate" title="Мастер-шина всех голосов">
                     Шина вокала
                   </span>
                 </div>
                 <div className="flex items-center gap-1">
                   <button
                     type="button"
                     onClick={() => onUpdateVocalBusMuted?.(!project.vocalBusMuted)}
                     className={cn(
                       "w-5 h-5 rounded text-[9px] font-black transition-colors flex items-center justify-center cursor-pointer",
                       project.vocalBusMuted
                         ? "bg-rose-500 text-white shadow-sm shadow-rose-900/50"
                         : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                     )}
                     title={project.vocalBusMuted ? "Включить шину вокала (Unmute)" : "Заглушить шину вокала (Mute)"}
                   >
                     M
                   </button>
                   {onOpenVocalBusSettings && (
                     <button
                       type="button"
                       onClick={onOpenVocalBusSettings}
                       className="p-1 rounded text-zinc-400 hover:text-indigo-300 hover:bg-indigo-950/50 transition-colors cursor-pointer"
                       title="Открыть настройки мастер-шины вокала (DSP / VST рэк)"
                     >
                       <Sliders size={12} />
                     </button>
                   )}
                 </div>
               </div>
               <div className="flex flex-col gap-1">
                 <div className="flex items-center justify-between text-[8px] font-mono text-zinc-400">
                   <span className="text-zinc-500">Громкость голосов:</span>
                   <span className="text-indigo-300 font-bold">
                     {Math.round((project.vocalBusVolume ?? 1.0) * 100)}%
                     <span className="text-zinc-500 ml-1">
                       ({((project.vocalBusVolume ?? 1.0) >= 1.0 ? '+' : '') + (20 * Math.log10(Math.max(0.001, project.vocalBusVolume ?? 1.0))).toFixed(1)} dB)
                     </span>
                   </span>
                 </div>
                 <div className="flex items-center gap-2">
                   <input 
                     type="range" min={0} max={1.5} step={0.01}
                     value={project.vocalBusVolume ?? 1.0}
                     onChange={(e) => onUpdateVocalBusVolume?.(parseFloat(e.target.value))} 
                     className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500" 
                     title="Регулятор общей громкости всех реплик перед мастерингом"
                   />
                 </div>
                 <VUMeter busType="vocal_bus" stream={vocalBusStream} />
               </div>
            </div>

            {/* Master Track Header */}
            <div className="w-full h-[95px] border-t border-zinc-700 bg-zinc-900 p-3 pt-3 flex flex-col justify-between relative shrink-0">
               <div className="flex items-center justify-between">
                 <div className="flex items-center gap-1.5">
                   <span className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                     OUT
                   </span>
                   <span className="text-[10px] font-black uppercase tracking-widest text-emerald-400">Master</span>
                 </div>
                 <span className="text-[8px] font-mono text-zinc-500">
                   {Math.round((project.masterVolume ?? 1.0) * 100)}%
                 </span>
               </div>
               <div className="flex flex-col gap-1">
                 <div className="flex items-center gap-2">
                   <input 
                     type="range" min={0} max={1.5} step={0.01}
                     value={project.masterVolume ?? 1.0}
                     onChange={(e) => onUpdateMasterVolume?.(parseFloat(e.target.value))} 
                     className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500" 
                   />
                 </div>
                 <VUMeter busType="master" stream={masterStream} />
               </div>
            </div>
          </div>
        </div>

        {/* Timeline Area */}
        <div 
          ref={timelineRef}
          onDoubleClick={handleDoubleClick}
          className="flex-1 overflow-auto relative min-h-0 min-w-0 bg-zinc-950 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.06),rgba(255,255,255,0))] [background-image:linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:24px_24px]"
          onMouseDown={(e) => {
            if (e.button === 0) {
              const rect = e.currentTarget.getBoundingClientRect();
              const scrollLeft = e.currentTarget.scrollLeft;
              const scrollTop = e.currentTarget.scrollTop;
              
              const clickX = e.clientX - rect.left;
              const time = (clickX + scrollLeft) / zoom;
              
              if (e.shiftKey && e.clientY - rect.top > 40) {
                // Marquee selection with Shift
                onClearSelection?.();
                setIsMarqueeSelecting(true);
                setMarqueeStart({ x: clickX + scrollLeft, y: e.clientY - rect.top + scrollTop });
                setMarqueeCurrent({ x: clickX + scrollLeft, y: e.clientY - rect.top + scrollTop });
              } else {
                // Normal scrubbing
                setIsScrubbing(true);
                handleTimelineInteraction(e, false);
              }
            }
          }}
          onMouseMove={(e) => {
            if (isScrubbing || isSelectingRange) {
              handleTimelineInteraction(e, true);
            } else if (isMarqueeSelecting && marqueeStart) {
              const rect = timelineRef.current?.getBoundingClientRect();
              if (rect) {
                const x = e.clientX - rect.left + (timelineRef.current?.scrollLeft || 0);
                const y = e.clientY - rect.top + (timelineRef.current?.scrollTop || 0);
                setMarqueeCurrent({ x, y });
              }
            }
          }}
          onMouseUp={() => {
            if (isMarqueeSelecting && marqueeStart && marqueeCurrent) {
              const minX = Math.min(marqueeStart.x, marqueeCurrent.x);
              const maxX = Math.max(marqueeStart.x, marqueeCurrent.x);
              const minY = Math.min(marqueeStart.y, marqueeCurrent.y);
              const maxY = Math.max(marqueeStart.y, marqueeCurrent.y);
              
              const newSelectedIds: string[] = [];
              let currentY = 40; // Ruler height
              
              sortedTracks.forEach(track => {
                const trackTop = currentY;
                const trackBottom = currentY + (track.height || 80);
                
                if (trackBottom > minY && trackTop < maxY) {
                  track.segments.forEach(seg => {
                    const segLeft = seg.startTime * zoom;
                    const segRight = (seg.startTime + seg.duration) * zoom;
                    
                    if (segRight > minX && segLeft < maxX) {
                      newSelectedIds.push(seg.id);
                    }
                  });
                }
                currentY += (track.height || 80);
              });
              
              if (newSelectedIds.length > 0) {
                if (onSelectBatchSegments) {
                  onSelectBatchSegments(newSelectedIds);
                } else if (onSelectSegment) {
                  onClearSelection?.();
                  newSelectedIds.forEach(id => onSelectSegment(id, true));
                }
              }
            }

            setIsScrubbing(false);
            setIsSelectingRange(false);
            setIsMarqueeSelecting(false);
            setSelectionStart(null);
            setSnapLine(null);
            setMarqueeStart(null);
            setMarqueeCurrent(null);
          }}
          onMouseLeave={() => {
            setIsScrubbing(false);
            setIsSelectingRange(false);
            setIsMarqueeSelecting(false);
            setSelectionStart(null);
            setSnapLine(null);
            setMarqueeStart(null);
            setMarqueeCurrent(null);
          }}
        >
          <div 
            className="relative min-h-full"
            style={{ width: `${duration * zoom}px` }}
          >
            {/* Ruler & Grid */}
            <div 
              className="sticky top-0 h-10 w-full bg-zinc-900/90 backdrop-blur-sm border-b border-zinc-800 z-30 cursor-pointer"
              onMouseDown={(e) => {
                e.stopPropagation();
                if (e.button === 0) {
                  if (e.shiftKey) {
                    setIsSelectingRange(true);
                    const rect = timelineRef.current?.getBoundingClientRect();
                    if (rect) {
                      const x = e.clientX - rect.left + (timelineRef.current?.scrollLeft || 0);
                      setSelectionStart(x / zoom);
                    }
                  } else {
                    setIsScrubbing(true);
                    handleTimelineInteraction(e, false);
                  }
                }
              }}
            >
              <TimelineCanvas 
                project={project} 
                duration={duration} 
                zoom={zoom} 
                visibleRange={timelineVisibleRange}
                loopRange={loopRange}
              />
            </div>

            {/* Tracks Content */}
            <div className="relative">
              {sortedTracks.map((track, idx) => (
                <div key={track.id} className="relative">
                  <TrackRow 
                    track={track}
                    project={project}
                    zoom={zoom}
                    selectedSegmentIds={selectedSegmentIds}
                    onUpdateSegment={onUpdateSegment}
                    onDeleteSegment={onDeleteSegment}
                    snapTime={snapTime}
                    setSnapLine={setSnapLine}
                    onSplitSegment={onSplitSegment}
                    onDuplicateSegment={onDuplicateSegment}
                    onSelectSegment={onSelectSegment}
                    onCopySegments={onCopySegments}
                    onCutSegments={onCutSegments}
                    onPasteSegments={onPasteSegments}
                    onGlueSegments={onGlueSegments}
                    currentTimeRef={currentTimeRef}
                    timelineVisibleRange={timelineVisibleRange}
                    waveformScaleMode={waveformScaleMode}
                    waveformVisualGain={waveformVisualGain}
                  />
                  {/* Live Recording Segment */}
                  {isRecording && idx === recordingTrackIndex && (
                    <LiveRecordingSegment 
                      recordingStartTime={recordingStartTime} 
                      zoom={zoom} 
                      recordingPeaks={recordingPeaks} 
                      timelineWidth={timelineRef.current?.clientWidth} 
                    />
                  )}
                </div>
              ))}
              {/* Spacer for Add Track button alignment */}
              {onAddTrack && <div className="h-10 border-b border-white/5 bg-zinc-900/10" />}
              
              {/* Vocal Bus Track Lane (Мастер-шина вокала) */}
              <div 
                className="h-[95px] border-t border-indigo-900/50 bg-gradient-to-b from-indigo-950/20 via-zinc-900/30 to-zinc-900/40 relative overflow-hidden select-none pointer-events-none"
                style={{ width: `${duration * zoom}px` }}
              >
                {/* Background Grid Accent */}
                <div className="absolute inset-0 opacity-15 bg-[linear-gradient(to_right,#818cf815_1px,transparent_1px)]" style={{ backgroundSize: `${zoom}px 100%` }} />
                
                {/* Vocal Bus Lane Sticky Label */}
                <div className="sticky left-2 top-2 z-10 inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-indigo-950/90 border border-indigo-500/40 backdrop-blur-xs text-[9px] font-bold text-indigo-300 shadow-md">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                  <span>Шина вокала • Суммарная огибающая реплик</span>
                  <span className="text-[8px] font-mono text-indigo-400/80 ml-1">
                    ({Math.round((project.vocalBusVolume ?? 1.0) * 100)}%)
                  </span>
                </div>

                {/* Aggregated Vocal Segments Visual Representation */}
                {allVocalSegments.map(({ seg, track }) => {
                  const left = seg.startTime * zoom;
                  const width = Math.max(12, seg.duration * zoom);
                  const effectiveGain = (seg.gain ?? 1.0) * track.volume * (project.vocalBusVolume ?? 1.0);
                  const isMuted = project.vocalBusMuted || track.isMuted;

                  if (timelineVisibleRange && (seg.startTime > timelineVisibleRange.end || (seg.startTime + seg.duration) < timelineVisibleRange.start)) {
                    return null;
                  }

                  return (
                    <div
                      key={`vocal-bus-seg-${track.id}-${seg.id}`}
                      className={cn(
                        "absolute top-6 bottom-2 rounded border transition-opacity overflow-hidden flex flex-col justify-between p-1 shadow-sm",
                        isMuted 
                          ? "bg-zinc-800/40 border-zinc-700/50 opacity-40" 
                          : "bg-gradient-to-r from-indigo-900/60 via-purple-900/50 to-indigo-900/60 border-indigo-400/40 shadow-indigo-950/50"
                      )}
                      style={{ left: `${left}px`, width: `${width}px` }}
                    >
                      <div className="flex items-center justify-between text-[8px] font-mono leading-none text-indigo-200 truncate">
                        <span className="truncate font-semibold px-1 py-0.5 rounded bg-indigo-950/80 border border-indigo-400/30">
                          {track.name}
                        </span>
                        {width > 60 && (
                          <span className="text-zinc-400 text-[7px] ml-1">
                            {effectiveGain > 0 ? (20 * Math.log10(Math.max(0.001, effectiveGain))).toFixed(1) : '-inf'} dB
                          </span>
                        )}
                      </div>

                      <div className="w-full h-3.5 relative flex items-center">
                        <div 
                          className="w-full h-1.5 rounded-full bg-gradient-to-r from-indigo-400/70 to-purple-300/70 transition-transform origin-left"
                          style={{
                            transform: `scaleY(${Math.min(2.5, Math.max(0.4, effectiveGain))})`
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Master Track Lane (Мастер-выход) */}
              <div 
                className="h-[95px] border-t border-zinc-700 bg-zinc-900/40 relative overflow-hidden select-none pointer-events-none"
                style={{ width: `${duration * zoom}px` }}
              >
                <div className="sticky left-2 top-2 z-10 inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-950/90 border border-emerald-500/40 backdrop-blur-xs text-[9px] font-bold text-emerald-300 shadow-md">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span>Мастер-выход • Финальный микс (Голоса + Оригинал)</span>
                  <span className="text-[8px] font-mono text-emerald-400/80 ml-1">
                    ({Math.round((project.masterVolume ?? 1.0) * 100)}%)
                  </span>
                </div>
              </div>
            </div>

            {/* Playhead */}
            <Playhead zoom={zoom} />
            
            {/* Auto-scroller */}
            <TimelineAutoScroller timelineRef={timelineRef} isPlaying={isPlaying} zoom={zoom} />

            {/* Snap Line */}
            {snapLine !== null && (
              <div 
                className="absolute top-0 bottom-0 w-px bg-white z-[60] pointer-events-none shadow-[0_0_8px_rgba(255,255,255,0.8)]"
                style={{ left: `${snapLine * zoom}px` }}
              />
            )}

            {/* Marquee Selection Box */}
            {isMarqueeSelecting && marqueeStart && marqueeCurrent && (
              <div 
                className="absolute bg-indigo-500/20 border border-indigo-500/50 z-[70] pointer-events-none"
                style={{
                  left: `${Math.min(marqueeStart.x, marqueeCurrent.x)}px`,
                  top: `${Math.min(marqueeStart.y, marqueeCurrent.y)}px`,
                  width: `${Math.abs(marqueeCurrent.x - marqueeStart.x)}px`,
                  height: `${Math.abs(marqueeCurrent.y - marqueeStart.y)}px`
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default React.memo(AdvancedTimeline, (prev, next) => {
  return prev.project === next.project && 
         prev.zoom === next.zoom && 
         prev.isPlaying === next.isPlaying &&
         prev.isRecording === next.isRecording &&
         prev.loopRange === next.loopRange &&
         prev.isLooping === next.isLooping &&
         prev.isRippleEnabled === next.isRippleEnabled &&
         prev.selectedSegmentIds === next.selectedSegmentIds &&
         prev.recordingStartTime === next.recordingStartTime &&
         prev.recordingPeaks === next.recordingPeaks;
});
