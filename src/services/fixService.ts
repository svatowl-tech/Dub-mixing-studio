import { Fix, SubtitleLine } from '../types';

export class FixService {
  /**
   * Parses raw text feedback into structured Fix objects.
   * Expected format:
   * @ActorName
   * [MM:SS] comment
   * or
   * Name:
   * [MM:SS] comment
   */
  static parseRawFixes(text: string, subtitles: SubtitleLine[]): Fix[] {
    const fixes: Fix[] = [];
    const lines = text.split('\n');
    let currentActor = 'Unknown';

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // Check for Actor Name pattern
      const actorMatch = trimmedLine.match(/^@?([\w\d]+)(?:\s*\(.*\))?:?$/i);
      if (actorMatch) {
        currentActor = actorMatch[1];
        continue;
      }

      // Check for Timestamp + Comment pattern
      // Matches: "  • [15:04] comment", "3:42 — comment", "14:00-14:12 - comment", etc.
      const fixMatch = trimmedLine.match(/^(?:[\s•\-\—\*\.]*?)\[?(\d{1,2}):(\d{2})(?:\s*(?:-|—)\s*\d{1,2}:\d{2})?\]?\s*(?:-|—|:)?\s*(.*)$/i);
      if (fixMatch) {
        const minutes = parseInt(fixMatch[1], 10);
        const seconds = parseInt(fixMatch[2], 10);
        const timestamp = minutes * 60 + seconds;
        let comment = fixMatch[3].trim();
        
        // Remove leading dash if still present (e.g., if it didn't match the separator)
        if (comment.startsWith('-') || comment.startsWith('—')) {
            comment = comment.substring(1).trim();
        }

        // Find the closest segment, preferring segments that encompass the timestamp
        let closestSegment = subtitles.find(s => timestamp >= s.start && timestamp <= s.end);
        
        // If no exact match inside time segment, find the closest one by absolute difference to start time
        if (!closestSegment && subtitles.length > 0) {
            closestSegment = subtitles.reduce((prev, curr) => {
                const prevDiff = Math.min(Math.abs(prev.start - timestamp), Math.abs(prev.end - timestamp));
                const currDiff = Math.min(Math.abs(curr.start - timestamp), Math.abs(curr.end - timestamp));
                return currDiff < prevDiff ? curr : prev;
            });
        }

        fixes.push({
          id: Math.random().toString(36).substr(2, 9),
          segmentId: closestSegment?.id,
          timestamp,
          actor: currentActor,
          comment,
          isResolved: false
        });
      }
    }

    return fixes;
  }
}
