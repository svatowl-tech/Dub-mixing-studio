import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Download, 
  Video, 
  AudioLines, 
  FileAudio, 
  Music, 
  Settings, 
  Layers,
  Sliders,
  Info,
  ChevronDown,
  ChevronUp,
  Cpu
} from 'lucide-react';

export interface ExportSettings {
  format: 'WAV' | 'MP3' | 'FLAC';
  includeVideo: boolean;
  includeOriginalAudio: boolean;
  forceMono: boolean;
  
  // Advanced Audio
  sampleRate: number;      // 44100, 48000, 96000
  bitDepth: '16' | '24' | '32';
  audioBitrate: string;    // '128k', '192k', '256k', '320k'
  channels: 'stereo' | 'mono';

  // Advanced Video
  videoCodec: string;      // 'libx264', 'libx265', 'h264_hardware'
  videoPreset: string;     // 'ultrafast' | 'fast' | 'medium' | 'slow'
  videoBitrate: string;    // 'auto' | '4M' | '8M' | '15M'
  videoPasses: number;     // 1 | 2
  videoResolution: string; // 'original' | '1080p' | '720p'
}

interface ExportModalProps {
  onExport: (options: ExportSettings) => void;
  onCancel: () => void;
  initialOptions?: {
    format: 'WAV' | 'MP3' | 'FLAC';
    includeVideo: boolean;
    includeOriginalAudio: boolean;
    forceMono: boolean;
  };
  duration?: number; // Project duration in seconds
}

export const ExportModal: React.FC<ExportModalProps> = ({ 
  onExport, 
  onCancel,
  initialOptions = { format: 'WAV', includeVideo: false, includeOriginalAudio: true, forceMono: false },
  duration = 120 // Fallback to 2 minutes
}) => {
  // Main settings
  const [includeVideo, setIncludeVideo] = useState(initialOptions.includeVideo);
  const [includeOriginalAudio, setIncludeOriginalAudio] = useState(initialOptions.includeOriginalAudio);
  const [format, setFormat] = useState<'WAV' | 'MP3' | 'FLAC'>(initialOptions.format);

  // Layout Tab Mode: 'presets' vs 'audio_pro' vs 'video_pro'
  const [activeTab, setActiveTab] = useState<'audio' | 'video' | 'info'>('audio');
  
  // Advanced Audio settings
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [bitDepth, setBitDepth] = useState<'16' | '24' | '32'>('24');
  const [audioBitrate, setAudioBitrate] = useState<string>('320k');
  const [channels, setChannels] = useState<'stereo' | 'mono'>(initialOptions.forceMono ? 'mono' : 'stereo');

  // Advanced Video settings
  const [videoCodec, setVideoCodec] = useState<string>('libx264');
  const [videoPreset, setVideoPreset] = useState<string>('medium');
  const [videoBitrate, setVideoBitrate] = useState<string>('auto');
  const [videoPasses, setVideoPasses] = useState<number>(1);
  const [videoResolution, setVideoResolution] = useState<string>('original');

  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);

  // Sync state when includeVideo changes
  useEffect(() => {
    if (includeVideo) {
      setActiveTab('video');
    } else {
      setActiveTab('audio');
    }
  }, [includeVideo]);

  // Calculate estimated file size in MB
  const calculateEstimatedSize = (): string => {
    if (includeVideo) {
      // Base audio bitrate calculation bytes/sec
      let audioBps = 192000 / 8; // standard AAC 192kbps
      if (format === 'MP3') {
        const rate = parseInt(audioBitrate) || 320;
        audioBps = (rate * 1000) / 8;
      } else if (format === 'WAV') {
        const depth = parseInt(bitDepth) || 24;
        audioBps = sampleRate * (depth / 8) * (channels === 'stereo' ? 2 : 1);
      }
      
      // Video bitrate (average) in bytes/sec
      let videoBps = 8000000 / 8; // default 8 Mbps
      if (videoBitrate === '4M') videoBps = 4000000 / 8;
      else if (videoBitrate === '15M') videoBps = 15000000 / 8;
      else if (videoPreset === 'slow') videoBps = 10000000 / 8; // slightly heavier
      else if (videoPreset === 'ultrafast') videoBps = 5000000 / 8; // lighter
      
      const totalBps = videoBps + audioBps;
      const totalBytes = totalBps * duration;
      return (totalBytes / (1024 * 1024)).toFixed(1) + ' MB';
    } else {
      // Audio-only estimation
      let bytesPerSec = 0;
      if (format === 'WAV') {
        const depth = parseInt(bitDepth) || 24;
        bytesPerSec = sampleRate * (depth / 8) * (channels === 'stereo' ? 2 : 1);
      } else if (format === 'FLAC') {
        // FLAC is compressed lossless, roughly 55% of WAV
        const depth = parseInt(bitDepth) || 24;
        bytesPerSec = sampleRate * (depth / 8) * (channels === 'stereo' ? 2 : 1) * 0.55;
      } else if (format === 'MP3') {
        const rate = parseInt(audioBitrate) || 320;
        bytesPerSec = (rate * 1000) / 8;
      }
      
      const totalBytes = bytesPerSec * duration;
      return (totalBytes / (1024 * 1024)).toFixed(2) + ' MB';
    }
  };

  const formattedDuration = (): string => {
    const mins = Math.floor(duration / 60);
    const secs = Math.floor(duration % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const handleApplyExport = () => {
    onExport({
      format,
      includeVideo,
      includeOriginalAudio,
      forceMono: channels === 'mono',
      sampleRate,
      bitDepth,
      audioBitrate,
      channels,
      videoCodec,
      videoPreset,
      videoBitrate,
      videoPasses,
      videoResolution
    });
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/85 backdrop-blur-md z-[200] p-4 text-zinc-100 font-sans">
      <motion.div 
        initial={{ scale: 0.96, opacity: 0, y: 15 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        className="bg-zinc-950 border border-white/10 rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Modal Header */}
        <div className="bg-zinc-900 px-6 py-4 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-lg">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base text-zinc-100">Мастер экспорта</h3>
              <p className="text-[10px] text-zinc-400">Профессиональное сведение проекта в высоком качестве</p>
            </div>
          </div>
          <div className="text-right">
            <span className="text-xs font-mono text-zinc-400 block">Длина: {formattedDuration()}</span>
            <span className="text-[9px] text-zinc-500 block uppercase tracking-wider font-bold">Timebase: 48k/24b</span>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Quick Core Mode Switcher */}
          <div className="bg-zinc-900/60 p-1.5 rounded-xl border border-white/5 flex gap-1">
            <button
              onClick={() => {
                setIncludeVideo(false);
                setIncludeOriginalAudio(true);
              }}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                !includeVideo && includeOriginalAudio 
                  ? "bg-indigo-600/90 text-white shadow-md shadow-indigo-600/10 border border-white/10" 
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
              }`}
            >
              <Music className="w-3.5 h-3.5" />
              Весь аудио-микс
            </button>
            <button
              onClick={() => {
                setIncludeVideo(false);
                setIncludeOriginalAudio(false);
              }}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                !includeVideo && !includeOriginalAudio 
                  ? "bg-emerald-600/90 text-white shadow-md shadow-emerald-600/10 border border-white/10" 
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
              }`}
            >
              <AudioLines className="w-3.5 h-3.5" />
              Микс без оригинала
            </button>
            <button
              onClick={() => {
                setIncludeVideo(true);
                setIncludeOriginalAudio(true);
              }}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                includeVideo 
                  ? "bg-purple-600/90 text-white shadow-md shadow-purple-600/10 border border-white/10" 
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
              }`}
            >
              <Video className="w-3.5 h-3.5" />
              Видео-микс с озвучкой
            </button>
          </div>

          {/* Quick Notice */}
          <div className="p-3 bg-zinc-900 border border-white/5 rounded-xl text-xs text-zinc-300 flex items-start gap-2.5">
            <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-white block mb-0.5">Внимание к уровням микширования:</span>
              При экспорте будут строго применены абсолютные уровни громкости всех дорожек и их мьюты, установленные вами на таймлайне. Эйсинг и панорамирование сохраняются.
            </div>
          </div>

          {/* Tabs Settings Headers */}
          <div className="border-b border-white/5 flex gap-4 text-xs">
            <button
              onClick={() => setActiveTab('audio')}
              className={`pb-2.5 font-bold transition-colors border-b-2 px-1 cursor-pointer ${
                activeTab === 'audio' 
                  ? 'border-indigo-500 text-white' 
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Настройки Аудио
            </button>
            {includeVideo && (
              <button
                onClick={() => setActiveTab('video')}
                className={`pb-2.5 font-bold transition-colors border-b-2 px-1 cursor-pointer ${
                  activeTab === 'video' 
                    ? 'border-purple-500 text-white' 
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Кодирование Видео
              </button>
            )}
            <button
              onClick={() => setActiveTab('info')}
              className={`pb-2.5 font-bold transition-colors border-b-2 px-1 cursor-pointer ${
                activeTab === 'info' 
                  ? 'border-zinc-500 text-white' 
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Спецификация Экспорта
            </button>
          </div>

          {/* Tab Contents */}
          <div className="space-y-4">
            {activeTab === 'audio' && (
              <div className="space-y-4">
                {/* Format selection */}
                <div className="grid grid-cols-3 gap-2">
                  {(['WAV', 'FLAC', 'MP3'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setFormat(f)}
                      className={`py-3 rounded-lg text-xs font-bold transition-all border cursor-pointer ${
                        format === f 
                          ? "bg-zinc-800 border-indigo-500 text-white text-glow shadow-inner" 
                          : "bg-zinc-900 border-white/5 hover:border-white/10 text-zinc-400"
                      }`}
                    >
                      <span className="block text-[14px] font-mono tracking-tight font-extrabold">{f}</span>
                      <span className="text-[9px] text-zinc-500 font-normal block mt-1">
                        {f === 'WAV' && 'Студийный несжатый'}
                        {f === 'FLAC' && 'Экономный Lossless'}
                        {f === 'MP3' && 'Mpeg Сжатие'}
                      </span>
                    </button>
                  ))}
                </div>

                {/* Sample Rate */}
                <div>
                  <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Частота дискретизации (Sample Rate)</label>
                  <select
                    value={sampleRate}
                    onChange={e => setSampleRate(Number(e.target.value))}
                    className="w-full bg-zinc-900 border border-white/5 rounded-lg px-3 py-2 text-xs font-bold text-zinc-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
                  >
                    <option value={44100}>44 100 Hz — Стандарт CD качества</option>
                    <option value={48000}>48 000 Hz — Стандарт видео озвучки (Рекомендовано)</option>
                    <option value={96000}>96 000 Hz — Ultra High-End Studio Mastering</option>
                  </select>
                </div>

                {/* Bit Depth or MP3 bitrate */}
                {format !== 'MP3' ? (
                  <div>
                    <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Битность квантования (Bit Depth)</label>
                    <div className="grid grid-cols-3 gap-2">
                      {(['16', '24', '32'] as const).map(depth => (
                        <button
                          key={depth}
                          onClick={() => setBitDepth(depth)}
                          className={`py-2 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${
                            bitDepth === depth 
                              ? "bg-indigo-600/30 border-indigo-500 text-white" 
                              : "bg-zinc-900 border-white/5 text-zinc-400 hover:border-white/10"
                          }`}
                        >
                          {depth === '16' && '16-bit PCM'}
                          {depth === '24' && '24-bit HD Study'}
                          {depth === '32' && '32-bit Float'}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Постоянный битрейт MP3 (MP3 Bitrate)</label>
                    <div className="grid grid-cols-4 gap-2">
                      {(['128k', '192k', '256k', '320k'] as const).map(rate => (
                        <button
                          key={rate}
                          onClick={() => setAudioBitrate(rate)}
                          className={`py-2 rounded-lg text-xs font-bold border font-mono transition-colors cursor-pointer ${
                            audioBitrate === rate 
                              ? "bg-indigo-600/30 border-indigo-500 text-white" 
                              : "bg-zinc-900 border-white/5 text-zinc-400 hover:border-white/10"
                          }`}
                        >
                          {rate}bps
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Channel layout config */}
                <div>
                  <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Конфигурация выходов (Channels)</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setChannels('stereo')}
                      className={`py-2 px-3 rounded-lg text-xs font-bold border transition-colors flex items-center justify-between cursor-pointer ${
                        channels === 'stereo' 
                          ? "bg-indigo-600/30 border-indigo-500 text-white" 
                          : "bg-zinc-900 border-white/5 text-zinc-400 hover:border-white/10"
                      }`}
                    >
                      <span>Стерео-микс</span>
                      <span className="text-[8px] opacity-75 px-1 py-0.5 bg-zinc-800 rounded">Stereo (2.0)</span>
                    </button>
                    <button
                      onClick={() => setChannels('mono')}
                      className={`py-2 px-3 rounded-lg text-xs font-bold border transition-colors flex items-center justify-between cursor-pointer ${
                        channels === 'mono' 
                          ? "bg-indigo-600/30 border-indigo-500 text-white" 
                          : "bg-zinc-900 border-white/5 text-zinc-400 hover:border-white/10"
                      }`}
                    >
                      <span>Сложить в моно</span>
                      <span className="text-[8px] opacity-75 px-1 py-0.5 bg-zinc-800 rounded">Mono (1.0)</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'video' && includeVideo && (
              <div className="space-y-4">
                {/* Video codec Selector */}
                <div>
                  <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Семейство кодеков видео (Video Codec)</label>
                  <select
                    value={videoCodec}
                    onChange={e => setVideoCodec(e.target.value)}
                    className="w-full bg-zinc-900 border border-white/5 rounded-lg px-3 py-2 text-xs font-bold text-zinc-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
                  >
                    <option value="libx264">H.264 (Compatible / Рекомендовано для дистрибуции)</option>
                    <option value="libx265">H.265 / HEVC (High Efficiency / Максимальное сжатие)</option>
                    <option value="copy">Пассивное слияние (Без перекодирования исходного потока - Моментально!)</option>
                  </select>
                </div>

                {/* Bitrate Selection */}
                <div>
                  <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Целевой битрейт видеопотока (Video Bitrate)</label>
                  <div className="grid grid-cols-4 gap-2">
                    {(['auto', '4M', '8M', '15M'] as const).map(bt => (
                      <button
                        key={bt}
                        disabled={videoCodec === 'copy'}
                        onClick={() => setVideoBitrate(bt)}
                        className={`py-2 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${
                          videoCodec === 'copy' ? "opacity-30 cursor-not-allowed bg-zinc-800 text-zinc-500" :
                          videoBitrate === bt 
                            ? "bg-purple-600/30 border-purple-500 text-white" 
                            : "bg-zinc-900 border-white/5 text-zinc-400 hover:border-white/10"
                        }`}
                      >
                        {bt === 'auto' && 'Авто'}
                        {bt === '4M' && '4 Mbps'}
                        {bt === '8M' && '8 Mbps'}
                        {bt === '15M' && '15 Mbps'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Collapsible advanced video */}
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1 text-[10px] font-bold text-zinc-500 hover:text-indigo-400 transition-colors uppercase cursor-pointer"
                >
                  {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  Дополнительные параметры кодера
                </button>

                <AnimatePresence>
                  {showAdvanced && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="space-y-4 pt-1 border-t border-white/5 overflow-hidden"
                    >
                      {/* Presets */}
                      <div>
                        <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Предустановка скорости/качества (Presets)</label>
                        <div className="grid grid-cols-4 gap-1.5 text-[10px]">
                          {(['ultrafast', 'fast', 'medium', 'slow'] as const).map(pr => (
                            <button
                              key={pr}
                              disabled={videoCodec === 'copy'}
                              onClick={() => setVideoPreset(pr)}
                              className={`py-1.5 rounded transition-all cursor-pointer ${
                                videoCodec === 'copy' ? "opacity-30 bg-zinc-850 text-zinc-600" :
                                videoPreset === pr 
                                  ? "bg-indigo-500 text-white font-bold" 
                                  : "bg-zinc-900 border border-white/5 text-zinc-400 hover:bg-zinc-800"
                              }`}
                            >
                              {pr}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Number of passes */}
                      <div>
                        <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Метод распределения битрейта (Encoding Passes)</label>
                        <div className="flex gap-2 text-[10px]">
                          <button
                            disabled={videoCodec === 'copy'}
                            onClick={() => setVideoPasses(1)}
                            className={`flex-1 py-1.5 rounded font-bold cursor-pointer ${
                              videoCodec === 'copy' ? "opacity-30 bg-zinc-850 text-zinc-600" :
                              videoPasses === 1 ? "bg-purple-600 text-white" : "bg-zinc-900 border border-white/5 text-zinc-400"
                            }`}
                          >
                            1-Pass (Мгновенное кодирование)
                          </button>
                          <button
                            disabled={videoCodec === 'copy'}
                            onClick={() => setVideoPasses(2)}
                            className={`flex-1 py-1.5 rounded font-bold cursor-pointer ${
                              videoCodec === 'copy' ? "opacity-30 bg-zinc-850 text-zinc-600" :
                              videoPasses === 2 ? "bg-purple-600 text-white" : "bg-zinc-900 border border-white/5 text-zinc-400"
                            }`}
                          >
                            2-Pass (Идеальное распределение битрейта)
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {activeTab === 'info' && (
              <div className="p-4 bg-zinc-900 rounded-xl border border-white/5 space-y-3.5 text-xs text-zinc-300">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="text-zinc-500 font-bold uppercase text-[10px]">Тип экспорта:</span>
                  <span className="font-bold text-indigo-400">
                    {includeVideo ? 'Ремультиплексирование в Видео MP4' : 'Сведение Аудио'}
                  </span>
                </div>
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="text-zinc-500 font-bold uppercase text-[10px]">Оригинальный трек:</span>
                  <span className={includeOriginalAudio ? 'text-emerald-400 font-bold' : 'text-zinc-400 font-bold'}>
                    {includeOriginalAudio ? 'Сведение (Включен в микс)' : 'Исключен из микса'}
                  </span>
                </div>
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="text-zinc-500 font-bold uppercase text-[10px]">Аудио-кодек:</span>
                  <span className="font-mono">{format === 'WAV' ? 'PCM Linear (Lossless)' : format === 'FLAC' ? 'FLAC' : 'LAME MP3 (Squeeze)'}</span>
                </div>
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="text-zinc-500 font-bold uppercase text-[10px]">Характеристики микса:</span>
                  <span className="font-mono text-zinc-100 font-bold">
                    {channels === 'stereo' ? 'Stereo' : 'Mono'} @ {sampleRate / 1000} kHz, {format === 'MP3' ? audioBitrate : `${bitDepth}-bit`}
                  </span>
                </div>
                {includeVideo && (
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500 font-bold uppercase text-[10px]">Сегментация видео:</span>
                    <span className="font-mono text-purple-400">
                      Codec: {videoCodec === 'copy' ? 'Direct Stream Copy (Fastest)' : videoCodec}, preset: {videoPreset}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Real-time calculated file specifications panel */}
          <div className="bg-indigo-950/20 border border-indigo-500/20 p-4 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 bg-indigo-500/15 rounded-lg text-indigo-400">
                <Cpu className="w-4 h-4" />
              </div>
              <div>
                <span className="text-[10px] text-zinc-400 block font-bold uppercase tracking-wider">Расчётный вес файла</span>
                <span className="text-sm font-extrabold text-indigo-300 font-mono tracking-wide">{calculateEstimatedSize()}</span>
              </div>
            </div>
            
            <span className="text-[10px] px-2.5 py-1 bg-zinc-900 border border-white/10 rounded-full font-mono font-bold text-zinc-400">
              {format === 'WAV' ? 'uncompressed' : 'compressed'}
            </span>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="bg-zinc-900 px-6 py-4 border-t border-white/5 flex gap-3">
          <button 
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-lg text-xs font-bold bg-zinc-850 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer border border-white/5"
          >
            Отмена
          </button>
          <button 
            type="button"
            onClick={handleApplyExport}
            className="flex-1 py-2.5 rounded-lg text-xs font-bold bg-indigo-600 text-white hover:bg-indigo-500 shadow-md shadow-indigo-600/20 hover:shadow-indigo-600/40 transition-all flex items-center justify-center gap-2 cursor-pointer border border-indigo-500"
          >
            <Download className="w-3.5 h-3.5" />
            Экспортировать
          </button>
        </div>
      </motion.div>
    </div>
  );
};

export default ExportModal;
