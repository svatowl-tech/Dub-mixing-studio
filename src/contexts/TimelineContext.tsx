import React, { createContext, useContext, RefObject, MutableRefObject } from 'react';

export interface TimelineContextType {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  zoomLevel: number;
  timelineHeight: number;
  isAutoHeight: boolean;
  sidebarWidth: number;
  isRippleEnabled: boolean;
  selectedSegmentIds: string[];
  isLooping: boolean;
  loopRange: { start: number; end: number } | null;
  currentTimeRef: MutableRefObject<number>;
  videoRef: RefObject<HTMLVideoElement>;
  referenceAudioRef: RefObject<HTMLAudioElement>;
  
  setCurrentTime: (t: number) => void;
  setDuration: (d: number) => void;
  setIsPlaying: (p: boolean) => void;
  setZoomLevel: (z: number) => void;
  setTimelineHeight: (h: number) => void;
  setIsAutoHeight: (a: boolean) => void;
  setSidebarWidth: (w: number) => void;
  setIsRippleEnabled: (r: boolean) => void;
  setSelectedSegmentIds: (ids: React.SetStateAction<string[]>) => void;
  setIsLooping: (l: boolean) => void;
  setLoopRange: (r: { start: number; end: number } | null) => void;
  
  togglePlay: () => void;
  handleSeek: (time: number) => void;
}

const TimelineContext = createContext<TimelineContextType | null>(null);

export const TimelineProvider: React.FC<{
  value: TimelineContextType;
  children: React.ReactNode;
}> = ({ value, children }) => {
  return <TimelineContext.Provider value={value}>{children}</TimelineContext.Provider>;
};

export const useTimelineData = () => {
  const ctx = useContext(TimelineContext);
  if (!ctx) throw new Error("useTimelineData must be used within TimelineProvider");
  return ctx;
};
