import { resolve } from 'node:path';

export interface Config {
  port: number;
  /** Every origin that serves this app, e.g. the direct host and a regional front proxy. */
  publicOrigins: string[];
  upstreamURL: string;
  upstreamKey: string;
  model: string;
  voice: string;
  accessCode: string;
  sessionSecret: string;
  sessionHours: number;
  maxSessionSeconds: number;
  dailyLimitSeconds: number;
  /** Calendar month in `timeZone`. */
  monthlyLimitSeconds: number;
  totalLimitSeconds: number;
  minimumStartSeconds: number;
  idleAudioSeconds: number;
  closeGraceSeconds: number;
  trustProxy: boolean;
  dataDir: string;
  staticDir: string;
  timeZone: string;
  /** Responses API for parent reports, subtitles, word lookup and typed replies; all are off when unset. */
  text?: { url: string; key: string; model: string };
  /** Shared budget for subtitles, word lookup and typed replies. Parent reports are not counted. */
  helperLimits: { perMinute: number; perDay: number };
  /** Current-topic searches (text model with web search) per day in `timeZone`; 0 turns them off. */
  topicDailyLimit: number;
  /** Quiet seconds after Mural's last speech before one gentle check-in; 0 turns it off. */
  checkInSeconds: number;
}

function text(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = env[name]?.trim() || fallback;
  if (!value) throw new Error(`Missing required setting ${name}.`);
  return value;
}

function seconds(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${name} must be an integer between 0 and ${max}.`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicOrigins = text(env, 'PUBLIC_ORIGIN').split(',').map(value => new URL(value.trim()).origin);
  const upstream = new URL(text(env, 'LIVE_UPSTREAM_URL'));
  if (upstream.protocol !== 'wss:' && !(upstream.protocol === 'ws:' && upstream.hostname === '127.0.0.1'))
    throw new Error('LIVE_UPSTREAM_URL must use wss:// (ws:// is allowed only for 127.0.0.1 tests).');
  const accessCode = text(env, 'ACCESS_CODE');
  const sessionSecret = text(env, 'SESSION_SECRET');
  if (accessCode.length < 16) throw new Error('ACCESS_CODE must contain at least 16 characters.');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  return {
    port: seconds(env, 'PORT', 8080, 65_535),
    publicOrigins,
    upstreamURL: upstream.toString(),
    upstreamKey: text(env, 'LIVE_UPSTREAM_KEY'),
    model: text(env, 'LIVE_MODEL', 'gpt-live-1'),
    voice: text(env, 'LIVE_VOICE', 'marin'),
    accessCode,
    sessionSecret,
    sessionHours: seconds(env, 'SESSION_HOURS', 12, 24 * 30),
    maxSessionSeconds: seconds(env, 'MAX_SESSION_SECONDS', 600, 3_600),
    dailyLimitSeconds: seconds(env, 'DAILY_LIMIT_SECONDS', 1_200, 86_400),
    monthlyLimitSeconds: seconds(env, 'MONTHLY_LIMIT_SECONDS', 36_000, 2_678_400),
    totalLimitSeconds: seconds(env, 'TOTAL_LIMIT_SECONDS', 2_400, 10_000_000),
    minimumStartSeconds: seconds(env, 'MINIMUM_START_SECONDS', 30, 600),
    idleAudioSeconds: seconds(env, 'IDLE_AUDIO_SECONDS', 10, 600),
    closeGraceSeconds: seconds(env, 'CLOSE_GRACE_SECONDS', 15, 120),
    trustProxy: env.TRUST_PROXY === 'true',
    dataDir: text(env, 'DATA_DIR', '/data'),
    staticDir: resolve(text(env, 'STATIC_DIR', 'dist')),
    timeZone: text(env, 'USAGE_TIME_ZONE', 'Asia/Shanghai'),
    text: textModel(env),
    helperLimits: { perMinute: seconds(env, 'HELPER_PER_MINUTE', 20, 60), perDay: seconds(env, 'HELPER_DAILY_LIMIT', 1_000, 10_000) },
    topicDailyLimit: seconds(env, 'TOPIC_DAILY_LIMIT', 10, 1_000),
    checkInSeconds: seconds(env, 'CHECK_IN_SECONDS', 15, 600),
  };
}

function textModel(env: NodeJS.ProcessEnv): Config['text'] {
  const raw = env.TEXT_UPSTREAM_URL?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    throw new Error('TEXT_UPSTREAM_URL must use https:// (http:// is allowed only for 127.0.0.1 tests).');
  return { url: url.toString().replace(/\/+$/, ''), key: text(env, 'TEXT_UPSTREAM_KEY'), model: text(env, 'TEXT_MODEL', 'gpt-6-luna') };
}
