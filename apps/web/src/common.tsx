import { minutes, type Line, type Live } from './live';

export function TopBar({ title, onBack, children }: { title: string; onBack?: () => void; children?: React.ReactNode }) {
  return (
    <header className="topbar">
      {onBack ? <button className="back" onClick={onBack} aria-label="返回">‹ 返回</button> : <span />}
      <h1>{title}</h1>
      <span className="topbar-end">{children}</span>
    </header>
  );
}

/** The talk orb, timer, mute and transcript shared by both modes. */
export function Conversation({ live, idleLabel, onStart, onStop, stopLabel, disabled, extra }: {
  live: Live; idleLabel: string; onStart: () => void; onStop: () => void; stopLabel: string; disabled?: boolean; extra?: React.ReactNode;
}) {
  const { phase, busy } = live;
  return (
    <>
      <button className={`orb ${phase}`} style={{ transform: `scale(${1 + live.level * 0.25})` }}
              onClick={busy ? onStop : onStart} disabled={phase === 'closing' || (!busy && disabled)}
              aria-label={busy ? stopLabel : idleLabel}>
        <span>{phase === 'idle' ? idleLabel : phase === 'connecting' ? '连接中' : phase === 'closing' ? '结束中' : stopLabel}</span>
      </button>
      {busy && (
        <div className="controls">
          <span className="muted">{phase === 'active' ? `${minutes(live.elapsed)} / 上限 ${minutes(live.allowed)}` : ' '}</span>
          <button className="secondary" onClick={live.toggleMute} disabled={phase !== 'active'}>{live.muted ? '取消静音' : '静音'}</button>
          {extra}
        </div>
      )}
      {live.message && <p className="error">{live.message}</p>}
      <Transcript lines={live.lines} newestFirst />
    </>
  );
}

const clockTime = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });

/** Conversation text with a time on each line. During a call the newest line is on top, so no scrolling is needed. */
export function Transcript({ lines, newestFirst = false }: { lines: Line[]; newestFirst?: boolean }) {
  const ordered = newestFirst ? [...lines].reverse() : lines;
  return (
    <section className="transcript" aria-live="polite">
      {ordered.map((line, index) => (
        <div key={newestFirst ? lines.length - index : index} className={`line ${line.speaker}`}>
          <span className="time">{line.speaker === 'user' ? '我' : 'Mural'} · {clockTime(line.time)}</span>
          <p>{line.text}</p>
        </div>
      ))}
    </section>
  );
}

export function Diagnostics({ live }: { live: Live }) {
  return (
    <details className="diagnostics">
      <summary>真机测试记录</summary>
      <p className="small muted">{navigator.userAgent}</p>
      <p className="small muted">显示模式：{matchMedia('(display-mode: standalone)').matches ? '主屏幕应用' : '浏览器标签页'}</p>
      {live.diagnostics.map((item, index) => <p key={index} className="small">{item}</p>)}
    </details>
  );
}
