import React, { useState, useEffect, useMemo } from 'react';
import {
  aiModelService,
  ModelCatalogItem,
  ModelCategory,
  ModelDownloadProgress
} from '../services/aiModelService';
import {
  Download,
  Trash2,
  FolderOpen,
  RefreshCw,
  Search,
  CheckCircle2,
  AlertCircle,
  HardDrive,
  ExternalLink,
  Layers,
  Sparkles,
  Waves,
  Sliders,
  FileAudio,
  XCircle,
  Link,
  Info
} from 'lucide-react';

interface ModelManagerProps {
  onClose?: () => void;
  filterCategory?: ModelCategory;
}

export const ModelManager: React.FC<ModelManagerProps> = ({ onClose, filterCategory }) => {
  const [models, setModels] = useState<ModelCatalogItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>(filterCategory || 'all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [customUrlModelId, setCustomUrlModelId] = useState<string | null>(null);
  const [customUrlInput, setCustomUrlInput] = useState<string>('');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [activeDownloads, setActiveDownloads] = useState<Record<string, ModelDownloadProgress>>({});
  const [openedLinksModelId, setOpenedLinksModelId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = aiModelService.subscribe((updated) => {
      setModels(updated);
      // Сбор активных прогрессов
      const progresses: Record<string, ModelDownloadProgress> = {};
      for (const m of updated) {
        const prog = aiModelService.getDownloadProgress(m.id);
        if (prog && prog.status === 'downloading') {
          progresses[m.id] = prog;
        }
      }
      setActiveDownloads(progresses);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await aiModelService.refreshModels();
    setIsRefreshing(false);
    showToast('Статусы локальных моделей обновлены');
  };

  const handleOpenFolder = async () => {
    const path = await aiModelService.openModelsDirectory();
    showToast(path ? `Открыта папка: ${path}` : 'Папка открыта в проводнике');
  };

  const handleStartDownload = async (model: ModelCatalogItem, customUrl?: string) => {
    try {
      showToast(`Начата загрузка ${model.name}...`);
      await aiModelService.downloadModel(model.id, customUrl);
      showToast(`Модель ${model.name} успешно установлена!`);
    } catch (e: any) {
      showToast(`Ошибка загрузки: ${e?.message || e}`);
    }
  };

  const handleCancelDownload = async (modelId: string) => {
    await aiModelService.cancelDownload(modelId);
    showToast('Загрузка отменена');
  };

  const handleDeleteModel = async (model: ModelCatalogItem) => {
    if (confirm(`Удалить файл модели '${model.filename}' с диска?`)) {
      await aiModelService.deleteModel(model.filename);
      showToast(`Модель ${model.name} удалена с диска`);
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 3500);
  };

  const categories: { id: string; label: string; icon: any }[] = [
    { id: 'all', label: 'Все модели', icon: Layers },
    { id: 'separation', label: 'Изоляция вокала / стемы', icon: Waves },
    { id: 'dereverb', label: 'Удаление реверберации', icon: Sparkles },
    { id: 'denoise', label: 'Шумоподавление', icon: Sliders },
    { id: 'whisper', label: 'Whisper (Транскрибация)', icon: FileAudio },
    { id: 'vocal_match', label: 'EQ Matching / Подгонка вокала', icon: Sparkles }
  ];

  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      const matchCategory = selectedCategory === 'all' || m.category === selectedCategory;
      const q = searchQuery.toLowerCase();
      const matchSearch =
        !q ||
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.filename.toLowerCase().includes(q) ||
        m.recommended_for.toLowerCase().includes(q);
      return matchCategory && matchSearch;
    });
  }, [models, selectedCategory, searchQuery]);

  // Статистика
  const stats = useMemo(() => {
    const total = models.length;
    const installed = models.filter((m) => m.is_installed).length;
    const totalInstalledMb = models
      .filter((m) => m.is_installed)
      .reduce((sum, m) => sum + (m.installed_bytes ? m.installed_bytes / (1024 * 1024) : m.size_mb), 0);

    return { total, installed, totalInstalledMb: totalInstalledMb.toFixed(1) };
  }, [models]);

  return (
    <div className="flex flex-col h-full bg-[#12141a] text-slate-100 rounded-xl overflow-hidden shadow-2xl border border-slate-800">
      {/* Верхний заголовок и панель инструментов */}
      <div className="p-4 bg-[#181b24] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-indigo-400" />
            <h2 className="text-lg font-bold text-white tracking-wide">
              Менеджер нейросетевых моделей AI
            </h2>
            <span className="text-xs bg-indigo-950 text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-700/50">
              По требованию
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Модели хранятся локально на вашем ПК и не утяжеляют дистрибутив. Если модель не скачана, шаг пропускается или работает быстрый DSP фоллбэк.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenFolder}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-lg border border-slate-700 transition"
            title="Открыть системную папку хранения моделей"
          >
            <FolderOpen className="w-4 h-4 text-amber-400" />
            <span>Папка моделей</span>
          </button>

          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-lg border border-slate-700 transition"
            title="Пересканировать наличие моделей на диске"
          >
            <RefreshCw className={`w-4 h-4 text-cyan-400 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>Обновить</span>
          </button>
        </div>
      </div>

      {/* Информационная плашка статистики */}
      <div className="px-4 py-2 bg-[#151720] border-b border-slate-800/80 flex items-center justify-between text-xs text-slate-300">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1">
            <span className="text-slate-400">Установлено моделей:</span>
            <span className="font-semibold text-emerald-400">
              {stats.installed} из {stats.total}
            </span>
          </span>
          <span className="text-slate-600">•</span>
          <span className="flex items-center gap-1">
            <span className="text-slate-400">Использовано диска:</span>
            <span className="font-semibold text-indigo-300">{stats.totalInstalledMb} МБ</span>
          </span>
        </div>

        {toastMessage && (
          <span className="text-xs bg-indigo-500/20 text-indigo-200 px-2 py-0.5 rounded border border-indigo-500/40 animate-pulse">
            {toastMessage}
          </span>
        )}
      </div>

      {/* Фильтры по категориям и поиск */}
      <div className="p-3 bg-[#14161f] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 overflow-x-auto max-w-full pb-1 sm:pb-0">
          {categories.map((cat) => {
            const Icon = cat.icon;
            const isSelected = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition ${
                  isSelected
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-slate-800/60 hover:bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>

        <div className="relative min-w-[220px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск модели по названию..."
            className="w-full bg-[#1c1f2b] border border-slate-700/80 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
          />
        </div>
      </div>

      {/* Список моделей */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {filteredModels.length === 0 ? (
          <div className="py-12 text-center text-slate-500 text-sm">
            Модели, соответствующие выбранным фильтрам, не найдены
          </div>
        ) : (
          filteredModels.map((model) => {
            const progress = activeDownloads[model.id] || aiModelService.getDownloadProgress(model.id);
            const isDownloading = progress && progress.status === 'downloading';
            const showCustomUrl = customUrlModelId === model.id;
            const showLinks = openedLinksModelId === model.id;

            return (
              <div
                key={model.id}
                className={`p-3.5 rounded-xl border transition-all ${
                  model.is_installed
                    ? 'bg-[#181c27] border-emerald-900/40 hover:border-emerald-700/50'
                    : 'bg-[#161822] border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
                  {/* Описание модели */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-white">{model.name}</span>

                      {/* Бейдж категории */}
                      <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                        {model.category}
                      </span>

                      {/* Бейдж размера */}
                      <span className="text-xs text-slate-400">
                        ~{model.size_mb.toFixed(1)} МБ
                      </span>

                      {/* Статус наличия */}
                      {model.is_installed ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/50">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Установлена на диск</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded">
                          <span>Не скачана</span>
                        </span>
                      )}
                    </div>

                    {/* Описание */}
                    <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                      {model.description}
                    </p>

                    {/* Рекомендация */}
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-300/90">
                      <Info className="w-3 h-3 flex-shrink-0" />
                      <span>{model.recommended_for}</span>
                    </div>

                    <div className="mt-1 text-[11px] font-mono text-slate-500">
                      Файл: {model.filename}
                    </div>
                  </div>

                  {/* Кнопки действий */}
                  <div className="flex flex-wrap md:flex-col items-end gap-2 shrink-0">
                    {model.is_installed ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleDeleteModel(model)}
                          className="flex items-center gap-1 px-2.5 py-1.5 bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 text-xs rounded-lg border border-rose-800/40 transition"
                          title="Удалить файл модели для освобождения места"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Удалить</span>
                        </button>
                      </div>
                    ) : isDownloading ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleCancelDownload(model.id)}
                          className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-950/40 hover:bg-amber-900/60 text-amber-300 text-xs rounded-lg border border-amber-800/40 transition"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          <span>Отмена</span>
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleStartDownload(model)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs rounded-lg shadow-sm transition"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Скачать ({model.size_mb.toFixed(0)} МБ)</span>
                        </button>

                        <button
                          onClick={() =>
                            setCustomUrlModelId(showCustomUrl ? null : model.id)
                          }
                          className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition"
                          title="Указать свою ссылку или зеркало"
                        >
                          <Link className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}

                    <button
                      onClick={() =>
                        setOpenedLinksModelId(showLinks ? null : model.id)
                      }
                      className="text-[11px] text-slate-400 hover:text-slate-200 underline flex items-center gap-1"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>{showLinks ? 'Скрыть ссылки' : 'Ссылки на модель'}</span>
                    </button>
                  </div>
                </div>

                {/* Прогресс-бар скачивания */}
                {isDownloading && (
                  <div className="mt-3 pt-2.5 border-t border-slate-800">
                    <div className="flex justify-between text-xs text-slate-300 mb-1">
                      <span>Загрузка модели с зеркала...</span>
                      <span className="font-semibold text-indigo-400">
                        {progress.percent.toFixed(1)}% (
                        {(progress.downloaded_bytes / (1024 * 1024)).toFixed(1)} /{' '}
                        {(progress.total_bytes / (1024 * 1024)).toFixed(1)} МБ)
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-300 rounded-full"
                        style={{ width: `${progress.percent}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Поле для ввода своей ссылки */}
                {showCustomUrl && (
                  <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center gap-2">
                    <input
                      type="url"
                      placeholder="Вставьте прямую ссылку на .onnx / .ckpt / .pth / .bin..."
                      value={customUrlInput}
                      onChange={(e) => setCustomUrlInput(e.target.value)}
                      className="flex-1 bg-[#12141c] border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                    />
                    <button
                      onClick={() => {
                        handleStartDownload(model, customUrlInput);
                        setCustomUrlModelId(null);
                        setCustomUrlInput('');
                      }}
                      className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg transition"
                    >
                      Скачать по ссылке
                    </button>
                    <button
                      onClick={() => setCustomUrlModelId(null)}
                      className="px-2 py-1 bg-slate-800 text-slate-400 hover:text-slate-200 text-xs rounded-lg"
                    >
                      Отмена
                    </button>
                  </div>
                )}

                {/* Выпадающий список прямых ссылок */}
                {showLinks && (
                  <div className="mt-2.5 p-2 bg-[#12141a] rounded-lg border border-slate-800/80 text-[11px] space-y-1">
                    <div className="text-slate-400 font-medium">Официальные репозитории и зеркала:</div>
                    {model.urls.map((url, idx) => (
                      <div key={idx} className="flex items-center justify-between gap-2 overflow-hidden">
                        <span className="font-mono text-slate-300 truncate select-all">{url}</span>
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-indigo-400 hover:underline shrink-0 flex items-center gap-0.5"
                        >
                          <span>Открыть</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Нижняя информационная панель */}
      <div className="p-3 bg-[#181b24] border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-slate-500" />
          <span>
            Модели сохраняются в папку пользователя и переживают переустановку приложения.
          </span>
        </div>

        {onClose && (
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg transition"
          >
            Закрыть
          </button>
        )}
      </div>
    </div>
  );
};
