import React, { useState, useEffect } from 'react';
import { cn } from '../lib/utils';

export const AudioDeviceManager = ({ 
  settings, 
  onSettingsChange 
}: { 
  settings: any, 
  onSettingsChange: (s: any) => void 
}) => {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    const getDevices = async () => {
      try {
        let backstageAudioDevices: MediaDeviceInfo[] = [];
        if ((window as any).electronAPI) {
          const response = await (window as any).electronAPI.getAudioDevices();
          if (response.success && response.data) {
            const asioDevices = response.data.filter((d: any) => d.host === "ASIO" || d.host === "Wasapi" || d.host === "CoreAudio");
            backstageAudioDevices = asioDevices.map((d: any) => ({
              deviceId: d.name,
              groupId: d.host, 
              kind: 'audioinput',
              label: `${d.name} (${d.max_input_channels} ch) [${d.host}]`
            }));
          }
        }

        const audioPromise = navigator.mediaDevices.getUserMedia({ audio: true }).catch(err => null);
        const videoPromise = navigator.mediaDevices.getUserMedia({ video: true }).catch(err => null);

        const [audioStream, videoStream] = await Promise.all([audioPromise, videoPromise]);
        
        audioStream?.getTracks().forEach(t => t.stop());
        videoStream?.getTracks().forEach(t => t.stop());

        const devs = await navigator.mediaDevices.enumerateDevices();
        
        const combined = [
          ...backstageAudioDevices,
          ...devs.filter(d => d.kind === 'videoinput' || d.kind === 'audiooutput' || (d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'))
        ];
        
        // Ensure unique devices by deviceId
        const uniqueDevices = Array.from(new Map(combined.map(item => [item.deviceId, item])).values());
        
        setDevices(uniqueDevices);
      } catch (err) {
        console.error("Error enumerating devices:", err);
      }
    };
    getDevices();
    navigator.mediaDevices.addEventListener('devicechange', getDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', getDevices);
  }, []);

  const inputDevices = devices.filter(d => d.kind === 'audioinput');

  const outputDevices = devices.filter(d => d.kind === 'audiooutput');
  const videoDevices = devices.filter(d => d.kind === 'videoinput');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className="text-[10px] font-bold text-zinc-500 mb-2 block uppercase tracking-widest">Устройство ввода</label>
          <select 
            value={settings.deviceId}
            onChange={(e) => {
              const deviceId = e.target.value;
              const selectedDevice = devices.find(d => d.deviceId === deviceId);
              const isAsio = selectedDevice && (selectedDevice.groupId === "ASIO" || selectedDevice.groupId === "Wasapi");
              const newSettings = { 
                ...settings, 
                deviceId,
                asioMode: isAsio, // auto scale for engine
                host: isAsio ? selectedDevice.groupId : undefined
              };
              
              onSettingsChange(newSettings);
            }}
            className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none transition-all"
          >
            {inputDevices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Микрофон ${d.deviceId.slice(0, 5)}`}</option>
            ))}
          </select>
        </div>

        {settings.asioMode && (
          <div>
            <label className="text-[10px] font-bold text-zinc-500 mb-2 block uppercase tracking-widest">Канал ввода</label>
            <select 
              value={settings.channelIndex || 0}
              onChange={(e) => onSettingsChange({ ...settings, channelIndex: parseInt(e.target.value) })}
              className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none transition-all"
            >
              {(() => {
                const selectedDevice = devices.find(d => d.deviceId === settings.deviceId);
                // Extract channel count from label "(X ch)" if possible, or default to 8 for safety
                const chMatch = selectedDevice?.label?.match(/\((\d+)\s+ch\)/);
                const channels = chMatch ? parseInt(chMatch[1]) : 8;
                return Array.from({ length: channels }).map((_, i) => (
                  <option key={i} value={i}>Input {i + 1}</option>
                ));
              })()}
            </select>
          </div>
        )}
      </div>

      <div>
        <label className="text-[10px] font-bold text-zinc-500 mb-2 block uppercase tracking-widest">Устройство вывода</label>
        <select 
          value={settings.outputDeviceId}
          onChange={(e) => onSettingsChange({ ...settings, outputDeviceId: e.target.value })}
          className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none transition-all"
        >
          {outputDevices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Выход ${d.deviceId.slice(0, 5)}`}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[10px] font-bold text-zinc-500 mb-2 block uppercase tracking-widest">Веб-камера (Видео)</label>
        <select 
          value={settings.webcamDeviceId}
          onChange={(e) => onSettingsChange({ ...settings, webcamDeviceId: e.target.value })}
          className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none transition-all"
        >
          <option value="">Нет</option>
          {videoDevices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Камера ${d.deviceId.slice(0, 5)}`}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[10px] font-bold text-zinc-500 mb-2 block uppercase tracking-widest">Веб-камера (Звук)</label>
        <select 
          value={settings.backstageAudioDeviceId || 'default'}
          onChange={(e) => onSettingsChange({ ...settings, backstageAudioDeviceId: e.target.value })}
          className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none transition-all"
        >
          <option value="default">По умолчанию</option>
          <option value="none">Без звука</option>
          {inputDevices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Микрофон ${d.deviceId.slice(0, 5)}`}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-[10px] font-bold text-zinc-500 mb-2 block uppercase tracking-widest">Разрешение веб-камеры</label>
          <select 
            value={settings.webcamResolutionY || 1080}
            onChange={(e) => {
              const y = parseInt(e.target.value);
              const x = y === 2160 ? 3840 : (y === 1080 ? 1920 : 1280);
              onSettingsChange({ ...settings, webcamResolutionY: y, webcamResolutionX: x })
            }}
            className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none transition-all"
          >
            <option value={720}>720p (HD)</option>
            <option value={1080}>1080p (Full HD)</option>
            <option value={2160}>4K (UHD)</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] font-bold text-zinc-500 mb-2 block uppercase tracking-widest">Битрейт вебкамеры</label>
          <select 
            value={settings.webcamBitrate || 5000000}
            onChange={(e) => onSettingsChange({ ...settings, webcamBitrate: parseInt(e.target.value) })}
            className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 outline-none transition-all"
          >
            <option value={2500000}>2.5 Mbps (Низкий)</option>
            <option value={5000000}>5 Mbps (Средний)</option>
            <option value={10000000}>10 Mbps (Высокий)</option>
            <option value={20000000}>20 Mbps (Максимум)</option>
          </select>
        </div>
      </div>

      <div className="pt-2 border-t border-white/5 mt-2">
        <label className="text-[10px] font-bold text-zinc-500 mb-3 block uppercase tracking-widest">Рендер Бекстейджа</label>
        <div className="flex items-center gap-4 bg-zinc-900/50 p-3 rounded-xl border border-white/5">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => onSettingsChange({ ...settings, webcamExportOverlay: settings.webcamExportOverlay === false ? true : false })}>
            <div className={cn(
              "w-8 h-4 rounded-full transition-all relative",
              settings.webcamExportOverlay !== false ? "bg-indigo-600" : "bg-zinc-700"
            )}>
              <div className={cn(
                "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all shadow-sm",
                settings.webcamExportOverlay !== false ? "left-4.5" : "left-0.5"
              )} />
            </div>
            <span className="text-[10px] font-bold text-zinc-300">Пайплайн Overlay</span>
          </div>
        </div>
        <p className="text-[9px] text-zinc-500 mt-2 px-1">
          При включении, бекстейдж будет экспортироваться с наложением на основное видео (как PiP). При выключении - будет экспортироваться только само видео с веб-камеры со звуком.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 pt-2">
        <div>
          <label className="text-xs font-bold text-zinc-400 mb-2 block uppercase tracking-widest">Разрядность (бит)</label>
          <div className="flex gap-2">
            {[16, 24, 32].map(bit => (
              <button
                key={bit}
                onClick={() => onSettingsChange({ ...settings, bitDepth: bit as 16 | 24 | 32 })}
                className={cn(
                  "flex-1 py-2 rounded-lg text-[10px] font-bold border transition-all",
                  settings.bitDepth === bit 
                    ? "bg-indigo-600 border-indigo-500 text-white" 
                    : "bg-zinc-800 border-white/5 text-zinc-400 hover:bg-zinc-700"
                )}
              >
                {bit}-бит {bit === 32 ? 'Float' : 'PCM'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-bold text-zinc-400 mb-2 block uppercase tracking-widest">Частота дискретизации</label>
          <select 
            value={settings.sampleRate}
            onChange={(e) => onSettingsChange({ ...settings, sampleRate: parseInt(e.target.value) })}
            className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
          >
            <option value={44100}>44.1 kHz</option>
            <option value={48000}>48.0 kHz</option>
            <option value={96000}>96.0 kHz</option>
          </select>
        </div>
      </div>

      <div className="pt-2 border-t border-white/5 mt-2">
        <label className="text-[10px] font-bold text-zinc-500 mb-3 block uppercase tracking-widest">Обработка входа (Noise Gate)</label>
        <div className="flex items-center gap-4 bg-zinc-900/50 p-3 rounded-xl border border-white/5">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => onSettingsChange({ ...settings, isNoiseGateEnabled: !settings.isNoiseGateEnabled })}>
            <div className={cn(
              "w-8 h-4 rounded-full transition-all relative",
              settings.isNoiseGateEnabled ? "bg-indigo-600" : "bg-zinc-700"
            )}>
              <div className={cn(
                "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all shadow-sm",
                settings.isNoiseGateEnabled ? "left-4.5" : "left-0.5"
              )} />
            </div>
            <span className="text-[10px] font-bold text-zinc-300">Включить</span>
          </div>

          <div className="flex-1 flex flex-col gap-1">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Порог срабатывания</span>
              <span className="text-[10px] text-indigo-400 font-mono font-bold">{settings.noiseGateThreshold} dB</span>
            </div>
            <input 
              type="range"
              min="-70"
              max="-10"
              step="1"
              value={settings.noiseGateThreshold || -45}
              onChange={(e) => onSettingsChange({ ...settings, noiseGateThreshold: parseInt(e.target.value) })}
              disabled={!settings.isNoiseGateEnabled}
              className="w-full accent-indigo-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer disabled:opacity-30"
            />
          </div>
        </div>
        <p className="text-[9px] text-zinc-500 mt-2 px-1">
          Noise Gate автоматически отключает микрофон, когда вы не говорите, убирая шум кликов и окружения.
        </p>
      </div>

      <div className="pt-2 border-t border-white/5 mt-2">
        <label className="text-[10px] font-bold text-zinc-500 mb-3 block uppercase tracking-widest">Воспроизведение оригинала</label>
        <div className="flex items-center gap-4 bg-zinc-900/50 p-3 rounded-xl border border-white/5">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => onSettingsChange({ ...settings, playOriginalTrackSegments: !settings.playOriginalTrackSegments })}>
            <div className={cn(
              "w-8 h-4 rounded-full transition-all relative",
              settings.playOriginalTrackSegments ? "bg-indigo-600" : "bg-zinc-700"
            )}>
              <div className={cn(
                "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all shadow-sm",
                settings.playOriginalTrackSegments ? "left-4.5" : "left-0.5"
              )} />
            </div>
            <span className="text-[10px] font-bold text-zinc-300">Проигрывать нарезку</span>
          </div>
        </div>
        <p className="text-[9px] text-zinc-500 mt-2 px-1">
          По умолчанию воспроизведение видеофайла отдает оригинальный звук. Включение этой опции заставит плеер напрямую проигрывать аудио реплики на треке «Оригинал» (для проектов без единого мастер-видео/звукового файла).
        </p>
      </div>
    </div>
  );
};

export default AudioDeviceManager;
