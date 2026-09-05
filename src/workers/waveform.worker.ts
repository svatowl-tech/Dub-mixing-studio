self.onmessage = async (e) => {
  const { channelData, samples } = e.data;
  
  try {
    // We expect a Float32Array of raw audio data from the main thread
    // since decodeAudioData is not available in Web Workers.
    const data = new Float32Array(channelData);
    const blockSize = Math.floor(data.length / samples);
    const peaks = new Float32Array(samples);
    
    for (let i = 0; i < samples; i++) {
      let min = 1.0;
      let max = -1.0;
      const start = i * blockSize;
      const end = start + blockSize;
      
      for (let j = start; j < end; j++) {
        const val = data[j];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      
      // Store the max absolute value for the peak
      peaks[i] = Math.max(Math.abs(min), Math.abs(max));
    }
    
    self.postMessage({ peaks: Array.from(peaks) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
