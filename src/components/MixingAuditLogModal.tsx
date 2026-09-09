import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { 
  X, 
  FileText, 
  CheckCircle2, 
  AlertTriangle, 
  Info, 
  Copy, 
  Trash2, 
  Search, 
  Check, 
  Sliders, 
  Volume2, 
  Sparkles, 
  Flame 
} from 'lucide-react';
import { MixingAuditEntry } from '../types';

interface MixingAuditLogModalProps {
  isOpen: boolean;
  logs: MixingAuditEntry[];
  onClearLogs?: () => void;
  onClose: () => void;
}

export const MixingAuditLogModal: React.FC<MixingAuditLogModalProps> = ({
  isOpen,
  logs,
  onClearLogs,
  onClose
}) => {
  const [selectedFilter, setSelectedFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copied, setCopied] = useState(false);

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

  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      const matchFilter = selectedFilter === 'all' || log.stepId === selectedFilter;
      const matchSearch = searchQuery.trim() === '' || 
        log.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (log.details?.trackName && log.details.trackName.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchFilter && matchSearch;
    });
  }, [logs, selectedFilter, searchQuery]);

  const handleCopyLogs = () => {
    const text = filteredLogs.map(l => {
      const time = new Date(l.timestamp).toLocaleTimeString();
      return `[${time}] [${l.stageName} - ${l.stepId}] [${l.status.toUpperCase()}] ${l.title}: ${l.message}`;
    }).join('\n');

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return createPortal(
    <div 
      className="fixed inset-0 bg-black/85 backdrop-blur-md z-[999999] flex items-center justify-center p-3 sm:p-6 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div 
        className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[88vh] flex flex-col shadow-2xl overflow-hidden text-zinc-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/60">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                Журнал аудита и логирования (Этап 3: Сведение)
              </h2>
              <p className="text-xs text-zinc-400">
                Детальный отчет по всем выполненным шагам, замерам громкости, дакингу и эффектам
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={handleCopyLogs}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 font-medium flex items-center gap-1.5 transition-colors border border-zinc-700"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Скопировано!' : 'Копировать лог'}
            </button>
            {onClearLogs && (
              <button
                onClick={onClearLogs}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-red-950/40 text-zinc-400 hover:text-red-400 transition-colors border border-zinc-700"
                title="Очистить журнал"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              id="audit-log-modal-close-header-btn"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors cursor-pointer"
              title="Закрыть (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Filters and search bar */}
        <div className="px-6 py-3 border-b border-zinc-800 bg-zinc-900/40 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-1.5 overflow-x-auto text-xs">
            <button
              onClick={() => setSelectedFilter('all')}
              className={`px-3 py-1 rounded-lg font-medium transition-colors ${selectedFilter === 'all' ? 'bg-purple-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
            >
              Все записи ({logs.length})
            </button>
            <button
              onClick={() => setSelectedFilter('gainMatching')}
              className={`px-3 py-1 rounded-lg font-medium transition-colors flex items-center gap-1 ${selectedFilter === 'gainMatching' ? 'bg-purple-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
            >
              <Volume2 className="w-3 h-3" />
              Громкость
            </button>
            <button
              onClick={() => setSelectedFilter('ducking')}
              className={`px-3 py-1 rounded-lg font-medium transition-colors flex items-center gap-1 ${selectedFilter === 'ducking' ? 'bg-purple-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
            >
              <Sliders className="w-3 h-3" />
              Дакинг
            </button>
            <button
              onClick={() => setSelectedFilter('autoFxAnalysis')}
              className={`px-3 py-1 rounded-lg font-medium transition-colors flex items-center gap-1 ${selectedFilter === 'autoFxAnalysis' ? 'bg-purple-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
            >
              <Sparkles className="w-3 h-3" />
              Авто-FX
            </button>
            <button
              onClick={() => setSelectedFilter('vocalBusProcessing')}
              className={`px-3 py-1 rounded-lg font-medium transition-colors flex items-center gap-1 ${selectedFilter === 'vocalBusProcessing' ? 'bg-purple-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
            >
              <Flame className="w-3 h-3" />
              Мастер-шина
            </button>
          </div>

          <div className="relative min-w-[200px] max-w-xs">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Поиск по логам..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
            />
          </div>
        </div>

        {/* Logs List */}
        <div className="flex-1 overflow-y-auto p-6 space-y-2.5 font-sans">
          {filteredLogs.length === 0 ? (
            <div className="py-16 text-center text-zinc-500 text-xs">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
              Журнал логов пока пуст. Запустите этап сведения или отдельный шаг для генерации записей аудита.
            </div>
          ) : (
            filteredLogs.map((log) => {
              const time = new Date(log.timestamp).toLocaleTimeString();
              const statusColors = {
                success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
                warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
                error: 'bg-red-500/10 text-red-400 border-red-500/20',
                info: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
              };

              return (
                <div
                  key={log.id}
                  className="bg-zinc-900/70 border border-zinc-800/80 hover:border-zinc-700 rounded-xl p-3.5 space-y-1.5 transition-colors"
                >
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${statusColors[log.status]}`}>
                        {log.stepId}
                      </span>
                      <span className="font-semibold text-white">{log.title}</span>
                    </div>
                    <span className="text-[10px] font-mono text-zinc-500">{time}</span>
                  </div>

                  <p className="text-xs text-zinc-300 leading-relaxed">
                    {log.message}
                  </p>

                  {log.details && (
                    <div className="flex flex-wrap items-center gap-2 pt-1 text-[10px] font-mono text-zinc-400">
                      {log.details.trackName && (
                        <span className="bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300">
                          Дорожка: {log.details.trackName}
                        </span>
                      )}
                      {log.details.category && (
                        <span className={`px-1.5 py-0.5 rounded border ${log.details.category === 'dialogue' ? 'bg-purple-950/60 text-purple-300 border-purple-800' : 'bg-amber-950/60 text-amber-300 border-amber-800'}`}>
                          Категория: {log.details.category === 'dialogue' ? 'Реплика (Сабы)' : 'Физика (Без сабов)'}
                        </span>
                      )}
                      {log.details.timeRange && (
                        <span className="bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400">
                          Интервал: {log.details.timeRange}
                        </span>
                      )}
                      {log.details.adjustedGainDb !== undefined && (
                        <span className="bg-purple-900/40 text-purple-300 px-1.5 py-0.5 rounded border border-purple-700/40">
                          Δ Gain: {log.details.adjustedGainDb >= 0 ? `+${log.details.adjustedGainDb.toFixed(1)}` : log.details.adjustedGainDb.toFixed(1)} dB
                        </span>
                      )}
                      {log.details.duckingDb !== undefined && (
                        <span className="bg-indigo-900/40 text-indigo-300 px-1.5 py-0.5 rounded border border-indigo-700/40">
                          Дакинг: {log.details.duckingDb.toFixed(1)} dB
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-zinc-800 flex items-center justify-between bg-zinc-900/60">
          <div className="text-xs text-zinc-500">
            Отображено записей: {filteredLogs.length} из {logs.length}
          </div>
          <button
            id="audit-log-modal-close-footer-btn"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="px-4 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold transition-colors cursor-pointer active:scale-95"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
