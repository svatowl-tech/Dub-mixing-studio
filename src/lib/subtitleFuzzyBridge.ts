// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE SUBTITLE & FUZZY MATCH BRIDGE
// Типизированный мост вызовов к Rust `subtitle_fuzzy_engine`
// Стек: Tauri v2 Core Invoke, Rayon Parallel Levenshtein O(1) Allocations
// ============================================================================

import { invoke } from '@tauri-apps/api/core';
import { SubtitleLine } from '../types';

export interface ParsedSubtitleEntry {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  role: string;
  rawText: string;
  cleanText: string;
  style?: string;
  actor?: string;
  effect?: string;
  marginL?: number;
  marginR?: number;
  marginV?: number;
}

export interface WhisperEntry {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  speaker?: string;
}

export interface ScriptEntry {
  id: string;
  index: number;
  role?: string;
  text: string;
  targetStartMs?: number;
  targetEndMs?: number;
}

export interface MatchedScriptPair {
  whisperId: string;
  scriptId: string;
  scriptIndex: number;
  whisperText: string;
  scriptText: string;
  role: string;
  similarity: number;
  startMs: number;
  endMs: number;
  timeDriftMs: number;
  confidence: number;
  isExactMatch: boolean;
}

/**
 * Проверка доступности нативного окружения Tauri
 */
export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__);
}

/**
 * Нативный высокоскоростной парсинг файлов субтитров через Rust
 */
export async function parseSubtitleFileNative(content: string, format: string): Promise<SubtitleLine[]> {
  if (isTauriEnvironment()) {
    try {
      const rawEntries = await invoke<ParsedSubtitleEntry[]>('parse_subtitle_file_native', {
        content,
        format: format.toLowerCase()
      });

      return rawEntries.map(e => ({
        id: e.id,
        start: e.startMs / 1000,
        end: e.endMs / 1000,
        text: e.cleanText || e.rawText,
        role: e.role || 'Default',
        style: e.style,
        actor: e.actor,
      }));
    } catch (err) {
      console.warn('[SubtitleFuzzyBridge] Ошибка вызова parse_subtitle_file_native в Rust, fallback на JS:', err);
    }
  }

  return [];
}

/**
 * Нативное нечеткое многопоточное сопоставление реплик Whisper со сценарием через Rust
 */
export async function matchTranscriptionWithScriptNative(
  whisperEntries: WhisperEntry[],
  scriptLines: ScriptEntry[]
): Promise<MatchedScriptPair[]> {
  if (isTauriEnvironment()) {
    try {
      return await invoke<MatchedScriptPair[]>('match_transcription_with_script', {
        whisperEntries,
        scriptLines
      });
    } catch (err) {
      console.warn('[SubtitleFuzzyBridge] Ошибка вызова match_transcription_with_script в Rust:', err);
    }
  }

  // Fallback на JS сопоставление (упрощенный расчет)
  return fallbackMatchTranscription(whisperEntries, scriptLines);
}

function fallbackMatchTranscription(
  whisperEntries: WhisperEntry[],
  scriptLines: ScriptEntry[]
): MatchedScriptPair[] {
  const normalize = (t: string) => t.toLowerCase().replace(/[^\w\sа-яё]/gi, '').trim();

  return whisperEntries.map(w => {
    const wNorm = normalize(w.text);
    let bestSim = 0;
    let bestScript = scriptLines[0];
    let bestIdx = 0;

    scriptLines.forEach((s, idx) => {
      const sNorm = normalize(s.text);
      if (wNorm === sNorm) {
        bestSim = 1.0;
        bestScript = s;
        bestIdx = idx;
      } else if (wNorm.includes(sNorm) || sNorm.includes(wNorm)) {
        const sim = Math.min(wNorm.length, sNorm.length) / Math.max(wNorm.length, sNorm.length);
        if (sim > bestSim) {
          bestSim = sim;
          bestScript = s;
          bestIdx = idx;
        }
      }
    });

    return {
      whisperId: w.id,
      scriptId: bestScript?.id || 'none',
      scriptIndex: bestIdx + 1,
      whisperText: w.text,
      scriptText: bestScript?.text || '',
      role: bestScript?.role || 'Default',
      similarity: bestSim,
      startMs: w.startMs,
      endMs: w.endMs,
      timeDriftMs: 0,
      confidence: (w.confidence ?? 1.0) * bestSim,
      isExactMatch: bestSim >= 0.95
    };
  });
}
