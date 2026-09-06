import { readFile } from "node:fs/promises";

import { Router } from "express";
import { describe, expect, it, vi } from "vitest";

import { parseRealtimeConfig, type RealtimeConfig } from "../../../src/modules/realtime/infrastructure/config.js";
import type {
  WorkspaceGatewayAttachment,
  WorkspaceGatewayConnection,
} from "../../../src/modules/realtime/application/workspaceGateway.js";
import type {
  AdmissionLeaseRisk,
  RealtimeAdmissionController,
} from "../../../src/modules/realtime/domain/contracts.js";
import {
  startRealtimeRuntime,
  type RealtimeRuntimeDependencies,
} from "../../../src/runtime/startRealtimeRuntime.js";
import { parseRealtimeRuntimeEnv } from "../../../src/runtime/realtimeRuntimeEnv.js";
import { createRealtimeServer } from "../../../src/runtime/realtimeServer.js";

type HealthState = "starting" | "ready" | "degraded" | "draining" | "stopped";
type Health = "ready" | "degraded";
type AdmissionHealthListener = Parameters<RealtimeAdmissionController["onHealth"]>[0];
type AdmissionHealthEvent = Parameters<AdmissionHealthListener>[0];
type AdmissionHealthState = AdmissionHealthEvent["state"];
type ProcessSignal = "SIGINT" | "SIGTERM";
type ProcessSignals = {
  once(name: ProcessSignal, listener: () => void): void;
  emit(name: ProcessSignal): void;
};
type ProcessRuntime = Pick<Runtime, "shutdown">;
type RunRealtimeProcess = (input: {
  process: ProcessSignals;
  start(signal: AbortSignal): Promise<ProcessRuntime>;
}) => Promise<ProcessRuntime>;
type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const processSignals = (): ProcessSignals & { once: ReturnType<typeof vi.fn> } => {
  const listeners = new Map<ProcessSignal, () => void>();
  const once = vi.fn((name: ProcessSignal, listener: () => void) => {
    listeners.set(name, listener);
  });
  return {
    once,
    emit: (name) => listeners.get(name)?.(),
  };
};

/** A deterministic monotonic clock also exposes timer pressure for the runtime gate. */
class TestClock {
  private currentMs = 0;
  private readonly timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
  maxOutstanding = 0;

  now = (): number => this.currentMs;

  setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const token = {} as ReturnType<typeof setTimeout>;
    this.timers.set(token, { at: this.currentMs + Math.max(0, delayMs), callback });
    this.maxOutstanding = Math.max(this.maxOutstanding, this.timers.size);
    return token;
  };

  clearTimeout = (token: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(token);
  };

  advanceBy = (durationMs: number): void => {
    const target = this.currentMs + durationMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.currentMs = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.currentMs = target;
  };

  outstanding = (): number => this.timers.size;
}

interface DatabaseHealthPort {
  health(signal?: AbortSignal): Promise<true>;
  close(): Promise<void>;
}

interface CommandClientHealthPort {
  health(): Promise<Health>;
  onHealth(listener: (health: Health) => void): () => void;
  emitHealth(health: Health): void;
}

type AuthDatabase = DatabaseHealthPort;

interface Subscriber {
  start(signal?: AbortSignal): Promise<void>;
  onContinuity(listener: (event: { generation: number; state: "lost" | "restored" }) => void): () => void;
  subscribe(workspaceId: string, listener: (kinds: readonly string[]) => void): Promise<{ generation: number }>;
  unsubscribe(workspaceId: string, listener: (kinds: readonly string[]) => void): Promise<void>;
  close(): Promise<void>;
}

interface AdmissionCommandClient extends CommandClientHealthPort {
  start(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

type AdmissionController = Pick<RealtimeAdmissionController, "admit" | "checkReconnect" | "onHealth"> & {
  close(): Promise<void>;
};

interface Gateway {
  attach(connection: WorkspaceGatewayConnection, options?: { signal?: AbortSignal }): Promise<WorkspaceGatewayAttachment>;
  onHealth(listener: (health: { state: "degraded" | "restored" }) => void): () => void;
  shutdown(): Promise<void>;
}

interface ServerPort {
  listen(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  forceDestroy(): void;
}

interface PresenterRegistry {
  abortPreflight(): void;
  closeAll(): Promise<void>;
  forceDestroy(): void;
}

interface FixedCardTelemetry {
  healthTransition(state: HealthState): void;
  readinessGaugeDelta(delta: 1 | -1): void;
  shutdown(outcome: "complete" | "forced" | "failed", durationMs: number): void;
  error(outcome: "startup" | "shutdown"): void;
  tracing(outcome: "stop"): void;
}

const baseRawConfig = (): Record<string, unknown> => ({
  REALTIME_MODE: "standalone",
  REALTIME_REDIS_URL: "redis://127.0.0.1:6379",
  REALTIME_ROLLOUT_MODE: "default-on",
  REALTIME_MAX_CONNECTIONS: "900",
  REALTIME_PLATFORM_CONCURRENCY: "1000",
});

const makeConfig = (overrides: Partial<RealtimeConfig["gateway"]> = {}): RealtimeConfig => {
  const config = parseRealtimeConfig(baseRawConfig());
  return {
    ...config,
    gateway: { ...config.gateway, ...overrides },
  };
};

const commandClientHealthSource = (initial: Health = "ready") => {
  let state = initial;
  const listeners = new Set<(health: Health) => void>();
  return {
    health: vi.fn(async () => state),
    onHealth: vi.fn((listener: (health: Health) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emitHealth: (health: Health) => {
      state = health;
      for (const listener of listeners) listener(health);
    },
    listenerCount: (): number => listeners.size,
  };
};

const makeFixture = (config = makeConfig()) => {
  const clock = new TestClock();
  const authDatabase = {
    health: vi.fn(async (_signal?: AbortSignal): Promise<true> => true),
    close: vi.fn(async (): Promise<void> => undefined),
  } satisfies AuthDatabase;
  const subscriberListeners = new Set<(event: { generation: number; state: "lost" | "restored" }) => void>();
  const subscriber = {
    start: vi.fn(async (_signal?: AbortSignal): Promise<void> => undefined),
    onContinuity: vi.fn((listener: (event: { generation: number; state: "lost" | "restored" }) => void) => {
      subscriberListeners.add(listener);
      return () => subscriberListeners.delete(listener);
    }),
    subscribe: vi.fn(async (_workspaceId: string, _listener: (kinds: readonly string[]) => void) => ({ generation: 1 })),
    unsubscribe: vi.fn(async (_workspaceId: string, _listener: (kinds: readonly string[]) => void): Promise<void> => undefined),
    close: vi.fn(async (): Promise<void> => undefined),
  } satisfies Subscriber;
  const admissionClient = {
    ...commandClientHealthSource(),
    start: vi.fn(async (_signal?: AbortSignal): Promise<void> => undefined),
    close: vi.fn(async (): Promise<void> => undefined),
  } satisfies AdmissionCommandClient;
  const controllerListeners = new Set<AdmissionHealthListener>();
  const controllerHealth = {
    onHealth: vi.fn((listener: AdmissionHealthListener) => {
      controllerListeners.add(listener);
      return () => controllerListeners.delete(listener);
    }),
    emitHealth: (state: AdmissionHealthState) => {
      const event: AdmissionHealthEvent = { state };
      for (const listener of controllerListeners) listener(event);
    },
    listenerCount: (): number => controllerListeners.size,
  };
  const admissionController = {
    admit: vi.fn(async (_input: { accountId: string; workspaceId: string; principalId: string }) => ({
      risk: new Promise<AdmissionLeaseRisk>(() => undefined),
      release: async (): Promise<void> => undefined,
    })),
    checkReconnect: vi.fn(async (_input: { accountId: string; workspaceId: string; principalId: string }): Promise<void> => undefined),
    onHealth: controllerHealth.onHealth,
    close: vi.fn(async (): Promise<void> => undefined),
  } satisfies AdmissionController;
  const gatewayListeners = new Set<(health: { state: "degraded" | "restored" }) => void>();
  const gatewayHealth = {
    onHealth: vi.fn((listener: (health: { state: "degraded" | "restored" }) => void) => {
      gatewayListeners.add(listener);
      return () => gatewayListeners.delete(listener);
    }),
    emitHealth: (state: "degraded" | "restored") => {
      for (const listener of gatewayListeners) listener({ state });
    },
    listenerCount: (): number => gatewayListeners.size,
  };
  const gateway = {
    attach: vi.fn(async (_connection: WorkspaceGatewayConnection, _options?: { signal?: AbortSignal }) => ({
      generation: 1,
      release: async (): Promise<void> => undefined,
    })),
    onHealth: gatewayHealth.onHealth,
    shutdown: vi.fn(async (): Promise<void> => undefined),
  } satisfies Gateway;
  const server = {
    listen: vi.fn(async (_signal?: AbortSignal): Promise<void> => undefined),
    close: vi.fn(async (): Promise<void> => undefined),
    forceDestroy: vi.fn(),
  } satisfies ServerPort;
  const presenters = {
    abortPreflight: vi.fn(),
    closeAll: vi.fn(async (): Promise<void> => undefined),
    forceDestroy: vi.fn(),
  } satisfies PresenterRegistry;
  const telemetry = {
    healthTransition: vi.fn(),
    readinessGaugeDelta: vi.fn(),
    shutdown: vi.fn(),
    error: vi.fn(),
    tracing: vi.fn(),
  } satisfies FixedCardTelemetry;

  const dependencies = {
    authDatabaseFactory: vi.fn((_connectionString: string, _options: Record<string, unknown>) => authDatabase),
    subscriberFactory: vi.fn((_input: Record<string, unknown>) => subscriber),
    admissionClientFactory: vi.fn((_input: Record<string, unknown>) => admissionClient),
    admissionControllerFactory: vi.fn((_input: { localProcessCap: number }) => admissionController),
    gatewayFactory: vi.fn((_input: { maxConnections: number; transportLossGraceMs: number }) => gateway),
    presenters,
    server,
    telemetry,
  } satisfies RealtimeRuntimeDependencies;

  return {
    config,
    clock,
    authDatabase,
    subscriber,
    admissionClient,
    admissionController,
    controllerHealth,
    gatewayHealth,
    emitSubscriberContinuity: (event: { generation: number; state: "lost" | "restored" }) => {
      for (const listener of subscriberListeners) listener(event);
    },
    listenerCounts: {
      admissionClient: (): number => admissionClient.listenerCount(),
      admissionController: (): number => controllerHealth.listenerCount(),
      gateway: (): number => gatewayHealth.listenerCount(),
      subscriber: (): number => subscriberListeners.size,
    },
    gateway,
    server,
    presenters,
    telemetry,
    dependencies,
  };
};

type Runtime = {
  health(): { liveness: number; readiness: number };
  shutdown(reason?: string): Promise<void>;
};

const start = (fixture: ReturnType<typeof makeFixture>, signal?: AbortSignal, rawConfig?: Record<string, unknown>): Promise<Runtime> =>
  startRealtimeRuntime({
    config: fixture.config,
    rawConfig,
    dependencies: fixture.dependencies,
    clock: fixture.clock,
    dbHealthCacheMs: 1_000,
    signal,
  });

describe("realtime runtime RED contract", () => {
  it("keeps runtime import graph narrow and provider-neutral", async () => {
    const paths = [
      "src/runtime/startRealtimeRuntime.ts",
      "src/runtime/realtimeServer.ts",
      "src/realtimeServer.ts",
      "src/app/composition/realtimeComposition.ts",
    ];
    const source = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
    expect(source).not.toMatch(/buildDependencies|createApp|defaultComposition|applicationModule|runMigrations|pendingMigrations|crawler|retrieval|assistant|document|worker|mcp|publisher/i);
    expect(source).not.toMatch(/from ["'][^"']*(?:app\/server|app\/composition|app\/http\/routes|migrations)[^"']*["']/i);
  });

  it("keeps the existing backend package role and image entrypoint", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: { start?: string; "start:http"?: string };
    };
    const image = await readFile("../infra/backend.Dockerfile", "utf8");
    expect(packageJson.scripts?.start).toBe("pnpm run start:http");
    expect(packageJson.scripts?.["start:http"]).toBe("node ./dist/src/httpServer.js");
    expect(image).toContain('CMD ["node", "./dist/src/httpServer.js"]');
  });

  it("exposes an executable realtime dev/start entry while preserving HTTP as the default", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: {
        start?: string;
        "start:http"?: string;
        "dev:realtime"?: string;
        "start:realtime"?: string;
      };
    };
    const realtimeSource = await readFile("src/realtime.ts", "utf8");
    const devEntrypoint = await readFile("../infra/backend.dev.entrypoint.sh", "utf8");
    expect(packageJson.scripts?.["dev:realtime"]).toBe("tsx watch ./src/realtime.ts");
    expect(packageJson.scripts?.["start:realtime"]).toBe("node ./dist/src/realtime.js");
    expect(realtimeSource).toMatch(/startRealtimeRuntime/);
    expect(devEntrypoint).toContain('TARGET_SCRIPT="' + "$" + '{1:-dev:http}"');
    expect(devEntrypoint).toContain('exec pnpm --dir backend run "$TARGET_SCRIPT"');
    expect(packageJson.scripts?.start).toBe("pnpm run start:http");
    expect(packageJson.scripts?.["start:http"]).toBe("node ./dist/src/httpServer.js");
    expect(realtimeSource).toMatch(/\brunRealtimeProcess\s*\(/);
    expect(realtimeSource).toMatch(/parseRealtimeRuntimeEnv/);
    expect(realtimeSource).not.toMatch(/\bgetEnv\b/);
  });

  it("uses an injectable process bootstrap that registers both signal fences before startup", async () => {
    const { runRealtimeProcess } = await import("../../../src/runtime/runRealtimeProcess.js") as {
      runRealtimeProcess: RunRealtimeProcess;
    };
    const signals = processSignals();
    const runtime: ProcessRuntime = { shutdown: vi.fn(async (): Promise<void> => undefined) };
    const startRuntime = vi.fn(async (_signal: AbortSignal): Promise<ProcessRuntime> => {
      expect(signals.once).toHaveBeenCalledWith("SIGINT", expect.any(Function));
      expect(signals.once).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
      return runtime;
    });

    const running = await runRealtimeProcess({ process: signals, start: startRuntime });
    expect(running).toBe(runtime);
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await vi.waitFor(() => expect(runtime.shutdown).toHaveBeenCalledTimes(1));
  });

  it.each([
    ...(["database", "subscriber", "admission", "listen"] as const).map((stage) => ({ stage, signal: "SIGTERM" as const })),
    ...(["database", "subscriber", "admission", "listen"] as const).map((stage) => ({ stage, signal: "SIGINT" as const })),
  ])(
    "passes one abort controller through injectable process startup and fences late $signal during $stage completion",
    async ({ stage, signal }) => {
      const { runRealtimeProcess } = await import("../../../src/runtime/runRealtimeProcess.js") as {
        runRealtimeProcess: RunRealtimeProcess;
      };
      const fixture = makeFixture();
      const pendingDatabase = deferred<true>();
      const pendingLifecycle = deferred<void>();
      if (stage === "database") fixture.authDatabase.health.mockReturnValueOnce(pendingDatabase.promise);
      if (stage === "subscriber") fixture.subscriber.start.mockReturnValueOnce(pendingLifecycle.promise);
      if (stage === "admission") fixture.admissionClient.start.mockReturnValueOnce(pendingLifecycle.promise);
      if (stage === "listen") fixture.server.listen.mockReturnValueOnce(pendingLifecycle.promise);

      const signals = processSignals();
      let startupSignal: AbortSignal | undefined;
      const starting = runRealtimeProcess({
        process: signals,
        start: (signal) => {
          startupSignal = signal;
          return start(fixture, signal);
        },
      });
      const stageCall = stage === "database"
        ? fixture.authDatabase.health
        : stage === "subscriber"
          ? fixture.subscriber.start
          : stage === "admission"
            ? fixture.admissionClient.start
            : fixture.server.listen;
      await vi.waitFor(() => expect(stageCall).toHaveBeenCalled());
      expect(startupSignal).toBeInstanceOf(AbortSignal);
      signals.emit(signal);
      expect(startupSignal?.aborted).toBe(true);
      await expect(starting).rejects.toMatchObject({ name: "AbortError" });

      if (stage === "database") pendingDatabase.resolve(true);
      else pendingLifecycle.resolve();
      await Promise.resolve();
      expect(fixture.server.listen).toHaveBeenCalledTimes(stage === "listen" ? 1 : 0);
      expect(Object.values(fixture.listenerCounts).map((count) => count())).toEqual([0, 0, 0, 0]);
      expect(fixture.server.close).toHaveBeenCalledOnce();
      expect(fixture.telemetry.tracing).toHaveBeenCalledOnce();
    },
  );

  it("passes the startup abort signal through DB, subscriber, admission, and server listen", async () => {
    const fixture = makeFixture();
    const startupSignal = new AbortController();
    const runtime = await start(fixture, startupSignal.signal);

    expect(fixture.authDatabase.health).toHaveBeenCalledWith(startupSignal.signal);
    expect(fixture.subscriber.start).toHaveBeenCalledWith(startupSignal.signal);
    expect(fixture.admissionClient.start).toHaveBeenCalledWith(startupSignal.signal);
    expect(fixture.server.listen).toHaveBeenCalledWith(startupSignal.signal);
    await runtime.shutdown();
  });

  it.each(["database", "subscriber", "admission", "listen"] as const)(
    "fences SIGTERM during pending %s startup without a late listen",
    async (stage) => {
      const fixture = makeFixture();
      const pendingDatabase = deferred<true>();
      const pendingLifecycle = deferred<void>();
      if (stage === "database") fixture.authDatabase.health.mockReturnValueOnce(pendingDatabase.promise);
      if (stage === "subscriber") fixture.subscriber.start.mockReturnValueOnce(pendingLifecycle.promise);
      if (stage === "admission") fixture.admissionClient.start.mockReturnValueOnce(pendingLifecycle.promise);
      if (stage === "listen") fixture.server.listen.mockReturnValueOnce(pendingLifecycle.promise);

      const startupSignal = new AbortController();
      const starting = start(fixture, startupSignal.signal);
      const stageCall = stage === "database"
        ? fixture.authDatabase.health
        : stage === "subscriber"
          ? fixture.subscriber.start
          : stage === "admission"
            ? fixture.admissionClient.start
            : fixture.server.listen;
      await vi.waitFor(() => expect(stageCall).toHaveBeenCalled());
      startupSignal.abort();
      await expect(starting).rejects.toMatchObject({ name: "AbortError" });

      if (stage === "database") pendingDatabase.resolve(true);
      else pendingLifecycle.resolve();
      expect(fixture.server.listen).toHaveBeenCalledTimes(stage === "listen" ? 1 : 0);
    },
  );

  it("parses only the dedicated role environment and requires no API secrets while disabled", () => {
    expect(parseRealtimeRuntimeEnv({ REALTIME_MODE: "disabled" })).toEqual({
      config: expect.objectContaining({ mode: "disabled" }),
      enabled: false,
    });
    expect(() => parseRealtimeRuntimeEnv({
      DATABASE_URL: "postgres://localhost/radioso",
      REALTIME_MODE: "standalone",
      REALTIME_REDIS_URL: "redis://localhost:6379",
    })).not.toThrow();
  });

  it("does not construct, connect, subscribe, or listen when disabled", async () => {
    const fixture = makeFixture(parseRealtimeConfig({ REALTIME_MODE: "disabled" }));
    const runtime = await start(fixture);
    expect(fixture.dependencies.authDatabaseFactory).not.toHaveBeenCalled();
    expect(fixture.dependencies.subscriberFactory).not.toHaveBeenCalled();
    expect(fixture.dependencies.admissionClientFactory).not.toHaveBeenCalled();
    expect(fixture.dependencies.gatewayFactory).not.toHaveBeenCalled();
    expect(fixture.subscriber.subscribe).not.toHaveBeenCalled();
    expect(fixture.server.listen).not.toHaveBeenCalled();
    expect(runtime.health()).toEqual({ liveness: 200, readiness: 200 });
    await runtime.shutdown();
  });

  it("rejects invalid raw config before a resource factory or server listen", async () => {
    const fixture = makeFixture();
    await expect(start(fixture, undefined, { REALTIME_MODE: "standalone" })).rejects.toThrow();
    expect(fixture.dependencies.authDatabaseFactory).not.toHaveBeenCalled();
    expect(fixture.dependencies.subscriberFactory).not.toHaveBeenCalled();
    expect(fixture.dependencies.admissionClientFactory).not.toHaveBeenCalled();
    expect(fixture.server.listen).not.toHaveBeenCalled();
  });

  it("passes the tiny realtime database options and application name without a broad app graph", async () => {
    const fixture = makeFixture();
    const runtime = await start(fixture);
    expect(fixture.dependencies.authDatabaseFactory).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        poolMax: 1,
        connectionTimeoutMs: 2_000,
        statementTimeoutMs: 2_000,
        applicationName: "radioso-realtime",
      }),
    );
    await runtime.shutdown();
  });

  it("single-flights fresh DB health and bounds stale refreshes to one query", async () => {
    const fixture = makeFixture();
    const health = deferred<true>();
    fixture.authDatabase.health.mockReturnValueOnce(health.promise);
    const starting = start(fixture);
    await vi.waitFor(() => expect(fixture.authDatabase.health).toHaveBeenCalledOnce());
    health.resolve(true);
    const runtime = await starting;

    expect(runtime.health().readiness).toBe(200);
    const freshCalls = fixture.authDatabase.health.mock.calls.length;
    expect(runtime.health().readiness).toBe(200);
    expect(runtime.health().readiness).toBe(200);
    expect(fixture.authDatabase.health).toHaveBeenCalledTimes(freshCalls);

    fixture.clock.advanceBy(1_001);
    const stale = deferred<true>();
    fixture.authDatabase.health.mockReturnValueOnce(stale.promise);
    const first = runtime.health();
    const second = runtime.health();
    expect(first.readiness).toBe(200);
    expect(second.readiness).toBe(200);
    expect(fixture.authDatabase.health).toHaveBeenCalledTimes(freshCalls + 1);
    stale.reject(new Error("db probe failed"));
    await vi.waitFor(() => expect(runtime.health().readiness).toBe(503));

    fixture.authDatabase.health.mockResolvedValueOnce(true);
    fixture.clock.advanceBy(1_001);
    await vi.waitFor(() => expect(runtime.health().readiness).toBe(200));
    await runtime.shutdown();
    expect(fixture.clock.outstanding()).toBe(0);
  });

  it("finishes startup in degraded phase when a dependency reports loss during pending start", async () => {
    const fixture = makeFixture();
    const pendingStart = deferred<void>();
    fixture.admissionClient.start.mockReturnValueOnce(pendingStart.promise);
    const starting = start(fixture);
    await vi.waitFor(() => expect(fixture.admissionClient.start).toHaveBeenCalledOnce());
    fixture.admissionClient.emitHealth("degraded");
    pendingStart.resolve();
    const runtime = await starting;

    expect(runtime.health()).toEqual({ liveness: 200, readiness: 503 });
    expect(fixture.telemetry.healthTransition.mock.calls.map(([state]) => state)).toContain("degraded");
    fixture.admissionClient.emitHealth("ready");
    expect(runtime.health()).toEqual({ liveness: 200, readiness: 200 });
    await runtime.shutdown();
  });

  it("installs subscriber and admission health listeners before dependency start and reconciles a loss during startup", async () => {
    const fixture = makeFixture();
    const pendingSubscriber = deferred<void>();
    const pendingAdmission = deferred<void>();
    fixture.subscriber.start.mockReturnValueOnce(pendingSubscriber.promise);
    fixture.admissionClient.start.mockReturnValueOnce(pendingAdmission.promise);
    const starting = start(fixture);

    await vi.waitFor(() => expect(fixture.subscriber.start).toHaveBeenCalledOnce());
    expect(fixture.listenerCounts.subscriber()).toBe(1);
    expect(fixture.listenerCounts.admissionClient()).toBe(1);
    expect(fixture.listenerCounts.admissionController()).toBe(1);
    expect(fixture.listenerCounts.gateway()).toBe(1);
    fixture.emitSubscriberContinuity({ generation: 20, state: "lost" });
    pendingSubscriber.resolve();
    await vi.waitFor(() => expect(fixture.admissionClient.start).toHaveBeenCalledOnce());
    pendingAdmission.resolve();
    const runtime = await starting;

    expect(runtime.health()).toEqual({ liveness: 200, readiness: 503 });
    fixture.emitSubscriberContinuity({ generation: 20, state: "restored" });
    fixture.admissionClient.emitHealth("ready");
    fixture.controllerHealth.emitHealth("restored");
    expect(runtime.health()).toEqual({ liveness: 200, readiness: 200 });
    await runtime.shutdown();
  });

  it("gates readiness on an independent gateway health loss and restores only on the matching event", async () => {
    const fixture = makeFixture();
    const runtime = await start(fixture);

    expect(fixture.gatewayHealth.onHealth).toHaveBeenCalledOnce();
    expect(fixture.listenerCounts.gateway()).toBe(1);
    expect(runtime.health()).toEqual({ liveness: 200, readiness: 200 });

    fixture.gatewayHealth.emitHealth("degraded");
    expect(runtime.health()).toEqual({ liveness: 200, readiness: 503 });
    expect(fixture.authDatabase.health).toHaveBeenCalledOnce();
    expect(fixture.subscriber.start).toHaveBeenCalledOnce();
    expect(fixture.admissionClient.start).toHaveBeenCalledOnce();

    fixture.gatewayHealth.emitHealth("restored");
    expect(runtime.health()).toEqual({ liveness: 200, readiness: 200 });
    await runtime.shutdown();
    expect(fixture.listenerCounts.gateway()).toBe(0);
  });

  it("starts the subscriber and admission command client, while the controller owns admit/reconnect/health/close", async () => {
    const fixture = makeFixture();
    const runtime = await start(fixture);
    expect(fixture.subscriber.start).toHaveBeenCalledOnce();
    expect(fixture.admissionClient.start).toHaveBeenCalledOnce();
    expect(fixture.admissionController.admit).toBeTypeOf("function");
    expect(fixture.admissionController.checkReconnect).toBeTypeOf("function");
    expect(fixture.admissionController.onHealth).toBeTypeOf("function");
    expect(fixture.admissionController.close).toBeTypeOf("function");
    expect(fixture.subscriber.subscribe).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it("keeps zero-interest startup ready without asking the subscriber to subscribe", async () => {
    const fixture = makeFixture();
    const runtime = await start(fixture);
    expect(fixture.subscriber.subscribe).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it("rolls back every constructed resource once, in reverse order, for each startup failure", async () => {
    const failures = ["authDatabase", "subscriber", "admissionClient", "admissionController", "gateway"] as const;
    for (const failure of failures) {
      const fixture = makeFixture();
      if (failure === "authDatabase") fixture.authDatabase.health.mockRejectedValueOnce(new Error("db unavailable"));
      if (failure === "subscriber") fixture.subscriber.start.mockRejectedValueOnce(new Error("subscriber unavailable"));
      if (failure === "admissionClient") fixture.admissionClient.start.mockRejectedValueOnce(new Error("admission unavailable"));
      if (failure === "admissionController") {
        fixture.dependencies.admissionControllerFactory.mockImplementationOnce(() => {
          throw new Error("controller unavailable");
        });
      }
      if (failure === "gateway") {
        fixture.dependencies.gatewayFactory.mockImplementationOnce(() => {
          throw new Error("gateway unavailable");
        });
      }
      await expect(start(fixture)).rejects.toThrow();
      expect(fixture.authDatabase.close).toHaveBeenCalledTimes(1);
      expect(fixture.subscriber.close).toHaveBeenCalledTimes(1);
      expect(fixture.admissionClient.close).toHaveBeenCalledTimes(1);
      expect(fixture.admissionController.close).toHaveBeenCalledTimes(failure === "admissionController" ? 0 : 1);
      expect(fixture.gateway.shutdown).toHaveBeenCalledTimes(failure === "gateway" ? 0 : 1);
      const cleanupOrder = [
        fixture.gateway.shutdown.mock.invocationCallOrder[0],
        fixture.admissionController.close.mock.invocationCallOrder[0],
        fixture.admissionClient.close.mock.invocationCallOrder[0],
        fixture.subscriber.close.mock.invocationCallOrder[0],
        fixture.authDatabase.close.mock.invocationCallOrder[0],
      ].filter((value): value is number => value !== undefined);
      expect(cleanupOrder).toEqual([...cleanupOrder].sort((left, right) => left - right));
    }
  });

  it("aborts pending startup and closes a database that was constructed before the abort", async () => {
    const fixture = makeFixture();
    const startup = deferred<void>();
    fixture.admissionClient.start.mockReturnValueOnce(startup.promise);
    const request = new AbortController();
    const starting = start(fixture, request.signal);
    await vi.waitFor(() => expect(fixture.admissionClient.start).toHaveBeenCalledOnce());
    request.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.authDatabase.close).toHaveBeenCalledOnce();
    expect(fixture.subscriber.close).toHaveBeenCalledOnce();
    expect(fixture.admissionClient.close).toHaveBeenCalledOnce();
    expect(fixture.server.listen).not.toHaveBeenCalled();
    startup.resolve();
  });

  it("closes the server when startup is aborted while listen is pending", async () => {
    const fixture = makeFixture();
    const listening = deferred<void>();
    fixture.server.listen.mockReturnValueOnce(listening.promise);
    const request = new AbortController();
    const starting = start(fixture, request.signal);
    await vi.waitFor(() => expect(fixture.server.listen).toHaveBeenCalledOnce());
    request.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.server.close).toHaveBeenCalledOnce();
    expect(fixture.telemetry.healthTransition).not.toHaveBeenCalledWith("ready");
    listening.resolve();
  });

  it("does not leak a late listener when server close races initial listen", async () => {
    const server = createRealtimeServer({
      eventsPath: "/events",
      eventsRouter: Router(),
      health: () => ({ liveness: 200, readiness: 200 }),
      port: 0,
    });
    let remainedListening = false;
    try {
      await Promise.all([server.listen(), server.close()]);
      remainedListening = server.server.listening;
    } finally {
      server.forceDestroy();
      if (server.server.listening) {
        await new Promise<void>((resolve) => server.server.close(() => resolve()));
      }
    }
    expect(remainedListening).toBe(false);
  });

  it("reports liveness through outages but gates readiness/intake until every dependency restores", async () => {
    const fixture = makeFixture();
    const runtime = await start(fixture);
    expect(runtime.health()).toEqual({ liveness: 200, readiness: 200 });
    fixture.emitSubscriberContinuity({ generation: 1, state: "lost" });
    fixture.admissionClient.emitHealth("degraded");
    fixture.controllerHealth.emitHealth("degraded");
    expect(runtime.health()).toEqual({ liveness: 200, readiness: 503 });
    fixture.emitSubscriberContinuity({ generation: 1, state: "restored" });
    fixture.admissionClient.emitHealth("ready");
    fixture.controllerHealth.emitHealth("restored");
    expect(runtime.health()).toEqual({ liveness: 200, readiness: 200 });
    expect(fixture.telemetry.healthTransition.mock.calls.map(([state]) => state)).toEqual([
      "starting", "ready", "degraded", "ready",
    ]);
    expect(fixture.telemetry.readinessGaugeDelta.mock.calls.map(([delta]) => delta)).toEqual([1, -1, 1]);
    await runtime.shutdown();
  });

  it("wires the same local cap to admission and gateway and leaves Node server caps alone", async () => {
    const fixture = makeFixture();
    const runtime = await start(fixture);
    expect(fixture.dependencies.admissionControllerFactory).toHaveBeenCalledWith(expect.objectContaining({ localProcessCap: 900 }));
    expect(fixture.dependencies.gatewayFactory).toHaveBeenCalledWith(expect.objectContaining({ maxConnections: 900, transportLossGraceMs: 20_000 }));
    expect(fixture.config.gateway.platformConcurrency).toBe(1_000);
    const serverSource = await readFile("src/runtime/realtimeServer.ts", "utf8");
    expect(serverSource).not.toMatch(/maxConnections\s*:\s*900/);
    await runtime.shutdown();
  });

  it("shuts down intake before draining, then gateway/unsubscribe before clients and DB", async () => {
    const fixture = makeFixture();
    const release = deferred<void>();
    fixture.presenters.closeAll.mockReturnValueOnce(release.promise);
    const runtime = await start(fixture);
    const shutdown = runtime.shutdown("SIGTERM");
    expect(fixture.server.close).toHaveBeenCalledOnce();
    expect(fixture.presenters.abortPreflight).toHaveBeenCalledOnce();
    expect(fixture.gateway.shutdown).toHaveBeenCalledOnce();
    expect(fixture.subscriber.close).not.toHaveBeenCalled();
    expect(fixture.admissionController.close).not.toHaveBeenCalled();
    expect(fixture.authDatabase.close).not.toHaveBeenCalled();
    release.resolve();
    await shutdown;
    expect(fixture.subscriber.close).toHaveBeenCalledOnce();
    expect(fixture.admissionClient.close).toHaveBeenCalledOnce();
    expect(fixture.admissionController.close).toHaveBeenCalledOnce();
    expect(fixture.authDatabase.close).toHaveBeenCalledOnce();
    expect(fixture.server.close.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.presenters.closeAll.mock.invocationCallOrder[0]);
    expect(fixture.gateway.shutdown.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.subscriber.close.mock.invocationCallOrder[0]);
    expect(fixture.presenters.closeAll.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.admissionController.close.mock.invocationCallOrder[0]);
    expect(fixture.admissionController.close.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.admissionClient.close.mock.invocationCallOrder[0]);
    expect(fixture.admissionController.close.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.authDatabase.close.mock.invocationCallOrder[0]);
    expect(Object.values(fixture.listenerCounts).map((count) => count())).toEqual([0, 0, 0, 0]);
    expect(fixture.telemetry.error).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
    expect(fixture.telemetry.tracing).toHaveBeenCalledOnce();
    expect(fixture.telemetry.shutdown.mock.invocationCallOrder[0])
      .toBeGreaterThan(fixture.authDatabase.close.mock.invocationCallOrder[0]);
    expect(fixture.telemetry.tracing.mock.invocationCallOrder[0])
      .toBeGreaterThan(fixture.authDatabase.close.mock.invocationCallOrder[0]);
    expect(fixture.telemetry.shutdown.mock.invocationCallOrder[0])
      .toBeGreaterThan(fixture.telemetry.tracing.mock.invocationCallOrder[0]);
    expect(fixture.telemetry.healthTransition.mock.calls.map(([state]) => state)).toEqual([
      "starting", "ready", "draining", "stopped",
    ]);
    expect(fixture.telemetry.readinessGaugeDelta.mock.calls.map(([delta]) => delta)).toEqual([1, -1]);
  });

  it("force-destroys presenters and server at one shared 8 second budget without a timer per stage", async () => {
    const fixture = makeFixture();
    fixture.presenters.closeAll.mockReturnValueOnce(new Promise<void>(() => undefined));
    const runtime = await start(fixture);
    const shutdown = runtime.shutdown("SIGTERM");
    fixture.clock.advanceBy(7_999);
    expect(fixture.presenters.forceDestroy).not.toHaveBeenCalled();
    fixture.clock.advanceBy(1);
    expect(fixture.presenters.forceDestroy).toHaveBeenCalledOnce();
    expect(fixture.server.forceDestroy).toHaveBeenCalledOnce();
    await shutdown;
    expect(fixture.clock.maxOutstanding).toBeLessThanOrEqual(1);
    expect(fixture.clock.outstanding()).toBe(0);
    expect(fixture.telemetry.shutdown).toHaveBeenCalledWith("forced", 8_000);
    expect(fixture.telemetry.shutdown).toHaveBeenCalledTimes(1);
    await runtime.shutdown("SIGTERM");
    expect(fixture.admissionClient.close).toHaveBeenCalledOnce();
    expect(fixture.authDatabase.close).toHaveBeenCalledOnce();
  });

  it("keeps shutdown pending after forced intake close until Redis and DB resources settle", async () => {
    const fixture = makeFixture();
    fixture.presenters.closeAll.mockReturnValueOnce(new Promise<void>(() => undefined));
    const admissionClose = deferred<void>();
    const clientClose = deferred<void>();
    const subscriberClose = deferred<void>();
    const databaseClose = deferred<void>();
    const tracingStop = deferred<void>();
    fixture.admissionController.close.mockReturnValueOnce(admissionClose.promise);
    fixture.admissionClient.close.mockReturnValueOnce(clientClose.promise);
    fixture.subscriber.close.mockReturnValueOnce(subscriberClose.promise);
    fixture.authDatabase.close.mockReturnValueOnce(databaseClose.promise);
    fixture.telemetry.tracing.mockReturnValueOnce(tracingStop.promise);

    const runtime = await start(fixture);
    let settled = false;
    const shutdown = runtime.shutdown("SIGTERM").then(() => { settled = true; });

    fixture.clock.advanceBy(8_000);
    await vi.waitFor(() => expect(fixture.admissionController.close).toHaveBeenCalledOnce());
    expect(fixture.presenters.forceDestroy).toHaveBeenCalledOnce();
    expect(fixture.server.forceDestroy).toHaveBeenCalledOnce();
    expect(fixture.admissionController.close).toHaveBeenCalledOnce();
    expect(fixture.admissionClient.close).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
    expect(fixture.telemetry.healthTransition.mock.calls.map(([state]) => state)).not.toContain("stopped");

    admissionClose.resolve();
    await vi.waitFor(() => expect(fixture.admissionClient.close).toHaveBeenCalledOnce());
    clientClose.resolve();
    await vi.waitFor(() => expect(fixture.subscriber.close).toHaveBeenCalledOnce());
    subscriberClose.resolve();
    await vi.waitFor(() => expect(fixture.authDatabase.close).toHaveBeenCalledOnce());
    databaseClose.resolve();
    tracingStop.resolve();
    await shutdown;
    expect(settled).toBe(true);
    expect(fixture.telemetry.shutdown).toHaveBeenCalledWith("forced", 8_000);
  });

  it("bounds a pending tracing stop by the same shared 8 second shutdown deadline", { timeout: 1_000 }, async () => {
    const fixture = makeFixture();
    fixture.telemetry.tracing.mockReturnValueOnce(new Promise<void>(() => undefined));
    const runtime = await start(fixture);
    const firstShutdown = runtime.shutdown("SIGTERM");
    const repeatedShutdown = runtime.shutdown("SIGINT");
    expect(repeatedShutdown).toBe(firstShutdown);

    await vi.waitFor(() => expect(fixture.telemetry.tracing).toHaveBeenCalledOnce());
    expect(fixture.clock.maxOutstanding).toBe(1);

    fixture.clock.advanceBy(7_999);
    await Promise.resolve();
    expect(fixture.presenters.forceDestroy).not.toHaveBeenCalled();

    fixture.clock.advanceBy(1);
    await Promise.resolve();
    expect.soft(fixture.presenters.forceDestroy).toHaveBeenCalledOnce();
    expect.soft(fixture.server.forceDestroy).toHaveBeenCalledOnce();
    expect(fixture.clock.outstanding()).toBe(0);
    await expect(firstShutdown).resolves.toBeUndefined();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledWith("forced", 8_000);
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it("contains tracing-stop rejection and records fixed-card shutdown failure", async () => {
    const fixture = makeFixture();
    fixture.telemetry.tracing.mockRejectedValueOnce(new Error("exporter unavailable"));
    const runtime = await start(fixture);
    const shutdown = runtime.shutdown("SIGTERM");

    await expect(shutdown).resolves.toBeUndefined();
    expect(fixture.telemetry.error).toHaveBeenCalledWith("shutdown");
    expect(fixture.telemetry.shutdown).toHaveBeenCalledWith("failed", 0);
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
    await expect(runtime.shutdown("SIGTERM")).resolves.toBeUndefined();
    expect(fixture.telemetry.tracing).toHaveBeenCalledOnce();
    expect(fixture.clock.maxOutstanding).toBeLessThanOrEqual(1);
    expect(fixture.clock.outstanding()).toBe(0);
  });

  it("uses fixed-card lifecycle telemetry without IDs, URLs, raw errors, or content", async () => {
    const fixture = makeFixture();
    const runtime = await start(fixture);
    await runtime.shutdown();
    for (const call of [
      ...fixture.telemetry.healthTransition.mock.calls,
      ...fixture.telemetry.readinessGaugeDelta.mock.calls,
      ...fixture.telemetry.shutdown.mock.calls,
      ...fixture.telemetry.error.mock.calls,
      ...fixture.telemetry.tracing.mock.calls,
    ]) {
      expect(JSON.stringify(call)).not.toMatch(/account|workspace|principal|redis:\/\/|token|cookie|error message|content|url/i);
    }
  });
});
