// Kid-mode records kept only on this device (localStorage): profiles, stars, reports,
// per-child daily minutes and the parent password hash. The server keeps none of them.
import { useCallback, useState } from 'react';
import type { KidReport } from '../server/src/kids';
import type { Line } from './transcript';

export type { KidReport };
export type Level = 1 | 2 | 3 | 4;
export interface LevelInfo { level: Level; nameZh: string; hintZh: string }
export type Category = 'daily' | 'explore' | 'news';
export interface Scenario { id: string; category: Category; titleZh: string; titleEn: string; minutes: number; gameZh: string }
/** `level` is a difficulty a parent raises as the child grows; it is not a school grade. */
export interface Profile { id: string; nickname: string; level: Level; dailyMinutes: number; stars: number; createdAt: string }
export interface SavedReport {
  id: string; profileID: string; scenarioID: string; scenarioTitle: string; startedAt: string; seconds: number;
  stars: number; status: 'ok' | 'failed' | 'none' | 'off'; report?: KidReport;
  /** The conversation text, so parent and child can read it again. */
  transcript?: Line[];
}
interface KidData {
  version: 1;
  profiles: Profile[];
  reports: SavedReport[];
  /** Seconds per child per day, keyed by profile ID and then YYYY-MM-DD in Beijing time. */
  usage: Record<string, Record<string, number>>;
  parent?: { salt: string; hash: string };
}

const KEY = 'mural.kids.v1';
export const STARS_PER_STICKER = 5;
export const MAX_STARS_PER_TALK = 10;
/** Conversation texts kept, newest first (about 5 KB each); older records keep only their report. */
const MAX_TRANSCRIPTS = 100;
export const STICKERS = ['🦁', '🐼', '🦄', '🚀', '🌈', '🍉', '🐬', '🦕', '🎈', '🐝', '🍦', '🐢', '🦋', '🌻', '🐧', '🎨', '🦊', '🍓', '🐳', '🏆'];
export const AVATARS: Record<Level, string> = { 1: '🐣', 2: '🐥', 3: '🦉', 4: '🦅' };
export const NICKNAME = /^[\p{L}\p{N} ]{1,12}$/u;

export const today = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

function load(): KidData {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? '') as KidData;
    if (data?.version !== 1 || !Array.isArray(data.profiles)) throw new Error('unsupported');
    // The first test build stored a school grade (3 or 5); map it to a difficulty level.
    data.profiles = data.profiles.map(profile => {
      const { grade, ...rest } = profile as Profile & { grade?: number };
      return rest.level ? rest : { ...rest, level: grade === 5 ? 3 : 1 };
    });
    return data;
  } catch { /* first use */ }
  return { version: 1, profiles: [], reports: [], usage: {} };
}

export const stickers = (stars: number) => Array.from({ length: Math.floor(stars / STARS_PER_STICKER) }, (_, i) => STICKERS[i % STICKERS.length]!);

/** Device-local kid records with a React state mirror. */
export function useKids() {
  const [data, setData] = useState(load);
  const update = useCallback((change: (draft: KidData) => KidData) => setData(current => {
    const next = change(current);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {
      // Storage is full: keep reports, drop the text of the older half of the conversations.
      const keep = Math.floor(next.reports.length / 2);
      next.reports = next.reports.map((report, index) => (index < keep ? report : { ...report, transcript: undefined }));
      localStorage.setItem(KEY, JSON.stringify(next));
    }
    return next;
  }), []);

  const usedToday = (profileID: string) => data.usage[profileID]?.[today()] ?? 0;
  const lastReviewWords = (profileID: string) =>
    data.reports.find(item => item.profileID === profileID && item.report?.reviewWords.length)?.report?.reviewWords ?? [];

  return {
    profiles: data.profiles,
    reports: data.reports,
    hasParentPassword: Boolean(data.parent),
    usedToday,
    remainingToday: (profile: Profile) => Math.max(0, profile.dailyMinutes * 60 - usedToday(profile.id)),
    lastReviewWords,
    saveProfile: (profile: Profile) => update(d => ({
      ...d, profiles: d.profiles.some(p => p.id === profile.id) ? d.profiles.map(p => (p.id === profile.id ? profile : p)) : [...d.profiles, profile],
    })),
    deleteProfile: (id: string) => update(d => {
      const usage = { ...d.usage }; delete usage[id];
      return { ...d, profiles: d.profiles.filter(p => p.id !== id), reports: d.reports.filter(r => r.profileID !== id), usage };
    }),
    addUsage: (profileID: string, seconds: number) => update(d => {
      const day = today(), days = { ...(d.usage[profileID] ?? {}) };
      days[day] = (days[day] ?? 0) + seconds;
      // Keep two months of daily totals.
      for (const key of Object.keys(days)) if (key < today(new Date(Date.now() - 62 * 86_400_000))) delete days[key];
      return { ...d, usage: { ...d.usage, [profileID]: days } };
    }),
    /** Saves the report and adds its stars to the child's total. */
    addReport: (saved: SavedReport) => update(d => ({
      ...d,
      reports: [saved, ...d.reports.filter(r => r.id !== saved.id)].slice(0, 300)
        .map((report, index) => (index < MAX_TRANSCRIPTS ? report : { ...report, transcript: undefined })),
      profiles: d.profiles.map(p => (p.id === saved.profileID ? { ...p, stars: p.stars + saved.stars } : p)),
    })),
    setParentPassword: async (password: string) => {
      const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      const hash = await derive(password, salt);
      update(d => ({ ...d, parent: { salt, hash } }));
    },
    checkParentPassword: async (password: string) => Boolean(data.parent) && (await derive(password, data.parent!.salt)) === data.parent!.hash,
  };
}

export type Kids = ReturnType<typeof useKids>;

async function derive(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 200_000 }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
