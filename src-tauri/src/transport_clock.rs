// ============================================================================
// DUB MIXING STUDIO PRO - MASTER TRANSPORT CLOCK (RUST)
// Аппаратный генератор мастер-времени DAW с суб-миллисекундной точностью
// Источник правды: аппаратный CPAL аудио-буфер (current_sample: AtomicU64)
// Вывод в UI: 60 Гц Tick Thread со защитой от переполнения Event Loop
// ============================================================================

#![allow(dead_code)]

use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::audio_engine::AudioState;
use crate::logger::log_info;

// ============================================================================
// 1. DATA STRUCTURES & SNAPSHOTS
// ============================================================================

/// Снимок состояния мастер-часов для передачи в UI (60 FPS)
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportSnapshot {
    /// Номер текущего воспроизведенного сэмпла
    pub sample: u64,
    /// Текущее время в миллисекундах (дробное, суб-сэмпловая точность)
    pub time_ms: f64,
    /// Текущее время в секундах
    pub time_sec: f64,
    /// Флаг воспроизведения
    pub is_playing: bool,
    /// Флаг записи
    pub is_recording: bool,
    /// Включен ли режим зацикливания (Loop)
    pub is_looping: bool,
    /// Начальный сэмпл петли
    pub loop_start_sample: u64,
    /// Конечный сэмпл петли
    pub loop_end_sample: u64,
    /// Идет ли отсчет предзаписи (Pre-roll Countdown)
    pub is_preroll: bool,
    /// Оставшееся время предзаписи в миллисекундах
    pub preroll_remaining_ms: f64,
    /// Текущая частота дискретизации аудиоустройства
    pub sample_rate: u32,
    /// Темп метронома (BPM)
    pub bpm: u32,
}

impl Default for TransportSnapshot {
    fn default() -> Self {
        Self {
            sample: 0,
            time_ms: 0.0,
            time_sec: 0.0,
            is_playing: false,
            is_recording: false,
            is_looping: false,
            loop_start_sample: 0,
            loop_end_sample: 0,
            is_preroll: false,
            preroll_remaining_ms: 0.0,
            sample_rate: 48000,
            bpm: 120,
        }
    }
}

// ============================================================================
// 2. CENTRAL TRANSPORT CLOCK
// ============================================================================

pub struct TransportClock {
    /// Точный счетчик фактически воспроизведенных сэмплов (источник правды)
    pub current_sample: Arc<AtomicU64>,
    /// Флаг активности воспроизведения
    pub is_playing: Arc<AtomicBool>,
    /// Флаг активности записи
    pub is_recording: Arc<AtomicBool>,
    /// Частота дискретизации аудио-выхода (CPAL)
    pub sample_rate: Arc<AtomicU32>,

    /// Состояние петли (Looping)
    pub is_looping: Arc<AtomicBool>,
    pub loop_start_sample: Arc<AtomicU64>,
    pub loop_end_sample: Arc<AtomicU64>,

    /// Состояние предзаписи (Pre-roll Countdown)
    pub is_preroll: Arc<AtomicBool>,
    pub preroll_samples_total: Arc<AtomicU64>,
    pub preroll_samples_elapsed: Arc<AtomicU64>,
    pub preroll_bpm: Arc<AtomicU32>,
    pub preroll_target_sample: Arc<AtomicU64>,
    pub preroll_record_on_finish: Arc<AtomicBool>,

    /// Флаг ожидания подтверждения от UI (защита от спама очереди Event Loop)
    pub ui_pending_ack: Arc<AtomicBool>,

    /// Lock-free почтовый ящик емкостью 1: новый снимок перезаписывает старый
    snapshot_tx: Sender<TransportSnapshot>,
    snapshot_rx: Receiver<TransportSnapshot>,

    /// Управление рабочим потоком генератора тиков 60 Гц
    pub tick_worker_active: Arc<AtomicBool>,
}

impl TransportClock {
    pub fn new(initial_sample_rate: u32) -> Self {
        let (tx, rx) = bounded(1);
        Self {
            current_sample: Arc::new(AtomicU64::new(0)),
            is_playing: Arc::new(AtomicBool::new(false)),
            is_recording: Arc::new(AtomicBool::new(false)),
            sample_rate: Arc::new(AtomicU32::new(initial_sample_rate.max(8000))),

            is_looping: Arc::new(AtomicBool::new(false)),
            loop_start_sample: Arc::new(AtomicU64::new(0)),
            loop_end_sample: Arc::new(AtomicU64::new(0)),

            is_preroll: Arc::new(AtomicBool::new(false)),
            preroll_samples_total: Arc::new(AtomicU64::new(0)),
            preroll_samples_elapsed: Arc::new(AtomicU64::new(0)),
            preroll_bpm: Arc::new(AtomicU32::new(120)),
            preroll_target_sample: Arc::new(AtomicU64::new(0)),
            preroll_record_on_finish: Arc::new(AtomicBool::new(true)),

            ui_pending_ack: Arc::new(AtomicBool::new(false)),

            snapshot_tx: tx,
            snapshot_rx: rx,

            tick_worker_active: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Конвертация семплов в миллисекунды с суб-миллисекундной точностью
    #[inline]
    pub fn sample_to_ms(&self, sample: u64) -> f64 {
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        (sample as f64 * 1000.0) / sr
    }

    /// Конвертация миллисекунд в сэмплы
    #[inline]
    pub fn ms_to_sample(&self, ms: f64) -> u64 {
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        ((ms.max(0.0) * sr) / 1000.0).round() as u64
    }

    /// Получение мгновенного снимка мастер-времени
    pub fn get_snapshot(&self) -> TransportSnapshot {
        let sample = self.current_sample.load(Ordering::Relaxed);
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1);
        let time_ms = (sample as f64 * 1000.0) / sr as f64;
        let time_sec = time_ms / 1000.0;

        let is_playing = self.is_playing.load(Ordering::Relaxed);
        let is_recording = self.is_recording.load(Ordering::Relaxed);
        let is_looping = self.is_looping.load(Ordering::Relaxed);
        let loop_start_sample = self.loop_start_sample.load(Ordering::Relaxed);
        let loop_end_sample = self.loop_end_sample.load(Ordering::Relaxed);

        let is_preroll = self.is_preroll.load(Ordering::Relaxed);
        let preroll_remaining_ms = if is_preroll {
            let total = self.preroll_samples_total.load(Ordering::Relaxed);
            let elapsed = self.preroll_samples_elapsed.load(Ordering::Relaxed);
            let remaining_samples = total.saturating_sub(elapsed);
            (remaining_samples as f64 * 1000.0) / sr as f64
        } else {
            0.0
        };

        let bpm = self.preroll_bpm.load(Ordering::Relaxed);

        TransportSnapshot {
            sample,
            time_ms,
            time_sec,
            is_playing,
            is_recording,
            is_looping,
            loop_start_sample,
            loop_end_sample,
            is_preroll,
            preroll_remaining_ms,
            sample_rate: sr,
            bpm,
        }
    }

    /// Публикация нового снимка в lock-free канал без блокировок аудио-потока
    #[inline]
    pub fn publish_snapshot(&self) {
        let snapshot = self.get_snapshot();
        // Перезаписываем старый снимок, если предыдущий еще не был вычитан
        if self.snapshot_tx.try_send(snapshot).is_err() {
            let _ = self.snapshot_rx.try_recv();
            let _ = self.snapshot_tx.try_send(snapshot);
        }
    }

    /// Команда Play
    pub fn play(&self) {
        self.is_preroll.store(false, Ordering::SeqCst);
        self.is_playing.store(true, Ordering::SeqCst);
        self.publish_snapshot();
    }

    /// Команда Pause
    pub fn pause(&self) {
        self.is_playing.store(false, Ordering::SeqCst);
        self.is_recording.store(false, Ordering::SeqCst);
        self.is_preroll.store(false, Ordering::SeqCst);
        self.publish_snapshot();
    }

    /// Команда Seek на указанный сэмпл
    pub fn seek(&self, target_sample: u64) {
        self.current_sample.store(target_sample, Ordering::SeqCst);
        self.publish_snapshot();
    }

    /// Установка диапазона петли (Loop)
    pub fn set_loop(&self, start_sample: u64, end_sample: u64, enabled: bool) {
        let (start, end) = if start_sample <= end_sample {
            (start_sample, end_sample)
        } else {
            (end_sample, start_sample)
        };
        self.loop_start_sample.store(start, Ordering::SeqCst);
        self.loop_end_sample.store(end, Ordering::SeqCst);
        self.is_looping.store(enabled, Ordering::SeqCst);
        self.publish_snapshot();
    }

    /// Сброс петли
    pub fn clear_loop(&self) {
        self.is_looping.store(false, Ordering::SeqCst);
        self.publish_snapshot();
    }

    /// Запуск режима предзаписи с метрономом (Pre-roll Countdown)
    pub fn start_preroll(
        &self,
        countdown_ms: u64,
        bpm: u32,
        target_sample: u64,
        record_on_finish: bool,
    ) {
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        let total_samples = ((countdown_ms.max(500) as f64 * sr) / 1000.0).round() as u64;

        self.preroll_samples_total.store(total_samples, Ordering::SeqCst);
        self.preroll_samples_elapsed.store(0, Ordering::SeqCst);
        self.preroll_bpm.store(bpm.clamp(30, 300), Ordering::SeqCst);
        self.preroll_target_sample.store(target_sample, Ordering::SeqCst);
        self.preroll_record_on_finish.store(record_on_finish, Ordering::SeqCst);

        // Устанавливаем позицию таймлайна в точку врезки
        self.current_sample.store(target_sample, Ordering::SeqCst);

        self.is_preroll.store(true, Ordering::SeqCst);
        self.is_playing.store(true, Ordering::SeqCst);
        self.is_recording.store(false, Ordering::SeqCst);

        self.publish_snapshot();
    }

    /// Принудительная остановка предзаписи
    pub fn stop_preroll(&self) {
        self.is_preroll.store(false, Ordering::SeqCst);
        self.publish_snapshot();
    }

    /// Синтез метронома в аудио-буфер во время предзаписи (вызывается из CPAL коллбэка)
    pub fn synthesize_metronome(
        &self,
        buffer: &mut [f32],
        channels: usize,
        sample_rate: u32,
        num_frames: usize,
    ) {
        if !self.is_preroll.load(Ordering::Relaxed) {
            return;
        }

        let elapsed = self.preroll_samples_elapsed.load(Ordering::Relaxed);
        let bpm = self.preroll_bpm.load(Ordering::Relaxed).max(20) as f64;
        let samples_per_beat = ((sample_rate as f64 * 60.0) / bpm) as u64;
        let click_duration = (sample_rate as f64 * 0.035) as u64; // 35 мс клик

        for f in 0..num_frames {
            let sample_idx = elapsed + f as u64;
            let pos_in_beat = sample_idx % samples_per_beat;
            let beat_num = sample_idx / samples_per_beat;

            if pos_in_beat < click_duration {
                let freq = if beat_num % 4 == 0 { 1200.0f32 } else { 800.0f32 };
                let t = pos_in_beat as f32 / sample_rate as f32;
                let decay = (-8.0 * (pos_in_beat as f32 / click_duration as f32)).exp();
                let click_val = 0.35 * (2.0 * PI * freq * t).sin() * decay;

                let out_idx = f * channels;
                buffer[out_idx] += click_val;
                if channels >= 2 {
                    buffer[out_idx + 1] += click_val;
                }
            }
        }
    }

    /// Продвижение аппаратных сэмплов из аудио-коллбэка CPAL
    pub fn advance_samples(&self, num_frames: usize) {
        // 1. Проверка режима предзаписи (Pre-roll)
        if self.is_preroll.load(Ordering::Relaxed) {
            let prev_elapsed = self.preroll_samples_elapsed.fetch_add(num_frames as u64, Ordering::SeqCst);
            let total = self.preroll_samples_total.load(Ordering::Relaxed);

            if prev_elapsed + num_frames as u64 >= total {
                // Предзапись окончена: автоматически включаем запись/воспроизведение
                self.is_preroll.store(false, Ordering::SeqCst);
                let record_finish = self.preroll_record_on_finish.load(Ordering::Relaxed);
                if record_finish {
                    self.is_recording.store(true, Ordering::SeqCst);
                }
                self.is_playing.store(true, Ordering::SeqCst);
                self.publish_snapshot();
                return;
            }
            self.publish_snapshot();
            return;
        }

        // 2. Если воспроизведение активно: инкрементируем счетчик сэмплов с учетом петли
        if self.is_playing.load(Ordering::Relaxed) {
            if self.is_looping.load(Ordering::Relaxed) {
                let loop_start = self.loop_start_sample.load(Ordering::Relaxed);
                let loop_end = self.loop_end_sample.load(Ordering::Relaxed);

                if loop_end > loop_start {
                    let cur = self.current_sample.load(Ordering::Relaxed);
                    if cur + num_frames as u64 >= loop_end {
                        let overshoot = (cur + num_frames as u64).saturating_sub(loop_end);
                        let loop_len = (loop_end - loop_start).max(1);
                        let wrapped = loop_start + (overshoot % loop_len);
                        self.current_sample.store(wrapped, Ordering::SeqCst);
                        self.publish_snapshot();
                        return;
                    }
                }
            }

            self.current_sample.fetch_add(num_frames as u64, Ordering::Relaxed);
            self.publish_snapshot();
        }
    }
}

// ============================================================================
// 3. 60 HZ TICK THREAD С ЗАЩИТОЙ ОТ ПЕРЕПОЛНЕНИЯ EVENT LOOP
// ============================================================================

/// Запуск выделенного 60 Гц потока генерации тиков мастер-времени
pub fn start_tick_worker(clock: Arc<TransportClock>, app_handle: AppHandle) {
    if clock.tick_worker_active.swap(true, Ordering::SeqCst) {
        // Поток уже запущен
        return;
    }

    std::thread::Builder::new()
        .name("transport-tick-master".to_string())
        .spawn(move || {
            log_info("Transport Master Clock Tick Thread active (60 Hz)");
            let target_interval = Duration::from_micros(16_666); // ~60.0 fps
            let mut last_emitted_sample = u64::MAX;
            let mut last_emitted_state = (false, false, false);
            let mut dropped_acks = 0u32;

            while clock.tick_worker_active.load(Ordering::Relaxed) {
                let loop_start = Instant::now();

                // Извлекаем самый свежий снимок из lock-free ячейки
                let mut snapshot = clock.get_snapshot();
                while let Ok(newer) = clock.snapshot_rx.try_recv() {
                    snapshot = newer;
                }

                let is_active = snapshot.is_playing || snapshot.is_recording || snapshot.is_preroll;
                let current_state = (snapshot.is_playing, snapshot.is_recording, snapshot.is_preroll);

                // Защита от спама Event Loop:
                // Если UI еще не вызвал transport_ui_ack (занят рендерингом),
                // мы не забиваем IPC очередь дубликатами. Снимок перезаписан в памяти.
                let ui_busy = clock.ui_pending_ack.load(Ordering::Relaxed);
                if ui_busy && dropped_acks < 3 {
                    dropped_acks += 1;
                } else {
                    // Разрешаем отправку следующего тика
                    clock.ui_pending_ack.store(true, Ordering::Relaxed);
                    dropped_acks = 0;

                    // Шлем событие только при активности воспроизведения/записи/предзаписи
                    // либо при смене позиции или состояния
                    if is_active || snapshot.sample != last_emitted_sample || current_state != last_emitted_state {
                        let _ = app_handle.emit("transport-tick", &snapshot);
                        last_emitted_sample = snapshot.sample;
                        last_emitted_state = current_state;
                    }
                }

                let elapsed = loop_start.elapsed();
                if elapsed < target_interval {
                    std::thread::sleep(target_interval - elapsed);
                }
            }

            log_info("Transport Master Clock Tick Thread terminated");
        })
        .expect("Failed to spawn transport-tick-master thread");
}

// ============================================================================
// 4. TAURI COMMANDS
// ============================================================================

#[tauri::command]
pub async fn transport_play(
    state: State<'_, AudioState>,
) -> Result<TransportSnapshot, String> {
    {
        let mut player = state.player.lock().map_err(|e| e.to_string())?;
        player.ensure_stream()?;
    }
    state.clock.play();
    Ok(state.clock.get_snapshot())
}

#[tauri::command]
pub async fn transport_pause(
    state: State<'_, AudioState>,
) -> Result<TransportSnapshot, String> {
    state.clock.pause();
    Ok(state.clock.get_snapshot())
}

#[tauri::command]
pub async fn transport_seek(
    state: State<'_, AudioState>,
    target_sample: u64,
) -> Result<TransportSnapshot, String> {
    state.clock.seek(target_sample);
    Ok(state.clock.get_snapshot())
}

#[tauri::command]
pub async fn transport_seek_ms(
    state: State<'_, AudioState>,
    target_ms: f64,
) -> Result<TransportSnapshot, String> {
    let sample = state.clock.ms_to_sample(target_ms);
    state.clock.seek(sample);
    Ok(state.clock.get_snapshot())
}

#[tauri::command]
pub async fn transport_set_loop(
    state: State<'_, AudioState>,
    start_sample: u64,
    end_sample: u64,
    enabled: bool,
) -> Result<TransportSnapshot, String> {
    state.clock.set_loop(start_sample, end_sample, enabled);
    Ok(state.clock.get_snapshot())
}

#[tauri::command]
pub async fn transport_clear_loop(
    state: State<'_, AudioState>,
) -> Result<TransportSnapshot, String> {
    state.clock.clear_loop();
    Ok(state.clock.get_snapshot())
}

#[tauri::command]
pub async fn transport_start_preroll(
    state: State<'_, AudioState>,
    countdown_ms: Option<u64>,
    bpm: Option<u32>,
    target_sample: Option<u64>,
    record_on_finish: Option<bool>,
) -> Result<TransportSnapshot, String> {
    {
        let mut player = state.player.lock().map_err(|e| e.to_string())?;
        player.ensure_stream()?;
    }
    let target = target_sample.unwrap_or_else(|| state.clock.current_sample.load(Ordering::Relaxed));
    state.clock.start_preroll(
        countdown_ms.unwrap_or(3000),
        bpm.unwrap_or(120),
        target,
        record_on_finish.unwrap_or(true),
    );
    Ok(state.clock.get_snapshot())
}

#[tauri::command]
pub async fn transport_stop_preroll(
    state: State<'_, AudioState>,
) -> Result<TransportSnapshot, String> {
    state.clock.stop_preroll();
    Ok(state.clock.get_snapshot())
}

#[tauri::command]
pub async fn transport_get_snapshot(
    state: State<'_, AudioState>,
) -> Result<TransportSnapshot, String> {
    Ok(state.clock.get_snapshot())
}

#[tauri::command]
pub async fn transport_ui_ack(
    state: State<'_, AudioState>,
) -> Result<(), String> {
    state.clock.ui_pending_ack.store(false, Ordering::Relaxed);
    Ok(())
}
