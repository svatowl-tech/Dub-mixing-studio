import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface PipelineTelemetry {
  currentPhase: number;
  stepName: string;
  overallProgress: number;
  stepProgress: number;
  logMessage: string;
  elapsedSeconds: number;
}

export interface PipelineConfig {
  executionId?: string;
  projectName?: string;
  originalAudioPath?: string;
  voiceAudioPaths?: string[];
  backgroundMusicPath?: string;
  outputDirectory?: string;
  targetDialogueLufs?: number;
  eqProfile?: string;
  declickSensitivity?: number;
  denoiseModel?: string;
  denoiseStrength?: number;
  vadOnsetDb?: number;
  vadOffsetDb?: number;
  smartAlignMaxStretch?: number;
  duckingAttenuationDb?: number;
  duckingAttackMs?: number;
  duckingReleaseMs?: number;
  vocalBusHpfHz?: number;
  vocalBusWarmthDb?: number;
  vocalBusCompressionRatio?: number;
  masterTargetLufs?: number;
  masterTruePeakCeiling?: number;
}

export interface PipelineStatusResponse {
  executionId: string;
  projectId: string;
  currentPhase: number;
  currentStep: string;
  overallProgress: number;
  isRunning: boolean;
  isPaused: boolean;
  isCancelled: boolean;
  elapsedSeconds: number;
  outputFiles: string[];
}

export class NativePipelineService {
  /**
   * Starts the autonomous native Rust pipeline state machine.
   * Runs in background Tokio runtime, independent of UI tab/window lifecycle.
   */
  static async startPipeline(projectId: string, settings: PipelineConfig = {}): Promise<string> {
    if (!isTauri()) {
      console.warn('[NativePipelineService] Not running inside Tauri. Mocking start.');
      return `mock_${Date.now()}`;
    }
    return await invoke<string>('start_pipeline_execution', { projectId, settings });
  }

  /**
   * Cancels the currently running pipeline via tokio_util::sync::CancellationToken.
   */
  static async cancelPipeline(executionId: string): Promise<boolean> {
    if (!isTauri()) return true;
    return await invoke<boolean>('cancel_pipeline_execution', { executionId });
  }

  /**
   * Pauses the pipeline execution in Rust.
   */
  static async pausePipeline(executionId: string): Promise<boolean> {
    if (!isTauri()) return true;
    return await invoke<boolean>('pause_pipeline_execution', { executionId });
  }

  /**
   * Resumes the paused pipeline execution in Rust.
   */
  static async resumePipeline(executionId: string): Promise<boolean> {
    if (!isTauri()) return true;
    return await invoke<boolean>('resume_pipeline_execution', { executionId });
  }

  /**
   * Queries the current status of the autonomous pipeline.
   */
  static async getStatus(executionId: string): Promise<PipelineStatusResponse | null> {
    if (!isTauri()) return null;
    return await invoke<PipelineStatusResponse>('get_pipeline_status', { executionId });
  }

  /**
   * Subscribes to real-time streaming telemetry emitted by the native pipeline.
   */
  static async onTelemetry(callback: (telemetry: PipelineTelemetry) => void): Promise<UnlistenFn> {
    if (!isTauri()) {
      return () => {};
    }
    return await listen<PipelineTelemetry>('pipeline-telemetry', (event) => {
      callback(event.payload);
    });
  }
}
