import React, { useState } from 'react';
import { 
  X, AlertTriangle, CheckCircle, Info, ShieldAlert, Volume2, 
  Clock, ArrowRight, Sparkles, Filter, RefreshCw
} from 'lucide-react';
import { QualityControlIssue } from '../types';

interface FinalQualityControlModalProps {
  isOpen: boolean;
  onClose: () => void;
  issues: QualityControlIssue[];
  integratedLufs: number;
  maxTruePeakDb: number;
  onSeekToTime?: (timeSeconds: number) => void;
  onAutoFixIssue?: (issue: QualityControlIssue) => void;
  onRerunQa?: () => void;
}

export const FinalQualityControlModal: React.FC<FinalQualityControlModalProps> = ({
  isOpen,
  onClose,
  issues,
  integratedLufs,
  maxTruePeakDb,
  onSeekToTime,
  onAutoFixIssue,
  onRerunQa
}) => {
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const [filterType, setFilterType] = useState<string>('all');

  if (!isOpen) return null;

  const errorsCount = issues.filter(i => i.severity === 'error').length;
  const warningsCount = issues.filter(i => i.severity === 'warning').length;
  const infosCount = issues.filter(i => i.severity === 'info').length;

  const filteredIssues = issues.filter(issue => {
    if (filterSeverity !== 'all' && issue.severity !== filterSeverity) return false;
    if (filterType !== 'all' && issue.type !== filterType) return false;
    return true;
  });

  const formatTimecode = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${mins.toString().padStart(2, '0')}:${parseFloat(secs) < 10 ? '0' : ''}${secs}`;
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div 
        id="final-qa-modal"
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-700/80 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-zinc-950/60">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${
              errorsCount > 0 
                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' 
                : warningsCount > 0 
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
            }`}>
              {errorsCount > 0 ? (
                <ShieldAlert className="w-5 h-5" />
              ) : warningsCount > 0 ? (
                <AlertTriangle className="w-5 h-5" />
              ) : (
                <CheckCircle className="w-5 h-5" />
              )}
            </div>
            <div>
              <h2 className="text-base font-black text-white flex items-center gap-2">
                Отсмотр и анализ косяков (Quality Control / QA)
                {errorsCount === 0 ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono font-bold border border-emerald-500/30">
                    QA ПРОЙДЕН
                  </span>
                ) : (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 font-mono font-bold border border-rose-500/30">
                    ТРЕБУЕТСЯ ВНИМАНИЕ ({errorsCount})
                  </span>
                )}
              </h2>
              <p className="text-xs text-zinc-400">
                Автоматическая проверка серии на клиппинг, наезды реплик, пропуски фраз и соответствие стандартам громкости
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onRerunQa && (
              <button
                type="button"
                onClick={onRerunQa}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
                title="Пересканировать таймлайн"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Пересканировать</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Meters Summary Banner */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 bg-zinc-950/40 border-b border-white/5 text-xs">
          <div className="p-2.5 rounded-xl bg-zinc-900 border border-white/5 flex flex-col justify-between">
            <span className="text-[10px] uppercase font-bold text-zinc-400 flex items-center gap-1">
              <Volume2 className="w-3 h-3 text-indigo-400" />
              Интегральный LUFS
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={`text-lg font-mono font-black ${
                Math.abs(integratedLufs - (-14)) <= 2 ? 'text-emerald-400' : 'text-amber-400'
              }`}>
                {integratedLufs.toFixed(1)}
              </span>
              <span className="text-[10px] text-zinc-500">LUFS (Цель: -14 / -23)</span>
            </div>
          </div>

          <div className="p-2.5 rounded-xl bg-zinc-900 border border-white/5 flex flex-col justify-between">
            <span className="text-[10px] uppercase font-bold text-zinc-400 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3 text-rose-400" />
              True-Peak Max
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={`text-lg font-mono font-black ${
                maxTruePeakDb > -0.5 ? 'text-rose-400' : 'text-emerald-400'
              }`}>
                {maxTruePeakDb.toFixed(1)}
              </span>
              <span className="text-[10px] text-zinc-500">dBTP (Потолок: -1.0)</span>
            </div>
          </div>

          <div className="p-2.5 rounded-xl bg-zinc-900 border border-white/5 flex flex-col justify-between">
            <span className="text-[10px] uppercase font-bold text-zinc-400">Критичные ошибки</span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={`text-lg font-mono font-black ${errorsCount > 0 ? 'text-rose-400' : 'text-zinc-500'}`}>
                {errorsCount}
              </span>
              <span className="text-[10px] text-zinc-500">перегрузки / наезды</span>
            </div>
          </div>

          <div className="p-2.5 rounded-xl bg-zinc-900 border border-white/5 flex flex-col justify-between">
            <span className="text-[10px] uppercase font-bold text-zinc-400">Предупреждения</span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={`text-lg font-mono font-black ${warningsCount > 0 ? 'text-amber-400' : 'text-zinc-500'}`}>
                {warningsCount}
              </span>
              <span className="text-[10px] text-zinc-500">пропуски / паузы</span>
            </div>
          </div>
        </div>

        {/* Filters Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-2.5 bg-zinc-900/90 border-b border-white/5 text-xs">
          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-zinc-400 mr-1" />
            <button
              type="button"
              onClick={() => setFilterSeverity('all')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                filterSeverity === 'all' 
                  ? 'bg-zinc-800 text-white shadow' 
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Все ({issues.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterSeverity('error')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                filterSeverity === 'error' 
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40' 
                  : 'text-zinc-400 hover:text-rose-300'
              }`}
            >
              Ошибки ({errorsCount})
            </button>
            <button
              type="button"
              onClick={() => setFilterSeverity('warning')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                filterSeverity === 'warning' 
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' 
                  : 'text-zinc-400 hover:text-amber-300'
              }`}
            >
              Предупреждения ({warningsCount})
            </button>
            <button
              type="button"
              onClick={() => setFilterSeverity('info')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                filterSeverity === 'info' 
                  ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40' 
                  : 'text-zinc-400 hover:text-indigo-300'
              }`}
            >
              Инфо ({infosCount})
            </button>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="bg-zinc-950 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-zinc-300 focus:outline-none"
            >
              <option value="all">Все категории проблем</option>
              <option value="clipping">Клиппинг и перегрузка</option>
              <option value="overlap">Наезды реплик</option>
              <option value="missing_sub">Пропущенные субтитры</option>
              <option value="silence">Затянувшаяся тишина</option>
              <option value="lufs_deviation">Громкость LUFS</option>
            </select>
          </div>
        </div>

        {/* Issues List Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar">
          {filteredIssues.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-3">
                <CheckCircle className="w-8 h-8" />
              </div>
              <h3 className="text-sm font-bold text-zinc-200">Замечаний не обнаружено</h3>
              <p className="text-xs text-zinc-500 max-w-sm mt-1">
                Все дорожки, тайминги реплик и уровни громкости соответствуют стандартам профессионального дубляжа!
              </p>
            </div>
          ) : (
            filteredIssues.map((issue) => {
              const isError = issue.severity === 'error';
              const isWarning = issue.severity === 'warning';

              return (
                <div 
                  key={issue.id}
                  className={`p-4 rounded-xl border transition-all ${
                    isError 
                      ? 'bg-rose-950/20 border-rose-500/30 hover:border-rose-500/50' 
                      : isWarning
                        ? 'bg-amber-950/20 border-amber-500/30 hover:border-amber-500/50'
                        : 'bg-zinc-950/60 border-white/5 hover:border-white/10'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 p-1.5 rounded-lg flex-shrink-0 ${
                        isError 
                          ? 'bg-rose-500/20 text-rose-400' 
                          : isWarning 
                            ? 'bg-amber-500/20 text-amber-400' 
                            : 'bg-indigo-500/20 text-indigo-400'
                      }`}>
                        {isError ? (
                          <ShieldAlert className="w-4 h-4" />
                        ) : isWarning ? (
                          <AlertTriangle className="w-4 h-4" />
                        ) : (
                          <Info className="w-4 h-4" />
                        )}
                      </div>

                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold text-zinc-100">{issue.title}</span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-white/5">
                            {issue.trackName}
                          </span>
                          {issue.measuredValue && (
                            <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                              isError ? 'bg-rose-500/20 text-rose-300' : 'bg-zinc-800 text-amber-300'
                            }`}>
                              {issue.measuredValue}
                            </span>
                          )}
                        </div>

                        <p className="text-xs text-zinc-300 leading-relaxed">
                          {issue.description}
                        </p>

                        {issue.fixSuggestion && (
                          <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 mt-1">
                            <Sparkles className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                            <span>Совет: {issue.fixSuggestion}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <div className="flex items-center gap-1 text-[11px] font-mono text-zinc-400 bg-zinc-900 px-2 py-1 rounded-lg border border-white/5">
                        <Clock className="w-3 h-3 text-indigo-400" />
                        <span>{formatTimecode(issue.time)}</span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {onSeekToTime && (
                          <button
                            type="button"
                            onClick={() => {
                              onSeekToTime(issue.time);
                              onClose();
                            }}
                            className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                            title="Перейти к таймкоду на шкале времени"
                          >
                            <span>Таймлайн</span>
                            <ArrowRight className="w-3 h-3" />
                          </button>
                        )}
                        {onAutoFixIssue && (
                          <button
                            type="button"
                            onClick={() => onAutoFixIssue(issue)}
                            className="px-2 py-1 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                            title="Автоматически применить исправление"
                          >
                            <Sparkles className="w-3 h-3 text-indigo-300" />
                            <span>Исправить</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-white/10 bg-zinc-950/60 flex items-center justify-between text-xs">
          <span className="text-zinc-400 text-[11px]">
            Найдено замечаний: <strong className="text-zinc-200">{filteredIssues.length}</strong> (из {issues.length})
          </span>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold transition-all cursor-pointer"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};
