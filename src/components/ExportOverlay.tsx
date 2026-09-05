import React from 'react';
import { motion } from 'framer-motion';
import { Download } from 'lucide-react';

export const ExportOverlay = ({ progress, operation, onCancel }: { progress: number, operation?: string, onCancel: () => void }) => (
  <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm z-[100]">
    <motion.div 
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className="bg-zinc-900 border border-white/10 p-8 rounded-2xl shadow-2xl w-96 text-center"
    >
      <div className="w-20 h-20 bg-indigo-600/20 rounded-full flex items-center justify-center mx-auto mb-6">
        <Download className="w-10 h-10 text-indigo-400 animate-bounce" />
      </div>
      <h3 className="text-xl font-bold mb-2">Экспорт проекта</h3>
      <p className="text-zinc-400 text-sm mb-2">Сборка аудиодорожек и применение фильтров. Это может занять некоторое время.</p>
      {operation && (
        <p className="text-indigo-400 text-[10px] font-mono mb-6 animate-pulse uppercase tracking-widest">{operation}</p>
      )}
      
      <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden mb-4">
        <motion.div 
          className="absolute inset-y-0 left-0 bg-indigo-500"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-zinc-500 mb-8">
        <span>ПРОГРЕСС</span>
        <span>{Math.round(progress)}%</span>
      </div>

      <button 
        onClick={onCancel}
        className="text-xs text-zinc-500 hover:text-rose-400 transition-colors"
        title="Отменить экспорт"
      >
        Отменить экспорт
      </button>
    </motion.div>
  </div>
);

export default ExportOverlay;
