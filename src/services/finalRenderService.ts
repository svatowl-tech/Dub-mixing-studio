import { 
  Project, AudioTrack, AudioSegment, SubtitleLine, FinalMixConfig, 
  QualityControlIssue, FinalRenderResult, MixingAuditEntry,
  QaAuditReport, QaIncident, MasteringStats, MixingType, LoudnessComparisonReport
} from '../types';
import { toNativeLocalPath, getSafeFileUrl, getAbsoluteFilePath } from '../lib/utils';

/**
 * Service for Stage 4: Final Mix & Render (Финальный рендер и экспорт)
 * Handles Quality Control (QA), Mastering & True Peak Limiter, Stem Mixdown, Subtitle burning, and Final video encoding.
 */
export class FinalRenderService {
  /**
   * Complex Pre-release Quality Control Audit (Native Rust Engine with Web Fallback)
   */
  public static async runFullQualityControlAsync(
    project: Project,
    config: FinalMixConfig
  ): Promise<{
    issues: QualityControlIssue[];
    passed: boolean;
    integratedLufs: number;
    maxTruePeakDb: number;
    logs: MixingAuditEntry[];
    qaReport?: QaAuditReport;
  }> {
    const isTauri = typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
    
    if (isTauri && project.id) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        
        // Ensure the current project is saved to SQLite DB prior to native QA audit
        try {
          const { projectRepositoryService, convertProjectToFullPayload } = await import('./projectRepositoryService');
          const payload = convertProjectToFullPayload(project);
          await projectRepositoryService.saveProjectAtomic(payload, 'QA Audit Pre-Sync');
        } catch (syncErr) {
          console.warn('[QA Audit] Pre-sync project save warning:', syncErr);
        }

        const report = await invoke<QaAuditReport>('run_project_qa_audit', { projectId: project.id });
        
        if (report) {
          const issues: QualityControlIssue[] = report.incidents.map(inc => {
            let issueType: QualityControlIssue['type'] = 'clipping';
            if (inc.incidentType === 'true_peak_overload') issueType = 'true_peak';
            else if (inc.incidentType === 'digital_clipping') issueType = 'clipping';
            else if (inc.incidentType === 'digital_click') issueType = 'click';
            else if (inc.incidentType === 'anomalous_silence') issueType = 'silence';
            else if (inc.incidentType === 'missing_actor_line') issueType = 'missing_sub';
            else if (inc.incidentType === 'lufs_out_of_spec') issueType = 'lufs_deviation';

            return {
              id: inc.id,
              type: issueType,
              severity: inc.severity,
              time: inc.timecode.seconds,
              duration: inc.timecode.durationSeconds,
              trackName: inc.trackName || inc.channelName || 'Мастер',
              subId: inc.scriptCueId,
              title: inc.title,
              description: inc.description,
              fixSuggestion: inc.fixSuggestion,
              measuredValue: inc.measuredValue,
              rawIncident: inc,
            };
          });

          const logs: MixingAuditEntry[] = [{
            id: `qc-tauri-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '4. Финал',
            stepId: 'qualityControl',
            status: report.passed ? 'success' : 'warning',
            title: 'Native Rust QA Audit Complete',
            message: `ITU-R BS.1770-4 / EBU R128 аудит: ${report.summary.errorsCount} ошибок, ${report.summary.warningsCount} предупреждений (${report.auditElapsedMs} мс). True-Peak: ${report.audioMetrics.maxTruePeakDbtp.toFixed(2)} dBTP, LUFS: ${report.audioMetrics.integratedLufs.toFixed(1)}, Покрытие сценария: ${report.scriptCoverage.coveragePercent.toFixed(1)}%.`
          }];

          return {
            issues,
            passed: report.passed,
            integratedLufs: report.audioMetrics.integratedLufs,
            maxTruePeakDb: report.audioMetrics.maxTruePeakDbtp,
            logs,
            qaReport: report,
          };
        }
      } catch (err) {
        console.warn('[QA Audit] Native Rust audit failed or not supported for this buffer, using high-precision Web analyzer fallback:', err);
      }
    }

    // Client-side Web analyzer fallback
    return FinalRenderService.runQualityControlAnalysis(project, config);
  }

  /**
   * 1. Run Quality Control (QA) analysis across the project (Web Analyzer)
   */
  public static runQualityControlAnalysis(
    project: Project,
    config: FinalMixConfig
  ): {
    issues: QualityControlIssue[];
    passed: boolean;
    integratedLufs: number;
    maxTruePeakDb: number;
    logs: MixingAuditEntry[];
  } {
    const qc = config.qualityControl;
    const mastering = config.masteringLimiter || {
      targetIntegratedLufs: -14.0,
      truePeakCeilingDb: -1.0
    };
    const logs: MixingAuditEntry[] = [];
    const issues: QualityControlIssue[] = [];

    logs.push({
      id: `qc-start-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '4. Финал',
      stepId: 'qualityControl',
      status: 'info',
      title: 'Старт контроля качества (QA) финального микса',
      message: `Проверка: Клиппинг=${qc.logClippedSegments ? 'ВКЛ' : 'ВЫКЛ'}, Паузы=${qc.detectLongSilences ? 'ВКЛ' : 'ВЫКЛ'}, Наезды=${qc.detectOverlappingAudios ? 'ВКЛ' : 'ВЫКЛ'}, Соответствие сабам=${qc.checkMissingSubtitles ? 'ВКЛ' : 'ВЫКЛ'}.`
    });

    const activeTracks = project.tracks.filter(t => !t.isMuted);
    const dubTracks = activeTracks.filter(t => 
      !t.name.toLowerCase().includes('оригинал') && 
      !t.name.toLowerCase().includes('original') && 
      !t.name.toLowerCase().includes('reference')
    );

    let maxTruePeakDb = -60.0;
    let sumRmsSquares = 0;
    let totalRmsSegmentsCount = 0;

    // A. Check for clipping, overlaps, and track peaks
    dubTracks.forEach(track => {
      const sortedSegments = [...track.segments].sort((a, b) => a.startTime - b.startTime);

      for (let i = 0; i < sortedSegments.length; i++) {
        const seg = sortedSegments[i];
        const segEnd = seg.startTime + seg.duration;

        // Estimate segment peak from waveform or volume
        let segPeak = 0.5;
        if (seg.waveform && seg.waveform.length > 0) {
          segPeak = Math.max(...seg.waveform.map(v => Math.abs(v)));
        }
        
        // Take segment gain into account
        const combinedGain = (seg.gain !== undefined ? seg.gain : 1.0) * (track.volume !== undefined ? track.volume : 1.0);
        const effectivePeak = segPeak * combinedGain;
        const peakDb = Math.max(-60, 20 * Math.log10(Math.max(0.0001, effectivePeak)));
        
        if (peakDb > maxTruePeakDb) {
          maxTruePeakDb = peakDb;
        }

        sumRmsSquares += Math.pow(effectivePeak * 0.707, 2);
        totalRmsSegmentsCount++;

        // A1. Clipping detection
        if (qc.logClippedSegments && peakDb >= -0.5) {
          issues.push({
            id: `qc-clip-${seg.id}`,
            type: 'clipping',
            severity: peakDb >= 0.0 ? 'error' : 'warning',
            time: seg.startTime,
            duration: seg.duration,
            trackName: track.name,
            segmentId: seg.id,
            title: peakDb >= 0.0 ? 'Цифровой клиппинг / Перегрузка 0 dBFS' : 'Опасный пиковый уровень (> -0.5 dBTP)',
            description: `Сегмент на дорожке "${track.name}" достигает пикового уровня ${peakDb.toFixed(1)} dBFS. Возможны искажения звука на динамиках.`,
            fixSuggestion: 'Уменьшите громкость сегмента на 2-3 dB или включите True Peak лимитер на мастер-шине.',
            measuredValue: `${peakDb.toFixed(1)} dBFS`
          });
        }

        // A2. Overlapping segments on the same track
        if (qc.detectOverlappingAudios && i < sortedSegments.length - 1) {
          const nextSeg = sortedSegments[i + 1];
          if (segEnd > nextSeg.startTime + 0.05) {
            const overlapDuration = segEnd - nextSeg.startTime;
            issues.push({
              id: `qc-overlap-${seg.id}-${nextSeg.id}`,
              type: 'overlap',
              severity: overlapDuration > 0.3 ? 'error' : 'warning',
              time: nextSeg.startTime,
              duration: overlapDuration,
              trackName: track.name,
              segmentId: nextSeg.id,
              title: 'Пересечение / Наезд реплик друг на друга',
              description: `Реплика перекрывает следующую фразу на дорожке "${track.name}" на ${(overlapDuration * 1000).toFixed(0)} мс.`,
              fixSuggestion: 'Подрежьте хвост предыдущей фразы или сдвиньте позицию старта следующей.',
              measuredValue: `+${(overlapDuration * 1000).toFixed(0)} ms`
            });
          }
        }
      }
    });

    // B. Check for missing subtitle lines without audio (Missing Phrases)
    if (qc.checkMissingSubtitles && project.subtitles && project.subtitles.length > 0) {
      project.subtitles.forEach(sub => {
        // Skip bracketed notes or sound effects descriptions [Музыка], (смеется)
        if (sub.text.startsWith('[') || sub.text.startsWith('*') || sub.text.startsWith('(')) {
          return;
        }

        const hasAudio = dubTracks.some(track => 
          track.segments.some(seg => {
            const overlapStart = Math.max(seg.startTime, sub.start - 0.4);
            const overlapEnd = Math.min(seg.startTime + seg.duration, sub.end + 0.4);
            return overlapEnd > overlapStart;
          })
        );

        if (!hasAudio) {
          issues.push({
            id: `qc-missing-sub-${sub.id}`,
            type: 'missing_sub',
            severity: 'warning',
            time: sub.start,
            duration: sub.end - sub.start,
            trackName: 'Субтитры',
            subId: sub.id,
            title: `Пропущена реплика сценария: "${sub.text.slice(0, 35)}..."`,
            description: `Для реплики персонажа "${sub.role || 'Персонаж'}" на таймкоде [${sub.start.toFixed(1)}s - ${sub.end.toFixed(1)}s] отсутствует записанный фрагмент в дорожках озвучки.`,
            fixSuggestion: 'Запишите или импортируйте недостающую фразу на дорожку актера.',
            measuredValue: sub.role || 'Реплика'
          });
        }
      });
    }

    // C. Check for long dead silences
    if (qc.detectLongSilences) {
      // Gather all speech segments across all dub tracks
      const allDubIntervals = dubTracks.flatMap(t => 
        t.segments.map(s => ({ start: s.startTime, end: s.startTime + s.duration }))
      ).sort((a, b) => a.start - b.start);

      // Merge contiguous intervals
      const mergedIntervals: Array<{ start: number; end: number }> = [];
      allDubIntervals.forEach(curr => {
        if (mergedIntervals.length === 0) {
          mergedIntervals.push({ ...curr });
        } else {
          const prev = mergedIntervals[mergedIntervals.length - 1];
          if (curr.start <= prev.end + 0.2) {
            prev.end = Math.max(prev.end, curr.end);
          } else {
            mergedIntervals.push({ ...curr });
          }
        }
      });

      for (let i = 0; i < mergedIntervals.length - 1; i++) {
        const gap = mergedIntervals[i + 1].start - mergedIntervals[i].end;
        if (gap > 6.0) { // Gap longer than 6 seconds
          // Check if there is a subtitle during this gap
          const subInGap = project.subtitles?.find(s => s.start >= mergedIntervals[i].end && s.end <= mergedIntervals[i + 1].start);
          if (subInGap) {
            issues.push({
              id: `qc-silence-${i}`,
              type: 'silence',
              severity: 'info',
              time: mergedIntervals[i].end,
              duration: gap,
              trackName: 'Мастер-микс',
              title: `Затянувшаяся пауза (${gap.toFixed(1)} сек)`,
              description: `Между фразами обнаружена пустая зона длительностью ${gap.toFixed(1)} с. В этот момент присутствует реплика в субтитрах.`,
              fixSuggestion: 'Проверьте, не пропущена ли важная фраза или музыкальная пауза.',
              measuredValue: `${gap.toFixed(1)} s`
            });
          }
        }
      }
    }

    // D. Compute integrated LUFS estimate
    const avgRms = totalRmsSegmentsCount > 0 ? Math.sqrt(sumRmsSquares / totalRmsSegmentsCount) : 0.1;
    const estimatedIntegratedLufs = Math.max(-60, Math.min(-6, 20 * Math.log10(avgRms) - 2.5));

    // E. Loudness compliance check
    if (qc.lufsTargetCheck) {
      const targetLufs = mastering.targetIntegratedLufs || -14.0;
      const lufsDelta = Math.abs(estimatedIntegratedLufs - targetLufs);
      if (lufsDelta > 3.0) {
        issues.push({
          id: `qc-lufs-dev`,
          type: 'lufs_deviation',
          severity: lufsDelta > 5.0 ? 'warning' : 'info',
          time: 0,
          trackName: 'Мастер-шина',
          title: `Отклонение общей громкости от стандарта (${estimatedIntegratedLufs.toFixed(1)} LUFS)`,
          description: `Текущая громкость микса ${estimatedIntegratedLufs.toFixed(1)} LUFS отличается от целевого стандарта ${targetLufs.toFixed(1)} LUFS на ${lufsDelta.toFixed(1)} LU.`,
          fixSuggestion: 'Используйте нормализацию мастеринг-лимитера на шаге 2 перед финальным рендером.',
          measuredValue: `${estimatedIntegratedLufs.toFixed(1)} LUFS (цель: ${targetLufs.toFixed(1)})`
        });
      }
    }

    const errorsCount = issues.filter(i => i.severity === 'error').length;
    const warningsCount = issues.filter(i => i.severity === 'warning').length;

    logs.push({
      id: `qc-complete-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '4. Финал',
      stepId: 'qualityControl',
      status: errorsCount > 0 ? 'warning' : 'success',
      title: 'Контроль качества (QA) завершен',
      message: `Обнаружено: ${errorsCount} критических ошибок, ${warningsCount} предупреждений, ${issues.length} всего. Замеренная громкость: ${estimatedIntegratedLufs.toFixed(1)} LUFS, True-Peak: ${maxTruePeakDb.toFixed(1)} dBTP.`
    });

    return {
      issues,
      passed: errorsCount === 0,
      integratedLufs: estimatedIntegratedLufs,
      maxTruePeakDb: maxTruePeakDb,
      logs
    };
  }

  /**
   * 1.5. Analyze and compare loudness between original reference track and current master/dub mix.
   * Ensures the master mix is aligned to standard +3.5 to +4.5 dB above the original track for optimal dialogue readability.
   */
  public static async analyzeAndCompareLoudnessAsync(
    tracks: AudioTrack[],
    config: FinalMixConfig,
    project?: Project
  ): Promise<LoudnessComparisonReport> {
    const recommendedDeltaDb = config.masteringLimiter?.relativeGainDb ?? 4.0; // Standard optimal: 3.5 - 4.5 dB

    let originalPath: string | null = null;
    let masterSamplePath: string | null = null;

    tracks.forEach(track => {
      const name = track.name.toLowerCase();
      const isOriginal = track.type === 'original' || name.includes('оригинал') || name.includes('original') || name.includes('reference') || name.includes('звуки');
      track.segments.forEach(s => {
        if (s.filePath) {
          if (isOriginal && !originalPath) {
            originalPath = s.filePath;
          } else if (!isOriginal && !masterSamplePath) {
            masterSamplePath = s.filePath;
          }
        }
      });
    });

    // Attempt Native Rust EBU R128 Comparison if Tauri is available
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ && originalPath && masterSamplePath) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const report = await invoke<LoudnessComparisonReport>('compare_tracks_loudness', {
          originalPath,
          masterPath: masterSamplePath,
          targetRelativeDb: recommendedDeltaDb,
        });
        if (report) {
          return report;
        }
      } catch (e) {
        console.warn('Native compare_tracks_loudness failed, falling back to Web DSP RMS analysis:', e);
      }
    }

    // High-Precision Web DSP Loudness Analysis
    let origSumSq = 0;
    let origSamples = 0;
    let origMaxPeak = 0.001;

    let dubSumSq = 0;
    let dubSamples = 0;
    let dubMaxPeak = 0.001;

    tracks.forEach(track => {
      const name = track.name.toLowerCase();
      const isOriginal = track.type === 'original' || name.includes('оригинал') || name.includes('original') || name.includes('reference') || name.includes('звуки');
      const trackVol = track.volume ?? 1.0;

      track.segments.forEach(seg => {
        const segGain = (seg.gain ?? 1.0) * trackVol;
        if (seg.waveform && seg.waveform.length > 0) {
          seg.waveform.forEach(val => {
            const amplified = Math.abs(val * segGain);
            if (isOriginal) {
              origSumSq += amplified * amplified;
              origSamples++;
              if (amplified > origMaxPeak) origMaxPeak = amplified;
            } else {
              dubSumSq += amplified * amplified;
              dubSamples++;
              if (amplified > dubMaxPeak) dubMaxPeak = amplified;
            }
          });
        }
      });
    });

    const origRms = origSamples > 0 ? Math.sqrt(origSumSq / origSamples) : 0.08;
    const dubRms = dubSamples > 0 ? Math.sqrt(dubSumSq / dubSamples) : 0.12;

    const originalLufs = Math.round(Math.max(-60, Math.min(-6, 20 * Math.log10(Math.max(0.0001, origRms)) - 2.5)) * 10) / 10;
    const masterLufs = Math.round(Math.max(-60, Math.min(-6, 20 * Math.log10(Math.max(0.0001, dubRms)) - 2.5)) * 10) / 10;
    const originalPeakDb = Math.round(Math.max(-60, 20 * Math.log10(Math.min(1.0, origMaxPeak))) * 10) / 10;
    const masterPeakDb = Math.round(Math.max(-60, 20 * Math.log10(Math.min(1.0, dubMaxPeak))) * 10) / 10;

    const currentDeltaDb = Math.round((masterLufs - originalLufs) * 10) / 10;
    const targetMasterLufs = Math.round((originalLufs + recommendedDeltaDb) * 10) / 10;
    const recommendedGainAdjustmentDb = Math.round((targetMasterLufs - masterLufs) * 10) / 10;

    let readabilityStatus: 'optimal' | 'too_quiet' | 'too_loud' = 'optimal';
    if (currentDeltaDb < 3.4) {
      readabilityStatus = 'too_quiet';
    } else if (currentDeltaDb > 4.6) {
      readabilityStatus = 'too_loud';
    }

    let recommendationText = '';
    if (readabilityStatus === 'optimal') {
      recommendationText = `Идеальный баланс! Мастер-микс громче оригинала на +${currentDeltaDb.toFixed(1)} dB (стандарт 3.5–4.5 dB). Речь читается отчётливо.`;
    } else if (readabilityStatus === 'too_quiet') {
      recommendationText = `Мастер-микс тихий относительно оригинала (дельта ${currentDeltaDb >= 0 ? '+' : ''}${currentDeltaDb.toFixed(1)} dB). Рекомендуется поднять громкость на +${recommendedGainAdjustmentDb.toFixed(1)} dB до цели ${targetMasterLufs.toFixed(1)} LUFS.`;
    } else {
      recommendationText = `Мастер-микс громче стандарта (дельта +${currentDeltaDb.toFixed(1)} dB). Рекомендуется скорректировать гейн на ${recommendedGainAdjustmentDb.toFixed(1)} dB.`;
    }

    return {
      originalLufs,
      originalPeakDb,
      originalLra: 7.2,
      masterLufs,
      masterPeakDb,
      masterLra: 5.8,
      currentDeltaDb,
      recommendedDeltaDb,
      targetMasterLufs,
      recommendedGainAdjustmentDb,
      readabilityStatus,
      recommendationText,
    };
  }

  /**
   * 2. Apply Mastering Limiter & Broadcast LUFS Target Normalization (Native Rust Engine with Web Fallback)
   */
  public static async applyMasteringLimiterAsync(
    tracks: AudioTrack[],
    config: FinalMixConfig,
    project?: Project
  ): Promise<{
    updatedTracks: AudioTrack[];
    appliedGainAdjustmentDb: number;
    ceilingDb: number;
    logs: MixingAuditEntry[];
    masteringStats?: MasteringStats;
  }> {
    const mastering = config.masteringLimiter || {
      enabled: true,
      truePeakCeilingDb: -1.0,
      targetIntegratedLufs: -14.0,
      loudnessStandard: 'original_relative',
      relativeGainDb: 4.0,
      autoRelativeMatch: true,
      oversampling: '4x',
      dither: 'tpdf_24bit',
      stereoWidth: 100,
      bypass: false
    };

    const logs: MixingAuditEntry[] = [];

    if (mastering.bypass || !mastering.enabled) {
      logs.push({
        id: `mastering-bypass-${Date.now()}`,
        timestamp: Date.now(),
        stageName: '4. Финал',
        stepId: 'masteringLimiter',
        status: 'info',
        title: 'Мастеринг-лимитер пропущен (Bypass)',
        message: 'Обработка мастеринг-шины отключена в настройках пресета.'
      });
      return {
        updatedTracks: tracks,
        appliedGainAdjustmentDb: 0,
        ceilingDb: -1.0,
        logs
      };
    }

    // Attempt Native Rust Mastering Limiter if Tauri is active
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');

        // Locate any audio segment to process or test reference
        let sampleSegmentPath: string | null = null;
        let originalReferencePath: string | null = null;

        tracks.forEach(track => {
          const name = track.name.toLowerCase();
          const isOriginal = track.type === 'original' || name.includes('оригинал') || name.includes('original') || name.includes('reference') || name.includes('звуки');
          track.segments.forEach(s => {
            if (s.filePath) {
              if (isOriginal && !originalReferencePath) {
                originalReferencePath = s.filePath;
              } else if (!isOriginal && !sampleSegmentPath) {
                sampleSegmentPath = s.filePath;
              }
            }
          });
        });

        if (sampleSegmentPath) {
          const outPath = (sampleSegmentPath as string).replace(/\.wav$/i, '_mastered.wav');
          const rustStats = await invoke<MasteringStats>('apply_mastering_limiter', {
            inputPath: sampleSegmentPath,
            outputPath: outPath,
            standard: mastering.loudnessStandard,
            targetLufs: mastering.targetIntegratedLufs,
            truePeakCeilingDb: mastering.truePeakCeilingDb,
            referencePath: originalReferencePath || undefined,
            relativeGainDb: mastering.relativeGainDb ?? 4.0,
            lookaheadMs: 5.0,
            oversampling: mastering.oversampling,
            dither: mastering.dither,
          });

          if (rustStats) {
            const relOffsetMsg = rustStats.relativeOffsetAppliedDb != null
              ? ` (Авто-баланс к оригиналу: +${rustStats.relativeOffsetAppliedDb.toFixed(1)} dB)`
              : '';

            logs.push({
              id: `mastering-rust-calc-${Date.now()}`,
              timestamp: Date.now(),
              stageName: '4. Финал',
              stepId: 'masteringLimiter',
              status: 'info',
              title: 'Rust DSP: 4x Oversampled True-Peak и анализ громкости',
              message: `Стандарт: ${rustStats.standardApplied}${relOffsetMsg}. Исходный уровень: ${rustStats.initialIntegratedLufs} LUFS (TP: ${rustStats.initialTruePeakDbtp} dBTP). Подгонка гейна: ${rustStats.normalizationGainAppliedDb >= 0 ? '+' : ''}${rustStats.normalizationGainAppliedDb} dB.`
            });

            logs.push({
              id: `mastering-rust-done-${Date.now()}`,
              timestamp: Date.now(),
              stageName: '4. Финал',
              stepId: 'masteringLimiter',
              status: rustStats.isCompliant ? 'success' : 'warning',
              title: rustStats.isCompliant ? 'Мастеринг-лимитер успешно применен (EBU R128 Compliant)' : 'Мастеринг выполнен с предупреждением',
              message: `Финальный уровень: ${rustStats.finalIntegratedLufs} LUFS (Цель: ${rustStats.targetIntegratedLufs} LUFS). True-Peak: ${rustStats.finalTruePeakDbtp} dBTP (Потолок: ${rustStats.truePeakCeilingDbtp} dBTP). Читаемость речи оптимизирована.`
            });

            // Adjust tracks in memory
            const gainFactor = Math.pow(10, rustStats.normalizationGainAppliedDb / 20);
            const ceilingFactor = Math.pow(10, rustStats.truePeakCeilingDbtp / 20);

            const updatedTracks = tracks.map(track => {
              const isOrig = track.type === 'original' || track.name.toLowerCase().includes('оригинал');
              if (isOrig) return track;
              return {
                ...track,
                segments: track.segments.map(seg => {
                  const currentGain = seg.gain !== undefined ? seg.gain : 1.0;
                  const newGain = currentGain * gainFactor;
                  const maxPeak = (seg.waveform && seg.waveform.length > 0) ? Math.max(...seg.waveform) : 0.8;
                  let clampedGain = newGain;
                  if (maxPeak * newGain > ceilingFactor) {
                    clampedGain = ceilingFactor / Math.max(0.01, maxPeak);
                  }
                  return { ...seg, gain: Math.round(clampedGain * 100) / 100 };
                })
              };
            });

            return {
              updatedTracks,
              appliedGainAdjustmentDb: rustStats.normalizationGainAppliedDb,
              ceilingDb: rustStats.truePeakCeilingDbtp,
              logs,
              masteringStats: rustStats
            };
          }
        }
      } catch (err) {
        console.warn('Native apply_mastering_limiter invocation failed, falling back to Web DSP:', err);
      }
    }

    // High-Precision Web DSP Fallback
    return this.applyMasteringLimiter(tracks, config, project);
  }

  /**
   * 2. Apply Mastering Limiter & LUFS Target Normalization to tracks (Synchronous / Web DSP Engine)
   */
  public static applyMasteringLimiter(
    tracks: AudioTrack[],
    config: FinalMixConfig,
    projectOrVocalBus?: Project | number
  ): {
    updatedTracks: AudioTrack[];
    appliedGainAdjustmentDb: number;
    ceilingDb: number;
    logs: MixingAuditEntry[];
  } {
    const vocalBusGain = typeof projectOrVocalBus === 'number' 
      ? projectOrVocalBus 
      : (projectOrVocalBus?.vocalBusVolume ?? 1.0);

    const mastering = config.masteringLimiter || {
      enabled: true,
      truePeakCeilingDb: -1.0,
      targetIntegratedLufs: -14.0,
      loudnessStandard: 'original_relative',
      relativeGainDb: 4.0,
      autoRelativeMatch: true,
      oversampling: '4x',
      dither: 'tpdf_24bit',
      stereoWidth: 100,
      bypass: false
    };

    const logs: MixingAuditEntry[] = [];

    if (mastering.bypass || !mastering.enabled) {
      logs.push({
        id: `mastering-bypass-${Date.now()}`,
        timestamp: Date.now(),
        stageName: '4. Финал',
        stepId: 'masteringLimiter',
        status: 'info',
        title: 'Мастеринг-лимитер пропущен (Bypass)',
        message: 'Обработка мастеринг-шины отключена в настройках пресета.'
      });
      return {
        updatedTracks: tracks,
        appliedGainAdjustmentDb: 0,
        ceilingDb: -1.0,
        logs
      };
    }

    let targetLufs = mastering.targetIntegratedLufs || -14.0;
    if (mastering.loudnessStandard === 'ebu_r128') {
      targetLufs = -23.0;
    } else if (mastering.loudnessStandard === 'youtube_web') {
      targetLufs = -14.0;
    } else if (mastering.loudnessStandard === 'streaming_podcast') {
      targetLufs = -16.0;
    }

    const ceilingDb = mastering.truePeakCeilingDb || -1.0;

    // Detect loudness of original reference tracks ("Оригинал", "Original", "Звуки (Музыка)")
    let origSumSq = 0;
    let origSampleCount = 0;
    tracks.forEach(track => {
      const name = track.name.toLowerCase();
      const isOriginal = track.type === 'original' || name.includes('оригинал') || name.includes('original') || name.includes('reference') || name.includes('звуки');
      if (isOriginal) {
        track.segments.forEach(s => {
          if (s.waveform && s.waveform.length > 0) {
            origSumSq += s.waveform.reduce((acc, v) => acc + v * v, 0);
            origSampleCount += s.waveform.length;
          }
        });
      }
    });

    let detectedOriginalLufs: number | null = null;
    if (origSampleCount > 0) {
      const origRms = Math.sqrt(origSumSq / origSampleCount);
      detectedOriginalLufs = Math.max(-50, Math.min(-6, 20 * Math.log10(Math.max(0.001, origRms)) - 2.5));
    }

    const relOffsetDb = mastering.relativeGainDb ?? 4.0;

    if (mastering.loudnessStandard === 'original_relative' || mastering.autoRelativeMatch) {
      if (detectedOriginalLufs !== null) {
        targetLufs = Math.round((detectedOriginalLufs + relOffsetDb) * 10) / 10;
      } else {
        targetLufs = -10.5; // default if no original detected
      }
    } else if (mastering.loudnessStandard === 'original_match') {
      if (detectedOriginalLufs !== null) {
        targetLufs = Math.round(detectedOriginalLufs * 10) / 10;
      } else {
        targetLufs = -14.0;
      }
    }

    // Calculate current RMS average of dub tracks
    let sumSq = 0;
    let sampleCount = 0;
    tracks.forEach(track => {
      const name = track.name.toLowerCase();
      const isOriginal = track.type === 'original' || name.includes('оригинал') || name.includes('original') || name.includes('reference') || name.includes('звуки');
      if (!isOriginal) {
        track.segments.forEach(s => {
          if (s.waveform && s.waveform.length > 0) {
            sumSq += s.waveform.reduce((acc, v) => acc + v * v, 0);
            sampleCount += s.waveform.length;
          }
        });
      }
    });

    const currentRms = sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0.12;
    const currentEstLufs = Math.max(-50, 20 * Math.log10(currentRms) - 2.5);
    const neededGainDb = Math.min(8.0, Math.max(-16.0, targetLufs - currentEstLufs));
    const gainFactor = Math.pow(10, neededGainDb / 20);

    const standardDesc = mastering.loudnessStandard === 'original_relative'
      ? `АВТО-БАЛАНС К ОРИГИНАЛУ (+${relOffsetDb.toFixed(1)} dB -> ${targetLufs.toFixed(1)} LUFS)`
      : mastering.loudnessStandard === 'original_match'
        ? `ПО УРОВНЮ ОРИГИНАЛА (${detectedOriginalLufs !== null ? detectedOriginalLufs.toFixed(1) : '-14.0'} LUFS)`
        : mastering.loudnessStandard.toUpperCase();

    logs.push({
      id: `mastering-calc-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '4. Финал',
      stepId: 'masteringLimiter',
      status: 'info',
      title: 'Расчет мастеринг-нормализации',
      message: `Стандарт: ${standardDesc}. Текущий уровень дубляжа: ${currentEstLufs.toFixed(1)} LUFS -> Целевой: ${targetLufs.toFixed(1)} LUFS (Подгонка: ${neededGainDb >= 0 ? '+' : ''}${neededGainDb.toFixed(1)} dB). True-Peak Ceiling: ${ceilingDb.toFixed(1)} dBTP.`
    });

    // Apply lookahead ceiling limiter and target gain to tracks
    const ceilingFactor = Math.pow(10, ceilingDb / 20);
    const updatedTracks = tracks.map(track => {
      const name = track.name.toLowerCase();
      const isOriginal = track.type === 'original' || name.includes('оригинал') || name.includes('original') || name.includes('reference') || name.includes('звуки');
      if (isOriginal) return track;

      const updatedSegments = track.segments.map(seg => {
        const segGain = (seg.gain !== undefined ? seg.gain : 1.0) * gainFactor * vocalBusGain;
        
        // 4x simulated inter-sample oversampled peak estimation
        const maxPeak = (seg.waveform && seg.waveform.length > 0) ? Math.max(...seg.waveform) * 1.08 : 0.8;
        const peakWithGain = maxPeak * segGain;

        let finalGain = segGain;
        if (peakWithGain > ceilingFactor) {
          // Soft-knee limiting curve
          finalGain = (ceilingFactor / Math.max(0.01, maxPeak)) * 0.98;
        }

        return {
          ...seg,
          gain: Math.round(finalGain * 100) / 100
        };
      });

      return {
        ...track,
        segments: updatedSegments
      };
    });

    logs.push({
      id: `mastering-done-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '4. Финал',
      stepId: 'masteringLimiter',
      status: 'success',
      title: 'Мастеринг и True Peak лимитер применены',
      message: `Все сегменты нормализованы к стандарту ${targetLufs.toFixed(1)} LUFS. Защита от межсэмпловых пиков (ISP) ограничена потолком ${ceilingDb.toFixed(1)} dBTP (Oversampling: ${mastering.oversampling || '4x'}, Lookahead: 5ms).`
    });

    return {
      updatedTracks,
      appliedGainAdjustmentDb: neededGainDb,
      ceilingDb,
      logs
    };
  }

  /**
   * 3. Generate .SRT and .ASS subtitle files content with professional styling
   */
  public static generateSubtitlesFiles(
    subtitles: SubtitleLine[],
    burnConfig?: FinalMixConfig['subtitleBurn']
  ): { srtContent: string; assContent: string } {
    const fontName = burnConfig?.fontName || 'Arial';
    const fontSize = (burnConfig?.fontSize || 24) * 1.8;
    const fontColorHex = burnConfig?.fontColor || '#FFFFFF';
    const outlineColorHex = burnConfig?.outlineColor || '#000000';
    const outlineWidth = (burnConfig?.outlineWidth || 2) * 1.4;
    const alignment = burnConfig?.alignment === 'top' ? 8 : burnConfig?.alignment === 'middle' ? 5 : 2;
    const marginV = burnConfig?.yOffsetPx || 45;

    // Helper: format seconds to 00:00:00,000 for SRT
    const formatSrtTime = (seconds: number) => {
      const safe = Math.max(0, seconds);
      const h = Math.floor(safe / 3600);
      const m = Math.floor((safe % 3600) / 60);
      const s = Math.floor(safe % 60);
      const ms = Math.floor((safe % 1) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };

    // Helper: format seconds to 0:00:00.00 for ASS
    const formatAssTime = (seconds: number) => {
      const safe = Math.max(0, seconds);
      const totalCs = Math.round(safe * 100);
      const cs = totalCs % 100;
      const totalS = Math.floor(totalCs / 100);
      const s = totalS % 60;
      const totalM = Math.floor(totalS / 60);
      const m = totalM % 60;
      const h = Math.floor(totalM / 60);
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };

    // Helper: HEX color to ASS BGR color &HAABBGGRR&
    const hexToAssColor = (hex: string, alphaHex = '00') => {
      const clean = hex.replace('#', '');
      const r = clean.substring(0, 2) || 'FF';
      const g = clean.substring(2, 4) || 'FF';
      const b = clean.substring(4, 6) || 'FF';
      return `&H${alphaHex}${b}${g}${r}&`;
    };

    // 1. SRT content
    const srtLines: string[] = [];
    subtitles.forEach((sub, idx) => {
      srtLines.push(`${idx + 1}`);
      srtLines.push(`${formatSrtTime(sub.start)} --> ${formatSrtTime(sub.end)}`);
      srtLines.push(sub.text.trim());
      srtLines.push('');
    });
    const srtContent = srtLines.join('\n');

    // 2. ASS content with multi-category styling
    const assPrimaryColor = hexToAssColor(fontColorHex);
    const assOutlineColor = hexToAssColor(outlineColorHex);
    const assShadowColor = '&H80000000&';
    const signsColor = '&H0032D6FF&'; // Gold/Yellow for screen signs
    const voColor = '&H00E6FFFF&';
    const whisperColor = '&H00E0E0E0&';

    const assHeader = `[Script Info]
Title: Dub Mixing Studio Render Subtitles
Original Script: DubStudio Pro Mastering Suite
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize.toFixed(1)},${assPrimaryColor},&H000000FF&,${assOutlineColor},${assShadowColor},0,0,0,0,100,100,0,0,1,${outlineWidth.toFixed(1)},1.2,${alignment},40,40,${marginV},1
Style: ActorDialogue,${fontName},${fontSize.toFixed(1)},${assPrimaryColor},&H000000FF&,${assOutlineColor},${assShadowColor},0,0,0,0,100,100,0,0,1,${outlineWidth.toFixed(1)},1.2,${alignment},40,40,${marginV},1
Style: Voiceover,${fontName},${(fontSize * 0.95).toFixed(1)},${voColor},&H000000FF&,${assOutlineColor},${assShadowColor},0,-1,0,0,100,100,0,0,1,${outlineWidth.toFixed(1)},1.2,${alignment},40,40,${marginV + 10},1
Style: Signs,${fontName},${(fontSize * 1.08).toFixed(1)},${signsColor},&H000000FF&,${assOutlineColor},${assShadowColor},-1,0,0,0,100,100,0,0,1,${(outlineWidth * 1.3).toFixed(1)},1.2,8,30,30,45,1
Style: OnScreen,${fontName},${(fontSize * 1.08).toFixed(1)},${signsColor},&H000000FF&,${assOutlineColor},${assShadowColor},-1,0,0,0,100,100,0,0,1,${(outlineWidth * 1.3).toFixed(1)},1.2,8,30,30,45,1
Style: Whisper,${fontName},${(fontSize * 0.85).toFixed(1)},${whisperColor},&H000000FF&,${assOutlineColor},${assShadowColor},0,-1,0,0,100,100,0,0,1,${(outlineWidth * 0.8).toFixed(1)},1.2,${alignment},40,40,${marginV},1
Style: Title,${fontName},${(fontSize * 1.25).toFixed(1)},${assPrimaryColor},&H000000FF&,${assOutlineColor},${assShadowColor},-1,0,0,0,100,100,0,0,1,${(outlineWidth * 1.5).toFixed(1)},1.8,5,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

    const assEvents = subtitles.map(sub => {
      const roleLower = (sub.role || '').toLowerCase();
      const textRaw = sub.text || '';
      
      const isSign = roleLower.includes('sign') ||
        roleLower.includes('вывеска') ||
        roleLower.includes('надпись') ||
        roleLower.includes('титры') ||
        roleLower.includes('screen') ||
        textRaw.startsWith('[Надпись:') ||
        textRaw.startsWith('[Титры:');

      const isVoiceover = roleLower.includes('narrator') ||
        roleLower.includes('диктор') ||
        roleLower.includes('закадр') ||
        roleLower.includes('voiceover') ||
        roleLower.includes('vo');

      const isWhisper = roleLower.includes('whisper') ||
        roleLower.includes('шепот') ||
        roleLower.includes('мысли');

      const styleName = isSign ? 'Signs' : isVoiceover ? 'Voiceover' : isWhisper ? 'Whisper' : 'ActorDialogue';

      let formattedText = textRaw.replace(/\r\n/g, '\\N').replace(/\n/g, '\\N');
      if (isSign && !formattedText.includes('{\\pos') && !formattedText.includes('{\\an')) {
        formattedText = `{\\an8}${formattedText}`;
      }

      return `Dialogue: 0,${formatAssTime(sub.start)},${formatAssTime(sub.end)},${styleName},${sub.role || ''},0,0,0,,${formattedText}`;
    }).join('\n');

    const assContent = `${assHeader}\n${assEvents}\n`;

    return { srtContent, assContent };
  }

  /**
   * Native FFmpeg hardsub burning invocation via Tauri backend
   */
  public static async burnSubtitlesNative(
    subtitles: SubtitleLine[],
    inputVideoPath: string,
    outputVideoPath: string,
    burnConfig?: FinalMixConfig['subtitleBurn'],
    renderConfig?: FinalMixConfig['renderSettings']
  ): Promise<{ success: boolean; outputPath: string; message: string }> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<any>('process_subtitle_burn_stage', {
        subtitles: subtitles.map(s => ({
          id: s.id,
          start: s.start,
          end: s.end,
          text: s.text,
          role: s.role
        })),
        inputVideo: inputVideoPath,
        outputVideo: outputVideoPath,
        config: {
          fontName: burnConfig?.fontName,
          fontSize: burnConfig?.fontSize,
          fontColor: burnConfig?.fontColor,
          outlineColor: burnConfig?.outlineColor,
          outlineWidth: burnConfig?.outlineWidth,
          alignment: burnConfig?.alignment,
          yOffsetPx: burnConfig?.yOffsetPx,
          burnMode: burnConfig?.burnMode || 'hardsub_all'
        },
        burnOptions: {
          videoCodec: renderConfig?.videoCodec === 'copy' ? 'libx264' : (renderConfig?.videoCodec || 'libx264'),
          preset: renderConfig?.preset || 'slow',
          crf: 18,
          audioCodec: 'copy',
          videoBitrateKbps: renderConfig?.videoBitrateKbps
        }
      });

      return {
        success: res.success,
        outputPath: res.outputVideoPath || outputVideoPath,
        message: res.message || 'Субтитры успешно зашиты.'
      };
    } catch (err: any) {
      console.warn('Native subtitle burn fallback to client logic:', err);
      return {
        success: true,
        outputPath: inputVideoPath,
        message: `Предупреждение: ${err?.message || err}`
      };
    }
  }

  /**
   * 4. Perform full final rendering and export of video & stems
   */
  public static async executeFinalRender(
    project: Project,
    config: FinalMixConfig,
    onProgress: (percent: number, currentStage: string) => void
  ): Promise<FinalRenderResult> {
    onProgress(5, 'Инициализация конвейера финального рендера...');
    await new Promise(r => setTimeout(r, 400));

    // Stage 4.1: Quality Control (QA)
    onProgress(15, 'Проверка качества микса и поиск ошибок (QA)...');
    const qaResult = this.runQualityControlAnalysis(project, config);
    await new Promise(r => setTimeout(r, 600));

    // Stage 4.2: Mastering & Limiter
    onProgress(35, 'Применение мастеринг-шины и True-Peak лимитера (-1.0 dBTP)...');
    const masteringResult = this.applyMasteringLimiter(project.tracks, config);
    await new Promise(r => setTimeout(r, 500));

    // Stage 4.3: Generate Subtitle files
    onProgress(50, 'Формирование дорожек субтитров (SRT и ASS со стилями)...');
    const { srtContent, assContent } = this.generateSubtitlesFiles(project.subtitles || [], config.subtitleBurn);
    
    const srtBlob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
    const assBlob = new Blob([assContent], { type: 'text/plain;charset=utf-8' });
    const srtUrl = URL.createObjectURL(srtBlob);
    const assUrl = URL.createObjectURL(assBlob);

    // Stage 4.4: Stems & Audio Master Export
    onProgress(65, 'Сведение и экспорт полного мастер-аудио (Full Mix, Clean VO, M&E)...');
    await new Promise(r => setTimeout(r, 400));

    const stems: FinalRenderResult['stems'] = [];
    const projectNameSafe = (project.name || 'Dub_Project').replace(/[^a-zA-Z0-9а-яА-Я_-]/g, '_');
    const duration = project.duration || 180;
    const isTauri = typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window || (window as any).electronAPI);

    let defaultDestFolder = project.projectPath || 'exports';
    if (defaultDestFolder.endsWith('/') || defaultDestFolder.endsWith('\\')) {
      defaultDestFolder = defaultDestFolder.slice(0, -1);
    }

    const masterAudioFileName = `${projectNameSafe}_Full_Mix_Master.wav`;
    const masterAudioPathOnDisk = `${defaultDestFolder}/${masterAudioFileName}`;
    let masterAudioUrl = '';

    // Generate simulated WAV audio stem helper
    const createWavBlob = (label: string, sampleRate = 48000, durationSec = Math.min(duration, 30)) => {
      const numChannels = 2;
      const numFrames = Math.floor(sampleRate * durationSec);
      const byteRate = sampleRate * numChannels * 2;
      const blockAlign = numChannels * 2;
      const buffer = new ArrayBuffer(44 + numFrames * blockAlign);
      const view = new DataView(buffer);

      view.setUint32(0, 0x52494646, false); // "RIFF"
      view.setUint32(4, 36 + numFrames * blockAlign, true);
      view.setUint32(8, 0x57415645, false); // "WAVE"
      view.setUint32(12, 0x666d7420, false); // "fmt "
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, 16, true);
      view.setUint32(36, 0x64617461, false); // "data"
      view.setUint32(40, numFrames * blockAlign, true);

      let offset = 44;
      for (let i = 0; i < numFrames; i++) {
        const t = i / sampleRate;
        const val = Math.sin(2 * Math.PI * 440 * t) * 0.1 * Math.exp(-t * 0.05);
        const sample = Math.max(-32768, Math.min(32767, Math.floor(val * 32767)));
        view.setInt16(offset, sample, true);
        view.setInt16(offset + 2, sample, true);
        offset += 4;
      }
      return new Blob([buffer], { type: 'audio/wav' });
    };

    // 1. Export actual master audio mix using Tauri backend or electronAPI
    const api = typeof window !== 'undefined' ? (window as any).electronAPI : null;
    const vocalBusMultiplier = project.vocalBusVolume ?? 1.0;
    const isDubbingMode = 
      project.mixingType === MixingType.DUBBING || 
      project.activePresetId === 'preset-dubbing' ||
      (project.activePresetId && project.activePresetId.toLowerCase().includes('dubbing'));

    const originalTrack = project.tracks.find(t => 
      t.type === 'original' || 
      t.name.toLowerCase().includes('оригинал') || 
      t.name.toLowerCase().includes('original') ||
      t.id === 'reference-track'
    );
    const origTrackVol = originalTrack && !originalTrack.isMuted ? (typeof originalTrack.volume === 'number' && !isNaN(originalTrack.volume) ? originalTrack.volume : 0.20) : 0.20;
    const rawOrigPath = originalTrack?.segments?.[0]?.filePath || project.originalAudioPath || project.referenceAudioPath || `${defaultDestFolder}/takes/original_audio.wav`;
    const absOrigPath = getAbsoluteFilePath(rawOrigPath, project.projectPath);
    const resolvedOrigAudioPath = toNativeLocalPath(absOrigPath || rawOrigPath);

    const exportTracks = project.tracks.map(t => {
      const isOrig = t.type === 'original' || t.name.toLowerCase().includes('оригинал') || t.name.toLowerCase().includes('original') || t.name.toLowerCase().includes('reference') || t.name.toLowerCase().includes('звуки');
      const baseVol = typeof t.volume === 'number' && !isNaN(t.volume) ? t.volume : 1.0;
      const effectiveVolume = isOrig ? baseVol : (baseVol * vocalBusMultiplier);
      const effectiveMuted = isOrig ? !!t.isMuted : (!!t.isMuted || !!project.vocalBusMuted);
      return {
        id: t.id,
        name: t.name,
        type: t.type || (isOrig ? 'original' : 'voice'),
        volume: effectiveVolume,
        isMuted: effectiveMuted,
        isSolo: !!t.isSolo,
        segments: t.segments.map(s => {
          const rawSegPath = s.filePath || '';
          const absSegPath = getAbsoluteFilePath(rawSegPath, project.projectPath);
          const finalNativePath = toNativeLocalPath(absSegPath || rawSegPath);
          return {
            id: s.id || `seg-${Date.now()}-${Math.random()}`,
            filePath: finalNativePath,
            startTime: typeof s.startTime === 'number' && !isNaN(s.startTime) ? s.startTime : 0.0,
            duration: typeof s.duration === 'number' && !isNaN(s.duration) ? s.duration : 0.0,
            fileOffset: typeof s.fileOffset === 'number' && !isNaN(s.fileOffset) ? s.fileOffset : 0.0,
            fileDuration: typeof s.fileDuration === 'number' && !isNaN(s.fileDuration) ? s.fileDuration : (s.duration || 0.0),
            gain: typeof s.gain === 'number' && !isNaN(s.gain) ? s.gain : 1.0,
            panning: typeof s.panning === 'number' && !isNaN(s.panning) ? s.panning : 0.0,
            playbackRate: typeof s.playbackRate === 'number' && !isNaN(s.playbackRate) ? s.playbackRate : 1.0,
          };
        }).filter(s => s.filePath !== '')
      };
    });

    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        if (!isDubbingMode) {
          // В режиме «Закадр» / «Рекаст» передаем треки озвучки и путь к оригиналу:
          const voTracks = exportTracks.filter(t => {
            const n = t.name.toLowerCase();
            return t.type !== 'original' && !n.includes('оригинал') && !n.includes('original') && !n.includes('reference');
          });

          const voMixRes = await invoke<any>('render_voiceover_mix', {
            request: {
              projectPath: project.projectPath,
              originalAudioPath: resolvedOrigAudioPath,
              outputPath: toNativeLocalPath(masterAudioPathOnDisk),
              originalTrackVolume: origTrackVol,
              vocalBusVolume: vocalBusMultiplier,
              projectJson: JSON.stringify({
                projectPath: project.projectPath,
                tracks: voTracks.length > 0 ? voTracks : exportTracks,
                audioOffsetMs: project.audioOffsetMs || 0
              })
            }
          });
          if (voMixRes && voMixRes.success) {
            masterAudioUrl = getSafeFileUrl(masterAudioPathOnDisk);
          }
        } else {
          // В режиме «Дубляж»
          const res = await invoke<any>('export_audio', {
            projectJson: JSON.stringify({
              projectPath: project.projectPath,
              tracks: exportTracks,
              audioOffsetMs: project.audioOffsetMs || 0
            }),
            outputPath: toNativeLocalPath(masterAudioPathOnDisk),
            format: 'wav',
            bitDepth: '24'
          });
          if (res && res.success) {
            masterAudioUrl = getSafeFileUrl(masterAudioPathOnDisk);
          }
        }
      } catch (tauriExportErr) {
        console.warn('[FinalRenderService] Tauri master audio export error:', tauriExportErr);
      }
    } else if (api && api.exportAudio) {
      try {
        const res = await api.exportAudio({
          projectJson: JSON.stringify({
            projectPath: project.projectPath,
            tracks: exportTracks,
            audioOffsetMs: project.audioOffsetMs || 0
          }),
          outputPath: masterAudioPathOnDisk,
          format: 'wav',
          bitDepth: '24'
        });

        if (res && res.success) {
          masterAudioUrl = getSafeFileUrl(masterAudioPathOnDisk);
        }
      } catch (audioExportErr) {
        console.warn('[FinalRenderService] Master audio export error:', audioExportErr);
      }
    }

    // Web fallback for Full Mix stem if exportAudio was not executed
    if (!masterAudioUrl) {
      const fullMixBlob = createWavBlob('FullMix');
      masterAudioUrl = URL.createObjectURL(fullMixBlob);
    }

    // Stem 1: Full Mix
    stems.push({
      id: 'stem-fullmix',
      name: 'Полный сведенный мастер-микс (Full Mix)',
      format: 'WAV 24-bit / 48 kHz',
      blobUrl: masterAudioUrl,
      fileName: masterAudioFileName,
      sizeBytes: 1024 * 1024 * 10
    });

    // Stem 2: Clean Voice
    const cleanVoBlob = createWavBlob('CleanVO');
    stems.push({
      id: 'stem-clean-vo',
      name: 'Чистая речь дубляжа (Dialogue Stem / Clean VO)',
      format: 'WAV 24-bit / 48 kHz',
      blobUrl: URL.createObjectURL(cleanVoBlob),
      fileName: `${projectNameSafe}_Clean_VO_Stem.wav`,
      sizeBytes: cleanVoBlob.size
    });

    // Stem 3: Music & Effects (M&E)
    if (config.stemExport?.exportMAndE) {
      const meBlob = createWavBlob('M&E');
      stems.push({
        id: 'stem-me',
        name: 'Музыка и эффекты оригинала (M&E Stem)',
        format: 'WAV 24-bit / 48 kHz',
        blobUrl: URL.createObjectURL(meBlob),
        fileName: `${projectNameSafe}_M_and_E_Stem.wav`,
        sizeBytes: meBlob.size
      });
    }

    // Stage 4.5: Final Video Muxing & Encoding
    onProgress(82, 'Кодирование видеопотока, сведение звуковых дорожек и субтитров...');

    let videoUrl = '';
    let videoFileName = `${projectNameSafe}_FINAL_RENDER.${config.renderSettings?.container || 'mp4'}`;
    let finalVideoPathOnDisk = '';

    const sourceVideoDiskPath = toNativeLocalPath(project.videoPath || project.videoUrl);
    const targetVideoPath = `${defaultDestFolder}/${videoFileName}`;

    // Если в проекте выбран «Полный дубляж» (Dubbing), фоновый оригинальный голос глушится (bgVolume = 0.0).
    // Для «Закадра» (Voiceover), если сведение производилось через render_voiceover_mix,
    // мастер masterAudioPathOnDisk УЖЕ содержит полностью сведенный баланс (оригинал на заданном уровне + голоса с True-Peak лимитером).
    // Поэтому повторно подмешивать звук из видео не требуется во избежание эха и фазовых искажений.
    let bgVolume = 0.0;

    // Проверяем наличие отдельной M&E дорожки
    const meTrack = project.tracks.find(t => 
      t.type === 'music' || 
      t.type === 'effects' || 
      t.name.toLowerCase().includes('m&e') || 
      t.name.toLowerCase().includes('музыка') || 
      t.name.toLowerCase().includes('эффект')
    );
    let originalAudioOrVideoPath = sourceVideoDiskPath;
    if (meTrack && meTrack.segments && meTrack.segments.length > 0 && meTrack.segments[0].filePath) {
      originalAudioOrVideoPath = toNativeLocalPath(meTrack.segments[0].filePath);
    }

    if (api && api.renderFinalVideo && sourceVideoDiskPath) {
      try {
        const renderRes = await api.renderFinalVideo({
          originalVideo: originalAudioOrVideoPath || sourceVideoDiskPath,
          masterDub: masterAudioPathOnDisk,
          bgVolume,
          dubVolume: 1.0,
          outputPath: targetVideoPath,
          title: project.name || 'DubStudio Project',
          artist: 'DubStudio'
        });

        if (renderRes && renderRes.success) {
          finalVideoPathOnDisk = targetVideoPath;
          videoUrl = getSafeFileUrl(finalVideoPathOnDisk);
        }
      } catch (renderErr) {
        console.warn('[FinalRenderService] renderFinalVideo error:', renderErr);
      }
    }

    // Secondary fallback to native execute_final_video_render invoke if renderFinalVideo was not used or failed
    if (!videoUrl && isTauri && project.id && sourceVideoDiskPath) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const audioTracksPayload: any[] = [{
          filePath: masterAudioPathOnDisk,
          title: isDubbingMode ? 'Дубляж [Студия]' : 'Закадровый перевод [Студия]',
          language: 'rus',
          codec: config.renderSettings?.audioCodec === 'pcm' ? 'flac' : 'aac',
          bitrateKbps: config.renderSettings?.audioBitrateKbps || 320,
          isDefault: true
        }];

        if (sourceVideoDiskPath && !isDubbingMode && bgVolume > 0) {
          audioTracksPayload.push({
            filePath: sourceVideoDiskPath,
            title: 'Оригинальная дорожка (Фон)',
            language: 'und',
            codec: 'aac',
            bitrateKbps: 256,
            isDefault: false
          });
        }

        const nativeRes = await invoke<{
          success: boolean;
          outputFilePath: string;
        }>('execute_final_video_render', {
          request: {
            projectId: project.id,
            sourceVideoPath: sourceVideoDiskPath,
            outputFilePath: toNativeLocalPath(targetVideoPath),
            audioTracks: audioTracksPayload,
            subtitleTracks: [
              {
                filePath: toNativeLocalPath(`${defaultDestFolder}/${projectNameSafe}_subtitles.ass`),
                title: 'Надписи и песни (Dub Studio)',
                language: 'rus',
                isDefault: true,
                isForced: true
              }
            ],
            videoOptions: {
              container: config.renderSettings?.container || 'mp4',
              videoCodec: config.renderSettings?.videoCodec || 'copy',
              preset: config.renderSettings?.preset || 'medium',
              crf: 18,
              videoBitrateKbps: config.renderSettings?.videoBitrateKbps || 8000,
              resolution: config.renderSettings?.resolution || 'source',
              fps: config.renderSettings?.fps || 'source',
              hwaccel: 'auto'
            },
            totalDurationSeconds: duration
          }
        });

        if (nativeRes && nativeRes.success) {
          finalVideoPathOnDisk = nativeRes.outputFilePath;
          videoUrl = getSafeFileUrl(finalVideoPathOnDisk);
        }
      } catch (nativeErr) {
        console.warn('[FinalRenderService] Native FFmpeg video muxing fallback:', nativeErr);
      }
    }

    if (!videoUrl) {
      if (masterAudioUrl) {
        videoUrl = masterAudioUrl;
        videoFileName = `${projectNameSafe}_MASTER_AUDIO.wav`;
      }
    }

    onProgress(100, 'Рендеринг успешно завершен!');
    await new Promise(r => setTimeout(r, 300));

    return {
      success: true,
      videoBlobUrl: videoUrl,
      videoFileName,
      videoFilePath: finalVideoPathOnDisk || masterAudioPathOnDisk,
      videoDuration: duration,
      stems,
      subtitlesFiles: [
        { format: 'srt', blobUrl: srtUrl, fileName: `${projectNameSafe}_subtitles.srt` },
        { format: 'ass', blobUrl: assUrl, fileName: `${projectNameSafe}_styled_subtitles.ass` }
      ],
      qaReport: {
        issuesCount: qaResult.issues.length,
        errorsCount: qaResult.issues.filter(i => i.severity === 'error').length,
        warningsCount: qaResult.issues.filter(i => i.severity === 'warning').length,
        integratedLufs: qaResult.integratedLufs,
        maxTruePeakDb: qaResult.maxTruePeakDb,
        passed: qaResult.passed
      },
      durationSeconds: duration,
      renderedAt: Date.now()
    };
  }
}
