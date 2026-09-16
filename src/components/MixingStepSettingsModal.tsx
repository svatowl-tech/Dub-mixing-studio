import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { 
  X, 
  Sliders, 
  Volume2, 
  VolumeX, 
  Sparkles, 
  Radio, 
  Phone, 
  Tv, 
  Bot, 
  Zap, 
  Check, 
  RotateCcw, 
  Info, 
  Flame, 
  Power, 
  Play, 
  Activity,
  Layers,
  FileText,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Search,
  FolderOpen,
  RefreshCw,
  Cpu,
  Settings2,
  SlidersHorizontal,
  AlertCircle
} from 'lucide-react';
import { 
  Project, 
  MixingEffectsConfig, 
  AuditionVocalBusChainConfig,
  VocalBusRackConfig,
  VstRackConfig,
  VstRackSlot,
  MixingType
} from '../types';
import { scanPluginsWithPaths, PluginMetadata } from '../lib/vstHost';
import { VstPluginRack } from './VstPluginRack';

interface MixingStepSettingsModalProps {
  isOpen?: boolean;
  stepId: 'gainMatching' | 'ducking' | 'autoFxAnalysis' | 'vocalBusProcessing';
  config: MixingEffectsConfig;
  project?: Project | null;
  mixingType?: string;
  onUpdateConfig?: (updates: Partial<MixingEffectsConfig>) => void;
  onSaveConfig?: (updates: Partial<MixingEffectsConfig>) => void;
  onRunSingleStep?: (stepId: string) => void;
  onRunStep?: (stepId: string) => void;
  isRunning?: boolean;
  onClose: () => void;
  onOpenAuditLog?: () => void;
}

export const MixingStepSettingsModal: React.FC<MixingStepSettingsModalProps> = ({
  isOpen = true,
  stepId,
  config,
  project,
  mixingType,
  onUpdateConfig,
  onSaveConfig,
  onRunSingleStep,
  onRunStep,
  isRunning,
  onClose,
  onOpenAuditLog
}) => {
  const [activeTab, setActiveTab] = useState<'settings' | 'rack' | 'preview'>('settings');
  const [busRackMode, setBusRackMode] = useState<'rustDsp' | 'vstRack'>(config.vocalBusProcessing?.mode || 'rustDsp');
  const [isScanning, setIsScanning] = useState(false);
  const [scannedPlugins, setScannedPlugins] = useState<PluginMetadata[]>([]);
  const [showPluginBrowser, setShowPluginBrowser] = useState(false);
  const [pluginSearch, setPluginSearch] = useState('');
  const [pluginCategoryFilter, setPluginCategoryFilter] = useState('all');
  const [customPathInput, setCustomPathInput] = useState('');
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleUpdate = (updates: Partial<MixingEffectsConfig>) => {
    if (onUpdateConfig) onUpdateConfig(updates);
    if (onSaveConfig) onSaveConfig(updates);
  };
  const onUpdateConfigSafe = handleUpdate;

  const handleRun = (id: string) => {
    if (onRunSingleStep) onRunSingleStep(id);
    if (onRunStep) onRunStep(id);
  };
  const hasRunHandler = Boolean(onRunSingleStep || onRunStep);

  const gm = config.gainMatching;
  const duck = config.ducking;
  const fx = config.autoFxAnalysis;
  const bus = config.vocalBusProcessing;

  const defaultNativeRack: VocalBusRackConfig = {
    presetName: 'Studio Master Vocal Bus Rack (Rust DSP)',
    bypass: false,
    eq: {
      enabled: true,
      hpfCutoffHz: 75,
      hpfOrder: 2,
      notchEnabled: true,
      notchFreqHz: 3200,
      notchQ: 8.0,
      notchGainDb: -6.0,
    },
    deesser: {
      enabled: true,
      frequencyHz: 6500,
      thresholdDb: -22.0,
      ratio: 4.0,
      attackMs: 1.5,
      releaseMs: 50.0,
      kneeWidthDb: 4.0,
      maxReductionDb: -12.0,
      mode: 'splitBand',
    },
    saturation: {
      enabled: true,
      driveDb: 3.5,
      blend: 0.35,
      warmthBias: 0.15,
      autoGain: true,
    },
    compressor: {
      enabled: true,
      thresholdDb: -18.0,
      ratio: 3.0,
      attackMs: 20.0,
      releaseMs: 120.0,
      kneeWidthDb: 6.0,
      makeupGainDb: 2.5,
      optoCharacter: true,
    },
    exciter: {
      enabled: true,
      airFreqHz: 10000,
      airGainDb: 2.5,
      harmonicDrive: 0.20,
      airBlend: 0.70,
    },
    limiter: {
      enabled: true,
      ceilingDbtp: -1.0,
      releaseMs: 60.0,
      lookaheadMs: 1.5,
    },
  };

  const nativeRack: VocalBusRackConfig = bus.nativeRack || defaultNativeRack;

  const updateNativeRack = (stageKey: keyof VocalBusRackConfig, updates: any) => {
    const currentVal = (nativeRack as any)[stageKey];
    const updatedStage = typeof currentVal === 'object' && currentVal !== null ? { ...currentVal, ...updates } : updates;
    const updatedRack: VocalBusRackConfig = {
      ...nativeRack,
      [stageKey]: updatedStage
    };
    handleUpdate({
      vocalBusProcessing: {
        ...bus,
        nativeRack: updatedRack
      }
    });
  };

  const defaultVstRack: VstRackConfig = {
    presetName: 'Моя VST-цепочка',
    bypass: false,
    masterMix: 1.0,
    masterGainDb: 0.0,
    plugins: []
  };

  const vstRack: VstRackConfig = bus.vstRack || defaultVstRack;

  const updateVstRack = (updates: Partial<VstRackConfig>) => {
    const updated = { ...vstRack, ...updates };
    handleUpdate({
      vocalBusProcessing: {
        ...bus,
        vstRack: updated
      }
    });
  };

  const updateVstSlot = (slotId: string, updates: Partial<VstRackSlot>) => {
    const updatedPlugins = vstRack.plugins.map(p => p.id === slotId ? { ...p, ...updates } : p);
    updateVstRack({ plugins: updatedPlugins });
  };

  const addVstSlot = (plugin: Partial<VstRackSlot>) => {
    const newSlot: VstRackSlot = {
      id: `vst-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name: plugin.name || 'New VST Plugin',
      pluginPath: plugin.pluginPath || 'Custom Path',
      vstVersion: plugin.vstVersion || 'VST3',
      manufacturer: plugin.manufacturer || 'External Developer',
      category: plugin.category || 'Audio Effect',
      enabled: true,
      bypass: false,
      mix: typeof plugin.mix === 'number' ? plugin.mix : 1.0,
      gainDb: typeof plugin.gainDb === 'number' ? plugin.gainDb : 0.0,
      parameters: plugin.parameters || {}
    };
    updateVstRack({ plugins: [...vstRack.plugins, newSlot] });
  };

  const removeVstSlot = (slotId: string) => {
    updateVstRack({ plugins: vstRack.plugins.filter(p => p.id !== slotId) });
  };

  const moveVstSlot = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= vstRack.plugins.length) return;
    const newPlugins = [...vstRack.plugins];
    const temp = newPlugins[index];
    newPlugins[index] = newPlugins[targetIndex];
    newPlugins[targetIndex] = temp;
    updateVstRack({ plugins: newPlugins });
  };

  const handleScanPlugins = async () => {
    setIsScanning(true);
    setScanMessage('Сканирование стандартных директорий VST2 / VST3 / AU...');
    try {
      const extraPaths = customPathInput.trim() ? [customPathInput.trim()] : [];
      const plugins = await scanPluginsWithPaths(extraPaths);
      setScannedPlugins(plugins);
      setScanMessage(`Найдено ${plugins.length} VST-плагинов в системе.`);
      setShowPluginBrowser(true);
    } catch (err: any) {
      console.warn('Scan plugins error:', err);
      setScanMessage('Ошибка сканирования плагинов');
    } finally {
      setIsScanning(false);
    }
  };

  const stepTitles = {
    gainMatching: '1. Соответствие громкости (Реплики vs Физика)',
    ducking: '2. Автодакинг оригинальных реплик',
    autoFxAnalysis: '3. Автоанализ и перенос эффектов оригинала',
    vocalBusProcessing: '4. Мастер-шина вокала (Студийный Rust DSP рэк или цепочка VST-плагинов)'
  };

  return createPortal(
    <div 
      className="fixed inset-0 bg-black/85 backdrop-blur-md z-[999999] flex items-center justify-center p-3 sm:p-6 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div 
        className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-zinc-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/60">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center border border-purple-500/30">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                {stepTitles[stepId]}
              </h2>
              <p className="text-xs text-zinc-400">
                Этап 3: Сведение • Тонкая настройка алгоритмов и DSP обработки
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {onOpenAuditLog && (
              <button
                onClick={onOpenAuditLog}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 font-medium flex items-center gap-1.5 transition-colors border border-zinc-700"
              >
                <FileText className="w-3.5 h-3.5 text-indigo-400" />
                Журнал логов
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* ========================================================================= */}
          {/* 1. GAIN MATCHING (LOUDNESS MATCHING)                                     */}
          {/* ========================================================================= */}
          {stepId === 'gainMatching' && (
            <div className="space-y-6">
              <div className="bg-purple-950/30 border border-purple-800/40 rounded-xl p-4 flex items-start gap-3">
                <Info className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
                <div className="text-xs text-zinc-300 leading-relaxed">
                  <span className="font-semibold text-purple-300">Правило громкости сериалов и озвучки:</span><br />
                  Все <strong className="text-white">реплики с субтитрами</strong> выравниваются под строго единый стандартный уровень. Звуки персонажей без сабов (<strong className="text-amber-300">физика: крики, вздохи, кряхтение, звуки движения</strong>) делаются мягче на <strong className="text-white">10 дБ</strong>, чтобы не глушить слушателя и звучать естественно в миксе.
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Target Dialogue LUFS */}
                <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-zinc-200">Целевая громкость реплик (Сабы)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="-28"
                        max="-12"
                        step="0.1"
                        value={gm.targetDialogueLufs}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) {
                            handleUpdate({
                              gainMatching: { ...gm, targetDialogueLufs: val }
                            });
                          }
                        }}
                        className="w-16 px-1.5 py-0.5 bg-zinc-950 border border-purple-500/30 rounded text-right text-purple-400 font-mono font-bold text-xs focus:outline-none focus:border-purple-500"
                      />
                      <span className="text-[10px] text-zinc-400 font-mono">dBFS</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="-28"
                    max="-12"
                    step="0.1"
                    value={gm.targetDialogueLufs}
                    onChange={(e) => handleUpdate({
                      gainMatching: { ...gm, targetDialogueLufs: parseFloat(e.target.value) }
                    })}
                    className="w-full accent-purple-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                    <span>-28 dBFS (Тихий закадр)</span>
                    <span>-18 dBFS (Стандарт)</span>
                    <span>-12 dBFS (Громкий)</span>
                  </div>
                </div>

                {/* Physics Offset dB */}
                <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-zinc-200">Ослабление физики/криков (Без сабов)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="-24"
                        max="-3"
                        step="0.1"
                        value={gm.physicsOffsetDb}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) {
                            handleUpdate({
                              gainMatching: { ...gm, physicsOffsetDb: val }
                            });
                          }
                        }}
                        className="w-16 px-1.5 py-0.5 bg-zinc-950 border border-amber-500/30 rounded text-right text-amber-400 font-mono font-bold text-xs focus:outline-none focus:border-amber-500"
                      />
                      <span className="text-[10px] text-zinc-400 font-mono">dB</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="-24"
                    max="-3"
                    step="0.1"
                    value={gm.physicsOffsetDb}
                    onChange={(e) => handleUpdate({
                      gainMatching: { ...gm, physicsOffsetDb: parseFloat(e.target.value) }
                    })}
                    className="w-full accent-amber-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                    <span>-24 dB (Очень тихо)</span>
                    <span>-10 dB (Рекомендуемое)</span>
                    <span>-3 dB (Минимум)</span>
                  </div>
                </div>
              </div>

              {/* Extra toggles */}
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-zinc-200">Автоматическая разметка категорий</div>
                    <div className="text-[11px] text-zinc-400">Маркировать сегменты на таймлайне бейджами «Реплика» и «Физика»</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={gm.autoTagCategories}
                    onChange={(e) => handleUpdate({
                      gainMatching: { ...gm, autoTagCategories: e.target.checked }
                    })}
                    className="w-4 h-4 rounded bg-zinc-800 border-zinc-700 text-purple-600 focus:ring-0 cursor-pointer"
                  />
                </div>

                <div className="border-t border-zinc-800/80 pt-3 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-zinc-200">Алгоритм измерения</div>
                    <div className="text-[11px] text-zinc-400">Интегральный стандарт взвешивания громкости</div>
                  </div>
                  <select
                    value={gm.measurementMethod}
                    onChange={(e) => handleUpdate({
                      gainMatching: { ...gm, measurementMethod: e.target.value as any }
                    })}
                    className="bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 rounded-lg px-2.5 py-1 focus:outline-none"
                  >
                    <option value="lufs">EBU R128 (LUFS)</option>
                    <option value="rms">True RMS (dB)</option>
                    <option value="peak">Peak Normalized</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* 2. AUTO-DUCKING (SIDECHAIN DSP)                                          */}
          {/* ========================================================================= */}
          {stepId === 'ducking' && (
            <div className="space-y-6">
              <div className="bg-indigo-950/30 border border-indigo-800/40 rounded-xl p-4 flex items-start gap-3">
                <Info className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
                <div className="text-xs text-zinc-300 leading-relaxed">
                  <span className="font-semibold text-indigo-300">Интеллектуальный сайдчейн-дакинг (Rayon DSP):</span><br />
                  • <strong className="text-white">Закадр (Voiceover):</strong> оригинальный голос приглушается на <strong className="text-indigo-400">-16 dB</strong> во время речи дабера.<br />
                  • <strong className="text-white">Рекаст (Recast):</strong> оригинальный голос приглушается на <strong className="text-indigo-400">-24 dB</strong>.<br />
                  • <strong className="text-white">Дубляж (Dubbing):</strong> оригинальный голос полностью глушится (<strong className="text-indigo-400">Mute / -∞ dB</strong>).<br />
                  • <strong className="text-white">Подложка (M&E):</strong> чистая музыка и эффекты ослабляются всего на <strong className="text-indigo-400">-1.5 dB</strong> для разборчивости речи.<br />
                  • <strong className="text-white">S-образная огибающая:</strong> полукосинусная интерполяция без кликов и щелчков (Lookahead 50 мс, Fade-down 100 мс, Hold 150 мс, Release 300–500 мс).
                </div>
              </div>

              {/* Sliders Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Voiceover */}
                <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-zinc-200">Закадр (Voiceover)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="-30"
                        max="0"
                        step="0.5"
                        value={duck.voiceoverDuckingDb ?? -16}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) {
                            handleUpdate({
                              ducking: { ...duck, voiceoverDuckingDb: val }
                            });
                          }
                        }}
                        className="w-16 px-1.5 py-0.5 bg-zinc-950 border border-indigo-500/30 rounded text-right text-indigo-400 font-mono font-bold text-xs focus:outline-none focus:border-indigo-500"
                      />
                      <span className="text-[10px] text-zinc-400 font-mono">dB</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="-30"
                    max="0"
                    step="0.5"
                    value={duck.voiceoverDuckingDb ?? -16}
                    onChange={(e) => handleUpdate({
                      ducking: { ...duck, voiceoverDuckingDb: parseFloat(e.target.value) }
                    })}
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                    <span>-30 dB</span>
                    <span>-16 dB (Стандарт)</span>
                    <span>0 dB</span>
                  </div>
                </div>

                {/* Recast */}
                <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-zinc-200">Рекаст (Recast)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="-36"
                        max="-10"
                        step="0.5"
                        value={duck.recastDuckingDb ?? -24}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) {
                            handleUpdate({
                              ducking: { ...duck, recastDuckingDb: val }
                            });
                          }
                        }}
                        className="w-16 px-1.5 py-0.5 bg-zinc-950 border border-indigo-500/30 rounded text-right text-indigo-400 font-mono font-bold text-xs focus:outline-none focus:border-indigo-500"
                      />
                      <span className="text-[10px] text-zinc-400 font-mono">dB</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="-36"
                    max="-10"
                    step="0.5"
                    value={duck.recastDuckingDb ?? -24}
                    onChange={(e) => handleUpdate({
                      ducking: { ...duck, recastDuckingDb: parseFloat(e.target.value) }
                    })}
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                    <span>-36 dB</span>
                    <span>-24 dB (Стандарт)</span>
                    <span>-10 dB</span>
                  </div>
                </div>

                {/* Dubbing */}
                <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-zinc-200">Дубляж (Dubbing)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="-96"
                        max="-18"
                        step="1"
                        value={duck.dubbingDuckingDb ?? -96}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) {
                            handleUpdate({
                              ducking: { ...duck, dubbingDuckingDb: val }
                            });
                          }
                        }}
                        className="w-16 px-1.5 py-0.5 bg-zinc-950 border border-indigo-500/30 rounded text-right text-indigo-400 font-mono font-bold text-xs focus:outline-none focus:border-indigo-500"
                      />
                      <span className="text-[10px] text-zinc-400 font-mono">dB</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="-96"
                    max="-18"
                    step="1"
                    value={duck.dubbingDuckingDb ?? -96}
                    onChange={(e) => handleUpdate({
                      ducking: { ...duck, dubbingDuckingDb: parseFloat(e.target.value) }
                    })}
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                    <span>Mute (-96 dB)</span>
                    <span>-40 dB</span>
                    <span>-18 dB</span>
                  </div>
                </div>
              </div>

              {/* M&E track attenuation & Lookahead */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-zinc-200">Ослабление M&E (Music & SFX)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="-6"
                        max="0"
                        step="0.5"
                        value={duck.meDuckingDb ?? -1.5}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) {
                            handleUpdate({
                              ducking: { ...duck, meDuckingDb: val }
                            });
                          }
                        }}
                        className="w-16 px-1.5 py-0.5 bg-zinc-950 border border-indigo-500/30 rounded text-right text-indigo-400 font-mono font-bold text-xs focus:outline-none focus:border-indigo-500"
                      />
                      <span className="text-[10px] text-zinc-400 font-mono">dB</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="-6"
                    max="0"
                    step="0.5"
                    value={duck.meDuckingDb ?? -1.5}
                    onChange={(e) => handleUpdate({
                      ducking: { ...duck, meDuckingDb: parseFloat(e.target.value) }
                    })}
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                    <span>-6.0 dB</span>
                    <span>-1.5 dB (Рекомендация)</span>
                    <span>0 dB (Без дакинга)</span>
                  </div>
                </div>

                <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-zinc-200">Упреждение (Lookahead)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="0"
                        max="150"
                        step="5"
                        value={duck.lookaheadMs ?? 50}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          if (!isNaN(val)) {
                            handleUpdate({
                              ducking: { ...duck, lookaheadMs: Math.max(0, val) }
                            });
                          }
                        }}
                        className="w-16 px-1.5 py-0.5 bg-zinc-950 border border-indigo-500/30 rounded text-right text-indigo-400 font-mono font-bold text-xs focus:outline-none focus:border-indigo-500"
                      />
                      <span className="text-[10px] text-zinc-400 font-mono">ms</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="150"
                    step="5"
                    value={duck.lookaheadMs ?? 50}
                    onChange={(e) => handleUpdate({
                      ducking: { ...duck, lookaheadMs: Math.max(0, parseInt(e.target.value)) }
                    })}
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                    <span>0 ms</span>
                    <span>50 ms (Стандарт)</span>
                    <span>150 ms</span>
                  </div>
                </div>
              </div>

              {/* Envelope timings */}
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-4">
                <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-wider">Параметры S-огибающей (S-Curve Envelope)</h4>
                
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[11px] text-zinc-400">Спуск (Fade-down ms)</label>
                    <input
                      type="number"
                      value={duck.fadeDownMs ?? duck.attackMs ?? 100}
                      onChange={(e) => handleUpdate({
                        ducking: { 
                          ...duck, 
                          fadeDownMs: Math.max(5, parseInt(e.target.value) || 100),
                          attackMs: Math.max(5, parseInt(e.target.value) || 100) 
                        }
                      })}
                      className="w-full bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-200 rounded-lg p-2 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] text-zinc-400">Удержание (Hold ms)</label>
                    <input
                      type="number"
                      value={duck.holdMs ?? 150}
                      onChange={(e) => handleUpdate({
                        ducking: { ...duck, holdMs: Math.max(0, parseInt(e.target.value) || 150) }
                      })}
                      className="w-full bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-200 rounded-lg p-2 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] text-zinc-400">Восстановление (Release ms)</label>
                    <input
                      type="number"
                      value={duck.releaseMs ?? 350}
                      onChange={(e) => handleUpdate({
                        ducking: { ...duck, releaseMs: Math.max(50, parseInt(e.target.value) || 350) }
                      })}
                      className="w-full bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-200 rounded-lg p-2 focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* 3. AUTO FX ANALYSIS                                                      */}
          {/* ========================================================================= */}
          {stepId === 'autoFxAnalysis' && (
            <div className="space-y-6">
              <div className="bg-emerald-950/30 border border-emerald-800/40 rounded-xl p-4 flex items-start gap-3">
                <Info className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div className="text-xs text-zinc-300 leading-relaxed">
                  <span className="font-semibold text-emerald-300">Акустический DSP-анализатор оригинала (Rust / rustfft / hound):</span><br />
                  • <strong className="text-white">Стерео-панорама и ILD:</strong> расчет межканальной разницы уровней <code className="text-emerald-300 font-mono text-[11px]">ILD = 20·lg(RMS_R / RMS_L)</code> и фазовой когерентности.<br />
                  • <strong className="text-white">Расстояние и реверберация:</strong> вычисление <strong className="text-emerald-400">DRR</strong> (Direct-to-Reverberant Ratio) и времени затухания <strong className="text-emerald-400">T60</strong> через интеграл Шрёдера (EDC).<br />
                  • <strong className="text-white">Спектральная окраска:</strong> определение фильтров рации/телефона (<code className="text-emerald-300 font-mono text-[11px]">300–3400 Гц</code>), мегафона/рупора (<code className="text-emerald-300 font-mono text-[11px]">550–2800 Гц</code>) и студийного голоса.<br />
                  • <strong className="text-white">AcousticPreset:</strong> экспорт точной структуры <code className="text-emerald-300 font-mono text-[11px]">&#123; pan, reverb_wet, reverb_decay_ms, high_pass_hz, low_pass_hz &#125;</code> для Web Audio и VST.
                </div>
              </div>

              {/* Detections grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex items-center justify-between p-3.5 bg-zinc-900/80 border border-zinc-800 rounded-xl cursor-pointer hover:border-zinc-700 transition-colors">
                  <div className="flex items-center gap-3">
                    <Sparkles className="w-4 h-4 text-emerald-400" />
                    <div>
                      <div className="text-xs font-semibold text-zinc-200">Реверберация и пространство (Reverb)</div>
                      <div className="text-[11px] text-zinc-500">Комната, зал, открытый воздух, T60 Decay</div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={fx.detectReverb}
                    onChange={(e) => handleUpdate({
                      autoFxAnalysis: { ...fx, detectReverb: e.target.checked }
                    })}
                    className="w-4 h-4 rounded bg-zinc-800 border-zinc-700 text-emerald-600 focus:ring-0 cursor-pointer"
                  />
                </label>

                <label className="flex items-center justify-between p-3.5 bg-zinc-900/80 border border-zinc-800 rounded-xl cursor-pointer hover:border-zinc-700 transition-colors">
                  <div className="flex items-center gap-3">
                    <Activity className="w-4 h-4 text-cyan-400" />
                    <div>
                      <div className="text-xs font-semibold text-zinc-200">Эхо и дилей (Delay / Echo)</div>
                      <div className="text-[11px] text-zinc-500">Повторы, миллисекунды задержки, фидбек</div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={fx.detectDelay}
                    onChange={(e) => handleUpdate({
                      autoFxAnalysis: { ...fx, detectDelay: e.target.checked }
                    })}
                    className="w-4 h-4 rounded bg-zinc-800 border-zinc-700 text-emerald-600 focus:ring-0 cursor-pointer"
                  />
                </label>

                <label className="flex items-center justify-between p-3.5 bg-zinc-900/80 border border-zinc-800 rounded-xl cursor-pointer hover:border-zinc-700 transition-colors">
                  <div className="flex items-center gap-3">
                    <Phone className="w-4 h-4 text-amber-400" />
                    <div>
                      <div className="text-xs font-semibold text-zinc-200">Спецэффекты (Телефон, Радио, ТВ, Робот)</div>
                      <div className="text-[11px] text-zinc-500">Полосовые фильтры 300Hz-3.4kHz, сатурация</div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={fx.detectSpecialFx}
                    onChange={(e) => handleUpdate({
                      autoFxAnalysis: { ...fx, detectSpecialFx: e.target.checked }
                    })}
                    className="w-4 h-4 rounded bg-zinc-800 border-zinc-700 text-emerald-600 focus:ring-0 cursor-pointer"
                  />
                </label>

                <label className="flex items-center justify-between p-3.5 bg-zinc-900/80 border border-zinc-800 rounded-xl cursor-pointer hover:border-zinc-700 transition-colors">
                  <div className="flex items-center gap-3">
                    <Sliders className="w-4 h-4 text-purple-400" />
                    <div>
                      <div className="text-xs font-semibold text-zinc-200">Стереопанорама (L/R Panning)</div>
                      <div className="text-[11px] text-zinc-500">Позиционирование персонажа в кадре</div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={fx.detectPanning}
                    onChange={(e) => handleUpdate({
                      autoFxAnalysis: { ...fx, detectPanning: e.target.checked }
                    })}
                    className="w-4 h-4 rounded bg-zinc-800 border-zinc-700 text-emerald-600 focus:ring-0 cursor-pointer"
                  />
                </label>
              </div>

              {/* Sensitivity & Target */}
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-4">
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-zinc-200">Чувствительность детектора эффектов</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="30"
                        max="100"
                        step="1"
                        value={fx.sensitivity}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          if (!isNaN(val)) {
                            handleUpdate({
                              autoFxAnalysis: { ...fx, sensitivity: val }
                            });
                          }
                        }}
                        className="w-16 px-1.5 py-0.5 bg-zinc-950 border border-emerald-500/30 rounded text-right text-emerald-400 font-mono font-bold text-xs focus:outline-none focus:border-emerald-500"
                      />
                      <span className="text-[10px] text-zinc-400 font-mono">%</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="30"
                    max="100"
                    value={fx.sensitivity}
                    onChange={(e) => handleUpdate({
                      autoFxAnalysis: { ...fx, sensitivity: parseInt(e.target.value) }
                    })}
                    className="w-full accent-emerald-500 cursor-pointer"
                  />
                </div>

                <div className="border-t border-zinc-800/80 pt-3 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-zinc-200">Автоматический перенос на дубли</div>
                    <div className="text-[11px] text-zinc-400">Назначать эффекты на соответствующие реплики в дорожках</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={fx.applyToDub}
                    onChange={(e) => handleUpdate({
                      autoFxAnalysis: { ...fx, applyToDub: e.target.checked }
                    })}
                    className="w-4 h-4 rounded bg-zinc-800 border-zinc-700 text-emerald-600 focus:ring-0 cursor-pointer"
                  />
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* 4. MASTER VOCAL BUS PROCESSING (RUST DSP & AUDITION VO CHAIN)             */}
          {/* ========================================================================= */}
          {stepId === 'vocalBusProcessing' && (
            <div className="space-y-6">
              {/* Rack Mode Selector Tabs */}
              <div className="flex items-center justify-between p-1.5 bg-zinc-900 border border-zinc-800 rounded-xl">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      setBusRackMode('rustDsp');
                      handleUpdate({
                        vocalBusProcessing: { ...bus, mode: 'rustDsp', useRustDsp: true }
                      });
                    }}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all ${
                      busRackMode === 'rustDsp'
                        ? 'bg-gradient-to-r from-rose-600 to-amber-600 text-white shadow-md shadow-rose-900/30'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                    }`}
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>Студийный рэк Rust DSP (6 звеньев)</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-black/30 border border-white/10 font-mono">
                      Zero-Alloc
                    </span>
                  </button>

                  <button
                    onClick={() => {
                      setBusRackMode('vstRack');
                      handleUpdate({
                        vocalBusProcessing: { ...bus, mode: 'vstRack', useRustDsp: false }
                      });
                    }}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all ${
                      busRackMode === 'vstRack'
                        ? 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-md shadow-cyan-900/30'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                    }`}
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    <span>Пользовательский рэк VST-плагинов</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950/60 text-cyan-300 border border-cyan-500/30 font-mono">
                      {vstRack.plugins.filter(p => !p.bypass).length} в цепи
                    </span>
                  </button>
                </div>

                <div className="flex items-center gap-2 pr-2">
                  <span className="text-[11px] text-zinc-400">Мастер Bypass:</span>
                  <button
                    onClick={() => {
                      if (busRackMode === 'rustDsp') {
                        updateNativeRack('bypass', !nativeRack.bypass);
                      } else {
                        updateVstRack({ bypass: !vstRack.bypass });
                      }
                    }}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-mono font-bold transition-colors ${
                      (busRackMode === 'rustDsp' ? nativeRack.bypass : vstRack.bypass)
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    }`}
                  >
                    {(busRackMode === 'rustDsp' ? nativeRack.bypass : vstRack.bypass) ? 'BYPASS' : 'ACTIVE'}
                  </button>
                </div>
              </div>

              {/* VIEW 1: HIGH-PERFORMANCE RUST DSP 6-STAGE STUDIO RACK */}
              {busRackMode === 'rustDsp' && (
                <div className="space-y-4">
                  <div className="bg-rose-950/20 border border-rose-800/40 rounded-xl p-4 flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <Flame className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                      <div className="text-xs text-zinc-300 leading-relaxed">
                        <span className="font-semibold text-rose-300">Студийная цепочка обработки мастер-шины вокала (Rust DSP):</span><br />
                        Высокопроизводительный пакетный рэк для вокального микса: частотная хирургия HPF/Notch, деэссинг сибилянтов (5–8 кГц), аналоговое насыщение WaveShaper tanh, Opto-компрессия 3:1, воздушный гармонический шельф и истиннопиковый лимитер True-Peak.
                      </div>
                    </div>
                    <div className="px-2.5 py-1 rounded bg-rose-500/10 border border-rose-500/30 text-[11px] font-mono text-rose-300 shrink-0">
                      Rayon Parallel • 6 Stages
                    </div>
                  </div>

                  {/* Stage 1: HPF & Surgical EQ */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3.5 hover:border-zinc-700 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono font-bold text-rose-400 w-4">1</span>
                        <button
                          onClick={() => updateNativeRack('eq', { enabled: !nativeRack.eq.enabled })}
                          className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${nativeRack.eq.enabled ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <div>
                          <div className="text-xs font-bold text-white flex items-center gap-2">
                            <span>HPF & Surgical EQ</span>
                            <span className="text-[10px] text-zinc-500 font-mono">Biquad Direct-Form II</span>
                          </div>
                          <div className="text-[10px] text-zinc-400">Срез инфранизких частот и точечное вырезание корпусных резонансов микрофона</div>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                        HPF: {nativeRack.eq.hpfCutoffHz} Hz • Notch: {nativeRack.eq.notchFreqHz} Hz ({nativeRack.eq.notchGainDb} dB)
                      </span>
                    </div>

                    {nativeRack.eq.enabled && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-zinc-800/80">
                        <div className="space-y-3">
                          <div className="flex justify-between items-center">
                            <label className="text-[11px] text-zinc-300 font-medium">HPF Срез ({nativeRack.eq.hpfCutoffHz} Гц)</label>
                            <span className="text-[10px] font-mono text-zinc-400">{nativeRack.eq.hpfOrder === 4 ? '24 dB/oct (4th)' : '12 dB/oct (2nd)'}</span>
                          </div>
                          <input
                            type="range"
                            min="40"
                            max="160"
                            step="1"
                            value={nativeRack.eq.hpfCutoffHz}
                            onChange={(e) => updateNativeRack('eq', { hpfCutoffHz: parseInt(e.target.value) })}
                            className="w-full accent-rose-500"
                          />
                          <div className="flex items-center gap-3">
                            <span className="text-[10px] text-zinc-400">Крутизна среза:</span>
                            <button
                              onClick={() => updateNativeRack('eq', { hpfOrder: 2 })}
                              className={`px-2 py-0.5 rounded text-[10px] font-mono ${nativeRack.eq.hpfOrder === 2 ? 'bg-rose-500/30 text-rose-300 border border-rose-500/40' : 'bg-zinc-800 text-zinc-400'}`}
                            >
                              12 dB/oct
                            </button>
                            <button
                              onClick={() => updateNativeRack('eq', { hpfOrder: 4 })}
                              className={`px-2 py-0.5 rounded text-[10px] font-mono ${nativeRack.eq.hpfOrder === 4 ? 'bg-rose-500/30 text-rose-300 border border-rose-500/40' : 'bg-zinc-800 text-zinc-400'}`}
                            >
                              24 dB/oct
                            </button>
                          </div>
                        </div>

                        <div className="space-y-3 bg-zinc-950/40 p-3 rounded-lg border border-zinc-800/60">
                          <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={nativeRack.eq.notchEnabled}
                                onChange={(e) => updateNativeRack('eq', { notchEnabled: e.target.checked })}
                                className="w-3.5 h-3.5 rounded bg-zinc-800 border-zinc-700 text-rose-600 focus:ring-0 cursor-pointer"
                              />
                              <label className="text-[11px] text-zinc-300 font-medium">Surgical Notch ({nativeRack.eq.notchFreqHz} Гц)</label>
                            </div>
                            <span className="text-[10px] font-mono text-rose-400">{nativeRack.eq.notchGainDb} dB (Q={nativeRack.eq.notchQ})</span>
                          </div>
                          {nativeRack.eq.notchEnabled && (
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-[10px] text-zinc-400 block mb-1">Частота ({nativeRack.eq.notchFreqHz}Hz)</label>
                                <input
                                  type="range"
                                  min="800"
                                  max="6000"
                                  step="50"
                                  value={nativeRack.eq.notchFreqHz}
                                  onChange={(e) => updateNativeRack('eq', { notchFreqHz: parseInt(e.target.value) })}
                                  className="w-full accent-rose-500"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] text-zinc-400 block mb-1">Ослабление ({nativeRack.eq.notchGainDb}dB)</label>
                                <input
                                  type="range"
                                  min="-18"
                                  max="0"
                                  step="0.5"
                                  value={nativeRack.eq.notchGainDb}
                                  onChange={(e) => updateNativeRack('eq', { notchGainDb: parseFloat(e.target.value) })}
                                  className="w-full accent-rose-500"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Stage 2: Dynamic De-Esser */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3.5 hover:border-zinc-700 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono font-bold text-amber-400 w-4">2</span>
                        <button
                          onClick={() => updateNativeRack('deesser', { enabled: !nativeRack.deesser.enabled })}
                          className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${nativeRack.deesser.enabled ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <div>
                          <div className="text-xs font-bold text-white flex items-center gap-2">
                            <span>Dynamic De-Esser</span>
                            <span className="text-[10px] text-amber-400/80 font-mono">5–8 kHz Band</span>
                          </div>
                          <div className="text-[10px] text-zinc-400">Адаптивная компрессия сибилянтов («с», «ц», «щ», «ш») с Linkwitz-Riley кроссовером</div>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                        {nativeRack.deesser.frequencyHz} Hz • Thresh: {nativeRack.deesser.thresholdDb} dB • Ratio: {nativeRack.deesser.ratio}:1
                      </span>
                    </div>

                    {nativeRack.deesser.enabled && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-zinc-800/80">
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Центр сибилянтов ({nativeRack.deesser.frequencyHz} Гц)</label>
                          <input
                            type="range"
                            min="5000"
                            max="8500"
                            step="100"
                            value={nativeRack.deesser.frequencyHz}
                            onChange={(e) => updateNativeRack('deesser', { frequencyHz: parseInt(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Порог деэссинга ({nativeRack.deesser.thresholdDb} dBFS)</label>
                          <input
                            type="range"
                            min="-36"
                            max="-10"
                            step="0.5"
                            value={nativeRack.deesser.thresholdDb}
                            onChange={(e) => updateNativeRack('deesser', { thresholdDb: parseFloat(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Степень (Ratio {nativeRack.deesser.ratio}:1)</label>
                          <input
                            type="range"
                            min="2"
                            max="8"
                            step="0.5"
                            value={nativeRack.deesser.ratio}
                            onChange={(e) => updateNativeRack('deesser', { ratio: parseFloat(e.target.value) })}
                            className="w-full accent-amber-500"
                          />
                        </div>
                        <div className="sm:col-span-3 flex items-center justify-between text-[11px] text-zinc-400 pt-1">
                          <span>Атака: {nativeRack.deesser.attackMs} мс • Релиз: {nativeRack.deesser.releaseMs} мс</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px]">Режим:</span>
                            <button
                              onClick={() => updateNativeRack('deesser', { mode: 'splitBand' })}
                              className={`px-2 py-0.5 rounded text-[10px] ${nativeRack.deesser.mode === 'splitBand' ? 'bg-amber-500/30 text-amber-300 border border-amber-500/40' : 'bg-zinc-800 text-zinc-400'}`}
                            >
                              Split-Band
                            </button>
                            <button
                              onClick={() => updateNativeRack('deesser', { mode: 'wideband' })}
                              className={`px-2 py-0.5 rounded text-[10px] ${nativeRack.deesser.mode === 'wideband' ? 'bg-amber-500/30 text-amber-300 border border-amber-500/40' : 'bg-zinc-800 text-zinc-400'}`}
                            >
                              Wideband
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Stage 3: Warmth / Saturation */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3.5 hover:border-zinc-700 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono font-bold text-orange-400 w-4">3</span>
                        <button
                          onClick={() => updateNativeRack('saturation', { enabled: !nativeRack.saturation.enabled })}
                          className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${nativeRack.saturation.enabled ? 'bg-orange-500/20 text-orange-400 border border-orange-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <div>
                          <div className="text-xs font-bold text-white flex items-center gap-2">
                            <span>Warmth / Saturation</span>
                            <span className="text-[10px] text-orange-400/80 font-mono">Tanh WaveShaper</span>
                          </div>
                          <div className="text-[10px] text-zinc-400">Аналоговое насыщение с мягким тангенциальным клиппингом tanh без жесткого цифрового перегруза</div>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded border border-orange-500/20">
                        Drive: +{nativeRack.saturation.driveDb} dB • Blend: {Math.round(nativeRack.saturation.blend * 100)}%
                      </span>
                    </div>

                    {nativeRack.saturation.enabled && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-zinc-800/80">
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Drive (+{nativeRack.saturation.driveDb} dB)</label>
                          <input
                            type="range"
                            min="0"
                            max="10"
                            step="0.2"
                            value={nativeRack.saturation.driveDb}
                            onChange={(e) => updateNativeRack('saturation', { driveDb: parseFloat(e.target.value) })}
                            className="w-full accent-orange-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Dry/Wet Blend ({Math.round(nativeRack.saturation.blend * 100)}%)</label>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={nativeRack.saturation.blend}
                            onChange={(e) => updateNativeRack('saturation', { blend: parseFloat(e.target.value) })}
                            className="w-full accent-orange-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Warmth Bias (четные гармоники: {nativeRack.saturation.warmthBias})</label>
                          <input
                            type="range"
                            min="0"
                            max="0.35"
                            step="0.02"
                            value={nativeRack.saturation.warmthBias}
                            onChange={(e) => updateNativeRack('saturation', { warmthBias: parseFloat(e.target.value) })}
                            className="w-full accent-orange-500"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Stage 4: Vocal Compressor */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3.5 hover:border-zinc-700 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono font-bold text-emerald-400 w-4">4</span>
                        <button
                          onClick={() => updateNativeRack('compressor', { enabled: !nativeRack.compressor.enabled })}
                          className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${nativeRack.compressor.enabled ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <div>
                          <div className="text-xs font-bold text-white flex items-center gap-2">
                            <span>Vocal Compressor</span>
                            <span className="text-[10px] text-emerald-400/80 font-mono">Opto LA-2A / VCA</span>
                          </div>
                          <div className="text-[10px] text-zinc-400">Студийный компрессор вокала (Ratio 3:1, Attack 20ms, Release 120ms с мягким коленом)</div>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                        {nativeRack.compressor.ratio}:1 • Att: {nativeRack.compressor.attackMs}ms • Rel: {nativeRack.compressor.releaseMs}ms • Makeup: +{nativeRack.compressor.makeupGainDb}dB
                      </span>
                    </div>

                    {nativeRack.compressor.enabled && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-zinc-800/80">
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Порог ({nativeRack.compressor.thresholdDb} dB)</label>
                          <input
                            type="range"
                            min="-32"
                            max="-8"
                            step="0.5"
                            value={nativeRack.compressor.thresholdDb}
                            onChange={(e) => updateNativeRack('compressor', { thresholdDb: parseFloat(e.target.value) })}
                            className="w-full accent-emerald-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Ratio ({nativeRack.compressor.ratio}:1)</label>
                          <input
                            type="range"
                            min="1.5"
                            max="6"
                            step="0.2"
                            value={nativeRack.compressor.ratio}
                            onChange={(e) => updateNativeRack('compressor', { ratio: parseFloat(e.target.value) })}
                            className="w-full accent-emerald-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Attack ({nativeRack.compressor.attackMs} ms)</label>
                          <input
                            type="range"
                            min="5"
                            max="50"
                            step="1"
                            value={nativeRack.compressor.attackMs}
                            onChange={(e) => updateNativeRack('compressor', { attackMs: parseInt(e.target.value) })}
                            className="w-full accent-emerald-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Release ({nativeRack.compressor.releaseMs} ms)</label>
                          <input
                            type="range"
                            min="40"
                            max="250"
                            step="5"
                            value={nativeRack.compressor.releaseMs}
                            onChange={(e) => updateNativeRack('compressor', { releaseMs: parseInt(e.target.value) })}
                            className="w-full accent-emerald-500"
                          />
                        </div>
                        <div className="col-span-2 sm:col-span-4 flex items-center justify-between pt-1 border-t border-zinc-800/60 text-[11px] text-zinc-400">
                          <div className="flex items-center gap-3">
                            <span>Makeup Gain: +{nativeRack.compressor.makeupGainDb} dB</span>
                            <input
                              type="range"
                              min="0"
                              max="6"
                              step="0.5"
                              value={nativeRack.compressor.makeupGainDb}
                              onChange={(e) => updateNativeRack('compressor', { makeupGainDb: parseFloat(e.target.value) })}
                              className="w-24 accent-emerald-500"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px]">Баллистика Opto (T4):</span>
                            <input
                              type="checkbox"
                              checked={nativeRack.compressor.optoCharacter}
                              onChange={(e) => updateNativeRack('compressor', { optoCharacter: e.target.checked })}
                              className="w-3.5 h-3.5 rounded bg-zinc-800 border-zinc-700 text-emerald-600 focus:ring-0 cursor-pointer"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Stage 5: Presence Exciter / Air */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3.5 hover:border-zinc-700 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono font-bold text-cyan-400 w-4">5</span>
                        <button
                          onClick={() => updateNativeRack('exciter', { enabled: !nativeRack.exciter.enabled })}
                          className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${nativeRack.exciter.enabled ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <div>
                          <div className="text-xs font-bold text-white flex items-center gap-2">
                            <span>Presence Exciter / Air</span>
                            <span className="text-[10px] text-cyan-400/80 font-mono">&gt;10 kHz Air Shelf</span>
                          </div>
                          <div className="text-[10px] text-zinc-400">Шельфовый подъем выше 10 кГц (+2.5 dB) с генерацией четных гармоник воздуха</div>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
                        {nativeRack.exciter.airFreqHz / 1000} kHz • +{nativeRack.exciter.airGainDb} dB • Sheen: {Math.round(nativeRack.exciter.harmonicDrive * 100)}%
                      </span>
                    </div>

                    {nativeRack.exciter.enabled && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-zinc-800/80">
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Air Shelf Gain (+{nativeRack.exciter.airGainDb} dB)</label>
                          <input
                            type="range"
                            min="0"
                            max="5"
                            step="0.25"
                            value={nativeRack.exciter.airGainDb}
                            onChange={(e) => updateNativeRack('exciter', { airGainDb: parseFloat(e.target.value) })}
                            className="w-full accent-cyan-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Гармоники Sheen ({Math.round(nativeRack.exciter.harmonicDrive * 100)}%)</label>
                          <input
                            type="range"
                            min="0"
                            max="0.5"
                            step="0.05"
                            value={nativeRack.exciter.harmonicDrive}
                            onChange={(e) => updateNativeRack('exciter', { harmonicDrive: parseFloat(e.target.value) })}
                            className="w-full accent-cyan-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Air Blend ({Math.round(nativeRack.exciter.airBlend * 100)}%)</label>
                          <input
                            type="range"
                            min="0.2"
                            max="1"
                            step="0.05"
                            value={nativeRack.exciter.airBlend}
                            onChange={(e) => updateNativeRack('exciter', { airBlend: parseFloat(e.target.value) })}
                            className="w-full accent-cyan-500"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Stage 6: True-Peak Brickwall Limiter */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3.5 hover:border-zinc-700 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono font-bold text-violet-400 w-4">6</span>
                        <button
                          onClick={() => updateNativeRack('limiter', { enabled: !nativeRack.limiter.enabled })}
                          className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${nativeRack.limiter.enabled ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <div>
                          <div className="text-xs font-bold text-white flex items-center gap-2">
                            <span>True-Peak Brickwall Limiter</span>
                            <span className="text-[10px] text-violet-400/80 font-mono">-1.0 dBTP Ceiling</span>
                          </div>
                          <div className="text-[10px] text-zinc-400">Истиннопиковое ограничение для защиты от межсэмпловых искажений (ISP) при стриминге</div>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded border border-violet-500/20">
                        Ceiling: {nativeRack.limiter.ceilingDbtp} dBTP • Lookahead: {nativeRack.limiter.lookaheadMs} ms
                      </span>
                    </div>

                    {nativeRack.limiter.enabled && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-zinc-800/80">
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Ceiling ({nativeRack.limiter.ceilingDbtp} dBTP)</label>
                          <input
                            type="range"
                            min="-2.5"
                            max="-0.1"
                            step="0.1"
                            value={nativeRack.limiter.ceilingDbtp}
                            onChange={(e) => updateNativeRack('limiter', { ceilingDbtp: parseFloat(e.target.value) })}
                            className="w-full accent-violet-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Lookahead ({nativeRack.limiter.lookaheadMs} ms)</label>
                          <input
                            type="range"
                            min="0.5"
                            max="3.0"
                            step="0.1"
                            value={nativeRack.limiter.lookaheadMs}
                            onChange={(e) => updateNativeRack('limiter', { lookaheadMs: parseFloat(e.target.value) })}
                            className="w-full accent-violet-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400 block mb-1">Release ({nativeRack.limiter.releaseMs} ms)</label>
                          <input
                            type="range"
                            min="20"
                            max="150"
                            step="5"
                            value={nativeRack.limiter.releaseMs}
                            onChange={(e) => updateNativeRack('limiter', { releaseMs: parseInt(e.target.value) })}
                            className="w-full accent-violet-500"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* VIEW 2: CUSTOM VST PLUGIN RACK (VST2 / VST3 / AU) */}
              {busRackMode === 'vstRack' && (
                <VstPluginRack
                  vstRack={vstRack}
                  updateVstRack={updateVstRack}
                  updateVstSlot={updateVstSlot}
                  addVstSlot={addVstSlot}
                  removeVstSlot={removeVstSlot}
                  moveVstSlot={moveVstSlot}
                  scannedPlugins={scannedPlugins}
                  isScanning={isScanning}
                  scanMessage={scanMessage}
                  onScanPlugins={handleScanPlugins}
                  customPathInput={customPathInput}
                  setCustomPathInput={setCustomPathInput}
                  onSwitchToRustDsp={() => setBusRackMode('rustDsp')}
                />
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 flex items-center justify-between bg-zinc-900/60">
          <div className="text-xs text-zinc-400 flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-400" />
            <span>Параметры сохраняются автоматически в активный пресет</span>
          </div>

          <div className="flex items-center space-x-3">
            {hasRunHandler && (
              <button
                onClick={() => {
                  handleRun(stepId);
                  onClose();
                }}
                disabled={isRunning}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-2 shadow-lg shadow-purple-600/30 transition-all active:scale-95"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                {isRunning ? 'Выполняется...' : 'Выполнить и применить к дорожкам'}
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold transition-colors"
            >
              Готово
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
