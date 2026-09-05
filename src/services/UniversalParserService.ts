import { parse as parseAss } from 'ass-compiler';
import mammoth from 'mammoth';
import ePub from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import { SubtitleLine } from '../types';
import { IOLogger } from '../lib/ioLogger';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

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
      const parsed = parseAss(content);
      // Map Dialogue events to our SubtitleLine structure using 'any' cast to bypass strict ass-compiler type mismatches
      return parsed.events.dialogue.map((dialogue: any, index: number) => {
        let rawText = dialogue.Text?.combined || dialogue.text?.combined || '';
        if (!rawText) rawText = '';
        const cleanText = rawText
          .replace(/\{[^}]+\}/g, '')
          .replace(/\\N/g, '\n')
          .replace(/\\n/g, '\n')
          .replace(/\\h/g, ' ')
          .trim();

        return {
          id: `ass-${index}-${Date.now()}`,
          start: dialogue.Start || dialogue.start || 0,
          end: dialogue.End || dialogue.end || 0,
          text: cleanText,
          role: dialogue.Name || dialogue.who || 'Default',
        };
      });
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
      lines.push({
        id: `srt-${lines.length}-${Date.now()}`,
        start: this.srtTimeToSeconds(startStr),
        end: this.srtTimeToSeconds(endStr),
        text: cleanText,
        role: 'Default',
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
      
      lines.push({
        id: `vtt-${lines.length}-${Date.now()}`,
        start: this.vttTimeToSeconds(startStr),
        end: this.vttTimeToSeconds(endStr),
        text: cleanText,
        role: 'Default',
      });
    }
    return lines;
  }

  private static parseCSV(content: string): SubtitleLine[] {
    const lines: SubtitleLine[] = [];
    const rows = content.split('\n').filter(line => line.trim().length > 0);
    
    rows.forEach((row, index) => {
      // Basic CSV splitting (doesn't handle quotes perfectly, but good enough for simple scripts)
      const parts = row.split(';');
      if (parts.length === 1) { // Try comma if semicolon fails
        const commaParts = row.split(',');
        if (commaParts.length > 1) parts.splice(0, 1, ...commaParts);
      }

      let text = parts[0] || '';
      let role = 'Default';

      if (parts.length >= 2) {
        role = parts[0].trim();
        text = parts.slice(1).join(',').trim();
      }

      lines.push({
        id: `csv-${index}-${Date.now()}`,
        start: 0, // No timecodes 
        end: 0,
        text: text.replace(/^["']|["']$/g, ''), // Strip surrounding quotes
        role: role.replace(/^["']|["']$/g, ''), // Strip surrounding quotes
      });
    });

    return lines;
  }

  private static parseFB2(content: string): SubtitleLine[] {
    const lines: SubtitleLine[] = [];
    
    // Extract everything between <body...> and </body>
    const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let bodyText = bodyMatch ? bodyMatch[1] : content;

    // Remove empty lines, images, binary
    bodyText = bodyText.replace(/<binary[^>]*>[\s\S]*?<\/binary>/gi, '');
    bodyText = bodyText.replace(/<empty-line\b[^>]*\/>/gi, '');

    // Get paragraphs <p>
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    let index = 0;
    while ((match = pRegex.exec(bodyText)) !== null) {
      // Strip other inner tags like <strong>, <emphasis>, <a>
      let text = match[1].replace(/<[^>]+>/g, '').trim();
      if (text.length > 0) {
        lines.push({
          id: `fb2-${index++}-${Date.now()}`,
          start: 0,
          end: 0,
          text: text,
          role: 'Default',
        });
      }
    }
    return lines;
  }

  private static async parseDOCX(content: string | ArrayBuffer): Promise<SubtitleLine[]> {
    try {
      // mammoth needs array buffer
      const buffer = typeof content === 'string' 
          ? new TextEncoder().encode(content).buffer 
          : content;
      
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      const text = result.value; // The raw text
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
          // Loop through all chapters
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
      .map((line, index) => ({
        id: `txt-${index}-${Date.now()}`,
        start: 0,
        end: 0,
        text: line.trim().replace(/\\N/g, ' ').replace(/\\n/g, ' '),
        role: 'Default',
      }));
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
