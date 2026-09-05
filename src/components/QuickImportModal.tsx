import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

interface QuickImportModalProps {
  show: boolean;
  onClose: () => void;
  text: string;
  onTextChange: (text: string) => void;
  duration: number;
  onDurationChange: (duration: number) => void;
  onImport: () => void;
}

const QuickImportModal: React.FC<QuickImportModalProps> = ({
  show,
  onClose,
  text,
  onTextChange,
  duration,
  onDurationChange,
  onImport
}) => {
  return (
    <AnimatePresence>
      {show && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="relative w-full max-w-2xl bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
          >
            <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
              <h2 className="text-xl font-bold">Быстрый импорт</h2>
              <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                <X className="w-5 h-5 text-zinc-400" />
              </button>
            </div>
            
            <div className="p-6 flex-1 overflow-y-auto flex flex-col gap-4">
              <p className="text-sm text-zinc-400">
                Вставьте сюда текст. Распознается стандартный скрипт "Актёр: Текст" или тайминги формата 00:00 - 00:05.
              </p>
              <textarea
                value={text}
                onChange={(e) => onTextChange(e.target.value)}
                placeholder="[Роль] 00:00 - 00:10 // Текст реплики //&#10;ИЛИ&#10;Актёр 1: Привет!"
                className="w-full h-64 bg-black/50 border border-white/10 rounded-xl p-4 text-sm font-mono focus:outline-none focus:border-indigo-500 resize-none"
              />
              <div className="flex items-center gap-4">
                <label className="text-sm text-zinc-400">Длительность сегмента по умолчанию (сек):</label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={duration}
                  onChange={(e) => onDurationChange(parseInt(e.target.value) || 5)}
                  className="w-20 bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="p-6 border-t border-white/5 bg-black/20 flex justify-end gap-3">
              <button onClick={onClose} className="px-6 py-2 rounded-xl font-bold text-sm hover:bg-white/5 transition-all">Отмена</button>
              <button onClick={onImport} className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-bold text-sm transition-all">Импорт</button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default QuickImportModal;
