import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLines, type Delta } from '../../src/transcript.js';

const delta = (speaker: Delta['speaker'], text: string, startMs: number, arrivedAt = 0): Delta => ({ speaker, text, startMs, arrivedAt });

test('a late learner transcript joins its own line instead of splitting Mural\'s reply', () => {
  // Real order of arrival on a device: "yummy" was transcribed after Mural started answering.
  const deltas = [delta('user', ' I like rice because it is', 1_000), delta('assistant', ' Great!', 3_000),
                  delta('user', ' yummy', 2_400), delta('assistant', ' You said it!', 3_400)];
  const lines = buildLines(deltas, Date.parse('2026-10-31T15:00:00Z'));
  assert.deepEqual(lines.map(line => [line.speaker, line.text]),
                   [['user', 'I like rice because it is yummy'], ['assistant', 'Great! You said it!']]);
  assert.equal(lines[1]!.time, '2026-10-31T15:00:03.000Z');
});

test("Mural's words wait for their speech, but never more than 3 s", () => {
  const deltas = [delta('assistant', ' Hello', 1_000, 10_000), delta('assistant', ' there', 1_400, 10_000)];
  assert.deepEqual(buildLines(deltas, 0, -Infinity, 10_500), []);
  assert.equal(buildLines(deltas, 0, 1_000, 10_500)[0]!.text, 'Hello');
  assert.equal(buildLines(deltas, 0, -Infinity, 13_500)[0]!.text, 'Hello there');
});

test('a typed message stays its own line, after the speech received before it', () => {
  const deltas: Delta[] = [delta('user', ' I like', 1_000), { ...delta('user', 'I like noodles', 1_401), typed: true }, delta('user', ' rice', 1_400)];
  assert.deepEqual(buildLines(deltas, 0).map(line => [line.text, line.typed ?? false, line.startMs]),
                   [['I like rice', false, 1_000], ['I like noodles', true, 1_401]]);
});
