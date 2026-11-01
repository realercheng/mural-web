import type { Config } from './config.js';
import { LEVELS, type KidReport, type KidScenario, type Level } from './kids.js';
import { respond } from './responses.js';

export interface TranscriptLine { speaker: 'child' | 'mural'; text: string; typed?: boolean }

const PENDING_MINUTES = 30;
const MAX_TRANSCRIPT_CHARS = 30_000;

/**
 * Holds the transcript of each finished kid conversation in memory until the browser asks for
 * its report. Nothing is written to disk; an entry is removed once its report succeeds or after
 * 30 minutes.
 */
export class PendingReports {
  private readonly entries = new Map<string, { scenario: KidScenario; level: Level; lines: TranscriptLine[]; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  keep(sessionID: string, scenario: KidScenario, level: Level, lines: TranscriptLine[]): void {
    const now = this.now();
    for (const [key, value] of this.entries) if (value.expires <= now) this.entries.delete(key);
    while (this.entries.size >= 10) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(sessionID, { scenario, level, lines, expires: now + PENDING_MINUTES * 60_000 });
  }

  get(sessionID: string) {
    const entry = this.entries.get(sessionID);
    return entry && entry.expires > this.now() ? entry : undefined;
  }

  delete(sessionID: string): void { this.entries.delete(sessionID); }
}

const strings = (description: string) => ({ type: 'array', description, items: { type: 'string' } });
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'words', 'sentences', 'corrections', 'repeatSuccesses', 'teachBackWord', 'nextSteps', 'reviewWords'],
  properties: {
    summary: { type: 'string', description: '用中文一两句话概括这次练习。' },
    words: strings('English words or short phrases the child practised (at most 10).'),
    sentences: strings('English sentences the child practised or said correctly (at most 6).'),
    corrections: {
      type: 'array', description: 'Errors Mural corrected (at most 6).',
      items: {
        type: 'object', additionalProperties: false, required: ['said', 'correct', 'note'],
        properties: {
          said: { type: 'string', description: 'What the child said.' },
          correct: { type: 'string', description: 'The corrected English.' },
          note: { type: 'string', description: '用中文简短说明错在哪里。' },
        },
      },
    },
    repeatSuccesses: { type: 'integer', description: 'Times the child correctly repeated a sentence after Mural asked them to say it.' },
    teachBackWord: { type: 'string', description: 'The word the child taught Mural at the end, or an empty string.' },
    nextSteps: strings('用中文写给家长的下次练习建议（最多 3 条）。'),
    reviewWords: strings('2 or 3 English words from today to review next time.'),
  },
};

const INSTRUCTIONS = [
  'You write a short report for a Chinese parent about one English speaking practice between their primary-school child and Mural, an AI speaking partner.',
  'The transcript comes from speech recognition. The child\'s lines can contain recognition mistakes; do not count a likely recognition mistake as the child\'s error. Base every item only on the transcript; never invent words, errors or praise.',
  'List in corrections only real errors. If Mural treated a correct sentence as an error, do not list it.',
  'Count repeatSuccesses only when Mural asked the child to say or repeat a sentence and the child\'s next line says it correctly or nearly correctly. A turn with no child line counts as nothing. Lines marked (typed) were typed, not spoken, and never count.',
  'If the difficulty level looks clearly too easy or too hard for the child, say so in one nextSteps item and suggest the level to use.',
  'Write summary, note and nextSteps in simple, natural Chinese for a parent. Keep English items exactly as practised. Do not include any personal information the child may have mentioned.',
].join('\n');

/** Asks the text model for a parent report. The transcript is sent once and not stored. */
export async function writeReport(text: NonNullable<Config['text']>, scenario: KidScenario, level: Level, lines: TranscriptLine[],
                                  fetcher: typeof fetch = fetch): Promise<KidReport> {
  let transcript = lines.map(line => `${line.speaker === 'child' ? 'Child' : 'Mural'}${line.typed ? ' (typed)' : ''}: ${line.text.trim()}`).join('\n');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
  const output = await respond(text, {
    instructions: INSTRUCTIONS, maxOutputTokens: 4_000, timeoutMs: 90_000, schema: { name: 'kid_report', schema: SCHEMA },
    input: `Difficulty level ${level} of 4 (${LEVELS[level].nameZh}). Topic: ${scenario.titleEn} (${scenario.titleZh}). Target words: ${scenario.words.join(', ')}.\n\nTranscript:\n${transcript}`,
  }, fetcher);
  return clean(JSON.parse(output));
}

const list = (value: unknown, max: number) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim().slice(0, 200)).slice(0, max) : [];
const line = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 400) : '';

function clean(raw: Record<string, unknown>): KidReport {
  const corrections = Array.isArray(raw.corrections) ? raw.corrections as Record<string, unknown>[] : [];
  const repeats = Number(raw.repeatSuccesses);
  return {
    summary: line(raw.summary),
    words: list(raw.words, 10),
    sentences: list(raw.sentences, 6),
    corrections: corrections.filter(item => item && typeof item === 'object').slice(0, 6)
      .map(item => ({ said: line(item.said), correct: line(item.correct), note: line(item.note) })),
    repeatSuccesses: Number.isSafeInteger(repeats) ? Math.min(20, Math.max(0, repeats)) : 0,
    teachBackWord: line(raw.teachBackWord).slice(0, 40),
    nextSteps: list(raw.nextSteps, 3),
    reviewWords: list(raw.reviewWords, 3).filter(word => /^[A-Za-z][A-Za-z' -]{0,23}$/.test(word)),
  };
}
