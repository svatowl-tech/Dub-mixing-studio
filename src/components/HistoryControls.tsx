import React from 'react';
import { Undo2, Redo2 } from 'lucide-react';
import { useProjectData } from '../contexts/ProjectContext';
import { cn } from '../lib/utils';

const HistoryControls: React.FC = () => {
  const { undo, redo, canUndo, canRedo, undoDescription, redoDescription } = useProjectData();

  const undoTitle = canUndo
    ? `Отменить: ${undoDescription || 'Действие'} (Ctrl+Z)`
    : 'Отменить (Ctrl+Z)';

  const redoTitle = canRedo
    ? `Повторить: ${redoDescription || 'Действие'} (Ctrl+Y)`
    : 'Повторить (Ctrl+Y)';

  return (
    <div className="flex items-center gap-1 bg-zinc-800/80 px-2 py-1.5 rounded-lg border border-white/5 mr-2">
      <button
        onClick={undo}
        disabled={!canUndo}
        title={undoTitle}
        className={cn(
          "p-1.5 rounded-md transition-all",
          canUndo 
            ? "text-zinc-300 hover:text-white hover:bg-white/10 active:scale-95" 
            : "text-zinc-600 opacity-50 cursor-not-allowed"
        )}
      >
        <Undo2 size={16} />
      </button>
      <button
        onClick={redo}
        disabled={!canRedo}
        title={redoTitle}
        className={cn(
          "p-1.5 rounded-md transition-all",
          canRedo 
            ? "text-zinc-300 hover:text-white hover:bg-white/10 active:scale-95" 
            : "text-zinc-600 opacity-50 cursor-not-allowed"
        )}
      >
        <Redo2 size={16} />
      </button>
    </div>
  );
};

export default HistoryControls;
