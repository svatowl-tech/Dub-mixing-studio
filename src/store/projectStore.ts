import { create } from 'zustand';
import { Project, ProjectSummary } from '../types';
import {
  projectRepositoryService,
  convertProjectToFullPayload,
  convertFullPayloadToProject,
} from '../services/projectRepositoryService';
import { getGlobalAudioSettings } from '../lib/utils';
import { logger } from '../lib/logger';

interface ProjectState {
  project: Project | null;
  isSaving: boolean;
  isLoading: boolean;
  canUndo: boolean;
  canRedo: boolean;
  lastSavedAt: string | null;
  errorMessage: string | null;
  recentProjects: ProjectSummary[];

  // Actions
  setProject: (
    project: Project | null | ((prev: Project | null) => Project | null)
  ) => void;
  saveProject: (actionName?: string) => Promise<boolean>;
  loadProject: (projectId: string) => Promise<boolean>;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  fetchRecentProjects: () => Promise<void>;
  createNewProject: (name?: string, folderPath?: string) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<boolean>;
  clearError: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  isSaving: false,
  isLoading: false,
  canUndo: false,
  canRedo: false,
  lastSavedAt: null,
  errorMessage: null,
  recentProjects: [],

  setProject: (updater) => {
    set((state) => ({
      project: typeof updater === 'function' ? updater(state.project) : updater,
    }));
  },

  clearError: () => {
    set({ errorMessage: null });
  },

  /**
   * Атомарное сохранение текущего проекта в SQLite
   */
  saveProject: async (actionName: string = 'Update Project') => {
    const { project } = get();
    if (!project) {
      logger.warn('[ProjectStore] No active project to save');
      return false;
    }

    set({ isSaving: true, errorMessage: null });
    try {
      const payload = convertProjectToFullPayload(project);
      const result = await projectRepositoryService.saveProjectAtomic(payload, actionName);

      set({
        isSaving: false,
        lastSavedAt: result.updatedAt,
        canUndo: result.canUndo,
        canRedo: result.canRedo,
      });

      // Обновляем список последних проектов
      get().fetchRecentProjects();
      return true;
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ProjectStore] Save project failed:', err);
      set({ isSaving: false, errorMessage: `Failed to save project: ${msg}` });
      return false;
    }
  },

  /**
   * Загрузка проекта по ID напрямую из SQLite
   */
  loadProject: async (projectId: string) => {
    set({ isLoading: true, errorMessage: null });
    try {
      const payload = await projectRepositoryService.loadProjectById(projectId);
      const project = convertFullPayloadToProject(payload);

      set({
        project,
        isLoading: false,
        canUndo: false,
        canRedo: false,
        lastSavedAt: payload.updatedAt,
      });

      logger.info(`[ProjectStore] Project loaded: ${project.name} (${project.id})`);
      return true;
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[ProjectStore] Load project ${projectId} failed:`, err);
      set({ isLoading: false, errorMessage: `Failed to load project: ${msg}` });
      return false;
    }
  },

  /**
   * Транзакционный откат (Undo) из SQLite снапшотов
   */
  undo: async () => {
    const { project } = get();
    if (!project) return false;

    set({ isLoading: true, errorMessage: null });
    try {
      const restoredPayload = await projectRepositoryService.undoProjectAction(project.id);
      const restoredProject = convertFullPayloadToProject(restoredPayload);

      set({
        project: restoredProject,
        isLoading: false,
        canUndo: true,
        canRedo: true,
      });

      logger.info(`[ProjectStore] Undo successful for ${project.id}`);
      return true;
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[ProjectStore] Undo action failed:', err);
      set({ isLoading: false, canUndo: false });
      return false;
    }
  },

  /**
   * Транзакционный повтор (Redo) из SQLite снапшотов
   */
  redo: async () => {
    const { project } = get();
    if (!project) return false;

    set({ isLoading: true, errorMessage: null });
    try {
      const restoredPayload = await projectRepositoryService.redoProjectAction(project.id);
      const restoredProject = convertFullPayloadToProject(restoredPayload);

      set({
        project: restoredProject,
        isLoading: false,
        canUndo: true,
        canRedo: true,
      });

      logger.info(`[ProjectStore] Redo successful for ${project.id}`);
      return true;
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[ProjectStore] Redo action failed:', err);
      set({ isLoading: false, canRedo: false });
      return false;
    }
  },

  /**
   * Получение списка всех проектов из SQLite
   */
  fetchRecentProjects: async () => {
    try {
      const list = await projectRepositoryService.listAllProjects();
      set({ recentProjects: list });
    } catch (err) {
      logger.error('[ProjectStore] Failed to fetch recent projects:', err);
    }
  },

  /**
   * Создание нового проекта и атомарное сохранение в SQLite
   */
  createNewProject: async (name: string = 'Новый проект', folderPath?: string) => {
    const newId = `proj_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newProject: Project = {
      id: newId,
      name,
      projectPath: folderPath || '',
      subtitles: [],
      roles: [],
      tracks: [
        { id: `track_1_${newId}`, name: 'Дорожка 1 (Дубляж)', type: 'dub', segments: [], volume: 1.0, isMuted: false },
        { id: `track_2_${newId}`, name: 'Дорожка 2 (Оригинал)', type: 'original', segments: [], volume: 1.0, isMuted: false },
      ],
      latencyOffset: 0,
      audioOffsetMs: 0,
      audioSettings: getGlobalAudioSettings(),
      activePresetId: 'preset-voiceover',
      customPresets: [],
    };

    set({ project: newProject, errorMessage: null });

    // Сохраняем начальное состояние атомарно в базу данных
    try {
      const payload = convertProjectToFullPayload(newProject);
      await projectRepositoryService.saveProjectAtomic(payload, 'Create Project');
      await get().fetchRecentProjects();
    } catch (err) {
      logger.error('[ProjectStore] Error saving initial project state to SQLite:', err);
    }

    return newProject;
  },

  /**
   * Удаление проекта из SQLite
   */
  deleteProject: async (projectId: string) => {
    try {
      await projectRepositoryService.deleteProject(projectId);
      const { project } = get();
      if (project && project.id === projectId) {
        set({ project: null });
      }
      await get().fetchRecentProjects();
      return true;
    } catch (err) {
      logger.error(`[ProjectStore] Failed to delete project ${projectId}:`, err);
      return false;
    }
  },
}));
