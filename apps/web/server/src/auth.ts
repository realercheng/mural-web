import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const COOKIE_NAME = 'mural_session';
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Single-user sign-in: one access code issues a signed, short-lived HttpOnly cookie. */
export class Auth {
  private readonly failures = new Map<string, { until: number; count: number }>();
  private globalFailures = { until: 0, count: 0 };

  constructor(private readonly accessCode: string, private readonly secret: string, private readonly sessionHours: number,
              private readonly now: () => number = Date.now) {}

  /** Returns false while this address, or all addresses together, exceed the failure budget. */
  allowAttempt(address: string): boolean {
    const now = this.now();
    const slot = this.failures.get(address);
    if (slot && slot.until > now && slot.count >= 5) return false;
    return !(this.globalFailures.until > now && this.globalFailures.count >= 20);
  }

  verifyCode(address: string, code: unknown): boolean {
    const valid = typeof code === 'string' && code.length <= 256 && timingSafeEqual(digest(code), digest(this.accessCode));
    if (!valid) {
      const now = this.now(), window = 15 * 60_000;
      const slot = this.failures.get(address);
      if (!slot || slot.until <= now) this.failures.set(address, { until: now + window, count: 1 });
      else slot.count += 1;
      if (this.globalFailures.until <= now) this.globalFailures = { until: now + window, count: 1 };
      else this.globalFailures.count += 1;
      if (this.failures.size > 1_000) for (const [key, value] of this.failures) if (value.until <= now) this.failures.delete(key);
    }
    return valid;
  }

  issue(): { value: string; maxAge: number } {
    const maxAge = this.sessionHours * 3_600;
    const payload = `${this.now() + maxAge * 1_000}.${randomBytes(16).toString('base64url')}`;
    return { value: `${payload}.${this.sign(payload)}`, maxAge };
  }

  authenticated(request: IncomingMessage): boolean {
    const value = readCookie(request.headers.cookie, COOKIE_NAME);
    if (!value) return false;
    const index = value.lastIndexOf('.');
    if (index < 0) return false;
    const payload = value.slice(0, index), signature = Buffer.from(value.slice(index + 1));
    const expected = Buffer.from(this.sign(payload));
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return false;
    const expires = Number(payload.split('.')[0]);
    return Number.isFinite(expires) && expires > this.now();
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}
