import { SubtitleLine } from '../types';
import { IOLogger } from '../lib/ioLogger';

export class TextImportService {
  static parseRawText(text: string, defaultDurationMs: number = 5000): SubtitleLine[] {
    IOLogger.log('SUBTITLES', 'TextImport:parseRawText', 'START', { length: text.length });
    text = text.replace(/^\uFEFF/, ''); // Strip BOM
    
    let result: SubtitleLine[] = [];
    
    // 1. Try Parse as Distribution List (Timings)
    const isDistributionLine = (line: string) => line.includes('//') || /\(\d{1,2}:\d{2}/.test(line);
    const lines = text.split(/\r?\n/);
    
    if (lines.some(l => isDistributionLine(l))) {
      const segments: SubtitleLine[] = [];
      const timeToSeconds = (timeStr: string): number => {
        const parts = timeStr.trim().split(':').map(Number);
        if (parts.length === 2) return parts[0] * 60 + parts[1]; // MM:SS
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS
        return parts[0];
      };

      for (const line of lines) {
        if (!line.trim() || line.includes(':') && !line.includes('//') && /[А-ЯЁ]/.test(line)) continue;
        
        const regex = /(\/\/|[\(\[])\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-\s*(\d{1,2}:\d{2}(?::\d{2})?))?\s*(\/\/|[\)\]])/g;
        let match;
        let role = 'Unknown';
        const roleMatch = line.match(/^([^-\(\[]+)/);
        if (roleMatch) role = roleMatch[1].trim();

        while ((match = regex.exec(line)) !== null) {
          const start = timeToSeconds(match[2]);
          const end = match[3] ? timeToSeconds(match[3]) : start + 5;
          segments.push({
            id: Math.random().toString(36).substr(2, 9),
            start: start,
            end: end,
            text: `[${role}]`,
            role: role
          });
        }
      }
      result = segments;
    } else {
      // 2. Default: Parse as Standard Script
      const segments: SubtitleLine[] = [];
      let currentRole = 'Narrator';
      let currentText = '';
      let currentTime = 0;

      const flushSegment = (force: boolean = false) => {
        const trimmed = currentText.trim();
        if (trimmed) {
          if (trimmed.length > 600 && !force) {
            const sentences = trimmed.match(/[^.!?]+[.!?]+/g) || [trimmed];
            for (const sentence of sentences) {
               this.addSegment(segments, sentence, currentRole, currentTime, defaultDurationMs);
               currentTime += defaultDurationMs;
            }
          } else {
            this.addSegment(segments, trimmed, currentRole, currentTime, defaultDurationMs);
            currentTime += defaultDurationMs;
          }
          currentText = '';
        }
      };

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          flushSegment();
          continue;
        }
        const actorMatch = trimmed.match(/^([\w\sа-яА-ЯёЁ]{2,30}):\s*(.*)$/);
        const isChapter = trimmed.toLowerCase().startsWith('chapter') || trimmed.match(/^\[.*\]$/);

        if (isChapter) {
          flushSegment();
          currentRole = 'System';
          currentText = trimmed;
          flushSegment(true);
          currentRole = 'Narrator';
        } else if (actorMatch) {
          flushSegment();
          currentRole = actorMatch[1].trim();
          currentText = actorMatch[2].trim();
        } else {
          currentText += (currentText ? ' ' : '') + trimmed;
        }
      }
      flushSegment();
      result = segments;
    }
    
    IOLogger.log('SUBTITLES', 'TextImport:parseRawText', 'SUCCESS', { count: result.length });
    return result;
  }

  private static addSegment(segments: SubtitleLine[], text: string, role: string, timeMs: number, durationMs: number) {
    segments.push({
      id: Math.random().toString(36).substr(2, 9),
      start: timeMs / 1000,
      end: (timeMs + durationMs) / 1000,
      text: text.trim(),
      role: role
    });
  }
}
