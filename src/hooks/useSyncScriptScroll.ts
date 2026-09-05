import React, { useEffect, useState, useRef, useCallback } from 'react';
import { SubtitleLine } from '../types';

export const useSyncScriptScroll = (
  currentTime: number,
  subtitles: SubtitleLine[],
  containerRef: React.RefObject<HTMLDivElement | null>,
  idPrefix: string = ''
) => {
  const [isSyncEnabled, setIsSyncEnabled] = useState(true);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const performSyncScroll = useCallback((instant: boolean = false) => {
    // Small delay to allow state to settle after seek/update
    setTimeout(() => {
      if (!containerRef.current || !subtitles || subtitles.length === 0) return;

      // Find active or nearest subtitle
      let activeSub = subtitles.find(s => currentTime >= s.start && currentTime <= s.end);
      if (!activeSub) {
        let minDistance = Infinity;
        let nearestSub = undefined;
        for (const s of subtitles) {
          let dist = 0;
          if (currentTime < s.start) {
            dist = s.start - currentTime;
          } else if (currentTime > s.end) {
            dist = currentTime - s.end;
          }
          if (dist < minDistance) {
            minDistance = dist;
            nearestSub = s;
          }
        }
        activeSub = nearestSub;
      }
      
      if (!activeSub) return;

      // If instant is true (from event) or we are very close to subtitle start 
      // (accounting for potential preroll jumps or normal entry)
      const isActuallyInstant = instant;

      // Resolve Element
      const activeId = activeSub.id;
      let element = activeId ? document.getElementById(`${idPrefix}sub-${activeId}`) : null;
      
      if (!element && activeId) {
        element = document.getElementById(`${idPrefix}${activeId}`);
      }
      if (!element) {
        const timeId = `sub-${activeSub.start.toFixed(3)}`;
        element = document.getElementById(`${idPrefix}${timeId}`);
      }

      if (element) {
        const container = containerRef.current;
        const rect = element.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // Centering logic
        const threshold = containerRect.height * 0.2;
        const isVisibleInCenter = (rect.top >= containerRect.top + threshold) && 
                                (rect.bottom <= containerRect.bottom - threshold);

        if (!isVisibleInCenter || isActuallyInstant) {
          element.scrollIntoView({
            behavior: isActuallyInstant ? 'auto' : 'smooth',
            block: 'center'
          });
        }
      }
    }, 20);
  }, [currentTime, subtitles, containerRef, idPrefix]);

  useEffect(() => {
    if (!isSyncEnabled || !containerRef.current || !subtitles || subtitles.length === 0) return;
    performSyncScroll(false);
  }, [currentTime, isSyncEnabled, performSyncScroll]);

  useEffect(() => {
    const handleForceSync = () => {
      setIsSyncEnabled(true);
      // Forced sync from buttons is instant
      performSyncScroll(true);
    };

    window.addEventListener('syncScroll', handleForceSync);
    return () => window.removeEventListener('syncScroll', handleForceSync);
  }, [performSyncScroll]);

  const handleManualInteraction = () => {
    setIsSyncEnabled(false);
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setIsSyncEnabled(true);
    }, 2000); // Re-enable after 2 seconds of inactivity
  };

  return { handleManualInteraction };
};
