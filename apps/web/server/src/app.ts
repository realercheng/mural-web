import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { Auth, COOKIE_NAME } from './auth.js';
import type { Config } from './config.js';
import { LiveRelay } from './live.js';
import { kidScenario, publicKidScenarios, publicLevels } from './kids.js';
import { livePlan, publicLanguages } from './policy.js';
import { PendingReports, writeReport } from './report.js';
import { UsageStore } from './usage.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

export type Log = (event: string, fields?: Record<string, unknown>) => void;
// One JSON line per event. Never pass request bodies, cookies, audio or transcripts.
export const jsonLog: Log = (event, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

export function createApp(config: Config, log: Log = jsonLog): { server: Server; usage: UsageStore } {
  const auth = new Auth(config.accessCode, config.sessionSecret, config.sessionHours);
  const usage = new UsageStore(config.dataDir, config.timeZone);
  const limits = { maxSessionSeconds: config.maxSessionSeconds, dailyLimitSeconds: config.dailyLimitSeconds,
                   monthlyLimitSeconds: config.monthlyLimitSeconds, totalLimitSeconds: config.totalLimitSeconds };
  let active: LiveRelay | undefined;
  const pending = new PendingReports();
  const reporting = new Set<string>();
  const secure = config.publicOrigins.every(origin => origin.startsWith('https:'));
  const wsOrigins = config.publicOrigins.map(origin => origin.replace(/^http/, 'ws')).join(' ');
  const csp = `default-src 'self'; connect-src 'self' ${wsOrigins}; img-src 'self' data:; style-src 'self'; script-src 'self'; ` +
              "worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  const address = (request: IncomingMessage) => {
    const forwarded = request.headers['x-real-ip'];
    return config.trustProxy && typeof forwarded === 'string' ? forwarded : request.socket.remoteAddress ?? 'unknown';
  };
  const sameOrigin = (request: IncomingMessage) => config.publicOrigins.includes(request.headers.origin ?? '');
  const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    response.end(JSON.stringify(body));
  };
  const fail = (response: ServerResponse, status: number, code: string) => send(response, status, { error: { code } });
  const cookie = (value: string, maxAge: number) =>
    `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

  const readJSON = (request: IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_024) { reject(new Error('too_large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('invalid_json')); } });
    request.on('error', reject);
  });

  const serveStatic = (request: IncomingMessage, response: ServerResponse) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://local').pathname);
    let file = normalize(join(config.staticDir, path));
    if (!file.startsWith(config.staticDir + sep) && file !== config.staticDir) { fail(response, 404, 'not_found'); return; }
    let stat = (() => { try { return statSync(file); } catch { return undefined; } })();
    if (!stat?.isFile()) {
      // Single-page app: unknown navigations load the shell; missing assets stay 404.
      if (extname(path)) { fail(response, 404, 'not_found'); return; }
      file = join(config.staticDir, 'index.html'); stat = statSync(file);
    }
    const immutable = path.startsWith('/assets/');
    response.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': String(stat.size),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Security-Policy': csp,
    });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(file).pipe(response);
  };

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    const path = new URL(request.url ?? '/', 'http://local').pathname;
    try {
      if (path === '/api/health' && request.method === 'GET') { send(response, 200, { ok: true }); return; }
      if (path === '/api/login' && request.method === 'POST') {
        if (!sameOrigin(request)) { fail(response, 403, 'origin_rejected'); return; }
        const client = address(request);
        if (!auth.allowAttempt(client)) { fail(response, 429, 'too_many_attempts'); return; }
        const body = await readJSON(request) as { code?: unknown };
        if (!auth.verifyCode(client, body?.code)) { log('login_failed'); fail(response, 401, 'invalid_code'); return; }
        const session = auth.issue();
        log('login_succeeded');
        send(response, 200, { ok: true }, { 'Set-Cookie': cookie(session.value, session.maxAge) });
        return;
      }
      if (path === '/api/logout' && request.method === 'POST') {
        if (!sameOrigin(request)) { fail(response, 403, 'origin_rejected'); return; }
        send(response, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
        return;
      }
      if (path === '/api/status' && request.method === 'GET') {
        if (!auth.authenticated(request)) { fail(response, 401, 'sign_in_required'); return; }
        send(response, 200, { usage: usage.summary(limits), active: Boolean(active), languages: publicLanguages(),
                              kids: { scenarios: publicKidScenarios(), levels: publicLevels(), reports: Boolean(config.text) } });
        return;
      }
      if (path === '/api/kid/report' && request.method === 'POST') {
        if (!sameOrigin(request)) { fail(response, 403, 'origin_rejected'); return; }
        if (!auth.authenticated(request)) { fail(response, 401, 'sign_in_required'); return; }
        if (!config.text) { fail(response, 503, 'report_unavailable'); return; }
        const body = await readJSON(request) as { sessionID?: unknown };
        const id = typeof body?.sessionID === 'string' ? body.sessionID : '';
        const entry = pending.get(id);
        if (!entry) { fail(response, 404, 'report_not_found'); return; }
        if (!entry.lines.some(line => line.speaker === 'child' && line.text.trim())) {
          pending.delete(id); fail(response, 422, 'nothing_to_report'); return;
        }
        if (reporting.has(id)) { fail(response, 409, 'report_in_progress'); return; }
        reporting.add(id);
        try {
          const report = await writeReport(config.text, entry.scenario, entry.level, entry.lines);
          pending.delete(id);
          log('kid_report_written', { session: id, scenario: entry.scenario.id });
          send(response, 200, { report });
        } catch (error) {
          // The transcript stays pending, so the browser can retry.
          log('kid_report_failed', { session: id, category: error instanceof Error ? error.message.slice(0, 40) : 'unknown' });
          fail(response, 502, 'report_failed');
        } finally { reporting.delete(id); }
        return;
      }
      if (path.startsWith('/api/')) { fail(response, 404, 'not_found'); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { fail(response, 405, 'method_not_allowed'); return; }
      serveStatic(request, response);
    } catch (error) {
      log('request_failed', { path, category: error instanceof Error ? error.message : 'unknown' });
      if (!response.headersSent) fail(response, 400, 'invalid_request');
    }
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://local');
    const reject = (status: number, code: string) => {
      log('live_rejected', { code });
      socket.end(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (url.pathname !== '/api/live') return reject(404, 'not_found');
    if (!sameOrigin(request)) return reject(403, 'origin_rejected');
    if (!auth.authenticated(request)) return reject(401, 'sign_in_required');
    const chosen = livePlan(url.searchParams);
    if ('error' in chosen) return reject(400, chosen.error);
    if (active) return reject(409, 'session_active');
    // The page may ask for less time, e.g. a child's remaining daily minutes set by a parent.
    const requested = Number(url.searchParams.get('seconds') || Infinity);
    const allowed = Math.floor(Math.min(usage.summary(limits).nextSessionSeconds, requested > 0 ? requested : Infinity));
    if (allowed < config.minimumStartSeconds) return reject(429, 'quota_exhausted');
    sockets.handleUpgrade(request, socket, head, client => {
      if (active) { client.close(1013, 'session_active'); return; }
      const relay = new LiveRelay(client, chosen.plan, allowed, config, usage, log, transcript => {
        if (active === relay) active = undefined;
        const scenario = kidScenario(chosen.kid?.scenario ?? '');
        if (scenario && chosen.kid && transcript.length) pending.keep(relay.id, scenario, chosen.kid.level, transcript);
      });
      active = relay;
    });
  });
  return { server, usage };
}
