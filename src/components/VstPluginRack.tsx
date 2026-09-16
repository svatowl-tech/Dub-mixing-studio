import React, { useState, useEffect } from 'react';
import {
  Cpu,
  Zap,
  Power,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  Search,
  FolderOpen,
  Info,
  X,
  Save,
  Check,
  FolderPlus,
  HardDrive,
  FileCode,
  SlidersHorizontal,
  Sparkles
} from 'lucide-react';
import { VstRackConfig, VstRackSlot } from '../types';
import { PluginMetadata } from '../lib/vstHost';

interface UserVstPreset {
  id: string;
  name: string;
  createdAt: number;
  config: VstRackConfig;
}

interface VstPluginRackProps {
  vstRack: VstRackConfig;
  updateVstRack: (updates: Partial<VstRackConfig>) => void;
  updateVstSlot: (slotId: string, updates: Partial<VstRackSlot>) => void;
  addVstSlot: (plugin: Partial<VstRackSlot>) => void;
  removeVstSlot: (slotId: string) => void;
  moveVstSlot: (index: number, direction: 'up' | 'down') => void;
  scannedPlugins: PluginMetadata[];
  isScanning: boolean;
  scanMessage: string | null;
  onScanPlugins: () => void;
  customPathInput: string;
  setCustomPathInput: (val: string) => void;
  onSwitchToRustDsp?: () => void;
}

const STORAGE_KEY = 'dubstudio_user_vst_presets';

export const VstPluginRack: React.FC<VstPluginRackProps> = ({
  vstRack,
  updateVstRack,
  updateVstSlot,
  addVstSlot,
  removeVstSlot,
  moveVstSlot,
  scannedPlugins,
  isScanning,
  scanMessage,
  onScanPlugins,
  customPathInput,
  setCustomPathInput,
  onSwitchToRustDsp,
}) => {
  const [showPluginBrowser, setShowPluginBrowser] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualFormat, setManualFormat] = useState<'VST3' | 'VST2' | 'AU'>('VST3');

  const [pluginSearch, setPluginSearch] = useState('');
  const [formatFilter, setFormatFilter] = useState<'all' | 'VST3' | 'VST2' | 'AU'>('all');

  const [userPresets, setUserPresets] = useState<UserVstPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const [newPresetName, setNewPresetName] = useState('');
  const [showSavePresetModal, setShowSavePresetModal] = useState(false);
  const [presetSavedNotice, setPresetSavedNotice] = useState(false);

  // Load user saved presets from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setUserPresets(parsed);
        }
      }
    } catch (e) {
      console.warn('Failed to load user VST presets:', e);
    }
  }, []);

  const saveUserPresetsToStorage = (presets: UserVstPreset[]) => {
    setUserPresets(presets);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    } catch (e) {
      console.warn('Failed to save user VST presets:', e);
    }
  };

  const handleSaveCurrentAsPreset = () => {
    const trimmed = newPresetName.trim() || vstRack.presetName || `Мой пресет ${userPresets.length + 1}`;
    const newPreset: UserVstPreset = {
      id: `preset-${Date.now()}`,
      name: trimmed,
      createdAt: Date.now(),
      config: {
        ...vstRack,
        presetName: trimmed,
      }
    };
    const updated = [newPreset, ...userPresets.filter(p => p.name !== trimmed)];
    saveUserPresetsToStorage(updated);
    updateVstRack({ presetName: trimmed });
    setShowSavePresetModal(false);
    setNewPresetName('');
    setPresetSavedNotice(true);
    setTimeout(() => setPresetSavedNotice(false), 3000);
  };

  const handleLoadUserPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    const found = userPresets.find(p => p.id === presetId);
    if (found) {
      updateVstRack({
        presetName: found.name,
        bypass: found.config.bypass,
        masterMix: found.config.masterMix,
        masterGainDb: found.config.masterGainDb,
        plugins: found.config.plugins || []
      });
    }
  };

  const handleDeleteUserPreset = (presetId: string) => {
    const updated = userPresets.filter(p => p.id !== presetId);
    saveUserPresetsToStorage(updated);
    if (selectedPresetId === presetId) {
      setSelectedPresetId('');
    }
  };

  const handleClearRack = () => {
    updateVstRack({
      presetName: 'Моя VST-цепочка (пустая)',
      plugins: []
    });
  };

  const handleAddManualPlugin = () => {
    if (!manualPath.trim()) return;
    const pathStr = manualPath.trim();
    const fallbackName = pathStr.split(/[\\/]/).pop()?.replace(/\.(vst3|dll|component|vst|so)$/i, '') || 'Custom VST';
    addVstSlot({
      name: manualName.trim() || fallbackName,
      pluginPath: pathStr,
      vstVersion: manualFormat,
      manufacturer: 'Пользовательский плагин',
      category: 'Audio Effect',
      enabled: true,
      bypass: false,
      mix: 1.0,
      gainDb: 0.0,
      parameters: {}
    });
    setManualPath('');
    setManualName('');
    setShowManualAdd(false);
  };

  // Only real plugins from actual scan
  const filteredPlugins = scannedPlugins.filter(p => {
    const matchesSearch = !pluginSearch ||
      p.name.toLowerCase().includes(pluginSearch.toLowerCase()) ||
      p.manufacturer.toLowerCase().includes(pluginSearch.toLowerCase()) ||
      p.category.toLowerCase().includes(pluginSearch.toLowerCase()) ||
      p.path.toLowerCase().includes(pluginSearch.toLowerCase());
    
    if (!matchesSearch) return false;
    if (formatFilter === 'all') return true;
    return p.format.toUpperCase() === formatFilter;
  });

  return (
    <div className="space-y-4">
      {/* Host Status & Mode Switcher */}
      <div className="bg-cyan-950/20 border border-cyan-800/40 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <Cpu className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
          <div className="text-xs text-zinc-300 leading-relaxed">
            <span className="font-semibold text-cyan-300">Пользовательский рэк внешних VST:</span><br />
            Цепочка формируется исключительно из плагинов, реально установленных в вашей системе.
            Никаких эмуляций или фиктивных плагинов.
          </div>
        </div>
        {onSwitchToRustDsp && (
          <button
            onClick={onSwitchToRustDsp}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium border border-zinc-700 flex items-center gap-1.5 transition-colors shrink-0"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>Вернуться к Rust DSP</span>
          </button>
        )}
      </div>

      {/* Rack Master Bar & User Preset Controls */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Preset Name & Selector */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-zinc-300">Цепочка:</span>
            <input
              type="text"
              value={vstRack.presetName || 'Моя VST-цепочка'}
              onChange={(e) => updateVstRack({ presetName: e.target.value })}
              className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-2.5 py-1.5 w-48 sm:w-64 focus:outline-none focus:border-cyan-500 font-medium"
              placeholder="Название цепочки..."
            />

            {userPresets.length > 0 && (
              <select
                value={selectedPresetId}
                onChange={(e) => handleLoadUserPreset(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-cyan-500"
              >
                <option value="">-- Мои сохранённые пресеты ({userPresets.length}) --</option>
                {userPresets.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.config.plugins?.length || 0} пл.)
                  </option>
                ))}
              </select>
            )}

            <button
              onClick={() => setShowSavePresetModal(true)}
              className="px-2.5 py-1.5 bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 border border-cyan-500/30 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
              title="Сохранить текущую цепочку плагинов как пользовательский пресет"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Сохранить пресет</span>
            </button>

            {presetSavedNotice && (
              <span className="text-xs text-emerald-400 font-medium flex items-center gap-1">
                <Check className="w-3.5 h-3.5" /> Сохранено
              </span>
            )}
          </div>

          {/* Master Controls & Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => updateVstRack({ bypass: !vstRack.bypass })}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                vstRack.bypass
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              <span>{vstRack.bypass ? 'Рэк в байпасе' : 'Рэк активен'}</span>
            </button>

            {vstRack.plugins.length > 0 && (
              <button
                onClick={handleClearRack}
                className="px-2.5 py-1.5 bg-zinc-800 hover:bg-rose-950/40 text-zinc-400 hover:text-rose-400 border border-zinc-700 hover:border-rose-700/50 rounded-lg text-xs transition-colors"
                title="Очистить все плагины в рэке"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Master Mix & Gain */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-zinc-800">
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-zinc-400">Master Mix (Dry / Wet):</span>
              <span className="font-mono text-cyan-400 font-bold">{Math.round(vstRack.masterMix * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={vstRack.masterMix}
              onChange={(e) => updateVstRack({ masterMix: parseFloat(e.target.value) })}
              className="w-full accent-cyan-500"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-zinc-400">Master Output Trim:</span>
              <span className="font-mono text-cyan-400 font-bold">
                {vstRack.masterGainDb > 0 ? `+${vstRack.masterGainDb}` : vstRack.masterGainDb} dB
              </span>
            </div>
            <input
              type="range"
              min="-12"
              max="12"
              step="0.5"
              value={vstRack.masterGainDb}
              onChange={(e) => updateVstRack({ masterGainDb: parseFloat(e.target.value) })}
              className="w-full accent-cyan-500"
            />
          </div>
        </div>
      </div>

      {/* Save Preset Dialog Modal */}
      {showSavePresetModal && (
        <div className="bg-zinc-900 border border-cyan-500/50 rounded-xl p-4 space-y-3">
          <div className="flex justify-between items-center">
            <h4 className="text-xs font-bold text-white flex items-center gap-2">
              <Save className="w-4 h-4 text-cyan-400" />
              <span>Сохранить текущую цепочку плагинов</span>
            </h4>
            <button onClick={() => setShowSavePresetModal(false)} className="text-zinc-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-zinc-400">
            Пресет сохранит порядок установленных VST-плагинов ({vstRack.plugins.length} шт.), параметры Dry/Wet и Trim.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder="Например: Мой любимый дубляж (FabFilter + CLA)"
              className="flex-1 bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-cyan-500"
              autoFocus
            />
            <button
              onClick={handleSaveCurrentAsPreset}
              className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold rounded-lg transition-colors"
            >
              Сохранить
            </button>
          </div>
        </div>
      )}

      {/* VST Chain Slots List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
            <span>Цепочка обработки</span>
            <span className="px-2 py-0.5 rounded-full bg-zinc-800 text-[10px] text-zinc-400 font-mono">
              {vstRack.plugins.length} плагинов
            </span>
          </h3>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowPluginBrowser(true);
                if (scannedPlugins.length === 0 && !isScanning) {
                  onScanPlugins();
                }
              }}
              className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Добавить VST плагин</span>
            </button>

            <button
              onClick={() => setShowManualAdd(!showManualAdd)}
              className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-medium border border-zinc-700 flex items-center gap-1.5 transition-colors"
              title="Указать путь к файлу плагина вручную (.vst3 / .dll / .component)"
            >
              <FolderPlus className="w-3.5 h-3.5 text-zinc-400" />
              <span>Указать файл</span>
            </button>
          </div>
        </div>

        {/* Manual Plugin File Input */}
        {showManualAdd && (
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-3.5 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                <span>Добавить плагин по прямому пути к файлу:</span>
              </span>
              <button onClick={() => setShowManualAdd(false)} className="text-zinc-500 hover:text-white">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="Имя плагина (необязательно)"
                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-cyan-500"
              />
              <select
                value={manualFormat}
                onChange={(e) => setManualFormat(e.target.value as any)}
                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-cyan-500"
              >
                <option value="VST3">Формат VST3</option>
                <option value="VST2">Формат VST2 (.dll)</option>
                <option value="AU">Формат AU (.component)</option>
              </select>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  placeholder="Полный путь к .vst3 или .dll..."
                  className="flex-1 bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                />
                <button
                  onClick={handleAddManualPlugin}
                  disabled={!manualPath.trim()}
                  className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white rounded-lg text-xs font-semibold transition-colors"
                >
                  Добавить
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Empty State when no plugins are added */}
        {vstRack.plugins.length === 0 && (
          <div className="bg-zinc-900/60 border border-dashed border-zinc-800 rounded-xl p-8 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-zinc-800/80 border border-zinc-700 flex items-center justify-center mx-auto text-zinc-400">
              <SlidersHorizontal className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-semibold text-zinc-200">Цепочка VST пуста</div>
              <div className="text-xs text-zinc-400 max-w-md mx-auto">
                Здесь нет фиктивных заглушек. Добавьте реальные VST-плагины, установленные на вашем компьютере, либо используйте нашу готовую студийную обработку на чистом Rust.
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                onClick={() => {
                  setShowPluginBrowser(true);
                  if (scannedPlugins.length === 0 && !isScanning) {
                    onScanPlugins();
                  }
                }}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors shadow-sm"
              >
                <Search className="w-4 h-4" />
                <span>Выбрать из установленных VST</span>
              </button>

              {onSwitchToRustDsp && (
                <button
                  onClick={onSwitchToRustDsp}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-semibold border border-zinc-700 flex items-center gap-2 transition-colors"
                >
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span>Использовать обработку Rust DSP</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Plugin Slots */}
        {vstRack.plugins.map((slot, index) => (
          <div
            key={slot.id}
            className={`border rounded-xl p-3.5 transition-colors ${
              slot.bypass
                ? 'bg-zinc-950/60 border-zinc-800/60 opacity-60'
                : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* Slot Header & Meta */}
              <div className="flex items-center gap-3 min-w-0">
                <span className="w-6 h-6 rounded-md bg-zinc-800 flex items-center justify-center text-xs font-mono font-bold text-cyan-400 shrink-0">
                  {index + 1}
                </span>

                <button
                  onClick={() => updateVstSlot(slot.id, { bypass: !slot.bypass })}
                  className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors shrink-0 ${
                    !slot.bypass
                      ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40'
                      : 'bg-zinc-800 text-zinc-600 border border-zinc-700'
                  }`}
                  title={slot.bypass ? 'Включить плагин' : 'Отключить (Bypass)'}
                >
                  <Power className="w-3.5 h-3.5" />
                </button>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white truncate">{slot.name}</span>
                    <span className="px-1.5 py-0.2 rounded bg-zinc-800 border border-zinc-700 text-[10px] font-mono text-zinc-400 shrink-0">
                      {slot.vstVersion || 'VST3'}
                    </span>
                    {slot.manufacturer && slot.manufacturer !== 'External Developer' && (
                      <span className="text-[10px] text-zinc-400 truncate hidden sm:inline">
                        • {slot.manufacturer}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-zinc-500 font-mono truncate max-w-md" title={slot.pluginPath}>
                    {slot.pluginPath}
                  </div>
                </div>
              </div>

              {/* Slot Actions */}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => moveVstSlot(index, 'up')}
                  disabled={index === 0}
                  className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-20 transition-colors"
                  title="Переместить выше по цепочке"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => moveVstSlot(index, 'down')}
                  disabled={index === vstRack.plugins.length - 1}
                  className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-20 transition-colors"
                  title="Переместить ниже по цепочке"
                >
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => removeVstSlot(slot.id)}
                  className="p-1.5 rounded hover:bg-rose-950/40 text-zinc-400 hover:text-rose-400 transition-colors ml-1"
                  title="Удалить плагин из цепочки"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Individual Slot Mix & Trim Controls */}
            {!slot.bypass && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3 pt-3 border-t border-zinc-800/80">
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-zinc-400">Mix (Dry/Wet):</span>
                    <span className="font-mono text-cyan-400 font-semibold">{Math.round(slot.mix * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={slot.mix}
                    onChange={(e) => updateVstSlot(slot.id, { mix: parseFloat(e.target.value) })}
                    className="w-full accent-cyan-500 h-1.5 bg-zinc-800 rounded-lg cursor-pointer"
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-zinc-400">Output Gain Trim:</span>
                    <span className="font-mono text-cyan-400 font-semibold">
                      {slot.gainDb > 0 ? `+${slot.gainDb}` : slot.gainDb} dB
                    </span>
                  </div>
                  <input
                    type="range"
                    min="-24"
                    max="24"
                    step="0.5"
                    value={slot.gainDb}
                    onChange={(e) => updateVstSlot(slot.id, { gainDb: parseFloat(e.target.value) })}
                    className="w-full accent-cyan-500 h-1.5 bg-zinc-800 rounded-lg cursor-pointer"
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Plugin Browser Modal Dialog (Only Real Installed Plugins) */}
      {showPluginBrowser && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
            {/* Header */}
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <HardDrive className="w-5 h-5 text-cyan-400" />
                <div>
                  <h3 className="text-sm font-bold text-white">Установленные VST плагины</h3>
                  <div className="text-[11px] text-zinc-400">
                    {scannedPlugins.length > 0
                      ? `Обнаружено ${scannedPlugins.length} плагинов на вашем компьютере`
                      : 'Сканирование системных директорий VST2 / VST3 / AU'}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setShowPluginBrowser(false)}
                className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Scan Controls & Path Input */}
            <div className="p-3.5 bg-zinc-950/60 border-b border-zinc-800 space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={onScanPlugins}
                  disabled={isScanning}
                  className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                  <span>{isScanning ? 'Сканирование...' : 'Пересканировать систему'}</span>
                </button>

                <div className="flex-1 flex gap-1.5 min-w-[200px]">
                  <input
                    type="text"
                    value={customPathInput}
                    onChange={(e) => setCustomPathInput(e.target.value)}
                    placeholder="Добавить папку (например C:\Program Files\VSTPlugins)..."
                    className="flex-1 bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                  <button
                    onClick={onScanPlugins}
                    disabled={isScanning || !customPathInput.trim()}
                    className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 text-xs font-medium rounded-lg border border-zinc-700"
                  >
                    Сканировать
                  </button>
                </div>
              </div>

              {scanMessage && (
                <div className="text-[11px] text-cyan-300 font-mono flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{scanMessage}</span>
                </div>
              )}

              {/* Filters */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <div className="relative flex-1 min-w-[160px]">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-zinc-400" />
                  <input
                    type="text"
                    value={pluginSearch}
                    onChange={(e) => setPluginSearch(e.target.value)}
                    placeholder="Поиск по имени или разработчику..."
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="flex items-center gap-1">
                  {(['all', 'VST3', 'VST2', 'AU'] as const).map(fmt => (
                    <button
                      key={fmt}
                      onClick={() => setFormatFilter(fmt)}
                      className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                        formatFilter === fmt
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                          : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {fmt === 'all' ? 'Все форматы' : fmt}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Plugin List */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-1.5">
              {filteredPlugins.length === 0 ? (
                <div className="text-center py-10 space-y-2">
                  <FolderOpen className="w-8 h-8 text-zinc-600 mx-auto" />
                  <div className="text-xs font-medium text-zinc-400">
                    {scannedPlugins.length === 0
                      ? 'В стандартных директориях VST плагины не обнаружены'
                      : 'По вашему запросу ничего не найдено'}
                  </div>
                  <div className="text-[11px] text-zinc-500 max-w-sm mx-auto">
                    {scannedPlugins.length === 0
                      ? 'Убедитесь, что плагины установлены в стандартную папку VST3 или укажите путь к вашей папке выше.'
                      : 'Попробуйте изменить поисковый запрос или фильтр форматов.'}
                  </div>
                </div>
              ) : (
                filteredPlugins.map(p => (
                  <div
                    key={p.path}
                    className="bg-zinc-950/60 hover:bg-zinc-800/80 border border-zinc-800 hover:border-zinc-700 rounded-xl p-3 flex items-center justify-between gap-3 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white truncate">{p.name}</span>
                        <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-[10px] font-mono text-cyan-400 border border-zinc-700 shrink-0">
                          {p.format}
                        </span>
                        {p.category && (
                          <span className="text-[10px] text-zinc-400 truncate hidden sm:inline">
                            [{p.category}]
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-500 truncate font-mono mt-0.5" title={p.path}>
                        {p.manufacturer ? `${p.manufacturer} • ` : ''}{p.path}
                      </div>
                    </div>

                    <button
                      onClick={() => {
                        addVstSlot({
                          name: p.name,
                          pluginPath: p.path,
                          vstVersion: (p.format as any) || 'VST3',
                          manufacturer: p.manufacturer,
                          category: p.category,
                          enabled: true,
                          bypass: false,
                          mix: 1.0,
                          gainDb: 0.0,
                          parameters: {}
                        });
                        setShowPluginBrowser(false);
                      }}
                      className="px-3 py-1.5 bg-cyan-600/20 hover:bg-cyan-600 text-cyan-300 hover:text-white border border-cyan-500/30 hover:border-cyan-500 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Вставить в рэк</span>
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-zinc-800 bg-zinc-950/40 flex items-center justify-between text-xs text-zinc-400">
              <span>Отображается: {filteredPlugins.length} из {scannedPlugins.length} найденных плагинов</span>
              <button
                onClick={() => setShowPluginBrowser(false)}
                className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
