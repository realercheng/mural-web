import { useCallback, useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { withMeanings, createRecord } from './archive';
import { useAssessor } from './assess';
import { Conversation, Diagnostics, TopBar } from './common';
import { useHistory } from './history';
import { HistoryView } from './HistoryView';
import { KidMode } from './KidMode';
import { inScope, project, reviewWordsFor } from './learning';
import { LearningView } from './LearningView';
import { useKids, type LevelInfo, type Scenario } from './kids';
import { minutes, REASON_TEXT, useLive, type Ended } from './live';
import { useMeanings, useSubtitlePreference } from './meaning';

interface Usage { todaySeconds: number; monthSeconds: number; totalSeconds: number; remainingSeconds: number; nextSessionSeconds: number }
interface Language { id: string; name: string; nativeName: string }
type Phase = 'loading' | 'signin' | 'ready';
type Mode = 'home' | 'adult' | 'kid' | 'history' | 'learning';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [usage, setUsage] = useState<Usage>();
  const [languages, setLanguages] = useState<Language[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [levels, setLevels] = useState<LevelInfo[]>([]);
  const [reportsEnabled, setReportsEnabled] = useState(false);
  const [helpersEnabled, setHelpersEnabled] = useState(false);
  const [languageID, setLanguageID] = useState(() => localStorage.getItem('mural.language') ?? 'en');
  // A device used by a child reopens in kid mode.
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('mural.mode') as Mode | null) ?? 'home');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  const kids = useKids();
  const history = useHistory();
  const [subtitles, setSubtitles] = useSubtitlePreference();
  const meanings = useMeanings(mode === 'kid' ? 'en' : languageID);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (response.status === 401) { setPhase('signin'); return; }
    const body = await response.json();
    setUsage(body.usage); setLanguages(body.languages);
    setScenarios(body.kids?.scenarios ?? []); setLevels(body.kids?.levels ?? []); setReportsEnabled(Boolean(body.kids?.reports));
    setHelpersEnabled(Boolean(body.helpers));
    setPhase('ready');
  }, []);
  const live = useLive(useCallback(() => { refresh().catch(() => {}); }, [refresh]));
  const assessor = useAssessor(live, helpersEnabled);

  useEffect(() => { refresh().catch(() => setMessage('无法连接服务器，请检查网络后刷新。')); }, [refresh]);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (response.ok) { setCode(''); setPhase('loading'); await refresh(); return; }
    setMessage(response.status === 429 ? '尝试次数过多，请 15 分钟后再试。' : '访问码不正确。');
  };

  const choose = (next: Mode) => { setMode(next); if (next !== 'history' && next !== 'learning') localStorage.setItem('mural.mode', next); live.setMessage(''); };
  const languageName = (id: string) => languages.find(item => item.id === id)?.nativeName ?? id;
  const reading = { languageID: helpersEnabled ? (mode === 'kid' ? 'en' : languageID) : undefined, meanings: helpersEnabled ? meanings : undefined,
                    subtitles: helpersEnabled && subtitles, onSubtitles: setSubtitles };

  /** Saves a finished adult conversation, then again with the subtitles that arrive afterwards. */
  const saveAdult = (id: string, ended: Ended) => {
    if (!ended.lines.length) return;
    const record = createRecord({ id, languageID, title: `${languageName(languageID)} 自由对话`, startedAt: ended.startedAt, seconds: ended.seconds,
                                  confirmed: ended.confirmed, endReason: REASON_TEXT(ended.reason), lines: ended.lines, web: { mode: 'adult' } });
    history.save(record);
    assessor.complete(history, id);
    if (!reading.meanings || !subtitles) return;
    const mural = ended.lines.filter(line => line.speaker === 'assistant');
    Promise.all(mural.map(line => meanings.request(line.text))).then(results => {
      const found = new Map(mural.map((line, index) => [line.text, results[index]]));
      if (results.some(Boolean)) history.update(id, latest => withMeanings(latest, text => found.get(text)));
    });
  };
  const hiddenWords = Array.isArray(history.preferences.hiddenWords) ? history.preferences.hiddenWords as string[] : [];
  const chooseLanguage = (id: string) => { setLanguageID(id); localStorage.setItem('mural.language', id); };
  const serverUsage = usage
    ? `全家共用：今天已用 ${minutes(usage.todaySeconds)}，本月已用 ${minutes(usage.monthSeconds)}，剩余可用 ${minutes(usage.remainingSeconds)}。`
    : '';

  if (phase === 'loading') return <main className="screen center"><p className="muted">正在加载…</p>{message && <p className="error">{message}</p>}</main>;
  if (phase === 'signin') return (
    <main className="screen center">
      <h1>Mural 个人版</h1>
      <form className="signin" onSubmit={signIn}>
        <label htmlFor="code">访问码</label>
        <input id="code" type="password" autoComplete="current-password" value={code} onChange={event => setCode(event.target.value)} />
        <button className="primary" type="submit" disabled={!code}>登录</button>
      </form>
      {message && <p className="error">{message}</p>}
    </main>
  );

  const update = needRefresh && !live.busy && <button className="update" onClick={() => updateServiceWorker(true)}>有新版本，点击更新</button>;

  if (mode === 'kid') return (
    <>
      {update}
      <KidMode live={live} kids={kids} history={history} assessor={assessor} reading={reading} typing={helpersEnabled} scenarios={scenarios} levels={levels}
               reportsEnabled={reportsEnabled} serverUsage={serverUsage} onExit={() => choose('home')} />
    </>
  );

  if (mode === 'history') return (
    <>
      {update}
      <HistoryView history={history} kids={kids} languageName={languageName} supported={helpersEnabled ? languages.map(item => item.id) : []}
                   onBack={() => choose('home')} />
    </>
  );

  if (mode === 'learning') return (
    <>
      {update}
      <LearningView history={history} scope={{ kind: 'adult' }} title="学习进度和单词" languages={languages} defaultLanguage={languageID}
                    enabled={helpersEnabled} canHide onBack={() => choose('home')} />
    </>
  );

  if (mode === 'adult') return (
    <main className="screen">
      {update}
      <TopBar title="成人自由对话" onBack={live.busy ? undefined : () => choose('home')} />
      <p className="muted">对话保存在这台设备上，可在“对话历史”查看</p>
      <div className="languages" role="radiogroup" aria-label="学习语言">
        {languages.map(item => (
          <button key={item.id} role="radio" aria-checked={item.id === languageID} disabled={live.busy}
                  className={item.id === languageID ? 'chip selected' : 'chip'} onClick={() => chooseLanguage(item.id)}>
            {item.nativeName}
          </button>
        ))}
      </div>
      <Conversation live={live} idleLabel="开始" stopLabel="结束" reading={reading} typing={helpersEnabled}
                    onStart={() => {
                      const id = crypto.randomUUID();
                      assessor.begin(languageID);
                      // Words due for review go into the voice instructions as data, as TeachingPolicy.voice does.
                      const review = reviewWordsFor(project(history.sessions.filter(item => inScope(item, { kind: 'adult' })), languageID, hiddenWords)).join(',');
                      live.start({ language: languageID, ...(review ? { review } : {}) }, ended => saveAdult(id, ended));
                    }}
                    onStop={live.end} disabled={(usage?.nextSessionSeconds ?? 0) < 30} />
      {history.problem && <p className="error small">{history.problem}</p>}
      {usage && !live.busy && <p className="muted small">{serverUsage}</p>}
      <Diagnostics live={live} />
    </main>
  );

  return (
    <main className="screen">
      {update}
      <header>
        <h1>Mural 个人版</h1>
        <p className="muted">选择练习方式</p>
      </header>
      <div className="cards">
        <button className="card mode" onClick={() => choose('kid')}>
          <span className="avatar">🧒</span>
          <strong>孩子英语口语</strong>
          <span className="muted small">分难度练口语、跟读得星星、家长报告</span>
        </button>
        <button className="card mode" onClick={() => choose('adult')}>
          <span className="avatar">💬</span>
          <strong>成人自由对话</strong>
          <span className="muted small">英语或西班牙语，随意聊天</span>
        </button>
        <button className="card mode" onClick={() => choose('learning')}>
          <span className="avatar">📈</span>
          <strong>学习进度和单词</strong>
          <span className="muted small">每轮评估、记忆条、单词卡、自动复习</span>
        </button>
        <button className="card mode" onClick={() => choose('history')}>
          <span className="avatar">📚</span>
          <strong>对话历史</strong>
          <span className="muted small">查看、删除对话；导出和导入备份</span>
        </button>
      </div>
      {usage && <p className="muted small">{serverUsage}</p>}
    </main>
  );
}
