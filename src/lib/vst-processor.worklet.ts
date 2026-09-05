declare const AudioWorkletProcessor: any;
declare const registerProcessor: any;

class VstProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data.type === 'PROCESS_RESULT') {
        // In some designs we might wait for sync, but here we probably 
        // just pass through if we haven't received the result yet.
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0]) return true;

    // Send input buffer to main thread for VST processing
    // Note: This is asynchronous and might introduce 1-block latency or jitter.
    // For real-time VST in DAW, a SharedArrayBuffer approach would be better.
    this.port.postMessage({
      type: 'PROCESS_BLOCK',
      buffer: input[0], // Only mono for now in this mock/simple impl
    });

    // Copy input to output (pass-through while waiting for VST or if bypass)
    for (let channel = 0; channel < output.length; channel++) {
      if (input[channel]) {
        output[channel].set(input[channel]);
      }
    }

    return true;
  }
}

registerProcessor('vst-processor', VstProcessor);
