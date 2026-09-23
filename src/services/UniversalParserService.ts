import { SubtitleService } from './subtitleService';
import mammoth from 'mammoth';
import ePub from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import { SubtitleLine } from '../types';
import { IOLogger } from '../lib/ioLogger';
import { parseSubtitleFileNative, isTauriEnvironment } from '../lib/subtitleFuzzyBridge';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

export function extractSpeakerAndCleanText(rawText: string, defaultRole = 'Default'): { role: string; text: string } {
  let text = rawText.trim();
  if (!text) return { role: defaultRole, text: '' };

  // 1. WebVTT <v Speaker>text</v>
  const vttSpeakerMatch = text.match(/^<v\s+([^>]+)>(.*)(?:<\/v>)?$/is);
  if (vttSpeakerMatch) {
    return {
      role: vttSpeakerMatch[1].trim(),
      text: vttSpeakerMatch[2].replace(/<\/v>/gi, '').trim()
    };
  }

  // 2. [Speaker]: Text or [Speaker] Text
  const bracketSpeakerMatch = text.match(/^\[([a-zA-Zа-яА-ЯёЁ0-9_\s\-\.]{1,30})\]\s*[:\-—]?\s*(.+)$/s);
  if (bracketSpeakerMatch) {
    return {
      role: bracketSpeakerMatch[1].trim(),
      text: bracketSpeakerMatch[2].trim()
    };
  }

  // 3. (Speaker): Text or (Speaker) Text
  const parenSpeakerMatch = text.match(/^\(([a-zA-Zа-яА-ЯёЁ0-9_\s\-\.]{1,30})\)\s*[:\-—]?\s*(.+)$/s);
  if (parenSpeakerMatch) {
    return {
      role: parenSpeakerMatch[1].trim(),
      text: parenSpeakerMatch[2].trim()
    };
  }

  // 4. Speaker: Text (where Speaker is 1-3 words without punctuation)
  const colonSpeakerMatch = text.match(/^([a-zA-Zа-яА-ЯёЁ0-9_]{2,20}(?:\s+[a-zA-Zа-яА-ЯёЁ0-9_]{2,20}){0,2})\s*:\s+(.+)$/s);
  if (colonSpeakerMatch && !colonSpeakerMatch[1].toLowerCase().startsWith('http') && !/^\d+$/.test(colonSpeakerMatch[1])) {
    return {
      role: colonSpeakerMatch[1].trim(),
      text: colonSpeakerMatch[2].trim()
    };
  }

  return {
    role: defaultRole,
    text
  };
}

export class UniversalParserService {
  /**
   * Parses the raw content of a file into SubtitleLine objects.
   * Supports .ass, .srt, .vtt, .csv, .fb2, .txt, .epub, .docx, .pdf.
   */
  static async parse(content: string | ArrayBuffer, fileName: string): Promise<SubtitleLine[]> {
    const extension = fileName.split('.').pop()?.toLowerCase();
    IOLogger.log('SUBTITLES', 'UniversalParser.parse', 'START', { fileName, extension, size: typeof content === 'string' ? content.length : content.byteLength });

    try {
      // If it's ArrayBuffer (for docx/epub/pdf), we handle it internally within the switch
      // Otherwise, normalize CRLF to LF universally for text modes
      const isText = typeof content === 'string';
      const normalizedContent = isText ? (content as string).replace(/\r\n/g, '\n') : '';

      // High-performance Native Rust parser for ASS, SRT, VTT, TXT in Tauri
      if (isText && isTauriEnvironment() && ['ass', 'ssa', 'srt', 'vtt'].includes(extension || '')) {
        const nativeResult = await parseSubtitleFileNative(normalizedContent, extension || 'ass');
        if (nativeResult && nativeResult.length > 0) {
          IOLogger.log('SUBTITLES', 'UniversalParser.parseNative', 'SUCCESS', { count: nativeResult.length, format: extension });
          return nativeResult;
        }
      }

      let result: SubtitleLine[] = [];
      switch (extension) {
        case 'ass':
          result = this.parseASS(normalizedContent);
          break;
        case 'srt':
          result = this.parseSRT(normalizedContent);
          break;
        case 'vtt':
          result = this.parseVTT(normalizedContent);
          break;
        case 'csv':
          result = this.parseCSV(normalizedContent);
          break;
        case 'fb2':
          result = this.parseFB2(normalizedContent);
          break;
        case 'docx':
          result = await this.parseDOCX(content);
          break;
        case 'epub':
          result = await this.parseEPUB(content);
          break;
        case 'pdf':
          result = await this.parsePDF(content);
          break;
        case 'txt':
        default:
          result = this.parseTXT(normalizedContent);
          break;
      }
      IOLogger.log('SUBTITLES', 'UniversalParser.parse', 'SUCCESS', { count: result.length });
      return result;
    } catch (err) {
      IOLogger.log('SUBTITLES', 'UniversalParser.parse', 'ERROR', { fileName }, String(err));
      throw err;
    }
  }

  private static parseASS(content: string): SubtitleLine[] {
    try {
      return SubtitleService.parseASS(content).subtitles;
    } catch (err) {
      console.error('ASS parsing failed:', err);
      return [];
    }
  }

  private static parseSRT(content: string): SubtitleLine[] {
    const lines: SubtitleLine[] = [];
    const srtRegex = /\d+\n(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})\n([\s\S]*?)(?=\n\n|\n$|$)/g;
    
    let match;
    while ((match = srtRegex.exec(content)) !== null) {
      const [ , startStr, endStr, text] = match;
      const cleanText = text.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim().replace(/\\N/g, ' ').replace(/\\n/g, ' ').replace(/\n/g, ' ');
      const { role, text: parsedText } = extractSpeakerAndCleanText(cleanText, 'Default');
      lines.push({
        id: `srt-${lines.length}-${Date.now()}`,
        start: this.srtTimeToSeconds(startStr),
        end: this.srtTimeToSeconds(endStr),
        text: parsedText,
        role,
      });
    }
    return lines;
  }

  private static parseVTT(content: string): SubtitleLine[] {
    const lines: SubtitleLine[] = [];
    // VTT uses . instead of , for milliseconds and may omit hours
    const vttRegex = /(?:.+)?\n?(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3})(?:.*?)\n([\s\S]*?)(?=\n\n|\n$|$)/g;
    
    let match;
    while ((match = vttRegex.exec(content)) !== null) {
      const [ , startStr, endStr, text] = match;
      if (text.trim().toLowerCase() === 'webvtt') continue; // Skip header

      // Strip VTT tags like <v Speaker> or <c.class>
      const cleanText = text.replace(/<[^>]+>/g, '').trim().replace(/\\N/g, ' ').replace(/\\n/g, ' ').replace(/\n/g, ' ');
      const { role, text: parsedText } = extractSpeakerAndCleanText(text.trim(), 'Default');
      
      lines.push({
        id: `vtt-${lines.length}-${Date.now()}`,
        start: this.vttTimeToSeconds(startStr),
        end: this.vttTimeToSeconds(endStr),
        text: parsedText || cleanText,
        role,
      });
    }
    return lines;
  }

  private static parseCSV(content: string): SubtitleLine[] {
    const lines: SubtitleLine[] = [];
    const rows = content.split('\n').filter(line => line.trim().length > 0);
    
    rows.forEach((row, index) => {
      const parts = row.split(';');
      if (parts.length === 1) {
        const commaParts = row.split(',');
        if (commaParts.length > 1) parts.splice(0, 1, ...commaParts);
      }

      let text = parts[0] || '';
      let role = 'Default';

      if (parts.length >= 2) {
        role = parts[0].trim();
        text = parts.slice(1).join(',').trim();
      } else {
        const extracted = extractSpeakerAndCleanText(text);
        role = extracted.role;
        text = extracted.text;
      }

      lines.push({
        id: `csv-${index}-${Date.now()}`,
        start: 0, 
        end: 0,
        text: text.replace(/^["']|["']$/g, ''),
        role: role.replace(/^["']|["']$/g, ''),
      });
    });

    return lines;
  }

  private static parseFB2(content: string): SubtitleLine[] {
    const lines: SubtitleLine[] = [];
    const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let bodyText = bodyMatch ? bodyMatch[1] : content;

    bodyText = bodyText.replace(/<binary[^>]*>[\s\S]*?<\/binary>/gi, '');
    bodyText = bodyText.replace(/<empty-line\b[^>]*\/>/gi, '');

    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    let index = 0;
    while ((match = pRegex.exec(bodyText)) !== null) {
      let text = match[1].replace(/<[^>]+>/g, '').trim();
      if (text.length > 0) {
        const { role, text: parsedText } = extractSpeakerAndCleanText(text);
        lines.push({
          id: `fb2-${index++}-${Date.now()}`,
          start: 0,
          end: 0,
          text: parsedText,
          role,
        });
      }
    }
    return lines;
  }

  private static async parseDOCX(content: string | ArrayBuffer): Promise<SubtitleLine[]> {
    try {
      const buffer = typeof content === 'string' 
          ? new TextEncoder().encode(content).buffer 
          : content;
      
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      const text = result.value;
      return this.parseTXT(text);
    } catch (err) {
      console.error('DOCX parsing failed:', err);
      return [];
    }
  }

  private static async parseEPUB(content: string | ArrayBuffer): Promise<SubtitleLine[]> {
    try {
      const book = ePub(content as any);
      await book.ready;
      
      let fullText = '';
      const spine = book.spine as any;
      if (spine && spine.each) {
          const chapters: string[] = [];
          for (let i = 0; i < spine.items.length; i++) {
              const item = spine.items[i];
              const chapter = await book.load(item.href);
              const textNode = (chapter as Document).body.textContent || "";
              chapters.push(textNode.trim());
          }
          fullText = chapters.join('\n\n');
      }
      
      return this.parseTXT(fullText);
    } catch (err) {
      console.error('EPUB parsing failed:', err);
      return [];
    }
  }

  private static async parsePDF(content: string | ArrayBuffer): Promise<SubtitleLine[]> {
    try {
      const buffer = typeof content === 'string'
        ? new TextEncoder().encode(content).buffer
        : content;

      const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
      const pdf = await loadingTask.promise;
      
      let fullText = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        fullText += pageText + '\n\n';
      }

      return this.parseTXT(fullText);
    } catch (err) {
      console.error('PDF parsing failed:', err);
      return [];
    }
  }

  private static parseTXT(content: string): SubtitleLine[] {
    return content.split('\n')
      .filter(line => line.trim().length > 0)
      .map((line, index) => {
        const { role, text } = extractSpeakerAndCleanText(line.trim().replace(/\\N/g, ' ').replace(/\\n/g, ' '));
        return {
          id: `txt-${index}-${Date.now()}`,
          start: 0,
          end: 0,
          text,
          role,
        };
      });
  }

  private static srtTimeToSeconds(time: string): number {
    const [hms, ms] = time.split(',');
    const [h, m, s] = hms.split(':').map(Number);
    return h * 3600 + m * 60 + s + Number(ms) / 1000;
  }

  private static vttTimeToSeconds(time: string): number {
    const parts = time.split('.');
    const hms = parts[0];
    const ms = parts[1] ? Number(parts[1]) / 1000 : 0;
    
    const timeParts = hms.split(':').map(Number);
    if (timeParts.length === 3) { // HH:MM:SS
      return timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2] + ms;
    } else if (timeParts.length === 2) { // MM:SS
      return timeParts[0] * 60 + timeParts[1] + ms;
    }
    return 0;
  }
}

