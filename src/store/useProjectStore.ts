import { create } from 'zustand';
import { Project } from '../types';

interface ProjectState {
  project: Project | null;
  history: Project[];
  historyIndex: number;
  
  setProject: (projectOrUpdater: Project | null | ((prev: Project | null) => Project | null)) => void;
  saveSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  clearHistory: () => void;
}

const MAX_HISTORY_STEPS = 50;

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  history: [],
  historyIndex: -1,

  setProject: (projectOrUpdater) => {
    set((state) => {
      const nextProject = typeof projectOrUpdater === 'function' ? projectOrUpdater(state.project) : projectOrUpdater;
      return { project: nextProject };
    });
  },

  saveSnapshot: () => {
    set((state) => {
      if (!state.project) return state;
      // Truncate history if we were in the middle of an undo chain
      const currentHistory = state.history.slice(0, state.historyIndex + 1);
      
      const newHistory = [...currentHistory, state.project];
      if (newHistory.length > MAX_HISTORY_STEPS) {
        newHistory.shift();
      }
      
      return {
        history: newHistory,
        historyIndex: newHistory.length - 1
      };
    });
  },

  undo: () => {
    set((state) => {
      if (state.historyIndex >= 0) {
        const prevProject = state.history[state.historyIndex];
        return {
          project: prevProject,
          historyIndex: state.historyIndex - 1
        };
      }
      return state;
    });
  },

  redo: () => {
    set((state) => {
      if (state.historyIndex < state.history.length - 2) {
        const nextIndex = state.historyIndex + 2;
        const nextProject = state.history[nextIndex - 1]; // wait, index logic
        return {
          project: nextProject,
          historyIndex: nextIndex - 1
        };
      }
      // If we are at the last available step before current state
      if (state.historyIndex === state.history.length - 2) {
         return {
            project: state.history[state.historyIndex + 1],
            historyIndex: state.historyIndex + 1
         };
      }
      return state;
    });
  },

  clearHistory: () => set({ history: [], historyIndex: -1 })
}));
