/**
 * Builds the on-screen transcript from GPT-Live transcript deltas.
 *
 * - Both speakers' deltas carry `start_ms` on one session clock. The learner's words are often
 *   transcribed after Mural has started answering, so lines are ordered by `start_ms`, not by
 *   arrival; otherwise a late "yummy" splits Mural's reply in two.
 * - Mural's words appear when their speech plays (`playedMs`), so the text never runs ahead of
 *   the voice. A word that has waited for 3 s is shown anyway, e.g. when audio is not playing.
 */
export interface Delta { speaker: 'user' | 'assistant'; text: string; startMs: number; arrivedAt: number; typed?: boolean }
export interface Line {
  speaker: 'user' | 'assistant'; text: string; /** ISO time the line started. */ time: string;
  /** Position on the conversation's timeline; absent in records saved before history existed. */
  startMs?: number; endMs?: number; typed?: boolean;
}

const SHOW_UNPLAYED_AFTER_MS = 3_000;

export function buildLines(deltas: Delta[], sessionStart: number, playedMs = Infinity, now = Infinity): Line[] {
  const visible = deltas
    .filter(delta => delta.speaker === 'user' || delta.startMs <= playedMs + 150 || now - delta.arrivedAt > SHOW_UNPLAYED_AFTER_MS)
    .map((delta, index) => ({ delta, index }))
    .sort((a, b) => a.delta.startMs - b.delta.startMs || a.index - b.index);
  const lines: Line[] = [];
  for (const { delta } of visible) {
    const last = lines.at(-1);
    // A typed message is its own line, never merged with speech.
    if (last?.speaker === delta.speaker && !last.typed && !delta.typed) { last.text += delta.text; last.endMs = delta.startMs; }
    else lines.push({ speaker: delta.speaker, text: delta.text.trimStart(), time: new Date(sessionStart + delta.startMs).toISOString(),
                      startMs: delta.startMs, endMs: delta.startMs, ...(delta.typed ? { typed: true } : {}) });
  }
  return lines;
}
