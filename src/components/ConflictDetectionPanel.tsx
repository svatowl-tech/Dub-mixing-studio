import React, { useState, useEffect } from 'react';
import { 
  AlertTriangle, 
  CheckCircle2, 
  Clock, 
  HelpCircle, 
  Play, 
  RefreshCw, 
  Wand2, 
  ArrowRight,
  Split,
  FileWarning,
  Volume2,
  Sliders,
  ChevronRight
} from 'lucide-react';
import { Project, ConflictReport, TimelineValidationSummary } from '../types';
import { SmartAlignService } from '../services/smartAlignService';
import { TimingAlignmentService } from '../services/timingAlignmentService';
import { cn } from '../lib/utils';

interface ConflictDetectionPanelProps {
  project: Project;
  currentTimeMs: number;
  onSeekToMs: (ms: number) => void;
  onApplyFix?: (conflict: ConflictReport) => void;
  onAutoResolveAll?: () => void;
}

export const ConflictDetectionPanel: React.FC<ConflictDetectionPanelProps> = ({
  project,
  currentTimeMs,
  onSeekToMs,
  onApplyFix,
  onAutoResolveAll
}) => {
  const [summary, setSummary] = useState<TimelineValidationSummary | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'critical' | 'warning' | 'info'>('all');
  const [selectedConflictId, setSelectedConflictId] = useState<string | null>(null);

  const runAnalysis = async () => {
    setIsScanning(true);
    try {
      const rawSubtitles = project.subtitles || [];
      const subtitles = rawSubtitles.map(sub => ({
        id: String(sub.id),
        startMs: Math.round((sub.start || 0) * 1000),
        endMs: Math.round(((sub.end || 0) || (sub.start + 1)) * 1000),
        characterName: sub.role,
        text: sub.text
      }));

      // Подготавливаем аудио-сегменты с учетом допустимых нахлестов из субтитров
      const clips = (project.tracks ? project.tracks.flatMap(t => (t.segments || []).map(seg => {
        const sub = seg.matchedSubId ? rawSubtitles.find(s => s.id === seg.matchedSubId) : undefined;
        let isDialogOverlapAllowed = false;
        if (sub) {
          isDialogOverlapAllowed = rawSubtitles.some(otherSub => 
            otherSub.id !== sub.id &&
            otherSub.role !== sub.role &&
            TimingAlignmentService.doSubtitlesOverlapInScript(sub, otherSub)
          );
        }

        return {
          id: seg.id,
          trackId: t.id,
          characterId: (seg as any).characterId || t.role,
          characterName: (seg as any).characterName || t.role || t.name,
          startMs: Math.round((seg.startTime || 0) * 1000),
          endMs: Math.round(((seg.startTime || 0) + (seg.duration || 0)) * 1000),
          durationMs: Math.round((seg.duration || 0) * 1000),
          subtitleId: seg.matchedSubId || (seg as any).subtitleId,
          isDialogOverlapAllowed,
          isMuted: Boolean(t.isMuted)
        };
      })) : []);

      const res = await SmartAlignService.validateTimelineCompliance(clips, subtitles, {
        minGapMs: 50,
        timingDriftThresholdMs: 400,
        autoResolveMinorClashes: true
      });

      setSummary(res);
    } catch (e) {
      console.error('Timeline validation error:', e);
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    runAnalysis();
  }, [project.tracks, project.subtitles?.length]);

  const filteredConflicts = (summary?.conflicts || []).filter(c => {
    if (selectedFilter === 'all') return true;
    return c.severity === selectedFilter;
  });

  return (
    <div className="flex flex-col h-full bg-zinc-950 border border-white/10 rounded-xl overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="p-4 bg-zinc-900/80 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-wider">
                Детектор коллизий и соответствия сценарию
              </h3>
              {summary && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {summary.executionTimeUs < 1000 ? `${summary.executionTimeUs} µs` : `${(summary.executionTimeUs / 1000).toFixed(1)} ms`}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Поиск наездов реплик, пропущенных фраз сабов и расхождений хронометража (&gt;400 мс)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {summary && summary.conflicts.length > 0 && (
            <button
              onClick={() => {
                if (onAutoResolveAll) {
                  onAutoResolveAll();
                }
                runAnalysis();
              }}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-indigo-600/20 transition"
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>Авто-раздвижка коллизий ({summary.autoResolvedCount})</span>
            </button>
          )}

          <button
            onClick={runAnalysis}
            disabled={isScanning}
            className="p-2 hover:bg-white/5 border border-white/10 rounded-lg text-zinc-400 hover:text-zinc-200 transition"
            title="Пересканировать таймлайн"
          >
            <RefreshCw className={cn("w-4 h-4", isScanning && "animate-spin text-indigo-400")} />
          </button>
        </div>
      </div>

      {/* Stats and Filter Bar */}
      <div className="px-4 py-2 bg-zinc-900/40 border-b border-white/5 flex items-center justify-between text-xs">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSelectedFilter('all')}
            className={cn(
              "px-2.5 py-1 rounded-md font-medium transition",
              selectedFilter === 'all' 
                ? "bg-white/10 text-white shadow-sm" 
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
            )}
          >
            Все ({summary?.totalConflicts ?? 0})
          </button>
          <button
            onClick={() => setSelectedFilter('critical')}
            className={cn(
              "px-2.5 py-1 rounded-md font-medium flex items-center gap-1.5 transition",
              selectedFilter === 'critical' 
                ? "bg-rose-500/20 text-rose-300 border border-rose-500/30" 
                : "text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10"
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
            Критические ({summary?.criticalCount ?? 0})
          </button>
          <button
            onClick={() => setSelectedFilter('warning')}
            className={cn(
              "px-2.5 py-1 rounded-md font-medium flex items-center gap-1.5 transition",
              selectedFilter === 'warning' 
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/30" 
                : "text-zinc-400 hover:text-amber-400 hover:bg-amber-500/10"
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Предупреждения ({summary?.warningCount ?? 0})
          </button>
        </div>

        <div className="text-[11px] text-zinc-500 font-mono">
          Проанализировано: {summary?.totalCuesAnalyzed ?? 0} клипов, {summary?.totalSubtitlesAnalyzed ?? 0} субтитров
        </div>
      </div>

      {/* Conflict List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {isScanning ? (
          <div className="h-48 flex flex-col items-center justify-center gap-3 text-zinc-500">
            <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
            <span className="text-xs">Сверхбыстрый анализ коллизий таймлайна на Rust...</span>
          </div>
        ) : filteredConflicts.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center gap-2 text-zinc-500">
            <CheckCircle2 className="w-8 h-8 text-emerald-400/80" />
            <span className="text-xs font-medium text-zinc-300">Коллизий и расхождений не обнаружено!</span>
            <span className="text-[11px] text-zinc-500">Все реплики согласованы со сценарием и не наезжают друг на друга.</span>
          </div>
        ) : (
          filteredConflicts.map((conflict) => {
            const isSelected = selectedConflictId === conflict.id;
            const isCurrent = currentTimeMs >= conflict.timeStartMs && currentTimeMs <= conflict.timeEndMs;

            return (
              <div
                key={conflict.id}
                onClick={() => setSelectedConflictId(conflict.id)}
                className={cn(
                  "p-3 rounded-lg border transition cursor-pointer flex flex-col gap-2",
                  conflict.severity === 'critical'
                    ? "bg-rose-950/20 border-rose-500/20 hover:border-rose-500/40"
                    : conflict.severity === 'warning'
                    ? "bg-amber-950/20 border-amber-500/20 hover:border-amber-500/40"
                    : "bg-zinc-900/40 border-white/5 hover:border-white/10",
                  isSelected && "ring-1 ring-indigo-500 border-indigo-500/50 bg-indigo-950/20",
                  isCurrent && "border-indigo-400/60"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {conflict.conflictType === 'clashing' && (
                      <Split className="w-4 h-4 text-rose-400 shrink-0" />
                    )}
                    {conflict.conflictType === 'script_gap' && (
                      <FileWarning className="w-4 h-4 text-amber-400 shrink-0" />
                    )}
                    {conflict.conflictType === 'timing_drift' && (
                      <Clock className="w-4 h-4 text-sky-400 shrink-0" />
                    )}

                    <span className="text-xs font-semibold text-zinc-200">
                      {conflict.conflictType === 'clashing' && 'Наезд/перекрытие реплик'}
                      {conflict.conflictType === 'script_gap' && 'Пропущенная фраза сценария'}
                      {conflict.conflictType === 'timing_drift' && 'Расхождение хронометража (>400 мс)'}
                    </span>

                    {conflict.characterName && (
                      <span className="text-[10px] px-1.5 py-0.2 bg-white/5 rounded text-zinc-400 font-mono">
                        {conflict.characterName}
                      </span>
                    )}
                  </div>

                  {/* Таймкод и кнопка перехода */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSeekToMs(conflict.timeStartMs);
                    }}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800/80 hover:bg-indigo-600/80 text-[11px] font-mono text-zinc-300 hover:text-white transition"
                    title="Перейти к маркеру на таймлайне"
                  >
                    <Play className="w-2.5 h-2.5 fill-current" />
                    <span>{(conflict.timeStartMs / 1000).toFixed(2)}s</span>
                  </button>
                </div>

                <p className="text-xs text-zinc-300 leading-relaxed">
                  {conflict.message}
                </p>

                {/* Блок предлагаемого решения */}
                <div className="mt-1 p-2 rounded bg-zinc-950/60 border border-white/5 flex items-center justify-between gap-2 text-[11px]">
                  <div className="flex items-center gap-2 text-zinc-400">
                    <Wand2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    <span>{conflict.suggestedFix.explanation}</span>
                  </div>

                  {onApplyFix && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onApplyFix(conflict);
                      }}
                      className="px-2 py-1 bg-white/10 hover:bg-indigo-600 text-zinc-200 hover:text-white rounded text-[10px] font-medium transition shrink-0"
                    >
                      Применить фикс
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
