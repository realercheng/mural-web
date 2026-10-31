import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine, SpeechGate } from './audio';
import { encodeMulaw, frame, FRAME_AUDIO, FRAME_HEARTBEAT, readOutputFrame } from '../server/src/wire';

export interface Line { speaker: 'user' | 'assistant'; text: string }
export type LivePhase = 'idle' | 'connecting' | 'active' | 'closing';
export interface Ended { sessionID?: string; reason: string; seconds: number; confirmed: boolean }

const REASONS: Record<string, string> = {
  ended_by_learner: '你结束了对话', said_goodbye: '已说再见', time_limit: '已到本次时长上限', idle_audio: '麦克风音频中断（可能切到后台或锁屏）',
  browser_disconnected: '页面连接断开', upstream_rejected: '语音服务拒绝连接', upstream_error: '语音服务连接出错',
  upstream_closed: '语音服务关闭了连接', start_timeout: '语音服务启动超时', expired: '会话因无输入音频而过期',
};
const EXPECTED = new Set(['ended_by_learner', 'said_goodbye', 'time_limit']);
const REJECTIONS: Record<number, string> = { 1006: '连接被拒绝或中断。可能原因：未登录、额度用完或已有对话在进行。' };
export const minutes = (seconds: number) => `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

/**
 * One live conversation through the gateway: microphone, socket, playback and transcript.
 * `query` selects the conversation (language, or kid scenario); the server decides the rest.
 */
export function useLive(refresh: () => void) {
  const [phase, setPhase] = useState<LivePhase>('idle');
  const [message, setMessage] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [allowed, setAllowed] = useState(0);
  const [wrapping, setWrapping] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [level, setLevel] = useState(0);
  const socket = useRef<WebSocket | undefined>(undefined);
  const engine = useRef<AudioEngine | undefined>(undefined);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const startedAt = useRef(0);

  const note = useCallback((text: string) => setDiagnostics(items => [`${clock()} ${text}`, ...items].slice(0, 40)), []);

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
    if (phase === 'idle') { setLevel(0); return; }
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

  const cleanup = useCallback(async () => {
    socket.current = undefined;
    await wakeLock.current?.release().catch(() => {});
    wakeLock.current = null;
    await engine.current?.stop();
    engine.current = undefined;
    startedAt.current = 0;
    setMuted(false); setWrapping(false);
    setPhase('idle');
    refresh();
  }, [refresh]);

  const start = async (query: Record<string, string>, onEnded?: (ended: Ended) => void) => {
    setMessage(''); setLines([]); setElapsed(0); setWrapping(false); setPhase('connecting');
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
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live?${new URLSearchParams(query)}`);
    socket.current = ws;
    ws.binaryType = 'arraybuffer';
    const gate = new SpeechGate(pcm => {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm ? frame(FRAME_AUDIO, encodeMulaw(pcm)) : frame(FRAME_HEARTBEAT));
    });
    let maxBacklog = 0, sessionID: string | undefined;
    audio.onChunk = (pcm, level) => { if (startedAt.current) gate.push(pcm, level); };
    ws.onmessage = event => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (bytes[0] === FRAME_AUDIO && bytes.length > 5) {
          const { offsetSamples, payload } = readOutputFrame(bytes);
          audio.play(payload, offsetSamples); maxBacklog = Math.max(maxBacklog, audio.backlog);
        }
        return;
      }
      const data = JSON.parse(event.data as string);
      switch (data.type) {
        case 'mural.session':
          sessionID = data.sessionID;
          startedAt.current = Date.now(); setAllowed(data.allowedSeconds); setPhase('active'); note('对话已开始');
          break;
        case 'mural.wrapping_up':
          setWrapping(true); note('请 Mural 收尾并说再见');
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
          if (data.error?.code === 'content_filter')
            setMessage('语音服务的内容安全过滤中止了这次对话。请重新开始；如果反复出现，请把“真机测试记录”发给管理员。');
          break;
        case 'mural.ended':
          note(`对话结束：${REASONS[data.reason] ?? data.reason}，计时 ${minutes(data.seconds)}${data.confirmed ? '' : '（按连接时长估算）'}`);
          note(`网络：下行 ${data.traffic?.toClientKB ?? '?'} KB，上行 ${data.traffic?.fromClientKB ?? '?'} KB，服务器待发积压最多 ${data.traffic?.maxBufferedKB ?? '?'} KB，本机播放积压最多 ${maxBacklog.toFixed(1)} 秒，断流 ${audio.underruns} 次，缓冲 ${audio.jitterBuffer.toFixed(2)} 秒`);
          if (!EXPECTED.has(data.reason)) setMessage(current => current || `对话已结束：${REASONS[data.reason] ?? data.reason}`);
          onEnded?.({ sessionID, reason: data.reason, seconds: data.seconds, confirmed: data.confirmed });
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

  /** Kid mode: Mural asks the child to teach it a word and says goodbye; the call ends a minute later. */
  const wrapUp = () => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mural.wrap_up' }));
    setWrapping(true);
  };

  const toggleMute = () => { const next = !muted; setMuted(next); engine.current?.mute(next); };
  const busy = phase !== 'idle';

  return { phase, busy, message, setMessage, lines, muted, elapsed, allowed, wrapping, diagnostics, level, start, end, wrapUp, toggleMute };
}

export type Live = ReturnType<typeof useLive>;
