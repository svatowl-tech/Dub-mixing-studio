import React, { useState } from 'react';
import { 
  FolderOpen, 
  Settings, 
  FileVideo, 
  FileText, 
  Music, 
  Layers, 
  Video as VideoIcon,
  Plus,
  X,
  Bookmark,
  Mic,
  Download,
  Play,
  Keyboard,
  Cpu
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn, formatHotkey, getDefaultKeyMap } from '../lib/utils';
import { Tooltip } from './Tooltip';
import { ImportModal } from './ImportModal';
import HistoryControls from './HistoryControls';
import { useUIState } from '../contexts/UIContext';

interface HeaderProps {
  project: any;
  recentProjects: { name: string; path: string }[];
  showProjectMenu: boolean;
  setShowProjectMenu: (show: boolean) => void;
  handleNewProject: () => void;
  handleOpenProject: () => void;
  handleSaveProject: () => void;
  handleSelectProjectFolder?: () => void;
  handleSelectBackstageFolder?: () => void;
  handleSelectVideo: () => void;
  handleSelectSubs: () => void;
  handleSelectDocument: () => void;
  handleSelectReferenceAudio: () => void;
  handleMergeBackstage: () => void;
  handleToggleBackstage: () => void;
  setShowQuickImport: (show: boolean) => void;
  setShowFixImport?: (show: boolean) => void;
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
  handleExportAudioBook: (gap?: number) => void;
  handleExportStems: () => void;
  handleExportAllStemsZip: () => void;
  handleOpenProjectFolder?: () => void;
  onLoadProject: (path: string) => void;
}

const HotkeyHints = ({ onClose, keyMap }: { onClose: () => void, keyMap: any }) => {
  const currentKeyMap = keyMap || getDefaultKeyMap();
  
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex justify-center items-start sm:items-center overflow-y-auto p-4 py-12 scrollbar-hide">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl max-w-xl w-full p-6 my-auto"
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Keyboard className="w-5 h-5 text-indigo-400" />
            Горячие клавиши
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors text-zinc-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {Object.entries(currentKeyMap).map(([id, action]: [string, any]) => (
            <div key={id} className="flex flex-col gap-1 p-3 bg-zinc-800/30 rounded-lg border border-white/5">
              <div className="text-indigo-300 font-mono text-xs font-bold bg-indigo-500/10 self-start px-2 py-0.5 rounded">
                {formatHotkey(action)}
              </div>
              <div className="text-xs text-zinc-300">
                {action.label}
              </div>
            </div>
          ))}
          {/* Add explicit mention for special keys that aren't in the map but are hardcoded */}
          <div className="flex flex-col gap-1 p-3 bg-zinc-800/30 rounded-lg border border-white/5">
            <div className="text-indigo-300 font-mono text-xs font-bold bg-indigo-500/10 self-start px-2 py-0.5 rounded">
              Delete / Backspace
            </div>
            <div className="text-xs text-zinc-300">
              Удалить выбранные сегменты
            </div>
          </div>
        </div>
        
        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-sm font-bold transition-all">
            Закрыть
          </button>
        </div>
      </motion.div>
    </div>
  );
};

const Header: React.FC<HeaderProps> = ({
  project,
  recentProjects,
  showProjectMenu,
  setShowProjectMenu,
  handleNewProject,
  handleOpenProject,
  handleSaveProject,
  handleSelectProjectFolder,
  handleSelectBackstageFolder,
  handleSelectVideo,
  handleSelectSubs,
  handleSelectDocument,
  handleSelectReferenceAudio,
  handleMergeBackstage,
  handleToggleBackstage,
  setShowQuickImport,
  setShowFixImport,
  handleBulkImport,
  handleGameDubbingImport,
  isDesktop,
  handleExport,
  handleBatchExport,
  handleMuxVideo,
  handleExportAudioBook,
  handleExportStems,
  handleExportAllStemsZip,
  handleOpenProjectFolder,
  onLoadProject
}) => {
  const { toggleSettings, setActiveModal } = useUIState();
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  const importOptions = [
    { icon: <FileVideo className="w-5 h-5 text-indigo-400" />, title: "Видео", description: "Открыть видеофайл для озвучки", onClick: () => isDesktop && handleSelectVideo() },
    { icon: <FileText className="w-5 h-5 text-purple-400" />, title: "Субтитры", description: "Импортировать (.ass, .srt, .vtt, .fb2, .csv)", onClick: () => isDesktop && handleSelectSubs() },
    { icon: <Music className="w-5 h-5 text-amber-400" />, title: "Аудиореференс", description: "Выбрать референсный аудиофайл", onClick: () => isDesktop && handleSelectReferenceAudio() },
    { icon: <Layers className="w-5 h-5 text-emerald-400" />, title: "Импорт игровой озвучки", description: "Выбрать папку реплик + TXT перевод", onClick: handleGameDubbingImport || (() => {}) },
    { icon: <Layers className="w-5 h-5 text-blue-400" />, title: "Импортировать для сведения", description: "Пакетный импорт видео и дорожек", onClick: () => setActiveModal('batchImport') },
  ];

  return (
    <>
      <header className="h-14 border-b border-white/5 flex items-center justify-between px-6 bg-zinc-900/80 backdrop-blur-md relative z-[100]">
        <div className="flex items-center gap-4 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <Mic className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold tracking-tight hidden sm:inline">Dub Mixing <span className="text-indigo-400">Studio</span></span>
          </div>
          <div className="h-4 w-px bg-white/10" />
          <div className="text-sm text-zinc-400 font-medium truncate max-w-[150px]">{project?.name || 'Нет проекта'}</div>
        </div>

        <div className="flex items-center gap-3 shrink-0 ml-auto">
          <HistoryControls />
          <button 
              onClick={() => setShowImportModal(true)}
              className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs font-bold flex items-center gap-2 transition-all border border-white/5 cursor-pointer"
            >
              <FileVideo className="w-4 h-4 text-indigo-400" />
              Импорт
          </button>

          {project && (
            <div className="relative group">
              <button 
                className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-[10px] font-bold transition-all shadow-lg shadow-indigo-600/20"
              >
                <Download className="w-3.5 h-3.5" /> <span className="hidden md:inline">Экспорт</span>
              </button>
              <div className="absolute right-0 top-full mt-1 w-64 bg-zinc-900 border border-white/10 rounded-lg shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 overflow-hidden divide-y divide-white/5">
                <button 
                  onClick={() => handleExport({ format: 'WAV', includeVideo: false, includeOriginalAudio: true, forceMono: false })} 
                  className="w-full px-4 py-3 text-left hover:bg-white/5 transition-colors flex items-center gap-2.5 text-zinc-100 group cursor-pointer"
                >
                  <Download className="w-4 h-4 text-indigo-400 group-hover:scale-105 transition-transform shrink-0" />
                  <div className="flex flex-col">
                    <span className="text-[11px] font-bold text-white">Весь аудио-микс (WAV)</span>
                    <span className="text-[9px] text-zinc-400 font-normal mt-0.5">Сведение оригинала и всех дорожек дубляжа</span>
                  </div>
                </button>
                <button 
                  onClick={() => handleExport({ format: 'WAV', includeVideo: false, includeOriginalAudio: false, forceMono: false })} 
                  className="w-full px-4 py-3 text-left hover:bg-white/5 transition-colors flex items-center gap-2.5 text-zinc-100 group cursor-pointer"
                >
                  <Music className="w-4 h-4 text-emerald-400 group-hover:scale-105 transition-transform shrink-0" />
                  <div className="flex flex-col">
                    <span className="text-[11px] font-bold text-white">Микс без оригинала (WAV)</span>
                    <span className="text-[9px] text-zinc-400 font-normal mt-0.5">Сведение только дорожек дубляжа (чистый голос)</span>
                  </div>
                </button>
                <button 
                  onClick={() => handleExport({ format: 'WAV', includeVideo: true, includeOriginalAudio: true, forceMono: false })} 
                  className="w-full px-4 py-3 text-left hover:bg-white/5 transition-colors flex items-center gap-2.5 text-zinc-100 group cursor-pointer"
                >
                  <VideoIcon className="w-4 h-4 text-purple-400 group-hover:scale-105 transition-transform shrink-0" />
                  <div className="flex flex-col">
                    <span className="text-[11px] font-bold text-white">Видео-микс с озвучкой (MP4)</span>
                    <span className="text-[9px] text-zinc-400 font-normal mt-0.5">Экспорт финального видео со сведенным звуком</span>
                  </div>
                </button>
              </div>
            </div>
          )}
          
          <div className="relative">
            <button 
              onClick={() => setShowProjectMenu(!showProjectMenu)}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-[10px] font-bold flex items-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
            >
              <Layers className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Проекты</span>
            </button>
            
            <AnimatePresence>
              {showProjectMenu && (
                <>
                  <div className="fixed inset-0 z-[60]" onClick={() => setShowProjectMenu(false)} />
                  <motion.div 
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="absolute top-full right-0 mt-2 w-64 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl z-[70] overflow-hidden"
                  >
                    <div className="p-2 space-y-1">
                      <button 
                        onClick={() => { handleNewProject(); setShowProjectMenu(false); }}
                        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 rounded-lg text-xs font-bold transition-colors"
                      >
                        <Plus className="w-4 h-4 text-emerald-400" />
                        Новый проект
                      </button>
                      <button 
                        onClick={() => { handleOpenProject(); setShowProjectMenu(false); }}
                        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 rounded-lg text-xs font-bold transition-colors"
                      >
                        <FolderOpen className="w-4 h-4 text-indigo-400" />
                        Открыть проект
                      </button>
                      <button 
                        onClick={() => { handleSaveProject(); setShowProjectMenu(false); }}
                        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 rounded-lg text-xs font-bold transition-colors"
                      >
                        <Bookmark className="w-4 h-4 text-amber-400" />
                        Сохранить проект
                      </button>
                    </div>

                    {project && (handleSelectProjectFolder || handleOpenProjectFolder) && (
                      <div className="border-t border-white/5 p-2 space-y-1">
                        <div className="px-3 py-1 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Папки</div>
                        {handleOpenProjectFolder && (
                          <button 
                            onClick={() => { handleOpenProjectFolder(); setShowProjectMenu(false); }}
                            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 rounded-lg text-xs font-bold transition-colors"
                          >
                            <FolderOpen className="w-4 h-4 text-indigo-400" />
                            Открыть папку проекта
                          </button>
                        )}
                        {handleSelectProjectFolder && (
                          <button 
                            onClick={() => { handleSelectProjectFolder(); setShowProjectMenu(false); }}
                            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 rounded-lg text-xs font-bold transition-colors"
                            title={project?.projectPath || 'Выбрать...'}
                          >
                            <Plus className="w-4 h-4 text-zinc-400" />
                            Сменить / Переместить проект
                          </button>
                        )}
                      </div>
                    )}
                    
                    {recentProjects.length > 0 && (
                      <div className="border-t border-white/5 p-2">
                        <div className="px-3 py-2 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Недавние</div>
                        <div className="space-y-1 max-h-48 overflow-y-auto custom-scrollbar">
                          {recentProjects.map((proj, i) => (
                            <button 
                              key={i}
                              onClick={() => {
                                onLoadProject(proj.path);
                                setShowProjectMenu(false);
                              }}
                              className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/5 rounded-lg text-xs transition-colors group"
                            >
                              <span className="truncate flex-1 text-left">{proj.name}</span>
                              <Play className="w-3 h-3 text-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          <div className="h-6 w-px bg-white/10 mx-2" />

          <button 
            onClick={() => setShowHotkeys(true)}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors text-zinc-400 hover:text-white"
            title="Горячие клавиши"
          >
            <Keyboard className="w-5 h-5" />
          </button>
          <button 
            onClick={toggleSettings}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors text-zinc-400 hover:text-white"
            title="Настройки проекта"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      <AnimatePresence>
        {showHotkeys && <HotkeyHints onClose={() => setShowHotkeys(false)} keyMap={project?.audioSettings?.keyMap} />}
        {showImportModal && <ImportModal onClose={() => setShowImportModal(false)} options={importOptions} />}
      </AnimatePresence>
    </>
  );
};

export default Header;
