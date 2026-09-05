/**
 * DubStudio Pro - System Architecture
 * 
 * 1. Renderer Process (React + Vite):
 *    - UI Components: Video Player, Timeline (Wavesurfer), Script View, Teleprompter.
 *    - Audio Engine: Web Audio API for real-time recording, playback, and gain control.
 *    - State Management: React Context/Hooks for project data.
 * 
 * 2. Main Process (Electron - Simulated in Prototype):
 *    - File System: Access to local video/audio files.
 *    - FFmpeg Integration: For muxing audio tracks with video and exporting to WAV/MP3/FLAC.
 *    - SQLite: Persistent storage for projects and metadata.
 * 
 * 3. Data Flow:
 *    - Subtitles (ASS/SRT) -> Parser -> SubtitleLine Objects.
 *    - Recording -> MediaRecorder -> Blob -> AudioSegment.
 *    - Synchronization: requestAnimationFrame loop syncing Video.currentTime with Timeline and Teleprompter.
 */

export const ARCHITECTURE_DOC = "See comments above for architecture overview.";
