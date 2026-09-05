import React, { useCallback } from 'react';
import { Project, AudioSegment, AudioTrack, TrackProcessing, Marker, VstPluginInstance } from '../types';
import { splitSegmentAtTime } from '../lib/timelineUtils';
import { playbackEngine } from '../services/playbackEngine';
import { loadPlugin, setPluginParameter } from '../lib/vstHost';

interface UseProjectActionsOptions {
  project: Project | null;
  setProject: React.Dispatch<React.SetStateAction<Project | null>>;
  saveSnapshot: (targetId?: string) => void;
  selectedSegmentIds: string[];
  setSelectedSegmentIds: (ids: string[]) => void;
  isPlayingRef: React.MutableRefObject<boolean>;
  currentTimeRef: React.MutableRefObject<number>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isRippleEnabledRef: React.MutableRefObject<boolean>;
}

export function useProjectActions({
  project,
  setProject,
  saveSnapshot,
  selectedSegmentIds,
  setSelectedSegmentIds,
  isPlayingRef,
  currentTimeRef,
  videoRef,
  isRippleEnabledRef
}: UseProjectActionsOptions) {

  const handleSplit = useCallback((trackId?: string, segmentId?: string, splitTimeInput?: number) => {
    const videoElem = videoRef.current;
    const rawTime = (splitTimeInput && splitTimeInput !== -1) 
      ? splitTimeInput 
      : (videoElem ? videoElem.currentTime : currentTimeRef.current);
    
    const splitTimeNormalized = Number(rawTime.toFixed(3));
    
    saveSnapshot();
    
    let newSelectionIds: string[] = [];
    
    setProject(currentProject => {
      if (!currentProject) return null;
      
      const newTracks = [...currentProject.tracks];
      const segmentsToSplit: { trackIndex: number, segmentIndex: number, segment: AudioSegment }[] = [];

      const hasSpecificId = segmentId && segmentId !== '';
      const targetIds = hasSpecificId ? [segmentId] : selectedSegmentIds;
      
      if (targetIds.length > 0) {
        for (let t = 0; t < newTracks.length; t++) {
            const track = newTracks[t];
            targetIds.forEach(id => {
                const sIndex = track.segments.findIndex(s => String(s.id) === String(id));
                if (sIndex !== -1) {
                    const s = track.segments[sIndex];
                    const sStart = Number(s.startTime.toFixed(3));
                    const sEnd = Number((s.startTime + s.duration).toFixed(3));
                    
                    if (splitTimeNormalized >= sStart && splitTimeNormalized <= sEnd) {
                      segmentsToSplit.push({ trackIndex: t, segmentIndex: sIndex, segment: s });
                    }
                }
            });
        }
      }
      
      if (segmentsToSplit.length === 0) {
        for (let t = 0; t < newTracks.length; t++) {
            const track = newTracks[t];
            if (track.id === 'originals-track' || track.name === 'Оригинал' || track.id === 'original-audio-seg' || track.id === 'original-audio-track') continue;
            
            track.segments.forEach((s, sIndex) => {
                const sStart = Number(s.startTime.toFixed(3));
                const sEnd = Number((s.startTime + s.duration).toFixed(3));
                
                if (splitTimeNormalized >= sStart && splitTimeNormalized <= sEnd) {
                    segmentsToSplit.push({ trackIndex: t, segmentIndex: sIndex, segment: s });
                }
            });
        }
      }

      if (segmentsToSplit.length === 0) {
        console.warn("[Split] No matching segments found at current time:", splitTimeNormalized);
        return currentProject;
      }

      segmentsToSplit.sort((a,b) => b.segmentIndex - a.segmentIndex);

      for (const item of segmentsToSplit) {
          const { trackIndex, segmentIndex, segment } = item;
          
          const splitResult = splitSegmentAtTime(segment, splitTimeNormalized);
          if (splitResult.length === 2) {
             const [p1, p2] = splitResult;
             newSelectionIds.push(p2.id); 
             
             const updatedSegments = [...newTracks[trackIndex].segments];
             updatedSegments.splice(segmentIndex, 1, p1, p2);
             
             newTracks[trackIndex] = {
               ...newTracks[trackIndex],
               segments: updatedSegments
             };
          }
      }

      const updatedProject = { ...currentProject, tracks: newTracks };
      if (isPlayingRef.current) {
        playbackEngine.reconcile(updatedProject.tracks);
      }
      return updatedProject;
    });

    if (newSelectionIds.length > 0) {
      setSelectedSegmentIds(newSelectionIds);
    }
  }, [saveSnapshot, setProject, selectedSegmentIds, setSelectedSegmentIds, videoRef, currentTimeRef, isPlayingRef]);

  const deleteSegments = useCallback((targetIds?: string[]) => {
    if (!project) return;
    
    const validSelected = selectedSegmentIds.filter((cid): cid is string => cid !== undefined && cid !== null);
    
    let idsToDelete: string[] = [];
    if (targetIds && targetIds.length > 0) {
      if (targetIds.some(tid => validSelected.includes(tid))) {
        idsToDelete = validSelected;
      } else {
        idsToDelete = targetIds;
      }
    } else {
      idsToDelete = validSelected;
    }

    if (idsToDelete.length === 0) return;

    saveSnapshot();
    
    setProject(prevProject => {
      if (!prevProject) return prevProject;
      
      const newTracks = [...prevProject.tracks];
      let hasChanges = false;
      let minStartTimeAffected = Infinity;
      let totalDurationDeleted = 0;
      let mainTrackIndex = -1;

      for (let t = 0; t < newTracks.length; t++) {
        const track = newTracks[t];
        const segmentsToDelete = track.segments.filter(s => idsToDelete.includes(String(s.id)));
        
        if (segmentsToDelete.length > 0) {
          hasChanges = true;
          mainTrackIndex = t;
          
          for (const s of segmentsToDelete) {
             if (s.startTime < minStartTimeAffected) {
                 minStartTimeAffected = s.startTime;
             }
             totalDurationDeleted += s.duration;
          }

          const filteredSegments = track.segments.filter(s => !idsToDelete.includes(String(s.id)));
          
          if (isRippleEnabledRef.current) {
             const finalSegments = filteredSegments.map(seg => {
                 if (seg.startTime >= minStartTimeAffected) {
                     return {
                         ...seg,
                         startTime: seg.startTime - totalDurationDeleted
                     };
                 }
                 return seg;
             });
             newTracks[t] = { ...track, segments: finalSegments };
          } else {
             newTracks[t] = { ...track, segments: filteredSegments };
          }
        }
      }

      if (!hasChanges) return prevProject;

      if (isPlayingRef.current) {
        playbackEngine.reconcile(newTracks);
      }

      return { ...prevProject, tracks: newTracks };
    });
    
    setSelectedSegmentIds([]);
  }, [project, selectedSegmentIds, saveSnapshot, setProject, setSelectedSegmentIds, isRippleEnabledRef, isPlayingRef]);

  const moveSegmentToTrack = useCallback((segmentId: string, sourceTrackId: string, targetTrackId: string, newStartTime: number) => {
    saveSnapshot();
    setProject(prev => {
      if (!prev) return prev;
      
      // 1. Находим исходный трек и удаляем сегмент
      const sourceTrack = prev.tracks.find(t => t.id === sourceTrackId);
      const segmentToMove = sourceTrack?.segments.find(s => s.id === segmentId);
      
      if (!segmentToMove) return prev;

      const updatedTracks = prev.tracks.map(track => {
        // Убираем из старого трека
        if (track.id === sourceTrackId) {
          return { ...track, segments: track.segments.filter(s => s.id !== segmentId) };
        }
        // Добавляем в новый трек
        if (track.id === targetTrackId) {
          const newSegment = { ...segmentToMove, startTime: Number(newStartTime.toFixed(3)) };
          return { ...track, segments: [...track.segments, newSegment] };
        }
        return track;
      });

      return { ...prev, tracks: updatedTracks };
    });
  }, [saveSnapshot, setProject]);

  const handleAddTrack = useCallback(() => {
    saveSnapshot();
    setProject(prev => {
      if (!prev) return prev;
      const dubsCount = prev.tracks.filter(t => t.name.toLowerCase().includes('dub')).length;
      const newTrack: AudioTrack = {
        id: `track-${Date.now()}`,
        name: `Dubs ${dubsCount + 1}`,
        segments: [],
        volume: 1.0,
        isMuted: false,
        isArmed: false,
      };
      return { ...prev, tracks: [...prev.tracks, newTrack] };
    });
  }, [setProject, saveSnapshot]);

  const deleteTrack = useCallback((id: string) => {
    saveSnapshot();
    setProject(prev => {
       if (!prev) return prev;
       return { ...prev, tracks: prev.tracks.filter(track => track.id !== id) };
    });
  }, [setProject, saveSnapshot]);

  const updateSegment = useCallback((id: string, updates: Partial<AudioSegment>, targetTrackId?: string) => {
    setProject(prevProject => {
      if (!prevProject) return prevProject;
      let hasChanges = false;
      const newTracks = prevProject.tracks.map(track => {
        let segmentsConfigured = false;
        const newSegments = track.segments.map(seg => {
          if (String(seg.id) === String(id)) {
            hasChanges = true;
            segmentsConfigured = true;
            if (isRippleEnabledRef.current && updates.duration !== undefined && updates.duration !== seg.duration) {
                // Handle ripple if supported inside updateSegment, although it is mostly handled in handlers.
            }
            return { ...seg, ...updates };
          }
          return seg;
        });

        if (segmentsConfigured) {
          if (targetTrackId && track.id !== targetTrackId) {
             // We need to move the segment, handled by TimelineCanvas drag so maybe skipping here
          }
          return { ...track, segments: newSegments };
        }
        return track;
      });

      if (!hasChanges && targetTrackId) {
          // Additional complex logic omitted for brevity in updateSegment, handled mostly by TimelineCanvas dragging.
      }

      // Live update segment volume, panning, etc. in real-time during playback
      if (isPlayingRef.current) {
        const tracksToUpdate = [...newTracks];
        const originalsTrack = newTracks.find(t => t.name === 'Оригинал' || t.name === 'Original');
        if (prevProject.referenceAudioPath) {
          tracksToUpdate.push({
            id: 'reference-track',
            name: 'Reference',
            volume: originalsTrack?.volume ?? 1.0,
            isMuted: originalsTrack?.isMuted ?? false,
            isSolo: originalsTrack?.isSolo ?? false,
            segments: [{ id: 'reference-seg' }]
          } as any);
        }
        playbackEngine.updateTracks(tracksToUpdate).catch(console.error);
      }

      return { ...prevProject, tracks: newTracks };
    });
  }, [setProject, isRippleEnabledRef, isPlayingRef]);

  const updateAllTracks = useCallback((updates: Partial<AudioTrack>) => {
    setProject(prev => {
      if (!prev) return prev;
      return { ...prev, tracks: prev.tracks.map(track => ({ ...track, ...updates })) };
    });
  }, [setProject]);

  const handleArmTrack = useCallback((trackId: string) => {
    setProject(prev => {
      if (!prev) return prev;
      const newTracks = prev.tracks.map(t => ({
        ...t,
        isArmed: t.id === trackId ? !t.isArmed : false,
      }));
      return { ...prev, tracks: newTracks };
    });
  }, [setProject]);

  const handleUpdateProcessing = useCallback((trackId: string, settings: TrackProcessing) => {
    setProject(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        tracks: prev.tracks.map(t => t.id === trackId ? { ...t, processing: settings } : t)
      };
    });
  }, [setProject]);

  const handleDuplicateSegment = useCallback((trackId: string, segmentId: string, newStartTime: number) => {
    saveSnapshot();
    setProject(prev => {
      if (!prev) return prev;
      const newTracks = prev.tracks.map(track => {
        if (track.id === trackId) {
          const segmentToDup = track.segments.find(s => String(s.id) === String(segmentId));
          if (segmentToDup) {
            const newSegment: AudioSegment = {
              ...segmentToDup,
              id: `seg-${Date.now()}-${Math.random().toString(36).substring(2,5)}`,
              startTime: newStartTime,
            };
            return { ...track, segments: [...track.segments, newSegment] };
          }
        }
        return track;
      });
      return { ...prev, tracks: newTracks };
    });
  }, [setProject, saveSnapshot]);

  const handleGlueSegments = useCallback(async () => {
      if (selectedSegmentIds.length !== 2) {
          alert('Выберите ровно два сегмента для склейки');
          return;
      }
      // Logic for glue
  }, [selectedSegmentIds]);

  const handleJoinSegments = useCallback(() => {
    if (selectedSegmentIds.length < 2) return;
    saveSnapshot();
  }, [selectedSegmentIds, saveSnapshot]);

  const addMarker = useCallback(() => {
    const time = currentTimeRef.current;
    saveSnapshot();
    setProject(prev => {
      if (!prev) return prev;
      const newMarker: Marker = {
        id: `marker-${Date.now()}`,
        time: time,
        label: `Marker ${prev.markers ? prev.markers.length + 1 : 1}`,
        color: '#ff0000'
      };
      const existingMarkers = prev.markers || [];
      return { ...prev, markers: [...existingMarkers, newMarker] };
    });
  }, [currentTimeRef, saveSnapshot, setProject]);

  const handleAddVstToTrack = useCallback(async (trackId: string, vstPath: string, vstName: string) => {
    try {
      const instanceId = await loadPlugin(vstPath);
      saveSnapshot();
      setProject(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          tracks: prev.tracks.map(t => {
            if (t.id === trackId) {
              const currentVsts = t.processing?.vstPlugins || [];
              const newVst: VstPluginInstance = {
                id: instanceId,
                name: vstName,
                bypass: false,
                pluginPath: vstPath,
                vstVersion: vstPath.endsWith('.vst3') ? 'VST3' : 'VST2',
                parameters: {},
              };
              return {
                ...t,
                processing: {
                  ...(t.processing || { enabled: true }),
                  vstPlugins: [...currentVsts, newVst]
                }
              };
            }
            return t;
          })
        };
      });
    } catch (err) {
      console.error("Failed to load VST:", err);
    }
  }, [setProject, saveSnapshot]);

  const handleToggleVstBypass = useCallback((trackId: string, vstInstanceId: string) => {
    setProject(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        tracks: prev.tracks.map(t => {
          if (t.id === trackId && t.processing?.vstPlugins) {
            return {
              ...t,
              processing: {
                ...t.processing,
                vstPlugins: t.processing.vstPlugins.map(v => 
                  v.id === vstInstanceId ? { ...v, bypass: !v.bypass } : v
                )
              }
            };
          }
          return t;
        })
      };
    });
  }, [setProject]);

  const handleUpdateVstParam = useCallback((trackId: string, vstInstanceId: string, paramId: number, value: number) => {
    // Optimistically update UI
    setProject(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        tracks: prev.tracks.map(t => {
          if (t.id === trackId && t.processing?.vstPlugins) {
            return {
              ...t,
              processing: {
                ...t.processing,
                vstPlugins: t.processing.vstPlugins.map(v => 
                  v.id === vstInstanceId ? { ...v, parameters: { ...v.parameters, [paramId]: value } } : v
                )
              }
            };
          }
          return t;
        })
      };
    });
    
    // Send to backend
    setPluginParameter(vstInstanceId, paramId, value).catch(console.error);
  }, [setProject]);

  return {
    handleSplit,
    deleteSegments,
    handleAddTrack,
    deleteTrack,
    updateSegment,
    updateAllTracks,
    handleArmTrack,
    handleUpdateProcessing,
    handleDuplicateSegment,
    handleGlueSegments,
    handleJoinSegments,
    moveSegmentToTrack,
    addMarker,
    handleAddVstToTrack,
    handleToggleVstBypass,
    handleUpdateVstParam
  };
}
