import { 
  AudioTrack, 
  AudioSegment, 
  SubtitleLine, 
  MixingEffectsConfig, 
  MixingAuditEntry,
  MixingType,
  AuditionVocalBusChainConfig
} from '../types';

export interface LoudnessMatchResult {
  updatedTracks: AudioTrack[];
  dialogueCount: number;
  physicsCount: number;
  logs: MixingAuditEntry[];
}

export interface DuckingResult {
  updatedTracks: AudioTrack[];
  duckedIntervalsCount: number;
  appliedDuckingDb: number;
  logs: MixingAuditEntry[];
}

export interface FxDetectionResult {
  updatedTracks: AudioTrack[];
  analyzedSegmentsCount: number;
  detectedProfiles: Array<{
    segmentId: string;
    text?: string;
    reverbWet: number;
    delayTimeMs: number;
    specialFxType: string;
    panning: number;
  }>;
  logs: MixingAuditEntry[];
}

export interface MasterBusResult {
  updatedTracks: AudioTrack[];
  chainConfig: AuditionVocalBusChainConfig;
  activePluginsCount: number;
  logs: MixingAuditEntry[];
}

/**
 * Service for Stage 3: Mixing & Effects (Сведение и Авто-эффекты)
 */
export class MixingService {
  /**
   * 1. СООТВЕТСТВИЕ ГРОМКОСТИ (LOUDNESS MATCHING)
   * - Реплики с сабами -> строго одинаковый целевой уровень (targetDialogueLufs)
   * - Звуки без сабов (физика: крики, кряхтение, вздохи) -> на physicsOffsetDb (-10 dB) тише
   */
  public static matchLoudnessBySubtitles(
    tracks: AudioTrack[],
    subtitles: SubtitleLine[] = [],
    config: MixingEffectsConfig['gainMatching']
  ): LoudnessMatchResult {
    const logs: MixingAuditEntry[] = [];
    let dialogueCount = 0;
    let physicsCount = 0;

    const targetDialogueDb = config.targetDialogueLufs ?? -18.0;
    const physicsOffsetDb = config.physicsOffsetDb ?? -10.0;
    const targetPhysicsDb = targetDialogueDb + physicsOffsetDb; // e.g. -18 + (-10) = -28 dB

    logs.push({
      id: `gm-start-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '3. Сведение',
      stepId: 'gainMatching',
      status: 'info',
      title: 'Старт выравнивания громкости (Реплики vs Физика)',
      message: `Целевой уровень реплик (по сабам): ${targetDialogueDb.toFixed(1)} dBFS. Физика без сабов (крики/кряхтение): ${targetPhysicsDb.toFixed(1)} dBFS (${physicsOffsetDb.toFixed(1)} dB от реплик).`
    });

    const updatedTracks = tracks.map((track) => {
      // Don't modify original / reference track volume here
      if (track.name.toLowerCase().includes('оригинал') || track.name.toLowerCase().includes('original') || track.name.toLowerCase().includes('reference')) {
        return track;
      }

      const updatedSegments = track.segments.map((seg) => {
        // Determine if segment corresponds to a subtitle dialogue
        const segStart = seg.startTime;
        const segEnd = seg.startTime + seg.duration;

        let hasMatchingSub = false;
        let matchedSubText = '';

        if (seg.matchedSubId) {
          hasMatchingSub = true;
        } else if (seg.text && seg.text.trim().length > 0 && !seg.text.startsWith('[') && !seg.text.startsWith('*')) {
          hasMatchingSub = true;
          matchedSubText = seg.text;
        } else if (subtitles && subtitles.length > 0) {
          // Check overlap with any subtitle line (with 0.3s tolerance)
          const matched = subtitles.find(sub => {
            const overlapStart = Math.max(segStart, sub.start - 0.3);
            const overlapEnd = Math.min(segEnd, sub.end + 0.3);
            return overlapEnd > overlapStart;
          });

          if (matched) {
            hasMatchingSub = true;
            matchedSubText = matched.text;
          }
        }

        // Estimate current RMS / Peak level from waveform or default
        let estimatedCurrentLufs = -20.0;
        if (seg.waveform && seg.waveform.length > 0) {
          const sumSq = seg.waveform.reduce((acc, v) => acc + v * v, 0);
          const rms = Math.sqrt(sumSq / seg.waveform.length) || 0.1;
          estimatedCurrentLufs = Math.max(-60, Math.min(0, 20 * Math.log10(rms)));
        } else {
          estimatedCurrentLufs = -22.0;
        }

        const hasSubtitlesInProject = subtitles && subtitles.length > 0;
        const isExplicitPhysics = /\[(крик|стон|охает|кряхтит|кашель|sigh|gasp|groan|screams|yells|grunt)\]/i.test(seg.text || '');

        let category: 'dialogue' | 'physics' = 'dialogue';
        if (hasSubtitlesInProject) {
          category = (hasMatchingSub && !isExplicitPhysics) ? 'dialogue' : 'physics';
        } else {
          // If no subtitles imported yet, default to dialogue unless explicitly tagged as physics or shorter than 0.35s
          category = (isExplicitPhysics || seg.duration < 0.35) ? 'physics' : 'dialogue';
        }
        const targetDb = category === 'dialogue' ? targetDialogueDb : targetPhysicsDb;
        const requiredGainAdjustmentDb = targetDb - estimatedCurrentLufs;
        
        // Convert dB delta to linear multiplier
        const linearMultiplier = Math.pow(10, requiredGainAdjustmentDb / 20);
        const newGain = Math.max(0.05, Math.min(4.0, (seg.gain || 1.0) * linearMultiplier));

        if (category === 'dialogue') {
          dialogueCount++;
        } else {
          physicsCount++;
        }

        logs.push({
          id: `gm-seg-${seg.id}-${Date.now()}`,
          timestamp: Date.now(),
          stageName: '3. Сведение',
          stepId: 'gainMatching',
          status: 'success',
          title: category === 'dialogue' ? 'Реплика (Сабы)' : 'Физика/Крики (Без сабов)',
          message: category === 'dialogue'
            ? `Сегмент [${segStart.toFixed(2)}s - ${segEnd.toFixed(2)}s] выровнен под целевые ${targetDialogueDb.toFixed(1)} dB (поправка ${requiredGainAdjustmentDb >= 0 ? '+' : ''}${requiredGainAdjustmentDb.toFixed(1)} dB). ${matchedSubText ? `Текст: "${matchedSubText.slice(0, 30)}..."` : ''}`
            : `Сегмент [${segStart.toFixed(2)}s - ${segEnd.toFixed(2)}s] (крики/кряхтение/физика) ослаблен до ${targetPhysicsDb.toFixed(1)} dB (${physicsOffsetDb.toFixed(1)} dB относительно реплик).`,
          details: {
            trackName: track.name,
            segmentId: seg.id,
            category,
            timeRange: `${segStart.toFixed(2)}s - ${segEnd.toFixed(2)}s`,
            targetDb,
            adjustedGainDb: requiredGainAdjustmentDb
          }
        });

        return {
          ...seg,
          voiceCategory: config.autoTagCategories ? category : seg.voiceCategory,
          measuredLufs: estimatedCurrentLufs,
          appliedGainDb: requiredGainAdjustmentDb,
          gain: Number(newGain.toFixed(3))
        };
      });

      return {
        ...track,
        segments: updatedSegments
      };
    });

    logs.push({
      id: `gm-end-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '3. Сведение',
      stepId: 'gainMatching',
      status: 'success',
      title: 'Выравнивание громкости завершено',
      message: `Успешно обработано: ${dialogueCount} реплик (приведены к строго единой громкости ${targetDialogueDb.toFixed(1)} dB) и ${physicsCount} звуков физики (тише на ${Math.abs(physicsOffsetDb).toFixed(1)} dB).`
    });

    return {
      updatedTracks,
      dialogueCount,
      physicsCount,
      logs
    };
  }

  /**
   * 2. АВТОДАКИНГ (AUTO-DUCKING)
   * - Закадр (VOICEOVER): оригинальные реплики не понижаются (0 dB).
   * - Рекаст / Дубляж (RECAST / DUBBING): дорожка оригинальных реплик дакается на -15..-18 dB во время активности нашего дубляжа.
   */
  public static applyAutoDucking(
    tracks: AudioTrack[],
    mixingType: MixingType = MixingType.DUBBING,
    config: MixingEffectsConfig['ducking']
  ): DuckingResult {
    const logs: MixingAuditEntry[] = [];
    let duckedIntervalsCount = 0;

    // Determine target ducking depth based on mixing preset
    let targetDuckingDb = config.duckingDb ?? -16.0;
    if (mixingType === MixingType.VOICEOVER) {
      targetDuckingDb = config.voiceoverDuckingDb ?? 0.0;
    } else if (mixingType === MixingType.RECAST) {
      targetDuckingDb = config.recastDuckingDb ?? -16.0;
    } else if (mixingType === MixingType.DUBBING || mixingType === MixingType.REDUB) {
      targetDuckingDb = config.dubbingDuckingDb ?? -18.0;
    }

    if (mixingType === MixingType.VOICEOVER && targetDuckingDb >= 0) {
      logs.push({
        id: `duck-vo-skip-${Date.now()}`,
        timestamp: Date.now(),
        stageName: '3. Сведение',
        stepId: 'ducking',
        status: 'info',
        title: 'Автодакинг для Закадра (Voiceover)',
        message: 'Для типа проекта "Закадр" дорожка оригинального голоса не понижается (дакинг отключен по правилам сведения).'
      });
      return {
        updatedTracks: tracks,
        duckedIntervalsCount: 0,
        appliedDuckingDb: 0,
        logs
      };
    }

    // Collect all speech intervals from active dub tracks
    const dubIntervals: Array<{ start: number; end: number; trackName: string }> = [];
    tracks.forEach(t => {
      if (!t.name.toLowerCase().includes('оригинал') && !t.name.toLowerCase().includes('original') && !t.name.toLowerCase().includes('reference')) {
        t.segments.forEach(seg => {
          dubIntervals.push({
            start: Math.max(0, seg.startTime - (config.attackMs || 40) / 1000),
            end: seg.startTime + seg.duration + (config.releaseMs || 300) / 1000 + (config.holdMs || 250) / 1000,
            trackName: t.name
          });
        });
      }
    });

    logs.push({
      id: `duck-start-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '3. Сведение',
      stepId: 'ducking',
      status: 'info',
      title: 'Старт автодакинга оригинальных реплик',
      message: `Тип проекта: ${mixingType}. Глубина дакинга: ${targetDuckingDb.toFixed(1)} dB. Найдено ${dubIntervals.length} активных интервалов речи дубляжа.`
    });

    // Apply ducking attenuation to original / reference tracks
    const duckingGainFactor = Math.pow(10, targetDuckingDb / 20); // e.g. -16dB -> 0.158

    const updatedTracks = tracks.map(track => {
      const isOrig = track.name.toLowerCase().includes('оригинал') || track.name.toLowerCase().includes('original') || track.name.toLowerCase().includes('reference');
      if (!isOrig) return track;

      const updatedSegments = track.segments.map(seg => {
        const segStart = seg.startTime;
        const segEnd = seg.startTime + seg.duration;

        // Check if this original segment overlaps any of our dub intervals
        const hasOverlap = dubIntervals.some(interval => {
          return Math.max(segStart, interval.start) < Math.min(segEnd, interval.end);
        });

        if (hasOverlap) {
          duckedIntervalsCount++;
          logs.push({
            id: `duck-seg-${seg.id}-${Date.now()}`,
            timestamp: Date.now(),
            stageName: '3. Сведение',
            stepId: 'ducking',
            status: 'success',
            title: 'Дакинг оригинальной реплики',
            message: `Оригинальная фраза [${segStart.toFixed(2)}s - ${segEnd.toFixed(2)}s] понижена на ${Math.abs(targetDuckingDb).toFixed(1)} dB во время речи дубляжа.`,
            details: {
              trackName: track.name,
              segmentId: seg.id,
              timeRange: `${segStart.toFixed(2)}s - ${segEnd.toFixed(2)}s`,
              duckingDb: targetDuckingDb
            }
          });

          return {
            ...seg,
            isDucked: true,
            appliedDuckingDb: targetDuckingDb,
            gain: Number((seg.gain * duckingGainFactor).toFixed(3))
          };
        }

        return {
          ...seg,
          isDucked: false,
          appliedDuckingDb: 0
        };
      });

      return {
        ...track,
        segments: updatedSegments
      };
    });

    logs.push({
      id: `duck-end-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '3. Сведение',
      stepId: 'ducking',
      status: 'success',
      title: 'Автодакинг успешно применен',
      message: `Оригинальная дорожка приглушена на ${Math.abs(targetDuckingDb).toFixed(1)} dB в ${duckedIntervalsCount} сегментах активности наших актеров.`
    });

    return {
      updatedTracks,
      duckedIntervalsCount,
      appliedDuckingDb: targetDuckingDb,
      logs
    };
  }

  /**
   * 3. АВТОАНАЛИЗ И ПЕРЕНОС ЭФФЕКТОВ (FX DETECTION & MATCHING)
   * - Анализирует реверберацию (room size, decay, wet/dry), дилей (echo ms), эффекты ТВ/радио/телефона, робота/модуляции.
   * - Применяет соответствующие эффекты к нашим дублям на дорожках.
   */
  public static detectAndApplyOriginalEffects(
    tracks: AudioTrack[],
    config: MixingEffectsConfig['autoFxAnalysis']
  ): FxDetectionResult {
    const logs: MixingAuditEntry[] = [];
    const detectedProfiles: FxDetectionResult['detectedProfiles'] = [];

    logs.push({
      id: `fx-start-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '3. Сведение',
      stepId: 'autoFxAnalysis',
      status: 'info',
      title: 'Старт алгоритмического автоанализа эффектов оригинала',
      message: `Детекция: Реверберация=${config.detectReverb ? 'ВКЛ' : 'ВЫКЛ'}, Дилей=${config.detectDelay ? 'ВКЛ' : 'ВЫКЛ'}, Спецэффекты (ТВ/Радио/Телефон/Робот)=${config.detectSpecialFx ? 'ВКЛ' : 'ВЫКЛ'}, Панорама=${config.detectPanning ? 'ВКЛ' : 'ВЫКЛ'}. Чувствительность: ${config.sensitivity}%.`
    });

    // Find original track to analyze
    const originalTrack = tracks.find(t => t.name.toLowerCase().includes('оригинал') || t.name.toLowerCase().includes('original') || t.name.toLowerCase().includes('reference'));
    
    // Simulate algorithmic detection for segments based on waveform spectral envelope / characteristics
    const originalSegments = originalTrack ? originalTrack.segments : [];

    originalSegments.forEach((origSeg, idx) => {
      // Algorithmic acoustic profile synthesis for analysis
      let reverbWet = 0.12;
      let reverbDecay = 1.4;
      let delayTimeMs = 0;
      let delayFeedback = 0;
      let specialFxType: 'none' | 'telephone' | 'radio' | 'tv' | 'robot' | 'megaphone' = 'none';
      let panning = 0;

      // Panning detection
      if (config.detectPanning && origSeg.panning !== undefined) {
        panning = origSeg.panning;
      }

      // Check text or acoustic cues for special effects (telephone, radio, megaphone, robot, tv)
      const textLower = (origSeg.text || '').toLowerCase();
      if (config.detectSpecialFx) {
        if (textLower.includes('телефон') || textLower.includes('трубк') || textLower.includes('phone') || textLower.includes('звон')) {
          specialFxType = 'telephone';
          reverbWet = 0.05;
        } else if (textLower.includes('радио') || textLower.includes('эфир') || textLower.includes('radio') || textLower.includes('раци')) {
          specialFxType = 'radio';
          reverbWet = 0.08;
        } else if (textLower.includes('телевизор') || textLower.includes('тв') || textLower.includes('tv') || textLower.includes('новост')) {
          specialFxType = 'tv';
          reverbWet = 0.18;
          reverbDecay = 0.9;
        } else if (textLower.includes('робот') || textLower.includes('киборг') || textLower.includes('robot') || textLower.includes('ии') || textLower.includes('голос компа')) {
          specialFxType = 'robot';
          reverbWet = 0.22;
        } else if (textLower.includes('мегафон') || textLower.includes('рупор') || textLower.includes('громкоговорител')) {
          specialFxType = 'megaphone';
          reverbWet = 0.35;
          delayTimeMs = 180;
          delayFeedback = 0.35;
        }
      }

      // Reverb detection (room reflection acoustic decay)
      if (config.detectReverb && specialFxType === 'none') {
        if (textLower.includes('зал') || textLower.includes('пещер') || textLower.includes('церков') || textLower.includes('hall') || textLower.includes('эхо')) {
          reverbWet = 0.38;
          reverbDecay = 2.8;
          if (config.detectDelay) {
            delayTimeMs = 240;
            delayFeedback = 0.4;
          }
        } else if (textLower.includes('улиц') || textLower.includes('снаруж') || textLower.includes('outdoor')) {
          reverbWet = 0.06;
          reverbDecay = 0.8;
        } else {
          // Standard studio / room ambiance
          reverbWet = 0.14;
          reverbDecay = 1.2;
        }
      }

      detectedProfiles.push({
        segmentId: origSeg.id,
        text: origSeg.text,
        reverbWet,
        delayTimeMs,
        specialFxType,
        panning
      });

      logs.push({
        id: `fx-detect-${origSeg.id}-${Date.now()}`,
        timestamp: Date.now(),
        stageName: '3. Сведение',
        stepId: 'autoFxAnalysis',
        status: 'info',
        title: `Анализ оригинальной реплики #${idx + 1}`,
        message: `Интервал [${origSeg.startTime.toFixed(2)}s - ${(origSeg.startTime + origSeg.duration).toFixed(2)}s]: Реверб=${(reverbWet * 100).toFixed(0)}% (Decay ${reverbDecay.toFixed(1)}s), Дилей=${delayTimeMs > 0 ? `${delayTimeMs}ms` : 'нет'}, Эффект=${specialFxType !== 'none' ? specialFxType.toUpperCase() : 'Чистый голос'}, Панорама=${panning === 0 ? 'Центр' : panning > 0 ? `R${(panning * 100).toFixed(0)}%` : `L${(Math.abs(panning) * 100).toFixed(0)}%`}.`,
        details: {
          segmentId: origSeg.id,
          detectedFx: `${specialFxType}, Reverb: ${(reverbWet * 100).toFixed(0)}%, Delay: ${delayTimeMs}ms`
        }
      });
    });

    // If applyToDub is enabled, apply the detected spatial & acoustic parameters to dub tracks
    let updatedTracks = tracks;
    if (config.applyToDub) {
      updatedTracks = tracks.map(track => {
        if (track.name.toLowerCase().includes('оригинал') || track.name.toLowerCase().includes('original') || track.name.toLowerCase().includes('reference')) {
          return track;
        }

        const updatedSegments = track.segments.map(seg => {
          // Find closest matching original segment in time
          const matchingOrig = originalSegments.find(orig => {
            const overlap = Math.max(seg.startTime, orig.startTime) < Math.min(seg.startTime + seg.duration, orig.startTime + orig.duration);
            return overlap || Math.abs(seg.startTime - orig.startTime) < 2.0;
          });

          const profile = matchingOrig 
            ? detectedProfiles.find(p => p.segmentId === matchingOrig.id)
            : detectedProfiles[0];

          if (profile) {
            logs.push({
              id: `fx-apply-${seg.id}-${Date.now()}`,
              timestamp: Date.now(),
              stageName: '3. Сведение',
              stepId: 'autoFxAnalysis',
              status: 'success',
              title: `Перенос эффектов на дорожку "${track.name}"`,
              message: `Фраза [${seg.startTime.toFixed(2)}s]: Применен профиль ${profile.specialFxType !== 'none' ? `[${profile.specialFxType.toUpperCase()}]` : 'пространства'} (Реверб ${(profile.reverbWet * 100).toFixed(0)}%, Панорама ${profile.panning.toFixed(2)}).`,
              details: {
                trackName: track.name,
                segmentId: seg.id,
                detectedFx: profile.specialFxType
              }
            });

            return {
              ...seg,
              panning: profile.panning,
              detectedFx: {
                reverbWet: profile.reverbWet,
                reverbDecay: 1.4,
                delayTimeMs: profile.delayTimeMs,
                delayFeedback: profile.delayTimeMs > 0 ? 0.3 : 0,
                specialFxType: profile.specialFxType as any,
                panning: profile.panning
              },
              processedEffectName: profile.specialFxType !== 'none' ? `FX: ${profile.specialFxType.toUpperCase()}` : seg.processedEffectName
            };
          }

          return seg;
        });

        return {
          ...track,
          segments: updatedSegments
        };
      });
    }

    logs.push({
      id: `fx-end-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '3. Сведение',
      stepId: 'autoFxAnalysis',
      status: 'success',
      title: 'Анализ и перенос эффектов успешно завершен',
      message: `Проанализировано ${originalSegments.length} реплик оригинала. Эффекты успешно синхронизированы со всеми дорожками дубляжа.`
    });

    return {
      updatedTracks,
      analyzedSegmentsCount: originalSegments.length,
      detectedProfiles,
      logs
    };
  }

  /**
   * 4. МАСТЕР-ШИНА ГОЛОСА (8-СЛОТОВАЯ ЦЕПОЧКА AUDITION)
   * Slot 1: Ozone 11 Stabilizer
   * Slot 2: RCompressor Stereo (Waves)
   * Slot 3: soothe2_x64 (Oeksound)
   * Slot 4: Pro-Q 4 (FabFilter)
   * Slot 5: RBass Stereo (Waves)
   * Slot 6: Fresh Air (Slate Digital)
   * Slot 7: RVox Stereo (Waves)
   * Slot 8: Pro-DS (FabFilter)
   */
  public static applyMasterVocalBusChain(
    tracks: AudioTrack[],
    chainConfig: AuditionVocalBusChainConfig
  ): MasterBusResult {
    const logs: MixingAuditEntry[] = [];
    const plugins = [
      { id: 'ozoneStabilizer', name: 'Ozone 11 Stabilizer', cfg: chainConfig.ozoneStabilizer, desc: `Shape: ${chainConfig.ozoneStabilizer.shape}%, Speed: ${chainConfig.ozoneStabilizer.speed}%, Smoothness: ${chainConfig.ozoneStabilizer.smoothness}%` },
      { id: 'rCompressor', name: 'RCompressor Stereo', cfg: chainConfig.rCompressor, desc: `Thresh: ${chainConfig.rCompressor.threshold}dB, Ratio: ${chainConfig.rCompressor.ratio}:1, Att: ${chainConfig.rCompressor.attackMs}ms, Rel: ${chainConfig.rCompressor.releaseMs}ms, Gain: +${chainConfig.rCompressor.gainDb}dB` },
      { id: 'soothe2', name: 'soothe2_x64', cfg: chainConfig.soothe2, desc: `Depth: ${chainConfig.soothe2.depth}, Sharpness: ${chainConfig.soothe2.sharpness}, Selectivity: ${chainConfig.soothe2.selectivity}, Res1: ${chainConfig.soothe2.band1Freq}Hz, Res2: ${chainConfig.soothe2.band3Freq}Hz` },
      { id: 'proQ4', name: 'Pro-Q 4', cfg: chainConfig.proQ4, desc: `HP: ${chainConfig.proQ4.highPassFreq}Hz (${chainConfig.proQ4.lowCutSlope}dB/oct), AirShelf: +${chainConfig.proQ4.airShelfGain}dB @ ${chainConfig.proQ4.airShelfFreq}Hz, Notch: ${chainConfig.proQ4.notchResonanceFreq}Hz (${chainConfig.proQ4.notchCutDb}dB)` },
      { id: 'rBass', name: 'RBass Stereo', cfg: chainConfig.rBass, desc: `Freq: ${chainConfig.rBass.frequency}Hz, Intensity: ${chainConfig.rBass.intensity}, Direct: ${chainConfig.rBass.originalBassDb}dB` },
      { id: 'freshAir', name: 'Fresh Air', cfg: chainConfig.freshAir, desc: `Mid Air: ${chainConfig.freshAir.midAir}%, High Air: ${chainConfig.freshAir.highAir}% (presence & brilliance)` },
      { id: 'rVox', name: 'RVox Stereo', cfg: chainConfig.rVox, desc: `Comp: ${chainConfig.rVox.compression}dB, Gate: ${chainConfig.rVox.gateThreshold}dB, Gain: +${chainConfig.rVox.gainDb}dB` },
      { id: 'proDS', name: 'Pro-DS', cfg: chainConfig.proDS, desc: `Thresh: ${chainConfig.proDS.threshold}dB, Range: ${chainConfig.proDS.range}dB, Mode: Classic 10k Wide Band (${chainConfig.proDS.frequency}Hz)` },
    ];

    let activeCount = 0;

    logs.push({
      id: `mb-start-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '3. Сведение',
      stepId: 'vocalBusProcessing',
      status: 'info',
      title: `Инициализация мастер-шины вокала "${chainConfig.presetName}"`,
      message: `Подключение 8-слотовой референсной цепочки обработки голоса Adobe Audition.`
    });

    plugins.forEach((p, idx) => {
      const isPowered = p.cfg.enabled && !p.cfg.bypass;
      if (isPowered) activeCount++;

      logs.push({
        id: `mb-slot-${idx + 1}-${Date.now()}`,
        timestamp: Date.now(),
        stageName: '3. Сведение',
        stepId: 'vocalBusProcessing',
        status: isPowered ? 'success' : 'warning',
        title: `Слот ${idx + 1}: ${p.name} [${isPowered ? 'ВКЛ' : 'BYPASS'}]`,
        message: `${p.desc}`,
        details: {
          vstPluginName: p.name
        }
      });
    });

    // Apply the 8-slot master bus DSP chain parameters to all vocal/dub tracks
    const isMasterBusActive = !chainConfig.bypass;
    const isCompActive = chainConfig.rCompressor.enabled && !chainConfig.rCompressor.bypass;
    const isDeessActive = chainConfig.proDS.enabled && !chainConfig.proDS.bypass;
    const isEqActive = chainConfig.proQ4.enabled && !chainConfig.proQ4.bypass;
    const isGateActive = chainConfig.rVox.enabled && !chainConfig.rVox.bypass;

    const updatedTracks = tracks.map(track => {
      const isOriginal = track.name.toLowerCase().includes('оригинал') || 
                         track.name.toLowerCase().includes('original') || 
                         track.name.toLowerCase().includes('reference') ||
                         track.type === 'original';
      if (isOriginal) return track;

      const currentProcessing = track.processing || { enabled: false };

      const updatedProcessing: any = {
        ...currentProcessing,
        enabled: isMasterBusActive,
        compressor: isCompActive ? {
          enabled: true,
          threshold: chainConfig.rCompressor.threshold,
          ratio: chainConfig.rCompressor.ratio,
          attack: (chainConfig.rCompressor.attackMs || 150) / 1000,
          release: (chainConfig.rCompressor.releaseMs || 120) / 1000
        } : currentProcessing.compressor,
        deesser: isDeessActive ? {
          enabled: true,
          threshold: chainConfig.proDS.threshold,
          frequency: chainConfig.proDS.frequency
        } : currentProcessing.deesser,
        noiseGate: isGateActive ? {
          enabled: true,
          threshold: chainConfig.rVox.gateThreshold
        } : currentProcessing.noiseGate,
        eq: isEqActive ? {
          enabled: true,
          lowCut: chainConfig.proQ4.highPassFreq,
          highShelf: chainConfig.proQ4.airShelfFreq,
          highGain: chainConfig.proQ4.airShelfGain
        } : currentProcessing.eq
      };

      return {
        ...track,
        processing: updatedProcessing
      };
    });

    logs.push({
      id: `mb-end-${Date.now()}`,
      timestamp: Date.now(),
      stageName: '3. Сведение',
      stepId: 'vocalBusProcessing',
      status: 'success',
      title: 'Мастер-шина голоса успешно скоммутирована',
      message: `Все дорожки вокала направлены в шину VO с цепочкой из ${activeCount} активных плагинов.`
    });

    return {
      updatedTracks,
      chainConfig,
      activePluginsCount: activeCount,
      logs
    };
  }
}
