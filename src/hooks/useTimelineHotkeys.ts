import React, { useEffect } from 'react';
import { Project } from '../types';
import { getDefaultKeyMap } from '../lib/utils';

interface UseTimelineHotkeysProps {
  projectRef: React.MutableRefObject<Project | null>;
  selectedSegmentIds: string[];
  currentTimeRef: React.MutableRefObject<number>;
  isRecordingRef: React.MutableRefObject<boolean>;
  isStartingRecordingRef?: React.MutableRefObject<boolean>;
  togglePlay: () => void;
  stopRecording?: () => void;
  discardRecording?: () => void;
  handleSplitSegment: (trackId: string, segmentId: string, splitTime: number) => void;
  handleSeek?: (time: number) => void;
  addMarker?: () => void;
  deleteSegments?: () => void;
  handleToggleRecord?: () => void;
  handleToggleBackstage?: () => void;
  handleDeleteLastTake?: () => void;
  handleJoinSegments?: () => void;
  handleCopySegments?: () => void;
  handleCutSegments?: () => void;
  handlePasteSegments?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
}

export function useTimelineHotkeys({
  projectRef,
  selectedSegmentIds,
  currentTimeRef,
  isRecordingRef,
  isStartingRecordingRef,
  togglePlay,
  stopRecording,
  discardRecording,
  handleSplitSegment,
  handleSeek,
  addMarker,
  deleteSegments,
  handleToggleRecord,
  handleToggleBackstage,
  handleDeleteLastTake,
  handleJoinSegments,
  handleCopySegments,
  handleCutSegments,
  handlePasteSegments,
  onUndo,
  onRedo
}: UseTimelineHotkeysProps) {
  const callbacksRef = React.useRef({
    togglePlay, stopRecording, discardRecording, handleSplitSegment,
    handleSeek, addMarker, deleteSegments, handleToggleRecord,
    handleToggleBackstage, handleDeleteLastTake, handleJoinSegments,
    handleCopySegments, handleCutSegments, handlePasteSegments,
    onUndo, onRedo
  });

  useEffect(() => {
    callbacksRef.current = {
      togglePlay, stopRecording, discardRecording, handleSplitSegment,
      handleSeek, addMarker, deleteSegments, handleToggleRecord,
      handleToggleBackstage, handleDeleteLastTake, handleJoinSegments,
      handleCopySegments, handleCutSegments, handlePasteSegments,
      onUndo, onRedo
    };
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger hotkeys if user is typing in an input or textarea
      const activeElement = document.activeElement;
      const isTyping = 
        activeElement instanceof HTMLInputElement || 
        activeElement instanceof HTMLTextAreaElement || 
        (activeElement as HTMLElement)?.isContentEditable;

      if (isTyping) return;

      const currentKeyMap = projectRef.current?.audioSettings?.keyMap || getDefaultKeyMap();

      const isPressed = (actionId: string) => {
        const action = currentKeyMap[actionId];
        if (!action) return false;
        return (
          e.code === action.code &&
          (action.ctrlKey === undefined ? !e.ctrlKey : !!e.ctrlKey === !!action.ctrlKey) &&
          (action.shiftKey === undefined ? !e.shiftKey : !!e.shiftKey === !!action.shiftKey) &&
          (action.altKey === undefined ? !e.altKey : !!e.altKey === !!action.altKey)
        );
      };

      // Undo/Redo/Copy/Cut/Paste
      if (e.ctrlKey || e.metaKey) {
        if (e.code === 'KeyZ') {
          e.preventDefault();
          if (e.shiftKey) {
            callbacksRef.current.onRedo?.();
          } else {
            callbacksRef.current.onUndo?.();
          }
          return;
        }
        if (e.code === 'KeyY') {
          e.preventDefault();
          callbacksRef.current.onRedo?.();
          return;
        }
      }

      // Backspace
      if (e.code === 'Delete' || e.code === 'Backspace' || isPressed('delete_selected')) {
        const selectedIds = selectedSegmentIds;
        if (selectedIds && selectedIds.length > 0) {
          e.preventDefault();
          callbacksRef.current.deleteSegments?.();
          return; // Allow the operation to consume the event
        }
      }

      // Play/Pause
      if (isPressed('play_pause') || (!currentKeyMap['play_pause'] && e.code === 'Space')) {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        e.preventDefault();
        e.stopPropagation();
        
        // Wait if recording is in the middle of starting!
        if (isStartingRecordingRef?.current) return;
        
        if (isRecordingRef && isRecordingRef.current && callbacksRef.current.stopRecording) {
            callbacksRef.current.stopRecording();
        } else {
            callbacksRef.current.togglePlay();
        }
        return;
      }

      // Discard recording
      if (isPressed('discard_recording')) {
        if (isRecordingRef.current && callbacksRef.current.discardRecording) {
          e.preventDefault();
          callbacksRef.current.discardRecording();
        }
        return;
      }

      // Seek prev subtitle
      if (isPressed('seek_prev_sub')) {
        e.preventDefault();
        const proj = projectRef.current;
        if (proj && proj.subtitles.length > 0 && callbacksRef.current.handleSeek) {
          const subs = proj.subtitles;
          const role = proj.selectedRole;
          const currentTime = currentTimeRef.current;
          
          // 1. Find current index
          let currentIndex = -1;
          const exactIndex = subs.findIndex(s => currentTime >= s.start && currentTime <= s.end);
          if (exactIndex !== -1) {
            currentIndex = exactIndex;
          } else {
            for (let i = subs.length - 1; i >= 0; i--) {
              if (currentTime > subs[i].start) {
                currentIndex = i;
                break;
              }
            }
          }

          // 2. Logic: If inside sub and > 0.5s from start, go to start
          const currentSub = currentIndex !== -1 ? subs[currentIndex] : null;
          if (currentSub && currentTime > currentSub.start + 0.5) {
            callbacksRef.current.handleSeek(currentSub.start);
            window.dispatchEvent(new CustomEvent('syncScroll'));
            return;
          }

          // 3. Otherwise find previous
          let targetIndex = -1;
          for (let i = currentIndex - 1; i >= 0; i--) {
            if (subs[i].role === role || !role) {
              targetIndex = i;
              break;
            }
          }
          if (targetIndex === -1 && currentIndex > 0) targetIndex = currentIndex - 1;

          if (targetIndex !== -1) {
            callbacksRef.current.handleSeek(subs[targetIndex].start);
          } else {
            callbacksRef.current.handleSeek(0);
          }
          window.dispatchEvent(new CustomEvent('syncScroll'));
        }
        return;
      }

      // Seek next subtitle
      if (isPressed('seek_next_sub')) {
        e.preventDefault();
        const proj = projectRef.current;
        if (proj && proj.subtitles.length > 0 && callbacksRef.current.handleSeek) {
          const subs = proj.subtitles;
          const role = proj.selectedRole;
          const currentTime = currentTimeRef.current;

          // 1. Find current index
          let currentIndex = -1;
          const exactIndex = subs.findIndex(s => currentTime >= s.start && currentTime <= s.end);
          if (exactIndex !== -1) {
            currentIndex = exactIndex;
          } else {
            for (let i = subs.length - 1; i >= 0; i--) {
              if (currentTime > subs[i].start) {
                currentIndex = i;
                break;
              }
            }
          }

          // 2. Find next
          let targetIndex = -1;
          for (let i = currentIndex + 1; i < subs.length; i++) {
            if (subs[i].role === role || !role) {
              targetIndex = i;
              break;
            }
          }
          if (targetIndex === -1 && currentIndex < subs.length - 1) {
            targetIndex = currentIndex + 1;
          }

          if (targetIndex !== -1) {
            callbacksRef.current.handleSeek(subs[targetIndex].start);
          } else {
            // Seek to end
            let maxEnd = 0;
            proj.tracks.forEach(t => {
              t.segments.forEach(s => {
                maxEnd = Math.max(maxEnd, s.startTime + s.duration);
              });
            });
            callbacksRef.current.handleSeek(maxEnd);
          }
          window.dispatchEvent(new CustomEvent('syncScroll'));
        }
        return;
      }

      // Add marker
      if (isPressed('add_marker')) {
        e.preventDefault();
        callbacksRef.current.addMarker?.();
        return;
      }

      // Toggle record
      if (isPressed('record_toggle')) {
        e.preventDefault();
        callbacksRef.current.handleToggleRecord?.();
        return;
      }

      // Toggle backstage
      if (isPressed('backstage_toggle')) {
        e.preventDefault();
        callbacksRef.current.handleToggleBackstage?.();
        return;
      }

      // Delete last take
      if (isPressed('delete_take')) {
        e.preventDefault();
        callbacksRef.current.handleDeleteLastTake?.();
        return;
      }

      // Join segments
      if (isPressed('join_segments')) {
        e.preventDefault();
        callbacksRef.current.handleJoinSegments?.();
        return;
      }

      // Seek start
      if (isPressed('seek_start')) {
        e.preventDefault();
        callbacksRef.current.handleSeek?.(0);
        return;
      }

      // Seek end
      if (isPressed('seek_end')) {
        e.preventDefault();
        const proj = projectRef.current;
        if (proj && callbacksRef.current.handleSeek) {
          let maxEnd = 0;
          proj.tracks.forEach(t => {
            t.segments.forEach(s => {
              maxEnd = Math.max(maxEnd, s.startTime + s.duration);
            });
          });
          callbacksRef.current.handleSeek(maxEnd);
        }
        return;
      }

      // S / split_segment
      if (isPressed('split_segment') || (!currentKeyMap['split_segment'] && (e.code === 'KeyS' || e.key === 's'))) {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        
        // Always trigger split - the logic for what to split resides in handleSplitSegment
        callbacksRef.current.handleSplitSegment('', '', -1); 
        return;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) return;
      
      if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleCopy = (e: ClipboardEvent) => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement || (activeElement as HTMLElement)?.isContentEditable) return;
      if (callbacksRef.current.handleCopySegments && selectedSegmentIds && selectedSegmentIds.length > 0) {
        e.preventDefault();
        callbacksRef.current.handleCopySegments();
      }
    };

    const handleCut = (e: ClipboardEvent) => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement || (activeElement as HTMLElement)?.isContentEditable) return;
      if (callbacksRef.current.handleCutSegments && selectedSegmentIds && selectedSegmentIds.length > 0) {
        e.preventDefault();
        callbacksRef.current.handleCutSegments();
      }
    };

    const handlePaste = (e: ClipboardEvent) => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement || (activeElement as HTMLElement)?.isContentEditable) return;
      if (callbacksRef.current.handlePasteSegments) {
        e.preventDefault();
        callbacksRef.current.handlePasteSegments();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    document.addEventListener('copy', handleCopy);
    document.addEventListener('cut', handleCut);
    document.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('cut', handleCut);
      document.removeEventListener('paste', handlePaste);
    };
  }, [
    projectRef, selectedSegmentIds, currentTimeRef, isRecordingRef
  ]);
}
