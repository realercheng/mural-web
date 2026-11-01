// The learning core: validation of per-turn assessments, the vocabulary memory (1-3 bars),
// flashcards and the words to revisit. A port of apps/ios/Core/LearningEngine.swift,
// FlashcardDeck.swift and FinalAssessmentQueue.swift (`applying`), and of the checks in
// Models.swift (`invalidateChangedAssessments`, `Archive.merging`). Keep the rules and numbers
// the same on every platform: scripts/check_cross_platform.py compares them with the apps.
// All dates are seconds since 2001-01-01 UTC, as in the backup format.
import { fromDate, joinParts, LANGUAGE_IDS, passages, toDate, type Assessment, type Passage, type SessionRecord, type WordProposal } from './archive';

export const MAX_WORDS = 12;
export const NEXT_GOAL_PREFIX = 300;
export const CAPABILITY_PREFIX = 160;
export const MIN_WORD_CONFIDENCE = 0.8;
/** A word the assistant said this recently before the learner's turn is a model, not independent recall. */
export const IMITATION_WINDOW_MS = 90_000;
/** Days until a word is due again, by number of bars (0-3). */
export const REVIEW_INTERVAL_DAYS = [1, 1, 4, 14];
export const STEADY_WINDOW_DAYS = 7;
export const STEADY_MIN_DAYS = 3;
export const STEADY_MIN_CONTEXTS = 2;
export const CAPABILITY_EVIDENCE_MIN = 3;
/** Version of `joinParts`; assessments without it were judged against the older assembly. */
export const TEXT_ASSEMBLY_VERSION = 2;
export const MIN_PASSAGE_CHARS = 3;
/** The assessment of the last turn may take this long after the call, as in FinalAssessmentQueue. */
export const FINAL_ASSESSMENT_SECONDS = 15;
export const DAY_SECONDS = 86_400;

export interface WordState {
  id: string; lemma: string; meaning: string; form: string; example: string; bars: number; understandingCount: number;
  independentCount: number; lastSeen: number; dueAt: number;
}
export interface LearnerState { challenge: number; observationCount: number; nextGoal: string; capabilities: string[]; words: WordState[] }

export const WORD_LABELS = ['New', 'Fragile', 'Growing', 'Steady'];
export const wordLabel = (word: WordState) => WORD_LABELS[Math.min(3, Math.max(0, word.bars))]!;
/** The explanation the apps show under a word's bars. */
export function wordExplanation(word: WordState): string {
  if (word.independentCount === 0) return 'Heard or used with support. Try using it in your own words.';
  if (word.bars === 1) return 'Used independently. We’ll bring it back soon.';
  if (word.bars === 2) return 'Recalled on different days. Still worth revisiting.';
  return 'Recalled across days and contexts. Strength can fade with time.';
}
export const levelLabel = (state: LearnerState) => (state.observationCount < 4 ? 'Getting to know you' : 'Finding your pace');

export const wordKey = (word: Pick<WordProposal, 'language' | 'lemma' | 'meaning'>) =>
  `${word.language}|${word.lemma.trim().toLowerCase()}|${word.meaning.toLowerCase()}`;

const contains = (text: string, part: string) => text.toLowerCase().includes(part.toLowerCase());
const prefix = (text: string, count: number) => Array.from(text).slice(0, count).join('');
const count = (text: string) => Array.from(text).length;

const isHan = (character: string) => /[\p{Script=Han}]/u.test(character);
/** The apps' `Passage.legacyJoin`: assessments saved before the current assembly quote this text. */
export function legacyJoinParts(parts: string[]): string {
  let result = '';
  for (const part of parts) {
    if (!result) { result = part; continue; }
    const last = Array.from(result).at(-1), first = Array.from(part)[0];
    if (last === undefined || first === undefined) { result += part; continue; }
    const opening = /[\p{Ps}\p{Pi}]/u.test(last);
    const cjkPunctuation = /[　-〿＀-￯]/u.test(last);
    const unspaced = opening || (isHan(first) && (isHan(last) || cjkPunctuation));
    if (!/\s/u.test(last) && !/\s/u.test(first) && !/\p{P}/u.test(first) && !unspaced) result += ' ';
    result += part;
  }
  return result;
}

/** Ports `LearningEngine.validate`. Returns the checked assessment, or undefined when it does not fit the record. */
export function validateAssessment(proposal: Assessment, session: SessionRecord): Assessment | undefined {
  if (!LANGUAGE_IDS.includes(session.languageID)) return undefined;
  const all = passages(session.fragments);
  const passage = all.find(item => item.id === proposal.passageID && item.speaker === 'user');
  if (!passage || passage.revisionKey !== proposal.revisionKey || !Number.isInteger(proposal.suggestedLevel) ||
      proposal.suggestedLevel < 0 || proposal.suggestedLevel > 5 || !Array.isArray(proposal.words) || proposal.words.length > MAX_WORDS) return undefined;
  if (typeof proposal.nextGoal !== 'string' || typeof proposal.capability !== 'string') return undefined;
  const allowed = new Set(passage.fragments.map(fragment => fragment.id));
  // Re-evaluate saved evidence with the same assembly it was originally judged against.
  const join = proposal.textAssemblyVersion == null ? legacyJoinParts : joinParts;
  const evidenceText = join(passage.fragments.map(fragment => fragment.text));
  const words: WordProposal[] = [];
  for (const word of proposal.words) {
    if (word.language !== session.languageID || !Array.isArray(word.sourceIDs) || !word.sourceIDs.length ||
        !word.sourceIDs.every(id => allowed.has(id)) || !Number.isFinite(word.confidence) ||
        word.confidence < MIN_WORD_CONFIDENCE || word.confidence > 1 ||
        !word.lemma || count(word.lemma) >= 100 || !word.meaning || count(word.meaning) >= 180 ||
        !word.form || !word.quote || !contains(evidenceText, word.quote) || !contains(word.quote, word.form)) continue;
    const refs = join(passage.fragments.filter(fragment => word.sourceIDs.includes(fragment.id)).map(fragment => fragment.text));
    if (!contains(refs, word.quote)) continue;
    const result = { ...word };
    if (result.kind === 'independent') {
      // A visible meaning or immediate imitation is supporting evidence, never independent recall.
      const recentlyModeled = all.some(other => other.speaker === 'assistant' && other.startMS <= passage.startMS &&
        passage.startMS - other.endMS < IMITATION_WINDOW_MS && contains(join(other.fragments.map(fragment => fragment.text)), word.form));
      if (passage.fragments.some(fragment => fragment.meaningVisible || fragment.typed) || recentlyModeled) result.kind = 'assisted';
    }
    words.push(result);
  }
  return { ...proposal, nextGoal: prefix(proposal.nextGoal, NEXT_GOAL_PREFIX), capability: prefix(proposal.capability, CAPABILITY_PREFIX), words };
}

/** Ports `SessionRecord.invalidateChangedAssessments`: an assessment of text that has since changed is dropped. */
export function invalidateChangedAssessments(session: SessionRecord): SessionRecord {
  const current = new Map(passages(session.fragments).map(passage => [passage.id, passage.revisionKey]));
  return { ...session, assessments: session.assessments.filter(item => current.get(item.passageID) === item.revisionKey) };
}

/** What `Archive.merging` does to an imported session: keep only assessments that still fit its text. */
export function sanitizeImported(session: SessionRecord): SessionRecord {
  const checked = invalidateChangedAssessments(session);
  return { ...checked, assessments: checked.assessments.flatMap(item => validateAssessment(item, checked) ?? []) };
}

const startOfDay = (seconds: number) => { const day = toDate(seconds); day.setHours(0, 0, 0, 0); return day.getTime(); };

/** Which conversations make up one learner: an adult, or one child (each child has separate vocabulary). */
export type LearnerScope = { kind: 'adult' } | { kind: 'kid'; profileID: string };
export const inScope = (session: SessionRecord, scope: LearnerScope) =>
  scope.kind === 'kid' ? session.web?.mode === 'kid' && session.web.kid?.profileID === scope.profileID : session.web?.mode !== 'kid';

/** Ports `LearningEngine.project`. */
export function project(sessions: SessionRecord[], languageID: string, hiddenWords: string[] = [], now = fromDate(Date.now())): LearnerState {
  let level = 0, observationCount = 0, successes = 0;
  let nextGoal = 'Start with a greeting and one small question. Adjust from what the learner actually says.';
  const capabilityEvidence = new Map<string, Set<string>>();
  const events = new Map<string, { word: WordProposal; at: number; context: string }[]>();
  const ordered = sessions.filter(item => item.languageID === languageID).sort((a, b) => a.startedAt - b.startedAt);
  for (const session of ordered) {
    const seen = new Set<string>();
    for (const raw of [...session.assessments].sort((a, b) => a.createdAt - b.createdAt)) {
      if (seen.has(raw.passageID)) continue;
      const assessment = validateAssessment(raw, session);
      if (!assessment) continue;
      seen.add(raw.passageID);
      observationCount++;
      if (assessment.outcome === 'breakdown') { level = Math.max(0, level - 1); successes = 0; }
      else if (assessment.outcome === 'success') {
        successes++;
        if (successes >= 2) { level = Math.min(5, Math.max(level, Math.min(level + 1, assessment.suggestedLevel))); successes = 0; }
      } else successes = 0;
      if (assessment.nextGoal) nextGoal = assessment.nextGoal;
      if (assessment.outcome === 'success' && assessment.capability) {
        const days = capabilityEvidence.get(assessment.capability) ?? new Set<string>();
        days.add(`${startOfDay(assessment.createdAt)}|${assessment.context}`);
        capabilityEvidence.set(assessment.capability, days);
      }
      const seenWords = new Set<string>();
      for (const word of assessment.words) {
        const key = wordKey(word);
        if (hiddenWords.includes(key) || seenWords.has(key)) continue;
        seenWords.add(key);
        const list = events.get(key) ?? [];
        list.push({ word, at: assessment.createdAt, context: assessment.context });
        events.set(key, list);
      }
    }
  }
  const words: WordState[] = [];
  for (const [id, observations] of events) {
    const last = observations.at(-1)!;
    const independent = observations.filter(item => item.word.kind === 'independent');
    const days = new Set(independent.map(item => startOfDay(item.at))).size;
    const contexts = new Set(independent.map(item => item.context)).size;
    const lastRecall = independent.at(-1)?.at;
    let bars = independent.length ? 1 : 0;
    if (days >= 2) bars = 2;
    if (days >= STEADY_MIN_DAYS && contexts >= STEADY_MIN_CONTEXTS && independent.at(-1)!.at - independent[0]!.at >= STEADY_WINDOW_DAYS * DAY_SECONDS) bars = 3;
    const dueAt = (lastRecall ?? last.at) + REVIEW_INTERVAL_DAYS[bars]! * DAY_SECONDS;
    if (now > dueAt && bars > 1) bars--;
    const lapse = [...observations].reverse().find(item => item.word.kind === 'lapse');
    if (lapse && lapse.at > (lastRecall ?? -Infinity)) bars = Math.min(bars, 1);
    words.push({ id, lemma: last.word.lemma, meaning: last.word.meaning, form: last.word.form, example: last.word.quote, bars,
                 understandingCount: observations.filter(item => item.word.kind === 'understanding').length, independentCount: independent.length,
                 lastSeen: last.at, dueAt });
  }
  words.sort((a, b) => b.lastSeen - a.lastSeen || (a.id < b.id ? -1 : 1));
  const capabilities = [...capabilityEvidence].filter(([, days]) => days.size >= CAPABILITY_EVIDENCE_MIN).map(([name]) => name).sort();
  return { challenge: level, observationCount, nextGoal, capabilities, words };
}

/** Words that are due, newest evidence first, for the next conversation's review. */
export function dueWords(state: LearnerState, now = fromDate(Date.now()), limit = 5): WordState[] {
  return state.words.filter(word => word.dueAt < now).slice(0, limit);
}

/** A read-only snapshot for browsing: it never changes vocabulary or conversation recall. */
export function flashcardDeck(words: WordState[], languageID: string): WordState[] {
  const seen = new Set<string>();
  return words.filter(word => word.id.startsWith(`${languageID}|`) && !seen.has(word.id) && seen.add(word.id));
}
export const deckDestination = (deck: WordState[], index: number, direction: number) =>
  deck.length ? Math.min(deck.length - 1, Math.max(0, index + direction)) : 0;

/** The user passage the final assessment is for: the last one with at least three characters. */
export function lastUserPassage(session: SessionRecord): Passage | undefined {
  const found = passages(session.fragments).filter(item => item.speaker === 'user').at(-1);
  return found && Array.from(found.text).length >= MIN_PASSAGE_CHARS ? found : undefined;
}

/** True when this passage, in this revision, already has an assessment. */
export const isAssessed = (session: SessionRecord, passage: Passage) =>
  session.assessments.some(item => item.passageID === passage.id && item.revisionKey === passage.revisionKey);

/**
 * Ports `FinalAssessmentResult.applying`: applies a result only to the saved record it was made
 * for, which may have changed or been deleted since. Returns the new record, or undefined.
 */
export function applyAssessment(current: SessionRecord | undefined, assessment: Assessment): SessionRecord | undefined {
  if (!current || current.endedAt == null) return undefined;
  const validated = validateAssessment(assessment, current);
  if (!validated || isAssessedKey(current, assessment)) return undefined;
  return { ...current, assessments: [...current.assessments.filter(item => item.passageID !== validated.passageID), validated] };
}
const isAssessedKey = (session: SessionRecord, assessment: Assessment) =>
  session.assessments.some(item => item.passageID === assessment.passageID && item.revisionKey === assessment.revisionKey);

/** The model's JSON for one turn, which the browser turns into an `Assessment` for that passage. */
export interface AssessmentReply { outcome: Assessment['outcome']; suggestedLevel: number; nextGoal: string; capability: string; words: WordProposal[] }

export function toAssessment(reply: AssessmentReply, passage: Passage, session: Pick<SessionRecord, 'themeID'>, now = fromDate(Date.now())): Assessment {
  return { passageID: passage.id, revisionKey: passage.revisionKey, outcome: reply.outcome, suggestedLevel: reply.suggestedLevel,
           nextGoal: reply.nextGoal, capability: reply.capability, words: reply.words, createdAt: now, context: session.themeID ?? 'free',
           textAssemblyVersion: TEXT_ASSEMBLY_VERSION };
}

/** Plain English words for the voice instructions: letters, spaces, apostrophes and hyphens only, so a word cannot carry instructions. */
export const REVIEW_WORD = /^[\p{L}][\p{L}'’ -]{0,29}$/u;
export function reviewWordsFor(state: LearnerState, now = fromDate(Date.now()), limit = 5): string[] {
  return dueWords(state, now, 50).map(word => word.lemma.trim()).filter(lemma => REVIEW_WORD.test(lemma)).slice(0, limit);
}
