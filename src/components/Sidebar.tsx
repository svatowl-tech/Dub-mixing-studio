import React from 'react';
import { Project } from '../types';
import { MixingPanel } from './MixingPanel';

interface SidebarProps {
  project: Project | null;
  selectedRole?: string;
  onRoleChange?: (role: string) => void;
  currentTime?: number;
  onSeek?: (time: number) => void;
  onTogglePlay?: () => void;
  isPlaying?: boolean;
  sidebarScrollTop?: number;
  onScroll?: (scrollTop: number) => void;
  sidebarRef?: React.RefObject<HTMLDivElement | null>;
  width?: number;
  onUpdateProject?: (updates: Partial<Project>) => void;
  onResize?: (width: number) => void;
  referenceAudioRef?: React.RefObject<HTMLAudioElement | null>;
}

const Sidebar: React.FC<SidebarProps> = ({
  project,
  width = 320,
  onUpdateProject
}) => {
  return (
    <aside 
      className="flex-shrink-0 border-r border-white/5 flex flex-col bg-zinc-950 min-h-0 overflow-hidden"
      style={{ width: `${width}px` }}
    >
      <MixingPanel 
        project={project} 
        onUpdateProject={onUpdateProject || (() => {})} 
        fullHeight={true}
      />
    </aside>
  );
};

export default Sidebar;
