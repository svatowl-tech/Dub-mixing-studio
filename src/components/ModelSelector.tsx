import React, { useState, useEffect } from 'react';
import { Download, CheckCircle2, AlertTriangle, Loader2, HardDrive } from 'lucide-react';
import { AIModelService, ModelCatalogItem, ModelCategory, ModelDownloadProgress } from '../services/aiModelService';

export interface BuiltInOption {
  id: string;
  name: string;
  description?: string;
}

interface ModelSelectorProps {
  category: ModelCategory;
  value: string;
  onChange: (val: string) => void;
  builtInOptions?: BuiltInOption[];
  className?: string;
  label?: string;
  disabled?: boolean;
  onOpenModelManager?: () => void;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  category,
  value,
  onChange,
  builtInOptions = [],
  className = '',
  label,
  disabled = false,
  onOpenModelManager
}) => {
  const [models, setModels] = useState<ModelCatalogItem[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [customUrl, setCustomUrl] = useState('');
  const [showCustomUrlInput, setShowCustomUrlInput] = useState(false);

  useEffect(() => {
    const service = AIModelService.getInstance();
    const unsubscribe = service.subscribe((allModels) => {
      const catModels = allModels.filter(m => m.category === category);
      setModels(catModels);
    });
    return () => unsubscribe();
  }, [category]);

  const service = AIModelService.getInstance();
  const selectedModelInfo = service.getModelInfo(value);
  const isInstalled = service.isModelInstalled(value);

  // Is current selected value a neural model requiring download?
  const isBuiltInSelected = builtInOptions.some(b => b.id === value) || value === 'fast_dsp_splitter' || value === 'spectral_gate' || value === 'rt_dereverb_v2';
  const needsDownload = !isBuiltInSelected && selectedModelInfo && !isInstalled;

  useEffect(() => {
    if (selectedModelInfo) {
      const prog = service.getDownloadProgress(selectedModelInfo.id);
      if (prog) {
        setDownloadProgress(prog);
        if (prog.status === 'downloading' || prog.status === 'starting') {
          setDownloading(true);
        } else if (prog.status === 'completed') {
          setDownloading(false);
        }
      }
    }
  }, [value, selectedModelInfo]);

  const handleDownload = async (overrideUrl?: string) => {
    if (!selectedModelInfo) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await service.downloadModel(selectedModelInfo.id, overrideUrl || (customUrl.trim() ? customUrl.trim() : undefined));
      setShowCustomUrlInput(false);
      setCustomUrl('');
    } catch (err: any) {
      setDownloadError(err?.message || 'Ошибка загрузки модели');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className={`w-full ${className}`}>
      {label && (
        <label className="block text-xs font-semibold text-slate-300 mb-1.5">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={`w-full bg-slate-900/90 border text-xs text-slate-100 rounded-lg px-3 py-2 pr-8 outline-none focus:ring-1 focus:ring-teal-500 transition-all ${
            needsDownload
              ? 'border-amber-500/60 bg-amber-950/20 text-amber-200'
              : isInstalled && !isBuiltInSelected
              ? 'border-emerald-500/40'
              : 'border-slate-700'
          }`}
        >
          {builtInOptions.length > 0 && (
            <optgroup label="⚡ Встроенные DSP (Бесплатно / Без загрузки)">
              {builtInOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  ⚡ {opt.name} (Встроен)
                </option>
              ))}
            </optgroup>
          )}

          <optgroup label="🧠 Нейросети AI (Требуют загрузки)">
            {models.map((m) => {
              const installed = service.isModelInstalled(m.id) || service.isModelInstalled(m.filename);
              return (
                <option key={m.id} value={m.id}>
                  {installed ? '✓' : '🔒'} {m.name} {installed ? '(Установлена)' : `(Не скачана - ${m.size_mb} МБ)`}
                </option>
              );
            })}
          </optgroup>
        </select>
      </div>

      {/* Inline Download Bar if uninstalled neural model selected */}
      {needsDownload && selectedModelInfo && (
        <div className="mt-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex flex-col gap-2 transition-all animate-fadeIn">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="truncate font-medium">
                Модель <span className="underline">{selectedModelInfo.name}</span> не скачана ({selectedModelInfo.size_mb} МБ)
              </span>
            </div>
            <button
              type="button"
              onClick={() => handleDownload()}
              disabled={downloading}
              className="px-3 py-1 rounded-md bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs transition flex items-center gap-1.5 shrink-0 shadow-sm"
            >
              {downloading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Скачивание...</span>
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" />
                  <span>Скачать {selectedModelInfo.size_mb} МБ</span>
                </>
              )}
            </button>
          </div>

          {downloading && downloadProgress && (
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] text-amber-300">
                <span>{downloadProgress.status === 'verifying' ? 'Проверка...' : 'Загрузка весов модели...'}</span>
                <span>{Math.round(downloadProgress.percent)}%</span>
              </div>
              <div className="w-full bg-slate-900/80 h-1.5 rounded-full overflow-hidden border border-amber-500/20">
                <div
                  className="bg-gradient-to-r from-amber-500 to-emerald-400 h-full transition-all duration-300"
                  style={{ width: `${Math.max(3, downloadProgress.percent)}%` }}
                />
              </div>
            </div>
          )}

          {downloadError && (
            <div className="flex flex-col gap-2 pt-1 border-t border-amber-500/20 text-[11px]">
              <div className="text-rose-400 font-medium leading-tight">
                ❌ {downloadError}
              </div>

              {showCustomUrlInput ? (
                <div className="flex items-center gap-1.5 mt-1">
                  <input
                    type="url"
                    placeholder="Вставьте ссылку на зеркало или .onnx / .pth..."
                    value={customUrl}
                    onChange={(e) => setCustomUrl(e.target.value)}
                    className="flex-1 bg-slate-900 border border-amber-500/40 rounded px-2 py-1 text-xs text-white placeholder-slate-500"
                  />
                  <button
                    type="button"
                    onClick={() => handleDownload()}
                    className="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded text-xs shrink-0"
                  >
                    Скачать
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCustomUrlInput(false)}
                    className="px-2 py-1 bg-slate-800 text-slate-400 rounded text-xs"
                  >
                    Отмена
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-[10px]">
                  <button
                    type="button"
                    onClick={() => setShowCustomUrlInput(true)}
                    className="text-amber-300 hover:underline font-medium"
                  >
                    🔗 Указать своё зеркало / ссылку
                  </button>
                  {onOpenModelManager && (
                    <>
                      <span className="text-slate-600">•</span>
                      <button
                        type="button"
                        onClick={onOpenModelManager}
                        className="text-cyan-300 hover:underline font-medium"
                      >
                        ⚙️ Менеджер моделей
                      </button>
                    </>
                  )}
                  {builtInOptions.length > 0 && (
                    <>
                      <span className="text-slate-600">•</span>
                      <button
                        type="button"
                        onClick={() => onChange(builtInOptions[0].id)}
                        className="text-emerald-400 hover:underline font-medium"
                      >
                        ⚡ Использовать встроенный DSP ({builtInOptions[0].name})
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Success indicator when installed */}
      {!isBuiltInSelected && isInstalled && selectedModelInfo && (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>Модель установлена и готова к работе ({selectedModelInfo.size_mb} МБ)</span>
        </div>
      )}
    </div>
  );
};
