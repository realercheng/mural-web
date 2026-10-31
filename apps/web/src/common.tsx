import { useEffect, useState } from 'react';
import type { ShownLine } from './archive';
import { minutes, type Live } from './live';
import { lookUp, useLiveSubtitles, words, type Meanings } from './meaning';

export function TopBar({ title, onBack, children }: { title: string; onBack?: () => void; children?: React.ReactNode }) {
  return (
    <header className="topbar">
      {onBack ? <button className="back" onClick={onBack} aria-label="返回">‹ 返回</button> : <span />}
      <h1>{title}</h1>
      <span className="topbar-end">{children}</span>
    </header>
  );
}

/** Subtitle and word-lookup settings shared by a transcript. Lookup and subtitles are off without `languageID`. */
export interface Reading { languageID?: string; meanings?: Meanings; subtitles: boolean; onSubtitles: (on: boolean) => void }

export function SubtitleToggle({ reading }: { reading: Reading }) {
  if (!reading.languageID || !reading.meanings) return null;
  return (
    <button className={reading.subtitles ? 'chip selected' : 'chip'} aria-pressed={reading.subtitles}
            onClick={() => reading.onSubtitles(!reading.subtitles)}>中文字幕</button>
  );
}

/** The talk orb, timer, mute, typed replies and transcript shared by both modes. */
export function Conversation({ live, idleLabel, onStart, onStop, stopLabel, disabled, extra, reading, typing }: {
  live: Live; idleLabel: string; onStart: () => void; onStop: () => void; stopLabel: string; disabled?: boolean; extra?: React.ReactNode;
  reading: Reading; typing: boolean;
}) {
  const { phase, busy } = live;
  useLiveSubtitles(live.lines, phase === 'idle', reading.meanings, reading.subtitles);
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
      <div className="row center-row">
        <SubtitleToggle reading={reading} />
        {typing && phase === 'active' && <TypedReply live={live} />}
      </div>
      <Transcript lines={live.lines} newestFirst reading={reading} />
    </>
  );
}

/** A text box for when speaking is not convenient. The server writes Mural's reply and Mural says it. */
function TypedReply({ live }: { live: Live }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  if (!open) return <button className="chip" onClick={() => setOpen(true)}>⌨️ 打字</button>;
  return (
    <form className="typed" onSubmit={async event => {
      event.preventDefault();
      if (!text.trim() || sending) return;
      setSending(true); setError('');
      const failure = await live.sendTyped(text);
      setSending(false);
      if (failure) setError(failure); else setText('');
    }}>
      <input value={text} maxLength={300} onChange={event => setText(event.target.value)} placeholder="不方便说话时，在这里打字" aria-label="打字回复" enterKeyHint="send" />
      <button className="primary" type="submit" disabled={!text.trim() || sending}>{sending ? '发送中' : '发送'}</button>
      <button className="secondary" type="button" onClick={() => { setOpen(false); setError(''); }}>收起</button>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

const clockTime = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });

/**
 * Conversation text with a time on each line. During a call the newest line is on top, so no scrolling is needed.
 * Mural's lines can show a Chinese subtitle; tapping a word shows its meaning in that sentence.
 */
export function Transcript({ lines, newestFirst = false, reading }: { lines: ShownLine[]; newestFirst?: boolean; reading?: Reading }) {
  const [selected, setSelected] = useState<{ word: string; sentence: string }>();
  const ordered = newestFirst ? [...lines].reverse() : lines;
  const languageID = reading?.languageID;
  return (
    <section className="transcript" aria-live="polite">
      {ordered.map((line, index) => {
        const meaning = reading?.subtitles && line.speaker === 'assistant' ? (line.meaning ? { status: 'ok' as const, text: line.meaning } : reading.meanings?.get(line.text)) : undefined;
        return (
          <div key={newestFirst ? lines.length - index : index} className={`line ${line.speaker}`}>
            <span className="time">{line.speaker === 'user' ? '我' : 'Mural'} · {clockTime(line.time)}{line.typed ? ' · 打字' : ''}</span>
            <p>{languageID ? words(line.text).map((part, i) => part.word
              ? <button key={i} className="word" onClick={() => setSelected({ word: part.text, sentence: line.text.trim() })}>{part.text}</button>
              : <span key={i}>{part.text}</span>) : line.text}</p>
            {meaning?.status === 'ok' && <p className="meaning">{meaning.text}</p>}
            {meaning?.status === 'loading' && <p className="meaning muted">翻译中…</p>}
            {meaning?.status === 'error' && <button className="meaning link" onClick={() => reading!.meanings!.request(line.text)}>字幕获取失败，点此重试</button>}
          </div>
        );
      })}
      {selected && languageID && <WordSheet languageID={languageID} {...selected} onClose={() => setSelected(undefined)} />}
    </section>
  );
}

/** The meaning of one tapped word in its sentence, in Chinese. */
function WordSheet({ languageID, word, sentence, onClose }: { languageID: string; word: string; sentence: string; onClose: () => void }) {
  const [state, setState] = useState<{ text?: string; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState({});
    lookUp(languageID, word, sentence).then(text => { if (current) setState({ text }); }, (error: Error) => { if (current) setState({ error: error.message }); });
    return () => { current = false; };
  }, [languageID, word, sentence, attempt]);
  return (
    <div className="sheet" role="dialog" aria-label={`${word} 的意思`}>
      <div className="sheet-head">
        <strong>{word}</strong>
        <button className="secondary" onClick={onClose}>关闭</button>
      </div>
      {!state.text && !state.error && <p className="muted">查询中…</p>}
      {state.text && <p className="sheet-text">{state.text}</p>}
      {state.error && <><p className="error">{state.error}</p><button className="secondary" onClick={() => setAttempt(n => n + 1)}>重试</button></>}
      <p className="small muted">意思由文字模型根据这句话给出，可能有误差。</p>
    </div>
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
