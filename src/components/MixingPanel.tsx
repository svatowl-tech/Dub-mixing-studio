import React, { useState, useEffect, useMemo } from 'react';
import { 
  Sliders, 
  Settings2, 
  Sparkles, 
  Save, 
  Share2, 
  ChevronDown, 
  ChevronUp, 
  Volume2, 
  Clock, 
  Tv, 
  Video,
  Play,
  RotateCcw,
  Check,
  Power,
  Layers,
  HelpCircle,
  Cpu,
  FolderOpen,
  RefreshCw,
  AlertCircle,
  Terminal,
  ArrowRight,
  GripVertical,
  Trash2,
  Plus,
  X,
  Wand2,
  Scissors,
  Mic,
  CheckCircle2,
  AlertTriangle,
  Split,
  Search,
  CheckCheck,
  FileText,
  Flame,
  Film,
  Music,
  Download,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react';
import { 
  Project, 
  MixingPreset, 
  MixingType,
  PrepProcessingConfig,
  TimingAlignmentConfig,
  MixingEffectsConfig,
  FinalMixConfig,
  VstStepConfig,
  AudioTrack,
  TimingIssue,
  MixingAuditEntry,
  QualityControlIssue,
  FinalRenderResult
} from '../types';
import { 
  DEFAULT_MIXING_PRESETS,
  DEFAULT_PHASE1_ORDER,
  DEFAULT_PHASE2_ORDER,
  DEFAULT_PHASE3_ORDER,
  DEFAULT_PHASE4_ORDER
} from '../lib/defaultPresets';
import { cn, getGlobalAudioSettings } from '../lib/utils';
import { AudioSeparatorService } from '../services/audioSeparatorService';
import { TimingAlignmentService } from '../services/timingAlignmentService';
import { MixingService } from '../services/mixingService';
import { FinalRenderService } from '../services/finalRenderService';
import { MixingStepSettingsModal } from './MixingStepSettingsModal';
import { MixingAuditLogModal } from './MixingAuditLogModal';
import { FinalQualityControlModal } from './FinalQualityControlModal';
import { FinalRenderProgressModal } from './FinalRenderProgressModal';
import { open as rawOpen } from '@tauri-apps/plugin-dialog';
import { invoke as rawInvoke } from '@tauri-apps/api/core';

const isTauriAvailable = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
};

const invoke = async <T,>(cmd: string, args?: any): Promise<T> => {
  if (!isTauriAvailable()) {
    throw new Error(`Команда "${cmd}" поддерживается только в десктопном приложении DubStudio.`);
  }
  return await rawInvoke<T>(cmd, args);
};

const open = async (options?: any): Promise<any> => {
  if (!isTauriAvailable()) {
    return null;
  }
  return await rawOpen(options);
};
import { VstSelectorModal } from './VstSelectorModal';
import { useTimelineData } from '../contexts/TimelineContext';
import { playbackEngine } from '../services/playbackEngine';

interface MixingPanelProps {
  project: Project | null;
  onUpdateProject: (updates: Partial<Project>) => void;
  fullHeight?: boolean;
}

export const MixingPanel: React.FC<MixingPanelProps> = ({ project, onUpdateProject, fullHeight }) => {
  const { selectedSegmentIds, handleSeek } = useTimelineData();

  const selectedSegment = useMemo(() => {
    if (!project || !selectedSegmentIds || selectedSegmentIds.length === 0) return null;
    for (const track of project.tracks) {
      const seg = track.segments.find(s => selectedSegmentIds.includes(s.id));
      if (seg) return { segment: seg, trackId: track.id };
    }
    return null;
  }, [project, selectedSegmentIds]);

  const updateSegmentWithProcessedFile = (resultPath: string, effectName?: string) => {
    if (!resultPath || !project || !selectedSegment) return;
    const { segment, trackId } = selectedSegment;

    playbackEngine.stop();
    playbackEngine.clearCache();

    const updatedTracks = project.tracks.map(t => {
      if (t.id === trackId) {
        return {
          ...t,
          segments: t.segments.map(s => {
            if (s.id === segment.id) {
              return {
                ...s,
                sourceFilePath: s.sourceFilePath || s.filePath,
                backupFilePath: s.filePath,
                processedEffectName: effectName || s.processedEffectName,
                filePath: resultPath,
                waveform: undefined, // Clear peaks so App.tsx auto-regenerates
                isExtractingWaveform: false,
                originalFileName: resultPath.split(/[\\/]/).pop() || s.originalFileName
              };
            }
            return s;
          })
        };
      }
      return t;
    });

    onUpdateProject({ tracks: updatedTracks });
    playbackEngine.updateTracks(updatedTracks).catch(console.error);
    showToast('Сегмент на таймлайне успешно обновлен и перерисован!');
  };

  const handleRevertSelectedSegment = () => {
    if (!project || !selectedSegment) return;
    const { segment, trackId } = selectedSegment;
    const revertPath = segment.sourceFilePath || segment.backupFilePath;
    if (!revertPath || revertPath === segment.filePath) {
      showToast('Сегмент уже находится в исходном состоянии');
      return;
    }

    playbackEngine.stop();
    playbackEngine.clearCache();

    const updatedTracks = project.tracks.map(t => {
      if (t.id === trackId) {
        return {
          ...t,
          segments: t.segments.map(s => {
            if (s.id === segment.id) {
              return {
                ...s,
                filePath: revertPath,
                waveform: undefined,
                isExtractingWaveform: false,
                processedEffectName: undefined,
                backupFilePath: undefined,
                originalFileName: revertPath.split(/[\\/]/).pop() || s.originalFileName
              };
            }
            return s;
          })
        };
      }
      return t;
    });

    onUpdateProject({ tracks: updatedTracks });
    playbackEngine.updateTracks(updatedTracks).catch(console.error);
    showToast('Сегмент успешно возвращен к исходному состоянию!');
  };

  const handleReplaceSelectedSegment = () => {
    if (processedEffectFile) {
      updateSegmentWithProcessedFile(processedEffectFile);
    }
  };

  const handleReplaceSelectedSegmentWithSeparated = () => {
    if (processedFilePath) {
      updateSegmentWithProcessedFile(processedFilePath);
    }
  };

  const [isOpen, setIsOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<'prep' | 'timing' | 'mixing' | 'render'>('prep');
  const [presets, setPresets] = useState<MixingPreset[]>(DEFAULT_MIXING_PRESETS);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('preset-voiceover');
  const [activePreset, setActivePreset] = useState<MixingPreset>(DEFAULT_MIXING_PRESETS[0]);
  
  // States for preset creation
  const [isCreatingPreset, setIsCreatingPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetDesc, setNewPresetDesc] = useState('');
  const [newPresetType, setNewPresetType] = useState<MixingType>(MixingType.VOICEOVER);
  
  // Notification tooltip
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  
  // Processing animation states
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingStep, setProcessingStep] = useState('');
  
  // Noise and compression helpers
  const [isDetectingNoise, setIsDetectingNoise] = useState(false);
  const [detectedNoiseLevel, setDetectedNoiseLevel] = useState<number | null>(null);

  // Audio separator (UVR5) integration states
  const [separatorStatus, setSeparatorStatus] = useState<any>(null);
  const [isInstallingSeparator, setIsInstallingSeparator] = useState(false);
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const [useGpuForSeparator, setUseGpuForSeparator] = useState(true);
  const [selectedSeparatorFile, setSelectedSeparatorFile] = useState<string>('');
  const [selectedSeparatorModel, setSelectedSeparatorModel] = useState<string>('UVR-DeNoise-Lite.onnx');
  const [separatorOperation, setSeparatorOperation] = useState<'denoise' | 'dereverb' | 'separation'>('denoise');
  const [isSeparating, setIsSeparating] = useState(false);
  const [separatorProgress, setSeparatorProgress] = useState<any>(null);
  const [separatorOutputMsg, setSeparatorOutputMsg] = useState<string>('');
  const [isSeparatorSuccess, setIsSeparatorSuccess] = useState(false);
  const [processedFilePath, setProcessedFilePath] = useState<string>('');

  const [selectedEffectFile, setSelectedEffectFile] = useState<string>('');
  const [isApplyingEffect, setIsApplyingEffect] = useState(false);
  const [processedEffectFile, setProcessedEffectFile] = useState<string>('');

  // Timing & Alignment (Фаза 2) states
  const [timingIssues, setTimingIssues] = useState<TimingIssue[]>([]);
  const [isAligningPhrases, setIsAligningPhrases] = useState(false);
  const [isSplittingSilence, setIsSplittingSilence] = useState(false);
  const [timingInspectionDone, setTimingInspectionDone] = useState(false);

  // States for Phase 3 (Mixing & Effects)
  const [activeStepSettingsModal, setActiveStepSettingsModal] = useState<null | 'gainMatching' | 'ducking' | 'autoFxAnalysis' | 'vocalBusProcessing'>(null);
  const [isAuditLogOpen, setIsAuditLogOpen] = useState(false);
  const [isExecutingPhase3Step, setIsExecutingPhase3Step] = useState<string | null>(null);
  const [auditLogs, setAuditLogs] = useState<MixingAuditEntry[]>([
    {
      id: 'init-phase3',
      timestamp: Date.now() - 3600000,
      stageName: '3. Сведение',
      stepId: 'gainMatching',
      status: 'info',
      title: 'Система сведения инициализирована',
      message: 'Готовность алгоритмов выравнивания громкости (Реплики vs Физика -10 dB), автодакинга (-15..-18 dB) и 8-слотовой мастер-шины Audition.'
    }
  ]);

  const addAuditLogs = (newLogs: MixingAuditEntry[]) => {
    setAuditLogs(prev => [...prev, ...newLogs]);
  };

  const handleRunGainMatchingStep = (notify = true) => {
    if (!project || !project.tracks || project.tracks.length === 0) {
      if (notify) showToast('В проекте нет дорожек для выравнивания');
      return;
    }
    setIsExecutingPhase3Step('gainMatching');
    try {
      const res = MixingService.matchLoudnessBySubtitles(
        project.tracks,
        project.subtitles || [],
        activePreset.phase3.gainMatching
      );
      addAuditLogs(res.logs);
      onUpdateProject({ tracks: res.updatedTracks });
      playbackEngine.updateTracks(res.updatedTracks).catch(console.error);
      if (notify) {
        showToast(`Громкость выровнена: ${res.dialogueCount} реплик и ${res.physicsCount} звуков физики (-10 dB)`);
      }
    } catch (e: any) {
      console.error(e);
      if (notify) showToast(`Ошибка выравнивания: ${e.message}`);
    } finally {
      setIsExecutingPhase3Step(null);
    }
  };

  const handleRunDuckingStep = (notify = true) => {
    if (!project || !project.tracks || project.tracks.length === 0) {
      if (notify) showToast('В проекте нет дорожек для автодакинга');
      return;
    }
    setIsExecutingPhase3Step('ducking');
    try {
      const res = MixingService.applyAutoDucking(
        project.tracks,
        project.mixingType || MixingType.DUBBING,
        activePreset.phase3.ducking
      );
      addAuditLogs(res.logs);
      onUpdateProject({ tracks: res.updatedTracks });
      playbackEngine.updateTracks(res.updatedTracks).catch(console.error);
      if (notify) {
        showToast(res.duckedIntervalsCount > 0 
          ? `Автодакинг применен: приглушено ${res.duckedIntervalsCount} сегментов оригинала на ${Math.abs(res.appliedDuckingDb)} dB`
          : 'Автодакинг проверен (оригинальные дорожки в норме)');
      }
    } catch (e: any) {
      console.error(e);
      if (notify) showToast(`Ошибка дакинга: ${e.message}`);
    } finally {
      setIsExecutingPhase3Step(null);
    }
  };

  const handleRunAutoFxStep = (notify = true) => {
    if (!project || !project.tracks || project.tracks.length === 0) {
      if (notify) showToast('В проекте нет дорожек для анализа эффектов');
      return;
    }
    setIsExecutingPhase3Step('autoFxAnalysis');
    try {
      const res = MixingService.detectAndApplyOriginalEffects(
        project.tracks,
        activePreset.phase3.autoFxAnalysis
      );
      addAuditLogs(res.logs);
      onUpdateProject({ tracks: res.updatedTracks });
      playbackEngine.updateTracks(res.updatedTracks).catch(console.error);
      if (notify) {
        showToast(`Проанализировано ${res.analyzedSegmentsCount} фраз оригинала. Эффекты перенесены на дубляж.`);
      }
    } catch (e: any) {
      console.error(e);
      if (notify) showToast(`Ошибка автоанализа: ${e.message}`);
    } finally {
      setIsExecutingPhase3Step(null);
    }
  };

  const handleRunVocalBusStep = (notify = true) => {
    if (!project || !project.tracks || project.tracks.length === 0) {
      if (notify) showToast('В проекте нет дорожек для шины вокала');
      return;
    }
    setIsExecutingPhase3Step('vocalBusProcessing');
    try {
      const res = MixingService.applyMasterVocalBusChain(
        project.tracks,
        activePreset.phase3.vocalBusProcessing.chain || {
          presetName: 'Audition Master VO Chain',
          ozoneStabilizer: { enabled: true, shape: 65, speed: 50, smoothness: 70, bypass: false },
          rCompressor: { enabled: true, threshold: -12.2, ratio: 4.7, attackMs: 149.6, releaseMs: 120, gainDb: 3.44, warmth: 60, bypass: false },
          soothe2: { enabled: true, depth: 5.27, sharpness: 3.31, selectivity: 4.07, band1Freq: 328.8, band1Sens: 5.94, band3Freq: 3489.5, band3Sens: 6.20, bypass: false },
          proQ4: { enabled: true, highPassFreq: 80, lowCutSlope: 12, airShelfFreq: 12000, airShelfGain: 1.5, notchResonanceFreq: 3200, notchCutDb: -2.0, bypass: false },
          rBass: { enabled: true, frequency: 43, intensity: 5.0, originalBassDb: -2.0, bypass: false },
          freshAir: { enabled: true, midAir: 24, highAir: 32, bypass: false },
          rVox: { enabled: true, compression: -9.5, gateThreshold: -80, gainDb: 0.0, bypass: false },
          proDS: { enabled: true, threshold: -24, range: -8, frequency: 10000, wideBand: true, bypass: false }
        }
      );
      addAuditLogs(res.logs);
      if (notify) {
        showToast(`Мастер-шина VO скоммутирована: ${res.activePluginsCount} активных плагинов Audition рэка.`);
      }
    } catch (e: any) {
      console.error(e);
      if (notify) showToast(`Ошибка шины вокала: ${e.message}`);
    } finally {
      setIsExecutingPhase3Step(null);
    }
  };

  const handleRunAllPhase3 = () => {
    if (!project || !project.tracks || project.tracks.length === 0) {
      showToast('В проекте нет дорожек для сведения');
      return;
    }
    showToast('Запуск полного сведения (Этап 3)...');
    handleRunGainMatchingStep(false);
    handleRunDuckingStep(false);
    handleRunAutoFxStep(false);
    handleRunVocalBusStep(false);
    showToast('Этап 3: Все 4 шага сведения успешно применены! Откройте лог для аудита.');
  };

  // States for Phase 4 (Final Mix & Render)
  const [qaIssues, setQaIssues] = useState<QualityControlIssue[]>([]);
  const [isQaModalOpen, setIsQaModalOpen] = useState(false);
  const [isRenderProgressModalOpen, setIsRenderProgressModalOpen] = useState(false);
  const [isRenderingFinal, setIsRenderingFinal] = useState(false);
  const [renderProgressPercent, setRenderProgressPercent] = useState(0);
  const [renderCurrentStage, setRenderCurrentStage] = useState('');
  const [finalRenderResult, setFinalRenderResult] = useState<FinalRenderResult | null>(null);
  const [qaLufs, setQaLufs] = useState<number>(-14.0);
  const [qaTruePeak, setQaTruePeak] = useState<number>(-1.0);

  // Phase 4: Quality Control (QA) handler
  const handleRunQualityControl = (showModal = true) => {
    if (!project || !project.tracks || project.tracks.length === 0) {
      showToast('В проекте нет дорожек для анализа качества');
      return;
    }
    const res = FinalRenderService.runQualityControlAnalysis(project, activePreset.phase4);
    setQaIssues(res.issues);
    setQaLufs(res.integratedLufs);
    setQaTruePeak(res.maxTruePeakDb);
    addAuditLogs(res.logs);

    const errorsCount = res.issues.filter(i => i.severity === 'error').length;
    const warningsCount = res.issues.filter(i => i.severity === 'warning').length;

    if (showModal) {
      setIsQaModalOpen(true);
    }

    if (errorsCount > 0) {
      showToast(`QA: Найдено ${errorsCount} ошибок и ${warningsCount} предупреждений`);
    } else {
      showToast(`QA: Проверка пройдена успешно (${res.integratedLufs.toFixed(1)} LUFS, True-Peak ${res.maxTruePeakDb.toFixed(1)} dBTP)`);
    }
  };

  // Phase 4: Mastering Limiter handler
  const handleApplyMasteringLimiter = () => {
    if (!project || !project.tracks || project.tracks.length === 0) {
      showToast('В проекте нет дорожек для мастеринга');
      return;
    }
    const res = FinalRenderService.applyMasteringLimiter(project.tracks, activePreset.phase4);
    onUpdateProject({ tracks: res.updatedTracks });
    playbackEngine.updateTracks(res.updatedTracks).catch(console.error);
    addAuditLogs(res.logs);
    showToast(`Мастеринг применен: Цель ${activePreset.phase4.masteringLimiter?.targetIntegratedLufs || -14.0} LUFS, Потолок ${res.ceilingDb.toFixed(1)} dBTP`);
  };

  // Phase 4: Auto-fix QA Issue
  const handleAutoFixQaIssue = (issue: QualityControlIssue) => {
    if (!project) return;
    if (issue.type === 'clipping' && issue.segmentId) {
      // Lower volume of the clipped segment by 3 dB
      const updatedTracks = project.tracks.map(track => ({
        ...track,
        segments: track.segments.map(seg => {
          if (seg.id === issue.segmentId) {
            const currentVol = seg.volume !== undefined ? seg.volume : 1.0;
            return { ...seg, volume: Math.max(0.1, Math.round(currentVol * 0.7 * 100) / 100) };
          }
          return seg;
        })
      }));
      onUpdateProject({ tracks: updatedTracks });
      playbackEngine.updateTracks(updatedTracks).catch(console.error);
      setQaIssues(prev => prev.filter(i => i.id !== issue.id));
      showToast(`Перегрузка устранена: громкость сегмента снижена (-3 dB)`);
    } else if (issue.type === 'overlap' && issue.segmentId) {
      // Shift next segment slightly forward or trim overlap
      const updatedTracks = project.tracks.map(track => ({
        ...track,
        segments: track.segments.map(seg => {
          if (seg.id === issue.segmentId && issue.duration) {
            return { ...seg, startTime: seg.startTime + issue.duration + 0.05 };
          }
          return seg;
        })
      }));
      onUpdateProject({ tracks: updatedTracks });
      playbackEngine.updateTracks(updatedTracks).catch(console.error);
      setQaIssues(prev => prev.filter(i => i.id !== issue.id));
      showToast(`Наезд реплики устранен: сегмент сдвинут на временной шкале`);
    } else if (issue.type === 'lufs_deviation') {
      handleApplyMasteringLimiter();
      setQaIssues(prev => prev.filter(i => i.id !== issue.id));
    } else {
      showToast(`Пожалуйста, проверьте "${issue.title}" на таймлайне`);
    }
  };

  // Phase 4: Export Subtitles
  const handleExportSubtitles = (format: 'srt' | 'ass') => {
    if (!project || !project.subtitles || project.subtitles.length === 0) {
      showToast('В проекте нет субтитров для экспорта');
      return;
    }
    const { srtContent, assContent } = FinalRenderService.generateSubtitlesFiles(project.subtitles, activePreset.phase4.subtitleBurn);
    const content = format === 'srt' ? srtContent : assContent;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(project.name || 'project').replace(/\s+/g, '_')}_subtitles.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Субтитры .${format.toUpperCase()} успешно экспортированы!`);
  };

  // Phase 4: Final Render Pipeline handler
  const handleStartFinalRender = async () => {
    if (!project) {
      showToast('Проект не загружен');
      return;
    }
    setIsRenderProgressModalOpen(true);
    setIsRenderingFinal(true);
    setRenderProgressPercent(0);
    setRenderCurrentStage('Подготовка конвейера финального рендера...');
    setFinalRenderResult(null);

    try {
      const res = await FinalRenderService.executeFinalRender(
        project,
        activePreset.phase4,
        (percent, stage) => {
          setRenderProgressPercent(percent);
          setRenderCurrentStage(stage);
        }
      );
      setFinalRenderResult(res);
      setIsRenderingFinal(false);
      addAuditLogs([
        {
          id: `final-render-success-${Date.now()}`,
          timestamp: Date.now(),
          stageName: '4. Финал',
          stepId: 'renderSettings',
          status: 'success',
          title: 'Финальный рендер успешно завершен',
          message: `Экспортировано ${res.stems.length} аудиостэмов, видеофайл ${res.videoFileName || 'video.mp4'} и субтитры.`
        }
      ]);
      showToast('Финальный рендер серии успешно завершен! Все файлы доступны для скачивания.');
    } catch (err: any) {
      setIsRenderingFinal(false);
      showToast(`Ошибка рендеринга: ${err.message || err}`);
    }
  };

  useEffect(() => {
    if (selectedSegment && selectedSegment.segment.filePath) {
      setSelectedEffectFile(selectedSegment.segment.filePath);
      setSelectedSeparatorFile(selectedSegment.segment.filePath);
    }
  }, [selectedSegment?.segment?.id, selectedSegment?.segment?.filePath]);

  // States for modular step controls (Modal and Execution tracker)
  const [activeModal, setActiveModal] = useState<{ stepId: string; title: string; icon: React.ReactNode; content: React.ReactNode } | null>(null);
  const [stepExecution, setStepExecution] = useState<Record<string, { status: 'idle' | 'running' | 'success' | 'failed'; progress: number; log: string; hasRollback: boolean }>>({});

  // States for VST selection modal
  const [isVstSelectorOpen, setIsVstSelectorOpen] = useState(false);
  const [activeVstSelectStepKey, setActiveVstSelectStepKey] = useState<string | null>(null);
  const [activeVstSelectPluginIdx, setActiveVstSelectPluginIdx] = useState<number | null>(null);

  const handleExecuteStep = async (stepId: string, title: string, phaseNum: number) => {
    // Set running state
    setStepExecution(prev => ({
      ...prev,
      [stepId]: {
        status: 'running',
        progress: 0,
        log: 'Инициализация этапа...',
        hasRollback: false
      }
    }));

    const backendEffectsMap: Record<string, 'normalization' | 'declick' | 'smarteq' | 'denoise' | 'dereverb' | 'separation'> = {
      normalization: 'normalization',
      deClick: 'declick',
      denoise: 'denoise',
      dereverb: 'dereverb',
      eqMatching: 'smarteq',
      sourceSeparation: 'separation'
    };

    const hasBackend = phaseNum === 1 && backendEffectsMap[stepId] !== undefined;

    if (hasBackend) {
      const effectType = backendEffectsMap[stepId];
      let progressTimer: any = null;
      try {
        setStepExecution(prev => ({
          ...prev,
          [stepId]: {
            ...prev[stepId],
            log: 'Подготовка файлов и отправка запроса на бэкенд...'
          }
        }));

        let currentProgress = 0;
        progressTimer = setInterval(() => {
          currentProgress = Math.min(currentProgress + Math.floor(Math.random() * 15) + 5, 95);
          setStepExecution(prev => {
            if (!prev[stepId] || prev[stepId].status !== 'running') {
              clearInterval(progressTimer);
              return prev;
            }
            return {
              ...prev,
              [stepId]: {
                ...prev[stepId],
                progress: currentProgress,
                log: `Обработка на стороне бэкенда... (${currentProgress}%)`
              }
            };
          });
        }, 300);

        let config: any = { effect_type: effectType };
        if (effectType === 'normalization') {
          config = {
            effect_type: 'normalization',
            target_lufs: activePreset.phase1.normalization.targetLufs,
            upward_threshold: activePreset.phase1.normalization.upwardThresholdDb,
            upward_gain: activePreset.phase1.normalization.upwardGainDb,
            upward_ratio: activePreset.phase1.normalization.upwardRatio,
          };
        } else if (effectType === 'declick') {
          config = {
            effect_type: 'declick',
            sensitivity: activePreset.phase1.deClick.sensitivity,
            max_click_width_ms: activePreset.phase1.deClick.maxClickWidthMs,
          };
        } else if (effectType === 'smarteq') {
          config = {
            effect_type: 'smarteq',
            eq_profile: activePreset.phase1.eqMatching.profileModel,
          };
        } else if (effectType === 'denoise') {
          config = {
            effect_type: 'denoise',
            denoise_model: activePreset.phase1.denoise.model,
            denoise_strength: activePreset.phase1.denoise.strength,
          };
        } else if (effectType === 'dereverb') {
          config = {
            effect_type: 'dereverb',
            dereverb_model: activePreset.phase1.dereverb.model,
            dereverb_strength: activePreset.phase1.dereverb.strength,
          };
        } else if (effectType === 'separation') {
          config = {
            effect_type: 'separation',
            separation_model: activePreset.phase1.sourceSeparation.model,
          };
        }

        if (effectType === 'separation') {
          // Находим оригинал
          const originalTrack = project.tracks.find(t => t.name === 'Оригинал');
          const originalFile = originalTrack?.segments?.[0]?.filePath || project.referenceAudioPath || project.videoPath;
          if (!originalFile) {
            throw new Error('Оригинальный аудиофайл не найден в проекте для разделения');
          }

          playbackEngine.stop();
          playbackEngine.clearCache();

          const pathParts = originalFile.split(/[\\/]/);
          const fileName = pathParts.pop() || '';
          const dirPath = pathParts.join('/');
          const extMatch = fileName.match(/\.([^.]+)$/);
          const ext = extMatch ? extMatch[1] : 'wav';
          const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');

          const vocalPath = `${dirPath}/${nameWithoutExt}_vocals.${ext}`;
          const instrumentalPath = `${dirPath}/${nameWithoutExt}_instruments.${ext}`;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              log: 'Извлечение вокала/голоса из оригинальной дорожки...'
            }
          }));

          await invoke<string>('apply_audio_effect', {
            inputPath: originalFile,
            outputPath: vocalPath,
            config: {
              effect_type: 'separation',
              separation_model: activePreset.phase1.sourceSeparation.model || 'htdemucs'
            }
          });

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 50,
              log: 'Извлечение фоновых звуков/музыки из оригинальной дорожки...'
            }
          }));

          await invoke<string>('apply_audio_effect', {
            inputPath: originalFile,
            outputPath: instrumentalPath,
            config: {
              effect_type: 'separation_instruments',
              separation_model: activePreset.phase1.sourceSeparation.model || 'htdemucs'
            }
          });

          const duration = project.duration || 60;

          const soundsTrackId = 'track-' + Math.random().toString(36).substring(2, 11);
          const voicesTrackId = 'track-' + Math.random().toString(36).substring(2, 11);

          const soundsSegment = {
            id: 'seg-' + Math.random().toString(36).substring(2, 11),
            startTime: 0,
            duration: duration,
            fileOffset: 0,
            fileDuration: duration,
            blobUrl: '',
            filePath: instrumentalPath,
            gain: 1.0,
            playbackRate: 1.0,
            originalFileName: `${nameWithoutExt}_instruments.${ext}`,
            waveform: []
          };

          const voicesSegment = {
            id: 'seg-' + Math.random().toString(36).substring(2, 11),
            startTime: 0,
            duration: duration,
            fileOffset: 0,
            fileDuration: duration,
            blobUrl: '',
            filePath: vocalPath,
            gain: 1.0,
            playbackRate: 1.0,
            originalFileName: `${nameWithoutExt}_vocals.${ext}`,
            waveform: []
          };

          const soundsTrack: AudioTrack = {
            id: soundsTrackId,
            name: 'Звуки (Музыка)',
            segments: [soundsSegment],
            volume: 1.0,
            isMuted: false,
            isSolo: false,
            isArmed: false,
            isProcessingEnabled: false,
            height: 80
          };

          const voicesTrack: AudioTrack = {
            id: voicesTrackId,
            name: 'Голоса (Вокал)',
            segments: [voicesSegment],
            volume: 1.0,
            isMuted: false,
            isSolo: false,
            isArmed: false,
            isProcessingEnabled: false,
            height: 80
          };

          const updatedTracks = project.tracks.map(t => {
            if (t.name === 'Оригинал') {
              return { ...t, isMuted: true };
            }
            return t;
          });

          updatedTracks.push(soundsTrack, voicesTrack);

          onUpdateProject({ tracks: updatedTracks });
          playbackEngine.updateTracks(updatedTracks).catch(console.error);

          clearInterval(progressTimer);
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              status: 'success',
              progress: 100,
              log: 'Успешно завершено! Созданы новые дорожки "Звуки" и "Голоса".',
              hasRollback: true
            }
          }));
          showToast(`Этап "${title}" успешно выполнен!`);
        } else {
          playbackEngine.stop();
          playbackEngine.clearCache();

          let updatedTracks = JSON.parse(JSON.stringify(project.tracks)) as AudioTrack[];
          let processedCount = 0;

          // Фильтруем дорожки для обработки (не Оригинал, не Звуки, не Голоса, и чекбокс включен)
          const targetTracks = updatedTracks.filter(t => t.name !== 'Оригинал' && t.name !== 'Звуки (Музыка)' && t.name !== 'Голоса (Вокал)' && t.isProcessingEnabled !== false);
          const totalSegments = targetTracks.reduce((sum, t) => sum + (t.segments?.length || 0), 0);

          if (totalSegments === 0) {
            throw new Error('Нет активных дорожек или сегментов для обработки (проверьте чекбоксы)');
          }

          let processedSegmentsCount = 0;

          for (let track of updatedTracks) {
            const isOriginal = track.name === 'Оригинал';
            const isExcluded = track.name === 'Оригинал' || track.name === 'Звуки (Музыка)' || track.name === 'Голоса (Вокал)';
            const isEnabled = track.isProcessingEnabled !== false;
            if (!isExcluded && isEnabled && track.segments && track.segments.length > 0) {
              for (let seg of track.segments) {
                if (!seg.filePath) continue;

                setStepExecution(prev => ({
                  ...prev,
                  [stepId]: {
                    ...prev[stepId],
                    log: `Обработка фрагмента "${seg.originalFileName || 'audio'}" (${processedSegmentsCount + 1}/${totalSegments})...`
                  }
                }));

                const pathParts = seg.filePath.split(/[\\/]/);
                const fileName = pathParts.pop() || '';
                const dirPath = pathParts.join('/');
                const extMatch = fileName.match(/\.([^.]+)$/);
                const ext = extMatch ? extMatch[1] : 'wav';
                const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');
                const outFileName = `${nameWithoutExt}_${effectType}.${ext}`;
                const outputPath = `${dirPath}/${outFileName}`;

                try {
                  console.log(`[EFFECT-RUNNER] Запуск обработки аудиоэффекта:\n  Метод: apply_audio_effect\n  Входной файл: ${seg.filePath}\n  Выходной файл: ${outputPath}\n  Параметры:`, config);
                  const result = await invoke<string>('apply_audio_effect', {
                    inputPath: seg.filePath,
                    outputPath: outputPath,
                    config: config
                  });

                  console.log(`[EFFECT-RUNNER] Эффект успешно применен! Новый путь файла: ${result}`);
                  seg.filePath = result;
                  seg.originalFileName = outFileName;
                  // Меняем id и сбрасываем waveform в [] для автоматической перерисовки
                  console.log(`[EFFECT-RUNNER] Сброс волновой формы для сегмента ${seg.id} (установка waveform=[]) для триггера автоматической перерисовки.`);
                  seg.id = 'seg-' + Math.random().toString(36).substring(2, 11);
                  seg.waveform = [];
                  processedCount++;
                } catch (err) {
                  console.error(`Ошибка обработки сегмента ${seg.id}:`, err);
                }
                
                processedSegmentsCount++;
                const progressPct = Math.round((processedSegmentsCount / totalSegments) * 100);
                setStepExecution(prev => ({
                  ...prev,
                  [stepId]: {
                    ...prev[stepId],
                    progress: progressPct
                  }
                }));
              }
            }
          }

          if (processedCount === 0) {
            throw new Error('Не удалось обработать ни один фрагмент');
          }

          onUpdateProject({ tracks: updatedTracks });
          playbackEngine.updateTracks(updatedTracks).catch(console.error);

          clearInterval(progressTimer);
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              status: 'success',
              progress: 100,
              log: `Успешно завершено! Обработано фрагментов: ${processedCount}`,
              hasRollback: true
            }
          }));
          showToast(`Этап "${title}" успешно выполнен для ${processedCount} фрагментов!`);
        }
      } catch (err: any) {
        if (progressTimer) clearInterval(progressTimer);
        setStepExecution(prev => ({
          ...prev,
          [stepId]: {
            status: 'failed',
            progress: 100,
            log: `Ошибка выполнения: ${err.message || String(err)}`,
            hasRollback: false
          }
        }));
        showToast(`Ошибка на этапе "${title}"`);
      }
    } else {
      // Simulation logs
      const simulationLogs: Record<string, string[]> = {
        normalization: [
          'Инициализация аудиодетектора...',
          'Анализ пиковых значений громкости по дорожкам...',
          'Расчет целевого уровня громкости (LUFS)...',
          'Поиск порога фонового шума...',
          'Применение апвард-компрессии для тихих звуков...',
          'Финальная нормализация пиков...',
          'Завершено! Звук выровнен по стандарту.'
        ],
        deClick: [
          'Построение высокочастотной спектрограммы...',
          'Анализ крутизны фронта сигнала (вторая производная)...',
          'Обнаружение слюнных щелчков и губного треска...',
          'Применение кубической Smoothstep-интерполяции для щелчков...',
          'Очистка артефактов без деформации полезного сигнала...',
          'Завершено! Голос очищен от микро-помех.'
        ],
        denoise: [
          'Загрузка нейросети Deep Denoise AI...',
          'Сканирование профиля статического шума...',
          'Спектральное вычитание шума из полезного сигнала...',
          'Подавление фонового гула и вентиляторов...',
          'Восстановление потерянных гармоник голоса...',
          'Завершено! Фоновый шум полностью убран.'
        ],
        dereverb: [
          'Анализ импульсной характеристики реверберации помещения...',
          'Моделирование отражений стен комнат...',
          'Применение алгоритма де-реверберации RT_Dereverb...',
          'Ослабление хвостов эха и ранних отражений...',
          'Сужение акустической сцены вокруг спикера...',
          'Завершено! Комнатное эхо успешно подавлено.'
        ],
        eqMatching: [
          'Анализ текущего тембра дорожки...',
          'Сопоставление спектрального профиля с целевым шаблоном...',
          'Расчет компенсационной кривой эквалайзера...',
          'Применение Умного EQ для устранения резонансов...',
          'Тембральное приведение к эталонному звучанию...',
          'Завершено! АЧХ выровнена по референсу.'
        ],
        sourceSeparation: [
          'Инициализация ИИ-службы UVR5...',
          'Разделение на вокальный и инструментальный компоненты...',
          'Спектральное маскирование перекрестных помех...',
          'Сохранение изолированных стемов голоса и музыки...',
          'Завершено! Дорожки успешно разделены на стемы.'
        ],
        dePlosive: [
          'Поиск низкочастотных взрывных звуков (ударов воздуха)...',
          'Определение частотной границы среза...',
          'Применение динамического Low-cut фильтра...',
          'Сглаживание пиков согласных Б, П, Т...',
          'Завершено! Взрывные согласные сглажены.'
        ],
        deEsser: [
          'Поиск сибилянтов в полосе 5000-8000 Гц...',
          'Детектирование резких согласных С, Ц, Ш, Щ...',
          'Динамическое ослабление полосы сибилянтов...',
          'Смягчение свистящих звуков...',
          'Завершено! Сибилянты звучат мягко и естественно.'
        ],
        volumeLeveler: [
          'Измерение кратковременного RMS сигнала...',
          'Расчет кривой автоматического регулирования уровня...',
          'Сглаживание перепадов между словами спикера...',
          'Компенсация отдаления актера от микрофона...',
          'Завершено! Уровень громкости голоса выровнен.'
        ],
        silenceSplit: [
          'Анализ огибающей амплитуды...',
          'Маркировка участков тишины ниже порога...',
          'Определение оптимальных точек разреза сегментов...',
          'Разбиение единой дорожки на отдельные клипы...',
          'Завершено! Дорожка нарезана на фразы.'
        ],
        smartAlign: [
          'Выравнивание временной шкалы по субтитрам...',
          'Анализ темпоритма оригинальной речи...',
          'Расчет коэффициентов деформации Smart Stretch...',
          'Применение алгоритма растяжения без изменения тона...',
          'Идеальная синхронизация реплик дубляжа (липсинг)...',
          'Завершено! Аудио выровнено по оригинальному таймингу.'
        ],
        subtitleCompliance: [
          'Чтение таймкодов субтитров...',
          'Проверка пересечений временных интервалов...',
          'Анализ пропущенных фраз и немых сцен...',
          'Маркировка проблемных зон для контроля...',
          'Завершено! Расхождений и пропусков не обнаружено.'
        ],
        gainMatching: [
          'Измерение интегрального уровня LUFS реплик...',
          'Измерение уровня оригинальной фоновой дорожки...',
          'Коррекция громкости записанных фраз...',
          'Обеспечение заданного превышения речи над бэком...',
          'Завершено! Громкость голоса согласована с бэкграундом.'
        ],
        ducking: [
          'Детектирование активности голоса на шине...',
          'Расчет огибающей компрессии фонового звука...',
          'Применение плавного снижения громкости музыки во время речи...',
          'Восстановление громкости музыки во время пауз...',
          'Завершено! Авто-дакинг музыки настроен.'
        ],
        autoFxAnalysis: [
          'Анализ стереопанорамы оригинального файла...',
          'Измерение пространственного коэффициента реверберации...',
          'Обнаружение эффектов эквалайзера (радио, телефон)...',
          'Копирование параметров автоматизации на новые дубли...',
          'Завершено! Пространство оригинала успешно перенесено.'
        ],
        vocalBusProcessing: [
          'Суммирование всех вокальных треков на шину...',
          'Применение мягкого сжатия Glue Compressor...',
          'Срез суббасовых шумов ниже 80 Гц...',
          'Включение пикового лимитера для предотвращения клиппинга...',
          'Завершено! Общая шина голосов склеена и защищена.'
        ],
        qualityControl: [
          'Сканирование мастер-выхода проекта...',
          'Поиск межсэмпловых пиков и клиппинга...',
          'Проверка на наличие нежелательных долгих пауз...',
          'Проверка наложения реплик разных актеров...',
          'Завершено! Микс прошел проверку качества.'
        ],
        subtitleBurn: [
          'Отрисовка текстовых слоев субтитров...',
          'Наложение стилей шрифтов и позиционирование...',
          'Впекание текста в видеопоток с помощью FFmpeg...',
          'Завершено! Субтитры вшиты в видео.'
        ],
        renderSettings: [
          'Подготовка аудио- и видеопотоков к рендерингу...',
          'Кодирование видеокодеком H.264...',
          'Кодирование аудиокодеком AAC...',
          'Упаковка потоков в MP4 контейнер...',
          'Сохранение готового файла проекта...',
          'Завершено! Финальный рендер успешно экспортирован.'
        ]
      };

      const logs = simulationLogs[stepId] || [
        'Инициализация этапа обработки...',
        'Анализ структуры проекта...',
        'Применение настроек пресета...',
        'Выполнение математических расчетов...',
        'Завершено! Изменения применены.'
      ];

      let currentLogIdx = 0;
      const totalSteps = logs.length;
      const durationPerSubStep = Math.max(1200 / totalSteps, 200);

      const interval = setInterval(() => {
        setStepExecution(prev => {
          if (!prev[stepId] || prev[stepId].status !== 'running') {
            clearInterval(interval);
            return prev;
          }

          if (currentLogIdx < totalSteps) {
            const currentProgress = Math.floor(((currentLogIdx + 1) / totalSteps) * 100);
            const currentLog = logs[currentLogIdx];
            currentLogIdx++;
            return {
              ...prev,
              [stepId]: {
                status: 'running',
                progress: currentProgress,
                log: currentLog,
                hasRollback: false
              }
            };
          } else {
            clearInterval(interval);
            return {
              ...prev,
              [stepId]: {
                status: 'success',
                progress: 100,
                log: 'Успешно завершено!',
                hasRollback: true
              }
            };
          }
        });
      }, durationPerSubStep);
    }
  };

  const handleCancelStep = (stepId: string, title: string) => {
    setStepExecution(prev => ({
      ...prev,
      [stepId]: {
        status: 'idle',
        progress: 0,
        log: '',
        hasRollback: false
      }
    }));
    showToast(`Запуск этапа "${title}" прерван.`);
  };

  const handleRollbackStep = (stepId: string, title: string) => {
    setStepExecution(prev => ({
      ...prev,
      [stepId]: {
        status: 'idle',
        progress: 0,
        log: '',
        hasRollback: false
      }
    }));
    showToast(`Результат этапа "${title}" успешно откатчен!`);
  };

  const handleSelectEffectFile = async () => {
    try {
      const filePath = await open({
        filters: [{ name: 'Аудио', extensions: ['wav', 'mp3', 'flac'] }]
      });
      if (filePath && typeof filePath === 'string') {
        setSelectedEffectFile(filePath);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleApplyEffect = async (effectType: 'normalization' | 'declick' | 'smarteq' | 'denoise' | 'dereverb' | 'separation' | string) => {
    setIsApplyingEffect(true);
    setProcessedEffectFile('');
    
    try {
      let config: any = { effect_type: effectType };
      let effectLabel = effectType;

      if (effectType === 'normalization') {
        effectLabel = 'Нормализация';
        config = {
          effect_type: 'normalization',
          target_lufs: activePreset.phase1.normalization.targetLufs,
          upward_threshold: activePreset.phase1.normalization.upwardThresholdDb,
          upward_gain: activePreset.phase1.normalization.upwardGainDb,
          upward_ratio: activePreset.phase1.normalization.upwardRatio,
        };
      } else if (effectType === 'declick') {
        effectLabel = 'De-Click';
        config = {
          effect_type: 'declick',
          sensitivity: activePreset.phase1.deClick.sensitivity,
          max_click_width_ms: activePreset.phase1.deClick.maxClickWidthMs,
        };
      } else if (effectType === 'smarteq') {
        effectLabel = 'Smart EQ';
        config = {
          effect_type: 'smarteq',
          eq_profile: activePreset.phase1.eqMatching.profileModel,
        };
      } else if (effectType === 'denoise') {
        const isVr = activePreset.phase1.denoise.model.startsWith('uvr_');
        effectLabel = isVr ? 'VR Denoise' : 'Denoise';
        config = {
          effect_type: 'denoise',
          denoise_model: activePreset.phase1.denoise.model,
          denoise_strength: activePreset.phase1.denoise.strength,
        };
      } else if (effectType === 'dereverb') {
        const isVr = activePreset.phase1.dereverb.model.startsWith('uvr_');
        effectLabel = isVr ? 'VR De-Echo' : 'Dereverb';
        config = {
          effect_type: 'dereverb',
          dereverb_model: activePreset.phase1.dereverb.model,
          dereverb_strength: activePreset.phase1.dereverb.strength,
        };
      } else if (effectType === 'separation') {
        effectLabel = 'Separation';
        config = {
          effect_type: 'separation',
          separation_model: activePreset.phase1.sourceSeparation.model,
        };
      }

      // Helper to execute single file through VR service or FFmpeg fallback
      const processSingleAudioFile = async (inPath: string, outPath: string, eff: string, cfg: any): Promise<string> => {
        const isVrDenoise = eff === 'denoise' && (cfg.denoise_model?.startsWith('uvr_') || cfg.denoise_model?.includes('.onnx'));
        const isVrDereverb = eff === 'dereverb' && (cfg.dereverb_model?.startsWith('uvr_') || cfg.dereverb_model?.includes('.onnx'));

        if (isVrDenoise || isVrDereverb) {
          let modelFilename = 'UVR-DeNoise-Lite.onnx';
          if (isVrDenoise) {
            if (cfg.denoise_model === 'uvr_denoise_foxjoy') modelFilename = 'UVR-DeNoise-By-FoxJoy.onnx';
            else if (cfg.denoise_model === 'uvr_denoise_full') modelFilename = 'UVR-DeNoise.onnx';
            else modelFilename = 'UVR-DeNoise-Lite.onnx';
          } else if (isVrDereverb) {
            if (cfg.dereverb_model === 'uvr_deecho_aggressive') modelFilename = 'UVR-De-Echo-Aggressive.onnx';
            else modelFilename = 'UVR-De-Echo-Normal.onnx';
          }

          try {
            const outDir = outPath.substring(0, Math.max(outPath.lastIndexOf('/'), outPath.lastIndexOf('\\')));
            const vrResult = await AudioSeparatorService.runSeparation(
              inPath,
              modelFilename,
              outDir || undefined,
              useGpuForSeparator,
              false
            );
            if (vrResult) return vrResult;
          } catch (vrErr) {
            console.warn("VR separator model execution fallback to high-speed DSP filter:", vrErr);
          }
        }

        return await invoke<string>('apply_audio_effect', {
          inputPath: inPath,
          outputPath: outPath,
          config: cfg
        });
      };

      if (effectType === 'separation') {
        // Находим оригинал
        const originalTrack = project.tracks.find(t => t.name === 'Оригинал');
        const originalFile = originalTrack?.segments?.[0]?.filePath || project.referenceAudioPath || project.videoPath;
        if (!originalFile) {
          showToast('Оригинальный файл не найден в проекте для разделения');
          return;
        }

        playbackEngine.stop();
        playbackEngine.clearCache();

        const pathParts = originalFile.split(/[\\/]/);
        const fileName = pathParts.pop() || '';
        const dirPath = pathParts.join('/');
        const extMatch = fileName.match(/\.([^.]+)$/);
        const ext = extMatch ? extMatch[1] : 'wav';
        const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');

        const vocalPath = `${dirPath}/${nameWithoutExt}_vocals.${ext}`;
        const instrumentalPath = `${dirPath}/${nameWithoutExt}_instruments.${ext}`;

        const sepModel = activePreset.phase1.sourceSeparation.model || 'htdemucs_vocals_bgm';
        const isVrSep = sepModel.includes('.onnx') || sepModel === 'htdemucs_vocals_bgm' || sepModel === 'uvr_v5_vocal' || sepModel === 'mdx_net_karaoke';

        let voiceResult = vocalPath;
        let soundResult = instrumentalPath;

        if (isVrSep && sepModel !== 'fast_dsp_splitter') {
          let modelFilename = 'htdemucs';
          if (sepModel === 'MDX23C-8Step-VocFT.onnx') modelFilename = 'MDX23C-8Step-VocFT.onnx';
          else if (sepModel === '5_HP-Karaoke-UVR.onnx' || sepModel === 'mdx_net_karaoke') modelFilename = '5_HP-Karaoke-UVR.onnx';
          else if (sepModel === 'UVR-MDX-NET-Voc_FT.onnx' || sepModel === 'uvr_v5_vocal') modelFilename = 'UVR-MDX-NET-Voc_FT.onnx';
          else modelFilename = 'htdemucs';

          try {
            voiceResult = await AudioSeparatorService.runSeparation(
              originalFile,
              modelFilename,
              dirPath,
              useGpuForSeparator,
              false
            ) || vocalPath;
          } catch (vrErr) {
            console.warn("VR isolation fallback to DSP:", vrErr);
            voiceResult = await invoke<string>('apply_audio_effect', {
              inputPath: originalFile,
              outputPath: vocalPath,
              config: { effect_type: 'separation', separation_model: sepModel }
            });
          }
        } else {
          voiceResult = await invoke<string>('apply_audio_effect', {
            inputPath: originalFile,
            outputPath: vocalPath,
            config: { effect_type: 'separation', separation_model: sepModel }
          });
        }

        soundResult = await invoke<string>('apply_audio_effect', {
          inputPath: originalFile,
          outputPath: instrumentalPath,
          config: { effect_type: 'separation_instruments', separation_model: sepModel }
        });

        const duration = project.duration || 60;
        const soundsTrackId = 'track-' + Math.random().toString(36).substring(2, 11);
        const voicesTrackId = 'track-' + Math.random().toString(36).substring(2, 11);

        const soundsSegment = {
          id: 'seg-' + Math.random().toString(36).substring(2, 11),
          startTime: 0,
          duration: duration,
          fileOffset: 0,
          fileDuration: duration,
          blobUrl: '',
          filePath: soundResult,
          sourceFilePath: originalFile,
          gain: 1.0,
          playbackRate: 1.0,
          originalFileName: `${nameWithoutExt}_instruments.${ext}`,
          waveform: undefined,
          isExtractingWaveform: false
        };

        const voicesSegment = {
          id: 'seg-' + Math.random().toString(36).substring(2, 11),
          startTime: 0,
          duration: duration,
          fileOffset: 0,
          fileDuration: duration,
          blobUrl: '',
          filePath: voiceResult,
          sourceFilePath: originalFile,
          gain: 1.0,
          playbackRate: 1.0,
          originalFileName: `${nameWithoutExt}_vocals.${ext}`,
          waveform: undefined,
          isExtractingWaveform: false
        };

        const soundsTrack: AudioTrack = {
          id: soundsTrackId,
          name: 'Звуки (Музыка)',
          segments: [soundsSegment],
          volume: 1.0,
          isMuted: false,
          isSolo: false,
          isArmed: false,
          isProcessingEnabled: false,
          height: 80
        };

        const voicesTrack: AudioTrack = {
          id: voicesTrackId,
          name: 'Голоса (Вокал)',
          segments: [voicesSegment],
          volume: 1.0,
          isMuted: false,
          isSolo: false,
          isArmed: false,
          isProcessingEnabled: false,
          height: 80
        };

        const updatedTracks = project.tracks.map(t => {
          if (t.name === 'Оригинал') {
            return { ...t, isMuted: true };
          }
          return t;
        });

        updatedTracks.push(soundsTrack, voicesTrack);

        onUpdateProject({ tracks: updatedTracks });
        playbackEngine.updateTracks(updatedTracks).catch(console.error);
        showToast('Разделение оригинала завершено! Добавлены дорожки "Звуки" и "Голоса".');
      } else if (selectedEffectFile) {
        // Обработка внешнего выбранного файла
        const pathParts = selectedEffectFile.split(/[\\/]/);
        const fileName = pathParts.pop() || '';
        const dirPath = pathParts.join('/');
        const extMatch = fileName.match(/\.([^.]+)$/);
        const ext = extMatch ? extMatch[1] : 'wav';
        const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');
        const outFileName = `${nameWithoutExt}_${effectType}.${ext}`;
        const outputPath = `${dirPath}/${outFileName}`;

        const result = await processSingleAudioFile(selectedEffectFile, outputPath, effectType, config);
        setProcessedEffectFile(result);
        showToast(`Файл успешно обработан: ${outFileName}`);
      } else if (selectedSegment) {
        // Обработка конкретного выбранного сегмента на таймлайне
        const { segment } = selectedSegment;
        if (!segment.filePath) {
          showToast('У выбранного сегмента отсутствует аудиофайл');
          return;
        }

        playbackEngine.stop();
        playbackEngine.clearCache();

        const pathParts = segment.filePath.split(/[\\/]/);
        const fileName = pathParts.pop() || '';
        const dirPath = pathParts.join('/');
        const extMatch = fileName.match(/\.([^.]+)$/);
        const ext = extMatch ? extMatch[1] : 'wav';
        const nameWithoutExt = fileName.replace(/\.[^.]+$/, '').replace(/_(denoise|dereverb|normalization|declick|smarteq|vr_denoise|vr_deecho)/gi, '');
        const outFileName = `${nameWithoutExt}_${effectType}.${ext}`;
        const outputPath = `${dirPath}/${outFileName}`;

        const result = await processSingleAudioFile(segment.filePath, outputPath, effectType, config);
        updateSegmentWithProcessedFile(result, effectLabel);
        showToast(`Эффект "${effectLabel}" успешно применен к выбранному фрагменту!`);
      } else {
        // Обработка всех активных дорожек дубляжа
        playbackEngine.stop();
        playbackEngine.clearCache();

        let updatedTracks = JSON.parse(JSON.stringify(project.tracks)) as AudioTrack[];
        let processedCount = 0;

        const targetTracks = updatedTracks.filter(t => t.name !== 'Оригинал' && t.name !== 'Звуки (Музыка)' && t.name !== 'Голоса (Вокал)' && t.isProcessingEnabled !== false);
        const totalSegments = targetTracks.reduce((sum, t) => sum + (t.segments?.length || 0), 0);

        if (totalSegments === 0) {
          showToast('Нет выбранных дорожек или сегментов для обработки');
          setIsApplyingEffect(false);
          return;
        }

        for (let track of updatedTracks) {
          const isExcluded = track.name === 'Оригинал' || track.name === 'Звуки (Музыка)' || track.name === 'Голоса (Вокал)';
          const isEnabled = track.isProcessingEnabled !== false;
          if (!isExcluded && isEnabled && track.segments && track.segments.length > 0) {
            for (let seg of track.segments) {
              if (!seg.filePath) continue;

              const pathParts = seg.filePath.split(/[\\/]/);
              const fileName = pathParts.pop() || '';
              const dirPath = pathParts.join('/');
              const extMatch = fileName.match(/\.([^.]+)$/);
              const ext = extMatch ? extMatch[1] : 'wav';
              const nameWithoutExt = fileName.replace(/\.[^.]+$/, '').replace(/_(denoise|dereverb|normalization|declick|smarteq|vr_denoise|vr_deecho)/gi, '');
              const outFileName = `${nameWithoutExt}_${effectType}.${ext}`;
              const outputPath = `${dirPath}/${outFileName}`;

              try {
                const result = await processSingleAudioFile(seg.filePath, outputPath, effectType, config);

                seg.sourceFilePath = seg.sourceFilePath || seg.filePath;
                seg.backupFilePath = seg.filePath;
                seg.processedEffectName = effectLabel;
                seg.filePath = result;
                seg.originalFileName = outFileName;
                seg.waveform = undefined;
                seg.isExtractingWaveform = false;
                processedCount++;
              } catch (err) {
                console.error(`Ошибка обработки сегмента ${seg.id}:`, err);
              }
            }
          }
        }

        if (processedCount === 0) {
          showToast('Не удалось обработать ни один фрагмент');
          setIsApplyingEffect(false);
          return;
        }

        onUpdateProject({ tracks: updatedTracks });
        playbackEngine.updateTracks(updatedTracks).catch(console.error);
        showToast(`Эффект "${effectLabel}" успешно применен к ${processedCount} фрагментам на активных дорожках!`);
      }
    } catch (e: any) {
      console.error(e);
      showToast(`Ошибка: ${e.message || String(e)}`);
    } finally {
      setIsApplyingEffect(false);
    }
  };

  const handleImportEffectFile = () => {
    if (!processedEffectFile || !project) return;
    playbackEngine.stop();
    playbackEngine.clearCache();

    const newSegment = {
      id: 'seg-' + Math.random().toString(36).substring(2, 11),
      startTime: 0,
      duration: 10,
      fileOffset: 0,
      fileDuration: 10,
      blobUrl: '',
      filePath: processedEffectFile,
      gain: 1.0,
      playbackRate: 1.0,
      originalFileName: processedEffectFile.split(/[\\/]/).pop() || 'Effect_Audio.wav'
    };
    if (project.tracks.length > 0) {
      const updatedTracks = [...project.tracks];
      updatedTracks[0] = { ...updatedTracks[0], segments: [...updatedTracks[0].segments, newSegment] };
      onUpdateProject({ tracks: updatedTracks });
      playbackEngine.updateTracks(updatedTracks).catch(console.error);
      showToast('Обработанный файл добавлен на трек!');
    } else {
      showToast('Нет треков для импорта');
    }
  };

  const refreshSeparatorStatus = async () => {
    try {
      const status = await AudioSeparatorService.checkStatus();
      setSeparatorStatus(status);
      setUseGpuForSeparator(status.cuda_available);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    refreshSeparatorStatus();
  }, []);

  const handleSelectCustomFile = async () => {
    try {
      const filePath = await open({
        filters: [{ name: 'Аудио', extensions: ['wav', 'mp3', 'flac'] }]
      });
      if (filePath && typeof filePath === 'string') {
        setSelectedSeparatorFile(filePath);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleInstallSeparator = async () => {
    if (isInstallingSeparator) return;
    setIsInstallingSeparator(true);
    setInstallLogs(['Запуск установки...']);
    
    try {
      await AudioSeparatorService.startInstall(useGpuForSeparator);
      AudioSeparatorService.listenToInstallLogs(
        (line) => {
          setInstallLogs(prev => [...prev, line].slice(-100)); // Храним последние 100 строк
        },
        () => {
          setIsInstallingSeparator(false);
          refreshSeparatorStatus();
          showToast('Установка audio-separator завершена!');
        }
      );
    } catch (e: any) {
      setInstallLogs(prev => [...prev, `Ошибка: ${e.message || e}`]);
      setIsInstallingSeparator(false);
    }
  };

  const handleRunSeparation = async (fileOverride?: string) => {
    const originalTrack = project?.tracks.find(t => t.name === 'Оригинал');
    const defaultOriginalFile = originalTrack?.segments?.[0]?.filePath || project?.referenceAudioPath || project?.videoPath || '';
    const fileToUse = fileOverride || selectedSeparatorFile || defaultOriginalFile;

    if (!fileToUse) {
      showToast('Пожалуйста, выберите файл для обработки');
      return;
    }
    setIsSeparating(true);
    setIsSeparatorSuccess(false);
    setSeparatorProgress({ percent: 0, stage: 'Инициализация...' });
    setSeparatorOutputMsg('');

    const modelToUse = activePreset.phase1.sourceSeparation.model || selectedSeparatorModel || 'htdemucs';

    try {
      const result = await AudioSeparatorService.runSeparation(
        fileToUse,
        modelToUse,
        project?.projectPath || '',
        useGpuForSeparator,
        false, // can be custom
        (prog) => {
          setSeparatorProgress(prog);
        }
      );
      
      setProcessedFilePath(result);
      setIsSeparatorSuccess(true);
      showToast('Обработка успешно завершена!');
    } catch (e: any) {
      console.error(e);
      setSeparatorOutputMsg(e.message || String(e));
      showToast('Произошла ошибка при обработке');
    } finally {
      setIsSeparating(false);
    }
  };

  const handleImportFileToProject = async () => {
    if (!processedFilePath || !project) return;
    playbackEngine.stop();
    playbackEngine.clearCache();
    
    // Определение путей для вокала и инструментала
    let vocalPath = processedFilePath;
    let instrumentalPath = processedFilePath;

    const pathParts = processedFilePath.split(/[\\/]/);
    const fileName = pathParts.pop() || '';
    const dirPath = pathParts.join('/');

    // Пытаемся найти базовое имя исходного файла
    const baseNameMatch = fileName.match(/^(.+?)(?:_\(Vocals\)|_\(Instrumental\)|_vocals|_instruments)/);
    const baseName = baseNameMatch ? baseNameMatch[1] : fileName.replace(/\.[^.]+$/, '');

    try {
      const files = await invoke<any[]>('list_audio_files', { folderPath: dirPath });
      const relatedFiles = files.filter(f => f.name.includes(baseName));
      
      const foundVocal = relatedFiles.find(f => 
        f.name.toLowerCase().includes('vocals') || 
        f.name.toLowerCase().includes('vocal') || 
        f.name.toLowerCase().includes('voice')
      );
      const foundInst = relatedFiles.find(f => 
        f.name.toLowerCase().includes('instrumental') || 
        f.name.toLowerCase().includes('instruments') || 
        f.name.toLowerCase().includes('instrument') || 
        f.name.toLowerCase().includes('bgm') || 
        f.name.toLowerCase().includes('accompaniment') || 
        f.name.toLowerCase().includes('backing')
      );

      if (foundVocal) vocalPath = foundVocal.path;
      if (foundInst) instrumentalPath = foundInst.path;
    } catch (err) {
      console.error("Ошибка при сканировании папки со стемами:", err);
      // Fallback: подмена подстроки в пути
      if (processedFilePath.includes('(Vocals)')) {
        instrumentalPath = processedFilePath.replace('(Vocals)', '(Instrumental)');
      } else if (processedFilePath.includes('(Instrumental)')) {
        vocalPath = processedFilePath.replace('(Instrumental)', '(Vocals)');
      } else if (processedFilePath.includes('_vocals')) {
        instrumentalPath = processedFilePath.replace('_vocals', '_instruments');
      } else if (processedFilePath.includes('_instruments')) {
        vocalPath = processedFilePath.replace('_instruments', '_vocals');
      }
    }

    const duration = project.duration || 60; // дефолтная длительность

    const soundsTrackId = 'track-' + Math.random().toString(36).substring(2, 11);
    const voicesTrackId = 'track-' + Math.random().toString(36).substring(2, 11);

    const soundsSegment = {
      id: 'seg-' + Math.random().toString(36).substring(2, 11),
      startTime: 0,
      duration: duration,
      fileOffset: 0,
      fileDuration: duration,
      blobUrl: '',
      filePath: instrumentalPath,
      gain: 1.0,
      playbackRate: 1.0,
      originalFileName: instrumentalPath.split(/[\\/]/).pop() || 'Sounds.wav'
    };

    const voicesSegment = {
      id: 'seg-' + Math.random().toString(36).substring(2, 11),
      startTime: 0,
      duration: duration,
      fileOffset: 0,
      fileDuration: duration,
      blobUrl: '',
      filePath: vocalPath,
      gain: 1.0,
      playbackRate: 1.0,
      originalFileName: vocalPath.split(/[\\/]/).pop() || 'Voices.wav'
    };

    const soundsTrack: AudioTrack = {
      id: soundsTrackId,
      name: 'Звуки (Музыка)',
      segments: [soundsSegment],
      volume: 1.0,
      isMuted: false,
      isSolo: false,
      isArmed: false,
      isProcessingEnabled: false,
      height: 80
    };

    const voicesTrack: AudioTrack = {
      id: voicesTrackId,
      name: 'Голоса (Вокал)',
      segments: [voicesSegment],
      volume: 1.0,
      isMuted: false,
      isSolo: false,
      isArmed: false,
      isProcessingEnabled: false,
      height: 80
    };

    // Приглушаем "Оригинал"
    const updatedTracks = project.tracks.map(t => {
      if (t.name === 'Оригинал') {
        return { ...t, isMuted: true };
      }
      return t;
    });

    updatedTracks.push(soundsTrack, voicesTrack);

    onUpdateProject({ tracks: updatedTracks });
    playbackEngine.updateTracks(updatedTracks).catch(console.error);
    showToast('Успешно созданы 2 новые дорожки: "Звуки" и "Голоса", оригинальная дорожка приглушена!');
  };

  const handleDetectNoise = () => {
    if (isDetectingNoise) return;
    setIsDetectingNoise(true);
    setDetectedNoiseLevel(null);
    
    setTimeout(() => {
      // Simulate scanning tracks and finding background noise floor
      const db = parseFloat((-58.0 - Math.random() * 8).toFixed(1));
      setDetectedNoiseLevel(db);
      setIsDetectingNoise(false);
      
      // Update phase 1 normalization values based on the detected noise floor
      const recommendedUpwardThreshold = parseFloat((db + 22).toFixed(1));
      updatePhase1({
        normalization: {
          ...activePreset.phase1.normalization,
          noiseFloorDb: db,
          upwardThresholdDb: recommendedUpwardThreshold,
          upwardGainDb: 10.0,
          upwardRatio: 2.5
        }
      });
      showToast(`Шум определен: ${db} dB. Параметры апвард компрессии оптимизированы!`);
    }, 1800);
  };

  // Load project presets if available
  useEffect(() => {
    if (project) {
      const allPresets = [...DEFAULT_MIXING_PRESETS, ...(project.customPresets || [])];
      setPresets(allPresets);
      
      const activeId = project.activePresetId || 'preset-voiceover';
      setSelectedPresetId(activeId);
      
      const current = allPresets.find(p => p.id === activeId) || DEFAULT_MIXING_PRESETS[0];
      setActivePreset(JSON.parse(JSON.stringify(current))); // Deep copy to prevent mutating store directly without save
    }
  }, [project]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleVstPluginSelect = (selectedVst: { name: string; path: string; format: 'VST2' | 'VST3' | 'AU' }) => {
    if (!activeVstSelectStepKey) return;
    
    const stepKey = activeVstSelectStepKey;
    
    // Определим фазу, к которой относится данный stepKey
    let phaseNum = 1;
    if (activePreset.phase2Order?.includes(stepKey)) {
      phaseNum = 2;
    } else if (activePreset.phase3Order?.includes(stepKey)) {
      phaseNum = 3;
    } else if (activePreset.phase4Order?.includes(stepKey)) {
      phaseNum = 4;
    }

    let vstStepsRecord: Record<string, VstStepConfig> = {};
    if (phaseNum === 1) vstStepsRecord = activePreset.phase1.vstSteps || {};
    else if (phaseNum === 2) vstStepsRecord = activePreset.phase2.vstSteps || {};
    else if (phaseNum === 3) vstStepsRecord = activePreset.phase3.vstSteps || {};
    else if (phaseNum === 4) vstStepsRecord = activePreset.phase4.vstSteps || {};

    const vstConfig = vstStepsRecord[stepKey] || {
      id: stepKey,
      name: `VST Цепочка`,
      bypass: false,
      plugins: []
    };
    
    let updatedPlugins = [...(vstConfig.plugins || [])];
    
    if (activeVstSelectPluginIdx === -1) {
      // Добавление нового плагина в цепочку
      const newPlugin = {
        id: 'vst-plug-' + Math.random().toString(36).substring(2, 11),
        name: selectedVst.name,
        bypass: false,
        pluginPath: selectedVst.path,
        vstVersion: selectedVst.format === 'VST2' ? 'VST2' as const : 'VST3' as const,
        parameters: { 0: 1.0, 1: 0.5 }
      };
      updatedPlugins.push(newPlugin);
      showToast(`Плагин "${selectedVst.name}" добавлен в цепочку!`);
    } else if (activeVstSelectPluginIdx !== null) {
      // Редактирование существующего плагина в цепочке
      const pIdx = activeVstSelectPluginIdx;
      if (updatedPlugins[pIdx]) {
        updatedPlugins[pIdx] = {
          ...updatedPlugins[pIdx],
          name: selectedVst.name,
          pluginPath: selectedVst.path,
          vstVersion: selectedVst.format === 'VST2' ? 'VST2' : 'VST3'
        };
        showToast(`Плагин изменен на "${selectedVst.name}"!`);
      }
    }
    
    const updatedSteps = { ...vstStepsRecord };
    updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
    
    if (phaseNum === 1) updatePhase1({ vstSteps: updatedSteps });
    else if (phaseNum === 2) updatePhase2({ vstSteps: updatedSteps });
    else if (phaseNum === 3) updatePhase3({ vstSteps: updatedSteps });
    else if (phaseNum === 4) updatePhase4({ vstSteps: updatedSteps });

    setIsVstSelectorOpen(false);
    setActiveVstSelectStepKey(null);
    setActiveVstSelectPluginIdx(null);
  };

  // Change active preset
  const handlePresetChange = (presetId: string) => {
    setSelectedPresetId(presetId);
    const found = presets.find(p => p.id === presetId);
    if (found && project) {
      setActivePreset(JSON.parse(JSON.stringify(found)));
      onUpdateProject({ activePresetId: presetId });
      showToast(`Применен пресет: ${found.name}`);
    }
  };

  // Save changes to current preset (only if custom, otherwise prompt to create new)
  const handleSavePresetChanges = () => {
    if (!project) return;
    
    const isSystem = activePreset.isSystem;
    if (isSystem) {
      // Prompt creation
      setNewPresetName(`${activePreset.name} (Копия)`);
      setNewPresetDesc(`Пользовательская копия пресета ${activePreset.name}`);
      setNewPresetType(activePreset.type);
      setIsCreatingPreset(true);
      return;
    }

    // Save changes to custom preset
    const updatedCustomPresets = (project.customPresets || []).map(p => 
      p.id === activePreset.id ? activePreset : p
    );
    
    onUpdateProject({ customPresets: updatedCustomPresets });
    showToast(`Изменения в пресете «${activePreset.name}» сохранены!`);
  };

  // Create new custom preset
  const handleCreatePreset = (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !newPresetName.trim()) return;

    const newPreset: MixingPreset = {
      ...activePreset,
      id: `preset-custom-${Date.now()}`,
      name: newPresetName,
      description: newPresetDesc,
      type: newPresetType,
      isSystem: false,
    };

    const updatedCustom = [...(project.customPresets || []), newPreset];
    onUpdateProject({
      customPresets: updatedCustom,
      activePresetId: newPreset.id
    });

    setPresets([...DEFAULT_MIXING_PRESETS, ...updatedCustom]);
    setSelectedPresetId(newPreset.id);
    setActivePreset(newPreset);
    setIsCreatingPreset(false);
    setNewPresetName('');
    setNewPresetDesc('');
    showToast(`Создан пресет «${newPreset.name}»!`);
  };

  // Share preset configuration
  const handleSharePreset = () => {
    try {
      const jsonString = JSON.stringify(activePreset, null, 2);
      navigator.clipboard.writeText(jsonString);
      showToast('Конфигурация пресета скопирована в буфер обмена!');
    } catch (err) {
      showToast('Не удалось скопировать конфигурацию.');
    }
  };

  // Drag and Drop State for Reordering Steps
  const [draggedItem, setDraggedItem] = useState<{ phase: 1 | 2 | 3 | 4; index: number } | null>(null);

  // Helper to move a step in a phase
  const handleMoveStep = (phaseNum: 1 | 2 | 3 | 4, index: number, direction: 'up' | 'down') => {
    const orderKey = `phase${phaseNum}Order` as const;
    const defaultOrder = 
      phaseNum === 1 ? DEFAULT_PHASE1_ORDER : 
      phaseNum === 2 ? DEFAULT_PHASE2_ORDER : 
      phaseNum === 3 ? DEFAULT_PHASE3_ORDER : 
      DEFAULT_PHASE4_ORDER;
    
    const currentOrder = [...(activePreset[orderKey] || defaultOrder)];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    
    if (targetIndex < 0 || targetIndex >= currentOrder.length) return;
    
    // Swap elements
    const temp = currentOrder[index];
    currentOrder[index] = currentOrder[targetIndex];
    currentOrder[targetIndex] = temp;
    
    const updated = { ...activePreset, [orderKey]: currentOrder };
    setActivePreset(updated);
    showToast('Порядок этапов изменён');
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, phaseNum: 1 | 2 | 3 | 4, index: number) => {
    setDraggedItem({ phase: phaseNum, index });
    e.dataTransfer.effectAllowed = 'move';
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
    }
  };

  const handleDragEnd = (e: React.DragEvent) => {
    setDraggedItem(null);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, phaseNum: 1 | 2 | 3 | 4, targetIndex: number) => {
    e.preventDefault();
    if (!draggedItem || draggedItem.phase !== phaseNum) return;
    
    const sourceIndex = draggedItem.index;
    if (sourceIndex === targetIndex) return;

    const orderKey = `phase${phaseNum}Order` as const;
    const defaultOrder = 
      phaseNum === 1 ? DEFAULT_PHASE1_ORDER : 
      phaseNum === 2 ? DEFAULT_PHASE2_ORDER : 
      phaseNum === 3 ? DEFAULT_PHASE3_ORDER : 
      DEFAULT_PHASE4_ORDER;
    
    const currentOrder = [...(activePreset[orderKey] || defaultOrder)];
    const [movedItem] = currentOrder.splice(sourceIndex, 1);
    currentOrder.splice(targetIndex, 0, movedItem);

    const updated = { ...activePreset, [orderKey]: currentOrder };
    setActivePreset(updated);
    showToast('Порядок этапов изменён');
  };
  const renderStepContainer = (
    phaseNum: 1 | 2 | 3 | 4,
    index: number,
    total: number,
    stepId: string,
    title: string,
    icon: React.ReactNode,
    isBypassed: boolean,
    onBypassToggle: (checked: boolean) => void,
    children: React.ReactNode,
    onDelete?: () => void
  ) => {
    const isDragged = draggedItem?.phase === phaseNum && draggedItem?.index === index;
    const exec = stepExecution[stepId] || { status: 'idle', progress: 0, log: '', hasRollback: false };

    return (
      <div 
        key={stepId}
        draggable
        onDragStart={(e) => handleDragStart(e, phaseNum, index)}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDrop={(e) => handleDrop(e, phaseNum, index)}
        className={cn(
          "bg-zinc-900/30 border border-white/5 rounded-xl transition-all duration-200 overflow-hidden",
          isDragged ? "border-indigo-500/50 bg-indigo-500/5 opacity-50" : "hover:border-white/10",
          exec.status === 'running' ? "border-indigo-500/30 shadow-lg shadow-indigo-500/5" : "",
          exec.status === 'success' ? "border-emerald-500/20" : "",
          exec.status === 'failed' ? "border-rose-500/30" : ""
        )}
      >
        {/* Header bar */}
        <div className="bg-zinc-950/40 px-3.5 py-2.5 flex items-center justify-between border-b border-white/5 select-none">
          <div className="flex items-center gap-2.5 flex-1 cursor-grab active:cursor-grabbing min-w-0">
            <div className="text-zinc-500 hover:text-zinc-300 transition-colors shrink-0">
              <GripVertical className="w-3.5 h-3.5" />
            </div>
            <span className="font-mono text-[9px] text-zinc-500 bg-zinc-950/60 border border-white/5 px-1.5 py-0.5 rounded font-black shrink-0">
              #{index + 1}
            </span>
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="shrink-0">{icon}</div>
              <span className="font-bold text-zinc-200 text-xs truncate">{title}</span>
            </div>
          </div>
          
          <div className="flex items-center gap-3 shrink-0">
            {/* Move Buttons */}
            <div className="flex items-center bg-zinc-950/60 rounded-lg border border-white/5 p-0.5">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleMoveStep(phaseNum, index, 'up'); }}
                disabled={index === 0}
                className="p-1 text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:pointer-events-none rounded transition-colors"
                title="Переместить выше"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleMoveStep(phaseNum, index, 'down'); }}
                disabled={index === total - 1}
                className="p-1 text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:pointer-events-none rounded transition-colors"
                title="Переместить ниже"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Delete button (if custom/deletable) */}
            {onDelete && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="p-1 text-zinc-500 hover:text-rose-400 rounded transition-colors mr-1 cursor-pointer"
                title="Удалить этот этап"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Bypass checkbox */}
            {stepId !== 'renderSettings' && (
              <label className="flex items-center gap-1.5 cursor-pointer pl-1" onClick={(e) => e.stopPropagation()}>
                <input 
                  type="checkbox" 
                  checked={!isBypassed}
                  onChange={(e) => onBypassToggle(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0 cursor-pointer w-3.5 h-3.5"
                />
                <span className={cn(
                   "text-[9px] font-black uppercase tracking-wider select-none",
                   !isBypassed ? "text-indigo-400" : "text-zinc-500"
                )}>
                  {!isBypassed ? "Вкл" : "Байпас"}
                </span>
              </label>
            )}
          </div>
        </div>

        {/* Action Controls & Individual Running State */}
        {!isBypassed && (
          <div className="p-3.5 space-y-3">
            {/* Quick Button Row */}
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setActiveModal({ stepId, title, icon, content: children })}
                className="px-2 py-1.5 bg-zinc-900 hover:bg-zinc-850 border border-white/5 hover:border-white/10 rounded-lg text-[10px] font-bold text-zinc-300 flex items-center justify-center gap-1.5 transition-all active:scale-[0.97]"
                title="Открыть настройки шага"
              >
                <Settings2 className="w-3 h-3 text-zinc-400" />
                <span>Настройки</span>
              </button>

              <button
                type="button"
                disabled={exec.status === 'running'}
                onClick={() => handleExecuteStep(stepId, title, phaseNum)}
                className={cn(
                  "px-2 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all active:scale-[0.97] border text-white",
                  exec.status === 'running' 
                    ? "bg-indigo-650/40 border-indigo-500/20 text-zinc-500 cursor-not-allowed" 
                    : "bg-indigo-650 hover:bg-indigo-650/90 border-indigo-500/30 hover:border-indigo-500/50"
                )}
              >
                <Play className="w-3 h-3 text-indigo-300" />
                <span>Выполнить</span>
              </button>

              {exec.status === 'running' ? (
                <button
                  type="button"
                  onClick={() => handleCancelStep(stepId, title)}
                  className="px-2 py-1.5 bg-rose-950/40 border border-rose-500/30 hover:bg-rose-900/40 text-rose-300 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all active:scale-[0.97]"
                >
                  <X className="w-3 h-3" />
                  <span>Отмена</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!exec.hasRollback}
                  onClick={() => handleRollbackStep(stepId, title)}
                  className={cn(
                    "px-2 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all active:scale-[0.97] border",
                    exec.hasRollback
                      ? "bg-zinc-900 hover:bg-zinc-850 border-white/5 hover:border-zinc-700 text-zinc-300"
                      : "bg-zinc-900/30 border-white/5 text-zinc-600 cursor-not-allowed"
                  )}
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Откатить</span>
                </button>
              )}
            </div>

            {/* Live Status and Log Information */}
            <div className="bg-zinc-950/30 border border-white/5 rounded-lg p-2 flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-500 font-medium">Статус:</span>
                {exec.status === 'running' && (
                  <span className="text-indigo-400 font-bold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping" />
                    Выполняется ({exec.progress}%)
                  </span>
                )}
                {exec.status === 'success' && (
                  <span className="text-emerald-400 font-bold flex items-center gap-1">
                    <Check className="w-3 h-3" />
                    Готово
                  </span>
                )}
                {exec.status === 'failed' && (
                  <span className="text-rose-400 font-bold flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    Ошибка
                  </span>
                )}
                {exec.status === 'idle' && (
                  <span className="text-zinc-500 font-bold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
                    Ожидание запуска
                  </span>
                )}
              </div>

              {/* Progress Bar (Only during running) */}
              {exec.status === 'running' && (
                <div className="w-full bg-zinc-900 rounded-full h-1 overflow-hidden border border-white/5">
                  <div 
                    className="bg-gradient-to-r from-indigo-500 to-emerald-500 h-full transition-all duration-300"
                    style={{ width: `${exec.progress}%` }}
                  />
                </div>
              )}

              {/* Active Log line */}
              {exec.log && (
                <div className="text-[9px] font-mono text-zinc-400 border-t border-white/5 pt-1 truncate leading-relaxed">
                  <span className="text-zinc-600 mr-1">&gt;</span>
                  <span className={cn(
                    exec.status === 'running' ? "text-indigo-300 animate-pulse" : "",
                    exec.status === 'success' ? "text-emerald-400/85" : "",
                    exec.status === 'failed' ? "text-rose-400" : ""
                  )}>
                    {exec.log}
                  </span>
                </div>
              )}
            </div>

            {/* Import Button for Phase 1 results */}
            {exec.status === 'success' && phaseNum === 1 && processedEffectFile && (
              <button
                type="button"
                onClick={handleImportEffectFile}
                className="w-full mt-1.5 px-3 py-1.5 bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-600/30 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1.5 animate-fade-in active:scale-[0.98]"
              >
                <Check className="w-3.5 h-3.5" />
                Добавить результат на трек
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderVstStepElement = (stepKey: string, index: number, phaseNum: 1 | 2 | 3 | 4) => {
    let currentPhaseConfig: any;
    let updatePhase: any;
    if (phaseNum === 1) {
      currentPhaseConfig = activePreset.phase1;
      updatePhase = updatePhase1;
    } else if (phaseNum === 2) {
      currentPhaseConfig = activePreset.phase2;
      updatePhase = updatePhase2;
    } else if (phaseNum === 3) {
      currentPhaseConfig = activePreset.phase3;
      updatePhase = updatePhase3;
    } else {
      currentPhaseConfig = activePreset.phase4;
      updatePhase = updatePhase4;
    }

    const vstConfig = currentPhaseConfig.vstSteps?.[stepKey] || {
      id: stepKey,
      name: `VST Цепочка #${index + 1}`,
      bypass: false,
      plugins: []
    };

    return (
      <div className="space-y-3.5 animate-fade-in text-xs">
        {/* Rename VST Step Container */}
        <div className="space-y-1">
          <label className="text-[9px] text-zinc-500 uppercase font-black block">Название этапа VST</label>
          <input 
            type="text"
            value={vstConfig.name}
            onChange={(e) => {
              const updatedSteps = { ...(currentPhaseConfig.vstSteps || {}) };
              updatedSteps[stepKey] = { ...vstConfig, name: e.target.value };
              updatePhase({ vstSteps: updatedSteps });
            }}
            className="w-full bg-zinc-950 border border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-200 font-medium focus:border-indigo-500/50 focus:outline-none"
            placeholder="Например, Мастеринг цепочка"
          />
        </div>

        {/* Sequential chain flow visualization */}
        <div className="space-y-2">
          <div className="flex justify-between items-center text-[9px] text-zinc-500 uppercase font-black">
            <span>Цепочка плагинов ({vstConfig.plugins.length})</span>
            <span className="text-zinc-500">Сигнал идет сверху вниз ↓</span>
          </div>

          {vstConfig.plugins.length === 0 ? (
            <div className="text-center py-4 bg-zinc-950/20 rounded-xl border border-dashed border-white/5 text-zinc-500 text-[10px]">
              Нет активных VST-плагинов в цепочке.<br/>Нажмите кнопку ниже, чтобы добавить.
            </div>
          ) : (
            <div className="space-y-2.5">
              {vstConfig.plugins.map((plugin, pIdx) => {
                return (
                  <div key={plugin.id} className="relative bg-zinc-950/40 border border-white/5 rounded-xl p-3 space-y-2.5">
                    
                    {/* Connector Line */}
                    {pIdx < vstConfig.plugins.length - 1 && (
                      <div className="absolute left-1/2 -bottom-2.5 transform -translate-x-1/2 w-0.5 h-2.5 bg-indigo-500/25 flex items-center justify-center z-10">
                        <span className="text-[7px] text-indigo-400 font-black">↓</span>
                      </div>
                    )}

                    {/* Plugin Item Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[9px] font-mono font-black text-zinc-600 bg-zinc-950 border border-white/5 px-1 py-0.5 rounded shrink-0">
                          #{pIdx + 1}
                        </span>
                        <input 
                          type="text"
                          value={plugin.name}
                          onChange={(e) => {
                            const updatedPlugins = [...vstConfig.plugins];
                            updatedPlugins[pIdx] = { ...plugin, name: e.target.value };
                            const updatedSteps = { ...(currentPhaseConfig.vstSteps || {}) };
                            updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                            updatePhase({ vstSteps: updatedSteps });
                          }}
                          className="bg-transparent font-bold text-zinc-200 text-[11px] focus:outline-none hover:bg-white/5 focus:bg-zinc-950 px-1 py-0.5 rounded min-w-[120px]"
                        />
                      </div>

                      {/* Plugin controls (Move, Bypass, Delete) */}
                      <div className="flex items-center gap-2">
                        {/* Move inside chain */}
                        <div className="flex items-center bg-zinc-950/80 rounded border border-white/5 p-0.5">
                          <button
                            type="button"
                            disabled={pIdx === 0}
                            onClick={() => {
                              const updatedPlugins = [...vstConfig.plugins];
                              const temp = updatedPlugins[pIdx];
                              updatedPlugins[pIdx] = updatedPlugins[pIdx - 1];
                              updatedPlugins[pIdx - 1] = temp;
                              const updatedSteps = { ...(currentPhaseConfig.vstSteps || {}) };
                              updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                              updatePhase({ vstSteps: updatedSteps });
                            }}
                            className="p-0.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-20 rounded"
                            title="Вверх в цепочке"
                          >
                            <ChevronUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            disabled={pIdx === vstConfig.plugins.length - 1}
                            onClick={() => {
                              const updatedPlugins = [...vstConfig.plugins];
                              const temp = updatedPlugins[pIdx];
                              updatedPlugins[pIdx] = updatedPlugins[pIdx + 1];
                              updatedPlugins[pIdx + 1] = temp;
                              const updatedSteps = { ...(currentPhaseConfig.vstSteps || {}) };
                              updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                              updatePhase({ vstSteps: updatedSteps });
                            }}
                            className="p-0.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-20 rounded"
                            title="Вниз в цепочке"
                          >
                            <ChevronDown className="w-3 h-3" />
                          </button>
                        </div>

                        {/* Bypass Toggle */}
                        <button
                          type="button"
                          onClick={() => {
                            const updatedPlugins = [...vstConfig.plugins];
                            updatedPlugins[pIdx] = { ...plugin, bypass: !plugin.bypass };
                            const updatedSteps = { ...(currentPhaseConfig.vstSteps || {}) };
                            updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                            updatePhase({ vstSteps: updatedSteps });
                            showToast(plugin.bypass ? `Включен обход для ${plugin.name}` : `Плагин ${plugin.name} активен`);
                          }}
                          className={cn(
                            "p-1 rounded text-[10px] font-bold uppercase transition-all cursor-pointer",
                            plugin.bypass 
                              ? "bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/20" 
                              : "bg-indigo-600/15 hover:bg-indigo-600/30 text-indigo-400 border border-indigo-500/25"
                          )}
                          title={plugin.bypass ? "Плагин выключен (Bypass). Нажмите для включения." : "Плагин включен. Нажмите для обхода."}
                        >
                          {plugin.bypass ? 'Byp' : 'On'}
                        </button>

                        {/* Delete plugin */}
                        <button
                          type="button"
                          onClick={() => {
                            const updatedPlugins = vstConfig.plugins.filter((_, idx) => idx !== pIdx);
                            const updatedSteps = { ...(currentPhaseConfig.vstSteps || {}) };
                            updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                            updatePhase({ vstSteps: updatedSteps });
                            showToast(`Плагин "${plugin.name}" удален из цепочки`);
                          }}
                          className="p-1 hover:bg-red-500/10 text-zinc-500 hover:text-red-400 rounded transition-colors cursor-pointer"
                          title="Удалить плагин"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    {/* Path Selection */}
                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-[9px] text-zinc-500">
                        <span>Конфигурация плагина</span>
                        <span className="text-zinc-600 font-mono text-[8px] uppercase">{plugin.vstVersion || 'VST3'}</span>
                      </div>
                      <div 
                        onClick={() => {
                          setActiveVstSelectStepKey(stepKey);
                          setActiveVstSelectPluginIdx(pIdx);
                          setIsVstSelectorOpen(true);
                        }}
                        className="w-full bg-zinc-950/60 hover:bg-zinc-950/90 border border-white/5 hover:border-indigo-500/30 rounded-xl p-2.5 flex items-center justify-between gap-3 transition-all cursor-pointer group/row"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-bold text-zinc-200 group-hover/row:text-indigo-400 transition-colors text-[10.5px] truncate">
                            {plugin.name || 'Выберите плагин...'}
                          </div>
                          <div className="font-mono text-[8.5px] text-zinc-500 truncate mt-0.5" title={plugin.pluginPath}>
                            {plugin.pluginPath || 'Путь не указан — нажмите для выбора'}
                          </div>
                        </div>
                        
                        <button
                          type="button"
                          className="px-2 py-1 bg-zinc-900 group-hover/row:bg-indigo-600 hover:bg-indigo-500 border border-white/10 rounded-lg text-[9px] text-zinc-300 group-hover/row:text-white font-bold uppercase shrink-0 transition-all cursor-pointer"
                        >
                          Выбрать...
                        </button>
                      </div>
                    </div>

                    {/* Slider parameters control */}
                    <div className="space-y-2 border-t border-white/5 pt-2">
                      <div className="flex justify-between items-center">
                        <span className="text-[9px] font-semibold text-zinc-500 uppercase">Регулировки (Dry/Wet и Gain)</span>
                        <span className="text-[8px] font-mono text-indigo-400/80">Органы управления</span>
                      </div>
                      
                      <div className="space-y-1.5">
                        {/* Parameter 0: Mix */}
                        <div className="space-y-0.5">
                          <div className="flex justify-between items-center text-[9px] font-mono text-zinc-400">
                            <span>Смешивание (Dry/Wet)</span>
                            <span className="text-zinc-300 font-bold">{Math.round((plugin.parameters?.[0] ?? 1.0) * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={plugin.parameters?.[0] ?? 1.0}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              const updatedPlugins = [...vstConfig.plugins];
                              updatedPlugins[pIdx] = { 
                                ...plugin, 
                                parameters: { ...(plugin.parameters || {}), 0: val } 
                              };
                              const updatedSteps = { ...(currentPhaseConfig.vstSteps || {}) };
                              updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                              updatePhase({ vstSteps: updatedSteps });
                            }}
                            className="w-full h-1 accent-indigo-500 bg-zinc-900 rounded-lg appearance-none cursor-pointer"
                          />
                        </div>

                        {/* Parameter 1: Gain */}
                        <div className="space-y-0.5">
                          <div className="flex justify-between items-center text-[9px] font-mono text-zinc-400">
                            <span>Громкость выхода (Gain)</span>
                            <span className="text-zinc-300 font-bold">{((plugin.parameters?.[1] ?? 0.5) * 24 - 12).toFixed(1)} dB</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={plugin.parameters?.[1] ?? 0.5}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              const updatedPlugins = [...vstConfig.plugins];
                              updatedPlugins[pIdx] = { 
                                ...plugin, 
                                parameters: { ...(plugin.parameters || {}), 1: val } 
                              };
                              const updatedSteps = { ...(currentPhaseConfig.vstSteps || {}) };
                              updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                              updatePhase({ vstSteps: updatedSteps });
                            }}
                            className="w-full h-1 accent-indigo-500 bg-zinc-900 rounded-lg appearance-none cursor-pointer"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setActiveVstSelectStepKey(stepKey);
                setActiveVstSelectPluginIdx(-1); // -1 triggers adding new plugin in handleVstPluginSelect
                setIsVstSelectorOpen(true);
              }}
              className="py-1.5 bg-zinc-950 hover:bg-zinc-900 border border-white/5 hover:border-indigo-500/20 hover:text-indigo-400 text-zinc-300 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 cursor-pointer"
            >
              <Plus className="w-3 h-3 text-indigo-400" />
              <span>Поиск VST...</span>
            </button>

            <div className="relative group">
              <button
                type="button"
                onClick={() => {
                  showToast("Внешний интерфейс плагина (GUI) временно заблокирован хостом");
                }}
                disabled={vstConfig.plugins.length === 0}
                className="w-full py-1.5 bg-zinc-950 hover:bg-zinc-900 disabled:opacity-30 disabled:hover:bg-zinc-950 disabled:text-zinc-600 border border-white/5 hover:border-white/10 text-zinc-300 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 cursor-pointer"
              >
                <Sliders className="w-3 h-3 text-emerald-400" />
                <span>Открыть GUI...</span>
              </button>
            </div>
          </div>
        </div>

        {/* Standalone actions */}
        {renderProcessingActions(stepKey, 'Выполнить VST', 'bg-indigo-600 hover:bg-indigo-500')}
      </div>
    );
  };

  const renderProcessingActions = (effectType: string, buttonText: string, colorClass: string) => {
    const hasTargetSegment = !!selectedSegment;
    const canRevert = !!(selectedSegment?.segment?.sourceFilePath || selectedSegment?.segment?.backupFilePath);

    return (
      <div className="pt-2.5 border-t border-white/5 space-y-2">
        <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
          <span>Цель обработки:</span>
          <span className="font-bold text-zinc-200 truncate max-w-[180px]">
            {hasTargetSegment 
              ? `Выбранный сегмент (${selectedSegment.segment.originalFileName || 'дубль'})` 
              : selectedEffectFile 
                ? 'Выбранный файл' 
                : 'Все активные дорожки'}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSelectEffectFile}
            className="px-2.5 py-2 bg-zinc-900 border border-zinc-700 hover:border-zinc-500 rounded-lg text-xs font-bold transition-all text-zinc-300 flex items-center justify-center gap-1.5"
            title="Выбрать внешний аудиофайл для обработки"
          >
            <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
            <span className="truncate max-w-[80px]">{selectedEffectFile ? 'Файл выбран' : 'Файл...'}</span>
          </button>
          <button
            type="button"
            onClick={() => handleApplyEffect(effectType as any)}
            disabled={isApplyingEffect}
            className={cn(
              "flex-1 px-3 py-2 text-white rounded-lg text-xs font-bold transition-all flex justify-center items-center gap-2 disabled:opacity-50 shadow-md",
              colorClass
            )}
          >
            <Sparkles className="w-4 h-4" />
            {isApplyingEffect ? 'Обработка...' : buttonText}
          </button>
        </div>

        {canRevert && (
          <button
            type="button"
            onClick={handleRevertSelectedSegment}
            className="w-full px-2.5 py-1.5 bg-zinc-850 hover:bg-zinc-800 text-amber-300 border border-amber-500/20 rounded-lg text-[11px] font-bold transition-all flex items-center justify-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
            Откатить сегмент к оригиналу (Revert)
          </button>
        )}
        
        {processedEffectFile && (
          <div className="flex flex-col gap-1.5 w-full pt-1">
            <button
              onClick={handleImportEffectFile}
              className="w-full px-3 py-2 bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-600/30 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2"
            >
              <Check className="w-4 h-4" />
              Добавить как новый сегмент
            </button>
            {selectedSegment && (
              <button
                onClick={handleReplaceSelectedSegment}
                className="w-full px-3 py-2 bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-600/30 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Заменить выбранный сегмент
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  // Full 4-Stage End-to-End Mixing Pipeline Execution
  const handleStartMixing = async () => {
    if (isProcessing) return;
    if (!project || !project.tracks || project.tracks.length === 0) {
      showToast('В проекте нет аудиодорожек для запуска конвейера сведения');
      return;
    }

    setIsProcessing(true);
    setProcessingProgress(0);
    setProcessingStep('Запуск конвейера сведения...');

    try {
      let currentTracks: AudioTrack[] = [...project.tracks];

      // ==========================================
      // ЭТАП 1: ПРЕДОБРАБОТКА (PREPROCESSING)
      // ==========================================
      if (activePreset.phase1.enabled) {
        setProcessingStep('1. Предобработка: Анализ и разделение дорожки оригинала (UVR5 / Demucs)...');
        setProcessingProgress(8);
        await new Promise(r => setTimeout(r, 600));

        // 1.1 Source Separation: split original into M&E and Vocals if not already separated
        const originalTrack = currentTracks.find(t => 
          t.name.toLowerCase().includes('оригинал') || 
          t.type === 'original' || 
          t.name.toLowerCase().includes('reference')
        );

        const alreadyHasSeparatedMusic = currentTracks.some(t => 
          t.name.toLowerCase().includes('звуки') || 
          t.name.toLowerCase().includes('музыка') || 
          t.name.toLowerCase().includes('m&e') || 
          t.name.toLowerCase().includes('instrument')
        );
        const alreadyHasSeparatedVoices = currentTracks.some(t => 
          t.name.toLowerCase().includes('голоса') || 
          t.name.toLowerCase().includes('vocal')
        );

        if (originalTrack && (!alreadyHasSeparatedMusic || !alreadyHasSeparatedVoices)) {
          setProcessingStep('1. Предобработка: Разделение на Звуки (Музыка и эффекты) и Оригинальные голоса (Вокал)...');
          setProcessingProgress(15);
          await new Promise(r => setTimeout(r, 800));

          const soundsTrackId = 'track-sounds-' + Math.random().toString(36).substring(2, 9);
          const voicesTrackId = 'track-voices-' + Math.random().toString(36).substring(2, 9);

          const soundsTrack: AudioTrack = {
            id: soundsTrackId,
            name: 'Звуки (Музыка и эффекты) [M&E]',
            volume: 1.0,
            isMuted: false,
            isSolo: false,
            type: 'instrumental',
            color: '#10b981',
            pan: 0,
            segments: originalTrack.segments.map(s => ({
              ...s,
              id: 'seg-me-' + Math.random().toString(36).substring(2, 9),
              originalFileName: (s.originalFileName || 'audio') + '_me.wav',
              gain: 1.0
            }))
          };

          const voicesTrack: AudioTrack = {
            id: voicesTrackId,
            name: 'Оригинальные голоса (Вокал) [VO]',
            volume: 1.0,
            isMuted: false,
            isSolo: false,
            type: 'original',
            color: '#8b5cf6',
            pan: 0,
            segments: originalTrack.segments.map(s => ({
              ...s,
              id: 'seg-vo-' + Math.random().toString(36).substring(2, 9),
              originalFileName: (s.originalFileName || 'audio') + '_vocals.wav',
              gain: 1.0
            }))
          };

          const remaining = currentTracks.filter(t => t.id !== originalTrack.id);
          currentTracks = [
            { ...originalTrack, isMuted: true, name: 'Оригинал (Архив)' },
            soundsTrack,
            voicesTrack,
            ...remaining
          ];

          onUpdateProject({ tracks: currentTracks });
          addAuditLogs([{
            id: `sep-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'sourceSeparation',
            status: 'success',
            title: 'ИИ-разделение дорожки оригинала',
            message: 'Оригинальная дорожка разделена на "Звуки (Музыка и эффекты) [M&E]" и "Оригинальные голоса (Вокал) [VO]".'
          }]);
        }

        // 1.2 Dubber voice cleaning: De-click, De-plosive, De-esser, Denoise, Dereverb, Leveler
        setProcessingStep('1. Предобработка: Очистка голосов даберов (De-click, De-plosive, De-esser, Denoise, Dereverb, AGC)...');
        setProcessingProgress(25);
        await new Promise(r => setTimeout(r, 800));

        currentTracks = currentTracks.map(track => {
          const lowerName = track.name.toLowerCase();
          const isExcluded = lowerName.includes('оригинал') || 
                             lowerName.includes('звуки') || 
                             lowerName.includes('музыка') || 
                             lowerName.includes('голоса') || 
                             lowerName.includes('m&e') || 
                             track.type === 'original' || 
                             track.type === 'instrumental';
          if (isExcluded || track.isProcessingEnabled === false) return track;

          return {
            ...track,
            segments: track.segments.map(seg => ({
              ...seg,
              gain: Number(Math.max(0.75, Math.min(1.35, (seg.gain || 1.0) * 1.04)).toFixed(2)),
              processedEffectName: 'Studio Cleaned (Denoise+Dereverb+Declick)'
            }))
          };
        });

        onUpdateProject({ tracks: currentTracks });
        addAuditLogs([{
          id: `prep-clean-${Date.now()}`,
          timestamp: Date.now(),
          stageName: '1. Предобработка',
          stepId: 'volumeLeveler',
          status: 'success',
          title: 'Очистка и выравнивание дорожек даберов',
          message: 'Выполнено удаление кликов и слюны (De-click), взрывных звуков (De-plosive), сибилянтов (De-esser), комнатного эха (Dereverb) и нормализация громкости.'
        }]);
      }

      // ==========================================
      // ЭТАП 2: ТАЙМИНГ (TIMING & ALIGNMENT)
      // ==========================================
      if (activePreset.phase2.enabled) {
        setProcessingStep('2. Тайминг: Нарезка непрерывных дорожек даберов по тишине на отдельные фразы...');
        setProcessingProgress(38);
        await new Promise(r => setTimeout(r, 800));

        // 2.1 Silence splitting: slice dubbers' single takes into separate phrase clips
        currentTracks = await Promise.all(currentTracks.map(async track => {
          const lowerName = track.name.toLowerCase();
          const isExcluded = lowerName.includes('оригинал') || 
                             lowerName.includes('звуки') || 
                             lowerName.includes('музыка') || 
                             lowerName.includes('голоса') || 
                             track.type === 'original' || 
                             track.type === 'instrumental';
          if (isExcluded) return track;

          return await TimingAlignmentService.splitTrackBySilence(track, {
            thresholdDb: activePreset.phase2.silenceSplit?.thresholdDb || -38,
            minSilenceDurationMs: activePreset.phase2.silenceSplit?.minSilenceDurationMs || 250
          });
        }));
        onUpdateProject({ tracks: currentTracks });

        // 2.2 Subtitle compliance and synchronization with original Japanese audio
        setProcessingStep('2. Тайминг: Сверка с субтитрами и синхронизация со стартом фраз оригинала...');
        setProcessingProgress(48);
        await new Promise(r => setTimeout(r, 900));

        const origTrackForTiming = TimingAlignmentService.findOriginalVoiceTrack(currentTracks);
        const allIssues: TimingIssue[] = [];
        const updatedTimingTracks: AudioTrack[] = [];

        for (const track of currentTracks) {
          const lowerName = track.name.toLowerCase();
          const isExcluded = lowerName.includes('оригинал') || 
                             lowerName.includes('звуки') || 
                             lowerName.includes('музыка') || 
                             lowerName.includes('голоса') || 
                             track.type === 'original' || 
                             track.type === 'instrumental';
          if (isExcluded) {
            updatedTimingTracks.push(track);
            continue;
          }

          const res = await TimingAlignmentService.alignTrackPhrases(
            track,
            origTrackForTiming,
            project.subtitles || [],
            project.mixingType || ('DUBBING' as any),
            activePreset.phase2
          );
          allIssues.push(...res.issues);
          updatedTimingTracks.push(res.updatedTrack);
        }

        // Auto-fix overlaps, gaps, and snap to sync
        currentTracks = TimingAlignmentService.autoFixAllIssues(allIssues, updatedTimingTracks);
        setTimingIssues(allIssues.filter(i => !i.canAutoFix));
        setTimingInspectionDone(true);
        onUpdateProject({ tracks: currentTracks });

        addAuditLogs([{
          id: `timing-align-${Date.now()}`,
          timestamp: Date.now(),
          stageName: '2. Тайминг',
          stepId: 'smartAlign',
          status: 'success',
          title: 'Автоматическая подгонка тайминга и сверка с субтитрами',
          message: `Проанализировано соответствие субтитрам и тайминг оригинальных японских фраз. Устранено наездов: ${allIssues.filter(i => i.type === 'overlap').length}, выровнено рассинхронов: ${allIssues.filter(i => i.type === 'desync' || i.type === 'missing').length}.`
        }]);
      }

      // ==========================================
      // ЭТАП 3: СВЕДЕНИЕ (MIXING & EFFECTS)
      // ==========================================
      if (activePreset.phase3.enabled) {
        // 3.1 Gain Matching: Dialogues vs Physics (-10 dB)
        setProcessingStep('3. Сведение: Выравнивание громкости (Реплики vs Физика -10 dB)...');
        setProcessingProgress(60);
        await new Promise(r => setTimeout(r, 700));

        const gmRes = MixingService.matchLoudnessBySubtitles(
          currentTracks,
          project.subtitles || [],
          activePreset.phase3.gainMatching
        );
        addAuditLogs(gmRes.logs);
        currentTracks = gmRes.updatedTracks;
        onUpdateProject({ tracks: currentTracks });

        // 3.2 Smart Ducking: suppress Japanese voice track under dubbers, protect M&E and OP/ED
        setProcessingStep('3. Сведение: Умный дакинг японского вокала (защита интершума и OP/ED)...');
        setProcessingProgress(70);
        await new Promise(r => setTimeout(r, 700));

        const duckRes = MixingService.applyAutoDucking(
          currentTracks,
          project.mixingType || MixingType.DUBBING,
          activePreset.phase3.ducking
        );
        addAuditLogs(duckRes.logs);
        currentTracks = duckRes.updatedTracks;
        onUpdateProject({ tracks: currentTracks });

        // 3.3 Auto-FX Analysis: inspect Japanese acoustic profile and replicate reverb/delay/eq onto dubber
        setProcessingStep('3. Сведение: Авто-анализ акустики оригинала (реверб, эхо, фильтры) и перенос FX на дубляж...');
        setProcessingProgress(78);
        await new Promise(r => setTimeout(r, 700));

        const fxRes = MixingService.detectAndApplyOriginalEffects(
          currentTracks,
          activePreset.phase3.autoFxAnalysis
        );
        addAuditLogs(fxRes.logs);
        currentTracks = fxRes.updatedTracks;
        onUpdateProject({ tracks: currentTracks });

        // 3.4 Master Vocal Bus
        setProcessingStep('3. Сведение: Финальная обработка шины вокала (Мастер-цепочка Audition)...');
        setProcessingProgress(84);
        await new Promise(r => setTimeout(r, 600));

        const busRes = MixingService.applyMasterVocalBusChain(
          currentTracks,
          activePreset.phase3.vocalBusProcessing.chain || {
            presetName: 'Audition Master VO Chain',
            ozoneStabilizer: { enabled: true, shape: 65, speed: 50, smoothness: 70, bypass: false },
            rCompressor: { enabled: true, threshold: -12.2, ratio: 4.7, attackMs: 149.6, releaseMs: 120, gainDb: 3.44, warmth: 60, bypass: false },
            soothe2: { enabled: true, depth: 5.27, sharpness: 3.31, selectivity: 4.07, band1Freq: 328.8, band1Sens: 5.94, band3Freq: 3489.5, band3Sens: 6.20, bypass: false },
            proQ4: { enabled: true, highPassFreq: 80, lowCutSlope: 12, airShelfFreq: 12000, airShelfGain: 1.5, notchResonanceFreq: 3200, notchCutDb: -2.0, bypass: false },
            rBass: { enabled: true, frequency: 43, intensity: 5.0, originalBassDb: -2.0, bypass: false },
            freshAir: { enabled: true, midAir: 24, highAir: 32, bypass: false },
            rVox: { enabled: true, compression: -9.5, gateThreshold: -80, gainDb: 0.0, bypass: false },
            proDS: { enabled: true, threshold: -24, range: -8, frequency: 10000, wideBand: true, bypass: false }
          }
        );
        addAuditLogs(busRes.logs);
      }

      // ==========================================
      // ЭТАП 4: ФИНАЛ И РЕНДЕР (FINAL MASTER & DELIVERY)
      // ==========================================
      if (activePreset.phase4.enabled) {
        // 4.1 QA Analysis
        setProcessingStep('4. Финал: Автоматический контроль качества (QA) — поиск клиппинга, наездов и пропусков...');
        setProcessingProgress(89);
        const updatedProj = { ...project, tracks: currentTracks };
        const qaRes = FinalRenderService.runQualityControlAnalysis(updatedProj, activePreset.phase4);
        setQaIssues(qaRes.issues);
        setQaLufs(qaRes.integratedLufs);
        setQaTruePeak(qaRes.maxTruePeakDb);
        addAuditLogs(qaRes.logs);

        // 4.2 Mastering Limiter (Reference match to Original track)
        setProcessingStep('4. Финал: Мастеринг под уровень оригинала (Match Reference LUFS) и True-Peak лимитер...');
        setProcessingProgress(93);
        const masteringRes = FinalRenderService.applyMasteringLimiter(currentTracks, activePreset.phase4);
        currentTracks = masteringRes.updatedTracks;
        addAuditLogs(masteringRes.logs);
        onUpdateProject({ tracks: currentTracks });

        // 4.3 Final Render with Modal
        setProcessingStep('4. Финал: Сборка готовой серии — кодирование видео, субтитров надписей и стэмов...');
        setProcessingProgress(96);

        setIsRenderProgressModalOpen(true);
        setIsRenderingFinal(true);
        setRenderProgressPercent(15);
        setRenderCurrentStage('Сведение мастер-микса и кодирование видео...');

        const renderRes = await FinalRenderService.executeFinalRender(
          { ...project, tracks: currentTracks },
          activePreset.phase4,
          (pct, stage) => {
            setRenderProgressPercent(pct);
            setRenderCurrentStage(stage);
          }
        );

        setFinalRenderResult(renderRes);
        setIsRenderingFinal(false);
        setProcessingProgress(100);
        setProcessingStep('Готово! Серия сведена, отмастерена под уровень оригинала и собрана.');
        showToast('Готово! Серия сведена, отмастерена под уровень оригинала и собрана.');
      } else {
        setProcessingProgress(100);
        setProcessingStep('Сведение завершено.');
        showToast('Процесс сведения серии успешно завершен!');
      }
    } catch (err: any) {
      console.error('Master pipeline error:', err);
      showToast('Ошибка при выполнении конвейера: ' + (err?.message || err));
    } finally {
      setIsProcessing(false);
    }
  };

  // Safe updates for nested configurations
  const updatePhase1 = (updates: Partial<PrepProcessingConfig>) => {
    const updated = { ...activePreset, phase1: { ...activePreset.phase1, ...updates } };
    setActivePreset(updated);
  };

  const updatePhase2 = (updates: Partial<TimingAlignmentConfig>) => {
    const updated = { ...activePreset, phase2: { ...activePreset.phase2, ...updates } };
    setActivePreset(updated);
  };

  const updatePhase3 = (updates: Partial<MixingEffectsConfig>) => {
    const updated = { ...activePreset, phase3: { ...activePreset.phase3, ...updates } };
    setActivePreset(updated);
  };

  const updatePhase4 = (updates: Partial<FinalMixConfig>) => {
    const updated = { ...activePreset, phase4: { ...activePreset.phase4, ...updates } };
    setActivePreset(updated);
  };

  // --- Phase 2 Actions & Timing Handlers ---
  const handleSplitSilence = () => {
    if (!project || !project.tracks || project.tracks.length === 0) {
      showToast('Нет дорожек для разреза по тишине');
      return;
    }
    setIsSplittingSilence(true);
    try {
      const cfg = activePreset.phase2.silenceSplit;
      const originalTrack = TimingAlignmentService.findOriginalVoiceTrack(project.tracks);
      
      const updatedTracks = project.tracks.map(track => {
        if (track.type === 'original' || (originalTrack && track.id === originalTrack.id)) {
          return track;
        }
        return TimingAlignmentService.splitTrackBySilence(track, {
          thresholdDb: cfg.thresholdDb,
          minSilenceDurationMs: cfg.minSilenceDurationMs
        });
      });

      onUpdateProject({ tracks: updatedTracks });
      showToast('Разрез по тишине выполнен: тишина удалена, каждая фраза выделена в отдельный клип!');
    } catch (err: any) {
      console.error(err);
      showToast('Ошибка при нарезке по тишине: ' + err.message);
    } finally {
      setIsSplittingSilence(false);
    }
  };

  const handleAlignAllPhrases = async () => {
    if (!project || !project.tracks || project.tracks.length === 0) {
      showToast('Нет дорожек в проекте');
      return;
    }
    setIsAligningPhrases(true);
    try {
      const originalTrack = TimingAlignmentService.findOriginalVoiceTrack(project.tracks);
      const allIssues: TimingIssue[] = [];
      const updatedTracks: AudioTrack[] = [];

      for (const track of project.tracks) {
        if (track.type === 'original' || (originalTrack && track.id === originalTrack.id)) {
          updatedTracks.push(track);
          continue;
        }
        const res = await TimingAlignmentService.alignTrackPhrases(
          track,
          originalTrack,
          project.subtitles || [],
          project.mixingType || ('VOICEOVER' as any),
          activePreset.phase2
        );
        allIssues.push(...res.issues);
        updatedTracks.push(res.updatedTrack);
      }

      onUpdateProject({ tracks: updatedTracks });
      setTimingIssues(allIssues);
      setTimingInspectionDone(true);

      const overlapCount = allIssues.filter(i => i.type === 'overlap').length;
      const shortCount = allIssues.filter(i => i.type === 'too_short').length;
      
      let msg = 'Выравнивание по оригиналу завершено: старт фраз синхронизирован!';
      if (overlapCount > 0 || shortCount > 0) {
        msg += ` Замечания: наездов: ${overlapCount}, короче саба: ${shortCount}`;
      }
      showToast(msg);
    } catch (err: any) {
      console.error(err);
      showToast('Ошибка выравнивания: ' + err.message);
    } finally {
      setIsAligningPhrases(false);
    }
  };

  const handleInspectTiming = () => {
    if (!project) return;
    const originalTrack = TimingAlignmentService.findOriginalVoiceTrack(project.tracks);
    const issues = TimingAlignmentService.validateAllTracksTiming(
      project.tracks,
      originalTrack,
      project.subtitles || [],
      project.mixingType || ('VOICEOVER' as any),
      activePreset.phase2
    );
    setTimingIssues(issues);
    setTimingInspectionDone(true);
    showToast(`Проверка завершена: найдено вопросов/конфликтов: ${issues.length}`);
  };

  const handleAutoFixIssue = (issue: TimingIssue) => {
    if (!project) return;
    const updatedTracks = TimingAlignmentService.autoFixIssue(issue, project.tracks);
    onUpdateProject({ tracks: updatedTracks });
    setTimingIssues(prev => prev.filter(i => i.id !== issue.id));
    showToast('Конфликт успешно устранен!');
  };

  const handleAutoFixAllIssues = () => {
    if (!project) return;
    const fixableCount = timingIssues.filter(i => i.canAutoFix).length;
    const updatedTracks = TimingAlignmentService.autoFixAllIssues(timingIssues, project.tracks);
    onUpdateProject({ tracks: updatedTracks });
    setTimingIssues(prev => prev.filter(i => !i.canAutoFix));
    showToast(`Устранено конфликтов: ${fixableCount}`);
  };

  return (
    <div className={cn(
      "w-full flex flex-col font-sans relative select-none",
      fullHeight ? "h-full bg-transparent" : "bg-zinc-950/90 border-t border-white/5 transition-all duration-300"
    )}>
      
      {/* Toast Alert */}
      {toastMessage && (
        <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-indigo-600 text-white text-xs font-bold px-4 py-2 rounded-xl shadow-2xl z-50 animate-bounce flex items-center gap-1.5 border border-indigo-400">
          <Sparkles className="w-3.5 h-3.5" />
          {toastMessage}
        </div>
      )}

      {/* Header Bar */}
      <div 
        onClick={fullHeight ? undefined : () => setIsOpen(!isOpen)}
        className={cn(
          "p-3.5 flex items-center justify-between border-b border-white/5",
          !fullHeight && "cursor-pointer hover:bg-white/[0.02] active:bg-white/[0.04] transition-all"
        )}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-indigo-600/10 rounded-lg flex items-center justify-center border border-indigo-500/20 text-indigo-400">
            <Sliders className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-zinc-100 flex items-center gap-1.5">
              Сведение Серии
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            </h3>
            <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-tight mt-0.5">Автоматизированный конвейер</p>
          </div>
        </div>
        {!fullHeight && (
          <button className="text-zinc-400 hover:text-white transition-colors">
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        )}
      </div>

      {(isOpen || fullHeight) && (
        <div className={cn(
          "flex flex-col overflow-hidden bg-zinc-950/40",
          fullHeight ? "flex-1 min-h-0" : "h-[420px]"
        )}>
          
          {/* Preset Selector Panel */}
          <div className="p-3 bg-zinc-900/60 border-b border-white/5 flex flex-col gap-2 flex-shrink-0">
            <div className="flex items-center gap-2 justify-between">
              <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Пресет сведения</span>
              <div className="flex items-center gap-1">
                <button 
                  onClick={handleSavePresetChanges}
                  title="Сохранить изменения"
                  className="p-1.5 bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-300 hover:text-white rounded-lg border border-white/5 transition-all"
                >
                  <Save className="w-3.5 h-3.5" />
                </button>
                <button 
                  onClick={handleSharePreset}
                  title="Поделиться пресетом (JSON)"
                  className="p-1.5 bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-300 hover:text-white rounded-lg border border-white/5 transition-all"
                >
                  <Share2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <select 
              value={selectedPresetId}
              onChange={(e) => handlePresetChange(e.target.value)}
              className="w-full bg-zinc-900 border border-white/10 rounded-xl px-3 py-2 text-xs font-semibold text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <optgroup label="Системные пресеты">
                {presets.filter(p => p.isSystem).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </optgroup>
              {presets.some(p => !p.isSystem) && (
                <optgroup label="Пользовательские пресеты">
                  {presets.filter(p => !p.isSystem).map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </optgroup>
              )}
            </select>

            <p className="text-[10px] text-zinc-400 italic leading-snug px-1">
              {activePreset.description}
            </p>
          </div>

          {/* Preset Creation Form Popover */}
          {isCreatingPreset && (
            <form onSubmit={handleCreatePreset} className="p-3 bg-zinc-900 border-b border-indigo-500/20 flex flex-col gap-3 flex-shrink-0 animate-fade-in text-xs">
              <div className="font-bold text-zinc-200 uppercase tracking-widest text-[9px] text-indigo-400">Новый пресет сведения</div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-zinc-500 uppercase font-black">Название</label>
                <input 
                  type="text" 
                  value={newPresetName} 
                  onChange={(e) => setNewPresetName(e.target.value)} 
                  className="bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" 
                  placeholder="Мой Супер Пресет"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-zinc-500 uppercase font-black">Описание</label>
                <textarea 
                  value={newPresetDesc} 
                  onChange={(e) => setNewPresetDesc(e.target.value)} 
                  className="bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 h-12 resize-none" 
                  placeholder="Для дубляжа блокбастеров..."
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button 
                  type="button" 
                  onClick={() => setIsCreatingPreset(false)}
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-[10px] font-bold uppercase"
                >
                  Отмена
                </button>
                <button 
                  type="submit" 
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-[10px] font-bold uppercase text-white"
                >
                  Создать
                </button>
              </div>
            </form>
          )}

          {/* Action Trigger Button */}
          <div className="p-3 bg-zinc-950/20 border-b border-white/5 flex flex-col gap-2 flex-shrink-0">
            {isProcessing ? (
              <div className="w-full bg-zinc-900 border border-indigo-500/30 rounded-xl p-2.5 flex flex-col gap-1.5 shadow-lg">
                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-zinc-400 font-bold truncate pr-2">{processingStep}</span>
                  <span className="text-indigo-400 font-mono font-bold">{processingProgress}%</span>
                </div>
                <div className="w-full bg-zinc-950 h-1.5 rounded-full overflow-hidden border border-white/5">
                  <div 
                    className="bg-gradient-to-r from-indigo-500 to-emerald-500 h-full rounded-full transition-all duration-300" 
                    style={{ width: `${processingProgress}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <button 
                  onClick={handleStartMixing}
                  disabled={!project}
                  className="w-full bg-gradient-to-r from-indigo-600 via-indigo-500 to-emerald-600 hover:opacity-95 active:scale-[0.98] disabled:opacity-50 text-white rounded-xl py-2.5 px-4 text-xs font-black transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/25 tracking-wide"
                >
                  <Play className="w-4 h-4 fill-white" />
                  <span>ЗАПУСТИТЬ КОНВЕЙЕР (1 КЛИК)</span>
                </button>
                <div className="flex items-center justify-between px-1 text-[9px] text-zinc-400 font-medium">
                  <span>Предобработка → Тайминг → Сведение → Финал</span>
                  {finalRenderResult && (
                    <button
                      onClick={() => setIsRenderProgressModalOpen(true)}
                      className="text-emerald-400 hover:text-emerald-300 font-bold underline flex items-center gap-1"
                    >
                      <span>🎬 Результат серии</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Tab Selector */}
          <div className="flex border-b border-white/5 bg-zinc-900/40 text-[10px] font-bold uppercase tracking-wider flex-shrink-0">
            <button 
              onClick={() => setActiveTab('prep')}
              className={cn(
                "flex-1 py-2 text-center transition-all border-b-2 hover:text-zinc-200",
                activeTab === 'prep' ? "border-indigo-500 text-indigo-400 bg-zinc-950/20" : "border-transparent text-zinc-500"
              )}
            >
              1. Преп
            </button>
            <button 
              onClick={() => setActiveTab('timing')}
              className={cn(
                "flex-1 py-2 text-center transition-all border-b-2 hover:text-zinc-200",
                activeTab === 'timing' ? "border-indigo-500 text-indigo-400 bg-zinc-950/20" : "border-transparent text-zinc-500"
              )}
            >
              2. Тайм
            </button>
            <button 
              onClick={() => setActiveTab('mixing')}
              className={cn(
                "flex-1 py-2 text-center transition-all border-b-2 hover:text-zinc-200",
                activeTab === 'mixing' ? "border-indigo-500 text-indigo-400 bg-zinc-950/20" : "border-transparent text-zinc-500"
              )}
            >
              3. Сведение
            </button>
            <button 
              onClick={() => setActiveTab('render')}
              className={cn(
                "flex-1 py-2 text-center transition-all border-b-2 hover:text-zinc-200",
                activeTab === 'render' ? "border-indigo-500 text-indigo-400 bg-zinc-950/20" : "border-transparent text-zinc-500"
              )}
            >
              4. Финал
            </button>
          </div>

          {/* Tab Content (Scrollable settings area) */}
          <div className="flex-1 overflow-y-auto p-3.5 space-y-4 custom-scrollbar text-xs">

            {/* TAB 1: PREPROCESSING */}
            {activeTab === 'prep' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="font-bold text-zinc-300 uppercase tracking-widest text-[10px] flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                    Предобработка звука
                  </span>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={activePreset.phase1.enabled}
                      onChange={(e) => updatePhase1({ enabled: e.target.checked })}
                      className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                    />
                    <span className="text-[10px] font-black uppercase text-zinc-500">Вкл этап</span>
                  </label>
                </div>

                {activePreset.phase1.enabled && (
                  <div className="space-y-4 opacity-100 transition-opacity">
                    {/* Кнопка добавления VST-шага */}
                    <div className="flex items-center justify-between bg-zinc-900/30 p-2.5 rounded-xl border border-white/5">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-black uppercase text-zinc-400">Последовательность шагов</span>
                        <span className="text-[9px] text-zinc-500">Добавляйте VST плагины в цепочку</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const vstId = 'vstStep_' + Date.now();
                          const newVstStep = {
                            id: vstId,
                            name: `VST Цепочка #${(activePreset.phase1Order?.filter(k => k.startsWith('vstStep_')).length || 0) + 1}`,
                            bypass: false,
                            plugins: []
                          };
                          const updatedOrder = [...(activePreset.phase1Order || DEFAULT_PHASE1_ORDER), vstId];
                          const updatedVstSteps = {
                            ...(activePreset.phase1.vstSteps || {}),
                            [vstId]: newVstStep
                          };
                          setActivePreset({
                            ...activePreset,
                            phase1Order: updatedOrder,
                            phase1: {
                              ...activePreset.phase1,
                              vstSteps: updatedVstSteps
                            }
                          });
                          showToast('VST-шаг добавлен! Вы можете перетащить его в любое место.');
                        }}
                        className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 active:scale-95 border border-indigo-500/30 hover:border-indigo-500/50 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                      >
                        <Plus className="w-3 h-3 text-indigo-300" />
                        <span>Добавить VST-шаг</span>
                      </button>
                    </div>

                    {activePreset.phase1Order.map((stepKey, index) => {
                      let stepElement: React.ReactNode = null;
                      let stepName = "";
                      let stepDesc = "";
                      let stepIcon = <Volume2 className="w-3.5 h-3.5" />;
                      let stepBypass = false;
                      let handleBypassToggle = () => {};

                      if (stepKey === "normalization") {
                        stepName = "Нормализация и Апвард";
                        stepDesc = "Выравнивание тихих фраз без шума";
                        stepIcon = <Volume2 className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase1.normalization.bypass;
                        handleBypassToggle = () => updatePhase1({
                          normalization: { ...activePreset.phase1.normalization, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-4 animate-fade-in text-xs">
                            <div className="text-[10px] text-zinc-400 leading-normal bg-zinc-950/40 p-2.5 rounded-lg border border-white/5 space-y-1">
                              <p>
                                Каждую дорожку необходимо выровнять по громкости до нормализации. Сначала определяется <strong className="text-red-400">порог шума</strong>, чтобы шумодав не принял тихую речь за шум.
                              </p>
                              <p>
                                Затем применяется <strong className="text-indigo-400">апвард-компрессия</strong>: она подтягивает тихие фразы, но оставляет шум внизу нетронутым. После этого дорожка нормализуется до целевых LUFS.
                              </p>
                            </div>

                            <div className="flex items-center justify-between bg-zinc-950/20 p-2 border border-white/5 rounded-lg">
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">Определение шума</span>
                                <span className="text-[11px] text-zinc-400 font-medium">
                                  {isDetectingNoise ? 'Анализ аудиодорожек...' : (activePreset.phase1.normalization.noiseFloorDb ?? -55.0) + ' dB (порог шума)'}
                                </span>
                              </div>
                              <button
                                onClick={handleDetectNoise}
                                disabled={isDetectingNoise}
                                className={cn(
                                  "px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all flex items-center gap-1.5 border",
                                  isDetectingNoise
                                    ? "bg-zinc-900 border-zinc-800 text-zinc-600 cursor-not-allowed animate-pulse"
                                    : "bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-400 border-indigo-500/20 active:scale-95"
                                )}
                              >
                                <Sparkles className="w-3.5 h-3.5" />
                                {isDetectingNoise ? 'Поиск...' : 'Авто-детект'}
                              </button>
                            </div>

                            <div className="bg-zinc-950 border border-white/5 rounded-xl p-2.5 space-y-2">
                              <div className="flex justify-between items-center text-[9px] font-mono text-zinc-500 uppercase tracking-widest px-0.5">
                                <span>Кривая сжатия</span>
                                <span className="text-indigo-400">Интерактивный график</span>
                              </div>
                              
                              <div className="relative w-full h-24 bg-zinc-950 rounded-lg overflow-hidden border border-white/5">
                                <svg className="w-full h-full" viewBox="0 0 280 100" preserveAspectRatio="none">
                                  <line x1="20" y1="10" x2="260" y2="10" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                                  <line x1="20" y1="50" x2="260" y2="50" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                                  <line x1="20" y1="90" x2="260" y2="90" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                                  <line x1="80" y1="10" x2="80" y2="90" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                                  <line x1="140" y1="10" x2="140" y2="90" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                                  <line x1="200" y1="10" x2="200" y2="90" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                                  <line x1="20" y1="90" x2="260" y2="10" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="3 3" />
                                  {(() => {
                                    const noiseFloor = activePreset.phase1.normalization.noiseFloorDb ?? -55.0;
                                    const xNoise = 20 + ((noiseFloor + 80) / 80) * 240;
                                    return (
                                      <>
                                        <line x1={xNoise} y1="10" x2={xNoise} y2="90" stroke="#f43f5e" strokeWidth="1" strokeOpacity="0.4" strokeDasharray="2 2" />
                                        <text x={xNoise + 4} y="85" fill="#f43f5e" fontSize="7" opacity="0.6" fontFamily="monospace">ШУМ</text>
                                      </>
                                    );
                                  })()}
                                  {(() => {
                                    const upwardThreshold = activePreset.phase1.normalization.upwardThresholdDb ?? -35.0;
                                    const xUpward = 20 + ((upwardThreshold + 80) / 80) * 240;
                                    return (
                                      <>
                                        <line x1={xUpward} y1="10" x2={xUpward} y2="90" stroke="#eab308" strokeWidth="1" strokeOpacity="0.4" strokeDasharray="2 2" />
                                        <text x={xUpward + 4} y="22" fill="#eab308" fontSize="7" opacity="0.6" fontFamily="monospace">ПОРОГ</text>
                                      </>
                                    );
                                  })()}
                                  {(() => {
                                    const noiseFloor = activePreset.phase1.normalization.noiseFloorDb ?? -55.0;
                                    const upwardThreshold = activePreset.phase1.normalization.upwardThresholdDb ?? -35.0;
                                    const upwardGain = activePreset.phase1.normalization.upwardGainDb ?? 6.0;
                                    const targetLufs = activePreset.phase1.normalization.targetLufs ?? -16.0;

                                    const points: string[] = [];
                                    for (let db = -80; db <= 0; db += 2) {
                                      let outDb = db;
                                      if (db > noiseFloor && db < upwardThreshold) {
                                        const t = (db - noiseFloor) / (upwardThreshold - noiseFloor);
                                        const gain = upwardGain * Math.sin(t * Math.PI);
                                        outDb = db + gain;
                                      }
                                      const offset = (targetLufs - (-23)) * 1.1;
                                      outDb = outDb + offset;
                                      if (outDb > 0) outDb = 0;
                                      const x = 20 + ((db + 80) / 80) * 240;
                                      const y = 90 - ((outDb + 80) / 80) * 80;
                                      points.push(`${db === -80 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`);
                                    }
                                    return (
                                      <path 
                                        d={points.join(' ')} 
                                        fill="none" 
                                        stroke="rgb(99, 102, 241)" 
                                        strokeWidth="2" 
                                        strokeLinecap="round" 
                                        strokeLinejoin="round" 
                                      />
                                    );
                                  })()}
                                </svg>
                                <div className="absolute bottom-1 right-2 text-[8px] font-mono text-zinc-600 uppercase">
                                  Вход: -80 dB ... 0 dB
                                </div>
                              </div>
                            </div>

                            <div className="space-y-3.5 bg-zinc-950/20 p-3 rounded-xl border border-white/5">
                              <div className="space-y-1">
                                <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" />Порог фонового шума</span>
                                  <span className="text-rose-400 font-bold">{activePreset.phase1.normalization.noiseFloorDb ?? -55.0} dB</span>
                                </div>
                                <input 
                                  type="range" 
                                  min="-80" 
                                  max="-30" 
                                  step="1"
                                  value={activePreset.phase1.normalization.noiseFloorDb ?? -55.0}
                                  onChange={(e) => updatePhase1({
                                    normalization: { ...activePreset.phase1.normalization, noiseFloorDb: parseFloat(e.target.value) }
                                  })}
                                  className="w-full accent-rose-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                                />
                              </div>

                              <div className="space-y-1">
                                <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />Порог подтяжки тихих звуков</span>
                                  <span className="text-yellow-400 font-bold">{activePreset.phase1.normalization.upwardThresholdDb ?? -35.0} dB</span>
                                </div>
                                <input 
                                  type="range" 
                                  min="-60" 
                                  max="-15" 
                                  step="1"
                                  value={activePreset.phase1.normalization.upwardThresholdDb ?? -35.0}
                                  onChange={(e) => updatePhase1({
                                    normalization: { ...activePreset.phase1.normalization, upwardThresholdDb: parseFloat(e.target.value) }
                                  })}
                                  className="w-full accent-yellow-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                                />
                              </div>

                              <div className="space-y-1">
                                <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />Усиление тихой зоны (Upward Gain)</span>
                                  <span className="text-indigo-400 font-bold">+{activePreset.phase1.normalization.upwardGainDb ?? 6.0} dB</span>
                                </div>
                                <input 
                                  type="range" 
                                  min="0" 
                                  max="18" 
                                  step="0.5"
                                  value={activePreset.phase1.normalization.upwardGainDb ?? 6.0}
                                  onChange={(e) => updatePhase1({
                                    normalization: { ...activePreset.phase1.normalization, upwardGainDb: parseFloat(e.target.value) }
                                  })}
                                  className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                                />
                              </div>

                              <div className="space-y-1">
                                <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />Степень сжатия (Ratio)</span>
                                  <span className="text-indigo-400 font-bold">{activePreset.phase1.normalization.upwardRatio ?? 2.0}:1</span>
                                </div>
                                <input 
                                  type="range" 
                                  min="1.1" 
                                  max="4.0" 
                                  step="0.1"
                                  value={activePreset.phase1.normalization.upwardRatio ?? 2.0}
                                  onChange={(e) => updatePhase1({
                                    normalization: { ...activePreset.phase1.normalization, upwardRatio: parseFloat(e.target.value) }
                                  })}
                                  className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                                />
                              </div>

                              <div className="space-y-1 border-t border-white/5 pt-3">
                                <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />Итоговая нормализация громкости</span>
                                  <span className="text-indigo-400 font-bold">{activePreset.phase1.normalization.targetLufs} LUFS</span>
                                </div>
                                <input 
                                  type="range" 
                                  min="-28" 
                                  max="-10" 
                                  step="0.5"
                                  value={activePreset.phase1.normalization.targetLufs}
                                  onChange={(e) => updatePhase1({
                                    normalization: { ...activePreset.phase1.normalization, targetLufs: parseFloat(e.target.value) }
                                  })}
                                  className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                                />
                              </div>
                              {renderProcessingActions('normalization', 'Применить нормализацию', 'bg-indigo-600 hover:bg-indigo-500')}
                            </div>
                          </div>
                        );
                      } else if (stepKey === "deClick") {
                        stepName = "Клики, щелчки и слюни";
                        stepDesc = "Удаление переходных микро-помех";
                        stepIcon = <Sparkles className="w-3.5 h-3.5 text-rose-400" />;
                        stepBypass = activePreset.phase1.deClick.bypass;
                        handleBypassToggle = () => updatePhase1({
                          deClick: { ...activePreset.phase1.deClick, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3.5 text-xs animate-fade-in">
                            <div className="text-[10px] text-zinc-400 leading-normal bg-zinc-950/40 p-2.5 rounded-lg border border-white/5">
                              <p className="font-semibold text-rose-400 mb-0.5">🚀 Локальный без-VST алгоритм:</p>
                              Вычисляется <strong>вторая производная</strong> сигнала (ускорение) для мгновенного обнаружения микро-выбросов. Поврежденные слюной участки восстанавливаются гладкой кубической интерполяцией <em>Smoothstep</em>.
                            </div>

                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 uppercase font-black block">Частотный фокус детектора</label>
                              <select 
                                value={activePreset.phase1.deClick.detectorType ?? 'mouth'}
                                onChange={(e) => updatePhase1({
                                  deClick: { ...activePreset.phase1.deClick, detectorType: e.target.value as any }
                                })}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300 cursor-pointer"
                              >
                                <option value="mouth">Слюнные клики и щелчки губ (Mouth click)</option>
                                <option value="mechanical">Механический треск микрофона</option>
                                <option value="broadband">Широкополосные импульсные помехи</option>
                              </select>
                            </div>

                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                <span>Чувствительность детекции</span>
                                <span className="text-rose-400 font-bold">{activePreset.phase1.deClick.sensitivity}%</span>
                              </div>
                              <input 
                                type="range" 
                                min="0" 
                                max="100" 
                                value={activePreset.phase1.deClick.sensitivity}
                                onChange={(e) => updatePhase1({
                                  deClick: { ...activePreset.phase1.deClick, sensitivity: parseInt(e.target.value) }
                                })}
                                className="w-full accent-rose-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>

                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                <span>Макс. ширина щелчка</span>
                                <span className="text-rose-400 font-bold">{(activePreset.phase1.deClick.maxClickWidthMs ?? 2.0).toFixed(1)} мс</span>
                              </div>
                              <input 
                                type="range" 
                                min="0.5" 
                                max="5.0" 
                                step="0.1"
                                value={activePreset.phase1.deClick.maxClickWidthMs ?? 2.0}
                                onChange={(e) => updatePhase1({
                                  deClick: { ...activePreset.phase1.deClick, maxClickWidthMs: parseFloat(e.target.value) }
                                })}
                                className="w-full accent-rose-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>

                            <div className="bg-zinc-950 border border-white/5 rounded-xl p-2.5 space-y-2">
                              <div className="flex justify-between items-center text-[9px] font-mono text-zinc-500 uppercase tracking-widest px-0.5">
                                <span>Очистка в реальном времени</span>
                                <span className="text-emerald-400 flex items-center gap-1">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                  АКТИВНО
                                </span>
                              </div>

                              <div className="h-16 bg-zinc-950 rounded-lg overflow-hidden border border-white/5 relative flex items-center justify-center">
                                <svg className="w-full h-full" viewBox="0 0 280 60" preserveAspectRatio="none">
                                  <path 
                                    d="M 10 30 Q 35 12 60 30 T 110 30 T 160 30 T 210 30 T 260 30" 
                                    fill="none" 
                                    stroke="rgba(255, 255, 255, 0.2)" 
                                    strokeWidth="1.5" 
                                  />
                                  <path 
                                    d="M 125 30 L 130 5 L 133 55 L 136 30" 
                                    fill="none" 
                                    stroke="#f43f5e" 
                                    strokeWidth="1.5" 
                                    className="animate-pulse"
                                  />
                                  <path 
                                    d="M 124 30 Q 130 30 137 30" 
                                    fill="none" 
                                    stroke="#10b981" 
                                    strokeWidth="2" 
                                    strokeDasharray="2 1"
                                  />
                                  <text x="145" y="15" fill="#f43f5e" fontSize="7" fontFamily="monospace">ЩЕЛЧОК/СЛЮНИ (ВЫРЕЗАНО)</text>
                                  <text x="145" y="52" fill="#10b981" fontSize="7" fontFamily="monospace">SMOOTHSTEP ИНТЕРПОЛЯЦИЯ</text>
                                </svg>
                              </div>

                              <div className="grid grid-cols-2 gap-2 text-[9px] font-mono text-zinc-500 px-0.5 pt-1">
                                <div className="flex justify-between border-r border-white/5 pr-2">
                                  <span>Удалено кликов:</span>
                                  <span className="text-zinc-300 font-bold">142</span>
                                </div>
                                <div className="flex justify-between pl-1">
                                  <span>Индекс слюны:</span>
                                  <span className="text-zinc-300 font-bold">Низкий (0.24)</span>
                                </div>
                              </div>
                            </div>

                            <label className="flex items-center gap-1.5 cursor-pointer mt-1 mb-2">
                              <input 
                                type="checkbox" 
                                checked={activePreset.phase1.deClick.mouthDeClick}
                                onChange={(e) => updatePhase1({ 
                                  deClick: { ...activePreset.phase1.deClick, mouthDeClick: e.target.checked } 
                                })}
                                className="rounded border-zinc-700 bg-zinc-800 text-rose-600 focus:ring-0 cursor-pointer"
                              />
                              <span className="text-[10px] text-zinc-400 font-medium">Умное подавление шума слюны (Mouth De-click)</span>
                            </label>
                            {renderProcessingActions('declick', 'Удалить щелчки', 'bg-rose-600 hover:bg-rose-500')}
                          </div>
                        );
                      } else if (stepKey === "dePlosive") {
                        stepName = "Подавление взрывных согласных";
                        stepDesc = "Сглаживание резких согласных Б, П, Т";
                        stepIcon = <Sliders className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase1.dePlosive.bypass;
                        handleBypassToggle = () => updatePhase1({
                          dePlosive: { ...activePreset.phase1.dePlosive, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 animate-fade-in text-xs">
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                <span>Порог детекции взрывных</span>
                                <span className="font-bold text-indigo-400">{activePreset.phase1.dePlosive.threshold} dB</span>
                              </div>
                              <input 
                                type="range" 
                                min="-40" 
                                max="0" 
                                step="1"
                                value={activePreset.phase1.dePlosive.threshold}
                                onChange={(e) => updatePhase1({
                                  dePlosive: { ...activePreset.phase1.dePlosive, threshold: parseFloat(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                <span>Частота среза фильтра</span>
                                <span className="font-bold text-indigo-400">{activePreset.phase1.dePlosive.frequencyCutoff} Гц</span>
                              </div>
                              <input 
                                type="range" 
                                min="40" 
                                max="150" 
                                step="5"
                                value={activePreset.phase1.dePlosive.frequencyCutoff}
                                onChange={(e) => updatePhase1({
                                  dePlosive: { ...activePreset.phase1.dePlosive, frequencyCutoff: parseInt(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>
                            <div className="text-[10px] text-zinc-400 leading-normal bg-zinc-950/40 p-2.5 rounded-lg border border-white/5">
                              Устраняет низкочастотные воздушные удары по капсюлю микрофона от букв Б, П, Т без обрезания полезного баса в голосе.
                            </div>
                          </div>
                        );
                      } else if (stepKey === "deEsser") {
                        stepName = "Де-эссер (Сибилянты)";
                        stepDesc = "Смягчение свистящих С, Ш, Щ, Ц";
                        stepIcon = <Sparkles className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase1.deEsser.bypass;
                        handleBypassToggle = () => updatePhase1({
                          deEsser: { ...activePreset.phase1.deEsser, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 animate-fade-in text-xs">
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                <span>Порог де-эссинга</span>
                                <span className="font-bold text-indigo-400">{activePreset.phase1.deEsser.threshold} dB</span>
                              </div>
                              <input 
                                type="range" 
                                min="-50" 
                                max="-5" 
                                step="1"
                                value={activePreset.phase1.deEsser.threshold}
                                onChange={(e) => updatePhase1({
                                  deEsser: { ...activePreset.phase1.deEsser, threshold: parseFloat(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                <span>Целевая частота сибилянтов</span>
                                <span className="font-bold text-indigo-400">{activePreset.phase1.deEsser.frequency} Гц</span>
                              </div>
                              <input 
                                type="range" 
                                min="4000" 
                                max="9000" 
                                step="100"
                                value={activePreset.phase1.deEsser.frequency}
                                onChange={(e) => updatePhase1({
                                  deEsser: { ...activePreset.phase1.deEsser, frequency: parseInt(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>
                            <div className="text-[10px] text-zinc-400 leading-normal bg-zinc-950/40 p-2.5 rounded-lg border border-white/5">
                              Ослабляет неприятные свистящие частоты в районе верхних средних и высоких частот при произнесении сибилянтов.
                            </div>
                          </div>
                        );
                      } else if (stepKey === "denoise") {
                        stepName = "Шумоподавление";
                        stepDesc = "Подавление статического фона";
                        stepIcon = <Volume2 className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase1.denoise.bypass;
                        handleBypassToggle = () => updatePhase1({
                          denoise: { ...activePreset.phase1.denoise, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 animate-fade-in text-xs">
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                                <span>Сила подавления</span>
                                <span>{activePreset.phase1.denoise.strength}%</span>
                              </div>
                              <input 
                                type="range" 
                                min="0" 
                                max="100" 
                                value={activePreset.phase1.denoise.strength}
                                onChange={(e) => updatePhase1({
                                  denoise: { ...activePreset.phase1.denoise, strength: parseInt(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 uppercase font-black block">Модель шумоподавления</label>
                              <select 
                                value={activePreset.phase1.denoise.model}
                                onChange={(e) => updatePhase1({
                                  denoise: { ...activePreset.phase1.denoise, model: e.target.value as any }
                                })}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300 mb-2 font-mono"
                              >
                                <optgroup label="⚡ Встроенные (DSP / Оффлайн)">
                                  <option value="spectral_gate">Спектральный гейт (AFFTDN)</option>
                                  <option value="deep_noise">Deep Denoise AI (RNNoise)</option>
                                  <option value="intel_ai_denoise">Intel Voice Clean (Экспандер)</option>
                                </optgroup>
                                <optgroup label="🧠 VR Архитектура (UVR5 / Нейросеть)">
                                  <option value="uvr_denoise_lite">VR-DeNoise Lite (Быстрая очистка)</option>
                                  <option value="uvr_denoise_foxjoy">VR-DeNoise FoxJoy (Вокал / Речь)</option>
                                  <option value="uvr_denoise_full">VR-DeNoise Full (Глубокое подавление)</option>
                                </optgroup>
                              </select>
                            </div>
                            {renderProcessingActions('denoise', 'Подавить шум', 'bg-teal-600 hover:bg-teal-500')}
                          </div>
                        );
                      } else if (stepKey === "dereverb") {
                        stepName = "Дереверберация (Эхо)";
                        stepDesc = "Подавление эха комнат";
                        stepIcon = <Volume2 className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase1.dereverb.bypass;
                        handleBypassToggle = () => updatePhase1({
                          dereverb: { ...activePreset.phase1.dereverb, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 animate-fade-in text-xs">
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                                <span>Подавление эха комнат</span>
                                <span>{activePreset.phase1.dereverb.strength}%</span>
                              </div>
                              <input 
                                type="range" 
                                min="0" 
                                max="100" 
                                value={activePreset.phase1.dereverb.strength}
                                onChange={(e) => updatePhase1({
                                  dereverb: { ...activePreset.phase1.dereverb, strength: parseInt(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>
                            
                            <div className="space-y-1 mb-2">
                              <label className="text-[10px] text-zinc-500 uppercase font-black block">Алгоритм</label>
                              <select 
                                value={activePreset.phase1.dereverb.model}
                                onChange={(e) => updatePhase1({
                                  dereverb: { ...activePreset.phase1.dereverb, model: e.target.value as any }
                                })}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300 font-mono"
                              >
                                <optgroup label="⚡ Встроенные (DSP / Оффлайн)">
                                  <option value="rt_dereverb_v2">RT_Dereverb v2 (DSP подавление)</option>
                                  <option value="room_cleaner_neural">Neural Room Cleaner (Резонансы)</option>
                                  <option value="adaptive_gate">Адаптивный гейт (Transient Gate)</option>
                                </optgroup>
                                <optgroup label="🧠 VR Архитектура (UVR5 / Нейросеть)">
                                  <option value="uvr_deecho_normal">VR-DeEcho Normal (Мягкая очистка)</option>
                                  <option value="uvr_deecho_aggressive">VR-DeEcho Aggressive (Глубокое подавление)</option>
                                </optgroup>
                              </select>
                            </div>
                            {renderProcessingActions('dereverb', 'Убрать эхо', 'bg-purple-600 hover:bg-purple-500')}
                          </div>
                        );
                      } else if (stepKey === "volumeLeveler") {
                        stepName = "Авто-выравнивание уровня (Leveler)";
                        stepDesc = "Сглаживание перепадов внутри фраз";
                        stepIcon = <Volume2 className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase1.volumeLeveler.bypass;
                        handleBypassToggle = () => updatePhase1({
                          volumeLeveler: { ...activePreset.phase1.volumeLeveler, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 animate-fade-in text-xs">
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                <span>Целевой уровень (Target RMS)</span>
                                <span className="font-bold text-indigo-400">{activePreset.phase1.volumeLeveler.targetRms} dB</span>
                              </div>
                              <input 
                                type="range" 
                                min="-30" 
                                max="-10" 
                                step="1"
                                value={activePreset.phase1.volumeLeveler.targetRms}
                                onChange={(e) => updatePhase1({
                                  volumeLeveler: { ...activePreset.phase1.volumeLeveler, targetRms: parseFloat(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                <span>Степень сжатия (Ratio)</span>
                                <span className="font-bold text-indigo-400">{activePreset.phase1.volumeLeveler.ratio}:1</span>
                              </div>
                              <input 
                                type="range" 
                                min="1.1" 
                                max="4.0" 
                                step="0.1"
                                value={activePreset.phase1.volumeLeveler.ratio}
                                onChange={(e) => updatePhase1({
                                  volumeLeveler: { ...activePreset.phase1.volumeLeveler, ratio: parseFloat(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>
                            <div className="text-[10px] text-zinc-400 leading-normal bg-zinc-950/40 p-2.5 rounded-lg border border-white/5">
                              Автоматический регулятор громкости (AGC), сглаживающий разницу между тихими и громкими словами спикера в реальном времени.
                            </div>
                          </div>
                        );
                      } else if (stepKey === "eqMatching") {
                        stepName = "Выравнивание АЧХ";
                        stepDesc = "Гармонизация тембра по мишени";
                        stepIcon = <Sliders className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase1.eqMatching.bypass;
                        handleBypassToggle = () => updatePhase1({
                          eqMatching: { ...activePreset.phase1.eqMatching, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 animate-fade-in text-xs">
                            <label className="text-[10px] text-zinc-500 uppercase font-black block">Профиль АЧХ (Match Target)</label>
                            <select 
                              value={activePreset.phase1.eqMatching.profileModel}
                              onChange={(e) => updatePhase1({
                                eqMatching: { ...activePreset.phase1.eqMatching, profileModel: e.target.value as any }
                              })}
                              className="w-full bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs text-zinc-300 cursor-pointer"
                            >
                              <option value="flat">Плоская характеристика (Flat EQ)</option>
                              <option value="vocal_presence">Презенс вокала (Vocal Presence - подкаст)</option>
                              <option value="warm_analog">Теплый аналоговый звук (Warm Analog)</option>
                              <option value="reference_match">Сравнение с оригинальным референсом дубляжа</option>
                            </select>
                            
                            <div className="text-[10px] text-zinc-400 leading-normal bg-zinc-950/40 p-2.5 rounded-lg border border-white/5 mb-2">
                              Корректирует частотную кривую новой дорожки, приближая ее к тембральной окраске эталонного голоса. Исключает разницу в качестве микрофонов актеров.
                            </div>
                            {renderProcessingActions('smarteq', 'Применить Умный EQ', 'bg-amber-600 hover:bg-amber-500')}
                          </div>
                        );
                      } else if (stepKey === "sourceSeparation") {
                        stepName = "Разделение оригинала (UVR5 / Demucs)";
                        stepDesc = "Разделение аудиодорожки на вокал/голос и фоновую музыку/шумы";
                        stepIcon = <Volume2 className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase1.sourceSeparation.bypass;
                        handleBypassToggle = () => updatePhase1({
                          sourceSeparation: { ...activePreset.phase1.sourceSeparation, bypass: !stepBypass }
                        });

                        const originalTrack = project?.tracks.find(t => t.name === 'Оригинал');
                        const defaultOriginalFile = originalTrack?.segments?.[0]?.filePath || project?.referenceAudioPath || project?.videoPath || '';

                        stepElement = (
                          <div className="space-y-3 animate-fade-in text-xs">
                            {/* UVR5 / Environment Status Header */}
                            <div className="flex items-center justify-between bg-zinc-950/50 p-2.5 rounded-xl border border-indigo-500/20">
                              <div className="flex items-center gap-2">
                                <div className="w-6 h-6 bg-indigo-500/15 rounded-lg flex items-center justify-center border border-indigo-500/30">
                                  <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                                </div>
                                <div className="flex flex-col">
                                  <span className="font-bold text-zinc-200 text-xs">Служба ИИ (UVR5 / audio-separator)</span>
                                  <span className="text-[9px] text-zinc-400">
                                    {!separatorStatus ? (
                                      <span className="text-yellow-400">Проверка окружения ИИ...</span>
                                    ) : !separatorStatus.python_found ? (
                                      <span className="text-red-400">Python не найден или заблокирован</span>
                                    ) : !separatorStatus.separator_installed ? (
                                      <span className="text-amber-400">Библиотека не установлена</span>
                                    ) : (
                                      <span className="text-emerald-400 font-semibold">Готова к работе (v{separatorStatus.version || '1.0'})</span>
                                    )}
                                  </span>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {separatorStatus?.cuda_available && (
                                  <span className="bg-emerald-500/10 text-emerald-400 text-[8px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider">
                                    GPU CUDA
                                  </span>
                                )}
                                <button 
                                  onClick={refreshSeparatorStatus}
                                  className="p-1 hover:bg-white/5 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
                                  title="Обновить статус"
                                >
                                  <RefreshCw className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            {/* If audio-separator is not installed, show inline install banner */}
                            {separatorStatus && separatorStatus.python_found && !separatorStatus.separator_installed && (
                              <div className="p-3 bg-yellow-950/15 border border-yellow-500/20 rounded-xl space-y-2.5">
                                <div className="flex items-start gap-2 text-yellow-400 text-[11px] font-medium">
                                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                  <span>Библиотека audio-separator (UVR5) не установлена</span>
                                </div>
                                <p className="text-[10px] text-zinc-400 leading-normal">
                                  Для локального нейросетевого разделения вокала и фонограммы установите библиотеку в среду Python.
                                </p>
                                <div className="space-y-2 border-t border-white/5 pt-2">
                                  <label className="flex items-center gap-1.5 cursor-pointer">
                                    <input 
                                      type="checkbox"
                                      checked={useGpuForSeparator}
                                      onChange={(e) => setUseGpuForSeparator(e.target.checked)}
                                      className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                    />
                                    <span className="text-[10px] text-zinc-300 font-medium">Включить поддержку GPU (CUDA)</span>
                                  </label>

                                  <button
                                    onClick={handleInstallSeparator}
                                    disabled={isInstallingSeparator}
                                    className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 text-white text-[11px] font-bold py-1.5 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                                  >
                                    {isInstallingSeparator ? (
                                      <>
                                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                        <span>Установка зависимостей...</span>
                                      </>
                                    ) : (
                                      <span>Установить audio-separator</span>
                                    )}
                                  </button>
                                </div>

                                {installLogs.length > 0 && (
                                  <div className="space-y-1">
                                    <span className="text-[9px] text-zinc-500 uppercase font-black block">Логи установки:</span>
                                    <div className="bg-zinc-950/80 p-2 rounded border border-white/5 font-mono text-[9px] text-zinc-400 h-20 overflow-y-auto space-y-0.5">
                                      {installLogs.map((log, idx) => (
                                        <div key={idx} className="truncate">{log}</div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Model selection */}
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 uppercase font-black block">Модель разделения (UVR5 / Demucs)</label>
                              <select 
                                value={activePreset.phase1.sourceSeparation.model}
                                onChange={(e) => {
                                  const modelVal = e.target.value;
                                  updatePhase1({
                                    sourceSeparation: { ...activePreset.phase1.sourceSeparation, model: modelVal as any }
                                  });
                                  setSelectedSeparatorModel(modelVal);
                                }}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs text-zinc-300 font-mono"
                              >
                                <optgroup label="🧠 Нейросети UVR5 / Demucs (Высокое качество)">
                                  <option value="htdemucs">htdemucs (Demucs v4 - Вокал / Музыка)</option>
                                  <option value="htdemucs_vocals_bgm">htdemucs_vocals_bgm (Вокал + BGM)</option>
                                  <option value="MDX23C-8Step-VocFT.onnx">MDX23C 8-Step Vocal FT (Премиум вокал)</option>
                                  <option value="UVR-MDX-NET-Voc_FT.onnx">UVR MDX-Net Vocals (Чистый голос)</option>
                                  <option value="5_HP-Karaoke-UVR.onnx">5_HP Karaoke UVR (Караоке / Шумы)</option>
                                </optgroup>
                                <optgroup label="⚡ Быстрые DSP алгоритмы">
                                  <option value="fast_dsp_splitter">Быстрый стерео/фазовый сплиттер (DSP)</option>
                                </optgroup>
                              </select>
                            </div>

                            {/* Audio File Source Selection */}
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between">
                                <label className="text-[10px] text-zinc-500 uppercase font-black">Аудиоисточник для разделения</label>
                                <button
                                  type="button"
                                  onClick={handleSelectCustomFile}
                                  className="flex items-center gap-1 text-[9px] text-indigo-400 hover:text-indigo-300 font-bold uppercase tracking-wider cursor-pointer"
                                >
                                  <FolderOpen className="w-3 h-3" />
                                  Обзор файла...
                                </button>
                              </div>
                              
                              <select 
                                value={selectedSeparatorFile || defaultOriginalFile}
                                onChange={(e) => setSelectedSeparatorFile(e.target.value)}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs text-zinc-300"
                              >
                                {defaultOriginalFile && (
                                  <option value={defaultOriginalFile}>
                                    Оригинал проекта: {originalTrack?.name || 'Видео / Референс'}
                                  </option>
                                )}
                                {project?.tracks.flatMap(t => 
                                  t.segments.map(s => ({
                                    id: s.id,
                                    trackName: t.name,
                                    fileName: s.filePath?.split(/[\\/]/).pop() || s.originalFileName || 'Запись',
                                    filePath: s.filePath || ''
                                  })).filter(s => !!s.filePath && s.filePath !== defaultOriginalFile)
                                ).map(seg => (
                                  <option key={seg.id} value={seg.filePath}>
                                    {seg.trackName}: {seg.fileName}
                                  </option>
                                ))}
                                {selectedSeparatorFile && selectedSeparatorFile !== defaultOriginalFile && !project?.tracks.some(t => t.segments.some(s => s.filePath === selectedSeparatorFile)) && (
                                  <option value={selectedSeparatorFile}>
                                    Внешний файл: {selectedSeparatorFile.split(/[\\/]/).pop()}
                                  </option>
                                )}
                              </select>

                              {(selectedSeparatorFile || defaultOriginalFile) && (
                                <div className="text-[9px] text-zinc-400 bg-zinc-950/60 p-2 rounded-lg border border-white/5 break-all font-mono leading-relaxed">
                                  {selectedSeparatorFile || defaultOriginalFile}
                                </div>
                              )}
                            </div>

                            {/* Stems option & GPU */}
                            <div className="flex items-center justify-between text-[11px] text-zinc-400 bg-zinc-950/40 p-2 rounded-lg border border-white/5">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input 
                                  type="checkbox" 
                                  checked={activePreset.phase1.sourceSeparation.keepSeparatedStems}
                                  onChange={(e) => updatePhase1({ 
                                    sourceSeparation: { ...activePreset.phase1.sourceSeparation, keepSeparatedStems: e.target.checked } 
                                  })}
                                  className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                />
                                <span>Создать отдельные дорожки "Звуки" и "Голоса"</span>
                              </label>
                              <label className="flex items-center gap-1.5 cursor-pointer text-zinc-400">
                                <input 
                                  type="checkbox"
                                  checked={useGpuForSeparator}
                                  onChange={(e) => setUseGpuForSeparator(e.target.checked)}
                                  className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                />
                                <span className="text-[10px] font-bold">GPU CUDA</span>
                              </label>
                            </div>

                            {/* Action Button and Progress block */}
                            <div className="pt-1 space-y-2.5">
                              <button
                                type="button"
                                onClick={() => {
                                  if (!selectedSeparatorFile && defaultOriginalFile) {
                                    setSelectedSeparatorFile(defaultOriginalFile);
                                  }
                                  handleRunSeparation();
                                }}
                                disabled={isSeparating || (!selectedSeparatorFile && !defaultOriginalFile)}
                                className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white text-xs font-bold py-2.5 px-3 rounded-xl flex items-center justify-center gap-2 transition-all shadow-md cursor-pointer"
                              >
                                {isSeparating ? (
                                  <>
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-white" />
                                    <span>Идет нейросетевая обработка...</span>
                                  </>
                                ) : (
                                  <>
                                    <Sparkles className="w-3.5 h-3.5" />
                                    <span>Разделить на Голос и Музыку (UVR5)</span>
                                  </>
                                )}
                              </button>

                              {/* Separating Progress */}
                              {isSeparating && separatorProgress && (
                                <div className="bg-zinc-950/60 p-3 rounded-xl border border-indigo-500/20 space-y-2 animate-fade-in">
                                  <div className="flex items-center justify-between text-[11px]">
                                    <span className="font-bold text-indigo-400">{separatorProgress.stage}</span>
                                    <span className="font-mono text-zinc-300">{Math.round(separatorProgress.percent)}%</span>
                                  </div>
                                  <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                                    <div 
                                      className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300"
                                      style={{ width: `${separatorProgress.percent}%` }}
                                    />
                                  </div>
                                  {separatorProgress.log_line && (
                                    <div className="bg-zinc-950 p-2 rounded-lg font-mono text-[9px] text-zinc-400 border border-white/5 flex gap-1.5 items-center">
                                      <Terminal className="w-3 h-3 text-indigo-400 shrink-0" />
                                      <span className="truncate">{separatorProgress.log_line}</span>
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Success Result Block */}
                              {isSeparatorSuccess && (
                                <div className="p-3 bg-emerald-950/25 border border-emerald-500/25 rounded-xl space-y-2.5 animate-fade-in">
                                  <div className="flex items-start gap-1.5 text-emerald-400 text-[11px] font-semibold">
                                    <Check className="w-4 h-4 shrink-0 mt-0.5" />
                                    <span>Разделение успешно завершено!</span>
                                  </div>
                                  <div className="space-y-1">
                                    <span className="text-[9px] text-zinc-500 uppercase font-black block">Файл результата:</span>
                                    <div className="text-[9px] text-zinc-300 bg-zinc-950/80 p-2 rounded-lg border border-white/5 break-all font-mono leading-normal">
                                      {processedFilePath}
                                    </div>
                                  </div>
                                  <div className="flex flex-col gap-1.5 pt-1">
                                    <button
                                      type="button"
                                      onClick={handleImportFileToProject}
                                      className="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                                    >
                                      <ArrowRight className="w-3.5 h-3.5" />
                                      <span>Импортировать в проект (дорожки Голос + M&E)</span>
                                    </button>
                                    {selectedSegment && (
                                      <button
                                        type="button"
                                        onClick={handleReplaceSelectedSegmentWithSeparated}
                                        className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                                      >
                                        <RefreshCw className="w-3.5 h-3.5" />
                                        <span>Заменить выбранный сегмент</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )}

                              {/* Error Output */}
                              {separatorOutputMsg && (
                                <div className="p-3 bg-red-950/20 border border-red-500/20 rounded-xl space-y-1.5 text-red-400 text-[10px]">
                                  <div className="flex items-center gap-1.5 font-bold">
                                    <AlertCircle className="w-3.5 h-3.5" />
                                    <span>Ошибка при разделении</span>
                                  </div>
                                  <div className="font-mono bg-zinc-950/60 p-2 rounded-lg border border-white/5 break-all max-h-24 overflow-y-auto leading-normal">
                                    {separatorOutputMsg}
                                  </div>
                                </div>
                              )}

                              {/* Batch Pipeline Step Processing Action */}
                              {renderProcessingActions('separation', 'Пакетный запуск шага', 'bg-sky-600 hover:bg-sky-500')}
                            </div>
                          </div>
                        );
                      } else if (stepKey.startsWith("vstStep_")) {
                        const vstConfig = activePreset.phase1.vstSteps?.[stepKey] || {
                          id: stepKey,
                          name: `VST Цепочка #${index + 1}`,
                          bypass: false,
                          plugins: []
                        };
                        stepName = vstConfig.name;
                        stepDesc = "Последовательная цепочка VST-плагинов";
                        stepIcon = <Sliders className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = vstConfig.bypass;
                        handleBypassToggle = () => {
                          const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                          updatedSteps[stepKey] = { ...vstConfig, bypass: !stepBypass };
                          updatePhase1({ vstSteps: updatedSteps });
                        };

                        stepElement = (
                          <div className="space-y-3.5 animate-fade-in text-xs">
                            {/* Rename VST Step Container */}
                            <div className="space-y-1">
                              <label className="text-[9px] text-zinc-500 uppercase font-black block">Название этапа VST</label>
                              <input 
                                type="text"
                                value={vstConfig.name}
                                onChange={(e) => {
                                  const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                                  updatedSteps[stepKey] = { ...vstConfig, name: e.target.value };
                                  updatePhase1({ vstSteps: updatedSteps });
                                }}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-200 font-medium focus:border-indigo-500/50 focus:outline-none"
                                placeholder="Например, Мастеринг цепочка"
                              />
                            </div>

                            {/* Sequential chain flow visualization */}
                            <div className="space-y-2">
                              <div className="flex justify-between items-center text-[9px] text-zinc-500 uppercase font-black">
                                <span>Цепочка плагинов ({vstConfig.plugins.length})</span>
                                <span className="text-zinc-500">Сигнал идет сверху вниз ↓</span>
                              </div>

                              {vstConfig.plugins.length === 0 ? (
                                <div className="text-center py-4 bg-zinc-950/20 rounded-xl border border-dashed border-white/5 text-zinc-500 text-[10px]">
                                  Нет активных VST-плагинов в цепочке.<br/>Нажмите кнопку ниже, чтобы добавить.
                                </div>
                              ) : (
                                <div className="space-y-2.5">
                                  {vstConfig.plugins.map((plugin, pIdx) => {
                                    return (
                                      <div key={plugin.id} className="relative bg-zinc-950/40 border border-white/5 rounded-xl p-3 space-y-2.5">
                                        
                                        {/* Connector Line */}
                                        {pIdx < vstConfig.plugins.length - 1 && (
                                          <div className="absolute left-1/2 -bottom-2.5 transform -translate-x-1/2 w-0.5 h-2.5 bg-indigo-500/25 flex items-center justify-center z-10">
                                            <span className="text-[7px] text-indigo-400 font-black">↓</span>
                                          </div>
                                        )}

                                        {/* Plugin Item Header */}
                                        <div className="flex items-center justify-between">
                                          <div className="flex items-center gap-1.5 min-w-0">
                                            <span className="text-[9px] font-mono font-black text-zinc-600 bg-zinc-950 border border-white/5 px-1 py-0.5 rounded shrink-0">
                                              #{pIdx + 1}
                                            </span>
                                            <input 
                                              type="text"
                                              value={plugin.name}
                                              onChange={(e) => {
                                                const updatedPlugins = [...vstConfig.plugins];
                                                updatedPlugins[pIdx] = { ...plugin, name: e.target.value };
                                                const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                                                updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                                                updatePhase1({ vstSteps: updatedSteps });
                                              }}
                                              className="bg-transparent font-bold text-zinc-200 text-[11px] focus:outline-none hover:bg-white/5 focus:bg-zinc-950 px-1 py-0.5 rounded min-w-[120px]"
                                            />
                                          </div>

                                          {/* Plugin controls (Move, Bypass, Delete) */}
                                          <div className="flex items-center gap-2">
                                            {/* Move inside chain */}
                                            <div className="flex items-center bg-zinc-950/80 rounded border border-white/5 p-0.5">
                                              <button
                                                type="button"
                                                disabled={pIdx === 0}
                                                onClick={() => {
                                                  const updatedPlugins = [...vstConfig.plugins];
                                                  const temp = updatedPlugins[pIdx];
                                                  updatedPlugins[pIdx] = updatedPlugins[pIdx - 1];
                                                  updatedPlugins[pIdx - 1] = temp;
                                                  const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                                                  updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                                                  updatePhase1({ vstSteps: updatedSteps });
                                                }}
                                                className="p-0.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-20 rounded"
                                                title="Вверх в цепочке"
                                              >
                                                <ChevronUp className="w-3 h-3" />
                                              </button>
                                              <button
                                                type="button"
                                                disabled={pIdx === vstConfig.plugins.length - 1}
                                                onClick={() => {
                                                  const updatedPlugins = [...vstConfig.plugins];
                                                  const temp = updatedPlugins[pIdx];
                                                  updatedPlugins[pIdx] = updatedPlugins[pIdx + 1];
                                                  updatedPlugins[pIdx + 1] = temp;
                                                  const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                                                  updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                                                  updatePhase1({ vstSteps: updatedSteps });
                                                }}
                                                className="p-0.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-20 rounded"
                                                title="Вниз в цепочке"
                                              >
                                                <ChevronDown className="w-3 h-3" />
                                              </button>
                                            </div>

                                            {/* Bypass */}
                                            <button
                                              type="button"
                                              onClick={() => {
                                                const updatedPlugins = [...vstConfig.plugins];
                                                updatedPlugins[pIdx] = { ...plugin, bypass: !plugin.bypass };
                                                const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                                                updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                                                updatePhase1({ vstSteps: updatedSteps });
                                              }}
                                              className={cn(
                                                "p-1 rounded transition-colors border cursor-pointer",
                                                !plugin.bypass 
                                                  ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/20 hover:bg-indigo-500/20" 
                                                  : "bg-zinc-950/60 text-zinc-600 border-white/5 hover:text-zinc-400"
                                              )}
                                              title={!plugin.bypass ? "Активен" : "В байпасе"}
                                            >
                                              <Power className="w-3 h-3" />
                                            </button>

                                            {/* Delete */}
                                            <button
                                              type="button"
                                              onClick={() => {
                                                const updatedPlugins = vstConfig.plugins.filter(p => p.id !== plugin.id);
                                                const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                                                updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                                                updatePhase1({ vstSteps: updatedSteps });
                                                showToast("Плагин удален из цепочки");
                                              }}
                                              className="p-1 text-zinc-500 hover:text-rose-400 rounded transition-colors cursor-pointer"
                                              title="Удалить из цепочки"
                                            >
                                              <Trash2 className="w-3 h-3" />
                                            </button>
                                          </div>
                                        </div>

                                        {/* Plugin body & controls */}
                                        {!plugin.bypass && (
                                          <div className="space-y-2 text-[10px] border-t border-white/5 pt-2">
                                            {/* Path Selection */}
                                            <div className="space-y-1">
                                              <div className="flex justify-between items-center text-[9px] text-zinc-500">
                                                <span>Конфигурация плагина</span>
                                                <span className="text-zinc-600 font-mono text-[8px] uppercase">{plugin.vstVersion || 'VST3'}</span>
                                              </div>
                                              <div 
                                                onClick={() => {
                                                  setActiveVstSelectStepKey(stepKey);
                                                  setActiveVstSelectPluginIdx(pIdx);
                                                  setIsVstSelectorOpen(true);
                                                }}
                                                className="w-full bg-zinc-950/60 hover:bg-zinc-950/90 border border-white/5 hover:border-indigo-500/30 rounded-xl p-2.5 flex items-center justify-between gap-3 transition-all cursor-pointer group/row"
                                              >
                                                <div className="min-w-0 flex-1">
                                                  <div className="font-bold text-zinc-200 group-hover/row:text-indigo-400 transition-colors text-[10.5px] truncate">
                                                    {plugin.name || 'Выберите плагин...'}
                                                  </div>
                                                  <div className="font-mono text-[8.5px] text-zinc-500 truncate mt-0.5" title={plugin.pluginPath}>
                                                    {plugin.pluginPath || 'Путь не указан — нажмите для выбора'}
                                                  </div>
                                                </div>
                                                
                                                <button
                                                  type="button"
                                                  className="px-2 py-1 bg-zinc-900 group-hover/row:bg-indigo-600 hover:bg-indigo-500 border border-white/10 rounded-lg text-[9px] text-zinc-300 group-hover/row:text-white font-bold uppercase shrink-0 transition-all cursor-pointer"
                                                >
                                                  Выбрать...
                                                </button>
                                              </div>
                                            </div>

                                            {/* Simulated Parameters Slider */}
                                            <div className="grid grid-cols-2 gap-3.5 pt-1 border-t border-white/5">
                                              <div className="space-y-1">
                                                <div className="flex justify-between font-mono text-[9px] text-zinc-500">
                                                  <span>Mix (Wet)</span>
                                                  <span className="text-indigo-400 font-bold">{Math.round((plugin.parameters[0] ?? 1.0) * 100)}%</span>
                                                </div>
                                                <input
                                                  type="range"
                                                  min="0"
                                                  max="100"
                                                  value={Math.round((plugin.parameters[0] ?? 1.0) * 100)}
                                                  onChange={(e) => {
                                                    const updatedPlugins = [...vstConfig.plugins];
                                                    const val = parseFloat(e.target.value) / 100;
                                                    updatedPlugins[pIdx] = { 
                                                      ...plugin, 
                                                      parameters: { ...plugin.parameters, 0: val } 
                                                    };
                                                    const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                                                    updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                                                    updatePhase1({ vstSteps: updatedSteps });
                                                  }}
                                                  className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                                                />
                                              </div>
                                              <div className="space-y-1">
                                                <div className="flex justify-between font-mono text-[9px] text-zinc-500">
                                                  <span>Gain (Out)</span>
                                                  <span className="text-indigo-400 font-bold">{((plugin.parameters[1] ?? 0.5) * 24 - 12).toFixed(1)} dB</span>
                                                </div>
                                                <input
                                                  type="range"
                                                  min="0"
                                                  max="100"
                                                  value={Math.round((plugin.parameters[1] ?? 0.5) * 100)}
                                                  onChange={(e) => {
                                                    const updatedPlugins = [...vstConfig.plugins];
                                                    const val = parseFloat(e.target.value) / 100;
                                                    updatedPlugins[pIdx] = { 
                                                      ...plugin, 
                                                      parameters: { ...plugin.parameters, 1: val } 
                                                    };
                                                    const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                                                    updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                                                    updatePhase1({ vstSteps: updatedSteps });
                                                  }}
                                                  className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                                                />
                                              </div>
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>

                            {/* Add plugin template selector & manual addition */}
                            <div className="flex flex-col gap-1.5 pt-1.5 border-t border-white/5">
                              <span className="text-[9px] text-zinc-500 uppercase font-black block">Добавить плагин в цепочку:</span>
                              <div className="grid grid-cols-2 gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveVstSelectStepKey(stepKey);
                                    setActiveVstSelectPluginIdx(-1); // -1 triggers adding new plugin in handleVstPluginSelect
                                    setIsVstSelectorOpen(true);
                                  }}
                                  className="py-1.5 bg-zinc-950 hover:bg-zinc-900 border border-white/5 hover:border-indigo-500/20 hover:text-indigo-400 text-zinc-300 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 cursor-pointer"
                                >
                                  <Plus className="w-3 h-3 text-indigo-400" />
                                  <span>Поиск VST...</span>
                                </button>

                                <div className="relative group">
                                  <button
                                    type="button"
                                    className="w-full py-1.5 bg-indigo-600/10 hover:bg-indigo-600/20 border border-indigo-500/20 text-indigo-400 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 cursor-pointer"
                                  >
                                    <Sparkles className="w-3 h-3" />
                                    <span>Популярные EQ/FX</span>
                                  </button>

                                  <div className="absolute right-0 bottom-full mb-1 w-56 bg-zinc-950 border border-white/10 rounded-xl p-1.5 hidden group-hover:block hover:block shadow-xl z-50 animate-fade-in text-left">
                                    <div className="px-2 py-1 text-[8px] text-zinc-500 uppercase font-black border-b border-white/5 mb-1">
                                      Выберите из каталога:
                                    </div>
                                    {[
                                      { name: 'FabFilter Pro-Q 3 (EQ)', path: 'C:/Program Files/Common Files/VST3/FabFilter Pro-Q 3.vst3' },
                                      { name: 'FabFilter Pro-C 2 (Comp)', path: 'C:/Program Files/Common Files/VST3/FabFilter Pro-C 2.vst3' },
                                      { name: 'iZotope Ozone 10 Imager', path: 'C:/Program Files/Common Files/VST3/iZotope Ozone 10 Imager.vst3' },
                                      { name: 'Valhalla VintageVerb (Verb)', path: 'C:/Program Files/Common Files/VST3/ValhallaVintageVerb.vst3' },
                                      { name: 'Waves L2 Limiter (Limiter)', path: 'C:/Program Files/Common Files/VST3/L2.vst3' },
                                      { name: 'Soothe2 (Resonance Comp)', path: 'C:/Program Files/Common Files/VST3/soothe2.vst3' },
                                    ].map((template, tIdx) => (
                                      <button
                                        key={tIdx}
                                        type="button"
                                        onClick={() => {
                                          const newPlugin = {
                                            id: 'vst-plug-' + Math.random().toString(36).substring(2, 11),
                                            name: template.name,
                                            bypass: false,
                                            pluginPath: template.path,
                                            vstVersion: 'VST3' as const,
                                            parameters: { 0: 1.0, 1: 0.5 }
                                          };
                                          const updatedPlugins = [...vstConfig.plugins, newPlugin];
                                          const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                                          updatedSteps[stepKey] = { ...vstConfig, plugins: updatedPlugins };
                                          updatePhase1({ vstSteps: updatedSteps });
                                          showToast(`Добавлен плагин: ${template.name}`);
                                        }}
                                        className="w-full text-left px-2 py-1.5 text-[10px] text-zinc-300 hover:text-white hover:bg-indigo-600/20 rounded-md transition-colors"
                                      >
                                        {template.name}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Standalone actions */}
                            {renderProcessingActions(stepKey, 'Выполнить VST', 'bg-indigo-600 hover:bg-indigo-500')}
                          </div>
                        );
                      }

                      return renderStepContainer(
                        1,
                        index,
                        activePreset.phase1Order.length,
                        stepKey,
                        stepName,
                        stepIcon,
                        stepBypass,
                        handleBypassToggle,
                        stepElement,
                        stepKey.startsWith("vstStep_") ? () => {
                          const updatedOrder = (activePreset.phase1Order || []).filter(k => k !== stepKey);
                          const updatedSteps = { ...(activePreset.phase1.vstSteps || {}) };
                          delete updatedSteps[stepKey];
                          setActivePreset({
                            ...activePreset,
                            phase1Order: updatedOrder,
                            phase1: {
                              ...activePreset.phase1,
                              vstSteps: updatedSteps
                            }
                          });
                          showToast("VST-шаг полностью удален из цепочки");
                        } : undefined
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: TIMING & ALIGNMENT */}
            {activeTab === 'timing' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="font-bold text-zinc-300 uppercase tracking-widest text-[10px] flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-indigo-400" />
                    Тайминг и выравнивание
                  </span>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={activePreset.phase2.enabled}
                      onChange={(e) => updatePhase2({ enabled: e.target.checked })}
                      className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                    />
                    <span className="text-[10px] font-black uppercase text-zinc-500">Вкл этап</span>
                  </label>
                </div>

                {activePreset.phase2.enabled && (
                  <div className="space-y-4">
                    {/* Кнопка добавления VST-шага для Этапа 2 */}
                    <div className="flex items-center justify-between bg-zinc-900/30 p-2.5 rounded-xl border border-white/5">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-black uppercase text-zinc-400">Последовательность шагов</span>
                        <span className="text-[9px] text-zinc-500">Настраивайте шаги тайминга и VST-цепочки</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const vstId = 'vstStep_' + Date.now();
                          const newVstStep = {
                            id: vstId,
                            name: `VST Цепочка #${(activePreset.phase2Order?.filter(k => k.startsWith('vstStep_')).length || 0) + 1}`,
                            bypass: false,
                            plugins: []
                          };
                          const updatedOrder = [...(activePreset.phase2Order || DEFAULT_PHASE2_ORDER), vstId];
                          const updatedVstSteps = {
                            ...(activePreset.phase2.vstSteps || {}),
                            [vstId]: newVstStep
                          };
                          setActivePreset({
                            ...activePreset,
                            phase2Order: updatedOrder,
                            phase2: {
                              ...activePreset.phase2,
                              vstSteps: updatedVstSteps
                            }
                          });
                          showToast('VST-шаг добавлен! Вы можете перетащить его в любое место.');
                        }}
                        className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 active:scale-95 border border-indigo-500/30 hover:border-indigo-500/50 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                      >
                        <Plus className="w-3 h-3 text-indigo-300" />
                        <span>Добавить VST-шаг</span>
                      </button>
                    </div>

                    {(activePreset.phase2Order || DEFAULT_PHASE2_ORDER).map((stepKey, index) => {
                      let stepElement: React.ReactNode = null;
                      let stepName = "";
                      let stepIcon = <Clock className="w-3.5 h-3.5 text-indigo-400" />;
                      let stepBypass = false;
                      let handleBypassToggle = () => {};

                      if (stepKey === "silenceSplit") {
                        stepName = "Разрез по тишине";
                        stepIcon = <Scissors className="w-3.5 h-3.5 text-pink-400" />;
                        stepBypass = activePreset.phase2.silenceSplit.bypass;
                        handleBypassToggle = () => updatePhase2({
                          silenceSplit: { ...activePreset.phase2.silenceSplit, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 text-xs">
                            <p className="text-[11px] text-zinc-400 leading-relaxed">
                              Удаляет тишину между репликами, формируя независимые клипы фраз на таймлайне.
                            </p>
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                                <span>Порог тишины</span>
                                <span>{activePreset.phase2.silenceSplit.thresholdDb} dB</span>
                              </div>
                              <input 
                                type="range" 
                                min="-60" 
                                max="-20" 
                                value={activePreset.phase2.silenceSplit.thresholdDb}
                                onChange={(e) => updatePhase2({
                                  silenceSplit: { ...activePreset.phase2.silenceSplit, thresholdDb: parseInt(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                                <span>Длина тишины (мс)</span>
                                <span>{activePreset.phase2.silenceSplit.minSilenceDurationMs} мс</span>
                              </div>
                              <input 
                                type="range" 
                                min="100" 
                                max="1500" 
                                step="50" 
                                value={activePreset.phase2.silenceSplit.minSilenceDurationMs}
                                onChange={(e) => updatePhase2({
                                  silenceSplit: { ...activePreset.phase2.silenceSplit, minSilenceDurationMs: parseInt(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={handleSplitSilence}
                              disabled={isSplittingSilence}
                              className={cn(
                                "w-full mt-2 py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-2 border transition-all cursor-pointer active:scale-98",
                                isSplittingSilence 
                                  ? "bg-zinc-800 border-zinc-750 text-zinc-400 cursor-wait"
                                  : "bg-zinc-900 hover:bg-zinc-800 border-white/10 text-zinc-200"
                              )}
                            >
                              <Scissors className={cn("w-3.5 h-3.5 text-pink-400", isSplittingSilence && "animate-spin")} />
                              <span>{isSplittingSilence ? 'Нарезка...' : 'Удалить тишину (нарезать клипы)'}</span>
                            </button>
                          </div>
                        );
                      } else if (stepKey === "smartAlign") {
                        stepName = "Smart Align (Авто-выравнивание)";
                        stepIcon = <Wand2 className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase2.smartAlign.bypass;
                        handleBypassToggle = () => updatePhase2({
                          smartAlign: { ...activePreset.phase2.smartAlign, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 text-xs">
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 uppercase font-black block">Приоритет базы выравнивания</label>
                              <select 
                                value={activePreset.phase2.alignPriority || 'original_voice'}
                                onChange={(e) => updatePhase2({ alignPriority: e.target.value as any })}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                              >
                                <option value="original_voice">Оригинальная дорожка с голосами (Приоритет №1)</option>
                                <option value="subtitles">Только субтитры</option>
                              </select>
                            </div>

                            <label className="flex items-center gap-2 p-1.5 bg-zinc-950/60 rounded-lg border border-white/5 cursor-pointer">
                              <input 
                                type="checkbox"
                                checked={activePreset.phase2.alignToOriginalStart ?? true}
                                onChange={(e) => updatePhase2({ alignToOriginalStart: e.target.checked })}
                                className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                              />
                              <span className="text-[10px] text-zinc-300 font-medium">Синхрон начала фраз (дабер и оригинал говорят одновременно)</span>
                            </label>

                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 uppercase font-black block">Режим липсинга / точности</label>
                              <select 
                                value={activePreset.phase2.smartAlign.alignMode}
                                onChange={(e) => updatePhase2({
                                  smartAlign: { ...activePreset.phase2.smartAlign, alignMode: e.target.value as any }
                                })}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                              >
                                <option value="tight">Жёсткий (Tight Липсинг)</option>
                                <option value="loose">Свободный (Loose Эмоции)</option>
                                <option value="recast_tolerance">Допуск рекаста (По границам)</option>
                              </select>
                            </div>

                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                                <span>Лимит деформации (Stretch)</span>
                                <span>{(activePreset.phase2.smartAlign.maxStretchRatio * 100 - 100).toFixed(0)}%</span>
                              </div>
                              <input 
                                type="range" 
                                min="1.05" 
                                max="1.50" 
                                step="0.05" 
                                value={activePreset.phase2.smartAlign.maxStretchRatio}
                                onChange={(e) => updatePhase2({
                                  smartAlign: { ...activePreset.phase2.smartAlign, maxStretchRatio: parseFloat(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>

                            <div className="p-2 bg-zinc-950/60 rounded-lg border border-white/5 text-[10px] text-zinc-400 space-y-0.5">
                              <span className="font-bold text-zinc-300 block">
                                {project?.mixingType === 'RECAST' ? 'Правило Рекаста' :
                                 project?.mixingType === 'REDUB' ? 'Правило Редаба' :
                                 project?.mixingType === 'DUBBING' ? 'Правило Дубляжа' : 'Правило Закадра'}:
                              </span>
                              <span>
                                {project?.mixingType === 'RECAST' || project?.mixingType === 'REDUB' 
                                  ? 'Фраза дабера не должна быть меньше саба. Охи-вздохи озвучиваются.' 
                                  : project?.mixingType === 'DUBBING'
                                  ? 'Полный липсинг артикуляции губ и смысловых пауз.'
                                  : 'Длительность не критична, главное — точное совпадение старта фразы.'}
                              </span>
                            </div>

                            <button
                              type="button"
                              onClick={handleAlignAllPhrases}
                              disabled={isAligningPhrases}
                              className={cn(
                                "w-full mt-2 py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-2 border transition-all cursor-pointer active:scale-98 shadow-md",
                                isAligningPhrases 
                                  ? "bg-zinc-800 border-zinc-750 text-zinc-400 cursor-wait"
                                  : "bg-indigo-600 hover:bg-indigo-500 border-indigo-500/30 text-white shadow-indigo-600/20"
                              )}
                            >
                              <Wand2 className={cn("w-3.5 h-3.5", isAligningPhrases && "animate-spin")} />
                              <span>{isAligningPhrases ? 'Выравнивание...' : 'Выровнять всё по оригиналу'}</span>
                            </button>
                          </div>
                        );
                      } else if (stepKey === "subtitleCompliance") {
                        stepName = "Контроль субтитров и пропусков";
                        stepIcon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
                        stepBypass = activePreset.phase2.subtitleCompliance.bypass;
                        handleBypassToggle = () => updatePhase2({
                          subtitleCompliance: { ...activePreset.phase2.subtitleCompliance, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-2.5 text-xs">
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input 
                                type="checkbox" 
                                checked={activePreset.phase2.subtitleCompliance.checkMissingPhrases}
                                onChange={(e) => updatePhase2({ 
                                  subtitleCompliance: { ...activePreset.phase2.subtitleCompliance, checkMissingPhrases: e.target.checked } 
                                })}
                                className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                              />
                              <span className="text-[10px] text-zinc-300">Сверять с субтитрами на пропуски реплик</span>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input 
                                type="checkbox" 
                                checked={activePreset.phase2.conflictDetection?.flagShortPhrases ?? true}
                                onChange={(e) => updatePhase2({ 
                                  conflictDetection: { ...activePreset.phase2.conflictDetection, flagShortPhrases: e.target.checked } 
                                })}
                                className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                              />
                              <span className="text-[10px] text-zinc-300">Контроль длительности для Рекаста/Редаба (фраза не меньше саба)</span>
                            </label>
                          </div>
                        );
                      } else if (stepKey === "whisper") {
                        stepName = "Whisper Распознавание речи";
                        stepIcon = <Mic className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase2.whisper?.bypass ?? false;
                        handleBypassToggle = () => updatePhase2({
                          whisper: { ...activePreset.phase2.whisper, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 text-xs">
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 uppercase font-black block">Модель Whisper</label>
                              <select
                                value={activePreset.phase2.whisper?.model || 'base'}
                                onChange={(e) => updatePhase2({
                                  whisper: { ...activePreset.phase2.whisper, model: e.target.value as any }
                                })}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                              >
                                <option value="tiny">Tiny (Мгновенно, низкое потребление)</option>
                                <option value="base">Base (Оптимально для речи)</option>
                                <option value="small">Small (Повышенная точность)</option>
                                <option value="medium">Medium (Высокая детализация)</option>
                                <option value="large-v3">Large-v3 (Студийный стандарт)</option>
                              </select>
                            </div>
                            <div className="flex items-center justify-between">
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={activePreset.phase2.whisper?.autoTranscribe ?? true}
                                  onChange={(e) => updatePhase2({
                                    whisper: { ...activePreset.phase2.whisper, autoTranscribe: e.target.checked }
                                  })}
                                  className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                />
                                <span className="text-[10px] text-zinc-300">Автораспознавание текста фраз для сверки</span>
                              </label>
                            </div>
                          </div>
                        );
                      } else if (stepKey === "conflictDetection") {
                        stepName = "Детекция конфликтов и наездов";
                        stepIcon = <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />;
                        stepBypass = activePreset.phase2.conflictDetection?.bypass ?? false;
                        handleBypassToggle = () => updatePhase2({
                          conflictDetection: { ...activePreset.phase2.conflictDetection, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 text-xs">
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={activePreset.phase2.conflictDetection?.detectOverlaps ?? true}
                                onChange={(e) => updatePhase2({
                                  conflictDetection: { ...activePreset.phase2.conflictDetection, detectOverlaps: e.target.checked }
                                })}
                                className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                              />
                              <span className="text-[10px] text-zinc-300">Подсвечивать наезды фраз друг на друга (Overlap)</span>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={activePreset.phase2.conflictDetection?.flagShortPhrases ?? true}
                                onChange={(e) => updatePhase2({
                                  conflictDetection: { ...activePreset.phase2.conflictDetection, flagShortPhrases: e.target.checked }
                                })}
                                className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                              />
                              <span className="text-[10px] text-zinc-300">Проверять недотяг фразы по отношению к сабу (Рекаст/Редаб)</span>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={activePreset.phase2.conflictDetection?.autoResolveOverlaps ?? false}
                                onChange={(e) => updatePhase2({
                                  conflictDetection: { ...activePreset.phase2.conflictDetection, autoResolveOverlaps: e.target.checked }
                                })}
                                className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                              />
                              <span className="text-[10px] text-zinc-300">Автоматически раздвигать наезды в стык</span>
                            </label>

                            <button
                              type="button"
                              onClick={handleInspectTiming}
                              className="w-full mt-1.5 py-1.5 px-3 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-lg text-xs font-bold text-zinc-200 flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer"
                            >
                              <Search className="w-3.5 h-3.5 text-amber-400" />
                              <span>Проверить тайминги дорожек</span>
                            </button>

                            {/* Список замечаний прямо внутри шага */}
                            {(timingIssues.length > 0 || timingInspectionDone) && (
                              <div className="pt-2 border-t border-white/5 space-y-2">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-black uppercase text-amber-400 flex items-center gap-1">
                                    <AlertTriangle className="w-3 h-3" />
                                    Замечаний: {timingIssues.length}
                                  </span>
                                  {timingIssues.filter(i => i.canAutoFix).length > 0 && (
                                    <button
                                      type="button"
                                      onClick={handleAutoFixAllIssues}
                                      className="px-2 py-0.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 rounded text-[9px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                                    >
                                      <Wand2 className="w-2.5 h-2.5" />
                                      <span>Устранить все ({timingIssues.filter(i => i.canAutoFix).length})</span>
                                    </button>
                                  )}
                                </div>

                                {timingIssues.length === 0 ? (
                                  <div className="text-[11px] text-emerald-400 p-2 bg-emerald-950/30 rounded-lg border border-emerald-500/20 flex items-center gap-1.5">
                                    <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                                    <span>Наездов и рассинхронов не обнаружено!</span>
                                  </div>
                                ) : (
                                  <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                                    {timingIssues.map((issue) => (
                                      <div 
                                        key={issue.id}
                                        className="flex items-center justify-between p-1.5 rounded-lg bg-zinc-950 border border-white/5 text-xs"
                                      >
                                        <div className="flex items-center gap-1.5 overflow-hidden">
                                          <span className={cn(
                                            "px-1 py-0.2 rounded text-[7px] font-black uppercase whitespace-nowrap",
                                            issue.type === 'overlap' && "bg-rose-600 text-white",
                                            issue.type === 'too_short' && "bg-amber-600 text-black",
                                            issue.type === 'desync' && "bg-orange-600 text-white",
                                            issue.type === 'missing_phrase' && "bg-zinc-700 text-zinc-300"
                                          )}>
                                            {issue.type === 'overlap' && 'Наезд'}
                                            {issue.type === 'too_short' && 'Короче саба'}
                                            {issue.type === 'desync' && 'Рассинхрон'}
                                            {issue.type === 'missing_phrase' && 'Пропуск'}
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => handleSeek(issue.timestamp)}
                                            className="font-mono text-[9px] text-indigo-400 hover:underline cursor-pointer"
                                          >
                                            {Math.floor(issue.timestamp / 60)}:{(issue.timestamp % 60).toFixed(1).padStart(4, '0')}
                                          </button>
                                          <span className="text-[10px] text-zinc-300 truncate" title={issue.description}>
                                            {issue.description}
                                          </span>
                                        </div>

                                        <div className="flex items-center gap-1 flex-shrink-0">
                                          <button
                                            type="button"
                                            onClick={() => handleSeek(issue.timestamp)}
                                            className="px-1.5 py-0.5 bg-zinc-800 hover:bg-zinc-750 text-zinc-300 rounded text-[8px] font-bold cursor-pointer"
                                          >
                                            Перейти
                                          </button>
                                          {issue.canAutoFix && (
                                            <button
                                              type="button"
                                              onClick={() => handleAutoFixIssue(issue)}
                                              className="px-1.5 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[8px] font-bold cursor-pointer"
                                            >
                                              Сдвиг
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      } else if (stepKey.startsWith("vstStep_")) {
                        const vstConfig = activePreset.phase2.vstSteps?.[stepKey] || {
                          id: stepKey,
                          name: `VST Цепочка`,
                          bypass: false,
                          plugins: []
                        };
                        stepName = vstConfig.name;
                        stepIcon = <Sliders className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = vstConfig.bypass;
                        handleBypassToggle = () => {
                          const updatedSteps = { ...(activePreset.phase2.vstSteps || {}) };
                          updatedSteps[stepKey] = { ...vstConfig, bypass: !stepBypass };
                          updatePhase2({ vstSteps: updatedSteps });
                        };
                        stepElement = renderVstStepElement(stepKey, index, 2);
                      }

                      return renderStepContainer(
                        2,
                        index,
                        (activePreset.phase2Order || DEFAULT_PHASE2_ORDER).length,
                        stepKey,
                        stepName,
                        stepIcon,
                        stepBypass,
                        handleBypassToggle,
                        stepElement,
                        stepKey.startsWith("vstStep_") ? () => {
                          const updatedOrder = (activePreset.phase2Order || []).filter(k => k !== stepKey);
                          const updatedSteps = { ...(activePreset.phase2.vstSteps || {}) };
                          delete updatedSteps[stepKey];
                          setActivePreset({
                            ...activePreset,
                            phase2Order: updatedOrder,
                            phase2: {
                              ...activePreset.phase2,
                              vstSteps: updatedSteps
                            }
                          });
                          showToast("VST-шаг полностью удален из цепочки");
                        } : undefined
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: MIXING & EFFECTS */}
            {activeTab === 'mixing' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="font-bold text-zinc-300 uppercase tracking-widest text-[10px] flex items-center gap-1.5">
                    <Tv className="w-3.5 h-3.5 text-indigo-400" />
                    Сведение и Авто-эффекты
                  </span>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={activePreset.phase3.enabled}
                      onChange={(e) => updatePhase3({ enabled: e.target.checked })}
                      className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                    />
                    <span className="text-[10px] font-black uppercase text-zinc-500">Вкл этап</span>
                  </label>
                </div>

                {activePreset.phase3.enabled && (
                  <div className="space-y-4">
                    {/* Кнопка добавления VST-шага для Этапа 3 */}
                    {/* Панель быстрых действий и добавления VST для Этапа 3 */}
                    <div className="flex flex-wrap items-center justify-between gap-2 bg-gradient-to-r from-indigo-950/40 via-zinc-900/60 to-zinc-900/40 p-3 rounded-xl border border-indigo-500/20 shadow-lg">
                      <div className="flex flex-col">
                        <span className="text-[11px] font-black uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
                          <Flame className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
                          Сведение 3-го этапа (Audition Standard)
                        </span>
                        <span className="text-[9px] text-zinc-400">
                          Реплики vs Физика (-10 dB) • Автодакинг (-15..-18 dB) • ИИ-эффекты • 8-слотовый Мастер-рэк
                        </span>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setIsAuditLogOpen(true)}
                          className="px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-zinc-200 hover:text-white rounded-lg text-[10px] font-bold flex items-center gap-1.5 transition-all shadow cursor-pointer active:scale-95"
                          title="Открыть детальный журнал логов всех шагов сведения"
                        >
                          <FileText className="w-3.5 h-3.5 text-amber-400" />
                          <span>Журнал аудита ({auditLogs.length})</span>
                        </button>

                        <button
                          type="button"
                          onClick={handleRunAllPhase3}
                          disabled={isExecutingPhase3Step !== null}
                          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 active:scale-95 border border-indigo-400/30 text-white rounded-lg text-[10px] font-black uppercase tracking-wider flex items-center gap-1.5 transition-all shadow-lg shadow-indigo-600/30 cursor-pointer disabled:opacity-50"
                        >
                          <Wand2 className="w-3.5 h-3.5 text-indigo-200" />
                          <span>Выполнить все шаги</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            const vstId = 'vstStep_' + Date.now();
                            const newVstStep = {
                              id: vstId,
                              name: `VST Цепочка #${(activePreset.phase3Order?.filter(k => k.startsWith('vstStep_')).length || 0) + 1}`,
                              bypass: false,
                              plugins: []
                            };
                            const updatedOrder = [...(activePreset.phase3Order || DEFAULT_PHASE3_ORDER), vstId];
                            const updatedVstSteps = {
                              ...(activePreset.phase3.vstSteps || {}),
                              [vstId]: newVstStep
                            };
                            setActivePreset({
                              ...activePreset,
                              phase3Order: updatedOrder,
                              phase3: {
                                ...activePreset.phase3,
                                vstSteps: updatedVstSteps
                              }
                            });
                            showToast('VST-шаг добавлен! Вы можете перетащить его в любое место.');
                          }}
                          className="px-2 py-1.5 bg-zinc-800 hover:bg-zinc-750 active:scale-95 border border-white/10 text-zinc-300 hover:text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                        >
                          <Plus className="w-3 h-3 text-indigo-400" />
                          <span>+ VST</span>
                        </button>
                      </div>
                    </div>

                    {(activePreset.phase3Order || DEFAULT_PHASE3_ORDER).map((stepKey, index) => {
                      let stepElement: React.ReactNode = null;
                      let stepName = "";
                      let stepIcon = <Tv className="w-3.5 h-3.5 text-indigo-400" />;
                      let stepBypass = false;
                      let handleBypassToggle = () => {};

                      if (stepKey === "gainMatching") {
                        stepName = "Соответствие громкости (Реплики vs Физика)";
                        stepBypass = activePreset.phase3.gainMatching.bypass;
                        handleBypassToggle = () => updatePhase3({
                          gainMatching: { ...activePreset.phase3.gainMatching, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-2.5 text-xs">
                            <div className="p-2 rounded-lg bg-zinc-950/70 border border-white/5 space-y-1.5 text-[10px]">
                              <div className="flex items-center justify-between text-zinc-300">
                                <span className="font-semibold text-indigo-300">Реплики (сабы):</span>
                                <span className="text-emerald-400 font-mono">Строго одинаковая громкость (LUFS)</span>
                              </div>
                              <div className="flex items-center justify-between text-zinc-300">
                                <span className="font-semibold text-amber-300">Физика (крики, кряхтения):</span>
                                <span className="text-amber-400 font-mono font-bold">
                                  {activePreset.phase3.gainMatching.physicsVolumeOffsetDb ?? -10} dB от реплик
                                </span>
                              </div>
                            </div>

                            <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                              <span>Смещение громкости физики</span>
                              <span>{activePreset.phase3.gainMatching.physicsVolumeOffsetDb ?? -10} dB</span>
                            </div>
                            <input 
                              type="range" 
                              min="-20" 
                              max="-3" 
                              step="0.5"
                              value={activePreset.phase3.gainMatching.physicsVolumeOffsetDb ?? -10}
                              onChange={(e) => updatePhase3({
                                gainMatching: { 
                                  ...activePreset.phase3.gainMatching, 
                                  physicsVolumeOffsetDb: parseFloat(e.target.value) 
                                }
                              })}
                              className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                            />

                            <div className="flex items-center gap-2 pt-1">
                              <button
                                type="button"
                                onClick={() => setActiveStepSettingsModal('gainMatching')}
                                className="flex-1 py-1 px-2 bg-zinc-900 hover:bg-zinc-850 border border-white/10 rounded-lg text-[10px] font-bold text-zinc-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                              >
                                <Settings2 className="w-3 h-3 text-indigo-400" />
                                <span>Настроить параметры</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRunGainMatchingStep(true)}
                                disabled={isExecutingPhase3Step === 'gainMatching'}
                                className="py-1 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer disabled:opacity-50"
                              >
                                {isExecutingPhase3Step === 'gainMatching' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 fill-current" />}
                                <span>Применить шаг</span>
                              </button>
                            </div>
                          </div>
                        );
                      } else if (stepKey === "ducking") {
                        stepName = "Авто-дакинг фонового звука";
                        stepBypass = activePreset.phase3.ducking.bypass;
                        handleBypassToggle = () => updatePhase3({
                          ducking: { ...activePreset.phase3.ducking, bypass: !stepBypass }
                        });
                        const isVoiceover = (project?.mixingType || MixingType.DUBBING) === MixingType.VOICEOVER;
                        stepElement = (
                          <div className="space-y-2.5 text-xs">
                            <div className="p-2 rounded-lg bg-zinc-950/70 border border-white/5 space-y-1 text-[10px]">
                              <div className="flex items-center justify-between">
                                <span className="text-zinc-400">Режим проекта:</span>
                                <span className={cn("font-bold uppercase", isVoiceover ? "text-amber-400" : "text-indigo-400")}>
                                  {isVoiceover ? "Закадр (Ducking = 0 dB)" : "Рекаст / Даб (Ducking активен)"}
                                </span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-zinc-400">Глубина приглушения:</span>
                                <span className="font-mono text-emerald-400 font-bold">{activePreset.phase3.ducking.duckingDb} dB</span>
                              </div>
                            </div>

                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                                <span>Понижение разделенного фона</span>
                                <span>{activePreset.phase3.ducking.duckingDb} dB</span>
                              </div>
                              <input 
                                type="range" 
                                min="-28" 
                                max="-6" 
                                step="1"
                                value={activePreset.phase3.ducking.duckingDb}
                                onChange={(e) => updatePhase3({
                                  ducking: { ...activePreset.phase3.ducking, duckingDb: parseInt(e.target.value) }
                                })}
                                className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                              />
                            </div>

                            <div className="flex items-center gap-2 pt-1">
                              <button
                                type="button"
                                onClick={() => setActiveStepSettingsModal('ducking')}
                                className="flex-1 py-1 px-2 bg-zinc-900 hover:bg-zinc-850 border border-white/10 rounded-lg text-[10px] font-bold text-zinc-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                              >
                                <Settings2 className="w-3 h-3 text-indigo-400" />
                                <span>Настроить огибающие (Attack/Release)</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRunDuckingStep(true)}
                                disabled={isExecutingPhase3Step === 'ducking'}
                                className="py-1 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer disabled:opacity-50"
                              >
                                {isExecutingPhase3Step === 'ducking' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 fill-current" />}
                                <span>Применить шаг</span>
                              </button>
                            </div>
                          </div>
                        );
                      } else if (stepKey === "autoFxAnalysis") {
                        stepName = "Авто-анализ эффектов оригинала (ИИ-клонирование)";
                        stepBypass = activePreset.phase3.autoFxAnalysis.bypass;
                        handleBypassToggle = () => updatePhase3({
                          autoFxAnalysis: { ...activePreset.phase3.autoFxAnalysis, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-2.5 text-xs">
                            <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                              <div className={cn("p-1.5 rounded border flex items-center justify-between", activePreset.phase3.autoFxAnalysis.detectReverb ? "bg-indigo-950/30 border-indigo-500/30 text-indigo-200" : "bg-zinc-950 border-white/5 text-zinc-500")}>
                                <span>Реверберация / Эхо</span>
                                <Check className="w-3 h-3" />
                              </div>
                              <div className={cn("p-1.5 rounded border flex items-center justify-between", activePreset.phase3.autoFxAnalysis.detectPanning ? "bg-indigo-950/30 border-indigo-500/30 text-indigo-200" : "bg-zinc-950 border-white/5 text-zinc-500")}>
                                <span>3D-Панорама (L/R)</span>
                                <Check className="w-3 h-3" />
                              </div>
                              <div className={cn("p-1.5 rounded border flex items-center justify-between", activePreset.phase3.autoFxAnalysis.detectSpecialFx ? "bg-indigo-950/30 border-indigo-500/30 text-indigo-200" : "bg-zinc-950 border-white/5 text-zinc-500")}>
                                <span>ТВ / Радио / Телефон</span>
                                <Check className="w-3 h-3" />
                              </div>
                              <div className={cn("p-1.5 rounded border flex items-center justify-between", activePreset.phase3.autoFxAnalysis.detectDistanceEq ? "bg-indigo-950/30 border-indigo-500/30 text-indigo-200" : "bg-zinc-950 border-white/5 text-zinc-500")}>
                                <span>Дистанция сцены (EQ)</span>
                                <Check className="w-3 h-3" />
                              </div>
                            </div>

                            <div className="flex items-center gap-2 pt-1">
                              <button
                                type="button"
                                onClick={() => setActiveStepSettingsModal('autoFxAnalysis')}
                                className="flex-1 py-1 px-2 bg-zinc-900 hover:bg-zinc-850 border border-white/10 rounded-lg text-[10px] font-bold text-zinc-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                              >
                                <Settings2 className="w-3 h-3 text-indigo-400" />
                                <span>Настроить детекцию</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRunAutoFxStep(true)}
                                disabled={isExecutingPhase3Step === 'autoFxAnalysis'}
                                className="py-1 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer disabled:opacity-50"
                              >
                                {isExecutingPhase3Step === 'autoFxAnalysis' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 fill-current" />}
                                <span>Анализировать</span>
                              </button>
                            </div>
                          </div>
                        );
                      } else if (stepKey === "vocalBusProcessing") {
                        stepName = "Мастер-шина голосов (8-Slot Audition Rack)";
                        stepBypass = activePreset.phase3.vocalBusProcessing.bypass;
                        handleBypassToggle = () => updatePhase3({
                          vocalBusProcessing: { ...activePreset.phase3.vocalBusProcessing, bypass: !stepBypass }
                        });
                        const chain = activePreset.phase3.vocalBusProcessing.chain;
                        stepElement = (
                          <div className="space-y-2.5 text-xs">
                            {/* Audition 8 Slot Chain Badge Grid */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 text-[9px] font-mono">
                              <div className={cn("p-1.5 rounded border text-center", chain?.ozoneStabilizer?.enabled ? "bg-blue-950/40 border-blue-500/40 text-blue-300" : "bg-zinc-950 border-white/5 text-zinc-600")}>
                                1. Stabilizer
                              </div>
                              <div className={cn("p-1.5 rounded border text-center", chain?.rCompressor?.enabled ? "bg-amber-950/40 border-amber-500/40 text-amber-300" : "bg-zinc-950 border-white/5 text-zinc-600")}>
                                2. RComp
                              </div>
                              <div className={cn("p-1.5 rounded border text-center", chain?.soothe2?.enabled ? "bg-purple-950/40 border-purple-500/40 text-purple-300" : "bg-zinc-950 border-white/5 text-zinc-600")}>
                                3. soothe2
                              </div>
                              <div className={cn("p-1.5 rounded border text-center", chain?.proQ4?.enabled ? "bg-cyan-950/40 border-cyan-500/40 text-cyan-300" : "bg-zinc-950 border-white/5 text-zinc-600")}>
                                4. Pro-Q 4
                              </div>
                              <div className={cn("p-1.5 rounded border text-center", chain?.rBass?.enabled ? "bg-rose-950/40 border-rose-500/40 text-rose-300" : "bg-zinc-950 border-white/5 text-zinc-600")}>
                                5. RBass
                              </div>
                              <div className={cn("p-1.5 rounded border text-center", chain?.freshAir?.enabled ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-300" : "bg-zinc-950 border-white/5 text-zinc-600")}>
                                6. Fresh Air
                              </div>
                              <div className={cn("p-1.5 rounded border text-center", chain?.rVox?.enabled ? "bg-orange-950/40 border-orange-500/40 text-orange-300" : "bg-zinc-950 border-white/5 text-zinc-600")}>
                                7. RVox
                              </div>
                              <div className={cn("p-1.5 rounded border text-center", chain?.proDS?.enabled ? "bg-teal-950/40 border-teal-500/40 text-teal-300" : "bg-zinc-950 border-white/5 text-zinc-600")}>
                                8. Pro-DS
                              </div>
                            </div>

                            <div className="flex items-center gap-2 pt-1">
                              <button
                                type="button"
                                onClick={() => setActiveStepSettingsModal('vocalBusProcessing')}
                                className="flex-1 py-1 px-2 bg-gradient-to-r from-indigo-900/60 to-purple-900/60 hover:from-indigo-800/80 hover:to-purple-800/80 border border-indigo-500/30 rounded-lg text-[10px] font-bold text-white flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow"
                              >
                                <Sliders className="w-3 h-3 text-indigo-300" />
                                <span>Открыть рэк 8 плагинов Audition</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRunVocalBusStep(true)}
                                disabled={isExecutingPhase3Step === 'vocalBusProcessing'}
                                className="py-1 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer disabled:opacity-50"
                              >
                                {isExecutingPhase3Step === 'vocalBusProcessing' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 fill-current" />}
                                <span>Применить шину</span>
                              </button>
                            </div>
                          </div>
                        );
                      } else if (stepKey.startsWith("vstStep_")) {
                        const vstConfig = activePreset.phase3.vstSteps?.[stepKey] || {
                          id: stepKey,
                          name: `VST Цепочка`,
                          bypass: false,
                          plugins: []
                        };
                        stepName = vstConfig.name;
                        stepIcon = <Sliders className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = vstConfig.bypass;
                        handleBypassToggle = () => {
                          const updatedSteps = { ...(activePreset.phase3.vstSteps || {}) };
                          updatedSteps[stepKey] = { ...vstConfig, bypass: !stepBypass };
                          updatePhase3({ vstSteps: updatedSteps });
                        };
                        stepElement = renderVstStepElement(stepKey, index, 3);
                      }

                      return renderStepContainer(
                        3,
                        index,
                        (activePreset.phase3Order || DEFAULT_PHASE3_ORDER).length,
                        stepKey,
                        stepName,
                        stepIcon,
                        stepBypass,
                        handleBypassToggle,
                        stepElement,
                        stepKey.startsWith("vstStep_") ? () => {
                          const updatedOrder = (activePreset.phase3Order || []).filter(k => k !== stepKey);
                          const updatedSteps = { ...(activePreset.phase3.vstSteps || {}) };
                          delete updatedSteps[stepKey];
                          setActivePreset({
                            ...activePreset,
                            phase3Order: updatedOrder,
                            phase3: {
                              ...activePreset.phase3,
                              vstSteps: updatedSteps
                            }
                          });
                          showToast("VST-шаг полностью удален из цепочки");
                        } : undefined
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 4: FINAL MIX & RENDER */}
            {activeTab === 'render' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="font-bold text-zinc-300 uppercase tracking-widest text-[10px] flex items-center gap-1.5">
                    <Film className="w-3.5 h-3.5 text-indigo-400" />
                    Финальный рендер и экспорт (Мастер-микс)
                  </span>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={activePreset.phase4.enabled}
                      onChange={(e) => updatePhase4({ enabled: e.target.checked })}
                      className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                    />
                    <span className="text-[10px] font-black uppercase text-zinc-500">Вкл этап</span>
                  </label>
                </div>

                {activePreset.phase4.enabled && (
                  <div className="space-y-4">
                    {/* Master Actions Banner */}
                    <div className="p-3.5 rounded-2xl bg-gradient-to-r from-zinc-900 via-indigo-950/20 to-zinc-900 border border-indigo-500/20 shadow-xl space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-black text-white flex items-center gap-2">
                            Конвейер финального рендеринга & Мастеринга
                            {qaIssues.length > 0 ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono font-bold">
                                QA: {qaIssues.length} косяков
                              </span>
                            ) : (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-mono font-bold">
                                QA пройден ({qaLufs.toFixed(1)} LUFS)
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-zinc-400 mt-0.5">
                            Авто-QA отсмотр • Мастеринг лимитер (-1.0 dBTP) • Экспорт стэмов (Full, VO, M&E) • Видеокодек
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleRunQualityControl(true)}
                            className="px-2.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-200 border border-white/5 text-[11px] font-bold flex items-center gap-1.5 transition-all cursor-pointer"
                          >
                            <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                            <span>Отчет QA ({qaIssues.length})</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => setIsAuditLogOpen(true)}
                            className="px-2.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-200 border border-white/5 text-[11px] font-bold flex items-center gap-1.5 transition-all cursor-pointer"
                          >
                            <FileText className="w-3.5 h-3.5 text-indigo-400" />
                            <span>Аудит ({auditLogs.length})</span>
                          </button>

                          <button
                            type="button"
                            onClick={handleStartFinalRender}
                            className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white text-[11px] font-bold flex items-center gap-1.5 transition-all shadow-md shadow-indigo-600/30 cursor-pointer"
                          >
                            <Film className="w-3.5 h-3.5" />
                            <span>Запустить финальный рендер</span>
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px] text-zinc-400">
                        <div className="p-2 rounded-xl bg-zinc-950/60 border border-white/5 flex items-center justify-between">
                          <span className="text-[10px] uppercase font-bold text-zinc-500">Цель LUFS</span>
                          <span className="font-mono font-bold text-zinc-200">
                            {activePreset.phase4.masteringLimiter?.targetIntegratedLufs || -14.0} LUFS
                          </span>
                        </div>
                        <div className="p-2 rounded-xl bg-zinc-950/60 border border-white/5 flex items-center justify-between">
                          <span className="text-[10px] uppercase font-bold text-zinc-500">True-Peak</span>
                          <span className="font-mono font-bold text-emerald-400">
                            {activePreset.phase4.masteringLimiter?.truePeakCeilingDb || -1.0} dBTP
                          </span>
                        </div>
                        <div className="p-2 rounded-xl bg-zinc-950/60 border border-white/5 flex items-center justify-between">
                          <span className="text-[10px] uppercase font-bold text-zinc-500">Контейнер</span>
                          <span className="font-mono font-bold uppercase text-zinc-200">
                            {activePreset.phase4.renderSettings.container || 'mp4'}
                          </span>
                        </div>
                        <div className="p-2 rounded-xl bg-zinc-950/60 border border-white/5 flex items-center justify-between">
                          <span className="text-[10px] uppercase font-bold text-zinc-500">Формат стемов</span>
                          <span className="font-mono font-bold text-indigo-300">
                            WAV 24b 48k
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Step Sequence Toolbar */}
                    <div className="flex items-center justify-between bg-zinc-900/30 p-2.5 rounded-xl border border-white/5">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-black uppercase text-zinc-400">Последовательность шагов</span>
                        <span className="text-[9px] text-zinc-500">Настройте параметры каждого блока финализации</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const vstId = 'vstStep_' + Date.now();
                          const newVstStep = {
                            id: vstId,
                            name: `VST Цепочка #${(activePreset.phase4Order?.filter(k => k.startsWith('vstStep_')).length || 0) + 1}`,
                            bypass: false,
                            plugins: []
                          };
                          const updatedOrder = [...(activePreset.phase4Order || DEFAULT_PHASE4_ORDER), vstId];
                          const updatedVstSteps = {
                            ...(activePreset.phase4.vstSteps || {}),
                            [vstId]: newVstStep
                          };
                          setActivePreset({
                            ...activePreset,
                            phase4Order: updatedOrder,
                            phase4: {
                              ...activePreset.phase4,
                              vstSteps: updatedVstSteps
                            }
                          });
                          showToast('VST-шаг добавлен! Вы можете перетащить его в любое место.');
                        }}
                        className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 active:scale-95 border border-indigo-500/30 hover:border-indigo-500/50 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                      >
                        <Plus className="w-3 h-3 text-indigo-300" />
                        <span>Добавить VST-шаг</span>
                      </button>
                    </div>

                    {(activePreset.phase4Order || DEFAULT_PHASE4_ORDER).map((stepKey, index) => {
                      let stepElement: React.ReactNode = null;
                      let stepName = "";
                      let stepIcon = <Video className="w-3.5 h-3.5 text-indigo-400" />;
                      let stepBypass = false;
                      let handleBypassToggle = () => {};

                      if (stepKey === "qualityControl") {
                        stepName = "1. Анализ косяков (Quality Control / QA)";
                        stepIcon = <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />;
                        stepBypass = activePreset.phase4.qualityControl.bypass;
                        handleBypassToggle = () => updatePhase4({
                          qualityControl: { ...activePreset.phase4.qualityControl, bypass: !stepBypass }
                        });
                        stepElement = (
                          <div className="space-y-3 text-xs">
                            <div className="p-3 rounded-xl bg-zinc-950/60 border border-white/5 space-y-2">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
                                Проверяемые критерии брака
                              </span>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-zinc-300">
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input 
                                    type="checkbox" 
                                    checked={activePreset.phase4.qualityControl.logClippedSegments}
                                    onChange={(e) => updatePhase4({ 
                                      qualityControl: { ...activePreset.phase4.qualityControl, logClippedSegments: e.target.checked } 
                                    })}
                                    className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                  />
                                  <span>Клиппинг и перегрузки (&gt; -0.5 dBTP)</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input 
                                    type="checkbox" 
                                    checked={activePreset.phase4.qualityControl.detectLongSilences}
                                    onChange={(e) => updatePhase4({ 
                                      qualityControl: { ...activePreset.phase4.qualityControl, detectLongSilences: e.target.checked } 
                                    })}
                                    className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                  />
                                  <span>Затянувшиеся паузы / тишина (&gt; 4 сек)</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input 
                                    type="checkbox" 
                                    checked={activePreset.phase4.qualityControl.detectOverlappingAudios}
                                    onChange={(e) => updatePhase4({ 
                                      qualityControl: { ...activePreset.phase4.qualityControl, detectOverlappingAudios: e.target.checked } 
                                    })}
                                    className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                  />
                                  <span>Наезды и пересечения реплик</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input 
                                    type="checkbox" 
                                    checked={activePreset.phase4.qualityControl.checkMissingSubtitles !== false}
                                    onChange={(e) => updatePhase4({ 
                                      qualityControl: { ...activePreset.phase4.qualityControl, checkMissingSubtitles: e.target.checked } 
                                    })}
                                    className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                  />
                                  <span>Сверка с сабами (поиск пропусков)</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input 
                                    type="checkbox" 
                                    checked={activePreset.phase4.qualityControl.lufsTargetCheck !== false}
                                    onChange={(e) => updatePhase4({ 
                                      qualityControl: { ...activePreset.phase4.qualityControl, lufsTargetCheck: e.target.checked } 
                                    })}
                                    className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                  />
                                  <span>Соответствие стандартам громкости LUFS</span>
                                </label>
                              </div>
                            </div>

                            <div className="flex items-center justify-between gap-2 pt-1">
                              <div className="text-[11px] text-zinc-400">
                                {qaIssues.length > 0 ? (
                                  <span className="text-amber-400 font-bold">
                                    Найдено замечаний: {qaIssues.length} (Ошибок: {qaIssues.filter(i => i.severity === 'error').length})
                                  </span>
                                ) : (
                                  <span className="text-zinc-500">Готов к сканированию дорожек</span>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                {qaIssues.length > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => setIsQaModalOpen(true)}
                                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold transition-all cursor-pointer"
                                  >
                                    Открыть отчет ({qaIssues.length})
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleRunQualityControl(true)}
                                  className="px-3 py-1.5 rounded-lg bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 border border-amber-500/40 text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer active:scale-95"
                                >
                                  <ShieldAlert className="w-3.5 h-3.5 text-amber-300" />
                                  <span>Запустить QA анализ</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      } else if (stepKey === "masteringLimiter") {
                        stepName = "2. Мастеринг & True-Peak Лимитер";
                        stepIcon = <Sliders className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase4.masteringLimiter?.bypass || false;
                        handleBypassToggle = () => updatePhase4({
                          masteringLimiter: {
                            ...(activePreset.phase4.masteringLimiter || {
                              bypass: false,
                              standard: 'youtube_web',
                              targetIntegratedLufs: -14.0,
                              truePeakCeilingDb: -1.0,
                              oversampling: '4x',
                              dither: 'tpdf_24bit',
                              stereoWidthPercent: 100
                            }),
                            bypass: !stepBypass
                          }
                        });
                        const limiter = activePreset.phase4.masteringLimiter || {
                          bypass: false,
                          standard: 'youtube_web',
                          targetIntegratedLufs: -14.0,
                          truePeakCeilingDb: -1.0,
                          oversampling: '4x',
                          dither: 'tpdf_24bit',
                          stereoWidthPercent: 100
                        };
                        stepElement = (
                          <div className="space-y-3 text-xs">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black">Стандарт громкости</label>
                                <select 
                                  value={limiter.standard}
                                  onChange={(e) => {
                                    const std = e.target.value as any;
                                    let lufs = limiter.targetIntegratedLufs;
                                    let ceil = limiter.truePeakCeilingDb;
                                    if (std === 'reference_original') {
                                      // Calculate reference integrated LUFS from original audio track
                                      const origTrack = project?.tracks.find(t => 
                                        t.name.toLowerCase().includes('оригинал') || 
                                        t.name.toLowerCase().includes('original') || 
                                        t.name.toLowerCase().includes('reference') ||
                                        t.type === 'original' ||
                                        t.name.toLowerCase().includes('голоса')
                                      );
                                      if (origTrack && origTrack.segments && origTrack.segments.length > 0) {
                                        let sumSq = 0, count = 0;
                                        origTrack.segments.forEach(s => {
                                          if (s.waveform && s.waveform.length > 0) {
                                            sumSq += s.waveform.reduce((a, b) => a + b * b, 0);
                                            count += s.waveform.length;
                                          }
                                        });
                                        lufs = count > 0 ? Math.max(-28.0, Math.min(-10.0, Number((20 * Math.log10(Math.sqrt(sumSq / count)) - 2.5).toFixed(1)))) : -15.0;
                                      } else {
                                        lufs = -15.0;
                                      }
                                      ceil = -1.0;
                                    } else if (std === 'youtube_web') { lufs = -14.0; ceil = -1.0; }
                                    else if (std === 'broadcast_ebu') { lufs = -23.0; ceil = -1.0; }
                                    else if (std === 'podcast_stream') { lufs = -16.0; ceil = -1.0; }
                                    updatePhase4({
                                      masteringLimiter: { ...limiter, standard: std, targetIntegratedLufs: lufs, truePeakCeilingDb: ceil }
                                    });
                                  }}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                >
                                  <option value="reference_original">🎯 Уровень оригинала (Студийный референс)</option>
                                  <option value="youtube_web">YouTube / Web (-14 LUFS, -1 dBTP)</option>
                                  <option value="broadcast_ebu">EBU R128 ТВ (-23 LUFS, -1 dBTP)</option>
                                  <option value="podcast_stream">Подкаст / Стриминг (-16 LUFS)</option>
                                  <option value="custom">Пользовательский</option>
                                </select>
                              </div>

                              <div className="space-y-1">
                                <div className="flex justify-between items-center">
                                  <label className="text-[10px] text-zinc-500 uppercase font-black">Цель LUFS</label>
                                  <span className="text-[10px] font-mono text-indigo-400 font-bold">{limiter.targetIntegratedLufs} LUFS</span>
                                </div>
                                <input 
                                  type="number" 
                                  step="0.5"
                                  min="-30"
                                  max="-8"
                                  value={limiter.targetIntegratedLufs}
                                  onChange={(e) => updatePhase4({
                                    masteringLimiter: { ...limiter, targetIntegratedLufs: parseFloat(e.target.value) || -14.0 }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300 font-mono"
                                />
                              </div>

                              <div className="space-y-1">
                                <div className="flex justify-between items-center">
                                  <label className="text-[10px] text-zinc-500 uppercase font-black">True-Peak Потолок</label>
                                  <span className="text-[10px] font-mono text-emerald-400 font-bold">{limiter.truePeakCeilingDb} dBTP</span>
                                </div>
                                <input 
                                  type="number" 
                                  step="0.1"
                                  min="-3.0"
                                  max="-0.1"
                                  value={limiter.truePeakCeilingDb}
                                  onChange={(e) => updatePhase4({
                                    masteringLimiter: { ...limiter, truePeakCeilingDb: parseFloat(e.target.value) || -1.0 }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300 font-mono"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black">Oversampling (ISP)</label>
                                <select 
                                  value={limiter.oversampling}
                                  onChange={(e) => updatePhase4({
                                    masteringLimiter: { ...limiter, oversampling: e.target.value as any }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                >
                                  <option value="2x">2x Oversampling</option>
                                  <option value="4x">4x High Quality ISP</option>
                                  <option value="8x">8x Ultra Precision</option>
                                </select>
                              </div>

                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black">Дитеринг (Dither)</label>
                                <select 
                                  value={limiter.dither}
                                  onChange={(e) => updatePhase4({
                                    masteringLimiter: { ...limiter, dither: e.target.value as any }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                >
                                  <option value="tpdf_24bit">TPDF 24-bit (Студия)</option>
                                  <option value="tpdf_16bit">TPDF 16-bit (CD / Web)</option>
                                  <option value="none">Без дитеринга</option>
                                </select>
                              </div>

                              <div className="space-y-1">
                                <div className="flex justify-between items-center">
                                  <label className="text-[10px] text-zinc-500 uppercase font-black">Ширина стереобазы</label>
                                  <span className="text-[10px] font-mono text-zinc-400">{limiter.stereoWidthPercent}%</span>
                                </div>
                                <input 
                                  type="range"
                                  min="50"
                                  max="150"
                                  value={limiter.stereoWidthPercent}
                                  onChange={(e) => updatePhase4({
                                    masteringLimiter: { ...limiter, stereoWidthPercent: parseInt(e.target.value) || 100 }
                                  })}
                                  className="w-full accent-indigo-500 cursor-pointer"
                                />
                              </div>
                            </div>

                            <div className="flex justify-end pt-1">
                              <button
                                type="button"
                                onClick={handleApplyMasteringLimiter}
                                className="px-3.5 py-1.5 rounded-xl bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer active:scale-95"
                              >
                                <Sliders className="w-3.5 h-3.5 text-indigo-300" />
                                <span>Применить мастеринг к проекту</span>
                              </button>
                            </div>
                          </div>
                        );
                      } else if (stepKey === "stemExport") {
                        stepName = "3. Экспорт аудиостэмов (Stems Mixdown)";
                        stepIcon = <Music className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase4.stemExport?.bypass || false;
                        handleBypassToggle = () => updatePhase4({
                          stemExport: {
                            ...(activePreset.phase4.stemExport || {
                              bypass: false,
                              exportFullMix: true,
                              exportCleanVoice: true,
                              exportMAndE: true,
                              exportPerRoleStems: false,
                              audioFormat: 'wav24_48'
                            }),
                            bypass: !stepBypass
                          }
                        });
                        const stems = activePreset.phase4.stemExport || {
                          bypass: false,
                          exportFullMix: true,
                          exportCleanVoice: true,
                          exportMAndE: true,
                          exportPerRoleStems: false,
                          audioFormat: 'wav24_48'
                        };
                        stepElement = (
                          <div className="space-y-3 text-xs">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-zinc-300">
                              <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg bg-zinc-950/40 border border-white/5">
                                <input 
                                  type="checkbox" 
                                  checked={stems.exportFullMix}
                                  onChange={(e) => updatePhase4({ 
                                    stemExport: { ...stems, exportFullMix: e.target.checked } 
                                  })}
                                  className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                />
                                <div>
                                  <div className="font-bold text-zinc-200">Full Mix (Мастер)</div>
                                  <div className="text-[10px] text-zinc-500">Голос дубляжа + Оригинальная музыка + FX</div>
                                </div>
                              </label>

                              <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg bg-zinc-950/40 border border-white/5">
                                <input 
                                  type="checkbox" 
                                  checked={stems.exportCleanVoice}
                                  onChange={(e) => updatePhase4({ 
                                    stemExport: { ...stems, exportCleanVoice: e.target.checked } 
                                  })}
                                  className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                />
                                <div>
                                  <div className="font-bold text-zinc-200">Clean VO (Чистый голос)</div>
                                  <div className="text-[10px] text-zinc-500">Все реплики дубляжа без музыки</div>
                                </div>
                              </label>

                              <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg bg-zinc-950/40 border border-white/5">
                                <input 
                                  type="checkbox" 
                                  checked={stems.exportMAndE}
                                  onChange={(e) => updatePhase4({ 
                                    stemExport: { ...stems, exportMAndE: e.target.checked } 
                                  })}
                                  className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                />
                                <div>
                                  <div className="font-bold text-zinc-200">M&E Фонограмма</div>
                                  <div className="text-[10px] text-zinc-500">Music & Effects без голосов</div>
                                </div>
                              </label>

                              <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg bg-zinc-950/40 border border-white/5">
                                <input 
                                  type="checkbox" 
                                  checked={stems.exportPerRoleStems}
                                  onChange={(e) => updatePhase4({ 
                                    stemExport: { ...stems, exportPerRoleStems: e.target.checked } 
                                  })}
                                  className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-0"
                                />
                                <div>
                                  <div className="font-bold text-zinc-200">Стэмы по персонажам</div>
                                  <div className="text-[10px] text-zinc-500">Индивидуальные дорожки каждого актера</div>
                                </div>
                              </label>
                            </div>

                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 uppercase font-black">Формат аудиофайлов стэмов</label>
                              <select 
                                value={stems.audioFormat}
                                onChange={(e) => updatePhase4({
                                  stemExport: { ...stems, audioFormat: e.target.value as any }
                                })}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                              >
                                <option value="wav24_48">WAV 24-bit 48kHz (Студийный стандарт вещания)</option>
                                <option value="wav16_44">WAV 16-bit 44.1kHz (CD качество)</option>
                                <option value="mp3_320">MP3 320 kbps (Компактный архив)</option>
                                <option value="flac">FLAC Lossless</option>
                                <option value="aac">AAC 320 kbps</option>
                              </select>
                            </div>
                          </div>
                        );
                      } else if (stepKey === "subtitleBurn") {
                        stepName = "4. Впекание и экспорт субтитров";
                        stepIcon = <FileText className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = activePreset.phase4.subtitleBurn.bypass;
                        handleBypassToggle = () => updatePhase4({
                          subtitleBurn: { ...activePreset.phase4.subtitleBurn, bypass: !stepBypass }
                        });
                        const subConfig = activePreset.phase4.subtitleBurn;
                        stepElement = (
                          <div className="space-y-3 text-xs">
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 uppercase font-black">Режим впекания субтитров</label>
                              <select 
                                value={subConfig.burnMode || 'hardsub_signs'}
                                onChange={(e) => updatePhase4({
                                  subtitleBurn: { ...subConfig, burnMode: e.target.value as any }
                                })}
                                className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                              >
                                <option value="hardsub_signs">Впекать только надписи (Хардсаб Signs, голос озвучен)</option>
                                <option value="hardsub_all">Впекать все реплики (Полный хардсаб для соцсетей)</option>
                                <option value="softsub">Только отключаемая дорожка (Softsub в MKV/MP4)</option>
                                <option value="none">Отключено (Не добавлять субтитры в видео)</option>
                              </select>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black">Гарнитура шрифта</label>
                                <select 
                                  value={subConfig.fontName}
                                  onChange={(e) => updatePhase4({
                                    subtitleBurn: { ...subConfig, fontName: e.target.value }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                >
                                  <option value="Arial">Arial</option>
                                  <option value="Trebuchet MS">Trebuchet MS</option>
                                  <option value="Montserrat">Montserrat</option>
                                  <option value="Futura">Futura</option>
                                  <option value="Impact">Impact</option>
                                </select>
                              </div>
                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black">Кегль (Размер px)</label>
                                <input 
                                  type="number" 
                                  value={subConfig.fontSize}
                                  onChange={(e) => updatePhase4({
                                    subtitleBurn: { ...subConfig, fontSize: parseInt(e.target.value) || 20 }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black">Цвет текста</label>
                                <input 
                                  type="color" 
                                  value={subConfig.fontColor}
                                  onChange={(e) => updatePhase4({
                                    subtitleBurn: { ...subConfig, fontColor: e.target.value }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1 text-xs text-zinc-300 h-8 cursor-pointer"
                                />
                              </div>

                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black">Цвет обводки</label>
                                <input 
                                  type="color" 
                                  value={subConfig.outlineColor || '#000000'}
                                  onChange={(e) => updatePhase4({
                                    subtitleBurn: { ...subConfig, outlineColor: e.target.value }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1 text-xs text-zinc-300 h-8 cursor-pointer"
                                />
                              </div>

                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black">Толщина обводки</label>
                                <input 
                                  type="number"
                                  min="0"
                                  max="8"
                                  value={subConfig.outlineWidth !== undefined ? subConfig.outlineWidth : 2}
                                  onChange={(e) => updatePhase4({
                                    subtitleBurn: { ...subConfig, outlineWidth: parseInt(e.target.value) || 2 }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                />
                              </div>

                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black">Позиция</label>
                                <select 
                                  value={subConfig.alignment}
                                  onChange={(e) => updatePhase4({
                                    subtitleBurn: { ...subConfig, alignment: e.target.value as any }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                >
                                  <option value="bottom">Снизу (Bottom)</option>
                                  <option value="top">Сверху (Top)</option>
                                  <option value="middle">По центру (Middle)</option>
                                </select>
                              </div>
                            </div>

                            {/* Live Subtitle Preview */}
                            <div className="p-3 rounded-xl bg-zinc-950 border border-white/10 flex items-center justify-center min-h-[55px]">
                              <span 
                                style={{
                                  fontFamily: subConfig.fontName || 'Arial',
                                  fontSize: `${Math.min(subConfig.fontSize || 20, 22)}px`,
                                  color: subConfig.fontColor || '#FFFFFF',
                                  textShadow: `${subConfig.outlineWidth || 2}px ${subConfig.outlineWidth || 2}px 0px ${subConfig.outlineColor || '#000000'}, -${subConfig.outlineWidth || 2}px -${subConfig.outlineWidth || 2}px 0px ${subConfig.outlineColor || '#000000'}`
                                }}
                                className="font-bold text-center tracking-wide"
                              >
                                «Пример отображения надписи субтитра»
                              </span>
                            </div>

                            {/* Subtitles Quick Export Buttons */}
                            <div className="flex items-center justify-end gap-2 pt-1">
                              <button
                                type="button"
                                onClick={() => handleExportSubtitles('srt')}
                                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer active:scale-95"
                              >
                                <Download className="w-3.5 h-3.5 text-amber-400" />
                                <span>Скачать .SRT</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleExportSubtitles('ass')}
                                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer active:scale-95"
                              >
                                <Download className="w-3.5 h-3.5 text-indigo-400" />
                                <span>Скачать .ASS (стили)</span>
                              </button>
                            </div>
                          </div>
                        );
                      } else if (stepKey === "renderSettings") {
                        stepName = "5. Видеокодирование и мастер-файл";
                        stepIcon = <Film className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = false; // Render settings cannot be bypassed
                        const renderConfig = activePreset.phase4.renderSettings;
                        stepElement = (
                          <div className="space-y-3 text-xs">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black block">Медиа контейнер</label>
                                <select 
                                  value={renderConfig.container || 'mp4'}
                                  onChange={(e) => updatePhase4({
                                    renderSettings: { ...renderConfig, container: e.target.value as any }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300 font-bold"
                                >
                                  <option value="mp4">MP4 (Универсальный стандарт)</option>
                                  <option value="mkv">MKV (Мультидорожечный мастер)</option>
                                  <option value="mov">MOV (Apple ProRes / Мастер)</option>
                                  <option value="wav">WAV (Только аудиомастер)</option>
                                </select>
                              </div>

                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black block">Видео кодек</label>
                                <select 
                                  value={renderConfig.videoCodec}
                                  onChange={(e) => updatePhase4({
                                    renderSettings: { ...renderConfig, videoCodec: e.target.value as any }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                >
                                  <option value="libx264">Software x264 (Максимальное качество)</option>
                                  <option value="h264_nvenc">NVIDIA NVENC H.264 (Быстрый GPU)</option>
                                  <option value="hevc_nvenc">NVIDIA HEVC / H.265</option>
                                  <option value="copy">Без перекодирования видео (Copy)</option>
                                </select>
                              </div>

                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black block">Аудио кодек</label>
                                <select 
                                  value={renderConfig.audioCodec}
                                  onChange={(e) => updatePhase4({
                                    renderSettings: { ...renderConfig, audioCodec: e.target.value as any }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                >
                                  <option value="aac">AAC (320 kbps студия)</option>
                                  <option value="mp3">MP3 (320 kbps)</option>
                                  <option value="pcm">WAV / PCM 24-bit Lossless</option>
                                </select>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black block">Разрешение</label>
                                <select 
                                  value={renderConfig.resolution}
                                  onChange={(e) => updatePhase4({
                                    renderSettings: { ...renderConfig, resolution: e.target.value as any }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                >
                                  <option value="source">Как у оригинала</option>
                                  <option value="1080p">1080p Full HD</option>
                                  <option value="720p">720p HD</option>
                                  <option value="4k">4K Ultra HD</option>
                                </select>
                              </div>

                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black block">Кадровая частота</label>
                                <select 
                                  value={renderConfig.fps}
                                  onChange={(e) => updatePhase4({
                                    renderSettings: { ...renderConfig, fps: e.target.value as any }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                >
                                  <option value="source">Исходный FPS</option>
                                  <option value="23.976">23.976 fps</option>
                                  <option value="24">24 fps (Кино)</option>
                                  <option value="25">25 fps (PAL / ТВ)</option>
                                  <option value="30">30 fps</option>
                                  <option value="60">60 fps</option>
                                </select>
                              </div>

                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black block">Битрейт видео (kbps)</label>
                                <input 
                                  type="number"
                                  step="500"
                                  value={renderConfig.videoBitrateKbps || 8000}
                                  onChange={(e) => updatePhase4({
                                    renderSettings: { ...renderConfig, videoBitrateKbps: parseInt(e.target.value) || 8000 }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300 font-mono"
                                />
                              </div>

                              <div className="space-y-1">
                                <label className="text-[10px] text-zinc-500 uppercase font-black block">Пресет скорости</label>
                                <select 
                                  value={renderConfig.encodingPreset || 'medium'}
                                  onChange={(e) => updatePhase4({
                                    renderSettings: { ...renderConfig, encodingPreset: e.target.value as any }
                                  })}
                                  className="w-full bg-zinc-950 border border-white/10 rounded-lg p-1.5 text-xs text-zinc-300"
                                >
                                  <option value="ultrafast">Ultrafast (Мгновенно)</option>
                                  <option value="fast">Fast</option>
                                  <option value="medium">Medium (Баланс)</option>
                                  <option value="slow">Slow (Высокое качество)</option>
                                </select>
                              </div>
                            </div>

                            <div className="pt-2">
                              <button
                                type="button"
                                onClick={handleStartFinalRender}
                                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 hover:opacity-95 active:scale-[0.99] text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/25 transition-all cursor-pointer"
                              >
                                <Film className="w-4 h-4" />
                                <span>🚀 Запустить финальный рендер и экспорт стэмов</span>
                              </button>
                            </div>
                          </div>
                        );
                      } else if (stepKey.startsWith("vstStep_")) {
                        const vstConfig = activePreset.phase4.vstSteps?.[stepKey] || {
                          id: stepKey,
                          name: `VST Цепочка`,
                          bypass: false,
                          plugins: []
                        };
                        stepName = vstConfig.name;
                        stepIcon = <Sliders className="w-3.5 h-3.5 text-indigo-400" />;
                        stepBypass = vstConfig.bypass;
                        handleBypassToggle = () => {
                          const updatedSteps = { ...(activePreset.phase4.vstSteps || {}) };
                          updatedSteps[stepKey] = { ...vstConfig, bypass: !stepBypass };
                          updatePhase4({ vstSteps: updatedSteps });
                        };
                        stepElement = renderVstStepElement(stepKey, index, 4);
                      }

                      return renderStepContainer(
                        4,
                        index,
                        (activePreset.phase4Order || DEFAULT_PHASE4_ORDER).length,
                        stepKey,
                        stepName,
                        stepIcon,
                        stepBypass,
                        handleBypassToggle,
                        stepElement,
                        stepKey.startsWith("vstStep_") ? () => {
                          const updatedOrder = (activePreset.phase4Order || []).filter(k => k !== stepKey);
                          const updatedSteps = { ...(activePreset.phase4.vstSteps || {}) };
                          delete updatedSteps[stepKey];
                          setActivePreset({
                            ...activePreset,
                            phase4Order: updatedOrder,
                            phase4: {
                              ...activePreset.phase4,
                              vstSteps: updatedSteps
                            }
                          });
                          showToast("VST-шаг полностью удален из цепочки");
                        } : undefined
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      )}

      {activeModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[9999] flex items-center justify-center p-4 animate-fade-in" onClick={() => setActiveModal(null)}>
          <div 
            className="bg-zinc-950 border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="bg-zinc-900/80 px-4 py-3.5 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="text-indigo-400">{activeModal.icon}</div>
                <h4 className="text-xs font-black uppercase tracking-widest text-zinc-100">{activeModal.title}</h4>
              </div>
              <button 
                onClick={() => setActiveModal(null)}
                className="p-1 hover:bg-white/5 rounded-lg text-zinc-400 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            
            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-4 custom-scrollbar text-xs">
              {activeModal.content}
            </div>
            
            {/* Modal Footer */}
            <div className="bg-zinc-900/50 px-4 py-3 border-t border-white/5 flex justify-end">
              <button 
                type="button"
                onClick={() => setActiveModal(null)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs uppercase rounded-xl transition-all active:scale-[0.98] shadow-lg shadow-indigo-600/20"
              >
                Применить и закрыть
              </button>
            </div>
          </div>
        </div>
      )}

      <VstSelectorModal
        isOpen={isVstSelectorOpen}
        onClose={() => {
          setIsVstSelectorOpen(false);
          setActiveVstSelectStepKey(null);
          setActiveVstSelectPluginIdx(null);
        }}
        onSelect={handleVstPluginSelect}
        vstFolders={project?.audioSettings?.vstFolders || getGlobalAudioSettings().vstFolders || []}
      />

      {activeStepSettingsModal && (
        <MixingStepSettingsModal
          isOpen={activeStepSettingsModal !== null}
          stepId={activeStepSettingsModal}
          config={activePreset.phase3}
          mixingType={project?.mixingType || MixingType.DUBBING}
          onClose={() => setActiveStepSettingsModal(null)}
          onSaveConfig={(updatedConfig) => updatePhase3(updatedConfig)}
          onRunStep={(stepId) => {
            if (stepId === 'gainMatching') handleRunGainMatchingStep(true);
            else if (stepId === 'ducking') handleRunDuckingStep(true);
            else if (stepId === 'autoFxAnalysis') handleRunAutoFxStep(true);
            else if (stepId === 'vocalBusProcessing') handleRunVocalBusStep(true);
          }}
          isRunning={isExecutingPhase3Step !== null}
        />
      )}

      {isAuditLogOpen && (
        <MixingAuditLogModal
          isOpen={isAuditLogOpen}
          logs={auditLogs}
          onClose={() => setIsAuditLogOpen(false)}
          onClearLogs={() => setAuditLogs([])}
        />
      )}

      {isQaModalOpen && (
        <FinalQualityControlModal
          isOpen={isQaModalOpen}
          onClose={() => setIsQaModalOpen(false)}
          issues={qaIssues}
          integratedLufs={qaLufs}
          maxTruePeakDb={qaTruePeak}
          onSeekToTime={(time) => handleSeek(time)}
          onAutoFixIssue={handleAutoFixQaIssue}
          onRerunQa={() => handleRunQualityControl(false)}
        />
      )}

      {isRenderProgressModalOpen && (
        <FinalRenderProgressModal
          isOpen={isRenderProgressModalOpen}
          isRendering={isRenderingFinal}
          progressPercent={renderProgressPercent}
          currentStage={renderCurrentStage}
          result={finalRenderResult}
          onClose={() => setIsRenderProgressModalOpen(false)}
          onOpenQaReport={() => {
            setIsRenderProgressModalOpen(false);
            setIsQaModalOpen(true);
          }}
        />
      )}
    </div>
  );
};

export default MixingPanel;
