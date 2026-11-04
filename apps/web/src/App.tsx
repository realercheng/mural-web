import { useCallback, useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useAssessor } from './assess';
import { AdultMode, type Language } from './AdultMode';
import { useHistory } from './history';
import { HistoryView } from './HistoryView';
import { KidMode } from './KidMode';
import { LearningView } from './LearningView';
import { useKids, type LevelInfo, type Scenario } from './kids';
import { minutes, useLive } from './live';
import { useMeanings, useSubtitlePreference } from './meaning';

interface Usage { todaySeconds: number; monthSeconds: number; totalSeconds: number; remainingSeconds: number; nextSessionSeconds: number }
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
  const [topicsEnabled, setTopicsEnabled] = useState(false);
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
    setHelpersEnabled(Boolean(body.helpers)); setTopicsEnabled(Boolean(body.topics));
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
    <AdultMode live={live} history={history} assessor={assessor} reading={reading} helpers={helpersEnabled} topicsEnabled={topicsEnabled}
               languages={languages} languageID={languageID} onLanguage={chooseLanguage} nextSessionSeconds={usage?.nextSessionSeconds ?? 0}
               serverUsage={serverUsage} update={update} onBack={() => choose('home')} />
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
          <span className="muted small">13 种语言、24 个主题、时事话题，随意聊天</span>
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
