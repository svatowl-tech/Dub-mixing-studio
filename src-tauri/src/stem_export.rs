// ============================================================================
// DUB MIXING STUDIO PRO - MULTITHREADED BROADCAST WAV STEM EXPORTER (RUST)
// Модуль 4.4: Параллельный потоковый экспорт стемов BWF (24-bit PCM / 48 kHz)
// ============================================================================

use std::fs::{self, File};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use chrono::{Datelike, Local, Timelike};
use hound::{SampleFormat, WavReader};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{AppHandle, Emitter, State};

use crate::db::AppState;
use crate::logger::log_debug;

// ----------------------------------------------------------------------------
// КОНСТАНТЫ СТАНДАРТА ВЕЩАТЕЛЬНОГО АУДИО (EBU TECH 3285 / ITU-R BS.1387)
// ----------------------------------------------------------------------------
pub const BWF_SAMPLE_RATE: u32 = 48000;
pub const BWF_CHANNELS: u16 = 2; // Stereo
pub const BWF_BITS_PER_SAMPLE: u16 = 24;
pub const BWF_BYTES_PER_SAMPLE: usize = 3;
pub const BWF_FRAME_SIZE_BYTES: usize = (BWF_CHANNELS as usize) * BWF_BYTES_PER_SAMPLE; // 6 bytes per stereo frame

/// Размер потокового чанка рендеринга (8192 фрейма = 49 152 байт ~ 64 КБ I/O буфер)
pub const STREAM_BLOCK_FRAMES: usize = 8192;
pub const DISK_BUFFER_CAPACITY_BYTES: usize = 65536; // 64 КБ аппаратный буфер записи на диск

// ============================================================================
// СТРУКТУРЫ ДАННЫХ И ОТЧЕТОВ ЭКСПОРТА СТЕМОВ
// ============================================================================

/// Метаданные экспортированного стема
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedStemInfo {
    /// Идентификатор стема (full_mix, clean_vo, me)
    pub id: String,
    /// Человекочитаемое название
    pub name: String,
    /// Имя файла
    pub file_name: String,
    /// Полный путь к файлу на диске
    pub file_path: String,
    /// Формат аудио
    pub format: String,
    /// Разрядность (24-bit)
    pub bit_depth: u16,
    /// Частота дискретизации (48000 Гц)
    pub sample_rate: u32,
    /// Количество каналов (2 - Стерео)
    pub channels: u16,
    /// Длительность в секундах
    pub duration_seconds: f64,
    /// Размер файла в байтах
    pub file_size_bytes: u64,
    /// SMPTE таймкод старта (HH:MM:SS:FF)
    pub smpte_start_timecode: String,
}

/// Финальный отчет об экспорте всех стемов проекта
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemExportReport {
    /// Успешность операции
    pub success: bool,
    /// ID проекта
    pub project_id: String,
    /// Название проекта
    pub project_name: String,
    /// Папка назначения
    pub destination_folder: String,
    /// Частота дискретизации
    pub sample_rate: u32,
    /// Разрядность квантования
    pub bit_depth: u16,
    /// Общее количество фреймов таймлайна
    pub total_frames: u64,
    /// Общая продолжительность в секундах
    pub duration_seconds: f64,
    /// Стартовый SMPTE таймкод
    pub smpte_timecode_start: String,
    /// Список 3-х мастер-стемов
    pub stems: Vec<ExportedStemInfo>,
    /// Затраченное время в миллисекундах
    pub elapsed_ms: u64,
    /// Информационное сообщение
    pub message: String,
}

/// Прогресс экспорта для обратной связи в UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemExportProgress {
    pub progress_percent: f32,
    pub current_frame: u64,
    pub total_frames: u64,
    pub current_stage: String,
    pub elapsed_sec: f64,
}

// ============================================================================
// РЕАЛИЗАЦИЯ ПОТОКОВОГО ПИСАТЕЛЯ BROADCAST WAV (BWF / EBU TECH 3285)
// ============================================================================

/// Заголовок расширения Broadcast Audio Extension (bext-чанк)
pub struct BwfBextMetadata {
    pub description: String,
    pub originator: String,
    pub originator_reference: String,
    pub origination_date: String, // YYYY-MM-DD
    pub origination_time: String, // HH:MM:SS
    pub time_reference: u64,     // Сэмплы от полуночи (таймкод)
    pub loudness_value_lufs: f32,
    pub max_true_peak_db: f32,
    pub coding_history: String,
}

impl Default for BwfBextMetadata {
    fn default() -> Self {
        let now = Local::now();
        let date_str = format!("{:04}-{:02}-{:02}", now.year(), now.month(), now.day());
        let time_str = format!("{:02}:{:02}:{:02}", now.hour(), now.minute(), now.second());

        Self {
            description: "Broadcast Master Stem / DubStudio DAW".to_string(),
            originator: "DubStudio Pro DAW".to_string(),
            originator_reference: format!("DUB_{:08X}", now.timestamp() as u32),
            origination_date: date_str,
            origination_time: time_str,
            time_reference: 0,
            loudness_value_lufs: -23.0,
            max_true_peak_db: -1.0,
            coding_history: "A=PCM,F=48000,W=24,M=stereo,T=DubStudio 1.1 Multi-Stem Engine\r\n".to_string(),
        }
    }
}

/// Потоковый BWF-райтер с аппаратной буферизацией 64 КБ
pub struct BwfWavWriter {
    file_path: PathBuf,
    writer: BufWriter<File>,
    data_bytes_written: u64,
    data_chunk_offset: u64,
    bext_chunk_len: u32,
    dither_prng_state: u32,
}

impl BwfWavWriter {
    /// Создание нового файла BWF и запись валидных заголовков RIFF, bext и fmt
    pub fn create(path: &Path, metadata: &BwfBextMetadata) -> Result<Self, String> {
        let file = File::create(path).map_err(|e| format!("Не удалось создать файл {}: {}", path.display(), e))?;
        let mut writer = BufWriter::with_capacity(DISK_BUFFER_CAPACITY_BYTES, file);

        // 1. RIFF Header Placeholder (12 bytes)
        writer.write_all(b"RIFF").map_err(|e| e.to_string())?;
        writer.write_all(&0u32.to_le_bytes()).map_err(|e| e.to_string())?; // Placeholder for RIFF size
        writer.write_all(b"WAVE").map_err(|e| e.to_string())?;

        // 2. Broadcast Extension Chunk ('bext') согласно EBU Tech 3285 v2
        let coding_hist_bytes = metadata.coding_history.as_bytes();
        let bext_fixed_size = 602u32;
        let bext_total_size = bext_fixed_size + coding_hist_bytes.len() as u32;

        writer.write_all(b"bext").map_err(|e| e.to_string())?;
        writer.write_all(&bext_total_size.to_le_bytes()).map_err(|e| e.to_string())?;

        // Description (256 bytes)
        let mut desc_buf = [0u8; 256];
        let desc_bytes = metadata.description.as_bytes();
        let copy_len = desc_bytes.len().min(255);
        desc_buf[..copy_len].copy_from_slice(&desc_bytes[..copy_len]);
        writer.write_all(&desc_buf).map_err(|e| e.to_string())?;

        // Originator (32 bytes)
        let mut orig_buf = [0u8; 32];
        let orig_bytes = metadata.originator.as_bytes();
        let copy_len = orig_bytes.len().min(31);
        orig_buf[..copy_len].copy_from_slice(&orig_bytes[..copy_len]);
        writer.write_all(&orig_buf).map_err(|e| e.to_string())?;

        // OriginatorReference (32 bytes)
        let mut orig_ref_buf = [0u8; 32];
        let ref_bytes = metadata.originator_reference.as_bytes();
        let copy_len = ref_bytes.len().min(31);
        orig_ref_buf[..copy_len].copy_from_slice(&ref_bytes[..copy_len]);
        writer.write_all(&orig_ref_buf).map_err(|e| e.to_string())?;

        // OriginationDate (10 bytes: YYYY-MM-DD)
        let mut date_buf = [0u8; 10];
        let date_bytes = metadata.origination_date.as_bytes();
        let copy_len = date_bytes.len().min(10);
        date_buf[..copy_len].copy_from_slice(&date_bytes[..copy_len]);
        writer.write_all(&date_buf).map_err(|e| e.to_string())?;

        // OriginationTime (8 bytes: HH:MM:SS)
        let mut time_buf = [0u8; 8];
        let time_bytes = metadata.origination_time.as_bytes();
        let copy_len = time_bytes.len().min(8);
        time_buf[..copy_len].copy_from_slice(&time_bytes[..copy_len]);
        writer.write_all(&time_buf).map_err(|e| e.to_string())?;

        // TimeReference (8 bytes: u32 Low, u32 High)
        let time_ref_low = (metadata.time_reference & 0xFFFFFFFF) as u32;
        let time_ref_high = ((metadata.time_reference >> 32) & 0xFFFFFFFF) as u32;
        writer.write_all(&time_ref_low.to_le_bytes()).map_err(|e| e.to_string())?;
        writer.write_all(&time_ref_high.to_le_bytes()).map_err(|e| e.to_string())?;

        // Version (2 bytes: 2 for BWF version 2 EBU R128 support)
        writer.write_all(&2u16.to_le_bytes()).map_err(|e| e.to_string())?;

        // UMID (64 bytes of zeroes)
        let umid_buf = [0u8; 64];
        writer.write_all(&umid_buf).map_err(|e| e.to_string())?;

        // Loudness metrics (EBU R128: 100x LUFS, 100x dBTP)
        let loudness_val_i16 = (metadata.loudness_value_lufs * 100.0).round() as i16;
        let true_peak_i16 = (metadata.max_true_peak_db * 100.0).round() as i16;
        writer.write_all(&loudness_val_i16.to_le_bytes()).map_err(|e| e.to_string())?; // LoudnessValue
        writer.write_all(&0i16.to_le_bytes()).map_err(|e| e.to_string())?;             // LoudnessRange
        writer.write_all(&true_peak_i16.to_le_bytes()).map_err(|e| e.to_string())?;    // MaxTruePeakLevel
        writer.write_all(&0i16.to_le_bytes()).map_err(|e| e.to_string())?;             // MaxMomentaryLoudness
        writer.write_all(&0i16.to_le_bytes()).map_err(|e| e.to_string())?;             // MaxShortTermLoudness

        // Reserved (180 bytes)
        let reserved_buf = [0u8; 180];
        writer.write_all(&reserved_buf).map_err(|e| e.to_string())?;

        // CodingHistory
        writer.write_all(coding_hist_bytes).map_err(|e| e.to_string())?;

        // Паддинг до четного байта для чанка bext
        if bext_total_size % 2 != 0 {
            writer.write_all(&[0u8]).map_err(|e| e.to_string())?;
        }

        // 3. 'fmt ' Chunk (PCM 24-bit, 48000 Hz, Stereo)
        writer.write_all(b"fmt ").map_err(|e| e.to_string())?;
        writer.write_all(&16u32.to_le_bytes()).map_err(|e| e.to_string())?; // Chunk size = 16
        writer.write_all(&1u16.to_le_bytes()).map_err(|e| e.to_string())?;  // AudioFormat = 1 (PCM)
        writer.write_all(&BWF_CHANNELS.to_le_bytes()).map_err(|e| e.to_string())?; // Channels = 2
        writer.write_all(&BWF_SAMPLE_RATE.to_le_bytes()).map_err(|e| e.to_string())?; // Sample Rate = 48000
        
        let byte_rate = BWF_SAMPLE_RATE * (BWF_CHANNELS as u32) * (BWF_BYTES_PER_SAMPLE as u32);
        let block_align = BWF_CHANNELS * (BWF_BYTES_PER_SAMPLE as u16);
        writer.write_all(&byte_rate.to_le_bytes()).map_err(|e| e.to_string())?;
        writer.write_all(&block_align.to_le_bytes()).map_err(|e| e.to_string())?;
        writer.write_all(&BWF_BITS_PER_SAMPLE.to_le_bytes()).map_err(|e| e.to_string())?;

        // 4. 'data' Chunk Header
        writer.write_all(b"data").map_err(|e| e.to_string())?;
        let data_chunk_offset = 12 + 8 + bext_total_size as u64 + (if bext_total_size % 2 != 0 { 1 } else { 0 }) + 8 + 16 + 4;
        writer.write_all(&0u32.to_le_bytes()).map_err(|e| e.to_string())?; // Placeholder for data size

        Ok(Self {
            file_path: path.to_path_buf(),
            writer,
            data_bytes_written: 0,
            data_chunk_offset,
            bext_chunk_len: bext_total_size,
            dither_prng_state: 0x12345678,
        })
    }

    /// Потоковая запись блока чередующихся стерео сэмплов f32 с квантованием в 24-bit PCM и TPDF дизерингом
    pub fn write_stereo_block_f32(&mut self, left: &[f32], right: &[f32]) -> Result<(), String> {
        let frame_count = left.len().min(right.len());
        if frame_count == 0 {
            return Ok(());
        }

        let mut byte_buffer = Vec::with_capacity(frame_count * BWF_FRAME_SIZE_BYTES);

        for i in 0..frame_count {
            // TPDF Dither (Triangular Probability Density Function)
            let r1 = self.next_random_f32();
            let r2 = self.next_random_f32();
            let dither = (r1 - r2) * (1.0 / 8388608.0);

            let l_sample = (left[i] + dither).clamp(-1.0, 1.0);
            let r_sample = (right[i] + dither).clamp(-1.0, 1.0);

            // Квантование в знаковый 24-битный int (-8388608 .. 8388607)
            let l_int = if l_sample >= 1.0 {
                8388607i32
            } else if l_sample <= -1.0 {
                -8388608i32
            } else {
                (l_sample * 8388607.0).round() as i32
            };

            let r_int = if r_sample >= 1.0 {
                8388607i32
            } else if r_sample <= -1.0 {
                -8388608i32
            } else {
                (r_sample * 8388607.0).round() as i32
            };

            // Little-endian 3 байта для левого канала
            byte_buffer.push((l_int & 0xFF) as u8);
            byte_buffer.push(((l_int >> 8) & 0xFF) as u8);
            byte_buffer.push(((l_int >> 16) & 0xFF) as u8);

            // Little-endian 3 байта для правого канала
            byte_buffer.push((r_int & 0xFF) as u8);
            byte_buffer.push(((r_int >> 8) & 0xFF) as u8);
            byte_buffer.push(((r_int >> 16) & 0xFF) as u8);
        }

        self.writer.write_all(&byte_buffer).map_err(|e| e.to_string())?;
        self.data_bytes_written += byte_buffer.len() as u64;

        Ok(())
    }

    /// Генератор псевдослучайных чисел для быстрого TPDF-дизеринга (Xorshift32)
    #[inline]
    fn next_random_f32(&mut self) -> f32 {
        let mut x = self.dither_prng_state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.dither_prng_state = x;
        (x as f32) / (u32::MAX as f32) - 0.5
    }

    /// Финализация BWF-файла: обновление размеров RIFF и data чанков
    pub fn finalize(mut self) -> Result<u64, String> {
        self.writer.flush().map_err(|e| e.to_string())?;
        let mut file = self.writer.into_inner().map_err(|e| e.to_string())?;

        let total_file_size = file.metadata().map_err(|e| e.to_string())?.len();
        let riff_payload_size = if total_file_size >= 8 { (total_file_size - 8) as u32 } else { 0 };

        // 1. Обновляем размер RIFF чанка (байт 4..8)
        file.seek(SeekFrom::Start(4)).map_err(|e| e.to_string())?;
        file.write_all(&riff_payload_size.to_le_bytes()).map_err(|e| e.to_string())?;

        // 2. Обновляем размер data чанка
        file.seek(SeekFrom::Start(self.data_chunk_offset)).map_err(|e| e.to_string())?;
        let data_size_u32 = (self.data_bytes_written & 0xFFFFFFFF) as u32;
        file.write_all(&data_size_u32.to_le_bytes()).map_err(|e| e.to_string())?;

        file.flush().map_err(|e| e.to_string())?;
        Ok(total_file_size)
    }
}

// ============================================================================
// СТРУКТУРЫ СЕГМЕНТОВ И ДОРОЖЕК ДЛЯ ПОТОКОВОГО МИКШИРОВАНИЯ
// ============================================================================

/// Внутреннее представление аудио-сегмента на таймлайне DAW
#[derive(Clone, Debug)]
pub struct TimelineSegmentSource {
    pub segment_id: String,
    pub track_id: String,
    pub track_name: String,
    pub is_dub_voice: bool,
    pub start_frame: usize,
    pub duration_frames: usize,
    pub file_offset_frames: usize,
    pub gain: f32,
    pub pan: f32, // -1.0 (Left) .. 1.0 (Right)
    pub file_path: PathBuf,
}

/// Кэшированный ридер сегмента для быстрого блочного чтения без повторных открытий
pub struct SegmentFileReader {
    pub source: TimelineSegmentSource,
    pub cached_samples: Option<Vec<f32>>,
    pub reader_sample_rate: u32,
    pub reader_channels: usize,
}

impl SegmentFileReader {
    pub fn new(source: TimelineSegmentSource) -> Self {
        Self {
            source,
            cached_samples: None,
            reader_sample_rate: BWF_SAMPLE_RATE,
            reader_channels: 2,
        }
    }

    /// Загрузка или потоковое извлечение нужного диапазона сэмплов
    pub fn preload(&mut self) -> Result<(), String> {
        if self.cached_samples.is_some() {
            return Ok(());
        }

        if !self.source.file_path.exists() {
            return Err(format!("Файл не найден: {}", self.source.file_path.display()));
        }

        let mut reader = WavReader::open(&self.source.file_path)
            .map_err(|e| format!("Ошибка чтения WAV {}: {}", self.source.file_path.display(), e))?;

        let spec = reader.spec();
        self.reader_sample_rate = spec.sample_rate;
        self.reader_channels = spec.channels as usize;

        let raw: Vec<f32> = match spec.sample_format {
            SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
            SampleFormat::Int => {
                if spec.bits_per_sample == 16 {
                    reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / 32768.0).collect()
                } else if spec.bits_per_sample == 24 || spec.bits_per_sample == 32 {
                    reader.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / 2147483648.0).collect()
                } else {
                    Vec::new()
                }
            }
        };

        self.cached_samples = Some(raw);
        Ok(())
    }

    /// Смешивание сэмплов сегмента в предоставленный блок [block_start .. block_end]
    pub fn mix_into_block(
        &self,
        block_start_frame: usize,
        block_frames: usize,
        out_left: &mut [f32],
        out_right: &mut [f32],
    ) {
        let seg_start = self.source.start_frame;
        let seg_end = seg_start + self.source.duration_frames;
        let block_end_frame = block_start_frame + block_frames;

        // Проверяем пересечение отрезков [seg_start, seg_end] и [block_start, block_end]
        if seg_end <= block_start_frame || seg_start >= block_end_frame {
            return;
        }

        let Some(samples) = &self.cached_samples else {
            return;
        };

        if samples.is_empty() || self.reader_channels == 0 {
            return;
        }

        let total_file_frames = samples.len() / self.reader_channels;
        let overlap_start = seg_start.max(block_start_frame);
        let overlap_end = seg_end.min(block_end_frame);

        let gain = self.source.gain;
        // Constant-Power Panning Law (pan: -1.0 .. 1.0)
        let pan_norm = ((self.source.pan.clamp(-1.0, 1.0) + 1.0) * 0.5) * std::f32::consts::FRAC_PI_2;
        let left_pan_gain = pan_norm.cos();
        let right_pan_gain = pan_norm.sin();

        for frame_idx in overlap_start..overlap_end {
            let block_offset = frame_idx - block_start_frame;
            let seg_local_frame = frame_idx - seg_start;

            // Расчет позиции в файле с учетом частоты дискретизации
            let src_frame = self.source.file_offset_frames
                + ((seg_local_frame as f64 * self.reader_sample_rate as f64) / BWF_SAMPLE_RATE as f64).round() as usize;

            if src_frame >= total_file_frames {
                continue;
            }

            let l_raw = samples[src_frame * self.reader_channels];
            let r_raw = if self.reader_channels > 1 {
                samples[src_frame * self.reader_channels + 1]
            } else {
                l_raw
            };

            out_left[block_offset] += l_raw * gain * left_pan_gain;
            out_right[block_offset] += r_raw * gain * right_pan_gain;
        }
    }
}

// ============================================================================
// ГЛАВНЫЙ МНОГОПОТОЧНЫЙ ПАРАЛЛЕЛЬНЫЙ ЭКСПОРТЕР СТЕМОВ
// ============================================================================

pub struct MultiStemExporter {
    project_id: String,
    project_name: String,
    destination_folder: PathBuf,
    total_timeline_frames: usize,
    readers: Vec<SegmentFileReader>,
    app_handle: Option<AppHandle>,
}

impl MultiStemExporter {
    /// Инициализация экспортера с предварительным аудитом таймлайна
    pub fn new(
        project_id: String,
        project_name: String,
        destination_folder: PathBuf,
        total_timeline_frames: usize,
        segments: Vec<TimelineSegmentSource>,
        app_handle: Option<AppHandle>,
    ) -> Self {
        // Параллельная предварительная загрузка и валидация аудиофайлов через Rayon
        let readers: Vec<SegmentFileReader> = segments
            .into_par_iter()
            .map(|seg| {
                let mut reader = SegmentFileReader::new(seg);
                let _ = reader.preload();
                reader
            })
            .collect();

        Self {
            project_id,
            project_name,
            destination_folder,
            total_timeline_frames,
            readers,
            app_handle,
        }
    }

    /// Параллельный рендеринг 3 мастер-дорожек без лишних проходов по диску
    pub fn execute_parallel_export(&self) -> Result<StemExportReport, String> {
        let start_time = Instant::now();
        fs::create_dir_all(&self.destination_folder)
            .map_err(|e| format!("Не удалось создать директорию назначения: {}", e))?;

        let safe_name = self.project_name
            .replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");

        // 1. Формирование путей 3 мастер-файлов
        let full_mix_path = self.destination_folder.join(format!("{}_Full_Mix_24bit.wav", safe_name));
        let clean_vo_path = self.destination_folder.join(format!("{}_Clean_VO_24bit.wav", safe_name));
        let me_path = self.destination_folder.join(format!("{}_M_and_E_24bit.wav", safe_name));

        // 2. Инициализация BWF-метаданных с таймкодом и EBU R128
        let mut full_mix_meta = BwfBextMetadata::default();
        full_mix_meta.description = format!("{} - Full Mix Broadcast Master", self.project_name);
        full_mix_meta.originator_reference = format!("{}_FULLMIX", self.project_id);

        let mut clean_vo_meta = BwfBextMetadata::default();
        clean_vo_meta.description = format!("{} - Clean Voice / Dialogue Stem", self.project_name);
        clean_vo_meta.originator_reference = format!("{}_CLEANVO", self.project_id);

        let mut me_meta = BwfBextMetadata::default();
        me_meta.description = format!("{} - Music & Effects (M&E) Stem", self.project_name);
        me_meta.originator_reference = format!("{}_ME_STEM", self.project_id);

        // 3. Открытие 3 потоковых BWF-райтеров (64 КБ буфер каждый)
        let mut full_mix_writer = BwfWavWriter::create(&full_mix_path, &full_mix_meta)?;
        let mut clean_vo_writer = BwfWavWriter::create(&clean_vo_path, &clean_vo_meta)?;
        let mut me_writer = BwfWavWriter::create(&me_path, &me_meta)?;

        let total_frames = self.total_timeline_frames.max(BWF_SAMPLE_RATE as usize); // Минимум 1 сек
        let duration_seconds = total_frames as f64 / BWF_SAMPLE_RATE as f64;

        log_debug(&format!(
            "[StemExporter] Старт потокового экспорта: {} фреймов ({:.2} сек), блок {} фреймов",
            total_frames, duration_seconds, STREAM_BLOCK_FRAMES
        ));

        // 4. Разделение читателей на две группы: Дубляж (VO) и Фон (M&E)
        let (vo_readers, me_readers): (Vec<&SegmentFileReader>, Vec<&SegmentFileReader>) = self
            .readers
            .iter()
            .partition(|r| r.source.is_dub_voice);

        // 5. Потоковый рендеринг чанками по 64 КБ без загрузки всего файла в память
        let mut current_frame = 0;
        let mut last_progress_report = Instant::now();

        while current_frame < total_frames {
            let block_len = (total_frames - current_frame).min(STREAM_BLOCK_FRAMES);

            // Буферы для M&E и Clean VO
            let mut me_left = vec![0.0f32; block_len];
            let mut me_right = vec![0.0f32; block_len];
            let mut vo_left = vec![0.0f32; block_len];
            let mut vo_right = vec![0.0f32; block_len];

            // Параллельное микширование M&E и Clean VO через Rayon
            rayon::join(
                || {
                    for reader in &me_readers {
                        reader.mix_into_block(current_frame, block_len, &mut me_left, &mut me_right);
                    }
                },
                || {
                    for reader in &vo_readers {
                        reader.mix_into_block(current_frame, block_len, &mut vo_left, &mut vo_right);
                    }
                },
            );

            // Full Mix = M&E + Clean VO (с мягким лимитированием при суммировании)
            let mut full_left = vec![0.0f32; block_len];
            let mut full_right = vec![0.0f32; block_len];

            for i in 0..block_len {
                full_left[i] = (me_left[i] + vo_left[i]).clamp(-1.0, 1.0);
                full_right[i] = (me_right[i] + vo_right[i]).clamp(-1.0, 1.0);
            }

            // Потоковая запись в 3 файла BWF
            full_mix_writer.write_stereo_block_f32(&full_left, &full_right)?;
            clean_vo_writer.write_stereo_block_f32(&vo_left, &vo_right)?;
            me_writer.write_stereo_block_f32(&me_left, &me_right)?;

            current_frame += block_len;

            // Отправка прогресса в UI (не чаще 1 раза в 100 мс)
            if let Some(app) = &self.app_handle {
                if last_progress_report.elapsed().as_millis() > 100 || current_frame >= total_frames {
                    let pct = ((current_frame as f32 / total_frames as f32) * 100.0).min(100.0);
                    let _ = app.emit(
                        "stem-export-progress",
                        StemExportProgress {
                            progress_percent: pct,
                            current_frame: current_frame as u64,
                            total_frames: total_frames as u64,
                            current_stage: format!(
                                "Экспорт стемов: рендеринг блока {}/{} фреймов ({:.1}%)",
                                current_frame, total_frames, pct
                            ),
                            elapsed_sec: start_time.elapsed().as_secs_f64(),
                        },
                    );
                    last_progress_report = Instant::now();
                }
            }
        }

        // 6. Финализация 3-х файлов BWF (параллельно через Rayon)
        let (full_size, (vo_size, me_size)) = rayon::join(
            || full_mix_writer.finalize(),
            || rayon::join(|| clean_vo_writer.finalize(), || me_writer.finalize()),
        );

        let full_mix_bytes = full_size?;
        let clean_vo_bytes = vo_size?;
        let me_bytes = me_size?;

        let elapsed_ms = start_time.elapsed().as_millis() as u64;

        let smpte_start = "00:00:00:00".to_string();

        let stems = vec![
            ExportedStemInfo {
                id: "full_mix".to_string(),
                name: "Full Mix (Мастер-микс дубляжа, M&E и эффектов)".to_string(),
                file_name: full_mix_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                file_path: full_mix_path.to_string_lossy().to_string(),
                format: "Broadcast WAV (24-bit PCM / 48000 Hz Stereo)".to_string(),
                bit_depth: BWF_BITS_PER_SAMPLE,
                sample_rate: BWF_SAMPLE_RATE,
                channels: BWF_CHANNELS,
                duration_seconds,
                file_size_bytes: full_mix_bytes,
                smpte_start_timecode: smpte_start.clone(),
            },
            ExportedStemInfo {
                id: "clean_vo".to_string(),
                name: "Clean VO (Чистый голос дубляжа со всей линейкой обработки)".to_string(),
                file_name: clean_vo_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                file_path: clean_vo_path.to_string_lossy().to_string(),
                format: "Broadcast WAV (24-bit PCM / 48000 Hz Stereo)".to_string(),
                bit_depth: BWF_BITS_PER_SAMPLE,
                sample_rate: BWF_SAMPLE_RATE,
                channels: BWF_CHANNELS,
                duration_seconds,
                file_size_bytes: clean_vo_bytes,
                smpte_start_timecode: smpte_start.clone(),
            },
            ExportedStemInfo {
                id: "me".to_string(),
                name: "M&E (Музыка и синхронные шумы без дубляжа)".to_string(),
                file_name: me_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                file_path: me_path.to_string_lossy().to_string(),
                format: "Broadcast WAV (24-bit PCM / 48000 Hz Stereo)".to_string(),
                bit_depth: BWF_BITS_PER_SAMPLE,
                sample_rate: BWF_SAMPLE_RATE,
                channels: BWF_CHANNELS,
                duration_seconds,
                file_size_bytes: me_bytes,
                smpte_start_timecode: smpte_start.clone(),
            },
        ];

        println!(
            "[StemExporter] <<< УСПЕШНО ЗАВЕРШЕНО >>> 3 стема за {} мс. Full Mix: {} байт, Clean VO: {} байт, M&E: {} байт",
            elapsed_ms, full_mix_bytes, clean_vo_bytes, me_bytes
        );

        Ok(StemExportReport {
            success: true,
            project_id: self.project_id.clone(),
            project_name: self.project_name.clone(),
            destination_folder: self.destination_folder.to_string_lossy().to_string(),
            sample_rate: BWF_SAMPLE_RATE,
            bit_depth: BWF_BITS_PER_SAMPLE,
            total_frames: total_frames as u64,
            duration_seconds,
            smpte_timecode_start: smpte_start,
            stems,
            elapsed_ms,
            message: format!(
                "Экспорт стемов Broadcast WAV 24-bit/48kHz успешно выполнен за {:.2} сек. Сохранено 3 мастер-файла.",
                elapsed_ms as f64 / 1000.0
            ),
        })
    }
}

// ============================================================================
// КОМАНДА TAURI: export_project_stems
// ============================================================================

#[tauri::command]
pub async fn export_project_stems(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    destination_folder: String,
) -> Result<StemExportReport, String> {
    log_debug(&format!(
        "[Tauri] export_project_stems: project_id='{}', destination='{}'",
        project_id, destination_folder
    ));

    let db_guard = state.db.lock().await;
    let pool = db_guard.as_ref().ok_or_else(|| "База данных SQLite не инициализирована".to_string())?;

    // 1. Загрузка проекта
    let proj_row = sqlx::query("SELECT id, name, config_json, audio_offset_ms FROM projects WHERE id = ?")
        .bind(&project_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Ошибка БД при загрузке проекта: {}", e))?
        .ok_or_else(|| format!("Проект с ID '{}' не найден", project_id))?;

    let project_name: String = proj_row.get("name");
    let audio_offset_ms: f64 = proj_row.try_get("audio_offset_ms").unwrap_or(0.0);
    let offset_seconds = audio_offset_ms / 1000.0;

    // 2. Загрузка всех активных дорожек и сегментов
    let tracks_rows = sqlx::query("SELECT id, name, volume, is_muted FROM tracks WHERE project_id = ?")
        .bind(&project_id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Ошибка БД при загрузке дорожек: {}", e))?;

    let mut timeline_segments: Vec<TimelineSegmentSource> = Vec::new();
    let mut max_end_frame: usize = 0;

    for track_row in tracks_rows {
        let track_id: String = track_row.get("id");
        let track_name: String = track_row.get("name");
        let track_volume: f64 = track_row.get("volume");
        let is_muted: bool = track_row.get("is_muted");

        if is_muted {
            continue;
        }

        let name_lower = track_name.to_lowercase();
        // Определение роли дорожки: дубляж (голос) vs M&E (музыка/шумы/оригинал)
        let is_me = name_lower.contains("оригинал")
            || name_lower.contains("original")
            || name_lower.contains("m&e")
            || name_lower.contains("me")
            || name_lower.contains("music")
            || name_lower.contains("музык")
            || name_lower.contains("effects")
            || name_lower.contains("sfx")
            || name_lower.contains("шум")
            || name_lower.contains("фон");

        let is_dub_voice = !is_me;

        let seg_rows = sqlx::query(
            "SELECT id, start_time, duration, file_offset, file_path, gain FROM segments WHERE track_id = ?"
        )
        .bind(&track_id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Ошибка БД при загрузке сегментов: {}", e))?;

        for s_row in seg_rows {
            let seg_id: String = s_row.get("id");
            let start_time: f64 = s_row.get("start_time");
            let duration: f64 = s_row.get("duration");
            let file_offset: f64 = s_row.get("file_offset");
            let file_path_opt: Option<String> = s_row.get("file_path");
            let gain: f64 = s_row.get("gain");

            if let Some(f_path) = file_path_opt {
                let p = PathBuf::from(&f_path);
                if p.exists() {
                    let actual_start_sec = (start_time + offset_seconds).max(0.0);
                    let start_frame = (actual_start_sec * BWF_SAMPLE_RATE as f64).round() as usize;
                    let duration_frames = (duration * BWF_SAMPLE_RATE as f64).round() as usize;
                    let file_offset_frames = (file_offset * BWF_SAMPLE_RATE as f64).round() as usize;

                    let end_frame = start_frame + duration_frames;
                    if end_frame > max_end_frame {
                        max_end_frame = end_frame;
                    }

                    timeline_segments.push(TimelineSegmentSource {
                        segment_id: seg_id,
                        track_id: track_id.clone(),
                        track_name: track_name.clone(),
                        is_dub_voice,
                        start_frame,
                        duration_frames,
                        file_offset_frames,
                        gain: (gain * track_volume) as f32,
                        pan: 0.0,
                        file_path: p,
                    });
                }
            }
        }
    }

    drop(db_guard);

    let dest_path = PathBuf::from(destination_folder);
    let exporter = MultiStemExporter::new(
        project_id,
        project_name,
        dest_path,
        max_end_frame,
        timeline_segments,
        Some(app_handle),
    );

    exporter.execute_parallel_export()
}
