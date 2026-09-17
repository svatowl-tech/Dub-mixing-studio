import { useCallback, useRef, useState, useEffect, Dispatch, SetStateAction } from 'react';
import { Project, AudioTrack } from '../types';
import { playbackEngine } from '../services/playbackEngine';
import { TimelineHistoryService } from '../services/timelineHistoryService';

/**
 * Высокопроизводительный хук истории действий на таймлайне.
 * Ликвидирует хранение сотен тяжелых клонов массивов AudioTrack в памяти JS!
 * Все состояния сохраняются и извлекаются в виде прямых и обратных дельта-патчей
 * (RFC 6902 JSON Patch) в SQLite таблице `timeline_history` на бэкенде.
 */
export function useTimelineHistory(
  project: Project | null,
  setProject: Dispatch<SetStateAction<Project | null>>
) {
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);
  const [undoDescription, setUndoDescription] = useState<string | null>(null);
  const [redoDescription, setRedoDescription] = useState<string | null>(null);

  const isPerformingUndoRedoRef = useRef<boolean>(false);
  const projectRef = useRef<Project | null>(project);
  projectRef.current = project;

  const initializedProjectIdRef = useRef<string | null>(null);

  // При открытии/смене проекта инициализируем базовое состояние в SQLite
  useEffect(() => {
    if (!project || !project.id) {
      initializedProjectIdRef.current = null;
      setCanUndo(false);
      setCanRedo(false);
      setUndoDescription(null);
      setRedoDescription(null);
      return;
    }

    if (initializedProjectIdRef.current !== project.id) {
      initializedProjectIdRef.current = project.id;
      TimelineHistoryService.initBaseState(project.id, project.tracks)
        .then(() => {
          setCanUndo(false);
          setCanRedo(false);
          setUndoDescription(null);
          setRedoDescription(null);
        })
        .catch(err => {
          console.warn('[useTimelineHistory] Failed to init base state in SQLite:', err);
        });
    }
  }, [project?.id]);

  // Запись действия в нативную историю SQLite
  const saveSnapshot = useCallback((actionDescOrTargetId?: string) => {
    const currentProj = projectRef.current;
    if (!currentProj || !currentProj.id || isPerformingUndoRedoRef.current) return;

    // Формируем человекочитаемое описание действия
    const description = (actionDescOrTargetId && !actionDescOrTargetId.startsWith('track-') && !actionDescOrTargetId.startsWith('seg-'))
      ? actionDescOrTargetId
      : 'Timeline modification';

    TimelineHistoryService.recordAction(currentProj.id, description, currentProj.tracks)
      .then(status => {
        setCanUndo(status.canUndo);
        setCanRedo(status.canRedo);
        setUndoDescription(status.undoActionDescription || null);
        setRedoDescription(status.redoActionDescription || null);
      })
      .catch(err => {
        console.warn('[useTimelineHistory] Failed to record action to SQLite:', err);
      });
  }, []);

  // Выполнение отката (Undo) через дельта-хранилище SQLite
  const undo = useCallback(async () => {
    const currentProj = projectRef.current;
    if (!currentProj || !currentProj.id || isPerformingUndoRedoRef.current) return;

    try {
      isPerformingUndoRedoRef.current = true;
      const response = await TimelineHistoryService.undo(currentProj.id);

      if (response.success && response.tracks) {
        const restoredTracks = response.tracks as AudioTrack[];
        setProject(prev => prev ? { ...prev, tracks: restoredTracks } : prev);
        playbackEngine.reconcile(restoredTracks);

        setCanUndo(response.status.canUndo);
        setCanRedo(response.status.canRedo);
        setUndoDescription(response.status.undoActionDescription || null);
        setRedoDescription(response.status.redoActionDescription || null);
      }
    } catch (err) {
      console.warn('[useTimelineHistory] Undo failed:', err);
      // Запрашиваем актуальный статус
      const status = await TimelineHistoryService.getStatus(currentProj.id);
      setCanUndo(status.canUndo);
      setCanRedo(status.canRedo);
    } finally {
      // Защитный интервал для предотвращения гонок
      setTimeout(() => {
        isPerformingUndoRedoRef.current = false;
      }, 50);
    }
  }, [setProject]);

  // Выполнение повтора (Redo) через дельта-хранилище SQLite
  const redo = useCallback(async () => {
    const currentProj = projectRef.current;
    if (!currentProj || !currentProj.id || isPerformingUndoRedoRef.current) return;

    try {
      isPerformingUndoRedoRef.current = true;
      const response = await TimelineHistoryService.redo(currentProj.id);

      if (response.success && response.tracks) {
        const restoredTracks = response.tracks as AudioTrack[];
        setProject(prev => prev ? { ...prev, tracks: restoredTracks } : prev);
        playbackEngine.reconcile(restoredTracks);

        setCanUndo(response.status.canUndo);
        setCanRedo(response.status.canRedo);
        setUndoDescription(response.status.undoActionDescription || null);
        setRedoDescription(response.status.redoActionDescription || null);
      }
    } catch (err) {
      console.warn('[useTimelineHistory] Redo failed:', err);
      const status = await TimelineHistoryService.getStatus(currentProj.id);
      setCanUndo(status.canUndo);
      setCanRedo(status.canRedo);
    } finally {
      setTimeout(() => {
        isPerformingUndoRedoRef.current = false;
      }, 50);
    }
  }, [setProject]);

  return {
    saveSnapshot,
    undo,
    redo,
    canUndo,
    canRedo,
    undoDescription,
    redoDescription,
  };
}
