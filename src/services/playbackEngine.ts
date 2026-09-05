import { getSafeFileUrl } from '../lib/utils';
import { VSTAudioWorkletNode } from '../lib/vstHost';
import { IOLogger } from '../lib/ioLogger';

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
  private boundVideoElement: HTMLMediaElement | null = null;
  private boundReferenceElement: HTMLMediaElement | null = null;
  private audioOffsetMs = 0; 
  private currentTracks: any[] = [];
  private playOriginalTrackSegments = false;
  private workletInitialized = false;
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

  private createProcessingChain(
    ctx: AudioContext,
    processing: any,
    inputNode: AudioNode,
    destinationNode: AudioNode
  ) {
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

    // --- 1. Noise gate ---
    if (processing.noiseGate?.enabled) {
      gateNode = ctx.createDynamicsCompressor();
      gateNode.threshold.value = processing.noiseGate.threshold ?? -45;
      gateNode.ratio.value = 12;
      gateNode.knee.value = 0;
      gateNode.attack.value = 0.002;
      gateNode.release.value = 0.100;
      activeInput.connect(gateNode);
      activeInput = gateNode;
    }

    // --- 2. De-esser ---
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

    // --- 3. EQ highpass / lowpass ---
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

    // --- 4. Compressor ---
    if (processing.compressor?.enabled) {
      compressorNode = ctx.createDynamicsCompressor();
      compressorNode.threshold.value = processing.compressor.threshold ?? -18;
      compressorNode.ratio.value = processing.compressor.ratio ?? 3.5;
      compressorNode.attack.value = (processing.compressor.attack ?? 15) / 1000;
      compressorNode.release.value = (processing.compressor.release ?? 200) / 1000;
      activeInput.connect(compressorNode);
      activeInput = compressorNode;
    }

    // --- 5. VST Plugins Rack ---
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

    // --- 6. Reverb ---
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

    // --- 7. Delay ---
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
      // Dynamic balancing of delays to handle positive/negative offsets
      // Positive offset = Dubs play LATER (delay Dubbing)
      // Negative offset = Video/Reference plays LATER (delay Video)
      
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
      
      console.log(`[PlaybackEngine] AudioContext initialized at ${this.audioContext.sampleRate}Hz`);

      if (!this.workletInitialized) {
        try {
          // Use the static public worklet file to avoid violating CSP/browser-side blocks in iframe previews
          await this.audioContext.audioWorklet.addModule(
            '/vst-processor.worklet.js'
          );
          this.workletInitialized = true;
          console.log("[PlaybackEngine] VST AudioWorklet loaded");
        } catch (err) {
          console.error("[PlaybackEngine] Failed to load VST Worklet:", err);
        }
      }

      // Initialize Dubbing Bus
      this.dubbingGain = this.audioContext.createGain();
      this.dubbingDelay = this.audioContext.createDelay(4.0); // Allow up to 4s compensation
      this.dubbingGain.connect(this.dubbingDelay);
      this.dubbingDelay.connect(this.audioContext.destination);

      // Initialize Original/Video Bus
      this.videoGain = this.audioContext.createGain();
      this.videoDelay = this.audioContext.createDelay(4.0);
      this.videoGain.connect(this.videoDelay);
      this.videoDelay.connect(this.audioContext.destination);

      // Reference track uses its own gain but same delay line as video
      this.referenceGain = this.audioContext.createGain();
      this.referenceGain.gain.value = 0;
      this.referenceGain.connect(this.videoDelay); 
    }
    return this.audioContext;
  }

  public getCurrentTime(): number {
    return this.audioContext ? this.audioContext.currentTime : 0;
  }

  public clearCache() {
    this.bufferCache.clear();
    console.log("[PlaybackEngine] Cache cleared");
  }

  public async bindVideoElement(video: HTMLMediaElement) {
    if (this.boundVideoElement === video) return;
    console.log("[PlaybackEngine] Binding video element for native direct routing...");
    
    try {
      this.boundVideoElement = video;
      this.videoSource = null as any;
      
      const ctx = await this.getContext();
      if (!this.videoGain) {
        this.videoGain = ctx.createGain();
        this.videoGain.gain.value = 1.0;
      }

      if (!this.videoDelay) {
        this.videoDelay = ctx.createDelay(4.0);
        this.videoDelay.delayTime.value = this.audioOffsetMs < 0 ? Math.abs(this.audioOffsetMs) / 1000 : 0;
      }
      
      // Ensure the master bus graph is consistent
      if (this.videoGain.numberOfOutputs === 0) {
         try { this.videoGain.disconnect(); } catch(e){}
         this.videoGain.connect(this.videoDelay);
      }
      
      console.log("[PlaybackEngine] Video element bound for native direct playback");
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
      
      const ctx = await this.getContext();
      if (!this.referenceGain) {
        this.referenceGain = ctx.createGain();
        this.referenceGain.gain.value = 0.0;
      }
      
      // Route through videoDelay if available
      if (this.videoDelay) {
         try { this.referenceGain.disconnect(); } catch(e) {}
         this.referenceGain.connect(this.videoDelay);
      } else {
         try { this.referenceGain.disconnect(); } catch(e) {}
         this.referenceGain.connect(ctx.destination);
      }
      
      console.log("[PlaybackEngine] Reference audio bound for native direct playback");
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
        
        // Check global web cache directly to avoid CSP issues with fetch("blob:...")
        const globalCache = (window as any).webFileCache;
        let fileOrBlob: Blob | File | undefined;
        if (globalCache) {
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
          // Fallback to standard fetch
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          arrayBuffer = await response.arrayBuffer();
        }
        
        let audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        IOLogger.log('MEDIA', 'loadBuffer', 'SUCCESS', { url, duration: audioBuffer.duration, channels: audioBuffer.numberOfChannels });
        
        // Manual resampling if decodeAudioData didn't match (though it usually does)
        if (audioBuffer.sampleRate !== ctx.sampleRate) {
          console.warn(`[PlaybackEngine] Resampling buffer from ${audioBuffer.sampleRate} to ${ctx.sampleRate}`);
          const offlineCtx = new OfflineAudioContext(
            audioBuffer.numberOfChannels,
            Math.max(1, Math.ceil(audioBuffer.duration * ctx.sampleRate)),
            ctx.sampleRate
          );
          const source = offlineCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offlineCtx.destination);
          source.start(0);
          audioBuffer = await offlineCtx.startRendering();
        }
        
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
    
    // Log context latency for debugging sync issues
    const outputLatency = (ctx as any).outputLatency || 0;
    console.log(`[PlaybackEngine] Starting playback. Context latency: ${Math.round(outputLatency * 1000)}ms`);
    
    this.tick(currentTime, tracks);
  }

  private async performSync() {
    if (!this.boundVideoElement || !this.isPlaying) return;
    
    const ctx = await this.getContext();
    const videoTime = this.boundVideoElement.currentTime;
    const videoRate = this.boundVideoElement.playbackRate;

    this.sources.forEach((source, segId) => {
      const meta = this.playingMetadata.get(segId);
      if (!meta) {
        this.sources.delete(segId);
        return;
      }

      // Cleanup finished segments
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

      // Calculate how much time the Video and Audio Context have actually progressed
      const elapsedVideoTime = videoTime - meta.videoStartTime;
      const elapsedCtxTime = ctx.currentTime - meta.ctxStartTime;

      // Ensure that if the video is stalled, buffering, or still preparing (e.g. at the start of playback),
      // we do not trigger hard/soft desync corrections or infinite restart loops.
      // We wait until both have at least minimally progressed before starting drift and sync calculations.
      const isVideoBufferingOrStarting = elapsedVideoTime < 0.5 || elapsedCtxTime < 0.5;

      // Assuming basePlaybackRate = 1 for timing sync (if video is 1x).
      // If video played at 2x, elapsedVideoTime grows 2x as fast as Ctx time,
      // so we normalize by videoRate to find the expected Ctx time.
      const expectedElapsedCtxTime = elapsedVideoTime / videoRate;
      
      const drift = expectedElapsedCtxTime - elapsedCtxTime;
      const driftMs = drift * 1000;

      if (isVideoBufferingOrStarting) {
        // Normal baseline rate during startup or buffering phase
        source.playbackRate.setTargetAtTime(
          meta.basePlaybackRate * videoRate, 
          ctx.currentTime, 
          0.1
        );
        return;
      }

      // Master Sync: Tiered Synchronization Logic with dead-band zone to prevent pitch warping
      if (Math.abs(driftMs) > 1000) {
        // HARD SYNC: Drift exceeds 1000ms. Massive desync, restart node.
        console.log(`[PlaybackEngine] Master Sync (Restarting) for ${segId}: ${Math.round(driftMs)}ms drift. (vTime=${videoTime.toFixed(2)}, meta.vStart=${meta.videoStartTime.toFixed(2)}, cTime=${ctx.currentTime.toFixed(2)})`);
        this.restartSegment(meta.track, meta.seg);
      } else if (Math.abs(driftMs) >= 120) {
        // SOFT SYNC: Drift from 120ms to 1000ms. Adjust playback rate slightly.
        // Limit speed correction to max +/- 6% (0.94x to 1.06x) to avoid audible pitch warping.
        const errorRatio = Math.max(-0.06, Math.min(0.06, drift * 0.5)); 
        const correction = 1.0 + errorRatio;
        
        source.playbackRate.setTargetAtTime(
          meta.basePlaybackRate * videoRate * correction, 
          ctx.currentTime, 
          0.15
        );
      } else {
        // NORMAL: Minimal drift (< 120ms). Keep exact baseline rate.
        // Crucial for keeping the pitch perfectly natural (exactly 1.0) under normal browser playback jitter
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
      
      // Implement micro-fade out (crossfade support)
      const fadeOutTime = 0.01; // 10ms
      if (gain) {
        gain.gain.setTargetAtTime(0, now, fadeOutTime / 2);
      }
      
      // Cleanup after fade out
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
    // tick will naturally reschedule it if it's still in the window
  }

  public async tick(currentVideoTime: number, tracks: any[]) {
    if (!this.isPlaying) return;

    await this.performSync();

    const ctx = await this.getContext();
    const sessionId = this.currentSessionId;
    const now = ctx.currentTime;
    
    // Use the most up-to-date time from the element if available to reduce latency
    const liveVideoTime = this.boundVideoElement ? this.boundVideoElement.currentTime : currentVideoTime;
    const playbackRate = this.boundVideoElement ? this.boundVideoElement.playbackRate : 1.0;
    
    // Cleanup segments that have passed
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

    // (Drift correction moved to performSync)

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

    if (this.boundVideoElement && !this.videoSource) {
      const isOriginalActive = anySolo 
        ? (originalTrack?.isSolo || false) 
        : !(originalTrack?.isMuted || false);
      const targetVolume = isOriginalActive ? (originalTrack?.volume ?? 1) : 0;
      const isMutedByMaster = originalTrack?.isMuted || false;
      
      this.boundVideoElement.volume = targetVolume;
      this.boundVideoElement.muted = targetVolume === 0 || isMutedByMaster;
    }

    if (this.referenceGain) {
      const isRefActive = anySolo
        ? (referenceTrack?.isSolo || false)
        : !(referenceTrack?.isMuted || false);
      const targetVolume = isRefActive ? (referenceTrack?.volume ?? 1) : 0;
      this.referenceGain.gain.setTargetAtTime(targetVolume, now, 0.03);
    }

    if (this.boundReferenceElement && !this.referenceSource) {
      const isRefActive = anySolo
        ? (referenceTrack?.isSolo || false)
        : !(referenceTrack?.isMuted || false);
      const targetVolume = isRefActive ? (referenceTrack?.volume ?? 1) : 0;
      const isMutedByMaster = referenceTrack?.isMuted || false;
      
      this.boundReferenceElement.volume = targetVolume;
      this.boundReferenceElement.muted = targetVolume === 0 || isMutedByMaster;
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
          
          const urlToLoad = (seg as any).url || seg.blobUrl || (seg.filePath ? getSafeFileUrl(seg.filePath) : null);
          if (!urlToLoad) continue;

          this.loadBuffer(urlToLoad, seg.filePath).then(buffer => {
            if (!buffer || !this.isPlaying || sessionId !== this.currentSessionId) return;

            // Use the captured 'now' for start time calculation to ensure uniformity 
            // but we might need a fresh read if Buffer loading was LONG. 
            // However, the requirements say 'use time in the beginning of tick'.
            
            // Get the most precise current time and rate directly from the source if possible
            const freshCtxTime = ctx.currentTime;
            const freshVideoTime = this.boundVideoElement ? this.boundVideoElement.currentTime : liveVideoTime;
            const currentVideoRate = this.boundVideoElement ? this.boundVideoElement.playbackRate : playbackRate;

            if (freshVideoTime > seg.startTime + seg.duration) {
              return; // Segment is already in the past
            }

            const schedulingDelay = 0.02; // 20ms pre-roll for smooth start
            
            let when: number;
            let bufferOffset: number;
            let timeOffsetInSegment: number;

            // Capture the exact video time for metadata synchronization
            const audioStartVideoTime = freshVideoTime + (schedulingDelay * currentVideoRate);

            if (freshVideoTime > seg.startTime) {
              // 1. Starting from the middle of the segment
              timeOffsetInSegment = freshVideoTime - seg.startTime;
              // Add fixed pre-roll as requested
              when = freshCtxTime + schedulingDelay;
              // User requested NOT to add schedulingDelay to buffer offset to prevent "jumping"
              bufferOffset = (seg.fileOffset || 0) + timeOffsetInSegment;
            } else {
              // 2. Future segment
              timeOffsetInSegment = 0;
              const timeUntilStart = (seg.startTime - freshVideoTime) / currentVideoRate;
              when = freshCtxTime + timeUntilStart;
              bufferOffset = seg.fileOffset || 0;
            }

            // Protect against negative offset from rounding errors.
            bufferOffset = Math.max(0, bufferOffset);
            
            // 4. Calculate how much buffer is left to play for this segment
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
            
            // Micro-fade in at start
            gainNode.gain.setValueAtTime(0, when);
            gainNode.gain.linearRampToValueAtTime(baseVolume, when + FADE_TIME);

            source.connect(gainNode);
            
            let currentMonoNode: GainNode | undefined;
            const lowerTrackName = track.name?.toLowerCase() || '';
            if (lowerTrackName.includes('озвучк') || lowerTrackName.includes('dub') || buffer.numberOfChannels === 1) {
              const monoNode = ctx.createGain();
              monoNode.channelCount = 1;
              monoNode.channelCountMode = 'explicit';
              source.disconnect(gainNode);
              source.connect(monoNode);
              monoNode.connect(gainNode);
              currentMonoNode = monoNode;
            }

            const pannerNode = ctx.createStereoPanner();
            pannerNode.pan.setValueAtTime(seg.panning !== undefined ? seg.panning : 0.0, when);
            this.pannerNodes.set(seg.id, pannerNode);
            gainNode.connect(pannerNode);

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
            
            // Micro-fade out at end
            const fadeOutStart = when + duration - FADE_TIME;
            gainNode.gain.setValueAtTime(baseVolume, Math.max(when, fadeOutStart));
            gainNode.gain.linearRampToValueAtTime(0, when + duration);
            
            this.sources.set(seg.id, source);
            this.gainNodes.set(seg.id, gainNode);

            // Store metadata for sync loop
            this.playingMetadata.set(seg.id, {
              videoStartTime: freshVideoTime > seg.startTime ? audioStartVideoTime : seg.startTime,
              ctxStartTime: when,
              fileOffset: bufferOffset,
              basePlaybackRate: baseRate,
              seg,
              track,
              monoNode: currentMonoNode
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

  /**
   * Reconciles current playback with updated tracks without stopping all audio.
   * Efficiently handles segment splits, deletions, and volume changes.
   */
  public async reconcile(tracks: any[]) {
    this.currentTracks = tracks;
    if (!this.isPlaying) return;

    const ctx = await this.getContext();
    const liveVideoTime = this.boundVideoElement ? this.boundVideoElement.currentTime : 0;
    
    // 1. Find segments that are no longer present in tracks and stop them
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

    // 2. Cleanup scheduledSegments set for segments that were removed but not yet playing
    this.scheduledSegments.forEach(segId => {
      if (!activeSegmentIds.has(segId)) {
        this.scheduledSegments.delete(segId);
      }
    });

    // 3. Update gains and rates for existing segments
    await this.updateTracks(tracks);

    // 4. Tick once to schedule any newly added segments (like the second part of a split)
    await this.tick(liveVideoTime, tracks);
    
    console.log("[PlaybackEngine] Reconciliation complete");
  }

  public async seek(currentTime: number, tracks: any[]) {
    const wasPlaying = this.isPlaying;
    this.stop();
    
    // If was playing, we continue playing from the new position
    if (wasPlaying) {
      this.isPlaying = true;
      this.currentSessionId = Date.now();
    }
    
    this.currentTracks = tracks;
    await this.tick(currentTime, tracks);
  }

  public async updateTracks(tracks: any[]) {
    this.currentTracks = tracks;
    if (!this.isPlaying) return;

    const ctx = await this.getContext();
    const anySolo = tracks.some(t => t.isSolo);
    
    // Update Video/Reference gains
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
          // Update playback rate in real-time to match video speed, maintaining strictly 1.0 base rate
          source.playbackRate.setTargetAtTime(1.0 * currentPlaybackRate, now, 0.02);
        }

        // --- Dynamic DSP & VST Parameter Updates in Real-time ---
        const chain = this.activeProcessingChains.get(seg.id);
        if (chain && track.processing && track.processing.enabled) {
          this.applyProcessingParams(chain, track.processing, now);
        }
      });
    });
  }

  /**
   * Applies processing parameters to an existing chain in real-time.
   */
  private applyProcessingParams(chain: any, proc: any, now: number) {
    // 1. Noise Gate
    if (chain.gateNode && proc.noiseGate?.enabled) {
      chain.gateNode.threshold.setTargetAtTime(proc.noiseGate.threshold ?? -45, now, 0.05);
    }
    
    // 2. De-esser
    if (chain.deesserNode && proc.deesser?.enabled) {
      chain.deesserNode.frequency.setTargetAtTime(proc.deesser.frequency ?? 6200, now, 0.05);
      const thresh = proc.deesser.threshold ?? -12;
      chain.deesserNode.gain.setTargetAtTime(Math.min(0, thresh / 4), now, 0.05);
    }
    
    // 3. EQ Filters
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
    
    // 4. Compressor
    if (chain.compressorNode && proc.compressor?.enabled) {
      chain.compressorNode.threshold.setTargetAtTime(proc.compressor.threshold ?? -18, now, 0.05);
      chain.compressorNode.ratio.setTargetAtTime(proc.compressor.ratio ?? 3.5, now, 0.05);
      chain.compressorNode.attack.setTargetAtTime((proc.compressor.attack ?? 15) / 1000, now, 0.05);
      chain.compressorNode.release.setTargetAtTime((proc.compressor.release ?? 200) / 1000, now, 0.05);
    }
    
    // 5. Reverb
    if (chain.reverbDryNode && chain.reverbWetNode && proc.reverb?.enabled) {
      const wetVal = proc.reverb.wet ?? 0.12;
      chain.reverbDryNode.gain.setTargetAtTime(1.0 - wetVal, now, 0.05);
      chain.reverbWetNode.gain.setTargetAtTime(wetVal, now, 0.05);
    }
    
    // 6. Delay
    if (chain.delayDryNode && chain.delayWetNode && chain.delayNode && chain.delayFeedbackNode && proc.delay?.enabled) {
      const wetVal = proc.delay.wet ?? 0.1;
      chain.delayDryNode.gain.setTargetAtTime(1.0 - wetVal, now, 0.05);
      chain.delayWetNode.gain.setTargetAtTime(wetVal, now, 0.05);
      chain.delayNode.delayTime.setTargetAtTime(proc.delay.time ?? 0.3, now, 0.05);
      chain.delayFeedbackNode.gain.setTargetAtTime(proc.delay.feedback ?? 0.3, now, 0.05);
    }

    // 7. VST Plugins Rack
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

  /**
   * Dynamic live update for all active chains belonging to a track.
   * Useful for real-time adjustments in the Mixer or Processing Modal.
   */
  public updateTrackProcessingLive(trackId: string, proc: any) {
    if (!this.audioContext) return;
    const now = this.audioContext.currentTime;
    
    // Find all active segments for this track
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
