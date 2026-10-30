const OUTPUT_RATE = 24_000;

/** Microphone capture and speech playback through one AudioContext. */
export class AudioEngine {
  onChunk: (pcm: ArrayBuffer) => void = () => {};
  inputLevel = 0;
  private context?: AudioContext;
  private stream?: MediaStream;
  private capture?: AudioWorkletNode;
  private analyser?: AnalyserNode;
  private nextPlayback = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private samples = new Float32Array(1024);

  get sampleRate() { return this.context?.sampleRate ?? 0; }
  get microphoneTrack() { return this.stream?.getAudioTracks()[0]; }

  /** Call from a user gesture so iOS allows audio playback. */
  async start(): Promise<void> {
    const context = new AudioContext({ latencyHint: 'interactive' });
    this.context = context;
    await context.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await context.audioWorklet.addModule('/pcm-capture.js');
    const capture = new AudioWorkletNode(context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    capture.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      this.inputLevel = event.data.level;
      this.onChunk(event.data.pcm);
    };
    const silent = context.createGain();
    silent.gain.value = 0;
    context.createMediaStreamSource(this.stream).connect(capture).connect(silent).connect(context.destination);
    this.capture = capture;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.connect(context.destination);
  }

  mute(muted: boolean): void { this.capture?.port.postMessage({ muted }); }

  play(base64: string): void {
    const context = this.context, analyser = this.analyser;
    if (!context || !analyser) return;
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    if (!pcm.length) return;
    const buffer = context.createBuffer(1, pcm.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    const at = Math.max(context.currentTime + 0.03, this.nextPlayback);
    source.start(at);
    this.nextPlayback = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  outputLevel(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const value of this.samples) sum += value * value;
    return Math.sqrt(sum / this.samples.length);
  }

  async stop(): Promise<void> {
    this.sources.forEach(source => { try { source.stop(); } catch { /* already ended */ } });
    this.sources.clear();
    this.stream?.getTracks().forEach(track => track.stop());
    this.capture?.disconnect();
    await this.context?.close().catch(() => {});
    this.context = undefined; this.stream = undefined; this.capture = undefined; this.analyser = undefined;
    this.nextPlayback = 0; this.inputLevel = 0;
  }
}

export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
