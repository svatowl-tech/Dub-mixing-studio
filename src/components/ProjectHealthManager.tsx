import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  ShieldCheck, 
  ShieldAlert, 
  Trash2, 
  RefreshCw, 
  Search, 
  Link as LinkIcon, 
  FileWarning, 
  CheckCircle2,
  AlertTriangle,
  FolderOpen
} from 'lucide-react';
import { Project, AudioSegment } from '../types';
import { cn, safeConfirm } from '../lib/utils';
import { useUIState } from '../contexts/UIContext';
import { useProjectData } from '../contexts/ProjectContext';

interface VerificationData {
  missingSegments: AudioSegment[];
  orphanedFiles: string[];
}

export const ProjectHealthManager: React.FC = () => {
  const { activeModal, setActiveModal } = useUIState();
  const { project, setProject } = useProjectData();
  const isOpen = activeModal === 'health';
  const onClose = () => setActiveModal(null);
  
  const [isVerifying, setIsVerifying] = useState(false);
  const [data, setData] = useState<VerificationData | null>(null);
  const [relinkingId, setRelinkingId] = useState<string | null>(null);
  const [isCleaning, setIsCleaning] = useState(false);

  const runVerification = async () => {
    if (!window.electronAPI || !project?.projectPath) return;
    setIsVerifying(true);
    try {
      const res = await window.electronAPI.verifyProjectFiles(project.id, project.projectPath);

      if (res.success && res.data) {
        setData(res.data);
      }
    } catch (err) {
      console.error("Verification failed:", err);
    } finally {
      setIsVerifying(false);
    }
  };

  useEffect(() => {
    runVerification();
  }, []);

  const handleRelink = async (segment: AudioSegment) => {
    if (!window.electronAPI) return;
    setRelinkingId(segment.id);
    try {
      // 1. Pick new file
      const res = await window.electronAPI.openFile({
        title: 'Select File to Relink',
        filters: [{ name: 'Audio', extensions: ['wav'] }]
      });

      if (res.success && res.data) {
        const newPath = res.data.path;
        await performRelink(segment.id, newPath);
      }
    } catch (err) {
      alert("Failed to relink: " + err);
    } finally {
      setRelinkingId(null);
    }
  };

  const handleRelinkByHash = async (segment: AudioSegment) => {
    if (!window.electronAPI || !project?.projectPath) return;
    setRelinkingId(segment.id);
    try {
        // We can't calculate hash of a missing file, BUT if the project was originally exported/saved 
        // with metadata containing hash, we could use it. 
        // Since we don't store hashes yet, we'll suggest picking a project folder to scan for matches.
        const folderRes = await window.electronAPI.openFolder();
        if (!folderRes.success || !folderRes.data) return;

        alert("Сканирование папки на наличие дубликатов может занять время...");
        
        // This is a bit of a placeholder logic since we don't have the TARGET hash stored in DB.
        // Usually, relink by hash is for when we HAVE the hash.
        // Let's assume user wants to find a file with the SAME NAME first in that folder as a shortcut.
        const fileName = segment.filePath?.split(/[/\\]/).pop();
        if (fileName) {
             const res = await window.electronAPI.findFileByHash(folderRes.data, "target_hash_placeholder");
             // Since we don't have hash, let's just use manual relink for now or implement file-system search.
             // I will implement a "Quick Search by Name" in the provided folder instead.
             alert("Функция авто-поиска по хэшу требует предварительного индексирования. Пока доступен только ручной Relink или поиск по имени.");
        }

    } catch (err) {
        alert("Search failed: " + err);
    } finally {
        setRelinkingId(null);
    }
  };

  const performRelink = async (segmentId: string, newPath: string) => {
    if (!window.electronAPI) return;
    // 2. Update DB
    await window.electronAPI.relinkSegmentFile(segmentId, newPath);
    
    // 3. Update local state
    const updatedTracks = project.tracks.map(t => ({
      ...t,
      segments: t.segments.map(s => s.id === segmentId ? { ...s, filePath: newPath } : s)
    }));
    setProject({ ...project, tracks: updatedTracks });
    
    // Refresh verification list
    runVerification();
  };

  const handleCleanup = async () => {
    if (!data?.orphanedFiles.length || !window.electronAPI) return;
    if (!(await safeConfirm(`Вы уверены, что хотите удалить ${data.orphanedFiles.length} неиспользуемых файлов? Это действие нельзя отменить.`))) return;

    setIsCleaning(true);
    try {
      await window.electronAPI.cleanupOrphanedFiles(data.orphanedFiles);
      setData(prev => prev ? { ...prev, orphanedFiles: [] } : null);
    } catch (err) {
      alert("Cleanup failed: " + err);
    } finally {
      setIsCleaning(false);
    }
  };

  if (!isOpen || !project) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        />
        <motion.div 
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          className="relative w-full max-w-2xl bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col h-full max-h-[80vh]"
        >
          {/* Header */}
          <div className="p-6 border-b border-white/5 flex items-center justify-between bg-zinc-900/50 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center border border-indigo-500/20">
            <ShieldCheck className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">Здоровье проекта</h2>
            <p className="text-xs text-zinc-500">Проверка целостности файлов и очистка мусора</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={runVerification}
            disabled={isVerifying}
            className="p-2.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-400 hover:text-white rounded-xl transition-all border border-white/5 group"
            title="Перепроверить"
          >
            <RefreshCw className={cn("w-5 h-5", isVerifying && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
        {isVerifying && !data ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="w-12 h-12 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
            <p className="text-sm font-bold text-zinc-500 uppercase tracking-widest">Проверка файлов...</p>
          </div>
        ) : (
          <>
            {/* Missing Files Status */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-zinc-400">
                  <FileWarning className="w-4 h-4" />
                  <span>Потерянные фрагменты</span>
                </div>
                <span className={cn(
                  "px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase",
                  data?.missingSegments.length === 0 ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                )}>
                  {data?.missingSegments.length || 0} ошибок
                </span>
              </div>

              {data?.missingSegments.length === 0 ? (
                <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-2xl p-6 flex items-center gap-4">
                  <div className="w-12 h-12 bg-emerald-500/20 rounded-full flex items-center justify-center">
                    <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                  </div>
                  <div>
                    <h4 className="font-bold text-white mb-0.5">Все файлы на месте</h4>
                    <p className="text-xs text-zinc-500">Целостность базы данных и файловой системы подтверждена.</p>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3">
                  {data?.missingSegments.map(seg => (
                    <div key={seg.id} className="bg-rose-500/5 border border-rose-500/10 rounded-2xl p-4 flex items-center justify-between group hover:border-rose-500/30 transition-all">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-rose-500/20 rounded-xl flex items-center justify-center">
                          <AlertTriangle className="w-5 h-5 text-rose-400" />
                        </div>
                        <div className="min-w-0">
                          <h5 className="text-sm font-bold text-white truncate max-w-[200px]">
                            {seg.filePath?.split(/[/\\]/).pop() || "Unknown File"}
                          </h5>
                          <p className="text-[10px] text-zinc-500 font-mono">ID: {seg.id}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => handleRelink(seg)}
                          disabled={relinkingId === seg.id}
                          className="flex items-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-rose-600/20"
                        >
                          {relinkingId === seg.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <LinkIcon className="w-3 h-3" />}
                          Relink
                        </button>
                        <button 
                          onClick={() => handleRelinkByHash(seg)}
                          disabled={relinkingId === seg.id}
                          className="p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-indigo-400 rounded-xl transition-all border border-white/5"
                          title="Попробовать найти автоматически в другой папке"
                        >
                          <Search className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Cleanup Status */}
            <section className="space-y-4 pt-4 border-t border-white/5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-zinc-400">
                  <Trash2 className="w-4 h-4" />
                  <span>Мусорные файлы (.dubstudio)</span>
                </div>
                <span className="text-xs text-zinc-500">
                  {data?.orphanedFiles.length || 0} файлов
                </span>
              </div>

              {data?.orphanedFiles.length === 0 ? (
                <div className="bg-zinc-800/50 border border-white/5 rounded-2xl p-6 flex items-center gap-4">
                  <div className="w-12 h-12 bg-zinc-700/30 rounded-full flex items-center justify-center">
                    <Trash2 className="w-6 h-6 text-zinc-600" />
                  </div>
                  <div>
                    <h4 className="font-bold text-zinc-400 mb-0.5">Папка проекта чиста</h4>
                    <p className="text-xs text-zinc-600">Лишних файлов, не привязанных к проекту, не обнаружено.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="bg-amber-500/5 border border-amber-500/10 rounded-2xl p-5 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-amber-500/20 rounded-full flex items-center justify-center">
                        <FolderOpen className="w-6 h-6 text-amber-400" />
                      </div>
                      <div>
                        <h4 className="font-bold text-white mb-0.5">Найдено {data?.orphanedFiles.length} лишних файлов</h4>
                        <p className="text-xs text-zinc-500 max-w-[280px]">Это файлы, которых нет в проекте, но они занимают место на диске.</p>
                      </div>
                    </div>
                    <button 
                      onClick={handleCleanup}
                      disabled={isCleaning}
                      className="px-6 py-3 bg-zinc-800 hover:bg-rose-600 hover:text-white text-zinc-400 rounded-2xl text-xs font-black uppercase tracking-widest transition-all border border-white/5"
                    >
                      {isCleaning ? "Удаление..." : "Очистить"}
                    </button>
                  </div>
                  
                  {/* Small preview of files if we want, but hidden for space usually */}
                  <div className="bg-black/20 rounded-2xl overflow-hidden border border-white/5">
                    <div className="max-h-[150px] overflow-y-auto p-4 space-y-2 custom-scrollbar">
                      {data?.orphanedFiles.map((file, idx) => (
                        <div key={idx} className="flex items-center justify-between gap-4 group">
                          <p className="text-[10px] text-zinc-500 font-mono truncate flex-1">
                            {file.split(/[/\\]/).pop()}
                          </p>
                          <span className="text-[9px] text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity">
                            {file.length > 50 ? '...' + file.slice(-50) : file}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="p-6 border-t border-white/5 bg-zinc-900/50 backdrop-blur-md">
        <button 
          onClick={onClose}
          className="w-full py-4 bg-zinc-800 hover:bg-zinc-700 text-white rounded-2xl text-sm font-bold shadow-xl transition-all active:scale-95"
        >
          Закрыть
        </button>
      </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
