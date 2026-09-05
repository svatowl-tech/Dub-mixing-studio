import React, { createContext, useContext } from 'react';
import { Project } from '../types';

export interface ProjectContextType {
  project: Project | null;
  setProject: React.Dispatch<React.SetStateAction<Project | null>>;
  recentProjects: { name: string; path: string }[];
  handleNewProject: () => Promise<void>;
  handleOpenProject: (path?: string) => Promise<void>;
  handleSaveProject: () => Promise<void>;
  onLoadProject: (projectData: Project, projectPath?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const ProjectContext = createContext<ProjectContextType | null>(null);

export const ProjectProvider: React.FC<{
  value: ProjectContextType;
  children: React.ReactNode;
}> = ({ value, children }) => {
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

export const useProjectData = () => {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjectData must be used within ProjectProvider");
  return ctx;
};
