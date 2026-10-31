import type { Config } from './config.js';
import { respond } from './responses.js';

// Short text-model calls during and after a conversation. Ports the purpose allowlist of
// services/api/src/hosted-helpers.ts for one user without accounts or billing: each purpose has
// fixed server-side instructions, an input size limit and an output limit, and all purposes share
// a per-minute and a per-day call budget. Content is held only for the duration of one call.
export const HELPER_PURPOSES = ['meaning', 'lookup', 'typed_reply'] as const;
export type HelperPurpose = typeof HELPER_PURPOSES[number];

const LIMITS: Record<HelperPurpose, { maxOutputTokens: number; timeoutMs: number; maxChars: number }> = {
  meaning: { maxOutputTokens: 1_000, timeoutMs: 20_000, maxChars: 800 },
  lookup: { maxOutputTokens: 800, timeoutMs: 20_000, maxChars: 400 },
  typed_reply: { maxOutputTokens: 1_000, timeoutMs: 20_000, maxChars: 600 },
};

export class HelperLimited extends Error {}

/** Rejects control characters and lone surrogates, so input is plain text of bounded size. */
export function cleanText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > maxChars || /[\uD800-\uDFFF]/u.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return undefined;
  return text;
}

export class TextHelpers {
  private minute = { start: 0, count: 0 };
  private day = { key: '', total: 0 };
  private inFlight = 0;

  constructor(private readonly text: NonNullable<Config['text']>, private readonly limits: { perMinute: number; perDay: number },
              private readonly timeZone: string, private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  /** Calls left today, for the status screen. */
  remainingToday(): number {
    return Math.max(0, this.limits.perDay - (this.day.key === this.dayKey() ? this.day.total : 0));
  }

  async call(purpose: HelperPurpose, instructions: string, input: string): Promise<string> {
    this.admit();
    const limit = LIMITS[purpose];
    this.inFlight++;
    try {
      const output = await respond(this.text, { instructions, input, maxOutputTokens: limit.maxOutputTokens, timeoutMs: limit.timeoutMs }, this.fetcher);
      // Shown as plain text or spoken: drop Markdown emphasis such as **look after**.
      return output.replace(/\*\*(.+?)\*\*/gu, '$1').trim().slice(0, limit.maxChars);
    } finally { this.inFlight--; }
  }

  /** Counts the call before it is sent, so failed or slow calls also use the budget. */
  private admit(): void {
    const now = this.now(), key = this.dayKey();
    if (this.day.key !== key) this.day = { key, total: 0 };
    if (now - this.minute.start >= 60_000) this.minute = { start: now, count: 0 };
    // The text gateway key allows two concurrent calls. The page sends one subtitle at a time,
    // so a word lookup or typed reply can still run beside it.
    if (this.inFlight >= 2 || this.minute.count >= this.limits.perMinute || this.day.total >= this.limits.perDay) throw new HelperLimited('limited');
    this.minute.count++; this.day.total++;
  }

  private dayKey(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(this.now()));
  }
}
