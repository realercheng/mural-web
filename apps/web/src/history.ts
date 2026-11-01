// Conversation history on this device, in IndexedDB. Each record is an archive session
// (see archive.ts), so export and import need no conversion. Nothing is sent to the server.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveError, createRecord, decodeArchive, defaultPreferences, encodeArchive, mergeArchive, MAXIMUM_ENCODED_BYTES,
         type Archive, type Preferences, type SessionRecord } from './archive';
import type { SavedReport } from './kids';
import { sanitizeImported } from './learning';

const DB_NAME = 'mural';
const SESSIONS = 'sessions';
const META = 'meta';
/** Before history existed, kid conversations were kept in localStorage under this key. */
export const LEGACY_KIDS_KEY = 'mural.kids.v1';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('unavailable')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SESSIONS, { keyPath: 'id' });
      request.result.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  });
}

/** Runs one transaction and resolves only after it has been committed. */
function write(db: IDBDatabase, change: (sessions: IDBObjectStore, meta: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SESSIONS, META], 'readwrite');
    change(transaction.objectStore(SESSIONS), transaction.objectStore(META));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('aborted'));
  });
}

function readAll(db: IDBDatabase): Promise<{ sessions: SessionRecord[]; preferences?: Preferences }> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SESSIONS, META], 'readonly');
    const sessions = transaction.objectStore(SESSIONS).getAll();
    const preferences = transaction.objectStore(META).get('preferences');
    transaction.oncomplete = () => resolve({ sessions: sessions.result as SessionRecord[], preferences: preferences.result as Preferences | undefined });
    transaction.onerror = () => reject(transaction.error);
  });
}

/** A kid conversation saved by the first kid-mode version, as a history record. */
export function legacyRecord(saved: SavedReport): SessionRecord {
  return createRecord({
    id: saved.id, languageID: 'en', title: saved.scenarioTitle, startedAt: new Date(saved.startedAt), seconds: saved.seconds, confirmed: true,
    themeID: saved.scenarioID, lines: saved.transcript ?? [],
    web: { mode: 'kid', kid: { profileID: saved.profileID, scenarioID: saved.scenarioID, stars: saved.stars, status: saved.status,
                               ...(saved.report ? { report: saved.report } : {}) } },
  });
}

function legacyReports(): SavedReport[] {
  try {
    const reports = JSON.parse(localStorage.getItem(LEGACY_KIDS_KEY) ?? '{}')?.reports;
    return Array.isArray(reports) ? reports : [];
  } catch { return []; }
}

/**
 * Moves kid conversations from localStorage into IndexedDB. They leave localStorage only after
 * the IndexedDB transaction has committed, so a failure keeps them where they were.
 * Call before the app reads kid data.
 */
export async function migrateLegacyKidRecords(): Promise<void> {
  const reports = legacyReports();
  if (!reports.length) return;
  const db = await openDB();
  try {
    const records = reports.filter(item => item && typeof item.id === 'string').map(legacyRecord);
    await write(db, sessions => {
      // add() keeps a record that is already there, e.g. after an interrupted earlier attempt.
      for (const record of records) sessions.add(record).onerror = event => { event.preventDefault(); event.stopPropagation(); };
    });
    const data = JSON.parse(localStorage.getItem(LEGACY_KIDS_KEY)!);
    delete data.reports;
    localStorage.setItem(LEGACY_KIDS_KEY, JSON.stringify(data));
  } finally { db.close(); }
}

export interface ImportResult { added: number; skipped: number; profiles: unknown[] }

const newestFirst = (a: SessionRecord, b: SessionRecord) => b.startedAt - a.startedAt;

/** Device-local conversation history with a React state mirror. */
export function useHistory() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [db, setDB] = useState<IDBDatabase>();
  const [problem, setProblem] = useState('');
  // The latest records, readable at once: a later change (subtitles, assessments) builds on the
  // newest saved record instead of on the copy a slower task started with.
  const latest = useRef<SessionRecord[]>([]);
  const commit = useCallback((change: (items: SessionRecord[]) => SessionRecord[]) => {
    latest.current = change(latest.current).sort(newestFirst);
    setSessions(latest.current);
  }, []);

  useEffect(() => {
    let opened: IDBDatabase | undefined;
    openDB().then(async database => {
      opened = database;
      const loaded = await readAll(database);
      commit(items => [...loaded.sessions, ...items.filter(item => !loaded.sessions.some(other => other.id === item.id))]);
      if (loaded.preferences) setPreferences({ ...defaultPreferences(), ...loaded.preferences });
      setDB(database);
    }).catch(() => {
      // Kid conversations not yet migrated are still readable from localStorage.
      commit(() => legacyReports().map(legacyRecord));
      setProblem('这个浏览器无法使用本机数据库（例如无痕模式），新的对话不会保存。');
    });
    return () => opened?.close();
  }, [commit]);

  /** Adds or replaces a record. */
  const save = useCallback(async (record: SessionRecord) => {
    commit(items => [record, ...items.filter(item => item.id !== record.id)]);
    if (!db) return;
    try { await write(db, store => store.put(record)); setProblem(''); } catch {
      setProblem('对话没有保存成功。可能是设备存储空间不足。');
    }
  }, [db, commit]);

  const get = useCallback((id: string) => latest.current.find(item => item.id === id), []);

  /** Changes the newest saved version of a record. Does nothing when it has been deleted. */
  const update = useCallback((id: string, change: (record: SessionRecord) => SessionRecord) => {
    const current = latest.current.find(item => item.id === id);
    if (current) save(change(current));
  }, [save]);

  const remove = useCallback(async (ids: string[]) => {
    if (db) await write(db, store => { for (const id of ids) store.delete(id); });
    commit(items => items.filter(item => !ids.includes(item.id)));
  }, [db, commit]);

  const removeAll = useCallback(async () => {
    if (db) await write(db, store => store.clear());
    commit(() => []);
  }, [db, commit]);

  /** Changes the archive preferences (for example the hidden words) and keeps them on this device. */
  const changePreferences = useCallback(async (change: (current: Preferences) => Preferences) => {
    const next = change(preferences);
    setPreferences(next);
    if (db) await write(db, (_sessions, meta) => { meta.put(next, 'preferences'); });
  }, [db, preferences]);

  const exportArchive = useCallback((extra: Archive['web']) => {
    const archive: Archive = { schemaVersion: 2, sessions: [...sessions].sort((a, b) => a.startedAt - b.startedAt), preferences, web: extra };
    return new Blob([encodeArchive(archive)], { type: 'application/json' });
  }, [sessions, preferences]);

  /** Checks the whole file, then saves every new record in one transaction. A failure changes nothing. */
  const importArchive = useCallback(async (file: File): Promise<ImportResult> => {
    if (!db) throw new Error('unavailable');
    if (file.size > MAXIMUM_ENCODED_BYTES) throw new ArchiveError('tooLarge');
    const archive = decodeArchive(await file.text());
    const merged = mergeArchive(latest.current, archive);
    // As the apps do on import: keep only assessments that still fit their conversation.
    const added = merged.added.map(sanitizeImported);
    await write(db, store => { for (const record of added) store.add(record); });
    commit(items => [...items, ...added]);
    const profiles = Array.isArray(archive.web?.kids?.profiles) ? archive.web.kids.profiles : [];
    return { added: added.length, skipped: merged.skipped, profiles };
  }, [db, commit]);

  return { sessions, preferences, available: Boolean(db), problem, save, get, update, remove, removeAll, changePreferences, exportArchive, importArchive };
}

export type History = ReturnType<typeof useHistory>;
