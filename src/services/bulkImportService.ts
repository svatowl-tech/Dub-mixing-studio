import { Project, AudioTrack, AudioSegment, SubtitleLine } from '../types';
import { IOLogger } from '../lib/ioLogger';

export class BulkImportService {
  static async importFolder(folderPath: string): Promise<{ tracks: AudioTrack[], duration: number, subtitles: SubtitleLine[] }> {
    IOLogger.log('MEDIA', 'BulkImport:importFolder', 'START', { folderPath });
    if (!window.electronAPI) throw new Error("Desktop API not available");

    try {
      const filesRes = await window.electronAPI.getAudioFiles(folderPath);
      if (!filesRes.success || !filesRes.data) {
        throw new Error("Failed to read audio files from directory");
      }
      const files = filesRes.data;
      IOLogger.log('MEDIA', 'BulkImport:importFolder', 'SUCCESS', { count: files.length });
    
      const originalTrack: AudioTrack = {
      id: 'original-track-' + Math.random().toString(36).substr(2, 9),
      name: 'Оригинал',
      segments: [],
      volume: 1,
      isMuted: false
    };

    const dubTrack: AudioTrack = {
      id: 'dub-track-' + Math.random().toString(36).substr(2, 9),
      name: 'Dubs',
      segments: [],
      volume: 1,
      isMuted: false
    };

    const subtitles: SubtitleLine[] = [];
    let currentTime = 0;
    const gap = 1.0; // 1 second gap between segments

    files.forEach(file => {
      const segmentId = Math.random().toString(36).substr(2, 9);
      const normalizedPath = file.path.replace(/\\/g, '/');
      const safeUrl = /^[a-zA-Z]:/.test(normalizedPath) ? `safe-file:///${normalizedPath}` : `safe-file://${normalizedPath}`;

      const segment: AudioSegment = {
        id: segmentId,
        startTime: currentTime,
        duration: file.duration,
        fileOffset: 0,
        fileDuration: file.duration,
        blobUrl: safeUrl,
        filePath: file.path,
        waveform: file.peaks,
        gain: 1,
        playbackRate: 1,
        originalFileName: file.name
      };

      originalTrack.segments.push(segment);

      subtitles.push({
        id: 'sub-' + segmentId,
        start: currentTime,
        end: currentTime + file.duration,
        text: file.name, // Use filename as text
        role: 'Original'
      });

      currentTime += file.duration + gap;
    });

    return {
      tracks: [originalTrack, dubTrack],
      duration: currentTime,
      subtitles
    };
    } catch (err) {
      IOLogger.log('MEDIA', 'BulkImport:importFolder', 'ERROR', { folderPath }, String(err));
      throw err;
    }
  }

  static async importGameDubbing(folderPath: string, translationText: string): Promise<{ tracks: AudioTrack[], duration: number, subtitles: SubtitleLine[] }> {
    IOLogger.log('MEDIA', 'BulkImport:importGameDubbing', 'START', { folderPath, textLength: translationText.length });
    if (!window.electronAPI) throw new Error("Desktop API not available");

    try {
      const filesRes = await window.electronAPI.getAudioFiles(folderPath);
      if (!filesRes.success || !filesRes.data) {
        throw new Error("Failed to read audio files from directory");
      }
      const files = filesRes.data;

      // Parse translation file lines
    const lines = translationText.split(/\r?\n/);
    const translations = new Map<number, string>();
    let currentNum: number | null = null;
    let currentText = '';

    const flush = () => {
      if (currentNum !== null && currentText.trim()) {
        translations.set(currentNum, currentText.trim());
      }
      currentNum = null;
      currentText = '';
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Robust matching of line beginning with optional prefix (Файл/File/etc), then possible colons/spaces, then the number, then separators, then translation text
      const match = trimmed.match(/^(?:Файл|File|Line|Номер|No|Num|Clip)?[\s\d_:#\-\[\]\.\)]*?\b(\d+)\s*[:\.\)\]\-\s]+\s*(.*)$/i);
      if (match) {
        flush();
        currentNum = parseInt(match[1], 10);
        currentText = match[2];
      } else {
        if (currentNum !== null) {
          currentText += ' ' + trimmed;
        }
      }
    }
    flush();

    // Helper to extract prefix number from filename (with fallback to first number block in the filename)
    const extractFilenameNumber = (filename: string): number | null => {
      const leadingMatch = filename.match(/^\s*(\d+)/);
      if (leadingMatch) {
        return parseInt(leadingMatch[1], 10);
      }
      const generalMatch = filename.match(/\d+/);
      if (generalMatch) {
        return parseInt(generalMatch[0], 10);
      }
      return null;
    };

    // Sort files numerically by prefix number (critical for correct sequence)
    const sortedFiles = [...files];
    sortedFiles.sort((a, b) => {
      const numA = extractFilenameNumber(a.name) ?? Infinity;
      const numB = extractFilenameNumber(b.name) ?? Infinity;
      if (numA !== numB) return numA - numB;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    const originalTrack: AudioTrack = {
      id: 'original-track-' + Math.random().toString(36).substr(2, 9),
      name: 'Оригинал',
      segments: [],
      volume: 1,
      isMuted: false
    };

    const dubTrack: AudioTrack = {
      id: 'dub-track-' + Math.random().toString(36).substr(2, 9),
      name: 'Dubs',
      segments: [],
      volume: 1,
      isMuted: false
    };

    const subtitles: SubtitleLine[] = [];
    let currentTime = 0;
    const gap = 1.0; // 1.0 second pause between segments

    sortedFiles.forEach(file => {
      const num = extractFilenameNumber(file.name);
      const text = (num !== null && translations.has(num)) ? translations.get(num)! : file.name;

      const segmentId = Math.random().toString(36).substr(2, 9);
      const normalizedPath = file.path.replace(/\\/g, '/');
      const safeUrl = /^[a-zA-Z]:/.test(normalizedPath) ? `safe-file:///${normalizedPath}` : `safe-file://${normalizedPath}`;

      const segment: AudioSegment = {
        id: segmentId,
        startTime: currentTime,
        duration: file.duration,
        fileOffset: 0,
        fileDuration: file.duration,
        blobUrl: safeUrl,
        filePath: file.path,
        waveform: file.peaks,
        gain: 1,
        playbackRate: 1,
        originalFileName: file.name,
        text: text
      };

      originalTrack.segments.push(segment);

      subtitles.push({
        id: 'sub-' + segmentId,
        start: currentTime,
        end: currentTime + file.duration,
        text: text,
        role: 'Original'
      });

      currentTime += file.duration + gap;
    });

    return {
      tracks: [originalTrack, dubTrack],
      duration: currentTime,
      subtitles
    };
    } catch (err) {
      IOLogger.log('MEDIA', 'BulkImport:importGameDubbing', 'ERROR', { folderPath }, String(err));
      throw err;
    }
  }
}
