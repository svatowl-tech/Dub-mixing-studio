import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Mic, 
  Play, 
  Pause, 
  SkipBack, 
  Settings, 
  FileVideo, 
  FolderOpen,
  Type, 
  Layers, 
  Download, 
  Plus,
  Trash2,
  Volume2,
  Monitor,
  Video as VideoIcon,
  ChevronRight,
  Upload,
  FileText,
  AlertTriangle,
  LayoutTemplate,
  ZoomIn,
  ZoomOut,
  Activity,
  Cpu,
  Star,
  GripVertical,
  X,
  Bookmark,
  Music,
  ScrollText,
  ArrowUp,
  ArrowDown,
  Maximize2,
  Minimize2,
  Minus,
  BookOpen,
  Archive,
  Circle,
  Square,
  Repeat
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDropzone } from 'react-dropzone';
import WaveSurfer from 'wavesurfer.js';
import { cn, getSafeFileUrl, getGlobalAudioSettings, getDefaultKeyMap, safeConfirm, getAbsoluteFilePath } from './lib/utils';
import { addToWebFileCache, tauriAPI } from './lib/tauriLegacyWrapper';
import { IOLogger } from './lib/ioLogger';
import { FixesPanel } from './components/FixesPanel';
import { Waveform } from './components/Waveform';
import AudioSegmentView from './components/AudioSegmentView';
import VUMeter from './components/VUMeter';
import AudioDeviceManager from './components/AudioDeviceManager';
import ExportModal from './components/ExportModal';
import QuickImportModal from './components/QuickImportModal';
import FixImportModal from './components/FixImportModal';
import PreRollCountdown from './components/PreRollCountdown';
import Teleprompter from './components/Teleprompter';
import { Project, SubtitleLine, AudioTrack, AudioSegment, Fix, Marker, TrackProcessing } from './types';
import { SubtitleService, ParsedSubtitles } from './services/subtitleService';
import { TextImportService } from './services/textImportService';
import { LatencyCalibration } from './components/LatencyCalibration';
import { WaveformService } from './services/waveformService';
import { SmartAlignService } from './services/smartAlignService';
import { FixService } from './services/fixService';
import { BulkImportService } from './services/bulkImportService';
import { UniversalParserService } from './services/UniversalParserService';
import { playbackEngine } from './services/playbackEngine';
import { logger } from './lib/logger';
import { splitSegmentAtTime } from './lib/timelineUtils';

// Extracted Components
import PopoutWindow from './components/PopoutWindow';
import StudioDashboard from './components/StudioDashboard';
import AdvancedTimeline from './components/AdvancedTimeline';
import DocumentViewer from './components/DocumentViewer';
import VirtualizedWaveform from './components/VirtualizedWaveform';
import TimelineCanvas from './components/TimelineCanvas';
import TrackHeader from './components/TrackHeader';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import TransportControls from './components/TransportControls';




import { useProject } from './hooks/useProject';
import { useTimelineState } from './hooks/useTimelineState';
import { useTimelineHotkeys } from './hooks/useTimelineHotkeys';
import { useTimelineHistory } from './hooks/useTimelineHistory';
import { useProjectActions } from './hooks/useProjectActions';
import { ProjectProvider } from './contexts/ProjectContext';
import { TimelineProvider } from './contexts/TimelineContext';
import LeftSidebar from './components/layout/LeftSidebar';
import { UIProvider } from './contexts/UIContext';
import ModalsManager from './components/layout/ModalsManager';
import { MkvTrackSelectorModal } from './components/MkvTrackSelectorModal';
import TopHeader from './components/layout/TopHeader';
import StyledExportOverlay from './components/layout/ExportOverlay';
import { useAudioEngine } from './hooks/useAudioEngine';
import { useProjectImport } from './hooks/useProjectImport';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openStudioWindow, closeStudioWindow } from './lib/windowHelpers';

export default function App() {
  const { 
    project, 
    setProject, 
    recentProjects, 
    handleNewProject, 
    handleOpenProject, 
    handleSaveProject: origHandleSaveProject, 
    onLoadProject 
  } = useProject();

  const handleSaveProject = async () => {
    if (!project || !project.projectPath) {
      alert("Проект не сохранен на диске. Используйте 'Создать проект'.");
      return;
    }
    const updatedProject = {
      ...project,
      uiState: {
        zoomLevel,
        timelineHeight,
        sidebarWidth,
        teleprompterMode,
        teleprompterFontSize,
        teleprompterLineHeight,
        teleprompterPacing,
        teleprompterPosition,
        teleprompterSize,
        showFixes
      }
    };
    setProject(updatedProject);
    if (window.electronAPI) {
      try {
        await window.electronAPI.saveProjectJson({ projectPath: project.projectPath, projectData: updatedProject });
        alert("Проект сохранен!");
      } catch (error) {
        alert(`Ошибка при сохранении проекта: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const [duration, setDuration] = useState(0);
  const [isWebcamSimulated, setIsWebcamSimulated] = useState(false);
  const [isVideoFloatingOpen, setIsVideoFloatingOpen] = useState(true);
  const [videoSize, setVideoSize] = useState<'sm' | 'md' | 'lg' | 'xl'>('md');
  const mainRef = useRef<HTMLDivElement>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const referenceAudioRef = useRef<HTMLAudioElement>(null);
  const lastLoggedIdRef = useRef<string | null>(null);
  const webcamRef = useRef<HTMLVideoElement>(null);

  const {
    currentTime, setCurrentTime,
    zoomLevel, setZoomLevel,
    isPlaying, setIsPlaying,
    isLooping, setIsLooping,
    loopRange, setLoopRange,
    isExporting, setIsExporting,
    exportProgress, setExportProgress,
    exportOperation, setExportOperation,
    timelineHeight, setTimelineHeight,
    isAutoHeight, setIsAutoHeight,
    sidebarWidth, setSidebarWidth,
    isRippleEnabled, setIsRippleEnabled,
    selectedSegmentIds, setSelectedSegmentIds,
    videoError, setVideoError,
    handleSeek,
    togglePlay,
    handleFitToWidth,
    isPlayingRef,
    currentTimeRef,
    timelineRef
  } = useTimelineState(project, duration, setDuration, videoRef, referenceAudioRef);

  const {
    isRecording,
    recordingStream,
    clippingDetected, setClippingDetected,
    recordingPeaks,
    isBackstageRecording,
    setIsBackstageRecording,
    isManualBackstageRecording,
    recordingStartTimeRef,
    startRecording,
    stopRecording,
    discardRecording,
    handleToggleRecord,
    handleToggleBackstage,
    handleDeleteLastTake,
    isRecordingRef,
    isStartingRecordingRef
  } = useAudioEngine(project, setProject, videoRef, currentTimeRef, isPlayingRef, togglePlay, webcamRef);

  const { saveSnapshot, undo, redo, canUndo, canRedo } = useTimelineHistory(project, setProject);

  
  const isRippleEnabledRef = useRef(isRippleEnabled);
  useEffect(() => { isRippleEnabledRef.current = isRippleEnabled; }, [isRippleEnabled]);

  const {
    handleSplit,
    deleteSegments,
    updateSegment,
    updateAllTracks,
    deleteTrack,
    addMarker,
    handleJoinSegments,
    handleArmTrack,
    handleUpdateProcessing,
    handleAddTrack,
    handleDuplicateSegment,
    moveSegmentToTrack
  } = useProjectActions({
    project,
    setProject,
    saveSnapshot,
    selectedSegmentIds,
    setSelectedSegmentIds,
    isPlayingRef,
    currentTimeRef,
    videoRef,
    isRippleEnabledRef
  });

  const { 
    handleSelectVideo, 
    mkvImportData, 
    handleMkvConfirm, 
    handleMkvCancel 
  } = useProjectImport(
    project, 
    setProject, 
    setDuration, 
    setIsExporting, 
    setExportProgress, 
    setExportOperation
  );

  const [isDesktop, setIsDesktop] = useState(!!(window as any).__TAURI_INTERNALS__);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showFixes, setShowFixes] = useState(true);
  const [showQuickImport, setShowQuickImport] = useState(false);
  const [processingTrackId, setProcessingTrackId] = useState<string | null>(null);
  const [quickImportText, setQuickImportText] = useState('');
  const [quickImportDuration, setQuickImportDuration] = useState(5);
  
  const [showFixImport, setShowFixImport] = useState(false);
  const [isPopoutOpen, setIsPopoutOpen] = useState(false);
  const [externalWindow, setExternalWindow] = useState<Window | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [fixImportText, setFixImportText] = useState('');

  // Exit app handler for Tauri main window
  useEffect(() => {
    const handleUnload = () => {
      // Close browser popups
      if (externalWindow && externalWindow !== window && typeof (externalWindow as any).close === 'function') {
        try { (externalWindow as any).close(); } catch(e) {}
      }
    };
    
    let unlistenTauriClose: any = null;
    if (isDesktop && !!(window as any).__TAURI_INTERNALS__) {
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        const mainWindow = getCurrentWindow();
        mainWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            await closeStudioWindow();
          } catch(e) {
            console.error("Cleanup error", e);
          } finally {
            // Now force destroy the main window which terminates the app if it's the last window
            mainWindow.destroy().catch(() => {});
          }
        }).then(unlisten => unlistenTauriClose = unlisten);
      });
    }
    
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      if (unlistenTauriClose) unlistenTauriClose();
    };
  }, [externalWindow, isDesktop]);

  const handleTogglePopout = async () => {
    if (isPopoutOpen) {
      if (externalWindow && externalWindow !== window && typeof (externalWindow as any).close === 'function') {
        try {
          (externalWindow as any).close();
        } catch (e) {
          console.warn('Error closing popout window:', e);
        }
      }
      if (isDesktop) {
        await closeStudioWindow();
      }
      setExternalWindow(null);
      setIsPopoutOpen(false);
      setPopupBlocked(false);
    } else {
      // 1. If we're inside an iframe (like AI Studio preview),
      // directly use Studio Mode (fullscreen overlay) because popups and PiP might be fully blocked
      if (window.top !== window.self) {
        setExternalWindow(window);
        setIsPopoutOpen(true);
        setPopupBlocked(false);
        return;
      }
      
      // 2. Native Desktop popup
      if (isDesktop) {
        const success = await openStudioWindow();
        if (success) {
          setIsPopoutOpen(true);
          setPopupBlocked(false);
          // Set external window to 'pseudo' truthy to satisfy conditional rendering logic
          setExternalWindow('DESKTOP_POPOUT' as any);
        } else {
          setPopupBlocked(true);
        }
        return;
      }

      // 2. Try Document Picture in Picture (Chrome 116+, shares JS Context perfectly)
      if ("documentPictureInPicture" in window) {
        try {
          const pipWindow = await (window as any).documentPictureInPicture.requestWindow({
            width: 1280,
            height: 720,
          });
          setExternalWindow(pipWindow);
          setIsPopoutOpen(true);
          setPopupBlocked(false);
          return;
        } catch (e) {
          console.warn("Document PiP failed:", e);
          // Fallback to error
        }
      }

      // 3. Try window.open popup
      const newWin = window.open(
        '',
        'DubStudioProDualScreenWindow',
        'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no,resizable=yes'
      );
      
      if (!newWin) {
        console.warn('Window.open returned null. Popups are blocked.');
        setPopupBlocked(true);
        setIsPopoutOpen(false);
        setExternalWindow(null);
      } else {
        setPopupBlocked(false);
        setExternalWindow(newWin);
        setIsPopoutOpen(true);
      }
    }
  };

  const handleFixImport = () => {
    if (!project || !project.subtitles) return;
    const fixes = FixService.parseRawFixes(fixImportText, project.subtitles);
    
    let updatedSubtitles = [...project.subtitles];
    
    // Helper to recognize Russian and English keywords for skipped or missing lines
    const isSkipOrMissingOrOverride = (comment: string): boolean => {
      const normalized = comment.toLowerCase();
      const ruKeywords = [
        'пропуск', 'пропустил', 'пропустила', 'пропущена', 'пропущено',
        'твое', 'твоё', 'твоя реплика', 'твоя фраза', 'возьми фразу', 'возьми себе',
        'озвучь тут', 'озвучить тут', 'озвучь', 'добавь', 'добавить реплику', 'добавить',
        'хардсаб', 'хардсаба', 'хардсабах', 'нет в сабах', 'нет реплики', 'нет фразы',
        'пропущен', 'пропущенная'
      ];
      const enKeywords = [
        'skip', 'skipped', 'missing', 'missed', 'add sub', 'add subtitle',
        'your phrase', 'your line', 'yours', 'add replica', 'not in subs', 'hardsub'
      ];
      return ruKeywords.some(kw => normalized.includes(kw)) || enKeywords.some(kw => normalized.includes(kw));
    };

    fixes.forEach(fix => {
      // Find the closest subtitle line to double check
      let matchingSub = updatedSubtitles.find(s => s.id === fix.segmentId);
      if (!matchingSub && fix.timestamp !== undefined) {
        // Fallback search in updatedSubtitles
        matchingSub = updatedSubtitles.find(s => fix.timestamp >= s.start && fix.timestamp <= s.end);
      }

      const commentIsSkip = isSkipOrMissingOrOverride(fix.comment);
      const isTooFar = matchingSub ? (Math.abs(matchingSub.start - fix.timestamp) > 4.0 && Math.abs(matchingSub.end - fix.timestamp) > 4.0) : true;
      const isWrongActor = matchingSub && fix.actor && fix.actor !== 'Unknown' && matchingSub.role !== fix.actor;

      if (commentIsSkip || isTooFar || (isWrongActor && commentIsSkip)) {
        if (isWrongActor && matchingSub && !isTooFar) {
          // Duplicate the existing sub for the correct actor so they can record in this time alignment
          const newSubId = `sub_fix_${Math.random().toString(36).substr(2, 9)}`;
          const duplicatedSub = {
            id: newSubId,
            start: matchingSub.start,
            end: matchingSub.end,
            text: `[ФИКС: Перенос от ${matchingSub.role}] ${matchingSub.text}`,
            role: fix.actor,
            needsFix: true,
            fixComment: fix.comment
          };
          updatedSubtitles.push(duplicatedSub);
          fix.segmentId = newSubId;
        } else {
          // Create a brand new subtitle line for the missing part
          const newSubId = `sub_fix_${Math.random().toString(36).substr(2, 9)}`;
          const newSub = {
            id: newSubId,
            start: fix.timestamp,
            end: fix.timestamp + 3.0,
            text: `[Пропущенная реплика] ${fix.comment}`,
            role: fix.actor && fix.actor !== 'Unknown' ? fix.actor : (project.selectedRole || 'Default'),
            needsFix: true,
            fixComment: fix.comment
          };
          updatedSubtitles.push(newSub);
          fix.segmentId = newSubId;
        }
      } else if (fix.segmentId) {
        // Normal fix mapping on exact/closest sub
        updatedSubtitles = updatedSubtitles.map(s => {
          if (s.id === fix.segmentId) {
            return {
              ...s,
              needsFix: true,
              fixComment: fix.comment
            };
          }
          return s;
        });
      }
    });

    // Make sure subtitles remain sorted by start time so chronological UI orders work perfectly
    updatedSubtitles.sort((a, b) => a.start - b.start);

    setProject({
      ...project,
      subtitles: updatedSubtitles,
      fixes: fixes
    });
    
    setShowFixImport(false);
    setFixImportText('');
  };

  const showWebcam = !!project?.audioSettings?.isBackstageEnabled;
  const [videoType, setVideoType] = useState<string | null>(null);
  const [showCalibration, setShowCalibration] = useState(false);
  const [teleprompterMode, setTeleprompterMode] = useState<'compact' | 'expanded'>('compact');
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [teleprompterPosition, setTeleprompterPosition] = useState({ x: 0, y: 0 });
  const [teleprompterSize, setTeleprompterSize] = useState({ width: 800, height: 200 });


  // Inject demo project for web preview immediately if not in desktop mode
  useEffect(() => {
    const check = () => {
      const isEl = !!(window as any).__TAURI_INTERNALS__;
      if (isEl !== isDesktop) setIsDesktop(isEl);
    };
    check();
    const interval = setInterval(check, 1000);
    
    // Inject demo project for web preview if not in desktop mode and no project loaded
    if (!project && !(window as any).__TAURI_INTERNALS__ && !isRecording) {
      setProject({
        id: 'demo-project',
        name: 'Демо Превью',
        projectPath: '/mock/path',
        videoUrl: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4',
        subtitles: [
          { id: 1, start: 0, end: 3, role: 'Character 1', text: 'This is a demo project', combined: 'This is a demo project' },
          { id: 2, start: 3, end: 7, role: 'Character 2', text: 'For AI Studio preview!', combined: 'For AI Studio preview!' }
        ],
        roles: ['Character 1', 'Character 2'],
        selectedRole: 'Character 1',
        tracks: [
          { id: 'original', name: 'Оригинал', segments: [], volume: 1, isMuted: false },
          { id: 'track-1', name: 'Dubs 1', segments: [
            {
               id: 'demo-seg',
               startTime: 1,
               duration: 6,
               fileOffset: 0,
               fileDuration: 6,
               blobUrl: '',
               filePath: '',
               gain: 1,
               playbackRate: 1,
               waveform: new Array(120).fill(0).map(() => Math.random() * 0.8 + 0.1),
               originalFileName: 'demo-dub.wav'
            }
          ], volume: 1, isMuted: false, isArmed: true }
        ],
        latencyOffset: 0,
        audioOffsetMs: 0,
        audioSettings: {
          deviceId: 'default',
          outputDeviceId: 'default',
          sampleRate: 48000,
          channels: 1,
          noiseSuppression: true,
          echoCancellation: true,
          backstageMode: 'parallel',
          isBackstageEnabled: false
        }
      });
      setDuration(10);
    }
    
    return () => clearInterval(interval);
  }, [isDesktop, project?.id, isRecording]);
  const [preRollCountdown, setPreRollCountdown] = useState<number | null>(null);
  const [sidebarScrollTop, setSidebarScrollTop] = useState(0);
  const [teleprompterFontSize, setTeleprompterFontSize] = useState(32);
  const [teleprompterLineHeight, setTeleprompterLineHeight] = useState(1.4);
  const [teleprompterPacing, setTeleprompterPacing] = useState<'auto' | 'manual'>('auto');

  useEffect(() => {
    if (project?.id && project.uiState) {
      if (project.uiState.zoomLevel !== undefined) setZoomLevel(project.uiState.zoomLevel);
      if (project.uiState.timelineHeight !== undefined) setTimelineHeight(project.uiState.timelineHeight);
      if (project.uiState.sidebarWidth !== undefined) setSidebarWidth(project.uiState.sidebarWidth);
      if (project.uiState.teleprompterMode !== undefined) setTeleprompterMode(project.uiState.teleprompterMode);
      if (project.uiState.teleprompterFontSize !== undefined) setTeleprompterFontSize(project.uiState.teleprompterFontSize);
      if (project.uiState.teleprompterLineHeight !== undefined) setTeleprompterLineHeight(project.uiState.teleprompterLineHeight);
      if (project.uiState.teleprompterPacing !== undefined) setTeleprompterPacing(project.uiState.teleprompterPacing);
      if (project.uiState.teleprompterPosition !== undefined) setTeleprompterPosition(project.uiState.teleprompterPosition);
      if (project.uiState.teleprompterSize !== undefined) setTeleprompterSize(project.uiState.teleprompterSize);
      if (project.uiState.showFixes !== undefined) setShowFixes(project.uiState.showFixes);
    }
  }, [project?.id]);

  const sidebarRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef<Project | null>(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    const unlisten = window.electronAPI.onMediaProgress((data) => {
      setExportProgress(data.percent);
      setExportOperation(data.operation || 'Processing...');
    });
    return () => unlisten();
  }, [setExportProgress, setExportOperation]);

  useEffect(() => {
    projectRef.current = project;
    // When switching projects, clear the buffer cache to save memory
    if (project?.id) {
       playbackEngine.clearCache();
    }
    if (project) {
      playbackEngine.setAudioOffset(project.audioOffsetMs || 0);
      playbackEngine.setPlayOriginalTrackSegments(!!project.audioSettings?.playOriginalTrackSegments);
    }
  }, [project?.id, project?.audioOffsetMs, project?.audioSettings?.playOriginalTrackSegments]);

  useEffect(() => {
    return () => {
      playbackEngine.stop();
      playbackEngine.clearCache();
    };
  }, []);

  // Hydrator for missing waveforms (e.g. loaded from DB)
  const extractingRefs = useRef<Set<string>>(new Set());
  const hydrationCycleRef = useRef<string | null>(null);
  const tracksHash = project?.tracks?.map(t => `${t.id}:${t.segments?.map(s => `${s.id}:${s.waveform?.length ? 1 : 0}:${s.filePath}`).join(',')}`).join('|') || '';
  
  // High-performance sequential loading queue for waveforms to prevent system choke and memory locks (lazy loading)
  const waveformQueueRef = useRef<{ filePath: string, segmentId: string, trackId: string, duration: number }[]>([]);
  const isProcessingQueueRef = useRef<boolean>(false);

  const processWaveformQueue = useCallback(() => {
    if (isProcessingQueueRef.current) {
      console.log("[WAVEFORM-QUEUE] Процесс уже запущен. Ожидание текущей задачи...");
      return;
    }
    if (waveformQueueRef.current.length === 0) {
      console.log("[WAVEFORM-QUEUE] Очередь пуста. Все волны успешно сгенерированы/отрисованы.");
      return;
    }

    isProcessingQueueRef.current = true;
    const task = waveformQueueRef.current.shift();
    if (!task) {
      console.log("[WAVEFORM-QUEUE] Задача отсутствует при декьюинге.");
      isProcessingQueueRef.current = false;
      return;
    }

    const { filePath, segmentId, trackId, duration } = task;
    console.log(`[WAVEFORM-QUEUE] Обработка новой задачи волновой формы:\n  Сегмент ID: ${segmentId}\n  Дорожка ID: ${trackId}\n  Файл: ${filePath}\n  Длительность: ${duration} сек`);
    
    // КРИТИЧЕСКИ ВАЖНО: Разрешаем путь перед отправкой в бэкенд
    const absPath = getAbsoluteFilePath(filePath, projectRef.current?.projectPath);
    console.log(`[WAVEFORM-QUEUE] Абсолютный путь файла разрешен: ${absPath}`);
    
    const pointsCount = Math.max(1024, Math.min(16000, Math.round((duration || 10) * 45)));
    console.log(`[WAVEFORM-QUEUE] Запрос на генерацию пиков: количество точек = ${pointsCount}...`);

    window.electronAPI.generateWaveformPeaks({ filePath: absPath, points: pointsCount })
      .then(res => {
        extractingRefs.current.delete(segmentId);
        if (res.success && res.data) {
          const peakCount = (res.data as any).length;
          console.log(`[WAVEFORM-QUEUE] Пики успешно сгенерированы! Сегмент: ${segmentId}. Количество точек: ${peakCount}`);
          setProject(p => {
            if (!p) return p;
            return {
              ...p,
              tracks: p.tracks.map(t => t.id === trackId ? {
                ...t,
                segments: t.segments.map(s => s.id === segmentId ? { 
                  ...s, 
                  waveform: Array.from(res.data as any), 
                  isExtractingWaveform: false 
                } : s)
              } : t)
            };
          });
        } else {
          console.warn(`[WAVEFORM-QUEUE] Бэкенд вернул неуспешный статус для файла: ${filePath}. Пики не сгенерированы.`);
          setProject(p => p ? {
            ...p,
            tracks: p.tracks.map(t => t.id === trackId ? {
              ...t,
              segments: t.segments.map(s => s.id === segmentId ? { ...s, isExtractingWaveform: false } : s)
            } : t)
          } : p);
        }
      })
      .catch(err => {
        extractingRefs.current.delete(segmentId);
        console.error(`[WAVEFORM-QUEUE] Ошибка генерации волновой формы для сегмента ${segmentId}:`, err);
        setProject(p => p ? {
          ...p,
          tracks: p.tracks.map(t => t.id === trackId ? {
            ...t,
            segments: t.segments.map(s => s.id === segmentId ? { ...s, isExtractingWaveform: false } : s)
          } : t)
        } : p);
      })
      .finally(() => {
        isProcessingQueueRef.current = false;
        const remaining = waveformQueueRef.current.length;
        console.log(`[WAVEFORM-QUEUE] Задача завершена. Осталось задач в очереди: ${remaining}. Следующий запуск через 120ms...`);
        // Small timeout to let UI updates settle and remain buttery smooth
        setTimeout(() => {
          processWaveformQueue();
        }, 120);
      });
  }, []);

  useEffect(() => {
    if (!project || !window.electronAPI) return;

    // Use a cycle indicator to prevent re-running in the same render context if we just setProject
    const currentCycleKey = `${project.id}:${tracksHash}`;
    if (hydrationCycleRef.current === currentCycleKey) {
      return;
    }

    console.log(`[WAVEFORM-HYDRATOR] Запущен цикл проверки волновых форм (Проект ID: ${project.id})`);
    let needsUpdate = false;
    const tracksToUpdate = [...project.tracks];

    // 1. Check Original Track
    const origTrackIdx = tracksToUpdate.findIndex(t => t.name === 'Оригинал' || t.name === 'Original');
    if (origTrackIdx !== -1 && project.originalPeaks && project.originalPeaks.length > 0) {
      const track = tracksToUpdate[origTrackIdx];
      if (track.segments && track.segments.length > 0) {
        const seg = track.segments[0];
        if (!seg.waveform || seg.waveform.length === 0) {
          console.log("[WAVEFORM-HYDRATOR] Восстановление волновой формы оригинального трека из project.originalPeaks...");
          const newSegments = [...track.segments];
          newSegments[0] = { ...seg, waveform: Array.from(project.originalPeaks) };
          tracksToUpdate[origTrackIdx] = { ...track, segments: newSegments };
          needsUpdate = true;
        }
      }
    }

    // 2. Check Dub Tracks
    let dubStarted = false;
    const queuedTasks: typeof waveformQueueRef.current = [];

    for (let trackIndex = 0; trackIndex < tracksToUpdate.length; trackIndex++) {
        const track = tracksToUpdate[trackIndex];
        // Skip original track if we already handled it or if it's named Original/Оригинал
        if (track.name === 'Оригинал' || track.name === 'Original') continue;
        if (!track.segments) continue;

        let trackUpdated = false;
        const newSegments = [...track.segments];

        for (let i = 0; i < newSegments.length; i++) {
            const seg = newSegments[i];
            if (seg.filePath && (!seg.waveform || seg.waveform.length === 0) && !seg.isExtractingWaveform && !extractingRefs.current.has(seg.id)) {
                console.log(`[WAVEFORM-HYDRATOR] Обнаружен сегмент без волновой формы. Добавление в очередь: ID=${seg.id}, Файл=${seg.filePath}`);
                extractingRefs.current.add(seg.id);
                newSegments[i] = { ...seg, isExtractingWaveform: true };
                trackUpdated = true;
                dubStarted = true;
                
                queuedTasks.push({
                  filePath: seg.filePath,
                  segmentId: seg.id,
                  trackId: track.id,
                  duration: seg.duration || 10
                });
            }
        }
        if (trackUpdated) {
            tracksToUpdate[trackIndex] = { ...track, segments: newSegments };
        }
    }

    if (queuedTasks.length > 0) {
      console.log(`[WAVEFORM-HYDRATOR] Добавлено новых задач в очередь генерации: ${queuedTasks.length}`);
      waveformQueueRef.current.push(...queuedTasks);
    }

    if (needsUpdate || dubStarted) {
        hydrationCycleRef.current = currentCycleKey;
        setProject(p => p ? { ...p, tracks: tracksToUpdate } : p);
        if (queuedTasks.length > 0) {
          processWaveformQueue();
        }
    }
  }, [project?.id, tracksHash, processWaveformQueue]);

  const createDefaultProject = useCallback((name: string, path?: string): Project => ({
    id: Math.random().toString(36).substr(2, 9),
    name,
    projectPath: path,
    subtitles: [],
    roles: [],
    tracks: [
      { id: 'track-1', name: 'Дорога 1', segments: [], volume: 1, isMuted: false }
    ],
    latencyOffset: 0,
    audioOffsetMs: 0,
    audioSettings: getGlobalAudioSettings()
  }), []);

  // Consolidated Auto-save effect
  useEffect(() => {
    if (!project || !project.projectPath || !window.electronAPI) return;

    if (project.audioSettings) {
      localStorage.setItem('dubstudio_global_audio_settings', JSON.stringify(project.audioSettings));
    }

    // Debounce auto-save to disk/db to avoid high frequency I/O (e.g. during dragging)
    const saveTimer = setTimeout(() => {
      if (window.electronAPI && project.projectPath) {
        window.electronAPI.saveProjectJson({
          projectPath: project.projectPath,
          projectData: project
        })
        .then(res => {
          if (res.success) {
            console.log("[AutoSave] Project saved successfully");
          }
        })
        .catch(err => console.error("[AutoSave] Error:", err));
      }
    }, 2000); // 2s delay for stability

    return () => clearTimeout(saveTimer);
  }, [project]);

  const handleNativeDrop = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      const fileName = path.split(/[/\\]/).pop() || 'file';
      const fileExt = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
      const fileDir = path.replace(/\\/g, '/').substring(0, path.replace(/\\/g, '/').lastIndexOf('/'));

      if (['.mp4', '.mkv', '.webm', '.mov', '.avi', '.mp3', '.wav', '.flac', '.ogg', '.m4a'].includes(fileExt)) {
        // Handle video or standalone audio
        let projectRoot = project?.projectPath;
        if (!projectRoot) {
           // Create a new project folder next to the video
           const baseName = fileName.replace(/\.[^/.]+$/, "");
           projectRoot = `${fileDir}/${baseName}_Project`.replace(/\\/g, '/');
        }

        if (window.electronAPI) {
          try {
            await window.electronAPI.initProject(projectRoot);
            
            // Copy to assets
            const assetsDir = `${projectRoot}/assets`.replace(/\\/g, '/');
            const copyRes = await window.electronAPI.copyFileToProject(path, assetsDir);
            const finalPath = copyRes.success && copyRes.data ? copyRes.data : path;

            setProject(prev => {
              const baseProject = prev || createDefaultProject(fileName.replace(/\.[^/.]+$/, ""), projectRoot);
              return { ...baseProject, videoUrl: getSafeFileUrl(finalPath), videoPath: finalPath, projectPath: projectRoot };
            });

            const takesDir = `${projectRoot}/takes`.replace(/\\/g, '/');
            const res = await window.electronAPI.extractAudioPeaks(finalPath, takesDir);
            if (res.success && res.data) {
                const audioData = res.data;
                const refPath = audioData.filePath || `${takesDir}/original_audio.wav`.replace(/\\/g, '/');
                
                setProject(p => {
                  if (!p) return p;
                  let updatedTracks = [...p.tracks];
                  if (!updatedTracks.find(t => t.name === 'Оригинал')) {
                    updatedTracks.unshift({
                      id: 'originals-track',
                      name: 'Оригинал',
                      volume: 1,
                      isMuted: false,
                      segments: []
                    });
                  }
                  const audioDuration = audioData.duration || (audioData.peaks.length / 50.0);
                  const extractedPeaks = Array.from(audioData.peaks);
                  
                  // LOG for debugging transcoding duration mismatch
                  console.log(`[Import] Project hydrator: Video path: ${finalPath}, Duration: ${audioDuration}s`);

                  return { 
                    ...p, 
                    originalPeaks: extractedPeaks,
                    audioOffsetMs: p.audioOffsetMs || 0, // Reset default to 0 for cleaner calibration
                    referenceAudioPath: refPath,
                    tracks: updatedTracks.map(t => {
                      if (t.name === 'Оригинал') {
                        return {
                          ...t,
                          segments: [{
                            id: 'original-audio-seg',
                            startTime: 0,
                            duration: audioDuration,
                            fileOffset: 0,
                            fileDuration: audioDuration,
                            blobUrl: getSafeFileUrl(refPath),
                            filePath: refPath,
                            gain: 1,
                            playbackRate: 1,
                            waveform: extractedPeaks
                          }]
                        };
                      }
                      return t;
                    })
                  };
                });
            }
          } catch (err) {
            console.error("Native drop video peaks error:", err);
          }
        }
      } else if (['.srt', '.ass', '.vtt', '.csv', '.fb2', '.txt', '.epub', '.docx', '.pdf'].includes(fileExt)) {
        // Handle subtitles
        if (window.electronAPI) {
            let contentToParse: string | ArrayBuffer;
            if (fileExt === '.epub' || fileExt === '.docx' || fileExt === '.pdf') {
                try {
                    // Try to read binary as we did in openSubtitles via fetch/Tauri
                    const arr = await (window as any).__TAURI_INVOKE__?.('read_binary_file', { path: path });
                    if (arr) {
                        contentToParse = new Uint8Array(arr).buffer;
                    } else {
                        // Fallback
                        const res = await window.electronAPI.readTextFile(path);
                        contentToParse = res.data || '';
                    }
                } catch (e) {
                    const res = await window.electronAPI.readTextFile(path);
                    contentToParse = res.data || '';
                }
            } else {
                const res = await window.electronAPI.readTextFile(path);
                contentToParse = res.data || '';
            }
            
            if (contentToParse) {
                const content = contentToParse;
                const subtitles = await UniversalParserService.parse(content, fileName);
                const roles = Array.from(new Set(subtitles.map(s => s.role)));
                
                setProject(p => {
                  const base = p || createDefaultProject(fileName.split('.')[0]);
                  return {
                    ...base,
                    subtitles,
                    roles,
                    selectedRole: roles[0] || 'Default'
                  };
                });
            }
        }
      }
    }
  }, [setProject, createDefaultProject]);

  useEffect(() => {
    logger.info("Application mounted. Desktop API available:", !!window.electronAPI);
    
    // Add DevTools shortcut
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Shift+I or F12
      if ((e.ctrlKey && e.shiftKey && e.code === 'KeyI') || e.code === 'F12') {
        if (window.electronAPI) {
          import('@tauri-apps/api/core').then(mod => {
             mod.invoke('open_devtools').catch(console.error);
          }).catch(console.error);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    // Listen for Tauri native file drop events to get full paths
    let unlisten: any;
    let isCancelled = false;
    if (isDesktop && window.electronAPI) {
      const setupDrop = async () => {
        try {
          const u = await getCurrentWindow().onDragDropEvent((event) => {
            if (isCancelled) return;
            if (event.payload.type === 'drop') {
              const paths = event.payload.paths;
              if (paths && paths.length > 0) {
                logger.info("Native drop detected:", paths);
                handleNativeDrop(paths);
              }
            }
          });
          if (isCancelled) {
            if (typeof u === 'function') u();
          } else {
            unlisten = u;
          }
        } catch (e) {
          logger.warn("Failed to listen for native drop events:", e);
        }
      };
      setupDrop();
    }

    return () => {
      isCancelled = true;
      logger.info("Application unmounting.");
      window.removeEventListener('keydown', handleKeyDown);
      if (typeof unlisten === 'function') unlisten();
      playbackEngine.stop();
    };
  }, [handleNativeDrop, isDesktop]);


  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    IOLogger.log('BRIDGE', 'onDrop', 'START', { count: acceptedFiles.length, names: acceptedFiles.map(f => f.name) });
    const isProjectActive = !!project?.videoUrl || !!project?.projectPath;
    
    const mediaFiles = acceptedFiles.filter(f => f.type.startsWith('video/') || f.type.startsWith('audio/') || ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.mp3', '.wav', '.flac', '.ogg', '.m4a'].some(ext => f.name.toLowerCase().endsWith(ext)));
    const textFiles = acceptedFiles.filter(f => ['.ass', '.srt', '.vtt', '.csv', '.fb2', '.txt', '.epub', '.docx', '.pdf'].some(ext => f.name.toLowerCase().endsWith(ext)));

    if (isProjectActive && mediaFiles.length > 0 && window.electronAPI && project.projectPath) {
      // Add drops as a new track
      const newTrackId = `track-drop-${Date.now()}`;
      const newTrackName = mediaFiles[0].name.replace(/\.[^/.]+$/, "");
      
      let currentStartTime = currentTimeRef.current;
      const newSegments: AudioSegment[] = [];
      
      for (const file of mediaFiles) {
        const filePath = (file as any).path || file.name;
        if (filePath) addToWebFileCache(filePath, file);
        
        const assetsDir = `${project.projectPath}/assets`.replace(/\\/g, '/');
        const copyRes = await window.electronAPI.copyFileToProject(filePath, assetsDir);
        const finalPath = copyRes.success && copyRes.data ? copyRes.data : filePath;
        
        let duration = 0;
        let peaks: number[] = [];
        
        const infoRes = await window.electronAPI.getFileInfo(finalPath);
        if (infoRes.success && infoRes.data) {
           duration = infoRes.data.duration || 0;
        }
        
        const pointsCount = Math.max(1024, Math.min(16000, Math.round((duration || 10) * 45)));
        const peaksRes = await window.electronAPI.generateWaveformPeaks({ filePath: finalPath, points: pointsCount });
        if (peaksRes.success && peaksRes.data) {
           peaks = peaksRes.data;
        }
        
        if (duration === 0 && peaks.length > 0) {
           duration = peaks.length / 50.0;
        } else if (duration === 0) {
           duration = 1;
        }

        newSegments.push({
           id: `drop-${Date.now()}-${Math.random().toString(36).substr(2,9)}`,
           startTime: currentStartTime,
           duration: duration,
           fileOffset: 0,
           fileDuration: duration,
           blobUrl: getSafeFileUrl(finalPath),
           filePath: finalPath,
           gain: 1,
           playbackRate: 1,
           waveform: peaks,
           originalFileName: file.name
        });
        
        currentStartTime += duration;
      }
      
      setProject(prev => {
        if (!prev) return prev;
        return {
           ...prev,
           tracks: [
              ...prev.tracks,
              {
                 id: newTrackId,
                 name: newTrackName,
                 volume: 1,
                 isMuted: false,
                 segments: newSegments
              }
           ]
        };
      });
    } else {
      // Logic for new project initialization
      for (const file of mediaFiles) {
        const filePath = (file as any).path || file.name;
        if (filePath) addToWebFileCache(filePath, file);
        
        const fileDir = filePath && filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : undefined;

        setVideoType(file.type);
        const url = URL.createObjectURL(file);
        
        let projectRoot = project?.projectPath;
        if (!projectRoot && fileDir) {
           const baseName = file.name.replace(/\.[^/.]+$/, "");
           projectRoot = `${fileDir}/${baseName}_Project`.replace(/\\/g, '/');
        }

        const isVideo = file.type.startsWith('video/') || ['.mp4', '.mkv', '.webm', '.mov', '.avi'].some(ext => file.name.toLowerCase().endsWith(ext));
        setProject(prev => {
          const baseProject = prev || createDefaultProject(file.name.replace(/\.[^/.]+$/, ""), projectRoot);
          return { 
            ...baseProject, 
            videoUrl: url, 
            videoPath: filePath, 
            projectPath: projectRoot,
            audioSettings: {
              ...(baseProject.audioSettings || getGlobalAudioSettings()),
              playOriginalTrackSegments: !isVideo
            }
          };
        });
        
        if (window.electronAPI && filePath && projectRoot) {
            window.electronAPI.initProject(projectRoot).then(async () => {
              const assetsDir = `${projectRoot}/assets`.replace(/\\/g, '/');
              const copyRes = await window.electronAPI.copyFileToProject(filePath, assetsDir);
              const finalPath = copyRes.success && copyRes.data ? copyRes.data : filePath;

              const takesDir = `${projectRoot}/takes`.replace(/\\/g, '/');
              window.electronAPI.extractAudioPeaks(finalPath, takesDir).then(res => {
                if (res.success && res.data) {
                  const audioData = res.data;
                  const refPath = audioData.filePath || `${takesDir}/original_audio.wav`.replace(/\\/g, '/');
                  const extractedPeaks = Array.from(audioData.peaks);
                  const audioDuration = audioData.duration || (extractedPeaks.length / 50.0);

                  setProject(p => {
                    if (!p) return p;
                    let updatedTracks = [...p.tracks];
                    if (!updatedTracks.find(t => t.name === 'Оригинал')) {
                      updatedTracks.unshift({
                        id: 'originals-track',
                        name: 'Оригинал',
                        volume: 1,
                        isMuted: false,
                        segments: []
                      });
                    }
                  return { 
                    ...p, 
                    videoPath: finalPath,
                    videoUrl: getSafeFileUrl(finalPath),
                    audioOffsetMs: p.audioOffsetMs || 0,
                    originalPeaks: extractedPeaks,
                    referenceAudioPath: refPath,
                    audioSettings: {
                      ...(p.audioSettings || getGlobalAudioSettings()),
                      playOriginalTrackSegments: !isVideo
                    },
                    tracks: updatedTracks.map(t => {
                      if (t.name === 'Оригинал') {
                        return {
                          ...t,
                          segments: [{
                            id: 'original-audio-seg',
                            startTime: 0,
                            duration: audioDuration,
                            fileOffset: 0,
                            fileDuration: audioDuration,
                            blobUrl: getSafeFileUrl(refPath),
                            filePath: refPath,
                            gain: 1,
                            playbackRate: 1,
                            waveform: extractedPeaks
                          }]
                        };
                      }
                      return t;
                    })
                  };
                  });
                }
              }).catch(err => console.error("Drop video peaks error:", err));
            });
        } else if (!window.electronAPI) {
          WaveformService.generatePeaks(file, 20000)
            .then(peaks => {
              setProject(p => p ? { ...p, originalPeaks: peaks } : p);
            })
            .catch(err => {
              console.warn("Could not generate peaks locally inside browser:", err);
            });
        }
      }
    }

    for (const file of textFiles) {
      const fileDir = (file as any).path ? (file as any).path.replace(/\\/g, '/').substring(0, (file as any).path.replace(/\\/g, '/').lastIndexOf('/')) : undefined;
      let content: string | ArrayBuffer;
      if (file.name.toLowerCase().endsWith('.epub') || file.name.toLowerCase().endsWith('.docx') || file.name.toLowerCase().endsWith('.pdf')) {
          content = await file.arrayBuffer();
      } else {
          content = await file.text();
      }
      
      const subtitles = await UniversalParserService.parse(content, file.name);
      const roles = Array.from(new Set(subtitles.map(s => s.role)));
      
      setProject(prev => {
        const baseProject = prev || createDefaultProject(file.name.replace(/\.[^/.]+$/, ""), fileDir);
        return {
          ...baseProject,
          subtitles,
          roles,
          selectedRole: roles[0] || 'Default'
        };
      });
    }
  }, [project, currentTimeRef.current]);

  const { getRootProps, getInputProps, isDragActive: dropzoneActive } = useDropzone({ 
    onDrop,
    noClick: true,
    accept: {
      'video/*': ['.mp4', '.webm', '.mkv', '.mov', '.avi'],
      'audio/*': ['.mp3', '.wav', '.flac', '.ogg', '.m4a'],
      'text/plain': ['.txt', '.csv', '.vtt'],
      'application/x-subrip': ['.srt'],
      'application/octet-stream': ['.ass', '.srt', '.fb2']
    }
  } as any);

  useEffect(() => {
    if (isDesktop && (window as any).electronAPI) {
      (window as any).electronAPI.requestPermissions().catch(err => {
        console.error('Failed to request media permissions:', err);
      });
    }
  }, [isDesktop]);

  // --- App Startup Check ---
  useEffect(() => {
    if (isDesktop && window.electronAPI) {
      window.electronAPI.checkCrashes().then(async (res) => {
        if (res.success && res.data && res.data.length > 0) {
          logger.info(`Found ${res.data.length} interrupted recordings. Attempting recovery...`);
          
          for (const recoveryInfo of res.data) {
            if (await safeConfirm(`Была обнаружена прерванная запись (${recoveryInfo.file_path}).\nВосстановить этот фрагмент на таймлайне?`)) {
              // Extract peaks for the recovered file
              const peaksRes = await window.electronAPI.generateWaveformPeaks({ 
                filePath: recoveryInfo.file_path, 
                points: 4000 
              });
              
              const recoveredSegment: AudioSegment = {
                id: recoveryInfo.segment_id || Math.random().toString(36).substr(2, 9),
                startTime: recoveryInfo.start_time,
                duration: 0, // Will be updated if we can get duration
                fileOffset: 0,
                fileDuration: 0,
                filePath: recoveryInfo.file_path,
                blobUrl: `asset://${recoveryInfo.file_path}`,
                waveform: peaksRes.success ? (peaksRes.data as any) : [],
                gain: 1,
                playbackRate: 1
              };

              // Try to get duration
              if (window.electronAPI.getFileInfo) {
                const info = await window.electronAPI.getFileInfo(recoveryInfo.file_path);
                if (info.success && info.data) {
                  recoveredSegment.duration = info.data.duration;
                  recoveredSegment.fileDuration = info.data.duration;
                }
              }

              setProject(prev => {
                if (!prev) return null;
                const updatedTracks = prev.tracks.map(track => {
                  if (track.id === recoveryInfo.track_id || track.name === 'Dubs') {
                    return { ...track, segments: [...track.segments, recoveredSegment] };
                  }
                  return track;
                });
                return { ...prev, tracks: updatedTracks };
              });
            }
          }
        }
      }).catch(err => logger.error("Crash check failed:", err));
    }
  }, [setProject]);

  // --- Electron Handlers ---

  const handleSelectSubs = async () => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.openSubtitles();
    if (!res.success || !res.data) return;
    const subsData = res.data;
    
    let finalProjectRoot = project?.projectPath;
    if (!finalProjectRoot && subsData.path) {
      const isWin = subsData.path.includes('\\');
      const sep = isWin ? '\\' : '/';
      const lastSepIndex = subsData.path.lastIndexOf(sep);
      const fileDir = lastSepIndex !== -1 ? subsData.path.substring(0, lastSepIndex) : '';
      const nameWithoutExt = subsData.name.replace(/\.[^/.]+$/, "");
      finalProjectRoot = fileDir ? `${fileDir}${sep}${nameWithoutExt}_Project` : `${nameWithoutExt}_Project`;
      await window.electronAPI.initProject(finalProjectRoot);
    }

    setProject(prev => {
      const currentProject = prev || createDefaultProject(subsData.name.replace(/\.[^/.]+$/, ""), finalProjectRoot || "");
      return {
        ...currentProject,
        subtitles: subsData.parsed.subtitles,
        roles: subsData.parsed.roles,
        selectedRole: subsData.parsed.roles[0] || 'Default'
      };
    });
  };

  const handleSelectDocument = async () => {
    if (!window.electronAPI) return;
    const bridgeResponse = await window.electronAPI.openFile({
      title: 'Select Document',
      filters: [{ name: 'Documents', extensions: ['txt'] }]
    });
    if (!bridgeResponse.success || !bridgeResponse.data) return;
    const fileData = bridgeResponse.data;
    
    let finalProjectRoot = project?.projectPath;
    if (!finalProjectRoot && fileData.path) {
      const isWin = fileData.path.includes('\\');
      const sep = isWin ? '\\' : '/';
      const lastSepIndex = fileData.path.lastIndexOf(sep);
      const fileDir = lastSepIndex !== -1 ? fileData.path.substring(0, lastSepIndex) : '';
      const nameWithoutExt = fileData.name.replace(/\.[^/.]+$/, "");
      finalProjectRoot = fileDir ? `${fileDir}${sep}${nameWithoutExt}_Project` : `${nameWithoutExt}_Project`;
      await window.electronAPI.initProject(finalProjectRoot);
    }

    setProject(prev => {
      const currentProject = prev || createDefaultProject(fileData.name.replace(/\.[^/.]+$/, ""), finalProjectRoot || "");
      
      let updatedSubtitles = currentProject.subtitles;
      let updatedRoles = currentProject.roles;
      let selectedRole = currentProject.selectedRole;

      if (fileData.content) {
        const parsedSubtitles = TextImportService.parseRawText(fileData.content);
        if (parsedSubtitles.length > 0) {
          updatedSubtitles = parsedSubtitles;
          updatedRoles = Array.from(new Set(parsedSubtitles.map(s => s.role)));
          selectedRole = updatedRoles[0] || 'Default';
        }
      }

      return {
        ...currentProject,
        documentPath: fileData.path,
        documentContent: fileData.content,
        subtitles: updatedSubtitles,
        roles: updatedRoles,
        selectedRole: selectedRole
      };
    });
  };

  const handleMergeBackstage = async () => {
    if (!project || !project.projectPath || !window.electronAPI) return;

    // Collect all unique backstage video paths from all segments
    const videoPaths: string[] = [];
    project.tracks.forEach(track => {
      track.segments.forEach(seg => {
        if (seg.backstageVideoPath) {
          const absPath = getAbsoluteFilePath(seg.backstageVideoPath, project.projectPath);
          if (absPath && !videoPaths.includes(absPath)) {
            videoPaths.push(absPath);
          }
        }
      });
    });

    if (videoPaths.length === 0) {
      alert("Нет записанных бекстейдж-видео для объединения.");
      return;
    }

    const saveRes = await window.electronAPI.saveFile({
      title: 'Сохранить финальный бекстейдж',
      defaultPath: `${project.projectPath}/final_backstage.mp4`,
      filters: [{ name: 'Video', extensions: ['mp4'] }]
    });

    if (!saveRes.success || !saveRes.data) return;
    const finalOutputPath = saveRes.data;

    setIsExporting(true);
    setExportProgress(0);
    setExportOperation("Preparing backstage video...");
    
    try {
      logger.info(`Starting backstage merge for ${videoPaths.length} videos to ${finalOutputPath}`);
      
      const tempVideoPath = `${project.projectPath}/temp_backstage_concat.mp4`;
      const tempAudioPath = `${project.projectPath}/temp_backstage_audio.wav`;

      // 1. Concat all backstage videos
      setExportOperation("Concatenating backstage video...");
      logger.info(`Concatenating backstage videos to ${tempVideoPath}`);
      const concatRes = await window.electronAPI.concatBackstageVideos({
        videoPaths,
        outputPath: tempVideoPath,
        backstageMode: project.audioSettings?.backstageMode,
        isBackstageEnabled: project.audioSettings?.isBackstageEnabled
      });

      if (!concatRes.success) {
        throw new Error(`Ошибка при объединении видео: ${concatRes.error}`);
      }

      // 2. Export project audio (Original + Dubs)
      setExportOperation("Mixing project audio for backstage...");
      logger.info(`Mixing project audio for backstage to ${tempAudioPath}`);
      const audioRes = await window.electronAPI.exportAudio({
        projectJson: JSON.stringify({
          projectPath: project.projectPath,
          tracks: project.tracks.map(t => ({
            name: t.name,
            isMuted: t.isMuted,
            isSolo: t.isSolo,
            volume: t.volume,
            segments: t.segments.map(s => ({
              ...s,
              filePath: getAbsoluteFilePath(s.filePath, project.projectPath)
            }))
          })),
          audioOffsetMs: project.audioOffsetMs || 0
        }),
        outputPath: tempAudioPath,
        format: 'wav'
      });

      if (!audioRes.success) {
        throw new Error(`Ошибка при экспорте аудио: ${audioRes.error}`);
      }

      // 3. Mux video from (1) and audio from (2)
      if (project.videoPath && project.audioSettings?.webcamExportOverlay !== false) {
        setExportOperation("Applying backstage overlay on main video...");
        const absVideoPath = getAbsoluteFilePath(project.videoPath, project.projectPath);
        logger.info(`Applying backstage overlay onto ${absVideoPath} to ${finalOutputPath}`);
        const overlayRes = await window.electronAPI.exportBackstageVideo({
          mainVideoPath: absVideoPath,
          backstageVideoPath: tempVideoPath,
          finalAudioPath: tempAudioPath,
          outputPath: finalOutputPath,
          webcamExportOverlay: project.audioSettings?.webcamExportOverlay
        });
        
        if (overlayRes.success) {
          alert(`Бекстейдж успешно создан с проектным звуком: ${finalOutputPath}`);
          logger.info("Backstage merge successful.");
        } else {
          alert(`Ошибка при финальном сведении: ${overlayRes.error}`);
          logger.error("Backstage overlay failed:", overlayRes.error);
        }
      } else {
        setExportOperation("Muxing video with project audio...");
        logger.info(`Muxing joined video with audio to ${finalOutputPath}`);
        const muxRes = await window.electronAPI.muxVideo({
          videoPath: tempVideoPath,
          audioPath: tempAudioPath,
          outputPath: finalOutputPath
        });

        if (muxRes.success) {
          alert(`Бекстейдж успешно создан с проектным звуком: ${finalOutputPath}`);
          logger.info("Backstage merge successful.");
        } else {
          alert(`Ошибка при финальном сведении: ${muxRes.error}`);
          logger.error("Backstage mux failed:", muxRes.error);
        }
      }
    } catch (err) {
      alert(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
      logger.error("Backstage merge operation failed:", err);
    } finally {
      setIsExporting(false);
      setExportProgress(100);
      setExportOperation("");
    }
  };

  const handleSelectReferenceAudio = async () => {
    if (!window.electronAPI) return;
    const fileDataRes = await window.electronAPI.openFile({
      title: 'Select Reference Audio',
      filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }]
    });
    if (!fileDataRes.success || !fileDataRes.data) return;
    const fileData = fileDataRes.data;
    
    let finalProjectRoot = project?.projectPath;
    if (!finalProjectRoot && fileData.path) {
      const isWin = fileData.path.includes('\\');
      const sep = isWin ? '\\' : '/';
      const lastSepIndex = fileData.path.lastIndexOf(sep);
      const fileDir = lastSepIndex !== -1 ? fileData.path.substring(0, lastSepIndex) : '';
      const nameWithoutExt = fileData.name.replace(/\.[^/.]+$/, "");
      finalProjectRoot = fileDir ? `${fileDir}${sep}${nameWithoutExt}_Project` : `${nameWithoutExt}_Project`;
      await window.electronAPI.initProject(finalProjectRoot);
    }
    
    const currentProject = project || createDefaultProject(fileData.name.replace(/\.[^/.]+$/, ""), finalProjectRoot || "");
    
    setProject({
      ...currentProject,
      referenceAudioPath: fileData.path,
      audioSettings: {
        ...(currentProject.audioSettings || getGlobalAudioSettings()),
        playOriginalTrackSegments: true
      }
    });
  };

  const handleBulkImport = async () => {
    if (!window.electronAPI) return;
    const folderPathRes = await window.electronAPI.openFolder();
    if (!folderPathRes.success || !folderPathRes.data) return;
    const folderPath = folderPathRes.data;

    try {
      const { tracks, duration, subtitles } = await BulkImportService.importFolder(folderPath);
      setProject(prev => {
        const baseProject = prev || {
          id: Math.random().toString(36).substr(2, 9),
          name: "Bulk Import Project",
          latencyOffset: 0,
          audioOffsetMs: 0,
          tracks: [],
          subtitles: [],
          roles: [],
          audioSettings: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            bitDepth: 24,
            noiseGateThreshold: -40,
            compressorThreshold: -20,
            compressorRatio: 4,
            highPassFrequency: 80,
            isDestructive: false,
            backstageMode: 'parallel',
            playOriginalTrackSegments: true
          }
        } as Project;

        return {
          ...baseProject,
          tracks: [...(baseProject.tracks || []), ...tracks],
          subtitles: [...(baseProject.subtitles || []), ...subtitles],
          roles: Array.from(new Set([...(baseProject.roles || []), "Original", "Dub"])),
          selectedRole: "Dub",
          projectPath: folderPath, // Use folder as project path for now
          audioSettings: {
            ...(baseProject.audioSettings || getGlobalAudioSettings()),
            playOriginalTrackSegments: true
          }
        };
      });
      setDuration(duration);
    } catch (error) {
      console.error("Bulk import failed:", error);
      alert("Bulk import failed. See console for details.");
    }
  };

  const handleGameDubbingImport = async () => {
    if (!window.electronAPI) return;
    
    // 1. Choose folder of WAV files
    const folderPathRes = await window.electronAPI.openFolder();
    if (!folderPathRes.success || !folderPathRes.data) return;
    const folderPath = folderPathRes.data;

    // 2. Choose text document
    const fileRes = await window.electronAPI.openFile({
      title: 'Выберите текстовый файл перевода',
      filters: [{ name: 'Text', extensions: ['txt'] }]
    });
    if (!fileRes.success || !fileRes.data) return;
    const fileData = fileRes.data;
    if (!fileData.content) {
      alert("Выбранный файл перевода пуст.");
      return;
    }

    try {
      const { tracks, duration, subtitles } = await BulkImportService.importGameDubbing(folderPath, fileData.content);
      
      // Auto-generate a blank master video of the exact project duration to neutralize non-video playback limits
      const blankVideoName = "blank_master_video.mp4";
      const blankVideoPath = `${folderPath}/${blankVideoName}`.replace(/\\/g, '/');
      
      try {
        const videoRes = await window.electronAPI.createBlankVideo(duration, blankVideoPath);
        if (!videoRes.success) {
          console.warn("Failed to create blank video file:", videoRes.error);
        }
      } catch (err) {
        console.warn("Error creating blank video file:", err);
      }

      setProject(prev => {
        const baseProject = prev || {
          id: Math.random().toString(36).substr(2, 9),
          name: "Game Dubbing Project",
          latencyOffset: 0,
          audioOffsetMs: 0,
          tracks: [],
          subtitles: [],
          roles: [],
          audioSettings: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            bitDepth: 24,
            noiseGateThreshold: -40,
            compressorThreshold: -20,
            compressorRatio: 4,
            highPassFrequency: 80,
            isDestructive: false,
            backstageMode: 'parallel',
            playOriginalTrackSegments: true
          }
        } as Project;

        return {
          ...baseProject,
          tracks: [...(baseProject.tracks || []), ...tracks],
          subtitles: [...(baseProject.subtitles || []), ...subtitles],
          roles: Array.from(new Set([...(baseProject.roles || []), "Original", "Dub"])),
          selectedRole: "Dub",
          projectPath: folderPath,
          videoPath: blankVideoName,
          videoUrl: undefined,
          audioSettings: {
            ...(baseProject.audioSettings || getGlobalAudioSettings()),
            playOriginalTrackSegments: true
          }
        };
      });
      setDuration(duration);
      alert("Проект игровой озвучки успешно импортирован с автогенерацией пустого видеофайла!");
    } catch (error) {
      console.error("Game dubbing import failed:", error);
      alert("Ошибка при импорте игровой озвучки: " + (error instanceof Error ? error.message : String(error)));
    }
  };

  const handleBatchExport = async () => {
    if (!project || !project.projectPath || !window.electronAPI) return;

    // 1. Identify original reference track
    const origTrack = project.tracks.find(t => t.name === 'Оригинал' || t.name === 'Original');
    if (!origTrack) {
      alert("Не найден оригинальный трек ('Оригинал') для определения временных интервалов и имен игровых реплик.");
      return;
    }

    // Accidental split mitigation: group segments on the reference track by duplicate `originalFileName`.
    const origGroupedMap = new Map<string, typeof origTrack.segments>();
    for (const s of origTrack.segments) {
      if (s.originalFileName) {
        let list = origGroupedMap.get(s.originalFileName);
        if (!list) {
          list = [];
          origGroupedMap.set(s.originalFileName, list);
        }
        list.push(s);
      }
    }

    const origSegments = [];
    for (const [fileName, segs] of origGroupedMap.entries()) {
      // Sort segments of this original file chronologically just in case
      segs.sort((a, b) => a.startTime - b.startTime);

      const minStartTime = Math.min(...segs.map(s => s.startTime));
      const maxEndTime = Math.max(...segs.map(s => s.startTime + s.duration));
      
      const spanDuration = maxEndTime - minStartTime;

      // Extract original file duration from the properties of the imported segment pieces
      const fileDuration = segs.find(s => s.fileDuration !== undefined && s.fileDuration > 0)?.fileDuration || 0;

      // Search matching subtitle line duration
      const matchingSub = project.subtitles.find(sub => 
        (sub.role === 'Original' || sub.role === 'original') && 
        Math.abs(sub.start - minStartTime) < 0.2
      );
      const subDuration = matchingSub ? (matchingSub.end - matchingSub.start) : 0;

      // Determine authoritative duration using precise priority
      let finalDuration = fileDuration;
      let durationSource = "оригинальному файлу";

      if (finalDuration <= 0) {
        finalDuration = subDuration;
        durationSource = "субтитрам";
      }
      if (finalDuration <= 0) {
        finalDuration = spanDuration;
        durationSource = "таймлайну (длине выделения)";
      }

      logger.info(`Пакетный экспорт [${fileName}]: реплика начинается с ${minStartTime.toFixed(4)}с. Длины: по таймлайну=${spanDuration.toFixed(4)}с, по файлу=${fileDuration.toFixed(4)}с, по сабам=${subDuration.toFixed(4)}с. Итоговая длина: ${finalDuration.toFixed(4)}с (выбрано по ${durationSource}).`);

      origSegments.push({
        startTime: minStartTime,
        duration: finalDuration,
        originalFileName: fileName
      });
    }

    if (origSegments.length === 0) {
      alert("Не найдено оригинальных сегментов реплик с информацией об имени файла на треке 'Оригинал'.");
      return;
    }

    // 2. Collect all active recorded dub segments across other tracks
    const dubTracks = project.tracks.filter(t => t.id !== origTrack.id && !t.isMuted);
    const dubSegmentsList = [];

    for (const track of dubTracks) {
      for (const segment of track.segments) {
        if (segment.filePath) {
          dubSegmentsList.push({
            filePath: segment.filePath,
            startTime: segment.startTime,
            duration: segment.duration,
            fileOffset: segment.fileOffset || 0,
            gain: segment.gain ?? 1,
            playbackRate: segment.playbackRate ?? 1
          });
        }
      }
    }

    if (dubSegmentsList.length === 0) {
      const confirmSilence = window.confirm("На дорожках дубляжа не обнаружено записанных фрагментов. Экспортировать пустые аудиофайлы (тишину) оригинальной длины с исходными именами?");
      if (!confirmSilence) return;
    }

    // 3. Ask destination folder
    const folderRes = await window.electronAPI.openFolder();
    if (!folderRes.success || !folderRes.data) return;
    const outDir = folderRes.data;

    setIsExporting(true);
    setExportProgress(0);
    setExportOperation(`Сборка и рендеринг ${origSegments.length} реплик...`);

    try {
      logger.info(`Starting batch render-export of ${origSegments.length} replicas to ${outDir}`);
      const exportedFilesRes = await window.electronAPI.batchExport({
        outDir,
        origSegments,
        dubSegments: dubSegmentsList,
      });

      if (exportedFilesRes.success && exportedFilesRes.data) {
        alert(`Успешно рендерировано и экспортировано ${exportedFilesRes.data.length} файлов в папку: ${outDir}\nВсе файлы соответствуют точной длине и именам оригиналов!`);
        logger.info("Batch render export successful.");
      } else {
        alert(`Ошибка пакетного рендеринга/экспорта: ${exportedFilesRes.error}`);
        logger.error("Batch render export failed:", exportedFilesRes.error);
      }
    } catch (error) {
      console.error("Batch render export failed:", error);
      alert("Ошибка при пакетном экспорте и рендеринге.");
    } finally {
      setIsExporting(false);
      setExportOperation('');
    }
  };

  const handleExportAudioBook = async (gapSeconds: number = 1.5) => {
    if (!project || !project.projectPath || !window.electronAPI) return;
    const dubTrack = project.tracks.find(t => t.name === 'Dubs');
    if (!dubTrack || dubTrack.segments.length === 0) {
      alert("Не найдено фрагментов Dubs для экспорта.");
      return;
    }

    const saveRes = await window.electronAPI.saveFile({
        title: 'Экспорт аудиокниги',
        defaultPath: `${project.name}_audiobook.wav`,
        filters: [{ name: 'Audio', extensions: ['wav'] }]
    });

    if (!saveRes.success || !saveRes.data) return;
    const outputPath = saveRes.data;

    setIsExporting(true);
    setExportProgress(0);
    setExportOperation('Preparing audiobook segments...');
    
    try {
      logger.info(`Starting audiobook export to ${outputPath}`);
      const resultRes = await window.electronAPI.exportAudioBook({
        projectPath: project.projectPath,
        outputPath: outputPath,
        format: 'wav',
        gapDuration: gapSeconds,
        normalizeLUFS: true,
        segments: dubTrack.segments.filter(s => s.filePath).map(s => ({
          filePath: getAbsoluteFilePath(s.filePath!, project.projectPath),
          gain: s.gain * (dubTrack.volume ?? 1)
        }))
      });

      if (resultRes.success && resultRes.data) {
        alert(`Аудиокнига успешно экспортирована: ${outputPath}`);
        logger.info("Audiobook export successful.");
      } else {
        alert(`Ошибка при экспорте аудиокниги: ${resultRes.error}`);
        logger.error("Audiobook export failed:", resultRes.error);
      }
    } catch (error) {
      console.error("Audio Book export failed:", error);
      alert(`Ошибка экспорта: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExporting(false);
      setExportOperation('');
    }
  };

  const handleExportStems = async () => {
    if (!project || !project.projectPath || !window.electronAPI) return;
    
    const folderRes = await window.electronAPI.openFolder();
    if (!folderRes.success || !folderRes.data) return;
    const outDir = folderRes.data;

    setIsExporting(true);
    setExportProgress(0);
    setExportOperation('Initializing stem export...');

    const unsubscribe = window.electronAPI.onStemProgress((data) => {
      const pct = (data.current / data.total) * 100;
      setExportProgress(pct);
      setExportOperation(`Stem ${data.current}/${data.total}: ${data.trackName}`);
    });

    try {
      logger.info(`Starting stem export to ${outDir}`);
      const resultRes = await window.electronAPI.exportStems({
        projectData: {
          tracks: project.tracks.map(t => ({
            name: t.name,
            isMuted: t.isMuted,
            isSolo: t.isSolo,
            volume: t.volume,
            segments: t.segments.map(s => ({
              id: s.id,
              startTime: s.startTime,
              duration: s.duration,
              filePath: s.filePath,
              gain: s.gain,
              panning: s.panning,
              fileOffset: s.fileOffset || 0,
              playbackRate: s.playbackRate
            }))
          })),
          audioOffsetMs: project.audioOffsetMs || 0
        },
        outputDir: outDir,
        bitDepth: project.audioSettings?.bitDepth?.toString() || '16'
      });
      if (resultRes.success) {
        alert(`Экспорт стемов завершен в папку: ${outDir}`);
        logger.info("Stem export successful.");
      } else {
        alert(`Ошибка при экспорте стемов: ${resultRes.error}`);
        logger.error("Stem export failed:", resultRes.error);
      }
    } catch (error) {
      console.error("Stem export failed:", error);
      alert(`Ошибка при экспорте: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      unsubscribe();
      setIsExporting(false);
      setExportOperation('');
    }
  };

  const handleExportAllStemsZip = async () => {
    if (!project || !project.id || !window.electronAPI) return;
    
    const saveRes = await window.electronAPI.saveFile({
        title: 'Экспорт всех дорожек в ZIP',
        defaultPath: `${project.name}_stems.zip`,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
    });

    if (!saveRes.success || !saveRes.data) return;
    const outputPath = saveRes.data;

    setIsExporting(true);
    setExportProgress(0);
    setExportOperation('Saving project...');
    await window.electronAPI.saveProjectJson({ projectPath: project.projectPath || '', projectData: project });

    setExportOperation('Exporting all tracks as ZIP...');

    try {
      logger.info(`Starting all stems ZIP export to ${outputPath}`);
      const resultRes = await window.electronAPI.exportAllStems({
        projectJson: JSON.stringify(project),
        outputPath: outputPath
      });
      if (resultRes.success) {
        alert(`Проект успешно упакован в ZIP: ${resultRes.data}`);
        logger.info("ZIP export successful.");
      } else {
        alert(`Ошибка при экспорте ZIP: ${resultRes.error}`);
        logger.error("ZIP export failed:", resultRes.error);
      }
    } catch (error) {
      console.error("ZIP export failed:", error);
      alert(`Ошибка при экспорте ZIP: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExporting(false);
      setExportOperation('');
    }
  };

  const handleQuickImport = () => {
    if (!project) return;
    const parsedSegments = TextImportService.parseRawText(quickImportText, quickImportDuration * 1000);
    const uniqueRoles = Array.from(new Set(parsedSegments.map(s => s.role)));
    if (uniqueRoles.length === 0) uniqueRoles.push('Default');
    
    setProject({
      ...project,
      subtitles: parsedSegments,
      roles: uniqueRoles,
      selectedRole: uniqueRoles[0]
    });
    setShowQuickImport(false);
    setQuickImportText('');
  };

  useEffect(() => {
    if (typeof project?.projectPath === 'string' && project.projectPath.endsWith('.dubstudio')) {
      const parentDir = project.projectPath.substring(0, Math.max(project.projectPath.lastIndexOf('/'), project.projectPath.lastIndexOf('\\')));
      console.log(`[Auto-Fix] Repairing projectPath: ${project.projectPath} -> ${parentDir}`);
      setProject({ ...project, projectPath: parentDir });
    }
  }, [project?.projectPath]);

  // Subtitle File Handling
  const handleSubtitleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const content = await file.text();
    let parsed: ParsedSubtitles;
    
    if (file.name.endsWith('.ass')) {
      parsed = SubtitleService.parseASS(content);
    } else if (file.name.endsWith('.srt')) {
      parsed = SubtitleService.parseSRT(content);
    } else {
      alert("Unsupported subtitle format. Please use .ass or .srt");
      return;
    }

    setProject(prev => {
      const baseProject = prev || createDefaultProject(file.name.replace(/\.[^/.]+$/, ""));

      return {
        ...baseProject,
        subtitles: parsed.subtitles,
        roles: parsed.roles,
        selectedRole: parsed.roles[0] || 'Default'
      };
    });
  };

  const triggerVideoPicker = async () => {
    if (isDesktop && (window as any).electronAPI) {
      const res = await (window as any).electronAPI.openVideo();
      if (res.success && res.data) {
        // Simulate a file object with path
        const fakeFile = {
          name: res.data.name,
          path: res.data.path,
          type: 'video/mp4', // basic assumption
          size: res.data.size
        } as any;
        onDrop([fakeFile]);
      }
    } else {
      document.getElementById('video-input')?.click();
    }
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    logger.info(`Loading video file via upload: ${file.name}`);

    if (!file.type.startsWith('video/')) {
      logger.warn(`Invalid video file type: ${file.type}`);
      setVideoError("Please select a valid video file (e.g., .mp4, .webm).");
      return;
    }

    setVideoType(file.type);
    const url = URL.createObjectURL(file);
    
    setProject(prev => {
      const baseProject = prev || createDefaultProject(file.name.replace(/\.[^/.]+$/, ""));

      return {
        ...baseProject,
        videoUrl: url
      };
    });
  };

  // Revoke blob URLs to prevent memory leaks
  useEffect(() => {
    const currentUrl = project?.videoUrl;
    return () => {
      if (currentUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(currentUrl);
      }
    };
  }, [project?.videoUrl]);

  useEffect(() => {
    let activeStream: MediaStream | null = null;
    let isCancelled = false;
    let mockCleanup: (() => void) | null = null;

    const createMockWebcamStream = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let animationId = 0;
      
      const draw = () => {
        if (!ctx) return;
        
        const gradient = ctx.createRadialGradient(320, 180, 50, 320, 180, 300);
        gradient.addColorStop(0, '#1e1b4b'); 
        gradient.addColorStop(1, '#090514'); 
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 640, 360);
        
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.08)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 640; i += 40) {
          ctx.beginPath();
          ctx.moveTo(i, 0);
          ctx.lineTo(i, 360);
          ctx.stroke();
        }
        for (let j = 0; j < 360; j += 40) {
          ctx.beginPath();
          ctx.moveTo(0, j);
          ctx.lineTo(640, j);
          ctx.stroke();
        }
        
        const time = Date.now() * 0.0025;
        const pulse = Math.sin(time) * 8 + 70;
        
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.25)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(320, 150, pulse, 0, Math.PI * 2);
        ctx.stroke();
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.beginPath();
        ctx.arc(320, 140, 32, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(320, 230, 60, 40, 0, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
        ctx.beginPath();
        ctx.arc(320, 140, 4, 0, Math.PI * 2);
        ctx.fill();
        
        const blink = Math.floor(Date.now() / 500) % 2 === 0;
        ctx.fillStyle = blink ? '#ef4444' : '#7f1d1d';
        ctx.beginPath();
        ctx.arc(40, 40, 5, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('LIVE (SIMULATED)', 53, 43);
        
        ctx.fillStyle = '#818cf8';
        ctx.font = 'bold 13px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('[ ДЕМО-РЕЖИМ ВЕБ-КАМЕРЫ ]', 320, 290);
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.font = '10px sans-serif';
        ctx.fillText('Доступ к оборудованию заблокирован либо ограничен', 320, 312);
        ctx.fillText('Используется виртуальный поток для тестирования записи', 320, 328);
        
        animationId = requestAnimationFrame(draw);
      };
      
      draw();
      
      const stream = (canvas as any).captureStream ? (canvas as any).captureStream(30) : null;
      return {
        stream: stream || new MediaStream(),
        cleanup: () => cancelAnimationFrame(animationId)
      };
    };

    if (showWebcam || project?.audioSettings?.isBackstageEnabled) {
      const targetWidth = project?.audioSettings?.webcamResolutionX || 1920;
      const targetHeight = project?.audioSettings?.webcamResolutionY || 1080;
      
      const constraints: MediaStreamConstraints = { 
        video: project?.audioSettings?.webcamDeviceId 
          ? { 
              deviceId: { ideal: project.audioSettings.webcamDeviceId },
              width: { ideal: targetWidth },
              height: { ideal: targetHeight },
              frameRate: { ideal: 30 }
            } 
          : { 
              width: { ideal: targetWidth },
              height: { ideal: targetHeight },
              frameRate: { ideal: 30 }
            },
        audio: false
      };
      
      console.log(`[Webcam] Attempting to start webcam. Backstage: ${project?.audioSettings?.isBackstageEnabled}, Source constraints:`, constraints);

      const startWebcam = async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (isCancelled) {
            stream.getTracks().forEach(t => t.stop());
            return;
          }

          console.log(`[Webcam] Webcam stream acquired. Video tracks:`, stream.getVideoTracks().map(t => t.label));
          activeStream = stream;
          setIsWebcamSimulated(false);
          if (webcamRef.current) {
            webcamRef.current.srcObject = stream;
            webcamRef.current.onloadedmetadata = () => {
              if (isCancelled) return;
              console.log(`[Webcam] Video metadata loaded. Resolution: ${webcamRef.current?.videoWidth}x${webcamRef.current?.videoHeight}`);
            };
            try {
              await webcamRef.current.play();
            } catch (e: any) {
              if (e.name !== 'AbortError') {
                console.error("[Webcam] Play failed:", e);
              }
            }
          }
        } catch (err) {
          if (isCancelled) return;
          console.warn("[Webcam] Primary webcam access failed, trying fallback:", err);
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia({ 
              video: true,
              audio: false
            });
            if (isCancelled) {
              fallbackStream.getTracks().forEach(t => t.stop());
              return;
            }
            activeStream = fallbackStream;
            setIsWebcamSimulated(false);
            if (webcamRef.current) {
              webcamRef.current.srcObject = fallbackStream;
              try {
                await webcamRef.current.play();
              } catch (e: any) {
                if (e.name !== 'AbortError') {
                  console.error("[Webcam] Fallback play failed:", e);
                }
              }
            }
          } catch (fallbackErr) {
            if (isCancelled) return;
            console.error("[Webcam] Webcam access completely failed:", fallbackErr);
            
            // Fallback to custom simulated stream
            console.log("[Webcam] Starting simulated webcam stream fallback.");
            try {
              const mock = createMockWebcamStream();
              activeStream = mock.stream;
              mockCleanup = mock.cleanup;
              setIsWebcamSimulated(true);
              if (webcamRef.current) {
                webcamRef.current.srcObject = mock.stream;
                try {
                  await webcamRef.current.play();
                } catch (e: any) {
                  if (e.name !== 'AbortError') {
                    console.error("[Webcam] Simulated webcam play failed:", e);
                  }
                }
              }
            } catch (simErr) {
              console.error("[Webcam] Simulated webcam generation failed:", simErr);
              if (project?.audioSettings?.isBackstageEnabled) {
                handleToggleBackstage();
              }
            }
          }
        }
      };

      startWebcam();
    }

    return () => {
      isCancelled = true;
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
      if (mockCleanup) {
        mockCleanup();
      }
      setIsWebcamSimulated(false);
      if (webcamRef.current) {
        webcamRef.current.srcObject = null;
      }
    };
  }, [showWebcam, project?.audioSettings?.isBackstageEnabled, project?.audioSettings?.webcamDeviceId, handleToggleBackstage, isPopoutOpen]);

  const [clipboardSegments, setClipboardSegments] = useState<any[]>([]);

  const handleCopySegments = () => {
      if (!project || selectedSegmentIds.length === 0) return;
      const copied: any[] = [];
      project.tracks.forEach(track => {
        track.segments.forEach(seg => {
          if (selectedSegmentIds.includes(seg.id)) {
            copied.push({
              trackId: track.id,
              segment: { ...seg }
            });
          }
        });
      });
      setClipboardSegments(copied);
  };

  const handleCutSegments = () => {
      handleCopySegments();
      deleteSegments();
  };

  const handlePasteSegments = () => {
      if (!project || clipboardSegments.length === 0) return;
      saveSnapshot();

      const minStartTime = Math.min(...clipboardSegments.map(c => c.segment.startTime));
      const pasteTime = currentTimeRef.current;
      const timeOffset = pasteTime - minStartTime;

      const newSegmentsMap = new Map<string, any[]>();
      const newSelectedIds: string[] = [];

      clipboardSegments.forEach(c => {
        const newSeg = {
          ...c.segment,
          id: "seg_" + crypto.randomUUID(),
          startTime: c.segment.startTime + timeOffset
        };
        
        let targetTrackId = c.trackId;
        const armedTrack = project.tracks.find(t => t.isArmed);
        if (armedTrack && clipboardSegments.length === 1) {
            targetTrackId = armedTrack.id;
        } else if (!project.tracks.some(t => t.id === targetTrackId)) {
            targetTrackId = project.tracks[0]?.id;
        }

        if (targetTrackId) {
            if (!newSegmentsMap.has(targetTrackId)) newSegmentsMap.set(targetTrackId, []);
            newSegmentsMap.get(targetTrackId)!.push(newSeg);
            newSelectedIds.push(newSeg.id);
        }
      });

      if (newSegmentsMap.size === 0) return;

      const updatedTracks = project.tracks.map(t => {
        if (newSegmentsMap.has(t.id)) {
          return {
            ...t,
            segments: [...t.segments, ...(newSegmentsMap.get(t.id) || [])].sort((a, b) => a.startTime - b.startTime)
          };
        }
        return t;
      });

      setProject({ ...project, tracks: updatedTracks });
      setSelectedSegmentIds(newSelectedIds);
  };


  useTimelineHotkeys({
    projectRef,
    selectedSegmentIds,
    currentTimeRef,
    isRecordingRef,
    isStartingRecordingRef,
    togglePlay,
    stopRecording,
    discardRecording,
    handleSplitSegment: handleSplit,
    handleSeek,
    addMarker,
    deleteSegments,
    handleToggleRecord,
    handleToggleBackstage,
    handleDeleteLastTake,
    handleJoinSegments,
    handleCopySegments,
    handleCutSegments,
    handlePasteSegments,
    onUndo: undo,
    onRedo: redo
  });

  useEffect(() => {
    const updateAutoHeight = () => {
      if (isAutoHeight && project) {
        // Base height: 
        // Transport (56px) + DAW Bar (56px) + Minimap (48px) + Ruler (40px) + Add Track button (40px) + padding/buffer (20px) = ~260px
        let totalTimelinePx = 260;
        project.tracks.forEach(t => {
          totalTimelinePx += t.height || 80;
        });
        const vh = (totalTimelinePx / window.innerHeight) * 100;
        setTimelineHeight(Math.max(15, Math.min(vh, 80)));
      }
    };

    updateAutoHeight();
    window.addEventListener('resize', updateAutoHeight);
    return () => window.removeEventListener('resize', updateAutoHeight);
  }, [project?.tracks, isAutoHeight, setTimelineHeight]);

  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [pendingExportOptions, setPendingExportOptions] = useState<{
    format: 'WAV' | 'MP3' | 'FLAC',
    includeVideo: boolean,
    includeOriginalAudio: boolean,
    forceMono: boolean
  }>({
    format: 'WAV',
    includeVideo: false,
    includeOriginalAudio: true,
    forceMono: false
  });

  const handleExport = (options: any) => {
    setPendingExportOptions(options);
    setIsExportModalOpen(true);
  };

  const runExportProcess = async (options: any) => {
    logger.info("runExportProcess triggered with options:", options);
    if (!project || !project.projectPath) {
      alert("Настройте или сохраните проект перед экспортом.");
      return;
    }

    const { 
      format = 'WAV', 
      includeVideo = false, 
      includeOriginalAudio = true, 
      forceMono = false,
      bitDepth = '24',
      audioBitrate = '320k'
    } = options;
    const safeFormat = format || 'WAV';

    const exportTracks = project.tracks.filter(t => {
      if (t.name === 'Оригинал' || t.name === 'Original' || t.id === 'originals-track' || t.id === 'original') return includeOriginalAudio;
      return true; // Dubs track
    }).map(track => ({
      id: track.id,
      volume: track.volume,
      isMuted: track.isMuted,
      isSolo: track.isSolo,
      segments: track.segments.map(seg => ({
        id: seg.id || `seg-${Date.now()}-${Math.random()}`,
        filePath: seg.filePath || '',
        startTime: seg.startTime,
        duration: seg.duration,
        fileOffset: seg.fileOffset || 0,
        fileDuration: seg.fileDuration || seg.duration,
        gain: seg.gain,
        panning: seg.panning,
        playbackRate: seg.playbackRate,
      })).filter(s => s.filePath !== '')
    }));

    const hasSegments = exportTracks.some(t => t.segments.length > 0);

    if (!hasSegments) {
      alert("No recorded segments to export.");
      return;
    }
    
    let videoName = '';
    if (project.videoPath) {
      const base = project.videoPath.split(/[/\\]/).pop() || '';
      const extIdx = base.lastIndexOf('.');
      videoName = extIdx !== -1 ? base.substring(0, extIdx) : base;
    } else if (project.videoUrl) {
      const base = project.videoUrl.split('/').pop()?.split('?')[0] || '';
      const extIdx = base.lastIndexOf('.');
      videoName = extIdx !== -1 ? base.substring(0, extIdx) : base;
    }
    if (!videoName) {
      videoName = project.name || 'project';
    }

    const activeRole = project.selectedRole || 'Default';
    const hasLoadedFixes = !!(project.fixes && project.fixes.length > 0);
    const filePrefix = hasLoadedFixes ? 'fix_' : '';
    const ext = includeVideo ? 'mp4' : safeFormat.toLowerCase();
    const exportFileName = `${filePrefix}${activeRole}_${videoName}.${ext}`;

    const saveFileRes = await window.electronAPI.saveFile({
      title: includeVideo ? 'Export Video' : 'Export Audio',
      defaultPath: exportFileName,
      filters: includeVideo 
        ? [{ name: 'MP4 Video', extensions: ['mp4'] }]
        : [{ name: safeFormat, extensions: [safeFormat.toLowerCase()] }]
    });

    if (!saveFileRes.success || !saveFileRes.data) return;
    const outputPath = saveFileRes.data;
    
    setIsExporting(true);
    setExportProgress(0);
    setIsExportModalOpen(false);

    let unsubscribe: (() => void) | undefined;

    if (window.electronAPI) {
      unsubscribe = window.electronAPI.onExportProgress((percent) => {
        setExportProgress(percent);
      });

      try {
        let actualAudioOutputPath = outputPath;
        if (includeVideo) {
          actualAudioOutputPath = outputPath + '.tmp.wav';
        }

        logger.info(`Starting audio export to ${actualAudioOutputPath} in format ${includeVideo ? 'wav' : safeFormat}`);
        const resultRes = await window.electronAPI.exportAudio({ 
          projectJson: JSON.stringify({
            projectPath: project.projectPath,
            tracks: exportTracks.map(t => ({
              name: project.tracks.find(pt => pt.id === t.id)?.name || 'Track',
              isMuted: t.isMuted,
              isSolo: t.isSolo,
              volume: t.volume,
              segments: t.segments.map(s => ({
                ...s,
                filePath: getAbsoluteFilePath(s.filePath, project.projectPath)
              }))
            })),
            audioOffsetMs: project.audioOffsetMs || 0
          }),
          outputPath: actualAudioOutputPath,
          format: includeVideo ? 'wav' : safeFormat.toLowerCase() as any,
          bitDepth: bitDepth,
          bitrate: format === 'MP3' ? audioBitrate : undefined
        });

        if (!resultRes.success) {
          throw new Error(resultRes.error || 'Unknown audio export error');
        }

        if (includeVideo && project.videoPath) {
           setExportProgress(0); // Reset for video phase
           const absVideoPath = getAbsoluteFilePath(project.videoPath, project.projectPath);
           logger.info(`Starting video render to ${outputPath} using video ${absVideoPath}`);
           const videoRes = await window.electronAPI.renderFinalVideo({
             originalVideo: absVideoPath,
             masterDub: actualAudioOutputPath,
             bgVolume: 0.0, // Original audio is already mixed into masterDub if requested
             dubVolume: 1.0, 
             outputPath: outputPath,
             title: videoName,
             artist: 'DubStudio'
           });

           if (!videoRes.success) {
             throw new Error(videoRes.error || 'Unknown video render error');
           }

           // Cleanup temp wav file
           // We can use a backend call, but we don't have a reliable `unlink` right now from frontend. 
           // Oh well, it will overwrite next time. Or we can use file system.
           // However we shouldn't throw error if we can't clean up.
        }

        alert(`Экспорт успешно завершен: ${outputPath}`);
        logger.info("Export successful.");
      } catch (error) {
        console.error("Export failed:", error);
        alert(`Ошибка экспорта: ${error instanceof Error ? error.message : String(error)}`);
        logger.error("Export operation failed:", error);
      } finally {
        if (unsubscribe) unsubscribe();
        setIsExporting(false);
      }
      return;
    }
  };

  
  // Actions moved to useProjectActions
  const handleGlueSegments = useCallback(async () => {
    if (!project || !project.projectPath || selectedSegmentIds.length < 2) return;
    
    // Find all selected segments across all tracks
    const segmentsToGlue: AudioSegment[] = [];
    let targetTrackId = '';
    
    project.tracks.forEach(track => {
      track.segments.forEach(seg => {
        if (selectedSegmentIds.includes(seg.id)) {
          segmentsToGlue.push(seg);
          targetTrackId = track.id; // Assume they are on the same track or use the last one
        }
      });
    });
    
    if (segmentsToGlue.length < 2) return;
    
    // Sort by start time
    segmentsToGlue.sort((a, b) => a.startTime - b.startTime);
    
    const firstSeg = segmentsToGlue[0];
    const lastSeg = segmentsToGlue[segmentsToGlue.length - 1];
    const totalDuration = (lastSeg.startTime + lastSeg.duration) - firstSeg.startTime;
    
    setIsExporting(true);
    setExportProgress(0);
    
    try {
      const outputPath = `${project.projectPath}/takes/glued_${Date.now()}.wav`;
      const resultRes = await window.electronAPI.mergeSegments({
        segments: segmentsToGlue.map(s => ({
          filePath: s.filePath ? getAbsoluteFilePath(s.filePath, project.projectPath) : '',
          startTime: s.startTime,
          gain: s.gain
        })),
        outputPath
      });
      
      if (resultRes.success && resultRes.data) {
        // Create new segment
        const newSeg: AudioSegment = {
          id: Math.random().toString(36).substr(2, 9),
          startTime: firstSeg.startTime,
          duration: totalDuration,
          filePath: outputPath,
          blobUrl: getSafeFileUrl(outputPath),
          fileOffset: 0,
          fileDuration: totalDuration,
          gain: 1.0,
          playbackRate: 1.0,
          text: `Glued (${segmentsToGlue.length} items)`
        };
        
        // Update project: remove old segments, add new one
        setProject(prev => {
          if (!prev) return prev;
          const newTracks = prev.tracks.map(track => {
            if (track.id !== targetTrackId) return track;
            const filtered = track.segments.filter(s => !selectedSegmentIds.includes(s.id));
            return { ...track, segments: [...filtered, newSeg] };
          });
          return { ...prev, tracks: newTracks };
        });
        
        setSelectedSegmentIds([]);
        alert("Segments glued successfully!");
      }
    } catch (error) {
      console.error("Glue failed:", error);
      alert("Glue failed. Check console.");
    } finally {
      setIsExporting(false);
    }
  }, [project, selectedSegmentIds]);

  const handleMuxVideo = async () => {
    if (!project || !project.projectPath || !project.videoPath) {
      alert("Сначала настройте проект и выберите видео.");
      return;
    }

    let videoName = '';
    if (project.videoPath) {
      const base = project.videoPath.split(/[/\\]/).pop() || '';
      const extIdx = base.lastIndexOf('.');
      videoName = extIdx !== -1 ? base.substring(0, extIdx) : base;
    } else if (project.videoUrl) {
      const base = project.videoUrl.split('/').pop()?.split('?')[0] || '';
      const extIdx = base.lastIndexOf('.');
      videoName = extIdx !== -1 ? base.substring(0, extIdx) : base;
    }
    if (!videoName) {
      videoName = project.name || 'project';
    }

    const activeRole = project.selectedRole || 'Default';
    const hasLoadedFixes = !!(project.fixes && project.fixes.length > 0);
    const filePrefix = hasLoadedFixes ? 'fix_' : '';
    const exportFileName = `${filePrefix}${activeRole}_${videoName}_final.mp4`;

    const saveRes = await window.electronAPI.saveFile({
        title: 'Экспорт финального видео (Mix)',
        defaultPath: exportFileName,
        filters: [{ name: 'Video', extensions: ['mp4'] }]
    });

    if (!saveRes.success || !saveRes.data) return;
    const finalOutputPath = saveRes.data;
    
    setIsExporting(true);
    setExportProgress(0);
    setExportOperation('Initializing video mix...');

    if (window.electronAPI) {
      const unsubscribe = window.electronAPI.onExportProgress((percent) => {
        setExportProgress(percent);
      });

      try {
        const tempAudioPath = `${project.projectPath}/temp_master_mux.wav`.replace(/\\/g, '/');
        
        // 1. Export current mix to a temp WAV first, because muxing needs one.
        setExportOperation('Mixing project audio...');
        logger.info(`Mixing project audio to ${tempAudioPath}`);
        
        const audioRes = await window.electronAPI.exportAudio({ 
          projectJson: JSON.stringify({
            projectPath: project.projectPath,
            tracks: project.tracks.map(t => ({
              name: t.name,
              isMuted: t.isMuted,
              isSolo: t.isSolo,
              volume: t.volume,
              segments: t.segments.map(s => ({
                ...s,
                filePath: getAbsoluteFilePath(s.filePath, project.projectPath)
              }))
            })),
            audioOffsetMs: project.audioOffsetMs || 0
          }),
          outputPath: tempAudioPath,
          format: 'wav',
          bitDepth: '16'
        });

        if (!audioRes.success) {
          throw new Error(`Ошибка сведения аудио: ${audioRes.error}`);
        }

        // 2. Mux video with the newly created temp audio
        setExportOperation('Muxing video with audio...');
        const absVideoPath = getAbsoluteFilePath(project.videoPath, project.projectPath);
        logger.info(`Muxing video from ${absVideoPath} with audio ${tempAudioPath} to ${finalOutputPath}`);
        
        const resultRes = await window.electronAPI.muxVideo({ 
          videoPath: absVideoPath,
          audioPath: tempAudioPath,
          outputPath: finalOutputPath
        });

        if (resultRes.success) {
          alert(`Финальное видео успешно сохранено: ${finalOutputPath}`);
          logger.info("Video muxing successful.");
        } else {
          throw new Error(resultRes.error || 'Unknown mux error');
        }
      } catch (error) {
        console.error("Muxing failed:", error);
        alert(`Ошибка при создании видео: ${error instanceof Error ? error.message : String(error)}`);
        logger.error("Muxing failed:", error);
      } finally {
        unsubscribe();
        setIsExporting(false);
        setExportOperation('');
      }
      return;
    }
  };

  useEffect(() => {
    if (videoRef.current && project) {
      playbackEngine.bindVideoElement(videoRef.current);
      if (referenceAudioRef.current) {
        playbackEngine.bindReferenceAudio(referenceAudioRef.current);
      }
    }
  }, [project, videoRef, referenceAudioRef, isPopoutOpen]);

  const handleQuickPreview = async (segmentId: string) => {
    if (!project || !project.projectPath) {
      alert("Please save the project first.");
      return;
    }
    
    setIsExporting(true);
    setExportProgress(0);

    if (window.electronAPI) {
      const unsubscribe = window.electronAPI.onExportProgress((percent) => {
        setExportProgress(percent);
      });

      try {
        const result = await window.electronAPI.quickPreviewExport({ 
          projectPath: project.projectPath,
          segmentId
        });
        if (result) {
          alert(`Экспорт превью завершен: ${result}`);
        }
      } catch (error) {
        console.error("Quick Preview failed:", error);
        alert(`Ошибка превью: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        unsubscribe();
        setIsExporting(false);
      }
      return;
    }
  };

  const currentLine = project?.subtitles.find(l => currentTime >= l.start - 0.5 && currentTime <= l.end);
  const nextLine = project?.subtitles.find(l => l.start > currentTime);

  const studioSyncDataRef = useRef({
    project, currentTime, currentLine, nextLine, showWebcam, isRecording,
    teleprompterMode, teleprompterFontSize, teleprompterLineHeight, teleprompterPacing,
    teleprompterPosition, teleprompterSize, isManualBackstageRecording, isBackstageRecording
  });

  useEffect(() => {
    studioSyncDataRef.current = {
      project, currentTime, currentLine, nextLine, showWebcam, isRecording,
      teleprompterMode, teleprompterFontSize, teleprompterLineHeight, teleprompterPacing,
      teleprompterPosition, teleprompterSize, isManualBackstageRecording, isBackstageRecording
    };
  });

  useEffect(() => {
    if (isPopoutOpen) {
      let interval: any;
      let lastDataSync = 0;
      let lastTauriTimeSync = 0;
      let lastDataHash = "";
      const channel = new BroadcastChannel('studio-mode');
      
      let tauriEmit: any = null;
      if (isDesktop && !!(window as any).__TAURI_INTERNALS__) {
        import('@tauri-apps/api/event').then(({ emit }) => {
          tauriEmit = emit;
        }).catch(() => {});
      }
      
      let isTimeSyncPending = false;
      
      const sendDataSync = (force: boolean = false) => {
        const state = studioSyncDataRef.current;
        let resolvedVideoPath = state.project?.videoPath;
        if (resolvedVideoPath && state.project?.projectPath && !resolvedVideoPath.startsWith('http') && !resolvedVideoPath.startsWith('blob:')) {
          if (!resolvedVideoPath.startsWith('/') && !resolvedVideoPath.match(/^[a-zA-Z]:/)) {
            // It's a relative path or just a filename
            const cleanPath = resolvedVideoPath.startsWith('./') ? resolvedVideoPath.slice(2) : resolvedVideoPath;
            resolvedVideoPath = `${state.project.projectPath}/${cleanPath}`.replace(/\\/g, '/');
          }
        }
        
        const minimalProject = state.project ? {
          videoUrl: state.project.videoUrl,
          videoPath: state.project.videoPath,
          projectPath: state.project.projectPath,
          selectedRole: state.project.selectedRole,
          audioSettings: state.project.audioSettings
        } : null;
        
        const dataPayload = {
            videoSrc: resolvedVideoPath ? getSafeFileUrl(resolvedVideoPath) : state.project?.videoUrl,
            showWebcam: state.showWebcam || !!state.project?.audioSettings?.isBackstageEnabled,
            subtitles: state.project?.subtitles,
            teleprompterMode: state.teleprompterMode,
            teleprompterFontSize: state.teleprompterFontSize,
            teleprompterLineHeight: state.teleprompterLineHeight,
            teleprompterPacing: state.teleprompterPacing,
            teleprompterPosition: state.teleprompterPosition,
            teleprompterSize: state.teleprompterSize,
            isAudiobook: !!state.project?.documentContent,
            activeRole: state.project?.selectedRole || '',
            project: minimalProject,
        };
        
        try {
          const newHash = JSON.stringify(dataPayload);
          if (force || newHash !== lastDataHash) {
            lastDataHash = newHash;
            channel.postMessage({ type: 'SYNC_DATA', payload: dataPayload });
            
            if (tauriEmit) {
              tauriEmit('studio-sync-data', dataPayload).catch(() => {});
            }
          }
        } catch (e) {
          console.warn("Failed to stringify data payload for sync", e);
        }
      };

      const syncState = () => {
        const state = studioSyncDataRef.current;
        const now = Date.now();
        const timePayload = {
            currentTime: state.currentTime,
            isPlaying: isPlayingRef.current,
            isRecording: state.isRecording,
            isBackstageRecording: state.project?.audioSettings?.backstageMode === 'manual' ? state.isManualBackstageRecording : (state.isRecording && state.isBackstageRecording),
            currentLine: state.currentLine,
            nextLine: state.nextLine,
        };

        channel.postMessage({ type: 'SYNC_TIME', payload: timePayload });
        
        // Throttled high-performance fallback over Tauri events (only every 150ms and simplified payloads)
        if (tauriEmit && !isTimeSyncPending && now - lastTauriTimeSync > 150) {
          lastTauriTimeSync = now;
          isTimeSyncPending = true;
          
          const simpleTimePayload = {
            currentTime: state.currentTime,
            isPlaying: isPlayingRef.current,
            isRecording: state.isRecording,
            isBackstageRecording: state.project?.audioSettings?.backstageMode === 'manual' ? state.isManualBackstageRecording : (state.isRecording && state.isBackstageRecording),
            currentLine: state.currentLine ? { id: state.currentLine.id, start: state.currentLine.start, end: state.currentLine.end, text: state.currentLine.text, role: state.currentLine.role } : null,
            nextLine: state.nextLine ? { id: state.nextLine.id, start: state.nextLine.start, end: state.nextLine.end, text: state.nextLine.text, role: state.nextLine.role } : null,
          };

          tauriEmit('studio-sync-time', simpleTimePayload)
            .catch(() => {})
            .finally(() => { isTimeSyncPending = false; });
        }
        
        if (now - lastDataSync > 500) {
          lastDataSync = now;
          sendDataSync(false);
        }
      };

      interval = setInterval(syncState, 1000 / 30); // 30fps sync

      channel.onmessage = (e) => {
        if (e.data.type === 'STUDIO_PING') {
          // Connection acknowledged - force send the full data immediately
          sendDataSync(true);
        } else if (e.data.type === 'STUDIO_CLOSED') {
          setIsPopoutOpen(false);
          setExternalWindow(null);
        } else if (e.data.type === 'UPDATE_TELEPROMPTER_SETTINGS') {
          const { fontSize, lineHeight, pacing, mode, size, position } = e.data.payload;
          if (fontSize !== undefined) setTeleprompterFontSize(fontSize);
          if (lineHeight !== undefined) setTeleprompterLineHeight(lineHeight);
          if (pacing !== undefined) setTeleprompterPacing(pacing);
          if (mode !== undefined) setTeleprompterMode(mode);
          if (size !== undefined) setTeleprompterSize(size);
          if (position !== undefined) setTeleprompterPosition(position);
        }
      };

      let unlistenTauri: any = null;
      let unlistenTauri2: any = null;
      let unlistenTauriSettings: any = null;
      if (isDesktop && !!(window as any).__TAURI_INTERNALS__) {
        import('@tauri-apps/api/event').then(({ listen }) => {
          listen('studio-ping', () => {
            sendDataSync(true);
          }).then(u => unlistenTauri2 = u);
          listen('studio-closed', () => {
            setIsPopoutOpen(false);
            setExternalWindow(null);
          }).then(unlisten => unlistenTauri = unlisten);
          listen('update-teleprompter-settings', (event: any) => {
            const { fontSize, lineHeight, pacing, mode, size, position } = event.payload;
            if (fontSize !== undefined) setTeleprompterFontSize(fontSize);
            if (lineHeight !== undefined) setTeleprompterLineHeight(lineHeight);
            if (pacing !== undefined) setTeleprompterPacing(pacing);
            if (mode !== undefined) setTeleprompterMode(mode);
            if (size !== undefined) setTeleprompterSize(size);
            if (position !== undefined) setTeleprompterPosition(position);
          }).then(u => unlistenTauriSettings = u);
        });
      }

      return () => {
        clearInterval(interval);
        channel.close();
        if (unlistenTauri) unlistenTauri();
        if (unlistenTauri2) unlistenTauri2();
        if (unlistenTauriSettings) unlistenTauriSettings();
      };
    }
  }, [isPopoutOpen]);

  const projectContextValue = {
    project, setProject, recentProjects, handleNewProject, handleOpenProject, handleSaveProject, onLoadProject,
    undo, redo, canUndo, canRedo
  };
  const timelineContextValue = {
    currentTime, duration, isPlaying, zoomLevel, timelineHeight, isAutoHeight, sidebarWidth,
    isRippleEnabled, selectedSegmentIds, isLooping, loopRange, currentTimeRef, videoRef, referenceAudioRef,
    setCurrentTime, setDuration, setIsPlaying, setZoomLevel, setTimelineHeight, setIsAutoHeight, setSidebarWidth,
    setIsRippleEnabled, setSelectedSegmentIds, setIsLooping, setLoopRange, togglePlay, handleSeek
  };

  const updateTrack = (trackId: string, updates: Partial<AudioTrack>) => {
    if (!project) return;
    const updatedTracks = project.tracks.map(t => t.id === trackId ? { ...t, ...updates } : t);
    const newProject = { ...project, tracks: updatedTracks };
    setProject(newProject);
    
    // Update playback engine if playing
    if (isPlayingRef.current) {
      const tracksToUpdate = [...updatedTracks];
      const originalsTrack = updatedTracks.find(t => t.name === 'Оригинал');
      
      if (project.referenceAudioPath) {
        tracksToUpdate.push({
          id: 'reference-track',
          name: 'Reference',
          volume: originalsTrack?.volume ?? 1.0,
          isMuted: originalsTrack?.isMuted ?? false,
          isSolo: originalsTrack?.isSolo ?? false,
          segments: [{ id: 'reference-seg' }] // Only need ID for updateTracks to find it
        } as any);
      }
      playbackEngine.updateTracks(tracksToUpdate).catch(console.error);
    }
  };

  let resolvedMainVideoPath = project?.videoPath;
  if (resolvedMainVideoPath && project?.projectPath && !resolvedMainVideoPath.startsWith('http') && !resolvedMainVideoPath.startsWith('blob:')) {
    if (!resolvedMainVideoPath.startsWith('/') && !resolvedMainVideoPath.match(/^[a-zA-Z]:/)) {
      const cleanPath = resolvedMainVideoPath.startsWith('./') ? resolvedMainVideoPath.slice(2) : resolvedMainVideoPath;
      resolvedMainVideoPath = `${project.projectPath}/${cleanPath}`.replace(/\\/g, '/');
    }
  }

  return (
    <ProjectProvider value={projectContextValue}>
      <UIProvider>
      <TimelineProvider value={timelineContextValue}>
        <div 
          {...getRootProps()}
      className="h-screen bg-zinc-950 text-white flex flex-col overflow-hidden font-sans relative"
    >
      <input {...getInputProps()} />
      
      <AnimatePresence>
        {dropzoneActive && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[200] bg-indigo-600/20 backdrop-blur-md border-4 border-dashed border-indigo-500 m-4 rounded-3xl flex flex-col items-center justify-center pointer-events-none"
          >
            <div className="w-24 h-24 bg-indigo-500 rounded-full flex items-center justify-center mb-6 shadow-2xl shadow-indigo-500/50">
              <Upload className="w-12 h-12 text-white animate-bounce" />
            </div>
            <h2 className="text-3xl font-black mb-2">Загрузить файл</h2>
            <p className="text-indigo-200 font-bold">Видео, аудио, книги или субтитры</p>
            <p className="text-zinc-400 text-sm mt-2">
              (Поддерживается: mp4, wav, flac, ass, srt, vtt, fb2, txt, csv и др.)
            </p>
          </motion.div>
        )}
      </AnimatePresence>

            <TopHeader 
        showProjectMenu={showProjectMenu}
        setShowProjectMenu={setShowProjectMenu}
        handleSelectVideo={handleSelectVideo}
        handleSelectSubs={handleSelectSubs}
        handleSelectDocument={handleSelectDocument}
        handleSelectReferenceAudio={handleSelectReferenceAudio}
        handleMergeBackstage={handleMergeBackstage}
        handleToggleBackstage={handleToggleBackstage}
        setShowQuickImport={setShowQuickImport}
        setShowFixImport={setShowFixImport}
        handleBulkImport={handleBulkImport}
        handleGameDubbingImport={handleGameDubbingImport}
        isDesktop={isDesktop}
        handleExport={handleExport}
        handleBatchExport={handleBatchExport}
        handleMuxVideo={handleMuxVideo}
        handleExportAudioBook={handleExportAudioBook}
        handleExportStems={handleExportStems}
        handleExportAllStemsZip={handleExportAllStemsZip}
        setIsExporting={setIsExporting}
        setExportOperation={setExportOperation}
      />

      {/* Main Content */}
      <main ref={mainRef} className="flex-1 flex min-h-0 overflow-hidden relative">
        <LeftSidebar />
        
        {/* Center: Video & Teleprompter */}
        <section className="flex-1 min-w-0 min-h-0 flex flex-col bg-zinc-950 relative">
          
          {/* Timeline Area */}
          <div 
            className="bg-zinc-900 flex flex-col flex-1 min-h-0 relative"
          >
            <TransportControls 
              isRecording={isRecording}
              onToggleRecord={handleToggleRecord}
              recordingStream={recordingStream}
              onClipping={(clipping) => {
                if (isRecording) setClippingDetected(clipping);
              }}
              isLooping={isLooping}
              onToggleLoop={() => setIsLooping(!isLooping)}
              onFitToWidth={handleFitToWidth}
              isAutoHeight={isAutoHeight}
              onToggleAutoHeight={() => setIsAutoHeight(!isAutoHeight)}
              zoomLevel={zoomLevel}
              onZoomChange={setZoomLevel}
              isBackstageRecording={project?.audioSettings?.backstageMode === 'manual' ? isManualBackstageRecording : isBackstageRecording}
              onToggleBackstage={handleToggleBackstage}
              backstageMode={project?.audioSettings?.backstageMode || 'parallel'}
              isVideoFloatingOpen={isVideoFloatingOpen}
              onToggleVideoFloating={() => setIsVideoFloatingOpen(!isVideoFloatingOpen)}
              hasVideo={!!project && (!!project.videoPath || !!project.videoUrl)}
            />
            <div ref={timelineContainerRef} className="flex-1 overflow-hidden flex flex-col min-h-0">
              {project ? (
                <AdvancedTimeline 
                  project={project} 
                  duration={duration} 
                  isPlaying={isPlaying}
                  isRecording={isRecording}
                  onPlayPause={togglePlay}
                  onRecord={handleToggleRecord}
                  onSeek={handleSeek} 
                  zoom={zoomLevel}
                  onZoom={setZoomLevel}
                  onUpdateSegment={(sourceTrackId, segmentId, updates, targetTrackId) => {
                    if (targetTrackId && targetTrackId !== sourceTrackId) {
                      moveSegmentToTrack(segmentId, sourceTrackId, targetTrackId, updates.startTime ?? 0);
                    } else {
                      updateSegment(segmentId, updates, targetTrackId);
                    }
                  }}
                  onSplitSegment={handleSplit}
                  onDeleteSegment={(trackId, segmentId) => deleteSegments([segmentId])}
                  onDuplicateSegment={handleDuplicateSegment}
                  onAddTrack={handleAddTrack}
                  onArmTrack={handleArmTrack}
                  loopRange={loopRange}
                  onSetLoopRange={setLoopRange}
                  isLooping={isLooping}
                  onToggleLoop={() => setIsLooping(!isLooping)}
                  isRippleEnabled={isRippleEnabled}
                  onToggleRipple={() => setIsRippleEnabled(!isRippleEnabled)}
                  selectedSegmentIds={selectedSegmentIds}
                  onCopySegments={handleCopySegments}
                  onCutSegments={handleCutSegments}
                  onPasteSegments={handlePasteSegments}
                  onSelectSegment={(segmentId, multi) => {
                    setSelectedSegmentIds(prev => {
                      if (multi) {
                        return prev.includes(segmentId) ? prev.filter(id => id !== segmentId) : [...prev, segmentId];
                      } else {
                        return [segmentId];
                      }
                    });
                  }}
                  onSelectBatchSegments={(segmentIds, multi) => {
                    setSelectedSegmentIds(prev => {
                      if (multi) {
                         const currentSet = new Set(prev);
                         segmentIds.forEach(id => {
                           if (currentSet.has(id)) currentSet.delete(id);
                           else currentSet.add(id);
                         });
                         return Array.from(currentSet);
                      }
                      return segmentIds;
                    });
                  }}
                  onClearSelection={() => setSelectedSegmentIds([])}
                  onGlueSegments={handleGlueSegments}
                  onUpdateTrack={updateTrack}
                  onUpdateAllTracks={(updates) => {
                    updateAllTracks(updates);
                    if (isPlayingRef.current && project) {
                      const updatedTracks = project.tracks.map(track => ({ ...track, ...updates }));
                      playbackEngine.updateTracks(updatedTracks).catch(console.error);
                    }
                  }}
                  onDeleteTrack={deleteTrack}
                  recordingPeaks={recordingPeaks}
                  recordingStartTime={recordingStartTimeRef.current}
                  onOpenProcessing={setProcessingTrackId}
                  onUpdateMasterVolume={(vol) => {
                    setProject(prev => prev ? { ...prev, masterVolume: vol } : prev);
                  }}
                  currentTimeRef={currentTimeRef}
                />
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950 text-zinc-600 gap-4">
                  <Layers size={48} className="opacity-20" />
                  <div className="text-center">
                    <p className="text-sm font-bold uppercase tracking-widest mb-1">Проект не загружен</p>
                    <p className="text-xs opacity-50">Создайте новый проект или откройте существующий, чтобы начать.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Invisible Reference Audio Element */}
        {project?.referenceAudioPath && (
          <audio 
            ref={referenceAudioRef} 
            onPlay={() => {
              if (!isPlayingRef.current) {
                setIsPlaying(true);
                if (projectRef.current) {
                  playbackEngine.play(projectRef.current.tracks, referenceAudioRef.current?.currentTime || 0);
                }
              }
            }}
            onPause={() => {
              if (isPlayingRef.current) {
                setIsPlaying(false);
                playbackEngine.stop();
              }
            }}
            src={getSafeFileUrl(project.referenceAudioPath.startsWith('./') && project.projectPath ? `${project.projectPath}/${project.referenceAudioPath.slice(2)}` : project.referenceAudioPath)} 
            onLoadedMetadata={(e) => {
              if (!project.videoPath && !project.videoUrl) {
                setDuration(e.currentTarget.duration);
              }
            }}
          />
        )}

        {/* Floating Video Monitor */}
        {project && (project.videoPath || project.videoUrl) && isVideoFloatingOpen && (
          <motion.div
            drag
            dragConstraints={mainRef}
            dragMomentum={false}
            dragElastic={0}
            initial={{ x: window.innerWidth - 460, y: 80 }}
            className="absolute z-[150] bg-zinc-950 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col select-none"
            style={{ width: videoSize === 'sm' ? '280px' : videoSize === 'md' ? '420px' : videoSize === 'lg' ? '560px' : '720px' }}
          >
            {/* Title Bar / Drag Handle */}
            <div className="px-3.5 py-2.5 bg-zinc-900 border-b border-white/5 flex items-center justify-between cursor-grab active:cursor-grabbing">
              <div className="flex items-center gap-2">
                <GripVertical className="w-4 h-4 text-zinc-500" />
                <span className="text-[11px] font-sans font-bold text-zinc-200 uppercase tracking-wider">Видео-монитор</span>
              </div>
              <div className="flex items-center gap-2">
                {/* Size toggle */}
                <button
                  onClick={() => setVideoSize(prev => prev === 'sm' ? 'md' : prev === 'md' ? 'lg' : prev === 'lg' ? 'xl' : 'sm')}
                  className="px-1.5 py-0.5 hover:bg-white/15 rounded text-[9px] text-indigo-400 font-bold tracking-widest transition-colors uppercase border border-indigo-500/20"
                  title="Изменить размер окна"
                >
                  {videoSize}
                </button>
                <button
                  onClick={() => setIsVideoFloatingOpen(false)}
                  className="p-1 hover:bg-rose-950/50 hover:text-rose-400 rounded transition-all text-zinc-400 cursor-pointer"
                  title="Скрыть монитор"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Video Canvas Area */}
            <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden">
              <video 
                key={project.videoPath || project.videoUrl || 'default'}
                ref={videoRef}
                className="max-h-full max-w-full object-contain pointer-events-none"
                playsInline
                preload="metadata"
                onKeyDown={(e) => e.preventDefault()}
                onPlay={() => {
                  if (!isPlayingRef.current) {
                    setIsPlaying(true);
                    if (projectRef.current) {
                      playbackEngine.play(projectRef.current.tracks, videoRef.current?.currentTime || 0);
                    }
                  }
                }}
                onPause={() => {
                  if (isPlayingRef.current) {
                    setIsPlaying(false);
                    playbackEngine.stop();
                  }
                }}
                src={resolvedMainVideoPath ? getSafeFileUrl(resolvedMainVideoPath) : project.videoUrl ? project.videoUrl : undefined}
                onLoadedMetadata={(e) => {
                  let newDuration = e.currentTarget.duration;
                  logger.info("Video metadata loaded. Duration:", newDuration);
                  
                  if (newDuration === Infinity || newDuration < 1) {
                    e.currentTarget.currentTime = 1e101;
                    return;
                  }
                  setDuration(newDuration);
                  setVideoError(null);
                  
                  setProject(p => {
                    if (!p) return p;
                    const tracks = p.tracks.map(t => {
                      if (t.name === 'Оригинал') {
                        return {
                          ...t,
                          segments: t.segments.map(s => 
                            s.id === 'original-audio-seg' ? { ...s, duration: newDuration, fileDuration: newDuration } : s
                          )
                        };
                      }
                      return t;
                    });
                    return { ...p, tracks };
                  });
                }}
                onDurationChange={(e) => {
                  const newDuration = e.currentTarget.duration;
                  if (newDuration !== Infinity && newDuration > 0) {
                    setDuration(newDuration);
                    setProject(p => {
                      if (!p) return p;
                      const tracks = p.tracks.map(t => {
                        if (t.name === 'Оригинал') {
                          return {
                            ...t,
                            segments: t.segments.map(s => 
                              s.id === 'original-audio-seg' ? { ...s, duration: newDuration, fileDuration: newDuration } : s
                            )
                          };
                        }
                        return t;
                      });
                      return { ...p, tracks };
                    });
                  }
                }}
                onError={(e) => {
                  const video = e.currentTarget;
                  const error = video.error;
                  let message = "Видео не может быть загружено. Пожалуйста, проверьте формат файла.";
                  
                  if (error) {
                    if (error.code === 1) message = "Воспроизведение прервано пользователем.";
                    else if (error.code === 2) message = "Ошибка сети при загрузке видео.";
                    else if (error.code === 3) message = "Ошибка декодирования. Нажмите «Исправить воспроизведение» ниже.";
                    else if (error.code === 4) message = "Формат видео не поддерживается или файл отсутствует.";
                  }
                  
                  setVideoError(message);
                }}
              />

              {/* Timecode Indicator */}
              <div className="absolute top-3 left-3 bg-black/80 backdrop-blur-md border border-white/10 px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold text-white shadow-lg pointer-events-none flex items-center gap-1.5 z-10">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                <span>TIME: {Math.floor(currentTime / 60)}:{Math.floor(currentTime % 60).toString().padStart(2, '0')}.{Math.floor((currentTime % 1) * 10).toString()}</span>
              </div>

              {/* Error overlay inside floating video */}
              {videoError && (
                <div className="absolute inset-0 bg-zinc-950/95 flex flex-col items-center justify-center p-4 text-center z-50 animate-fade-in">
                  <AlertTriangle className="w-8 h-8 text-rose-500 mb-2 shrink-0" />
                  <p className="text-[11px] text-zinc-300 max-w-xs mb-3 leading-normal font-semibold">{videoError}</p>
                  <div className="flex gap-2 justify-center">
                    {window.electronAPI && project?.videoPath && (
                      <button 
                        onClick={async () => {
                          try {
                            if (project?.videoPath && (window.electronAPI as any)?.transcodeToMp4Webm) {
                              setIsExporting(true);
                              setExportOperation("Создание прокси...");
                              setExportProgress(10);
                              const result = await (window.electronAPI as any).transcodeToMp4Webm(project.videoPath);
                              if (result.success && result.outputPath) {
                                setProject({ ...project, videoPath: result.outputPath });
                                setVideoError(null);
                              }
                            }
                          } catch (e) {
                            alert("Failed to build proxy track");
                          } finally {
                            setIsExporting(false);
                          }
                        }} 
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-[10px] font-bold transition-all shadow-lg shrink-0"
                      >
                        Исправить
                      </button>
                    )}
                    <button 
                      onClick={() => {
                        setVideoError(null);
                        if (videoRef.current) videoRef.current.load();
                      }} 
                      className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-[10px] font-bold transition-all shrink-0"
                    >
                      Повторить
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* Popout Window Manager */}
        {isPopoutOpen && externalWindow && project && (() => {
          const content = (
            <div className="w-full h-full relative flex items-center justify-center bg-black overflow-hidden select-none">
              {(project.videoPath || project.videoUrl) && (
                <video 
                  ref={videoRef}
                  className="w-full h-full object-contain shadow-2xl"
                  playsInline
                  preload="metadata"
                  onKeyDown={(e) => e.preventDefault()}
                  onPlay={() => {
                    if (!isPlayingRef.current) {
                      setIsPlaying(true);
                      if (projectRef.current) {
                        playbackEngine.play(projectRef.current.tracks, videoRef.current?.currentTime || 0);
                      }
                    }
                  }}
                  onPause={() => {
                    if (isPlayingRef.current) {
                      setIsPlaying(false);
                      playbackEngine.stop();
                    }
                  }}
                  src={resolvedMainVideoPath ? getSafeFileUrl(resolvedMainVideoPath) : project.videoUrl ? project.videoUrl : undefined}
                  onLoadedMetadata={(e) => {
                    let newDuration = e.currentTarget.duration;
                    if (newDuration !== Infinity && newDuration > 0) {
                      setDuration(newDuration);
                    }
                  }}
                  onDurationChange={(e) => {
                    const newDuration = e.currentTarget.duration;
                    if (newDuration !== Infinity && newDuration > 0) {
                      setDuration(newDuration);
                    }
                  }}
                  onError={(e) => {
                    const video = e.currentTarget;
                    const error = video.error;
                    setVideoError(`Ошибка воспроизведения видео во втором окне: ${error?.message || error?.code}`);
                  }}
                />
              )}
              
              <div className="absolute top-4 left-4 z-[100] pointer-events-auto flex items-center gap-2">
                <button
                  onClick={() => {
                    let doc = window.document;
                    if (externalWindow && externalWindow !== window) {
                      doc = externalWindow.document;
                    }
                    const elem = doc.documentElement;
                    if (!doc.fullscreenElement) {
                      elem.requestFullscreen().catch((err) => {
                        console.error(`Fullscreen error: ${err.message}`);
                      });
                    } else {
                      doc.exitFullscreen();
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 text-white border border-white/10 text-[10px] font-black transition-all flex items-center gap-1.5 shadow-md active:scale-95 cursor-pointer uppercase tracking-tight"
                >
                  <Monitor className="w-3.5 h-3.5" />
                  Во весь экран
                </button>
                <button
                  onClick={handleTogglePopout}
                  className="px-3 py-1.5 rounded-lg bg-rose-950/80 hover:bg-rose-900/80 text-rose-200 border border-rose-500/30 text-[10px] font-black transition-all flex items-center gap-1.5 shadow-md active:scale-95 cursor-pointer uppercase tracking-tight"
                >
                  Вернуть на базу
                </button>
              </div>
            </div>
          );

          if (externalWindow === window) {
            return (
              <div className="fixed inset-0 w-full h-full z-[99999] bg-black">
                {content}
              </div>
            );
          }
          
          if ((externalWindow as any) === 'DESKTOP_POPOUT') {
            return (
              <div className="hidden">
                <video 
                  ref={videoRef}
                  src={resolvedMainVideoPath ? getSafeFileUrl(resolvedMainVideoPath) : project.videoUrl ? project.videoUrl : undefined}
                  onLoadedMetadata={(e) => {
                    let newDuration = e.currentTarget.duration;
                    if (newDuration !== Infinity && newDuration > 0) {
                      setDuration(newDuration);
                    }
                  }}
                  onPlay={() => {
                    if (!isPlayingRef.current) {
                      setIsPlaying(true);
                      if (projectRef.current) {
                        playbackEngine.play(projectRef.current.tracks, videoRef.current?.currentTime || 0);
                      }
                    }
                  }}
                  onPause={() => {
                    if (isPlayingRef.current) {
                      setIsPlaying(false);
                      playbackEngine.stop();
                    }
                  }}
                />
              </div>
            );
          }

          return (
            <PopoutWindow externalWindow={externalWindow} onClose={() => { setIsPopoutOpen(false); setExternalWindow(null); }}>
              {content}
            </PopoutWindow>
          );
        })()}

        {showCalibration && project && (
          <LatencyCalibration 
            inputDeviceId={project?.audioSettings?.deviceId}
            outputDeviceId={project?.audioSettings?.outputDeviceId}
            onComplete={(offset) => {
              setProject({ ...project, audioOffsetMs: offset });
              setShowCalibration(false);
            }}
            onClose={() => setShowCalibration(false)}
          />
        )}

        <PreRollCountdown countdown={preRollCountdown} />
      </main>

      <QuickImportModal 
        show={showQuickImport}
        onClose={() => setShowQuickImport(false)}
        text={quickImportText}
        onTextChange={setQuickImportText}
        duration={quickImportDuration}
        onDurationChange={setQuickImportDuration}
        onImport={handleQuickImport}
      />

      <FixImportModal 
        show={showFixImport}
        onClose={() => setShowFixImport(false)}
        text={fixImportText}
        onTextChange={setFixImportText}
        onImport={handleFixImport}
      />

      {mkvImportData && (
        <MkvTrackSelectorModal 
          mediaInfo={mkvImportData.mediaInfo}
          videoPath={mkvImportData.videoPath}
          videoName={mkvImportData.videoName}
          onConfirm={handleMkvConfirm}
          onCancel={handleMkvCancel}
        />
      )}

      <ModalsManager />

      {isExportModalOpen && (
        <ExportModal 
          onExport={(options) => runExportProcess(options)} 
          onCancel={() => setIsExportModalOpen(false)} 
          initialOptions={pendingExportOptions}
          duration={duration}
        />
      )}
      
      <StyledExportOverlay 
        isExporting={isExporting} 
        exportProgress={exportProgress} 
        exportOperation={exportOperation} 
      />
    </div>
      </TimelineProvider>
    </UIProvider>
    </ProjectProvider>
  );
}