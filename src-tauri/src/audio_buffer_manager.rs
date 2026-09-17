// ============================================================================
// DUB MIXING STUDIO PRO - NATIVE AUDIO BUFFER MANAGER (RUST)
// Высокопроизводительное управление аудио-буферами и Zero-Copy Memory Mapping
// Стек: memmap2 = "0.9.5", hound = "3.5.1", symphonia = "0.5.4", dashmap = "6.1.0", tokio = "1.43"
// ============================================================================

use std::fs::File;
use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use dashmap::DashMap;
use hound::{SampleFormat, WavReader, WavSpec};
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::State;
use uuid::Uuid;

use crate::file_io::normalize_windows_path;
use crate::logger::{log_debug, log_error, log_info};

// ============================================================================
// СТРУКТУРЫ ДАННЫХ И МЕТАДАННЫХ
// ============================================================================

/// Метаданные аудиофайла, возвращаемые во фронтенд в виде легковесного дескриптора
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadataResponse {
    pub buffer_id: String,
    pub file_path: String,
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub bit_depth: u16,
    pub total_samples: usize,
    pub total_frames: usize,
    pub is_mmap: bool,
}

/// Статистика глобального кэша аудио-буферов
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferCacheStats {
    pub cached_tracks_count: usize,
    pub total_memory_bytes: usize,
    pub mmap_buffers_count: usize,
    pub pcm_buffers_count: usize,
}

/// Тип хранения аудио-буфера в разделяемой памяти
pub enum AudioBufferData {
    /// Zero-Copy Memory Mapping для несжатых WAV файлов (Zero RAM overhead)
    MmapWav {
        mmap: Arc<Mmap>,
        spec: WavSpec,
        data_offset_bytes: usize,
        total_frames: usize,
    },
    /// Декодированный плоский PCM вектор (interleaved f32) для MP3, AAC, FLAC, OGG или синтезированных треков
    PcmFloat {
        samples: Vec<f32>,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        total_frames: usize,
    },
}

/// Элемент кэша декодированной дорожки
pub struct CachedTrackBuffer {
    pub buffer_id: String,
    pub file_path: String,
    pub data: AudioBufferData,
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub bit_depth: u16,
    pub total_frames: usize,
    pub last_accessed: Instant,
}

impl CachedTrackBuffer {
    /// Извлечение среза сэмплов (интерливнутый f32) для таймлайна, рендера или инспекции
    pub fn get_slice(&self, start_sample: usize, length: usize) -> Vec<f32> {
        let channels = self.channels as usize;
        let total_samples = self.total_frames * channels;

        if start_sample >= total_samples || length == 0 {
            return Vec::new();
        }

        let actual_len = length.min(total_samples - start_sample);

        match &self.data {
            AudioBufferData::PcmFloat { samples, .. } => {
                let end_idx = (start_sample + actual_len).min(samples.len());
                if start_sample < end_idx {
                    samples[start_sample..end_idx].to_vec()
                } else {
                    Vec::new()
                }
            }
            AudioBufferData::MmapWav {
                mmap,
                spec,
                data_offset_bytes,
                ..
            } => {
                let bytes_per_sample = (spec.bits_per_sample / 8) as usize;
                let mmap_slice = &mmap[*data_offset_bytes..];
                let mut out = Vec::with_capacity(actual_len);

                for i in 0..actual_len {
                    let sample_idx = start_sample + i;
                    let byte_idx = sample_idx * bytes_per_sample;

                    if byte_idx + bytes_per_sample > mmap_slice.len() {
                        break;
                    }

                    let val_f32 = match (spec.sample_format, spec.bits_per_sample) {
                        (SampleFormat::Float, 32) => {
                            let b = [
                                mmap_slice[byte_idx],
                                mmap_slice[byte_idx + 1],
                                mmap_slice[byte_idx + 2],
                                mmap_slice[byte_idx + 3],
                            ];
                            f32::from_le_bytes(b)
                        }
                        (SampleFormat::Int, 16) => {
                            let b = [mmap_slice[byte_idx], mmap_slice[byte_idx + 1]];
                            (i16::from_le_bytes(b) as f32) / 32768.0
                        }
                        (SampleFormat::Int, 24) => {
                            let b0 = mmap_slice[byte_idx];
                            let b1 = mmap_slice[byte_idx + 1];
                            let b2 = mmap_slice[byte_idx + 2];
                            // Sign-extend 24-bit into 32-bit int
                            let raw_i32 = ((b2 as i8 as i32) << 16) | ((b1 as i32) << 8) | (b0 as i32);
                            (raw_i32 as f32) / 8388608.0
                        }
                        (SampleFormat::Int, 32) => {
                            let b = [
                                mmap_slice[byte_idx],
                                mmap_slice[byte_idx + 1],
                                mmap_slice[byte_idx + 2],
                                mmap_slice[byte_idx + 3],
                            ];
                            (i32::from_le_bytes(b) as f32) / 2147483648.0
                        }
                        _ => 0.0,
                    };

                    out.push(val_f32);
                }

                out
            }
        }
    }

    /// Приблизительный размер в оперативной памяти (в байтах)
    pub fn memory_usage_bytes(&self) -> usize {
        match &self.data {
            AudioBufferData::MmapWav { .. } => 1024, // Mmap не занимает heap RAM процесса
            AudioBufferData::PcmFloat { samples, .. } => samples.len() * std::mem::size_of::<f32>(),
        }
    }
}

// ============================================================================
// ГЛОБАЛЬНЫЙ СТЕЙТ КЭША АУДИОБУФЕРОВ
// ============================================================================

/// Потокобезопасный стейт кэша аудиодескрипторов
#[derive(Clone)]
pub struct AudioBufferCache {
    pub buffers: Arc<DashMap<String, CachedTrackBuffer>>,
    pub path_to_id: Arc<DashMap<String, String>>,
}

impl Default for AudioBufferCache {
    fn default() -> Self {
        Self {
            buffers: Arc::new(DashMap::new()),
            path_to_id: Arc::new(DashMap::new()),
        }
    }
}

impl AudioBufferCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Проверка, загружен ли уже файл в кэш (дедупликация)
    pub fn get_by_path(&self, file_path: &str) -> Option<String> {
        let norm = normalize_windows_path(file_path);
        self.path_to_id.get(&norm).map(|entry| entry.value().clone())
    }

    /// Регистрация буфера в кэше
    pub fn insert(&self, buffer_id: String, file_path: String, buffer: CachedTrackBuffer) {
        let norm = normalize_windows_path(&file_path);
        self.path_to_id.insert(norm, buffer_id.clone());
        self.buffers.insert(buffer_id, buffer);
    }

    /// Удаление буфера по ID
    pub fn remove(&self, buffer_id: &str) -> bool {
        if let Some((_, buf)) = self.buffers.remove(buffer_id) {
            let norm = normalize_windows_path(&buf.file_path);
            self.path_to_id.remove(&norm);
            true
        } else {
            false
        }
    }

    /// Очистка всех закэшированных аудиобуферов
    pub fn clear(&self) {
        self.buffers.clear();
        self.path_to_id.clear();
    }
}

// ============================================================================
// ДЕКОДЕРЫ И ЗАГРУЗЧИКИ (WAV ZERO-COPY MMAP И NATIVE SYMPHONIA)
// ============================================================================

/// Быстрая Zero-Copy инициализация WAV файлов через memmap2
fn load_wav_mmap(file_path: &Path) -> Result<CachedTrackBuffer, String> {
    let file = File::open(file_path).map_err(|e| format!("Не удалось открыть файл: {}", e))?;
    let mmap = unsafe { Mmap::map(&file).map_err(|e| format!("Ошибка Memory Mapping (mmap): {}", e))? };

    // Быстрый парсинг WAV заголовков через Hound
    let mut cursor = Cursor::new(&mmap[..]);
    let reader = WavReader::new(&mut cursor).map_err(|e| format!("Ошибка парсинга WAV заголовка: {}", e))?;
    let spec = reader.spec();
    let duration_frames = reader.duration() as usize;
    let duration_seconds = duration_frames as f64 / spec.sample_rate as f64;

    // Поиск точного смещения чанка 'data' в mmap буфере
    let data_offset = find_wav_data_chunk_offset(&mmap)?;

    let buffer_id = format!("buf_{}", Uuid::new_v4());

    Ok(CachedTrackBuffer {
        buffer_id,
        file_path: file_path.to_string_lossy().to_string(),
        data: AudioBufferData::MmapWav {
            mmap: Arc::new(mmap),
            spec,
            data_offset_bytes: data_offset,
            total_frames: duration_frames,
        },
        duration_seconds,
        sample_rate: spec.sample_rate,
        channels: spec.channels,
        bit_depth: spec.bits_per_sample,
        total_frames: duration_frames,
        last_accessed: Instant::now(),
    })
}

/// Поиск байтового смещения заголовка чанка 'data' в RIFF/WAV контейнере
fn find_wav_data_chunk_offset(bytes: &[u8]) -> Result<usize, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("Невалидный RIFF/WAVE заголовок".to_string());
    }

    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;

        if chunk_id == b"data" {
            return Ok(offset + 8);
        }

        offset += 8 + chunk_size;
        // 2-byte alignment
        if chunk_size % 2 != 0 {
            offset += 1;
        }
    }

    Err("Чанк 'data' не найден в WAV файле".to_string())
}

/// Нативное многопоточное декодирование сжатых форматов (MP3, AAC, FLAC, OGG) через Symphonia
fn load_compressed_symphonia(file_path: &Path) -> Result<CachedTrackBuffer, String> {
    let file = File::open(file_path).map_err(|e| format!("Не удалось открыть медиа-файл: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

    let mut hint = Hint::new();
    if let Some(ext) = file_path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let format_opts = FormatOptions::default();
    let metadata_opts = MetadataOptions::default();
    let decoder_opts = DecoderOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| format!("Ошибка определения формата Symphonia: {}", e))?;

    let mut format = probed.format;

    // Ищем первую декодируемую аудиотрек-дорожку
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "В файле не обнаружено поддерживаемых аудиодорожек".to_string())?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(48000);
    let channels = track.codec_params.channels.map(|c| c.count() as u16).unwrap_or(2);
    let bit_depth = track.codec_params.bits_per_sample.unwrap_or(16) as u16;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Не удалось инициализировать декодер Symphonia: {}", e))?;

    let mut pcm_samples: Vec<f32> = Vec::new();

    // Потоковое декодирование пакетов в память
    loop {
        let packet = match format.next_packet() {
            Ok(pkt) => pkt,
            Err(SymphoniaError::IoError(ref err)) if err.kind() == std::io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(err) => {
                log_debug(&format!("[Symphonia] Завершение чтения пакетов: {}", err));
                break;
            }
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(audio_buf_ref) => {
                match audio_buf_ref {
                    AudioBufferRef::F32(buf) => {
                        let num_frames = buf.frames();
                        let num_channels = buf.spec().channels.count();
                        for frame in 0..num_frames {
                            for ch in 0..num_channels {
                                pcm_samples.push(buf.chan(ch)[frame]);
                            }
                        }
                    }
                    AudioBufferRef::S16(buf) => {
                        let num_frames = buf.frames();
                        let num_channels = buf.spec().channels.count();
                        for frame in 0..num_frames {
                            for ch in 0..num_channels {
                                pcm_samples.push(buf.chan(ch)[frame] as f32 / 32768.0);
                            }
                        }
                    }
                    AudioBufferRef::S24(buf) => {
                        let num_frames = buf.frames();
                        let num_channels = buf.spec().channels.count();
                        for frame in 0..num_frames {
                            for ch in 0..num_channels {
                                pcm_samples.push(buf.chan(ch)[frame].0 as f32 / 8388608.0);
                            }
                        }
                    }
                    AudioBufferRef::S32(buf) => {
                        let num_frames = buf.frames();
                        let num_channels = buf.spec().channels.count();
                        for frame in 0..num_frames {
                            for ch in 0..num_channels {
                                pcm_samples.push(buf.chan(ch)[frame] as f32 / 2147483648.0);
                            }
                        }
                    }
                    AudioBufferRef::U8(buf) => {
                        let num_frames = buf.frames();
                        let num_channels = buf.spec().channels.count();
                        for frame in 0..num_frames {
                            for ch in 0..num_channels {
                                pcm_samples.push((buf.chan(ch)[frame] as f32 - 128.0) / 128.0);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Err(SymphoniaError::DecodeError(err)) => {
                log_debug(&format!("[Symphonia] Пропуск поврежденного аудиокадра: {}", err));
            }
            Err(err) => {
                log_error(&format!("[Symphonia] Критическая ошибка декодирования: {}", err));
                break;
            }
        }
    }

    let ch_count = channels as usize;
    let total_frames = if ch_count > 0 { pcm_samples.len() / ch_count } else { 0 };
    let duration_seconds = total_frames as f64 / sample_rate as f64;

    let buffer_id = format!("buf_{}", Uuid::new_v4());

    Ok(CachedTrackBuffer {
        buffer_id,
        file_path: file_path.to_string_lossy().to_string(),
        data: AudioBufferData::PcmFloat {
            samples: pcm_samples,
            sample_rate,
            channels,
            bit_depth,
            total_frames,
        },
        duration_seconds,
        sample_rate,
        channels,
        bit_depth,
        total_frames,
        last_accessed: Instant::now(),
    })
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// 1. Загрузка и кэширование аудиофайла (WAV Zero-Copy Mmap или Symphonia Native Decode)
#[tauri::command]
pub async fn load_audio_file(
    state: State<'_, AudioBufferCache>,
    file_path: String,
) -> Result<AudioMetadataResponse, String> {
    let norm_path_str = normalize_windows_path(&file_path);
    let path = Path::new(&norm_path_str);

    if !path.exists() {
        return Err(format!("Аудиофайл не существует на диске: {}", norm_path_str));
    }

    // Дедупликация: если файл уже в кэше, мгновенно отдаем метаданные
    if let Some(existing_id) = state.get_by_path(&norm_path_str) {
        if let Some(mut buf_entry) = state.buffers.get_mut(&existing_id) {
            buf_entry.last_accessed = Instant::now();
            let is_mmap = matches!(buf_entry.data, AudioBufferData::MmapWav { .. });
            return Ok(AudioMetadataResponse {
                buffer_id: buf_entry.buffer_id.clone(),
                file_path: buf_entry.file_path.clone(),
                duration_seconds: buf_entry.duration_seconds,
                sample_rate: buf_entry.sample_rate,
                channels: buf_entry.channels,
                bit_depth: buf_entry.bit_depth,
                total_samples: buf_entry.total_frames * (buf_entry.channels as usize),
                total_frames: buf_entry.total_frames,
                is_mmap,
            });
        }
    }

    let start_time = Instant::now();
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();

    // Для WAV используем zero-copy memory mapping
    let buffer = if ext == "wav" {
        match load_wav_mmap(path) {
            Ok(b) => b,
            Err(err) => {
                log_debug(&format!("[AudioBufferManager] Mmap WAV fallback to Symphonia: {}", err));
                load_compressed_symphonia(path)?
            }
        }
    } else {
        load_compressed_symphonia(path)?
    };

    let is_mmap = matches!(buffer.data, AudioBufferData::MmapWav { .. });
    let buffer_id = buffer.buffer_id.clone();
    let duration_seconds = buffer.duration_seconds;
    let sample_rate = buffer.sample_rate;
    let channels = buffer.channels;
    let bit_depth = buffer.bit_depth;
    let total_frames = buffer.total_frames;
    let total_samples = total_frames * (channels as usize);

    log_info(&format!(
        "[AudioBufferManager] Файл '{}' успешно загружен в буфер '{}' за {:.2}ms (Mmap: {}, Длительность: {:.2}s, {} Hz)",
        norm_path_str,
        buffer_id,
        start_time.elapsed().as_secs_f64() * 1000.0,
        is_mmap,
        duration_seconds,
        sample_rate
    ));

    state.insert(buffer_id.clone(), norm_path_str.clone(), buffer);

    Ok(AudioMetadataResponse {
        buffer_id,
        file_path: norm_path_str,
        duration_seconds,
        sample_rate,
        channels,
        bit_depth,
        total_samples,
        total_frames,
        is_mmap,
    })
}

/// 2. Получение среза аудиосэмплов (интерливнутый f32) для рендера, спектрограмм или воспроизведения
#[tauri::command]
pub async fn get_audio_slice(
    state: State<'_, AudioBufferCache>,
    buffer_id: String,
    start_sample: usize,
    length: usize,
) -> Result<Vec<f32>, String> {
    if let Some(mut buf) = state.buffers.get_mut(&buffer_id) {
        buf.last_accessed = Instant::now();
        Ok(buf.get_slice(start_sample, length))
    } else {
        Err(format!("Аудиобуфер с ID '{}' не найден в кэше", buffer_id))
    }
}

/// 3. Удаление буфера из оперативной памяти при закрытии дорожки/проекта
#[tauri::command]
pub async fn unload_audio_buffer(
    state: State<'_, AudioBufferCache>,
    buffer_id: String,
) -> Result<bool, String> {
    let removed = state.remove(&buffer_id);
    if removed {
        log_debug(&format!("[AudioBufferManager] Буфер '{}' выгружен из памяти", buffer_id));
    }
    Ok(removed)
}

/// 4. Полный сброс кэша
#[tauri::command]
pub async fn clear_all_audio_buffers(
    state: State<'_, AudioBufferCache>,
) -> Result<(), String> {
    state.clear();
    log_info("[AudioBufferManager] Глобальный кэш аудиобуферов полностью очищен");
    Ok(())
}

/// 5. Получение диагностической статистики кэша
#[tauri::command]
pub async fn get_buffer_cache_stats(
    state: State<'_, AudioBufferCache>,
) -> Result<BufferCacheStats, String> {
    let mut total_bytes = 0;
    let mut mmap_count = 0;
    let mut pcm_count = 0;

    for entry in state.buffers.iter() {
        total_bytes += entry.value().memory_usage_bytes();
        match entry.value().data {
            AudioBufferData::MmapWav { .. } => mmap_count += 1,
            AudioBufferData::PcmFloat { .. } => pcm_count += 1,
        }
    }

    Ok(BufferCacheStats {
        cached_tracks_count: state.buffers.len(),
        total_memory_bytes: total_bytes,
        mmap_buffers_count: mmap_count,
        pcm_buffers_count: pcm_count,
    })
}
