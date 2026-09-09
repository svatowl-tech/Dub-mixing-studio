import React from 'react';
import { 
  X, CheckCircle, Download, Film, Music, FileText, 
  Sparkles, Loader2, Volume2, ShieldCheck, Play
} from 'lucide-react';
import { FinalRenderResult } from '../types';

interface FinalRenderProgressModalProps {
  isOpen: boolean;
  isRendering: boolean;
  progressPercent: number;
  currentStage: string;
  result: FinalRenderResult | null;
  onClose: () => void;
  onOpenQaReport?: () => void;
}

export const FinalRenderProgressModal: React.FC<FinalRenderProgressModalProps> = ({
  isOpen,
  isRendering,
  progressPercent,
  currentStage,
  result,
  onClose,
  onOpenQaReport
}) => {
  if (!isOpen) return null;

  const downloadFile = (url: string, fileName: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in"
      onClick={!isRendering ? onClose : undefined}
    >
      <div 
        id="final-render-modal"
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-700/80 rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-zinc-950/70">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              isRendering 
                ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 animate-pulse' 
                : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
            }`}>
              {isRendering ? (
                <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
              ) : (
                <CheckCircle className="w-6 h-6 text-emerald-400" />
              )}
            </div>
            <div>
              <h2 className="text-base font-black text-white flex items-center gap-2">
                {isRendering ? 'Финальный рендеринг серии' : 'Финальный микс готов к экспорту!'}
              </h2>
              <p className="text-xs text-zinc-400">
                {isRendering 
                  ? 'Сведение аудиостэмов, кодирование видеопотока и впекание субтитров...' 
                  : 'Все дорожки сведены, отмастерены и упакованы в студийные форматы.'}
              </p>
            </div>
          </div>

          {!isRendering && (
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
          {isRendering ? (
            /* Active rendering state */
            <div className="py-8 px-4 flex flex-col items-center justify-center text-center space-y-6">
              <div className="w-20 h-20 rounded-2xl bg-indigo-600/10 border border-indigo-500/30 flex items-center justify-center shadow-inner relative">
                <Film className="w-10 h-10 text-indigo-400 animate-pulse" />
                <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 animate-ping" />
              </div>

              <div className="w-full max-w-lg space-y-3">
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-zinc-300 font-bold truncate max-w-xs">{currentStage}</span>
                  <span className="text-indigo-400 font-black">{progressPercent}%</span>
                </div>

                <div className="w-full bg-zinc-950 h-3 rounded-full overflow-hidden border border-white/10 p-0.5 shadow-inner">
                  <div 
                    className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-emerald-400 rounded-full transition-all duration-300 shadow-md shadow-indigo-500/30"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>

                <div className="grid grid-cols-4 gap-2 pt-2 text-[10px] text-zinc-400 text-center">
                  <div className={`p-1.5 rounded-lg border ${progressPercent >= 20 ? 'bg-zinc-800/80 border-indigo-500/30 text-indigo-300 font-bold' : 'border-white/5 opacity-50'}`}>
                    1. QA Контроль
                  </div>
                  <div className={`p-1.5 rounded-lg border ${progressPercent >= 40 ? 'bg-zinc-800/80 border-indigo-500/30 text-indigo-300 font-bold' : 'border-white/5 opacity-50'}`}>
                    2. Мастеринг
                  </div>
                  <div className={`p-1.5 rounded-lg border ${progressPercent >= 70 ? 'bg-zinc-800/80 border-indigo-500/30 text-indigo-300 font-bold' : 'border-white/5 opacity-50'}`}>
                    3. Сведение стемов
                  </div>
                  <div className={`p-1.5 rounded-lg border ${progressPercent >= 90 ? 'bg-zinc-800/80 border-indigo-500/30 text-indigo-300 font-bold' : 'border-white/5 opacity-50'}`}>
                    4. Кодирование
                  </div>
                </div>
              </div>
            </div>
          ) : result ? (
            /* Render completed successfully */
            <div className="space-y-6">
              {/* QA Banner */}
              <div className="p-3.5 rounded-xl bg-gradient-to-r from-zinc-950 via-zinc-900 to-zinc-950 border border-white/10 flex flex-wrap items-center justify-between gap-3 shadow-lg">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                    <ShieldCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-zinc-200 flex items-center gap-2">
                      Контроль качества пройден:
                      <span className="text-emerald-400 font-mono font-black">
                        {result.qaReport.integratedLufs.toFixed(1)} LUFS
                      </span>
                      <span className="text-zinc-500">|</span>
                      <span className="text-zinc-300 font-mono">
                        True Peak: {result.qaReport.maxTruePeakDb.toFixed(1)} dBTP
                      </span>
                    </div>
                    <div className="text-[11px] text-zinc-400">
                      Ошибок: {result.qaReport.errorsCount} • Предупреждений: {result.qaReport.warningsCount}
                    </div>
                  </div>
                </div>

                {onOpenQaReport && (
                  <button
                    type="button"
                    onClick={onOpenQaReport}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-bold transition-all cursor-pointer"
                  >
                    Посмотреть отчет QA
                  </button>
                )}
              </div>

              {/* Video File Card */}
              {result.videoBlobUrl && (
                <div className="p-4 rounded-xl bg-zinc-950/70 border border-indigo-500/20 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <Film className="w-5 h-5 text-indigo-400" />
                      <div>
                        <div className="text-xs font-bold text-white">
                          Финальный видеофайл (Дубляж + Видеопоток)
                        </div>
                        <div className="text-[10px] text-zinc-400 font-mono">
                          {result.videoFileName}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => downloadFile(result.videoBlobUrl!, result.videoFileName || 'final_video.mp4')}
                      className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all shadow-md shadow-indigo-600/30 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Скачать видео</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Audio Stems Section */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-black uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                  <Music className="w-3.5 h-3.5 text-indigo-400" />
                  Экспортированные аудиостэмы (Stems Mixdown)
                </h3>

                <div className="grid grid-cols-1 gap-2">
                  {result.stems.map((stem) => (
                    <div 
                      key={stem.id}
                      className="p-3 rounded-xl bg-zinc-950/50 border border-white/5 hover:border-white/10 flex items-center justify-between gap-3 transition-all"
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-zinc-900 border border-white/5 text-zinc-400">
                          <Volume2 className="w-4 h-4 text-emerald-400" />
                        </div>
                        <div>
                          <div className="text-xs font-bold text-zinc-200">{stem.name}</div>
                          <div className="text-[10px] text-zinc-500 font-mono">
                            {stem.format} • {formatFileSize(stem.sizeBytes)} • {stem.fileName}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => downloadFile(stem.blobUrl, stem.fileName)}
                        className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-200 hover:text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all border border-white/5 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5 text-zinc-400" />
                        <span>Скачать WAV</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Subtitles Section */}
              {result.subtitlesFiles.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-xs font-black uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-amber-400" />
                    Файлы субтитров (SRT и ASS со стилями)
                  </h3>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {result.subtitlesFiles.map((sub) => (
                      <div 
                        key={sub.format}
                        className="p-3 rounded-xl bg-zinc-950/50 border border-white/5 flex items-center justify-between gap-2"
                      >
                        <div className="flex items-center gap-2.5">
                          <FileText className="w-4 h-4 text-amber-400" />
                          <div>
                            <div className="text-xs font-bold text-zinc-200 uppercase">
                              Субтитры .{sub.format}
                            </div>
                            <div className="text-[10px] text-zinc-500 truncate max-w-[150px]">
                              {sub.fileName}
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => downloadFile(sub.blobUrl, sub.fileName)}
                          className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-300 hover:text-white rounded-lg text-[11px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                        >
                          <Download className="w-3 h-3 text-zinc-400" />
                          <span>Скачать</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-white/10 bg-zinc-950/70 flex items-center justify-between">
          <span className="text-[11px] text-zinc-500">
            {result ? 'Все мастер-файлы готовы к публикации на видеохостингах и ТВ' : 'Пожалуйста, не закрывайте вкладку во время кодирования'}
          </span>

          <button
            type="button"
            disabled={isRendering}
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 text-xs font-bold transition-all cursor-pointer active:scale-95"
          >
            {result ? 'Готово' : 'Отмена'}
          </button>
        </div>
      </div>
    </div>
  );
};
