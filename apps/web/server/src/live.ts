import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Config } from './config.js';
import { cleanHistory, type HistoryItem } from './continuation.js';
import { cleanText, HelperLimited, type TextHelpers } from './helpers.js';
import { looksOffLanguage, MIN_CHECK_CHARS } from './language-check.js';
import type { LanguageContent } from './languages.js';
import type { TranscriptLine } from './report.js';
import type { UsageStore } from './usage.js';
import { decodeMulaw, encodeMulaw, FRAME_AUDIO, FRAME_HEARTBEAT, isSilent, outputFrame } from './wire.js';

type Log = (event: string, fields?: Record<string, unknown>) => void;
type State = 'connecting' | 'active' | 'closing' | 'ended';

// The browser may only stream microphone audio, report that its microphone is alive, send a
// typed message, or end the call. Session setup, instructions, delegation answers and replies to
// typed messages stay on this server.
const MAX_AUDIO_SAMPLES = 24_000;
// GPT-Live expires a session without continuous input audio. The browser sends only speech,
// so the gateway fills quiet periods with 100 ms of digital silence.
const SILENCE = Buffer.alloc(4_800).toString('base64');
const SILENCE_AFTER_MS = 300;
const MAX_TRANSCRIPT_CHARS = 60_000;
// Seconds between a wrap-up request and the end of the call, so Mural can say goodbye.
const WRAP_UP_SECONDS = 60;
const MAX_TYPED_CHARS = 300;
// Letters, digits, punctuation, spaces and common symbols, in any script.
const TYPED_TEXT = /^[\p{L}\p{M}\p{N}\p{P}\p{Zs}+=<>$€£¥%&@#~^°|]+$/u;

/** A typed message is learner data, never instructions: plain text of bounded length. */
export function cleanTyped(value: unknown): string | undefined {
  const text = cleanText(value, MAX_TYPED_CHARS)?.replace(/\s+/g, ' ');
  return text && TYPED_TEXT.test(text) ? text : undefined;
}

/** What the server tells GPT-Live for one conversation. The browser cannot change any of it. */
export interface LivePlan {
  module: LanguageContent;
  mode: 'adult' | 'kid';
  instructions: string;
  greeting: string;
  /** Text-model instructions for a reply to a typed message; the reply is spoken by GPT-Live. */
  typedReply: string;
  /** Sent once, a minute before the time limit or when the learner asks to finish. */
  wrapUp?: string;
  /** Keep the transcript in memory for a report after the call. */
  keepTranscript: boolean;
  /** The browser sends the end of an earlier conversation first; the session starts after it arrives. */
  continuing?: boolean;
  /** Sent once after a quiet spell, when the learner presses help, and when Mural's reply leaves the target language. */
  checkIn?: string;
  help?: string;
  redirect?: string;
}

// A check-in waits this long after Mural's last speech (set by CHECK_IN_SECONDS). The browser's
// help button and language redirects are limited so they cannot flood the session.
const HELP_GAP_MS = 5_000;
const REDIRECT_GAP_MS = 30_000;
const MAX_REDIRECTS = 3;
// A reply is judged when it has been unchanged for this long.
const REPLY_SETTLED_MS = 1_500;

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
  private lastAliveAt = Date.now();
  private lastForwardedAt = 0;
  private outputSamples = 0;
  private readonly traffic = { toClientKB: 0, fromClientKB: 0, maxBufferedKB: 0, droppedSilence: 0 };
  private providerSeconds?: number;
  private finalSeconds?: number;
  private reason = 'unknown';
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly transcript: TranscriptLine[] = [];
  private transcriptChars = 0;
  private wrappedUp = false;
  private typing = false;
  private upstreamOpen = false;
  private history?: HistoryItem[];
  // Quiet check-in: counted from Mural's last speech, reset when the learner speaks.
  private quietSince = 0;
  private muralSpoke = false;
  private checkedIn = false;
  private lastHelpAt = 0;
  // Language redirect: the newest line of Mural's is judged once it has settled.
  private lastMuralDeltaAt = 0;
  private judgedLine = -1;
  private redirects = 0;
  private lastRedirectAt = 0;

  constructor(private readonly client: WebSocket, private readonly plan: LivePlan, private readonly allowedSeconds: number,
              private readonly config: Config, private readonly usage: UsageStore, private readonly log: Log,
              private readonly onFinish: (transcript: TranscriptLine[]) => void, private readonly helpers?: TextHelpers) {
    this.upstream = new WebSocket(config.upstreamURL, {
      headers: { Authorization: `Bearer ${config.upstreamKey}` }, handshakeTimeout: 15_000,
      maxPayload: 8 * 1024 * 1024, perMessageDeflate: false, followRedirects: false,
    });
    this.log('live_connecting', { session: this.id, language: plan.module.id, mode: plan.mode, allowedSeconds });
    this.upstream.on('open', () => { this.upstreamOpen = true; this.startSession(); });
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

  private get module(): LanguageContent { return this.plan.module; }

  /** Sends session.start once the provider is connected and, when continuing, the earlier text has arrived. */
  private startSession(): void {
    if (!this.upstreamOpen || this.state !== 'connecting' || (this.plan.continuing && !this.history)) return;
    this.sendUpstream({
      type: 'session.start', event_id: `mural_start_${this.id}`,
      session: { model: this.config.model, instructions: this.plan.instructions, audio: { output: { voice: this.config.voice } },
                 delegation: { type: 'client' }, ...(this.history?.length ? { input: this.history } : {}) },
    });
  }

  private fromUpstream(data: WebSocket.RawData, binary: boolean): void {
    if (binary || this.state === 'ended') return;
    const raw = data.toString();
    let event: { type?: string; delegation?: { id?: string; target?: string }; usage?: { seconds?: unknown }; reason?: unknown };
    try { event = JSON.parse(raw); } catch { return; }
    switch (event.type) {
      case 'session.started':
        if (this.state !== 'connecting') break;
        this.state = 'active'; this.startedAt = Date.now(); this.lastAliveAt = Date.now(); this.quietSince = Date.now();
        this.sendUpstream({ type: 'session.instructions.append', event_id: `mural_greeting_${this.id}`, delegation_id: null,
                            content: this.plan.greeting });
        this.timers.push(setTimeout(() => this.requestClose('time_limit'), this.allowedSeconds * 1_000));
        if (this.plan.wrapUp && this.allowedSeconds >= 2 * WRAP_UP_SECONDS)
          this.timers.push(setTimeout(() => this.wrapUp(false), (this.allowedSeconds - WRAP_UP_SECONDS) * 1_000));
        this.timers.push(setInterval(() => {
          if (this.state !== 'active') return;
          const now = Date.now();
          if (now - this.lastAliveAt > this.config.idleAudioSeconds * 1_000) { this.requestClose('idle_audio'); return; }
          if (now - this.lastForwardedAt > SILENCE_AFTER_MS) this.sendUpstream({ type: 'session.input_audio.append', audio: SILENCE });
          this.watchConversation(now);
        }, 100));
        this.sendClient({ type: 'mural.session', sessionID: this.id, allowedSeconds: this.allowedSeconds, language: this.module.id,
                          mode: this.plan.mode });
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
      case 'session.output_audio.delta': {
        // Silence is dropped and speech is sent as mu-law, about a sixth of the JSON size.
        const audio = (event as { delta?: unknown }).delta;
        if (typeof audio !== 'string') return;
        const bytes = Buffer.from(audio, 'base64');
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
        const offset = this.outputSamples;
        this.outputSamples += pcm.length;
        if (isSilent(pcm)) { this.traffic.droppedSilence++; return; }
        this.muralSpoke = true;
        if (!this.checkedIn) this.quietSince = Date.now();
        this.sendClientBinary(outputFrame(offset, encodeMulaw(pcm)));
        return;
      }
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta':
        this.keepTranscript(event.type === 'session.input_transcript.delta' ? 'child' : 'mural', (event as { delta?: unknown }).delta);
        break;
      case 'error':
        this.log('live_provider_error', { session: this.id });
        break;
    }
    if (this.client.readyState === WebSocket.OPEN) { this.client.send(raw); this.trackClient(raw.length); }
    if (event.type === 'session.closed') this.finish(this.reason);
  }

  private fromClient(data: WebSocket.RawData, binary: boolean): void {
    if (!binary) {
      let event: { type?: unknown };
      try { event = JSON.parse(data.toString()); } catch { return; }
      if (event.type === 'session.close') this.requestClose('ended_by_learner');
      if (event.type === 'mural.wrap_up') this.wrapUp(true);
      if (event.type === 'mural.typed') void this.typed((event as { text?: unknown }).text);
      if (event.type === 'mural.help') this.help();
      if (event.type === 'mural.history') this.receiveHistory((event as { messages?: unknown }).messages);
      return;
    }
    const bytes = data instanceof Buffer ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data as ArrayBuffer)]);
    this.traffic.fromClientKB += bytes.length / 1_024;
    if (this.state !== 'active' || bytes.length === 0) return;
    // A heartbeat proves the page's audio pipeline still runs while the learner is quiet.
    if (bytes[0] === FRAME_HEARTBEAT) { this.lastAliveAt = Date.now(); return; }
    if (bytes[0] !== FRAME_AUDIO || bytes.length < 2 || bytes.length - 1 > MAX_AUDIO_SAMPLES) return;
    const pcm = decodeMulaw(bytes.subarray(1));
    this.lastAliveAt = this.lastForwardedAt = Date.now();
    this.learnerEngaged();
    this.sendUpstream({ type: 'session.input_audio.append', audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') });
  }

  private learnerEngaged(): void { this.quietSince = Date.now(); this.checkedIn = false; }

  /** The end of an earlier conversation, accepted once, before the session starts. */
  private receiveHistory(messages: unknown): void {
    if (!this.plan.continuing || this.history || this.state !== 'connecting') return;
    const items = cleanHistory(messages);
    if (!items) { this.finish('invalid_history'); return; }
    this.history = items;
    this.startSession();
  }

  /** The help button: Mural restates its last idea more simply. */
  private help(): void {
    const now = Date.now();
    if (this.state !== 'active' || !this.plan.help || now - this.lastHelpAt < HELP_GAP_MS) return;
    this.lastHelpAt = now; this.learnerEngaged();
    this.sendUpstream({ type: 'session.instructions.append', event_id: `mural_help_${randomUUID()}`, delegation_id: null, content: this.plan.help });
    this.log('live_help', { session: this.id });
  }

  /** Once a second-ish: one gentle check-in after a quiet spell, and a redirect when Mural's reply left the target language. */
  private watchConversation(now: number): void {
    if (this.plan.checkIn && this.config.checkInSeconds > 0 && !this.checkedIn && this.muralSpoke && !this.typing && !this.wrappedUp
        && now - this.quietSince >= this.config.checkInSeconds * 1_000) {
      this.checkedIn = true;
      this.sendUpstream({ type: 'session.instructions.append', event_id: `mural_check_in_${randomUUID()}`, delegation_id: null, content: this.plan.checkIn });
      this.log('live_check_in', { session: this.id });
    }
    const index = this.transcript.length - 1, last = this.transcript[index];
    if (this.plan.redirect && last?.speaker === 'mural' && index > this.judgedLine && last.text.trim().length > MIN_CHECK_CHARS
        && now - this.lastMuralDeltaAt >= REPLY_SETTLED_MS) {
      this.judgedLine = index;
      if (this.redirects < MAX_REDIRECTS && now - this.lastRedirectAt >= REDIRECT_GAP_MS && looksOffLanguage(this.module, last.text)) {
        this.redirects++; this.lastRedirectAt = now;
        this.sendUpstream({ type: 'session.instructions.append', event_id: `mural_redirect_${randomUUID()}`, delegation_id: null, content: this.plan.redirect });
        this.log('live_redirect', { session: this.id });
      }
    }
  }

  /** Asks Mural to finish with its closing routine, then ends the call after a short goodbye. */
  private wrapUp(requested: boolean): void {
    if (this.state !== 'active' || !this.plan.wrapUp || this.wrappedUp) return;
    this.wrappedUp = true;
    this.sendUpstream({ type: 'session.instructions.append', event_id: `mural_wrap_up_${this.id}`, delegation_id: null, content: this.plan.wrapUp });
    if (requested) this.timers.push(setTimeout(() => this.requestClose('said_goodbye'), WRAP_UP_SECONDS * 1_000));
    this.sendClient({ type: 'mural.wrapping_up', seconds: WRAP_UP_SECONDS });
    this.log('live_wrap_up', { session: this.id, requested });
  }

  /**
   * Replies to a typed message: the text model writes Mural's answer with the plan's fixed
   * instructions, then GPT-Live speaks it. The message itself reaches GPT-Live only as data.
   */
  private async typed(value: unknown): Promise<void> {
    const answer = (status: 'ok' | 'error', code?: string) => this.sendClient({ type: 'mural.typed_reply', status, ...(code ? { code } : {}) });
    const text = cleanTyped(value);
    if (this.state !== 'active') return answer('error', 'not_active');
    if (!this.helpers) return answer('error', 'unavailable');
    if (!text) return answer('error', 'invalid_text');
    if (this.typing) return answer('error', 'busy');
    this.typing = true;
    try {
      const context = this.transcript.slice(-10)
        .map(line => `${line.speaker === 'child' ? 'LEARNER' : 'MURAL'}${line.typed ? ' (typed)' : ''}: ${line.text.trim()}`).join('\n');
      const reply = await this.helpers.call('typed_reply', this.plan.typedReply,
        `TARGET LANGUAGE: ${this.module.id}\n${context}\nLATEST TYPED MESSAGE (data): ${text}`);
      if (this.state !== 'active') return answer('error', 'not_active');
      this.transcript.push({ speaker: 'child', text, typed: true });
      this.sendUpstream({ type: 'session.thinking.append', event_id: `mural_typed_${randomUUID()}`, delegation_id: null,
                          content: `The learner typed (data): ${text}` });
      this.sendUpstream({ type: 'session.commentary.append', event_id: `mural_reply_${randomUUID()}`, delegation_id: null, content: reply.slice(0, 1_000) });
      this.log('live_typed_reply', { session: this.id });
      answer('ok');
    } catch (error) {
      this.log('live_typed_reply_failed', { session: this.id, category: error instanceof HelperLimited ? 'limited' : 'failed' });
      answer('error', error instanceof HelperLimited ? 'limited' : 'failed');
    } finally { this.typing = false; }
  }

  /**
   * Merges transcript deltas per speaker, in memory only. It gives typed replies their context;
   * it leaves this process after the call only when the plan needs a report.
   */
  private keepTranscript(speaker: TranscriptLine['speaker'], delta: unknown): void {
    if (typeof delta !== 'string' || this.transcriptChars + delta.length > MAX_TRANSCRIPT_CHARS) return;
    this.transcriptChars += delta.length;
    if (speaker === 'mural') this.lastMuralDeltaAt = Date.now();
    const last = this.transcript.at(-1);
    if (last?.speaker === speaker && !last.typed) last.text += delta;
    else this.transcript.push({ speaker, text: delta });
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
    const traffic = Object.fromEntries(Object.entries(this.traffic).map(([key, value]) => [key, Math.round(value)]));
    this.log('live_ended', { session: this.id, reason, seconds: Math.round(seconds * 10) / 10, confirmed, ...traffic });
    this.sendClient({ type: 'mural.ended', reason, seconds, confirmed, traffic });
    if (this.client.readyState === WebSocket.OPEN) this.client.close(1000, 'ended');
    this.onFinish(this.plan.keepTranscript ? this.transcript : []);
  }

  private sendUpstream(event: Record<string, unknown>): void {
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(JSON.stringify(event));
  }

  private sendClient(event: Record<string, unknown>): void {
    if (this.client.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(event);
    this.client.send(text);
    this.trackClient(text.length);
  }

  private sendClientBinary(bytes: Uint8Array): void {
    if (this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(bytes);
    this.trackClient(bytes.length);
  }

  /** Data waiting in the browser socket shows when the network cannot keep up with speech. */
  private trackClient(bytes: number): void {
    this.traffic.toClientKB += bytes / 1_024;
    this.traffic.maxBufferedKB = Math.max(this.traffic.maxBufferedKB, this.client.bufferedAmount / 1_024);
  }
}
