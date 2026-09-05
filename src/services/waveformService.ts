/**
 * Service to generate waveform data from audio blobs.
 */
export class WaveformService {
  /**
   * Generates a list of peaks for visualization from an audio blob.
   * @param blob The audio blob to analyze.
   * @param points Number of points to generate.
   */
  static async generatePeaks(blob: Blob, points: number = 100): Promise<number[]> {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      
      const channelData = audioBuffer.getChannelData(0); // Use first channel
      const step = Math.floor(channelData.length / points);
      const peaks: number[] = [];
      
      for (let i = 0; i < points; i++) {
        let max = 0;
        const start = i * step;
        const end = Math.min(start + step, channelData.length);
        
        for (let j = start; j < end; j++) {
          const val = Math.abs(channelData[j]);
          if (val > max) max = val;
        }
        peaks.push(max);
      }
      
      await audioCtx.close();
      return peaks;
    } catch (e) {
      console.warn("Waveform generation failed, returning dummy peaks", e);
      return this.generateDummyPeaks(points);
    }
  }

  /**
   * Generates sample peaks based on duration when real data is unavailable.
   */
  static generateDummyPeaks(points: number): number[] {
    const peaks: number[] = [];
    for (let i = 0; i < points; i++) {
      // Create a "pulse" like waveform with some noise
      const base = 0.1 + Math.random() * 0.2;
      const pulse = Math.sin(i * 0.1) * 0.1;
      peaks.push(Math.max(0.01, base + pulse));
    }
    return peaks;
  }
}
