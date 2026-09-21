import React, { useRef, useEffect } from 'react';
import { cn } from '../lib/utils';
import { useVUMeter, UseVUMeterOptions } from '../hooks/useVUMeter';

export interface VUMeterProps extends UseVUMeterOptions {
  className?: string;
  width?: number;
  height?: number;
  showLabels?: boolean;
  orientation?: 'horizontal' | 'vertical';
}

export const VUMeter: React.FC<VUMeterProps> = ({
  stream = null,
  busType = 'input',
  enabled = true,
  rms: directRms,
  peak: directPeak,
  loudnessLufs: directLufs,
  onClipping,
  className,
  width = 200,
  height = 8,
  showLabels = true,
  orientation = 'horizontal',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Использование специализированного нативного хука телеметрии
  const {
    rms,
    peak,
    peakHold,
    loudnessLufs,
    isClipping,
    levelNorm,
    peakHoldNorm,
    resetClipping,
  } = useVUMeter({
    stream,
    busType,
    enabled,
    directRms,
    directPeak,
    directLufs,
    onClipping,
  });

  // Отрисовка шкалы уровня и Peak Hold на Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const isHoriz = orientation === 'horizontal';

    // Установка четкости под Retina/High-DPI
    const displayWidth = width;
    const displayHeight = height;
    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    const w = displayWidth;
    const h = displayHeight;

    // 1. Очистка и закраска фонового поддона
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, w, h);

    // 2. Отрисовка светодиодных градаций / градиента (-60..-12 Зеленый, -12..-1 Желтый, >-1 Красный)
    if (levelNorm > 0) {
      if (isHoriz) {
        const fillW = w * levelNorm;
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        // -60 dBFS to -12 dBFS (80% длины) -> Зеленый
        grad.addColorStop(0.0, '#22c55e');
        grad.addColorStop(0.75, '#16a34a');
        // -12 dBFS to -1 dBFS (18% длины) -> Желтый/Оранжевый
        grad.addColorStop(0.82, '#eab308');
        grad.addColorStop(0.95, '#f97316');
        // > -1 dBFS -> Красный
        grad.addColorStop(1.0, '#ef4444');

        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, fillW, h);
      } else {
        const fillH = h * levelNorm;
        const grad = ctx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0.0, '#22c55e');
        grad.addColorStop(0.75, '#16a34a');
        grad.addColorStop(0.82, '#eab308');
        grad.addColorStop(0.95, '#f97316');
        grad.addColorStop(1.0, '#ef4444');

        ctx.fillStyle = grad;
        ctx.fillRect(0, h - fillH, w, fillH);
      }
    }

    // 3. Линия Peak Hold со сглаженным падением (20 dB/s)
    if (peakHoldNorm > 0.01) {
      ctx.fillStyle = isClipping ? '#ffffff' : '#fde047';
      if (isHoriz) {
        const peakX = Math.min(w - 2, Math.max(0, w * peakHoldNorm - 2));
        ctx.fillRect(peakX, 0, 2, h);
      } else {
        const peakY = Math.min(h - 2, Math.max(0, h - h * peakHoldNorm));
        ctx.fillRect(0, peakY, w, 2);
      }
    }

    // 4. Текстовая метка LUFS при наличии
    if (loudnessLufs !== undefined && loudnessLufs > -70 && isHoriz && w >= 120) {
      ctx.font = 'bold 7px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'right';
      ctx.fillText(`${loudnessLufs.toFixed(1)} LUFS`, w - 4, h - 2);
    }

    ctx.restore();
  }, [width, height, orientation, levelNorm, peakHoldNorm, isClipping, loudnessLufs]);

  return (
    <div
      className={cn(
        'flex flex-col gap-1 w-full select-none',
        orientation === 'vertical' && 'flex-row items-center h-full',
        className
      )}
      onClick={resetClipping}
      title="Нажмите для сброса индикатора клиппинга"
    >
      {showLabels && orientation === 'horizontal' && (
        <div className="flex justify-between text-[7px] font-mono text-zinc-500 uppercase tracking-tighter px-0.5">
          <span className={cn(isClipping && 'text-rose-400 font-semibold')}>-60dB</span>
          <span>-24dB</span>
          <span>-12dB</span>
          <span className={cn(isClipping && 'text-rose-400 font-bold')}>-1dB</span>
          <span
            className={cn(
              'px-1 rounded text-[6px]',
              isClipping
                ? 'bg-rose-600 text-white font-bold animate-pulse shadow-[0_0_8px_rgba(244,63,94,0.8)]'
                : 'text-zinc-600'
            )}
          >
            CLIP
          </span>
        </div>
      )}

      <div className="relative w-full flex items-center">
        <canvas
          ref={canvasRef}
          style={{ width: orientation === 'horizontal' ? '100%' : `${width}px`, height: `${height}px` }}
          className={cn(
            'rounded-sm bg-zinc-950 border border-white/10 overflow-hidden transition-colors cursor-pointer',
            isClipping && 'border-rose-500/80 shadow-[0_0_10px_rgba(244,63,94,0.3)]'
          )}
        />
      </div>
    </div>
  );
};

export default VUMeter;
