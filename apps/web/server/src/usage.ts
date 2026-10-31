import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionUsage {
  id: string;
  language: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
  source: 'provider' | 'wallclock';
  reason: string;
}

interface UsageFile {
  version: 1;
  totalSeconds: number;
  days: Record<string, number>;
  sessions: SessionUsage[];
}

export interface Limits { maxSessionSeconds: number; dailyLimitSeconds: number; monthlyLimitSeconds: number; totalLimitSeconds: number }

/** Durable voice-time ledger. Holds no audio, transcripts or credentials. */
export class UsageStore {
  private readonly path: string;
  private data: UsageFile;

  constructor(dataDir: string, private readonly timeZone: string, private readonly now: () => Date = () => new Date()) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'usage.json');
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as UsageFile;
      if (parsed.version !== 1 || typeof parsed.totalSeconds !== 'number') throw new Error('Unsupported usage file.');
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.data = { version: 1, totalSeconds: 0, days: {}, sessions: [] };
    }
  }

  day(date = this.now()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }

  summary(limits: Limits) {
    const day = this.day(), today = this.data.days[day] ?? 0;
    // Day keys are YYYY-MM-DD in the ledger's time zone, so a month is the sum of its days.
    const month = Object.entries(this.data.days).reduce((sum, [key, value]) => key.startsWith(day.slice(0, 8)) ? sum + value : sum, 0);
    const remaining = Math.max(0, Math.min(limits.dailyLimitSeconds - today, limits.monthlyLimitSeconds - month,
                                           limits.totalLimitSeconds - this.data.totalSeconds));
    return {
      todaySeconds: Math.round(today),
      monthSeconds: Math.round(month),
      totalSeconds: Math.round(this.data.totalSeconds),
      remainingSeconds: Math.floor(remaining),
      nextSessionSeconds: Math.floor(Math.min(limits.maxSessionSeconds, remaining)),
      limits,
    };
  }

  record(session: SessionUsage): void {
    const day = this.day(new Date(session.startedAt));
    this.data.days[day] = (this.data.days[day] ?? 0) + session.seconds;
    this.data.totalSeconds += session.seconds;
    this.data.sessions = [...this.data.sessions, session].slice(-500);
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
