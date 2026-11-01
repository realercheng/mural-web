// Conversation history and its JSON backup, in the format of the iOS and Android apps:
// `Archive` with `schemaVersion: 2` in apps/ios/Core/Models.swift. Records keep every field of
// that format, so a backup round-trips without loss. Dates are seconds since 2001-01-01 UTC
// (Swift's default `Date` encoding). Web-only details sit under `web`, which the apps ignore.
import type { KidReport } from '../server/src/kids';
import type { Line } from './transcript';

export type Speaker = 'user' | 'assistant';
export interface Fragment {
  id: string; revision: number; previousTexts: string[]; speaker: Speaker; text: string;
  startMS: number; endMS: number; receivedAt: number; meaningVisible: boolean; typed: boolean;
}
export interface KidRecord {
  profileID: string; scenarioID: string; level?: number; stars: number;
  status: 'ok' | 'failed' | 'none' | 'off'; report?: KidReport;
}
export interface SessionRecord {
  id: string; languageID: string; providerID?: string; startedAt: number; endedAt?: number; themeID?: string; title: string;
  fragments: Fragment[]; assessments: unknown[]; translations: Record<string, string>; topics: { languageID: string; retrievedAt: number }[];
  voiceSeconds: number; usageFinal: boolean; inputTokens: number; outputTokens: number; searchCalls: number; endReason?: string;
  web?: { mode: 'adult' | 'kid'; kid?: KidRecord };
}
export type Preferences = Record<string, unknown> & { learningLanguageID: string; sessionMinutes: number };
export interface Archive { schemaVersion: 2; sessions: SessionRecord[]; preferences: Preferences; web?: { kids?: { profiles: unknown[] } } }

export const MAXIMUM_ENCODED_BYTES = 30_000_000;
const MAXIMUM_SESSIONS = 10_000;
/** Subtitle and word-meaning language, named as in the apps' meaning-language list. */
export const MEANING_LANGUAGE = 'Chinese (Simplified)';
/** Language modules of the apps (LanguageRegistry.all). Version 1 backups were Norwegian only. */
export const LANGUAGE_IDS = ['nb', 'es', 'en', 'fr', 'de', 'it', 'pt', 'zh', 'sr', 'el', 'tl', 'nl', 'ru'];
const DEFAULT_LANGUAGE_ID = 'nb';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REFERENCE_MS = Date.UTC(2001, 0, 1);
export const toDate = (seconds: number) => new Date(REFERENCE_MS + seconds * 1_000);
export const fromDate = (date: Date | number) => ((typeof date === 'number' ? date : date.getTime()) - REFERENCE_MS) / 1_000;

export const defaultPreferences = (): Preferences => ({
  learningLanguageID: 'en', meaningVisible: true, meaningLanguage: MEANING_LANGUAGE, sessionMinutes: 10,
  hiddenWords: [], interests: '', hasOnboarded: true,
});

export type ArchiveErrorKind = 'tooLarge' | 'unsupportedVersion' | 'unsupportedLanguage' | 'invalid';
export class ArchiveError extends Error {
  constructor(readonly kind: ArchiveErrorKind) { super(kind); }
}
export const ARCHIVE_MESSAGES: Record<ArchiveErrorKind, string> = {
  tooLarge: '备份文件太大，无法导入。',
  unsupportedVersion: '这个备份来自更新版本的 Mural，当前版本无法读取。',
  unsupportedLanguage: '备份里有当前版本不支持的语言。',
  invalid: '备份文件内容无效，或有重复的记录。',
};

/** Parses and checks a backup file. Throws ArchiveError; never returns a partly valid archive. */
export function decodeArchive(text: string): Archive {
  if (new TextEncoder().encode(text).length > MAXIMUM_ENCODED_BYTES) throw new ArchiveError('tooLarge');
  let root: unknown;
  try { root = JSON.parse(text); } catch { throw new ArchiveError('invalid'); }
  const archive = migrate(root);
  validate(archive);
  return archive;
}

export function encodeArchive(archive: Archive): string {
  return JSON.stringify(archive, null, 2);
}

/** Adds the incoming sessions that are not here yet. Checks the whole result before anything is saved. */
export function mergeArchive(current: SessionRecord[], incoming: Archive): { added: SessionRecord[]; skipped: number } {
  validate(incoming);
  const known = new Set(current.map(session => session.id.toUpperCase()));
  const added = incoming.sessions.filter(session => !known.has(session.id.toUpperCase()));
  if (added.length > MAXIMUM_SESSIONS - current.length) throw new ArchiveError('tooLarge');
  return { added, skipped: incoming.sessions.length - added.length };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInteger = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
// Swift's Date.distantPast and Date.distantFuture, in seconds since 2001.
const isDate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= -63_114_076_800 && value <= 63_113_904_000;
const isString = (value: unknown) => typeof value === 'string';

/** Version 1 was Norwegian only: assign that language once, as the apps do. */
function migrate(root: unknown): Archive {
  if (!isObject(root) || !Number.isSafeInteger(root.schemaVersion)) throw new ArchiveError('invalid');
  if (root.schemaVersion !== 1 && root.schemaVersion !== 2) throw new ArchiveError('unsupportedVersion');
  if (root.schemaVersion === 2) return root as unknown as Archive;
  if (!isObject(root.preferences) || !Array.isArray(root.sessions)) throw new ArchiveError('invalid');
  const preferences: Record<string, unknown> = { ...root.preferences, learningLanguageID: DEFAULT_LANGUAGE_ID };
  if (Array.isArray(preferences.hiddenWords)) preferences.hiddenWords = preferences.hiddenWords.map((word: unknown) => `${DEFAULT_LANGUAGE_ID}|${word}`);
  const sessions = root.sessions.map(session => {
    if (!isObject(session)) throw new ArchiveError('invalid');
    const topics = Array.isArray(session.topics) ? session.topics.map(topic => ({ ...topic, languageID: DEFAULT_LANGUAGE_ID })) : session.topics;
    return { ...session, languageID: DEFAULT_LANGUAGE_ID, topics };
  });
  return { ...root, schemaVersion: 2, preferences, sessions } as unknown as Archive;
}

/** Ports Archive.validate(), and also checks the types the apps' decoder requires. */
function validate(archive: Archive): void {
  const preferences = archive.preferences as unknown;
  if (!isObject(preferences) || !Array.isArray(archive.sessions)) throw new ArchiveError('invalid');
  if (!LANGUAGE_IDS.includes(preferences.learningLanguageID as string)) throw new ArchiveError('unsupportedLanguage');
  if (!isInteger(preferences.sessionMinutes, 1, 60) || archive.sessions.length > MAXIMUM_SESSIONS ||
      new Set(archive.sessions.map(session => isObject(session) && isString(session.id) ? (session.id as string).toUpperCase() : '')).size !== archive.sessions.length)
    throw new ArchiveError('invalid');
  for (const session of archive.sessions as unknown[]) {
    if (!isObject(session)) throw new ArchiveError('invalid');
    if (!LANGUAGE_IDS.includes(session.languageID as string)) throw new ArchiveError('unsupportedLanguage');
    const fragments = session.fragments, assessments = session.assessments, topics = session.topics;
    if (!isString(session.id) || !UUID.test(session.id as string) || !isString(session.title) || !isDate(session.startedAt) ||
        (session.endedAt !== undefined && session.endedAt !== null && !isDate(session.endedAt)) ||
        typeof session.voiceSeconds !== 'number' || !(session.voiceSeconds >= 0 && session.voiceSeconds <= 31_536_000) ||
        typeof session.usageFinal !== 'boolean' || !isObject(session.translations) ||
        !Object.values(session.translations).every(isString) ||
        ![session.inputTokens, session.outputTokens, session.searchCalls].every(value => isInteger(value, 0, 1_000_000_000)) ||
        !Array.isArray(fragments) || !Array.isArray(assessments) || !Array.isArray(topics) ||
        !assessments.every(item => isObject(item) && isDate(item.createdAt)))
      throw new ArchiveError('invalid');
    if (new Set(fragments.map(fragment => isObject(fragment) ? fragment.id : undefined)).size !== fragments.length ||
        !fragments.every(fragment => isObject(fragment) && isString(fragment.id) && isString(fragment.text) &&
          (fragment.speaker === 'user' || fragment.speaker === 'assistant') &&
          isInteger(fragment.startMS, 0, Number.MAX_SAFE_INTEGER) && isInteger(fragment.endMS, fragment.startMS as number, Number.MAX_SAFE_INTEGER) &&
          (fragment.text as string).length <= 50_000 && isInteger(fragment.revision, 0, 1_000_000) && isDate(fragment.receivedAt) &&
          Array.isArray(fragment.previousTexts) && fragment.previousTexts.every(isString) &&
          typeof fragment.meaningVisible === 'boolean' && typeof fragment.typed === 'boolean') ||
        !topics.every(topic => isObject(topic) && topic.languageID === session.languageID && isDate(topic.retrievedAt)))
      throw new ArchiveError('invalid');
  }
}

/** Ports Passage.join: deltas can end inside a word; repair only a clear sentence break. */
export function joinParts(parts: string[]): string {
  let result = '';
  for (const part of parts) {
    const first = part[0], last = result.at(-1);
    if (first !== undefined && last !== undefined && !/\s/u.test(last) && !/\s/u.test(first) && first !== first.toLowerCase()) {
      const tail = Array.from(result.trimStart());
      const ending = tail.at(-1);
      let letters = 0;
      for (let index = tail.length - 2; index >= 0 && /\p{L}/u.test(tail[index]!); index--) letters++;
      if (ending === '!' || ending === '?' || ending === '…' || (ending === '.' && letters > 1)) result += ' ';
    }
    result += part;
  }
  return result;
}

export interface Passage { id: string; speaker: Speaker; fragments: Fragment[]; text: string; revisionKey: string; startMS: number }

/** Ports Transcript.passages: a presentation grouping of fragments, as in the apps. */
export function passages(fragments: Fragment[]): Passage[] {
  const groups: { id: string; speaker: Speaker; fragments: Fragment[] }[] = [];
  const endMS = (group: { fragments: Fragment[] }) => Math.max(...group.fragments.map(fragment => fragment.endMS));
  const sorted = fragments.map((fragment, index) => ({ fragment, index }))
    .sort((a, b) => a.fragment.startMS - b.fragment.startMS || a.index - b.index).map(item => item.fragment);
  for (const fragment of sorted) {
    let index = -1;
    for (let i = groups.length - 1; i >= 0; i--) if (groups[i]!.speaker === fragment.speaker) { index = i; break; }
    const group = groups[index];
    if (group && fragment.startMS - endMS(group) <= 2_200 && !fragment.typed && !group.fragments.at(-1)!.typed) group.fragments.push(fragment);
    else groups.push({ id: fragment.id, speaker: fragment.speaker, fragments: [fragment] });
  }
  return groups
    .map(group => ({ ...group, text: joinParts(group.fragments.map(fragment => fragment.text)), startMS: group.fragments[0]!.startMS,
                     revisionKey: group.fragments.map(fragment => `${fragment.id}:${fragment.revision}`).join(',') }))
    .sort((a, b) => a.startMS - b.startMS);
}

/** A line on screen, with its subtitle when one was saved. */
export interface ShownLine extends Line { meaning?: string }

const translationFor = (record: SessionRecord, revisionKey: string) =>
  record.translations[`${MEANING_LANGUAGE}::${revisionKey}`] ??
  Object.entries(record.translations).find(([key]) => key.slice(key.indexOf('::') + 2) === revisionKey)?.[1];

/**
 * The lines to show for a record. Web records store one fragment per line and show them as saved;
 * records from the apps are grouped into passages as the apps show them.
 */
export function recordLines(record: SessionRecord): ShownLine[] {
  const start = toDate(record.startedAt).getTime();
  if (record.web) return [...record.fragments].sort((a, b) => a.startMS - b.startMS).map(fragment => ({
    speaker: fragment.speaker, text: fragment.text, time: new Date(start + fragment.startMS).toISOString(),
    startMs: fragment.startMS, endMs: fragment.endMS, ...(fragment.typed ? { typed: true } : {}),
    meaning: translationFor(record, `${fragment.id}:${fragment.revision}`),
  }));
  return passages(record.fragments).map(passage => ({
    speaker: passage.speaker, text: passage.text.trim(), time: new Date(start + passage.startMS).toISOString(), startMs: passage.startMS,
    ...(passage.fragments.some(fragment => fragment.typed) ? { typed: true } : {}), meaning: translationFor(record, passage.revisionKey),
  }));
}

/** Adds subtitles to a web record, keyed by fragment as the apps key translations by passage revision. */
export function withMeanings(record: SessionRecord, meanings: (text: string) => string | undefined): SessionRecord {
  const translations = { ...record.translations };
  const fragments = record.fragments.map(fragment => {
    const meaning = fragment.speaker === 'assistant' ? meanings(fragment.text) : undefined;
    if (!meaning) return fragment;
    translations[`${MEANING_LANGUAGE}::${fragment.id}:${fragment.revision}`] = meaning;
    return { ...fragment, meaningVisible: true };
  });
  return { ...record, fragments, translations };
}

export interface NewRecord {
  id: string; languageID: string; title: string; startedAt: Date; seconds: number; confirmed: boolean; endReason?: string;
  themeID?: string; lines: Line[]; web: NonNullable<SessionRecord['web']>;
}

/** A finished web conversation as an archive session: one fragment per line. */
export function createRecord(item: NewRecord): SessionRecord {
  const start = item.startedAt.getTime();
  let previous = 0;
  const fragments: Fragment[] = item.lines.filter(line => line.text.trim()).map((line, index) => {
    // Records saved before history existed have only a clock time per line.
    const startMS = Math.max(previous, Math.round(line.startMs ?? Date.parse(line.time) - start) || 0);
    const endMS = Math.max(startMS, Math.round(line.endMs ?? startMS));
    previous = startMS;
    return { id: `f${index + 1}`, revision: 0, previousTexts: [], speaker: line.speaker, text: line.text, startMS, endMS,
             receivedAt: fromDate(Date.parse(line.time) || start), meaningVisible: false, typed: Boolean(line.typed) };
  });
  return {
    id: item.id, languageID: item.languageID, startedAt: fromDate(start), endedAt: fromDate(start + item.seconds * 1_000),
    ...(item.themeID ? { themeID: item.themeID } : {}), title: item.title, fragments, assessments: [], translations: {}, topics: [],
    voiceSeconds: Math.max(0, Math.min(31_536_000, item.seconds)), usageFinal: item.confirmed, inputTokens: 0, outputTokens: 0, searchCalls: 0,
    ...(item.endReason ? { endReason: item.endReason } : {}), web: item.web,
  };
}
