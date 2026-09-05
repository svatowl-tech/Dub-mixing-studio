import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Activity, FolderOpen, Trash2 } from 'lucide-react';
import { cn, getGlobalAudioSettings } from '../lib/utils';
import AudioDeviceManager from './AudioDeviceManager';
import { HotkeySettings } from './HotkeySettings';
import { useUIState } from '../contexts/UIContext';
import { useProjectData } from '../contexts/ProjectContext';
import { open as rawOpen } from '@tauri-apps/plugin-dialog';

const open = async (options?: any): Promise<any> => {
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) {
    return null;
  }
  return await rawOpen(options);
};

const SettingsModal: React.FC = () => {
  const { activeModal, setActiveModal } = useUIState();
  const { project, setProject } = useProjectData();
  const show = activeModal === 'settings';

  const onClose = () => setActiveModal(null);

  const onProjectUpdate = (updates: any) => {
    if (project) {
      setProject({ ...project, ...updates });
    }
  };

  const onStartCalibration = () => {
    setActiveModal('calibration' as any);
  };

  return (
    <AnimatePresence>
      {show && (
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
            className="relative w-full max-w-lg bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
          >
            <div className="p-6 border-b border-white/5 flex items-center justify-between flex-shrink-0">
              <h2 className="text-xl font-bold">Настройки</h2>
              <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                <Plus className="w-6 h-6 rotate-45" />
              </button>
            </div>

            <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar">
              <section>
                <AudioDeviceManager 
                  settings={project?.audioSettings || getGlobalAudioSettings()}
                  onSettingsChange={(newSettings) => {
                    onProjectUpdate({ audioSettings: newSettings });
                  }}
                />
              </section>
              <section>
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-3 block">Обработка при записи</label>
                <div className="space-y-4 bg-zinc-800/50 p-4 rounded-xl border border-white/5">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-white">Лимитер (защита от перегруза)</div>
                      <div className="text-[10px] text-zinc-500">Срезает пики громкости перед записью на таймлайн</div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        className="sr-only peer"
                        checked={project?.audioSettings?.limiterEnabled ?? false}
                        onChange={(e) => {
                          const settings = project?.audioSettings || {};
                          onProjectUpdate({ audioSettings: { ...settings, limiterEnabled: e.target.checked } });
                        }}
                      />
                      <div className="w-9 h-5 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
                    </label>
                  </div>
                  {project?.audioSettings?.limiterEnabled && (
                    <div className="space-y-2 pt-2 border-t border-white/5">
                      <div className="flex justify-between text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">
                        <span>Порог (Threshold)</span>
                        <span>{project?.audioSettings?.limiterThreshold ?? -9} дБ</span>
                      </div>
                      <input 
                        type="range" 
                        min="-30" 
                        max="0" 
                        step="1"
                        value={project?.audioSettings?.limiterThreshold ?? -9}
                        onChange={(e) => {
                          const settings = project?.audioSettings || {};
                          onProjectUpdate({ audioSettings: { ...settings, limiterThreshold: parseFloat(e.target.value) } });
                        }}
                        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500" 
                      />
                    </div>
                  )}
                </div>
              </section>
              <section>
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-3 block">Компенсация задержки</label>
                <div className="space-y-4">
                  <div className="bg-zinc-800/50 border border-white/5 p-4 rounded-xl">
                    <div className="flex justify-between items-center mb-4">
                      <div>
                        <div className="text-xs font-bold text-white">Системное смещение</div>
                        <div className="text-[10px] text-zinc-500">Компенсирует задержку записи</div>
                      </div>
                      <div className="text-xl font-black text-indigo-400 font-mono">{project?.audioOffsetMs || 0} мс</div>
                    </div>
                    
                    <button 
                      onClick={onStartCalibration}
                      className="w-full py-2 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 rounded-lg text-[10px] font-bold text-indigo-400 flex items-center justify-center gap-2 transition-all"
                    >
                      <Activity className="w-3 h-3" /> Запустить калибровку
                    </button>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">
                      <span>Ручная настройка</span>
                      <span>{project?.audioOffsetMs || 0} мс</span>
                    </div>
                    <input 
                      type="range" 
                      min="-500" 
                      max="500" 
                      step="1"
                      value={project?.audioOffsetMs || 0}
                      onChange={(e) => onProjectUpdate({ audioOffsetMs: parseInt(e.target.value) })}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500" 
                    />
                  </div>
                </div>
              </section>
              <section>
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-3 block">Навигация</label>
                <div className="bg-zinc-800/50 p-4 rounded-xl border border-white/5 space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">
                      <span>Предпрослушивание при клике (Pre-roll)</span>
                      <span>{project?.audioSettings?.prerollSeconds || 3} сек</span>
                    </div>
                    <input 
                      type="range" 
                      min="0" 
                      max="10" 
                      step="0.5"
                      value={project?.audioSettings?.prerollSeconds || 3}
                      onChange={(e) => {
                        const settings = project?.audioSettings || {};
                        onProjectUpdate({ audioSettings: { ...settings, prerollSeconds: parseFloat(e.target.value) } });
                      }}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500" 
                    />
                  </div>
                  <div className="pt-4 border-t border-white/5 text-left">
                    {/* Comparison mode removed as requested */}
                  </div>
                </div>
              </section>

              <section>
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-3 block">Папки сканирования VST</label>
                <div className="bg-zinc-800/50 p-4 rounded-xl border border-white/5 space-y-3">
                  <div className="text-[10px] text-zinc-400">
                    Укажите папки, в которых плагин-хост будет искать VST2 и VST3 плагины при запуске сканирования.
                  </div>
                  
                  {/* List of folders */}
                  <div className="space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar">
                    {((project?.audioSettings?.vstFolders || getGlobalAudioSettings().vstFolders) ?? []).length === 0 ? (
                      <div className="text-zinc-500 text-[10px] italic py-2 text-center">
                        Список папок пуст. Добавьте пути для сканирования.
                      </div>
                    ) : (
                      ((project?.audioSettings?.vstFolders || getGlobalAudioSettings().vstFolders) ?? []).map((folder, fIdx) => (
                        <div key={fIdx} className="flex items-center justify-between gap-2 bg-zinc-950/60 rounded-lg p-2 border border-white/5 font-mono text-[10px]">
                          <span className="truncate text-zinc-300 select-all" title={folder}>{folder}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const settings = project?.audioSettings || getGlobalAudioSettings();
                              const currentFolders = settings.vstFolders || [];
                              const updatedFolders = currentFolders.filter((_, idx) => idx !== fIdx);
                              onProjectUpdate({ audioSettings: { ...settings, vstFolders: updatedFolders } });
                            }}
                            className="p-1 text-zinc-500 hover:text-rose-400 rounded transition-colors shrink-0 cursor-pointer"
                            title="Удалить путь"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Add Folder Button */}
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const selected = await open({
                          directory: true,
                          multiple: false,
                          title: 'Выберите папку с VST-плагинами'
                        });
                        if (selected && typeof selected === 'string') {
                          const settings = project?.audioSettings || getGlobalAudioSettings();
                          const currentFolders = settings.vstFolders || [];
                          if (!currentFolders.includes(selected)) {
                            onProjectUpdate({ audioSettings: { ...settings, vstFolders: [...currentFolders, selected] } });
                          }
                        }
                      } catch (err) {
                        console.error('Ошибка выбора папки VST:', err);
                      }
                    }}
                    className="w-full py-2 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 rounded-lg text-[10px] font-bold text-indigo-400 flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5 animate-pulse" />
                    <span>Добавить папку для сканирования...</span>
                  </button>
                </div>
              </section>

              <section>
                <HotkeySettings 
                  keyMap={project?.audioSettings?.keyMap || getGlobalAudioSettings().keyMap!}
                  onChange={(newKeyMap) => {
                    const settings = project?.audioSettings || getGlobalAudioSettings();
                    onProjectUpdate({ audioSettings: { ...settings, keyMap: newKeyMap } });
                  }}
                />
              </section>
            </div>

            <div className="p-6 bg-zinc-800/50 flex justify-end gap-3">
              <button onClick={onClose} className="px-6 py-2 rounded-xl font-bold text-sm hover:bg-white/5 transition-all">Отмена</button>
              <button onClick={onClose} className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-bold text-sm transition-all">Сохранить</button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default SettingsModal;
