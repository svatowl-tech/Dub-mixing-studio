import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download } from 'lucide-react';

interface ExportOverlayProps {
  isExporting: boolean;
  exportProgress: number;
  exportOperation: string;
}

export const ExportOverlay: React.FC<ExportOverlayProps> = ({
  isExporting,
  exportProgress,
  exportOperation
}) => {
  return (
    <AnimatePresence>
      {isExporting && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="relative w-full max-w-sm bg-zinc-900 border border-white/10 rounded-2xl p-8 text-center shadow-2xl"
          >
            <div className="w-16 h-16 bg-indigo-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              >
                <Download className="w-8 h-8 text-indigo-400" />
              </motion.div>
            </div>
            <h3 className="text-xl font-bold mb-2">Exporting Project...</h3>
            {exportOperation && (
              <p className="text-indigo-400 text-[10px] font-mono mb-2 animate-pulse uppercase tracking-widest">{exportOperation}</p>
            )}
            <p className="text-sm text-zinc-400 mb-8">Merging audio tracks and syncing with video. Please wait.</p>
            
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-4">
              <motion.div 
                className="h-full bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.5)]"
                initial={{ width: 0 }}
                animate={{ width: `${exportProgress}%` }}
              />
            </div>
            <div className="flex justify-between items-center text-xs font-bold uppercase tracking-widest">
              <span className="text-zinc-500">Progress</span>
              <span className="text-indigo-400">{Math.round(exportProgress)}%</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default ExportOverlay;
