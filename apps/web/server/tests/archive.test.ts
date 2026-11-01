import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArchiveError, createRecord, decodeArchive, encodeArchive, mergeArchive, passages, recordLines, toDate, withMeanings } from '../../src/archive.js';

// Copies of shared/fixtures/cross-platform, the fixture the iOS and Android tests also use. The
// Docker build sees only apps/web, so the copies live here; the first test keeps them identical.
const fixtures = join(import.meta.dirname, 'fixtures');
const shared = join(import.meta.dirname, '../../../../shared/fixtures/cross-platform');
const source = () => readFileSync(join(fixtures, 'archive.json'), 'utf8');
const expected = () => JSON.parse(readFileSync(join(fixtures, 'archive-expected.json'), 'utf8'));

test('the fixture copies match the shared cross-platform fixtures', { skip: !existsSync(shared) && 'shared fixtures are outside the build context' }, () => {
  for (const name of ['archive.json', 'archive-expected.json'])
    assert.equal(readFileSync(join(fixtures, name), 'utf8'), readFileSync(join(shared, name), 'utf8'), name);
});

test('a re-encoded archive keeps every field and value of the shared fixture', () => {
  const archive = decodeArchive(source());
  assert.deepEqual(JSON.parse(encodeArchive(archive)), JSON.parse(source()));
  assert.equal(toDate(archive.sessions[0]!.startedAt).toISOString(), '2026-09-01T15:00:00.000Z');
});

test('transcript passages match the shared fixture', () => {
  const archive = decodeArchive(source());
  const want = expected().passages as Record<string, { speaker: string; text: string; fragmentIDs: string[] }[]>;
  assert.deepEqual(new Set(Object.keys(want)), new Set(archive.sessions.map(session => session.id)));
  for (const session of archive.sessions)
    assert.deepEqual(passages(session.fragments).map(p => ({ speaker: p.speaker, text: p.text, fragmentIDs: p.fragments.map(f => f.id) })), want[session.id], session.id);
  // The saved Spanish subtitle belongs to the first passage of the first session.
  assert.equal(recordLines(archive.sessions[0]!)[0]!.meaning, ' ¡Hola! ¿Qué hiciste el fin de semana pasado?');
});

test('import rejects a damaged backup as a whole', () => {
  const kind = (text: string) => { try { decodeArchive(text); return 'ok'; } catch (error) { return (error as ArchiveError).kind; } };
  const root = JSON.parse(source());
  const variant = (change: (copy: any) => void) => { const copy = structuredClone(root); change(copy); return JSON.stringify(copy); };
  assert.equal(kind('not json'), 'invalid');
  assert.equal(kind(variant(copy => { copy.schemaVersion = 3; })), 'unsupportedVersion');
  assert.equal(kind(variant(copy => { copy.sessions[1].languageID = 'xx'; })), 'unsupportedLanguage');
  assert.equal(kind(variant(copy => { copy.sessions[1].id = copy.sessions[0].id.toLowerCase(); })), 'invalid');
  assert.equal(kind(variant(copy => { copy.sessions[2].fragments[0].endMS = -1; })), 'invalid');
  assert.equal(kind(variant(copy => { delete copy.sessions[3].translations; })), 'invalid');
  assert.equal(kind(variant(copy => { copy.preferences.sessionMinutes = 0; })), 'invalid');
  assert.equal(kind(' '.repeat(30_000_001)), 'tooLarge');
});

test('a version 1 backup is migrated to Norwegian, as in the apps', () => {
  const root = JSON.parse(source());
  root.schemaVersion = 1;
  for (const session of root.sessions) { delete session.languageID; for (const topic of session.topics) delete topic.languageID; }
  const archive = decodeArchive(JSON.stringify(root));
  assert.ok(archive.sessions.every(session => session.languageID === 'nb'));
  assert.deepEqual(archive.preferences.hiddenWords, ['nb|en|soup|a hot liquid food']);
});

test('merging adds only new sessions and leaves existing ones unchanged', () => {
  const archive = decodeArchive(source());
  const current = [archive.sessions[0]!];
  const { added, skipped } = mergeArchive(current, archive);
  assert.equal(skipped, 1);
  assert.deepEqual(added.map(session => session.id), archive.sessions.slice(1).map(session => session.id));
});

test('a web conversation becomes an archive session that the apps can read back', () => {
  const lines = [
    { speaker: 'assistant' as const, text: 'Hi! What did you eat?', time: '2026-11-01T08:00:02.000Z', startMs: 2_000, endMs: 3_200 },
    { speaker: 'user' as const, text: 'I eat rice.', time: '2026-11-01T08:00:05.000Z', startMs: 5_000, endMs: 5_800 },
    { speaker: 'user' as const, text: 'Noodles too', time: '2026-11-01T08:00:06.000Z', startMs: 6_000, endMs: 6_001, typed: true },
  ];
  const record = withMeanings(createRecord({
    id: crypto.randomUUID(), languageID: 'en', title: 'English 自由对话', startedAt: new Date('2026-11-01T08:00:00Z'), seconds: 60, confirmed: true,
    lines, web: { mode: 'adult' },
  }), text => (text.startsWith('Hi') ? '你好！你吃了什么？' : undefined));
  const archive = decodeArchive(encodeArchive({ schemaVersion: 2, sessions: [record], preferences: decodeArchive(source()).preferences }));
  const shown = recordLines(archive.sessions[0]!);
  assert.deepEqual(shown.map(line => [line.speaker, line.text, line.typed ?? false]), lines.map(line => [line.speaker, line.text, line.typed ?? false]));
  assert.equal(shown[0]!.meaning, '你好！你吃了什么？');
  assert.equal(shown[0]!.time, lines[0]!.time);
  assert.equal(archive.sessions[0]!.fragments[0]!.meaningVisible, true);
});

test('kid conversations saved by the first kid-mode version keep their text, report and stars', async () => {
  const { legacyRecord } = await import('../../src/history.js');
  const record = legacyRecord({
    id: crypto.randomUUID(), profileID: 'p1', scenarioID: 'food', scenarioTitle: '食物和点餐', startedAt: '2026-10-31T15:34:13.000Z', seconds: 229,
    stars: 5, status: 'ok', report: { summary: '练习了买东西。', words: ['apple'], sentences: [], corrections: [], repeatSuccesses: 5, teachBackWord: '', nextSteps: [], reviewWords: ['apple'] },
    transcript: [{ speaker: 'assistant', text: 'Hi, Helen!', time: '2026-10-31T15:34:19.000Z' }, { speaker: 'user', text: 'I like my mom', time: '2026-10-31T15:34:30.000Z' }],
  });
  const archive = decodeArchive(encodeArchive({ schemaVersion: 2, sessions: [record], preferences: decodeArchive(source()).preferences }));
  const saved = archive.sessions[0]!;
  assert.deepEqual(saved.web?.kid && { stars: saved.web.kid.stars, words: saved.web.kid.report?.reviewWords, profile: saved.web.kid.profileID },
                   { stars: 5, words: ['apple'], profile: 'p1' });
  assert.deepEqual(recordLines(saved).map(line => [line.text, line.time]),
                   [['Hi, Helen!', '2026-10-31T15:34:19.000Z'], ['I like my mom', '2026-10-31T15:34:30.000Z']]);
  assert.equal(saved.fragments[1]!.startMS, 17_000);
});
