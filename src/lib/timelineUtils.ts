import { AudioSegment } from '../types';

/**
 * Implements "Punch-in" logic: replaces existing segments in the time range of the new segment.
 * This is non-destructive in the sense that it returns a new array of segments.
 */
export function punchInSegment(existingSegments: AudioSegment[], newSegment: AudioSegment): AudioSegment[] {
  const result: AudioSegment[] = [];
  const newStart = newSegment.startTime;
  const newEnd = newSegment.startTime + newSegment.duration;

  for (const seg of existingSegments) {
    const segStart = seg.startTime;
    const segEnd = seg.startTime + seg.duration;

    // Case 1: Existing segment is completely before or completely after the new one
    if (segEnd <= newStart || segStart >= newEnd) {
      result.push(seg);
      continue;
    }

    // Case 2: Existing segment is completely covered by the new one
    if (segStart >= newStart && segEnd <= newEnd) {
      // Just drop it (effectively replacing it)
      continue;
    }

    // Case 3: New segment starts inside existing segment and covers its end
    if (segStart < newStart && segEnd <= newEnd) {
      // Trim the end of existing segment
      const newDuration = newStart - segStart;
      if (newDuration > 0.01) { // Avoid micro-segments
        result.push({ ...seg, duration: newDuration });
      }
      continue;
    }

    // Case 4: New segment covers the start of existing segment but ends before it
    if (segStart >= newStart && segEnd > newEnd) {
      // Trim the start of existing segment
      const overlap = Math.round((newEnd - segStart) * 1000) / 1000;
      const newDuration = Math.round((seg.duration - overlap) * 1000) / 1000;
      const rate = seg.playbackRate || 1;
      if (newDuration > 0.01) {
        result.push({
          ...seg,
          startTime: newEnd,
          duration: newDuration,
          fileOffset: Math.round((seg.fileOffset + (overlap * rate)) * 1000) / 1000
        });
      }
      continue;
    }

    // Case 5: New segment is entirely inside existing segment (Split)
    if (segStart < newStart && segEnd > newEnd) {
      // Part 1: before
      const part1Duration = Math.round((newStart - segStart) * 1000) / 1000;
      if (part1Duration > 0.01) {
        result.push({ ...seg, duration: part1Duration });
      }
      
      // Part 2: after
      const overlapWithPart1PlusNew = Math.round((newEnd - segStart) * 1000) / 1000;
      const part2Duration = Math.round((segEnd - newEnd) * 1000) / 1000;
      const rate = seg.playbackRate || 1;
      if (part2Duration > 0.01) {
        result.push({
          ...seg,
          id: crypto.randomUUID(),
          startTime: newEnd,
          duration: part2Duration,
          fileOffset: Math.round((seg.fileOffset + (overlapWithPart1PlusNew * rate)) * 1000) / 1000
        });
      }
      continue;
    }
  }

  // Finally add the new segment
  result.push(newSegment);
  
  // Sort by start time
  return result.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Splits a single segment at a specific time and returns the resulting segments.
 * Calculates duration and fileOffset appropriately.
 */
export function splitSegmentAtTime(segment: AudioSegment, splitTime: number): AudioSegment[] {
  let normalizedSplitTime = Number(splitTime.toFixed(3));
  const segStart = Number(segment.startTime.toFixed(3));
  const segEnd = Number((segment.startTime + segment.duration).toFixed(3));

  // New logic: Clamp splitTime to force split
  if (normalizedSplitTime <= segStart) {
    normalizedSplitTime = Number((segStart + 0.001).toFixed(3));
  } else if (normalizedSplitTime >= segEnd) {
    normalizedSplitTime = Number((segEnd - 0.001).toFixed(3));
  }
  
  // Re-normalize just in case
  normalizedSplitTime = Number(normalizedSplitTime.toFixed(3));

  const leftDuration = Number((normalizedSplitTime - segment.startTime).toFixed(3));
  // Ensure sum equals original duration
  const rightDuration = Number((segment.duration - leftDuration).toFixed(3));
  
  const rate = segment.playbackRate || 1;
  // newFileOffset = originalFileOffset + (currentTime - originalStartTime) * rate
  const rightFileOffset = Number((segment.fileOffset + (leftDuration * rate)).toFixed(3));

  const actualSplitTimeOnTimeline = Number((segment.startTime + leftDuration).toFixed(3));

  const leftSeg: AudioSegment = { 
    ...segment, 
    duration: leftDuration 
  };
  
  const rightSeg: AudioSegment = {
    ...segment,
    id: crypto.randomUUID(),
    startTime: actualSplitTimeOnTimeline,
    duration: rightDuration,
    fileOffset: rightFileOffset
  };

  return [leftSeg, rightSeg];
}

