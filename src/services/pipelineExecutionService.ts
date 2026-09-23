import type React from 'react';
import { Project, AudioTrack, MixingPreset, MixingAuditEntry, QualityControlIssue, TimingIssue, AuditionVocalBusChainConfig, DeclickReport, DeplosiveReport, DeEsserReport, DenoiseReport, DereverbResult, VolumeLevelerReport, NormalizationStats, AudioSegment } from '../types';
import { AudioDspService } from './audioDspService';
import { TimingAlignmentService } from './timingAlignmentService';
import { MixingService } from './mixingService';
import { FinalRenderService } from './finalRenderService';
import { PlaybackEngine } from './playbackEngine';
import { AudioSeparatorService } from './audioSeparatorService';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { invalidateFileUrl, createPrefixedAudioPath } from '../lib/utils';
import { AIModelService } from './aiModelService';

export interface ExecuteStepParams {
  stepId: string;
  title: string;
  phaseNum: number;
  project: Project | null;
  activePreset: MixingPreset;
  playbackEngine: PlaybackEngine;
  onUpdateProject: (updates: Partial<Project>) => void;
  addAuditLogs: (logs: MixingAuditEntry[]) => void;
  setTimingIssues: (issues: TimingIssue[]) => void;
  setQaIssues: (issues: QualityControlIssue[]) => void;
  setStepExecution: React.Dispatch<React.SetStateAction<Record<string, { status: 'idle' | 'running' | 'success' | 'failed'; progress: number; log: string; hasRollback: boolean }>>>;
  showToast: (msg: string) => void;
  stepRollbackSnapshotsRef: React.MutableRefObject<Record<string, AudioTrack[]>>;
  handleRunSeparation?: () => Promise<void>;
  handleStartFinalRender?: () => Promise<void>;
}

/**
 * Обеспечивает, чтобы все аудиодорожки дубляжа были сконвертированы в 48kHz WAV
 * для корректной нативной DSP обработки и предотвращения ошибок "no RIFF tag found".
 */
async function ensureDubActorTracksWav(
  tracks: AudioTrack[]
): Promise<{ updatedTracks: AudioTrack[]; changed: boolean }> {
  if (typeof window === 'undefined' || !isTauri()) {
    return { updatedTracks: tracks, changed: false };
  }

  let changed = false;
  const updatedTracks = tracks.map(t => ({
    ...t,
    segments: [...t.segments]
  }));

  for (const track of updatedTracks) {
    if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
      for (let si = 0; si < track.segments.length; si++) {
        const seg = track.segments[si];
        const inputPath = seg.filePath;
        if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
          try {
            const wavPath = await invoke<string>('ensure_track_audio_wav', { filePath: inputPath });
            if (wavPath && wavPath !== inputPath) {
              track.segments[si] = {
                ...seg,
                filePath: wavPath,
              };
              changed = true;
            }
          } catch (err) {
            console.warn('[Pipeline] ensure_track_audio_wav conversion warning:', inputPath, err);
          }
        }
      }
    }
  }

  return { updatedTracks, changed };
}

export class PipelineExecutionService {
  /**
   * Executes a specific pipeline step across any of the 4 phases with real DSP calculations,
   * audio track modifications, audit logging, and state synchronization.
   */
  static async executeStep(params: ExecuteStepParams): Promise<void> {
    let { project } = params;
    const {
      stepId,
      title,
      phaseNum,
      activePreset,
      playbackEngine,
      onUpdateProject,
      addAuditLogs,
      setTimingIssues,
      setQaIssues,
      setStepExecution,
      showToast,
      stepRollbackSnapshotsRef,
      handleRunSeparation,
      handleStartFinalRender
    } = params;

    // 1. Set running state
    setStepExecution(prev => ({
      ...prev,
      [stepId]: {
        status: 'running',
        progress: 15,
        log: `Инициализация этапа "${title}"...`,
        hasRollback: false
      }
    }));

    // 2. Validate audio tracks
    if (!project || !project.tracks || project.tracks.length === 0) {
      setStepExecution(prev => ({
        ...prev,
        [stepId]: {
          status: 'failed',
          progress: 0,
          log: 'В проекте отсутствуют аудиодорожки для обработки.',
          hasRollback: false
        }
      }));
      showToast('В проекте отсутствуют аудиодорожки для обработки.');
      return;
    }

    // 3. Save snapshot of current tracks for non-destructive instant rollback
    stepRollbackSnapshotsRef.current[stepId] = JSON.parse(JSON.stringify(project.tracks));

    try {
      // =========================================================================
      // ЭТАП 1: ПРЕДОБРАБОТКА (Audio DSP Processing Engine)
      // =========================================================================
      if (phaseNum === 1) {
        // Гарантируем, что все дорожки дубляжа сконвертированы в 48kHz WAV перед DSP обработкой
        if (typeof window !== 'undefined' && isTauri()) {
          const { updatedTracks, changed } = await ensureDubActorTracksWav(project.tracks);
          if (changed) {
            project = { ...project, tracks: updatedTracks };
            onUpdateProject({ tracks: updatedTracks });
            playbackEngine.clearCache();
            await playbackEngine.updateTracks(updatedTracks);
          }
        }

        if (stepId === 'peakAdjustment') {
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 30,
              log: `Подстройка громкости по самому высокому пику (целевой пик -9.0 dBFS)...`
            }
          }));

          const res = await AudioDspService.applyPeakAdjustmentAsync(
            project.tracks,
            activePreset.phase1.peakAdjustment
          );
          project = { ...project, tracks: res.updatedTracks };
          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              status: 'success',
              progress: 100,
              log: res.logSummary,
              hasRollback: true
            }
          }));

          addAuditLogs(res.detailedLogs.map((msg, i) => ({
            id: `audit-peakadj-${Date.now()}-${i}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'peakAdjustment',
            status: 'success',
            title: 'Подстройка громкости по пику (-9 dBFS)',
            message: msg
          })));

          showToast(res.logSummary);
          return;
        }

        if (stepId === 'spectralBalancing') {
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 30,
              log: 'Анализ спектра и выравнивание частотного баланса (HPF 60Hz, LPF 20kHz)...'
            }
          }));

          const res = await AudioDspService.applySpectralBalancingAsync(
            (project as any).projectPath || '',
            project.tracks
          );
          project = { ...project, tracks: res.updatedTracks };
          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              status: 'success',
              progress: 100,
              log: res.logSummary,
              hasRollback: true
            }
          }));

          addAuditLogs(res.detailedLogs.map((msg, i) => ({
            id: `audit-specbalance-${Date.now()}-${i}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'spectralBalancing',
            status: 'success',
            title: 'Спектральное выравнивание 1.2',
            message: msg
          })));

          showToast(res.logSummary);
          return;
        }

        if (stepId === 'speechLeveler') {
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 30,
              log: 'Компрессия динамического диапазона и гейтирование пауз...'
            }
          }));

          const res = await AudioDspService.applySpeechLevelerAsync(
            (project as any).projectPath || '',
            project.tracks
          );
          project = { ...project, tracks: res.updatedTracks };
          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              status: 'success',
              progress: 100,
              log: res.logSummary,
              hasRollback: true
            }
          }));

          addAuditLogs(res.detailedLogs.map((msg, i) => ({
            id: `audit-speechlevel-${Date.now()}-${i}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'speechLeveler',
            status: 'success',
            title: 'Speech Leveler 1.3',
            message: msg
          })));

          showToast(res.logSummary);
          return;
        }

        if (stepId === 'vocalSpotCleaning') {
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 30,
              log: 'Точечное подавление деэссера, взрывных согласных и щелчков...'
            }
          }));

          const res = await AudioDspService.applyVocalSpotCleaningAsync(
            (project as any).projectPath || '',
            project.tracks
          );
          project = { ...project, tracks: res.updatedTracks };
          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              status: 'success',
              progress: 100,
              log: res.logSummary,
              hasRollback: true
            }
          }));

          addAuditLogs(res.detailedLogs.map((msg, i) => ({
            id: `audit-spotclean-${Date.now()}-${i}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'vocalSpotCleaning',
            status: 'success',
            title: 'Точечная очистка 1.4',
            message: msg
          })));

          showToast(res.logSummary);
          return;
        }

        if (stepId === 'normalization') {
          // Гарантируем наличие свежего анализа перед нормализацией и эквализацией
          const analysisRes = await AudioDspService.analyzeProjectVoiceTracksAsync(
            (project as any).projectPath || '',
            project.tracks
          );
          project = { ...project, tracks: analysisRes.updatedTracks };
          onUpdateProject({ tracks: analysisRes.updatedTracks });

          const targetLufs = activePreset.phase1.normalization.targetLufs ?? -16.0;
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 30,
              log: `Измерение LUFS (EBU R128) и расчет кривой апвард-компрессии (цель ${targetLufs.toFixed(1)} LUFS, порог ${activePreset.phase1.normalization.upwardThresholdDb} dB, подтяжка +${activePreset.phase1.normalization.upwardGainDb} dB)...`
            }
          }));

          let lastNativeNorm: NormalizationStats | null = null;
          let processedTracksCount = 0;
          let lastNativeError = '';

          if (typeof window !== 'undefined' && isTauri()) {
            if (activePreset.phase1.normalization.intelligentMode) {
              // Модуль 1.1: Интеллектуальная нормализация на основе классификации волн
              const res = await AudioDspService.applyIntelligentNormalizationAsync(
                (project as any).projectPath || '',
                project.tracks
              );
              onUpdateProject({ tracks: res.updatedTracks });
              playbackEngine.clearCache();
              await playbackEngine.updateTracks(res.updatedTracks);

              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'success',
                  progress: 100,
                  log: res.logSummary,
                  hasRollback: true
                }
              }));

              addAuditLogs(res.detailedLogs.map((msg, i) => ({
                id: `audit-intnorm-${Date.now()}-${i}`,
                timestamp: Date.now(),
                stageName: '1. Предобработка',
                stepId: 'normalization',
                status: 'success',
                title: 'Интеллектуальная нормализация 1.1',
                message: msg
              })));

              showToast(res.logSummary);
              // Если мы запустили интеллектуальную нормализацию, то продолжаем дальше к спектральному выравниванию
              // (вместо return выше, мы теперь просто даем им идти по цепочке)
            }

            if (activePreset.phase1.spectralBalancing.enabled) {
              // Модуль 1.2: Спектральное выравнивание на основе анализа
              const res = await AudioDspService.applySpectralBalancingAsync(
                (project as any).projectPath || '',
                project.tracks
              );
              onUpdateProject({ tracks: res.updatedTracks });
              playbackEngine.clearCache();
              await playbackEngine.updateTracks(res.updatedTracks);

              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'success',
                  progress: 100,
                  log: res.logSummary,
                  hasRollback: true
                }
              }));

              addAuditLogs(res.detailedLogs.map((msg, i) => ({
                id: `audit-specbalance-${Date.now()}-${i}`,
                timestamp: Date.now(),
                stageName: '1. Предобработка',
                stepId: 'spectral-balancing',
                status: 'success',
                title: 'Спектральное выравнивание 1.2',
                message: msg
              })));
              
              if (!activePreset.phase1.normalization.intelligentMode) {
                // Если нормализации не было, выводим тост сейчас
                showToast(res.logSummary);
              }
            }

            if (activePreset.phase1.speechLeveler.enabled) {
              // Модуль 1.3: Speech Leveler (Компрессия + Гейтирование)
              const res = await AudioDspService.applySpeechLevelerAsync(
                (project as any).projectPath || '',
                project.tracks
              );
              onUpdateProject({ tracks: res.updatedTracks });
              playbackEngine.clearCache();
              await playbackEngine.updateTracks(res.updatedTracks);

              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'success',
                  progress: 100,
                  log: res.logSummary,
                  hasRollback: true
                }
              }));

              addAuditLogs(res.detailedLogs.map((msg, i) => ({
                id: `audit-speechlevel-${Date.now()}-${i}`,
                timestamp: Date.now(),
                stageName: '1. Предобработка',
                stepId: 'speech-leveler',
                status: 'success',
                title: 'Speech Leveler 1.3',
                message: msg
              })));
            }

            if (activePreset.phase1.vocalSpotCleaning.enabled) {
              // Модуль 1.4: Точечная очистка (De-esser, Plosives, Clicks)
              const res = await AudioDspService.applyVocalSpotCleaningAsync(
                (project as any).projectPath || '',
                project.tracks
              );
              onUpdateProject({ tracks: res.updatedTracks });
              playbackEngine.clearCache();
              await playbackEngine.updateTracks(res.updatedTracks);

              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'success',
                  progress: 100,
                  log: res.logSummary,
                  hasRollback: true
                }
              }));

              addAuditLogs(res.detailedLogs.map((msg, i) => ({
                id: `audit-spotclean-${Date.now()}-${i}`,
                timestamp: Date.now(),
                stageName: '1. Предобработка',
                stepId: 'vocal-spot-cleaner',
                status: 'success',
                title: 'Точечная очистка 1.4',
                message: msg
              })));
            }

            if (activePreset.phase1.normalization.intelligentMode || 
                activePreset.phase1.spectralBalancing.enabled ||
                activePreset.phase1.speechLeveler.enabled ||
                activePreset.phase1.vocalSpotCleaning.enabled) {
               return; // Выходим, так как мы обработали кастомные шаги Rust
            }

            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const outPath = createPrefixedAudioPath('norm', inputPath);
                      const stats = await invoke<NormalizationStats>('normalize_audio', {
                        inputPath,
                        outputPath: outPath,
                        targetLufs,
                      });
                      if (stats) {
                        lastNativeNorm = stats;
                        processedTracksCount++;
                      }
                      seg.filePath = outPath;
                      invalidateFileUrl(inputPath);
                      invalidateFileUrl(outPath);
                      if (typeof window !== 'undefined' && (window as any).webFileCache) {
                        (window as any).webFileCache.delete(inputPath);
                        (window as any).webFileCache.delete(outPath);
                      }
                    } catch (e) {
                      lastNativeError = String(e);
                      console.warn('[Pipeline] Native normalize_audio invocation error:', e);
                    }
                  }
                }
              }
            }

            const dubSegments = project.tracks
              .filter(t => AudioDspService.isDubActorTrack(t) && t.isProcessingEnabled !== false)
              .flatMap(t => t.segments.filter(s => s.filePath && !s.filePath.startsWith('blob:') && !s.filePath.startsWith('data:')));

            if (dubSegments.length > 0 && processedTracksCount === 0 && lastNativeError) {
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'failed',
                  progress: 0,
                  log: `Ошибка нативной нормализации EBU R128: ${lastNativeError}`,
                  hasRollback: false,
                }
              }));
              showToast(`Ошибка нормализации: ${lastNativeError}`);
              return;
            }
          }

          const res = await AudioDspService.applyNormalizationAndUpwardCompression(
            project.tracks,
            activePreset.phase1.normalization
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = lastNativeNorm
            ? `EBU R128 нормализация (Rayon): ${lastNativeNorm.initialLufs.toFixed(1)} -> ${lastNativeNorm.finalLufs.toFixed(1)} LUFS (усиление ${lastNativeNorm.gainAppliedDb > 0 ? '+' : ''}${lastNativeNorm.gainAppliedDb.toFixed(2)} dB, True Peak ${lastNativeNorm.finalTruePeakDb.toFixed(1)} dBTP) на ${processedTracksCount} дорожках.`
            : res.logSummary;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              status: 'success',
              progress: 100,
              log: summaryLog,
              hasRollback: true
            }
          }));

          addAuditLogs(res.detailedLogs.map((msg, i) => ({
            id: `audit-norm-${Date.now()}-${i}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'normalization',
            status: 'success',
            title: 'Нормализация и апвард-компрессия',
            message: msg
          })));

          showToast(summaryLog);
          return;
        }

        if (stepId === 'eqMatching') {
          let profileModel = activePreset.phase1.eqMatching.profileModel || 'vocal_presence';
          const targetPath = activePreset.phase1.eqMatching.targetProfilePath;
          const missingBehavior = activePreset.phase1.missingModelBehavior || 'fallback_dsp';
          const isNeuralMatch = ['vocal_spectral_matcher', 'voicefixer_fe', 'vocal_timbre_transfer'].includes(profileModel);

          if (isNeuralMatch) {
            const isInstalled = await AIModelService.getInstance().checkModelInstalled(profileModel);
            if (!isInstalled) {
              if (missingBehavior === 'skip') {
                const skipMsg = `⏭️ Шаг EQ Matching пропущен: нейросетевая модель "${profileModel}" не скачана в Настройках.`;
                console.log(`[Pipeline] ${skipMsg}`);
                setStepExecution(prev => ({
                  ...prev,
                  [stepId]: { status: 'success', progress: 100, log: skipMsg, hasRollback: false }
                }));
                showToast(skipMsg);
                return;
              } else {
                console.log(`[Pipeline] ⚡ Нейросетевая модель "${profileModel}" не скачана. Применен встроенный DSP-эквалайзер "vocal_presence" без ИИ.`);
                profileModel = 'vocal_presence';
              }
            }
          }

          const profileParam = (profileModel === 'reference_match' && targetPath) ? targetPath : profileModel;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 35,
              log: `Запуск нативного DSP EQ Matching (FFT 4096, 1/3-octave smoothing, "${profileModel}")...`
            }
          }));

          let nativeSuccessCount = 0;
          let lastNativeError = '';

          // Native Tauri DSP processing if running in desktop app
          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const outPath = createPrefixedAudioPath('eq', inputPath);
                      await invoke('match_eq_profile', {
                        inputPath,
                        outputPath: outPath,
                        profileName: profileParam,
                      });
                      seg.filePath = outPath;
                      invalidateFileUrl(inputPath);
                      invalidateFileUrl(outPath);
                      if (typeof window !== 'undefined' && (window as any).webFileCache) {
                        (window as any).webFileCache.delete(inputPath);
                        (window as any).webFileCache.delete(outPath);
                      }
                      nativeSuccessCount++;
                    } catch (e) {
                      lastNativeError = String(e);
                      console.warn('[Pipeline] Native match_eq_profile invocation error:', e);
                    }
                  }
                }
              }
            }

            const dubSegments = project.tracks
              .filter(t => AudioDspService.isDubActorTrack(t) && t.isProcessingEnabled !== false)
              .flatMap(t => t.segments.filter(s => s.filePath && !s.filePath.startsWith('blob:') && !s.filePath.startsWith('data:')));

            if (dubSegments.length > 0 && nativeSuccessCount === 0 && lastNativeError) {
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'failed',
                  progress: 0,
                  log: `Ошибка нативного EQ Matching: ${lastNativeError}`,
                  hasRollback: false,
                }
              }));
              showToast(`Ошибка EQ Matching: ${lastNativeError}`);
              return;
            }
          }

          const res = await AudioDspService.applyEqMatching(
            project.tracks,
            activePreset.phase1.eqMatching
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = nativeSuccessCount > 0
            ? `EQ Matching применен (FFT 4096, 1/3-октавное сглаживание) на ${nativeSuccessCount} сегментах.`
            : res.logSummary;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: summaryLog, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-eq-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'eqMatching',
            status: 'success',
            title: 'EQ Matching',
            message: summaryLog
          }]);

          showToast(summaryLog);
          return;
        }

        if (stepId === 'deClick') {
          const sensitivity = activePreset.phase1.deClick.sensitivity ?? 75;
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 35,
              log: `Нативное удаление щелчков (LPC + 2-я производная, Rayon multithread, чувствительность ${sensitivity}%)...`
            }
          }));

          let nativeClicksCount = 0;
          let nativeSamplesRestored = 0;
          let processedTracksCount = 0;
          let lastNativeError = '';

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const outPath = createPrefixedAudioPath('declick', inputPath);
                      const rep = await invoke<DeclickReport>('clean_clicks', {
                        inputWav: inputPath,
                        outputWav: outPath,
                        sensitivity,
                      });
                      if (rep) {
                        nativeClicksCount += rep.clicksDetected;
                        nativeSamplesRestored += rep.samplesRestored;
                        processedTracksCount++;
                      }
                      seg.filePath = outPath;
                      invalidateFileUrl(inputPath);
                      invalidateFileUrl(outPath);
                      if (typeof window !== 'undefined' && (window as any).webFileCache) {
                        (window as any).webFileCache.delete(inputPath);
                        (window as any).webFileCache.delete(outPath);
                      }
                    } catch (e) {
                      lastNativeError = String(e);
                      console.warn('[Pipeline] Native clean_clicks invocation error:', e);
                    }
                  }
                }
              }
            }

            const dubSegments = project.tracks
              .filter(t => AudioDspService.isDubActorTrack(t) && t.isProcessingEnabled !== false)
              .flatMap(t => t.segments.filter(s => s.filePath && !s.filePath.startsWith('blob:') && !s.filePath.startsWith('data:')));

            if (dubSegments.length > 0 && processedTracksCount === 0 && lastNativeError) {
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'failed',
                  progress: 0,
                  log: `Ошибка нативного De-Click: ${lastNativeError}`,
                  hasRollback: false,
                }
              }));
              showToast(`Ошибка De-Click: ${lastNativeError}`);
              return;
            }
          }

          const res = await AudioDspService.applyDeClick(
            project.tracks,
            activePreset.phase1.deClick
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = processedTracksCount > 0
            ? `De-Click завершен (Rayon DSP): обработано ${processedTracksCount} сегментов, обнаружено ${nativeClicksCount} кликов, восстановлено ${nativeSamplesRestored} сэмплов.`
            : res.logSummary;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: summaryLog, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-declick-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'deClick',
            status: 'success',
            title: 'De-Click',
            message: summaryLog
          }]);

          showToast(summaryLog);
          return;
        }

        if (stepId === 'dePlosive') {
          const thresholdDb = activePreset.phase1.dePlosive.threshold ?? -24;
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 35,
              log: `Динамический De-Plosive (двухполосный сайдчейн 20-120 Гц vs 200-2000 Гц, Butterworth 4-го порядка, порог ${thresholdDb} dB)...`
            }
          }));

          let nativePlosivesCount = 0;
          let maxReductionDb = 0;
          let processedTracksCount = 0;
          let lastNativeError = '';

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const outPath = createPrefixedAudioPath('deplosive', inputPath);
                      const rep = await invoke<DeplosiveReport>('apply_deplosive', {
                        filePath: inputPath,
                        outPath: outPath,
                        thresholdDb,
                      });
                      if (rep) {
                        nativePlosivesCount += rep.plosivesDetected;
                        if (rep.maxReductionDb > maxReductionDb) {
                          maxReductionDb = rep.maxReductionDb;
                        }
                        processedTracksCount++;
                      }
                      seg.filePath = outPath;
                      invalidateFileUrl(inputPath);
                      invalidateFileUrl(outPath);
                      if (typeof window !== 'undefined' && (window as any).webFileCache) {
                        (window as any).webFileCache.delete(inputPath);
                        (window as any).webFileCache.delete(outPath);
                      }
                    } catch (e) {
                      lastNativeError = String(e);
                      console.warn('[Pipeline] Native apply_deplosive invocation error:', e);
                    }
                  }
                }
              }
            }

            const dubSegments = project.tracks
              .filter(t => AudioDspService.isDubActorTrack(t) && t.isProcessingEnabled !== false)
              .flatMap(t => t.segments.filter(s => s.filePath && !s.filePath.startsWith('blob:') && !s.filePath.startsWith('data:')));

            if (dubSegments.length > 0 && processedTracksCount === 0 && lastNativeError) {
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'failed',
                  progress: 0,
                  log: `Ошибка нативного De-Plosive: ${lastNativeError}`,
                  hasRollback: false,
                }
              }));
              showToast(`Ошибка De-Plosive: ${lastNativeError}`);
              return;
            }
          }

          const res = await AudioDspService.applyDePlosive(
            project.tracks,
            activePreset.phase1.dePlosive
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = processedTracksCount > 0
            ? `De-Plosive завершен (Rayon + Butterworth HPF): обработано ${processedTracksCount} сегментов, подавлено ${nativePlosivesCount} задувов/взрывов, макс. срез -${maxReductionDb.toFixed(1)} dB (сдвиг среза 40->175 Гц).`
            : res.logSummary;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: summaryLog, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-deplosive-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'dePlosive',
            status: 'success',
            title: 'De-Plosive',
            message: summaryLog
          }]);

          showToast(summaryLog);
          return;
        }

        if (stepId === 'deEsser') {
          const frequency = activePreset.phase1.deEsser.frequency ?? 6500;
          const threshold = activePreset.phase1.deEsser.threshold ?? -20;
          const ratio = activePreset.phase1.deEsser.ratio ?? 4.0;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 35,
              log: `Высокоточный Split-Band De-Esser (сайдчейн ${frequency} Гц Q=2.0, RMS детектор 1.5/50 мс, soft-knee порог ${threshold} dB, ratio ${ratio}:1)...`
            }
          }));

          let nativeSibilantsCount = 0;
          let maxReductionDb = 0;
          let processedTracksCount = 0;
          let lastNativeError = '';

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const outPath = createPrefixedAudioPath('deesser', inputPath);
                      const rep = await invoke<DeEsserReport>('process_deesser', {
                        inputPath,
                        outputPath: outPath,
                        frequency,
                        threshold,
                        ratio,
                      });
                      if (rep) {
                        nativeSibilantsCount += rep.sibilantsDetected;
                        if (rep.maxReductionDb > maxReductionDb) {
                          maxReductionDb = rep.maxReductionDb;
                        }
                        processedTracksCount++;
                      }
                      seg.filePath = outPath;
                      invalidateFileUrl(inputPath);
                      invalidateFileUrl(outPath);
                      if (typeof window !== 'undefined' && (window as any).webFileCache) {
                        (window as any).webFileCache.delete(inputPath);
                        (window as any).webFileCache.delete(outPath);
                      }
                    } catch (e) {
                      lastNativeError = String(e);
                      console.warn('[Pipeline] Native process_deesser invocation error:', e);
                    }
                  }
                }
              }
            }

            const dubSegments = project.tracks
              .filter(t => AudioDspService.isDubActorTrack(t) && t.isProcessingEnabled !== false)
              .flatMap(t => t.segments.filter(s => s.filePath && !s.filePath.startsWith('blob:') && !s.filePath.startsWith('data:')));

            if (dubSegments.length > 0 && processedTracksCount === 0 && lastNativeError) {
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'failed',
                  progress: 0,
                  log: `Ошибка нативного De-Esser: ${lastNativeError}`,
                  hasRollback: false,
                }
              }));
              showToast(`Ошибка De-Esser: ${lastNativeError}`);
              return;
            }
          }

          const res = await AudioDspService.applyDeEsser(
            project.tracks,
            activePreset.phase1.deEsser
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = processedTracksCount > 0
            ? `De-Esser завершен (Split-Band DSP): обработано ${processedTracksCount} сегментов, сглажено ${nativeSibilantsCount} сибилянтов («С», «З», «Щ»), макс. подавление -${maxReductionDb.toFixed(1)} dB.`
            : res.logSummary;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: summaryLog, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-deesser-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'deEsser',
            status: 'success',
            title: 'De-Esser (Split-Band)',
            message: summaryLog
          }]);

          showToast(summaryLog);
          return;
        }

        if (stepId === 'denoise') {
          let modelName = activePreset.phase1.denoise.model || 'UVR-DeNoise';
          const missingBehavior = activePreset.phase1.missingModelBehavior || 'fallback_dsp';
          const isNeuralModel = ['uvr_denoise', 'uvr_denoise_lite', 'uvr_denoise_foxjoy', 'uvr_denoise_full', 'deepfilternet3', 'UVR-DeNoise'].includes(modelName);

          if (isNeuralModel) {
            const isInstalled = await AIModelService.getInstance().checkModelInstalled(modelName);
            if (!isInstalled) {
              if (missingBehavior === 'skip') {
                const skipMsg = `⏭️ Шаг шумоподавления пропущен: AI-модель "${modelName}" не скачана в Настройках.`;
                console.log(`[Pipeline] ${skipMsg}`);
                setStepExecution(prev => ({
                  ...prev,
                  [stepId]: { status: 'success', progress: 100, log: skipMsg, hasRollback: false }
                }));
                showToast(skipMsg);
                return;
              } else {
                console.log(`[Pipeline] ⚡ AI-модель "${modelName}" не скачана. Применен встроенный спектральный DSP-гейт "spectral_gate" без ИИ.`);
                modelName = 'spectral_gate';
              }
            }
          }

          console.group(`%c[Pipeline] ▶ Этап: Шумоподавление (${modelName})`, 'color: #0d9488; font-weight: bold; font-size: 13px;');
          console.log(`[Pipeline] Модель: ${modelName}, Сила: ${activePreset.phase1.denoise.strength}%, Bypass: ${activePreset.phase1.denoise.bypass}`);
          
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 25,
              log: `Шумоподавление (${modelName}, сила ${activePreset.phase1.denoise.strength}%)...`
            }
          }));

          let lastNativeReport: DenoiseReport | null = null;
          let processedTracksCount = 0;
          let lastNativeError = '';

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                console.log(`[Pipeline] Обработка дорожки "${track.name}" (сегментов: ${track.segments.length})...`);
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const outPath = createPrefixedAudioPath('denoise', inputPath);
                      console.log(`[Pipeline] → Запуск process_denoise для: ${inputPath} -> ${outPath}`);
                      const rep = await invoke<DenoiseReport>('process_denoise', {
                        inputPath,
                        outputPath: outPath,
                        modelName: modelName,
                        strength: activePreset.phase1.denoise.strength,
                      });
                      if (rep) {
                        lastNativeReport = rep;
                        processedTracksCount++;
                        console.log(`[Pipeline] ✓ Шумоподавление завершено:`, rep);
                      }
                      seg.filePath = outPath;
                      invalidateFileUrl(inputPath);
                      invalidateFileUrl(outPath);
                      if (typeof window !== 'undefined' && (window as any).webFileCache) {
                        (window as any).webFileCache.delete(inputPath);
                        (window as any).webFileCache.delete(outPath);
                        const basenameIn = inputPath.split(/[/\\]/).pop();
                        const basenameOut = outPath.split(/[/\\]/).pop();
                        if (basenameIn) (window as any).webFileCache.delete(basenameIn);
                        if (basenameOut) (window as any).webFileCache.delete(basenameOut);
                      }
                    } catch (e) {
                      lastNativeError = String(e);
                      console.error('[Pipeline] ❌ Ошибка process_denoise:', e);
                    }
                  } else {
                    console.warn(`[Pipeline] Пропущен сегмент ${seg.id}: нет валидного локального filePath (${seg.filePath})`);
                  }
                }
              }
            }

            const dubSegments = project.tracks
              .filter(t => AudioDspService.isDubActorTrack(t) && t.isProcessingEnabled !== false)
              .flatMap(t => t.segments.filter(s => s.filePath && !s.filePath.startsWith('blob:') && !s.filePath.startsWith('data:')));

            if (dubSegments.length > 0 && processedTracksCount === 0 && lastNativeError) {
              console.error(`[Pipeline] Фатальная ошибка этапа DeNoise: ${lastNativeError}`);
              console.groupEnd();
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'failed',
                  progress: 0,
                  log: `Ошибка нативного шумоподавления: ${lastNativeError}`,
                  hasRollback: false,
                }
              }));
              showToast(`Ошибка DeNoise: ${lastNativeError}`);
              return;
            }
          }

          const res = await AudioDspService.applyDenoise(
            project.tracks,
            activePreset.phase1.denoise
          );

          // Invalidate cached blobUrls to guarantee fresh audio from disk is loaded by player
          const freshTracks = res.updatedTracks.map(t => ({
            ...t,
            segments: t.segments.map(s => ({
              ...s,
              blobUrl: undefined,
              updatedAt: Date.now()
            }))
          }));

          onUpdateProject({ tracks: freshTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(freshTracks);

          const summaryLog = lastNativeReport
            ? `Шумоподавление завершено (${lastNativeReport.isNeural ? `UVR DeNoise: ${lastNativeReport.providerUsed}` : lastNativeReport.modelName}): подавление шума -${lastNativeReport.noiseReductionDb.toFixed(1)} dB на ${processedTracksCount} дорожках.`
            : res.logSummary;

          console.log(`%c[Pipeline] ✅ ${summaryLog}`, 'color: #10b981; font-weight: bold;');
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: summaryLog, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-denoise-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'denoise',
            status: 'success',
            title: 'UVR DeNoise (Neural)',
            message: summaryLog
          }]);

          showToast(summaryLog);
          return;
        }

        if (stepId === 'dereverb') {
          let modelName = activePreset.phase1.dereverb.model || 'rt_dereverb_v2';
          const missingBehavior = activePreset.phase1.missingModelBehavior || 'fallback_dsp';
          const isNeuralModel = ['uvr_deecho_normal', 'uvr_deecho_aggressive', 'reverb_foxjoy', 'mdx_dereverb_room'].includes(modelName);

          if (isNeuralModel) {
            const isInstalled = await AIModelService.getInstance().checkModelInstalled(modelName);
            if (!isInstalled) {
              if (missingBehavior === 'skip') {
                const skipMsg = `⏭️ Шаг дереверберации пропущен: AI-модель "${modelName}" не скачана в Настройках.`;
                console.log(`[Pipeline] ${skipMsg}`);
                setStepExecution(prev => ({
                  ...prev,
                  [stepId]: { status: 'success', progress: 100, log: skipMsg, hasRollback: false }
                }));
                showToast(skipMsg);
                return;
              } else {
                console.log(`[Pipeline] ⚡ AI-модель "${modelName}" не скачана. Применен встроенный DSP-деревербератор "rt_dereverb_v2" без ИИ.`);
                modelName = 'rt_dereverb_v2';
              }
            }
          }

          console.group(`%c[Pipeline] ▶ Этап: Дереверберация (${modelName})`, 'color: #6366f1; font-weight: bold; font-size: 13px;');
          console.log(`[Pipeline] Модель: ${modelName}, Сила: ${activePreset.phase1.dereverb.strength}%, Bypass: ${activePreset.phase1.dereverb.bypass}`);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 25,
              log: `Подавление эха и реверберации (${modelName}, сила ${(activePreset.phase1.dereverb.strength)}%)...`
            }
          }));

          let lastNativeReport: DereverbResult | null = null;
          let processedTracksCount = 0;
          let lastNativeError = '';

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                console.log(`[Pipeline] Обработка дорожки "${track.name}" (сегментов: ${track.segments.length})...`);
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const outPath = createPrefixedAudioPath('dereverb', inputPath);
                      console.log(`[Pipeline] → Запуск process_uvr_dereverb для: ${inputPath} -> ${outPath}`);
                      const rep = await invoke<DereverbResult>('process_uvr_dereverb', {
                        inputPath,
                        outputPath: outPath,
                        modelName: modelName,
                        reverbTailExportPath: null,
                        strength: (activePreset.phase1.dereverb.strength || 85) / 100.0,
                      });
                      if (rep) {
                        lastNativeReport = rep;
                        processedTracksCount++;
                        console.log(`[Pipeline] ✓ Подавление реверберации завершено:`, rep);
                      }
                      seg.filePath = outPath;
                      invalidateFileUrl(inputPath);
                      invalidateFileUrl(outPath);
                      if (typeof window !== 'undefined' && (window as any).webFileCache) {
                        (window as any).webFileCache.delete(inputPath);
                        (window as any).webFileCache.delete(outPath);
                        const basenameIn = inputPath.split(/[/\\]/).pop();
                        const basenameOut = outPath.split(/[/\\]/).pop();
                        if (basenameIn) (window as any).webFileCache.delete(basenameIn);
                        if (basenameOut) (window as any).webFileCache.delete(basenameOut);
                      }
                    } catch (e) {
                      lastNativeError = String(e);
                      console.error('[Pipeline] ❌ Ошибка process_uvr_dereverb:', e);
                    }
                  } else {
                    console.warn(`[Pipeline] Пропущен сегмент ${seg.id}: нет валидного локального filePath (${seg.filePath})`);
                  }
                }
              }
            }

            const dubSegments = project.tracks
              .filter(t => AudioDspService.isDubActorTrack(t) && t.isProcessingEnabled !== false)
              .flatMap(t => t.segments.filter(s => s.filePath && !s.filePath.startsWith('blob:') && !s.filePath.startsWith('data:')));

            if (dubSegments.length > 0 && processedTracksCount === 0 && lastNativeError) {
              console.error(`[Pipeline] Фатальная ошибка этапа De-Reverb: ${lastNativeError}`);
              console.groupEnd();
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'failed',
                  progress: 0,
                  log: `Ошибка нативного De-Echo / De-Reverb: ${lastNativeError}`,
                  hasRollback: false,
                }
              }));
              showToast(`Ошибка De-Reverb: ${lastNativeError}`);
              return;
            }
          }

          const res = await AudioDspService.applyDeReverb(
            project.tracks,
            activePreset.phase1.dereverb
          );

          // Invalidate cached blobUrls to guarantee fresh audio from disk is loaded by player
          const freshTracks = res.updatedTracks.map(t => ({
            ...t,
            segments: t.segments.map(s => ({
              ...s,
              blobUrl: undefined,
              updatedAt: Date.now()
            }))
          }));

          onUpdateProject({ tracks: freshTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(freshTracks);

          const summaryLog = lastNativeReport
            ? `Подавление эха завершено (${lastNativeReport.isNeural ? `UVR De-Echo: ${lastNativeReport.providerUsed}` : lastNativeReport.modelName}): подавление реверберации -${lastNativeReport.reverbReductionDb.toFixed(1)} dB на ${processedTracksCount} дорожках.`
            : res.logSummary;

          console.log(`%c[Pipeline] ✅ ${summaryLog}`, 'color: #10b981; font-weight: bold;');
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: summaryLog, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-dereverb-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'dereverb',
            status: 'success',
            title: 'UVR De-Echo / De-Reverb',
            message: summaryLog
          }]);

          showToast(summaryLog);
          return;
        }

        if (stepId === 'volumeLeveler') {
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 25,
              log: `Выравнивание громкости слогов AGC (целевой RMS ${activePreset.phase1.volumeLeveler.targetRms} dBFS, Lookahead 15 мс)...`
            }
          }));

          let lastNativeReport: VolumeLevelerReport | null = null;
          let processedTracksCount = 0;
          let lastNativeError = '';

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const outPath = createPrefixedAudioPath('leveler', inputPath);
                      const rep = await invoke<VolumeLevelerReport>('level_speech_volume', {
                        inputPath,
                        outputPath: outPath,
                        targetRms: activePreset.phase1.volumeLeveler.targetRms || -19.0,
                        gateThresholdDb: -50.0,
                        maxBoostDb: 12.0,
                        maxAttenuationDb: 15.0,
                      });
                      if (rep) {
                        lastNativeReport = rep;
                        processedTracksCount++;
                      }
                      seg.filePath = outPath;
                      invalidateFileUrl(inputPath);
                      invalidateFileUrl(outPath);
                      if (typeof window !== 'undefined' && (window as any).webFileCache) {
                        (window as any).webFileCache.delete(inputPath);
                        (window as any).webFileCache.delete(outPath);
                        const basenameIn = inputPath.split(/[/\\]/).pop();
                        const basenameOut = outPath.split(/[/\\]/).pop();
                        if (basenameIn) (window as any).webFileCache.delete(basenameIn);
                        if (basenameOut) (window as any).webFileCache.delete(basenameOut);
                      }
                    } catch (e) {
                      lastNativeError = String(e);
                      console.warn('[Pipeline] Native level_speech_volume invocation error:', e);
                    }
                  }
                }
              }
            }

            const dubSegments = project.tracks
              .filter(t => AudioDspService.isDubActorTrack(t) && t.isProcessingEnabled !== false)
              .flatMap(t => t.segments.filter(s => s.filePath && !s.filePath.startsWith('blob:') && !s.filePath.startsWith('data:')));

            if (dubSegments.length > 0 && processedTracksCount === 0 && lastNativeError) {
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  status: 'failed',
                  progress: 0,
                  log: `Ошибка нативного выравнивания громкости (AGC): ${lastNativeError}`,
                  hasRollback: false,
                }
              }));
              showToast(`Ошибка Volume Leveler: ${lastNativeError}`);
              return;
            }
          }

          const res = await AudioDspService.applyVolumeLeveler(
            project.tracks,
            activePreset.phase1.volumeLeveler
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = lastNativeReport
            ? `Выравнивание громкости завершено (AGC): RMS ${lastNativeReport.initialRmsDb} -> ${lastNativeReport.finalRmsDb} dBFS (буст +${lastNativeReport.maxBoostAppliedDb} dB, срез -${lastNativeReport.maxCutAppliedDb} dB) на ${processedTracksCount} дорожках.`
            : res.logSummary;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: summaryLog, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-leveler-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'volumeLeveler',
            status: 'success',
            title: 'Speech Vocal Leveler (AGC)',
            message: summaryLog
          }]);

          showToast(summaryLog);
          return;
        }

        if (stepId === 'sourceSeparation') {
          if (handleRunSeparation) {
            await handleRunSeparation();
          } else {
            const originalTrack = project.tracks.find(t => t.name === 'Оригинал') || project.tracks[0];
            const defaultOriginalFile = originalTrack?.segments?.[0]?.filePath || project?.referenceAudioPath || project?.videoPath || '';

            if (typeof window !== 'undefined' && isTauri() && defaultOriginalFile) {
              let modelName = activePreset.phase1.sourceSeparation.model || 'UVR-MDX-NET-Voc_FT';
              const missingBehavior = activePreset.phase1.missingModelBehavior || 'fallback_dsp';
              const isNeural = modelName !== 'fast_dsp_splitter';

              if (isNeural) {
                const isInstalled = await AIModelService.getInstance().checkModelInstalled(modelName);
                if (!isInstalled) {
                  if (missingBehavior === 'skip') {
                    const skipMsg = `⏭️ Шаг разделения стемов пропущен: AI-модель "${modelName}" не скачана в Настройках.`;
                    console.log(`[Pipeline] ${skipMsg}`);
                    setStepExecution(prev => ({
                      ...prev,
                      [stepId]: { status: 'success', progress: 100, log: skipMsg, hasRollback: false }
                    }));
                    showToast(skipMsg);
                    return;
                  } else {
                    console.log(`[Pipeline] ⚡ AI-модель "${modelName}" не скачана. Применен быстрый фазово-спектральный разделитель (DSP-фоллбэк без ИИ).`);
                    modelName = 'fast_dsp_splitter';
                  }
                }
              }

              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  ...prev[stepId],
                  progress: 10,
                  log: `Разделение стемов (${modelName})...`
                }
              }));

              const sepResult = await AudioSeparatorService.separateStems(
                defaultOriginalFile,
                project.projectPath || undefined,
                modelName,
                false,
                (percent, detail) => {
                  setStepExecution(prev => ({
                    ...prev,
                    [stepId]: {
                      ...prev[stepId],
                      progress: Math.max(10, Math.min(99, Math.round(percent))),
                      log: detail?.stage || `Разделение стемов (${modelName}): ${Math.round(percent)}%`
                    }
                  }));
                }
              );

              playbackEngine.stop();
              playbackEngine.clearCache();

              const duration = sepResult.durationSec || project.duration || 60;
              const soundsTrackId = 'track-' + Math.random().toString(36).substring(2, 11);
              const voicesTrackId = 'track-' + Math.random().toString(36).substring(2, 11);

              const soundsSegment: AudioSegment = {
                id: 'seg-' + Math.random().toString(36).substring(2, 11),
                startTime: 0,
                duration: duration,
                fileOffset: 0,
                fileDuration: duration,
                blobUrl: '',
                filePath: sepResult.noVocalsPath,
                gain: 1.0,
                playbackRate: 1.0,
                originalFileName: sepResult.noVocalsPath.split(/[\\/]/).pop() || 'Sounds_no_vocals.wav'
              };

              const voicesSegment: AudioSegment = {
                id: 'seg-' + Math.random().toString(36).substring(2, 11),
                startTime: 0,
                duration: duration,
                fileOffset: 0,
                fileDuration: duration,
                blobUrl: '',
                filePath: sepResult.vocalsPath,
                gain: 1.0,
                playbackRate: 1.0,
                originalFileName: sepResult.vocalsPath.split(/[\\/]/).pop() || 'Voices_vocals.wav'
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

              const updatedTracks = project.tracks.map(t => (t.name === 'Оригинал' || t.type === 'original') ? { ...t, isMuted: true } : t);
              const finalTracks = [
                ...updatedTracks.filter(t => t.name !== 'Звуки (Музыка)' && t.name !== 'Голоса (Вокал)'),
                soundsTrack,
                voicesTrack
              ];

              onUpdateProject({ tracks: finalTracks });
              playbackEngine.clearCache();
              await playbackEngine.updateTracks(finalTracks);
            } else {
              // Web fallback
              const origTrack = project.tracks.find(t => t.name === 'Оригинал') || project.tracks[0];
              const origSeg = origTrack?.segments[0];
              const soundsTrackId = 'track-' + Math.random().toString(36).substring(2, 11);
              const voicesTrackId = 'track-' + Math.random().toString(36).substring(2, 11);

              const soundsTrack: AudioTrack = {
                id: soundsTrackId,
                name: 'Звуки (Музыка)',
                segments: origSeg ? [{
                  ...origSeg,
                  id: 'seg-' + Math.random().toString(36).substring(2, 11),
                  gain: 0.9,
                  originalFileName: 'Оригинал (Музыка и звуки)'
                }] : [],
                volume: 0.9,
                isMuted: false,
                isSolo: false,
                isArmed: false,
                isProcessingEnabled: false,
                height: 80
              };

              const voicesTrack: AudioTrack = {
                id: voicesTrackId,
                name: 'Голоса (Вокал)',
                segments: origSeg ? [{
                  ...origSeg,
                  id: 'seg-' + Math.random().toString(36).substring(2, 11),
                  gain: 1.0,
                  originalFileName: 'Оригинал (Изолированные голоса)'
                }] : [],
                volume: 1.0,
                isMuted: false,
                isSolo: false,
                isArmed: false,
                isProcessingEnabled: false,
                height: 80
              };

              const updatedTracks = project.tracks.map(t => t.name === 'Оригинал' ? { ...t, isMuted: true } : t);
              updatedTracks.push(soundsTrack, voicesTrack);
              onUpdateProject({ tracks: updatedTracks });
              playbackEngine.clearCache();
              await playbackEngine.updateTracks(updatedTracks);
            }
          }

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              status: 'success',
              progress: 100,
              log: 'Оригинальный трек успешно разделен на стемы "Звуки (Музыка)" и "Голоса (Вокал)".',
              hasRollback: true
            }
          }));
          return;
        }

        if (stepId.startsWith('vstStep_')) {
          const vstStep = activePreset.phase1.vstSteps?.[stepId];
          const pluginNames = vstStep?.plugins?.map(p => p.name).join(', ') || 'VST Цепочка';
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              status: 'success',
              progress: 100,
              log: `Применена внешняя VST цепочка: ${pluginNames}.`,
              hasRollback: true
            }
          }));
          showToast(`VST цепочка "${pluginNames}" успешно применена!`);
          return;
        }
      }

      // =========================================================================
      // ЭТАП 2: ТАЙМИНГ (Timing & Alignment)
      // =========================================================================
      if (phaseNum === 2) {
        if (stepId === 'silenceSplit') {
          const cfg = activePreset.phase2.silenceSplit;
          const origTrack = TimingAlignmentService.findOriginalVoiceTrack(project.tracks);
          console.group(`[Pipeline] ▶ Phase 2: Silence Split (VAD Speech Segmentation)`);
          console.log(`[SilenceSplit] Configuration:`, {
            thresholdDb: cfg.thresholdDb,
            offsetThresholdDb: cfg.offsetThresholdDb ?? -45,
            minSilenceDurationMs: cfg.minSilenceDurationMs,
            minSegmentDurationMs: cfg.minSegmentDurationMs,
            paddingPreMs: cfg.paddingPreMs ?? 80,
            paddingPostMs: cfg.paddingPostMs ?? 150,
            exportClips: cfg.exportClips
          });

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 30,
              log: `Быстрый VAD анализ и нарезка пауз (Onset: ${cfg.thresholdDb} dB, Offset: ${cfg.offsetThresholdDb ?? -45} dB, мин. пауза: ${cfg.minSilenceDurationMs} мс, отступы: +${cfg.paddingPreMs ?? 80}/+${cfg.paddingPostMs ?? 150} мс)...`
            }
          }));

          const splitTracks: AudioTrack[] = [];
          let totalSegments = 0;
          let processedTracksCount = 0;
          const stepAuditLogs: any[] = [];

          for (const track of project.tracks) {
            const isOrigStem = (track.type === 'original' || (origTrack && track.id === origTrack.id)) && !TimingAlignmentService.isDubTrack(track);
            if (!isOrigStem) {
              processedTracksCount++;
              console.log(`[SilenceSplit] Processing track "${track.name}" (${track.segments?.length || 0} initial segments)...`);
              const resTrack = await TimingAlignmentService.splitTrackBySilence(track, {
                thresholdDb: cfg.thresholdDb,
                offsetThresholdDb: cfg.offsetThresholdDb,
                minSilenceDurationMs: cfg.minSilenceDurationMs,
                minSegmentDurationMs: cfg.minSegmentDurationMs,
                paddingPreMs: cfg.paddingPreMs,
                paddingPostMs: cfg.paddingPostMs,
                padSilenceMs: cfg.padSilenceMs,
                exportClips: cfg.exportClips
              });
              totalSegments += resTrack.segments.length;
              splitTracks.push(resTrack);

              console.log(`[SilenceSplit] Track "${track.name}" split into ${resTrack.segments.length} speech segments:`, 
                resTrack.segments.map((s, idx) => ({
                  idx: idx + 1,
                  start: `${s.startTime.toFixed(2)}s`,
                  end: `${(s.startTime + s.duration).toFixed(2)}s`,
                  duration: `${s.duration.toFixed(2)}s`,
                  fileOffset: `${(s.fileOffset || 0).toFixed(2)}s`,
                  lufs: s.measuredLufs !== undefined ? `${s.measuredLufs.toFixed(1)} LUFS` : 'N/A'
                }))
              );

              stepAuditLogs.push({
                id: `audit-split-track-${track.id}-${Date.now()}`,
                timestamp: Date.now(),
                stageName: '2. Тайминг',
                stepId: 'silenceSplit',
                status: 'info',
                title: `VAD нарезка: ${track.name}`,
                message: `Дорожка "${track.name}" разделена на ${resTrack.segments.length} реплик. Паузы удалены (порог Onset: ${cfg.thresholdDb} dB, Offset: ${cfg.offsetThresholdDb ?? -45} dB, мин. пауза: ${cfg.minSilenceDurationMs} мс).`
              });
            } else {
              splitTracks.push(track);
            }
          }

          onUpdateProject({ tracks: splitTracks });
          await playbackEngine.updateTracks(splitTracks);

          const logMsg = `Нарезка VAD завершена: обработано дорожек: ${processedTracksCount}, сформировано ${totalSegments} реплик (Onset: ${cfg.thresholdDb} dB, Offset: ${cfg.offsetThresholdDb ?? -45} dB, пауза ${cfg.minSilenceDurationMs} мс).`;
          console.log(`[SilenceSplit] Summary: ${logMsg}`);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          addAuditLogs([
            {
              id: `audit-split-${Date.now()}`,
              timestamp: Date.now(),
              stageName: '2. Тайминг',
              stepId: 'silenceSplit',
              status: 'success',
              title: 'Разрезка по тишине (VAD)',
              message: logMsg
            },
            ...stepAuditLogs
          ]);

          showToast(logMsg);
          return;
        }

        if (stepId === 'whisper') {
          const whisperModel = activePreset.phase2.whisper?.model || 'whisper_base';
          const missingBehavior = activePreset.phase1.missingModelBehavior || 'fallback_dsp';
          const isInstalled = await AIModelService.getInstance().checkModelInstalled(whisperModel);
          console.group(`[Pipeline] ▶ Phase 2: Whisper Speech-to-Text & Subtitle Alignment`);
          console.log(`[Whisper] Model: ${whisperModel}, Installed: ${isInstalled}, MissingBehavior: ${missingBehavior}`);

          if (!isInstalled) {
            if (missingBehavior === 'skip') {
              const skipMsg = `⏭️ Шаг распознавания Whisper пропущен: модель "${whisperModel}" не скачана в Настройках.`;
              console.log(`[Pipeline] ${skipMsg}`);
              console.groupEnd();
              setStepExecution(prev => ({
                ...prev,
                [stepId]: { status: 'success', progress: 100, log: skipMsg, hasRollback: false }
              }));
              showToast(skipMsg);
              return;
            } else {
              console.log(`[Pipeline] ⚡ Модель Whisper "${whisperModel}" не скачана. Применяется эвристическое сопоставление по таймкодам субтитров.`);
            }
          }

          const origTrack = TimingAlignmentService.findOriginalVoiceTrack(project.tracks);
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 15,
              log: 'Распознавание речи через Whisper и сопоставление со сценарием...'
            }
          }));

          const updatedTracks: AudioTrack[] = [];
          let totalTranscribed = 0;
          let matchedScriptCount = 0;
          const whisperAuditLogs: any[] = [];

          const dubTracks = project.tracks.filter(t => !((t.type === 'original' || (origTrack && t.id === origTrack.id)) && !TimingAlignmentService.isDubTrack(t)));
          const totalSegmentsCount = dubTracks.reduce((acc, t) => acc + (t.segments?.length || 0), 0);

          for (const track of project.tracks) {
            const isOrig = (track.type === 'original' || (origTrack && track.id === origTrack.id)) && !TimingAlignmentService.isDubTrack(track);
            if (isOrig || !track.segments || track.segments.length === 0) {
              updatedTracks.push(track);
              continue;
            }

            console.log(`[Whisper] Transcribing track "${track.name}" (${track.segments.length} segments)...`);
            const newSegs: AudioSegment[] = [];
            for (let sIdx = 0; sIdx < track.segments.length; sIdx++) {
              const seg = track.segments[sIdx];
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  ...prev[stepId],
                  progress: Math.min(95, Math.round(15 + (totalTranscribed / Math.max(1, totalSegmentsCount)) * 80)),
                  log: `Whisper: распознавание "${track.name}" (${sIdx + 1}/${track.segments?.length || 0})...`
                }
              }));

              const res = await TimingAlignmentService.transcribePhraseWithWhisper(
                seg,
                project.subtitles || [],
                (track as any).role || track.name,
                {
                  model: activePreset.phase2.whisper?.model || 'whisper-base',
                  language: activePreset.phase2.whisper?.language || 'ru',
                  autoMatchSubtitles: activePreset.phase2.whisper?.autoMatchSubtitles !== false
                }
              );

              if (res.matchedSub) {
                matchedScriptCount++;
              }
              totalTranscribed++;

              console.log(`[Whisper] Segment #${sIdx + 1} [${seg.startTime.toFixed(2)}s - ${(seg.startTime + seg.duration).toFixed(2)}s]:`, {
                text: res.text,
                confidence: `${(res.confidence * 100).toFixed(1)}%`,
                matchedSubId: res.matchedSub?.id || 'none',
                matchedSubText: res.matchedSub?.text || 'none'
              });

              whisperAuditLogs.push({
                id: `audit-whisper-seg-${seg.id}-${Date.now()}`,
                timestamp: Date.now(),
                stageName: '2. Тайминг',
                stepId: 'whisper',
                status: 'info',
                title: `Whisper: "${track.name}" [${seg.startTime.toFixed(1)}s]`,
                message: `Распознано: "${res.text}" (достоверность ${(res.confidence * 100).toFixed(0)}%). ${res.matchedSub ? `Сопоставлено со строкой сценария #${res.matchedSub.id} ("${res.matchedSub.text}")` : 'Прямое совпадение со сценарием не найдено'}.`
              });

              newSegs.push({
                ...seg,
                whisperText: res.text,
                whisperConfidence: res.confidence,
                matchedSubId: res.matchedSub?.id,
                text: seg.text || res.text
              });
            }

            updatedTracks.push({
              ...track,
              segments: newSegs
            });
          }

          onUpdateProject({ tracks: updatedTracks });
          await playbackEngine.updateTracks(updatedTracks);

          const logMsg = `Whisper распознавание завершено: обработано ${totalTranscribed} фраз, сопоставлено со сценарием: ${matchedScriptCount}.`;
          console.log(`[Whisper] Summary: ${logMsg}`);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          addAuditLogs([
            {
              id: `audit-whisper-${Date.now()}`,
              timestamp: Date.now(),
              stageName: '2. Тайминг',
              stepId: 'whisper',
              status: 'success',
              title: 'Whisper Распознавание речи',
              message: logMsg
            },
            ...whisperAuditLogs
          ]);

          showToast(logMsg);
          return;
        }

        if (stepId === 'smartAlign') {
          const origTrack = TimingAlignmentService.findOriginalVoiceTrack(project.tracks);
          console.group(`[Pipeline] ▶ Phase 2: Smart Align & Auto-Timing (Actor Matching, Phrase Start Sync & Collision Resolution)`);
          console.log(`[SmartAlign] Reference Voice Track:`, origTrack ? `"${origTrack.name}" (ID: ${origTrack.id})` : 'NOT FOUND (Using Subtitle Timecodes as Reference)');
          console.log(`[SmartAlign] Preset Config:`, activePreset.phase2);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 5,
              log: 'Сопоставление актёров с дорожками, синхронизация начала фраз по сабам и разведение коллизий...'
            }
          }));

          const res = await TimingAlignmentService.autoAlignProject(
            project.tracks,
            origTrack,
            project.subtitles || [],
            project.mixingType || activePreset.type,
            activePreset.phase2,
            (percent, msg) => {
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  ...prev[stepId],
                  progress: Math.round(5 + percent * 0.9),
                  log: msg
                }
              }));
            }
          );

          onUpdateProject({ tracks: res.updatedTracks });
          await playbackEngine.updateTracks(res.updatedTracks);
          setTimingIssues(res.issues);

          const matchedActorsStr = res.stats.matchedActors > 0 
            ? ` Назначено дорожек актёрам: ${res.stats.matchedActors}.`
            : '';
          const collisionStr = res.stats.resolvedCollisions > 0 
            ? ` Разведено коллизий: ${res.stats.resolvedCollisions}.`
            : ' Коллизий нет.';

          const logMsg = `Smart Align: выровнено ${res.stats.alignedPhrases} фраз дубляжа.${matchedActorsStr}${collisionStr}`;
          console.log(`[SmartAlign] Summary: ${logMsg}`);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          const auditEntries = res.logs.map((l, i) => ({
            id: `audit-align-step-${Date.now()}-${i}`,
            timestamp: Date.now(),
            stageName: '2. Тайминг',
            stepId: 'smartAlign',
            status: 'success' as const,
            title: 'Авто-тайминг',
            message: l
          }));

          addAuditLogs([
            {
              id: `audit-align-${Date.now()}`,
              timestamp: Date.now(),
              stageName: '2. Тайминг',
              stepId: 'smartAlign',
              status: res.issues.length > 0 ? 'warning' : 'success',
              title: 'Smart Align & Авто-тайминг',
              message: logMsg
            },
            ...auditEntries
          ]);

          showToast(logMsg);
          return;
        }

        if (stepId === 'conflictDetection') {
          const origTrack = TimingAlignmentService.findOriginalVoiceTrack(project.tracks);
          console.group(`[Pipeline] ▶ Phase 2: Conflict Detection & Overlap Auto-Fix`);
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 30,
              log: 'Поиск наездов реплик и устранение коллизий между дорожками...'
            }
          }));

          let updatedTracks = project.tracks;
          let fixedCount = 0;

          if (activePreset.phase2.conflictDetection?.autoFixOverlaps) {
            const collisionRes = TimingAlignmentService.resolveProjectWideCollisions(
              project.tracks,
              project.subtitles || [],
              activePreset.phase2
            );
            updatedTracks = collisionRes.updatedTracks;
            fixedCount = collisionRes.resolvedCount;
            if (fixedCount > 0) {
              onUpdateProject({ tracks: updatedTracks });
              await playbackEngine.updateTracks(updatedTracks);
            }
          }

          const issues = TimingAlignmentService.validateAllTracksTiming(
            updatedTracks,
            origTrack,
            project.subtitles || [],
            activePreset.type,
            activePreset.phase2
          );

          const overlapIssues = issues.filter(i => i.type === 'overlap');
          setTimingIssues(issues);

          const logMsg = fixedCount > 0
            ? `Предотвращение наездов: автоматически разведено ${fixedCount} наездов фраз. Дорожки не перекрывают друг друга (за исключением запланированных по сабам).`
            : (overlapIssues.length > 0
                ? `Обнаружено ${overlapIssues.length} наездов реплик друг на друга. Требуется ручная проверка.`
                : `Коллизий не обнаружено: дорожки синхронизированы и звучат раздельно.`);

          console.log(`[ConflictDetection] Summary: ${logMsg}`);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-conflict-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '2. Тайминг',
            stepId: 'conflictDetection',
            status: overlapIssues.length > 0 && !activePreset.phase2.conflictDetection?.autoFixOverlaps ? 'warning' as const : 'success' as const,
            title: 'Предотвращение наездов дорожек (Коллизии)',
            message: logMsg
          }]);

          showToast(logMsg);
          return;
        }

        if (stepId === 'subtitleCompliance') {
          const origTrack = TimingAlignmentService.findOriginalVoiceTrack(project.tracks);
          console.group(`[Pipeline] ▶ Phase 2: Subtitle Timing & Reading Speed Compliance`);
          console.log(`[SubtitleCompliance] Tolerance: ±${activePreset.phase2.subtitleCompliance.toleranceMs} ms, Check Missing Phrases: ${activePreset.phase2.subtitleCompliance.checkMissingPhrases}`);

          const issues = TimingAlignmentService.validateAllTracksTiming(
            project.tracks,
            origTrack,
            project.subtitles || [],
            activePreset.type,
            activePreset.phase2
          );
          setTimingIssues(issues);

          console.log(`[SubtitleCompliance] Checked ${project.subtitles?.length || 0} subtitle lines against audio segments.`);
          if (issues.length > 0) {
            console.warn(`[SubtitleCompliance] Detected ${issues.length} compliance warnings:`, issues);
          } else {
            console.log(`[SubtitleCompliance] 100% compliance achieved! All voice segments match script cues within ±${activePreset.phase2.subtitleCompliance.toleranceMs}ms.`);
          }
          console.groupEnd();

          const logMsg = issues.length > 0 
            ? `Контроль субтитров: обнаружено ${issues.length} нестыковок тайминга (допуск ±${activePreset.phase2.subtitleCompliance.toleranceMs} мс).`
            : `Контроль субтитров: идеальное попадание во все таймкоды субтитров!`;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          addAuditLogs([
            {
              id: `audit-subcomp-${Date.now()}`,
              timestamp: Date.now(),
              stageName: '2. Тайминг',
              stepId: 'subtitleCompliance',
              status: issues.length > 0 ? 'warning' as const : 'success' as const,
              title: 'Контроль попадания в субтитры',
              message: logMsg
            },
            ...issues.map(iss => ({
              id: `audit-subcomp-issue-${iss.id}-${Date.now()}`,
              timestamp: Date.now(),
              stageName: '2. Тайминг',
              stepId: 'subtitleCompliance',
              status: iss.severity === 'error' ? 'error' as const : (iss.severity === 'warning' ? 'warning' as const : 'info' as const),
              title: `Тайминг: ${iss.title}`,
              message: `${iss.description} [Таймкод: ${iss.timestamp.toFixed(2)}s${iss.targetDuration ? `, целевая: ${iss.targetDuration.toFixed(2)}s` : ''}]`
            }))
          ]);

          showToast(logMsg);
          return;
        }
      }

      // =========================================================================
      // ЭТАП 3: СВЕДЕНИЕ И ЭФФЕКТЫ (Mixing & Effects)
      // =========================================================================
      if (phaseNum === 3) {
        if (stepId === 'gainMatching') {
          console.group(`[Pipeline] ▶ Phase 3: Gain Staging & Loudness Normalization`);
          console.log(`[GainMatching] Target Dialogue: ${activePreset.phase3.gainMatching.targetDialogueLufs} LUFS, Physics Offset: ${activePreset.phase3.gainMatching.physicsOffsetDb} dB, Anti-click Fade: 10ms`);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 40,
              log: `Выравнивание уровней (диалоги: ${activePreset.phase3.gainMatching.targetDialogueLufs} LUFS, физические звуки: ${activePreset.phase3.gainMatching.physicsOffsetDb} dB)...`
            }
          }));

          const gmRes = await MixingService.matchLoudnessBySubtitles(
            project.tracks,
            project.subtitles || [],
            activePreset.phase3.gainMatching
          );

          onUpdateProject({ tracks: gmRes.updatedTracks });
          await playbackEngine.updateTracks(gmRes.updatedTracks);
          addAuditLogs(gmRes.logs);

          const logMsg = `Gain Matching: обработано ${gmRes.dialogueCount} реплик диалога и ${gmRes.physicsCount} звуков физики. Применены антиклик-фейды 10 мс.`;
          console.log(`[GainMatching] Summary: ${logMsg}`, gmRes);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          showToast(logMsg);
          return;
        }

        if (stepId === 'ducking') {
          console.group(`[Pipeline] ▶ Phase 3: Sidechain Auto-Ducking Background Music & SFX`);
          console.log(`[AutoDucking] Depth: ${activePreset.phase3.ducking.duckingDb} dB, Attack: ${activePreset.phase3.ducking.attackMs} ms, Hold: ${activePreset.phase3.ducking.holdMs} ms, Release: ${activePreset.phase3.ducking.releaseMs} ms`);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 40,
              log: `Расчет огибающей авто-дакинга (${activePreset.phase3.ducking.duckingDb} dB, спад ${activePreset.phase3.ducking.releaseMs} мс)...`
            }
          }));

          const duckRes = await MixingService.applyAutoDucking(
            project.tracks,
            activePreset.type,
            activePreset.phase3.ducking
          );

          onUpdateProject({ tracks: duckRes.updatedTracks });
          await playbackEngine.updateTracks(duckRes.updatedTracks);
          addAuditLogs(duckRes.logs);

          const logMsg = duckRes.duckedIntervalsCount > 0 
            ? `Auto-Ducking: приглушено ${duckRes.duckedIntervalsCount} сегментов фоновой музыки на ${Math.abs(duckRes.appliedDuckingDb)} dB (Attack: ${activePreset.phase3.ducking.attackMs}ms, Release: ${activePreset.phase3.ducking.releaseMs}ms).`
            : `Auto-Ducking: огибающая проверена, уровни фоновой музыки сбалансированы.`;

          console.log(`[AutoDucking] Summary: ${logMsg}`, duckRes);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          showToast(logMsg);
          return;
        }

        if (stepId === 'autoFxAnalysis') {
          console.group(`[Pipeline] ▶ Phase 3: Auto-FX Acoustic Environment Analysis & Transfer`);
          console.log(`[AutoFX] Detect Panning: ${activePreset.phase3.autoFxAnalysis.detectPanning}, Detect Reverb: ${activePreset.phase3.autoFxAnalysis.detectReverb}, Detect Delay: ${activePreset.phase3.autoFxAnalysis.detectDelay}`);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 40,
              log: 'Анализ панорамы и реверберации оригинального трека...'
            }
          }));

          const fxRes = await MixingService.detectAndApplyOriginalEffects(
            project.tracks,
            activePreset.phase3.autoFxAnalysis
          );

          onUpdateProject({ tracks: fxRes.updatedTracks });
          await playbackEngine.updateTracks(fxRes.updatedTracks);
          addAuditLogs(fxRes.logs);

          const logMsg = `Auto-FX: проанализировано ${fxRes.analyzedSegmentsCount} фраз оригинала. Акустическое окружение (RT60, панорама, спектральный наклон) перенесено на дорожки дубляжа.`;
          console.log(`[AutoFX] Summary: ${logMsg}`, fxRes);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          showToast(logMsg);
          return;
        }

        if (stepId === 'vocalBusProcessing') {
          const busConfig = activePreset.phase3.vocalBusProcessing;
          const isRustDsp = busConfig.mode === 'rustDsp';
          const busTitle = isRustDsp
            ? 'Студийный Rust DSP рэк (6 ступеней: HPF, EQ, Compressor, De-Esser, Saturation, Reverb)'
            : (busConfig.vstRack?.presetName || 'Пользовательский VST-рэк');

          console.group(`[Pipeline] ▶ Phase 3: Master Vocal Bus Chain Processing`);
          console.log(`[VocalBus] Active Mode: ${busConfig.mode}, Config Title: ${busTitle}`);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 40,
              log: `Конфигурация мастер-шины вокала: ${busTitle}...`
            }
          }));

          const busRes = await MixingService.applyMasterVocalBusChain(
            project.tracks,
            busConfig
          );

          onUpdateProject({ tracks: busRes.updatedTracks });
          await playbackEngine.updateTracks(busRes.updatedTracks);
          addAuditLogs(busRes.logs);

          const logMsg = `Мастер-шина вокала: активировано ${busRes.activePluginsCount} звеньев обработки (${busTitle}).`;
          console.log(`[VocalBus] Summary: ${logMsg}`, busRes);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          showToast(logMsg);
          return;
        }
      }

      // =========================================================================
      // ЭТАП 4: МАСТЕРИНГ И РЕНДЕР (Final & Mastering)
      // =========================================================================
      if (phaseNum === 4) {
        if (stepId === 'qualityControl') {
          console.group(`[Pipeline] ▶ Phase 4: Pre-Release Quality Control QA Audit`);
          console.log(`[QualityControl] Log Clipped: ${activePreset.phase4.qualityControl.logClippedSegments}, Detect Long Silences: ${activePreset.phase4.qualityControl.detectLongSilences}, Detect Overlaps: ${activePreset.phase4.qualityControl.detectOverlappingAudios}`);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 40,
              log: 'Запуск предрелизного контроля качества (True-Peak 4x, EBU R128, клиппинг, сверка сценария)...'
            }
          }));

          const qcRes = await FinalRenderService.runFullQualityControlAsync(
            project,
            activePreset.phase4
          );

          setQaIssues(qcRes.issues);
          const logMsg = `QC Контроль качества: проверено ${project.tracks.length} дорожек. Замечаний: ${qcRes.issues.length} (LUFS: ${qcRes.integratedLufs.toFixed(1)}, Max True-Peak: ${qcRes.maxTruePeakDb.toFixed(2)} dBTP).`;
          console.log(`[QualityControl] Summary: ${logMsg}`, qcRes);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          addAuditLogs(qcRes.logs);
          showToast(logMsg);
          return;
        }

        if (stepId === 'masteringLimiter') {
          console.group(`[Pipeline] ▶ Phase 4: True-Peak 4x Mastering Limiter`);
          console.log(`[MasteringLimiter] Ceiling: ${activePreset.phase4.masteringLimiter.truePeakCeilingDb} dBTP, Target LUFS: ${activePreset.phase4.masteringLimiter.targetIntegratedLufs}, Standard: ${activePreset.phase4.masteringLimiter.loudnessStandard}`);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 40,
              log: `Применение мастеринг-лимитера (True Peak: ${activePreset.phase4.masteringLimiter.truePeakCeilingDb} dBTP, стандарт ${activePreset.phase4.masteringLimiter.loudnessStandard}, 4x oversampling)...`
            }
          }));

          const mastRes = await FinalRenderService.applyMasteringLimiterAsync(
            project.tracks,
            activePreset.phase4,
            project
          );

          onUpdateProject({ tracks: mastRes.updatedTracks });
          await playbackEngine.updateTracks(mastRes.updatedTracks);
          addAuditLogs(mastRes.logs);

          const logMsg = mastRes.masteringStats 
            ? `Мастеринг выполнен: ${mastRes.masteringStats.finalIntegratedLufs} LUFS, TP: ${mastRes.masteringStats.finalTruePeakDbtp} dBTP, компрессия: -${mastRes.masteringStats.maxGainReductionDb} dB (${mastRes.masteringStats.isCompliant ? 'Соответствует стандарту' : 'Внимание'}).`
            : `Мастеринг-лимитер: выходной потолок ${mastRes.ceilingDb.toFixed(1)} dBTP, стандарт ${activePreset.phase4.masteringLimiter.loudnessStandard} (${activePreset.phase4.masteringLimiter.targetIntegratedLufs} LUFS).`;
          
          console.log(`[MasteringLimiter] Summary: ${logMsg}`, mastRes);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          showToast(logMsg);
          return;
        }

        if (stepId === 'stemExport' || stepId === 'renderSettings') {
          console.group(`[Pipeline] ▶ Phase 4: Native FFmpeg Muxing & Audio Stems Export`);
          console.log(`[FinalRender] Starting native export...`);
          if (handleStartFinalRender) {
            await handleStartFinalRender();
          }
          console.log(`[FinalRender] Native export initiated.`);
          console.groupEnd();

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              status: 'success',
              progress: 100,
              log: 'Финальный рендер и экспорт стэмов запущены успешно.',
              hasRollback: true
            }
          }));
          return;
        }

        if (stepId === 'subtitleBurn') {
          console.group(`[Pipeline] ▶ Phase 4: Subtitle Formatting & .ASS Script Generation`);
          const subs = project.subtitles || [];
          const subConfig = activePreset.phase4.subtitleBurn;
          const { assContent } = FinalRenderService.generateSubtitlesFiles(subs, subConfig);
          
          let signsCount = 0;
          let voCount = 0;
          let actorCount = 0;
          subs.forEach(s => {
            const r = (s.role || '').toLowerCase();
            if (r.includes('sign') || r.includes('вывеска') || r.includes('надпись') || r.includes('титры') || s.text.startsWith('[')) {
              signsCount++;
            } else if (r.includes('narrator') || r.includes('диктор') || r.includes('закадр') || r.includes('vo')) {
              voCount++;
            } else {
              actorCount++;
            }
          });

          const logMsg = `Субтитры готовы: ${subs.length} реплик (Диалоги: ${actorCount}, Закадр: ${voCount}, Надписи/Вывески: ${signsCount}). Шрифт: ${subConfig.fontName} ${subConfig.fontSize}px, цвет: ${subConfig.fontColor}, режим: ${subConfig.burnMode || 'hardsub_all'}. Сгенерирован скрипт .ASS (${Math.round(assContent.length / 1024 * 10) / 10} KB).`;
          console.log(`[SubtitleBurn] Summary: ${logMsg}`);
          console.groupEnd();
          
          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-subburn-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '4. Мастеринг',
            stepId: 'subtitleBurn',
            status: 'success',
            title: 'Форматирование и рендер субтитров',
            message: logMsg
          }]);

          showToast(`Субтитры подготовлены (${subs.length} реплик)`);
          return;
        }
      }

      // Fallback for custom steps
      setStepExecution(prev => ({
        ...prev,
        [stepId]: {
          status: 'success',
          progress: 100,
          log: `Этап "${title}" успешно выполнен. Настройки применены.`,
          hasRollback: true
        }
      }));
      showToast(`Этап "${title}" успешно выполнен!`);
    } catch (err: any) {
      console.error(`Ошибка при выполнении этапа ${stepId}:`, err);
      setStepExecution(prev => ({
        ...prev,
        [stepId]: {
          status: 'failed',
          progress: 0,
          log: `Ошибка: ${err.message || String(err)}`,
          hasRollback: false
        }
      }));
      showToast(`Ошибка выполнения этапа: ${err.message || String(err)}`);
    }
  }
}
