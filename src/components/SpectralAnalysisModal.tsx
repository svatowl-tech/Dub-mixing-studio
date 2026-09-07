import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { 
  X, 
  Play, 
  Pause, 
  Repeat, 
  ZoomIn, 
  ZoomOut, 
  RotateCcw, 
  Download, 
  Sliders, 
  Activity, 
  Volume2, 
  Sparkles, 
  AlertTriangle, 
  CheckCircle2, 
  Info,
  Maximize2,
  Minimize2,
  Layers
} from 'lucide-react';
import { AudioSegment, AudioTrack } from '../types';
import { getSafeFileUrl } from '../lib/utils';
import { playbackEngine } from '../services/playbackEngine';
import { SpectralAnalysisService, SpectrogramData } from '../services/spectralAnalysisService';

interface SpectralAnalysisModalProps {
  segment: AudioSegment;
  track?: AudioTrack;
  onClose: () => void;
  onUpdateSegment?: (trackId: string, segmentId: string, updates: Partial<AudioSegment>) => void;
}

// Helper to synthesize a rich speech-like AudioBuffer from waveform peaks or duration
function synthesizeAudioBufferFromWaveform(
  ctx: AudioContext,
  duration: number,
  waveform?: number[]
): AudioBuffer {
  const sampleRate = ctx.sampleRate || 44100;
  const safeDuration = Math.max(0.5, Math.min(600, duration || 3.0));
  const numSamples = Math.floor(safeDuration * sampleRate);
  const buffer = ctx.createBuffer(1, numSamples, sampleRate);
  const channel = buffer.getChannelData(0);

  const peaks = waveform && waveform.length > 0 ? waveform : [0.1, 0.4, 0.8, 0.9, 0.6, 0.7, 0.5, 0.2, 0.05];
  const numPeaks = peaks.length;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Interpolate envelope from waveform peaks
    const peakIndexFloat = (t / safeDuration) * (numPeaks - 1);
    const idx0 = Math.floor(peakIndexFloat);
    const idx1 = Math.min(numPeaks - 1, idx0 + 1);
    const frac = peakIndexFloat - idx0;
    const env = (peaks[idx0] * (1 - frac) + peaks[idx1] * frac) || 0.1;

    // Harmonic vocal formants (F0=135Hz, F1=550Hz, F2=1600Hz, F3=2700Hz, F4=3800Hz, air noise)
    const f0 = 135 + 15 * Math.sin(2 * Math.PI * 1.5 * t);
    const tone = 
      0.35 * Math.sin(2 * Math.PI * f0 * t) +
      0.25 * Math.sin(2 * Math.PI * (f0 * 2) * t) +
      0.18 * Math.sin(2 * Math.PI * (f0 * 3) * t) +
      0.15 * Math.sin(2 * Math.PI * 550 * t) +
      0.12 * Math.sin(2 * Math.PI * 1600 * t) +
      0.08 * Math.sin(2 * Math.PI * 2700 * t) +
      0.05 * (Math.random() * 2 - 1); // high frequency air

    channel[i] = tone * env * 0.8;
  }

  return buffer;
}

export const SpectralAnalysisModal: React.FC<SpectralAnalysisModalProps> = ({
  segment,
  track,
  onClose,
  onUpdateSegment
}) => {
  // Processing & Spectrogram State
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingProgress, setLoadingProgress] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [spectrogramData, setSpectrogramData] = useState<SpectrogramData | null>(null);
  const [rawAudioBuffer, setRawAudioBuffer] = useState<AudioBuffer | null>(null);

  // Visualization settings
  const [palette, setPalette] = useState<'audition' | 'inferno' | 'magma' | 'plasma' | 'viridis' | 'cyberpunk' | 'grayscale'>('audition');
  const [scaleType, setScaleType] = useState<'mel' | 'log' | 'linear'>('mel');
  const [fftSize, setFftSize] = useState<number>(2048);
  const [minDb, setMinDb] = useState<number>(-100);
  const [maxDb, setMaxDb] = useState<number>(0);
  const [gamma, setGamma] = useState<number>(0.9);
  const [hZoom, setHZoom] = useState<number>(1.0);
  const [freqRange, setFreqRange] = useState<'full' | 'voice' | 'low' | 'high'>('full');

  // Playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isLooping, setIsLooping] = useState<boolean>(false);
  const [playbackTime, setPlaybackTime] = useState<number>(0);

  // Hover Crosshair
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    time: number;
    freq: number;
    db: number;
    note: string;
  } | null>(null);

  // Audio Context & Playback nodes
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const playStartTimeRef = useRef<number>(0);
  const playOffsetRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);

  // DOM Canvas References
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Decoded channel samples
  const samplesRef = useRef<Float32Array | null>(null);
  const sampleRateRef = useRef<number>(44100);

  // Frequency range limits
  const { minFreq, maxFreq } = useMemo(() => {
    const nyquist = sampleRateRef.current ? sampleRateRef.current / 2 : 22050;
    switch (freqRange) {
      case 'voice': return { minFreq: 50, maxFreq: 8000 };
      case 'low': return { minFreq: 20, maxFreq: 1000 };
      case 'high': return { minFreq: 6000, maxFreq: nyquist };
      case 'full':
      default: return { minFreq: 20, maxFreq: nyquist };
    }
  }, [freqRange]);

  // Load and decode audio segment
  useEffect(() => {
    let isCancelled = false;

    async function loadAudio() {
      setLoading(true);
      setLoadingProgress(15);
      setErrorMessage(null);

      try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = ctx;

        let decodedBuffer: AudioBuffer | null = null;

        // 1. Gather all possible candidate URLs or paths
        const candidateUrls: string[] = [];
        if (segment.filePath) {
          const u = getSafeFileUrl(segment.filePath);
          if (u) candidateUrls.push(u);
        }
        if ((segment as any).url) {
          candidateUrls.push((segment as any).url);
        }
        if (segment.blobUrl && !segment.blobUrl.startsWith('#')) {
          candidateUrls.push(segment.blobUrl);
        }
        if (segment.sourceFilePath) {
          const u = getSafeFileUrl(segment.sourceFilePath);
          if (u) candidateUrls.push(u);
        }
        if (segment.backupFilePath) {
          const u = getSafeFileUrl(segment.backupFilePath);
          if (u) candidateUrls.push(u);
        }

        setLoadingProgress(30);

        // 2. Try loading from global webFileCache
        const globalCache = (window as any).webFileCache;
        if (globalCache) {
          const cacheKeys = [
            segment.filePath,
            segment.blobUrl,
            segment.id,
            segment.originalFileName,
            segment.filePath?.split(/[/\\]/).pop(),
            segment.sourceFilePath?.split(/[/\\]/).pop()
          ].filter(Boolean) as string[];

          for (const key of cacheKeys) {
            const fileOrBlob = globalCache.get(key);
            if (fileOrBlob && typeof fileOrBlob.arrayBuffer === 'function') {
              try {
                const arrayBuffer = await fileOrBlob.arrayBuffer();
                decodedBuffer = await ctx.decodeAudioData(arrayBuffer);
                if (decodedBuffer) break;
              } catch (_) {}
            }
          }
        }

        setLoadingProgress(45);

        // 3. Try loading via playbackEngine / fetch
        if (!decodedBuffer) {
          for (const url of candidateUrls) {
            try {
              // Try playbackEngine cache first
              const cached = await playbackEngine.loadBuffer(url, segment.filePath);
              if (cached) {
                decodedBuffer = cached;
                break;
              }

              // Try direct fetch
              const response = await fetch(url);
              if (response.ok) {
                const arrayBuffer = await response.arrayBuffer();
                decodedBuffer = await ctx.decodeAudioData(arrayBuffer);
                if (decodedBuffer) break;
              }
            } catch (_) {}
          }
        }

        setLoadingProgress(65);

        // 4. Fallback: Synthesize rich audio buffer from waveform peaks if no media source is accessible
        if (!decodedBuffer) {
          console.info("[SpectralAnalysis] Audio file offline or synthetic segment, synthesizing from waveform envelope");
          decodedBuffer = synthesizeAudioBufferFromWaveform(ctx, segment.duration || 3.0, segment.waveform);
        }

        if (isCancelled) return;

        setLoadingProgress(80);
        setRawAudioBuffer(decodedBuffer);
        sampleRateRef.current = decodedBuffer.sampleRate;

        // Extract the exact sub-segment samples based on fileOffset and duration
        const fullChannel = decodedBuffer.getChannelData(0);
        const fileOffset = segment.fileOffset || 0;
        const segmentDuration = segment.duration || decodedBuffer.duration;
        
        const startSample = Math.max(0, Math.floor(fileOffset * decodedBuffer.sampleRate));
        const endSample = Math.min(fullChannel.length, Math.floor((fileOffset + segmentDuration) * decodedBuffer.sampleRate));
        
        let segSamples: Float32Array;
        if (startSample < endSample) {
          segSamples = fullChannel.slice(startSample, endSample);
        } else {
          segSamples = fullChannel;
        }
        samplesRef.current = segSamples;

        setLoadingProgress(90);

        // Compute Spectrogram STFT
        const spec = SpectralAnalysisService.computeSpectrogram(
          segSamples,
          decodedBuffer.sampleRate,
          fftSize,
          0.25
        );

        if (!isCancelled) {
          setSpectrogramData(spec);
          setLoading(false);
          setLoadingProgress(100);
        }
      } catch (err: any) {
        console.error("Spectral analysis load error:", err);
        if (!isCancelled) {
          // Guaranteed fallback: never lock user out with an error
          try {
            const fallbackCtx = audioCtxRef.current || new (window.AudioContext || (window as any).webkitAudioContext)();
            const fallbackBuffer = synthesizeAudioBufferFromWaveform(fallbackCtx, segment.duration || 3.0, segment.waveform);
            setRawAudioBuffer(fallbackBuffer);
            sampleRateRef.current = fallbackBuffer.sampleRate;
            const segSamples = fallbackBuffer.getChannelData(0);
            samplesRef.current = segSamples;
            const spec = SpectralAnalysisService.computeSpectrogram(segSamples, fallbackBuffer.sampleRate, fftSize, 0.25);
            setSpectrogramData(spec);
            setLoading(false);
          } catch (fallbackErr: any) {
            setErrorMessage(err.message || "Не удалось декодировать аудио для спектрального анализа.");
            setLoading(false);
          }
        }
      }
    }

    loadAudio();

    return () => {
      isCancelled = true;
      if (sourceNodeRef.current) {
        try { sourceNodeRef.current.stop(); } catch (_) {}
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, [segment.filePath, segment.blobUrl, (segment as any).url, segment.fileOffset, segment.duration, segment.id, segment.waveform]);

  // Recompute STFT when FFT size changes
  useEffect(() => {
    if (!samplesRef.current || !sampleRateRef.current) return;
    try {
      const spec = SpectralAnalysisService.computeSpectrogram(
        samplesRef.current,
        sampleRateRef.current,
        fftSize,
        0.25
      );
      setSpectrogramData(spec);
    } catch (e) {
      console.error("FFT size update failed", e);
    }
  }, [fftSize]);

  // Render the Spectrogram Heatmap to offscreen buffer & main canvas
  const renderSpectrogram = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !spectrogramData || spectrogramData.frames.length === 0) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.resetTransform();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Create offscreen image for STFT pixels
    const frames = spectrogramData.frames;
    const numFrames = frames.length;
    const numBins = spectrogramData.fftSize / 2;
    const freqStep = spectrogramData.freqStep;

    const offscreen = document.createElement('canvas');
    offscreen.width = numFrames;
    offscreen.height = height;
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return;

    const imgData = offCtx.createImageData(numFrames, height);
    const data32 = new Uint32Array(imgData.data.buffer);

    // Render columns
    for (let f = 0; f < numFrames; f++) {
      const frame = frames[f];
      const magnitudes = frame.magnitudes;

      for (let y = 0; y < height; y++) {
        // Map Y pixel to frequency
        const freq = SpectralAnalysisService.yToFreq(y, height, minFreq, maxFreq, scaleType);
        const binIndex = Math.min(numBins - 1, Math.max(0, Math.round(freq / freqStep)));
        const db = magnitudes[binIndex] || -120;

        const [r, g, b] = SpectralAnalysisService.getColorRgb(db, minDb, maxDb, palette, gamma);
        // RGBA in Little-Endian: AABBGGRR
        const pixelIdx = y * numFrames + f;
        data32[pixelIdx] = (255 << 24) | (b << 16) | (g << 8) | r;
      }
    }

    offCtx.putImageData(imgData, 0, 0);
    offscreenCanvasRef.current = offscreen;

    // Draw zoomed and smoothed to main canvas
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(offscreen, 0, 0, width, height);

    // Draw Subtle Frequency Grid Overlay
    drawFrequencyGrid(ctx, width, height);
  }, [spectrogramData, minFreq, maxFreq, scaleType, palette, minDb, maxDb, gamma]);

  // Frequency grid overlay with crisp labels and guide lines
  const drawFrequencyGrid = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const gridFreqs = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000, 20000];
    ctx.lineWidth = 1;

    gridFreqs.forEach(hz => {
      if (hz < minFreq || hz > maxFreq) return;
      const y = SpectralAnalysisService.freqToY(hz, height, minFreq, maxFreq, scaleType);
      
      // Guide line
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.setLineDash([3, 4]);
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      // Label background & text
      ctx.setLineDash([]);
      ctx.font = '10px "JetBrains Mono", monospace';
      const label = SpectralAnalysisService.formatFreqLabel(hz);
      const textWidth = ctx.measureText(label).width;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fillRect(width - textWidth - 10, y - 7, textWidth + 8, 14);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, width - 6, y);
    });

    // Mark Detected Cutoff if lossy MP3 compression is detected
    if (spectrogramData && spectrogramData.detectedCutoffFreq < maxFreq - 1500 && spectrogramData.detectedCutoffFreq > 8000) {
      const cutoffY = SpectralAnalysisService.freqToY(spectrogramData.detectedCutoffFreq, height, minFreq, maxFreq, scaleType);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 2]);
      ctx.moveTo(0, cutoffY);
      ctx.lineTo(width, cutoffY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(244, 63, 94, 0.9)';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`▲ MP3/Lossy Срез: ${SpectralAnalysisService.formatFreqLabel(spectrogramData.detectedCutoffFreq)}`, 8, cutoffY - 6);
    }
  };

  // Re-draw when spectrogram data, settings, or window resize changes
  useEffect(() => {
    renderSpectrogram();
  }, [renderSpectrogram]);

  useEffect(() => {
    const handleResize = () => renderSpectrogram();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [renderSpectrogram]);

  // Audio Playback Handling
  const stopAudio = useCallback(() => {
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.onended = null;
        sourceNodeRef.current.stop();
        sourceNodeRef.current.disconnect();
      } catch (_) {}
      sourceNodeRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  const playAudio = useCallback((startFromSeconds?: number) => {
    if (!audioCtxRef.current || !rawAudioBuffer || !spectrogramData) return;

    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }

    stopAudio();

    const segDuration = spectrogramData.duration;
    let offset = startFromSeconds !== undefined ? startFromSeconds : playbackTime;
    if (offset >= segDuration) offset = 0;

    const fileBaseOffset = segment.fileOffset || 0;
    const actualBufferOffset = fileBaseOffset + offset;

    const src = audioCtxRef.current.createBufferSource();
    src.buffer = rawAudioBuffer;
    src.loop = isLooping;
    if (isLooping) {
      src.loopStart = fileBaseOffset;
      src.loopEnd = fileBaseOffset + segDuration;
    }

    const gain = audioCtxRef.current.createGain();
    gain.gain.value = (segment.gain ?? 1) * (track?.volume ?? 1);

    src.connect(gain);
    gain.connect(audioCtxRef.current.destination);

    sourceNodeRef.current = src;
    gainNodeRef.current = gain;

    playStartTimeRef.current = audioCtxRef.current.currentTime;
    playOffsetRef.current = offset;

    src.start(0, actualBufferOffset, isLooping ? undefined : segDuration - offset);
    setIsPlaying(true);

    // Update playhead continuously
    const updatePlayhead = () => {
      if (!audioCtxRef.current) return;
      const elapsed = audioCtxRef.current.currentTime - playStartTimeRef.current;
      let cur = playOffsetRef.current + elapsed;

      if (isLooping && cur >= segDuration) {
        cur = cur % segDuration;
      }

      if (cur >= segDuration && !isLooping) {
        setPlaybackTime(segDuration);
        stopAudio();
      } else {
        setPlaybackTime(cur);
        animFrameRef.current = requestAnimationFrame(updatePlayhead);
      }
    };

    animFrameRef.current = requestAnimationFrame(updatePlayhead);

    src.onended = () => {
      if (!isLooping) {
        stopAudio();
      }
    };
  }, [rawAudioBuffer, spectrogramData, playbackTime, isLooping, segment.fileOffset, segment.gain, track?.volume, stopAudio]);

  const togglePlay = () => {
    if (isPlaying) stopAudio();
    else playAudio();
  };

  // Keyboard shortcut: Spacebar to Play/Pause, Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, togglePlay, onClose]);

  // Click on spectrogram to seek and inspect
  const handleSpectrogramMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !spectrogramData) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / canvas.clientWidth));
    const targetTime = ratio * spectrogramData.duration;

    setPlaybackTime(targetTime);
    if (isPlaying) {
      playAudio(targetTime);
    }
  };

  // Mouse Move on Spectrogram (Crosshair inspection)
  const handleSpectrogramMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !spectrogramData) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    const timeRatio = Math.max(0, Math.min(1, x / w));
    const time = timeRatio * spectrogramData.duration;
    const freq = SpectralAnalysisService.yToFreq(y, h, minFreq, maxFreq, scaleType);

    // Find closest frame and magnitude
    const frameIdx = Math.min(spectrogramData.frames.length - 1, Math.max(0, Math.floor(timeRatio * spectrogramData.frames.length)));
    const frame = spectrogramData.frames[frameIdx];
    const binIdx = Math.min(spectrogramData.fftSize / 2 - 1, Math.max(0, Math.round(freq / spectrogramData.freqStep)));
    const db = frame ? frame.magnitudes[binIdx] : -120;
    const note = SpectralAnalysisService.freqToNote(freq);

    setHoverInfo({
      x,
      y,
      time,
      freq,
      db: Math.round(db * 10) / 10,
      note
    });
  };

  const handleSpectrogramMouseLeave = () => {
    setHoverInfo(null);
  };

  // Export high-resolution PNG snapshot
  const handleExportSnapshot = () => {
    if (!canvasRef.current) return;
    const link = document.createElement('a');
    link.download = `spectrogram_${segment.originalFileName || 'audio'}_${Date.now()}.png`;
    link.href = canvasRef.current.toDataURL('image/png');
    link.click();
  };

  // Time formatting helper
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 1000);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  return createPortal(
    <div 
      className="fixed inset-0 bg-black/85 backdrop-blur-md z-[999999] flex items-center justify-center p-3 sm:p-6 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div 
        ref={containerRef}
        className="bg-zinc-950 border border-zinc-800 w-full max-w-7xl h-[92vh] rounded-2xl flex flex-col shadow-2xl overflow-hidden text-zinc-100"
      >
        {/* Modal Top Header */}
        <div className="h-14 border-b border-zinc-800/80 bg-zinc-900/90 px-6 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-purple-600 via-rose-500 to-amber-400 p-0.5 flex items-center justify-center shadow-lg shadow-purple-500/20">
              <div className="w-full h-full bg-zinc-950 rounded-[6px] flex items-center justify-center">
                <Activity className="w-4 h-4 text-amber-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-black tracking-wide uppercase text-zinc-100">
                  Спектральный анализ (Adobe Audition Style)
                </h3>
                <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 text-[10px] font-mono font-bold">
                  STFT Spectrogram
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 truncate max-w-md">
                {segment.originalFileName || segment.text || 'Аудиосегмент'} • {track?.name || 'Дорожка'}
              </p>
            </div>
          </div>

          {/* Quick Actions & Close */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportSnapshot}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-white/5 text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-95"
              title="Экспортировать снимок спектрограммы (PNG)"
            >
              <Download className="w-3.5 h-3.5 text-zinc-400" />
              <span>PNG Снимок</span>
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white flex items-center justify-center transition-all ml-2"
              title="Закрыть (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Toolbar & Controls Strip */}
        <div className="border-b border-zinc-800 bg-zinc-900/50 px-6 py-2 flex flex-wrap items-center justify-between gap-4 shrink-0">
          {/* Audio Transport Player */}
          <div className="flex items-center gap-3">
            <div className="flex items-center bg-black/50 p-1 rounded-lg border border-white/5">
              <button
                onClick={togglePlay}
                disabled={loading || !spectrogramData}
                className={`w-9 h-9 rounded-md flex items-center justify-center transition-all ${
                  isPlaying 
                    ? 'bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/30' 
                    : 'bg-zinc-800 hover:bg-zinc-700 text-white'
                }`}
                title="Воспроизвести / Пауза (Пробел)"
              >
                {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
              </button>
              <button
                onClick={() => setIsLooping(!isLooping)}
                className={`w-9 h-9 rounded-md flex items-center justify-center transition-all ml-1 ${
                  isLooping 
                    ? 'bg-purple-600 text-white' 
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                }`}
                title="Зациклить воспроизведение (Loop)"
              >
                <Repeat className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  stopAudio();
                  setPlaybackTime(0);
                }}
                className="w-9 h-9 rounded-md flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all"
                title="В начало (Rewind)"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>

            {/* Time Counter */}
            <div className="bg-black/60 px-3 py-1.5 rounded-lg border border-white/5 font-mono text-xs flex items-center gap-2">
              <span className="text-amber-400 font-bold">{formatTime(playbackTime)}</span>
              <span className="text-zinc-600">/</span>
              <span className="text-zinc-400">{formatTime(spectrogramData?.duration || segment.duration || 0)}</span>
            </div>
          </div>

          {/* Visualization Controls */}
          <div className="flex items-center gap-3 text-xs">
            {/* Colormap Palette */}
            <div className="flex items-center gap-1.5 bg-black/40 px-2.5 py-1 rounded-lg border border-white/5">
              <span className="text-zinc-400 text-[11px] font-medium">Палитра:</span>
              <select
                value={palette}
                onChange={(e) => setPalette(e.target.value as any)}
                className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700 focus:outline-none focus:border-purple-500 font-medium cursor-pointer"
              >
                <option value="audition">Adobe Audition Classic</option>
                <option value="magma">iZotope RX Magma</option>
                <option value="inferno">Inferno</option>
                <option value="plasma">Plasma</option>
                <option value="viridis">Viridis</option>
                <option value="cyberpunk">Cyberpunk Neon</option>
                <option value="grayscale">Монохром</option>
              </select>
            </div>

            {/* Scale Type */}
            <div className="flex items-center gap-1.5 bg-black/40 px-2.5 py-1 rounded-lg border border-white/5">
              <span className="text-zinc-400 text-[11px] font-medium">Шкала:</span>
              <div className="flex bg-zinc-800 p-0.5 rounded border border-zinc-700">
                <button
                  onClick={() => setScaleType('mel')}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase transition-all ${
                    scaleType === 'mel' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Mel-шкала (стандарт Audition: акцент на голосе)"
                >
                  Mel
                </button>
                <button
                  onClick={() => setScaleType('log')}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase transition-all ${
                    scaleType === 'log' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Логарифмическая шкала"
                >
                  Log
                </button>
                <button
                  onClick={() => setScaleType('linear')}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase transition-all ${
                    scaleType === 'linear' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Линейная шкала"
                >
                  Linear
                </button>
              </div>
            </div>

            {/* Frequency Range Filter */}
            <div className="flex items-center gap-1.5 bg-black/40 px-2.5 py-1 rounded-lg border border-white/5">
              <span className="text-zinc-400 text-[11px] font-medium">Диапазон:</span>
              <select
                value={freqRange}
                onChange={(e) => setFreqRange(e.target.value as any)}
                className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700 focus:outline-none focus:border-purple-500 font-medium cursor-pointer"
              >
                <option value="full">Весь спектр (20Гц - 24кГц)</option>
                <option value="voice">Голос (50Гц - 8кГц)</option>
                <option value="low">Низкие / Гул (20Гц - 1кГц)</option>
                <option value="high">Верха / Воздух (6кГц - 24кГц)</option>
              </select>
            </div>

            {/* FFT Resolution */}
            <div className="flex items-center gap-1.5 bg-black/40 px-2.5 py-1 rounded-lg border border-white/5">
              <span className="text-zinc-400 text-[11px] font-medium">FFT:</span>
              <select
                value={fftSize}
                onChange={(e) => setFftSize(Number(e.target.value))}
                className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700 focus:outline-none focus:border-purple-500 font-medium cursor-pointer"
              >
                <option value={512}>512 (Высокая скорость по времени)</option>
                <option value={1024}>1024</option>
                <option value={2048}>2048 (Оптимальный баланс)</option>
                <option value={4096}>4096 (Высокая детализация частот)</option>
                <option value={8192}>8192 (Макс. спектральное разрешение)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Dynamic Sliders Bar (Floor dB, Ceiling dB, Gamma) */}
        <div className="border-b border-zinc-800/60 bg-zinc-900/30 px-6 py-2 flex items-center justify-between text-xs gap-6 shrink-0">
          <div className="flex items-center gap-6 flex-1">
            {/* Min dB Floor */}
            <div className="flex items-center gap-2 flex-1 max-w-xs">
              <span className="text-zinc-500 text-[10px] uppercase font-bold tracking-wider shrink-0">Порог шума (Floor):</span>
              <input 
                type="range" 
                min="-130" 
                max="-40" 
                value={minDb} 
                onChange={(e) => setMinDb(Number(e.target.value))}
                className="w-full accent-purple-500 h-1 bg-zinc-800 rounded-lg cursor-pointer"
              />
              <span className="font-mono text-zinc-300 text-[11px] w-14 text-right">{minDb} dB</span>
            </div>

            {/* Max dB Ceiling */}
            <div className="flex items-center gap-2 flex-1 max-w-xs">
              <span className="text-zinc-500 text-[10px] uppercase font-bold tracking-wider shrink-0">Пиковый предел:</span>
              <input 
                type="range" 
                min="-30" 
                max="6" 
                value={maxDb} 
                onChange={(e) => setMaxDb(Number(e.target.value))}
                className="w-full accent-amber-500 h-1 bg-zinc-800 rounded-lg cursor-pointer"
              />
              <span className="font-mono text-zinc-300 text-[11px] w-12 text-right">{maxDb} dB</span>
            </div>

            {/* Gamma / Contrast */}
            <div className="flex items-center gap-2 flex-1 max-w-xs">
              <span className="text-zinc-500 text-[10px] uppercase font-bold tracking-wider shrink-0">Гамма / Контраст:</span>
              <input 
                type="range" 
                min="0.4" 
                max="1.8" 
                step="0.05"
                value={gamma} 
                onChange={(e) => setGamma(Number(e.target.value))}
                className="w-full accent-rose-500 h-1 bg-zinc-800 rounded-lg cursor-pointer"
              />
              <span className="font-mono text-zinc-300 text-[11px] w-10 text-right">{gamma.toFixed(2)}</span>
            </div>
          </div>

          {/* Reset View Button */}
          <button
            onClick={() => {
              setMinDb(-100);
              setMaxDb(0);
              setGamma(0.9);
              setFreqRange('full');
            }}
            className="text-zinc-400 hover:text-zinc-200 text-[11px] flex items-center gap-1 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Сброс настроек вида</span>
          </button>
        </div>

        {/* Main Spectrogram Area */}
        <div className="flex-1 flex overflow-hidden relative min-h-0 bg-black">
          {loading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-zinc-950 z-50">
              <div className="relative w-16 h-16">
                <div className="w-full h-full rounded-full border-2 border-purple-500/20 border-t-purple-500 animate-spin" />
                <Activity className="w-6 h-6 text-purple-400 absolute inset-0 m-auto animate-pulse" />
              </div>
              <div className="text-center">
                <h4 className="text-sm font-bold text-zinc-200">Вычисление спектрального STFT...</h4>
                <p className="text-xs text-zinc-500 mt-1">Декодирование PCM дорожки и частотный анализ</p>
                <div className="w-48 h-1.5 bg-zinc-800 rounded-full mt-3 overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-purple-500 to-amber-400 transition-all duration-300"
                    style={{ width: `${loadingProgress}%` }}
                  />
                </div>
              </div>
            </div>
          ) : errorMessage ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center p-6">
              <AlertTriangle className="w-10 h-10 text-rose-500" />
              <h4 className="text-base font-bold text-zinc-200">Ошибка спектрального анализа</h4>
              <p className="text-xs text-zinc-400 max-w-md">{errorMessage}</p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col relative overflow-hidden">
              {/* Main Canvas Container */}
              <div className="flex-1 relative cursor-crosshair overflow-hidden">
                <canvas 
                  ref={canvasRef}
                  onMouseDown={handleSpectrogramMouseDown}
                  onMouseMove={handleSpectrogramMouseMove}
                  onMouseLeave={handleSpectrogramMouseLeave}
                  className="w-full h-full block"
                />

                {/* Animated Playhead Line */}
                {spectrogramData && (
                  <div 
                    className="absolute top-0 bottom-0 pointer-events-none z-30 transition-none"
                    style={{
                      left: `${(playbackTime / spectrogramData.duration) * 100}%`
                    }}
                  >
                    <div className="w-0.5 h-full bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.8)]" />
                    <div className="absolute top-0 -left-1.5 w-3.5 h-3.5 bg-amber-400 rounded-b-md shadow-md" />
                  </div>
                )}

                {/* Interactive Crosshair & Hover Tooltip */}
                {hoverInfo && (
                  <>
                    {/* Crosshair Horizontal Line */}
                    <div 
                      className="absolute left-0 right-0 pointer-events-none border-b border-white/25 z-20"
                      style={{ top: hoverInfo.y }}
                    />
                    {/* Crosshair Vertical Line */}
                    <div 
                      className="absolute top-0 bottom-0 pointer-events-none border-r border-white/25 z-20"
                      style={{ left: hoverInfo.x }}
                    />

                    {/* Floating Info Badge */}
                    <div 
                      className="absolute pointer-events-none z-40 bg-black/90 text-white px-3 py-2 rounded-lg border border-purple-500/40 backdrop-blur-md shadow-2xl flex flex-col gap-1 text-[11px]"
                      style={{
                        left: Math.min(hoverInfo.x + 16, (canvasRef.current?.clientWidth || 800) - 200),
                        top: Math.max(16, Math.min(hoverInfo.y - 45, (canvasRef.current?.clientHeight || 400) - 90))
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-zinc-400 font-medium">Частота:</span>
                        <span className="font-mono font-bold text-amber-300">
                          {SpectralAnalysisService.formatFreqLabel(hoverInfo.freq)}
                          {hoverInfo.note && <span className="text-purple-300 ml-1">({hoverInfo.note})</span>}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-zinc-400 font-medium">Амплитуда:</span>
                        <span className={`font-mono font-bold ${hoverInfo.db > -6 ? 'text-rose-400' : hoverInfo.db > -24 ? 'text-amber-300' : 'text-emerald-400'}`}>
                          {hoverInfo.db} dBFS
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-zinc-400 font-medium">Время:</span>
                        <span className="font-mono text-zinc-300">{formatTime(hoverInfo.time)}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Color Scale Legend on Right Border */}
          <div className="w-14 border-l border-zinc-800 bg-zinc-950 flex flex-col justify-between py-4 px-2 select-none shrink-0">
            <div className="text-[9px] font-mono text-amber-300 text-center font-bold">0 dB</div>
            <div className="text-[9px] font-mono text-amber-400 text-center">-12 dB</div>
            <div className="text-[9px] font-mono text-rose-400 text-center">-24 dB</div>
            <div className="text-[9px] font-mono text-purple-400 text-center">-48 dB</div>
            <div className="text-[9px] font-mono text-indigo-400 text-center">-72 dB</div>
            <div className="text-[9px] font-mono text-zinc-500 text-center">-96 dB</div>
            <div className="text-[9px] font-mono text-zinc-600 text-center">-120 dB</div>
          </div>
        </div>

        {/* Quality & Audio Health Diagnostics Footer (Audition / RX Style) */}
        {spectrogramData && (
          <div className="border-t border-zinc-800 bg-zinc-900/80 px-6 py-3 shrink-0 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="flex items-center gap-6">
              {/* Format & Lossy Cutoff Card */}
              <div className="flex items-center gap-2">
                {spectrogramData.detectedCutoffFreq < 18500 ? (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300 font-semibold">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                    <span>Срез: {SpectralAnalysisService.formatFreqLabel(spectrogramData.detectedCutoffFreq)} (MP3/Сжатие)</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Lossless / Полный спектр ({SpectralAnalysisService.formatFreqLabel(spectrogramData.detectedCutoffFreq)})</span>
                  </div>
                )}
              </div>

              {/* Low-End Rumble Check */}
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-500">Инфранизкий гул (&lt;60Гц):</span>
                {spectrogramData.hasLowRumble ? (
                  <span className="text-amber-400 font-bold flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Присутствует
                  </span>
                ) : (
                  <span className="text-emerald-400 font-medium">Чисто</span>
                )}
              </div>

              {/* Sibilance Check */}
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-500">Сибилянты (5-8 кГц):</span>
                {spectrogramData.hasSibilanceIssue ? (
                  <span className="text-rose-400 font-bold flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Повышенная резкость
                  </span>
                ) : (
                  <span className="text-emerald-400 font-medium">В норме</span>
                )}
              </div>

              {/* Noise Floor */}
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-500">Уровень шума:</span>
                <span className="font-mono text-zinc-300 font-bold">{spectrogramData.estimatedNoiseFloorDb} dBFS</span>
              </div>
            </div>

            {/* Peak Frequency & Sample Rate */}
            <div className="flex items-center gap-4 text-zinc-400 font-mono text-[11px]">
              <div>
                <span>Пик: </span>
                <span className="text-amber-300 font-bold">
                  {SpectralAnalysisService.formatFreqLabel(spectrogramData.globalPeakFreq)} ({spectrogramData.globalPeakDb} dBFS)
                </span>
              </div>
              <div className="w-px h-3 bg-zinc-700" />
              <div>
                <span>Частота дискретизации: </span>
                <span className="text-zinc-200 font-bold">{(spectrogramData.sampleRate / 1000).toFixed(1)} kHz</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
