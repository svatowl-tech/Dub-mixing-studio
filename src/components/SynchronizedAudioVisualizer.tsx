import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  ZoomIn, ZoomOut, Maximize2, Sliders, Flame, Activity, 
  MoveHorizontal, Volume2, Sparkles, Filter
} from 'lucide-react';
import { SpectrogramData, SpectralAnalysisService } from '../services/spectralAnalysisService';

interface SynchronizedAudioVisualizerProps {
  originalBuffer: AudioBuffer | null;
  processedBuffer: AudioBuffer | null;
  activeSource: 'A' | 'B';
  spectrogramDataA: SpectrogramData | null;
  spectrogramDataB: SpectrogramData | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onSeek: (time: number) => void;
  palette: 'inferno' | 'viridis' | 'turbo' | 'plasma';
  onPaletteChange: (p: 'inferno' | 'viridis' | 'turbo' | 'plasma') => void;
}

export const SynchronizedAudioVisualizer: React.FC<SynchronizedAudioVisualizerProps> = ({
  originalBuffer,
  processedBuffer,
  activeSource,
  spectrogramDataA,
  spectrogramDataB,
  currentTime,
  duration,
  isPlaying,
  onSeek,
  palette,
  onPaletteChange,
}) => {
  // Horizontal Time Zoom & Pan
  const [timeZoom, setTimeZoom] = useState<number>(1.0); // 1x to 30x
  const [scrollPos, setScrollPos] = useState<number>(0); // 0..1
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const panStartXRef = useRef<number>(0);
  const panStartScrollRef = useRef<number>(0);

  // Vertical Frequency Band Zoom (Spectrogram)
  const [freqMin, setFreqMin] = useState<number>(0); // Hz
  const [freqMax, setFreqMax] = useState<number>(22050); // Hz
  const [contrastFloorDb, setContrastFloorDb] = useState<number>(-95); // dBFS floor
  const [gainBoostDb, setGainBoostDb] = useState<number>(0); // dB gain boost
  const [showFreqControls, setShowFreqControls] = useState<boolean>(false);

  // Hover Inspector Crosshair
  const [hoverInfo, setHoverInfo] = useState<{ 
    time: number; 
    freq: number; 
    db: number; 
    x: number; 
    y: number 
  } | null>(null);

  // Canvas Refs
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const spectrogramCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Compute visible time slice
  const visibleDuration = duration > 0 ? duration / timeZoom : 1;
  const maxOffset = Math.max(0, duration - visibleDuration);
  const startTime = maxOffset > 0 ? scrollPos * maxOffset : 0;
  const endTime = Math.min(duration, startTime + visibleDuration);

  // Auto-follow playhead during playback when zoomed in
  useEffect(() => {
    if (!isPlaying || timeZoom <= 1.05 || duration <= 0) return;

    if (currentTime > endTime - 0.05 * visibleDuration || currentTime < startTime) {
      const targetStart = Math.max(0, Math.min(currentTime - 0.2 * visibleDuration, duration - visibleDuration));
      if (maxOffset > 0) {
        setScrollPos(targetStart / maxOffset);
      }
    }
  }, [currentTime, isPlaying, timeZoom, visibleDuration, duration, startTime, endTime, maxOffset]);

  // Active Spectrogram Data
  const activeSpec = activeSource === 'B' && spectrogramDataB ? spectrogramDataB : spectrogramDataA;
  const currentBuf = activeSource === 'B' && processedBuffer ? processedBuffer : originalBuffer;

  // Format Time Helper
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 1000);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  // 1. Render Mini Timeline Overview Bar
  useEffect(() => {
    const canvas = overviewCanvasRef.current;
    if (!canvas || !currentBuf || duration <= 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width = canvas.parentElement?.clientWidth || 600;
    const height = canvas.height = 24;

    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, width, height);

    const channelData = currentBuf.getChannelData(0);
    const totalSamples = channelData.length;
    const step = Math.max(1, Math.floor(totalSamples / width));
    const midY = height / 2;

    ctx.fillStyle = '#3f3f46';
    for (let x = 0; x < width; x++) {
      let max = 0;
      const startIdx = x * step;
      const endIdx = Math.min(totalSamples, startIdx + step);
      for (let j = startIdx; j < endIdx; j += 4) {
        const val = Math.abs(channelData[j]);
        if (val > max) max = val;
      }
      const h = Math.max(1, Math.min(height - 2, max * height));
      ctx.fillRect(x, midY - h / 2, 1, h);
    }

    // Highlight visible window
    const winStartX = (startTime / duration) * width;
    const winWidth = Math.max(4, (visibleDuration / duration) * width);

    ctx.fillStyle = 'rgba(99, 102, 241, 0.25)';
    ctx.fillRect(winStartX, 0, winWidth, height);
    ctx.strokeStyle = '#818cf8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(winStartX, 0.5, winWidth, height - 1);

    // Playhead line
    const playX = (currentTime / duration) * width;
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(playX - 1, 0, 2, height);
  }, [currentBuf, duration, startTime, visibleDuration, currentTime]);

  // 2. Render Synchronized Waveform
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas || !currentBuf || duration <= 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width = canvas.parentElement?.clientWidth || 800;
    const height = canvas.height = 90;

    ctx.fillStyle = '#09090b'; // zinc-950
    ctx.fillRect(0, 0, width, height);

    // Zero-crossing center line
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    const channelData = currentBuf.getChannelData(0);
    const sampleRate = currentBuf.sampleRate;
    const startSample = Math.max(0, Math.floor(startTime * sampleRate));
    const endSample = Math.min(channelData.length, Math.ceil(endTime * sampleRate));
    const numSliceSamples = Math.max(1, endSample - startSample);
    const step = numSliceSamples / width;
    const amp = height / 2;

    ctx.beginPath();
    ctx.strokeStyle = activeSource === 'B' ? '#10b981' : '#6366f1'; // emerald for B, indigo for A
    ctx.lineWidth = 1;

    for (let i = 0; i < width; i++) {
      const idxStart = Math.floor(startSample + i * step);
      const idxEnd = Math.min(channelData.length, Math.floor(startSample + (i + 1) * step));
      let min = 1.0;
      let max = -1.0;

      if (idxEnd > idxStart) {
        for (let j = idxStart; j < idxEnd; j++) {
          const datum = channelData[j];
          if (datum < min) min = datum;
          if (datum > max) max = datum;
        }
      } else {
        const val = channelData[idxStart] || 0;
        min = val;
        max = val;
      }

      ctx.moveTo(i, (1 + min) * amp);
      ctx.lineTo(i, (1 + max) * amp);
    }
    ctx.stroke();

    // Time ticks along waveform bottom
    ctx.fillStyle = '#71717a';
    ctx.font = '9px monospace';
    const numTicks = 6;
    for (let t = 0; t <= numTicks; t++) {
      const x = (t / numTicks) * width;
      const tickTime = startTime + (t / numTicks) * visibleDuration;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillText(formatTime(tickTime), Math.min(width - 55, Math.max(4, x - 20)), height - 4);
    }

    // Playhead line
    if (currentTime >= startTime && currentTime <= endTime) {
      const playheadX = ((currentTime - startTime) / visibleDuration) * width;
      ctx.fillStyle = '#ef4444'; // Red playhead
      ctx.fillRect(playheadX - 1, 0, 2, height);
    }
  }, [currentBuf, startTime, endTime, visibleDuration, currentTime, activeSource, duration]);

  // 3. Render Synchronized Spectrogram with Frequency Zoom & Contrast
  const renderSpectrogram = useCallback(() => {
    const canvas = spectrogramCanvasRef.current;
    if (!canvas || !activeSpec || activeSpec.frames.length === 0 || duration <= 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width = canvas.parentElement?.clientWidth || 800;
    const height = canvas.height = 230;

    const frames = activeSpec.frames;
    const numFrames = frames.length;
    const numBins = activeSpec.fftSize / 2;
    const maxNyquist = activeSpec.maxFreq || 22050;

    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    // Time frame bounds
    const startFrame = Math.max(0, Math.floor((startTime / duration) * numFrames));
    const endFrame = Math.min(numFrames - 1, Math.ceil((endTime / duration) * numFrames));
    const visibleFrames = Math.max(1, endFrame - startFrame);

    // Frequency bin bounds for vertical frequency zoom
    const clampedMinFreq = Math.max(0, Math.min(freqMin, maxNyquist - 100));
    const clampedMaxFreq = Math.max(clampedMinFreq + 100, Math.min(freqMax, maxNyquist));
    const minBin = Math.max(0, Math.floor((clampedMinFreq / maxNyquist) * numBins));
    const maxBin = Math.min(numBins - 1, Math.ceil((clampedMaxFreq / maxNyquist) * numBins));
    const visibleBins = Math.max(1, maxBin - minBin);

    const minDb = contrastFloorDb; // default -95 dBFS
    const maxDb = 0 + gainBoostDb; // gain boosted ceiling

    for (let x = 0; x < width; x++) {
      const frameFrac = x / width;
      const frameIdx = Math.min(numFrames - 1, Math.floor(startFrame + frameFrac * visibleFrames));
      const frame = frames[frameIdx];

      for (let y = 0; y < height; y++) {
        // Top (y=0) is maxFreq, Bottom (y=height-1) is minFreq
        const binFrac = (height - 1 - y) / height;
        const binIdx = Math.min(numBins - 1, Math.floor(minBin + binFrac * visibleBins));
        const db = frame.magnitudes[binIdx] + gainBoostDb;

        // Normalize dBFS to 0..1
        const norm = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));

        // Color map calculation
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

    // Draw Cutoff Line if within view
    if (activeSpec.detectedCutoffFreq >= clampedMinFreq && activeSpec.detectedCutoffFreq <= clampedMaxFreq) {
      const cutoffFrac = (activeSpec.detectedCutoffFreq - clampedMinFreq) / (clampedMaxFreq - clampedMinFreq);
      const cutoffY = height - cutoffFrac * height;
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, cutoffY);
      ctx.lineTo(width, cutoffY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ef4444';
      ctx.font = '10px monospace';
      ctx.fillText(`▲ MP3 Срез: ${SpectralAnalysisService.formatFreqLabel(activeSpec.detectedCutoffFreq)}`, 8, cutoffY - 4);
    }

    // Draw 50Hz / 60Hz Power Hum line if in view to help inspect noise
    const hum50Y = height - ((50 - clampedMinFreq) / (clampedMaxFreq - clampedMinFreq)) * height;
    if (clampedMinFreq <= 50 && clampedMaxFreq >= 50) {
      ctx.strokeStyle = 'rgba(234, 179, 8, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(0, hum50Y);
      ctx.lineTo(width, hum50Y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#eab308';
      ctx.font = '9px monospace';
      ctx.fillText('50Hz Hum', 6, hum50Y - 2);
    }

    // Playhead line
    if (currentTime >= startTime && currentTime <= endTime) {
      const playheadX = ((currentTime - startTime) / visibleDuration) * width;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(playheadX - 1, 0, 2, height);
    }

    // Vertical Frequency Ruler Grid Marks on canvas right edge
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '9px monospace';
    const freqSteps = [
      clampedMaxFreq,
      Math.round(clampedMinFreq + (clampedMaxFreq - clampedMinFreq) * 0.75),
      Math.round(clampedMinFreq + (clampedMaxFreq - clampedMinFreq) * 0.5),
      Math.round(clampedMinFreq + (clampedMaxFreq - clampedMinFreq) * 0.25),
      clampedMinFreq,
    ];

    freqSteps.forEach((f, idx) => {
      const y = (idx / 4) * (height - 14) + 10;
      ctx.fillText(SpectralAnalysisService.formatFreqLabel(f), width - 50, y);
    });
  }, [
    activeSpec, duration, startTime, endTime, visibleDuration, currentTime,
    freqMin, freqMax, contrastFloorDb, gainBoostDb, palette
  ]);

  useEffect(() => {
    renderSpectrogram();
  }, [renderSpectrogram]);

  // Handle Wheel Zoom & Pan over canvases
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (duration <= 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const mouseFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const cursorTime = startTime + mouseFrac * visibleDuration;

    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      // Zoom in / out centered around cursorTime
      const zoomFactor = e.deltaY < 0 ? 1.25 : 0.8;
      const newZoom = Math.max(1.0, Math.min(30.0, timeZoom * zoomFactor));

      if (newZoom !== timeZoom) {
        const newVisibleDuration = duration / newZoom;
        const newStartTime = Math.max(0, Math.min(duration - newVisibleDuration, cursorTime - mouseFrac * newVisibleDuration));
        const newMaxOffset = Math.max(0, duration - newVisibleDuration);
        
        setTimeZoom(newZoom);
        if (newMaxOffset > 0) {
          setScrollPos(newStartTime / newMaxOffset);
        } else {
          setScrollPos(0);
        }
      }
    } else {
      // Horizontal scroll with wheel
      if (maxOffset > 0) {
        const scrollDelta = (e.deltaX || e.deltaY) / 1000;
        setScrollPos((prev) => Math.max(0, Math.min(1, prev + scrollDelta)));
      }
    }
  };

  // Mouse Inspection on Spectrogram
  const handleSpectrogramMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = spectrogramCanvasRef.current;
    if (!canvas || !activeSpec) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isPanning) {
      const deltaX = x - panStartXRef.current;
      const scrollDelta = -(deltaX / rect.width) * (visibleDuration / duration);
      setScrollPos(Math.max(0, Math.min(1, panStartScrollRef.current + scrollDelta)));
      return;
    }

    const timeRatio = x / rect.width;
    const freqRatio = (rect.height - y) / rect.height;

    const clampedMin = Math.max(0, Math.min(freqMin, activeSpec.maxFreq - 100));
    const clampedMax = Math.max(clampedMin + 100, Math.min(freqMax, activeSpec.maxFreq));

    const time = startTime + timeRatio * visibleDuration;
    const freq = Math.round(clampedMin + freqRatio * (clampedMax - clampedMin));

    const frameIdx = Math.min(activeSpec.frames.length - 1, Math.max(0, Math.floor((time / duration) * activeSpec.frames.length)));
    const frame = activeSpec.frames[frameIdx];
    const binIdx = Math.min(activeSpec.fftSize / 2 - 1, Math.max(0, Math.round(freq / activeSpec.freqStep)));
    const db = frame ? Math.round((frame.magnitudes[binIdx] + gainBoostDb) * 10) / 10 : -120;

    setHoverInfo({ time, freq, db, x, y });
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (timeZoom > 1.05 && (e.button === 1 || e.altKey || e.shiftKey)) {
      setIsPanning(true);
      panStartXRef.current = e.clientX;
      panStartScrollRef.current = scrollPos;
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  const handleCanvasSeek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const targetTime = startTime + ratio * visibleDuration;
    onSeek(Math.max(0, Math.min(duration, targetTime)));
  };

  const handleOverviewClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const clickedTime = ratio * duration;

    // Center visible window around clicked point
    if (maxOffset > 0) {
      const targetStart = Math.max(0, Math.min(maxOffset, clickedTime - visibleDuration / 2));
      setScrollPos(targetStart / maxOffset);
    }
    onSeek(Math.max(0, Math.min(duration, clickedTime)));
  };

  // Frequency Presets
  const applyFreqPreset = (min: number, max: number) => {
    setFreqMin(min);
    setFreqMax(max);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Visualizer Header Controls: Time Zoom, Freq Zoom, Palette */}
      <div className="bg-zinc-900/80 border border-white/10 rounded-xl p-2.5 flex flex-wrap items-center justify-between gap-3">
        {/* Horizontal Time Zoom Controls */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-zinc-950 px-2 py-1 rounded-lg border border-white/10">
            <button
              onClick={() => {
                const z = Math.max(1.0, timeZoom / 1.5);
                setTimeZoom(z);
                if (z === 1) setScrollPos(0);
              }}
              disabled={timeZoom <= 1.01}
              className="p-1 hover:bg-white/10 disabled:opacity-30 rounded text-zinc-300"
              title="Уменьшить масштаб (Ctrl + Scroll)"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>

            <span className="font-mono text-xs font-bold text-indigo-400 w-12 text-center">
              {timeZoom.toFixed(1)}x
            </span>

            <button
              onClick={() => setTimeZoom((z) => Math.min(30.0, z * 1.5))}
              disabled={timeZoom >= 29.9}
              className="p-1 hover:bg-white/10 disabled:opacity-30 rounded text-zinc-300"
              title="Приблизить масштаб (Ctrl + Scroll)"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>

            {timeZoom > 1.05 && (
              <button
                onClick={() => {
                  setTimeZoom(1.0);
                  setScrollPos(0);
                }}
                className="px-1.5 py-0.5 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-semibold ml-1"
                title="Сброс масштаба времени"
              >
                1x
              </button>
            )}
          </div>

          {/* Quick Zoom Presets */}
          <div className="hidden sm:flex items-center gap-1 text-[10px] font-bold">
            {[2, 5, 10, 20].map((z) => (
              <button
                key={z}
                onClick={() => setTimeZoom(z)}
                className={`px-2 py-1 rounded-md transition-all ${
                  Math.round(timeZoom) === z
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-zinc-800 text-zinc-400 hover:text-white'
                }`}
              >
                {z}x
              </button>
            ))}
          </div>
        </div>

        {/* Center: Spectrogram Band Presets */}
        <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
          <span className="text-zinc-500 font-medium hidden md:inline">Диапазон спектра:</span>
          <button
            onClick={() => applyFreqPreset(0, 22050)}
            className={`px-2 py-1 rounded-md font-bold transition-all ${
              freqMin === 0 && freqMax >= 22000
                ? 'bg-amber-600 text-white shadow-sm'
                : 'bg-zinc-800 text-zinc-400 hover:text-white'
            }`}
          >
            Весь спектр
          </button>
          <button
            onClick={() => applyFreqPreset(20, 1000)}
            className={`px-2 py-1 rounded-md font-bold transition-all ${
              freqMin === 20 && freqMax === 1000
                ? 'bg-amber-600 text-white shadow-sm'
                : 'bg-zinc-800 text-zinc-400 hover:text-white'
            }`}
            title="Приблизить низкие частоты (НЧ шум, гул сети 50/60Гц)"
          >
            НЧ шум (20-1000 Гц)
          </button>
          <button
            onClick={() => applyFreqPreset(80, 8000)}
            className={`px-2 py-1 rounded-md font-bold transition-all ${
              freqMin === 80 && freqMax === 8000
                ? 'bg-amber-600 text-white shadow-sm'
                : 'bg-zinc-800 text-zinc-400 hover:text-white'
            }`}
            title="Основной диапазон речи и гармоник"
          >
            Речь (80-8кГц)
          </button>
          <button
            onClick={() => applyFreqPreset(3000, 16000)}
            className={`px-2 py-1 rounded-md font-bold transition-all ${
              freqMin === 3000 && freqMax === 16000
                ? 'bg-amber-600 text-white shadow-sm'
                : 'bg-zinc-800 text-zinc-400 hover:text-white'
            }`}
            title="Сибилянты, свистящие и воздух"
          >
            Воздух (3-16кГц)
          </button>

          <button
            onClick={() => setShowFreqControls(!showFreqControls)}
            className={`p-1.5 rounded-lg border transition-all ${
              showFreqControls
                ? 'bg-indigo-600/30 text-indigo-300 border-indigo-500/50'
                : 'bg-zinc-800 text-zinc-400 border-white/5 hover:text-white'
            }`}
            title="Настройка диапазона частот и контраста спектрограммы"
          >
            <Sliders className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Right: Spectrogram Color Palette */}
        <div className="flex items-center gap-2">
          <select
            value={palette}
            onChange={(e) => onPaletteChange(e.target.value as any)}
            className="bg-zinc-950 border border-white/10 text-zinc-300 text-[11px] font-bold rounded-lg px-2.5 py-1"
          >
            <option value="inferno">Inferno (Тепловой)</option>
            <option value="turbo">Turbo (Радужный)</option>
            <option value="viridis">Viridis (Научный)</option>
            <option value="plasma">Plasma (Неоновый)</option>
          </select>
        </div>
      </div>

      {/* Expanded Frequency & Contrast Sliders Panel */}
      {showFreqControls && (
        <div className="bg-zinc-950 border border-white/10 rounded-xl p-3 grid grid-cols-1 sm:grid-cols-4 gap-4 text-xs">
          <div>
            <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
              <span>Низ диапазона (Мин Гц):</span>
              <span className="font-mono text-amber-400 font-bold">{freqMin} Гц</span>
            </div>
            <input
              type="range"
              min="0"
              max="5000"
              step="50"
              value={freqMin}
              onChange={(e) => setFreqMin(Number(e.target.value))}
              className="w-full accent-amber-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
              <span>Верх диапазона (Макс Гц):</span>
              <span className="font-mono text-amber-400 font-bold">
                {SpectralAnalysisService.formatFreqLabel(freqMax)}
              </span>
            </div>
            <input
              type="range"
              min="500"
              max="22050"
              step="250"
              value={freqMax}
              onChange={(e) => setFreqMax(Number(e.target.value))}
              className="w-full accent-amber-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
              <span>Порог шума (Floor dBFS):</span>
              <span className="font-mono text-indigo-400 font-bold">{contrastFloorDb} dB</span>
            </div>
            <input
              type="range"
              min="-120"
              max="-40"
              step="2"
              value={contrastFloorDb}
              onChange={(e) => setContrastFloorDb(Number(e.target.value))}
              className="w-full accent-indigo-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
              <span>Усиление спектра (Gain):</span>
              <span className="font-mono text-emerald-400 font-bold">+{gainBoostDb} dB</span>
            </div>
            <input
              type="range"
              min="0"
              max="24"
              step="1"
              value={gainBoostDb}
              onChange={(e) => setGainBoostDb(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
        </div>
      )}

      {/* Mini Overview Timeline Track */}
      <div className="bg-zinc-900/90 border border-white/10 rounded-xl p-2 flex flex-col gap-1">
        <div className="flex items-center justify-between text-[10px] text-zinc-400 font-medium px-1">
          <span className="flex items-center gap-1">
            <MoveHorizontal className="w-3 h-3 text-indigo-400" />
            Обзор таймлайна (Нажмите или перетащите для быстрой навигации)
          </span>
          <span className="font-mono text-zinc-500">
            Окно: {formatTime(startTime)} — {formatTime(endTime)} ({visibleDuration.toFixed(2)}s)
          </span>
        </div>
        <div 
          className="relative rounded-md overflow-hidden border border-white/5 cursor-pointer bg-zinc-950 h-[24px]"
          onClick={handleOverviewClick}
        >
          <canvas ref={overviewCanvasRef} className="w-full h-full block" />
        </div>
      </div>

      {/* Synchronized Waveform Canvas */}
      <div className="bg-zinc-900/90 border border-white/10 rounded-xl p-3 relative flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs font-bold text-zinc-300">
          <span className="flex items-center gap-1.5">
            <Activity className="w-4 h-4 text-indigo-400" />
            Звуковая волна (Waveform)
          </span>
          <span className="text-[10px] text-zinc-500 font-mono">
            {timeZoom > 1.0 ? `Масштаб ${timeZoom.toFixed(1)}x • Колесико мыши: зум` : 'Нажмите для перехода'}
          </span>
        </div>

        <div
          className="relative rounded-lg overflow-hidden border border-white/5 cursor-pointer"
          onClick={handleCanvasSeek}
          onWheel={handleWheel}
        >
          <canvas ref={waveformCanvasRef} className="w-full h-[90px] block bg-zinc-950" />
        </div>
      </div>

      {/* Synchronized Spectrogram Canvas */}
      <div className="bg-zinc-900/90 border border-white/10 rounded-xl p-3 relative flex flex-col gap-2 min-h-[280px]">
        <div className="flex items-center justify-between text-xs font-bold text-zinc-300">
          <span className="flex items-center gap-1.5">
            <Flame className="w-4 h-4 text-amber-400" />
            Спектральный анализ (STFT Spectrogram)
            <span className="text-[10px] font-normal text-zinc-400">
              [{freqMin} Гц — {SpectralAnalysisService.formatFreqLabel(freqMax)}]
            </span>
          </span>

          <span className="text-[10px] text-zinc-500 font-mono">
            Курсор: инспекция частот и шума
          </span>
        </div>

        {/* Spectrogram Canvas & Hover Tooltip */}
        <div
          className="relative rounded-lg overflow-hidden border border-white/5 flex-1 min-h-[200px] bg-zinc-950 cursor-crosshair"
          onMouseMove={handleSpectrogramMouseMove}
          onMouseLeave={() => {
            setHoverInfo(null);
            setIsPanning(false);
          }}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onClick={handleCanvasSeek}
          onWheel={handleWheel}
        >
          <canvas ref={spectrogramCanvasRef} className="w-full h-full block" />

          {/* Hover Crosshair Tooltip */}
          {hoverInfo && (
            <div
              className="absolute pointer-events-none bg-black/90 border border-white/20 px-2.5 py-1 rounded-md text-[10px] font-mono text-white shadow-xl z-20 flex items-center gap-2"
              style={{
                left: Math.min(hoverInfo.x + 10, 480),
                top: Math.max(hoverInfo.y - 32, 10),
              }}
            >
              <span className="text-amber-400 font-bold">{hoverInfo.freq} Гц</span>
              <span className="text-zinc-500">|</span>
              <span className="text-indigo-300">{formatTime(hoverInfo.time)}</span>
              <span className="text-zinc-500">|</span>
              <span className="text-emerald-400 font-bold">{hoverInfo.db} dBFS</span>
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
              <span className="text-amber-400 font-bold font-mono">
                {SpectralAnalysisService.formatFreqLabel(activeSpec.globalPeakFreq)}
              </span>
            </div>
            <div className="bg-zinc-950 p-2 rounded-lg border border-white/5 flex flex-col">
              <span className="text-zinc-500">Верхний срез</span>
              <span className="text-indigo-300 font-bold font-mono">
                {SpectralAnalysisService.formatFreqLabel(activeSpec.detectedCutoffFreq)}
              </span>
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
    </div>
  );
};

export default SynchronizedAudioVisualizer;
