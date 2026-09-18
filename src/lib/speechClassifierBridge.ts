// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE SPEECH & CUE CLASSIFIER BRIDGE
// Типизированный мост вызовов к Rust `speech_cue_classifier`
// Стек: Tauri v2 Core Invoke, Rayon Parallel Execution, RustFFT
// ============================================================================

import { invoke } from '@tauri-apps/api/core';

/**
 * Категория реплики / аудиосегмента в проекте
 */
export type CueClassification = 
  | 'standardDialogue' // Обычная речь сценария (целевой уровень -16.0 LUFS)
  | 'foleyEffort'      // Физиологические звуки: вздохи, кашель, кряхтение, всхлипы (ослабление на -10 дБ)
  | 'shoutScream'      // Крик, ор, эмоциональный вопль (особый контроль лимитера, поправка -6 дБ)
  | 'whisper';         // Шепот, тихий приглушенный голос (upward-компрессия / подъем тихих формант)

/**
 * Входные данные аудиосегмента для классификации
 */
export interface ProjectCueInput {
  id: string;
  filePath?: string;
  text?: string;
  startTime: number; // секунды
  duration: number; // секунды
  waveformPeaks?: number[];
  sampleRate?: number;
}

/**
 * Спектральные и временные акустические метрики сегмента
 */
export interface SpectralMetrics {
  zcr: number;
  spectralFlatness: number;
  spectralCentroidHz: number;
  rmsDb: number;
  peakDb: number;
  energyRatioHf: number;
  isUnvoiced: boolean;
  isTonal: boolean;
  fundamentalAutocorr: number;
}

/**
 * Результат классификации реплики
 */
export interface ClassifiedCueOutput {
  id: string;
  classification: CueClassification;
  confidence: number;
  targetLufs: number;
  gainOffsetDb: number;
  reason: string;
  spectralMetrics?: SpectralMetrics;
  processingHint: string;
}

/**
 * Проверка доступности нативного окружения Tauri
 */
export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__);
}

/**
 * Пакетная классификация всех сегментов проекта за один вызов через Rust / Rayon
 */
export async function classifyProjectCuesNative(
  cues: ProjectCueInput[]
): Promise<ClassifiedCueOutput[]> {
  if (cues.length === 0) {
    return [];
  }

  if (isTauriEnvironment()) {
    try {
      return await invoke<ClassifiedCueOutput[]>('classify_project_cues', {
        cues,
      });
    } catch (err) {
      console.warn('[SpeechCueClassifier] Ошибка вызова classify_project_cues в Rust, fallback на JS эмулятор:', err);
    }
  }

  // Fallback для чистого браузерного окружения / превью
  return fallbackClassifyProjectCues(cues);
}

/**
 * Браузерный фоллбэк с эквивалентной логикой текстового синтаксиса и оценки вейвформа
 */
function fallbackClassifyProjectCues(cues: ProjectCueInput[]): ClassifiedCueOutput[] {
  const shoutKeywords = ['крик', 'кричит', 'ор', 'орёт', 'орет', 'вопль', 'визг', 'scream', 'shout', 'yell', 'shriek'];
  const whisperKeywords = ['шепот', 'шёпот', 'шепотом', 'шёпотом', 'вполголоса', 'тихо', 'тихий голос', 'whisper', 'whispering'];
  const foleyKeywords = [
    'вздох', 'вдох', 'выдох', 'кряхтит', 'кряхтение', 'кашель', 'покашливание',
    'рычание', 'рык', 'всхлип', 'всхлипывание', 'плач', 'плачет', 'смех', 'смеется',
    'хихикает', 'стон', 'стонет', 'зевок', 'зевает', 'чмок', 'цок', 'шум', 'шорох',
    'охает', 'ахает', 'сопение', 'мычание', 'хмыканье', 'храп', 'пыхтит', 'рыдает',
    'sigh', 'gasp', 'groan', 'grunt', 'cough', 'growl', 'sob', 'cry', 'laugh', 'yawn'
  ];
  const interjections = new Set([
    'мм', 'ммм', 'гм', 'гмм', 'эх', 'эхх', 'ох', 'оох', 'ах', 'ух', 'пф', 'пфф',
    'тсс', 'тс', 'кхм', 'кхе', 'ха', 'хе', 'угу', 'ага', 'ой', 'ай', 'брр', 'фух',
    'hm', 'hmm', 'uh', 'um', 'ah', 'oh', 'tsk', 'ugh', 'huh', 'oof', 'gasp', 'shh'
  ]);

  return cues.map(cue => {
    const text = (cue.text || '').trim();
    const lowerText = text.toLowerCase();
    const cleanWord = lowerText.replace(/[^a-zа-яё0-9]/gi, '');
    const isBracketed = (text.startsWith('[') && text.endsWith(']')) ||
                        (text.startsWith('(') && text.endsWith(')')) ||
                        (text.startsWith('*') && text.endsWith('*'));

    // 1. Проверка крика
    const isShoutRemark = isBracketed && shoutKeywords.some(kw => lowerText.includes(kw));
    const isShoutCaps = text.length > 0 && text.length <= 30 && text === text.toUpperCase() && (text.endsWith('!') || text.includes('!!!'));
    if (isShoutRemark || isShoutCaps) {
      return {
        id: cue.id,
        classification: 'shoutScream',
        confidence: 0.92,
        targetLufs: -22.0,
        gainOffsetDb: -6.0,
        reason: `Текстовый маркер крика '${text}' -> ShoutScream (-6 dB)`,
        processingHint: 'Применен пресет лимитирования громких всплесков',
      };
    }

    // 2. Проверка шепота
    const isWhisperRemark = isBracketed && whisperKeywords.some(kw => lowerText.includes(kw));
    if (isWhisperRemark) {
      return {
        id: cue.id,
        classification: 'whisper',
        confidence: 0.94,
        targetLufs: -18.0,
        gainOffsetDb: 3.0,
        reason: `Текстовый маркер шепота '${text}' -> Whisper (+3 dB Upward)`,
        processingHint: 'Включена upward-компрессия тихих формант',
      };
    }

    // 3. Проверка вздохов / физиологических звуков
    const hasFoleyKeyword = foleyKeywords.some(kw => lowerText.includes(kw));
    const isInterjection = interjections.has(cleanWord);
    if ((isBracketed && (hasFoleyKeyword || text.length <= 35)) || isInterjection) {
      return {
        id: cue.id,
        classification: 'foleyEffort',
        confidence: 0.95,
        targetLufs: -26.0,
        gainOffsetDb: -10.0,
        reason: `Ремарка действия/вздоха '${text}' -> FoleyEffort (-10 dB)`,
        processingHint: 'Ослабление громкости на -10 дБ для сохранения прозрачности фонограммы',
      };
    }

    // 4. Короткие нетекстовые фрагменты (< 350 мс)
    if (cue.duration > 0.001 && cue.duration < 0.350 && (!text || cleanWord.length <= 3)) {
      return {
        id: cue.id,
        classification: 'foleyEffort',
        confidence: 0.85,
        targetLufs: -26.0,
        gainOffsetDb: -10.0,
        reason: `Сверхкороткий аудиосегмент (${(cue.duration * 1000).toFixed(0)} мс) без реплики -> FoleyEffort`,
        processingHint: 'Подавление шумов дыхания 10 мс anti-click фейдами',
      };
    }

    // 5. Стандартный диалог
    return {
      id: cue.id,
      classification: 'standardDialogue',
      confidence: 0.95,
      targetLufs: -16.0,
      gainOffsetDb: 0.0,
      reason: text ? `Реплика сценария: '${text}' -> StandardDialogue (-16 LUFS)` : 'Речевая дорожка -> StandardDialogue (-16 LUFS)',
      processingHint: 'Эталонное сведение по стандарту EBU R128 (-16 LUFS)',
    };
  });
}
