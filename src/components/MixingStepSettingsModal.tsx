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
  FileText
} from 'lucide-react';
import { 
  Project, 
  MixingEffectsConfig, 
  AuditionVocalBusChainConfig,
  MixingType
} from '../types';

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
  const chain = bus.chain || {
    presetName: 'Audition Master VO Chain',
    ozoneStabilizer: { enabled: true, shape: 65, speed: 50, smoothness: 70, bypass: false },
    rCompressor: { enabled: true, threshold: -12.2, ratio: 4.7, attackMs: 149.6, releaseMs: 120, gainDb: 3.44, warmth: 60, bypass: false },
    soothe2: { enabled: true, depth: 5.27, sharpness: 3.31, selectivity: 4.07, band1Freq: 328.8, band1Sens: 5.94, band3Freq: 3489.5, band3Sens: 6.20, bypass: false },
    proQ4: { enabled: true, highPassFreq: 80, lowCutSlope: 12, airShelfFreq: 12000, airShelfGain: 1.5, notchResonanceFreq: 3200, notchCutDb: -2.0, bypass: false },
    rBass: { enabled: true, frequency: 43, intensity: 5.0, originalBassDb: -2.0, bypass: false },
    freshAir: { enabled: true, midAir: 24, highAir: 32, bypass: false },
    rVox: { enabled: true, compression: -9.5, gateThreshold: -80, gainDb: 0.0, bypass: false },
    proDS: { enabled: true, threshold: -24, range: -8, frequency: 10000, wideBand: true, bypass: false }
  };

  const updateChain = (slotKey: keyof AuditionVocalBusChainConfig, updates: any) => {
    const updatedChain = {
      ...chain,
      [slotKey]: typeof chain[slotKey] === 'object' ? { ...chain[slotKey], ...updates } : updates
    };
    handleUpdate({
      vocalBusProcessing: {
        ...bus,
        chain: updatedChain
      }
    });
  };

  const stepTitles = {
    gainMatching: '1. Соответствие громкости (Реплики vs Физика)',
    ducking: '2. Автодакинг оригинальных реплик',
    autoFxAnalysis: '3. Автоанализ и перенос эффектов оригинала',
    vocalBusProcessing: '4. Мастер-шина вокала (Audition VO Rack)'
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
          {/* 2. AUTO-DUCKING                                                          */}
          {/* ========================================================================= */}
          {stepId === 'ducking' && (
            <div className="space-y-6">
              <div className="bg-indigo-950/30 border border-indigo-800/40 rounded-xl p-4 flex items-start gap-3">
                <Info className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
                <div className="text-xs text-zinc-300 leading-relaxed">
                  <span className="font-semibold text-indigo-300">Логика автодакинга оригинального звука:</span><br />
                  • <strong className="text-white">Закадр (Voiceover):</strong> Оригинальный голос не понижается (0 dB), чтобы сохранять понятную речь оригинала на фоне.<br />
                  • <strong className="text-white">Рекаст и Дубляж:</strong> Разделенная дорожка оригинальных реплик автоматически приглушается на <strong className="text-indigo-400">-15...-18 dB</strong> во время наших реплик с плавными огибающими атаки и релиза.
                </div>
              </div>

              {/* Sliders Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-zinc-200">Глубина дакинга для Дубляжа (Dubbing)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="-30"
                        max="-6"
                        step="0.5"
                        value={duck.dubbingDuckingDb}
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
                    min="-30"
                    max="-6"
                    step="0.5"
                    value={duck.dubbingDuckingDb}
                    onChange={(e) => handleUpdate({
                      ducking: { ...duck, dubbingDuckingDb: parseFloat(e.target.value) }
                    })}
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                    <span>-30 dB (Глубокий)</span>
                    <span>-18 dB (Стандарт дубляжа)</span>
                    <span>-6 dB (Легкий)</span>
                  </div>
                </div>

                <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-zinc-200">Глубина дакинга для Рекаста (Recast)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="-26"
                        max="-6"
                        step="0.5"
                        value={duck.recastDuckingDb}
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
                    min="-26"
                    max="-6"
                    step="0.5"
                    value={duck.recastDuckingDb}
                    onChange={(e) => handleUpdate({
                      ducking: { ...duck, recastDuckingDb: parseFloat(e.target.value) }
                    })}
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-500 font-mono">
                    <span>-26 dB</span>
                    <span>-16 dB (Стандарт рекаста)</span>
                    <span>-6 dB</span>
                  </div>
                </div>
              </div>

              {/* Envelope timings */}
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-4">
                <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-wider">Параметры огибающей фейдов (Ducking Envelope)</h4>
                
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[11px] text-zinc-400">Атака (Attack ms)</label>
                    <input
                      type="number"
                      value={duck.attackMs}
                      onChange={(e) => handleUpdate({
                        ducking: { ...duck, attackMs: Math.max(5, parseInt(e.target.value) || 40) }
                      })}
                      className="w-full bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-200 rounded-lg p-2 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] text-zinc-400">Удержание (Hold ms)</label>
                    <input
                      type="number"
                      value={duck.holdMs}
                      onChange={(e) => handleUpdate({
                        ducking: { ...duck, holdMs: Math.max(0, parseInt(e.target.value) || 250) }
                      })}
                      className="w-full bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-200 rounded-lg p-2 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] text-zinc-400">Восстановление (Release ms)</label>
                    <input
                      type="number"
                      value={duck.releaseMs}
                      onChange={(e) => handleUpdate({
                        ducking: { ...duck, releaseMs: Math.max(50, parseInt(e.target.value) || 300) }
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
                  <span className="font-semibold text-emerald-300">Алгоритмический анализ и перенос эффектов:</span><br />
                  Нейро-алгоритм сканирует оригинальные реплики на наличие акустических пространств (реверб, комната, холл, дилей) и спецэффектов (<strong className="text-white">телефон, радиостанция, ТВ-экран, робот/вокодер, рупор/мегафон</strong>), после чего автоматически применяет соответствующие параметры к дорожкам дубляжа.
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
          {/* 4. MASTER VOCAL BUS PROCESSING (AUDITION VO CHAIN RACK)                  */}
          {/* ========================================================================= */}
          {stepId === 'vocalBusProcessing' && (
            <div className="space-y-6">
              <div className="bg-rose-950/30 border border-rose-800/40 rounded-xl p-4 flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Flame className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                  <div className="text-xs text-zinc-300 leading-relaxed">
                    <span className="font-semibold text-rose-300">Цепочка мастер-шины вокала (Adobe Audition VO Bus):</span><br />
                    Полный рэк из 8 профессиональных плагинов с точной калибровкой параметров для кристального, плотного и читаемого звучания всех голосов.
                  </div>
                </div>
                <div className="px-2.5 py-1 rounded bg-rose-500/10 border border-rose-500/30 text-[11px] font-mono text-rose-300 shrink-0">
                  Track: VO (8 Slots)
                </div>
              </div>

              {/* 8-Slots Virtual VST Rack */}
              <div className="space-y-3">
                {/* Slot 1: Ozone 11 Stabilizer */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3 hover:border-zinc-700 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono font-bold text-zinc-500 w-4">1</span>
                      <button
                        onClick={() => updateChain('ozoneStabilizer', { enabled: !chain.ozoneStabilizer.enabled })}
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${chain.ozoneStabilizer.enabled ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                      <div>
                        <div className="text-xs font-bold text-white">Ozone 11 Stabilizer</div>
                        <div className="text-[10px] text-zinc-400">Динамическая спектральная стабилизация тона</div>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                      Shape {chain.ozoneStabilizer.shape}% • Speed {chain.ozoneStabilizer.speed}%
                    </span>
                  </div>
                  {chain.ozoneStabilizer.enabled && (
                    <div className="grid grid-cols-3 gap-3 pt-2 border-t border-zinc-800/80">
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Shape</label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={chain.ozoneStabilizer.shape}
                          onChange={(e) => updateChain('ozoneStabilizer', { shape: parseInt(e.target.value) })}
                          className="w-full accent-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Speed</label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={chain.ozoneStabilizer.speed}
                          onChange={(e) => updateChain('ozoneStabilizer', { speed: parseInt(e.target.value) })}
                          className="w-full accent-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Smoothness</label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={chain.ozoneStabilizer.smoothness}
                          onChange={(e) => updateChain('ozoneStabilizer', { smoothness: parseInt(e.target.value) })}
                          className="w-full accent-emerald-500"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Slot 2: RCompressor Stereo */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3 hover:border-zinc-700 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono font-bold text-zinc-500 w-4">2</span>
                      <button
                        onClick={() => updateChain('rCompressor', { enabled: !chain.rCompressor.enabled })}
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${chain.rCompressor.enabled ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                      <div>
                        <div className="text-xs font-bold text-white">RCompressor Stereo (Waves)</div>
                        <div className="text-[10px] text-zinc-400">Аналоговая оптическая компрессия голоса</div>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
                      Thresh: {chain.rCompressor.threshold} dB • Ratio: {chain.rCompressor.ratio}:1
                    </span>
                  </div>
                  {chain.rCompressor.enabled && (
                    <div className="grid grid-cols-4 gap-3 pt-2 border-t border-zinc-800/80">
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Threshold ({chain.rCompressor.threshold}dB)</label>
                        <input
                          type="range"
                          min="-36"
                          max="0"
                          step="0.5"
                          value={chain.rCompressor.threshold}
                          onChange={(e) => updateChain('rCompressor', { threshold: parseFloat(e.target.value) })}
                          className="w-full accent-indigo-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Ratio ({chain.rCompressor.ratio}:1)</label>
                        <input
                          type="range"
                          min="1"
                          max="10"
                          step="0.1"
                          value={chain.rCompressor.ratio}
                          onChange={(e) => updateChain('rCompressor', { ratio: parseFloat(e.target.value) })}
                          className="w-full accent-indigo-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Attack ({chain.rCompressor.attackMs}ms)</label>
                        <input
                          type="range"
                          min="1"
                          max="300"
                          value={chain.rCompressor.attackMs}
                          onChange={(e) => updateChain('rCompressor', { attackMs: parseFloat(e.target.value) })}
                          className="w-full accent-indigo-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Release ({chain.rCompressor.releaseMs}ms)</label>
                        <input
                          type="range"
                          min="20"
                          max="500"
                          value={chain.rCompressor.releaseMs}
                          onChange={(e) => updateChain('rCompressor', { releaseMs: parseFloat(e.target.value) })}
                          className="w-full accent-indigo-500"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Slot 3: soothe2_x64 */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3 hover:border-zinc-700 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono font-bold text-zinc-500 w-4">3</span>
                      <button
                        onClick={() => updateChain('soothe2', { enabled: !chain.soothe2.enabled })}
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${chain.soothe2.enabled ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                      <div>
                        <div className="text-xs font-bold text-white">soothe2_x64 (Oeksound)</div>
                        <div className="text-[10px] text-zinc-400">Динамическое подавление резких резонансов и грязи</div>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
                      Depth: {chain.soothe2.depth} • Sharpness: {chain.soothe2.sharpness}
                    </span>
                  </div>
                  {chain.soothe2.enabled && (
                    <div className="grid grid-cols-4 gap-3 pt-2 border-t border-zinc-800/80">
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Depth ({chain.soothe2.depth})</label>
                        <input
                          type="range"
                          min="0"
                          max="10"
                          step="0.1"
                          value={chain.soothe2.depth}
                          onChange={(e) => updateChain('soothe2', { depth: parseFloat(e.target.value) })}
                          className="w-full accent-cyan-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Sharpness ({chain.soothe2.sharpness})</label>
                        <input
                          type="range"
                          min="0"
                          max="10"
                          step="0.1"
                          value={chain.soothe2.sharpness}
                          onChange={(e) => updateChain('soothe2', { sharpness: parseFloat(e.target.value) })}
                          className="w-full accent-cyan-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Band 1 Res ({chain.soothe2.band1Freq}Hz)</label>
                        <input
                          type="range"
                          min="100"
                          max="800"
                          value={chain.soothe2.band1Freq}
                          onChange={(e) => updateChain('soothe2', { band1Freq: parseFloat(e.target.value) })}
                          className="w-full accent-cyan-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Band 3 Harsh ({chain.soothe2.band3Freq}Hz)</label>
                        <input
                          type="range"
                          min="2000"
                          max="6000"
                          value={chain.soothe2.band3Freq}
                          onChange={(e) => updateChain('soothe2', { band3Freq: parseFloat(e.target.value) })}
                          className="w-full accent-cyan-500"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Slot 4: Pro-Q 4 */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3 hover:border-zinc-700 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono font-bold text-zinc-500 w-4">4</span>
                      <button
                        onClick={() => updateChain('proQ4', { enabled: !chain.proQ4.enabled })}
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${chain.proQ4.enabled ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                      <div>
                        <div className="text-xs font-bold text-white">Pro-Q 4 (FabFilter)</div>
                        <div className="text-[10px] text-zinc-400">Хирургический вокальный эквалайзер и High-Pass</div>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">
                      HP: {chain.proQ4.highPassFreq}Hz • Air: +{chain.proQ4.airShelfGain}dB
                    </span>
                  </div>
                  {chain.proQ4.enabled && (
                    <div className="grid grid-cols-3 gap-3 pt-2 border-t border-zinc-800/80">
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">High-Pass Cutoff ({chain.proQ4.highPassFreq}Hz)</label>
                        <input
                          type="range"
                          min="40"
                          max="160"
                          value={chain.proQ4.highPassFreq}
                          onChange={(e) => updateChain('proQ4', { highPassFreq: parseInt(e.target.value) })}
                          className="w-full accent-purple-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Air Shelf Gain (+{chain.proQ4.airShelfGain}dB)</label>
                        <input
                          type="range"
                          min="-3"
                          max="6"
                          step="0.5"
                          value={chain.proQ4.airShelfGain}
                          onChange={(e) => updateChain('proQ4', { airShelfGain: parseFloat(e.target.value) })}
                          className="w-full accent-purple-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Notch Cut ({chain.proQ4.notchCutDb}dB @ {chain.proQ4.notchResonanceFreq}Hz)</label>
                        <input
                          type="range"
                          min="-6"
                          max="0"
                          step="0.5"
                          value={chain.proQ4.notchCutDb}
                          onChange={(e) => updateChain('proQ4', { notchCutDb: parseFloat(e.target.value) })}
                          className="w-full accent-purple-500"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Slot 5: RBass Stereo */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3 hover:border-zinc-700 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono font-bold text-zinc-500 w-4">5</span>
                      <button
                        onClick={() => updateChain('rBass', { enabled: !chain.rBass.enabled })}
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${chain.rBass.enabled ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                      <div>
                        <div className="text-xs font-bold text-white">RBass Stereo (Waves)</div>
                        <div className="text-[10px] text-zinc-400">Генератор субгармоник для бархатности и тела голоса</div>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                      Freq: {chain.rBass.frequency} Hz • Int: {chain.rBass.intensity}
                    </span>
                  </div>
                  {chain.rBass.enabled && (
                    <div className="grid grid-cols-2 gap-3 pt-2 border-t border-zinc-800/80">
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Target Freq ({chain.rBass.frequency}Hz)</label>
                        <input
                          type="range"
                          min="32"
                          max="90"
                          value={chain.rBass.frequency}
                          onChange={(e) => updateChain('rBass', { frequency: parseInt(e.target.value) })}
                          className="w-full accent-amber-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Intensity ({chain.rBass.intensity})</label>
                        <input
                          type="range"
                          min="0"
                          max="20"
                          step="0.5"
                          value={chain.rBass.intensity}
                          onChange={(e) => updateChain('rBass', { intensity: parseFloat(e.target.value) })}
                          className="w-full accent-amber-500"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Slot 6: Fresh Air */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3 hover:border-zinc-700 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono font-bold text-zinc-500 w-4">6</span>
                      <button
                        onClick={() => updateChain('freshAir', { enabled: !chain.freshAir.enabled })}
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${chain.freshAir.enabled ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                      <div>
                        <div className="text-xs font-bold text-white">Fresh Air (Slate Digital)</div>
                        <div className="text-[10px] text-zinc-400">Прозрачность, презенс и сияние верхнего диапазона</div>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-teal-400 bg-teal-500/10 px-2 py-0.5 rounded border border-teal-500/20">
                      Mid Air: {chain.freshAir.midAir}% • High Air: {chain.freshAir.highAir}%
                    </span>
                  </div>
                  {chain.freshAir.enabled && (
                    <div className="grid grid-cols-2 gap-3 pt-2 border-t border-zinc-800/80">
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Mid Air ({chain.freshAir.midAir}%)</label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={chain.freshAir.midAir}
                          onChange={(e) => updateChain('freshAir', { midAir: parseInt(e.target.value) })}
                          className="w-full accent-teal-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">High Air ({chain.freshAir.highAir}%)</label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={chain.freshAir.highAir}
                          onChange={(e) => updateChain('freshAir', { highAir: parseInt(e.target.value) })}
                          className="w-full accent-teal-500"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Slot 7: RVox Stereo */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3 hover:border-zinc-700 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono font-bold text-zinc-500 w-4">7</span>
                      <button
                        onClick={() => updateChain('rVox', { enabled: !chain.rVox.enabled })}
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${chain.rVox.enabled ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                      <div>
                        <div className="text-xs font-bold text-white">RVox Stereo (Waves)</div>
                        <div className="text-[10px] text-zinc-400">Быстрый вокальный компрессор для плотности в миксе</div>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                      Comp: {chain.rVox.compression} dB
                    </span>
                  </div>
                  {chain.rVox.enabled && (
                    <div className="grid grid-cols-2 gap-3 pt-2 border-t border-zinc-800/80">
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Compression ({chain.rVox.compression}dB)</label>
                        <input
                          type="range"
                          min="-24"
                          max="0"
                          step="0.5"
                          value={chain.rVox.compression}
                          onChange={(e) => updateChain('rVox', { compression: parseFloat(e.target.value) })}
                          className="w-full accent-rose-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Gate Threshold ({chain.rVox.gateThreshold}dB)</label>
                        <input
                          type="range"
                          min="-80"
                          max="-30"
                          value={chain.rVox.gateThreshold}
                          onChange={(e) => updateChain('rVox', { gateThreshold: parseInt(e.target.value) })}
                          className="w-full accent-rose-500"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Slot 8: Pro-DS */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3 hover:border-zinc-700 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono font-bold text-zinc-500 w-4">8</span>
                      <button
                        onClick={() => updateChain('proDS', { enabled: !chain.proDS.enabled })}
                        className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${chain.proDS.enabled ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-zinc-800 text-zinc-600 border border-zinc-700'}`}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                      <div>
                        <div className="text-xs font-bold text-white">Pro-DS (FabFilter)</div>
                        <div className="text-[10px] text-zinc-400">Интеллектуальный деэссер сибилянтов (Classic 10k Wide Band)</div>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                      Thresh: {chain.proDS.threshold} dB • Range: {chain.proDS.range} dB
                    </span>
                  </div>
                  {chain.proDS.enabled && (
                    <div className="grid grid-cols-2 gap-3 pt-2 border-t border-zinc-800/80">
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Threshold ({chain.proDS.threshold}dB)</label>
                        <input
                          type="range"
                          min="-40"
                          max="0"
                          step="0.5"
                          value={chain.proDS.threshold}
                          onChange={(e) => updateChain('proDS', { threshold: parseFloat(e.target.value) })}
                          className="w-full accent-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-zinc-400 block mb-1">Range ({chain.proDS.range}dB)</label>
                        <input
                          type="range"
                          min="-18"
                          max="0"
                          step="0.5"
                          value={chain.proDS.range}
                          onChange={(e) => updateChain('proDS', { range: parseFloat(e.target.value) })}
                          className="w-full accent-emerald-500"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
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
