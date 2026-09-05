import { parse } from 'ass-compiler';
import { SubtitleLine } from '../types';
import { IOLogger } from '../lib/ioLogger';

export interface ParsedSubtitles {
  roles: string[];
  subtitles: SubtitleLine[];
}

export class SubtitleService {
  static parse(content: string): ParsedSubtitles {
    IOLogger.log('SUBTITLES', 'SubtitleService:parse', 'START', { length: content.length });
    try {
      let result: ParsedSubtitles;
      if (content.includes('[Script Info]')) {
        result = this.parseASS(content);
      } else if (content.includes('-->')) {
        result = this.parseSRT(content);
      } else {
        throw new Error('Unsupported subtitle format');
      }
      IOLogger.log('SUBTITLES', 'SubtitleService:parse', 'SUCCESS', { count: result.subtitles.length, roles: result.roles });
      return result;
    } catch (err) {
      IOLogger.log('SUBTITLES', 'SubtitleService:parse', 'ERROR', null, String(err));
      throw err;
    }
  }

  static parseASS(content: string): ParsedSubtitles {
    const parsed = parse(content);
    const lines: SubtitleLine[] = [];
    const rolesSet = new Set<string>();

    const dialogues = parsed.events?.dialogue || [];
    
    dialogues.forEach((event: any, index: number) => {
      const role = event.Name && event.Name.trim() !== '' ? event.Name : (event.Style || 'Default');
      rolesSet.add(role);

      let rawText = '';
      if (typeof event.Text === 'object') {
        rawText = event.Text.combined || event.Text.raw || '';
      } else if (typeof event.Text === 'string') {
        rawText = event.Text;
      }

      const cleanText = rawText
        .replace(/\{[^}]+\}/g, '')
        .replace(/\\N/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\h/g, ' ')
        .trim();

      lines.push({
        id: `ass-${index}`,
        start: event.Start,
        end: event.End,
        text: cleanText,
        role: role,
      });
    });

    return {
      roles: Array.from(rolesSet),
      subtitles: lines,
    };
  }

  static parseSRT(content: string): ParsedSubtitles {
    const lines: SubtitleLine[] = [];
    const blocks = content.trim().split(/\n\s*\n/);

    blocks.forEach((block, index) => {
      const parts = block.split('\n');
      if (parts.length >= 3) {
        const timeMatch = parts[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
        if (timeMatch) {
          const start = this.srtTimeToSeconds(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
          const end = this.srtTimeToSeconds(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
          
          let text = parts.slice(2).join('\n');
          text = text.replace(/<[^>]+>/g, '').trim();
          
          lines.push({
            id: `srt-${index}`,
            start,
            end,
            text,
            role: 'Default',
          });
        }
      }
    });

    return {
      roles: ['Default'],
      subtitles: lines,
    };
  }

  private static srtTimeToSeconds(h: string, m: string, s: string, ms: string): number {
    return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms, 10) / 1000;
  }
}
