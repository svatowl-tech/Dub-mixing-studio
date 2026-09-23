import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Wrench, X, Play, Pause, Square, RotateCcw, Volume2, Sparkles, Sliders, 
  Layers, Download, Upload, Check, Activity, Flame, Zap, Music, Scissors, 
  FileAudio, RefreshCw, BarChart2, ShieldAlert, Cpu, CheckCircle2, AlertCircle, 
  FolderOpen, Mic, CheckSquare, ShieldCheck, Gauge
} from 'lucide-react';
import { useUIState } from '../contexts/UIContext';
import { computeSpectrogramFromFile, computeSpectrogramFromPcm, SpectrogramData } from '../lib/spectralBridge';
import { getSafeFileUrl, createPrefixedAudioPath, invalidateFileUrl } from '../lib/utils';
import { playbackEngine } from '../services/playbackEngine';
import { open as rawOpen, save as rawSave } from '@tauri-apps/plugin-dialog';
import SynchronizedAudioVisualizer from './SynchronizedAudioVisualizer';
import { ModelSelector } from './ModelSelector';

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

type ToolCategory = 'restoration' | 'eq_dynamics' | 'mastering';

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
  const [fftSize] = useState<number>(2048);
  const [palette, setPalette] = useState<'inferno' | 'viridis' | 'turbo' | 'plasma'>('inferno');

  // Processing UI state
  const [activeCategory, setActiveCategory] = useState<ToolCategory>('restoration');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processStage, setProcessStage] = useState<string>('');
  const [processProgress, setProcessProgress] = useState<number>(0);
  const [lastReport, setLastReport] = useState<string | null>(null);

  // --- Tool parameter states ---
  // 1. Denoise
  const [denoiseModel, setDenoiseModel] = useState<string>('uvr_denoise_foxjoy');
  const [denoiseStrength, setDenoiseStrength] = useState<number>(85);
  // 2. Dereverb
  const [dereverbModel, setDereverbModel] = useState<string>('reverb_foxjoy');
  const [dereverbStrength, setDereverbStrength] = useState<number>(85);
  // 3. De-Click
  const [declickSensitivity, setDeclickSensitivity] = useState<number>(75);
  // 4. De-Plosive
  const [deplosiveThreshold, setDeplosiveThreshold] = useState<number>(-24);
  // 5. De-Esser
  const [deesserFrequency, setDeesserFrequency] = useState<number>(6500);
  const [deesserThreshold, setDeesserThreshold] = useState<number>(-20);
  const [deesserRatio, setDeesserRatio] = useState<number>(4.0);
  // 6. Volume Leveler
  const [levelerTargetRms, setLevelerTargetRms] = useState<number>(-19.0);
  const [levelerMaxBoost, setLevelerMaxBoost] = useState<number>(12.0);
  const [levelerGateThreshold, setLevelerGateThreshold] = useState<number>(-50.0);
  // 7. VAD / Split
  const [vadThresholdDb, setVadThresholdDb] = useState<number>(-42);
  const [minSilenceMs, setMinSilenceMs] = useState<number>(300);
  const [vadResultSegments, setVadResultSegments] = useState<number | null>(null);
  // 8. Normalization
  const [targetLufs, setTargetLufs] = useState<number>(-16);
  // 9. EQ
  const [eqLowCut, setEqLowCut] = useState<number>(80);
  const [eqHighCut, setEqHighCut] = useState<number>(18000);
  const [eqMidGain, setEqMidGain] = useState<number>(0);
  // 10. Compressor
  const [compThreshold, setCompThreshold] = useState<number>(-18);
  const [compRatio, setCompRatio] = useState<number>(3);

  // Audio Context & Playback Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef<number>(0);
  const startOffsetRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);

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
      const safeUrl = getSafeFileUrl(path);
      if (safeUrl) {
        const buffered = await playbackEngine.loadBuffer(safeUrl, path);
        if (buffered) return buffered;
      }

      const ctx = getAudioContext();
      const resp = await fetch(safeUrl || path);
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

        // Compute Spectrogram for Original via Rust
        try {
          const spec = await computeSpectrogramFromFile(fileP, 0, undefined, fftSize, 0.25);
          setSpectrogramDataA(spec);
        } catch (_) {
          const pcm = buf.getChannelData(0);
          const spec = await computeSpectrogramFromPcm(pcm, buf.sampleRate, fftSize, 0.25);
          setSpectrogramDataA(spec);
        }
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
      const spec = await computeSpectrogramFromPcm(pcm, decoded.sampleRate, fftSize, 0.25);
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

  const handleSeek = (targetTime: number) => {
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
      try {
        const spec = await computeSpectrogramFromFile(outPath, 0, undefined, fftSize, 0.25);
        setSpectrogramDataB(spec);
      } catch (_) {
        const pcm = buf.getChannelData(0);
        const spec = await computeSpectrogramFromPcm(pcm, buf.sampleRate, fftSize, 0.25);
        setSpectrogramDataB(spec);
      }

      // Automatically switch to Processed source B
      setActiveSource('B');
    }

    setIsProcessing(false);
  };

  // --- TOOL EXECUTION HANDLERS ---

  // 1. Run AI Denoise (Python UVR / Sidecar)
  const handleRunDenoise = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Запуск AI Шумоподавления (Python UVR)...');
    setProcessProgress(20);

    try {
      const outPath = createPrefixedAudioPath('denoise', filePath);
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

  // 2. Run AI Dereverb (Python UVR / Sidecar)
  const handleRunDereverb = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Запуск AI Подавления эха (Python UVR)...');
    setProcessProgress(20);

    try {
      const outPath = createPrefixedAudioPath('dereverb', filePath);
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

  // 3. Run De-Click (Устранение щелчков)
  const handleRunDeclick = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Устранение щелчков и артефактов речи (De-Click)...');
    setProcessProgress(25);

    try {
      const outPath = createPrefixedAudioPath('declick', filePath);
      const rep: any = await safeInvoke('clean_clicks', {
        inputWav: filePath,
        outputWav: outPath,
        sensitivity: declickSensitivity
      });

      const detected = rep?.clicks_detected ?? rep?.clicksDetected ?? 0;
      const restored = rep?.samples_restored ?? rep?.samplesRestored ?? 0;
      const reportStr = `De-Click завершен: устранено ${detected} щелчков, восстановлено ${restored} сэмплов (чувствительность: ${declickSensitivity}%).`;
      await updateProcessedResult(outPath, reportStr);
    } catch (e: any) {
      setIsProcessing(false);
      alert('Ошибка De-Click: ' + e.toString());
    }
  };

  // 4. Run De-Plosive (Подавление задувов П/Б/Т)
  const handleRunDeplosive = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Подавление задувов микрофона и взрывных согласных (De-Plosive)...');
    setProcessProgress(25);

    try {
      const outPath = createPrefixedAudioPath('deplosive', filePath);
      const rep: any = await safeInvoke('apply_deplosive', {
        filePath: filePath,
        outPath: outPath,
        thresholdDb: deplosiveThreshold
      });

      const maxRed = rep?.max_reduction_db ?? rep?.maxReductionDb ?? 0;
      const reportStr = `De-Plosive завершен: подавлены низкочастотные задувы (порог: ${deplosiveThreshold} dB, макс. срез: -${Number(maxRed).toFixed(1)} dB).`;
      await updateProcessedResult(outPath, reportStr);
    } catch (e: any) {
      setIsProcessing(false);
      alert('Ошибка De-Plosive: ' + e.toString());
    }
  };

  // 5. Run De-Esser (Подавление сибилянтов С/Ш)
  const handleRunDeesser = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Подавление резких сибилянтов и свистящих (De-Esser)...');
    setProcessProgress(25);

    try {
      const outPath = createPrefixedAudioPath('deesser', filePath);
      const rep: any = await safeInvoke('process_deesser', {
        inputPath: filePath,
        outputPath: outPath,
        frequency: deesserFrequency,
        threshold: deesserThreshold,
        ratio: deesserRatio
      });

      const maxRed = rep?.max_reduction_db ?? rep?.maxReductionDb ?? 0;
      const reportStr = `De-Esser применен: сжатие свистящих на ${deesserFrequency} Гц (порог: ${deesserThreshold} dB, макс. срез: -${Number(maxRed).toFixed(1)} dB).`;
      await updateProcessedResult(outPath, reportStr);
    } catch (e: any) {
      setIsProcessing(false);
      alert('Ошибка De-Esser: ' + e.toString());
    }
  };

  // 6. Run Volume Leveler (Выравнивание громкости речи)
  const handleRunVolumeLeveler = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Интеллектуальное выравнивание громкости речи (Volume Leveler)...');
    setProcessProgress(25);

    try {
      const outPath = createPrefixedAudioPath('leveler', filePath);
      await safeInvoke('level_speech_volume', {
        inputPath: filePath,
        outputPath: outPath,
        targetRms: levelerTargetRms,
        gateThresholdDb: levelerGateThreshold,
        maxBoostDb: levelerMaxBoost
      });

      const reportStr = `Volume Leveler завершен: Целевой уровень ${levelerTargetRms} dB RMS, макс. усиление +${levelerMaxBoost} dB. Речь сбалансирована.`;
      await updateProcessedResult(outPath, reportStr);
    } catch (e: any) {
      setIsProcessing(false);
      alert('Ошибка Volume Leveler: ' + e.toString());
    }
  };

  // 7. Run VAD Silence Cut
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

      const count = res?.segments?.length ?? res?.segmentsCount ?? 0;
      setVadResultSegments(count);
      setLastReport(`Silero VAD обнаружил ${count} речевых сегментов.`);
    } catch (e: any) {
      alert('Ошибка VAD: ' + e.toString());
    } finally {
      setIsProcessing(false);
    }
  };

  // 8. Run Normalization
  const handleRunNormalize = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Нормализация громкости (EBU R128)...');
    setProcessProgress(30);

    try {
      const outPath = createPrefixedAudioPath('norm', filePath);
      let reportStr = `Нормализация до ${targetLufs} LUFS завершена.`;

      try {
        const stats: any = await safeInvoke('normalize_audio', {
          inputPath: filePath,
          outputPath: outPath,
          targetLufs: targetLufs
        });
        if (stats && stats.final_lufs !== undefined) {
          const gainPrefix = stats.gain_applied_db > 0 ? '+' : '';
          reportStr = `Нормализация EBU R128: Итог ${stats.final_lufs.toFixed(1)} LUFS (Gain: ${gainPrefix}${stats.gain_applied_db.toFixed(1)} dB, True Peak: ${stats.final_true_peak_db.toFixed(1)} dBTP)`;
        }
      } catch (_e) {
        await safeInvoke('process_media_effect', {
          inputPath: filePath,
          outputPath: outPath,
          effectType: 'normalize',
          params: { targetLufs }
        });
      }

      await updateProcessedResult(outPath, reportStr);
    } catch (e: any) {
      setIsProcessing(false);
      alert('Ошибка нормализации: ' + e.toString());
    }
  };

  // 9. Run EQ & Compression
  const handleRunEqComp = async () => {
    if (!filePath) return;
    setIsProcessing(true);
    setProcessStage('Применение параметрического эквалайзера и компрессора...');
    setProcessProgress(40);

    try {
      const outPath = createPrefixedAudioPath('eq', filePath);
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
        await safeInvoke('copy_file', {
          src: processedPath,
          dest: savePath
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

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[200] flex items-center justify-center p-3 sm:p-5">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className="bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl w-full max-w-7xl h-[94vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 py-3.5 border-b border-white/10 bg-zinc-900/90 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Wrench className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                Отдельные инструменты
                <span className="text-[10px] font-extrabold uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded-full">
                  Спектральная лаборатория
                </span>
              </h2>
              <p className="text-xs text-zinc-400">Точечная обработка и синхронизированный анализ звуковой волны и спектрограммы</p>
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
              Загрузите любой WAV, MP3, FLAC или AAC файл, чтобы применить нейросетевое шумоподавление, устранение эха, удаление щелчков, деплосив, выравнивание громкости и эквалайзер с масштабируемой спектрограммой.
            </p>

            <div className="flex items-center gap-4">
              <button
                onClick={handleSelectFile}
                className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm rounded-xl transition-all shadow-lg shadow-indigo-600/30 flex items-center gap-2 cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                Выбрать файл через проводник
              </button>

              <label className="px-5 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold text-sm rounded-xl transition-all border border-white/5 flex items-center gap-2 cursor-pointer">
                <FileAudio className="w-4 h-4 text-indigo-400" />
                Из папки браузера
                <input
                  type="file"
                  accept="audio/*"
                  onChange={handleFileInputChange}
                  className="hidden"
                />
              </label>
            </div>
          </div>
        ) : (
          /* Active Processing Studio Workspace */
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
            {/* Left Column: Waveform, Spectrogram, A/B Transport Controls (7 cols) */}
            <div className="lg:col-span-7 flex flex-col p-4 border-r border-white/10 gap-3 overflow-y-auto custom-scrollbar">
              {/* Top Bar: File Info & A/B Toggle */}
              <div className="flex items-center justify-between bg-zinc-950 p-2.5 rounded-xl border border-white/5">
                <div className="flex items-center gap-2 truncate pr-2">
                  <FileAudio className="w-4 h-4 text-indigo-400 shrink-0" />
                  <span className="text-xs font-bold text-zinc-200 truncate">{fileName}</span>
                  <span className="text-[10px] text-zinc-500 font-mono">({duration.toFixed(2)} сек)</span>
                </div>

                {/* Seamless A / B Source Switcher */}
                <div className="flex items-center bg-zinc-900 p-1 rounded-lg border border-white/10 shrink-0">
                  <button
                    onClick={() => handleToggleAB('A')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                      activeSource === 'A'
                        ? 'bg-indigo-600 text-white shadow-md'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-indigo-400" />
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
              <div className="bg-zinc-900/60 border border-white/5 rounded-xl p-2.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={togglePlay}
                    className="w-10 h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center transition-all shadow-lg shadow-indigo-600/30 cursor-pointer"
                  >
                    {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
                  </button>

                  <button
                    onClick={stopPlayback}
                    className="p-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-all cursor-pointer"
                    title="Стоп"
                  >
                    <Square className="w-4 h-4" />
                  </button>

                  <button
                    onClick={() => setIsLooping(!isLooping)}
                    className={`p-2.5 rounded-xl transition-all cursor-pointer ${
                      isLooping ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/40' : 'bg-zinc-800 text-zinc-400 hover:text-white'
                    }`}
                    title="Зациклить воспроизведение"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>

                {/* Time Display */}
                <div className="font-mono text-xs sm:text-sm font-bold text-white bg-zinc-950 px-3 py-1.5 rounded-lg border border-white/5">
                  <span className="text-indigo-400">{formatTime(currentTime)}</span>
                  <span className="text-zinc-600 mx-1.5">/</span>
                  <span className="text-zinc-400">{formatTime(duration)}</span>
                </div>
              </div>

              {/* Synchronized Visualizer (Waveform + Spectrogram with Linked Zoom & Frequency Zoom) */}
              <SynchronizedAudioVisualizer
                originalBuffer={originalBuffer}
                processedBuffer={processedBuffer}
                activeSource={activeSource}
                spectrogramDataA={spectrogramDataA}
                spectrogramDataB={spectrogramDataB}
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                onSeek={handleSeek}
                palette={palette}
                onPaletteChange={setPalette}
              />

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
                        className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold transition-all text-[11px] flex items-center gap-1.5 shadow-md cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Сделать исходником
                      </button>

                      <button
                        onClick={handleExportResult}
                        className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold transition-all text-[11px] flex items-center gap-1.5 shadow-md cursor-pointer"
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
                  onClick={() => setActiveCategory('restoration')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                    activeCategory === 'restoration' ? 'bg-indigo-600 text-white shadow-md' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Реставрация
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
                  Мастеринг & VAD
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

              {/* CATEGORY 1: RESTORATION & CLEANUP */}
              {activeCategory === 'restoration' && (
                <div className="space-y-4">
                  {/* 1. AI Denoise Tool Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold text-xs text-white">
                        <Sparkles className="w-4 h-4 text-indigo-400" />
                        AI Шумоподавление (Python UVR Sidecar)
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">VR / MDX Architecture</span>
                    </div>

                    <div className="space-y-2">
                      <ModelSelector
                        category="denoise"
                        label="Модель ИИ:"
                        value={denoiseModel}
                        onChange={(val) => setDenoiseModel(val)}
                        builtInOptions={[
                          { id: 'spectral_gate', name: 'Спектральный гейт (AFFTDN - DSP)' }
                        ]}
                      />
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

                  {/* 2. AI Dereverb Tool Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold text-xs text-white">
                        <Flame className="w-4 h-4 text-amber-400" />
                        AI Подавление эха (Python UVR Sidecar)
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">De-Reverb HQ</span>
                    </div>

                    <div className="space-y-2">
                      <ModelSelector
                        category="dereverb"
                        label="Модель ИИ:"
                        value={dereverbModel}
                        onChange={(val) => setDereverbModel(val)}
                        builtInOptions={[
                          { id: 'rt_dereverb_v2', name: 'RT_Dereverb v2 (DSP спектральное вычитание)' }
                        ]}
                      />
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

                  {/* 3. De-Click Tool Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold text-xs text-white">
                        <CheckSquare className="w-4 h-4 text-emerald-400" />
                        Устранение щелчков (De-Click)
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">LPC Interpolator</span>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>Чувствительность обнаружения щелчков:</span>
                        <span className="font-bold text-emerald-400 font-mono">{declickSensitivity}%</span>
                      </div>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        value={declickSensitivity}
                        onChange={(e) => setDeclickSensitivity(Number(e.target.value))}
                        className="w-full accent-emerald-500"
                      />
                      <p className="text-[10px] text-zinc-500">
                        Устраняет клики слюны, импульсные щелчки рта и короткие помехи микрофона с интерполяцией.
                      </p>
                    </div>

                    <button
                      onClick={handleRunDeclick}
                      disabled={isProcessing}
                      className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-emerald-600/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <CheckSquare className="w-4 h-4" />
                      Устранить щелчки (De-Click)
                    </button>
                  </div>

                  {/* 4. De-Plosive Tool Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold text-xs text-white">
                        <ShieldCheck className="w-4 h-4 text-rose-400" />
                        Подавление задувов (De-Plosive)
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">Dynamic Sub-Bass</span>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>Порог срабатывания задувов (Threshold):</span>
                        <span className="font-bold text-rose-400 font-mono">{deplosiveThreshold} dB</span>
                      </div>
                      <input
                        type="range"
                        min="-40"
                        max="-10"
                        step="1"
                        value={deplosiveThreshold}
                        onChange={(e) => setDeplosiveThreshold(Number(e.target.value))}
                        className="w-full accent-rose-500"
                      />
                      <p className="text-[10px] text-zinc-500">
                        Устраняет резкие взрывные согласные «П», «Б», «Т» и задувы капсюля микрофона.
                      </p>
                    </div>

                    <button
                      onClick={handleRunDeplosive}
                      disabled={isProcessing}
                      className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-rose-600/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      Подавить задувы (De-Plosive)
                    </button>
                  </div>

                  {/* 5. De-Esser Tool Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold text-xs text-white">
                        <Mic className="w-4 h-4 text-cyan-400" />
                        Диэссер сибилянтов (De-Esser)
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">Sidechain Bandpass</span>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>Центральная частота:</span>
                        <span className="font-mono text-cyan-400 font-bold">{deesserFrequency} Гц</span>
                      </div>
                      <input
                        type="range"
                        min="3000"
                        max="9000"
                        step="100"
                        value={deesserFrequency}
                        onChange={(e) => setDeesserFrequency(Number(e.target.value))}
                        className="w-full accent-cyan-500"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                          <span>Порог (dB):</span>
                          <span className="font-mono text-cyan-400 font-bold">{deesserThreshold}</span>
                        </div>
                        <input
                          type="range"
                          min="-35"
                          max="-10"
                          value={deesserThreshold}
                          onChange={(e) => setDeesserThreshold(Number(e.target.value))}
                          className="w-full accent-cyan-500"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                          <span>Сжатие (Ratio):</span>
                          <span className="font-mono text-cyan-400 font-bold">{deesserRatio}:1</span>
                        </div>
                        <input
                          type="range"
                          min="2"
                          max="8"
                          step="0.5"
                          value={deesserRatio}
                          onChange={(e) => setDeesserRatio(Number(e.target.value))}
                          className="w-full accent-cyan-500"
                        />
                      </div>
                    </div>

                    <button
                      onClick={handleRunDeesser}
                      disabled={isProcessing}
                      className="w-full py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-cyan-600/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Mic className="w-4 h-4" />
                      Применить Диэссер
                    </button>
                  </div>
                </div>
              )}

              {/* CATEGORY 2: EQ & DYNAMICS */}
              {activeCategory === 'eq_dynamics' && (
                <div className="space-y-4">
                  {/* Volume Leveler Tool Box */}
                  <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold text-xs text-white">
                        <Gauge className="w-4 h-4 text-amber-400" />
                        Выравнивание громкости речи (Volume Leveler)
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">Dynamic RMS AGC</span>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>Целевая средняя громкость речи (Target RMS):</span>
                        <span className="font-mono text-amber-400 font-bold">{levelerTargetRms} dB</span>
                      </div>
                      <input
                        type="range"
                        min="-28"
                        max="-12"
                        step="0.5"
                        value={levelerTargetRms}
                        onChange={(e) => setLevelerTargetRms(Number(e.target.value))}
                        className="w-full accent-amber-500"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                          <span>Макс. усиление:</span>
                          <span className="font-mono text-amber-400 font-bold">+{levelerMaxBoost} dB</span>
                        </div>
                        <input
                          type="range"
                          min="3"
                          max="18"
                          value={levelerMaxBoost}
                          onChange={(e) => setLevelerMaxBoost(Number(e.target.value))}
                          className="w-full accent-amber-500"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                          <span>Порог гейта:</span>
                          <span className="font-mono text-amber-400 font-bold">{levelerGateThreshold} dB</span>
                        </div>
                        <input
                          type="range"
                          min="-60"
                          max="-35"
                          value={levelerGateThreshold}
                          onChange={(e) => setLevelerGateThreshold(Number(e.target.value))}
                          className="w-full accent-amber-500"
                        />
                      </div>
                    </div>

                    <button
                      onClick={handleRunVolumeLeveler}
                      disabled={isProcessing}
                      className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-all shadow-md shadow-amber-600/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Gauge className="w-4 h-4" />
                      Выровнять громкость речи
                    </button>
                  </div>

                  {/* Parametric EQ Settings */}
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

              {/* CATEGORY 3: MASTERING & VAD */}
              {activeCategory === 'mastering' && (
                <div className="space-y-4">
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
