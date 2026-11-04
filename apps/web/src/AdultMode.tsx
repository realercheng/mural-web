import { useEffect, useState } from 'react';
import { createRecord, toDate, withMeanings, type SessionRecord } from './archive';
import type { useAssessor } from './assess';
import { Conversation, Diagnostics, TopBar, type Reading } from './common';
import type { History } from './history';
import { inScope, project, reviewWordsFor } from './learning';
import { REASON_TEXT, type Ended, type HistoryMessage, type Live } from './live';

export interface Language { id: string; name: string; nativeName: string; topicPlaceholder?: string }
interface ThemeInfo { id: string; title: string; subtitle: string; category: string }
interface Found { id: string; topic: string; notes: string }

const CATEGORIES: Record<string, string> = { Everyday: '日常生活', Connection: '交流相处', 'Local life': '本地生活', Interests: '兴趣爱好' };
const TOPIC_ERRORS: Record<string, string> = {
  topic_limited: '今天的时事搜索次数用完了，明天再试，或选一个主题。', topics_unavailable: '服务器没有开启时事搜索。',
  topic_failed: '搜索没有成功，请稍后重试。', invalid_topic: '请输入 1 到 120 个字的话题。', sign_in_required: '登录已过期，请刷新页面。',
};
const CONTINUED_KEY = 'mural.continued.v1';
/** The last conversation can be continued once, and only when it stopped at the time limit (as `ConversationContinuationCheckpoint`). */
const TIME_LIMIT = REASON_TEXT('time_limit');

const continued = (): string[] => { try { const list = JSON.parse(localStorage.getItem(CONTINUED_KEY) ?? '[]'); return Array.isArray(list) ? list : []; } catch { return []; } };

/** The saved text as earlier turns: neighbouring lines of one speaker become one message. The server keeps the newest 40. */
export function earlierMessages(record: SessionRecord): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  for (const fragment of record.fragments) {
    const text = fragment.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const last = messages.at(-1);
    if (last?.role === fragment.speaker) last.text += ` ${text}`; else messages.push({ role: fragment.speaker, text });
  }
  return messages.slice(-40);
}

/** The newest adult conversation in this language, if it ended at the time limit and has not been continued. */
export function continuable(sessions: SessionRecord[], languageID: string): SessionRecord | undefined {
  const latest = sessions.find(item => item.languageID === languageID && item.web?.mode === 'adult');
  return latest && latest.endReason === TIME_LIMIT && latest.fragments.length && !continued().includes(latest.id) ? latest : undefined;
}

/** Free adult conversation in any of the 13 languages, with themes, a searched current topic, help and "continue last time". */
export function AdultMode({ live, history, assessor, reading, helpers, topicsEnabled, languages, languageID, onLanguage, nextSessionSeconds, serverUsage, update, onBack }: {
  live: Live; history: History; assessor: ReturnType<typeof useAssessor>; reading: Reading; helpers: boolean; topicsEnabled: boolean;
  languages: Language[]; languageID: string; onLanguage: (id: string) => void; nextSessionSeconds: number; serverUsage: string;
  update: React.ReactNode; onBack: () => void;
}) {
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [themeID, setThemeID] = useState<string>();
  const [topic, setTopic] = useState('');
  const [found, setFound] = useState<Found>();
  const [searching, setSearching] = useState(false);
  const [topicError, setTopicError] = useState('');
  const [, refresh] = useState(0);
  const language = languages.find(item => item.id === languageID);
  const earlier = continuable(history.sessions, languageID);

  useEffect(() => {
    let current = true;
    setThemes([]); setThemeID(undefined); setFound(undefined); setTopicError('');
    fetch(`/api/themes?language=${encodeURIComponent(languageID)}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : undefined)
      .then(body => { if (current && body?.themes) setThemes(body.themes); }).catch(() => {});
    return () => { current = false; };
  }, [languageID]);

  const search = async () => {
    if (!topic.trim() || searching) return;
    setSearching(true); setTopicError(''); setFound(undefined);
    try {
      const response = await fetch('/api/topic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: languageID, topic }) });
      const body = await response.json().catch(() => ({}));
      if (response.ok) { setFound(body); setThemeID('current'); }
      else setTopicError(TOPIC_ERRORS[body?.error?.code] ?? TOPIC_ERRORS.topic_failed!);
    } catch { setTopicError(TOPIC_ERRORS.topic_failed!); }
    setSearching(false);
  };

  /** Saves a finished conversation, then again with the subtitles that arrive afterwards. */
  const save = (id: string, ended: Ended, title: string, theme: string | undefined) => {
    if (!ended.lines.length) return;
    const record = createRecord({ id, languageID, title, startedAt: ended.startedAt, seconds: ended.seconds, confirmed: ended.confirmed,
                                  endReason: REASON_TEXT(ended.reason), lines: ended.lines, ...(theme ? { themeID: theme } : {}), web: { mode: 'adult' } });
    history.save(record);
    assessor.complete(history, id);
    if (!reading.meanings || !reading.subtitles) return;
    const mural = ended.lines.filter(line => line.speaker === 'assistant');
    Promise.all(mural.map(line => reading.meanings!.request(line.text))).then(results => {
      const byText = new Map(mural.map((line, index) => [line.text, results[index]]));
      if (results.some(Boolean)) history.update(id, latest => withMeanings(latest, text => byText.get(text)));
    });
  };

  const begin = (resume?: SessionRecord) => {
    const id = crypto.randomUUID();
    const hiddenWords = Array.isArray(history.preferences.hiddenWords) ? history.preferences.hiddenWords as string[] : [];
    // Words due for review go into the voice instructions as data, as TeachingPolicy.voice does.
    const review = reviewWordsFor(project(history.sessions.filter(item => inScope(item, { kind: 'adult' })), languageID, hiddenWords)).join(',');
    const theme = resume ? undefined : themeID === 'current' && found ? found : themes.find(item => item.id === themeID);
    const chosen = resume ? undefined : themeID;
    assessor.begin(languageID, chosen);
    const query: Record<string, string> = { language: languageID, ...(review ? { review } : {}) };
    if (resume) query.continue = '1';
    else if (themeID === 'current' && found) { query.theme = 'current'; query.topic = found.id; }
    else if (themeID) query.theme = themeID;
    const name = language?.nativeName ?? languageID;
    const title = resume ? `${name} 继续上次对话` : !theme ? `${name} 自由对话` : 'topic' in theme ? `${name} 时事：${theme.topic}` : `${name} ${theme.title}`;
    if (resume) { localStorage.setItem(CONTINUED_KEY, JSON.stringify([...continued(), resume.id].slice(-50))); refresh(n => n + 1); }
    live.start(query, ended => save(id, ended, title, chosen), resume ? earlierMessages(resume) : undefined);
  };

  const groups = Object.keys(CATEGORIES).map(key => ({ key, items: themes.filter(item => item.category === key) })).filter(group => group.items.length);
  const chosenTheme = themeID === 'current' ? (found ? `时事：${found.topic}` : '') : themes.find(item => item.id === themeID)?.title;
  return (
    <main className="screen">
      {update}
      <TopBar title="成人自由对话" onBack={live.busy ? undefined : onBack} />
      <p className="muted">对话保存在这台设备上，可在“对话历史”查看</p>
      <div className="languages" role="radiogroup" aria-label="学习语言">
        {languages.map(item => (
          <button key={item.id} role="radio" aria-checked={item.id === languageID} disabled={live.busy}
                  className={item.id === languageID ? 'chip selected' : 'chip'} onClick={() => onLanguage(item.id)}>
            {item.nativeName}
          </button>
        ))}
      </div>
      {!live.busy && (
        <details className="themes">
          <summary>{chosenTheme ? `主题：${chosenTheme}` : '选择主题（可不选，自由聊）'}</summary>
          {themeID && <button className="secondary" onClick={() => setThemeID(undefined)}>不用主题，自由聊天</button>}
          {groups.map(group => (
            <fieldset key={group.key}>
              <legend>{CATEGORIES[group.key]}</legend>
              <div className="languages wrap">
                {group.items.map(item => (
                  <button key={item.id} className={item.id === themeID ? 'chip selected' : 'chip'} aria-pressed={item.id === themeID}
                          onClick={() => setThemeID(item.id === themeID ? undefined : item.id)} title={item.subtitle}>{item.title}</button>
                ))}
              </div>
            </fieldset>
          ))}
          {topicsEnabled && (
            <fieldset>
              <legend>时事话题</legend>
              <form className="typed" onSubmit={event => { event.preventDefault(); search(); }}>
                <input value={topic} maxLength={120} onChange={event => setTopic(event.target.value)} aria-label="时事话题"
                       placeholder={language?.topicPlaceholder || '想聊的新闻或话题'} enterKeyHint="search" />
                <button className="secondary" type="submit" disabled={!topic.trim() || searching}>{searching ? '搜索中…' : '查找时事'}</button>
              </form>
              {topicError && <p className="error small">{topicError}</p>}
              {found && <div className="notes"><strong>{found.topic}</strong><p className="small">{found.notes}</p>
                <p className="muted small">摘要由文字模型搜索网页后写成，可能有误；Mural 只把它当参考资料。</p></div>}
            </fieldset>
          )}
        </details>
      )}
      {earlier && !live.busy && (
        <button className="secondary" onClick={() => begin(earlier)} disabled={nextSessionSeconds < 30}>
          继续上次对话（{toDate(earlier.startedAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}，因时长上限中断）
        </button>
      )}
      <Conversation live={live} idleLabel="开始" stopLabel="结束" reading={reading} typing={helpers} onStart={() => begin()} onStop={live.end}
                    disabled={nextSessionSeconds < 30}
                    extra={live.phase === 'active' && <button className="secondary" onClick={live.help}>🙋 帮助</button>} />
      {history.problem && <p className="error small">{history.problem}</p>}
      {serverUsage && !live.busy && <p className="muted small">{serverUsage}</p>}
      <Diagnostics live={live} />
    </main>
  );
}
