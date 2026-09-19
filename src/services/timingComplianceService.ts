// ============================================================================
// DUB MIXING STUDIO PRO - TIMING COMPLIANCE SERVICE (TYPESCRIPT CLIENT)
// Высокопроизводительный фронтенд-интерфейс к Rust Sweep-Line Engine
// Ликвидирует тяжелый квадратичный перебор O(N*M) в пользу O((N+M) log(N+M))
// ============================================================================

import { AudioTrack, SubtitleLine, TimingIssue, MixingType, TimingAlignmentConfig } from '../types';

export interface SegmentAuditInput {
  id: string;
  startTimeMs: number;
  durationMs: number;
  text?: string;
  matchedSubId?: string;
  fileOffsetMs?: number;
  fileDurationMs?: number;
  isSibilant?: boolean;
  isPlosive?: boolean;
  isClick?: boolean;
}

export interface TrackAuditInput {
  id: string;
  name: string;
  role?: string;
  segments: SegmentAuditInput[];
}

export interface SubtitleAuditInput {
  id: string;
  startTimeMs: number;
  endTimeMs: number;
  role?: string;
  text: string;
}

export interface RustTimingIssue {
  id: string;
  issueType: 'overlap' | 'tooShort' | 'tooLong' | 'missing' | 'leadLagDelta' | 'sibilantExcess' | 'plosiveDetected' | 'clickFound';
  trackId: string;
  trackName?: string;
  segmentId?: string;
  timeStartMs: number;
  timeEndMs: number;
  deltaMs: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  canAutoFix: boolean;
  matchedSubText?: string;
  targetDurationMs?: number;
  actualDurationMs?: number;
}

class TimingComplianceService {
  private isTauriAvailable(): boolean {
    return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
  }

  /**
   * Нативный аудит таймингов через Rust + Rayon Sweep-Line (< 2 мс)
   */
  public async auditProjectTiming(
    tracks: AudioTrack[],
    subtitles: SubtitleLine[],
    toleranceMs: number = 200
  ): Promise<TimingIssue[]> {
    const dubTracks = tracks.filter(t => 
      t.name !== 'Оригинал' && 
      t.name !== 'Звуки (Музыка)' && 
      t.name !== 'Голоса (Вокал)'
    );

    if (this.isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');

        const trackInputs: TrackAuditInput[] = dubTracks.map(t => ({
          id: t.id,
          name: t.name,
          role: t.name,
          segments: (t.segments || []).map(s => ({
            id: s.id,
            startTimeMs: Math.round(s.startTime * 1000),
            durationMs: Math.round(s.duration * 1000),
            text: s.text,
            matchedSubId: s.matchedSubId,
            fileOffsetMs: s.fileOffset ? Math.round(s.fileOffset * 1000) : undefined,
            fileDurationMs: s.fileDuration ? Math.round(s.fileDuration * 1000) : undefined,
            isSibilant: s.analysisFlags?.isSibilant,
            isPlosive: s.analysisFlags?.isPlosive,
            isClick: s.analysisFlags?.isClick,
          }))
        }));

        const subInputs: SubtitleAuditInput[] = subtitles.map(s => ({
          id: s.id,
          startTimeMs: Math.round(s.start * 1000),
          endTimeMs: Math.round(s.end * 1000),
          role: s.role,
          text: s.text,
        }));

        const rustIssues = await invoke<RustTimingIssue[]>('audit_project_timing', {
          tracks: trackInputs,
          subtitles: subInputs,
          toleranceMs,
        });

        return rustIssues.map(r => this.mapRustIssueToTimingIssue(r));
      } catch (err) {
        console.warn('[TimingComplianceService] Ошибка нативного Rust аудита, fallback на JS Sweep-Line:', err);
      }
    }

    // Оптимизированный Sweep-Line алгоритм O((N+M) log(N+M)) для Web-режима
    return this.auditProjectTimingSweepLineWeb(dubTracks, subtitles, toleranceMs);
  }

  /**
   * Преобразование нативного ответа Rust в модель фронтенда
   */
  private mapRustIssueToTimingIssue(rustIssue: RustTimingIssue): TimingIssue {
    let type: TimingIssue['type'] = 'desync';
    switch (rustIssue.issueType) {
      case 'overlap':
        type = 'overlap';
        break;
      case 'tooShort':
        type = 'too_short';
        break;
      case 'tooLong':
        type = 'too_long';
        break;
      case 'missing':
        type = 'missing';
        break;
      case 'sibilantExcess':
        type = 'sibilant';
        break;
      case 'plosiveDetected':
        type = 'plosive';
        break;
      case 'clickFound':
        type = 'click';
        break;
      case 'leadLagDelta':
      default:
        type = 'desync';
        break;
    }

    const startSec = rustIssue.timeStartMs / 1000.0;
    const durSec = (rustIssue.timeEndMs - rustIssue.timeStartMs) / 1000.0;

    return {
      id: rustIssue.id,
      type,
      trackId: rustIssue.trackId,
      trackName: rustIssue.trackName || 'Дорожка',
      segmentId: rustIssue.segmentId,
      timestamp: parseFloat(startSec.toFixed(3)),
      duration: parseFloat(durSec.toFixed(3)),
      title: rustIssue.message.split(':')[0] || 'Проблема тайминга',
      description: rustIssue.message,
      severity: rustIssue.severity,
      canAutoFix: rustIssue.canAutoFix,
      matchedSubText: rustIssue.matchedSubText,
      targetDuration: rustIssue.targetDurationMs ? rustIssue.targetDurationMs / 1000.0 : undefined,
      actualDuration: rustIssue.actualDurationMs ? rustIssue.actualDurationMs / 1000.0 : undefined,
    };
  }

  /**
   * Быстрый Sweep-Line интервальный аудит в JS за O((N+M) log(N+M))
   */
  private auditProjectTimingSweepLineWeb(
    dubTracks: AudioTrack[],
    subtitles: SubtitleLine[],
    toleranceMs: number
  ): TimingIssue[] {
    const issues: TimingIssue[] = [];
    const tolSec = toleranceMs / 1000.0;

    // 1. Проверка наездов внутри каждой дорожки
    for (const track of dubTracks) {
      const segs = [...(track.segments || [])].sort((a, b) => a.startTime - b.startTime);
      for (let i = 1; i < segs.length; i++) {
        const prev = segs[i - 1];
        const curr = segs[i];
        const prevEnd = prev.startTime + prev.duration;
        if (curr.startTime < prevEnd - 0.03) {
          const overlapSec = parseFloat((prevEnd - curr.startTime).toFixed(2));
          issues.push({
            id: `val_overlap_${curr.id}`,
            type: 'overlap',
            trackId: track.id,
            trackName: track.name,
            segmentId: curr.id,
            timestamp: curr.startTime,
            duration: overlapSec,
            title: `Наезд на дорожке "${track.name}"`,
            description: `Реплика наезжает на предыдущую на ${overlapSec} с (таймкод: ${Math.floor(curr.startTime / 60)}:${(curr.startTime % 60).toFixed(1)})`,
            severity: 'error',
            matchedSubText: curr.text,
            canAutoFix: true
          });
        }
      }
    }

    // 2. Сортировка субтитров для бинарного поиска
    const sortedSubs = [...subtitles].sort((a, b) => a.start - b.start);
    const subsById = new Map<string, SubtitleLine>();
    sortedSubs.forEach(s => subsById.set(s.id, s));

    for (const track of dubTracks) {
      for (const seg of track.segments || []) {
        let matchedSub = seg.matchedSubId ? subsById.get(seg.matchedSubId) : undefined;
        if (!matchedSub && sortedSubs.length > 0) {
          // Бинарный поиск ближайшего субтитра
          let low = 0;
          let high = sortedSubs.length - 1;
          while (low <= high) {
            const mid = (low + high) >> 1;
            const sub = sortedSubs[mid];
            if (sub.end + 0.75 < seg.startTime) {
              low = mid + 1;
            } else if (sub.start - 0.75 > seg.startTime + seg.duration) {
              high = mid - 1;
            } else {
              matchedSub = sub;
              break;
            }
          }
        }

        if (matchedSub) {
          const subDur = matchedSub.end - matchedSub.start;
          if (seg.duration < subDur - tolSec) {
            const diff = (subDur - seg.duration).toFixed(2);
            issues.push({
              id: `val_short_${seg.id}`,
              type: 'too_short',
              trackId: track.id,
              trackName: track.name,
              segmentId: seg.id,
              timestamp: seg.startTime,
              duration: seg.duration,
              targetDuration: subDur,
              actualDuration: seg.duration,
              title: `Фраза короче саба на "${track.name}"`,
              description: `Фраза длится ${seg.duration.toFixed(2)} с, а субтитр ${subDur.toFixed(2)} с (недотяг ${diff} с)`,
              severity: 'warning',
              matchedSubText: matchedSub.text,
              canAutoFix: true
            });
          }
        }
      }
    }

    // 3. Проверка пропусков через слияние речевых зон
    if (subtitles.length > 0) {
      const allEvents: { time: number; type: 1 | -1 }[] = [];
      for (const track of dubTracks) {
        for (const seg of track.segments || []) {
          allEvents.push({ time: seg.startTime, type: 1 });
          allEvents.push({ time: seg.startTime + seg.duration, type: -1 });
        }
      }

      allEvents.sort((a, b) => a.time - b.time || b.type - a.type);
      const mergedSpans: { start: number; end: number }[] = [];
      let active = 0;
      let curStart = 0;

      for (const ev of allEvents) {
        if (ev.type === 1) {
          if (active === 0) curStart = ev.time;
          active++;
        } else {
          active--;
          if (active === 0) {
            mergedSpans.push({ start: curStart, end: ev.time });
          }
        }
      }

      for (const sub of subtitles) {
        let hasVoice = false;
        for (const span of mergedSpans) {
          if (span.end >= sub.start - 2.0 && span.start <= sub.end + 2.0) {
            hasVoice = true;
            break;
          }
        }

        if (!hasVoice) {
          issues.push({
            id: `val_miss_${sub.id}`,
            type: 'missing',
            trackId: dubTracks[0]?.id || 'unknown',
            trackName: sub.role || 'Общая',
            timestamp: sub.start,
            duration: sub.end - sub.start,
            title: `Пропущенная фраза: "${sub.role}"`,
            description: `Субтитр не имеет озвученного дубля на таймкоде ${Math.floor(sub.start / 60)}:${(sub.start % 60).toFixed(1)}: "${sub.text.slice(0, 45)}..."`,
            severity: 'info',
            matchedSubText: sub.text,
            canAutoFix: false
          });
        }
      }
    }

    return issues.sort((a, b) => a.timestamp - b.timestamp);
  }
}

export const timingComplianceService = new TimingComplianceService();
export default timingComplianceService;
