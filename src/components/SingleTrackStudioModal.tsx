import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Wrench, X, Play, Pause, Square, RotateCcw, Volume2, Sparkles, Sliders, 
  Layers, Download, Upload, Check, Activity, Flame, Zap, Music, Scissors, 
  FileAudio, RefreshCw, BarChart2, ShieldAlert, Cpu, CheckCircle2, AlertCircle, FolderOpen
} from 'lucide-react';
import { useUIState } from '../contexts/UIContext';
import { SpectralAnalysisService, SpectrogramData } from '../services/spectralAnalysisService';
import { getSafeFileUrl } from '../lib/utils';
import { open as rawOpen, save as rawSave } from '@tauri-apps/plugin-dialog';

const safeOpen = async (options?: any): Promise<any> => {
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return null;
  return await rawOpen(options);
};

const safeSave = async (options?: any): Promise<any> => {
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return null;
  return await rawSave(options);
};

const safeInvoke = async <T = any>(cmd: string, args?: any): Promise<T> => {
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) {
    throw new Error('Tauri API недоступна в браузере');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<T>(cmd, args);
};

type ToolCategory = 'prep' | 'eq_dynamics' | 'mastering';

export const SingleTrackStudioModal: React.FC = () => {
  const { activeModal, setActiveModal } = useUIState();
  const isOpen = activeModal === 'singleTrackStudio';

  // File states
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [processedPath, setProcessedPath] = useState<string | null>(null);
  
  // Audio playback & buffers
  const [originalBuffer, setOriginalBuffer] = useState<AudioBuffer | null>(null);
  const [processedBuffer, setProcessedBuffer] = useState<AudioBuffer | null>(null);
  const [activeSource, setActiveSource] = useState<'A' | 'B'>('A'); // A = Original, B = Processed
  
  // Playback engine
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isLooping, setIsLooping] = useState<boolean>(false);

  // Spectrogram states
  const [spectrogramDataA, setSpectrogramDataA] = useState<SpectrogramData | null>(null);
  const [spectrogramDataB, setSpectrogramDataB] = useState<SpectrogramData | null>(null);
  const [fftSize, setFftSize] = useState<number>(2048);
  const [palette, setPalette] = useState<'inferno' | 'viridis' | 'turbo' | 'plasma'>('inferno');
  const [hoverInfo, setHoverInfo] = useState<{ time: number; freq: number; db: number; x: number; y: number } | null>(null);

  // Processing UI state
  const [activeCategory, setActiveCategory] = useState<ToolCategory>('prep');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processStage, setProcessStage] = useState<string>('');
  const [processProgress, setProcessProgress] = useState<number>(0);
  const [lastReport, setLastReport] = useState<string | null>(null);

  // Tool parameter forms
  // Denoise
  const [denoiseModel, setDenoiseModel] = useState<string>('uvr_denoise_foxjoy');
  const [denoiseStrength, setDenoiseStrength] = useState<number>(85);
  // Dereverb
  const [dereverbModel, setDereverbModel] = useState<string>('reverb_foxjoy');
  const [dereverbStrength, setDereverbStrength] = useState<number>(85);
  // VAD / Split
  const [vadThresholdDb, setVadThresholdDb] = useState<number>(-42);
  const [minSilenceMs, setMinSilenceMs] = useState<number>(300);
  const [vadResultSegments, setVadResultSegments] = useState<number | null>(null);
  // Normalization
  const [targetLufs, setTargetLufs] = useState<number>(-16);
  // EQ
  const [eqLowCut, setEqLowCut] = useState<number>(80);
  const [eqHighCut, setEqHighCut] = useState<number>(18000);
  const [eqMidGain, setEqMidGain] = useState<number>(0);
  // Compressor
  const [compThreshold, setCompThreshold] = useState<number>(-18);
  const [compRatio, setCompRatio] = useState<number>(3);

  // Audio Context & Playback Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef<number>(0);
  const startOffsetRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);

  // Canvas Refs
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const spectrogramCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 44100 });
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  const onClose = () => {
    stopPlayback();
    setActiveModal(null);
  };

  // Decode audio file into AudioBuffer
  const decodeFileToBuffer = async (path: string): Promise<AudioBuffer | null> => {
    try {
      const ctx = getAudioContext();
      const safeUrl = getSafeFileUrl(path);
      const resp = await fetch(safeUrl);
      const arrayBuffer = await resp.arrayBuffer();

      const decoded = await ctx.decodeAudioData(arrayBuffer);
      return decoded;
    } catch (e) {
      console.error('Ошибка декодирования аудиофайла:', e);
      return null;
    }
  };

  // Load new input file
  const handleSelectFile = async () => {
    try {
      const selected = await safeOpen({
        multiple: false,
        filters: [{ name: 'Аудиофайлы', extensions: ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg'] }]
      });

      if (!selected) return;
      const fileP = typeof selected === 'string' ? selected : selected[0];
      if (!fileP) return;

      const fName = fileP.split(/[/\\]/).pop() || 'Аудиофайл';
      setFilePath(fileP);
      setFileName(fName);
      setProcessedPath(null);
      setProcessedBuffer(null);
      setSpectrogramDataB(null);
      setActiveSource('A');
      setLastReport(null);
      setVadResultSegments(null);

      stopPlayback();

      setIsProcessing(true);
      setProcessStage('Декодирование и генерация спектрограммы...');
      setProcessProgress(20);

      const buf = await decodeFileToBuffer(fileP);
      if (buf) {
        setOriginalBuffer(buf);
        setDuration(buf.duration);
        setCurrentTime(0);

        // Compute Spectrogram for Original
        const pcm = buf.getChannelData(0);
        const spec = SpectralAnalysisService.computeSpectrogram(pcm, buf.sampleRate, fftSize, 0.25);
        setSpectrogramDataA(spec);
      }

      setIsProcessing(false);
    } catch (err: any) {
      setIsProcessing(false);
      alert('Не удалось открыть файл: ' + err.message);
    }
  };

  // HTML Input File fallback for web browser
  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFilePath(file.name);
    setFileName(file.name);
    setProcessedPath(null);
    setProcessedBuffer(null);
    setSpectrogramDataB(null);
    setActiveSource('A');
    setLastReport(null);

    stopPlayback();
    setIsProcessing(true);
    setProcessStage('Загрузка и спектральный анализ...');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = getAudioContext();
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      setOriginalBuffer(decoded);
      setDuration(decoded.duration);
      setCurrentTime(0);

      const pcm = decoded.getChannelData(0);
      const spec = SpectralAnalysisService.computeSpectrogram(pcm, decoded.sampleRate, fftSize, 0.25);
      setSpectrogramDataA(spec);
    } catch (err: any) {
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  };

  // Playback controls
  const startPlayback = (offsetSeconds: number) => {
    const ctx = getAudioContext();
    const currentBuf = activeSource === 'B' && processedBuffer ? processedBuffer : originalBuffer;
    if (!currentBuf) return;

    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.stop(); } catch (_) {}
    }

    const src = ctx.createBufferSource();
    src.buffer = currentBuf;
    src.loop = isLooping;
    src.connect(ctx.destination);

    const clampedOffset = Math.max(0, Math.min(offsetSeconds, currentBuf.duration));
    src.start(0, clampedOffset);

    sourceNodeRef.current = src;
    startTimeRef.current = ctx.currentTime;
    startOffsetRef.current = clampedOffset;
    setIsPlaying(true);

    src.onended = () => {
      if (!isLooping) {
        setIsPlaying(false);
      }
    };
  };

  const stopPlayback = () => {
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.stop(); } catch (_) {}
      sourceNodeRef.current = null;
    }
    setIsPlaying(false);
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  };

  const togglePlay = () => {
    if (isPlaying) {
      stopPlayback();
    } else {
      startPlayback(currentTime >= duration ? 0 : currentTime);
    }
  };

  // Synchronize playback position animation
  useEffect(() => {
    if (!isPlaying) return;

    const updateTime = () => {
      if (audioCtxRef.current && isPlaying) {
        const elapsed = audioCtxRef.current.currentTime - startTimeRef.current;
        let newTime = startOffsetRef.current + elapsed;

        if (newTime >= duration) {
          if (isLooping) {
            newTime = newTime % duration;
          } else {
            newTime = duration;
            setIsPlaying(false);
          }
        }
        setCurrentTime(newTime);
      }
      if (isPlaying) {
        animFrameRef.current = requestAnimationFrame(updateTime);
      }
    };

    animFrameRef.current = requestAnimationFrame(updateTime);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isPlaying, duration, isLooping]);

  // A/B Switch: Switch audio source seamlessly during playback
  const handleToggleAB = (source: 'A' | 'B') => {
    if (source === 'B' && !processedBuffer) return;
    const wasPlaying = isPlaying;
    const currentPos = currentTime;

    stopPlayback();
    setActiveSource(source);

    if (wasPlaying) {
      setTimeout(() => startPlayback(currentPos), 20);
    }
  };

  // Render Waveform Canvas
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    const currentBuf = activeSource === 'B' && processedBuffer ? processedBuffer : originalBuffer;
    if (!canvas || !currentBuf) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width = canvas.parentElement?.clientWidth || 800;
    const height = canvas.height = 100;

    ctx.fillStyle = '#18181b'; // zinc-900
    ctx.fillRect(0, 0, width, height);

    const channelData = currentBuf.getChannelData(0);
    const step = Math.ceil(channelData.length / width);
    const amp = height / 2;

    ctx.beginPath();
    ctx.strokeStyle = activeSource === 'B' ? '#10b981' : '#6366f1'; // emerald for B, indigo for A
    ctx.lineWidth = 1;

    for (let i = 0; i < width; i++) {
      let min = 1.0;
      let max = -1.0;
      for (let j = 0; j < step; j++) {
        const datum = channelData[i * step + j];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      ctx.moveTo(i, (1 + min) * amp);
      ctx.lineTo(i, (1 + max) * amp);
    }
    ctx.stroke();

    // Playhead line
    if (duration > 0) {
      const playheadX = (currentTime / duration) * width;
      ctx.fillStyle = '#ef4444'; // red playhead
      ctx.fillRect(playheadX - 1, 0, 2, height);
    }
  }, [originalBuffer, processedBuffer, activeSource, currentTime, duration]);

  // Render Spectrogram Canvas
  const renderSpectrogram = useCallback(() => {
    const canvas = spectrogramCanvasRef.current;
    const activeSpec = activeSource === 'B' && spectrogramDataB ? spectrogramDataB : spectrogramDataA;
    if (!canvas || !activeSpec || activeSpec.frames.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width = canvas.parentElement?.clientWidth || 800;
    const height = canvas.height = 220;

    const frames = activeSpec.frames;
    const numFrames = frames.length;
    const numBins = activeSpec.fftSize / 2;

    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    const minDb = activeSpec.minDb; // -120
    const maxDb = activeSpec.maxDb; // 0

    for (let x = 0; x < width; x++) {
      const frameIdx = Math.min(numFrames - 1, Math.floor((x / width) * numFrames));
      const frame = frames[frameIdx];

      for (let y = 0; y < height; y++) {
        // Y=0 is max frequency (top), Y=height is 0Hz (bottom)
        const binIdx = Math.min(numBins - 1, Math.floor(((height - 1 - y) / height) * numBins));
        const db = frame.magnitudes[binIdx];

        // Normalize dBFS to 0..1
        let norm = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));

        // Color map lookup
        let r = 0, g = 0, b = 0;
        if (palette === 'inferno') {
          r = Math.floor(Math.min(255, norm * 1.5 * 255));
          g = Math.floor(Math.min(255, Math.pow(norm, 2) * 255));
          b = Math.floor(Math.min(255, Math.pow(norm, 4) * 255));
        } else if (palette === 'turbo') {
          r = Math.floor(255 * Math.sin(norm * Math.PI));
          g = Math.floor(255 * Math.sin(norm * Math.PI * 0.8));
          b = Math.floor(255 * Math.cos(norm * Math.PI * 0.5));
        } else if (palette === 'viridis') {
          r = Math.floor(255 * (0.2 + 0.8 * Math.pow(norm, 3)));
          g = Math.floor(255 * norm);
          b = Math.floor(255 * (0.5 + 0.5 * Math.sin(norm * Math.PI)));
        } else { // plasma
          r = Math.floor(255 * Math.pow(norm, 0.7));
          g = Math.floor(255 * Math.sin(norm * Math.PI * 0.5));
          b = Math.floor(255 * (1 - norm));
        }

        const pixelIdx = (y * width + x) * 4;
        data[pixelIdx] = r;
        data[pixelIdx + 1] = g;
        data[pixelIdx + 2] = b;
        data[pixelIdx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // Render Cutoff Frequency Line if present (e.g. MP3 16kHz cut)
    if (activeSpec.detectedCutoffFreq < 20000 && activeSpec.detectedCutoffFreq > 8000) {
      const cutoffY = height - (activeSpec.detectedCutoffFreq / activeSpec.maxFreq) * height;
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)'; // red dashed
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, cutoffY);
      ctx.lineTo(width, cutoffY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ef4444';
      ctx.font = '10px monospace';
      ctx.fillText(`▲ MP3/Lossy Срез: ${SpectralAnalysisService.formatFreqLabel(activeSpec.detectedCutoffFreq)}`, 8, cutoffY - 4);
    }

    // Playhead line
    if (duration > 0) {
      const playheadX = (currentTime / duration) * width;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(playheadX - 1, 0, 2, height);
    }
  }, [spectrogramDataA, spectrogramDataB, activeSource, palette, duration, currentTime]);

  useEffect(() => {
    renderSpectrogram();
  }, [renderSpectrogram]);

  // Mouse Inspection on Spectrogram
  const handleSpectrogramMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = spectrogramCanvasRef.current;
    const activeSpec = activeSource === 'B' && spectrogramDataB ? spectrogramDataB : spectrogramDataA;
    if (!canvas || !activeSpec) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const timeRatio = x / rect.width;
    const freqRatio = (rect.height - y) / rect.height;

    const time = timeRatio * activeSpec.duration;
    const freq = Math.round(freqRatio * activeSpec.maxFreq);

    const frameIdx = Math.min(activeSpec.frames.length - 1, Math.max(0, Math.floor(timeRatio * activeSpec.frames.length)));
    const frame = activeSpec.frames[frameIdx];
    const binIdx = Math.min(activeSpec.fftSize / 2 - 1, Math.max(0, Math.round(freq / activeSpec.freqStep)));
    const db = frame ? Math.round(frame.magnitudes[binIdx] * 10) / 10 : -120;

    setHoverInfo({ time, freq, db, x, y });
  };

  const handleSpectrogramMouseLeave = () => {
    setHoverInfo(null);
  };

  const handleCanvasSeek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const targetTime = ratio * duration;
    setCurrentTime(targetTime);
    if (isPlaying) {
      startPlayback(targetTime);
    }
  };

  // Update processed result buffer & spectrogram
  const updateProcessedResult = async (outPath: string, reportText: string) => {
    setProcessedPath(outPath);
    setLastReport(reportText);

    setProcessStage('Загрузка и спектральный анализ результата...');
    setProcessProgress(80);

    const buf = await decodeFileToBuffer(outPath);
    if (buf) {
      setProcessedBuffer(buf);
      const pcm = buf.getChannelData(0);
      const spec = SpectralAnalysisService.computeSpectrogram(pcm, buf.sampleRate, fftSize, 0.25);
      setSpectrogramDataB(spec);

      // Automatically switch to Processed source B
      setActiveSource('B');
    }

    setIsProcessing(false);
  };

  // --- TOOL EXECUTION HANDLERS (Calling unified backend commands) ---

  // 1. Run AI Denoise
  const handleRunDenoise = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Запуск AI Шумоподавления...');
    setProcessProgress(20);

    try {
      const outPath = filePath.replace(/\.([a-zA-Z0-9]+)$/, '_denoised.wav');
      const report: any = await safeInvoke('process_denoise', {
        inputPath: filePath,
        outputPath: outPath,
        modelName: denoiseModel,
        strength: denoiseStrength
      });

      const reportStr = `Шумоподавление выполнено (${report.model_name || 'AI UVR'}). Снижение шума ~${report.noise_reduction_db || 35} dB. Движок: ${report.provider_used || 'Native'}`;
      await updateProcessedResult(outPath, reportStr);
    } catch (e: any) {
      setIsProcessing(false);
      alert('Ошибка шумоподавления: ' + e.toString());
    }
  };

  // 2. Run AI Dereverb
  const handleRunDereverb = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Запуск AI Подавления эха...');
    setProcessProgress(20);

    try {
      const outPath = filePath.replace(/\.([a-zA-Z0-9]+)$/, '_dereverbed.wav');
      const report: any = await safeInvoke('process_uvr_dereverb', {
        inputPath: filePath,
        outputPath: outPath,
        reverbTailExportPath: null,
        strength: dereverbStrength / 100,
        modelName: dereverbModel
      });

      const reportStr = `Подавление реверберации завершено (${report.model_used || 'AI UVR'}). Движок: ${report.provider_used || 'Native'}`;
      await updateProcessedResult(outPath, reportStr);
    } catch (e: any) {
      setIsProcessing(false);
      alert('Ошибка подавления эха: ' + e.toString());
    }
  };

  // 3. Run VAD Silence Cut
  const handleRunVadSplit = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Анализ тишины через Silero VAD...');
    setProcessProgress(30);

    try {
      const res: any = await safeInvoke('process_vad_split', {
        inputPath: filePath,
        thresholdDb: vadThresholdDb,
        minSilenceDurationMs: minSilenceMs,
        speechPadMs: 100
      });

      setVadResultSegments(res?.segments?.length || 0);
      setLastReport(`Silero VAD обнаружил ${res?.segments?.length || 0} речевых сегментов.`);
    } catch (e: any) {
      alert('Ошибка VAD: ' + e.toString());
    } finally {
      setIsProcessing(false);
    }
  };

  // 4. Run Normalization
  const handleRunNormalize = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Нормализация громкости...');
    setProcessProgress(30);

    try {
      const outPath = filePath.replace(/\.([a-zA-Z0-9]+)$/, '_normalized.wav');
      await safeInvoke('process_media_effect', {
        inputPath: filePath,
        outputPath: outPath,
        effectType: 'normalize',
        params: { targetLufs }
      });

      await updateProcessedResult(outPath, `Нормализация до ${targetLufs} LUFS завершена.`);
    } catch (e: any) {
      setIsProcessing(false);
      alert('Ошибка нормализации: ' + e.toString());
    }
  };

  // 5. Run EQ & Compression
  const handleRunEqComp = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Применение параметрического эквалайзера и компрессора...');
    setProcessProgress(40);

    try {
      const outPath = filePath.replace(/\.([a-zA-Z0-9]+)$/, '_eq_comp.wav');
      await safeInvoke('process_media_effect', {
        inputPath: filePath,
        outputPath: outPath,
        effectType: 'vocal_dsp_chain',
        params: {
          lowCut: eqLowCut,
          highCut: eqHighCut,
          midGainDb: eqMidGain,
          compThreshold,
          compRatio
        }
      });

      await updateProcessedResult(outPath, `Эквалайзер (${eqLowCut}Hz - ${eqHighCut}Hz) и Компрессор (${compRatio}:1) применены.`);
    } catch (e: any) {
      setIsProcessing(false);
      alert('Ошибка обработки EQ/Comp: ' + e.toString());
    }
  };

  // Set Processed file as the new Input source (Iterative Pipeline)
  const handleMakeProcessedPrimary = async () => {
    if (!processedPath || !processedBuffer) return;
    setFilePath(processedPath);
    setOriginalBuffer(processedBuffer);
    setSpectrogramDataA(spectrogramDataB);

    setProcessedPath(null);
    setProcessedBuffer(null);
    setSpectrogramDataB(null);
    setActiveSource('A');
    setLastReport('Обработанный файл успешно установлен как текущий исходник.');
  };

  // Save / Export output file
  const handleExportResult = async () => {
    if (!processedPath) return;
    try {
      const savePath = await safeSave({
        defaultPath: fileName.replace(/\.([a-zA-Z0-9]+)$/, '_processed.wav'),
        filters: [{ name: 'WAV Audio', extensions: ['wav'] }]
      });

      if (savePath && (window as any).__TAURI_INTERNALS__) {
        await safeInvoke('copy_file_to_project', {
          srcPath: processedPath,
          destPath: savePath
        });
        alert('Файл успешно сохранен!');
      }
    } catch (e: any) {
      alert('Ошибка сохранения: ' + e.toString());
    }
  };

  if (!isOpen) return null;

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 100);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const activeSpec = activeSource === 'B' && spectrogramDataB ? spectrogramDataB : spectrogramDataA;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 sm:p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className="bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl w-full max-w-7xl h-[92vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/10 bg-zinc-900/90 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Wrench className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                Отдельные инструменты
                <span className="text-[10px] font-extrabold uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded-full">
                  Лаборатория точечной обработки
                </span>
              </h2>
              <p className="text-xs text-zinc-400">Тестирование и спектральный анализ отдельных аудиофайлов через единый движок</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {filePath && (
              <button
                onClick={handleSelectFile}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-bold transition-all border border-white/5 flex items-center gap-2"
              >
                <FolderOpen className="w-4 h-4 text-indigo-400" />
                Сменить файл
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-lg text-zinc-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Main Content Area */}
        {!filePath ? (
          /* Empty File Dropzone State */
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-20 h-20 rounded-3xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6">
              <FileAudio className="w-10 h-10 text-indigo-400" />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Загрузите аудиофайл для точечной обработки</h3>
            <p className="text-sm text-zinc-400 max-w-md mb-8">
              Загрузите любой WAV, MP3, FLAC или AAC файл, чтобы применить нейросетевое шумоподавление, удаление эха, VAD или эквалайзер с мгновенным спектральным контролем.
            </p>

            <div className="flex items-center gap-4">
              <button
                onClick={handleSelectFile}
                className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm rounded-xl transition-all shadow-lg shadow-indigo-600/30 flex items-center gap-2 cursor-pointer"
              >
                <Upload className="w-5 h-5" />
                Выбрать аудиофайл
              </button>

              <label className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-bold text-sm rounded-xl transition-all border border-white/10 flex items-center gap-2 cursor-pointer">
                <FileAudio className="w-5 h-5 text-purple-400" />
                Обзор диска
                <input type="file" accept="audio/*" onChange={handleFileInputChange} className="hidden" />
              </label>
            </div>
          </div>
        ) : (
          /* Main Workspace Grid */
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
            {/* Left Column: Waveform, Spectrogram & Player (7 cols) */}
            <div className="lg:col-span-7 border-r border-white/10 flex flex-col p-4 gap-4 overflow-y-auto bg-zinc-950/40 custom-scrollbar">
              
              {/* File Info & A/B Switch Toolbar */}
              <div className="bg-zinc-900/80 border border-white/10 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                    <Music className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white truncate max-w-[220px]" title={fileName}>
                      {fileName}
                    </div>
                    <div className="text-[10px] text-zinc-400 flex items-center gap-2">
                      <span>Длительность: {formatTime(duration)}</span>
                      <span>•</span>
                      <span>{(originalBuffer?.sampleRate || 44100) / 1000} kHz</span>
                    </div>
                  </div>
                </div>

                {/* A/B Comparison Switch */}
                <div className="flex items-center bg-zinc-950 p-1 rounded-xl border border-white/10">
                  <button
                    onClick={() => handleToggleAB('A')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                      activeSource === 'A'
                        ? 'bg-indigo-600 text-white shadow-md'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-indigo-300" />
                    А: Исходник
                  </button>

                  <button
                    onClick={() => handleToggleAB('B')}
                    disabled={!processedBuffer}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                      activeSource === 'B'
                        ? 'bg-emerald-600 text-white shadow-md'
                        : processedBuffer
                        ? 'text-zinc-400 hover:text-white'
                        : 'text-zinc-600 cursor-not-allowed opacity-50'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${processedBuffer ? 'bg-emerald-300' : 'bg-zinc-600'}`} />
                    Б: Результат
                  </button>
                </div>
              </div>

              {/* Player Transport Controls */}
              <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={togglePlay}
                    className="w-10 h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center transition-all shadow-lg shadow-indigo-600/30"
                  >
                    {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
                  </button>

                  <button
                    onClick={stopPlayback}
                    className="p-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-all"
                    title="Стоп"
                  >
                    <Square className="w-4 h-4" />
                  </button>

                  <button
                    onClick={() => setIsLooping(!isLooping)}
                    className={`p-2.5 rounded-xl transition-all ${
                      isLooping ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/40' : 'bg-zinc-800 text-zinc-400 hover:text-white'
                    }`}
                    title="Зациклить воспроизведение"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>

                {/* Time Display */}
                <div className="font-mono text-sm font-bold text-white bg-zinc-950 px-3 py-1.5 rounded-lg border border-white/5">
                  <span className="text-indigo-400">{formatTime(currentTime)}</span>
                  <span className="text-zinc-600 mx-1.5">/</span>
                  <span className="text-zinc-400">{formatTime(duration)}</span>
                </div>
              </div>

              {/* Sound Waveform Display */}
              <div className="bg-zinc-900/90 border border-white/10 rounded-xl p-3 relative flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs font-bold text-zinc-300">
                  <span className="flex items-center gap-1.5">
                    <Activity className="w-4 h-4 text-indigo-400" />
                    Звуковая волна (Waveform)
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono">Нажмите для перехода</span>
                </div>

                <div className="relative rounded-lg overflow-hidden border border-white/5 cursor-pointer" onClick={handleCanvasSeek}>
                  <canvas ref={waveformCanvasRef} className="w-full h-[90px] block bg-zinc-950" />
                </div>
              </div>

              {/* Spectrogram Display */}
              <div className="bg-zinc-900/90 border border-white/10 rounded-xl p-3 relative flex flex-col gap-2 flex-1 min-h-[260px]">
                <div className="flex items-center justify-between text-xs font-bold text-zinc-300">
                  <span className="flex items-center gap-1.5">
                    <Flame className="w-4 h-4 text-amber-400" />
                    Спектральный анализ (STFT Spectrogram)
                  </span>

                  <div className="flex items-center gap-2">
                    <select
                      value={palette}
                      onChange={(e) => setPalette(e.target.value as any)}
                      className="bg-zinc-800 border border-white/10 text-zinc-300 text-[10px] font-bold rounded-md px-2 py-1"
                    >
                      <option value="inferno">Палитра: Inferno</option>
                      <option value="turbo">Палитра: Turbo</option>
                      <option value="viridis">Палитра: Viridis</option>
                      <option value="plasma">Палитра: Plasma</option>
                    </select>
                  </div>
                </div>

                {/* Spectrogram Canvas */}
                <div
                  className="relative rounded-lg overflow-hidden border border-white/5 flex-1 min-h-[180px] bg-zinc-950 cursor-crosshair"
                  onMouseMove={handleSpectrogramMouseMove}
                  onMouseLeave={handleSpectrogramMouseLeave}
                  onClick={handleCanvasSeek}
                >
                  <canvas ref={spectrogramCanvasRef} className="w-full h-full block" />

                  {/* Hover Inspector Crosshair Tooltip */}
                  {hoverInfo && (
                    <div
                      className="absolute pointer-events-none bg-black/90 border border-white/20 px-2 py-1 rounded text-[10px] font-mono text-white shadow-xl z-20 flex items-center gap-2"
                      style={{
                        left: Math.min(hoverInfo.x + 10, 480),
                        top: Math.max(hoverInfo.y - 30, 10)
                      }}
                    >
                      <span className="text-amber-400">{hoverInfo.freq} Гц</span>
                      <span className="text-zinc-500">|</span>
                      <span className="text-indigo-300">{formatTime(hoverInfo.time)}</span>
                      <span className="text-zinc-500">|</span>
                      <span className="text-emerald-400">{hoverInfo.db} dBFS</span>
                    </div>
                  )}
                </div>

                {/* Diagnostics Badge Bar */}
                {activeSpec && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] font-medium text-zinc-400 pt-1">
                    <div className="bg-zinc-950 p-2 rounded-lg border border-white/5 flex flex-col">
                      <span className="text-zinc-500">Шум (Noise Floor)</span>
                      <span className="text-white font-bold font-mono">{activeSpec.estimatedNoiseFloorDb} dBFS</span>
                    </div>
                    <div className="bg-zinc-950 p-2 rounded-lg border border-white/5 flex flex-col">
                      <span className="text-zinc-500">Пик спектра</span>
                      <span className="text-amber-400 font-bold font-mono">{SpectralAnalysisService.formatFreqLabel(activeSpec.globalPeakFreq)}</span>
                    </div>
                    <div className="bg-zinc-950 p-2 rounded-lg border border-white/5 flex flex-col">
                      <span className="text-zinc-500">Верхний срез</span>
                      <span className="text-indigo-300 font-bold font-mono">{SpectralAnalysisService.formatFreqLabel(activeSpec.detectedCutoffFreq)}</span>
                    </div>
                    <div className="bg-zinc-950 p-2 rounded-lg border border-white/5 flex flex-col">
                      <span className="text-zinc-500">НЧ-гул (&lt;60Hz)</span>
                      <span className={activeSpec.hasLowRumble ? "text-red-400 font-bold" : "text-emerald-400 font-bold"}>
                        {activeSpec.hasLowRumble ? "Обнаружен" : "Чисто"}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Report & Chain Action Bar */}
              {lastReport && (
                <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs text-indigo-200">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0" />
                    <span>{lastReport}</span>
                  </div>

                  {processedPath && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleMakeProcessedPrimary}
                        className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold transition-all text-[11px] flex items-center gap-1.5 shadow-md"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Назначить как новый исходник
                      </button>

                      <button
                        onClick={handleExportResult}
                        className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold transition-all text-[11px] flex items-center gap-1.5 shadow-md"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Сохранить WAV
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right Column: Processing Tools Panel (5 cols) */}
            <div className="lg:col-span-5 flex flex-col p-4 bg-zinc-900/60 overflow-y-auto custom-scrollbar">
              {/* Category Tabs */}
              <div className="flex items-center bg-zinc-950 p-1 rounded-xl border border-white/10 mb-4">
                <button
                  onClick={() => setActiveCategory('prep')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                    activeCategory === 'prep' ? 'bg-indigo-600 text-white shadow-md' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Предподготовка
                </button>

                <button
                  onClick={() => setActiveCategory('eq_dynamics')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                    activeCategory === 'eq_dynamics' ? 'bg-indigo-600 text-white shadow-md' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  <Sliders className="w-3.5 h-3.5" />
                  EQ & Динамика
                </button>

                <button
                  onClick={() => setActiveCategory('mastering')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                    activeCategory === 'mastering' ? 'bg-indigo-600 text-white shadow-md' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  <Zap className="w-3.5 h-3.5" />
                  Мастеринг
                </button>
              </div>

              {/* Progress Overlay */}
              {isProcessing && (
                <div className="bg-indigo-950/60 border border-indigo-500/40 rounded-xl p-4 mb-4 flex flex-col gap-2 animate-pulse">
                  <div className="flex items-center justify-between text-xs font-bold text-indigo-300">
                    <span className="flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-indigo-400 animate-spin" />
                      {processStage || 'Обработка...'}
                    </span>
                    <span>{processProgress}%</span>
                  </div>
                  <div className="w-full h-2 bg-zinc-900 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${processProgress}%` }} />
                  </div>
                </div>
              )}

              {/* CATEGORY 1: PREP & CLEANUP */}
              {activeCategory === 'prep' && (
                <div className="space-y-4">
                  {/* AI Denoise Tool Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold text-xs text-white">
                        <Sparkles className="w-4 h-4 text-indigo-400" />
                        AI Шумоподавление (Python UVR)
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">VR / MDX Architecture</span>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[11px] text-zinc-400 block font-medium">Модель ИИ:</label>
                      <select
                        value={denoiseModel}
                        onChange={(e) => setDenoiseModel(e.target.value)}
                        className="w-full bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs text-white font-medium"
                      >
                        <option value="uvr_denoise_foxjoy">VR-DeNoise FoxJoy (Универсальная чистка речи)</option>
                        <option value="uvr_denoise_full">UVR-DeNoise Full (Глубокое подавление фонового шума)</option>
                        <option value="uvr_denoise_lite">UVR-DeNoise Lite (Быстрая легкая очистка)</option>
                        <option value="spectral_gate">Spectral Gate (DSP Спектральный гейт)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>Сила шумоподавления:</span>
                        <span className="font-bold text-white">{denoiseStrength}%</span>
                      </div>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        value={denoiseStrength}
                        onChange={(e) => setDenoiseStrength(Number(e.target.value))}
                        className="w-full accent-indigo-500"
                      />
                    </div>

                    <button
                      onClick={handleRunDenoise}
                      disabled={isProcessing}
                      className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-indigo-600/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Sparkles className="w-4 h-4" />
                      Применить AI Шумоподавление
                    </button>
                  </div>

                  {/* AI Dereverb Tool Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold text-xs text-white">
                        <Flame className="w-4 h-4 text-amber-400" />
                        AI Подавление эха (Python UVR)
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">De-Reverb HQ</span>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[11px] text-zinc-400 block font-medium">Модель ИИ:</label>
                      <select
                        value={dereverbModel}
                        onChange={(e) => setDereverbModel(e.target.value)}
                        className="w-full bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs text-white font-medium"
                      >
                        <option value="reverb_foxjoy">Reverb_HQ FoxJoy (Удаление реверберации помещения)</option>
                        <option value="uvr_deecho_normal">UVR De-Echo Normal (Подавление сухого эха)</option>
                        <option value="uvr_deecho_aggressive">MDX23C De-Reverb (Агрессивная чистка Гула)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>Интенсивность сушки:</span>
                        <span className="font-bold text-white">{dereverbStrength}%</span>
                      </div>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        value={dereverbStrength}
                        onChange={(e) => setDereverbStrength(Number(e.target.value))}
                        className="w-full accent-amber-500"
                      />
                    </div>

                    <button
                      onClick={handleRunDereverb}
                      disabled={isProcessing}
                      className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-amber-600/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Flame className="w-4 h-4" />
                      Применить AI Подавление эха
                    </button>
                  </div>

                  {/* Silero VAD Tool Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold text-xs text-white">
                        <Scissors className="w-4 h-4 text-purple-400" />
                        Silero VAD (Разрез по тишине)
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">Neural VAD</span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[11px] text-zinc-400 block mb-1">Порог шума (dB):</label>
                        <input
                          type="number"
                          value={vadThresholdDb}
                          onChange={(e) => setVadThresholdDb(Number(e.target.value))}
                          className="w-full bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs text-white font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-zinc-400 block mb-1">Мин тишина (ms):</label>
                        <input
                          type="number"
                          value={minSilenceMs}
                          onChange={(e) => setMinSilenceMs(Number(e.target.value))}
                          className="w-full bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs text-white font-mono"
                        />
                      </div>
                    </div>

                    {vadResultSegments !== null && (
                      <div className="text-xs text-purple-300 bg-purple-500/10 p-2 rounded-lg border border-purple-500/20">
                        Найдено речевых фрагментов: <strong>{vadResultSegments}</strong>
                      </div>
                    )}

                    <button
                      onClick={handleRunVadSplit}
                      disabled={isProcessing}
                      className="w-full py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-purple-600/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Scissors className="w-4 h-4" />
                      Анализировать паузы и тишину
                    </button>
                  </div>
                </div>
              )}

              {/* CATEGORY 2: EQ & DYNAMICS */}
              {activeCategory === 'eq_dynamics' && (
                <div className="space-y-4">
                  {/* EQ & Filter Settings */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2 font-bold text-xs text-white">
                      <Sliders className="w-4 h-4 text-emerald-400" />
                      Параметрический Эквалайзер (Parametric EQ)
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>Low Cut Filter (Срез НЧ):</span>
                        <span className="font-mono text-emerald-400 font-bold">{eqLowCut} Hz</span>
                      </div>
                      <input
                        type="range"
                        min="20"
                        max="300"
                        value={eqLowCut}
                        onChange={(e) => setEqLowCut(Number(e.target.value))}
                        className="w-full accent-emerald-500"
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>High Cut Filter (Срез ВЧ):</span>
                        <span className="font-mono text-emerald-400 font-bold">{eqHighCut} Hz</span>
                      </div>
                      <input
                        type="range"
                        min="8000"
                        max="22000"
                        value={eqHighCut}
                        onChange={(e) => setEqHighCut(Number(e.target.value))}
                        className="w-full accent-emerald-500"
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>Коррекция СЧ (Presence Gain):</span>
                        <span className="font-mono text-emerald-400 font-bold">{eqMidGain > 0 ? `+${eqMidGain}` : eqMidGain} dB</span>
                      </div>
                      <input
                        type="range"
                        min="-6"
                        max="6"
                        step="0.5"
                        value={eqMidGain}
                        onChange={(e) => setEqMidGain(Number(e.target.value))}
                        className="w-full accent-emerald-500"
                      />
                    </div>
                  </div>

                  {/* Vocal Compressor Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2 font-bold text-xs text-white">
                      <Activity className="w-4 h-4 text-indigo-400" />
                      Вокальный Компрессор (Vocal Compressor)
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[11px] text-zinc-400 block mb-1">Порог (Threshold dB):</label>
                        <input
                          type="number"
                          value={compThreshold}
                          onChange={(e) => setCompThreshold(Number(e.target.value))}
                          className="w-full bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs text-white font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-zinc-400 block mb-1">Соотношение (Ratio):</label>
                        <input
                          type="number"
                          value={compRatio}
                          onChange={(e) => setCompRatio(Number(e.target.value))}
                          className="w-full bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs text-white font-mono"
                        />
                      </div>
                    </div>

                    <button
                      onClick={handleRunEqComp}
                      disabled={isProcessing}
                      className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-emerald-600/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Sliders className="w-4 h-4" />
                      Применить EQ и Компрессию
                    </button>
                  </div>
                </div>
              )}

              {/* CATEGORY 3: MASTERING */}
              {activeCategory === 'mastering' && (
                <div className="space-y-4">
                  {/* LUFS Normalizer Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold text-xs text-white">
                        <Zap className="w-4 h-4 text-indigo-400" />
                        Нормализация громкости (LUFS Normalization)
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">EBU R128</span>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[11px] text-zinc-400 block font-medium">Целевой уровень громкости:</label>
                      <select
                        value={targetLufs}
                        onChange={(e) => setTargetLufs(Number(e.target.value))}
                        className="w-full bg-zinc-950 border border-white/10 rounded-lg p-2 text-xs text-white font-medium"
                      >
                        <option value={-16}>-16 LUFS (Стандарт для подкастов и видео)</option>
                        <option value={-14}>-14 LUFS (Громкий веб-дубляж / YouTube)</option>
                        <option value={-18}>-18 LUFS (Традиционный ТВ-стандарт / Радио)</option>
                        <option value={-23}>-23 LUFS (EBU R128 Кино и Телевидение)</option>
                      </select>
                    </div>

                    <button
                      onClick={handleRunNormalize}
                      disabled={isProcessing}
                      className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-indigo-600/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Zap className="w-4 h-4" />
                      Нормализовать целевую громкость
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
};

export default SingleTrackStudioModal;
