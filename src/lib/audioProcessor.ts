import { AudioSettings } from '../types';

export class AudioProcessor {
  private context: AudioContext;
  private source: MediaStreamAudioSourceNode | null = null;
  private monoMixer: GainNode;
  private highPass: BiquadFilterNode;
  private compressor: DynamicsCompressorNode;
  private gateGain: GainNode;
  private analyser: AnalyserNode;
  private destination: MediaStreamAudioDestinationNode;
  
  private settings: AudioSettings;
  private animationFrameId: number | null = null;
  private currentPeak: number = 0;

  constructor(context: AudioContext, settings: AudioSettings) {
    this.context = context;
    this.settings = settings;

    // Downmix to mono to fix audio interfaces where mic is on one channel
    this.monoMixer = context.createGain();
    this.monoMixer.channelCount = 1;
    this.monoMixer.channelCountMode = 'explicit';
    this.monoMixer.channelInterpretation = 'speakers';
    // Use 1.0 gain by default. If it's a stereo-to-mono downmix, 
    // the sum might exceed 1.0, but 2.0 was definitely too much.
    this.monoMixer.gain.value = 1.0;

    this.highPass = context.createBiquadFilter();
    this.highPass.type = 'highpass';
    
    this.compressor = context.createDynamicsCompressor();
    
    this.gateGain = context.createGain();
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    
    this.destination = context.createMediaStreamDestination();
    this.destination.channelCount = 2;
    this.destination.channelCountMode = 'explicit';
    this.destination.channelInterpretation = 'speakers';

    this.updateSettings(settings);
  }

  public updateSettings(settings: AudioSettings) {
    this.settings = settings;
    
    // High Pass Filter
    const hpfFreq = settings.highPassFrequency ?? 80;
    this.highPass.frequency.setTargetAtTime(hpfFreq, this.context.currentTime, 0.1);
    
    // Compressor
    const compThreshold = settings.compressorThreshold ?? -24;
    const compRatio = settings.compressorRatio ?? 4;
    this.compressor.threshold.setTargetAtTime(compThreshold, this.context.currentTime, 0.1);
    this.compressor.ratio.setTargetAtTime(compRatio, this.context.currentTime, 0.1);
    this.compressor.attack.setTargetAtTime(0.003, this.context.currentTime, 0.1);
    this.compressor.release.setTargetAtTime(0.25, this.context.currentTime, 0.1);
    
    // Start gate monitoring
    if (this.animationFrameId === null) {
      this.monitorGate();
    }
  }

  private monitorGate() {
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const check = () => {
      this.analyser.getByteTimeDomainData(dataArray);
      
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        const val = (dataArray[i] - 128) / 128;
        sum += val * val;
      }
      const rms = Math.sqrt(sum / bufferLength);
      this.currentPeak = rms;
      const db = 20 * Math.log10(rms || 0.00001);
      
      // Simple gate logic with smoothing
      const threshold = this.settings.noiseGateThreshold ?? -60;
      const targetGain = db > threshold ? 1 : 0;
      
      this.gateGain.gain.setTargetAtTime(targetGain, this.context.currentTime, 0.05);
      
      this.animationFrameId = requestAnimationFrame(check);
    };
    
    this.animationFrameId = requestAnimationFrame(check);
  }

  public getPeak(): number {
    return this.currentPeak;
  }

  public connectStream(stream: MediaStream) {
    this.source = this.context.createMediaStreamSource(stream);
    
    // Chain: Source -> MonoMixer -> HPF -> Gate -> Compressor -> Destination
    // Also connect MonoMixer to Analyser for gate detection
    this.source.connect(this.monoMixer);
    this.monoMixer.connect(this.highPass);
    this.monoMixer.connect(this.analyser);
    
    this.highPass.connect(this.gateGain);
    this.gateGain.connect(this.compressor);
    this.compressor.connect(this.destination);
  }

  public getDestinationStream(): MediaStream {
    return this.destination.stream;
  }

  public disconnect() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    this.monoMixer.disconnect();
    this.highPass.disconnect();
    this.gateGain.disconnect();
    this.compressor.disconnect();
    this.analyser.disconnect();
  }
}

/**
 * Удаляет короткие щелчки и слюнные призвуки из аудио-буфера.
 * Использует метод анализа второй производной (ускорения сигнала) и локального отклонения от огибающей.
 * Восстанавливает поврежденные участки посредством кубической или линейной интерполяции.
 */
export function deClickAudioBuffer(
  audioBuffer: AudioBuffer,
  sensitivity: number, // 0..100
  mouthDeClickEnabled: boolean,
  maxClickWidthMs: number = 2.0,
  detectorType: 'mouth' | 'mechanical' | 'broadband' = 'mouth'
): AudioBuffer {
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  
  // Создаем новый оффлайн-контекст или используем переданный
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const outputBuffer = ctx.createBuffer(numChannels, audioBuffer.length, sampleRate);
  
  // Коэффициент чувствительности: чем выше sensitivity, тем более чувствителен детектор
  // Преобразуем диапазон 0-100% в множитель порога отклонения. Чем меньше множитель, тем жестче порог.
  // Для 100% чувствительности множитель будет ~1.2 (очень чувствительно), для 0% ~9.0 (почти не реагирует)
  const thresholdFactor = 9.0 - (sensitivity / 100) * 7.8;
  const clickSamplesMax = Math.ceil((maxClickWidthMs / 1000) * sampleRate);
  
  for (let ch = 0; ch < numChannels; ch++) {
    const inputData = audioBuffer.getChannelData(ch);
    const outputData = outputBuffer.getChannelData(ch);
    
    // Копируем исходные данные
    outputData.set(inputData);
    
    const len = inputData.length;
    let i = 2;
    
    // Бегущее среднее локального отклонения (огибающая дисперсии шума)
    let localVariance = 0.005;
    const alpha = 0.9995; // Высокое сглаживание для плавной огибающей
    
    while (i < len - 2) {
      const x0 = inputData[i];
      
      // Вычисляем вторую производную для детекции локального пика/разрыва (ускорение сигнала)
      const derivative2 = Math.abs(inputData[i] - 2 * inputData[i - 1] + inputData[i - 2]);
      
      // Обновляем бегущую оценку локального стандартного отклонения
      localVariance = alpha * localVariance + (1.0 - alpha) * (derivative2 + 0.00005);
      
      // Добавим частотный фокус детекции на основе типа
      let freqFactor = 1.0;
      if (detectorType === 'mouth') {
        // Слюнные клики обычно высокочастотные и тихие
        freqFactor = 0.75; 
      } else if (detectorType === 'mechanical') {
        // Механические щелчки обычно громкие и резкие
        freqFactor = 1.25;
      } else if (detectorType === 'broadband') {
        // Широкополосные помехи
        freqFactor = 1.0;
      }
      
      const currentThreshold = localVariance * thresholdFactor * freqFactor;
      
      // Если рот-клик включен, мы делаем детектор еще более чувствительным к микро-разрывам
      const finalThreshold = mouthDeClickEnabled ? currentThreshold * 0.85 : currentThreshold;
      
      // Детектируем резкий выброс ускорения сигнала, который превышает порог
      if (derivative2 > finalThreshold && Math.abs(x0) > 0.002) {
        // Ищем конец щелчка (где производная спадет обратно под порог)
        let clickEndIdx = i;
        for (let j = i + 1; j < Math.min(i + clickSamplesMax, len - 2); j++) {
          const d2 = Math.abs(inputData[j] - 2 * inputData[j - 1] + inputData[j - 2]);
          if (d2 < finalThreshold) {
            clickEndIdx = j;
            break;
          }
        }
        
        const clickLength = clickEndIdx - i + 1;
        
        // Восстановление (интерполяция): плавно соединяем здоровый сигнал ДО и ПОСЛЕ щелчка
        const leftVal = inputData[i - 1];
        const rightVal = inputData[clickEndIdx + 1];
        
        for (let s = 0; s < clickLength; s++) {
          const t = (s + 1) / (clickLength + 1);
          
          // Используем Smoothstep (кубическую S-образную) интерполяцию вместо простой линейной
          // для более мягкого сопряжения краев восстановленного участка
          const smoothT = t * t * (3 - 2 * t);
          outputData[i + s] = leftVal + smoothT * (rightVal - leftVal);
        }
        
        // Смещаем индекс вперед за пределы восстановленного участка
        i = clickEndIdx + 2;
      } else {
        i++;
      }
    }
  }
  
  return outputBuffer;
}

