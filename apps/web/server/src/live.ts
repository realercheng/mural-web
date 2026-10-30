import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Config } from './config.js';
import type { LanguageContent } from './languages.js';
import { greeting, voiceInstructions } from './policy.js';
import type { UsageStore } from './usage.js';

type Log = (event: string, fields?: Record<string, unknown>) => void;
type State = 'connecting' | 'active' | 'closing' | 'ended';

// The browser may only stream microphone audio or end the call. Session setup,
// instructions and delegation answers stay on this server.
const MAX_AUDIO_CHARS = 200_000;

/**
 * Relays one browser conversation to GPT-Live over WebSocket. The provider key never
 * leaves this process; the session ends at the earliest of the time limit, idle audio,
 * a browser request or a lost connection.
 */
export class LiveRelay {
  readonly id = randomUUID();
  private state: State = 'connecting';
  private readonly upstream: WebSocket;
  private readonly openedAt = Date.now();
  private startedAt?: number;
  private lastAudioAt = Date.now();
  private providerSeconds?: number;
  private finalSeconds?: number;
  private reason = 'unknown';
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(private readonly client: WebSocket, private readonly module: LanguageContent, private readonly allowedSeconds: number,
              private readonly config: Config, private readonly usage: UsageStore, private readonly log: Log,
              private readonly onFinish: () => void) {
    this.upstream = new WebSocket(config.upstreamURL, {
      headers: { Authorization: `Bearer ${config.upstreamKey}` }, handshakeTimeout: 15_000,
      maxPayload: 8 * 1024 * 1024, perMessageDeflate: false, followRedirects: false,
    });
    this.log('live_connecting', { session: this.id, language: module.id, allowedSeconds });
    this.upstream.on('open', () => this.sendUpstream({
      type: 'session.start', event_id: `mural_start_${this.id}`,
      session: { model: config.model, instructions: voiceInstructions(module), audio: { output: { voice: config.voice } },
                 delegation: { type: 'client' } },
    }));
    this.upstream.on('message', (data, binary) => this.fromUpstream(data, binary));
    this.upstream.on('unexpected-response', (_request, response) => {
      this.log('live_upstream_rejected', { session: this.id, status: response.statusCode });
      response.resume();
      this.finish('upstream_rejected');
    });
    this.upstream.on('error', () => this.finish('upstream_error'));
    this.upstream.on('close', () => this.finish(this.state === 'closing' ? this.reason : 'upstream_closed'));
    client.on('message', (data, binary) => this.fromClient(data, binary));
    client.on('close', () => this.requestClose('browser_disconnected'));
    client.on('error', () => this.requestClose('browser_error'));
    this.timers.push(setTimeout(() => { if (this.state === 'connecting') this.finish('start_timeout'); }, 20_000));
  }

  private fromUpstream(data: WebSocket.RawData, binary: boolean): void {
    if (binary || this.state === 'ended') return;
    const raw = data.toString();
    let event: { type?: string; delegation?: { id?: string; target?: string }; usage?: { seconds?: unknown }; reason?: unknown };
    try { event = JSON.parse(raw); } catch { return; }
    switch (event.type) {
      case 'session.started':
        if (this.state !== 'connecting') break;
        this.state = 'active'; this.startedAt = Date.now(); this.lastAudioAt = Date.now();
        this.sendUpstream({ type: 'session.instructions.append', event_id: `mural_greeting_${this.id}`, delegation_id: null,
                            content: greeting(this.module) });
        this.timers.push(setTimeout(() => this.requestClose('time_limit'), this.allowedSeconds * 1_000));
        this.timers.push(setInterval(() => {
          if (this.state === 'active' && Date.now() - this.lastAudioAt > this.config.idleAudioSeconds * 1_000) this.requestClose('idle_audio');
        }, 1_000));
        this.sendClient({ type: 'mural.session', sessionID: this.id, allowedSeconds: this.allowedSeconds, language: this.module.id });
        this.log('live_started', { session: this.id });
        break;
      case 'session.delegation.created':
        // No lookup backend in the prototype: answer with the module's fixed fallback.
        if (event.delegation?.target === 'client' && typeof event.delegation.id === 'string')
          this.sendUpstream({ type: 'session.commentary.append', event_id: `mural_delegation_${randomUUID()}`,
                              delegation_id: event.delegation.id, content: this.module.lookupUnavailableReply });
        break;
      case 'session.usage.updated':
      case 'session.closed': {
        const seconds = event.usage?.seconds;
        if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
          this.providerSeconds = seconds;
          if (event.type === 'session.closed') this.finalSeconds = seconds;
        }
        if (event.type === 'session.closed' && typeof event.reason === 'string' && this.state !== 'closing') this.reason = event.reason;
        break;
      }
      case 'error':
        this.log('live_provider_error', { session: this.id });
        break;
    }
    if (this.client.readyState === WebSocket.OPEN) this.client.send(raw);
    if (event.type === 'session.closed') this.finish(this.reason);
  }

  private fromClient(data: WebSocket.RawData, binary: boolean): void {
    if (binary) return;
    let event: { type?: unknown; audio?: unknown };
    try { event = JSON.parse(data.toString()); } catch { return; }
    if (event.type === 'session.close') { this.requestClose('ended_by_learner'); return; }
    if (event.type !== 'session.input_audio.append' || this.state !== 'active') return;
    if (typeof event.audio !== 'string' || event.audio.length > MAX_AUDIO_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.audio)) return;
    this.lastAudioAt = Date.now();
    this.sendUpstream({ type: 'session.input_audio.append', audio: event.audio });
  }

  requestClose(reason: string): void {
    if (this.state === 'closing' || this.state === 'ended') return;
    if (this.state === 'connecting') { this.finish(reason); return; }
    this.state = 'closing'; this.reason = reason;
    this.log('live_close_requested', { session: this.id, reason });
    this.sendUpstream({ type: 'session.close', event_id: `mural_close_${this.id}` });
    this.timers.push(setTimeout(() => this.finish(`${reason}_unconfirmed`), this.config.closeGraceSeconds * 1_000));
  }

  private finish(reason: string): void {
    if (this.state === 'ended') return;
    const wasStarted = this.startedAt !== undefined;
    this.state = 'ended';
    this.timers.forEach(clearTimeout);
    if (this.upstream.readyState === WebSocket.OPEN || this.upstream.readyState === WebSocket.CONNECTING) this.upstream.terminate();
    // Without a final provider event, count connected wall-clock time so limits stay conservative.
    const wallclock = wasStarted ? (Date.now() - this.startedAt!) / 1_000 : 0;
    const confirmed = this.finalSeconds !== undefined;
    const seconds = confirmed ? this.finalSeconds! : Math.max(this.providerSeconds ?? 0, wallclock);
    if (wasStarted || seconds > 0)
      this.usage.record({ id: this.id, language: this.module.id, startedAt: new Date(this.startedAt ?? this.openedAt).toISOString(),
                          endedAt: new Date().toISOString(), seconds, source: confirmed ? 'provider' : 'wallclock', reason });
    this.log('live_ended', { session: this.id, reason, seconds: Math.round(seconds * 10) / 10, confirmed });
    this.sendClient({ type: 'mural.ended', reason, seconds, confirmed });
    if (this.client.readyState === WebSocket.OPEN) this.client.close(1000, 'ended');
    this.onFinish();
  }

  private sendUpstream(event: Record<string, unknown>): void {
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(JSON.stringify(event));
  }

  private sendClient(event: Record<string, unknown>): void {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(event));
  }
}
