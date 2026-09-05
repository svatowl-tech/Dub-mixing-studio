import React, { useRef, useState } from 'react';
import Sidebar from '../Sidebar';
import { useProjectData } from '../../contexts/ProjectContext';
import { useTimelineData } from '../../contexts/TimelineContext';

export const LeftSidebar: React.FC = () => {
  const { project, setProject } = useProjectData();
  const { currentTime, handleSeek, togglePlay, isPlaying, sidebarWidth, setSidebarWidth, referenceAudioRef } = useTimelineData();
  
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarScrollTop, setSidebarScrollTop] = useState(0);

  return (
    <Sidebar 
      project={project}
      selectedRole={project?.selectedRole || ''}
      onRoleChange={(role) => project && setProject({ ...project, selectedRole: role })}
      currentTime={currentTime}
      onSeek={handleSeek}
      onTogglePlay={togglePlay}
      isPlaying={isPlaying}
      sidebarScrollTop={sidebarScrollTop}
      onScroll={setSidebarScrollTop}
      sidebarRef={sidebarRef}
      width={sidebarWidth}
      onUpdateProject={(updates) => project && setProject({ ...project, ...updates })}
      onResize={(w) => {
        const newWidth = Math.max(200, Math.min(w, 600));
        setSidebarWidth(newWidth);
      }}
      referenceAudioRef={referenceAudioRef as React.RefObject<HTMLAudioElement>}
    />
  );
};

export default LeftSidebar;
