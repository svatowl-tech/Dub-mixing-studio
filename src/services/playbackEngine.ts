import { getSafeFileUrl, toNativeLocalPath } from '../lib/utils';
import { VSTAudioWorkletNode } from '../lib/vstHost';
import { IOLogger } from '../lib/ioLogger';
import { VocalBusWebAudioChain } from './vocalBusProcessor';
import { VocalBusRackConfig } from '../types';

async function callTauri(cmd: string, args?: Record<string, any>): Promise<any> {
  if (typeof window === 'undefined') return null;
  const isTauri = Boolean((window as any).__TAURI_INTERNALS__);
  if (!isTauri) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke(cmd, args);
  } catch (err) {
    console.warn(`[PlaybackEngine] Tauri invoke ${cmd} error:`, err);
    return null;
  }
}

function formatNativeTracks(tracks: any[]) {
  return (tracks || []).map(t => ({
    id: String(t.id),
    name: String(t.name || ''),
    volume: typeof t.volume === 'number' ? t.volume : 1.0,
    isMuted: Boolean(t.isMuted),
    isSolo: Boolean(t.isSolo),
    processing: t.processing || null,
    segments: (t.segments || [])
      .map((s: any) => {
        const rawPath = s.filePath || s.blobUrl || '';
        const nativePath = toNativeLocalPath(rawPath);
        return {
          id: String(s.id),
          filePath: nativePath,
          startTime: Number(s.startTime || 0),
          duration: Number(s.duration || 0),
          fileOffset: Number(s.fileOffset || 0),
          gain: typeof s.gain === 'number' ? s.gain : 1.0,
          panning: typeof s.panning === 'number' ? s.panning : 0.0,
          detectedFx: s.detectedFx || null,
        };
      })
      .filter((s: any) => s.filePath && !s.filePath.startsWith('blob:') && !s.filePath.startsWith('data:'))
  }));
}

function makeDistortionCurve(amount: number): Float32Array {
  const k = typeof amount === 'number' ? amount : 50;
  const n_samples = 44100;
  const curve = new Float32Array(n_samples);
  const deg = Math.PI / 180;
  for (let i = 0; i < n_samples; ++i) {
    const x = (i * 2) / n_samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

function createReverbImpulseResponse(ctx: AudioContext, decay: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.ceil(sampleRate * decay));
  const impulse = ctx.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);
  
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const decayFactor = Math.exp(-t * (4 / decay));
    const hfDamping = Math.exp(-t * (8 / decay));
    
    const leftNoise = (Math.random() * 2 - 1) * decayFactor;
    const rightNoise = (Math.random() * 2 - 1) * decayFactor;
    
    left[i] = leftNoise * (1 - 0.2 * hfDamping);
    right[i] = rightNoise * (1 - 0.2 * hfDamping);
  }
  return impulse;
}

export class PlaybackEngine {
  private audioContext: AudioContext | null = null;
  private sources: Map<string, AudioBufferSourceNode> = new Map();
  private gainNodes: Map<string, GainNode> = new Map();
  private pannerNodes: Map<string, StereoPannerNode> = new Map();
  private activeProcessingChains: Map<string, {
    gateNode?: DynamicsCompressorNode;
    deesserNode?: BiquadFilterNode;
    hpNode?: BiquadFilterNode;
    lpNode?: BiquadFilterNode;
    eqBandNodes?: BiquadFilterNode[];
    compressorNode?: DynamicsCompressorNode;
    reverbDryNode?: GainNode;
    reverbWetNode?: GainNode;
    reverbNode?: ConvolverNode;
    delayDryNode?: GainNode;
    delayWetNode?: GainNode;
    delayFeedbackNode?: GainNode;
    delayNode?: DelayNode;
    vstChains?: Array<{
      vstId: string;
      vstName: string;
      vstEnabled: boolean;
      inputNode: GainNode;
      outputNode: GainNode;
      dryNode?: GainNode;
      wetNode?: GainNode;
      nodes: AudioNode[];
    }>;
    cleanup: () => void;
  }> = new Map();
  private bufferCache: Map<string, AudioBuffer> = new Map();
  private pendingBuffers: Map<string, Promise<AudioBuffer | null>> = new Map();
  private isPlaying = false;
  private currentSessionId = 0;
  private startVideoTime = 0;
  private scheduledSegments: Set<string> = new Set();
  private lookaheadSeconds = 0.3; 
  private videoSource: MediaElementAudioSourceNode | null = null;
  private referenceSource: MediaElementAudioSourceNode | null = null;
  private videoGain: GainNode | null = null;
  private videoDelay: DelayNode | null = null;
  private referenceGain: GainNode | null = null;
  private dubbingGain: GainNode | null = null;
  private dubbingDelay: DelayNode | null = null;
  private vocalBusChain: VocalBusWebAudioChain | null = null;
  private cachedVocalBusConfig: VocalBusRackConfig | null = null;
  private cachedVocalBusBypass: boolean = false;
  private masterStreamDestination: MediaStreamAudioDestinationNode | null = null;
  private vocalBusStreamDestination: MediaStreamAudioDestinationNode | null = null;
  private masterGain: GainNode | null = null;
  private boundVideoElement: HTMLMediaElement | null = null;
  private boundReferenceElement: HTMLMediaElement | null = null;
  private audioOffsetMs = 0; 
  private currentTracks: any[] = [];
  private playOriginalTrackSegments = false;
  private workletInitialized = false;
  private isNativePlaying = false;
  private playingMetadata: Map<string, {
    videoStartTime: number;
    ctxStartTime: number;
    fileOffset: number;
    basePlaybackRate: number;
    seg: any;
    track: any;
    monoNode?: GainNode;
  }> = new Map();

  constructor() {}

  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
  }

  private createProcessingChain(
    ctx: AudioContext,
    processing: any,
    inputNode: AudioNode,
    destinationNode: AudioNode
  ) {
    if (!processing || !processing.enabled) {
      inputNode.connect(destinationNode);
      return {
        cleanup: () => {
          try { inputNode.disconnect(); } catch (e) {}
        }
      };
    }

    let activeInput = inputNode;
    let gateNode: DynamicsCompressorNode | undefined;
    let deesserNode: BiquadFilterNode | undefined;
    let hpNode: BiquadFilterNode | undefined;
    let lpNode: BiquadFilterNode | undefined;
    const eqBandNodes: BiquadFilterNode[] = [];
    let compressorNode: DynamicsCompressorNode | undefined;
    let reverbDryNode: GainNode | undefined;
    let reverbWetNode: GainNode | undefined;
    let reverbNode: ConvolverNode | undefined;
    let delayDryNode: GainNode | undefined;
    let delayWetNode: GainNode | undefined;
    let delayFeedbackNode: GainNode | undefined;
    let delayNode: DelayNode | undefined;
    const vstChains: Array<any> = [];

    // --- 1. De-esser ---
    if (processing.deesser?.enabled) {
      deesserNode = ctx.createBiquadFilter();
      deesserNode.type = 'peaking';
      deesserNode.frequency.value = processing.deesser.frequency ?? 6200;
      deesserNode.Q.value = 2.0;
      const thresh = processing.deesser.threshold ?? -12;
      deesserNode.gain.value = Math.min(0, thresh / 4);
      activeInput.connect(deesserNode);
      activeInput = deesserNode;
    }

    // --- 2. EQ highpass / lowpass ---
    if (processing.eq?.enabled) {
      if (processing.eq.highPass && processing.eq.highPass > 20) {
        hpNode = ctx.createBiquadFilter();
        hpNode.type = 'highpass';
        hpNode.frequency.value = processing.eq.highPass;
        activeInput.connect(hpNode);
        activeInput = hpNode;
      }
      if (processing.eq.lowPass && processing.eq.lowPass < 20000) {
        lpNode = ctx.createBiquadFilter();
        lpNode.type = 'lowpass';
        lpNode.frequency.value = processing.eq.lowPass;
        activeInput.connect(lpNode);
        activeInput = lpNode;
      }

      const bands = processing.eq.bands || [];
      if (bands.length > 0) {
        for (const band of bands) {
          const bNode = ctx.createBiquadFilter();
          bNode.type = band.type || 'peaking';
          bNode.frequency.value = band.freq;
          bNode.Q.value = band.q || 1.0;
          bNode.gain.value = band.gain || 0;
          activeInput.connect(bNode);
          activeInput = bNode;
          eqBandNodes.push(bNode);
        }
      } else {
        const standardFreqs = [220, 3200, 12000];
        for (let i = 0; i < 3; i++) {
          const bNode = ctx.createBiquadFilter();
          bNode.type = i === 2 ? 'highshelf' : 'peaking';
          bNode.frequency.value = standardFreqs[i];
          bNode.Q.value = 1.0;
          bNode.gain.value = 0;
          activeInput.connect(bNode);
          activeInput = bNode;
          eqBandNodes.push(bNode);
        }
      }
    }

    // --- 3. Compressor ---
    if (processing.compressor?.enabled) {
      compressorNode = ctx.createDynamicsCompressor();
      compressorNode.threshold.value = processing.compressor.threshold ?? -18;
      compressorNode.ratio.value = processing.compressor.ratio ?? 3.5;
      compressorNode.attack.value = (processing.compressor.attack ?? 15) / 1000;
      compressorNode.release.value = (processing.compressor.release ?? 200) / 1000;
      activeInput.connect(compressorNode);
      activeInput = compressorNode;
    }

    // --- 4. VST Plugins Rack ---
    if (processing.vstPlugins && processing.vstPlugins.length > 0) {
      for (const vst of processing.vstPlugins) {
        if (vst.bypass) continue;

        try {
          const vstNode = new VSTAudioWorkletNode(ctx, vst.id);
          activeInput.connect(vstNode);
          activeInput = vstNode;

          vstChains.push({
            vstId: vst.id,
            vstName: vst.name,
            vstEnabled: !vst.bypass,
            inputNode: vstNode,
            outputNode: vstNode,
            nodes: [vstNode]
          });
        } catch (err) {
          console.error(`[PlaybackEngine] Failed to create VST node for ${vst.name}:`, err);
        }
      }
    }

    // --- 5. Reverb ---
    if (processing.reverb?.enabled) {
      reverbDryNode = ctx.createGain();
      reverbWetNode = ctx.createGain();
      reverbNode = ctx.createConvolver();

      const wetVal = processing.reverb.wet ?? 0.12;
      reverbDryNode.gain.value = 1.0 - wetVal;
      reverbWetNode.gain.value = wetVal;

      const dVal = processing.reverb.decay ?? 1.6;
      reverbNode.buffer = createReverbImpulseResponse(ctx, dVal);

      activeInput.connect(reverbDryNode);
      activeInput.connect(reverbNode);
      reverbNode.connect(reverbWetNode);

      const reverbOutputSum = ctx.createGain();
      reverbDryNode.connect(reverbOutputSum);
      reverbWetNode.connect(reverbOutputSum);

      activeInput = reverbOutputSum;
    }

    // --- 6. Delay ---
    if (processing.delay?.enabled) {
      delayDryNode = ctx.createGain();
      delayWetNode = ctx.createGain();
      delayNode = ctx.createDelay(3.0);
      delayFeedbackNode = ctx.createGain();

      const wetVal = processing.delay.wet ?? 0.1;
      delayDryNode.gain.value = 1.0 - wetVal;
      delayWetNode.gain.value = wetVal;

      delayNode.delayTime.value = processing.delay.time ?? 0.3;
      delayFeedbackNode.gain.value = processing.delay.feedback ?? 0.3;

      delayNode.connect(delayFeedbackNode);
      delayFeedbackNode.connect(delayNode);

      activeInput.connect(delayDryNode);
      activeInput.connect(delayNode);
      delayNode.connect(delayWetNode);

      const delayOutputSum = ctx.createGain();
      delayDryNode.connect(delayOutputSum);
      delayWetNode.connect(delayOutputSum);

      activeInput = delayOutputSum;
    }

    activeInput.connect(destinationNode);

    const cleanup = () => {
      try { activeInput.disconnect(); } catch (e) {}
      try { inputNode.disconnect(); } catch (e) {}
      if (gateNode) { try { gateNode.disconnect(); } catch (e) {} }
      if (deesserNode) { try { deesserNode.disconnect(); } catch (e) {} }
      if (hpNode) { try { hpNode.disconnect(); } catch (e) {} }
      if (lpNode) { try { lpNode.disconnect(); } catch (e) {} }
      for (const bNode of eqBandNodes) { try { bNode.disconnect(); } catch (e) {} }
      if (compressorNode) { try { compressorNode.disconnect(); } catch (e) {} }
      if (reverbDryNode) { try { reverbDryNode.disconnect(); } catch (e) {} }
      if (reverbWetNode) { try { reverbWetNode.disconnect(); } catch (e) {} }
      if (reverbNode) { try { reverbNode.disconnect(); } catch (e) {} }
      if (delayDryNode) { try { delayDryNode.disconnect(); } catch (e) {} }
      if (delayWetNode) { try { delayWetNode.disconnect(); } catch (e) {} }
      if (delayFeedbackNode) { try { delayFeedbackNode.disconnect(); } catch (e) {} }
      if (delayNode) { try { delayNode.disconnect(); } catch (e) {} }

      for (const vstChain of vstChains) {
        try { vstChain.inputNode.disconnect(); } catch (e) {}
        try { vstChain.outputNode.disconnect(); } catch (e) {}
        if (vstChain.dryNode) { try { vstChain.dryNode.disconnect(); } catch (e) {} }
        if (vstChain.wetNode) { try { vstChain.wetNode.disconnect(); } catch (e) {} }
        for (const node of vstChain.nodes) {
          try { node.disconnect(); } catch (e) {}
        }
      }
    };

    return {
      gateNode,
      deesserNode,
      hpNode,
      lpNode,
      eqBandNodes,
      compressorNode,
      reverbDryNode,
      reverbWetNode,
      reverbNode,
      delayDryNode,
      delayWetNode,
      delayFeedbackNode,
      delayNode,
      vstChains,
      cleanup
    };
  }

  public setPlayOriginalTrackSegments(play: boolean) {
    this.playOriginalTrackSegments = play;
    console.log(`[PlaybackEngine] Play original track segments direct set to: ${play}`);
  }

  public async setAudioOffset(offsetMs: number) {
    this.audioOffsetMs = offsetMs;
    const ctx = await this.getContext();
    
    if (this.dubbingDelay && this.videoDelay) {
      const dubbingDelaySec = offsetMs > 0 ? offsetMs / 1000 : 0;
      const videoDelaySec = offsetMs < 0 ? Math.abs(offsetMs) / 1000 : 0;
      
      this.dubbingDelay.delayTime.setTargetAtTime(dubbingDelaySec, ctx.currentTime, 0.05);
      this.videoDelay.delayTime.setTargetAtTime(videoDelaySec, ctx.currentTime, 0.05);
      
      console.log(`[PlaybackEngine] Master Sync: Dubbing=${Math.round(dubbingDelaySec*1000)}ms, Original=${Math.round(videoDelaySec*1000)}ms`);
    }
  }

  private async getContext(): Promise<AudioContext> {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx({
        latencyHint: 'interactive',
        sampleRate: 48000,
      });
      
      console.log(`[PlaybackEngine] AudioContext initialized at ${this.audioContext.sampleRate}Hz (Tauri Runtime: ${this.isTauriRuntime()})`);

      if (!this.workletInitialized) {
        try {
          await this.audioContext.audioWorklet.addModule('/vst-processor.worklet.js');
          this.workletInitialized = true;
          console.log("[PlaybackEngine] VST AudioWorklet loaded");
        } catch (err) {
          console.error("[PlaybackEngine] Failed to load VST Worklet:", err);
        }
      }

      // Initialize Master Bus (Мастер-выход)
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = 1.0;

      // В десктопном режиме Tauri ВСЕГДА отключаем прямой вывод в браузерный destination,
      // чтобы ликвидировать дублирование звука, фазовый рассинхрон и фленджер.
      // Весь мастер-звук идет строго через нативный движок Tauri (CPAL/ASIO).
      if (!this.isTauriRuntime()) {
        this.masterGain.connect(this.audioContext.destination);
      }

      // Initialize Dubbing Bus
      this.dubbingGain = this.audioContext.createGain();
      this.dubbingDelay = this.audioContext.createDelay(4.0);
      
      this.vocalBusChain = new VocalBusWebAudioChain(this.audioContext);
      if (this.cachedVocalBusConfig) {
        this.vocalBusChain.updateConfig(this.cachedVocalBusConfig, this.cachedVocalBusBypass);
      }

      this.dubbingGain.connect(this.vocalBusChain.inputNode);
      this.vocalBusChain.outputNode.connect(this.dubbingDelay);
      this.dubbingDelay.connect(this.masterGain);

      // Initialize Original/Video Bus
      this.videoGain = this.audioContext.createGain();
      this.videoDelay = this.audioContext.createDelay(4.0);
      this.videoGain.connect(this.videoDelay);
      this.videoDelay.connect(this.masterGain);

      // Reference track gain
      this.referenceGain = this.audioContext.createGain();
      this.referenceGain.gain.value = 0;
      this.referenceGain.connect(this.videoDelay); 
    }

    if (this.isTauriRuntime() && this.masterGain && this.audioContext) {
      try {
        this.masterGain.disconnect(this.audioContext.destination);
      } catch (_) {}
    }

    return this.audioContext;
  }

  public setVocalBusVolume(volume: number, isMuted: boolean = false) {
    if (this.dubbingGain && this.audioContext) {
      const targetGain = isMuted ? 0 : Math.max(0, volume);
      try {
        this.dubbingGain.gain.setTargetAtTime(targetGain, this.audioContext.currentTime, 0.02);
      } catch (_) {
        this.dubbingGain.gain.value = targetGain;
      }
    }
    if (this.isTauriRuntime()) {
      callTauri('set_vocal_bus_volume', { volume: isMuted ? 0 : Math.max(0, volume) }).catch(() => {});
    }
  }

  public setVocalBusDspConfig(config: VocalBusRackConfig | null | undefined, bypass: boolean = false) {
    this.cachedVocalBusConfig = config || null;
    this.cachedVocalBusBypass = bypass;
    if (this.vocalBusChain) {
      this.vocalBusChain.updateConfig(config, bypass);
    }
  }

  public getVocalBusDspChain(): VocalBusWebAudioChain | null {
    return this.vocalBusChain;
  }

  public setMasterVolume(volume: number) {
    if (this.masterGain && this.audioContext) {
      const targetGain = Math.max(0, volume);
      try {
        this.masterGain.gain.setTargetAtTime(targetGain, this.audioContext.currentTime, 0.02);
      } catch (_) {
        this.masterGain.gain.value = targetGain;
      }
    }
    if (this.isTauriRuntime()) {
      callTauri('set_master_volume', { volume: Math.max(0, volume) }).catch(() => {});
    }
  }

  public getCurrentTime(): number {
    return this.audioContext ? this.audioContext.currentTime : 0;
  }

  public getMasterStream(): MediaStream | null {
    if (!this.audioContext || !this.masterGain) return null;
    if (!this.masterStreamDestination) {
      try {
        this.masterStreamDestination = this.audioContext.createMediaStreamDestination();
        this.masterGain.connect(this.masterStreamDestination);
      } catch (e) {
        console.warn("[PlaybackEngine] Failed to connect masterStreamDestination:", e);
      }
    }
    return this.masterStreamDestination?.stream || null;
  }

  public getVocalBusStream(): MediaStream | null {
    if (!this.audioContext) return null;
    if (!this.vocalBusStreamDestination) {
      try {
        this.vocalBusStreamDestination = this.audioContext.createMediaStreamDestination();
        if (this.dubbingDelay) {
          this.dubbingDelay.connect(this.vocalBusStreamDestination);
        } else if (this.dubbingGain) {
          this.dubbingGain.connect(this.vocalBusStreamDestination);
        }
      } catch (e) {
        console.warn("[PlaybackEngine] Failed to connect vocalBusStreamDestination:", e);
      }
    }
    return this.vocalBusStreamDestination?.stream || null;
  }

  public clearCache(targetUrlOrPath?: string) {
    if (targetUrlOrPath) {
      this.bufferCache.delete(targetUrlOrPath);
      this.pendingBuffers.delete(targetUrlOrPath);
      for (const [key] of this.bufferCache) {
        if (key.includes(targetUrlOrPath)) {
          this.bufferCache.delete(key);
        }
      }
    } else {
      this.bufferCache.clear();
      this.pendingBuffers.clear();
      callTauri('clear_native_playback_cache').catch(() => {});
    }
    console.log("[PlaybackEngine] Cache cleared", targetUrlOrPath || 'ALL');
  }

  public async preloadProjectBuffers(tracks: any[]): Promise<void> {
    const filePaths: string[] = [];
    const urlsToPreload: { url: string; filePath?: string }[] = [];

    for (const track of tracks) {
      for (const seg of (track.segments || [])) {
        if (seg.filePath && !seg.filePath.startsWith('blob:') && !seg.filePath.startsWith('data:')) {
          filePaths.push(seg.filePath);
        }
        const u = (seg as any).url || seg.blobUrl || (seg.filePath ? getSafeFileUrl(seg.filePath) : null);
        if (u) {
          urlsToPreload.push({ url: u, filePath: seg.filePath });
        }
      }
    }

    if (filePaths.length > 0) {
      callTauri('preload_playback_buffers', { filePaths: Array.from(new Set(filePaths)) }).catch(console.warn);
    }

    const chunkSize = 8;
    for (let i = 0; i < urlsToPreload.length; i += chunkSize) {
      const chunk = urlsToPreload.slice(i, i + chunkSize);
      await Promise.allSettled(chunk.map(item => this.loadBuffer(item.url, item.filePath)));
    }
  }

  public async bindVideoElement(video: HTMLMediaElement) {
    if (this.boundVideoElement === video) return;
    console.log("[PlaybackEngine] Binding video element for native direct routing...");
    
    try {
      this.boundVideoElement = video;
      this.videoSource = null as any;
      
      // Отключаем прямой вывод звука HTML5 видеоплеера для устранения двойного воспроизведения
      video.volume = 0;
      video.muted = true;
      
      const ctx = await this.getContext();
      if (!this.videoGain) {
        this.videoGain = ctx.createGain();
        this.videoGain.gain.value = 1.0;
      }

      if (!this.videoDelay) {
        this.videoDelay = ctx.createDelay(4.0);
        this.videoDelay.delayTime.value = this.audioOffsetMs < 0 ? Math.abs(this.audioOffsetMs) / 1000 : 0;
      }
      
      if (this.videoGain.numberOfOutputs === 0) {
         try { this.videoGain.disconnect(); } catch(e){}
         this.videoGain.connect(this.videoDelay);
      }
      
      console.log("[PlaybackEngine] Video element bound and muted for native direct playback");
    } catch (e) {
      console.warn("[PlaybackEngine] Failed to bind video element:", e);
    }
  }

  public async bindReferenceAudio(audio: HTMLMediaElement) {
    if (this.boundReferenceElement === audio) return;
    console.log("[PlaybackEngine] Binding reference audio for native direct routing...");
    
    try {
      this.boundReferenceElement = audio;
      this.referenceSource = null as any;
      
      // Отключаем прямой звук HTML5 аудио элемента
      audio.volume = 0;
      audio.muted = true;
      
      const ctx = await this.getContext();
      if (!this.referenceGain) {
        this.referenceGain = ctx.createGain();
        this.referenceGain.gain.value = 0.0;
      }
      
      if (this.videoDelay) {
         try { this.referenceGain.disconnect(); } catch(e) {}
         this.referenceGain.connect(this.videoDelay);
      } else {
         try { this.referenceGain.disconnect(); } catch(e) {}
         if (!this.isTauriRuntime()) {
           this.referenceGain.connect(ctx.destination);
         }
      }
      
      console.log("[PlaybackEngine] Reference audio bound and muted for native direct playback");
    } catch (e) {
      console.warn("[PlaybackEngine] Failed to bind reference audio:", e);
    }
  }

  public async loadBuffer(url: string, filePath?: string): Promise<AudioBuffer | null> {
    if (this.bufferCache.has(url)) {
      return this.bufferCache.get(url)!;
    }

    if (this.pendingBuffers.has(url)) {
      return this.pendingBuffers.get(url)!;
    }
    
    if (this.bufferCache.size > 200) {
      console.log("[PlaybackEngine] Cache size exceeded 200, pruning cache to save memory");
      
      const activeUrls = new Set<string>();
      activeUrls.add(url);

      const currentVideoTime = this.boundVideoElement ? this.boundVideoElement.currentTime : 0;
      
      this.playingMetadata.forEach((meta) => {
        const activeUrl = (meta.seg as any).url || meta.seg.blobUrl || (meta.seg.filePath ? getSafeFileUrl(meta.seg.filePath) : null);
        if (activeUrl) activeUrls.add(activeUrl);
      });

      this.currentTracks.forEach(track => {
        track.segments.forEach((seg: any) => {
           if (seg.startTime <= currentVideoTime + 5 && seg.startTime + seg.duration >= currentVideoTime) {
               const activeUrl = seg.url || seg.blobUrl || (seg.filePath ? getSafeFileUrl(seg.filePath) : null);
               if (activeUrl) activeUrls.add(activeUrl);
           }
        });
      });

      for (const [cacheUrl] of this.bufferCache) {
        if (!activeUrls.has(cacheUrl)) {
          this.bufferCache.delete(cacheUrl);
        }
      }
    }

    const loadPromise = (async () => {
      IOLogger.log('MEDIA', 'loadBuffer', 'START', { url, filePath });
      try {
        const ctx = await this.getContext();
        
        const isTauriEnv = this.isTauriRuntime();
        const globalCache = (window as any).webFileCache;
        let fileOrBlob: Blob | File | undefined;
        if (!isTauriEnv && globalCache) {
          if (url) {
            fileOrBlob = globalCache.get(url);
          }
          if (!fileOrBlob && filePath) {
            fileOrBlob = globalCache.get(filePath);
            if (!fileOrBlob) {
              const basename = filePath.split(/[/\\]/).pop();
              if (basename) fileOrBlob = globalCache.get(basename);
            }
          }
        }

        let arrayBuffer: ArrayBuffer;
        if (fileOrBlob) {
          arrayBuffer = await fileOrBlob.arrayBuffer();
        } else {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          arrayBuffer = await response.arrayBuffer();
        }
        
        let audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        IOLogger.log('MEDIA', 'loadBuffer', 'SUCCESS', { url, duration: audioBuffer.duration, channels: audioBuffer.numberOfChannels });
        
        this.bufferCache.set(url, audioBuffer);
        return audioBuffer;
      } catch (e) {
        IOLogger.log('MEDIA', 'loadBuffer', 'ERROR', { url }, String(e));
        console.error("[PlaybackEngine] Failed to load audio buffer:", url, e);
        return null;
      } finally {
        this.pendingBuffers.delete(url);
      }
    })();

    this.pendingBuffers.set(url, loadPromise);
    return loadPromise;
  }

  public async play(tracks: any[], currentTime: number) {
    const ctx = await this.getContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    
    this.stop(); 
    this.isPlaying = true;
    this.currentSessionId = Date.now();
    this.startVideoTime = currentTime;
    this.scheduledSegments.clear();
    this.currentTracks = tracks;

    // В десктопном режиме Tauri:
    // 1. Полностью отключаем запуск браузерных BufferSourceNode к динамикам.
    // 2. Отключаем masterGain от destination (гарантия 0% браузерного звука).
    // 3. Передаем управление нативному аудио-движку CPAL (Rust).
    if (this.isTauriRuntime()) {
      this.isNativePlaying = true;
      if (this.masterGain) {
        try { this.masterGain.disconnect(ctx.destination); } catch (_) {}
      }
      const nativeTracks = formatNativeTracks(tracks);
      try {
        await callTauri('start_native_playback', { tracks: nativeTracks, startTime: currentTime });
        await callTauri('transport_play');
      } catch (err) {
        console.warn("[PlaybackEngine] Native Tauri playback start error:", err);
      }
      return;
    }
    
    const outputLatency = (ctx as any).outputLatency || 0;
    console.log(`[PlaybackEngine] Starting browser playback. Context latency: ${Math.round(outputLatency * 1000)}ms`);
    
    this.tick(currentTime, tracks);
  }

  private async performSync() {
    if (!this.boundVideoElement || !this.isPlaying || this.isTauriRuntime() || this.isNativePlaying) return;
    
    const ctx = await this.getContext();
    const videoTime = this.boundVideoElement.currentTime;
    const videoRate = this.boundVideoElement.playbackRate;

    this.sources.forEach((source, segId) => {
      const meta = this.playingMetadata.get(segId);
      if (!meta) {
        this.sources.delete(segId);
        return;
      }

      const videoEnd = meta.seg.startTime + meta.seg.duration;
      if (videoTime > videoEnd + 0.1) {
        try { source.stop(); source.disconnect(); } catch(e) {}
        if (meta.monoNode) { try { meta.monoNode.disconnect(); } catch(e) {} }
        this.sources.delete(segId);
        const gain = this.gainNodes.get(segId);
        if (gain) {
          try { gain.disconnect(); } catch(e) {}
          this.gainNodes.delete(segId);
        }
        this.playingMetadata.delete(segId);
        this.scheduledSegments.delete(segId);
        return;
      }

      const elapsedVideoTime = videoTime - meta.videoStartTime;
      const elapsedCtxTime = ctx.currentTime - meta.ctxStartTime;
      const isVideoBufferingOrStarting = elapsedVideoTime < 0.5 || elapsedCtxTime < 0.5;

      const expectedElapsedCtxTime = elapsedVideoTime / videoRate;
      const drift = expectedElapsedCtxTime - elapsedCtxTime;
      const driftMs = drift * 1000;

      if (isVideoBufferingOrStarting) {
        source.playbackRate.setTargetAtTime(
          meta.basePlaybackRate * videoRate, 
          ctx.currentTime, 
          0.1
        );
        return;
      }

      if (Math.abs(driftMs) > 1000) {
        console.log(`[PlaybackEngine] Master Sync (Restarting) for ${segId}: ${Math.round(driftMs)}ms drift.`);
        this.restartSegment(meta.track, meta.seg);
      } else if (Math.abs(driftMs) >= 120) {
        const errorRatio = Math.max(-0.06, Math.min(0.06, drift * 0.5)); 
        const correction = 1.0 + errorRatio;
        
        source.playbackRate.setTargetAtTime(
          meta.basePlaybackRate * videoRate * correction, 
          ctx.currentTime, 
          0.15
        );
      } else {
        source.playbackRate.setTargetAtTime(
          meta.basePlaybackRate * videoRate, 
          ctx.currentTime, 
          0.15
        );
      }
    });
  }

  private async restartSegment(track: any, seg: any) {
    const ctx = await this.getContext();
    const source = this.sources.get(seg.id);
    const now = ctx.currentTime;
    
    if (source) {
      const gain = this.gainNodes.get(seg.id);
      const meta = this.playingMetadata.get(seg.id);
      const chain = this.activeProcessingChains.get(seg.id);
      
      const fadeOutTime = 0.01;
      if (gain) {
        gain.gain.setTargetAtTime(0, now, fadeOutTime / 2);
      }
      
      setTimeout(() => {
        try { source.stop(); source.disconnect(); } catch(e) {}
        if (meta?.monoNode) { try { meta.monoNode.disconnect(); } catch(e) {} }
        if (chain) { try { chain.cleanup(); } catch(e) {} }
        if (gain) { try { gain.disconnect(); } catch(e) {} }
        const panner = this.pannerNodes.get(seg.id);
        if (panner) { try { panner.disconnect(); } catch(e) {} }
      }, fadeOutTime * 1000 + 50);

      this.sources.delete(seg.id);
      this.gainNodes.delete(seg.id);
      this.pannerNodes.delete(seg.id);
      this.activeProcessingChains.delete(seg.id);
      this.playingMetadata.delete(seg.id);
      this.scheduledSegments.delete(seg.id);
    }
  }

  public async tick(currentVideoTime: number, tracks: any[]) {
    if (!this.isPlaying) return;

    // В десктопном режиме Tauri все воспроизведение и синхронизация ведутся нативно в Rust CPAL
    if (this.isTauriRuntime() || this.isNativePlaying) {
      return;
    }

    await this.performSync();

    const ctx = await this.getContext();
    const sessionId = this.currentSessionId;
    const now = ctx.currentTime;
    
    const liveVideoTime = this.boundVideoElement ? this.boundVideoElement.currentTime : currentVideoTime;
    const playbackRate = this.boundVideoElement ? this.boundVideoElement.playbackRate : 1.0;
    
    this.sources.forEach((source, segId) => {
      const meta = this.playingMetadata.get(segId);
      if (meta && liveVideoTime > meta.seg.startTime + meta.seg.duration + 0.1) {
        try { source.stop(); source.disconnect(); } catch(e) {}
        if (meta.monoNode) { try { meta.monoNode.disconnect(); } catch(e) {} }
        this.sources.delete(segId);
        const gain = this.gainNodes.get(segId);
        if (gain) {
          try { gain.disconnect(); } catch(e) {}
          this.gainNodes.delete(segId);
        }
        const panner = this.pannerNodes.get(segId);
        if (panner) {
          try { panner.disconnect(); } catch(e) {}
          this.pannerNodes.delete(segId);
        }
        const chain = this.activeProcessingChains.get(segId);
        if (chain) {
          try { chain.cleanup(); } catch (e) {}
          this.activeProcessingChains.delete(segId);
        }
        this.playingMetadata.delete(segId);
        this.scheduledSegments.delete(segId);
      }
    });

    const lookaheadEnd = liveVideoTime + this.lookaheadSeconds * playbackRate;

    const anySolo = tracks.some(t => t.isSolo);
    const originalTrack = tracks.find(t => {
      const n = t.name?.toLowerCase() || '';
      return n.includes('оригинал') || n.includes('original');
    });
    const referenceTrack = tracks.find(t => t.id === 'reference-track' || (t.name?.toLowerCase().includes('reference')));

    if (this.videoGain) {
      const isOriginalActive = anySolo 
        ? (originalTrack?.isSolo || false) 
        : !(originalTrack?.isMuted || false);
      const targetVolume = isOriginalActive ? (originalTrack?.volume ?? 1) : 0;
      this.videoGain.gain.setTargetAtTime(targetVolume, now, 0.03);
    }

    if (this.boundVideoElement) {
      this.boundVideoElement.volume = 0;
      this.boundVideoElement.muted = true;
    }

    if (this.referenceGain) {
      const isRefActive = anySolo
        ? (referenceTrack?.isSolo || false)
        : !(referenceTrack?.isMuted || false);
      const targetVolume = isRefActive ? (referenceTrack?.volume ?? 1) : 0;
      this.referenceGain.gain.setTargetAtTime(targetVolume, now, 0.03);
    }

    if (this.boundReferenceElement) {
      this.boundReferenceElement.volume = 0;
      this.boundReferenceElement.muted = true;
    }

    const activeTracks = anySolo 
      ? tracks.filter(t => t.isSolo) 
      : tracks.filter(t => !t.isMuted);

    for (const track of activeTracks) {
      const lowerName = track.name?.toLowerCase() || '';
      const isOriginalOrRef = lowerName.includes('оригинал') || lowerName.includes('original') || track.id === 'reference-track' || lowerName.includes('reference');
      if (isOriginalOrRef && !this.playOriginalTrackSegments) {
        continue;
      }

      for (const seg of track.segments) {
        const segmentEnd = seg.startTime + seg.duration;
        
        if (seg.startTime <= lookaheadEnd && segmentEnd > liveVideoTime && !this.scheduledSegments.has(seg.id)) {
          this.scheduledSegments.add(seg.id);
          
          let urlToLoad: string | null = null;
          if (this.isTauriRuntime() && seg.filePath && !seg.filePath.startsWith('blob:') && !seg.filePath.startsWith('data:')) {
            const diskUrl = getSafeFileUrl(seg.filePath);
            urlToLoad = diskUrl || (seg as any).url || seg.blobUrl || null;
          } else {
            urlToLoad = (seg as any).url || seg.blobUrl || (seg.filePath ? getSafeFileUrl(seg.filePath) : null);
          }
          if (!urlToLoad) continue;

          this.loadBuffer(urlToLoad, seg.filePath).then(buffer => {
            if (!buffer || !this.isPlaying || sessionId !== this.currentSessionId) return;

            const freshCtxTime = ctx.currentTime;
            const freshVideoTime = this.boundVideoElement ? this.boundVideoElement.currentTime : liveVideoTime;
            const currentVideoRate = this.boundVideoElement ? this.boundVideoElement.playbackRate : playbackRate;

            if (freshVideoTime > seg.startTime + seg.duration) {
              return;
            }

            const schedulingDelay = 0.02;
            let when: number;
            let bufferOffset: number;
            let timeOffsetInSegment: number;

            const audioStartVideoTime = freshVideoTime + (schedulingDelay * currentVideoRate);

            if (freshVideoTime > seg.startTime) {
              timeOffsetInSegment = freshVideoTime - seg.startTime;
              when = freshCtxTime + schedulingDelay;
              bufferOffset = (seg.fileOffset || 0) + timeOffsetInSegment;
            } else {
              timeOffsetInSegment = 0;
              const timeUntilStart = (seg.startTime - freshVideoTime) / currentVideoRate;
              when = freshCtxTime + timeUntilStart;
              bufferOffset = seg.fileOffset || 0;
            }

            bufferOffset = Math.max(0, bufferOffset);
            
            const remainingBuffer = Math.max(0, buffer.duration - bufferOffset);
            const remainingTimelineDuration = Math.max(0, seg.duration - timeOffsetInSegment);
            const duration = Math.min(remainingTimelineDuration, remainingBuffer);

            if (duration <= 0 || bufferOffset >= buffer.duration) return;

            const source = ctx.createBufferSource();
            source.buffer = buffer;
            
            const baseRate = 1.0; 
            source.playbackRate.value = baseRate * currentVideoRate;

            const gainNode = ctx.createGain();
            const baseVolume = (seg.gain !== undefined ? seg.gain : 1.0) * (track.volume !== undefined ? track.volume : 1);
            const FADE_TIME = 0.003;
            
            gainNode.gain.setValueAtTime(0, when);
            gainNode.gain.linearRampToValueAtTime(baseVolume, when + FADE_TIME);

            source.connect(gainNode);

            const pannerNode = ctx.createStereoPanner();
            pannerNode.pan.setValueAtTime(seg.panning !== undefined ? seg.panning : 0.0, when);
            this.pannerNodes.set(seg.id, pannerNode);
            gainNode.connect(pannerNode);

            const lowerTrackName = (track.name || '').toLowerCase();
            const isOriginalOrRefTrack = lowerTrackName.includes('оригинал') || lowerTrackName.includes('original') || track.id === 'reference-track' || lowerTrackName.includes('reference');
            const destNode = isOriginalOrRefTrack 
              ? (this.videoGain || ctx.destination) 
              : (this.dubbingGain || ctx.destination);

            if (track.processing && track.processing.enabled) {
              const chain = this.createProcessingChain(ctx, track.processing, pannerNode, destNode);
              this.activeProcessingChains.set(seg.id, chain);
            } else {
              pannerNode.connect(destNode);
            }
            source.start(when, Math.max(0, bufferOffset), Math.max(0, duration));
            
            const fadeOutStart = when + duration - FADE_TIME;
            gainNode.gain.setValueAtTime(baseVolume, Math.max(when, fadeOutStart));
            gainNode.gain.linearRampToValueAtTime(0, when + duration);
            
            this.sources.set(seg.id, source);
            this.gainNodes.set(seg.id, gainNode);

            this.playingMetadata.set(seg.id, {
              videoStartTime: freshVideoTime > seg.startTime ? audioStartVideoTime : seg.startTime,
              ctxStartTime: when,
              fileOffset: bufferOffset,
              basePlaybackRate: baseRate,
              seg,
              track,
            });
          });
        }
      }
    }
  }

  public stop() {
    this.isPlaying = false;
    this.currentSessionId = Date.now();
    this.scheduledSegments.clear();
    this.currentTracks = [];

    if (this.isTauriRuntime() || this.isNativePlaying) {
      this.isNativePlaying = false;
      callTauri('stop_native_playback').catch(() => {});
      callTauri('transport_pause').catch(() => {});
    }
    
    this.sources.forEach((source, segId) => {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {}
      const meta = this.playingMetadata.get(segId);
      if (meta && meta.monoNode) {
        try {
          meta.monoNode.disconnect();
        } catch (e) {}
      }
    });
    this.sources.clear();
    this.gainNodes.forEach(gain => {
      try {
        gain.disconnect();
      } catch (e) {}
    });
    this.gainNodes.clear();
    this.pannerNodes.forEach(pan => {
      try {
        pan.disconnect();
      } catch (e) {}
    });
    this.pannerNodes.clear();
    this.activeProcessingChains.forEach(chain => {
      try { chain.cleanup(); } catch (e) {}
    });
    this.activeProcessingChains.clear();
    this.playingMetadata.clear();
  }

  public async reconcile(tracks: any[]) {
    this.currentTracks = tracks;

    if (this.isTauriRuntime() || this.isNativePlaying) {
      const nativeTracks = formatNativeTracks(tracks);
      callTauri('update_native_playback_tracks', { tracks: nativeTracks }).catch(() => {});
      return;
    }

    if (!this.isPlaying) return;

    const ctx = await this.getContext();
    const liveVideoTime = this.boundVideoElement ? this.boundVideoElement.currentTime : 0;
    
    const activeSegmentIds = new Set<string>();
    tracks.forEach(track => {
      track.segments.forEach((seg: any) => activeSegmentIds.add(String(seg.id)));
    });

    this.sources.forEach((source, segId) => {
      if (!activeSegmentIds.has(segId)) {
        console.log(`[PlaybackEngine] Reconcile: Stopping removed segment ${segId}`);
        this.restartSegment(null, { id: segId });
      }
    });

    this.scheduledSegments.forEach(segId => {
      if (!activeSegmentIds.has(segId)) {
        this.scheduledSegments.delete(segId);
      }
    });

    await this.updateTracks(tracks);
    await this.tick(liveVideoTime, tracks);
    
    console.log("[PlaybackEngine] Reconciliation complete");
  }

  public async seek(currentTime: number, tracks: any[]) {
    const wasPlaying = this.isPlaying;
    this.stop();
    
    this.currentTracks = tracks;

    if (this.isTauriRuntime()) {
      const nativeTracks = formatNativeTracks(tracks);
      callTauri('transport_seek_ms', { targetMs: Math.max(0, currentTime * 1000) }).catch(() => {});
      callTauri('seek_native_playback', { time: currentTime }).catch(() => {});

      if (wasPlaying) {
        this.isPlaying = true;
        this.isNativePlaying = true;
        callTauri('start_native_playback', { tracks: nativeTracks, startTime: currentTime }).catch(() => {});
        callTauri('transport_play').catch(() => {});
      }
      return;
    }
    
    if (wasPlaying) {
      this.isPlaying = true;
      this.currentSessionId = Date.now();
    }
    await this.tick(currentTime, tracks);
  }

  public async updateTracks(tracks: any[]) {
    this.currentTracks = tracks;

    if (this.isTauriRuntime() || this.isNativePlaying) {
      const nativeTracks = formatNativeTracks(tracks);
      callTauri('update_native_playback_tracks', { tracks: nativeTracks }).catch(() => {});
      return;
    }

    if (!this.isPlaying) return;

    const ctx = await this.getContext();
    const anySolo = tracks.some(t => t.isSolo);
    
    const originalTrack = tracks.find(t => {
      const n = t.name?.toLowerCase() || '';
      return n.includes('оригинал') || n.includes('original');
    });
    const referenceTrack = tracks.find(t => t.id === 'reference-track' || (t.name?.toLowerCase().includes('reference')));

    if (this.videoGain) {
      const isOriginalActive = anySolo 
        ? (originalTrack?.isSolo || false) 
        : !(originalTrack?.isMuted || false);
      const targetVolume = isOriginalActive ? (originalTrack?.volume ?? 1) : 0;
      this.videoGain.gain.setTargetAtTime(targetVolume, ctx.currentTime, 0.03);
    }

    if (this.referenceGain) {
      const isRefActive = anySolo
        ? (referenceTrack?.isSolo || false)
        : !(referenceTrack?.isMuted || false);
      const targetVolume = isRefActive ? (referenceTrack?.volume ?? 1) : 0;
      this.referenceGain.gain.setTargetAtTime(targetVolume, ctx.currentTime, 0.03);
    }

    const currentPlaybackRate = this.boundVideoElement ? this.boundVideoElement.playbackRate : 1.0;

    tracks.forEach(track => {
      const isTrackActive = anySolo ? track.isSolo : !track.isMuted;
      
      track.segments.forEach((seg: any) => {
        const gainNode = this.gainNodes.get(seg.id);
        const now = ctx.currentTime;
        if (gainNode) {
          const targetGain = isTrackActive ? (seg.gain !== undefined ? seg.gain : 1.0) * (track.volume !== undefined ? track.volume : 1) : 0;
          gainNode.gain.setTargetAtTime(targetGain, now, 0.02);
        }

        const pannerNode = this.pannerNodes.get(seg.id);
        if (pannerNode) {
          const targetPan = seg.panning !== undefined ? seg.panning : 0.0;
          pannerNode.pan.setTargetAtTime(targetPan, now, 0.02);
        }

        const source = this.sources.get(seg.id);
        if (source && this.boundVideoElement) {
          source.playbackRate.setTargetAtTime(1.0 * currentPlaybackRate, now, 0.02);
        }

        const chain = this.activeProcessingChains.get(seg.id);
        if (chain && track.processing && track.processing.enabled) {
          this.applyProcessingParams(chain, track.processing, now);
        }
      });
    });
  }

  private applyProcessingParams(chain: any, proc: any, now: number) {
    if (chain.gateNode && proc.noiseGate?.enabled) {
      chain.gateNode.threshold.setTargetAtTime(proc.noiseGate.threshold ?? -45, now, 0.05);
    }
    
    if (chain.deesserNode && proc.deesser?.enabled) {
      chain.deesserNode.frequency.setTargetAtTime(proc.deesser.frequency ?? 6200, now, 0.05);
      const thresh = proc.deesser.threshold ?? -12;
      chain.deesserNode.gain.setTargetAtTime(Math.min(0, thresh / 4), now, 0.05);
    }
    
    if (chain.hpNode && proc.eq?.enabled && proc.eq.highPass) {
      chain.hpNode.frequency.setTargetAtTime(proc.eq.highPass, now, 0.05);
    }
    if (chain.lpNode && proc.eq?.enabled && proc.eq.lowPass) {
      chain.lpNode.frequency.setTargetAtTime(proc.eq.lowPass, now, 0.05);
    }
    if (chain.eqBandNodes && proc.eq?.enabled) {
      const bands = proc.eq.bands || [];
      bands.forEach((b: any, index: number) => {
        const bNode = chain.eqBandNodes?.[index];
        if (bNode) {
          bNode.frequency.setTargetAtTime(b.freq, now, 0.05);
          bNode.gain.setTargetAtTime(b.gain || 0, now, 0.05);
          bNode.Q.setTargetAtTime(b.q || 1.0, now, 0.05);
        }
      });
    }
    
    if (chain.compressorNode && proc.compressor?.enabled) {
      chain.compressorNode.threshold.setTargetAtTime(proc.compressor.threshold ?? -18, now, 0.05);
      chain.compressorNode.ratio.setTargetAtTime(proc.compressor.ratio ?? 3.5, now, 0.05);
      chain.compressorNode.attack.setTargetAtTime((proc.compressor.attack ?? 15) / 1000, now, 0.05);
      chain.compressorNode.release.setTargetAtTime((proc.compressor.release ?? 200) / 1000, now, 0.05);
    }
    
    if (chain.reverbDryNode && chain.reverbWetNode && proc.reverb?.enabled) {
      const wetVal = proc.reverb.wet ?? 0.12;
      chain.reverbDryNode.gain.setTargetAtTime(1.0 - wetVal, now, 0.05);
      chain.reverbWetNode.gain.setTargetAtTime(wetVal, now, 0.05);
    }
    
    if (chain.delayDryNode && chain.delayWetNode && chain.delayNode && chain.delayFeedbackNode && proc.delay?.enabled) {
      const wetVal = proc.delay.wet ?? 0.1;
      chain.delayDryNode.gain.setTargetAtTime(1.0 - wetVal, now, 0.05);
      chain.delayWetNode.gain.setTargetAtTime(wetVal, now, 0.05);
      chain.delayNode.delayTime.setTargetAtTime(proc.delay.time ?? 0.3, now, 0.05);
      chain.delayFeedbackNode.gain.setTargetAtTime(proc.delay.feedback ?? 0.3, now, 0.05);
    }

    if (chain.vstChains && proc.vstPlugins && proc.vstPlugins.length > 0) {
      proc.vstPlugins.forEach((vst: any) => {
        const vstChain = chain.vstChains?.find((vc: any) => vc.vstId === vst.id);
        if (vstChain) {
          const wetLevel = (vst.params['Mix/Wet'] ?? 100) / 100;
          const gainLevel = Math.pow(10, ((vst.params['Gain'] ?? 50) - 50) / 40);
          
          vstChain.dryNode?.gain.setTargetAtTime(1 - (vst.enabled ? wetLevel : 0), now, 0.05);
          vstChain.wetNode?.gain.setTargetAtTime((vst.enabled ? wetLevel : 0) * gainLevel, now, 0.05);
          
          const nameLower = vst.name.toLowerCase();
          if (nameLower.includes('pro-q') || nameLower.includes('eq') || nameLower.includes('equalizer')) {
            const calculatedGain = (vst.params['Gain'] - 50) * 0.3;
            vstChain.nodes.forEach((n: any) => {
              if (n.type === 'lowshelf') n.gain.setTargetAtTime(calculatedGain * 0.8, now, 0.05);
              if (n.type === 'peaking') n.gain.setTargetAtTime(calculatedGain, now, 0.05);
              if (n.type === 'highshelf') {
                n.gain.setTargetAtTime(calculatedGain * 1.2, now, 0.05);
                const fSizeParam = vst.params['Feedback / Size'] ?? 50;
                n.frequency.setTargetAtTime(6000 + (fSizeParam * 40), now, 0.05);
              }
            });
          }
        }
      });
    }
  }

  public updateTrackProcessingLive(trackId: string, proc: any) {
    if (this.currentTracks) {
      this.currentTracks = this.currentTracks.map(t => {
        if (t.id === trackId) {
          return { ...t, processing: proc };
        }
        return t;
      });
    }

    if (this.isTauriRuntime() || this.isNativePlaying) {
      callTauri('update_native_playback_tracks', { tracks: formatNativeTracks(this.currentTracks) }).catch(() => {});
      return;
    }

    if (!this.audioContext) return;
    const now = this.audioContext.currentTime;
    
    this.playingMetadata.forEach((meta, segId) => {
      if (meta.track.id === trackId) {
        const chain = this.activeProcessingChains.get(segId);
        if (chain) {
          this.applyProcessingParams(chain, proc, now);
        }
      }
    });
  }
}

export const playbackEngine = new PlaybackEngine();
