// ============================================================================
// DUB MIXING STUDIO PRO - MASTER TRANSPORT CLOCK HOOK (FRONTEND)
// Централизованный аппаратный генератор мастер-времени (Transport Clock Master)
// Источник правды: аппаратный CPAL аудио-буфер на Rust (< 0.02 мс джиттер)
// ============================================================================

import { useState, useEffect, useRef, useCallback, type RefObject } from 'react';

export interface TransportSnapshot {
  sample: number;
  timeMs: number;
  timeSec: number;
  isPlaying: boolean;
  isRecording: boolean;
  isLooping: boolean;
  loopStartSample: number;
  loopEndSample: number;
  isPreroll: boolean;
  prerollRemainingMs: number;
  sampleRate: number;
  bpm: number;
}

export interface UseTransportMasterOptions {
  /** Опциональная ссылка на HTMLVideoElement для жесткой аппаратной синхронизации */
  videoRef?: RefObject<HTMLVideoElement | null>;
  /** Опциональная ссылка на HTMLAudioElement для референсного аудио */
  referenceAudioRef?: RefObject<HTMLAudioElement | null>;
  /** Высокоскоростной коллбэк для 60 FPS отрисовки курсора таймлайна без ре-рендеров React */
  onTick?: (snapshot: TransportSnapshot) => void;
  /** Порог рассинхронизации видеоплеера с аппаратным аудио в секундах (по умолчанию 0.035 = 35 мс) */
  videoSyncThresholdSec?: number;
}

const DEFAULT_SNAPSHOT: TransportSnapshot = {
  sample: 0,
  timeMs: 0,
  timeSec: 0,
  isPlaying: false,
  isRecording: false,
  isLooping: false,
  loopStartSample: 0,
  loopEndSample: 0,
  isPreroll: false,
  prerollRemainingMs: 0,
  sampleRate: 48000,
  bpm: 120,
};

function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as any).__TAURI_INTERNALS__);
}

async function invokeTauri<T>(cmd: string, args?: Record<string, any>): Promise<T | null> {
  if (!isTauriEnvironment()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`[TransportClock] invoke ${cmd} error:`, err);
    return null;
  }
}

export function useTransportMaster(options: UseTransportMasterOptions = {}) {
  const {
    videoRef,
    referenceAudioRef,
    onTick,
    videoSyncThresholdSec = 0.035,
  } = options;

  const [snapshot, setSnapshot] = useState<TransportSnapshot>(DEFAULT_SNAPSHOT);
  const snapshotRef = useRef<TransportSnapshot>(DEFAULT_SNAPSHOT);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const lastAckTimeRef = useRef<number>(0);
  const lastStateRenderTimeRef = useRef<number>(0);

  // 1. Подписка на нативное аппаратное событие transport-tick (60 Гц)
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let isMounted = true;

    async function subscribe() {
      if (!isTauriEnvironment()) {
        return;
      }

      try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen<TransportSnapshot>('transport-tick', (event) => {
          if (!isMounted) return;

          const snap = event.payload;
          snapshotRef.current = snap;

          // Быстрый синхронный вызов коллбэка без ожидания React batching
          if (onTickRef.current) {
            onTickRef.current(snap);
          }

          // Аппаратная синхронизация видеоплеера с точностью до 35 мс
          if (videoRef?.current && snap.isPlaying && !videoRef.current.seeking) {
            const vid = videoRef.current;
            const drift = Math.abs(vid.currentTime - snap.timeSec);
            if (drift > videoSyncThresholdSec) {
              vid.currentTime = snap.timeSec;
            }
            if (vid.paused) {
              vid.play().catch(() => {});
            }
          } else if (videoRef?.current && !snap.isPlaying && !videoRef.current.paused) {
            videoRef.current.pause();
          }

          // Синхронизация референсного аудио
          if (referenceAudioRef?.current && snap.isPlaying) {
            const refAudio = referenceAudioRef.current;
            const drift = Math.abs(refAudio.currentTime - snap.timeSec);
            if (drift > videoSyncThresholdSec) {
              refAudio.currentTime = snap.timeSec;
            }
            if (refAudio.paused) {
              refAudio.play().catch(() => {});
            }
          } else if (referenceAudioRef?.current && !snap.isPlaying && !referenceAudioRef.current.paused) {
            referenceAudioRef.current.pause();
          }

          // Подтверждение получения тика для Rust tick thread (throttled ~30ms)
          const now = performance.now();
          if (now - lastAckTimeRef.current >= 30) {
            lastAckTimeRef.current = now;
            invokeTauri('transport_ui_ack').catch(() => {});
          }

          // Оптимизированный рендеринг React-состояния (~30-40 fps) для снижения нагрузки на DOM
          if (now - lastStateRenderTimeRef.current >= 25 || !snap.isPlaying) {
            lastStateRenderTimeRef.current = now;
            setSnapshot(snap);
          }
        });

        unlistenFn = unlisten;
      } catch (err) {
        console.warn('[TransportMaster] Failed to subscribe to transport-tick:', err);
      }
    }

    subscribe();

    // Первоначальный запрос текущего снимка
    invokeTauri<TransportSnapshot>('transport_get_snapshot').then((res) => {
      if (res && isMounted) {
        snapshotRef.current = res;
        setSnapshot(res);
      }
    });

    return () => {
      isMounted = false;
      if (unlistenFn) unlistenFn();
    };
  }, [videoRef, referenceAudioRef, videoSyncThresholdSec]);

  // 2. Транспортные команды Tauri

  /** Запуск аппаратного воспроизведения */
  const play = useCallback(async () => {
    const snap = await invokeTauri<TransportSnapshot>('transport_play');
    if (snap) {
      snapshotRef.current = snap;
      setSnapshot(snap);
    }
  }, []);

  /** Приостановка воспроизведения */
  const pause = useCallback(async () => {
    const snap = await invokeTauri<TransportSnapshot>('transport_pause');
    if (snap) {
      snapshotRef.current = snap;
      setSnapshot(snap);
    }
    if (videoRef?.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
    if (referenceAudioRef?.current && !referenceAudioRef.current.paused) {
      referenceAudioRef.current.pause();
    }
  }, [videoRef, referenceAudioRef]);

  /** Точный переход по номеру аппаратного сэмпла */
  const seekSample = useCallback(async (sample: number) => {
    const snap = await invokeTauri<TransportSnapshot>('transport_seek', { targetSample: Math.max(0, Math.round(sample)) });
    if (snap) {
      snapshotRef.current = snap;
      setSnapshot(snap);
      if (videoRef?.current) {
        videoRef.current.currentTime = snap.timeSec;
      }
      if (referenceAudioRef?.current) {
        referenceAudioRef.current.currentTime = snap.timeSec;
      }
    }
  }, [videoRef, referenceAudioRef]);

  /** Точный переход по времени в секундах */
  const seekSec = useCallback(async (timeSec: number) => {
    const snap = await invokeTauri<TransportSnapshot>('transport_seek_ms', { targetMs: Math.max(0, timeSec * 1000) });
    if (snap) {
      snapshotRef.current = snap;
      setSnapshot(snap);
      if (videoRef?.current) {
        videoRef.current.currentTime = snap.timeSec;
      }
      if (referenceAudioRef?.current) {
        referenceAudioRef.current.currentTime = snap.timeSec;
      }
    }
  }, [videoRef, referenceAudioRef]);

  /** Установка диапазона зацикливания (Loop) */
  const setLoopRange = useCallback(async (startSec: number, endSec: number, enabled: boolean = true) => {
    const sr = snapshotRef.current.sampleRate || 48000;
    const startSample = Math.round(Math.max(0, startSec) * sr);
    const endSample = Math.round(Math.max(0, endSec) * sr);

    const snap = await invokeTauri<TransportSnapshot>('transport_set_loop', {
      startSample,
      endSample,
      enabled,
    });
    if (snap) {
      snapshotRef.current = snap;
      setSnapshot(snap);
    }
  }, []);

  /** Сброс режима зацикливания */
  const clearLoop = useCallback(async () => {
    const snap = await invokeTauri<TransportSnapshot>('transport_clear_loop');
    if (snap) {
      snapshotRef.current = snap;
      setSnapshot(snap);
    }
  }, []);

  /**
   * Запуск режима предзаписи (Pre-roll Countdown) с метрономом на Rust
   * перед стартом записи
   */
  const startPreRoll = useCallback(async (opts?: {
    countdownMs?: number;
    bpm?: number;
    targetSec?: number;
    recordOnFinish?: boolean;
  }) => {
    const sr = snapshotRef.current.sampleRate || 48000;
    const targetSample = opts?.targetSec !== undefined
      ? Math.round(Math.max(0, opts.targetSec) * sr)
      : snapshotRef.current.sample;

    const snap = await invokeTauri<TransportSnapshot>('transport_start_preroll', {
      countdownMs: opts?.countdownMs ?? 3000,
      bpm: opts?.bpm ?? 120,
      targetSample,
      recordOnFinish: opts?.recordOnFinish ?? true,
    });

    if (snap) {
      snapshotRef.current = snap;
      setSnapshot(snap);
    }
  }, []);

  /** Остановка предзаписи */
  const stopPreRoll = useCallback(async () => {
    const snap = await invokeTauri<TransportSnapshot>('transport_stop_preroll');
    if (snap) {
      snapshotRef.current = snap;
      setSnapshot(snap);
    }
  }, []);

  /** Получение мгновенного снимка времени без ожидания рендера */
  const getSnapshot = useCallback((): TransportSnapshot => {
    return snapshotRef.current;
  }, []);

  return {
    snapshot,
    snapshotRef,
    currentTime: snapshot.timeSec,
    currentSample: snapshot.sample,
    isPlaying: snapshot.isPlaying,
    isRecording: snapshot.isRecording,
    isLooping: snapshot.isLooping,
    isPreroll: snapshot.isPreroll,
    prerollRemainingMs: snapshot.prerollRemainingMs,
    sampleRate: snapshot.sampleRate,
    bpm: snapshot.bpm,

    play,
    pause,
    seekSec,
    seekSample,
    setLoopRange,
    clearLoop,
    startPreRoll,
    stopPreRoll,
    getSnapshot,
  };
}
