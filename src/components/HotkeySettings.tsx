import React, { useState, useEffect } from 'react';
import { KeyMap, HotkeyAction } from '../types';
import { Keyboard, RotateCcw, Save } from 'lucide-react';
import { cn, getDefaultKeyMap, formatHotkey, safeConfirm } from '../lib/utils';

interface HotkeySettingsProps {
  keyMap: KeyMap;
  onChange: (newKeyMap: KeyMap) => void;
}

export const HotkeySettings: React.FC<HotkeySettingsProps> = ({ keyMap, onChange }) => {
  const [localKeyMap, setLocalKeyMap] = useState<KeyMap>(keyMap || getDefaultKeyMap());
  const [activeAction, setActiveAction] = useState<string | null>(null);

  useEffect(() => {
    if (keyMap && typeof keyMap === 'object') {
      setLocalKeyMap(keyMap);
    }
  }, [keyMap]);

  useEffect(() => {
    if (!activeAction || !localKeyMap || typeof localKeyMap !== 'object') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore modifier-only presses
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      const currentAction = localKeyMap[activeAction];
      if (!currentAction) {
        setActiveAction(null);
        return;
      }

      const newAction: HotkeyAction = {
        ...currentAction,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey
      };

      const updatedMap = {
        ...localKeyMap,
        [activeAction]: newAction
      };

      setLocalKeyMap(updatedMap);
      onChange(updatedMap);
      setActiveAction(null);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [activeAction, localKeyMap, onChange]);

    const handleReset = async () => {
    if (await safeConfirm('Сбросить все горячие клавиши по умолчанию?')) {
      const defaultMap = getDefaultKeyMap();
      setLocalKeyMap(defaultMap);
      onChange(defaultMap);
    }
  };

  if (!localKeyMap || typeof localKeyMap !== 'object') return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Настройка горячих клавиш</label>
        <button 
          onClick={handleReset}
          className="text-[10px] font-bold text-zinc-500 hover:text-amber-500 transition-colors uppercase tracking-widest flex items-center gap-1"
        >
          <RotateCcw size={10} />
          Сброс
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
        {Object.entries(localKeyMap as KeyMap).map(([id, action]) => (
          <div key={id} className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-xl border border-white/5 hover:border-white/10 transition-colors">
            <span className="text-xs font-medium text-zinc-300">{(action as HotkeyAction).label}</span>
            <button
              onClick={() => setActiveAction(id)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold border transition-all min-w-[100px]",
                activeAction === id 
                  ? "bg-indigo-500 border-indigo-400 text-white animate-pulse" 
                  : "bg-zinc-900 border-white/5 text-zinc-400 hover:text-white hover:border-white/20"
              )}
            >
              {activeAction === id ? 'Нажмите клавишу...' : formatHotkey(action as HotkeyAction)}
            </button>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-zinc-500 text-center italic">
        * Нажмите на кнопку с клавишей и затем нажмите желаемую комбинацию на клавиатуре. Изменения сохраняются автоматически.
      </p>
    </div>
  );
};
