import { useState, useRef, useCallback } from 'react';
import { playbackEngine } from '../services/playbackEngine';
import { Project } from '../types';

export const useTimelineNavigation = (
  project: Project | null,
  duration: number,
  zoom: number,
  onSeek: (time: number) => void
) => {
  const timelineRef = useRef<HTMLDivElement>(null);

  const handleSeek = useCallback((time: number) => {
    if (Number.isFinite(time)) {
      onSeek(Math.max(0, Math.min(duration, time)));
      
      if (project) {
        playbackEngine.seek(time, project.tracks);
      }
    }
  }, [duration, project, onSeek]);

  return { timelineRef, handleSeek };
};
