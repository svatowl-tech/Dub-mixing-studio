// ============================================================================
// DUB MIXING STUDIO PRO - REACT HOOK FOR SQLITE TIMELINE HISTORY
// ============================================================================
// Архитектура:
// 1. Нулевой оверхед памяти в браузере/рендерере: массивы треков и клипов не
//    дублируются в JS-стеках.
// 2. Все изменения передаются на бэкенд в SQLite дельта-движок (JSON-Patch).
// 3. Откат/повтор запрашивает вычисленное состояние и список затронутых сущностей.
// 4. Поддержка глобальных клавиатурных сочетаний (Ctrl+Z / Cmd+Z, Ctrl+Y / Cmd+Shift+Z).
// ============================================================================

import { useCallback, useRef, useState, useEffect, Dispatch, SetStateAction } from 'react';
import { Project, AudioTrack } from '../types';
import { playbackEngine } from '../services/playbackEngine';
import { TimelineHistoryService, HistoryStatus, AffectedEntities } from '../services/timelineHistoryService';

export interface UseTimelineHistoryReturn {
  saveSnapshot: (actionDescription?: string) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  undoDescription: string | null;
  redoDescription: string | null;
  totalUndoSteps: number;
  totalRedoSteps: number;
  isProcessingHistory: boolean;
}

/**
 * Высокопроизводительный минималистичный React-хук для работы с нативной историей в SQLite.
 */
export function useTimelineHistory(
  project: Project | null,
  setProject: Dispatch<SetStateAction<Project | null>>
): UseTimelineHistoryReturn {
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);
  const [undoDescription, setUndoDescription] = useState<string | null>(null);
  const [redoDescription, setRedoDescription] = useState<string | null>(null);
  const [totalUndoSteps, setTotalUndoSteps] = useState<number>(0);
  const [totalRedoSteps, setTotalRedoSteps] = useState<number>(0);
  const [isProcessingHistory, setIsProcessingHistory] = useState<boolean>(false);

  const isPerformingUndoRedoRef = useRef<boolean>(false);
  const projectRef = useRef<Project | null>(project);
  projectRef.current = project;

  const initializedProjectIdRef = useRef<string | null>(null);

  // Обновление локальных флагов доступности истории
  const updateStatus = useCallback((status: HistoryStatus) => {
    setCanUndo(status.canUndo);
    setCanRedo(status.canRedo);
    setUndoDescription(status.undoActionDescription || null);
    setRedoDescription(status.redoActionDescription || null);
    setTotalUndoSteps(status.totalUndoSteps);
    setTotalRedoSteps(status.totalRedoSteps);
  }, []);

  // Инициализация базового снимка в SQLite при открытии нового проекта
  useEffect(() => {
    if (!project || !project.id) {
      initializedProjectIdRef.current = null;
      setCanUndo(false);
      setCanRedo(false);
      setUndoDescription(null);
      setRedoDescription(null);
      setTotalUndoSteps(0);
      setTotalRedoSteps(0);
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
          setTotalUndoSteps(0);
          setTotalRedoSteps(0);
        })
        .catch(err => {
          console.warn('[useTimelineHistory] Init base state error in SQLite:', err);
        });
    }
  }, [project?.id]);

  // Запись действия в нативную историю SQLite
  const saveSnapshot = useCallback((actionDescOrTargetId?: string) => {
    const currentProj = projectRef.current;
    if (!currentProj || !currentProj.id || isPerformingUndoRedoRef.current) return;

    // Форматируем читаемое описание действия (Сдвиг клипа, Разрез, Изменение громкости и т.д.)
    const description = (actionDescOrTargetId && !actionDescOrTargetId.startsWith('track-') && !actionDescOrTargetId.startsWith('seg-'))
      ? actionDescOrTargetId
      : 'Модификация таймлайна';

    TimelineHistoryService.recordAction(currentProj.id, description, currentProj.tracks)
      .then(status => {
        updateStatus(status);
      })
      .catch(err => {
        console.warn('[useTimelineHistory] Record action to SQLite failed:', err);
      });
  }, [updateStatus]);

  // Атомарный откат (Undo) через SQLite
  const undo = useCallback(async () => {
    const currentProj = projectRef.current;
    if (!currentProj || !currentProj.id || isPerformingUndoRedoRef.current) return;

    try {
      isPerformingUndoRedoRef.current = true;
      setIsProcessingHistory(true);
      const response = await TimelineHistoryService.undo(currentProj.id);

      if (response.success && response.tracks) {
        const restoredTracks = response.tracks as AudioTrack[];
        setProject(prev => prev ? { ...prev, tracks: restoredTracks } : prev);
        playbackEngine.reconcile(restoredTracks);
        updateStatus(response.status);
      }
    } catch (err) {
      console.warn('[useTimelineHistory] Undo failed:', err);
      const status = await TimelineHistoryService.getStatus(currentProj.id);
      updateStatus(status);
    } finally {
      setIsProcessingHistory(false);
      // Защитный интервал для предотвращения случайной перезаписи дельты
      setTimeout(() => {
        isPerformingUndoRedoRef.current = false;
      }, 50);
    }
  }, [setProject, updateStatus]);

  // Атомарный повтор (Redo) через SQLite
  const redo = useCallback(async () => {
    const currentProj = projectRef.current;
    if (!currentProj || !currentProj.id || isPerformingUndoRedoRef.current) return;

    try {
      isPerformingUndoRedoRef.current = true;
      setIsProcessingHistory(true);
      const response = await TimelineHistoryService.redo(currentProj.id);

      if (response.success && response.tracks) {
        const restoredTracks = response.tracks as AudioTrack[];
        setProject(prev => prev ? { ...prev, tracks: restoredTracks } : prev);
        playbackEngine.reconcile(restoredTracks);
        updateStatus(response.status);
      }
    } catch (err) {
      console.warn('[useTimelineHistory] Redo failed:', err);
      const status = await TimelineHistoryService.getStatus(currentProj.id);
      updateStatus(status);
    } finally {
      setIsProcessingHistory(false);
      setTimeout(() => {
        isPerformingUndoRedoRef.current = false;
      }, 50);
    }
  }, [setProject, updateStatus]);

  // Глобальные горячие клавиши (Ctrl+Z / Cmd+Z для Undo, Ctrl+Y / Cmd+Shift+Z для Redo)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Игнорируем нажатия внутри текстовых полей и редакторов
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const isCmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

      if (isCmdOrCtrl && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          // Redo: Cmd+Shift+Z / Ctrl+Shift+Z
          if (canRedo) redo();
        } else {
          // Undo: Cmd+Z / Ctrl+Z
          if (canUndo) undo();
        }
      } else if (isCmdOrCtrl && e.key.toLowerCase() === 'y') {
        // Redo: Ctrl+Y
        e.preventDefault();
        if (canRedo) redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canUndo, canRedo, undo, redo]);

  return {
    saveSnapshot,
    undo,
    redo,
    canUndo,
    canRedo,
    undoDescription,
    redoDescription,
    totalUndoSteps,
    totalRedoSteps,
    isProcessingHistory,
  };
}
