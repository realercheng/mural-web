// Converts microphone input to 24 kHz mono PCM16 in 100 ms chunks, as GPT-Live requires.
// Muting sends silence instead of stopping, because the session expires without input audio.
const TARGET_RATE = 24000;
const CHUNK = 2400;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.position = 0;
    this.previous = 0;
    this.buffer = new Int16Array(CHUNK);
    this.length = 0;
    this.energy = 0;
    this.samples = 0;
    this.muted = false;
    this.port.onmessage = (event) => { if (typeof event.data?.muted === 'boolean') this.muted = event.data.muted; };
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;
    for (let i = 0; i < input.length; i++) { this.energy += input[i] * input[i]; }
    this.samples += input.length;
    // Linear interpolation; index -1 refers to the last sample of the previous block.
    let position = this.position;
    const last = input.length - 1;
    while (position < last) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = index < 0 ? this.previous : input[index];
      const b = input[index + 1];
      const value = this.muted ? 0 : a + (b - a) * fraction;
      this.buffer[this.length++] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
      if (this.length === CHUNK) this.flush();
      position += this.step;
    }
    this.position = position - input.length;
    this.previous = input[last];
    return true;
  }

  flush() {
    const level = this.muted || this.samples === 0 ? 0 : Math.sqrt(this.energy / this.samples);
    this.port.postMessage({ pcm: this.buffer.buffer, level }, [this.buffer.buffer]);
    this.buffer = new Int16Array(CHUNK);
    this.length = 0;
    this.energy = 0;
    this.samples = 0;
  }
}

registerProcessor('pcm-capture', PcmCapture);
