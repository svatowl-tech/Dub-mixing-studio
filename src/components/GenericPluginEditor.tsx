import React, { useEffect, useState } from 'react';
import { PluginParameter, getPluginParameters, setPluginParameter } from '../lib/vstHost';
import { cn } from '../lib/utils';
import { Settings2, X, Info } from 'lucide-react';

interface GenericPluginEditorProps {
  instanceId: string;
  pluginName: string;
  onClose: () => void;
  onParameterChange?: (paramId: number, value: number) => void;
}

export const GenericPluginEditor: React.FC<GenericPluginEditorProps> = ({
  instanceId,
  pluginName,
  onClose,
  onParameterChange
}) => {
  const [parameters, setParameters] = useState<PluginParameter[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchParams = async () => {
      try {
        const params = await getPluginParameters(instanceId);
        setParameters(params);
        setLoading(false);
      } catch (err) {
        console.error("Failed to fetch VST params:", err);
        setLoading(false);
      }
    };

    fetchParams();
  }, [instanceId]);

  const handleParamChange = (paramId: number, value: number) => {
    setParameters(prev => prev.map(p => p.id === paramId ? { ...p, value } : p));
    setPluginParameter(instanceId, paramId, value);
    if (onParameterChange) onParameterChange(paramId, value);
  };

  return (
    <div className="bg-zinc-950 border border-white/10 rounded-2xl shadow-2xl overflow-hidden w-[480px] max-h-[600px] flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 bg-zinc-900/50 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/10 rounded-lg">
            <Settings2 className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-zinc-100">{pluginName}</h3>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-black">Generic Editor</p>
          </div>
        </div>
        <button 
          onClick={onClose}
          className="p-2 hover:bg-white/5 rounded-lg transition-colors text-zinc-500 hover:text-zinc-100"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Params area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <div className="w-6 h-6 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
            <p className="text-xs text-zinc-500 font-medium">Scanning parameters...</p>
          </div>
        ) : parameters.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Info className="w-8 h-8 text-zinc-700" />
            <p className="text-sm text-zinc-500">No parameters exposed by this plugin.</p>
          </div>
        ) : (
          parameters.map((param) => (
            <div key={param.id} className="group flex flex-col gap-2">
              <div className="flex justify-between items-end px-1">
                <span className="text-[11px] font-bold text-zinc-400 group-hover:text-zinc-200 transition-colors">
                  {param.name || `Param ${param.id}`}
                </span>
                <span className="text-[11px] font-mono text-indigo-400 font-bold">
                  {param.label ? `${Math.round(param.value * 100)} ${param.label}` : (param.value).toFixed(3)}
                </span>
              </div>
              
              <div className="relative h-6 flex items-center">
                {/* Background Track */}
                <div className="absolute inset-0 bg-white/5 rounded-full" />
                {/* Visual Level */}
                <div 
                  className="absolute inset-y-0.5 left-0.5 bg-indigo-500/20 rounded-full border border-indigo-500/30"
                  style={{ width: `calc(${param.value * 100}% - 4px)` }}
                />
                {/* Actual Input Slider */}
                <input 
                  type="range"
                  min="0"
                  max="1"
                  step="0.001"
                  value={param.value ?? 0}
                  onChange={(e) => handleParamChange(param.id, parseFloat(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                />
                {/* Handle UI hint (centered circle that moves with slider) */}
                <div 
                  className="absolute h-5 w-5 bg-zinc-100 rounded-full shadow-lg border-2 border-indigo-600 transition-transform active:scale-95 pointer-events-none"
                  style={{ left: `calc(${param.value * 100}% - 10px)` }}
                />
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-4 bg-zinc-900/30 border-t border-white/5 flex items-center justify-between">
        <span className="text-[10px] text-zinc-600 font-bold">VST HOST v1.0</span>
        <div className="flex gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[9px] text-zinc-500 font-bold tracking-widest uppercase">Engine Linked</span>
        </div>
      </div>
    </div>
  );
};
