import { invoke } from '@tauri-apps/api/core';
import {
  Project,
  AudioTrack,
  AudioSegment,
  SubtitleLine,
  FullProjectPayload,
  TrackPayload,
  AudioClipPayload,
  SubtitlePayload,
  ProjectSaveResult,
  ProjectSummary,
} from '../types';
import { isTauriAvailable } from '../lib/utils';
import { logger } from '../lib/logger';

/**
 * Конвертер: Преобразует модель Project (React state) в FullProjectPayload (SQLite транзакционный DTO)
 */
export function convertProjectToFullPayload(project: Project): FullProjectPayload {
  const tracksPayload: TrackPayload[] = (project.tracks || []).map((t, idx) => {
    const clipsPayload: AudioClipPayload[] = (t.segments || []).map((s) => ({
      id: s.id || `seg_${Math.random().toString(36).substring(2, 9)}`,
      filePath: s.filePath || '',
      startTimeMs: (s.startTime ?? 0) * 1000.0,
      durationMs: (s.duration ?? 0) * 1000.0,
      sourceOffsetMs: (s.fileOffset ?? 0) * 1000.0,
      gainDb: s.gain !== undefined ? 20 * Math.log10(Math.max(0.0001, s.gain)) : 0.0,
      isActive: true,
      backstageVideoPath: s.backstageVideoPath || null,
    }));

    return {
      id: t.id,
      name: t.name,
      trackType: t.type || 'Dub',
      volume: t.volume ?? 1.0,
      pan: 0.0,
      isMuted: !!t.isMuted,
      isSolo: !!t.isSolo,
      orderIndex: idx,
      clips: clipsPayload,
      rackPreset: null,
    };
  });

  const subtitlesPayload: SubtitlePayload[] = (project.subtitles || []).map((sub) => ({
    id: sub.id,
    characterName: sub.role || 'Narrator',
    text: sub.text || '',
    startTimeMs: (sub.start ?? 0) * 1000.0,
    endTimeMs: (sub.end ?? 0) * 1000.0,
    matchedClipId: null,
  }));

  // Сохраняем остальные настройки в metadata
  const metadata: Record<string, any> = {
    videoUrl: project.videoUrl,
    videoPath: project.videoPath,
    referenceAudioPath: project.referenceAudioPath,
    documentPath: project.documentPath,
    documentContent: project.documentContent,
    projectPath: project.projectPath,
    roles: project.roles || [],
    selectedRole: project.selectedRole,
    markers: project.markers || [],
    latencyOffset: project.latencyOffset ?? 0,
    audioSettings: project.audioSettings,
    duration: project.duration,
    fixes: project.fixes || [],
    uiState: project.uiState || {},
    originalTrackSettings: project.originalTrackSettings,
    masterVolume: project.masterVolume,
    vocalBusVolume: project.vocalBusVolume,
    vocalBusMuted: project.vocalBusMuted,
    vocalBusSolo: project.vocalBusSolo,
    activePresetId: project.activePresetId,
    customPresets: project.customPresets || [],
    mixingType: project.mixingType,
  };

  return {
    id: project.id,
    name: project.name,
    sampleRate: project.audioSettings?.sampleRate || 48000,
    frameRate: 24.0,
    targetLufs: -14.0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    audioOffsetMs: project.audioOffsetMs ?? 0,
    metadata,
    tracks: tracksPayload,
    subtitles: subtitlesPayload,
  };
}

/**
 * Конвертер: Преобразует FullProjectPayload (SQLite DTO) обратно в модель Project (React state)
 */
export function convertFullPayloadToProject(payload: FullProjectPayload): Project {
  const tracks: AudioTrack[] = (payload.tracks || []).map((t) => {
    const segments: AudioSegment[] = (t.clips || []).map((c) => {
      // Преобразуем gainDb обратно в linear multiplier
      const gainLinear = Math.pow(10, (c.gainDb ?? 0.0) / 20);
      return {
        id: c.id,
        blobUrl: '',
        playbackRate: 1.0,
        startTime: (c.startTimeMs ?? 0) / 1000.0,
        duration: (c.durationMs ?? 0) / 1000.0,
        fileOffset: (c.sourceOffsetMs ?? 0) / 1000.0,
        fileDuration: (c.durationMs ?? 0) / 1000.0,
        filePath: c.filePath,
        backstageVideoPath: c.backstageVideoPath || undefined,
        gain: gainLinear,
      };
    });

    return {
      id: t.id,
      name: t.name,
      type: (t.trackType as any) || 'dub',
      segments,
      volume: t.volume ?? 1.0,
      isMuted: !!t.isMuted,
      isSolo: !!t.isSolo,
    };
  });

  const subtitles: SubtitleLine[] = (payload.subtitles || []).map((s) => ({
    id: s.id,
    start: (s.startTimeMs ?? 0) / 1000.0,
    end: (s.endTimeMs ?? 0) / 1000.0,
    text: s.text,
    role: s.characterName,
  }));

  const meta = payload.metadata || {};

  return {
    id: payload.id,
    name: payload.name,
    videoUrl: meta.videoUrl,
    videoPath: meta.videoPath,
    referenceAudioPath: meta.referenceAudioPath,
    documentPath: meta.documentPath,
    documentContent: meta.documentContent,
    projectPath: meta.projectPath,
    originalPeaks: meta.originalPeaks,
    subtitles,
    roles: meta.roles || [],
    selectedRole: meta.selectedRole,
    tracks,
    markers: meta.markers || [],
    latencyOffset: meta.latencyOffset ?? 0,
    audioOffsetMs: payload.audioOffsetMs ?? 0,
    audioSettings: meta.audioSettings || {
      sampleRate: payload.sampleRate || 48000,
      bitDepth: 24,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    duration: meta.duration,
    fixes: meta.fixes || [],
    uiState: meta.uiState || {},
    originalTrackSettings: meta.originalTrackSettings,
    masterVolume: meta.masterVolume ?? 1.0,
    vocalBusVolume: meta.vocalBusVolume ?? 1.0,
    vocalBusMuted: meta.vocalBusMuted ?? false,
    vocalBusSolo: meta.vocalBusSolo ?? false,
    activePresetId: meta.activePresetId || 'preset-voiceover',
    customPresets: meta.customPresets || [],
    mixingType: meta.mixingType || 'dubbing',
  };
}

class ProjectRepositoryService {
  // Локальный fallback-кэш на случай работы в браузере
  private memoryProjects: Map<string, FullProjectPayload> = new Map();
  private memoryHistory: Map<string, FullProjectPayload[]> = new Map();
  private memoryHistoryIndex: Map<string, number> = new Map();

  /**
   * Атомарное транзакционное сохранение проекта в SQLite
   */
  async saveProjectAtomic(
    projectPayload: FullProjectPayload,
    actionName: string = 'Save Project'
  ): Promise<ProjectSaveResult> {
    logger.info(`[ProjectRepository] Saving project '${projectPayload.name}' (${projectPayload.id}) atomically...`);

    if (!isTauriAvailable()) {
      // In-memory fallback
      const copy = JSON.parse(JSON.stringify(projectPayload));
      this.memoryProjects.set(projectPayload.id, copy);
      
      const history = this.memoryHistory.get(projectPayload.id) || [];
      const curIdx = this.memoryHistoryIndex.get(projectPayload.id) ?? -1;
      
      const nextHistory = history.slice(0, curIdx + 1);
      nextHistory.push(copy);
      this.memoryHistory.set(projectPayload.id, nextHistory);
      this.memoryHistoryIndex.set(projectPayload.id, nextHistory.length - 1);

      return {
        projectId: projectPayload.id,
        updatedAt: new Date().toISOString(),
        canUndo: nextHistory.length > 1,
        canRedo: false,
        snapshotSequence: nextHistory.length,
      };
    }

    try {
      const result = await invoke<ProjectSaveResult>('save_project_atomic', {
        project: projectPayload,
        actionName,
      });
      logger.info(`[ProjectRepository] Saved project ${result.projectId}. Seq: ${result.snapshotSequence}`);
      return result;
    } catch (err) {
      logger.error(`[ProjectRepository] Error in save_project_atomic:`, err);
      throw err;
    }
  }

  /**
   * Загрузка проекта по ID из SQLite
   */
  async loadProjectById(projectId: string): Promise<FullProjectPayload> {
    logger.info(`[ProjectRepository] Loading project by ID: ${projectId}`);

    if (!isTauriAvailable()) {
      const p = this.memoryProjects.get(projectId);
      if (!p) throw new Error(`Project ${projectId} not found in memory`);
      return p;
    }

    try {
      const payload = await invoke<FullProjectPayload>('load_project_by_id', {
        projectId,
      });
      return payload;
    } catch (err) {
      logger.error(`[ProjectRepository] Error loading project ${projectId}:`, err);
      throw err;
    }
  }

  /**
   * Откат действия (Undo) через дельта-снапшоты истории SQLite
   */
  async undoProjectAction(projectId: string): Promise<FullProjectPayload> {
    logger.info(`[ProjectRepository] Requesting undo for project: ${projectId}`);

    if (!isTauriAvailable()) {
      const history = this.memoryHistory.get(projectId) || [];
      const curIdx = this.memoryHistoryIndex.get(projectId) ?? 0;
      if (curIdx > 0) {
        const nextIdx = curIdx - 1;
        this.memoryHistoryIndex.set(projectId, nextIdx);
        const restored = JSON.parse(JSON.stringify(history[nextIdx]));
        this.memoryProjects.set(projectId, restored);
        return restored;
      }
      throw new Error('Cannot undo: earliest state reached');
    }

    try {
      const payload = await invoke<FullProjectPayload>('undo_project_action', {
        projectId,
      });
      return payload;
    } catch (err) {
      logger.error(`[ProjectRepository] Error in undo_project_action:`, err);
      throw err;
    }
  }

  /**
   * Повтор действия (Redo) через дельта-снапшоты истории SQLite
   */
  async redoProjectAction(projectId: string): Promise<FullProjectPayload> {
    logger.info(`[ProjectRepository] Requesting redo for project: ${projectId}`);

    if (!isTauriAvailable()) {
      const history = this.memoryHistory.get(projectId) || [];
      const curIdx = this.memoryHistoryIndex.get(projectId) ?? 0;
      if (curIdx < history.length - 1) {
        const nextIdx = curIdx + 1;
        this.memoryHistoryIndex.set(projectId, nextIdx);
        const restored = JSON.parse(JSON.stringify(history[nextIdx]));
        this.memoryProjects.set(projectId, restored);
        return restored;
      }
      throw new Error('Cannot redo: latest state reached');
    }

    try {
      const payload = await invoke<FullProjectPayload>('redo_project_action', {
        projectId,
      });
      return payload;
    } catch (err) {
      logger.error(`[ProjectRepository] Error in redo_project_action:`, err);
      throw err;
    }
  }

  /**
   * Получение списка всех проектов в локальной базе данных
   */
  async listAllProjects(): Promise<ProjectSummary[]> {
    if (!isTauriAvailable()) {
      const list: ProjectSummary[] = [];
      for (const p of this.memoryProjects.values()) {
        list.push({
          id: p.id,
          name: p.name,
          sampleRate: p.sampleRate,
          frameRate: p.frameRate,
          targetLufs: p.targetLufs,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          trackCount: p.tracks.length,
          clipCount: p.tracks.reduce((acc, t) => acc + t.clips.length, 0),
          subtitleCount: p.subtitles.length,
        });
      }
      return list;
    }

    try {
      return await invoke<ProjectSummary[]>('list_all_projects');
    } catch (err) {
      logger.error(`[ProjectRepository] Error listing projects:`, err);
      return [];
    }
  }

  /**
   * Удаление проекта по ID
   */
  async deleteProject(projectId: string): Promise<void> {
    if (!isTauriAvailable()) {
      this.memoryProjects.delete(projectId);
      this.memoryHistory.delete(projectId);
      this.memoryHistoryIndex.delete(projectId);
      return;
    }

    try {
      await invoke('delete_project', { projectId });
    } catch (err) {
      logger.error(`[ProjectRepository] Error deleting project ${projectId}:`, err);
      throw err;
    }
  }
}

export const projectRepositoryService = new ProjectRepositoryService();
export default projectRepositoryService;
