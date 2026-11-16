import type { UsageLimitPolicy } from "../../../shared/domain/usageLimitPolicy.js";

const ONE_MINUTE_MS = 60_000;

/**
 * How long one instance trusts a workspace's plan cap before reading it again. The cap is a
 * per-window budget and the default window is a minute, so a tier change reaching every instance
 * within one window is as fresh as the budget it governs, and a busy workspace costs one plan read
 * per instance per minute rather than one per visitor message.
 */
const PLAN_CAP_CACHE_TTL_MS = ONE_MINUTE_MS;

/**
 * How long visitor messages wait on a plan read. Every message of the workspace that arrives
 * meanwhile waits on the same read, so a store that hangs rather than fails holds them this long
 * and no longer.
 */
const PLAN_READ_TIMEOUT_MS = 2_000;

/**
 * How long the deployment default stands in after a read that timed out before the plan is asked
 * again: shorter than the cache period, so a store that recovers is read again soon.
 */
const PLAN_READ_RETRY_AFTER_TIMEOUT_MS = 10_000;

/** Messages per window all of one workspace's public chat visitors may send together. */
interface PublicChatWorkspaceRateLimit {
  limitFor(workspaceId: string): Promise<number>;
}

interface CachedLimit {
  limit: Promise<number>;
  expiresAtMs: number;
}

const isUsableCap = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const TIMED_OUT = Symbol("plan read timed out");

const withinTimeout = async <T>(read: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export const createPublicChatWorkspaceRateLimit = (input: {
  policy: Pick<UsageLimitPolicy, "getPublicChatMessagesPerMinute">;
  /** The deployment's own workspace budget per window, for every plan that does not set one. */
  defaultLimit: number;
  windowMs: number;
  logger: { warn(fields: Record<string, unknown>, message: string): void };
  now?: () => number;
}): PublicChatWorkspaceRateLimit => {
  const now = input.now ?? Date.now;
  // One entry per workspace that has passed a public session check in each map, so both are
  // bounded by the number of workspaces with public chat traffic.
  const cache = new Map<string, CachedLimit>();
  const lastWarnedAtMs = new Map<string, number>();

  // A plan states its cap per minute, which is how it is sold; the budget it replaces is counted
  // per rate-limit window.
  const perWindow = (messagesPerMinute: number): number =>
    Math.max(1, Math.round((messagesPerMinute * input.windowMs) / ONE_MINUTE_MS));

  // Once a cache period per workspace, whether the store fails or hangs, rather than on every
  // read a hanging store makes time out.
  const warnUnreadable = (workspaceId: string, fields: Record<string, unknown>): void => {
    const nowMs = now();
    const warnedAtMs = lastWarnedAtMs.get(workspaceId);
    if (warnedAtMs !== undefined && nowMs - warnedAtMs < PLAN_CAP_CACHE_TTL_MS) {
      return;
    }
    lastWarnedAtMs.set(workspaceId, nowMs);
    input.logger.warn(
      { ...fields, workspaceId },
      "Public chat workspace cap could not be read from the usage-limit policy; using the deployment default",
    );
  };

  const readLimit = async (workspaceId: string, onTimeout: () => void): Promise<number> => {
    if (!input.policy.getPublicChatMessagesPerMinute) {
      return input.defaultLimit;
    }
    try {
      const messagesPerMinute = await withinTimeout(
        input.policy.getPublicChatMessagesPerMinute({ workspaceId }),
        PLAN_READ_TIMEOUT_MS,
      );
      if (messagesPerMinute === TIMED_OUT) {
        onTimeout();
        warnUnreadable(workspaceId, { timeoutMs: PLAN_READ_TIMEOUT_MS });
        return input.defaultLimit;
      }
      return isUsableCap(messagesPerMinute) ? perWindow(messagesPerMinute) : input.defaultLimit;
    } catch (error) {
      // Kept for the cache period like a successful read, so a failing store is asked once a
      // minute per workspace rather than on every visitor message.
      warnUnreadable(workspaceId, { err: error });
      return input.defaultLimit;
    }
  };

  return {
    limitFor(workspaceId) {
      const nowMs = now();
      const cached = cache.get(workspaceId);
      if (cached && cached.expiresAtMs > nowMs) {
        return cached.limit;
      }
      const askAgainSoon = () => {
        const entry = cache.get(workspaceId);
        if (entry?.limit === limit) {
          entry.expiresAtMs = Math.min(entry.expiresAtMs, now() + PLAN_READ_RETRY_AFTER_TIMEOUT_MS);
        }
      };
      const limit = readLimit(workspaceId, askAgainSoon);
      cache.set(workspaceId, { limit, expiresAtMs: nowMs + PLAN_CAP_CACHE_TTL_MS });
      return limit;
    },
  };
};
