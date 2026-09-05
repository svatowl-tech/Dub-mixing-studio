class VstProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data.type === 'PROCESS_RESULT') {
        // Optional processing result
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0]) return true;

    // Send input buffer to main thread for VST processing
    this.port.postMessage({
      type: 'PROCESS_BLOCK',
      buffer: input[0], 
    });

    // Copy input to output (pass-through fallback)
    for (let channel = 0; channel < output.length; channel++) {
      if (input[channel]) {
        output[channel].set(input[channel]);
      }
    }

    return true;
  }
}

registerProcessor('vst-processor', VstProcessor);
