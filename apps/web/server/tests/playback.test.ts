import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlaybackClock } from '../../src/playback.js';

// Simulates GPT-Live's real-time output: 0.1 s chunks, speech in utterances separated by pauses.
function run(stallAt: (position: number) => number) {
  const clock = new PlaybackClock(), starts: { position: number; arrival: number; at: number }[] = [];
  for (let position = 0; position < 30; position += 0.1) {
    const utterance = Math.floor(position / 5), inside = position - utterance * 5;
    if (inside > 3) continue; // two seconds of dropped silence between utterances
    const arrival = position + 0.2 + stallAt(position);
    const at = clock.schedule(position, 0.1, arrival);
    if (inside < 0.05) starts.push({ position, arrival, at });
  }
  return { clock, starts };
}

test('playback keeps the provider timeline when the network is steady', () => {
  const { clock, starts } = run(() => 0);
  assert.equal(clock.underruns, 0);
  assert.equal(clock.catchUps, 0);
  for (const start of starts) assert.ok(Math.abs(start.at - start.arrival - 0.25) < 1e-6);
});

test('stalls do not leave the voice seconds behind the text', () => {
  // A 1.5 s stall in each of the first four utterances: chunks arrive late, then all at once.
  const { clock, starts } = run(position => (position < 20 && position % 5 > 1 && position % 5 < 2.5 ? 1.5 - (position % 5 - 1) : 0));
  assert.ok(clock.underruns >= 4);
  assert.ok(clock.catchUps >= 3);
  // The delay never adds up across stalls (four stalls would leave it about 6 s behind) ...
  for (const start of starts) assert.ok(start.at - start.arrival < 2.5, JSON.stringify(start));
  // ... and after the stalls, the next reply starts one jitter buffer after it arrives.
  const last = starts.at(-1)!;
  assert.ok(Math.abs(last.at - last.arrival - clock.jitterBuffer) < 1e-6, JSON.stringify(last));
});
