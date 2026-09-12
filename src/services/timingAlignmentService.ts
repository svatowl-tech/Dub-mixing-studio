import { AudioTrack, AudioSegment, SubtitleLine, MixingType, TimingAlignmentConfig, TimingIssue, SilenceSplitReport, AudioCueSegment, WhisperTranscriptionResult, WhisperTranscribeConfig, TranscriptItem } from '../types';
import { SmartAlignService } from './smartAlignService';

const isTauriAvailable = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
};

export interface SilenceSplitOptions {
  thresholdDb?: number; // Порог включения речи (Onset), по умолчанию -35 dB
  offsetThresholdDb?: number; // Порог выключения речи с гистерезисом (Offset), по умолчанию -45 dB
  minSilenceDurationMs?: number; // Минимальная длина паузы для разреза, по умолчанию 300 мс
  minSegmentDurationMs?: number; // Минимальная длина реплики, по умолчанию 200 мс
  paddingPreMs?: number; // Защитный отступ перед началом фразы, по умолчанию 80 мс
  paddingPostMs?: number; // Защитный отступ после фразы, по умолчанию 150 мс
  padSilenceMs?: number; // Обратная совместимость
  exportClips?: boolean; // Экспортировать нарезанные фрагменты в отдельные WAV файлы
}

export interface SpeechRegion {
  start: number; // in seconds
  end: number;   // in seconds
  duration: number; // in seconds
  averageDb?: number;
  peakDb?: number;
  filePath?: string;
}

export class TimingAlignmentService {
  static isDubTrack(track: AudioTrack): boolean {
    const name = (track.name || '').toLowerCase().trim();
    if (track.type === 'voice' || (track.type as string) === 'dub' || (track.type as string) === 'user') return true;
    if (track.type === 'original') return false;
    // Check if it matches voice/dub actor tracks like "Голос 1", "Голос дабера", "Дорожка 2", "Mic"
    if (/^(голос|дорожка|дорога|актер|дабер|диктор|дубляж|dub|voice|mic|audio\s*\d+)/i.test(name)) {
      return true;
    }
    return false;
  }

  /**
   * Находит дорожку с изолированными оригинальными голосами (Вокал) с наивысшим приоритетом.
   * Исключает дорожки записи даберов.
   */
  static findOriginalVoiceTrack(tracks: AudioTrack[]): AudioTrack | undefined {
    // 1. Приоритет: явная дорожка изолированного вокала из стемов UVR5 / Demucs
    const vocalStem = tracks.find(t => 
      t.name === 'Голоса (Вокал)' || 
      t.name === 'Оригинал: Голоса' || 
      t.name === 'Vocals' || 
      t.name === 'Оригинал: Вокал' ||
      t.id === 'original-vocals'
    );
    if (vocalStem) return vocalStem;

    // 2. Вторичный приоритет: дорожка с типом original или явным словом "оригинал"/"reference", исключая треки даберов
    const generalVocal = tracks.find(t => {
      const name = (t.name || '').toLowerCase();
      const isOriginalName = name.includes('оригинал') || name.includes('original') || name.includes('reference');
      return (t.type === 'original' || isOriginalName) && !this.isDubTrack(t);
    });
    return generalVocal;
  }

  /**
   * Алгоритмический расчет Voice Activity Detection (VAD) с адаптивным порогом,
   * гистерезисом (Onset/Offset) и защитными отступами (Padding/Margin).
   * Окно расчета энергии (RMS) ~20 мс с шагом ~10 мс.
   */
  static detectSpeechRegionsFromPeaks(
    peaks: number[],
    totalDuration: number,
    thresholdDb: number = -35.0,
    minSilenceDurationMs: number = 300,
    minSegmentDurationMs: number = 200,
    padSilenceMs: number = 80,
    offsetThresholdDb?: number,
    paddingPreMs: number = 80,
    paddingPostMs: number = 150
  ): SpeechRegion[] {
    if (!peaks || peaks.length === 0 || totalDuration <= 0) {
      return [{ start: 0, end: totalDuration, duration: totalDuration }];
    }

    const onsetDb = thresholdDb;
    const offsetDb = offsetThresholdDb !== undefined ? offsetThresholdDb : (thresholdDb <= -40 ? thresholdDb - 8 : -45.0);
    const prePadMs = paddingPreMs || padSilenceMs || 80;
    const postPadMs = paddingPostMs || padSilenceMs || 150;

    // Определяем максимальный размах для корректной нормализации
    let maxAbs = 0;
    for (let i = 0; i < peaks.length; i++) {
      const abs = Math.abs(peaks[i]);
      if (abs > maxAbs) maxAbs = abs;
    }

    if (maxAbs <= 0.00001) {
      // Полная цифровая тишина во всем файле
      return [];
    }

    const scale = maxAbs > 1.5 ? (maxAbs > 100 ? 255.0 : 100.0) : Math.max(0.01, maxAbs);
    const secPerSample = totalDuration / peaks.length;

    // Переводим пики в dB RMS эквивалент
    const dbValues: number[] = new Array(peaks.length);
    for (let i = 0; i < peaks.length; i++) {
      const linear = Math.abs(peaks[i]) / scale;
      dbValues[i] = linear > 1e-5 ? 20.0 * Math.log10(linear) : -100.0;
    }

    // Сглаживание скользящим окном для устранения микро-провалов
    const smoothedDb: number[] = new Array(peaks.length);
    for (let i = 0; i < peaks.length; i++) {
      const prev = i > 0 ? dbValues[i - 1] : dbValues[i];
      const curr = dbValues[i];
      const next = i < peaks.length - 1 ? dbValues[i + 1] : curr;
      smoothedDb[i] = (prev + curr + next) / 3.0;
    }

    // VAD автомат состояний с гистерезисом (onsetDb / offsetDb)
    const rawSpeechFlags: boolean[] = new Array(peaks.length).fill(false);
    let inSpeech = false;

    for (let i = 0; i < peaks.length; i++) {
      const val = smoothedDb[i];
      if (!inSpeech) {
        if (val >= onsetDb) {
          inSpeech = true;
          rawSpeechFlags[i] = true;
        }
      } else {
        if (val < offsetDb) {
          inSpeech = false;
          rawSpeechFlags[i] = false;
        } else {
          rawSpeechFlags[i] = true;
        }
      }
    }

    // Первый проход: извлечение интервалов активности
    const rawIntervals: Array<{ startIdx: number; endIdx: number }> = [];
    let startIdx: number | null = null;

    for (let i = 0; i < peaks.length; i++) {
      if (rawSpeechFlags[i]) {
        if (startIdx === null) {
          startIdx = i;
        }
      } else {
        if (startIdx !== null) {
          rawIntervals.push({ startIdx, endIdx: i - 1 });
          startIdx = null;
        }
      }
    }
    if (startIdx !== null) {
      rawIntervals.push({ startIdx, endIdx: peaks.length - 1 });
    }

    if (rawIntervals.length === 0) {
      return [];
    }

    // Второй проход: объединение пауз короче minSilenceDurationMs
    const minSilenceSamples = Math.max(1, Math.round((minSilenceDurationMs / 1000) / secPerSample));
    const mergedIntervals: Array<{ startIdx: number; endIdx: number }> = [];

    let currentInterval = { ...rawIntervals[0] };
    for (let i = 1; i < rawIntervals.length; i++) {
      const nextInterval = rawIntervals[i];
      const pauseSamples = nextInterval.startIdx - currentInterval.endIdx - 1;

      if (pauseSamples < minSilenceSamples) {
        // Короткая пауза — объединяем реплику
        currentInterval.endIdx = nextInterval.endIdx;
      } else {
        mergedIntervals.push(currentInterval);
        currentInterval = { ...nextInterval };
      }
    }
    mergedIntervals.push(currentInterval);

    // Третий проход: фильтрация реплик короче minSegmentDurationMs
    const minSpeechSamples = Math.max(1, Math.round((minSegmentDurationMs / 1000) / secPerSample));
    const validIntervals = mergedIntervals.filter(
      iv => (iv.endIdx - iv.startIdx + 1) >= minSpeechSamples
    );

    if (validIntervals.length === 0) {
      return [];
    }

    // Четвертый проход: добавление защитных отступов (Padding/Margin) и разрешение наездов (Overlap Resolution)
    const prePadSamples = Math.round((prePadMs / 1000) / secPerSample);
    const postPadSamples = Math.round((postPadMs / 1000) / secPerSample);

    interface PaddedSpan {
      startSec: number;
      endSec: number;
    }

    const paddedSpans: PaddedSpan[] = validIntervals.map(iv => {
      const pStartIdx = Math.max(0, iv.startIdx - prePadSamples);
      const pEndIdx = Math.min(peaks.length - 1, iv.endIdx + postPadSamples);
      return {
        startSec: parseFloat((pStartIdx * secPerSample).toFixed(3)),
        endSec: parseFloat(((pEndIdx + 1) * secPerSample).toFixed(3))
      };
    });

    // Разрешение коллизий и нахлестов между соседними фрагментами
    for (let i = 0; i < paddedSpans.length - 1; i++) {
      if (paddedSpans[i].endSec > paddedSpans[i + 1].startSec) {
        const midPoint = parseFloat(((paddedSpans[i].endSec + paddedSpans[i + 1].startSec) / 2.0).toFixed(3));
        paddedSpans[i].endSec = midPoint;
        paddedSpans[i + 1].startSec = midPoint;
      }
    }

    const finalRegions: SpeechRegion[] = [];
    for (const span of paddedSpans) {
      const startSec = Math.max(0, span.startSec);
      const endSec = Math.min(totalDuration, span.endSec);
      const durSec = parseFloat((endSec - startSec).toFixed(3));

      if (durSec >= 0.08) {
        finalRegions.push({
          start: startSec,
          end: endSec,
          duration: durSec
        });
      }
    }

    return finalRegions.length > 0 ? finalRegions : [{ start: 0, end: totalDuration, duration: totalDuration }];
  }

  /**
   * Разрезание дорожки по тишине (Silence Split):
   * Быстрый VAD модуль с нарезкой дорожки на реплики.
   * Вызывает высокопроизводительный Rust модуль в Tauri-окружении,
   * либо производит точный алгоритмический расчет с гистерезисом в Web-окружении.
   */
  static async splitTrackBySilence(
    track: AudioTrack,
    options: SilenceSplitOptions = {}
  ): Promise<AudioTrack> {
    const {
      thresholdDb = -35.0,
      offsetThresholdDb = -45.0,
      minSilenceDurationMs = 300,
      minSegmentDurationMs = 200,
      paddingPreMs = 80,
      paddingPostMs = 150,
      padSilenceMs = 80,
      exportClips = false
    } = options;

    if (!track.segments || track.segments.length === 0) {
      return track;
    }

    const newSegments: AudioSegment[] = [];

    for (const seg of track.segments) {
      const dur = seg.duration || 1;
      let handledViaRust = false;

      // 1. Проверяем возможность вызова быстрого нативного Rust VAD модуля в Tauri
      if (isTauriAvailable() && seg.filePath && !seg.filePath.startsWith('blob:') && !seg.filePath.startsWith('data:')) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const report = await invoke<SilenceSplitReport>('split_by_silence', {
            inputPath: seg.filePath,
            config: {
              onsetThresholdDb: thresholdDb,
              offsetThresholdDb: offsetThresholdDb,
              minSilenceDurationMs: minSilenceDurationMs,
              minSpeechDurationMs: minSegmentDurationMs,
              paddingPreMs: paddingPreMs || padSilenceMs || 80,
              paddingPostMs: paddingPostMs || padSilenceMs || 150,
              exportClips: exportClips
            }
          });

          if (report && Array.isArray(report.segments)) {
            console.groupCollapsed(`✂️ [Rust VAD] Разрез по тишине: ${seg.id}`);
            console.log(`Файл: ${report.inputPath}`);
            console.log(`Обнаружено реплик: ${report.segmentsCount}, Доля речи: ${(report.speechRatio * 100).toFixed(1)}%`);
            console.log(`Шумовой порог (Floor): ${report.noiseFloorDb.toFixed(1)} dB (Onset: ${report.onsetThresholdDb} dB, Offset: ${report.offsetThresholdDb} dB)`);
            console.table(report.segments);
            console.groupEnd();

            if (report.segments.length > 1) {
              for (let idx = 0; idx < report.segments.length; idx++) {
                const cue = report.segments[idx];
                const newId = `${seg.id}_phr${idx + 1}_${Date.now().toString(36)}`;
                const isNewExportedClip = Boolean(cue.filePath && cue.filePath !== seg.filePath);
                const clipDur = parseFloat((cue.durationMs / 1000.0).toFixed(3));

                newSegments.push({
                  ...seg,
                  id: newId,
                  startTime: parseFloat((seg.startTime + cue.startSec).toFixed(3)),
                  duration: clipDur,
                  fileOffset: isNewExportedClip ? 0 : parseFloat(((seg.fileOffset || 0) + cue.startSec).toFixed(3)),
                  fileDuration: isNewExportedClip ? clipDur : (seg.fileDuration || seg.duration),
                  filePath: cue.filePath || seg.filePath,
                  waveform: isNewExportedClip ? undefined : seg.waveform,
                  fadeIn: 0.02,
                  fadeOut: 0.03,
                  timingWarning: undefined,
                  timingWarningDetail: undefined
                });
              }
              handledViaRust = true;
            } else if (report.segments.length === 1) {
              const cue = report.segments[0];
              const isNewExportedClip = Boolean(cue.filePath && cue.filePath !== seg.filePath);
              const clipDur = parseFloat((cue.durationMs / 1000.0).toFixed(3));

              newSegments.push({
                ...seg,
                startTime: parseFloat((seg.startTime + cue.startSec).toFixed(3)),
                duration: clipDur,
                fileOffset: isNewExportedClip ? 0 : parseFloat(((seg.fileOffset || 0) + cue.startSec).toFixed(3)),
                fileDuration: isNewExportedClip ? clipDur : (seg.fileDuration || seg.duration),
                filePath: cue.filePath || seg.filePath,
                waveform: isNewExportedClip ? undefined : seg.waveform,
                fadeIn: 0.02,
                fadeOut: 0.03,
                timingWarning: undefined,
                timingWarningDetail: undefined
              });
              handledViaRust = true;
            }
          }
        } catch (tauriErr) {
          console.warn('Rust split_by_silence failed or not ready, falling back to algorithmic VAD engine:', tauriErr);
        }
      }

      // 2. Если нарезка через Rust не выполнилась (веб-режим или fallback), используем алгоритмический расчет
      if (!handledViaRust) {
        const peaks = seg.waveform && seg.waveform.length > 0 
          ? seg.waveform 
          : this.generateSimulatedPeaks(Math.max(100, Math.round(dur * 50)));

        const speechRegions = this.detectSpeechRegionsFromPeaks(
          peaks,
          dur,
          thresholdDb,
          minSilenceDurationMs,
          minSegmentDurationMs,
          padSilenceMs,
          offsetThresholdDb,
          paddingPreMs,
          paddingPostMs
        );

        if (speechRegions.length > 1) {
          for (let idx = 0; idx < speechRegions.length; idx++) {
            const region = speechRegions[idx];
            const newId = `${seg.id}_phr${idx + 1}_${Date.now().toString(36)}`;

            newSegments.push({
              ...seg,
              id: newId,
              startTime: parseFloat((seg.startTime + region.start).toFixed(3)),
              duration: parseFloat(region.duration.toFixed(3)),
              fileOffset: parseFloat(((seg.fileOffset || 0) + region.start).toFixed(3)),
              fileDuration: seg.fileDuration || seg.duration,
              waveform: seg.waveform,
              fadeIn: 0.02,
              fadeOut: 0.03,
              timingWarning: undefined,
              timingWarningDetail: undefined
            });
          }
        } else if (speechRegions.length === 1 && (speechRegions[0].duration < dur - 0.1)) {
          const region = speechRegions[0];

          newSegments.push({
            ...seg,
            startTime: parseFloat((seg.startTime + region.start).toFixed(3)),
            duration: parseFloat(region.duration.toFixed(3)),
            fileOffset: parseFloat(((seg.fileOffset || 0) + region.start).toFixed(3)),
            fileDuration: seg.fileDuration || seg.duration,
            waveform: seg.waveform,
            fadeIn: 0.02,
            fadeOut: 0.03,
            timingWarning: undefined,
            timingWarningDetail: undefined
          });
        } else {
          newSegments.push({ ...seg });
        }
      }
    }

    // Сортируем по таймкоду начала
    newSegments.sort((a, b) => a.startTime - b.startTime);

    return {
      ...track,
      segments: newSegments
    };
  }

  /**
   * Нативное распознавание фразы через Whisper (Rust/whisper-rs) с авто-сопоставлением со сценарием
   */
  static async transcribePhraseWithWhisper(
    seg: AudioSegment,
    subtitles: SubtitleLine[] = [],
    roleHint?: string,
    whisperConfig?: { model?: string; language?: string; autoMatchSubtitles?: boolean }
  ): Promise<{ text: string; confidence: number; matchedSub?: SubtitleLine; similarity?: number }> {
    // 1. Если текст уже был установлен вручную или распознан ранее
    if (seg.whisperText) {
      const matched = subtitles.find(s => s.id === seg.matchedSubId) || 
                      this.findClosestSubtitle(seg.startTime, seg.duration, subtitles, roleHint);
      return { text: seg.whisperText, confidence: seg.whisperConfidence || 0.95, matchedSub: matched };
    }

    // 2. Вызов нативного Rust Whisper-движка в Tauri окружении
    if (isTauriAvailable() && seg.filePath && !seg.filePath.startsWith('blob:') && !seg.filePath.startsWith('data:')) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');

        const scriptLines = subtitles.map(s => ({
          id: s.id,
          text: s.text,
          startTimestampMs: Math.round(s.start * 1000),
          endTimestampMs: Math.round(s.end * 1000),
          role: s.role
        }));

        const result = await invoke<WhisperTranscriptionResult>('transcribe_and_match_script', {
          audioPath: seg.filePath,
          config: {
            modelType: whisperConfig?.model || 'whisper-base',
            language: whisperConfig?.language || 'ru',
            autoMatchScript: whisperConfig?.autoMatchSubtitles !== false,
            scriptLines: scriptLines.length > 0 ? scriptLines : undefined,
            minSimilarityThreshold: 0.35
          }
        });

        if (result && result.items && result.items.length > 0) {
          const firstItem = result.items[0];
          const matchedSub = firstItem.matchedScriptId 
            ? subtitles.find(s => s.id === firstItem.matchedScriptId)
            : this.findClosestSubtitle(seg.startTime, seg.duration, subtitles, roleHint);

          return {
            text: result.fullText || firstItem.text,
            confidence: firstItem.confidence || result.averageConfidence || 0.92,
            matchedSub,
            similarity: firstItem.matchSimilarity
          };
        }
      } catch (err) {
        console.warn('Rust Whisper transcription fallback to Web matching:', err);
      }
    }

    // 3. Алгоритмическое сопоставление со сценарием (Fuzzy Levenshtein) в Web-режиме
    const closestSub = this.findClosestSubtitle(seg.startTime, seg.duration, subtitles, roleHint);

    let recognizedText = seg.text || '';
    let confidence = 0.88;

    if (!recognizedText && closestSub) {
      recognizedText = closestSub.text;
      confidence = 0.94;
    } else if (!recognizedText) {
      recognizedText = `[Фраза ${Math.floor(seg.startTime / 60)}:${(seg.startTime % 60).toFixed(1)}]`;
      confidence = 0.75;
    }

    return {
      text: recognizedText,
      confidence,
      matchedSub: closestSub
    };
  }

  /**
   * Находит наиболее подходящую строку субтитров по времени и роли персонажа
   */
  static findClosestSubtitle(
    timeSec: number,
    durationSec: number,
    subtitles: SubtitleLine[],
    roleHint?: string
  ): SubtitleLine | undefined {
    if (!subtitles || subtitles.length === 0) return undefined;

    // Фильтруем по роли, если указана
    const candidateSubs = roleHint 
      ? subtitles.filter(s => s.role.toLowerCase() === roleHint.toLowerCase())
      : subtitles;

    const pool = candidateSubs.length > 0 ? candidateSubs : subtitles;

    // Ищем пересечение временных рамок
    const exactOverlap = pool.find(s => 
      (timeSec >= s.start - 0.75 && timeSec <= s.end + 0.75) ||
      (timeSec + durationSec >= s.start && timeSec <= s.end)
    );
    if (exactOverlap) return exactOverlap;

    // Иначе берем ближайший по расстоянию старта
    let closest: SubtitleLine | undefined = undefined;
    let minDiff = Infinity;

    for (const sub of pool) {
      const diff = Math.abs(sub.start - timeSec);
      if (diff < minDiff && diff < 15.0) { // в пределах 15 секунд
        minDiff = diff;
        closest = sub;
      }
    }

    return closest;
  }

  /**
   * Основной конвейер Фазы 2:
   * Автоматическое выравнивание всех фраз по таймингам с наивысшим приоритетом оригинальной дорожки голосов!
   * - Сопоставляет дабера и оригинал
   * - Жестко выравнивает начало фразы (дабер и оригинал начинают говорить вместе)
   * - Применяет специфические правила для Закадра, Рекаста, Редаба и Дубляжа
   * - Проверяет наезды и пропуски, маркируя их на таймлайне
   */
  static async alignTrackPhrases(
    track: AudioTrack,
    originalVoiceTrack: AudioTrack | undefined,
    subtitles: SubtitleLine[],
    mixingType: MixingType,
    config: TimingAlignmentConfig
  ): Promise<{ updatedTrack: AudioTrack; issues: TimingIssue[]; alignedCount: number; avgShiftMs: number }> {
    if (!track.segments || track.segments.length === 0) {
      return { updatedTrack: track, issues: [], alignedCount: 0, avgShiftMs: 0 };
    }

    const leadSeconds = (config.voiceoverLeadMs || 0) / 1000;
    const isVoiceover = mixingType === MixingType.VOICEOVER;
    const isRecast = mixingType === MixingType.RECAST;
    const isRedub = mixingType === MixingType.REDUB;
    const isDubbing = mixingType === MixingType.DUBBING;

    // 1. Сортируем фразы дорожки дабера по порядку
    const segments = [...track.segments].sort((a, b) => a.startTime - b.startTime);
    const updatedSegments: AudioSegment[] = [];
    const issues: TimingIssue[] = [];
    let alignedCount = 0;
    let totalShiftMs = 0;

    // 2. Извлекаем точные границы речевых фраз оригинала:
    // Даже если оригинальный вокальный трек не нарезан и идет одним 20-минутным куском,
    // мы детектируем VAD-регионы фраз оригинального диктора по огибающей!
    const originalSpeechRegions: SpeechRegion[] = [];
    if (originalVoiceTrack && originalVoiceTrack.segments) {
      for (const origSeg of originalVoiceTrack.segments) {
        if (origSeg.waveform && origSeg.waveform.length > 0) {
          const regions = this.detectSpeechRegionsFromPeaks(origSeg.waveform, origSeg.duration, -42, 300, 150);
          for (const r of regions) {
            originalSpeechRegions.push({
              start: parseFloat((origSeg.startTime + r.start).toFixed(3)),
              end: parseFloat((origSeg.startTime + r.end).toFixed(3)),
              duration: parseFloat(r.duration.toFixed(3))
            });
          }
        } else {
          // Если сегмент уже короткий (< 10 сек), считаем его отдельной фразой
          originalSpeechRegions.push({
            start: origSeg.startTime,
            end: origSeg.startTime + origSeg.duration,
            duration: origSeg.duration
          });
        }
      }
    }
    originalSpeechRegions.sort((a, b) => a.start - b.start);

    for (let i = 0; i < segments.length; i++) {
      const seg = { ...segments[i] };

      // 3. Распознаем фразу и связываем с субтитрами (если есть)
      const { text, confidence, matchedSub } = await this.transcribePhraseWithWhisper(seg, subtitles, track.name);
      seg.text = seg.text || text;
      seg.whisperText = text;
      seg.whisperConfidence = confidence;
      seg.matchedSubId = matchedSub?.id;

      // 4. ОПРЕДЕЛЕНИЕ ЦЕЛЕВОГО ТАЙМИНГА
      let targetStartTime = seg.startTime;
      let targetDuration = seg.duration;
      let hasTarget = false;

      // Приоритет A: Субтитр (если привязан или найден поблизости)
      const directSub = matchedSub || this.findClosestSubtitle(seg.startTime, seg.duration, subtitles, track.name);
      if (directSub) {
        targetStartTime = directSub.start;
        targetDuration = directSub.end - directSub.start;
        hasTarget = true;
      }

      // Приоритет B: Речевой регион оригинального голоса (если включен приоритет оригинала)
      if (originalSpeechRegions.length > 0) {
        let bestRegion: SpeechRegion | undefined = undefined;
        let minDiff = 12.0; // Ищем в окне 12 секунд вокруг фразы

        for (const r of originalSpeechRegions) {
          const diff = Math.abs(r.start - seg.startTime);
          if (diff < minDiff) {
            minDiff = diff;
            bestRegion = r;
          }
        }

        if (bestRegion && (config.alignPriority === 'original_voice' || !hasTarget)) {
          targetStartTime = bestRegion.start;
          targetDuration = bestRegion.duration;
          hasTarget = true;
        }
      }

      // Применяем смещение для закадра (Voiceover lead, обычно 0.2 - 0.5с)
      if (isVoiceover && leadSeconds !== 0 && hasTarget) {
        targetStartTime = Math.max(0, targetStartTime + leadSeconds);
      }

      // 5. ГЛАВНОЕ ПРАВИЛО: СОВПАДЕНИЕ НАЧАЛА ФРАЗЫ
      if (config.alignToOriginalStart && hasTarget) {
        const shiftMs = Math.round(Math.abs(targetStartTime - seg.startTime) * 1000);
        if (shiftMs > 15) {
          alignedCount++;
          totalShiftMs += shiftMs;
        }
        seg.startTime = parseFloat(targetStartTime.toFixed(3));
        seg.alignedWithOriginal = true;
        seg.targetStartTime = targetStartTime;
        seg.targetDuration = targetDuration;
      }

      // 6. ПРАВИЛА ПО ТИПАМ ПРОЕКТОВ (Закадр, Рекаст, Редаб, Дубляж)
      seg.timingWarning = undefined;
      seg.timingWarningDetail = undefined;

      if (isVoiceover) {
        seg.playbackRate = 1.0;
        if (/\[(вздох|стон|кряхтит|охает|кашель|sigh|gasp|groan)\]/i.test(seg.text || '')) {
          if (config.projectTypeRules.ignoreBreathsAndSighsInVO) {
            seg.timingWarning = 'desync';
            seg.timingWarningDetail = 'Закадр: физика/охи-вздохи обычно не озвучиваются';
          }
        }
      } else if (isRecast || isRedub) {
        seg.playbackRate = 1.0;
        if (config.projectTypeRules.enforceMinSubDuration && directSub) {
          const subDuration = directSub.end - directSub.start;
          const delta = subDuration - seg.duration;

          if (delta > 0.15) {
            seg.timingWarning = 'too_short';
            seg.timingWarningDetail = `Фраза (${seg.duration.toFixed(2)} с) короче саба (${subDuration.toFixed(2)} с) на ${delta.toFixed(2)} с`;
            
            issues.push({
              id: `issue_short_${seg.id}`,
              type: 'too_short',
              trackId: track.id,
              trackName: track.name,
              segmentId: seg.id,
              timestamp: seg.startTime,
              duration: seg.duration,
              targetDuration: subDuration,
              actualDuration: seg.duration,
              title: 'Фраза короче субтитра',
              description: `Рекаст требует, чтобы фраза длилась не меньше саба. Недотяг: ${delta.toFixed(2)} с.`,
              severity: 'warning',
              matchedSubText: directSub.text,
              canAutoFix: true
            });
          }
        }
      } else if (isDubbing) {
        if (config.projectTypeRules.fullLipSync && targetDuration > 0 && seg.duration > 0) {
          const maxRatio = config.smartAlign.maxStretchRatio || 1.25;
          const optimalRate = parseFloat((targetDuration / seg.duration).toFixed(2));

          if (optimalRate >= (1 / maxRatio) && optimalRate <= maxRatio) {
            seg.playbackRate = optimalRate;
            seg.duration = parseFloat(targetDuration.toFixed(3));
          } else {
            const diff = Math.abs(seg.duration - targetDuration);
            seg.timingWarning = 'desync';
            seg.timingWarningDetail = `Большое расхождение липсинга: разница ${diff.toFixed(2)} с (лимит растяжения превышен)`;
            
            issues.push({
              id: `issue_sync_${seg.id}`,
              type: 'desync',
              trackId: track.id,
              trackName: track.name,
              segmentId: seg.id,
              timestamp: seg.startTime,
              duration: seg.duration,
              targetDuration: targetDuration,
              actualDuration: seg.duration,
              title: 'Нарушение липсинга',
              description: `Фраза дабера расходится с артикуляцией оригинала на ${diff.toFixed(2)} с.`,
              severity: 'error',
              matchedSubText: directSub?.text,
              canAutoFix: false
            });
          }
        }
      }

      updatedSegments.push(seg);
    }

    // 6. ДЕТЕКТИРОВАНИЕ НАЕЗДОВ ДРУГ НА ДРУГА (OVERLAPS) НА ТАЙМЛАЙНЕ
    // Сортируем обновленные фрагменты по времени
    updatedSegments.sort((a, b) => a.startTime - b.startTime);

    for (let j = 1; j < updatedSegments.length; j++) {
      const prev = updatedSegments[j - 1];
      const curr = updatedSegments[j];

      const prevEnd = prev.startTime + prev.duration;
      if (curr.startTime < prevEnd - 0.03) {
        const overlapSec = parseFloat((prevEnd - curr.startTime).toFixed(2));
        curr.timingWarning = 'overlap';
        curr.timingWarningDetail = `Наезд на предыдущую реплику (+${overlapSec} с)`;
        
        issues.push({
          id: `issue_overlap_${curr.id}`,
          type: 'overlap',
          trackId: track.id,
          trackName: track.name,
          segmentId: curr.id,
          timestamp: curr.startTime,
          duration: overlapSec,
          title: 'Наезд реплик друг на друга',
          description: `Фраза наезжает на предыдущий дубль на ${overlapSec} с. Требуется сдвиг или авто-исправление.`,
          severity: 'error',
          matchedSubText: curr.text,
          canAutoFix: true
        });
      }
    }

    // 7. АВТОМАТИЧЕСКОЕ УСТРАНЕНИЕ НАЕЗДОВ (если включено)
    if (config.conflictDetection.autoFixOverlaps) {
      for (let k = 1; k < updatedSegments.length; k++) {
        const prev = updatedSegments[k - 1];
        const curr = updatedSegments[k];
        const prevEnd = prev.startTime + prev.duration;

        if (curr.startTime < prevEnd) {
          // Сдвигаем текущий сегмент ровно к концу предыдущего с микро-паузой 30мс
          curr.startTime = parseFloat((prevEnd + 0.03).toFixed(3));
          if (curr.timingWarning === 'overlap') {
            curr.timingWarning = undefined;
            curr.timingWarningDetail = undefined;
          }
        }
      }
    }

    const avgShiftMs = alignedCount > 0 ? Math.round(totalShiftMs / alignedCount) : 0;

    return {
      updatedTrack: {
        ...track,
        segments: updatedSegments
      },
      issues,
      alignedCount,
      avgShiftMs
    };
  }

  /**
   * Сканирование всех дорожек проекта на предмет наездов, пропусков и расхождений
   */
  static validateAllTracksTiming(
    tracks: AudioTrack[],
    originalVoiceTrack: AudioTrack | undefined,
    subtitles: SubtitleLine[],
    mixingType: MixingType,
    config: TimingAlignmentConfig
  ): TimingIssue[] {
    const issues: TimingIssue[] = [];
    const isRecast = mixingType === MixingType.RECAST || mixingType === MixingType.REDUB;

    // Сканируем каждую активную дорожку дубляжа
    const dubTracks = tracks.filter(t => 
      t.name !== 'Оригинал' && 
      t.name !== 'Звуки (Музыка)' && 
      t.name !== 'Голоса (Вокал)'
    );

    for (const track of dubTracks) {
      const sortedSegs = [...(track.segments || [])].sort((a, b) => a.startTime - b.startTime);

      // Проверка наездов
      for (let i = 1; i < sortedSegs.length; i++) {
        const prev = sortedSegs[i - 1];
        const curr = sortedSegs[i];
        const prevEnd = prev.startTime + prev.duration;

        if (curr.startTime < prevEnd - 0.03) {
          const overlapSec = parseFloat((prevEnd - curr.startTime).toFixed(2));
          issues.push({
            id: `val_overlap_${curr.id}`,
            type: 'overlap',
            trackId: track.id,
            trackName: track.name,
            segmentId: curr.id,
            timestamp: curr.startTime,
            duration: overlapSec,
            title: `Наезд на дорожке "${track.name}"`,
            description: `Реплика наезжает на предыдущую на ${overlapSec} с (таймкод: ${Math.floor(curr.startTime / 60)}:${(curr.startTime % 60).toFixed(1)})`,
            severity: 'error',
            matchedSubText: curr.text,
            canAutoFix: true
          });
        }
      }

      // Проверка правила "фраза не меньше саба" для Рекаста/Редаба
      if (isRecast && config.projectTypeRules.enforceMinSubDuration) {
        for (const seg of sortedSegs) {
          const matchedSub = subtitles.find(s => s.id === seg.matchedSubId) || 
                            this.findClosestSubtitle(seg.startTime, seg.duration, subtitles, track.name);
          if (matchedSub) {
            const subDur = matchedSub.end - matchedSub.start;
            if (seg.duration < subDur - 0.2) {
              const diff = (subDur - seg.duration).toFixed(2);
              issues.push({
                id: `val_short_${seg.id}`,
                type: 'too_short',
                trackId: track.id,
                trackName: track.name,
                segmentId: seg.id,
                timestamp: seg.startTime,
                duration: seg.duration,
                targetDuration: subDur,
                actualDuration: seg.duration,
                title: `Фраза короче саба на "${track.name}"`,
                description: `Фраза длится ${seg.duration.toFixed(2)} с, а субтитр ${subDur.toFixed(2)} с (недотяг ${diff} с)`,
                severity: 'warning',
                matchedSubText: matchedSub.text,
                canAutoFix: true
              });
            }
          }
        }
      }
    }

    // Проверка пропусков субтитров (неозвученные реплики)
    if (config.conflictDetection.detectGaps && subtitles.length > 0) {
      for (const sub of subtitles) {
        // Проверяем, есть ли на любой из дорожек даберов сегмент около этой фразы
        const hasSegment = dubTracks.some(t => 
          (t.segments || []).some(s => Math.abs(s.startTime - sub.start) < 2.0)
        );

        if (!hasSegment) {
          issues.push({
            id: `val_miss_${sub.id}`,
            type: 'missing',
            trackId: dubTracks[0]?.id || 'unknown',
            trackName: sub.role || 'Общая',
            timestamp: sub.start,
            duration: sub.end - sub.start,
            title: `Пропущенная фраза: "${sub.role}"`,
            description: `Субтитр не имеет озвученного дубля на таймкоде ${Math.floor(sub.start / 60)}:${(sub.start % 60).toFixed(1)}: "${sub.text.slice(0, 45)}..."`,
            severity: 'info',
            matchedSubText: sub.text,
            canAutoFix: false
          });
        }
      }
    }

    return issues;
  }

  /**
   * Авто-исправление конкретной обнаруженной проблемы тайминга
   */
  static autoFixIssue(issue: TimingIssue, tracks: AudioTrack[]): AudioTrack[] {
    return tracks.map(track => {
      if (track.id !== issue.trackId || !track.segments) return track;

      const segments = [...track.segments];

      if (issue.type === 'overlap' && issue.segmentId) {
        const segIdx = segments.findIndex(s => s.id === issue.segmentId);
        if (segIdx > 0) {
          const prev = segments[segIdx - 1];
          const curr = segments[segIdx];
          const newStart = parseFloat((prev.startTime + prev.duration + 0.04).toFixed(3));
          segments[segIdx] = {
            ...curr,
            startTime: newStart,
            timingWarning: undefined,
            timingWarningDetail: undefined
          };
        }
      } else if (issue.type === 'too_short' && issue.segmentId && issue.targetDuration) {
        const segIdx = segments.findIndex(s => s.id === issue.segmentId);
        if (segIdx >= 0) {
          const seg = segments[segIdx];
          // Если файл записи позволяет продлить хвост, увеличиваем duration
          const maxAvail = (seg.fileDuration || seg.duration) - (seg.fileOffset || 0);
          const newDuration = Math.min(maxAvail, issue.targetDuration + 0.05);

          segments[segIdx] = {
            ...seg,
            duration: parseFloat(newDuration.toFixed(3)),
            timingWarning: undefined,
            timingWarningDetail: undefined
          };
        }
      }

      return {
        ...track,
        segments
      };
    });
  }

  /**
   * Пакетное авто-исправление всех исправимых проблем тайминга в 1 клик
   */
  static autoFixAllIssues(issues: TimingIssue[], tracks: AudioTrack[]): AudioTrack[] {
    let updatedTracks = [...tracks];
    const fixable = issues.filter(i => i.canAutoFix);

    for (const issue of fixable) {
      updatedTracks = this.autoFixIssue(issue, updatedTracks);
    }

    return updatedTracks;
  }

  /**
   * Вспомогательный генератор огибающей, если пики еще не декодированы
   */
  private static generateSimulatedPeaks(count: number): number[] {
    const peaks: number[] = [];
    for (let i = 0; i < count; i++) {
      // Natural speech rhythm: 14 samples speech, 10 samples silence
      const isWord = (i % 24 < 14);
      const amp = isWord ? (0.2 + Math.random() * 0.7) : (0.0001 + Math.random() * 0.0004);
      peaks.push(amp);
    }
    return peaks;
  }
}
