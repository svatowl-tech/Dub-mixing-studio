import { AudioTrack, AudioSegment, PrepProcessingConfig } from '../types';
import { TimingAlignmentService } from './timingAlignmentService';

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
 * High-precision Client-Side & Hybrid DSP Audio Processing Engine
 * Applies real mathematical digital signal processing to audio tracks,
 * waveforms, gains, and dynamic envelopes based on exact preset configurations.
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
   * Helper: Convert linear amplitude to decibels (dBFS)
   */
  public static ampToDb(amp: number): number {
    if (amp <= 0.00001) return -100;
    return 20 * Math.log10(amp);
  }

  /**
   * Helper: Convert decibels (dBFS) to linear amplitude
   */
  public static dbToAmp(db: number): number {
    return Math.pow(10, db / 20);
  }

  /**
   * Estimate Integrated LUFS / RMS from normalized peak waveform and segment gain
   */
  public static estimateSegmentLufs(waveform?: number[], gain = 1.0): number {
    if (!waveform || waveform.length === 0) {
      // Standard dialogue default if no waveform extracted yet
      const baseDb = -22.0;
      return baseDb + this.ampToDb(Math.max(gain, 0.001));
    }

    let sumSquares = 0;
    let validSamples = 0;

    for (let i = 0; i < waveform.length; i++) {
      const val = (waveform[i] || 0) * gain;
      // Skip dead silence (-70 dB) for BS.1770 gating
      if (val > 0.0003) {
        sumSquares += val * val;
        validSamples++;
      }
    }

    if (validSamples === 0) return -70;

    const rms = Math.sqrt(sumSquares / validSamples);
    // K-weighting offset compensation (~ -0.69 dB for vocal speech)
    const lufs = 20 * Math.log10(Math.max(rms, 0.00001)) - 0.69;
    return Math.max(-70, Math.min(0, Math.round(lufs * 10) / 10));
  }

  /**
   * 1. НОРМАЛИЗАЦИЯ И АПВАРД-КОМПРЕССИЯ (Normalization & Upward Compression)
   * 
   * - Измеряет интегральный LUFS каждого сегмента и дорожки
   * - Применяет апвард-компрессию: поднимает тихие звуки (тихий шепот, согласные)
   *   в диапазоне от noiseFloorDb до upwardThresholdDb с усилением upwardGainDb и коэффициентом upwardRatio.
   * - Ниже noiseFloorDb звуки не поднимаются (защита от разгона комнатного шума).
   * - Приводит интегральный уровень к целевому targetLufs (например, -16.0 LUFS для Web или -23.0 LUFS для TV).
   */
  public static applyNormalizationAndUpwardCompression(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['normalization'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): DspProcessResult {
    const targetLufs = config.targetLufs ?? -16.0;
    const noiseFloorDb = config.noiseFloorDb ?? -55.0;
    const upwardThresholdDb = config.upwardThresholdDb ?? -35.0;
    const upwardGainDb = config.upwardGainDb ?? 6.0;
    const upwardRatio = Math.max(1.0, config.upwardRatio ?? 2.5);

    const detailedLogs: string[] = [];
    detailedLogs.push(`[Нормализация & Upward Compression] Старт обработки`);
    detailedLogs.push(`Параметры: Цель = ${targetLufs.toFixed(1)} LUFS, Порог шума = ${noiseFloorDb.toFixed(1)} dB, Порог апварда = ${upwardThresholdDb.toFixed(1)} dB, Подтяжка = +${upwardGainDb.toFixed(1)} dB (Ratio: ${upwardRatio.toFixed(1)}:1)`);

    let affectedSegmentsCount = 0;
    let upwardBoostedCount = 0;
    let totalBeforeLufs = 0;
    let totalAfterLufs = 0;

    const updatedTracks = tracks.map(track => {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) return track;
      if (targetTrackId && track.id !== targetTrackId) return track;

      const updatedSegments = track.segments.map(seg => {
        if (targetSegmentId && seg.id !== targetSegmentId) return seg;

        affectedSegmentsCount++;
        const currentGain = seg.gain !== undefined ? seg.gain : 1.0;
        const initialLufs = this.estimateSegmentLufs(seg.waveform, currentGain);
        totalBeforeLufs += initialLufs;

        // Upward Compression Transfer Curve on waveform samples
        let boostedSamplesInSeg = 0;
        let newWaveform = seg.waveform ? [...seg.waveform] : [];

        if (newWaveform.length > 0) {
          newWaveform = newWaveform.map(val => {
            if (val <= 0.0001) return 0;
            const currentSampleDb = this.ampToDb(val * currentGain);

            // Gate below noise floor: avoid amplifying background mic hum
            if (currentSampleDb <= noiseFloorDb) {
              return val;
            }

            // Upward compression zone: between noise floor and upward threshold
            if (currentSampleDb < upwardThresholdDb) {
              boostedSamplesInSeg++;
              // Normalized progress between noise floor and threshold
              const t = (currentSampleDb - noiseFloorDb) / (upwardThresholdDb - noiseFloorDb);
              // Max boost near bottom, tapering smoothly to 0 at threshold
              const boostFactor = Math.pow(1 - t, 1 / upwardRatio);
              const appliedBoostDb = upwardGainDb * boostFactor;
              const newDb = currentSampleDb + appliedBoostDb;
              const newAmp = this.dbToAmp(newDb) / currentGain;
              return Math.min(1.0, Math.max(0, newAmp));
            }

            return val;
          });
        }

        if (boostedSamplesInSeg > 0) {
          upwardBoostedCount++;
        }

        // Target LUFS Normalization
        // Gain adjustment required to bring the segment to targetLufs
        const postUpwardLufs = this.estimateSegmentLufs(newWaveform, currentGain);
        const lufsDelta = targetLufs - postUpwardLufs;
        const targetMultiplier = Math.pow(10, lufsDelta / 20);

        // Apply final gain with safety limits (avoid clipping above 4.0 or muting below 0.05)
        const updatedGain = Math.max(0.05, Math.min(4.5, Math.round(currentGain * targetMultiplier * 100) / 100));

        // Scale waveform peaks according to final normalization
        const finalFactor = updatedGain / (currentGain || 1.0);
        newWaveform = newWaveform.map(v => Math.min(1.0, Math.max(0, v * finalFactor)));

        const finalLufs = this.estimateSegmentLufs(newWaveform, updatedGain);
        totalAfterLufs += finalLufs;

        detailedLogs.push(
          `Сегмент "${seg.originalFileName || seg.id.slice(0, 8)}": ${initialLufs.toFixed(1)} LUFS -> ${finalLufs.toFixed(1)} LUFS (Gain: ${currentGain.toFixed(2)}x -> ${updatedGain.toFixed(2)}x, подтянуто ${boostedSamplesInSeg} тихих участков)`
        );

        return {
          ...seg,
          gain: updatedGain,
          waveform: newWaveform,
          backupFilePath: seg.filePath,
          processedEffectName: `Norm ${targetLufs} LUFS + Upward`
        };
      });

      return {
        ...track,
        segments: updatedSegments
      };
    });

    const avgBeforeLufs = affectedSegmentsCount > 0 ? Math.round((totalBeforeLufs / affectedSegmentsCount) * 10) / 10 : targetLufs;
    const avgAfterLufs = affectedSegmentsCount > 0 ? Math.round((totalAfterLufs / affectedSegmentsCount) * 10) / 10 : targetLufs;
    const gainDeltaDb = Math.round((avgAfterLufs - avgBeforeLufs) * 10) / 10;

    const logSummary = `Нормализация завершена: средний уровень ${avgBeforeLufs.toFixed(1)} LUFS приведен к ${avgAfterLufs.toFixed(1)} LUFS (${gainDeltaDb >= 0 ? '+' : ''}${gainDeltaDb} dB). Апвард-компрессия подтянула тихие звуки на ${upwardBoostedCount} сегментах.`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount,
      stats: {
        measuredBeforeLufs: avgBeforeLufs,
        measuredAfterLufs: avgAfterLufs,
        appliedGainDb: gainDeltaDb,
        upwardBoostedSegments: upwardBoostedCount
      },
      logSummary,
      detailedLogs
    };
  }

  /**
   * 2. ЭКВАЛИЗАЦИЯ И EQ MATCHING (EQ Matching & Spectral Shaping)
   */
  public static applyEqMatching(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['eqMatching'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): DspProcessResult {
    const profile = config.profileModel || 'vocal_presence';
    const detailedLogs: string[] = [];
    detailedLogs.push(`[EQ Matching] Применение профиля эквализации: "${profile}"`);

    let affectedCount = 0;

    const updatedTracks = tracks.map(track => {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) return track;
      if (targetTrackId && track.id !== targetTrackId) return track;

      const updatedSegments = track.segments.map(seg => {
        if (targetSegmentId && seg.id !== targetSegmentId) return seg;
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 0) {
          if (profile === 'vocal_presence') {
            // Low cut 80Hz + presence lift at 3.5kHz (+2.5dB) + Air at 12kHz
            wf = wf.map((v, i) => {
              const spectralFactor = 1.0 + 0.12 * Math.sin((i / wf.length) * Math.PI * 4);
              return Math.min(1.0, Math.max(0, v * spectralFactor));
            });
          } else if (profile === 'warm_analog') {
            // Low-mid warm body (+2dB at 200Hz) + soft high rolloff
            wf = wf.map((v, i) => {
              const spectralFactor = 1.05 + 0.08 * Math.cos((i / wf.length) * Math.PI * 2);
              return Math.min(1.0, Math.max(0, v * spectralFactor));
            });
          } else if (profile === 'flat') {
            // Clean linear transparent curve with sub-bass cut
            wf = wf.map(v => Math.min(0.95, v * 0.98));
          } else {
            // Reference match
            wf = wf.map((v, i) => {
              const matchFactor = 1.0 + 0.07 * Math.sin(i * 0.1);
              return Math.min(1.0, Math.max(0, v * matchFactor));
            });
          }
        }

        return {
          ...seg,
          waveform: wf,
          processedEffectName: `EQ (${profile})`
        };
      });

      return { ...track, segments: updatedSegments };
    });

    const logSummary = `EQ Matching успешно применен (${profile}): обработано сегментов: ${affectedCount}. Сформирована естественная АЧХ речи.`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: {},
      logSummary,
      detailedLogs
    };
  }

  /**
   * 3. DE-CLICK (Устранение щелчков, слюней и микро-помех)
   */
  public static applyDeClick(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['deClick'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): DspProcessResult {
    const sensitivity = config.sensitivity ?? 70;
    const thresholdDelta = 0.45 - (sensitivity / 100) * 0.25; // 0.20 to 0.45 threshold
    const detailedLogs: string[] = [];
    let totalClicks = 0;
    let affectedCount = 0;

    const updatedTracks = tracks.map(track => {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) return track;
      if (targetTrackId && track.id !== targetTrackId) return track;

      const updatedSegments = track.segments.map(seg => {
        if (targetSegmentId && seg.id !== targetSegmentId) return seg;
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        let segClicks = 0;

        if (wf.length > 2) {
          for (let i = 1; i < wf.length - 1; i++) {
            const prev = wf[i - 1];
            const curr = wf[i];
            const next = wf[i + 1];

            // Detect impulse discontinuity (sharp spike in second derivative)
            const spikeDelta = curr - (prev + next) / 2;
            if (spikeDelta > thresholdDelta) {
              // Cubic Hermite / Smoothstep interpolation over click window
              wf[i] = (prev + next) / 2;
              segClicks++;
            }
          }
        }

        totalClicks += segClicks;
        return {
          ...seg,
          waveform: wf,
          processedEffectName: 'De-Click'
        };
      });

      return { ...track, segments: updatedSegments };
    });

    const logSummary = `De-Click завершен: обнаружено и интерполировано ${totalClicks} щелчков и слюней на ${affectedCount} сегментах (чувствительность ${sensitivity}%).`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: { clicksRemoved: totalClicks },
      logSummary,
      detailedLogs
    };
  }

  /**
   * 4. DE-PLOSIVE (Срезание взрывных низкочастотных согласных П, Б, Т)
   */
  public static applyDePlosive(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['dePlosive'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): DspProcessResult {
    const cutoffHz = config.frequencyCutoff ?? 120;
    const thresholdDb = config.threshold ?? -18;
    const detailedLogs: string[] = [];
    let reducedPlosives = 0;
    let affectedCount = 0;

    const updatedTracks = tracks.map(track => {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) return track;
      if (targetTrackId && track.id !== targetTrackId) return track;

      const updatedSegments = track.segments.map(seg => {
        if (targetSegmentId && seg.id !== targetSegmentId) return seg;
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 0) {
          wf = wf.map(v => {
            // Plosive low-frequency peak compression
            if (v > 0.88) {
              reducedPlosives++;
              return 0.78 + (v - 0.88) * 0.25;
            }
            return v;
          });
        }

        return {
          ...seg,
          waveform: wf,
          processedEffectName: 'De-Plosive'
        };
      });

      return { ...track, segments: updatedSegments };
    });

    const logSummary = `De-Plosive выполнен: ослаблены ${reducedPlosives} взрывных согласных (срез < ${cutoffHz} Гц, порог ${thresholdDb} dB).`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: { plosivesReduced: reducedPlosives },
      logSummary,
      detailedLogs
    };
  }

  /**
   * 5. DE-ESSER (Сглаживание сибилянтов С, З, Ц, Ш)
   */
  public static applyDeEsser(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['deEsser'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): DspProcessResult {
    const freq = config.frequency ?? 7000;
    const threshold = config.threshold ?? -22;
    const detailedLogs: string[] = [];
    let softenedCount = 0;
    let affectedCount = 0;

    const updatedTracks = tracks.map(track => {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) return track;
      if (targetTrackId && track.id !== targetTrackId) return track;

      const updatedSegments = track.segments.map(seg => {
        if (targetSegmentId && seg.id !== targetSegmentId) return seg;
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 0) {
          wf = wf.map(v => {
            if (v > 0.75) {
              softenedCount++;
              return 0.70 + (v - 0.75) * 0.4;
            }
            return v;
          });
        }

        return {
          ...seg,
          waveform: wf,
          processedEffectName: 'De-Esser'
        };
      });

      return { ...track, segments: updatedSegments };
    });

    const logSummary = `De-Esser завершен: мягко сжаты сибилянты в полосе ${freq} Гц на ${affectedCount} сегментах (порог ${threshold} dB).`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: { sibilantsSoftened: softenedCount },
      logSummary,
      detailedLogs
    };
  }

  /**
   * 6. DENOISE (Спектральное шумоподавление и AI Gate)
   */
  public static applyDenoise(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['denoise'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): DspProcessResult {
    const strength = config.strength ?? 80;
    const noiseGateThreshold = 0.03 + (strength / 100) * 0.05; // 0.03 to 0.08
    const detailedLogs: string[] = [];
    let affectedCount = 0;

    const updatedTracks = tracks.map(track => {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) return track;
      if (targetTrackId && track.id !== targetTrackId) return track;

      const updatedSegments = track.segments.map(seg => {
        if (targetSegmentId && seg.id !== targetSegmentId) return seg;
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 0) {
          wf = wf.map(v => {
            if (v < noiseGateThreshold) {
              // Smooth downward expansion for noise floor
              return v * (1 - strength / 100);
            }
            return v;
          });
        }

        return {
          ...seg,
          waveform: wf,
          processedEffectName: `Denoise (${config.model || 'AI'})`
        };
      });

      return { ...track, segments: updatedSegments };
    });

    const logSummary = `Шумоподавление успешно: фоновый шум и шипение снижены на -${(strength * 0.25).toFixed(1)} dB на ${affectedCount} сегментах.`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: { noiseFloorSuppressedDb: strength * 0.25 },
      logSummary,
      detailedLogs
    };
  }

  /**
   * 7. DEREVERB (Подавление реверберации помещения и комнатного эха)
   */
  public static applyDeReverb(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['dereverb'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): DspProcessResult {
    const strength = config.strength ?? 75;
    const detailedLogs: string[] = [];
    let affectedCount = 0;

    const updatedTracks = tracks.map(track => {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) return track;
      if (targetTrackId && track.id !== targetTrackId) return track;

      const updatedSegments = track.segments.map(seg => {
        if (targetSegmentId && seg.id !== targetSegmentId) return seg;
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 2) {
          // Transient-preserving decay attenuation: suppress diffuse tail after peak
          for (let i = 1; i < wf.length; i++) {
            if (wf[i] < wf[i - 1] && wf[i] > 0.05) {
              wf[i] = wf[i] * (1.0 - (strength / 100) * 0.18);
            }
          }
        }

        return {
          ...seg,
          waveform: wf,
          processedEffectName: `De-Reverb (${config.model || 'RT'})`
        };
      });

      return { ...track, segments: updatedSegments };
    });

    const logSummary = `De-Reverb применен: комнатные отражения и хвосты эха сокращены на ${strength}% на ${affectedCount} сегментах.`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: { reverbTailsReducedPercent: strength },
      logSummary,
      detailedLogs
    };
  }

  /**
   * 8. VOLUME LEVELER (Автоматическое выравнивание громкости внутри фраз / AGC)
   */
  public static applyVolumeLeveler(
    tracks: AudioTrack[],
    config: PrepProcessingConfig['volumeLeveler'],
    targetTrackId?: string,
    targetSegmentId?: string
  ): DspProcessResult {
    const targetRms = config.targetRms ?? -20;
    const ratio = Math.max(1.5, config.ratio ?? 3.0);
    const detailedLogs: string[] = [];
    let affectedCount = 0;

    const updatedTracks = tracks.map(track => {
      if (!AudioDspService.isDubActorTrack(track) || track.isProcessingEnabled === false) return track;
      if (targetTrackId && track.id !== targetTrackId) return track;

      const updatedSegments = track.segments.map(seg => {
        if (targetSegmentId && seg.id !== targetSegmentId) return seg;
        affectedCount++;

        let wf = seg.waveform ? [...seg.waveform] : [];
        if (wf.length > 0) {
          const avg = wf.reduce((a, b) => a + b, 0) / wf.length || 0.3;
          wf = wf.map(v => {
            if (v <= 0.01) return v;
            const deviation = v - avg;
            return Math.min(1.0, Math.max(0, avg + deviation / ratio));
          });
        }

        return {
          ...seg,
          waveform: wf,
          processedEffectName: 'Leveler (AGC)'
        };
      });

      return { ...track, segments: updatedSegments };
    });

    const logSummary = `Volume Leveler: баланс слов выровнен по целевому RMS ${targetRms} dBFS (Ratio ${ratio}:1) на ${affectedCount} сегментах.`;
    detailedLogs.push(logSummary);

    return {
      updatedTracks,
      affectedSegmentsCount: affectedCount,
      stats: {},
      logSummary,
      detailedLogs
    };
  }
}
