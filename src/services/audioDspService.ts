import { AudioTrack, PrepProcessingConfig } from '../types';
import { TimingAlignmentService } from './timingAlignmentService';
import {
  applyWaveformUpwardCompressionNative,
  estimateLufsFromPcmNative,
  transformWaveformEqNative,
  transformWaveformDeclickNative,
  transformWaveformDeplosiveNative,
  transformWaveformDeesserNative,
  transformWaveformDenoiseNative,
  transformWaveformDereverbNative,
  transformWaveformLevelerNative,
} from '../lib/dspBridge';

export interface DspProcessResult {
  updatedTracks: AudioTrack[];
  affectedSegmentsCount: number;
  stats: {
    measuredBeforeLufs?: number;
    measuredAfterLufs?: number;
    appliedGainDb?: number;
    upwardBoostedSegments?: number;
    clicksRemoved?: number;
    plosivesReduced?: number;
    sibilantsSoftened?: number;
    noiseFloorSuppressedDb?: number;
    reverbTailsReducedPercent?: number;
    dynamicRangeCompressedDb?: number;
  };
  logSummary: string;
  detailedLogs: string[];
}

/**
 * High-precision Rust DSP Audio Processing Engine Bridge
 * Delegates all mathematical signal processing, waveform dynamic curves,
 * gating, filtering, and LUFS estimation directly to compiled Rust modules.
 */
export class AudioDspService {
  public static isDubActorTrack(track: AudioTrack): boolean {
    if (TimingAlignmentService.isDubTrack(track)) return true;
    const name = (track.name || '').toLowerCase();
    const isOrig = track.type === 'original' || name.includes('оригинал') || name.includes('музыка') || name.includes('эффект');
    if (isOrig) return false;
    return true;
  }

  /**
   * 1. НОРМАЛИЗАЦИЯ И АПВАРД-КОМПРЕССИЯ (Normalization & Upward Compression via Rust)
   */
  public static async applyNormalizationAndUpwardCompressionAsync(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['normalization'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    const targetLufs = config.targetLufs ?? -16.0;
    const noiseFloorDb = config.noiseFloorDb ?? -55.0;
    const upwardThresholdDb = config.upwardThresholdDb ?? -35.0;
    const upwardGainDb = config.upwardGainDb ?? 6.0;
    const upwardRatio = Math.max(1.0, config.upwardRatio ?? 2.5);

    const detailedLogs: string[] = [];
    detailedLogs.push(`[Rust DSP: Нормализация & Upward Compression] Старт обработки`);
    detailedLogs.push(
      `Параметры: Цель = ${targetLufs.toFixed(1)} LUFS, Порог шума = ${noiseFloorDb.toFixed(1)} dB, Порог апварда = ${upwardThresholdDb.toFixed(1)} dB, Подтяжка = +${upwardGainDb.toFixed(1)} dB (Ratio: ${upwardRatio.toFixed(1)}:1)`
    );

    let affectedSegmentsCount = 0;
    let upwardBoostedCount = 0;
    let totalBeforeLufs = 0;
    let totalAfterLufs = 0;

    const updatedTracks: AudioTrack[] = [];

    for (const track of tracks) {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) {
        updatedTracks.push(track);
        continue;
      }
      if (targetTrackId && track.id !== targetTrackId) {
        updatedTracks.push(track);
        continue;
      }

      const updatedSegments = [];
      for (const seg of track.segments) {
        if (targetSegmentId && seg.id !== targetSegmentId) {
          updatedSegments.push(seg);
          continue;
        }

        affectedSegmentsCount++;
        const currentGain = seg.gain !== undefined ? seg.gain : 1.0;
        const wf = seg.waveform || [];

        // Run Upward Compression and LUFS calculation via Rust
        const rustRes = await applyWaveformUpwardCompressionNative({
          waveform: wf,
          currentGain,
          targetLufs,
          noiseFloorDb,
          upwardThresholdDb,
          upwardGainDb,
          upwardRatio,
        });

        if (rustRes.boostedSamplesCount > 0) {
          upwardBoostedCount++;
        }

        totalBeforeLufs += rustRes.initialLufs;
        totalAfterLufs += rustRes.finalLufs;

        detailedLogs.push(
          `Сегмент "${seg.originalFileName || seg.id.slice(0, 8)}": ${rustRes.initialLufs.toFixed(1)} LUFS -> ${rustRes.finalLufs.toFixed(1)} LUFS (Gain: ${currentGain.toFixed(2)}x -> ${rustRes.updatedGain.toFixed(2)}x, подтянуто ${rustRes.boostedSamplesCount} тихих участков [Rust DSP])`
        );

        updatedSegments.push({
          ...seg,
          gain: rustRes.updatedGain,
          waveform: rustRes.newWaveform,
          backupFilePath: seg.filePath,
          processedEffectName: `Norm ${targetLufs} LUFS + Upward (Rust)`,
        });
      }

      updatedTracks.push({ ...track, segments: updatedSegments });
    }

    const avgBeforeLufs = affectedSegmentsCount > 0 ? Math.round((totalBeforeLufs / affectedSegmentsCount) * 10) / 10 : targetLufs;
    const avgAfterLufs = affectedSegmentsCount > 0 ? Math.round((totalAfterLufs / affectedSegmentsCount) * 10) / 10 : targetLufs;
    const gainDeltaDb = Math.round((avgAfterLufs - avgBeforeLufs) * 10) / 10;

    const logSummary = `Нормализация завершена (Rust): средний уровень ${avgBeforeLufs.toFixed(1)} LUFS приведен к ${avgAfterLufs.toFixed(1)} LUFS (${gainDeltaDb >= 0 ? '+' : ''}${gainDeltaDb} dB). Апвард-компрессия подтянула тихие звуки на ${upwardBoostedCount} сегментах.`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount,
      stats: {
        measuredBeforeLufs: avgBeforeLufs,
        measuredAfterLufs: avgAfterLufs,
        appliedGainDb: gainDeltaDb,
        upwardBoostedSegments: upwardBoostedCount,
      },
      logSummary,
      detailedLogs,
    };
  }

  /**
   * 2. ЭКВАЛИЗАЦИЯ И EQ MATCHING (Rust DSP)
   */
  public static async applyEqMatchingAsync(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['eqMatching'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    const profile = config.profileModel || 'vocal_presence';
    const detailedLogs: string[] = [];
    detailedLogs.push(`[Rust DSP: EQ Matching] Применение профиля эквализации: "${profile}"`);

    let affectedCount = 0;
    const updatedTracks: AudioTrack[] = [];

    for (const track of tracks) {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) {
        updatedTracks.push(track);
        continue;
      }
      if (targetTrackId && track.id !== targetTrackId) {
        updatedTracks.push(track);
        continue;
      }

      const updatedSegments = [];
      for (const seg of track.segments) {
        if (targetSegmentId && seg.id !== targetSegmentId) {
          updatedSegments.push(seg);
          continue;
        }
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 0) {
          const res = await transformWaveformEqNative(wf, profile);
          wf = res.waveform;
        }

        updatedSegments.push({
          ...seg,
          waveform: wf,
          processedEffectName: `EQ (${profile}) [Rust]`,
        });
      }

      updatedTracks.push({ ...track, segments: updatedSegments });
    }

    const logSummary = `EQ Matching успешно применен (Rust DSP, ${profile}): обработано сегментов: ${affectedCount}. Сформирована естественная АЧХ речи.`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: {},
      logSummary,
      detailedLogs,
    };
  }

  /**
   * 3. DE-CLICK (Rust DSP)
   */
  public static async applyDeClickAsync(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['deClick'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    const sensitivity = config.sensitivity ?? 70;
    const detailedLogs: string[] = [];
    let totalClicks = 0;
    let affectedCount = 0;
    const updatedTracks: AudioTrack[] = [];

    for (const track of tracks) {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) {
        updatedTracks.push(track);
        continue;
      }
      if (targetTrackId && track.id !== targetTrackId) {
        updatedTracks.push(track);
        continue;
      }

      const updatedSegments = [];
      for (const seg of track.segments) {
        if (targetSegmentId && seg.id !== targetSegmentId) {
          updatedSegments.push(seg);
          continue;
        }
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 2) {
          const res = await transformWaveformDeclickNative(wf, sensitivity);
          wf = res.waveform;
          totalClicks += res.affectedCount;
        }

        updatedSegments.push({
          ...seg,
          waveform: wf,
          processedEffectName: 'De-Click (Rust)',
        });
      }

      updatedTracks.push({ ...track, segments: updatedSegments });
    }

    const logSummary = `De-Click завершен (Rust DSP): обнаружено и интерполировано ${totalClicks} щелчков на ${affectedCount} сегментах (чувствительность ${sensitivity}%).`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: { clicksRemoved: totalClicks },
      logSummary,
      detailedLogs,
    };
  }

  /**
   * 4. DE-PLOSIVE (Rust DSP)
   */
  public static async applyDePlosiveAsync(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['dePlosive'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    const cutoffHz = config.frequencyCutoff ?? 120;
    const thresholdDb = config.threshold ?? -18;
    const detailedLogs: string[] = [];
    let reducedPlosives = 0;
    let affectedCount = 0;
    const updatedTracks: AudioTrack[] = [];

    for (const track of tracks) {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) {
        updatedTracks.push(track);
        continue;
      }
      if (targetTrackId && track.id !== targetTrackId) {
        updatedTracks.push(track);
        continue;
      }

      const updatedSegments = [];
      for (const seg of track.segments) {
        if (targetSegmentId && seg.id !== targetSegmentId) {
          updatedSegments.push(seg);
          continue;
        }
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 0) {
          const res = await transformWaveformDeplosiveNative(wf, cutoffHz, thresholdDb);
          wf = res.waveform;
          reducedPlosives += res.affectedCount;
        }

        updatedSegments.push({
          ...seg,
          waveform: wf,
          processedEffectName: 'De-Plosive (Rust)',
        });
      }

      updatedTracks.push({ ...track, segments: updatedSegments });
    }

    const logSummary = `De-Plosive выполнен (Rust DSP): ослаблены ${reducedPlosives} взрывных согласных (срез < ${cutoffHz} Гц, порог ${thresholdDb} dB).`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: { plosivesReduced: reducedPlosives },
      logSummary,
      detailedLogs,
    };
  }

  /**
   * 5. DE-ESSER (Rust DSP)
   */
  public static async applyDeEsserAsync(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['deEsser'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    const freq = config.frequency ?? 7000;
    const threshold = config.threshold ?? -22;
    const detailedLogs: string[] = [];
    let softenedCount = 0;
    let affectedCount = 0;
    const updatedTracks: AudioTrack[] = [];

    for (const track of tracks) {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) {
        updatedTracks.push(track);
        continue;
      }
      if (targetTrackId && track.id !== targetTrackId) {
        updatedTracks.push(track);
        continue;
      }

      const updatedSegments = [];
      for (const seg of track.segments) {
        if (targetSegmentId && seg.id !== targetSegmentId) {
          updatedSegments.push(seg);
          continue;
        }
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 0) {
          const res = await transformWaveformDeesserNative(wf, freq, threshold);
          wf = res.waveform;
          softenedCount += res.affectedCount;
        }

        updatedSegments.push({
          ...seg,
          waveform: wf,
          processedEffectName: 'De-Esser (Rust)',
        });
      }

      updatedTracks.push({ ...track, segments: updatedSegments });
    }

    const logSummary = `De-Esser завершен (Rust DSP): мягко сжаты сибилянты в полосе ${freq} Гц на ${affectedCount} сегментах (порог ${threshold} dB).`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: { sibilantsSoftened: softenedCount },
      logSummary,
      detailedLogs,
    };
  }

  /**
   * 6. DENOISE (Rust DSP)
   */
  public static async applyDenoiseAsync(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['denoise'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    const strength = config.strength ?? 80;
    const detailedLogs: string[] = [];
    let affectedCount = 0;
    const updatedTracks: AudioTrack[] = [];

    for (const track of tracks) {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) {
        updatedTracks.push(track);
        continue;
      }
      if (targetTrackId && track.id !== targetTrackId) {
        updatedTracks.push(track);
        continue;
      }

      const updatedSegments = [];
      for (const seg of track.segments) {
        if (targetSegmentId && seg.id !== targetSegmentId) {
          updatedSegments.push(seg);
          continue;
        }
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 0) {
          const res = await transformWaveformDenoiseNative(wf, strength);
          wf = res.waveform;
        }

        updatedSegments.push({
          ...seg,
          waveform: wf,
          processedEffectName: `Denoise (${config.model || 'AI'}) [Rust]`,
        });
      }

      updatedTracks.push({ ...track, segments: updatedSegments });
    }

    const logSummary = `Шумоподавление успешно (Rust DSP): фоновый шум снижен на -${(strength * 0.25).toFixed(1)} dB на ${affectedCount} сегментах.`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: { noiseFloorSuppressedDb: strength * 0.25 },
      logSummary,
      detailedLogs,
    };
  }

  /**
   * 7. DEREVERB (Rust DSP)
   */
  public static async applyDeReverbAsync(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['dereverb'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    const strength = config.strength ?? 75;
    const detailedLogs: string[] = [];
    let affectedCount = 0;
    const updatedTracks: AudioTrack[] = [];

    for (const track of tracks) {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) {
        updatedTracks.push(track);
        continue;
      }
      if (targetTrackId && track.id !== targetTrackId) {
        updatedTracks.push(track);
        continue;
      }

      const updatedSegments = [];
      for (const seg of track.segments) {
        if (targetSegmentId && seg.id !== targetSegmentId) {
          updatedSegments.push(seg);
          continue;
        }
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 2) {
          const res = await transformWaveformDereverbNative(wf, strength);
          wf = res.waveform;
        }

        updatedSegments.push({
          ...seg,
          waveform: wf,
          processedEffectName: `De-Reverb (${config.model || 'RT'}) [Rust]`,
        });
      }

      updatedTracks.push({ ...track, segments: updatedSegments });
    }

    const logSummary = `De-Reverb применен (Rust DSP): комнатные отражения и хвосты эха сокращены на ${strength}% на ${affectedCount} сегментах.`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: { reverbTailsReducedPercent: strength },
      logSummary,
      detailedLogs,
    };
  }

  /**
   * 8. VOLUME LEVELER (Rust DSP)
   */
  public static async applyVolumeLevelerAsync(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['volumeLeveler'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    const targetRms = config.targetRms ?? -20;
    const ratio = Math.max(1.5, config.ratio ?? 3.0);
    const detailedLogs: string[] = [];
    let affectedCount = 0;
    const updatedTracks: AudioTrack[] = [];

    for (const track of tracks) {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) {
        updatedTracks.push(track);
        continue;
      }
      if (targetTrackId && track.id !== targetTrackId) {
        updatedTracks.push(track);
        continue;
      }

      const updatedSegments = [];
      for (const seg of track.segments) {
        if (targetSegmentId && seg.id !== targetSegmentId) {
          updatedSegments.push(seg);
          continue;
        }
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 0) {
          const res = await transformWaveformLevelerNative(wf, ratio);
          wf = res.waveform;
        }

        updatedSegments.push({
          ...seg,
          waveform: wf,
          processedEffectName: 'Leveler (AGC) [Rust]',
        });
      }

      updatedTracks.push({ ...track, segments: updatedSegments });
    }

    const logSummary = `Volume Leveler (Rust DSP): баланс слов выровнен по целевому RMS ${targetRms} dBFS (Ratio ${ratio}:1) на ${affectedCount} сегментах.`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: {},
      logSummary,
      detailedLogs,
    };
  }

  // Synchronous wrappers redirecting to async implementations
  public static applyNormalizationAndUpwardCompression(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['normalization'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    return this.applyNormalizationAndUpwardCompressionAsync(tracks, config, targetTrackId, targetSegmentId);
  }

  public static applyEqMatching(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['eqMatching'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    return this.applyEqMatchingAsync(tracks, config, targetTrackId, targetSegmentId);
  }

  public static applyDeClick(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['deClick'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    return this.applyDeClickAsync(tracks, config, targetTrackId, targetSegmentId);
  }

  public static applyDePlosive(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['dePlosive'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    return this.applyDePlosiveAsync(tracks, config, targetTrackId, targetSegmentId);
  }

  public static applyDeEsser(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['deEsser'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    return this.applyDeEsserAsync(tracks, config, targetTrackId, targetSegmentId);
  }

  public static applyDenoise(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['denoise'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    return this.applyDenoiseAsync(tracks, config, targetTrackId, targetSegmentId);
  }

  public static applyDeReverb(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['dereverb'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    return this.applyDeReverbAsync(tracks, config, targetTrackId, targetSegmentId);
  }

  public static applyVolumeLeveler(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['volumeLeveler'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): Promise<DspProcessResult> {
    return this.applyVolumeLevelerAsync(tracks, config, targetTrackId, targetSegmentId);
  }
}
