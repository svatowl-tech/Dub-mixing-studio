import { invoke, isTauri, convertFileSrc } from '@tauri-apps/api/core';
// sync
import { open, save, message } from '@tauri-apps/plugin-dialog';
import { listen, emit, UnlistenFn } from '@tauri-apps/api/event';

import { safeConfirm } from './utils';
import { IOLogger } from './ioLogger';
import { UniversalParserService } from '../services/UniversalParserService';
import { SubtitleLine } from '../types';

/**
 * Standard interface for IPC communication responses
 */
export interface BridgeResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
}

const IS_TAURI = isTauri();

// Web-fallback file storage for preview
const webFileMap = new Map<string, File>();
(window as any).webFileCache = webFileMap;

export const addToWebFileCache = (path: string, file: File) => {
  webFileMap.set(path, file);
  if (file.name && file.name !== path) {
    webFileMap.set(file.name, file);
  }
};

const genId = () => Math.random().toString(36).substring(2, 11);

const listenerRegistry = new Set<() => void>();

/**
 * Emit an action and wait for the result via the dubstudio-result event.
 * This decouples the invocation from the response, avoiding callback ID errors.
 */
async function emitAction<T>(action: string, payload: any): Promise<T> {
    if (!IS_TAURI) throw new Error("Not in Tauri environment");
    const requestId = genId();
    
    return new Promise((resolve, reject) => {
        let unlistenFunc: UnlistenFn | null = null;
        
        const cleanup = () => {
            if (unlistenFunc) {
                unlistenFunc();
                listenerRegistry.delete(unlistenFunc);
                unlistenFunc = null;
            }
        };

        // Setup timeout to prevent hanging forever
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Action ${action} timed out`));
        }, 120000); // 120 seconds (long for extraction)

        listen('dubstudio-result', (event: any) => {
            const result = event.payload;
            if (result.request_id === requestId && result.action === action) {
                clearTimeout(timeout);
                cleanup();
                if (result.success) {
                    resolve(result.data as T);
                } else {
                    reject(new Error(result.error || 'Unknown backend error'));
                }
            }
        }).then(u => {
            unlistenFunc = u;
            listenerRegistry.add(u);
            
            emit('dubstudio-action', { action, data: payload, request_id: requestId }).catch(err => {
                clearTimeout(timeout);
                cleanup();
                reject(err);
            });
        }).catch(err => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

/**
 * Watchdog helper for long running Rust commands.
 */
async function invokeWithWatchdog<T>(
    cmd: string, 
    args: any = {}, 
    options: { 
        timeoutMs?: number, 
        progressEvent?: string,
        onTimeout?: () => void 
    } = {}
): Promise<T> {
    if (!IS_TAURI) throw new Error("Not in Tauri environment");
    const timeout = options.timeoutMs || 30000;
    let timer: any;
    let lastProgress = Date.now();

    // Listen for progress to reset the watchdog timer
    let unlisten: UnlistenFn | undefined;
    if (options.progressEvent) {
        unlisten = await listen(options.progressEvent, () => {
            lastProgress = Date.now();
        });
    }

    const check = async () => {
        if (Date.now() - lastProgress > timeout) {
            console.warn(`[Watchdog] Command ${cmd} is taking too long without progress.`);
            if (options.onTimeout) options.onTimeout();
            try {
                const isConfirmed = await safeConfirm(`Операция "${cmd}" выполняется слишком долго (>30 сек) без обновлений. Попробовать отменить или проверить логи?`);
                if (isConfirmed) {
                    // In a real app we might trigger a cancel signal here if Rust supported it
                }
            } catch(e) {}
        } else {
            timer = setTimeout(check, 5000);
        }
    };

    timer = setTimeout(check, 5000);

    try {
        const result = await invoke<T>(cmd, args);
        return result;
    } finally {
        clearTimeout(timer);
        if (unlisten) unlisten();
    }
}

/**
 * Handles peak data conversion safely from various backend formats.
 * Detects if the input is already normalized floats or 8-bit integers.
 */
function bufferToFloat32Array(buffer: unknown): Float32Array {
    if (buffer instanceof Float32Array) return buffer;
    
    // Handle ArrayBuffer (direct binary)
    if (buffer instanceof ArrayBuffer) {
        // If the buffer size is a multiple of 4, it might be f32
        // But our backend specifically sends u8 peaks for extraction.
        // We'll treat ArrayBuffer as u8 for peaks by default unless we know better.
        const uint8 = new Uint8Array(buffer);
        const peaks = new Float32Array(uint8.length);
        for (let i = 0; i < uint8.length; i++) {
            peaks[i] = uint8[i] / 255.0;
        }
        return peaks;
    }

    // Handle JS Array (from JSON serialization)
    if (Array.isArray(buffer)) {
        if (buffer.length === 0) return new Float32Array(0);
        
        // Detect if it's already floats [0.0...1.0] or bytes [0...255]
        // Check first few elements. If any is non-integer or > 255, or if they are mostly < 1.0 but > 0
        let isProbablyFloats = false;
        for (let i = 0; i < Math.min(buffer.length, 10); i++) {
            if (!Number.isInteger(buffer[i]) || (buffer[i] > 0 && buffer[i] < 1.0)) {
                isProbablyFloats = true;
                break;
            }
        }

        if (isProbablyFloats) {
            return new Float32Array(buffer);
        } else {
            const peaks = new Float32Array(buffer.length);
            for (let i = 0; i < buffer.length; i++) {
                peaks[i] = (buffer[i] as number) / 255.0;
            }
            return peaks;
        }
    }

    // Fallback for unexpected types
    console.warn("[Bridge] Unexpected buffer type for peaks:", typeof buffer);
    return new Float32Array(0);
}

export const tauriAPI = {
  // --- PROJECT MANAGEMENT ---
  openFolder: async (): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await open({ directory: true });
        return result ? { success: true, data: result as string } : { success: false, error: 'User cancelled' };
    } catch(err) {
        console.error("[Bridge] openFolder error:", err);
        return { success: false, error: String(err) };
    }
  },

  saveProjectJson: async (args: { projectPath: string, projectData: any }): Promise<BridgeResponse<boolean>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    IOLogger.log('PROJECT', 'saveProjectJson', 'START', { path: args.projectPath, name: args.projectData.name });
    try {
      // Create hierarchy first
      await invoke('init_project_folder', { path: args.projectPath });
      
      const fileName = `${args.projectData.name}.dub`;
      const filePath = `${args.projectPath}/${fileName}`.replace(/\\/g, '/');
      
      // Clean up for saving (remove temporary UI state)
      const cleanData = { ...args.projectData };
      
      await invoke('save_project_file', { path: filePath, data: JSON.stringify(cleanData, null, 2) });
      IOLogger.log('PROJECT', 'saveProjectJson', 'SUCCESS', { filePath });
      return { success: true, data: true };
    } catch(err) {
      console.error("Save to file error:", err);
      IOLogger.log('PROJECT', 'saveProjectJson', 'ERROR', null, String(err));
      return { success: false, data: false, error: String(err) };
    }
  },

  loadProjectJson: async (filePath: string): Promise<BridgeResponse<any>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    IOLogger.log('PROJECT', 'loadProjectJson', 'START', { filePath });
    try {
        let actualPath = filePath;
        // If user picked a folder initially (legacy behavior), we can't easily find the .dub file.
        // But the new 'Open Project' will pick a .dub file directly.
        if (!filePath.endsWith('.dub')) {
            const error = 'Пожалуйста, выберите файл .dub';
            IOLogger.log('PROJECT', 'loadProjectJson', 'ERROR', { filePath }, error);
            return { success: false, error };
        }

        const content = await invoke<string>('read_text_file', { path: actualPath });
        const projectData = JSON.parse(content);
        
        // Update projectPath to the context of the .dub file
        const projectPath = actualPath.replace(/\\/g, '/').substring(0, actualPath.replace(/\\/g, '/').lastIndexOf('/'));
        projectData.projectPath = projectPath;

        IOLogger.log('PROJECT', 'loadProjectJson', 'SUCCESS', { 
          name: projectData.name, 
          tracks: projectData.tracks?.length, 
          segments: projectData.tracks?.reduce((acc: number, t: any) => acc + (t.segments?.length || 0), 0)
        });

        return {
           success: true,
           data: projectData
        };
    } catch(err) {
        console.warn("Project file load failed:", err);
        IOLogger.log('PROJECT', 'loadProjectJson', 'ERROR', { filePath }, String(err));
        return { success: false, error: String(err) };
    }
  },

  copyFileToProject: async (src: string, destDir: string): Promise<BridgeResponse<string>> => {
    IOLogger.log('BRIDGE', 'copyFileToProject', 'START', { src, destDir });
    if (!IS_TAURI) {
      // In web, we just pretend we copied it and return a simulated path or the original
      IOLogger.log('BRIDGE', 'copyFileToProject', 'SUCCESS', { web: true, path: src });
      return { success: true, data: src };
    }
    try {
        const result = await invoke<string>('copy_file_to_project', { src, destDir });
        IOLogger.log('BRIDGE', 'copyFileToProject', 'SUCCESS', { result });
        return { success: true, data: result };
    } catch(err) {
        IOLogger.log('BRIDGE', 'copyFileToProject', 'ERROR', { src }, String(err));
        return { success: false, error: String(err) };
    }
  },

  importLegacyJson: async (jsonString: string): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<string>('migrate_json_to_db', { jsonString });
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  // --- AUDIO PEAKS AND SAVING ---
  extractAudioPeaks: async (videoPath: string, projectPath: string): Promise<BridgeResponse<{ filePath: string, peaks: Float32Array, duration: number }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    const wavPath = `${projectPath}/original_audio.wav`.replace(/\\/g, '/');
    
    try {
      // Use event-driven action for long running peak extraction
      const response = await emitAction('extract_audio_peaks', { filePath: videoPath, outputDir: projectPath });
      console.log("extract_audio_peaks event response received");
      const peaks = bufferToFloat32Array(response);
      const duration = peaks.length / 50.0;
      
      return { success: true, data: { filePath: wavPath, peaks, duration } };
    } catch(err) {
      console.error("Peak extract error, using fallback waveform:", err);
      // Fallback: Try to get duration or assume 30s, and generate dummy peaks
      let duration = 30; // default
      try {
          const info = await invoke<any>('get_file_info', { path: videoPath });
          if (info && info.duration) duration = info.duration;
      } catch(e) {}

      // Use WaveformService fallback if possible, otherwise generate legacy way manually
      const points = Math.max(100, Math.floor(duration * 50));
      const dummyPeaks = new Float32Array(points);
      for(let i=0; i<points; i++) {
          dummyPeaks[i] = 0.05 + Math.random() * 0.1;
          if (i % 50 === 0) dummyPeaks[i] = 0.3; // some spikes for visual feedback
      }

      return { 
          success: true, // We return success even if peaks are dummy to keep UI alive
          data: { 
              filePath: wavPath, 
              peaks: dummyPeaks, 
              duration 
          } 
      };
    }
  },

  // --- AUDIO ENGINE ---
  getAudioDevices: async (): Promise<BridgeResponse<any[]>> => {
    if (!IS_TAURI) return { success: false, data: [] };
    try {
        const result = await invoke<any[]>('get_audio_devices');
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },
  
  startAsioRecording: async (
    device: string, 
    sampleRate: number, 
    bufferSize: number, 
    trackId: string, 
    segmentId: string, 
    startTime: number,
    hostName: string = "ASIO",
    channelIndex: number = 0,
    backstageRecord: boolean = false,
    videoDevice: string | null = null,
    audioDevice: string | null = null,
    projectPath: string | null = null,
    gateEnabled: boolean = false,
    gateThreshold: number = -45.0,
    limiterEnabled: boolean = false,
    limiterThreshold: number = -9.0
  ): Promise<BridgeResponse<void>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        console.log(`[Bridge] start_recording via event: device=${device}, host=${hostName}, limiter=${limiterEnabled} (${limiterThreshold}dB)`);
        
        await emitAction('start_recording', { 
            deviceName: device, 
            hostName: hostName, 
            sampleRate, 
            bufferSize,
            trackId,
            segmentId,
            startTime,
            channelIndex,
            backstageRecord,
            videoDevice,
            audioDevice,
            projectPath,
            gateEnabled,
            gateThreshold,
            limiterEnabled,
            limiterThreshold
        });
        
        return { success: true };
    } catch(err) {
        console.error("[Bridge] start_recording error:", err);
        return { success: false, error: String(err) };
    }
  },

  checkCrashes: async (): Promise<BridgeResponse<any[]>> => {
    if (!IS_TAURI) return { success: true, data: [] };
    try {
        const result = await invoke<any[]>('check_crashes');
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  generateWaveformPeaks: async (data: { filePath: string, points: number }): Promise<BridgeResponse<number[]>> => {
    let file = webFileMap.get(data.filePath);
    if (!file) {
      const basename = data.filePath.split(/[/\\]/).pop();
      if (basename) file = webFileMap.get(basename);
    }
    
    // If we have the file available locally in the web cache, we bypass the native Tauri call 
    // to prevent throwing unreadable and scary OS errors in the Tauri backend logs.
    if (IS_TAURI && !file) {
      try {
          const result = await invoke<number[]>('generate_waveform_peaks', {
              filePath: data.filePath,
              points: data.points
          });
          return { success: true, data: result };
      } catch(err) {
          console.debug("[tauriLegacyWrapper] get waveform peaks via Tauri failed, using web decoder fallback", err);
      }
    }
    
    // Generate real peaks for web mode / dropped files
    if (file) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(1, 44100, 44100);
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const channelData = audioBuffer.getChannelData(0);
        const points = data.points || 1024;
        const step = Math.max(1, Math.floor(channelData.length / points));
        const peaks = new Array(points).fill(0);
        
        let globalMax = 0;
        for (let i = 0; i < points; i++) {
            let max = 0;
            const start = i * step;
            const end = Math.min(start + step, channelData.length);
            for (let j = start; j < end; j++) {
                const val = Math.abs(channelData[j]);
                if (val > max) max = val;
            }
            peaks[i] = max;
            if (max > globalMax) globalMax = max;
        }
        
        // Normalize
        if (globalMax > 0.001) {
            for (let i = 0; i < points; i++) {
                peaks[i] = peaks[i] / globalMax;
            }
        }
        
        return { success: true, data: peaks };
      } catch (e) {
        console.warn("Could not decode peaks via Web Audio, falling back...", e);
      }
    }
    
    // Fallback if decoding failed or no file matched
    const peaks = Array.from({ length: data.points || 1024 }, () => 0.05 + Math.random() * 0.4);
    return { success: true, data: peaks };
  },

  getFileInfo: async (filePath: string): Promise<BridgeResponse<any>> => {
    let file = webFileMap.get(filePath);
    if (!file) {
      const basename = filePath.split(/[/\\]/).pop();
      if (basename) file = webFileMap.get(basename);
    }

    // Only call Tauri if we don't have it in webFileMap to prevent triggering os error 2 console logs
    if (IS_TAURI && !file) {
      try {
          const result = await invoke<any>('get_file_info', { path: filePath });
          let duration = 45;
          let durationLoaded = false;
          try {
              const mediaInfoStr = await invoke<string>('get_media_info', { path: filePath });
              const mediaInfo = JSON.parse(mediaInfoStr);
              if (mediaInfo?.format?.duration) {
                  duration = parseFloat(mediaInfo.format.duration);
                  durationLoaded = true;
              } else if (mediaInfo?.streams) {
                  for (const s of mediaInfo.streams) {
                      if (s.duration) {
                          duration = parseFloat(s.duration);
                          durationLoaded = true;
                          break;
                      }
                  }
              }
          } catch (e) {
              console.warn("Could not retrieve duration using get_media_info", e);
          }

          // HTML5 Webview Parser Backup/Fallback
          if (!durationLoaded || isNaN(duration) || duration <= 0) {
              try {
                  const url = convertFileSrc(filePath);
                  const isVid = filePath.match(/\.(mp4|mkv|webm|avi|mov)$/i);
                  duration = await new Promise<number>((resolve) => {
                     const media = isVid ? document.createElement('video') : document.createElement('audio');
                     const timeout = setTimeout(() => {
                         media.src = '';
                         resolve(45);
                     }, 3000); // 3 seconds timeout
                     media.onloadedmetadata = () => {
                       clearTimeout(timeout);
                       resolve(media.duration);
                     };
                     media.onerror = () => {
                       clearTimeout(timeout);
                       resolve(45);
                     };
                     media.src = url;
                  });
              } catch (e) {
                  console.warn("HTML5 backup getFileInfo duration extraction failed", e);
              }
          }

          return { 
            success: true, 
            data: { 
              ...result,
              duration
            } 
          };
      } catch(err) {
          console.debug("[tauriLegacyWrapper] get_file_info via Tauri failed, using web file cache info", err);
      }
    }

    let exactDuration = 45;
    if (file) {
      try {
        const url = URL.createObjectURL(file);
        const isVideo = file.type.startsWith('video/') || file.name.match(/\.(mp4|mkv|webm|avi|mov)$/i);
        exactDuration = await new Promise<number>((resolve) => {
           const media = isVideo ? document.createElement('video') : document.createElement('audio');
           media.onloadedmetadata = () => {
             resolve(media.duration);
             URL.revokeObjectURL(url);
           };
           media.onerror = () => {
             resolve(45);
             URL.revokeObjectURL(url);
           };
           media.src = url;
        });
      } catch(e) {
        console.warn("web fallback getFileInfo duration extraction failed", e);
      }
    }

    const fileName = filePath.split(/[/\\]/).pop() || 'file';
    return { 
      success: true, 
      data: { 
        path: filePath, 
        name: fileName, 
        size: file?.size || 1024 * 1024, 
        duration: exactDuration
      } 
    };
  },

  readTextFile: async (path: string): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<string>('read_text_file', { path });
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  readBinaryFile: async (path: string): Promise<BridgeResponse<Uint8Array>> => {
    IOLogger.log('BRIDGE', 'readBinaryFile', 'START', { path });
    
    // Always check webFileMap first - it might be a Drag&Drop file or a mapped Blob URL!
    let file = webFileMap.get(path);
    if (!file) {
      const basename = path.split(/[/\\]/).pop();
      if (basename) file = webFileMap.get(basename);
    }
    
    if (file) {
      const buffer = await file.arrayBuffer();
      IOLogger.log('BRIDGE', 'readBinaryFile', 'SUCCESS', { path, size: buffer.byteLength, source: 'cache' });
      return { success: true, data: new Uint8Array(buffer) };
    }

    // If it's a URL (blob, http, data), always use fetch regardless of environment
    if (path.startsWith('http') || path.startsWith('blob:') || path.startsWith('data:')) {
      try {
        const res = await fetch(path);
        const buffer = await res.arrayBuffer();
        return { success: true, data: new Uint8Array(buffer) };
      } catch (e) {
        IOLogger.log('BRIDGE', 'readBinaryFile', 'ERROR', { path }, `Fetch failed: ${e}`);
        return { success: false, error: `Web/Bridge: Failed to fetch binary from URL: ${e}` };
      }
    }

    if (IS_TAURI) {
      try {
          // Attempt HTTP stream first to avoid massive JSON serialization IPC bottleneck
          const srcUrl = (window as any).__TAURI__?.convertFileSrc ? (window as any).__TAURI__.convertFileSrc(path) : `tauri://localhost/${path.replace(/\\/g, '/')}`;
          const res = await fetch(srcUrl);
          if (res.ok) {
              const buffer = await res.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              IOLogger.log('BRIDGE', 'readBinaryFile', 'SUCCESS', { path, size: bytes.length, source: 'tauri_stream' });
              return { success: true, data: bytes };
          }
      } catch (e) {
          console.warn("fetch binary via tauri stream failed, falling back to IPC:", e);
      }

      try {
          const result = await invoke<number[]>('read_binary_file', { path });
          const bytes = new Uint8Array(result);
          IOLogger.log('BRIDGE', 'readBinaryFile', 'SUCCESS', { path, size: bytes.length, source: 'tauri_ipc' });
          return { success: true, data: bytes };
      } catch(err) {
          IOLogger.log('BRIDGE', 'readBinaryFile', 'ERROR', { path }, String(err));
          return { success: false, error: String(err) };
      }
    }
    
    const errorMsg = `Web preview: File "${path}" not found in cache. Please re-import the file.`;
    IOLogger.log('BRIDGE', 'readBinaryFile', 'ERROR', { path }, errorMsg);
    return { success: false, error: errorMsg };
  },

  stopAsioRecording: async (): Promise<BridgeResponse<any>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
      console.log("[Bridge] stop_recording initiated via event");
      const result: any = await emitAction('stop_recording', {});
      console.log("[Bridge] stop_recording result:", result);

      return { 
          success: true,
          data: { 
              filePath: result.filePath,
              videoPath: result.videoPath,
              metadata: {
                  peaks: new Float32Array(result.metadata.peaks),
                  duration: result.metadata.duration
              }
          }
      };
    } catch(err) {
        console.error("[Bridge] stop_recording error:", err);
        return { success: false, error: String(err) };
    }
  },

  forceStopAll: async (): Promise<BridgeResponse<void>> => {
    if (!IS_TAURI) return { success: true };
    try {
        // Cleanup all pending UI listeners first
        listenerRegistry.forEach(unlisten => unlisten());
        listenerRegistry.clear();

        await emitAction('force_stop_all', {});
        return { success: true };
    } catch(err) {
        console.error("[Bridge] force_stop_all error:", err);
        return { success: false, error: String(err) };
    }
  },

  cleanupAllListeners: () => {
    listenerRegistry.forEach(unlisten => unlisten());
    listenerRegistry.clear();
  },

  onRecordingStarted: (cb: () => void): (() => void) => {
    if (!IS_TAURI) return () => {};
    let unlisten: UnlistenFn | null = null;
    let isCancelled = false;
    
    listen('recording-started', () => {
      if (!isCancelled) cb();
    }).then(u => {
      if (isCancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    
    return () => {
      isCancelled = true;
      if (unlisten) unlisten();
    };
  },

  // --- EXPORT ENGINE ---
  onExportProgress: (cb: (percent: number) => void): (() => void) => {
    if (!IS_TAURI) return () => {};
    let unlisten: UnlistenFn | null = null;
    let isCancelled = false;
    
    listen<number>('export-progress', (event) => {
      if (!isCancelled) cb(event.payload);
    }).then(u => {
      if (isCancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    
    return () => {
      isCancelled = true;
      if (unlisten) unlisten();
    };
  },
  
  exportAudio: async (options: any): Promise<BridgeResponse<{ success: boolean }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    IOLogger.log('EXPORT', 'exportAudio', 'START', { outputPath: options.outputPath, format: options.format });
    try {
        await invokeWithWatchdog('export_audio', {
            projectJson: options.projectJson,
            outputPath: options.outputPath,
            format: options.format || 'wav',
            bitDepth: options.bitDepth,
            bitrate: options.bitrate
        }, { progressEvent: 'export-progress' });
        IOLogger.log('EXPORT', 'exportAudio', 'SUCCESS', { outputPath: options.outputPath });
        return { success: true, data: { success: true } };
    } catch(err) {
        console.error("Export Error:", err);
        IOLogger.log('EXPORT', 'exportAudio', 'ERROR', { outputPath: options.outputPath }, String(err));
        return { success: false, error: String(err) };
    }
  },

  renderFinalVideo: async (options: {
    originalVideo: string,
    masterDub: string,
    bgVolume: number,
    dubVolume: number,
    outputPath: string,
    title?: string,
    artist?: string,
  }): Promise<BridgeResponse<{ success: boolean }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    IOLogger.log('EXPORT', 'renderFinalVideo', 'START', { outputPath: options.outputPath, title: options.title });
    try {
        await invokeWithWatchdog('render_final_video', {
            originalVideo: options.originalVideo,
            masterDub: options.masterDub,
            bgVolume: options.bgVolume,
            dubVolume: options.dubVolume,
            outputPath: options.outputPath,
            title: options.title || "Unknown",
            artist: options.artist || "Unknown"
        }, { progressEvent: 'export-progress' });
        IOLogger.log('EXPORT', 'renderFinalVideo', 'SUCCESS', { outputPath: options.outputPath });
        return { success: true, data: { success: true } };
    } catch(err) {
        console.error("Render Final Video Error:", err);
        IOLogger.log('EXPORT', 'renderFinalVideo', 'ERROR', { outputPath: options.outputPath }, String(err));
        return { success: false, error: String(err) };
    }
  },

  exportStems: async (args: { projectData: any, outputDir: string, bitDepth: string }): Promise<BridgeResponse<{ success: boolean }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        await invokeWithWatchdog('export_stems', {
            projectJson: JSON.stringify({
                ...args.projectData,
                audio_offset_ms: args.projectData.audioOffsetMs || 0
            }),
            options: {
                bit_depth: args.bitDepth,
                output_dir: args.outputDir
            }
        }, { progressEvent: 'stem-progress' });
        return { success: true, data: { success: true } };
    } catch(err) {
        console.error("Stem Export Error:", err);
        return { success: false, error: String(err) };
    }
  },

  onStemProgress: (cb: (data: { current: number, total: number, trackName: string }) => void): (() => void) => {
      if (!IS_TAURI) return () => {};
      let unlisten: UnlistenFn | null = null;
      let isCancelled = false;
      
      listen<any>('stem-progress', (event) => {
        if (!isCancelled) cb(event.payload);
      }).then(u => {
        if (isCancelled) {
          u();
        } else {
          unlisten = u;
        }
      });
      
      return () => {
        isCancelled = true;
        if (unlisten) unlisten();
      };
  },

  // --- SUBTITLES ---
  openSubtitles: async (projectId?: string): Promise<BridgeResponse<any>> => {
    if (!IS_TAURI) {
       return new Promise((resolve) => {
         const input = document.createElement('input');
         input.type = 'file';
         input.accept = '.ass,.srt,.vtt,.txt,.fb2,.epub,.docx,.pdf';
         input.onchange = async (e: any) => {
           const file = e.target.files[0];
           if (file) {
             const path = file.name;
             IOLogger.log('SUBTITLES', 'openSubtitles (Web)', 'START', { fileName: file.name, size: file.size });
             addToWebFileCache(path, file);
             
             try {
               let content: string | ArrayBuffer;
               if (['docx', 'epub', 'pdf'].some(ext => file.name.endsWith(ext))) {
                 content = await file.arrayBuffer();
               } else {
                 content = await file.text();
               }
               
               const subtitles = await UniversalParserService.parse(content, file.name);
               const roles = Array.from(new Set(subtitles.map(s => s.role)));
               
               IOLogger.log('SUBTITLES', 'openSubtitles (Web)', 'SUCCESS', { count: subtitles.length, roles });
               resolve({ 
                 success: true, 
                 data: { 
                   path, 
                   name: file.name, 
                   parsed: { roles, subtitles } 
                 } 
               });
             } catch(err) {
               IOLogger.log('SUBTITLES', 'openSubtitles (Web)', 'ERROR', null, String(err));
               resolve({ success: false, error: String(err) });
             }
           } else {
             resolve({ success: false, error: 'Cancelled' });
           }
         };
         input.click();
       });
    }
    console.log("[Bridge] openSubtitles called");
    IOLogger.log('SUBTITLES', 'openSubtitles', 'START');
    try {
        const filePath = await open({
            filters: [{ name: 'Scripts', extensions: ['ass', 'srt', 'vtt', 'txt', 'csv', 'fb2', 'epub', 'docx', 'pdf'] }]
        });
        if (!filePath || Array.isArray(filePath)) {
          IOLogger.log('SUBTITLES', 'openSubtitles', 'ERROR', null, 'Cancelled');
          return { success: false, error: 'User cancelled' };
        }

        const fileName = (filePath as string).split(/[/\\]/).pop() || '';
        const ext = fileName.split('.').pop()?.toLowerCase();
        
        let contentToParse: string | ArrayBuffer;
        if (ext === 'docx' || ext === 'epub' || ext === 'pdf') {
             try {
                const arr = await invoke<number[]>('read_binary_file', { path: filePath });
                contentToParse = new Uint8Array(arr).buffer;
             } catch (e) {
                 console.warn("Failed binary fallback, trying text read", e);
                 contentToParse = await invoke<string>('read_text_file', { path: filePath });
             }
        } else {
             contentToParse = await invoke<string>('read_text_file', { path: filePath });
        }
        
        const subtitles = await UniversalParserService.parse(contentToParse, fileName);
        const roles = Array.from(new Set(subtitles.map(s => s.role)));

        if (projectId) {
            await invoke('save_subtitles', { projectId, subtitles });
        }

        IOLogger.log('SUBTITLES', 'openSubtitles', 'SUCCESS', { fileName, count: subtitles.length, roles });
        return { success: true, data: { path: filePath, name: fileName, parsed: { roles, subtitles } } };
    } catch (err) {
        console.error('[Bridge] Failed to open subtitles:', err);
        IOLogger.log('SUBTITLES', 'openSubtitles', 'ERROR', null, String(err));
        return { success: false, error: String(err) };
    }
  },

  // --- MEDIA PROCESSING ---
  muxVideo: async (args: { videoPath: string, audioPath: string, outputPath: string, duration?: number }): Promise<BridgeResponse<{ success: boolean }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        await invokeWithWatchdog('mux_video', { 
            videoInput: args.videoPath, 
            audioInput: args.audioPath, 
            outputPath: args.outputPath,
            duration: args.duration
        }, { progressEvent: 'media-progress' });
        return { success: true, data: { success: true } };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  createProxyVideo: async (videoPath: string, projectPath: string, duration?: number): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: true, data: videoPath };
    const fileName = videoPath.split(/[/\\]/).pop();
    const proxyPath = `${projectPath}/proxies/proxy_${fileName}`;
    
    try {
        const result = await invokeWithWatchdog<string>('create_proxy_video', { 
            inputPath: videoPath, 
            outputPath: proxyPath,
            duration: duration
        }, { progressEvent: 'media-progress' });
        return { success: true, data: result };
    } catch(err) {
        return { success: false, data: videoPath, error: String(err) };
    }
  },

  onMediaProgress: (cb: (data: { time: string, percent: number, operation: string }) => void): (() => void) => {
      if (!IS_TAURI) return () => {};
      let unlisten: UnlistenFn | null = null;
      let isCancelled = false;
      
      listen<any>('media-progress', (event) => {
        if (!isCancelled) cb(event.payload);
      }).then(u => {
        if (isCancelled) {
          u();
        } else {
          unlisten = u;
        }
      });
      
      return () => {
        isCancelled = true;
        if (unlisten) unlisten();
      };
  },

  mergeSegments: async (args: { 
      projectId: string, 
      trackId: string, 
      segmentIds: string[], 
      outputPath: string 
  }): Promise<BridgeResponse<{ filePath: string, duration: number, peaks: Float32Array }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<any>('merge_segments', {
            projectId: args.projectId,
            trackId: args.trackId,
            segmentIds: args.segmentIds,
            outputPath: args.outputPath
        });
        
        return { 
            success: true,
            data: { 
                filePath: result.file_path, 
                duration: result.duration,
                peaks: new Float32Array(result.peaks)
            }
        };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  mergeProjectSegments: async (data: { segments: { path: string, start_time: number, duration: number }[], total_duration: number, output_path: string }): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<string>('merge_project_segments', {
            segments: data.segments,
            totalDuration: data.total_duration,
            outputPath: data.output_path
        });
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  // --- REAL IMPLEMENTATIONS FOR PREVIOUS DUMMIES ---
  saveTake: async (args: { projectPath: string, role: string, startTime: number, audioData: Uint8Array }): Promise<BridgeResponse<{ filePath: string, peaks: Float32Array }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        // Use the backend to save the webm and convert it to WAV
        const filePath = await invoke<string>('save_media_recorder_take', { 
            projectPath: args.projectPath, 
            role: args.role, 
            data: Array.from(args.audioData) 
        });
        
        // Generate peaks
        const peaksRaw = await invoke<number[]>('generate_waveform_peaks', { 
            file_path: filePath, 
            points: 1024 
        });

        return { 
            success: true, 
            data: { 
                filePath, 
                peaks: new Float32Array(peaksRaw) 
            } 
        };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  openVideo: async (): Promise<BridgeResponse<{ path: string, name: string, projectPath: string, size: number }>> => {
    if (!IS_TAURI) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*,audio/*';
        input.onchange = (e: any) => {
          const file = e.target.files[0];
          if (file) {
            const path = file.name;
            addToWebFileCache(path, file);
            resolve({ 
              success: true, 
              data: { 
                path, 
                name: file.name, 
                projectPath: '/StudioWorkspace/Project', 
                size: file.size 
              } 
            });
          } else {
            resolve({ success: false, error: 'Cancelled' });
          }
        };
        input.click();
      });
    }
    console.log("[Bridge] openVideo called");
    try {
        const path = await open({
            filters: [{ name: 'Media', extensions: ['mp4', 'mkv', 'avi', 'mov', 'mp3', 'wav', 'ogg', 'flac'] }]
        });
        if (!path || Array.isArray(path)) return { success: false, error: 'Cancelled' };
        
        const info = await invoke<any>('get_file_info', { path });
        const projectPath = path.replace(/\\/g, '/').substring(0, path.replace(/\\/g, '/').lastIndexOf('/'));

        return { 
            success: true, 
            data: { 
                path: info.path || path as string, 
                name: info.name, 
                projectPath: projectPath, 
                size: info.size 
            } 
        };
    } catch(err) {
        console.error("[Bridge] openVideo error:", err);
        return { success: false, error: String(err) };
    }
  },

  openFile: async (options: { title: string, filters: { name: string, extensions: string[] }[] }): Promise<BridgeResponse<{ path: string, name: string, content?: string }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const path = await open({
            title: options.title,
            filters: options.filters
        });
        if (!path || Array.isArray(path)) return { success: false, error: 'Cancelled' };
        
        const content = await invoke<string>('read_text_file', { path });
        const name = path.split(/[/\\]/).pop() || '';

        return { success: true, data: { path, name, content } };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  openFiles: async (options: { title: string, filters: { name: string, extensions: string[] }[] }): Promise<BridgeResponse<{ path: string, name: string }[]>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const paths = await open({
            title: options.title,
            filters: options.filters,
            multiple: true
        });
        if (!paths) return { success: false, error: 'Cancelled' };
        
        const pathList = Array.isArray(paths) ? paths : [paths];
        const results = pathList.map(p => {
             const name = p.split(/[/\\]/).pop() || '';
             return { path: p, name };
        });
        return { success: true, data: results };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  saveFile: async (options: { title: string, defaultPath: string, filters: { name: string, extensions: string[] }[] }): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const path = await save({
            title: options.title,
            defaultPath: options.defaultPath,
            filters: options.filters
        });
        return path ? { success: true, data: path } : { success: false, error: 'Cancelled' };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  getAudioFiles: async (folderPath: string): Promise<BridgeResponse<{ path: string, name: string, duration: number, peaks: number[] }[]>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const files = await invoke<any[]>('list_audio_files', { folderPath });
        return { success: true, data: files };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  initProject: async (projectPath: string): Promise<BridgeResponse<void>> => {
    if (!IS_TAURI) return { success: true };
    try {
        await invoke('init_project_folder', { path: projectPath });
        return { success: true };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  moveProject: async (oldPath: string, newPath: string): Promise<BridgeResponse<boolean>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        await invoke('move_project_folder', { oldPath, newPath });
        return { success: true, data: true };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  openPath: async (path: string): Promise<BridgeResponse<void>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        // This usually opens in folder explorer
        await invoke('open_path', { path });
        return { success: true };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  generateStressTest: async (projectId: string, trackId: string, projectPath: string): Promise<BridgeResponse<void>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        await invoke('generate_stress_test', { projectId, trackId, projectPath });
        return { success: true };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  loadSegmentsInRange: async (trackId: string, startTime: number, endTime: number): Promise<BridgeResponse<any[]>> => {
    if (!IS_TAURI) return { success: true, data: [] };
    try {
        const segments = await invoke<any[]>('load_segments_in_range', { trackId, startTime, endTime });
        return { success: true, data: segments };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  // --- REMAINING DUMMIES ---
  parseFixes: async (text: string, _subtitles: any[]): Promise<BridgeResponse<any[]>> => {
    // Simple regex parser for labels like: [01:23] Actor: Comment
    const lines = text.split('\n');
    const fixes: any[] = [];
    const regex = /\[(\d+):(\d+)\]\s*(.*?):\s*(.*)/;

    lines.forEach(line => {
      const match = line.match(regex);
      if (match) {
        const mins = parseInt(match[1]);
        const secs = parseInt(match[2]);
        fixes.push({
          id: Math.random().toString(36).substr(2, 9),
          timestamp: mins * 60 + secs,
          actor: match[3],
          comment: match[4],
          isResolved: false
        });
      }
    });

    return { success: true, data: fixes };
  },
  requestPermissions: async () => ({ success: true, data: true }),

  quickPreviewExport: async (data: { projectPath: string, segmentId: string }): Promise<BridgeResponse<{ success: boolean }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        await invokeWithWatchdog('quick_preview_export', data);
        return { success: true, data: { success: true } };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  batchExport: async (options: any): Promise<BridgeResponse<string[]>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
      const result = await invoke<string[]>('batch_export', options);
      return { success: true, data: result };
    } catch(err) {
      return { success: false, error: String(err) };
    }
  },
  exportAudioBook: async (options: any): Promise<BridgeResponse<{ success: boolean, path?: string }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
      const mappedOptions = {
          projectPath: options.projectPath,
          outputPath: options.outputPath,
          format: options.format,
          gapDuration: options.gapDuration,
          normalizeLufs: options.normalizeLUFS || options.normalizeLufs,
          segments: options.segments
      };
      const result = await invoke<string>('export_audio_book', mappedOptions);
      return { success: true, data: { success: true, path: result } };
    } catch(err) {
      return { success: false, error: String(err) };
    }
  },
  // --- PROJECT HEALTH & VERIFICATION ---
  verifyProjectFiles: async (projectId: string, projectRoot: string): Promise<BridgeResponse<{ missingSegments: any[], orphanedFiles: string[] }>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<any>('verify_project_files', { projectId, projectRoot });
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  calculateFileHash: async (path: string): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<string>('calculate_file_hash', { path });
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  findFileByHash: async (searchRoot: string, targetHash: string): Promise<BridgeResponse<string | null>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<string | null>('find_file_by_hash', { searchRoot, targetHash });
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  relinkSegmentFile: async (segmentId: string, newPath: string): Promise<BridgeResponse<void>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        await invoke('relink_segment_file', { segmentId, newPath });
        return { success: true };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  cleanupOrphanedFiles: async (files: string[]): Promise<BridgeResponse<void>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        await invoke('cleanup_orphaned_files', { files });
        return { success: true };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  exportBackstageVideo: async (args: { mainVideoPath: string, backstageVideoPath: string, finalAudioPath: string, outputPath: string, webcamExportOverlay?: boolean }): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<string>('export_backstage_video', args);
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  concatBackstageVideos: async (args: { videoPaths: string[], outputPath: string, backstageMode?: string, isBackstageEnabled?: boolean }): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<string>('concat_backstage_videos', args);
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  exportAllStems: async (args: { projectJson: string, outputPath: string }): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invokeWithWatchdog('export_all_stems', args);
        return { success: true, data: result as string };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },

  getMediaInfo: async (path: string): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<string>('get_media_info', { path });
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: typeof err === 'object' ? JSON.stringify(err) : String(err) };
    }
  },

  extractMkvAssets: async (data: { inputPath: string, videoOutput: string, subOutput?: string, audioIndex: number, subIndex?: number, duration?: number }): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invokeWithWatchdog<string>('extract_mkv_assets', data, { progressEvent: 'media-progress', timeoutMs: 300000 });
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: typeof err === 'object' ? JSON.stringify(err) : String(err) };
    }
  },

  createBlankVideo: async (duration: number, outputPath: string): Promise<BridgeResponse<string>> => {
    if (!IS_TAURI) return { success: false, error: 'Not in Tauri' };
    try {
        const result = await invoke<string>('create_blank_video', { duration, outputPath });
        return { success: true, data: result };
    } catch(err) {
        return { success: false, error: String(err) };
    }
  },
};

export function setupTauriLegacyWrapper() {
  if (typeof window !== 'undefined') {
    (window as any).electronAPI = tauriAPI;
    
    // Monkey-patch URL.createObjectURL to auto-register blob URLs in webFileMap
    if (typeof URL !== 'undefined' && URL.createObjectURL && !(URL as any).__patchedByStudio) {
      const originalCreateObjectURL = URL.createObjectURL;
      URL.createObjectURL = function (obj: any): string {
        const url = originalCreateObjectURL(obj);
        if (obj instanceof Blob) {
          webFileMap.set(url, obj as File);
        }
        return url;
      };
      (URL as any).__patchedByStudio = true;
    }
  }
}

