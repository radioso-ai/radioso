import type { RadiosoMcpConfig } from "../config.js";
import { createInMemorySessionStore, type SessionStore } from "../auth/sessionStore.js";

import { createRedisClientHandle } from "./redisRuntimeStore.js";

export interface RuntimeStoreReadiness {
  isReady(): boolean;
  start(): void;
  stop(): void;
  waitUntilReady(): Promise<void>;
}

export type LegacySessionPurgeReadinessEvent =
  | { attempt: number; type: "attempt" }
  | { attempt: number; type: "failure" }
  | { attempt: number; retryDelayMs: number; type: "retry" }
  | { attempt: number; type: "success" };

/**
 * Receives the bounded operational lifecycle of the startup purge. Event
 * payloads deliberately exclude errors and store/session identifiers because
 * they can contain connection or credential material.
 */
export interface LegacySessionPurgeReadinessObserver {
  emit(event: LegacySessionPurgeReadinessEvent): void | Promise<void>;
}

export interface RuntimeStoreHandle {
  close(): Promise<void>;
  mode: "in-memory" | "redis";
  readiness: RuntimeStoreReadiness;
  sessionStore: SessionStore;
}

export interface RuntimeStoreHandleOptions {
  legacySessionPurgeReadinessObserver?: LegacySessionPurgeReadinessObserver;
}

export interface LegacySessionPurgeRuntime {
  close(): Promise<void>;
  readiness: RuntimeStoreReadiness;
}

export const createRuntimeStoreReadiness = (input: {
  purge: () => Promise<void>;
  retryDelayMs?: number;
  observer?: LegacySessionPurgeReadinessObserver;
}): RuntimeStoreReadiness => {
  const retryDelayMs = input.retryDelayMs ?? 1_000;
  let started = false;
  let ready = false;
  let stopped = false;
  let attemptCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A runtime may be closed before its owner awaits readiness. Keep that
  // normal lifecycle path from becoming an unhandled rejection while still
  // rejecting callers that explicitly await the promise.
  void readyPromise.catch(() => undefined);

  const emit = (event: LegacySessionPurgeReadinessEvent): void => {
    try {
      void Promise.resolve(input.observer?.emit(event)).catch(() => undefined);
    } catch {
      // Runtime readiness must not depend on an operational observer.
    }
  };

  const attempt = async (): Promise<void> => {
    if (stopped || ready) {
      return;
    }

    const attemptNumber = attemptCount + 1;
    attemptCount = attemptNumber;
    emit({ attempt: attemptNumber, type: "attempt" });

    try {
      await input.purge();
      ready = true;
      emit({ attempt: attemptNumber, type: "success" });
      resolveReady?.();
    } catch {
      emit({ attempt: attemptNumber, type: "failure" });
      if (!stopped) {
        emit({ attempt: attemptNumber, retryDelayMs, type: "retry" });
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void attempt();
        }, retryDelayMs);
      }
    }
  };

  return {
    isReady: () => ready,
    start() {
      if (started || stopped) {
        return;
      }
      started = true;
      void attempt();
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (!ready) {
        rejectReady?.(new Error("MCP runtime store readiness stopped."));
      }
    },
    waitUntilReady: () => readyPromise,
  };
};

export const createRuntimeStoreHandle = async (
  config: RadiosoMcpConfig,
  options: RuntimeStoreHandleOptions = {},
): Promise<RuntimeStoreHandle> => {
  if (config.redisUrl) {
    const redisHandle = await createRedisClientHandle({
      keyPrefix: config.redisKeyPrefix,
      redisUrl: config.redisUrl,
      signingSecret: config.signingSecret,
    });

    const readiness = createRuntimeStoreReadiness({
      purge: async () => {
        await redisHandle.sessionStore.purgeLegacyApiTokenSessions();
      },
      observer: options.legacySessionPurgeReadinessObserver,
    });

    return {
      async close() {
        readiness.stop();
        await redisHandle.close();
      },
      mode: "redis",
      readiness,
      sessionStore: redisHandle.sessionStore,
    };
  }

  const sessionStore = createInMemorySessionStore();
  const readiness = createRuntimeStoreReadiness({
    purge: async () => {
      await sessionStore.purgeLegacyApiTokenSessions();
    },
    observer: options.legacySessionPurgeReadinessObserver,
  });

  return {
    async close() {
      readiness.stop();
    },
    mode: "in-memory",
    readiness,
    sessionStore,
  };
};

/**
 * Runs only the destructive legacy-session purge for a shared Redis namespace.
 * The backend uses this during merged-mode upgrades even though it does not
 * expose the standalone MCP transport.
 */
export const createLegacySessionPurgeRuntime = async ({
  keyPrefix,
  redisUrl,
  retryDelayMs,
  signingSecret,
  observer,
}: {
  keyPrefix: string;
  redisUrl: string;
  retryDelayMs?: number;
  signingSecret?: string;
  observer?: LegacySessionPurgeReadinessObserver;
}): Promise<LegacySessionPurgeRuntime> => {
  const redisHandle = await createRedisClientHandle({ keyPrefix, redisUrl, signingSecret: signingSecret ?? "" });
  const readiness = createRuntimeStoreReadiness({
    purge: async () => {
      await redisHandle.sessionStore.purgeLegacyApiTokenSessions();
    },
    retryDelayMs,
    observer,
  });

  return {
    async close() {
      readiness.stop();
      await redisHandle.close();
    },
    readiness,
  };
};
