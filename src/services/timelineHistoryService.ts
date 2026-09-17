// ============================================================================
// DUB MIXING STUDIO PRO - TIMELINE HISTORY SERVICE (FRONTEND BRIDGE)
// Клиентский сервис интеграции с нативным SQLite Delta Undo/Redo движком
// Полная ликвидация хранения тяжелых состояний в памяти JavaScript!
// ============================================================================

import { invoke, isTauri } from '@tauri-apps/api/core';
import { AudioTrack } from '../types';
import { IOLogger } from '../lib/ioLogger';

export interface HistoryStatus {
  projectId: string;
  canUndo: boolean;
  canRedo: boolean;
  undoActionDescription?: string | null;
  redoActionDescription?: string | null;
  totalUndoSteps: number;
  totalRedoSteps: number;
  currentPointerId?: number | null;
}

export interface TimelineHistoryResponse {
  success: boolean;
  status: HistoryStatus;
  tracks?: AudioTrack[] | null;
  appliedAction?: string | null;
}

/**
 * Сервис управления историей действий на таймлайне через SQLite на бэкенде.
 */
export class TimelineHistoryService {
  // Легковесный браузерный fallback на случай разработки в чистом вебе без Tauri
  private static fallbackState: Map<string, {
    history: { desc: string; tracks: AudioTrack[] }[];
    index: number;
  }> = new Map();

  /**
   * Инициализирует базовое состояние проекта (без добавления в стек отката)
   */
  static async initBaseState(projectId: string, tracks: AudioTrack[]): Promise<void> {
    IOLogger.log('HISTORY', 'TimelineHistoryService:initBaseState', 'START', { projectId, tracksCount: tracks.length });
    try {
      if (isTauri()) {
        await invoke('init_timeline_history_base', {
          projectId,
          tracks,
        });
        IOLogger.log('HISTORY', 'TimelineHistoryService:initBaseState', 'SUCCESS', { projectId });
        return;
      }

      // Web Fallback
      this.fallbackState.set(projectId, {
        history: [{ desc: 'Initial state', tracks: JSON.parse(JSON.stringify(tracks)) }],
        index: 0,
      });
      IOLogger.log('HISTORY', 'TimelineHistoryService:initBaseState', 'SUCCESS', { projectId, fallback: true });
    } catch (err) {
      IOLogger.log('HISTORY', 'TimelineHistoryService:initBaseState', 'ERROR', { projectId }, String(err));
      console.warn('[TimelineHistoryService] initBaseState error:', err);
    }
  }

  /**
   * Записывает новое действие в SQLite с автоматическим расчетом JSON-Patch дельты
   */
  static async recordAction(
    projectId: string,
    actionDescription: string,
    tracks: AudioTrack[]
  ): Promise<HistoryStatus> {
    IOLogger.log('HISTORY', 'TimelineHistoryService:recordAction', 'START', {
      projectId,
      action: actionDescription,
      tracksCount: tracks.length,
    });

    try {
      if (isTauri()) {
        const status = await invoke<HistoryStatus>('record_timeline_action', {
          projectId,
          actionDescription,
          tracks,
        });
        IOLogger.log('HISTORY', 'TimelineHistoryService:recordAction', 'SUCCESS', {
          canUndo: status.canUndo,
          canRedo: status.canRedo,
          steps: status.totalUndoSteps,
        });
        return status;
      }

      // Web Fallback
      let state = this.fallbackState.get(projectId);
      if (!state) {
        state = { history: [], index: -1 };
        this.fallbackState.set(projectId, state);
      }
      // Truncate redo branch
      const nextHist = state.history.slice(0, state.index + 1);
      nextHist.push({ desc: actionDescription, tracks: JSON.parse(JSON.stringify(tracks)) });
      if (nextHist.length > 50) nextHist.shift();
      state.history = nextHist;
      state.index = nextHist.length - 1;

      return {
        projectId,
        canUndo: state.index > 0,
        canRedo: false,
        undoActionDescription: actionDescription,
        redoActionDescription: null,
        totalUndoSteps: state.index,
        totalRedoSteps: 0,
        currentPointerId: state.index,
      };
    } catch (err) {
      IOLogger.log('HISTORY', 'TimelineHistoryService:recordAction', 'ERROR', { projectId }, String(err));
      console.warn('[TimelineHistoryService] recordAction error:', err);
      return {
        projectId,
        canUndo: false,
        canRedo: false,
        totalUndoSteps: 0,
        totalRedoSteps: 0,
      };
    }
  }

  /**
   * Выполняет откат действия (Undo) через SQLite
   */
  static async undo(projectId: string): Promise<TimelineHistoryResponse> {
    IOLogger.log('HISTORY', 'TimelineHistoryService:undo', 'START', { projectId });
    try {
      if (isTauri()) {
        const res = await invoke<TimelineHistoryResponse>('undo_timeline_action', { projectId });
        IOLogger.log('HISTORY', 'TimelineHistoryService:undo', 'SUCCESS', {
          action: res.appliedAction,
          canUndo: res.status.canUndo,
          canRedo: res.status.canRedo,
        });
        return res;
      }

      // Web Fallback
      const state = this.fallbackState.get(projectId);
      if (!state || state.index <= 0) {
        throw new Error('Cannot undo: earliest state reached');
      }
      state.index -= 1;
      const entry = state.history[state.index];
      return {
        success: true,
        status: {
          projectId,
          canUndo: state.index > 0,
          canRedo: state.index < state.history.length - 1,
          undoActionDescription: state.index > 0 ? state.history[state.index].desc : null,
          redoActionDescription: state.history[state.index + 1]?.desc || null,
          totalUndoSteps: state.index,
          totalRedoSteps: state.history.length - 1 - state.index,
        },
        tracks: JSON.parse(JSON.stringify(entry.tracks)),
        appliedAction: entry.desc,
      };
    } catch (err) {
      IOLogger.log('HISTORY', 'TimelineHistoryService:undo', 'ERROR', { projectId }, String(err));
      throw err;
    }
  }

  /**
   * Выполняет повтор действия (Redo) через SQLite
   */
  static async redo(projectId: string): Promise<TimelineHistoryResponse> {
    IOLogger.log('HISTORY', 'TimelineHistoryService:redo', 'START', { projectId });
    try {
      if (isTauri()) {
        const res = await invoke<TimelineHistoryResponse>('redo_timeline_action', { projectId });
        IOLogger.log('HISTORY', 'TimelineHistoryService:redo', 'SUCCESS', {
          action: res.appliedAction,
          canUndo: res.status.canUndo,
          canRedo: res.status.canRedo,
        });
        return res;
      }

      // Web Fallback
      const state = this.fallbackState.get(projectId);
      if (!state || state.index >= state.history.length - 1) {
        throw new Error('Cannot redo: newest state reached');
      }
      state.index += 1;
      const entry = state.history[state.index];
      return {
        success: true,
        status: {
          projectId,
          canUndo: state.index > 0,
          canRedo: state.index < state.history.length - 1,
          undoActionDescription: state.index > 0 ? state.history[state.index].desc : null,
          redoActionDescription: state.index < state.history.length - 1 ? state.history[state.index + 1]?.desc : null,
          totalUndoSteps: state.index,
          totalRedoSteps: state.history.length - 1 - state.index,
        },
        tracks: JSON.parse(JSON.stringify(entry.tracks)),
        appliedAction: entry.desc,
      };
    } catch (err) {
      IOLogger.log('HISTORY', 'TimelineHistoryService:redo', 'ERROR', { projectId }, String(err));
      throw err;
    }
  }

  /**
   * Запрашивает текущий статус стека истории (canUndo, canRedo, описания)
   */
  static async getStatus(projectId: string): Promise<HistoryStatus> {
    if (isTauri()) {
      try {
        return await invoke<HistoryStatus>('get_timeline_history_status', { projectId });
      } catch (err) {
        console.warn('[TimelineHistoryService] getStatus error:', err);
      }
    }

    const state = this.fallbackState.get(projectId);
    if (!state) {
      return {
        projectId,
        canUndo: false,
        canRedo: false,
        totalUndoSteps: 0,
        totalRedoSteps: 0,
      };
    }

    return {
      projectId,
      canUndo: state.index > 0,
      canRedo: state.index < state.history.length - 1,
      undoActionDescription: state.index > 0 ? state.history[state.index].desc : null,
      redoActionDescription: state.index < state.history.length - 1 ? state.history[state.index + 1]?.desc : null,
      totalUndoSteps: state.index,
      totalRedoSteps: state.history.length - 1 - state.index,
    };
  }

  /**
   * Очищает историю проекта в SQLite
   */
  static async clearHistory(projectId: string): Promise<void> {
    if (isTauri()) {
      try {
        await invoke('clear_timeline_history', { projectId });
      } catch (err) {
        console.warn('[TimelineHistoryService] clearHistory error:', err);
      }
    }
    this.fallbackState.delete(projectId);
  }
}
