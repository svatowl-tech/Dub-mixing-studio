import React from 'react';
import { Project, SubtitleLine } from '../types';
import { Monitor, Camera, Mic, Volume2, Settings2, Activity, Play, Pause, Circle } from 'lucide-react';

interface StudioDashboardProps {
  project: Project;
  currentTime: number;
  currentLine?: SubtitleLine;
  isPlaying: boolean;
  isRecording: boolean;
  onToggleBackstage: () => void;
}

const StudioDashboard: React.FC<StudioDashboardProps> = ({
  project,
  currentTime,
  currentLine,
  isPlaying,
  isRecording,
  onToggleBackstage
}) => {
  const isBackstageEnabled = project.audioSettings?.isBackstageEnabled || false;
  const isBackstageRecording = project.audioSettings?.backstageMode === 'manual' ? isRecording : (isRecording && isBackstageEnabled);
  
  const formatTime = (time: number) => {
    return `${Math.floor(time / 60)}:${Math.floor(time % 60).toString().padStart(2, '0')}.${(time % 1).toFixed(3).substring(2)}`;
  };

  return (
    <div className="w-full h-full flex flex-col p-6 bg-zinc-950/80 backdrop-blur-xl border border-white/5 shadow-2xl relative overflow-y-auto">
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-600 via-emerald-500 to-indigo-600 opacity-50" />
      
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-black text-white uppercase tracking-wider flex items-center gap-3">
            <Activity className="w-6 h-6 text-indigo-400" />
            Мониторинг Студии
          </h2>
          <p className="text-zinc-400 text-sm mt-1">
            Второй экран транслирует интерфейс суфлера и видео
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="px-4 py-2 bg-zinc-900 border border-white/10 rounded-xl flex items-center gap-3 shadow-inner">
            <div className={`w-2.5 h-2.5 rounded-full ${isPlaying ? 'bg-emerald-500 animate-pulse shadow-[0_0_10px_#10b981]' : 'bg-red-500'}`} />
            <span className="text-xs font-bold text-zinc-300 tracking-wider">
              {isPlaying ? 'ВОСПРОИЗВЕДЕНИЕ' : 'ОСТАНОВЛЕНО'}
            </span>
          </div>
          <div className="px-4 py-2 bg-zinc-900 border border-white/10 rounded-xl flex items-center gap-3 shadow-inner">
            <div className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-red-500 animate-pulse shadow-[0_0_10px_#ef4444]' : 'bg-zinc-600'}`} />
            <span className="text-xs font-bold text-zinc-300 tracking-wider">
              {isRecording ? 'ЗАПИСЬ ИДЕТ' : 'ОЖИДАНИЕ ЗАПИСИ'}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 h-full">
        {/* Left Column - Playback & Teleprompter status */}
        <div className="flex flex-col gap-6">
          <div className="bg-zinc-900/50 border border-white/10 rounded-2xl p-6 flex flex-col shadow-lg">
            <h3 className="text-sm font-bold text-zinc-400 mb-4 uppercase tracking-widest flex items-center gap-2">
              <Monitor className="w-4 h-4 text-zinc-500" />
              Текущий статус суфлера
            </h3>
            
            <div className="bg-black/40 rounded-xl p-5 border border-white/5 mb-4 shadow-inner">
              <div className="text-xs text-indigo-400 font-bold mb-2 uppercase tracking-wider">
                Роль: {project.selectedRole || 'Все роли'}
              </div>
              <div className="text-lg font-bold text-white mb-2 leading-relaxed font-sans">
                {currentLine ? currentLine.text : <span className="text-zinc-600 italic">Ожидание реплики...</span>}
              </div>
              <div className="text-2xl font-black font-mono text-indigo-300 mt-4 tracking-tight">
                {formatTime(currentTime)}
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4 mt-auto">
              <div className="bg-zinc-800/30 p-3 rounded-xl border border-white/5">
                <span className="text-[10px] text-zinc-500 uppercase font-black block mb-1">Аудио треков</span>
                <span className="text-xs text-zinc-300 font-mono bg-zinc-800 px-2 py-1 rounded inline-block">
                  {project.tracks.length}
                </span>
              </div>
              <div className="bg-zinc-800/30 p-3 rounded-xl border border-white/5">
                <span className="text-[10px] text-zinc-500 uppercase font-black block mb-1">Субтитров</span>
                <span className="text-xs text-zinc-300 font-mono bg-zinc-800 px-2 py-1 rounded inline-block">
                  {project.subtitles.length} строк
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column - Backstage & Monitoring */}
        <div className="flex flex-col gap-6">
          <div className="bg-zinc-900/50 border border-white/10 rounded-2xl p-6 shadow-lg flex-1">
            <h3 className="text-sm font-bold text-zinc-400 mb-4 uppercase tracking-widest flex items-center gap-2">
              <Camera className="w-4 h-4 text-zinc-500" />
              Управление Backstage
            </h3>

            <div className="flex items-center justify-between p-4 bg-zinc-800/40 rounded-xl border border-white/5 mb-6">
              <div>
                <div className="text-sm font-bold text-white mb-1">Съемка процесса (Backstage)</div>
                <div className="text-xs text-zinc-500">Запись с веб-камеры параллельно диктовке</div>
              </div>
              <button
                onClick={onToggleBackstage}
                className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors ${isBackstageEnabled ? 'bg-indigo-500' : 'bg-zinc-700'}`}
              >
                <span className={`inline-block w-5 h-5 transform rounded-full bg-white transition-transform ${isBackstageEnabled ? 'translate-x-8' : 'translate-x-1'}`} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-zinc-800/30 p-4 rounded-xl border border-white/5 flex flex-col items-center justify-center text-center">
                <Camera className={`w-8 h-8 mb-3 ${isBackstageEnabled ? 'text-indigo-400' : 'text-zinc-600'}`} />
                <span className="text-xs font-bold text-zinc-300 uppercase">Камера</span>
                <span className={`text-[10px] mt-1 px-2 py-0.5 rounded font-mono ${isBackstageEnabled ? 'bg-indigo-500/20 text-indigo-300' : 'bg-zinc-800 text-zinc-500'}`}>
                  {isBackstageEnabled ? 'АКТИВНА' : 'ВЫКЛЮЧЕНА'}
                </span>
              </div>
              
              <div className="bg-zinc-800/30 p-4 rounded-xl border border-white/5 flex flex-col items-center justify-center text-center">
                <Circle className={`w-8 h-8 mb-3 ${isBackstageRecording ? 'text-rose-500 animate-pulse fill-rose-500/20' : 'text-zinc-600'}`} />
                <span className="text-xs font-bold text-zinc-300 uppercase">Статус записи</span>
                <span className={`text-[10px] mt-1 px-2 py-0.5 rounded font-mono ${isBackstageRecording ? 'bg-rose-500/20 text-rose-300' : 'bg-zinc-800 text-zinc-500'}`}>
                  {isBackstageRecording ? 'ИДЕТ ЗАПИСЬ' : 'ОЖИДАНИЕ'}
                </span>
              </div>
            </div>

            <div className="p-4 bg-zinc-950/50 rounded-xl border border-white/5 text-xs text-zinc-400 leading-relaxed">
              <div className="flex items-center gap-2 mb-2 text-zinc-300 font-bold">
                <Settings2 className="w-4 h-4" />
                Настройки Бекстейджа:
              </div>
              Режим: <span className="font-mono text-indigo-300">{project.audioSettings?.backstageMode === 'manual' ? 'Ручной' : 'Синхронный'}</span><br/>
              Статус камеры: <span className="font-mono text-zinc-300">{project.audioSettings?.isBackstageEnabled ? 'Включена (настройки ОС)' : 'Выключена'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StudioDashboard;
