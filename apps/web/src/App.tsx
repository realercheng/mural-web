import { useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { AudioEngine, SpeechGate } from './audio';
import { encodeMulaw, frame, FRAME_AUDIO, FRAME_HEARTBEAT } from '../server/src/wire';

interface Usage { todaySeconds: number; totalSeconds: number; remainingSeconds: number; nextSessionSeconds: number }
interface Language { id: string; name: string; nativeName: string }
interface Line { speaker: 'user' | 'assistant'; text: string }
type Phase = 'loading' | 'signin' | 'idle' | 'connecting' | 'active' | 'closing';

const REASONS: Record<string, string> = {
  ended_by_learner: '你结束了对话', time_limit: '已到单次时长上限', idle_audio: '麦克风音频中断（可能切到后台或锁屏）',
  browser_disconnected: '页面连接断开', upstream_rejected: '语音服务拒绝连接', upstream_error: '语音服务连接出错',
  upstream_closed: '语音服务关闭了连接', start_timeout: '语音服务启动超时', expired: '会话因无输入音频而过期',
};
const REJECTIONS: Record<number, string> = { 1006: '连接被拒绝或中断。可能原因：未登录、额度用完或已有对话在进行。' };
const minutes = (seconds: number) => `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [usage, setUsage] = useState<Usage>();
  const [languages, setLanguages] = useState<Language[]>([]);
  const [languageID, setLanguageID] = useState(() => localStorage.getItem('mural.language') ?? 'en');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [allowed, setAllowed] = useState(0);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [level, setLevel] = useState(0);
  const socket = useRef<WebSocket | undefined>(undefined);
  const engine = useRef<AudioEngine | undefined>(undefined);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const startedAt = useRef(0);
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();

  const note = useCallback((text: string) => setDiagnostics(items => [`${clock()} ${text}`, ...items].slice(0, 40)), []);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (response.status === 401) { setPhase('signin'); return; }
    const body = await response.json();
    setUsage(body.usage); setLanguages(body.languages);
    setPhase(current => (current === 'loading' || current === 'signin' ? 'idle' : current));
  }, []);

  useEffect(() => { refresh().catch(() => setMessage('无法连接服务器，请检查网络后刷新。')); }, [refresh]);

  useEffect(() => {
    const onVisibility = () => {
      note(`页面${document.visibilityState === 'visible' ? '回到前台' : '进入后台'}`);
      if (document.visibilityState === 'visible' && socket.current && 'wakeLock' in navigator)
        navigator.wakeLock.request('screen').then(lock => { wakeLock.current = lock; }).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [note]);

  useEffect(() => {
    if (phase !== 'active' && phase !== 'connecting' && phase !== 'closing') { setLevel(0); return; }
    let frame = 0;
    const tick = () => {
      const current = engine.current;
      if (current) setLevel(Math.min(1, Math.max(current.inputLevel, current.outputLevel()) * 4));
      if (startedAt.current) setElapsed((Date.now() - startedAt.current) / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (response.ok) { setCode(''); setPhase('loading'); await refresh(); return; }
    setMessage(response.status === 429 ? '尝试次数过多，请 15 分钟后再试。' : '访问码不正确。');
  };

  const cleanup = useCallback(async () => {
    socket.current = undefined;
    await wakeLock.current?.release().catch(() => {});
    wakeLock.current = null;
    await engine.current?.stop();
    engine.current = undefined;
    startedAt.current = 0;
    setMuted(false);
    setPhase('idle');
    refresh().catch(() => {});
  }, [refresh]);

  const start = async () => {
    setMessage(''); setLines([]); setElapsed(0); setPhase('connecting');
    const audio = new AudioEngine();
    engine.current = audio;
    try {
      await audio.start();
    } catch (error) {
      note(`麦克风启动失败：${(error as Error).name}`);
      setMessage('无法使用麦克风。请在浏览器设置里允许本网站使用麦克风。');
      await cleanup();
      return;
    }
    note(`麦克风已开启，采样率 ${audio.sampleRate} Hz`);
    const track = audio.microphoneTrack;
    if (track) {
      track.onmute = () => note('系统将麦克风静音');
      track.onunmute = () => note('系统恢复麦克风');
      track.onended = () => note('麦克风轨道已结束');
    }
    if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(lock => { wakeLock.current = lock; }).catch(() => note('无法保持屏幕常亮'));
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live?language=${encodeURIComponent(languageID)}`);
    socket.current = ws;
    ws.binaryType = 'arraybuffer';
    const gate = new SpeechGate(pcm => {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm ? frame(FRAME_AUDIO, encodeMulaw(pcm)) : frame(FRAME_HEARTBEAT));
    });
    let maxBacklog = 0;
    audio.onChunk = (pcm, level) => { if (startedAt.current) gate.push(pcm, level); };
    ws.onmessage = event => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (bytes[0] === FRAME_AUDIO) { audio.play(bytes.subarray(1)); maxBacklog = Math.max(maxBacklog, audio.backlog); }
        return;
      }
      const data = JSON.parse(event.data as string);
      switch (data.type) {
        case 'mural.session':
          startedAt.current = Date.now(); setAllowed(data.allowedSeconds); setPhase('active'); note('对话已开始');
          break;
        case 'session.input_transcript.delta':
        case 'session.output_transcript.delta': {
          const speaker = data.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
          setLines(items => {
            const last = items[items.length - 1];
            if (last?.speaker === speaker) return [...items.slice(0, -1), { speaker, text: last.text + data.delta }];
            return [...items, { speaker, text: data.delta }];
          });
          break;
        }
        case 'error':
          note(`服务返回错误：${data.error?.code ?? 'unknown'}`);
          break;
        case 'mural.ended':
          note(`对话结束：${REASONS[data.reason] ?? data.reason}，计时 ${minutes(data.seconds)}${data.confirmed ? '' : '（按连接时长估算）'}`);
          note(`网络：下行 ${data.traffic?.toClientKB ?? '?'} KB，上行 ${data.traffic?.fromClientKB ?? '?'} KB，服务器待发积压最多 ${data.traffic?.maxBufferedKB ?? '?'} KB，本机播放积压最多 ${maxBacklog.toFixed(1)} 秒`);
          if (data.reason !== 'ended_by_learner') setMessage(`对话已结束：${REASONS[data.reason] ?? data.reason}`);
          break;
      }
    };
    ws.onclose = event => {
      if (socket.current !== ws) return;
      if (!startedAt.current) setMessage(REJECTIONS[event.code] ?? `连接已关闭（${event.code}）。`);
      note(`连接关闭，代码 ${event.code}`);
      cleanup();
    };
  };

  const end = () => {
    const ws = socket.current;
    if (!ws) return;
    setPhase('closing');
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.close' }));
    else ws.close();
  };

  const toggleMute = () => { const next = !muted; setMuted(next); engine.current?.mute(next); };
  const chooseLanguage = (id: string) => { setLanguageID(id); localStorage.setItem('mural.language', id); };
  const busy = phase === 'connecting' || phase === 'active' || phase === 'closing';

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

  return (
    <main className="screen">
      {needRefresh && !busy && <button className="update" onClick={() => updateServiceWorker(true)}>有新版本，点击更新</button>}
      <header>
        <h1>Mural 个人版</h1>
        <p className="muted">语音原型 · 不保存对话</p>
      </header>
      <div className="languages" role="radiogroup" aria-label="学习语言">
        {languages.map(item => (
          <button key={item.id} role="radio" aria-checked={item.id === languageID} disabled={busy}
                  className={item.id === languageID ? 'chip selected' : 'chip'} onClick={() => chooseLanguage(item.id)}>
            {item.nativeName}
          </button>
        ))}
      </div>
      <button className={`orb ${phase}`} style={{ transform: `scale(${1 + level * 0.25})` }}
              onClick={busy ? end : start} disabled={phase === 'closing' || (!busy && (usage?.nextSessionSeconds ?? 0) < 30)}
              aria-label={busy ? '结束对话' : '开始对话'}>
        <span>{phase === 'idle' ? '开始' : phase === 'connecting' ? '连接中' : phase === 'closing' ? '结束中' : '结束'}</span>
      </button>
      {busy && (
        <div className="controls">
          <span className="muted">{phase === 'active' ? `${minutes(elapsed)} / 上限 ${minutes(allowed)}` : ' '}</span>
          <button className="secondary" onClick={toggleMute} disabled={phase !== 'active'}>{muted ? '取消静音' : '静音'}</button>
        </div>
      )}
      {message && <p className="error">{message}</p>}
      <section className="transcript" aria-live="polite">
        {lines.map((line, index) => <p key={index} className={line.speaker}>{line.text}</p>)}
      </section>
      {usage && !busy && (
        <p className="muted small">今天已用 {minutes(usage.todaySeconds)}，原型累计 {minutes(usage.totalSeconds)}，剩余可用 {minutes(usage.remainingSeconds)}。</p>
      )}
      <details className="diagnostics">
        <summary>真机测试记录</summary>
        <p className="small muted">{navigator.userAgent}</p>
        <p className="small muted">显示模式：{matchMedia('(display-mode: standalone)').matches ? '主屏幕应用' : '浏览器标签页'}</p>
        {diagnostics.map((item, index) => <p key={index} className="small">{item}</p>)}
      </details>
    </main>
  );
}
