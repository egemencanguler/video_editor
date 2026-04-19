// AudioWorklet processor for recording microphone input as raw PCM.
// Runs on the audio thread — posts Float32Array chunks to the main thread.

class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._active = true;
        this.port.onmessage = (e) => {
            if (e.data === 'stop') this._active = false;
        };
    }

    process(inputs) {
        if (!this._active) return false;
        const input = inputs[0];
        if (input && input.length > 0) {
            const channels = [];
            for (let ch = 0; ch < input.length; ch++) {
                // Must copy — the underlying buffer is reused by the audio thread
                channels.push(new Float32Array(input[ch]));
            }
            this.port.postMessage({ channels });
        }
        return true;
    }
}

registerProcessor('recorder-processor', RecorderProcessor);
