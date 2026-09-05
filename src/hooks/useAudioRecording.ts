import { useState, useRef, useCallback } from 'react';
import { logger } from '../lib/logger';
import { Project } from '../types';

export const useAudioRecording = (
  project: Project | null,
  currentTime: number,
  onRecordingComplete: (audioBlob: Blob, startTime: number) => Promise<void>
) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStream, setRecordingStream] = useState<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const isRecordingRef = useRef(false);

  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) return;
    logger.info("Starting recording process...");
    
    try {
      const constraints: MediaStreamConstraints = {
        audio: project?.audioSettings?.deviceId ? { 
          deviceId: { exact: project.audioSettings.deviceId }
        } : true
      };
      logger.info("Requesting user media with constraints", constraints);

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      logger.info("User media stream acquired");

      setRecordingStream(stream);
      
      const mediaRecorderOptions: MediaRecorderOptions = {};
      if (project?.audioSettings?.bitDepth) {
        const bitrate = project.audioSettings.bitDepth * (project.audioSettings.sampleRate || 48000);
        mediaRecorderOptions.audioBitsPerSecond = bitrate;
      }
      
      const mediaRecorder = new MediaRecorder(stream, mediaRecorderOptions);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      
      recordingStartTimeRef.current = currentTime;
      isRecordingRef.current = true;
      setIsRecording(true);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        logger.info("Recording stopped, processing audio...");
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        await onRecordingComplete(audioBlob, recordingStartTimeRef.current);
        
        stream.getTracks().forEach(track => track.stop());
        setRecordingStream(null);
        isRecordingRef.current = false;
        setIsRecording(false);
      };

      mediaRecorder.start();
    } catch (error) {
      logger.error("Failed to start recording:", error);
      alert(`Ошибка при записи: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [project, currentTime, onRecordingComplete]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecordingRef.current) {
      mediaRecorderRef.current.stop();
    }
  }, []);

  return { isRecording, startRecording, stopRecording, recordingStream };
};
