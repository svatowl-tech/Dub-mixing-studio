import React, { useState } from 'react';
import { Fix } from '../types';

export const FixesPanel = ({ fixes, onJump, onResolve, onParse }: { fixes: Fix[], onJump: (t: number) => void, onResolve: (id: string) => void, onParse: (fixes: Fix[]) => void }) => {
  const [rawText, setRawText] = useState('');
  
  const handleParse = async () => {
    if (!window.electronAPI) return;
    const parsedRes = await (window.electronAPI as any).parseFixes(rawText, (window as any).currentProjectSubtitles || []);
    if (parsedRes && parsedRes.success) {
      onParse(parsedRes.data || []);
    } else if (Array.isArray(parsedRes)) {
      // Fallback in case it wasn't wrapped
      onParse(parsedRes);
    }
  };
  
  return (
    <div className="w-80 border-l border-white/10 bg-zinc-900 flex flex-col">
      <div className="p-4 border-b border-white/10">
        <h3 className="font-bold mb-2">Исправления</h3>
        <textarea 
          className="w-full h-32 bg-zinc-800 rounded p-2 text-xs"
          placeholder="Вставьте исправления сюда..."
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
        />
        <button onClick={handleParse} className="mt-2 w-full bg-indigo-600 py-1 rounded text-xs font-bold" title="Разобрать и применить исправления">Применить</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {fixes.map(fix => (
          <div key={fix.id} className="p-3 border-b border-white/5 hover:bg-white/5 cursor-pointer" onClick={() => onJump(fix.timestamp)} title="Перейти к моменту исправления">
            <div className="text-[10px] text-indigo-400 font-bold">[{Math.floor(fix.timestamp/60)}:{String(fix.timestamp%60).padStart(2,'0')}] - {fix.actor}</div>
            <div className="text-xs">{fix.comment}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
