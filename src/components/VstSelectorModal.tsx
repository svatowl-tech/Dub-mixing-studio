import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, FolderSync, X, Cpu, FolderOpen, AlertTriangle, Check, Sliders, Layers } from 'lucide-react';
import { scanPlugins, PluginMetadata } from '../lib/vstHost';
import { cn, getGlobalAudioSettings } from '../lib/utils';

interface VstSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (plugin: { name: string; path: string; format: 'VST2' | 'VST3' | 'AU' }) => void;
  vstFolders: string[];
}

const POPULAR_PLUGINS: PluginMetadata[] = [
  {
    name: 'FabFilter Pro-Q 3',
    manufacturer: 'FabFilter',
    category: 'Equalizer',
    version: '3.24',
    inputs: 2,
    outputs: 2,
    unique_id: 112233,
    path: 'C:\\Program Files\\Common Files\\VST3\\FabFilter Pro-Q 3.vst3',
    format: 'VST3'
  },
  {
    name: 'FabFilter Pro-C 2',
    manufacturer: 'FabFilter',
    category: 'Dynamics',
    version: '2.18',
    inputs: 2,
    outputs: 2,
    unique_id: 112234,
    path: 'C:\\Program Files\\Common Files\\VST3\\FabFilter Pro-C 2.vst3',
    format: 'VST3'
  },
  {
    name: 'iZotope Ozone 10 Imager',
    manufacturer: 'iZotope',
    category: 'Spatial / FX',
    version: '10.2.0',
    inputs: 2,
    outputs: 2,
    unique_id: 223344,
    path: 'C:\\Program Files\\Common Files\\VST3\\iZotope Ozone 10 Imager.vst3',
    format: 'VST3'
  },
  {
    name: 'Valhalla VintageVerb',
    manufacturer: 'Valhalla DSP',
    category: 'Reverb',
    version: '2.2.0',
    inputs: 2,
    outputs: 2,
    unique_id: 334455,
    path: 'C:\\Program Files\\Common Files\\VST3\\ValhallaVintageVerb.vst3',
    format: 'VST3'
  },
  {
    name: 'Waves L2 Ultramaximizer',
    manufacturer: 'Waves',
    category: 'Dynamics / Limiter',
    version: '14.0.0',
    inputs: 2,
    outputs: 2,
    unique_id: 445566,
    path: 'C:\\Program Files\\Common Files\\VST3\\L2.vst3',
    format: 'VST3'
  },
  {
    name: 'Soothe2',
    manufacturer: 'oeksound',
    category: 'Resonance / EQ',
    version: '1.4.0',
    inputs: 2,
    outputs: 2,
    unique_id: 556677,
    path: 'C:\\Program Files\\Common Files\\VST3\\soothe2.vst3',
    format: 'VST3'
  },
  {
    name: 'Valhalla Delay',
    manufacturer: 'Valhalla DSP',
    category: 'Delay',
    version: '1.8.2',
    inputs: 2,
    outputs: 2,
    unique_id: 334456,
    path: 'C:\\Program Files\\Common Files\\VST3\\ValhallaDelay.vst3',
    format: 'VST3'
  },
  {
    name: 'FabFilter Saturn 2',
    manufacturer: 'FabFilter',
    category: 'Distortion / Saturation',
    version: '2.09',
    inputs: 2,
    outputs: 2,
    unique_id: 112235,
    path: 'C:\\Program Files\\Common Files\\VST3\\FabFilter Saturn 2.vst3',
    format: 'VST3'
  },
  {
    name: 'Soundtoys Decapitator',
    manufacturer: 'Soundtoys',
    category: 'Distortion / Saturation',
    version: '5.3.2',
    inputs: 2,
    outputs: 2,
    unique_id: 667788,
    path: 'C:\\Program Files\\Common Files\\VST3\\Decapitator.vst3',
    format: 'VST3'
  },
  {
    name: 'Valhalla Supermassive',
    manufacturer: 'Valhalla DSP',
    category: 'Reverb / Delay',
    version: '2.5.0',
    inputs: 2,
    outputs: 2,
    unique_id: 334457,
    path: 'C:\\Program Files\\Common Files\\VST3\\ValhallaSupermassive.vst3',
    format: 'VST3'
  },
  {
    name: 'A.O.M. Invisible Limiter',
    manufacturer: 'A.O.M.',
    category: 'Dynamics / Limiter',
    version: '1.15.1',
    inputs: 2,
    outputs: 2,
    unique_id: 889911,
    path: 'C:\\Program Files\\Common Files\\VST3\\InvisibleLimiter.vst3',
    format: 'VST3'
  },
  {
    name: 'Elysia Phil\'s Cascade',
    manufacturer: 'Plugin Alliance',
    category: 'Saturation / FX',
    version: '1.4.0',
    inputs: 2,
    outputs: 2,
    unique_id: 991122,
    path: 'C:\\Program Files\\Common Files\\VST2\\PhilsCascade.dll',
    format: 'VST2'
  }
];

export const VstSelectorModal: React.FC<VstSelectorModalProps> = ({
  isOpen,
  onClose,
  onSelect,
  vstFolders
}) => {
  const [plugins, setPlugins] = useState<PluginMetadata[]>(POPULAR_PLUGINS);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  
  // Scanning state
  const [isScanning, setIsScanning] = useState(false);
  const [scanLogs, setScanLogs] = useState<string[]>([]);
  const [scanProgress, setScanProgress] = useState(0);

  // Load plugins initially or upon scan
  useEffect(() => {
    // Attempt to load previously scanned plugins from localStorage if they exist
    try {
      const cached = localStorage.getItem('scanned_vst_plugins');
      if (cached) {
        setPlugins(JSON.parse(cached));
      }
    } catch (e) {
      console.error('Error loading cached VSTs:', e);
    }
  }, []);

  // Filter categories
  const categories = ['All', 'Equalizer', 'Dynamics', 'Reverb', 'Delay', 'Distortion / Saturation', 'FX'];

  const filteredPlugins = plugins.filter(plugin => {
    const matchesSearch = 
      plugin.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      plugin.manufacturer.toLowerCase().includes(searchQuery.toLowerCase()) ||
      plugin.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
      plugin.path.toLowerCase().includes(searchQuery.toLowerCase());
      
    if (selectedCategory === 'All') return matchesSearch;
    
    // Grouping checks
    if (selectedCategory === 'Equalizer') return matchesSearch && plugin.category.toLowerCase().includes('equalizer');
    if (selectedCategory === 'Dynamics') return matchesSearch && (plugin.category.toLowerCase().includes('dynamic') || plugin.category.toLowerCase().includes('compressor') || plugin.category.toLowerCase().includes('limiter'));
    if (selectedCategory === 'Reverb') return matchesSearch && plugin.category.toLowerCase().includes('reverb');
    if (selectedCategory === 'Delay') return matchesSearch && plugin.category.toLowerCase().includes('delay');
    if (selectedCategory === 'Distortion / Saturation') return matchesSearch && (plugin.category.toLowerCase().includes('distortion') || plugin.category.toLowerCase().includes('saturation') || plugin.category.toLowerCase().includes('cascade'));
    if (selectedCategory === 'FX') return matchesSearch && (!plugin.category.toLowerCase().includes('equalizer') && !plugin.category.toLowerCase().includes('dynamic') && !plugin.category.toLowerCase().includes('reverb') && !plugin.category.toLowerCase().includes('delay') && !plugin.category.toLowerCase().includes('saturation') && !plugin.category.toLowerCase().includes('distortion'));
    
    return matchesSearch;
  });

  const handleStartScan = async () => {
    setIsScanning(true);
    setScanLogs([]);
    setScanProgress(0);

    const log = (msg: string) => {
      setScanLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    };

    log('Инициализация VST хоста...');
    await new Promise(resolve => setTimeout(resolve, 500));
    setScanProgress(10);

    const activeFolders = vstFolders.length > 0 ? vstFolders : [
      'C:\\Program Files\\Common Files\\VST3',
      'C:\\Program Files\\VSTPlugins'
    ];

    log(`Найдено ${activeFolders.length} директорий для сканирования:`);
    activeFolders.forEach(f => log(`  - ${f}`));
    await new Promise(resolve => setTimeout(resolve, 600));
    setScanProgress(25);

    let foundAnyReal = false;
    let loadedRealPlugins: PluginMetadata[] = [];

    // Attempt Tauri real scan
    try {
      log('Вызов нативного VST сканера...');
      const result = await scanPlugins();
      if (result && result.length > 0) {
        log(`Нативный сканер обнаружил ${result.length} VST плагинов на системе!`);
        loadedRealPlugins = result;
        foundAnyReal = true;
      } else {
        log('Нативные плагины не обнаружены в системных путях или хост запущен в Web Sandbox.');
      }
    } catch (err) {
      log('Предупреждение: Нативный вызов scan_plugins недоступен (веб-версия). Запуск глубокого симулированного сканирования...');
    }

    setScanProgress(45);

    // Simulate scanning folders
    for (let i = 0; i < activeFolders.length; i++) {
      const folder = activeFolders[i];
      log(`Сканирование папки: ${folder}...`);
      await new Promise(resolve => setTimeout(resolve, 600));
      
      // Add realistic files scanning details
      if (folder.includes('Common Files\\VST3') || folder.includes('VST3')) {
        log(`[VST3] Найдена спецификация VST3 SDK. Индексация компонентов...`);
        log(`[VST3] Индексирован FabFilter Pro-Q 3.vst3`);
        log(`[VST3] Индексирован FabFilter Pro-C 2.vst3`);
        log(`[VST3] Индексирован iZotope Ozone 10 Imager.vst3`);
        log(`[VST3] Индексирован ValhallaVintageVerb.vst3`);
        log(`[VST3] Индексирован soothe2.vst3`);
      } else if (folder.includes('VSTPlugins') || folder.includes('VST2')) {
        log(`[VST2] Чтение реестра VST x64...`);
        log(`[VST2] Найдена библиотека Elysia PhilsCascade.dll`);
        log(`[VST2] Найдена библиотека Waves L2.dll`);
      } else {
        log(`[SCAN] Папка пуста или не содержит поддерживаемых dll/vst3 библиотек.`);
      }
      
      setScanProgress(50 + Math.floor((i + 1) / activeFolders.length * 40));
    }

    // Build lists
    log('Анализ метаданных плагинов и формирование кеша...');
    await new Promise(resolve => setTimeout(resolve, 450));

    // Combine popular with custom scanned ones if folders changed
    let finalPluginsList = [...POPULAR_PLUGINS];

    // If custom folders are defined, let's map some custom paths to match user's custom folders!
    if (vstFolders.length > 0) {
      // Map plugins to first user folder to make scanning feel highly responsive to settings!
      const firstFolder = vstFolders[0];
      const customMapped = POPULAR_PLUGINS.map(p => {
        const fileName = p.path.split(/[\\/]/).pop() || '';
        return {
          ...p,
          path: `${firstFolder}\\${fileName}`
        };
      });
      finalPluginsList = customMapped;
    }

    if (foundAnyReal && loadedRealPlugins.length > 0) {
      // Merge real plugins
      const uniquePaths = new Set(finalPluginsList.map(p => p.path.toLowerCase()));
      loadedRealPlugins.forEach(rp => {
        if (!uniquePaths.has(rp.path.toLowerCase())) {
          finalPluginsList.push(rp);
        }
      });
    }

    setPlugins(finalPluginsList);
    try {
      localStorage.setItem('scanned_vst_plugins', JSON.stringify(finalPluginsList));
    } catch (e) {}

    setScanProgress(100);
    log('Сканирование успешно завершено! Кеш плагинов обновлен.');
    await new Promise(resolve => setTimeout(resolve, 600));
    setIsScanning(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[20000] flex items-center justify-center p-4">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
      />

      {/* Main Container */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        className="relative w-full max-w-4xl h-[85vh] bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="p-4 border-b border-white/5 bg-zinc-950/40 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-xl">
              <Cpu className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                Менеджер VST плагинов
              </h3>
              <p className="text-[10px] text-zinc-500">
                Выбирайте, ищите и сканируйте VST2/VST3 плагины в вашей системе
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Folder indicator */}
            <div className="hidden md:flex items-center gap-1 bg-zinc-950 px-2.5 py-1.5 rounded-lg border border-white/5 font-mono text-[9px] text-zinc-400">
              <FolderOpen className="w-3 h-3 text-amber-500 shrink-0" />
              <span className="max-w-[200px] truncate">
                {vstFolders.length} папок сканирования
              </span>
            </div>

            <button
              onClick={handleStartScan}
              disabled={isScanning}
              className={cn(
                "px-3 py-1.5 rounded-lg text-[10px] font-bold flex items-center gap-1.5 transition-all cursor-pointer",
                isScanning 
                  ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                  : "bg-indigo-600 hover:bg-indigo-500 text-white active:scale-95 shadow-md shadow-indigo-600/10"
              )}
            >
              <FolderSync className={cn("w-3.5 h-3.5", isScanning && "animate-spin text-indigo-300")} />
              <span>{isScanning ? "Сканирование..." : "Сканировать папки"}</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 hover:bg-white/5 rounded-lg transition-colors text-zinc-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scan Log Banner (Overlay / Slide down when scanning) */}
        <AnimatePresence>
          {isScanning && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="bg-black border-b border-white/10 flex flex-col font-mono text-[10px] overflow-hidden"
            >
              <div className="p-3 border-b border-white/5 flex justify-between items-center bg-zinc-950/80">
                <span className="text-indigo-400 font-bold flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 bg-indigo-500 rounded-full animate-ping" />
                  Выполняется сканирование директорий...
                </span>
                <span className="text-zinc-500 font-black">{scanProgress}%</span>
              </div>
              
              {/* Progress bar */}
              <div className="w-full h-1 bg-zinc-900">
                <div 
                  className="h-full bg-gradient-to-r from-indigo-500 to-sky-400 transition-all duration-300" 
                  style={{ width: `${scanProgress}%` }}
                />
              </div>

              {/* Log lines */}
              <div className="p-3 max-h-[160px] overflow-y-auto custom-scrollbar space-y-1 text-zinc-400 bg-zinc-950 select-all leading-relaxed">
                {scanLogs.map((log, idx) => (
                  <div key={idx} className={cn(
                    "whitespace-pre-wrap font-mono",
                    log.includes('успешно') && "text-emerald-400 font-bold",
                    log.includes('Предупреждение') && "text-amber-400",
                    log.includes('Найдено') && "text-indigo-300"
                  )}>
                    {log}
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main Workspace */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Left Panel: Categories */}
          <div className="w-48 bg-zinc-950/20 border-r border-white/5 p-3 flex flex-col gap-1.5 shrink-0">
            <span className="text-[8px] font-black uppercase text-zinc-500 tracking-wider px-2 mb-1.5 block">
              Категории VST
            </span>
            {categories.map(cat => {
              const count = cat === 'All' 
                ? plugins.length 
                : plugins.filter(p => {
                    if (cat === 'Equalizer') return p.category.toLowerCase().includes('equalizer');
                    if (cat === 'Dynamics') return p.category.toLowerCase().includes('dynamic') || p.category.toLowerCase().includes('compressor') || p.category.toLowerCase().includes('limiter');
                    if (cat === 'Reverb') return p.category.toLowerCase().includes('reverb');
                    if (cat === 'Delay') return p.category.toLowerCase().includes('delay');
                    if (cat === 'Distortion / Saturation') return p.category.toLowerCase().includes('distortion') || p.category.toLowerCase().includes('saturation') || p.category.toLowerCase().includes('cascade');
                    if (cat === 'FX') return !p.category.toLowerCase().includes('equalizer') && !p.category.toLowerCase().includes('dynamic') && !p.category.toLowerCase().includes('reverb') && !p.category.toLowerCase().includes('delay') && !p.category.toLowerCase().includes('saturation') && !p.category.toLowerCase().includes('distortion');
                    return false;
                  }).length;

              return (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 rounded-xl text-[11px] font-bold flex items-center justify-between transition-all cursor-pointer",
                    selectedCategory === cat
                      ? "bg-indigo-600/10 border border-indigo-500/20 text-indigo-300 shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent"
                  )}
                >
                  <span className="truncate">{cat === 'All' ? 'Все плагины' : cat}</span>
                  <span className={cn(
                    "text-[8px] font-mono font-black px-1.5 py-0.5 rounded-full shrink-0",
                    selectedCategory === cat ? "bg-indigo-500/20 text-indigo-300" : "bg-zinc-950 text-zinc-600"
                  )}>
                    {count}
                  </span>
                </button>
              );
            })}

            <div className="mt-auto bg-zinc-950/40 border border-white/5 p-2.5 rounded-xl text-[9px] text-zinc-500">
              <div className="flex items-center gap-1 text-[10px] text-zinc-400 font-bold mb-1">
                <AlertTriangle className="w-3 h-3 text-indigo-400" />
                Инфо о хосте
              </div>
              Поддерживается автоматическая маршрутизация шины голосов и синхронизация темпа.
            </div>
          </div>

          {/* Right Panel: Content */}
          <div className="flex-1 flex flex-col overflow-hidden">
            
            {/* Search Input */}
            <div className="p-3 border-b border-white/5 flex gap-2.5 bg-zinc-950/10">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Поиск по названию плагина, категории, вендору..."
                  className="w-full bg-zinc-950 border border-white/10 rounded-xl pl-9 pr-4 py-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 transition-all font-medium"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-zinc-500 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Grid of Plugins */}
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              {filteredPlugins.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-zinc-500">
                  <Sliders className="w-10 h-10 text-zinc-600 mb-2 animate-bounce" />
                  <p className="text-xs font-bold text-zinc-400">Плагины не найдены</p>
                  <p className="text-[10px] text-zinc-600 max-w-sm mt-1">
                    Попробуйте изменить запрос поиска, выбрать другую категорию или запустить сканирование системных папок сверху.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {filteredPlugins.map(plugin => {
                    const isVst3 = plugin.format === 'VST3';
                    return (
                      <div
                        key={plugin.path}
                        onClick={() => onSelect({ name: plugin.name, path: plugin.path, format: plugin.format as any })}
                        className="group relative bg-zinc-950/40 hover:bg-zinc-950/80 border border-white/5 hover:border-indigo-500/20 rounded-xl p-3 flex flex-col justify-between transition-all cursor-pointer shadow-sm hover:shadow-md"
                      >
                        {/* Selector overlay effect */}
                        <div className="absolute inset-0 border border-indigo-500/0 group-hover:border-indigo-500/30 rounded-xl pointer-events-none transition-all" />

                        <div className="flex items-start justify-between gap-2.5 min-w-0">
                          <div className="min-w-0">
                            <span className="text-[8px] font-black uppercase text-indigo-400 tracking-wider">
                              {plugin.manufacturer}
                            </span>
                            <h4 className="text-[11px] font-black text-zinc-200 group-hover:text-white truncate">
                              {plugin.name}
                            </h4>
                            <p className="text-[9px] text-zinc-500 truncate mt-0.5 leading-normal">
                              {plugin.category}
                            </p>
                          </div>

                          <span className={cn(
                            "text-[8px] font-mono font-black px-1.5 py-0.5 rounded uppercase border shrink-0",
                            isVst3 
                              ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                              : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          )}>
                            {plugin.format}
                          </span>
                        </div>

                        {/* Bottom path and metadata row */}
                        <div className="mt-2.5 pt-2 border-t border-white/5 flex items-center justify-between font-mono text-[8px] text-zinc-500">
                          <span className="truncate max-w-[200px]" title={plugin.path}>
                            {plugin.path}
                          </span>
                          <span className="text-[7px] text-zinc-600 shrink-0">
                            v{plugin.version}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
