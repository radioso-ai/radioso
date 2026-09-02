import type { IncomingMessage } from "node:http";
import { resolveSourceDigest } from "@radioso/mcp-source-proof";

export interface PreAuthSourceBudget {
  consume(input: { sourceDigest: string }): boolean | Promise<boolean>;
}

export const digestPeerSource = (req: IncomingMessage, trustedProxyHops = 0): string =>
  resolveSourceDigest({
    forwardedFor: req.headers["x-forwarded-for"],
    socketAddress: req.socket.remoteAddress,
    trustedProxyHops,
  });

export const createFixedWindowPreAuthSourceBudget = (input: {
  maxAttempts: number;
  windowMs: number;
  maxSources?: number;
  now?: () => number;
}): PreAuthSourceBudget => {
  const maxSources = input.maxSources ?? 10_000;
  const now = input.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const pruneExpired = (at: number): void => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  };

  return {
    consume({ sourceDigest }) {
      const at = now();
      let bucket = buckets.get(sourceDigest);
      if (!bucket || bucket.resetAt <= at) {
        if (!bucket && buckets.size >= maxSources) pruneExpired(at);
        if (!bucket && buckets.size >= maxSources) return false;
        bucket = { count: 0, resetAt: at + input.windowMs };
        buckets.set(sourceDigest, bucket);
      }
      if (bucket.count >= input.maxAttempts) return false;
      bucket.count += 1;
      return true;
    },
  };
};
