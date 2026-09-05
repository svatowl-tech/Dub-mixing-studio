import { useCallback, useRef, useState, Dispatch, SetStateAction } from 'react';
import { Project, AudioTrack } from '../types';
import { playbackEngine } from '../services/playbackEngine';

export function useTimelineHistory(
  project: Project | null,
  setProject: Dispatch<SetStateAction<Project | null>>
) {
  const [history, setHistory] = useState<AudioTrack[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const isUndoRedoActionRef = useRef<boolean>(false);

  // Take a snapshot manually before an action
  const saveSnapshot = useCallback((targetId?: string) => {
    if (!project) return;
    setHistory(prev => {
      const currentHistory = prev.slice(0, historyIndex + 1);
      
      let newTracksSnapshot;
      if (targetId) {
        newTracksSnapshot = project.tracks.map(t => 
          t.id === targetId ? { ...t, segments: [...t.segments] } : t
        );
      } else {
        newTracksSnapshot = project.tracks.map(t => ({ ...t, segments: [...t.segments] }));
      }
      
      const newHistory = [...currentHistory, newTracksSnapshot];
      setHistoryIndex(newHistory.length - 1);
      return newHistory;
    });
  }, [project, historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex > 0 && project) {
      isUndoRedoActionRef.current = true;
      const previousTracks = history[historyIndex - 1];
      setProject(prev => prev ? { ...prev, tracks: previousTracks } : prev);
      playbackEngine.reconcile(previousTracks);
      setHistoryIndex(prev => prev - 1);
    } else if (historyIndex === 0 && project && history.length > 0) {
      // If we go back to the original state right before our first snapshot:
      // Wait, let's keep index 0 as the initial state of the first modification.
      // So index 0 is our earliest state.
      // We can't undo beyond the first snapshot unless we take an initial one on load.
      isUndoRedoActionRef.current = true;
      const previousTracks = history[0];
      setProject(prev => prev ? { ...prev, tracks: previousTracks } : prev);
      playbackEngine.reconcile(previousTracks);
    }
  }, [historyIndex, history, project, setProject]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1 && project) {
      isUndoRedoActionRef.current = true;
      const nextTracks = history[historyIndex + 1];
      setProject(prev => prev ? { ...prev, tracks: nextTracks } : prev);
      playbackEngine.reconcile(nextTracks);
      setHistoryIndex(prev => prev + 1);
    }
  }, [historyIndex, history, project, setProject]);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  return { saveSnapshot, undo, redo, canUndo, canRedo };
}
