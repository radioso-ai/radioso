import type { NextFunction, Request, RequestHandler, Response } from "express";

const WINDOW_MS = 60_000; // 1 minute

interface SessionEntry {
  timestamps: number[];
}

const sessions = new Map<string, SessionEntry>();

// Clean up stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60_000;
let lastCleanup = Date.now();

const cleanup = (now: number) => {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) {
    return;
  }
  lastCleanup = now;
  for (const [key, entry] of sessions) {
    entry.timestamps = entry.timestamps.filter((ts) => now - ts < WINDOW_MS);
    if (entry.timestamps.length === 0) {
      sessions.delete(key);
    }
  }
};

export const anonymousRateLimiter: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const sessionId = res.locals.anonymousSessionId as string | undefined;
  const limit = (res.locals.anonymousRateLimit as number | undefined) ?? 10;

  if (!sessionId) {
    next();
    return;
  }

  const now = Date.now();
  cleanup(now);

  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { timestamps: [] };
    sessions.set(sessionId, entry);
  }

  // Remove timestamps outside the window
  entry.timestamps = entry.timestamps.filter((ts) => now - ts < WINDOW_MS);

  if (entry.timestamps.length >= limit) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfterSeconds = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);

    res.status(429).json({
      code: "rate_limit_exceeded",
      message: "Rate limit exceeded. Please wait before sending another message.",
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    });
    return;
  }

  entry.timestamps.push(now);
  next();
};

/** Reset all rate limit state. For testing only. */
export const resetRateLimiterState = () => {
  sessions.clear();
  lastCleanup = Date.now();
};
