// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE ADAPTIVE DUCKING SERVICE (TYPESCRIPT)
// Sample-Accurate Sidechain Ducking Client & Gain Envelope Generator
// ============================================================================

export type CurveType = 'linear' | 'exponential' | 'sCurve';

export interface DuckingConfig {
  /** Уровень приглушения в dB (напр. -16 dB для закадра, -96 dB для дубляжа) */
  attenuationDb: number;
  /** Предварительное упреждение перед репликой (Lookahead) в миллисекундах */
  lookaheadMs: number;
  /** Длительность фазы затухания (Attack) в миллисекундах (S-Curve) */
  attackMs: number;
  /** Удержание ослабления (Hold) в миллисекундах */
  holdMs: number;
  /** Длительность фазы восстановления (Release) в миллисекундах */
  releaseMs: number;
  /** Тип кривой интерполяции (Linear, Exponential, SCurve) */
  curveType?: CurveType;
}

export interface CueRange {
  /** Начальный номер сэмпла реплики (Sample-accurate) */
  startSample: number;
  /** Конечный номер сэмпла реплики (Sample-accurate) */
  endSample: number;
}

export interface VoiceTimeRange {
  startSec: number;
  endSec: number;
}

export interface DuckingProcessingResult {
  projectId: string;
  targetTrackId: string;
  attenuationDb: number;
  processedFrames: usize;
  totalCuesCount: number;
  durationSeconds: number;
  elapsedMs: number;
  outputPath: string;
  success: boolean;
}

type usize = number;

class DuckingService {
  private isTauriAvailable(): boolean {
    return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
  }

  /**
   * Применение адаптивного сайдчейн-даккинга в Rust с точностью до сэмпла
   * @param projectId Идентификатор текущего проекта
   * @param config Параметры затухания, упреждения, атаки и релиза
   */
  public async applyAdaptiveDucking(
    projectId: string,
    config: Partial<DuckingConfig> = {}
  ): Promise<DuckingProcessingResult> {
    const fullConfig: DuckingConfig = {
      attenuationDb: config.attenuationDb ?? -16.0,
      lookaheadMs: config.lookaheadMs ?? 50.0,
      attackMs: config.attackMs ?? 80.0,
      holdMs: config.holdMs ?? 150.0,
      releaseMs: config.releaseMs ?? 300.0,
      curveType: config.curveType ?? 'sCurve',
    };

    if (this.isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<DuckingProcessingResult>('apply_adaptive_ducking', {
          projectId,
          config: fullConfig,
        });
      } catch (err) {
        console.error(`[DuckingService] Ошибка нативного даккинга для проекта '${projectId}':`, err);
        throw new Error(typeof err === 'string' ? err : (err as Error).message);
      }
    }

    // Fallback для режима веб-превью
    return {
      projectId,
      targetTrackId: 'me-track-default',
      attenuationDb: fullConfig.attenuationDb,
      processedFrames: 48000 * 60,
      totalCuesCount: 12,
      durationSeconds: 60.0,
      elapsedMs: 15,
      outputPath: 'preview_me_ducked.wav',
      success: true,
    };
  }

  /**
   * Быстрый расчет точек огибающей для отрисовки кривой даккинга в UI таймлайна
   */
  public async calculateEnvelopePreview(
    voiceRanges: VoiceTimeRange[],
    config: Partial<DuckingConfig> = {},
    totalDurationSec: number,
    pointsCount = 1000
  ): Promise<number[]> {
    const fullConfig: DuckingConfig = {
      attenuationDb: config.attenuationDb ?? -16.0,
      lookaheadMs: config.lookaheadMs ?? 50.0,
      attackMs: config.attackMs ?? 80.0,
      holdMs: config.holdMs ?? 150.0,
      releaseMs: config.releaseMs ?? 300.0,
      curveType: config.curveType ?? 'sCurve',
    };

    if (this.isTauriAvailable()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<number[]>('calculate_ducking_envelope_preview', {
          voiceRanges,
          config: fullConfig,
          totalDurationSec,
          pointsCount,
        });
      } catch (err) {
        console.warn('[DuckingService] Ошибка вычисления точек превью огибающей:', err);
      }
    }

    // Fallback браузерной генерации точек
    return this.fallbackEnvelopeCalculation(voiceRanges, fullConfig, totalDurationSec, pointsCount);
  }

  private fallbackEnvelopeCalculation(
    voiceRanges: VoiceTimeRange[],
    config: DuckingConfig,
    totalDurationSec: number,
    pointsCount: number
  ): number[] {
    const points: number[] = new Array(pointsCount).fill(1.0);
    const targetGain = Math.pow(10, config.attenuationDb / 20);
    const lookaheadSec = config.lookaheadMs / 1000;
    const attackSec = config.attackMs / 1000;
    const holdSec = config.holdMs / 1000;
    const releaseSec = config.releaseMs / 1000;

    for (let i = 0; i < pointsCount; i++) {
      const t = (i / pointsCount) * totalDurationSec;
      let minGain = 1.0;

      for (const cue of voiceRanges) {
        const attackEnd = Math.max(0, cue.startSec - lookaheadSec);
        const attackStart = Math.max(0, attackEnd - attackSec);
        const holdEnd = cue.endSec + holdSec;
        const releaseEnd = holdEnd + releaseSec;

        if (t < attackStart || t > releaseEnd) continue;

        let g = 1.0;
        if (t < attackEnd) {
          const progress = (t - attackStart) / Math.max(0.001, attackEnd - attackStart);
          const s = 0.5 * (1 + Math.cos(Math.PI * progress));
          g = targetGain + (1 - targetGain) * s;
        } else if (t <= holdEnd) {
          g = targetGain;
        } else {
          const progress = (t - holdEnd) / Math.max(0.001, releaseEnd - holdEnd);
          const s = 0.5 * (1 - Math.cos(Math.PI * progress));
          g = targetGain + (1 - targetGain) * s;
        }

        if (g < minGain) minGain = g;
      }

      points[i] = minGain;
    }

    return points;
  }
}

export const duckingService = new DuckingService();
export default duckingService;
