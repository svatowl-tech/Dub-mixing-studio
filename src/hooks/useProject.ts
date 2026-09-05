import { useState } from 'react';
import { Project } from '../types';
import { logger } from '../lib/logger';
import { getGlobalAudioSettings } from '../lib/utils';
import { DEFAULT_MIXING_PRESETS } from '../lib/defaultPresets';

export const useProject = () => {
  const [project, setProject] = useState<Project | null>(null);
  const [recentProjects, setRecentProjects] = useState<{ name: string; path: string }[]>([]);

  const handleNewProject = async () => {
    if (!window.electronAPI) {
      alert("Эта функция доступна только в десктопном приложении.");
      return;
    }
    logger.info("Initializing new project creation...");
    try {
      const folderRes = await window.electronAPI.openFolder();
      if (folderRes.success && folderRes.data) {
        const folder = folderRes.data;
        logger.info(`Creating new project in folder: ${folder}`);
        await window.electronAPI.initProject(folder);
        const newProject: Project = {
          id: Math.random().toString(36).substr(2, 9),
          name: 'Новый проект',
          projectPath: folder,
          subtitles: [],
          roles: [],
          tracks: [
            { id: 'track-1', name: 'Дорога 1', segments: [], volume: 1, isMuted: false },
            { id: 'track-2', name: 'Дорога 2', segments: [], volume: 1, isMuted: false }
          ],
          latencyOffset: 0,
          audioOffsetMs: 0,
          audioSettings: getGlobalAudioSettings(),
          activePresetId: 'preset-voiceover',
          customPresets: []
        };
        setProject(newProject);
        await window.electronAPI.saveProjectJson({ projectPath: folder, projectData: newProject });
        setRecentProjects(prev => [...prev, { name: newProject.name, path: folder }]);
        logger.info("New project created and saved.");
      }
    } catch (error) {
      logger.error('Failed to create new project:', error);
      alert(`Ошибка при создании проекта: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleOpenProject = async () => {
    if (!window.electronAPI) {
      alert("Эта функция доступна только в десктопном приложении.");
      return;
    }
    logger.info("Opening project...");
    try {
      const fileRes = await window.electronAPI.openFile({
        title: 'Выберите файл проекта',
        filters: [{ name: 'Dub Studio Project', extensions: ['dub'] }]
      });
      if (fileRes.success && fileRes.data) {
        const filePath = fileRes.data.path;
        logger.info(`Selected project file: ${filePath}`);
        const projectDataRes = await window.electronAPI.loadProjectJson(filePath);
        if (projectDataRes.success && projectDataRes.data) {
          const projectData = projectDataRes.data;
          logger.info(`Project loaded: ${projectData.name}`);
          
          // Ensure presets fields exist
          const upgradedProject: Project = {
            ...projectData,
            activePresetId: projectData.activePresetId || 'preset-voiceover',
            customPresets: projectData.customPresets || []
          };
          
          setProject(upgradedProject);
          setRecentProjects(prev => [...prev, { name: upgradedProject.name, path: upgradedProject.projectPath || filePath }]);
        } else {
          logger.warn("Project file load failed.");
          alert("Не удалось загрузить проект.");
        }
      }
    } catch (error) {
      logger.error('Failed to open project:', error);
      alert(`Ошибка при открытии проекта: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleSaveProject = async () => {
    if (!project || !project.projectPath) {
      alert("Проект не сохранен на диске. Используйте 'Создать проект'.");
      return;
    }
    if (window.electronAPI) {
      logger.info(`Saving project: ${project.name} to ${project.projectPath}`);
      try {
        await window.electronAPI.saveProjectJson({ projectPath: project.projectPath, projectData: project });
        alert("Проект сохранен!");
        logger.info("Project save successful.");
      } catch (error) {
        logger.error('Failed to save project:', error);
        alert(`Ошибка при сохранении проекта: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const onLoadProject = async (path: string) => {
    if (window.electronAPI) {
      logger.info(`Loading project from fixed path: ${path}`);
      const projectDataRes = await window.electronAPI.loadProjectJson(path);
      if (projectDataRes.success && projectDataRes.data) {
        const projectData = projectDataRes.data;
        logger.info(`Project loaded: ${projectData.name}`);
        
        // Ensure presets fields exist
        const upgradedProject: Project = {
          ...projectData,
          activePresetId: projectData.activePresetId || 'preset-voiceover',
          customPresets: projectData.customPresets || []
        };
        
        setProject(upgradedProject);
      }
    }
  };

  return {
    project,
    setProject,
    recentProjects,
    handleNewProject,
    handleOpenProject,
    handleSaveProject,
    onLoadProject
  };
};
