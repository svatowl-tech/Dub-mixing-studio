import React, { useState } from 'react';
import { 
  X, AlertTriangle, CheckCircle, Info, ShieldAlert, Volume2, 
  Clock, ArrowRight, Sparkles, Filter, RefreshCw, Download, Copy,
  Check, Mic, FileText, Zap, Layers, BarChart2
} from 'lucide-react';
import { QualityControlIssue, QaAuditReport, QaIncident } from '../types';

interface FinalQualityControlModalProps {
  isOpen: boolean;
  onClose: () => void;
  issues: QualityControlIssue[];
  integratedLufs: number;
  maxTruePeakDb: number;
  qaReport?: QaAuditReport | null;
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
  qaReport,
  onSeekToTime,
  onAutoFixIssue,
  onRerunQa
}) => {
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const [filterType, setFilterType] = useState<string>('all');
  const [copiedReport, setCopiedReport] = useState(false);
  const [selectedIncident, setSelectedIncident] = useState<QaIncident | null>(null);

  if (!isOpen) return null;

  const errorsCount = issues.filter(i => i.severity === 'error').length;
  const warningsCount = issues.filter(i => i.severity === 'warning').length;
  const infosCount = issues.filter(i => i.severity === 'info').length;

  const filteredIssues = issues.filter(issue => {
    if (filterSeverity !== 'all' && issue.severity !== filterSeverity) return false;
    if (filterType !== 'all') {
      if (filterType === 'true_peak' && issue.type !== 'true_peak') return false;
      if (filterType === 'clipping' && issue.type !== 'clipping') return false;
      if (filterType === 'click' && issue.type !== 'click') return false;
      if (filterType === 'missing_sub' && issue.type !== 'missing_sub') return false;
      if (filterType === 'silence' && issue.type !== 'silence') return false;
      if (filterType === 'lufs_deviation' && issue.type !== 'lufs_deviation') return false;
      if (filterType === 'overlap' && issue.type !== 'overlap') return false;
    }
    return true;
  });

  const formatTimecode = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(2);
    return `${mins.toString().padStart(2, '0')}:${parseFloat(secs) < 10 ? '0' : ''}${secs}`;
  };

  const handleCopyReport = () => {
    const reportData = qaReport ? JSON.stringify(qaReport, null, 2) : JSON.stringify({
      integratedLufs,
      maxTruePeakDb,
      totalIssues: issues.length,
      errorsCount,
      warningsCount,
      issues
    }, null, 2);

    navigator.clipboard.writeText(reportData);
    setCopiedReport(true);
    setTimeout(() => setCopiedReport(false), 2500);
  };

  const handleDownloadReport = () => {
    const reportData = qaReport ? JSON.stringify(qaReport, null, 2) : JSON.stringify({
      integratedLufs,
      maxTruePeakDb,
      totalIssues: issues.length,
      errorsCount,
      warningsCount,
      issues
    }, null, 2);

    const blob = new Blob([reportData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qa-audit-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div 
        id="final-qa-modal"
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-700/80 rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-zinc-950/80">
          <div className="flex items-center gap-3.5">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-lg ${
              errorsCount > 0 
                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30 ring-2 ring-rose-500/10' 
                : warningsCount > 0 
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 ring-2 ring-amber-500/10'
                  : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 ring-2 ring-emerald-500/10'
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
              <div className="flex items-center gap-2.5">
                <h2 className="text-base font-black text-white">
                  Предрелизный контроль качества (QA Compliance)
                </h2>
                {errorsCount === 0 ? (
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono font-bold border border-emerald-500/30">
                    ГОТОВ К ВЫПУСКУ (READY)
                  </span>
                ) : (
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 font-mono font-bold border border-rose-500/30">
                    БЛОКИРУЮЩИЕ ОШИБКИ ({errorsCount})
                  </span>
                )}
                {qaReport && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono border border-indigo-500/30">
                    Rust ITU-R BS.1770-4
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">
                Аудит True-Peak (4x оверсэмплинг), цифровых щелчков/клиппинга, 100% сверки сценария и вещательного стандарта EBU R128
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopyReport}
              className="p-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
              title="Скопировать отчет в буфер обмена"
            >
              {copiedReport ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{copiedReport ? 'Скопировано' : 'JSON'}</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadReport}
              className="p-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
              title="Экспорт отчета в файл"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Экспорт</span>
            </button>

            {onRerunQa && (
              <button
                type="button"
                onClick={onRerunQa}
                className="p-2 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 hover:text-white border border-indigo-500/30 transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
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

        {/* Dynamic Telemetry & Compliance Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 p-4 bg-zinc-950/60 border-b border-white/5 text-xs">
          {/* Integrated LUFS */}
          <div className="p-3 rounded-xl bg-zinc-900/90 border border-white/5 flex flex-col justify-between">
            <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-400 flex items-center gap-1">
              <Volume2 className="w-3 h-3 text-indigo-400" />
              Интегральный LUFS
            </span>
            <div className="flex items-baseline gap-1.5 mt-1.5">
              <span className={`text-xl font-mono font-black ${
                Math.abs(integratedLufs - (-14)) <= 2.0 ? 'text-emerald-400' : 'text-amber-400'
              }`}>
                {integratedLufs.toFixed(1)}
              </span>
              <span className="text-[10px] text-zinc-500">LUFS</span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-1 flex justify-between">
              <span>Цель: -14.0 LUFS</span>
              {qaReport && <span>LRA: {qaReport.audioMetrics.loudnessRangeLu.toFixed(1)} LU</span>}
            </div>
          </div>

          {/* True-Peak Max (4x) */}
          <div className="p-3 rounded-xl bg-zinc-900/90 border border-white/5 flex flex-col justify-between">
            <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-400 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3 text-rose-400" />
              True-Peak Max (4x)
            </span>
            <div className="flex items-baseline gap-1.5 mt-1.5">
              <span className={`text-xl font-mono font-black ${
                maxTruePeakDb > -0.5 ? 'text-rose-400' : 'text-emerald-400'
              }`}>
                {maxTruePeakDb.toFixed(2)}
              </span>
              <span className="text-[10px] text-zinc-500">dBTP</span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-1 flex justify-between">
              <span>Лимит: -0.5 dBTP</span>
              {qaReport && <span>{qaReport.audioMetrics.truePeakOverloadCount} пиков</span>}
            </div>
          </div>

          {/* Script Coverage */}
          <div className="p-3 rounded-xl bg-zinc-900/90 border border-white/5 flex flex-col justify-between">
            <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-400 flex items-center gap-1">
              <FileText className="w-3 h-3 text-emerald-400" />
              Покрытие сценария
            </span>
            <div className="flex items-baseline gap-1.5 mt-1.5">
              <span className={`text-xl font-mono font-black ${
                (qaReport?.scriptCoverage.coveragePercent ?? 100) >= 99 ? 'text-emerald-400' : 'text-amber-400'
              }`}>
                {(qaReport?.scriptCoverage.coveragePercent ?? 100).toFixed(1)}%
              </span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-1 flex justify-between">
              <span>{qaReport?.scriptCoverage.coveredScriptCues ?? 0} / {qaReport?.scriptCoverage.totalScriptCues ?? 0} реплик</span>
              <span>{(qaReport?.scriptCoverage.missingScriptCues ?? 0) > 0 ? `Пропущено: ${qaReport?.scriptCoverage.missingScriptCues}` : '100%'}</span>
            </div>
          </div>

          {/* Clicks & Clipping */}
          <div className="p-3 rounded-xl bg-zinc-900/90 border border-white/5 flex flex-col justify-between">
            <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-400 flex items-center gap-1">
              <Zap className="w-3 h-3 text-cyan-400" />
              Щелчки и Клиппинг
            </span>
            <div className="flex items-baseline gap-1.5 mt-1.5">
              <span className={`text-xl font-mono font-black ${
                (qaReport?.audioMetrics.digitalClippingEventsCount ?? 0) > 0 ? 'text-rose-400' : 'text-emerald-400'
              }`}>
                {(qaReport?.audioMetrics.digitalClippingEventsCount ?? 0) + (qaReport?.audioMetrics.digitalClicksCount ?? 0)}
              </span>
              <span className="text-[10px] text-zinc-500">событий</span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-1 flex justify-between">
              <span>Щелчков: {qaReport?.audioMetrics.digitalClicksCount ?? 0}</span>
              <span>Клиппов: {qaReport?.audioMetrics.totalClippedSamples ?? 0} сэмплов</span>
            </div>
          </div>

          {/* Audit Status */}
          <div className="p-3 rounded-xl bg-zinc-900/90 border border-white/5 flex flex-col justify-between col-span-2 sm:col-span-1">
            <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-400 flex items-center gap-1">
              <BarChart2 className="w-3 h-3 text-amber-400" />
              Итог инцидентов
            </span>
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`text-sm font-mono font-bold px-1.5 py-0.5 rounded ${errorsCount > 0 ? 'bg-rose-500/20 text-rose-300' : 'bg-zinc-800 text-zinc-500'}`}>
                {errorsCount} Ош
              </span>
              <span className={`text-sm font-mono font-bold px-1.5 py-0.5 rounded ${warningsCount > 0 ? 'bg-amber-500/20 text-amber-300' : 'bg-zinc-800 text-zinc-500'}`}>
                {warningsCount} Пред
              </span>
              <span className="text-sm font-mono font-bold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                {infosCount} Инфо
              </span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-1">
              Всего: {issues.length} инцидентов
            </div>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-2.5 bg-zinc-900 border-b border-white/5 text-xs">
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
              className="bg-zinc-950 border border-white/10 rounded-lg px-2.5 py-1 text-[11px] text-zinc-300 focus:outline-none focus:border-indigo-500"
            >
              <option value="all">Все категории проблем</option>
              <option value="true_peak">True-Peak Overloads (4x)</option>
              <option value="clipping">Цифровой клиппинг (0 dBFS)</option>
              <option value="click">Цифровые щелчки / Склейки</option>
              <option value="missing_sub">Пропущенные реплики сценария</option>
              <option value="silence">Аномальные провалы тишины</option>
              <option value="lufs_deviation">Громкость LUFS</option>
              <option value="overlap">Наезды реплик</option>
            </select>
          </div>
        </div>

        {/* Issues List Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar">
          {filteredIssues.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-3 shadow-inner">
                <CheckCircle className="w-9 h-9" />
              </div>
              <h3 className="text-base font-bold text-zinc-200">Замечаний не обнаружено</h3>
              <p className="text-xs text-zinc-400 max-w-md mt-1.5 leading-relaxed">
                Мастер-микс полностью соответствует вещательному стандарту EBU R128 и спецификации ITU-R BS.1770-4. Все реплики сценария покрыты, межсэмпловых перегрузок не зафиксировано!
              </p>
            </div>
          ) : (
            filteredIssues.map((issue) => {
              const isError = issue.severity === 'error';
              const isWarning = issue.severity === 'warning';
              const rawInc = issue.rawIncident;

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
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3.5 flex-1">
                      <div className={`mt-0.5 p-2 rounded-xl flex-shrink-0 shadow-sm ${
                        isError 
                          ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' 
                          : isWarning 
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' 
                            : 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                      }`}>
                        {isError ? (
                          <ShieldAlert className="w-4 h-4" />
                        ) : isWarning ? (
                          <AlertTriangle className="w-4 h-4" />
                        ) : (
                          <Info className="w-4 h-4" />
                        )}
                      </div>

                      <div className="space-y-1.5 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold text-zinc-100">{issue.title}</span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-white/5">
                            {issue.trackName}
                          </span>
                          {rawInc && (
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-950/60 text-indigo-300 border border-indigo-500/30">
                              SMPTE: {rawInc.timecode.smpteTimecode}
                            </span>
                          )}
                          {issue.measuredValue && (
                            <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                              isError ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-zinc-800 text-amber-300 border border-amber-500/20'
                            }`}>
                              Замер: {issue.measuredValue}
                            </span>
                          )}
                          {rawInc?.thresholdValue && (
                            <span className="text-[10px] font-mono text-zinc-400">
                              Норма: {rawInc.thresholdValue}
                            </span>
                          )}
                        </div>

                        <p className="text-xs text-zinc-300 leading-relaxed">
                          {issue.description}
                        </p>

                        {issue.fixSuggestion && (
                          <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 pt-0.5">
                            <Sparkles className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                            <span><strong className="text-zinc-300">Рекомендация:</strong> {issue.fixSuggestion}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <div className="flex items-center gap-1 text-[11px] font-mono text-zinc-300 bg-zinc-950 px-2.5 py-1 rounded-lg border border-white/10 shadow-inner">
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
                            className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-bold flex items-center gap-1 transition-all cursor-pointer border border-white/5 hover:border-white/20"
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
                            className="px-2.5 py-1 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 text-[11px] font-bold flex items-center gap-1 transition-all cursor-pointer shadow-sm"
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
        <div className="px-6 py-3.5 border-t border-white/10 bg-zinc-950/80 flex items-center justify-between text-xs">
          <div className="flex items-center gap-3 text-zinc-400 text-[11px]">
            <span>
              Показано инцидентов: <strong className="text-zinc-200">{filteredIssues.length}</strong> (из {issues.length})
            </span>
            {qaReport && (
              <span className="hidden sm:inline text-zinc-500">
                • Время анализа ядра: <strong className="text-zinc-400 font-mono">{qaReport.auditElapsedMs} мс</strong>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold transition-all cursor-pointer border border-white/10"
            >
              Закрыть
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
