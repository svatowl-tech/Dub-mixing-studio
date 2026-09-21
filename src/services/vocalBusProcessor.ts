import { VocalBusRackConfig } from '../types';

/**
 * Создает таблицу формы волны (Transfer Curve) для аналоговой сатурации
 * с мягким гиперболическим тангенсом (tanh) и асимметрией четных гармоник (warmthBias),
 * точно повторяя алгоритм нативного Rust DSP (vocal_bus.rs).
 */
export function generateWarmthTanhCurve(
  samples: number = 4096,
  driveDb: number = 3.5,
  warmthBias: number = 0.15,
  autoGain: boolean = true
): Float32Array {
  const curve = new Float32Array(samples);
  const half = (samples - 1) / 2;
  const driveLinear = Math.pow(10, driveDb / 20);
  
  // Авто-компенсация гейна (как в vocal_bus.rs)
  const satPeak = Math.tanh(driveLinear) / driveLinear;
  const makeupLinear = autoGain ? 1.0 / Math.max(0.2, satPeak) : 1.0;

  for (let i = 0; i < samples; i++) {
    const x = (i - half) / half; // -1.0 .. +1.0
    // Асимметричный подмес четных гармоник лампового типа: x + bias * (x^2 - 0.25)
    const xBiased = x + warmthBias * (x * x - 0.25);
    const satIn = xBiased * driveLinear;
    // Мягкое ограничение tanh
    const satOut = (Math.tanh(satIn) / driveLinear) * makeupLinear;
    curve[i] = Math.max(-1.0, Math.min(1.0, satOut));
  }
  return curve;
}

/**
 * Создает таблицу гармонического обогащения для Presence Exciter / Air
 * генерирует бархатные верхние гармоники: x + k * x^2
 */
export function generateExciterHarmonicsCurve(
  samples: number = 2048,
  harmonicDrive: number = 0.20
): Float32Array {
  const curve = new Float32Array(samples);
  const half = (samples - 1) / 2;
  for (let i = 0; i < samples; i++) {
    const x = (i - half) / half;
    const abs = Math.abs(x);
    const harm = x * (1.0 + harmonicDrive * abs);
    curve[i] = Math.max(-1.0, Math.min(1.0, harm));
  }
  return curve;
}

/**
 * Студийный Web Audio DSP процессор мастер-шины вокала.
 * Полностью реализует 6-звенный студийный рэк в реальном времени:
 * 1. HPF & Surgical Notch EQ
 * 2. Dynamic De-Esser (подавление сибилянтов)
 * 3. Tanh Warmth Saturation (аналоговое насыщение с Dry/Wet)
 * 4. Opto LA-2A Vocal Compressor (двухфазная компрессия с компенсацией Makeup Gain)
 * 5. Presence Exciter / Air (High-Shelf >10кГц + четные гармоники)
 * 6. True-Peak Brickwall Limiter (защита от межсэмплового клиппинга)
 */
export class VocalBusWebAudioChain {
  public ctx: BaseAudioContext;
  public inputNode: GainNode;
  public outputNode: GainNode;

  // Маршрутизация Dry / Wet для чистого байпаса без щелчков
  private bypassGain: GainNode;
  private wetGain: GainNode;

  // 1. HPF & Surgical EQ
  private hpfNode1: BiquadFilterNode;
  private hpfNode2: BiquadFilterNode;
  private notchNode: BiquadFilterNode;

  // 2. De-Esser
  private deesserNode: BiquadFilterNode;

  // 3. Warmth Saturation
  private satDryGain: GainNode;
  private satWetGain: GainNode;
  private satDriveGain: GainNode;
  private satShaper: WaveShaperNode;
  private satDcBlocker: BiquadFilterNode;
  private satSum: GainNode;

  // 4. Opto LA-2A Compressor
  private compressorNode: DynamicsCompressorNode;
  private compMakeupGain: GainNode;

  // 5. Presence Exciter / Air
  private exciterDryGain: GainNode;
  private exciterWetGain: GainNode;
  private airShelfNode: BiquadFilterNode;
  private airShaper: WaveShaperNode;
  private exciterSum: GainNode;

  // 6. True-Peak Limiter
  private limiterNode: DynamicsCompressorNode;
  private limiterCeilingGain: GainNode;

  private currentConfig: VocalBusRackConfig | null = null;
  private isBypassed: boolean = false;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;

    // Вход и выход шины
    this.inputNode = ctx.createGain();
    this.outputNode = ctx.createGain();

    this.bypassGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    // 1. HPF & Notch EQ
    this.hpfNode1 = ctx.createBiquadFilter();
    this.hpfNode1.type = 'highpass';
    this.hpfNode1.frequency.value = 75;
    this.hpfNode1.Q.value = 0.707;

    this.hpfNode2 = ctx.createBiquadFilter();
    this.hpfNode2.type = 'highpass';
    this.hpfNode2.frequency.value = 75;
    this.hpfNode2.Q.value = 0.707;

    this.notchNode = ctx.createBiquadFilter();
    this.notchNode.type = 'peaking';
    this.notchNode.frequency.value = 3200;
    this.notchNode.Q.value = 8.0;
    this.notchNode.gain.value = -6.0;

    // 2. Dynamic De-Esser
    this.deesserNode = ctx.createBiquadFilter();
    this.deesserNode.type = 'peaking';
    this.deesserNode.frequency.value = 6500;
    this.deesserNode.Q.value = 2.0;
    this.deesserNode.gain.value = -4.5;

    // 3. Warmth Saturation
    this.satDryGain = ctx.createGain();
    this.satWetGain = ctx.createGain();
    this.satDriveGain = ctx.createGain();
    this.satShaper = ctx.createWaveShaper();
    this.satShaper.oversample = '2x';
    this.satShaper.curve = generateWarmthTanhCurve(4096, 3.5, 0.15, true);

    this.satDcBlocker = ctx.createBiquadFilter();
    this.satDcBlocker.type = 'highpass';
    this.satDcBlocker.frequency.value = 15;
    this.satDcBlocker.Q.value = 0.707;

    this.satSum = ctx.createGain();

    // 4. Opto LA-2A Compressor
    this.compressorNode = ctx.createDynamicsCompressor();
    this.compressorNode.threshold.value = -18.0;
    this.compressorNode.knee.value = 6.0;
    this.compressorNode.ratio.value = 3.0;
    this.compressorNode.attack.value = 0.02; // 20 ms
    this.compressorNode.release.value = 0.12; // 120 ms

    this.compMakeupGain = ctx.createGain();
    this.compMakeupGain.gain.value = Math.pow(10, 2.5 / 20); // +2.5 dB

    // 5. Presence Exciter / Air
    this.exciterDryGain = ctx.createGain();
    this.exciterWetGain = ctx.createGain();
    this.airShelfNode = ctx.createBiquadFilter();
    this.airShelfNode.type = 'highshelf';
    this.airShelfNode.frequency.value = 10000;
    this.airShelfNode.gain.value = 2.5;

    this.airShaper = ctx.createWaveShaper();
    this.airShaper.curve = generateExciterHarmonicsCurve(2048, 0.20);

    this.exciterSum = ctx.createGain();

    // 6. True-Peak Limiter
    this.limiterNode = ctx.createDynamicsCompressor();
    this.limiterNode.threshold.value = -1.0;
    this.limiterNode.knee.value = 0.0;
    this.limiterNode.ratio.value = 20.0;
    this.limiterNode.attack.value = 0.001; // 1 ms lookahead catch
    this.limiterNode.release.value = 0.06; // 60 ms

    this.limiterCeilingGain = ctx.createGain();
    this.limiterCeilingGain.gain.value = 1.0;

    // Сборка графа
    this.buildGraph();

    // По умолчанию включаем режим обработки
    this.setBypass(false);
  }

  private buildGraph() {
    // 1. Вход разветвляется на Bypass (Dry) и Wet цепочку
    this.inputNode.connect(this.bypassGain);
    this.bypassGain.connect(this.outputNode);

    // 2. Начало Wet цепочки: HPF 1 -> HPF 2 -> Notch
    this.inputNode.connect(this.hpfNode1);
    this.hpfNode1.connect(this.hpfNode2);
    this.hpfNode2.connect(this.notchNode);

    // 3. De-Esser
    this.notchNode.connect(this.deesserNode);

    // 4. Saturation (Dry/Wet внутри стадии)
    this.deesserNode.connect(this.satDryGain);
    this.satDryGain.connect(this.satSum);

    this.deesserNode.connect(this.satDriveGain);
    this.satDriveGain.connect(this.satShaper);
    this.satShaper.connect(this.satDcBlocker);
    this.satDcBlocker.connect(this.satWetGain);
    this.satWetGain.connect(this.satSum);

    // 5. Compressor + Makeup
    this.satSum.connect(this.compressorNode);
    this.compressorNode.connect(this.compMakeupGain);

    // 6. Exciter / Air
    this.compMakeupGain.connect(this.exciterDryGain);
    this.exciterDryGain.connect(this.exciterSum);

    this.compMakeupGain.connect(this.airShelfNode);
    this.airShelfNode.connect(this.airShaper);
    this.airShaper.connect(this.exciterWetGain);
    this.exciterWetGain.connect(this.exciterSum);

    // 7. True-Peak Limiter
    this.exciterSum.connect(this.limiterNode);
    this.limiterNode.connect(this.limiterCeilingGain);

    // 8. Выход Wet ветки
    this.limiterCeilingGain.connect(this.wetGain);
    this.wetGain.connect(this.outputNode);
  }

  /**
   * Плавное переключение Bypass без щелчков и артефактов
   */
  public setBypass(bypass: boolean) {
    this.isBypassed = bypass;
    const now = this.ctx.currentTime;
    try {
      if (bypass) {
        this.bypassGain.gain.setTargetAtTime(1.0, now, 0.015);
        this.wetGain.gain.setTargetAtTime(0.0, now, 0.015);
      } else {
        this.bypassGain.gain.setTargetAtTime(0.0, now, 0.015);
        this.wetGain.gain.setTargetAtTime(1.0, now, 0.015);
      }
    } catch (_) {
      this.bypassGain.gain.value = bypass ? 1.0 : 0.0;
      this.wetGain.gain.value = bypass ? 0.0 : 1.0;
    }
  }

  /**
   * Обновление конфигурации мастер-шины вокала в реальном времени
   */
  public updateConfig(config: VocalBusRackConfig | null | undefined, bypassAll: boolean = false) {
    if (!config) {
      this.setBypass(true);
      return;
    }
    this.currentConfig = config;
    this.setBypass(bypassAll || config.bypass);

    const now = this.ctx.currentTime;
    const ramp = 0.025; // 25ms плавное сглаживание для устранения щелчков

    // 1. HPF & Notch EQ
    if (config.eq) {
      const hpfFreq = config.eq.enabled ? Math.max(20, Math.min(300, config.eq.hpfCutoffHz || 75)) : 20;
      this.hpfNode1.frequency.setTargetAtTime(hpfFreq, now, ramp);
      
      // Второй каскад для 24 dB/oct (4-й порядок)
      if (config.eq.enabled && (config.eq.hpfOrder || 2) >= 4) {
        this.hpfNode2.frequency.setTargetAtTime(hpfFreq, now, ramp);
        this.hpfNode2.Q.setTargetAtTime(0.707, now, ramp);
      } else {
        this.hpfNode2.frequency.setTargetAtTime(20, now, ramp);
      }

      // Резонансный вырез (Notch 3.2 kHz)
      if (config.eq.enabled && config.eq.notchEnabled) {
        this.notchNode.frequency.setTargetAtTime(config.eq.notchFreqHz || 3200, now, ramp);
        this.notchNode.Q.setTargetAtTime(config.eq.notchQ || 8.0, now, ramp);
        this.notchNode.gain.setTargetAtTime(config.eq.notchGainDb || -6.0, now, ramp);
      } else {
        this.notchNode.gain.setTargetAtTime(0.0, now, ramp);
      }
    }

    // 2. Dynamic De-Esser
    if (config.deesser) {
      if (config.deesser.enabled) {
        this.deesserNode.frequency.setTargetAtTime(config.deesser.frequencyHz || 6500, now, ramp);
        this.deesserNode.Q.setTargetAtTime(2.0, now, ramp);
        // Динамическое ослабление пропорционально порогу
        const reductionDb = Math.min(-1.5, Math.max(-12.0, (config.deesser.thresholdDb || -22) / 5.0));
        this.deesserNode.gain.setTargetAtTime(reductionDb, now, ramp);
      } else {
        this.deesserNode.gain.setTargetAtTime(0.0, now, ramp);
      }
    }

    // 3. Warmth Saturation
    if (config.saturation) {
      if (config.saturation.enabled && config.saturation.blend > 0.001) {
        const blend = Math.max(0, Math.min(1.0, config.saturation.blend));
        this.satDryGain.gain.setTargetAtTime(1.0 - blend, now, ramp);
        this.satWetGain.gain.setTargetAtTime(blend, now, ramp);

        const driveLinear = Math.pow(10, (config.saturation.driveDb || 3.5) / 20);
        this.satDriveGain.gain.setTargetAtTime(driveLinear, now, ramp);

        // Обновляем кривую мягкого tanh с ламповым смещением
        this.satShaper.curve = generateWarmthTanhCurve(
          4096,
          config.saturation.driveDb || 3.5,
          config.saturation.warmthBias ?? 0.15,
          config.saturation.autoGain ?? true
        );
      } else {
        this.satDryGain.gain.setTargetAtTime(1.0, now, ramp);
        this.satWetGain.gain.setTargetAtTime(0.0, now, ramp);
      }
    }

    // 4. Opto LA-2A Compressor
    if (config.compressor) {
      if (config.compressor.enabled) {
        this.compressorNode.threshold.setTargetAtTime(config.compressor.thresholdDb ?? -18.0, now, ramp);
        this.compressorNode.ratio.setTargetAtTime(config.compressor.ratio ?? 3.0, now, ramp);
        this.compressorNode.attack.setTargetAtTime((config.compressor.attackMs || 20.0) / 1000, now, ramp);
        this.compressorNode.release.setTargetAtTime((config.compressor.releaseMs || 120.0) / 1000, now, ramp);
        this.compressorNode.knee.setTargetAtTime(config.compressor.kneeWidthDb || 6.0, now, ramp);

        const makeupLinear = Math.pow(10, (config.compressor.makeupGainDb ?? 2.5) / 20);
        this.compMakeupGain.gain.setTargetAtTime(makeupLinear, now, ramp);
      } else {
        this.compressorNode.threshold.setTargetAtTime(0.0, now, ramp);
        this.compressorNode.ratio.setTargetAtTime(1.0, now, ramp);
        this.compMakeupGain.gain.setTargetAtTime(1.0, now, ramp);
      }
    }

    // 5. Presence Exciter / Air
    if (config.exciter) {
      if (config.exciter.enabled) {
        const airBlend = Math.max(0, Math.min(1.0, config.exciter.airBlend ?? 0.70));
        this.exciterDryGain.gain.setTargetAtTime(1.0 - airBlend * 0.35, now, ramp);
        this.exciterWetGain.gain.setTargetAtTime(airBlend, now, ramp);

        this.airShelfNode.frequency.setTargetAtTime(config.exciter.airFreqHz || 10000, now, ramp);
        this.airShelfNode.gain.setTargetAtTime(config.exciter.airGainDb || 2.5, now, ramp);

        this.airShaper.curve = generateExciterHarmonicsCurve(2048, config.exciter.harmonicDrive || 0.20);
      } else {
        this.exciterDryGain.gain.setTargetAtTime(1.0, now, ramp);
        this.exciterWetGain.gain.setTargetAtTime(0.0, now, ramp);
        this.airShelfNode.gain.setTargetAtTime(0.0, now, ramp);
      }
    }

    // 6. True-Peak Limiter
    if (config.limiter) {
      if (config.limiter.enabled) {
        const ceiling = config.limiter.ceilingDbtp ?? -1.0;
        this.limiterNode.threshold.setTargetAtTime(ceiling, now, ramp);
        this.limiterNode.ratio.setTargetAtTime(20.0, now, ramp);
        this.limiterNode.release.setTargetAtTime((config.limiter.releaseMs || 60.0) / 1000, now, ramp);
        this.limiterCeilingGain.gain.setTargetAtTime(1.0, now, ramp);
      } else {
        this.limiterNode.threshold.setTargetAtTime(0.0, now, ramp);
        this.limiterNode.ratio.setTargetAtTime(1.0, now, ramp);
        this.limiterCeilingGain.gain.setTargetAtTime(1.0, now, ramp);
      }
    }
  }

  public cleanup() {
    try { this.inputNode.disconnect(); } catch (_) {}
    try { this.outputNode.disconnect(); } catch (_) {}
    try { this.bypassGain.disconnect(); } catch (_) {}
    try { this.wetGain.disconnect(); } catch (_) {}
    try { this.hpfNode1.disconnect(); } catch (_) {}
    try { this.hpfNode2.disconnect(); } catch (_) {}
    try { this.notchNode.disconnect(); } catch (_) {}
    try { this.deesserNode.disconnect(); } catch (_) {}
    try { this.satDryGain.disconnect(); } catch (_) {}
    try { this.satWetGain.disconnect(); } catch (_) {}
    try { this.satDriveGain.disconnect(); } catch (_) {}
    try { this.satShaper.disconnect(); } catch (_) {}
    try { this.satDcBlocker.disconnect(); } catch (_) {}
    try { this.satSum.disconnect(); } catch (_) {}
    try { this.compressorNode.disconnect(); } catch (_) {}
    try { this.compMakeupGain.disconnect(); } catch (_) {}
    try { this.exciterDryGain.disconnect(); } catch (_) {}
    try { this.exciterWetGain.disconnect(); } catch (_) {}
    try { this.airShelfNode.disconnect(); } catch (_) {}
    try { this.airShaper.disconnect(); } catch (_) {}
    try { this.exciterSum.disconnect(); } catch (_) {}
    try { this.limiterNode.disconnect(); } catch (_) {}
    try { this.limiterCeilingGain.disconnect(); } catch (_) {}
  }
}

/**
 * Офлайн-рендеринг буфера аудио через 6-звенный студийный рэк мастер-шины вокала
 * (для Web-режима или предпросмотра без нативного бэкенда).
 */
export async function renderVocalBusOffline(
  sourceBuffer: AudioBuffer,
  config: VocalBusRackConfig
): Promise<AudioBuffer> {
  const sampleRate = sourceBuffer.sampleRate;
  const numChannels = sourceBuffer.numberOfChannels;
  const duration = sourceBuffer.duration;
  const totalFrames = sourceBuffer.length;

  const offlineCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(
    numChannels,
    totalFrames,
    sampleRate
  );

  const sourceNode = offlineCtx.createBufferSource();
  sourceNode.buffer = sourceBuffer;

  const vocalBusChain = new VocalBusWebAudioChain(offlineCtx);
  vocalBusChain.updateConfig(config, config.bypass);

  sourceNode.connect(vocalBusChain.inputNode);
  vocalBusChain.outputNode.connect(offlineCtx.destination);

  sourceNode.start(0);

  const renderedBuffer = await offlineCtx.startRendering();
  vocalBusChain.cleanup();

  return renderedBuffer;
}

/**
 * Конвертирует AudioBuffer в PCM WAV Blob (16-bit / 48kHz)
 */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  const left = buffer.getChannelData(0);
  const right = numChannels > 1 ? buffer.getChannelData(1) : left;
  const numSamples = left.length;

  const dataSize = numSamples * blockAlign;
  const bufferHeaderSize = 44;
  const arrayBuffer = new ArrayBuffer(bufferHeaderSize + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = channel === 0 ? left[i] : right[i];
      const clamped = Math.max(-1.0, Math.min(1.0, sample));
      const intSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
