// Per-turn assessment in the browser. During a call the learner's latest turn is assessed once it
// has been quiet for 3 s (as ConversationCoordinator.scheduleAssessment); after the call the last
// turn is assessed if it still has no result, within 15 s (as FinalAssessmentQueue). The server
// holds the instructions and the text-model key; the page sends the transcript rows only, and every
// result is checked again by `validateAssessment` before it is kept.
import { useCallback, useEffect, useRef } from 'react';
import { createRecord, passages, type Assessment, type Passage, type SessionRecord } from './archive';
import { applyAssessment, FINAL_ASSESSMENT_SECONDS, isAssessed, lastUserPassage, toAssessment, validateAssessment, type AssessmentReply } from './learning';
import type { Live } from './live';
import type { Line } from './transcript';

/** Quiet time after the learner's turn before it is assessed during a call. */
export const ASSESSMENT_DELAY_MS = 3_000;
const MAX_ROW_CHARS = 3_000;

export type AssessFunction = (session: SessionRecord, passage: Passage, signal?: AbortSignal) => Promise<Assessment>;

/** One call to the server. Rejects when the server refuses, is limited or does not answer in time. */
export const requestAssessment: AssessFunction = async (session, passage, signal) => {
  const rows = passages(session.fragments).slice(-10);
  const response = await fetch('/api/assess', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({
      language: session.languageID,
      context: rows.map(row => ({ speaker: row.speaker, ids: row.fragments.map(fragment => fragment.id), text: row.text.trim().slice(0, MAX_ROW_CHARS) })),
      target: passage.fragments.map(fragment => ({ id: fragment.id, meaningVisible: fragment.meaningVisible, typed: fragment.typed, text: fragment.text.slice(0, MAX_ROW_CHARS) })),
    }),
  });
  if (!response.ok) throw new Error(String(response.status));
  const { assessment } = await response.json() as { assessment: AssessmentReply };
  return toAssessment(assessment, passage, session);
};

interface Kept { startMS: number; text: string; assessment: Assessment }

/**
 * Assesses the learner's latest turn during a call, one request at a time. Fragment IDs follow the
 * order of the lines on screen, which can shift while Mural's lines still arrive, so each result is
 * kept with the turn's time and text and matched to the saved record afterwards.
 */
export class LiveAssessor {
  private kept: Kept[] = [];
  private latest?: SessionRecord;
  private lastKey = '';
  /** The turn the pending timer is for: Mural's own lines changing must not restart the wait. */
  private scheduledKey = '';
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private again = false;
  private stopped = true;

  constructor(private readonly assess: AssessFunction = requestAssessment, private readonly delayMs = ASSESSMENT_DELAY_MS) {}

  /** Starts a new call. */
  reset() {
    clearTimeout(this.timer);
    this.kept = []; this.latest = undefined; this.lastKey = ''; this.scheduledKey = ''; this.again = false; this.stopped = false;
  }

  /** The conversation so far, as a record built from the lines on screen. */
  observe(snapshot: SessionRecord) {
    if (this.stopped) return;
    this.latest = snapshot;
    const passage = lastUserPassage(snapshot);
    if (!passage || passage.revisionKey === this.lastKey || passage.revisionKey === this.scheduledKey) return;
    clearTimeout(this.timer);
    this.scheduledKey = passage.revisionKey;
    this.timer = setTimeout(() => this.run(), this.delayMs);
  }

  private run() {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    const snapshot = this.latest, passage = snapshot && lastUserPassage(snapshot);
    if (!snapshot || !passage || passage.revisionKey === this.lastKey) return;
    this.running = (async () => {
      try {
        const assessment = await this.assess(snapshot, passage);
        const valid = validateAssessment(assessment, snapshot);
        if (valid && !this.stopped) {
          this.lastKey = passage.revisionKey;
          this.kept = [...this.kept.filter(item => item.startMS !== passage.startMS), { startMS: passage.startMS, text: passage.text, assessment: valid }];
        }
      } catch { /* The turn stays saved without learning evidence; the next turn tries again. */ }
      this.running = undefined;
      if (this.again) { this.again = false; this.run(); }
    })();
  }

  /** Ends the call and waits briefly for a request that is still running. */
  async finish(waitMs = FINAL_ASSESSMENT_SECONDS * 1_000): Promise<void> {
    clearTimeout(this.timer);
    this.stopped = true;
    const running = this.running;
    if (running) await Promise.race([running, new Promise(resolve => setTimeout(resolve, waitMs))]);
  }

  /** The results that still fit the saved record: same turn, same text. */
  assessmentsFor(record: SessionRecord): Assessment[] {
    const result: Assessment[] = [];
    const turns = passages(record.fragments).filter(item => item.speaker === 'user');
    for (const item of this.kept) {
      const turn = turns.find(candidate => candidate.startMS === item.startMS && candidate.text === item.text);
      if (!turn) continue;
      const moved = { ...item.assessment, passageID: turn.id, revisionKey: turn.revisionKey };
      const valid = validateAssessment(moved, record);
      if (valid) result.push(valid);
    }
    return result;
  }
}

/** The conversation on screen as a record, so passages and revision keys come out as they will when it is saved. */
export function liveSnapshot(meta: { languageID: string; themeID?: string; startedAt: Date }, lines: Line[]): SessionRecord {
  return createRecord({ id: 'live', languageID: meta.languageID, title: 'live', startedAt: meta.startedAt, seconds: 0, confirmed: false,
                        ...(meta.themeID ? { themeID: meta.themeID } : {}), lines, web: { mode: 'adult' } });
}

export interface RecordStore {
  get(id: string): SessionRecord | undefined;
  update(id: string, change: (record: SessionRecord) => SessionRecord): void;
}

/**
 * After a call: keeps the per-turn results that fit the saved record, then assesses the last turn
 * if it has none (FinalAssessmentQueue). A failure or timeout leaves the record as it is.
 */
export async function completeAssessments(store: RecordStore, id: string, assessor: LiveAssessor, assess: AssessFunction = requestAssessment,
                                          timeoutMs = FINAL_ASSESSMENT_SECONDS * 1_000): Promise<void> {
  await assessor.finish(timeoutMs);
  const record = store.get(id);
  if (!record) return;
  const kept = assessor.assessmentsFor(record);
  if (kept.length) store.update(id, current => ({
    ...current, assessments: [...current.assessments.filter(item => !kept.some(other => other.passageID === item.passageID)), ...kept],
  }));
  const current = store.get(id);
  const passage = current && lastUserPassage(current);
  if (!current || !passage || isAssessed(current, passage)) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const assessment = await assess(current, passage, controller.signal);
    store.update(id, latest => applyAssessment(latest, assessment) ?? latest);
  } catch { /* No evidence is better than unverified evidence. */ } finally { clearTimeout(timer); }
}

/**
 * The assessor of one conversation screen. `begin` starts a call, `lines` are observed while the
 * call is active, and `complete` runs after it ends.
 */
export function useAssessor(live: Live, enabled: boolean) {
  const assessor = useRef(new LiveAssessor());
  const meta = useRef<{ languageID: string; themeID?: string; startedAt: Date } | undefined>(undefined);
  const { phase, lines } = live;
  useEffect(() => {
    if (enabled && phase === 'active' && meta.current && lines.length) assessor.current.observe(liveSnapshot(meta.current, lines));
  }, [enabled, phase, lines]);
  const begin = useCallback((languageID: string, themeID?: string) => {
    meta.current = { languageID, ...(themeID ? { themeID } : {}), startedAt: new Date() };
    assessor.current.reset();
  }, []);
  const complete = useCallback((store: RecordStore, id: string) => (enabled ? completeAssessments(store, id, assessor.current) : Promise.resolve()), [enabled]);
  return { begin, complete };
}
