import { useCallback, useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Conversation, Diagnostics, TopBar } from './common';
import { KidMode } from './KidMode';
import { useKids, type LevelInfo, type Scenario } from './kids';
import { minutes, useLive } from './live';

interface Usage { todaySeconds: number; monthSeconds: number; totalSeconds: number; remainingSeconds: number; nextSessionSeconds: number }
interface Language { id: string; name: string; nativeName: string }
type Phase = 'loading' | 'signin' | 'ready';
type Mode = 'home' | 'adult' | 'kid';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [usage, setUsage] = useState<Usage>();
  const [languages, setLanguages] = useState<Language[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [levels, setLevels] = useState<LevelInfo[]>([]);
  const [reportsEnabled, setReportsEnabled] = useState(false);
  const [languageID, setLanguageID] = useState(() => localStorage.getItem('mural.language') ?? 'en');
  // A device used by a child reopens in kid mode.
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('mural.mode') as Mode | null) ?? 'home');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  const kids = useKids();

  const refresh = useCallback(async () => {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (response.status === 401) { setPhase('signin'); return; }
    const body = await response.json();
    setUsage(body.usage); setLanguages(body.languages);
    setScenarios(body.kids?.scenarios ?? []); setLevels(body.kids?.levels ?? []); setReportsEnabled(Boolean(body.kids?.reports));
    setPhase('ready');
  }, []);
  const live = useLive(useCallback(() => { refresh().catch(() => {}); }, [refresh]));

  useEffect(() => { refresh().catch(() => setMessage('无法连接服务器，请检查网络后刷新。')); }, [refresh]);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (response.ok) { setCode(''); setPhase('loading'); await refresh(); return; }
    setMessage(response.status === 429 ? '尝试次数过多，请 15 分钟后再试。' : '访问码不正确。');
  };

  const choose = (next: Mode) => { setMode(next); localStorage.setItem('mural.mode', next); live.setMessage(''); };
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
      <KidMode live={live} kids={kids} scenarios={scenarios} levels={levels} reportsEnabled={reportsEnabled} serverUsage={serverUsage} onExit={() => choose('home')} />
    </>
  );

  if (mode === 'adult') return (
    <main className="screen">
      {update}
      <TopBar title="成人自由对话" onBack={live.busy ? undefined : () => choose('home')} />
      <p className="muted">语音原型 · 不保存对话</p>
      <div className="languages" role="radiogroup" aria-label="学习语言">
        {languages.map(item => (
          <button key={item.id} role="radio" aria-checked={item.id === languageID} disabled={live.busy}
                  className={item.id === languageID ? 'chip selected' : 'chip'} onClick={() => chooseLanguage(item.id)}>
            {item.nativeName}
          </button>
        ))}
      </div>
      <Conversation live={live} idleLabel="开始" stopLabel="结束" onStart={() => live.start({ language: languageID })} onStop={live.end}
                    disabled={(usage?.nextSessionSeconds ?? 0) < 30} />
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
      </div>
      {usage && <p className="muted small">{serverUsage}</p>}
    </main>
  );
}
