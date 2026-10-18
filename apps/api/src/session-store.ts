import session from 'express-session';
import type { PrismaClient } from '@prisma/client';

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

/** Shared, database-backed session storage. Expiry is enforced on reads and indexed for pruning. */
export class PrismaSessionStore extends session.Store {
  private writes = 0;

  constructor(private readonly prisma: PrismaClient) {
    super();
    const cleanup = setInterval(() => {
      void this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(err => {
        console.error('expired session cleanup failed', err instanceof Error ? err.name : 'unknown error');
      });
    }, 60 * 60 * 1000);
    cleanup.unref();
  }

  get(sid: string, callback: (err: unknown, session?: session.SessionData | null) => void): void {
    void this.prisma.session.findUnique({ where: { sid } }).then(async row => {
      if (!row || row.expiresAt <= new Date()) {
        if (row) await this.prisma.session.deleteMany({ where: { sid } });
        callback(null, null);
        return;
      }
      callback(null, JSON.parse(row.data) as session.SessionData);
    }).catch(callback);
  }

  set(sid: string, value: session.SessionData, callback?: (err?: unknown) => void): void {
    const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires) : new Date(Date.now() + (value.cookie?.maxAge ?? DEFAULT_TTL_MS));
    void this.prisma.session.upsert({
      where: { sid },
      create: { sid, data: JSON.stringify(value), expiresAt },
      update: { data: JSON.stringify(value), expiresAt },
    }).then(() => {
      this.writes += 1;
      if (this.writes % 100 === 0) void this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      callback?.();
    }).catch(err => callback?.(err));
  }

  touch(sid: string, value: session.SessionData, callback?: (err?: unknown) => void): void {
    const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires) : new Date(Date.now() + (value.cookie?.maxAge ?? DEFAULT_TTL_MS));
    void this.prisma.session.updateMany({ where: { sid }, data: { expiresAt } })
      .then(() => callback?.()).catch(err => callback?.(err));
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    void this.prisma.session.deleteMany({ where: { sid } }).then(() => callback?.()).catch(err => callback?.(err));
  }
}
