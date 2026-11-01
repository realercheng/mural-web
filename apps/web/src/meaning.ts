// Chinese subtitles for Mural's lines and contextual word meanings. The server holds the
// text-model key and the instructions; the page sends only the text and the language.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Line } from './transcript';

export interface Meaning { status: 'loading' | 'ok' | 'error'; text?: string; error?: string }

const ERRORS: Record<number, string> = {
  400: '这段文字无法查询。', 401: '登录已过期，请刷新页面。', 429: '请求太频繁，或今天的字幕和查词次数已用完。请稍后再试。',
  503: '服务器没有开启文字模型。',
};

async function helper(path: '/api/meaning' | '/api/lookup', body: Record<string, string>): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new Error('网络连接失败，请稍后重试。'); }
  if (!response.ok) throw new Error(ERRORS[response.status] ?? '暂时无法获取，请稍后重试。');
  return (await response.json()).text as string;
}

/**
 * Subtitles, one request at a time in the order asked. A result is kept for the page's lifetime;
 * a failure is not, so the learner can tap to retry.
 */
export function useMeanings(languageID: string) {
  const [entries, setEntries] = useState<Record<string, Meaning>>({});
  const requests = useRef(new Map<string, Promise<string | undefined>>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const key = useCallback((text: string) => `${languageID}|${text.trim()}`, [languageID]);

  const request = useCallback((text: string): Promise<string | undefined> => {
    const id = key(text);
    const existing = requests.current.get(id);
    if (existing || !text.trim()) return existing ?? Promise.resolve(undefined);
    setEntries(items => ({ ...items, [id]: { status: 'loading' } }));
    const job = queue.current.then(() => helper('/api/meaning', { language: languageID, text: text.trim() })).then(meaning => {
      setEntries(items => ({ ...items, [id]: { status: 'ok', text: meaning } }));
      return meaning;
    }, (error: Error) => {
      requests.current.delete(id);
      setEntries(items => ({ ...items, [id]: { status: 'error', error: error.message } }));
      return undefined;
    });
    queue.current = job;
    requests.current.set(id, job);
    return job;
  }, [key, languageID]);

  const get = useCallback((text: string): Meaning | undefined => entries[key(text)], [entries, key]);
  return useMemo(() => ({ request, get }), [request, get]);
}

export type Meanings = ReturnType<typeof useMeanings>;

const lookups = new Map<string, Promise<string>>();

/** The meaning of a word in its sentence, cached for the page's lifetime. */
export function lookUp(languageID: string, word: string, sentence: string): Promise<string> {
  const id = `${languageID}|${word.toLowerCase()}|${sentence}`;
  let job = lookups.get(id);
  if (!job) {
    job = helper('/api/lookup', { language: languageID, word, sentence: sentence.slice(0, 1_500) });
    lookups.set(id, job);
    job.catch(() => lookups.delete(id));
  }
  return job;
}

/** Subtitles on or off, remembered on this device. */
export function useSubtitlePreference(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => localStorage.getItem('mural.subtitles') !== 'off');
  return [on, (next: boolean) => { setOn(next); localStorage.setItem('mural.subtitles', next ? 'on' : 'off'); }];
}

/** Splits text into words (tappable) and the characters between them, keeping every character. Chinese is not tappable. */
export function words(text: string): { text: string; word: boolean }[] {
  return text.split(/([\p{L}\p{M}](?:[\p{L}\p{M}'’-]*[\p{L}\p{M}])?)/u).filter(Boolean)
    .map(part => ({ text: part, word: /^[\p{L}\p{M}]/u.test(part) && !/\p{Script=Han}/u.test(part) }));
}

const SENTENCE_END = /[.!?…。！？]["'”’)]?$/u;

/**
 * Asks for subtitles of Mural's lines during a call once each line has settled: when a later line
 * exists, when the call has ended, or after a quiet moment (as MeaningController does).
 */
export function useLiveSubtitles(lines: Line[], ended: boolean, meanings: Meanings | undefined, on: boolean) {
  const request = meanings?.request;
  useEffect(() => {
    if (!on || !request) return;
    lines.forEach((line, index) => { if (line.speaker === 'assistant' && (index < lines.length - 1 || ended)) request(line.text); });
    const last = lines.at(-1);
    if (!last || last.speaker !== 'assistant' || ended) return;
    const timer = setTimeout(() => request(last.text), SENTENCE_END.test(last.text.trim()) ? 1_200 : 3_000);
    return () => clearTimeout(timer);
  }, [lines, ended, request, on]);
}
