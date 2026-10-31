// Dropped silence longer than this marks a new utterance; the shortest pause kept between them.
const UTTERANCE_GAP = 0.15, PAUSE = 0.15;

/**
 * Places received speech on the provider's timeline. GPT-Live's output timeline runs at wall-clock
 * speed, so speech plays at `anchor + position` behind a jitter buffer.
 *
 * - A chunk that arrives after its slot (a network stall) moves the anchor later and grows the
 *   buffer by 0.1 s, up to 0.8 s.
 * - Stalls only ever move the anchor later. Without a correction the delays add up, and the text
 *   on screen runs seconds ahead of the voice. So when a new utterance starts (a jump on the
 *   timeline, where silence was dropped), the anchor moves back as far as possible: the utterance
 *   starts one jitter buffer after it arrived, or shortly after the speech still playing ends.
 *   The pause between utterances gets shorter; speech never overlaps.
 */
export class PlaybackClock {
  private anchor?: number;
  private nextPlayback = 0;
  private lastEnd = 0;
  jitterBuffer = 0.25;
  underruns = 0;
  catchUps = 0;

  /** Returns the context time at which a chunk at `position` seconds on the provider timeline should start. */
  schedule(position: number, duration: number, now: number): number {
    if (this.anchor === undefined) this.anchor = now + this.jitterBuffer - position;
    else if (this.anchor + position < now + 0.02) {
      this.underruns++;
      this.jitterBuffer = Math.min(0.8, this.jitterBuffer + 0.1);
      this.anchor = now + this.jitterBuffer - position;
    } else if (position - this.lastEnd > UTTERANCE_GAP) {
      const earliest = Math.max(now + this.jitterBuffer, this.nextPlayback + PAUSE) - position;
      if (earliest < this.anchor - 0.01) { this.catchUps++; this.anchor = earliest; }
    }
    const at = this.anchor + position;
    this.nextPlayback = Math.max(this.nextPlayback, at + duration);
    this.lastEnd = Math.max(this.lastEnd, position + duration);
    return at;
  }

  /** Seconds of received speech still waiting to play; growth means playback is behind. */
  backlog(now: number): number { return Math.max(0, this.nextPlayback - now); }
}
