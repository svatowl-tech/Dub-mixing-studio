import React, { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { Activity, Play, Check, RefreshCw } from 'lucide-react';

interface LatencyCalibrationProps {
  onComplete: (offsetMs: number) => void;
  onClose: () => void;
  inputDeviceId?: string;
  outputDeviceId?: string;
}

export const LatencyCalibration: React.FC<LatencyCalibrationProps> = ({ onComplete, onClose, inputDeviceId, outputDeviceId }) => {
  const [isTesting, setIsTesting] = useState(false);
  const [result, setResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);

  const runTest = async () => {
    setIsTesting(true);
    setError(null);
    setResult(null);

    try {
      const isAsio = (window as any).electronAPI && (inputDeviceId?.includes("ASIO") || outputDeviceId?.includes("ASIO"));
      
      console.log("[Calibration] Starting test...", { inputDeviceId, outputDeviceId, isAsio });

      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ 
          latencyHint: 'interactive' 
        });
        console.log("[Calibration] AudioContext created. Sample rate:", audioContextRef.current.sampleRate);
      }
      const ctx = audioContextRef.current;
      
      // Ensure context is running - Web Audio can be tricky in iframes/sandboxes
      if (ctx.state === 'suspended') {
        console.log("[Calibration] Resuming suspended AudioContext...");
        await ctx.resume();
      }
      console.log("[Calibration] AudioContext state:", ctx.state);
      
      // Attempt to set sink ID for output routing
      if (outputDeviceId && outputDeviceId !== 'default' && typeof (ctx as any).setSinkId === 'function') {
        try {
          console.log("[Calibration] Setting output device to:", outputDeviceId);
          await (ctx as any).setSinkId(outputDeviceId);
        } catch (e) {
          console.warn("Could not set sink ID:", e);
        }
      }
      
      // 1. Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: inputDeviceId && inputDeviceId !== 'default' 
          ? { deviceId: { exact: inputDeviceId }, latency: { ideal: 0.001 }, echoCancellation: false, noiseSuppression: false } as any
          : { latency: { ideal: 0.001 }, echoCancellation: false, noiseSuppression: false } as any
      });
      
      // 2. Setup recording
      const mediaRecorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => chunks.push(e.data);

      // 3. Prepare the beep (1kHz sine wave)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1000, ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      
      // We'll play it slightly after start
      const beepDelay = 0.3; // Increased delay slightly
      const startTimeInCtx = ctx.currentTime + beepDelay;
      
      gain.gain.setValueAtTime(0, startTimeInCtx);
      gain.gain.linearRampToValueAtTime(0.8, startTimeInCtx + 0.01);
      gain.gain.linearRampToValueAtTime(0.8, startTimeInCtx + 0.1);
      gain.gain.linearRampToValueAtTime(0, startTimeInCtx + 0.15);
      
      osc.connect(gain);
      gain.connect(ctx.destination);

      // 4. Start recording and play beep
      console.log("[Calibration] Recording start and scheduling beep for +0.3s");
      mediaRecorder.start();
      
      osc.start(startTimeInCtx);
      console.log("[Calibration] Oscillator started at ctx time:", startTimeInCtx);
      osc.stop(startTimeInCtx + 0.2);

      // Record for 1 second to capture the round trip
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      mediaRecorder.stop();
      stream.getTracks().forEach(t => t.stop());

      // 5. Analyze the recorded audio
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const data = audioBuffer.getChannelData(0);

        // Find the absolute maximum amplitude
        let maxAmplitude = 0;
        for (let i = 0; i < data.length; i++) {
          const abs = Math.abs(data[i]);
          if (abs > maxAmplitude) maxAmplitude = abs;
        }

        // Use 25% of the max amplitude as the threshold, but at least 0.05
        const threshold = Math.max(0.05, maxAmplitude * 0.25);

        // Find the first significant peak
        let peakIndex = -1;
        for (let i = 0; i < data.length; i++) {
          if (Math.abs(data[i]) > threshold) {
            peakIndex = i;
            break;
          }
        }

        if (peakIndex !== -1) {
          const detectedTimeMs = (peakIndex / audioBuffer.sampleRate) * 1000;
          // The beep was played at T=beepDelay (relative to recording start)
          // So the detected time minus beepDelay is the round-trip latency
          const latency = Math.round(detectedTimeMs - (beepDelay * 1000));
          // If the latency is negative, it means something went wrong or the recording started late
          setResult(Math.max(0, latency));
          setIsTesting(false);
        } else {
          setError("Could not detect the beep. Please check your microphone and volume.");
          setIsTesting(false);
        }
      };

    } catch (err) {
      console.error("Calibration error:", err);
      setError("Failed to access microphone or audio system.");
      setIsTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/80 backdrop-blur-md z-[110] p-6">
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-zinc-900 border border-white/10 rounded-2xl p-8 max-w-md w-full shadow-2xl"
      >
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-indigo-600/20 rounded-full flex items-center justify-center">
            <Activity className="w-6 h-6 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Калибровка задержки</h2>
            <p className="text-xs text-zinc-500">Синхронизируйте голос с видео</p>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-zinc-800/50 border border-white/5 p-4 rounded-xl text-sm text-zinc-400 leading-relaxed">
            Этот тест воспроизведет короткий "звуковой сигнал" и запишет его через микрофон для вычисления задержки системы. 
            <strong className="text-white block mt-2">Пожалуйста, увеличьте громкость динамиков и убедитесь, что микрофон находится рядом с ними.</strong>
          </div>

          {result !== null && (
            <motion.div 
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="bg-indigo-600/10 border border-indigo-500/30 p-6 rounded-2xl text-center"
            >
              <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 mb-1">Измеренная задержка</div>
              <div className="text-4xl font-black text-white">{result} <span className="text-xl font-normal opacity-50">мс</span></div>
            </motion.div>
          )}

          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 p-4 rounded-xl text-xs text-rose-400 text-center">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-3">
            {!result ? (
              <button
                onClick={runTest}
                disabled={isTesting}
                className="w-full py-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
                title="Запустить тест калибровки"
              >
                {isTesting ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
                {isTesting ? 'Тестирование...' : 'Запустить тест калибровки'}
              </button>
            ) : (
              <div className="flex gap-3">
                <button
                  onClick={runTest}
                  className="flex-1 py-4 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold flex items-center justify-center gap-2 transition-all"
                  title="Повторить тест"
                >
                  <RefreshCw className="w-4 h-4" /> Повторить
                </button>
                <button
                  onClick={() => onComplete(result)}
                  className="flex-[2] py-4 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
                  title="Применить измеренную задержку"
                >
                  <Check className="w-5 h-5" /> Применить смещение
                </button>
              </div>
            )}
            
            <button
              onClick={onClose}
              className="w-full py-3 text-zinc-500 hover:text-white transition-colors text-xs"
              title="Закрыть окно калибровки"
            >
              Отмена
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
