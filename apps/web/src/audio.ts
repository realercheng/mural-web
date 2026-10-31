import { decodeMulaw } from '../server/src/wire';
import { PlaybackClock } from './playback';

const OUTPUT_RATE = 24_000;

/** Microphone capture and speech playback through one AudioContext. */
export class AudioEngine {
  onChunk: (pcm: Int16Array, level: number) => void = () => {};
  inputLevel = 0;
  private context?: AudioContext;
  private stream?: MediaStream;
  private capture?: AudioWorkletNode;
  private analyser?: AnalyserNode;
  clock = new PlaybackClock();
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
      this.onChunk(new Int16Array(event.data.pcm), event.data.level);
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

  /** Seconds of received speech still waiting to play; growth means the network is behind. */
  get backlog(): number { return this.context ? this.clock.backlog(this.context.currentTime) : 0; }

  play(mulaw: Uint8Array, offsetSamples: number): void {
    const context = this.context, analyser = this.analyser;
    if (!context || !analyser) return;
    const pcm = decodeMulaw(mulaw);
    if (!pcm.length) return;
    const buffer = context.createBuffer(1, pcm.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    source.start(this.clock.schedule(offsetSamples / OUTPUT_RATE, buffer.duration, context.currentTime));
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
    this.inputLevel = 0; this.clock = new PlaybackClock();
  }
}

/**
 * Sends speech only. Quiet chunks are held briefly so a word's soft start is not lost, and a
 * one-byte heartbeat each second tells the gateway the microphone pipeline is still running.
 */
export class SpeechGate {
  private held: Int16Array[] = [];
  private openUntil = 0;
  private quietChunks = 0;
  sentChunks = 0;
  constructor(private readonly send: (pcm: Int16Array | null) => void, private readonly threshold = 0.008,
              private readonly hangoverMs = 1_000, private readonly preRollChunks = 3) {}

  push(pcm: Int16Array, level: number, now = Date.now()): void {
    if (level >= this.threshold) {
      this.held.forEach(chunk => this.send(chunk)); this.sentChunks += this.held.length; this.held = [];
      this.openUntil = now + this.hangoverMs;
    }
    if (now < this.openUntil) { this.send(pcm); this.sentChunks++; this.quietChunks = 0; return; }
    this.held = [...this.held, pcm].slice(-this.preRollChunks);
    if (++this.quietChunks % 10 === 0) this.send(null);
  }
}
