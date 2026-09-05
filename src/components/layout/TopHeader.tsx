import React from 'react';
import Header from '../Header';
import { useProjectData } from '../../contexts/ProjectContext';
import { safeConfirm } from '../../lib/utils';

// ... interface TopHeaderProps ...
interface TopHeaderProps {
  showProjectMenu: boolean;
  setShowProjectMenu: (v: boolean) => void;
  handleSelectVideo: () => void;
  handleSelectSubs: () => void;
  handleSelectDocument: () => void;
  handleSelectReferenceAudio: () => void;
  handleMergeBackstage: () => void;
  handleToggleBackstage: () => void;
  setShowQuickImport: (v: boolean) => void;
  setShowFixImport: (v: boolean) => void;
  handleBulkImport: () => void;
  handleGameDubbingImport?: () => void;
  isDesktop: boolean;
  handleExport: (options: { 
    format: 'WAV' | 'MP3' | 'FLAC', 
    includeVideo: boolean, 
    includeOriginalAudio: boolean,
    forceMono: boolean 
  }) => void;
  handleBatchExport: () => void;
  handleMuxVideo: () => void;
  handleExportAudioBook: () => void;
  handleExportStems: () => void;
  handleExportAllStemsZip: () => void;
  setIsExporting: (v: boolean) => void;
  setExportOperation: (o: string) => void;
}

export const TopHeader: React.FC<TopHeaderProps> = (props) => {
  const { project, setProject, recentProjects, handleNewProject, handleOpenProject, handleSaveProject, onLoadProject } = useProjectData();

  const handleSelectProjectFolder = async () => {
    if (window.electronAPI && project && project.projectPath) {
      const newFolder = await window.electronAPI.openFolder();
      if (newFolder.success && newFolder.data && newFolder.data !== project.projectPath) {
        const oldPath = project.projectPath;
        const targetPath = newFolder.data;
        
        if (await safeConfirm(`Вы уверены, что хотите переместить все файлы проекта в новую папку?\nИз: ${oldPath}\nВ: ${targetPath}`)) {
          props.setExportOperation("Moving project files...");
          props.setIsExporting(true);
          try {
            const moveRes = await window.electronAPI.moveProject(oldPath, targetPath);
            if (moveRes.success) {
              setProject({ ...project, projectPath: targetPath });
              alert("Проект успешно перемещен!");
            } else {
              alert(`Ошибка при перемещении: ${moveRes.error}`);
            }
          } catch (err) {
            alert("Критическая ошибка при перемещении файлов.");
          } finally {
            props.setIsExporting(false);
            props.setExportOperation('');
          }
        }
      }
    }
  };

  const handleOpenProjectFolder = async () => {
    if (window.electronAPI && project?.projectPath) {
      await window.electronAPI.openPath(project.projectPath);
    }
  };

  const handleSelectBackstageFolder = async () => {
    if (window.electronAPI) {
      const folder = await window.electronAPI.openFolder();
      if (folder && folder.data && project) {
        const settings = project.audioSettings || {};
        setProject({
          ...project,
          audioSettings: { ...settings, backstageFolderPath: folder.data }
        });
      }
    }
  };

  return (
    <Header 
      project={project}
      recentProjects={recentProjects}
      showProjectMenu={props.showProjectMenu}
      setShowProjectMenu={props.setShowProjectMenu}
      handleNewProject={handleNewProject}
      handleOpenProject={handleOpenProject}
      handleSaveProject={handleSaveProject}
      handleSelectProjectFolder={handleSelectProjectFolder}
      handleOpenProjectFolder={handleOpenProjectFolder}
      handleSelectBackstageFolder={handleSelectBackstageFolder}
      handleSelectVideo={props.handleSelectVideo}
      handleSelectSubs={props.handleSelectSubs}
      handleSelectDocument={props.handleSelectDocument}
      handleSelectReferenceAudio={props.handleSelectReferenceAudio}
      handleMergeBackstage={props.handleMergeBackstage}
      handleToggleBackstage={props.handleToggleBackstage}
      setShowQuickImport={props.setShowQuickImport}
      setShowFixImport={props.setShowFixImport}
      handleBulkImport={props.handleBulkImport}
      handleGameDubbingImport={props.handleGameDubbingImport}
      isDesktop={props.isDesktop}
      handleExport={props.handleExport}
      handleBatchExport={props.handleBatchExport}
      handleMuxVideo={props.handleMuxVideo}
      handleExportAudioBook={props.handleExportAudioBook}
      handleExportStems={props.handleExportStems}
      handleExportAllStemsZip={props.handleExportAllStemsZip}
      onLoadProject={onLoadProject}
    />
  );
};

export default TopHeader;
