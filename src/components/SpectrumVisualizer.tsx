// ============================================================================
// DUB MIXING STUDIO PRO - SPECTRUM VISUALIZER (REACT 18+ / CANVAS 60 FPS)
// Разгруженный компонент визуализации спектра на базе нативного Rust FFT
// ============================================================================

import React, { useRef, useEffect, useState } from 'react';
import { Activity, Zap, BarChart3, Waves } from 'lucide-react';
import { useRealtimeSpectrum } from '../hooks/useRealtimeSpectrum';

export interface SpectrumVisualizerProps {
  className?: string;
  height?: number;
  mode?: 'bars' | 'curve';
  showControls?: boolean;
  primaryColor?: string;
  secondaryColor?: string;
  sampleRate?: number;
}

export const SpectrumVisualizer: React.FC<SpectrumVisualizerProps> = ({
  className = '',
  height = 140,
  mode: initialMode = 'bars',
  showControls = true,
  primaryColor = '#3b82f6',
  secondaryColor = '#60a5fa',
  sampleRate = 48000,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<'bars' | 'curve'>(initialMode);
  const [stats, setStats] = useState<{ peak: number; dominantHz: number }>({
    peak: 0,
    dominantHz: 0,
  });

  // Подключаем оптимизированный хук
  const { start, stop } = useRealtimeSpectrum({
    enabled: true,
    sampleRate,
    canvasRef,
    mode,
    primaryColor,
    secondaryColor,
    minDb: -90,
    maxDb: 0,
    onFrame: (frame) => {
      // Обновляем числовые маркеры с частотой раз в ~100мс
      if (Math.random() < 0.15) {
        setStats({
          peak: frame.peak,
          dominantHz: frame.dominantFreqHz,
        });
      }
    },
  });

  useEffect(() => {
    start();
    return () => {
      stop();
    };
  }, [start, stop]);

  return (
    <div
      id="spectrum-visualizer-container"
      className={`relative flex flex-col bg-slate-900 border border-slate-800 rounded-lg p-3 overflow-hidden ${className}`}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800/80">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-blue-400 animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Realtime Spectrum (Rust FFT 2048)
          </span>
          <span className="px-1.5 py-0.5 text-[10px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded">
            60 FPS Lock-Free
          </span>
        </div>

        {showControls && (
          <div className="flex items-center gap-1">
            <button
              id="spectrum-toggle-bars-btn"
              onClick={() => setMode('bars')}
              className={`p-1 rounded text-xs transition-colors ${
                mode === 'bars'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
              title="Логарифмические октавные полосы"
            >
              <BarChart3 className="w-3.5 h-3.5" />
            </button>
            <button
              id="spectrum-toggle-curve-btn"
              onClick={() => setMode('curve')}
              className={`p-1 rounded text-xs transition-colors ${
                mode === 'curve'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
              title="Спектральная кривая (Spline)"
            >
              <Waves className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Direct Canvas Surface */}
      <div className="relative w-full rounded overflow-hidden bg-slate-950/80" style={{ height }}>
        <canvas
          id="spectrum-render-canvas"
          ref={canvasRef}
          className="w-full h-full block"
        />

        {/* Frequency & Peak overlay */}
        <div className="absolute bottom-1 right-2 flex items-center gap-3 text-[10px] font-mono text-slate-400 bg-slate-900/80 px-2 py-0.5 rounded border border-slate-800 backdrop-blur-xs">
          <span className="flex items-center gap-1">
            <Zap className="w-3 h-3 text-amber-400" />
            Peak: {(stats.peak * 100).toFixed(0)}%
          </span>
          {stats.dominantHz > 0 && (
            <span>
              Dom: {stats.dominantHz > 1000 ? `${(stats.dominantHz / 1000).toFixed(1)} kHz` : `${stats.dominantHz.toFixed(0)} Hz`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
