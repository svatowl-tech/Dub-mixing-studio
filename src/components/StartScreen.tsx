import React from 'react';
import { Plus, FolderOpen, Play, Sparkles, Cpu, Layers, Sliders } from 'lucide-react';

interface StartScreenProps {
  onNewProject: () => void;
  onOpenProject: () => void;
  recentProjects: { name: string; path: string }[];
}

export const StartScreen: React.FC<StartScreenProps> = ({ onNewProject, onOpenProject, recentProjects }) => {
  return (
    <div className="flex flex-col items-center justify-center h-screen bg-zinc-950 text-white p-8 font-sans">
      <div className="flex flex-col items-center mb-10 text-center">
        <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-600/20 border border-indigo-400/30 mb-4 animate-pulse">
          <Sliders className="w-9 h-9 text-white" />
        </div>
        <h1 className="text-4xl font-extrabold tracking-tight">Dub Mixing <span className="text-indigo-400">Studio</span></h1>
        <p className="text-sm text-zinc-500 font-bold mt-1.5 max-w-sm uppercase tracking-wide">Профессиональное сведение и AI-озвучка</p>
      </div>
      
      <div className="grid grid-cols-2 gap-6 w-full max-w-2xl">
        <button 
          onClick={onNewProject}
          className="flex flex-col items-center justify-center p-8 bg-zinc-900 border border-white/5 rounded-2xl hover:bg-indigo-900/10 hover:border-indigo-500/30 transition-all cursor-pointer group"
          title="Запустить новую сессию сведения"
        >
          <Plus className="w-12 h-12 mb-3.5 text-indigo-400 group-hover:scale-110 transition-transform" />
          <span className="text-base font-extrabold">Новая сессия сведения</span>
          <span className="text-[11px] text-zinc-500 mt-1 max-w-xs text-center">Пакетный импорт видео и raw-дорожек</span>
        </button>
        
        <button 
          onClick={onOpenProject}
          className="flex flex-col items-center justify-center p-8 bg-zinc-900 border border-white/5 rounded-2xl hover:bg-indigo-900/10 hover:border-indigo-500/30 transition-all cursor-pointer group"
          title="Открыть существующий проект"
        >
          <FolderOpen className="w-12 h-12 mb-3.5 text-indigo-400 group-hover:scale-110 transition-transform" />
          <span className="text-base font-extrabold">Открыть сессию</span>
          <span className="text-[11px] text-zinc-500 mt-1 max-w-xs text-center">Загрузить проект с диска (.json)</span>
        </button>
      </div>

      {/* Feature showcase */}
      <div className="mt-10 grid grid-cols-3 gap-6 max-w-2xl w-full border-t border-white/5 pt-8 text-center text-xs">
        <div className="space-y-1.5 p-3 bg-white/[0.02] border border-white/5 rounded-xl">
          <div className="flex items-center justify-center gap-1.5 text-orange-400 font-bold">
            <Cpu size={14} /> UVR v5 Сплиттер
          </div>
          <p className="text-[11px] text-zinc-500">Авторазделение оригинальной дороги на голоса и BGM/SFX</p>
        </div>

        <div className="space-y-1.5 p-3 bg-white/[0.02] border border-white/5 rounded-xl">
          <div className="flex items-center justify-center gap-1.5 text-indigo-400 font-bold">
            <Sparkles size={14} /> Нейро-Очистка вокала
          </div>
          <p className="text-[11px] text-zinc-500">Пакетный денойзер и эхоподавитель на базе ONNX бэкенда</p>
        </div>

        <div className="space-y-1.5 p-3 bg-white/[0.02] border border-white/5 rounded-xl">
          <div className="flex items-center justify-center gap-1.5 text-emerald-400 font-bold">
            <Layers size={14} /> Multitrack DAW
          </div>
          <p className="text-[11px] text-zinc-500">До 15 параллельных голосовых дорожек с низким джиттером</p>
        </div>
      </div>

      {recentProjects.length > 0 && (
        <div className="mt-10 w-full max-w-2xl">
          <h2 className="text-xs font-black text-zinc-500 uppercase tracking-widest mb-3 text-center md:text-left">Недавние сессии</h2>
          <div className="space-y-2">
            {recentProjects.map((proj, i) => (
              <div key={i} className="flex items-center justify-between p-4 bg-zinc-900 border border-white/5 rounded-xl hover:border-zinc-700 transition-all">
                <span className="font-bold text-xs">{proj.name}</span>
                <button className="p-2 hover:bg-white/5 rounded-lg transition-colors cursor-pointer" title="Открыть сессию"><Play className="w-4 h-4 text-indigo-400" /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
