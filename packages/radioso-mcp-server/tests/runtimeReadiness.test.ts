import { describe, expect, it, vi } from "vitest";

import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { createRemoteHttpRuntime } from "../src/http/runtime.js";
import { createRuntimeStoreHandle, createRuntimeStoreReadiness } from "../src/state/runtimeStores.js";

describe("MCP runtime-store readiness", () => {
  it("emits bounded non-secret lifecycle signals while retrying the legacy-session purge", async () => {
    const events: unknown[] = [];
    const purge = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("redis://operator:password@redis.internal:6379/session-token"))
      .mockResolvedValueOnce();
    const readiness = createRuntimeStoreReadiness({
      purge,
      retryDelayMs: 1,
      observer: {
        emit(event) {
          events.push(event);
        },
      },
    });

    readiness.start();
    await readiness.waitUntilReady();

    expect(events).toEqual([
      { attempt: 1, type: "attempt" },
      { attempt: 1, type: "failure" },
      { attempt: 1, retryDelayMs: 1, type: "retry" },
      { attempt: 2, type: "attempt" },
      { attempt: 2, type: "success" },
    ]);
    expect(JSON.stringify(events)).not.toContain("redis.internal");
    expect(JSON.stringify(events)).not.toContain("password");
    expect(JSON.stringify(events)).not.toContain("session-token");
  });

  it("keeps purge readiness fail-closed when its observer fails", async () => {
    const readiness = createRuntimeStoreReadiness({
      purge: vi.fn<() => Promise<void>>().mockResolvedValueOnce(),
      observer: {
        async emit() {
          throw new Error("observer unavailable");
        },
      },
    });

    readiness.start();
    await expect(readiness.waitUntilReady()).resolves.toBeUndefined();
    expect(readiness.isReady()).toBe(true);
  });

  it("retries a failed purge and becomes ready only after it succeeds", async () => {
    const purge = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Redis unavailable"))
      .mockResolvedValueOnce();
    const readiness = createRuntimeStoreReadiness({ purge, retryDelayMs: 1 });

    expect(readiness.isReady()).toBe(false);
    readiness.start();
    await readiness.waitUntilReady();

    expect(purge).toHaveBeenCalledTimes(2);
    expect(readiness.isReady()).toBe(true);
  });

  it("stays not ready while the purge keeps failing", async () => {
    const readiness = createRuntimeStoreReadiness({
      purge: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("Redis unavailable")),
      retryDelayMs: 1,
    });

    readiness.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(readiness.isReady()).toBe(false);
    readiness.stop();
  });

  it("does not bind the standalone HTTP server before readiness", async () => {
    let releasePurge!: () => void;
    const readiness = createRuntimeStoreReadiness({
      purge: () => new Promise<void>((resolve) => {
        releasePurge = resolve;
      }),
    });
    const runtime = await createRemoteHttpRuntime({
      auditSinks: [],
      config: {
        accessTokenTtlSeconds: 900,
        allowedReadTools: ["describe_capabilities"],
        allowedWriteTools: [],
        approvalRequiredWriteTools: [],
        baseUrl: "http://radioso.test",
        bindHost: "127.0.0.1",
        bindPort: 0,
        redisKeyPrefix: "radioso-mcp",
        requestTimeoutMs: 1_000,
        serverName: "radioso-test",
        signingSecret: "dev-signing-secret",
      },
      runtimeStores: {
        close: vi.fn(async () => readiness.stop()),
        mode: "in-memory",
        readiness,
        sessionStore: createInMemorySessionStore(),
      },
    });

    const listening = runtime.listen();
    await Promise.resolve();
    expect(runtime.server.server.listening).toBe(false);

    releasePurge();
    await listening;
    expect(runtime.server.server.listening).toBe(true);
    await runtime.close();
  });

  it("forwards the optional lifecycle observer through in-memory store composition", async () => {
    const events: unknown[] = [];
    const runtimeStores = await createRuntimeStoreHandle({
      accessTokenTtlSeconds: 900,
      allowedReadTools: [],
      allowedWriteTools: [],
      approvalRequiredWriteTools: [],
      baseUrl: "http://radioso.test",
      bindHost: "127.0.0.1",
      bindPort: 8787,
      redisKeyPrefix: "radioso-mcp-readiness-test",
      requestTimeoutMs: 1_000,
      serverName: "radioso-test",
      signingSecret: "dev-signing-secret",
    }, {
      legacySessionPurgeReadinessObserver: {
        emit(event) {
          events.push(event);
        },
      },
    });

    try {
      runtimeStores.readiness.start();
      await runtimeStores.readiness.waitUntilReady();
      expect(events).toEqual([
        { attempt: 1, type: "attempt" },
        { attempt: 1, type: "success" },
      ]);
    } finally {
      await runtimeStores.close();
    }
  });

  it("constructs an unavailable Redis runtime as unready so purge retries can run", async () => {
    const runtimeStores = await createRuntimeStoreHandle({
      accessTokenTtlSeconds: 900,
      allowedReadTools: [],
      allowedWriteTools: [],
      approvalRequiredWriteTools: [],
      baseUrl: "http://radioso.test",
      bindHost: "127.0.0.1",
      bindPort: 8787,
      redisKeyPrefix: "radioso-mcp-readiness-test",
      redisUrl: "redis://127.0.0.1:1",
      requestTimeoutMs: 1_000,
      serverName: "radioso-test",
      signingSecret: "dev-signing-secret",
    });

    try {
      expect(runtimeStores.mode).toBe("redis");
      runtimeStores.readiness.start();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(runtimeStores.readiness.isReady()).toBe(false);
    } finally {
      await runtimeStores.close();
    }
  });
});
