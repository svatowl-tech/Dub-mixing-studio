import React, { useRef, useEffect } from 'react';
import { cn } from '../lib/utils';
import { listen } from '@tauri-apps/api/event';

export const VUMeter = ({ 
  stream, 
  onClipping 
}: { 
  stream: MediaStream | null,
  onClipping?: (clipping: boolean) => void
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const peakTimeRef = useRef<number>(0);
  const isClippingRef = useRef(false);

  const peakDecayRef = useRef<number>(0);
  const lufsRef = useRef<number>(-70);
  const warningTimeRef = useRef<number>(0);

  // Tauri ASIO Listener
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let isCancelled = false;

    const setupListener = async () => {
      // Listen for background rust events
      if (!(window as any).__TAURI_INTERNALS__) return;
      
      const unlistenFn = await listen<{ rms: number; peak: number; loudness_lufs?: number }>('vu-meter', (event) => {
        if (isCancelled) return;
        if (!canvasRef.current || stream) return;
        const { peak, rms, loudness_lufs } = event.payload;
        
        if (loudness_lufs !== undefined) lufsRef.current = loudness_lufs;
        
        // Peak decay logic
        if (peak > peakDecayRef.current) {
          peakDecayRef.current = peak;
        } else {
          peakDecayRef.current = Math.max(0, peakDecayRef.current - 0.015); // Slow fall
        }

        // Warning logic (> -3dB)
        // -3dB ~= 0.707 linear
        if (peak > 0.707) {
          warningTimeRef.current = Date.now();
        }

        const db = peak > 0 ? 20 * Math.log10(rms || 1e-6) : -60;
        if (peak >= 0.99) {
          if (!isClippingRef.current) {
            isClippingRef.current = true;
            onClipping?.(true);
          }
          peakTimeRef.current = Date.now();
        }

        const level = Math.max(0, (db + 60) / 60);
        const peakLevel = Math.max(0, (20 * Math.log10(peakDecayRef.current || 1e-6) + 60) / 60);
        
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        const w = canvasRef.current.width;
        const h = canvasRef.current.height;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#09090b';
        ctx.fillRect(0, 0, w, h);

        const isCurrentlyClipping = Date.now() - peakTimeRef.current < 800;
        const isWarning = Date.now() - warningTimeRef.current < 1500;
        
        if (isCurrentlyClipping) {
          ctx.fillStyle = '#ef4444';
        } else if (isWarning) {
          ctx.fillStyle = '#f97316'; // Orange warning
        } else {
          const gradient = ctx.createLinearGradient(0, 0, w, 0);
          gradient.addColorStop(0, '#22c55e');
          gradient.addColorStop(0.7, '#eab308');
          gradient.addColorStop(0.9, '#ef4444');
          ctx.fillStyle = gradient;
        }

        // Active RMS Level
        ctx.fillRect(0, 0, w * level, h);

        // Slow Decay Peak Line
        ctx.fillStyle = isCurrentlyClipping ? '#ffffff' : (isWarning ? '#fbbf24' : '#fde047');
        ctx.fillRect(w * peakLevel - 2, 0, 2, h);

        // LUFS text if available
        if (loudness_lufs !== undefined) {
          ctx.font = 'bold 8px monospace';
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.textAlign = 'right';
          ctx.fillText(`${loudness_lufs.toFixed(1)} LUFS`, w - 5, h - 2);
        }
      });
      
      if (isCancelled) {
        unlistenFn();
      } else {
        unlisten = unlistenFn;
      }
    };

    setupListener();

    return () => {
      isCancelled = true;
      if (unlisten) unlisten();
    };
  }, [stream, onClipping]);

  // Original HTML5 Listener
  useEffect(() => {
    if (!stream || !canvasRef.current) return;

    const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
    const audioContext = new AudioContextClass();
    const source = audioContext.createMediaStreamSource(stream);
    
    // Gain Rider (Limiter) for visualization
    const limiter = audioContext.createDynamicsCompressor();
    limiter.threshold.setValueAtTime(-1, audioContext.currentTime);
    limiter.knee.setValueAtTime(0, audioContext.currentTime);
    limiter.ratio.setValueAtTime(20, audioContext.currentTime);
    limiter.attack.setValueAtTime(0.003, audioContext.currentTime);
    limiter.release.setValueAtTime(0.25, audioContext.currentTime);

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    
    source.connect(limiter);
    limiter.connect(analyser);

    const dataArray = new Float32Array(analyser.fftSize);
    const ctx = canvasRef.current.getContext('2d');

    const draw = () => {
      if (!ctx || !canvasRef.current) return;
      analyser.getFloatTimeDomainData(dataArray);
      
      let maxVal = 0;
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const val = Math.abs(dataArray[i]);
        if (val > maxVal) maxVal = val;
        sum += val * val;
      }
      
      const rms = Math.sqrt(sum / dataArray.length);
      const db = 20 * Math.log10(rms || 1e-6);
      
      // Clipping Detection (0dB = 1.0 in time domain)
      if (maxVal >= 0.99) {
        if (!isClippingRef.current) {
          isClippingRef.current = true;
          onClipping?.(true);
        }
        peakTimeRef.current = Date.now();
      }

      // Map -60dB to 0 and 0dB to 1
      const level = Math.max(0, (db + 60) / 60);

      // Decay logic for HTML5
      if (maxVal > peakDecayRef.current) {
        peakDecayRef.current = maxVal;
      } else {
        peakDecayRef.current = Math.max(0, peakDecayRef.current - 0.01);
      }
      
      const peakLevel = Math.max(0, (20 * Math.log10(peakDecayRef.current || 1e-6) + 60) / 60);

      if (maxVal > 0.707) {
        warningTimeRef.current = Date.now();
      }

      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      
      const w = canvasRef.current.width;
      const h = canvasRef.current.height;

      // Background
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, w, h);

      // Meter Color Logic
      const isCurrentlyClipping = Date.now() - peakTimeRef.current < 800;
      const isWarning = Date.now() - warningTimeRef.current < 1500;
      
      if (isCurrentlyClipping) {
        ctx.fillStyle = '#ef4444'; // Solid Red on clipping
      } else if (isWarning) {
        ctx.fillStyle = '#f97316';
      } else {
        const gradient = ctx.createLinearGradient(0, 0, w, 0);
        gradient.addColorStop(0, '#22c55e');
        gradient.addColorStop(0.7, '#eab308');
        gradient.addColorStop(0.9, '#ef4444');
        ctx.fillStyle = gradient;
      }

      ctx.fillRect(0, 0, w * level, h);

      // Slow Decay Peak Line
      ctx.fillStyle = isCurrentlyClipping ? '#ffffff' : (isWarning ? '#fbbf24' : '#fde047');
      ctx.fillRect(w * peakLevel - 2, 0, 2, h);

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animationRef.current);
      audioContext.close();
    };
  }, [stream, onClipping]);

  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex justify-between text-[6px] font-mono text-zinc-500 uppercase tracking-tighter px-1">
        <span className={cn(isClippingRef.current && "text-rose-500 font-bold")}>-60dB</span>
        <span className={cn(isClippingRef.current && "text-rose-500 font-bold")}>-30dB</span>
        <span className={cn(isClippingRef.current && "text-rose-500 font-bold")}>0dB {isClippingRef.current && "CLIP"}</span>
      </div>
      <canvas ref={canvasRef} width={200} height={6} className={cn("rounded-full bg-zinc-950 border border-white/5 overflow-hidden w-full transition-colors", isClippingRef.current && "border-rose-500/50 shadow-[0_0_10px_rgba(244,63,94,0.2)]")} />
    </div>
  );
};

export default VUMeter;
