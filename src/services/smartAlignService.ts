export class SmartAlignService {
  /**
   * Simple Dynamic Time Warping (DTW) to find the best alignment factor.
   * For simplicity, we compare the envelopes (energy) of the two signals.
   */
  static async calculateOptimalRate(originalPeaks: number[], recordedPeaks: number[]): Promise<number> {
    if (originalPeaks.length === 0 || recordedPeaks.length === 0) return 1.0;

    // Normalize peaks to [0, 1]
    const normOrig = this.normalize(originalPeaks);
    const normRec = this.normalize(recordedPeaks);

    // We want to find a scaling factor 's' such that recordedPeaks scaled by 's' 
    // matches originalPeaks best.
    // In a real app, we'd use full DTW, but for "Smart Align" in a dubbing context,
    // we often just need the overall duration adjustment to fit the phrase.
    
    // However, the user asked for DTW or fingerprinting.
    // Let's implement a basic DTW distance to evaluate different rates.
    
    let bestRate = 1.0;
    let minDistance = Infinity;

    // Test rates from 0.5x to 2.0x
    for (let rate = 0.8; rate <= 1.25; rate += 0.01) {
      const scaledRec = this.resample(normRec, Math.round(normRec.length / rate));
      const distance = this.dtwDistance(normOrig, scaledRec);
      
      if (distance < minDistance) {
        minDistance = distance;
        bestRate = rate;
      }
    }

    return parseFloat(bestRate.toFixed(2));
  }

  private static normalize(arr: number[]): number[] {
    const max = Math.max(...arr, 0.0001);
    return arr.map(v => v / max);
  }

  private static resample(arr: number[], newLength: number): number[] {
    const resampled = new Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const oldIdx = (i / newLength) * arr.length;
      const left = Math.floor(oldIdx);
      const right = Math.min(left + 1, arr.length - 1);
      const frac = oldIdx - left;
      resampled[i] = arr[left] * (1 - frac) + arr[right] * frac;
    }
    return resampled;
  }

  private static dtwDistance(s: number[], t: number[]): number {
    const n = s.length;
    const m = t.length;
    const dtw = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));

    dtw[0][0] = 0;

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const cost = Math.abs(s[i - 1] - t[j - 1]);
        dtw[i][j] = cost + Math.min(dtw[i - 1][j], dtw[i][j - 1], dtw[i - 1][j - 1]);
      }
    }

    return dtw[n][m] / (n + m); // Normalized distance
  }
}
