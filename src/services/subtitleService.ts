import { invoke, isTauri } from '@tauri-apps/api/core';
import { SubtitleLine } from '../types';
import { IOLogger } from '../lib/ioLogger';

export type SubtitleFormat = 'ass' | 'srt' | 'vtt';

export type IssueSeverity = 'warning' | 'error';

export type LinterIssueType =
  | 'highCps'
  | 'tooShort'
  | 'tooLong'
  | 'invalidDuration'
  | 'timeOverlap'
  | 'emptyText'
  | 'unclosedTag';

export interface SubtitleLinterIssue {
  lineId: string;
  lineIndex: usizeOrNumber;
  issueType: LinterIssueType;
  severity: IssueSeverity;
  message: string;
  start: number;
  end: number;
  measuredValue?: number;
  threshold?: number;
}

type usizeOrNumber = number;

export interface SubtitleReportStats {
  totalLines: number;
  totalDuration: number;
  averageCps: number;
  maxCps: number;
  overlapCount: number;
  warningCount: number;
  errorCount: number;
}

export interface CompiledSubtitleReport {
  projectId: string;
  format: SubtitleFormat;
  compiledContent: string;
  totalLines: number;
  isValid: boolean;
  warnings: SubtitleLinterIssue[];
  errors: SubtitleLinterIssue[];
  stats: SubtitleReportStats;
}

export interface ParsedSubtitles {
  roles: string[];
  subtitles: SubtitleLine[];
}

export class SubtitleService {
  /**
   * Invokes native Rust ASS/SRT/VTT compiler and strict broadcast compliance linter.
   */
  static async compileAndValidate(
    projectId: string,
    format: SubtitleFormat = 'ass',
    customSubtitles?: SubtitleLine[]
  ): Promise<CompiledSubtitleReport> {
    IOLogger.log('SUBTITLES', 'SubtitleService:compileAndValidate', 'START', { projectId, format });
    try {
      if (isTauri()) {
        const report = await invoke<CompiledSubtitleReport>('compile_and_validate_subtitles', {
          projectId,
          format,
          customSubtitles: customSubtitles && customSubtitles.length > 0 ? customSubtitles : null,
        });
        IOLogger.log('SUBTITLES', 'SubtitleService:compileAndValidate', 'SUCCESS', {
          totalLines: report.totalLines,
          warnings: report.warnings.length,
          errors: report.errors.length,
          isValid: report.isValid,
        });
        return report;
      }

      // Browser fallback when running outside Tauri container
      const subs = customSubtitles || [];
      const report = this.fallbackCompileAndValidate(projectId, subs, format);
      IOLogger.log('SUBTITLES', 'SubtitleService:compileAndValidate', 'SUCCESS', {
        totalLines: report.totalLines,
        fallback: true,
      });
      return report;
    } catch (err) {
      IOLogger.log('SUBTITLES', 'SubtitleService:compileAndValidate', 'ERROR', { projectId }, String(err));
      throw err;
    }
  }

  /**
   * Universal parser for .ass, .srt and .vtt content.
   * Leverages ultra-fast native Rust parser when running in Tauri.
   */
  static parse(content: string): ParsedSubtitles {
    IOLogger.log('SUBTITLES', 'SubtitleService:parse', 'START', { length: content.length });
    try {
      let result: ParsedSubtitles;
      if (content.includes('[Script Info]') || content.includes('[Events]')) {
        result = this.parseASS(content);
      } else if (content.includes('-->')) {
        result = this.parseSRT(content);
      } else {
        throw new Error('Unsupported subtitle format. Expected ASS or SRT/VTT.');
      }
      IOLogger.log('SUBTITLES', 'SubtitleService:parse', 'SUCCESS', {
        count: result.subtitles.length,
        roles: result.roles,
      });
      return result;
    } catch (err) {
      IOLogger.log('SUBTITLES', 'SubtitleService:parse', 'ERROR', null, String(err));
      throw err;
    }
  }

  /**
   * Asynchronous native parsing via Tauri IPC
   */
  static async parseNative(content: string): Promise<ParsedSubtitles> {
    if (isTauri()) {
      try {
        return await invoke<ParsedSubtitles>('parse_subtitles_native', { content });
      } catch (err) {
        console.warn('[SubtitleService] Native parser failed, falling back to local JS parser:', err);
      }
    }
    return this.parse(content);
  }

  /**
   * Fast zero-dependency parser for ASS v4.00+
   */
  static parseASS(content: string): ParsedSubtitles {
    const lines: SubtitleLine[] = [];
    const rolesSet = new Set<string>();

    const rawLines = content.split(/\r?\n/);
    let inEvents = false;
    let formatCols: string[] = [];

    const tagRegex = /\{[^}]*\}/g;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (line.startsWith('[') && line.endsWith(']')) {
        inEvents = line.toLowerCase() === '[events]';
        continue;
      }

      if (!inEvents || !line) continue;

      if (line.toLowerCase().startsWith('format:')) {
        formatCols = line.substring(7).split(',').map(c => c.trim().toLowerCase());
        continue;
      }

      if (line.toLowerCase().startsWith('dialogue:')) {
        const dataStr = line.substring(9).trim();
        const maxSplits = formatCols.length > 0 ? formatCols.length : 10;
        
        // Split by commas, but preserve commas in final Text column
        const parts: string[] = [];
        let cur = '';
        let count = 0;
        for (let cIdx = 0; cIdx < dataStr.length; cIdx++) {
          const char = dataStr[cIdx];
          if (char === ',' && count < maxSplits - 1) {
            parts.push(cur.trim());
            cur = '';
            count++;
          } else {
            cur += char;
          }
        }
        parts.push(cur.trim());

        let startSec = 0;
        let endSec = 0;
        let role = 'Default';
        let rawText = '';

        if (formatCols.length === 0 && parts.length >= 10) {
          // Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
          startSec = this.assTimeToSeconds(parts[1]);
          endSec = this.assTimeToSeconds(parts[2]);
          const name = parts[4].trim();
          const style = parts[3].trim();
          role = name || style || 'Default';
          rawText = parts[9];
        } else {
          for (let col = 0; col < formatCols.length && col < parts.length; col++) {
            const colName = formatCols[col];
            const val = parts[col];
            if (colName === 'start') startSec = this.assTimeToSeconds(val);
            else if (colName === 'end') endSec = this.assTimeToSeconds(val);
            else if (colName === 'name' && val) role = val;
            else if (colName === 'style' && role === 'Default' && val) role = val;
            else if (colName === 'text') rawText = val;
          }
        }

        const cleanText = rawText
          .replace(tagRegex, '')
          .replace(/\\N/g, '\n')
          .replace(/\\n/g, '\n')
          .replace(/\\h/g, ' ')
          .trim();

        rolesSet.add(role);
        lines.push({
          id: `ass-${lines.length}`,
          start: startSec,
          end: endSec,
          text: cleanText,
          role,
        });
      }
    }

    const roles = Array.from(rolesSet);
    return {
      roles: roles.length > 0 ? roles : ['Default'],
      subtitles: lines,
    };
  }

  /**
   * Fast zero-dependency parser for SRT / VTT
   */
  static parseSRT(content: string): ParsedSubtitles {
    const lines: SubtitleLine[] = [];
    const blocks = content.trim().split(/\r?\n\s*\r?\n/);
    const timeRe = /(\d{1,2}:\d{2}:\d{2}[,\.]\d{2,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{2,3})/;

    blocks.forEach((block, index) => {
      const parts = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      let timeIdx = -1;
      let start = 0;
      let end = 0;

      for (let i = 0; i < parts.length; i++) {
        const match = parts[i].match(timeRe);
        if (match) {
          timeIdx = i;
          start = this.timecodeToSeconds(match[1]);
          end = this.timecodeToSeconds(match[2]);
          break;
        }
      }

      if (timeIdx !== -1) {
        const textParts = parts.slice(timeIdx + 1);
        const text = textParts
          .join('\n')
          .replace(/<[^>]+>/g, '')
          .replace(/\{[^}]+\}/g, '')
          .trim();

        lines.push({
          id: `srt-${index}`,
          start,
          end,
          text,
          role: 'Default',
        });
      }
    });

    return {
      roles: ['Default'],
      subtitles: lines,
    };
  }

  private static assTimeToSeconds(tc: string): number {
    return this.timecodeToSeconds(tc);
  }

  private static timecodeToSeconds(tc: string): number {
    const clean = tc.trim().replace(',', '.');
    const parts = clean.split(':');
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(clean) || 0;
  }

  /**
   * In-browser compilation fallback matching Rust engine behavior
   */
  private static fallbackCompileAndValidate(
    projectId: string,
    subtitles: SubtitleLine[],
    format: SubtitleFormat
  ): CompiledSubtitleReport {
    const warnings: SubtitleLinterIssue[] = [];
    const errors: SubtitleLinterIssue[] = [];

    let totalDuration = 0;
    let totalChars = 0;
    let maxCps = 0;
    let overlapCount = 0;

    const sorted = [...subtitles].sort((a, b) => a.start - b.start);

    for (let i = 0; i < sorted.length; i++) {
      const sub = sorted[i];
      const duration = sub.end - sub.start;
      const cleanText = sub.text.replace(/\{[^}]*\}|<[^>]*>/g, '').trim();
      const charCount = cleanText.length;

      if (duration <= 0) {
        errors.push({
          lineId: sub.id,
          lineIndex: i + 1,
          issueType: 'invalidDuration',
          severity: 'error',
          message: `Недопустимая длительность: ${duration.toFixed(2)}s (конец <= начало).`,
          start: sub.start,
          end: sub.end,
          measuredValue: duration,
          threshold: 0,
        });
        continue;
      }

      totalDuration += duration;
      totalChars += charCount;

      const cps = duration > 0 ? charCount / duration : 0;
      if (cps > maxCps) maxCps = cps;

      if (cps > 20.0) {
        warnings.push({
          lineId: sub.id,
          lineIndex: i + 1,
          issueType: 'highCps',
          severity: 'warning',
          message: `Высокая скорость чтения: ${cps.toFixed(1)} CPS (лимит: 20 CPS).`,
          start: sub.start,
          end: sub.end,
          measuredValue: cps,
          threshold: 20.0,
        });
      }

      if (duration < 0.8) {
        warnings.push({
          lineId: sub.id,
          lineIndex: i + 1,
          issueType: 'tooShort',
          severity: 'warning',
          message: `Длительность строки слишком мала: ${duration.toFixed(2)}s (минимум 0.8s).`,
          start: sub.start,
          end: sub.end,
          measuredValue: duration,
          threshold: 0.8,
        });
      }

      if (duration > 7.0) {
        warnings.push({
          lineId: sub.id,
          lineIndex: i + 1,
          issueType: 'tooLong',
          severity: 'warning',
          message: `Длительность строки слишком велика: ${duration.toFixed(2)}s (максимум 7.0s).`,
          start: sub.start,
          end: sub.end,
          measuredValue: duration,
          threshold: 7.0,
        });
      }

      if (i < sorted.length - 1) {
        const next = sorted[i + 1];
        if (sub.end > next.start + 0.002) {
          const overlap = sub.end - next.start;
          overlapCount++;
          warnings.push({
            lineId: sub.id,
            lineIndex: i + 1,
            issueType: 'timeOverlap',
            severity: 'warning',
            message: `Наезд таймкода на строку #${i + 2} на ${overlap.toFixed(3)}s.`,
            start: sub.start,
            end: sub.end,
            measuredValue: overlap,
            threshold: 0,
          });
        }
      }
    }

    let compiledContent = '';
    if (format === 'ass') {
      compiledContent = `[Script Info]\nTitle: Project ${projectId}\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48.0,&H00FFFFFF&,&H0000FFFF&,&H00000000&,&H80000000&,0,0,0,0,100,100,0,0,1,2.5,1.2,2,40,40,45,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
        sorted.map(s => `Dialogue: 0,${this.formatAssTime(s.start)},${this.formatAssTime(s.end)},Default,${s.role},0,0,0,,${s.text.replace(/\n/g, '\\N')}`).join('\n');
    } else if (format === 'srt') {
      compiledContent = sorted.map((s, idx) => `${idx + 1}\n${this.formatSrtTime(s.start)} --> ${this.formatSrtTime(s.end)}\n${s.text}\n`).join('\n');
    } else {
      compiledContent = 'WEBVTT\n\n' + sorted.map((s, idx) => `${idx + 1}\n${this.formatVttTime(s.start)} --> ${this.formatVttTime(s.end)}\n${s.text}\n`).join('\n');
    }

    return {
      projectId,
      format,
      compiledContent,
      totalLines: sorted.length,
      isValid: errors.length === 0,
      warnings,
      errors,
      stats: {
        totalLines: sorted.length,
        totalDuration,
        averageCps: totalDuration > 0 ? totalChars / totalDuration : 0,
        maxCps,
        overlapCount,
        warningCount: warnings.length,
        errorCount: errors.length,
      },
    };
  }

  private static formatAssTime(sec: number): string {
    const s = Math.max(0, sec);
    const totalCs = Math.round(s * 100);
    const cs = totalCs % 100;
    const totalS = Math.floor(totalCs / 100);
    const secVal = totalS % 60;
    const totalM = Math.floor(totalS / 60);
    const minVal = totalM % 60;
    const h = Math.floor(totalM / 60);
    return `${h}:${String(minVal).padStart(2, '0')}:${String(secVal).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  private static formatSrtTime(sec: number): string {
    const s = Math.max(0, sec);
    const totalMs = Math.round(s * 1000);
    const ms = totalMs % 1000;
    const totalS = Math.floor(totalMs / 1000);
    const secVal = totalS % 60;
    const totalM = Math.floor(totalS / 60);
    const minVal = totalM % 60;
    const h = Math.floor(totalM / 60);
    return `${String(h).padStart(2, '0')}:${String(minVal).padStart(2, '0')}:${String(secVal).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  private static formatVttTime(sec: number): string {
    const s = Math.max(0, sec);
    const totalMs = Math.round(s * 1000);
    const ms = totalMs % 1000;
    const totalS = Math.floor(totalMs / 1000);
    const secVal = totalS % 60;
    const totalM = Math.floor(totalS / 60);
    const minVal = totalM % 60;
    const h = Math.floor(totalM / 60);
    return `${String(h).padStart(2, '0')}:${String(minVal).padStart(2, '0')}:${String(secVal).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }
}
