import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/app/config/env.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import { buildDependencies } from "../../src/app/server/dependencies.js";
import { capabilityNames } from "../../src/shared/domain/capabilityPolicy.js";
import { startApiRuntime } from "../../src/runtime/startApiRuntime.js";
import { startWorkerTaskRuntime } from "../../src/runtime/startWorkerTaskRuntime.js";
import { startWorkerRuntime } from "../../src/runtime/startWorkerRuntime.js";
import { startCrawlerWorkerRuntime } from "../../src/runtime/startCrawlerWorkerRuntime.js";
import { startCrawlerWorkerTaskRuntime } from "../../src/runtime/startCrawlerWorkerTaskRuntime.js";
import type { ConnectorPlugin } from "@radioso/connector-api";

const createEnv = (): Env => ({
  NODE_ENV: "test",
  PORT: 8088,
  TRUST_PROXY_HOPS: 0,
  OBSERVABILITY_ENABLED: true,
  OBSERVABILITY_SERVICE_NAME: "radioso-api",
  OBSERVABILITY_ENVIRONMENT: "test",
  OBSERVABILITY_VERSION: "test",
  METRICS_ENABLED: false,
  METRICS_PATH: "/metrics",
  METRICS_AUTH_TOKEN: undefined,
  OTEL_ENABLED: false,
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  OTEL_LOGS_ENABLED: false,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: undefined,
  OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER: undefined,
  OTEL_LOGS_MIN_LEVEL: undefined,
  PRODUCT_ANALYTICS_SINKS: "audit",
  ERROR_SINKS: "audit",
  OPS_EVENT_WEBHOOK_URL: undefined,
  OPS_EVENT_WEBHOOK_SECRET: undefined,
  OPS_EVENT_WEBHOOK_EVENTS: undefined,
  OPS_EVENT_WEBHOOK_MIN_ERROR_SEVERITY: "error",
  OPS_EVENT_WEBHOOK_QUEUE_LIMIT: 500,
  GOOGLE_CLOUD_PROJECT: "radioso-test",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  DB_POOL_MAX: 10,
  DB_POOL_IDLE_TIMEOUT_MS: 30_000,
  DB_POOL_CONNECTION_TIMEOUT_MS: 5_000,
  DB_STATEMENT_TIMEOUT_MS: 15_000,
  DB_QUERY_TIMEOUT_MS: 20_000,
  DB_MIGRATION_LOCK_TIMEOUT_MS: 10_000,
  DB_MIGRATION_STATEMENT_TIMEOUT_MS: 25_000,
  OPENAI_API_KEY: "test-key",
  OPENAI_CHAT_MODEL: "gpt-5.2",
  OPENAI_VECTOR_MODEL: "text-embedding-3-small",
  LLM_PROVIDER: "openai",
  SESSION_COOKIE_NAME: "radioso_session",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
  WORKSPACE_TOKEN_SECRET: "fedcba9876543210fedcba9876543210",
  PUBLIC_CHAT_SESSION_SECRET: "00112233445566778899aabbccddeeff",
  SESSION_TTL_HOURS: 168,
  AUTH_AUTO_VERIFY_EMAIL: false,
  AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: 10,
  PASSWORD_RESET_TOKEN_TTL_MINUTES: 30,
  EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: 30,
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: 20,
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 30,
  EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS: 60_000,
  EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS: 60,
  COPILOT_PROBE_BUDGET_PER_TURN: 3,
  COPILOT_CONVERSATION_RETENTION_DAYS: 90,
  AGENT_BUNDLE_IMPORT_ORPHAN_AGE_MS: 15 * 60 * 1_000,
  PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
  PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 10,
  PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 600,
  AGENT_CHANNEL_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 300,
  MCP_CONVERSE_SESSION_RATE_LIMIT_WINDOW_MS: 60_000,
  MCP_CONVERSE_SESSION_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 60,
  MCP_CONVERSE_SESSION_TOKEN_RATE_LIMIT_MAX_ATTEMPTS: 10,
  RADIOSO_TRUSTED_PROXY_HOPS: 0,
  CONNECTOR_ENCRYPTION_KEY: "test",
  WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: false,
  DOCUMENT_STORAGE_DRIVER: "local",
  DOCUMENT_STORAGE_LOCAL_PATH: "../.context/test-document-storage",
  DOCUMENT_STORAGE_BUCKET: "bucket",
  DOCUMENT_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
  WORKER_DISPATCH_DRIVER: "noop",
  WORKER_TASKS_QUEUE_LOCATION: undefined,
  WORKER_TASKS_QUEUE_NAME: undefined,
  WORKER_TASKS_CRAWL_QUEUE_NAME: undefined,
  ACTION_DISPATCH_TASK_QUEUE_NAME: undefined,
  WORKER_TASKS_SERVICE_URL: undefined,
  WORKER_TASKS_CRAWL_SERVICE_URL: undefined,
  WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: undefined,
  WORKER_TASK_AUTH_TOKEN: undefined,
  WORKER_AMQP_URL: undefined,
  WORKER_AMQP_QUEUE_NAME: undefined,
  WORKER_AMQP_CRAWL_QUEUE_NAME: undefined,
  WORKER_AMQP_PREFETCH: 1,
  DOCUMENT_PROCESSING_JOB_LEASE_MS: 300_000,
  WEBSITE_CRAWL_JOB_LEASE_MS: 900_000,
  WEBSITE_CRAWL_WORKER_POLL_INTERVAL_MS: 5_000,
  FACET_EXTRACTION_WORKER_POLL_INTERVAL_MS: 5_000,
  FACET_EXTRACTION_WORKER_BATCH_SIZE: 10,
  FACET_EXTRACTION_JOB_LEASE_MS: 300_000,
  WEBSITE_CRAWLER_ENABLED: true,
  AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
  AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS: 30,
  AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 300,
  APP_BASE_URL: undefined,
  PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  RADIOSO_EDITION: "oss",
  RADIOSO_APPLICATION_MODULES: undefined,
});

const migrationTimeoutOptionsFor = (env: Env) => ({
  lockTimeoutMs: env.DB_MIGRATION_LOCK_TIMEOUT_MS,
  statementTimeoutMs: env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,
});

const expectCalledBefore = (before: unknown, after: unknown) => {
  const callOrder = (candidate: unknown) =>
    (candidate as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
  expect(callOrder(before)).toBeLessThan(callOrder(after));
};

const createLogger = () => {
  const calls = {
    info: [] as Array<{ message: string; payload: unknown }>,
    error: [] as Array<{ message: string; payload: unknown }>,
  };

  return {
    logger: {
      info(payload: unknown, message?: string) {
        calls.info.push({ message: message ?? "", payload });
      },
      error(payload: unknown, message?: string) {
        calls.error.push({ message: message ?? "", payload });
      },
    },
    calls,
  };
};

const createDependencies = () =>
  ({
    metricsRegistry: null,
    workspaceInvalidationPublisher: { enqueue: vi.fn(() => ({ accepted: false, reason: "disabled" })) },
    realtimePublisherLifecycle: { shutdown: vi.fn().mockResolvedValue(undefined) },
    credentialExpiryWarningLifecycle: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    logger: createLogger().logger,
    documentProcessingWorker: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    copilotRetentionWorker: {
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    },
    agentBundleImportCleanupWorker: {
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    },
    actionDispatchWorker: {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    websiteCrawlWorker: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    connectorRegistry: {
      runMigrations: vi.fn().mockResolvedValue(undefined),
      initializeAll: vi.fn().mockResolvedValue(undefined),
      shutdownAll: vi.fn().mockResolvedValue(undefined),
    },
    applicationModules: {
      migrateAll: vi.fn().mockResolvedValue(undefined),
      initializeAll: vi.fn().mockResolvedValue(undefined),
      shutdownAll: vi.fn().mockResolvedValue(undefined),
    },
    vectorIndexReconciler: {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      runUntilIdle: vi.fn().mockResolvedValue(0),
    },
    connectorDb: {},
    chatService: {},
  } as unknown as AppDependencies);

describe("runtime startup", () => {
  it("starts the API runtime with SQL migrations and connector bootstrapping, but without the worker loop", async () => {
    const env = createEnv();
    const dependencies = createDependencies();
    const runMigrations = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn((callback?: () => void) => callback?.());
    const listen = vi.fn((_app: unknown, _port: number, onListening: () => void) => {
      onListening();
      return { close };
    });
    const { logger } = createLogger();

    const runtime = await startApiRuntime({
      env,
      logger: logger as any,
      runMigrations,
      buildDependencies: () => dependencies,
      createApp: () => ({}) as any,
      listen,
    });

    expect(runMigrations).toHaveBeenCalledWith(env.DATABASE_URL, logger, migrationTimeoutOptionsFor(env));
    expect(dependencies.connectorRegistry.runMigrations).toHaveBeenCalledWith(dependencies.connectorDb);
    expect(dependencies.connectorRegistry.initializeAll).toHaveBeenCalledOnce();
    expect(dependencies.connectorRegistry.initializeAll).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceInvalidationPublisher: dependencies.workspaceInvalidationPublisher,
      }),
    );
    expect(dependencies.applicationModules.initializeAll).toHaveBeenCalledOnce();
    expect(dependencies.credentialExpiryWarningLifecycle?.start).toHaveBeenCalledOnce();
    expect(dependencies.documentProcessingWorker.start).not.toHaveBeenCalled();
    expect(dependencies.vectorIndexReconciler?.start).not.toHaveBeenCalled();

    await runtime.shutdown("test");
    expect(dependencies.credentialExpiryWarningLifecycle?.stop).toHaveBeenCalledOnce();
    expect(dependencies.realtimePublisherLifecycle.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.applicationModules.shutdownAll).toHaveBeenCalledOnce();
    expect(dependencies.connectorRegistry.shutdownAll).toHaveBeenCalledOnce();
    expectCalledBefore(close, dependencies.realtimePublisherLifecycle.shutdown);
    expectCalledBefore(dependencies.realtimePublisherLifecycle.shutdown, dependencies.applicationModules.shutdownAll);
    expectCalledBefore(dependencies.applicationModules.shutdownAll, dependencies.connectorRegistry.shutdownAll);
  });

  it("starts the worker runtime without connector bootstrapping and fails fast on pending migrations", async () => {
    const env = createEnv();
    const dependencies = createDependencies();
    const ensureNoPendingMigrations = vi
      .fn()
      .mockRejectedValue(new Error("Pending SQL migrations detected"));

    await expect(startWorkerRuntime({
      env,
      logger: createLogger().logger as any,
      ensureNoPendingMigrations,
      buildDependencies: () => dependencies,
    })).rejects.toThrow("Pending SQL migrations detected");

    expect(dependencies.connectorRegistry.runMigrations).not.toHaveBeenCalled();
    expect(dependencies.connectorRegistry.initializeAll).not.toHaveBeenCalled();
    expect(dependencies.applicationModules.initializeAll).not.toHaveBeenCalled();
    expect(dependencies.documentProcessingWorker.start).not.toHaveBeenCalled();
    expect(dependencies.vectorIndexReconciler?.start).not.toHaveBeenCalled();
  });

  it("starts the worker runtime independently after migration verification", async () => {
    const env = createEnv();
    const dependencies = createDependencies();
    const ensureNoPendingMigrations = vi.fn().mockResolvedValue(undefined);

    const runtime = await startWorkerRuntime({
      env,
      logger: createLogger().logger as any,
      ensureNoPendingMigrations,
      buildDependencies: () => dependencies,
    });

    expect(ensureNoPendingMigrations).toHaveBeenCalledWith(env.DATABASE_URL, migrationTimeoutOptionsFor(env));
    expect(dependencies.applicationModules.initializeAll).toHaveBeenCalledOnce();
    expect(dependencies.documentProcessingWorker.start).toHaveBeenCalledOnce();
    expect(dependencies.vectorIndexReconciler?.start).toHaveBeenCalledOnce();
    expect(dependencies.actionDispatchWorker.start).toHaveBeenCalledOnce();
    expect(dependencies.copilotRetentionWorker.start).toHaveBeenCalledOnce();
    expect(dependencies.websiteCrawlWorker.start).not.toHaveBeenCalled();
    expect(dependencies.connectorRegistry.runMigrations).not.toHaveBeenCalled();
    expect(dependencies.connectorRegistry.initializeAll).not.toHaveBeenCalled();

    await runtime.shutdown("test");
    expect(dependencies.documentProcessingWorker.stop).toHaveBeenCalledOnce();
    expect(dependencies.vectorIndexReconciler?.stop).toHaveBeenCalledOnce();
    expect(dependencies.actionDispatchWorker.stop).toHaveBeenCalledOnce();
    expect(dependencies.copilotRetentionWorker.stop).toHaveBeenCalledOnce();
    expect(dependencies.websiteCrawlWorker.stop).not.toHaveBeenCalled();
    expect(dependencies.realtimePublisherLifecycle.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.applicationModules.shutdownAll).toHaveBeenCalledOnce();
    expectCalledBefore(dependencies.documentProcessingWorker.stop, dependencies.realtimePublisherLifecycle.shutdown);
    expectCalledBefore(dependencies.realtimePublisherLifecycle.shutdown, dependencies.applicationModules.shutdownAll);
  });

  it("starts the worker task runtime with only the internal task server", async () => {
    const env = createEnv();
    const dependencies = createDependencies();
    const ensureNoPendingMigrations = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn((callback?: () => void) => callback?.());
    const listen = vi.fn((_app: unknown, _port: number, onListening: () => void) => {
      onListening();
      return { close };
    });

    const runtime = await startWorkerTaskRuntime({
      env,
      logger: createLogger().logger as any,
      ensureNoPendingMigrations,
      buildDependencies: () => dependencies,
      createApp: () => ({}) as any,
      listen,
    });

    expect(ensureNoPendingMigrations).toHaveBeenCalledWith(env.DATABASE_URL, migrationTimeoutOptionsFor(env));
    expect(dependencies.applicationModules.initializeAll).toHaveBeenCalledOnce();
    expect(dependencies.documentProcessingWorker.start).not.toHaveBeenCalled();
    expect(dependencies.vectorIndexReconciler?.start).not.toHaveBeenCalled();
    expect(dependencies.websiteCrawlWorker.start).not.toHaveBeenCalled();

    await runtime.shutdown("test");
    expect(dependencies.documentProcessingWorker.stop).not.toHaveBeenCalled();
    expect(dependencies.websiteCrawlWorker.stop).not.toHaveBeenCalled();
    expect(dependencies.realtimePublisherLifecycle.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.applicationModules.shutdownAll).toHaveBeenCalledOnce();
    expectCalledBefore(close, dependencies.realtimePublisherLifecycle.shutdown);
    expectCalledBefore(dependencies.realtimePublisherLifecycle.shutdown, dependencies.applicationModules.shutdownAll);
  });

  it("starts the crawler worker runtime independently after migration verification", async () => {
    const env = createEnv();
    const dependencies = createDependencies();
    const ensureNoPendingMigrations = vi.fn().mockResolvedValue(undefined);

    const runtime = await startCrawlerWorkerRuntime({
      env,
      logger: createLogger().logger as any,
      ensureNoPendingMigrations,
      buildDependencies: () => dependencies,
    });

    expect(ensureNoPendingMigrations).toHaveBeenCalledWith(env.DATABASE_URL, migrationTimeoutOptionsFor(env));
    expect(dependencies.applicationModules.initializeAll).toHaveBeenCalledOnce();
    expect(dependencies.websiteCrawlWorker.start).toHaveBeenCalledOnce();
    expect(dependencies.documentProcessingWorker.start).not.toHaveBeenCalled();

    await runtime.shutdown("test");
    expect(dependencies.websiteCrawlWorker.stop).toHaveBeenCalledOnce();
    expect(dependencies.documentProcessingWorker.stop).not.toHaveBeenCalled();
    expect(dependencies.realtimePublisherLifecycle.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.applicationModules.shutdownAll).toHaveBeenCalledOnce();
    expectCalledBefore(dependencies.websiteCrawlWorker.stop, dependencies.realtimePublisherLifecycle.shutdown);
    expectCalledBefore(dependencies.realtimePublisherLifecycle.shutdown, dependencies.applicationModules.shutdownAll);
  });

  it("starts the crawler worker task runtime with only the internal task server", async () => {
    const env = createEnv();
    const dependencies = createDependencies();
    const ensureNoPendingMigrations = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn((callback?: () => void) => callback?.());
    const listen = vi.fn((_app: unknown, _port: number, onListening: () => void) => {
      onListening();
      return { close };
    });

    const runtime = await startCrawlerWorkerTaskRuntime({
      env,
      logger: createLogger().logger as any,
      ensureNoPendingMigrations,
      buildDependencies: () => dependencies,
      createApp: () => ({}) as any,
      listen,
    });

    expect(ensureNoPendingMigrations).toHaveBeenCalledWith(env.DATABASE_URL, migrationTimeoutOptionsFor(env));
    expect(dependencies.applicationModules.initializeAll).toHaveBeenCalledOnce();
    expect(dependencies.websiteCrawlWorker.start).not.toHaveBeenCalled();
    expect(dependencies.documentProcessingWorker.start).not.toHaveBeenCalled();

    await runtime.shutdown("test");
    expect(dependencies.websiteCrawlWorker.stop).not.toHaveBeenCalled();
    expect(dependencies.documentProcessingWorker.stop).not.toHaveBeenCalled();
    expect(dependencies.realtimePublisherLifecycle.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.applicationModules.shutdownAll).toHaveBeenCalledOnce();
    expectCalledBefore(close, dependencies.realtimePublisherLifecycle.shutdown);
    expectCalledBefore(dependencies.realtimePublisherLifecycle.shutdown, dependencies.applicationModules.shutdownAll);
  });

  it("passes the metrics registry through API startup composition when metrics are enabled", async () => {
    const env = {
      ...createEnv(),
      METRICS_ENABLED: true,
      METRICS_AUTH_TOKEN: "metrics-test-token",
    };
    const dependencies = {
      ...createDependencies(),
      metricsRegistry: {
        renderPrometheus: vi.fn().mockReturnValue(""),
      },
    } as unknown as AppDependencies;
    const runMigrations = vi.fn().mockResolvedValue(undefined);
    const createAppSpy = vi.fn().mockReturnValue({} as any);
    const listen = vi.fn((_app: unknown, _port: number, onListening: () => void) => {
      onListening();
      return {
        close(callback?: () => void) {
          callback?.();
        },
      };
    });

    const runtime = await startApiRuntime({
      env,
      logger: createLogger().logger as any,
      runMigrations,
      buildDependencies: () => dependencies,
      createApp: createAppSpy,
      listen,
    });

    expect(runMigrations).toHaveBeenCalledWith(env.DATABASE_URL, expect.anything(), migrationTimeoutOptionsFor(env));
    expect(createAppSpy).toHaveBeenCalledWith(expect.objectContaining({
      metricsRegistry: dependencies.metricsRegistry,
    }));

    await runtime.shutdown("test");
  });

  it("logs startup migration failures before dependency construction", async () => {
    const env = createEnv();
    const dependencies = createDependencies();
    const runMigrations = vi.fn().mockRejectedValue(new Error("canceling statement due to lock timeout"));
    const { logger, calls } = createLogger();

    await expect(startApiRuntime({
      env,
      logger: logger as any,
      runMigrations,
      buildDependencies: () => dependencies,
      createApp: () => ({}) as any,
      listen: vi.fn(),
    })).rejects.toThrow("canceling statement due to lock timeout");

    expect(calls.info).toContainEqual({
      message: "Radioso API startup migrations starting",
      payload: {
        role: "api",
        migrationLockTimeoutMs: env.DB_MIGRATION_LOCK_TIMEOUT_MS,
        migrationStatementTimeoutMs: env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,
      },
    });
    expect(calls.error).toEqual([
      {
        message: "Radioso API startup migrations failed",
        payload: expect.objectContaining({
          role: "api",
          migrationLockTimeoutMs: env.DB_MIGRATION_LOCK_TIMEOUT_MS,
          migrationStatementTimeoutMs: env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,
          err: expect.any(Error),
        }),
      },
    ]);
    expect(dependencies.applicationModules.migrateAll).not.toHaveBeenCalled();
  });

  it("builds default dependencies with capability policy and optional connector modules", async () => {
    const connector: ConnectorPlugin = {
      id: "test-connector",
      name: "Test Connector",
      description: "Test connector",
      configSchema: () => [],
      migrate: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      getWebhookPath: () => "/api/connectors/test/webhook",
      uniqueChannelField: () => null,
      validateConfig: () => [],
    };
    const dependencies = buildDependencies(createEnv(), {
      modules: [
        {
          id: "test-module",
          register(context) {
            context.registerConnector(connector);
          },
        },
      ],
    });

    await expect(dependencies.capabilityPolicy.can({
      capability: capabilityNames.documents.delete,
      workspaceId: "workspace-1",
    })).resolves.toEqual({ allowed: true });
    expect(dependencies.connectorRegistry.listPlugins()).toContainEqual({
      id: "test-connector",
      name: "Test Connector",
      description: "Test connector",
    });

    await dependencies.connectorDb.close();
  });

  describe("worker runtime parity guard", () => {
    // The contact-outbox incident: `actionDispatchWorker.start()` was wired into
    // startWorkerRuntime (docker-compose) but the production entrypoint,
    // startWorkerTaskRuntime, never got an equivalent push/route — and nothing
    // failed loudly, so it silently drained nothing in prod for two months while
    // local dev looked completely healthy.
    //
    // This guard is structural, not behavioral: it (1) dynamically enumerates every
    // AppDependencies key with a poll-loop-worker shape (`{start, stop}`) from a
    // REAL `buildDependencies()` build (so a newly added worker is picked up
    // automatically, not just entries someone remembered to add here), (2) reads
    // startWorkerRuntime.ts's own source to see which of those it actually calls
    // `.start()` on (also dynamic — no hand-copied list to fall out of date), and
    // (3) requires every one of those to have an entry in WORKER_TASK_RUNTIME_COVERAGE
    // below, either naming the worker-task route that drains it or explicitly
    // documenting why no push counterpart exists.
    //
    // What this does NOT catch: whether the named route actually calls into the
    // right dependency correctly (that's the route's own unit test), or a worker
    // wired into startWorkerTaskRuntime but forgotten in startWorkerRuntime (the
    // reverse direction — less dangerous, since local dev would visibly not drain
    // it and a developer would notice). It also trusts the `noPushCounterpart`
    // reasons as asserted, not independently verified against product intent.
    const WORKER_TASK_RUNTIME_COVERAGE: Record<
      string,
      { route: string } | { noPushCounterpart: string }
    > = {
      documentProcessingWorker: { route: "POST /internal/tasks/document-processing (and /recover)" },
      actionDispatchWorker: { route: "POST /internal/tasks/actions/drain (and /recover)" },
      vectorIndexReconciler: {
        noPushCounterpart:
          "runs embedding-space reconciliation ticks alongside document processing in the same " +
          "process; not triggered by a discrete turn/job event, so there is nothing to push per-item",
      },
      documentJobConsumer: {
        noPushCounterpart:
          "the AMQP alternative to Cloud Tasks push (WORKER_DISPATCH_DRIVER=amqp) — a message-queue " +
          "puller, not something an HTTP push targets; mutually exclusive with the task-runtime push model",
      },
      facetExtractionWorker: {
        route: "POST /internal/tasks/document-processing/recover",
      },
      copilotRetentionWorker: {
        route: "POST /internal/tasks/copilot-retention/sweep",
      },
      agentBundleImportCleanupWorker: {
        route: "POST /internal/tasks/agent-bundle-imports/sweep",
      },
    };

    it("accounts for every poll-loop worker startWorkerRuntime starts, in the worker-task runtime coverage map", async () => {
      const dependencies = buildDependencies(createEnv());
      try {
        const workerLikeKeys = Object.keys(dependencies).filter((key) => {
          const value = (dependencies as unknown as Record<string, unknown>)[key];
          return (
            Boolean(value) &&
            typeof value === "object" &&
            typeof (value as { start?: unknown }).start === "function" &&
            typeof (value as { stop?: unknown }).stop === "function"
          );
        });
        // Sanity check on the extraction itself — if this ever comes back empty the
        // regex/property-shape check below has silently stopped matching anything,
        // which would make the rest of this test vacuously pass.
        expect(workerLikeKeys.length).toBeGreaterThan(0);

        const runtimeSource = await readFile(
          fileURLToPath(new URL("../../src/runtime/startWorkerRuntime.ts", import.meta.url)),
          "utf8",
        );
        const startedKeys = new Set(
          [...runtimeSource.matchAll(/dependencies\.(\w+)\??\.start\(/g)].map((match) => match[1]!),
        );
        expect(startedKeys.size).toBeGreaterThan(0);

        const uncoveredKeys = [...startedKeys].filter((key) => !(key in WORKER_TASK_RUNTIME_COVERAGE));
        expect(
          uncoveredKeys,
          `startWorkerRuntime.ts starts ${JSON.stringify(uncoveredKeys)} with no entry in ` +
            "WORKER_TASK_RUNTIME_COVERAGE — add a { route } or { noPushCounterpart } entry so the " +
            "worker-task (Cloud Run) runtime is not silently missing this background responsibility.",
        ).toEqual([]);

        // Every key startWorkerRuntime starts must also actually exist as an
        // AppDependencies property (catches a renamed/removed field going stale in
        // startWorkerRuntime.ts's own source). Some optional workers — e.g.
        // documentJobConsumer, only built under WORKER_DISPATCH_DRIVER=amqp — are
        // `undefined` under this test's env, so this checks key presence, not shape.
        const staleCoverageKeys = [...startedKeys].filter((key) => !(key in dependencies));
        expect(staleCoverageKeys).toEqual([]);
      } finally {
        await dependencies.connectorDb.close();
      }
    });
  });
});
