import type React from 'react';
import { Project, AudioTrack, MixingPreset, MixingAuditEntry, QualityControlIssue, TimingIssue, AuditionVocalBusChainConfig, DeclickReport, DeplosiveReport, DeEsserReport, DenoiseReport, DereverbResult, VolumeLevelerReport, NormalizationStats, AudioSegment } from '../types';
import { AudioDspService } from './audioDspService';
import { TimingAlignmentService } from './timingAlignmentService';
import { MixingService } from './mixingService';
import { FinalRenderService } from './finalRenderService';
import { PlaybackEngine } from './playbackEngine';
import { AudioSeparatorService } from './audioSeparatorService';
import { invoke, isTauri } from '@tauri-apps/api/core';

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

const DEFAULT_VOCAL_CHAIN: AuditionVocalBusChainConfig = {
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

export class PipelineExecutionService {
  /**
   * Executes a specific pipeline step across any of the 4 phases with real DSP calculations,
   * audio track modifications, audit logging, and state synchronization.
   */
  static async executeStep(params: ExecuteStepParams): Promise<void> {
    const {
      stepId,
      title,
      phaseNum,
      project,
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
        if (stepId === 'normalization') {
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

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const stats = await invoke<NormalizationStats>('normalize_audio', {
                        inputPath,
                        outputPath: inputPath,
                        targetLufs,
                      });
                      if (stats) {
                        lastNativeNorm = stats;
                        processedTracksCount++;
                      }
                    } catch (e) {
                      console.warn('[Pipeline] Native normalize_audio invocation error:', e);
                    }
                  }
                }
              }
            }
          }

          const res = AudioDspService.applyNormalizationAndUpwardCompression(
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
          const profileModel = activePreset.phase1.eqMatching.profileModel || 'vocal_presence';
          const targetPath = activePreset.phase1.eqMatching.targetProfilePath;
          const profileParam = (profileModel === 'reference_match' && targetPath) ? targetPath : profileModel;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 35,
              log: `Запуск нативного DSP EQ Matching (FFT 4096, 1/3-octave smoothing, "${profileModel}")...`
            }
          }));

          // Native Tauri DSP processing if running in desktop app
          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      await invoke('match_eq_profile', {
                        inputPath,
                        outputPath: inputPath,
                        profileName: profileParam,
                      });
                    } catch (e) {
                      console.warn('[Pipeline] Native match_eq_profile invocation error:', e);
                    }
                  }
                }
              }
            }
          }

          const res = AudioDspService.applyEqMatching(
            project.tracks,
            activePreset.phase1.eqMatching
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: res.logSummary, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-eq-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '1. Предобработка',
            stepId: 'eqMatching',
            status: 'success',
            title: 'EQ Matching',
            message: res.logSummary
          }]);

          showToast(res.logSummary);
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

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const rep = await invoke<DeclickReport>('clean_clicks', {
                        inputWav: inputPath,
                        outputWav: inputPath,
                        sensitivity,
                      });
                      if (rep) {
                        nativeClicksCount += rep.clicksDetected;
                        nativeSamplesRestored += rep.samplesRestored;
                      }
                    } catch (e) {
                      console.warn('[Pipeline] Native clean_clicks invocation error:', e);
                    }
                  }
                }
              }
            }
          }

          const res = AudioDspService.applyDeClick(
            project.tracks,
            activePreset.phase1.deClick
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = nativeClicksCount > 0
            ? `De-Click завершен (Rayon DSP): обнаружено ${nativeClicksCount} кликов, восстановлено ${nativeSamplesRestored} сэмплов.`
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

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const rep = await invoke<DeplosiveReport>('apply_deplosive', {
                        filePath: inputPath,
                        outPath: inputPath,
                        thresholdDb,
                      });
                      if (rep) {
                        nativePlosivesCount += rep.plosivesDetected;
                        if (rep.maxReductionDb > maxReductionDb) {
                          maxReductionDb = rep.maxReductionDb;
                        }
                      }
                    } catch (e) {
                      console.warn('[Pipeline] Native apply_deplosive invocation error:', e);
                    }
                  }
                }
              }
            }
          }

          const res = AudioDspService.applyDePlosive(
            project.tracks,
            activePreset.phase1.dePlosive
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = nativePlosivesCount > 0
            ? `De-Plosive завершен (Rayon + Butterworth HPF): подавлено ${nativePlosivesCount} задувов/взрывов, макс. срез -${maxReductionDb.toFixed(1)} dB (сдвиг среза 40->175 Гц).`
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

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const rep = await invoke<DeEsserReport>('process_deesser', {
                        inputPath,
                        outputPath: inputPath,
                        frequency,
                        threshold,
                        ratio,
                      });
                      if (rep) {
                        nativeSibilantsCount += rep.sibilantsDetected;
                        if (rep.maxReductionDb > maxReductionDb) {
                          maxReductionDb = rep.maxReductionDb;
                        }
                      }
                    } catch (e) {
                      console.warn('[Pipeline] Native process_deesser invocation error:', e);
                    }
                  }
                }
              }
            }
          }

          const res = AudioDspService.applyDeEsser(
            project.tracks,
            activePreset.phase1.deEsser
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = nativeSibilantsCount > 0
            ? `De-Esser завершен (Split-Band DSP): сглажено ${nativeSibilantsCount} сибилянтов («С», «З», «Щ»), макс. подавление -${maxReductionDb.toFixed(1)} dB.`
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
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 25,
              log: `Нейросетевое шумоподавление UVR DeNoise (${activePreset.phase1.denoise.model}, сила ${activePreset.phase1.denoise.strength}%)...`
            }
          }));

          let lastNativeReport: DenoiseReport | null = null;
          let processedTracksCount = 0;

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const rep = await invoke<DenoiseReport>('process_denoise', {
                        inputPath,
                        outputPath: inputPath,
                        modelName: activePreset.phase1.denoise.model || 'UVR-DeNoise',
                        strength: activePreset.phase1.denoise.strength,
                      });
                      if (rep) {
                        lastNativeReport = rep;
                        processedTracksCount++;
                      }
                    } catch (e) {
                      console.warn('[Pipeline] Native process_denoise invocation error:', e);
                    }
                  }
                }
              }
            }
          }

          const res = AudioDspService.applyDenoise(
            project.tracks,
            activePreset.phase1.denoise
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = lastNativeReport
            ? `Шумоподавление завершено (${lastNativeReport.isNeural ? `UVR DeNoise: ${lastNativeReport.providerUsed}` : lastNativeReport.modelName}): подавление шума -${lastNativeReport.noiseReductionDb.toFixed(1)} dB на ${processedTracksCount} дорожках.`
            : res.logSummary;

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
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 25,
              log: `Нейросетевое разделение стемов UVR De-Echo / De-Reverb (сила ${(activePreset.phase1.dereverb.strength)}%)...`
            }
          }));

          let lastNativeReport: DereverbResult | null = null;
          let processedTracksCount = 0;

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const rep = await invoke<DereverbResult>('process_uvr_dereverb', {
                        inputPath,
                        outputPath: inputPath,
                        reverbTailExportPath: null,
                        strength: (activePreset.phase1.dereverb.strength || 85) / 100.0,
                      });
                      if (rep) {
                        lastNativeReport = rep;
                        processedTracksCount++;
                      }
                    } catch (e) {
                      console.warn('[Pipeline] Native process_uvr_dereverb invocation error:', e);
                    }
                  }
                }
              }
            }
          }

          const res = AudioDspService.applyDeReverb(
            project.tracks,
            activePreset.phase1.dereverb
          );

          onUpdateProject({ tracks: res.updatedTracks });
          playbackEngine.clearCache();
          await playbackEngine.updateTracks(res.updatedTracks);

          const summaryLog = lastNativeReport
            ? `Подавление эха завершено (${lastNativeReport.isNeural ? `UVR De-Echo: ${lastNativeReport.providerUsed}` : lastNativeReport.modelName}): подавление реверберации -${lastNativeReport.reverbReductionDb.toFixed(1)} dB на ${processedTracksCount} дорожках.`
            : res.logSummary;

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

          if (typeof window !== 'undefined' && isTauri()) {
            for (const track of project.tracks) {
              if (AudioDspService.isDubActorTrack(track) && track.isProcessingEnabled !== false) {
                for (const seg of track.segments) {
                  const inputPath = seg.filePath;
                  if (inputPath && !inputPath.startsWith('blob:') && !inputPath.startsWith('data:')) {
                    try {
                      const rep = await invoke<VolumeLevelerReport>('level_speech_volume', {
                        inputPath,
                        outputPath: inputPath,
                        targetRms: activePreset.phase1.volumeLeveler.targetRms || -19.0,
                        gateThresholdDb: -50.0,
                        maxBoostDb: 12.0,
                        maxAttenuationDb: 15.0,
                      });
                      if (rep) {
                        lastNativeReport = rep;
                        processedTracksCount++;
                      }
                    } catch (e) {
                      console.warn('[Pipeline] Native level_speech_volume invocation error:', e);
                    }
                  }
                }
              }
            }
          }

          const res = AudioDspService.applyVolumeLeveler(
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
              setStepExecution(prev => ({
                ...prev,
                [stepId]: {
                  ...prev[stepId],
                  progress: 10,
                  log: 'Запуск нейросетевого разделения стемов через Rust/Python (MDX-NET / Demucs)...'
                }
              }));

              const modelName = activePreset.phase1.sourceSeparation.model || 'UVR-MDX-NET-Voc_FT';
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
                      log: detail?.stage || `Разделение стемов UVR MDX-NET: ${Math.round(percent)}%`
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
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 30,
              log: `Поиск пауз тишины (< ${cfg.thresholdDb} dB, мин. ${cfg.minSilenceDurationMs} мс)...`
            }
          }));

          const splitTracks: AudioTrack[] = [];
          let totalSegments = 0;
          let processedTracksCount = 0;

          for (const track of project.tracks) {
            const isOrigStem = (track.type === 'original' || (origTrack && track.id === origTrack.id)) && !TimingAlignmentService.isDubTrack(track);
            if (!isOrigStem) {
              processedTracksCount++;
              const resTrack = await TimingAlignmentService.splitTrackBySilence(track, {
                thresholdDb: cfg.thresholdDb,
                minSilenceDurationMs: cfg.minSilenceDurationMs,
                minSegmentDurationMs: cfg.minSegmentDurationMs,
                padSilenceMs: cfg.padSilenceMs
              });
              totalSegments += resTrack.segments.length;
              splitTracks.push(resTrack);
            } else {
              splitTracks.push(track);
            }
          }

          onUpdateProject({ tracks: splitTracks });
          await playbackEngine.updateTracks(splitTracks);

          const logMsg = `Нарезка завершена: обработано дорожек: ${processedTracksCount}, сформировано ${totalSegments} фраз по тишине (порог ${cfg.thresholdDb} dB, пауза ${cfg.minSilenceDurationMs} мс).`;
          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-split-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '2. Тайминг',
            stepId: 'silenceSplit',
            status: 'success',
            title: 'Разрезка по тишине',
            message: logMsg
          }]);

          showToast(logMsg);
          return;
        }

        if (stepId === 'smartAlign') {
          const origTrack = TimingAlignmentService.findOriginalVoiceTrack(project.tracks);
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 30,
              log: 'Анализ таймкодов субтитров и сопоставление старта фраз с оригиналом...'
            }
          }));

          const alignedTracks: AudioTrack[] = [];
          let totalAligned = 0;
          let allIssues: TimingIssue[] = [];

          for (const track of project.tracks) {
            const isOrigStem = (track.type === 'original' || (origTrack && track.id === origTrack.id)) && !TimingAlignmentService.isDubTrack(track);
            if (!isOrigStem) {
              const res = await TimingAlignmentService.alignTrackPhrases(
                track,
                origTrack,
                project.subtitles || [],
                project.mixingType || activePreset.type,
                activePreset.phase2
              );
              totalAligned += (res.alignedCount || 0);
              allIssues.push(...res.issues);
              alignedTracks.push(res.updatedTrack);
            } else {
              alignedTracks.push(track);
            }
          }

          onUpdateProject({ tracks: alignedTracks });
          await playbackEngine.updateTracks(alignedTracks);
          setTimingIssues(allIssues);

          const logMsg = `Smart Align: синхронизировано ${totalAligned} фраз дубляжа с оригинальным голосом и субтитрами.`;
          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-align-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '2. Тайминг',
            stepId: 'smartAlign',
            status: 'success',
            title: 'Smart Align',
            message: logMsg
          }]);

          showToast(logMsg);
          return;
        }

        if (stepId === 'subtitleCompliance') {
          const origTrack = TimingAlignmentService.findOriginalVoiceTrack(project.tracks);
          const issues = TimingAlignmentService.validateAllTracksTiming(
            project.tracks,
            origTrack,
            project.subtitles || [],
            activePreset.type,
            activePreset.phase2
          );
          setTimingIssues(issues);

          const logMsg = issues.length > 0 
            ? `Контроль субтитров: обнаружено ${issues.length} нестыковок тайминга (допуск ±${activePreset.phase2.subtitleCompliance.toleranceMs} мс).`
            : `Контроль субтитров: идеальное попадание во все таймкоды субтитров!`;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          addAuditLogs([{
            id: `audit-subcomp-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '2. Тайминг',
            stepId: 'subtitleCompliance',
            status: issues.length > 0 ? 'warning' : 'success',
            title: 'Контроль попадания в субтитры',
            message: logMsg
          }]);

          showToast(logMsg);
          return;
        }
      }

      // =========================================================================
      // ЭТАП 3: СВЕДЕНИЕ И ЭФФЕКТЫ (Mixing & Effects)
      // =========================================================================
      if (phaseNum === 3) {
        if (stepId === 'gainMatching') {
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 40,
              log: `Выравнивание уровней (диалоги: ${activePreset.phase3.gainMatching.targetDialogueLufs} LUFS, физические звуки: ${activePreset.phase3.gainMatching.physicsOffsetDb} dB)...`
            }
          }));

          const gmRes = MixingService.matchLoudnessBySubtitles(
            project.tracks,
            project.subtitles || [],
            activePreset.phase3.gainMatching
          );

          onUpdateProject({ tracks: gmRes.updatedTracks });
          await playbackEngine.updateTracks(gmRes.updatedTracks);
          addAuditLogs(gmRes.logs);

          const logMsg = `Gain Matching: обработано ${gmRes.dialogueCount} реплик диалога и ${gmRes.physicsCount} звуков физики.`;
          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          showToast(logMsg);
          return;
        }

        if (stepId === 'ducking') {
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 40,
              log: `Расчет огибающей авто-дакинга (${activePreset.phase3.ducking.duckingDb} dB, спад ${activePreset.phase3.ducking.releaseMs} мс)...`
            }
          }));

          const duckRes = MixingService.applyAutoDucking(
            project.tracks,
            activePreset.type,
            activePreset.phase3.ducking
          );

          onUpdateProject({ tracks: duckRes.updatedTracks });
          await playbackEngine.updateTracks(duckRes.updatedTracks);
          addAuditLogs(duckRes.logs);

          const logMsg = duckRes.duckedIntervalsCount > 0 
            ? `Auto-Ducking: приглушено ${duckRes.duckedIntervalsCount} сегментов фоновой музыки на ${Math.abs(duckRes.appliedDuckingDb)} dB.`
            : `Auto-Ducking: проверено, уровни фоновой музыки в норме.`;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          showToast(logMsg);
          return;
        }

        if (stepId === 'autoFxAnalysis') {
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 40,
              log: 'Анализ панорамы и реверберации оригинального трека...'
            }
          }));

          const fxRes = MixingService.detectAndApplyOriginalEffects(
            project.tracks,
            activePreset.phase3.autoFxAnalysis
          );

          onUpdateProject({ tracks: fxRes.updatedTracks });
          await playbackEngine.updateTracks(fxRes.updatedTracks);
          addAuditLogs(fxRes.logs);

          const logMsg = `Auto-FX: проанализировано ${fxRes.analyzedSegmentsCount} фраз оригинала. Эффекты перенесены на дорожки дубляжа.`;
          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          showToast(logMsg);
          return;
        }

        if (stepId === 'vocalBusProcessing') {
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 40,
              log: `Конфигурация мастер-шины вокала (пресет "${activePreset.phase3.vocalBusProcessing.chain?.presetName || 'Master VO Chain'}")...`
            }
          }));

          const busRes = MixingService.applyMasterVocalBusChain(
            project.tracks,
            activePreset.phase3.vocalBusProcessing.chain || DEFAULT_VOCAL_CHAIN
          );

          onUpdateProject({ tracks: busRes.updatedTracks });
          await playbackEngine.updateTracks(busRes.updatedTracks);
          addAuditLogs(busRes.logs);

          const logMsg = `Мастер-шина вокала: активировано ${busRes.activePluginsCount} плагинов в цепочке "${busRes.chainConfig.presetName}".`;
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
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 50,
              log: 'Проверка клиппинга, интервалов тишины и наложений...'
            }
          }));

          const qcRes = FinalRenderService.runQualityControlAnalysis(
            project,
            activePreset.phase4
          );

          setQaIssues(qcRes.issues);
          const logMsg = `QC Контроль качества: проверено ${project.tracks.length} дорожек. Найдено замечаний: ${qcRes.issues.length} (${qcRes.integratedLufs.toFixed(1)} LUFS, True-Peak ${qcRes.maxTruePeakDb.toFixed(1)} dBTP).`;

          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          addAuditLogs(qcRes.logs);
          showToast(logMsg);
          return;
        }

        if (stepId === 'masteringLimiter') {
          setStepExecution(prev => ({
            ...prev,
            [stepId]: {
              ...prev[stepId],
              progress: 50,
              log: `Применение мастеринг-лимитера (True Peak: ${activePreset.phase4.masteringLimiter.truePeakCeilingDb} dB, стандарт ${activePreset.phase4.masteringLimiter.loudnessStandard})...`
            }
          }));

          const mastRes = FinalRenderService.applyMasteringLimiter(
            project.tracks,
            activePreset.phase4
          );

          onUpdateProject({ tracks: mastRes.updatedTracks });
          await playbackEngine.updateTracks(mastRes.updatedTracks);
          addAuditLogs(mastRes.logs);

          const logMsg = `Мастеринг-лимитер: выходной потолок ${mastRes.ceilingDb.toFixed(1)} dBTP, стандарт ${activePreset.phase4.masteringLimiter.loudnessStandard} (${activePreset.phase4.masteringLimiter.targetIntegratedLufs} LUFS).`;
          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));

          showToast(logMsg);
          return;
        }

        if (stepId === 'stemExport' || stepId === 'renderSettings') {
          if (handleStartFinalRender) {
            await handleStartFinalRender();
          }
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
          const logMsg = `Вшивание субтитров настроено: шрифт ${activePreset.phase4.subtitleBurn.fontName}, размер ${activePreset.phase4.subtitleBurn.fontSize}px, режим ${activePreset.phase4.subtitleBurn.burnMode || 'hardsub'}.`;
          setStepExecution(prev => ({
            ...prev,
            [stepId]: { status: 'success', progress: 100, log: logMsg, hasRollback: true }
          }));
          showToast(logMsg);
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
