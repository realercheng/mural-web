/**
 * Builds the on-screen transcript from GPT-Live transcript deltas.
 *
 * - Both speakers' deltas carry `start_ms` on one session clock. The learner's words are often
 *   transcribed after Mural has started answering, so lines are ordered by `start_ms`, not by
 *   arrival; otherwise a late "yummy" splits Mural's reply in two.
 * - Mural's words appear when their speech plays (`playedMs`), so the text never runs ahead of
 *   the voice. A word that has waited for 3 s is shown anyway, e.g. when audio is not playing.
 */
export interface Delta { speaker: 'user' | 'assistant'; text: string; startMs: number; arrivedAt: number }
export interface Line { speaker: 'user' | 'assistant'; text: string; /** ISO time the line started. */ time: string }

const SHOW_UNPLAYED_AFTER_MS = 3_000;

export function buildLines(deltas: Delta[], sessionStart: number, playedMs = Infinity, now = Infinity): Line[] {
  const visible = deltas
    .filter(delta => delta.speaker === 'user' || delta.startMs <= playedMs + 150 || now - delta.arrivedAt > SHOW_UNPLAYED_AFTER_MS)
    .map((delta, index) => ({ delta, index }))
    .sort((a, b) => a.delta.startMs - b.delta.startMs || a.index - b.index);
  const lines: Line[] = [];
  for (const { delta } of visible) {
    const last = lines.at(-1);
    if (last?.speaker === delta.speaker) last.text += delta.text;
    else lines.push({ speaker: delta.speaker, text: delta.text.trimStart(), time: new Date(sessionStart + delta.startMs).toISOString() });
  }
  return lines;
}
