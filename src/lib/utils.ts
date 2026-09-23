import { ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { convertFileSrc } from '@tauri-apps/api/core';
import { AudioSettings, HotkeyAction, KeyMap } from '../types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const isTauriAvailable = (): boolean => {
  return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
};

export const getDefaultKeyMap = (): KeyMap => ({
  'play_pause': { label: 'Воспроизведение/Пауза', code: 'Space' },
  'record_toggle': { label: 'Начать/Остановить запись', code: 'KeyR' },
  'backstage_toggle': { label: 'Вкл/Выкл Backstage', code: 'KeyB' },
  'delete_take': { label: 'Удалить последний дубль', code: 'KeyZ', ctrlKey: true },
  'split_segment': { label: 'Разрезать сегмент', code: 'KeyS' },
  'join_segments': { label: 'Склеить сегменты', code: 'KeyJ' },
  'seek_start': { label: 'В начало', code: 'Home' },
  'seek_end': { label: 'В конец', code: 'End' },
  'seek_prev_sub': { label: 'Пред. субтитр', code: 'ArrowLeft', ctrlKey: true },
  'seek_next_sub': { label: 'След. субтитр', code: 'ArrowRight', ctrlKey: true },
  'add_marker': { label: 'Добавить маркер', code: 'KeyM' },
  'discard_recording': { label: 'Отменить запись', code: 'Escape' },
  'delete_selected': { label: 'Удалить выбранное', code: 'KeyD' },
});

export const formatHotkey = (action: HotkeyAction) => {
  if (!action) return 'None';
  const parts = [];
  if (action.ctrlKey) parts.push('Ctrl');
  if (action.shiftKey) parts.push('Shift');
  if (action.altKey) parts.push('Alt');
  
  let keyName = action.code || 'None';
  if (keyName.startsWith('Key')) keyName = keyName.substring(3);
  else if (keyName.startsWith('Digit')) keyName = keyName.substring(5);
  else if (keyName === 'Space') keyName = 'Space';
  
  parts.push(keyName);
  return parts.join(' + ');
};

const blobUrlCache = new Map<string, string>();

export const invalidateFileUrl = (path: string | undefined): void => {
  if (!path) return;
  if (blobUrlCache.has(path)) {
    const url = blobUrlCache.get(path);
    if (url && url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }
    blobUrlCache.delete(path);
  }
};

export const clearFileUrlCache = (): void => {
  blobUrlCache.forEach(url => {
    if (url && url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }
  });
  blobUrlCache.clear();
};

export const getSafeFileUrl = (path: string | undefined): string | undefined => {
  if (!path) return undefined;
  try {
    // If it's already a URL, return it
    if (path.startsWith('http') || path.startsWith('blob:') || path.startsWith('data:')) {
      return path;
    }
    
    // Check memoized blob URLs
    if (blobUrlCache.has(path)) {
      return blobUrlCache.get(path);
    }

    // Check global web cache first (for web preview/dropped files)
    const globalCache = (window as any).webFileCache;
    if (globalCache) {
      let file = globalCache.get(path);
      if (!file) {
        // Fallback to basename just in case paths get rewritten
        const basename = path.split(/[/\\]/).pop();
        if (basename) file = globalCache.get(basename);
      }
      if (file) {
        const url = URL.createObjectURL(file);
        blobUrlCache.set(path, url);
        return url;
      }
    }
    
    // Otherwise use Tauri convertFileSrc if available
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      return convertFileSrc(path);
    }
    return path;
  } catch (e) {
    console.warn(`[getSafeFileUrl] Failed to convert path "${path}":`, e);
    return path;
  }
};

/**
 * Converts asset.localhost/convertFileSrc URLs back to local file system paths
 */
export const toNativeLocalPath = (pathOrUrl: string | undefined | null): string => {
  if (!pathOrUrl) return '';
  let s = String(pathOrUrl).trim();
  
  if (s.startsWith('http://asset.localhost/')) {
    s = s.substring('http://asset.localhost/'.length);
  } else if (s.startsWith('https://asset.localhost/')) {
    s = s.substring('https://asset.localhost/'.length);
  } else if (s.startsWith('asset://localhost/')) {
    s = s.substring('asset://localhost/'.length);
  } else if (s.startsWith('asset://')) {
    s = s.substring('asset://'.length);
  } else if (s.startsWith('tauri://localhost/')) {
    s = s.substring('tauri://localhost/'.length);
  } else if (s.startsWith('file:///')) {
    s = s.substring('file:///'.length);
  } else if (s.startsWith('file://')) {
    s = s.substring('file://'.length);
  }

  try {
    s = decodeURIComponent(s);
  } catch (_) {}

  // Remove leading slash before Windows drive: "/C:/" -> "C:/"
  if ((s.startsWith('/') || s.startsWith('\\')) && s.length > 3) {
    if (s[2] === ':' || s[2] === '|') {
      s = s.substring(1);
    }
  }

  return s;
};

export const getGlobalAudioSettings = (): AudioSettings => {
  const defaults: AudioSettings = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: 48000,
    bitDepth: 24,
    noiseGateThreshold: -45,
    isNoiseGateEnabled: false,
    compressorThreshold: -20,
    compressorRatio: 4,
    highPassFrequency: 80,
    isDestructive: false,
    webcamExportOverlay: true,
    backstageMode: 'parallel',
    isBackstageEnabled: false,
    asioMode: false,
    playOriginalTrackSegments: false,
    keyMap: getDefaultKeyMap(),
    vstFolders: [
      'C:\\Program Files\\Common Files\\VST3',
      'C:\\Program Files\\VSTPlugins',
      'C:\\Program Files\\Steinberg\\VSTPlugins',
      '/Library/Audio/Plug-Ins/VST3',
      '/Library/Audio/Plug-Ins/VST'
    ],
    exportSettings: {
      mp3Bitrate: 320,
      flacCompression: 5,
      sampleRate: 48000
    }
  };

  try {
    const saved = localStorage.getItem('dubstudio_global_audio_settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...defaults, ...parsed };
    }
  } catch(e) {}
  return defaults;
};

/**
 * Safe confirm that doesn't crash in environments where window.confirm is blocked by ACL
 */
export const safeConfirm = async (message: string, defaultValue: boolean = false): Promise<boolean> => {
  try {
    if (typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)) {
      try {
        const { ask } = await import('@tauri-apps/plugin-dialog');
        return await ask(message, { title: 'Подтверждение', kind: 'warning' });
      } catch (tauriErr) {
        console.warn("[safeConfirm] Tauri ask failed, falling back to window.confirm:", tauriErr);
      }
    }
    const res = window.confirm(message);
    if ((res as any) instanceof Promise) {
      return await (res as any);
    }
    return !!res;
  } catch (e) {
    console.warn("[safeConfirm] Native confirm failed (ACL?), defaulting to:", defaultValue, e);
    return defaultValue;
  }
};

/**
 * Resolves a potentially relative segment/media file path to an absolute path using the project root path.
 */
export const getAbsoluteFilePath = (filePath: string | undefined | null, projectPath: string | undefined | null): string => {
  if (!filePath) return '';
  let s = filePath.trim();
  
  // If it's already an absolute Windows path (e.g. C:/ or C:\) or file URL or asset URL:
  if (s.match(/^[a-zA-Z]:/) || s.startsWith('file://') || s.startsWith('http://asset.localhost/') || s.startsWith('https://asset.localhost/') || s.startsWith('asset://')) {
    return s.replace(/\\/g, '/');
  }
  
  // If POSIX absolute on non-Windows:
  if (s.startsWith('/') && (!projectPath || !projectPath.match(/^[a-zA-Z]:/))) {
    return s.replace(/\\/g, '/');
  }

  if (!projectPath) return s.replace(/\\/g, '/');
  
  let cleanPath = s.replace(/^\.[\\\/]/, '').replace(/^[\\\/]+/, '').replace(/\\/g, '/');
  const normProjectPath = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlashIndex = normProjectPath.lastIndexOf('/');
  const projectFolder = lastSlashIndex !== -1 ? normProjectPath.substring(lastSlashIndex + 1) : normProjectPath;
  
  // Защита от дублирования папки проекта
  if (projectFolder && cleanPath.startsWith(`${projectFolder}/`)) {
    cleanPath = cleanPath.substring(projectFolder.length + 1);
  }
  
  return `${normProjectPath}/${cleanPath}`.replace(/\\/g, '/');
};

/**
 * Generates a sequentially prefixed audio file path for DSP effect processing.
 * e.g., "denoise" + "C:/proj/audio.wav" -> "C:/proj/denoise_audio.wav"
 * In chains: "dereverb" + "C:/proj/denoise_audio.wav" -> "C:/proj/dereverb_denoise_audio.wav"
 */
export const createPrefixedAudioPath = (prefix: string, fullPath: string): string => {
  if (!fullPath) return fullPath;
  const normalized = fullPath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const dir = lastSlash !== -1 ? normalized.substring(0, lastSlash) : '';
  const fileWithExt = lastSlash !== -1 ? normalized.substring(lastSlash + 1) : normalized;

  // Clean prefix: lowercase alphanumeric and underscore
  const cleanPrefix = prefix.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const newFileName = `${cleanPrefix}_${fileWithExt}`;
  return dir ? `${dir}/${newFileName}` : newFileName;
};

/**
 * Безопасный сериализатор данных проекта в JSON без ошибок RangeError: Invalid string length
 * и без гигантских отступов / перегрузки массивными числами.
 */
export function safeStringifyProject(data: any): string {
  if (!data) return JSON.stringify(data);

  try {
    const sanitized = sanitizeProjectObject(data);
    return JSON.stringify(sanitized);
  } catch (err) {
    console.warn('[safeStringifyProject] Standard JSON.stringify failed, using emergency stripped fallback:', err);
    try {
      const emergencySanitized = stripHeavyArrays(data);
      return JSON.stringify(emergencySanitized);
    } catch (e) {
      console.error('[safeStringifyProject] Emergency JSON.stringify failed:', e);
      return '{}';
    }
  }
}

function sanitizeProjectObject(data: any, depth = 0): any {
  if (depth > 12) return null;
  if (!data || typeof data !== 'object') return data;
  if (data instanceof Uint8Array || data instanceof Float32Array || data instanceof ArrayBuffer) return null;

  if (Array.isArray(data)) {
    return data.map(item => sanitizeProjectObject(item, depth + 1));
  }

  const clean: Record<string, any> = {};
  for (const key of Object.keys(data)) {
    const value = data[key];

    // Исключаем огромные/временные блобы и прочие тяжелые поля
    if (key === 'blobUrl' || (key === 'audioUrl' && typeof value === 'string' && value.startsWith('blob:'))) {
      continue;
    }

    // Даунсамплим пики огибающей, если они огромные (> 6000 точек)
    if ((key === 'originalPeaks' || key === 'waveform') && Array.isArray(value)) {
      if (value.length > 6000) {
        const step = Math.ceil(value.length / 6000);
        const sampled: number[] = [];
        for (let i = 0; i < value.length; i += step) {
          const v = value[i];
          sampled.push(typeof v === 'number' ? Number(v.toFixed(4)) : 0);
        }
        clean[key] = sampled;
      } else {
        clean[key] = value.map(v => typeof v === 'number' ? Number(v.toFixed(4)) : v);
      }
      continue;
    }

    if (value && typeof value === 'object') {
      clean[key] = sanitizeProjectObject(value, depth + 1);
    } else {
      clean[key] = value;
    }
  }

  return clean;
}

function stripHeavyArrays(data: any): any {
  if (!data || typeof data !== 'object') return data;
  const copy = { ...data };
  delete copy.originalPeaks;
  if (Array.isArray(copy.tracks)) {
    copy.tracks = copy.tracks.map((t: any) => {
      if (!t || typeof t !== 'object') return t;
      const tc = { ...t };
      if (Array.isArray(tc.segments)) {
        tc.segments = tc.segments.map((s: any) => {
          if (!s || typeof s !== 'object') return s;
          const sc = { ...s };
          delete sc.waveform;
          return sc;
        });
      }
      return tc;
    });
  }
  return copy;
}


