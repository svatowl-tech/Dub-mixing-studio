import React, { useEffect, useState, useRef } from 'react';
import { Monitor } from 'lucide-react';
import ActorOverlay from './components/ActorOverlay';
import { Project } from './types';

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean, error: any}> {
  state: { hasError: boolean, error: any };
  props: {children: React.ReactNode};
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-screen bg-black text-red-500 flex flex-col items-center justify-center p-4">
          <h1 className="text-xl font-bold mb-4">Studio Mode Error</h1>
          <pre className="text-xs bg-red-950/50 p-4 rounded overflow-auto max-w-full">
            {this.state.error?.toString()}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const StudioModeContent = () => {
  const [state, setState] = useState<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const tauriEmitRef = useRef<any>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const toggleFullscreen = () => {
    const elem = document.documentElement;
    if (!document.fullscreenElement) {
      elem.requestFullscreen().catch((err) => {
        console.error(`Fullscreen error: ${err.message}`);
      });
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  useEffect(() => {
    // We must signal to the main window that we are ready
    const channel = new BroadcastChannel('studio-mode');
    channelRef.current = channel;
    
    // Periodically let the main window know we exist
    const interval = setInterval(() => {
      channel.postMessage({ type: 'STUDIO_PING' });
      if (!!(window as any).__TAURI_INTERNALS__) {
        import('@tauri-apps/api/event').then(({ emit }) => emit('studio-ping'));
      }
    }, 1000);

    const handleSyncTime = (payload: any) => {
        setState((prev: any) => ({ ...prev, ...payload }));
        if (videoRef.current) {
          const t = payload.currentTime;
          if (t !== undefined && typeof t === 'number' && !isNaN(t) && Math.abs(videoRef.current.currentTime - t) > 0.15) {
            videoRef.current.currentTime = t;
          }
          if (payload.isPlaying && videoRef.current.paused) {
            videoRef.current.play().catch(() => {});
          } else if (!payload.isPlaying && !videoRef.current.paused) {
            videoRef.current.pause();
          }
        }
    };

    const handleSyncData = (payload: any) => {
        setState((prev: any) => ({ ...prev, ...payload }));
        if (videoRef.current && payload.videoSrc && videoRef.current.src !== payload.videoSrc) {
            videoRef.current.src = payload.videoSrc;
            videoRef.current.load();
        }
    };

    channel.onmessage = (e) => {
      if (e.data.type === 'SYNC_TIME') {
        handleSyncTime(e.data.payload);
      } else if (e.data.type === 'SYNC_DATA') {
        handleSyncData(e.data.payload);
      } else if (e.data.type === 'UPDATE_TELEPROMPTER_SETTINGS') {
        setState((prev: any) => {
          if (!prev) return prev;
          return { ...prev, ...e.data.payload };
        });
      }
    };

    let unlistenTauriTime: any = null;
    let unlistenTauriData: any = null;
    let unlistenTauriSettings: any = null;
    if (!!(window as any).__TAURI_INTERNALS__) {
      import('@tauri-apps/api/event').then(({ listen, emit }) => {
        tauriEmitRef.current = emit;
        listen('studio-sync-time', (e: any) => {
          handleSyncTime(e.payload);
        }).then(unlisten => unlistenTauriTime = unlisten);
        
        listen('studio-sync-data', (e: any) => {
          handleSyncData(e.payload);
        }).then(unlisten => unlistenTauriData = unlisten);

        listen('update-teleprompter-settings', (e: any) => {
          setState((prev: any) => {
            if (!prev) return prev;
            return { ...prev, ...e.payload };
          });
        }).then(unlisten => unlistenTauriSettings = unlisten);
      });
    }

    return () => {
      clearInterval(interval);
      channel.close();
      if (unlistenTauriTime) unlistenTauriTime();
      if (unlistenTauriData) unlistenTauriData();
      if (unlistenTauriSettings) unlistenTauriSettings();
    };
  }, []);

  if (!state) {
    return (
      <div className="w-full h-screen bg-black flex flex-col items-center justify-center text-white/50 font-sans">
        <div className="w-12 h-12 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mb-4" />
        <p className="text-lg">Ожидание подключения главного окна...</p>
      </div>
    );
  }

  return (
    <div className="w-full h-screen relative flex items-center justify-center bg-black overflow-hidden select-none">
      {state.videoSrc && (
        <video 
          ref={videoRef}
          className="w-full h-full object-contain shadow-2xl"
          src={state.videoSrc}
          playsInline
          muted
        />
      )}

      {/* Floating Helpers in Popout Window */}
      <div className="absolute top-4 left-4 z-[100] pointer-events-auto flex items-center gap-2 opacity-30 hover:opacity-100 transition-opacity duration-300">
        <button
          onClick={toggleFullscreen}
          className="px-3 py-1.5 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 text-white border border-white/10 text-[10px] font-black transition-all flex items-center gap-1.5 shadow-md active:scale-95 cursor-pointer uppercase tracking-tight"
          title="Развернуть во весь экран"
        >
          <Monitor className="w-3.5 h-3.5" />
          {isFullscreen ? "Свернуть" : "Во весь экран"}
        </button>
      </div>
      
      <ActorOverlay 
        currentLine={state.currentLine} 
        nextLine={state.nextLine} 
        currentTime={state.currentTime || 0}
        showWebcam={false} /* Disabled in secondary window */
        webcamRef={{ current: null }}
        isRecording={state.isRecording || false}
        recordingStream={null}
        isWebcamSimulated={false}
        subtitles={state.subtitles || []}
        teleprompterMode={state.teleprompterMode || 'expanded'}
        teleprompterFontSize={state.teleprompterFontSize || 48}
        teleprompterLineHeight={state.teleprompterLineHeight || 1.1}
        teleprompterPacing={state.teleprompterPacing || 'auto'}
        setTeleprompterFontSize={(fontSize) => {
          setState((prev: any) => ({ ...prev, teleprompterFontSize: fontSize }));
          channelRef.current?.postMessage({ type: 'UPDATE_TELEPROMPTER_SETTINGS', payload: { fontSize } });
          tauriEmitRef.current?.('update-teleprompter-settings', { fontSize }).catch(() => {});
        }}
        setTeleprompterLineHeight={(lineHeight) => {
          setState((prev: any) => ({ ...prev, teleprompterLineHeight: lineHeight }));
          channelRef.current?.postMessage({ type: 'UPDATE_TELEPROMPTER_SETTINGS', payload: { lineHeight } });
          tauriEmitRef.current?.('update-teleprompter-settings', { lineHeight }).catch(() => {});
        }}
        setTeleprompterPacing={(pacing) => {
          setState((prev: any) => ({ ...prev, teleprompterPacing: pacing }));
          channelRef.current?.postMessage({ type: 'UPDATE_TELEPROMPTER_SETTINGS', payload: { pacing } });
          tauriEmitRef.current?.('update-teleprompter-settings', { pacing }).catch(() => {});
        }}
        setTeleprompterMode={(mode) => {
          setState((prev: any) => ({ ...prev, teleprompterMode: mode }));
          channelRef.current?.postMessage({ type: 'UPDATE_TELEPROMPTER_SETTINGS', payload: { mode } });
          tauriEmitRef.current?.('update-teleprompter-settings', { mode }).catch(() => {});
        }}
        teleprompterPosition={state.teleprompterPosition || { x: 0, y: 0 }}
        setTeleprompterPosition={(position) => {
          setState((prev: any) => ({ ...prev, teleprompterPosition: position }));
          channelRef.current?.postMessage({ type: 'UPDATE_TELEPROMPTER_SETTINGS', payload: { position } });
          tauriEmitRef.current?.('update-teleprompter-settings', { position }).catch(() => {});
        }}
        teleprompterSize={state.teleprompterSize || { width: 800, height: 200 }}
        setTeleprompterSize={(size) => {
          setState((prev: any) => ({ ...prev, teleprompterSize: size }));
          channelRef.current?.postMessage({ type: 'UPDATE_TELEPROMPTER_SETTINGS', payload: { size } });
          tauriEmitRef.current?.('update-teleprompter-settings', { size }).catch(() => {});
        }}
        isAudiobook={state.isAudiobook || false}
        isBackstageRecording={state.isBackstageRecording || false}
        activeRole={state.activeRole || ''}
        project={state.project as Project | null}
        onSettingsChange={() => {}}
        onSeek={() => {}}
      />
    </div>
  );
};

const StudioModeApp = () => {
  return (
    <ErrorBoundary>
      <StudioModeContent />
    </ErrorBoundary>
  );
};

export default StudioModeApp;
