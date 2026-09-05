import { invoke } from "@tauri-apps/api/core";

export interface PluginMetadata {
  name: string;
  manufacturer: string;
  category: string;
  version: string;
  inputs: number;
  outputs: number;
  unique_id: number;
  path: string;
  format: string; // "VST2" or "VST3"
}

export interface PluginParameter {
  id: number;
  name: string;
  label: string;
  value: number;
}

const isTauriAvailable = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
};

export const scanPlugins = async (): Promise<PluginMetadata[]> => {
  if (!isTauriAvailable()) return [];
  try {
    return await invoke("scan_plugins");
  } catch (err) {
    console.warn("[VSTHost] scanPlugins error:", err);
    return [];
  }
};

export const loadPlugin = async (path: string): Promise<string> => {
  if (!isTauriAvailable()) throw new Error("VST плагины поддерживаются только в десктопной версии");
  return await invoke("load_plugin", { path });
};

export const unloadPlugin = async (instanceId: string): Promise<void> => {
  if (!isTauriAvailable()) return;
  try {
    return await invoke("unload_plugin", { instanceId });
  } catch (err) {
    console.warn("[VSTHost] unloadPlugin error:", err);
  }
};

export const processAudioBlock = async (
  instanceId: string,
  inputBuffer: Float32Array,
  sampleRate: number
): Promise<Float32Array> => {
  if (!isTauriAvailable()) return inputBuffer;
  try {
    const result: number[] = await invoke("process_audio_block", {
      instanceId,
      inputBuffer: Array.from(inputBuffer),
      sampleRate,
    });
    return new Float32Array(result);
  } catch (err) {
    console.warn("[VSTHost] processAudioBlock error:", err);
    return inputBuffer;
  }
};

export const getPluginParameters = async (
  instanceId: string
): Promise<PluginParameter[]> => {
  if (!isTauriAvailable()) return [];
  try {
    return await invoke("get_plugin_parameters", { instanceId });
  } catch (err) {
    console.warn("[VSTHost] getPluginParameters error:", err);
    return [];
  }
};

export const setPluginParameter = async (
  instanceId: string,
  paramId: number,
  value: number
): Promise<void> => {
  if (!isTauriAvailable()) return;
  try {
    return await invoke("set_plugin_parameter", { instanceId, paramId, value });
  } catch (err) {
    console.warn("[VSTHost] setPluginParameter error:", err);
  }
};

export const getPluginState = async (instanceId: string): Promise<string> => {
  if (!isTauriAvailable()) return "";
  try {
    return await invoke("get_plugin_state", { instanceId });
  } catch (err) {
    console.warn("[VSTHost] getPluginState error:", err);
    return "";
  }
};

export const setPluginState = async (
  instanceId: string,
  base64Data: string
): Promise<void> => {
  if (!isTauriAvailable()) return;
  try {
    return await invoke("set_plugin_state", { instanceId, base64Data });
  } catch (err) {
    console.warn("[VSTHost] setPluginState error:", err);
  }
};

export const openPluginEditor = async (instanceId: string): Promise<void> => {
  if (!isTauriAvailable()) return;
  try {
    return await invoke("open_plugin_editor", { instanceId });
  } catch (err) {
    console.warn("[VSTHost] openPluginEditor error:", err);
  }
};

export const closePluginEditor = async (instanceId: string): Promise<void> => {
  if (!isTauriAvailable()) return;
  try {
    return await invoke("close_plugin_editor", { instanceId });
  } catch (err) {
    console.warn("[VSTHost] closePluginEditor error:", err);
  }
};

export class VSTAudioWorkletNode extends AudioWorkletNode {
  private instanceId: string;
  private sampleRate: number;

  constructor(context: AudioContext, instanceId: string) {
    super(context, 'vst-processor');
    this.instanceId = instanceId;
    this.sampleRate = context.sampleRate;

    this.port.onmessage = (event) => {
      if (event.data.type === 'PROCESS_BLOCK') {
        this.handleProcessBlock(event.data.buffer);
      }
    };
  }

  private async handleProcessBlock(buffer: Float32Array) {
    try {
      const processed = await processAudioBlock(this.instanceId, buffer, this.sampleRate);
      this.port.postMessage({
        type: 'PROCESS_RESULT',
        buffer: processed,
      });
    } catch (err) {
      console.error("[VSTNode] Process error:", err);
    }
  }
}
