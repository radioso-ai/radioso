import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/app/config/env.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import { buildDependencies } from "../../src/app/server/dependencies.js";
import { capabilityNames } from "../../src/shared/domain/capabilityPolicy.js";
import { startApiRuntime } from "../../src/runtime/startApiRuntime.js";
import { startWorkerTaskRuntime } from "../../src/runtime/startWorkerTaskRuntime.js";
import { startWorkerRuntime } from "../../src/runtime/startWorkerRuntime.js";
import type { ConnectorPlugin } from "@radioso/connector-api";

const createEnv = (): Env => ({
  NODE_ENV: "test",
  PORT: 8088,
  OBSERVABILITY_ENABLED: true,
  OBSERVABILITY_SERVICE_NAME: "radioso-api",
  OBSERVABILITY_ENVIRONMENT: "test",
  OBSERVABILITY_VERSION: "test",
  METRICS_ENABLED: false,
  METRICS_PATH: "/metrics",
  METRICS_AUTH_TOKEN: undefined,
  OTEL_ENABLED: false,
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  PRODUCT_ANALYTICS_SINKS: "audit",
  INCIDENT_SINKS: "audit",
  POSTHOG_HOST: undefined,
  POSTHOG_API_KEY: undefined,
  SENTRY_DSN: undefined,
  GOOGLE_CLOUD_PROJECT: "radioso-test",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  DB_POOL_MAX: 10,
  DB_POOL_IDLE_TIMEOUT_MS: 30_000,
  DB_POOL_CONNECTION_TIMEOUT_MS: 5_000,
  DB_STATEMENT_TIMEOUT_MS: 15_000,
  DB_QUERY_TIMEOUT_MS: 20_000,
  OPENAI_API_KEY: "test-key",
  OPENAI_CHAT_MODEL: "gpt-5.2",
  OPENAI_VECTOR_MODEL: "text-embedding-3-small",
  LLM_PROVIDER: "openai",
  SESSION_COOKIE_NAME: "radioso_session",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
  WORKSPACE_TOKEN_SECRET: "fedcba9876543210fedcba9876543210",
  PUBLIC_CHAT_SESSION_SECRET: "00112233445566778899aabbccddeeff",
  SESSION_TTL_HOURS: 168,
  AUTH_SKIP_EMAIL_VERIFICATION: false,
  APP_BASE_URL: "http://localhost:3000",
  PASSWORD_RESET_TOKEN_TTL_MINUTES: 30,
  PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS: 5,
  MAIL_DRIVER: "noop",
  MAIL_FROM_EMAIL: "noreply@example.com",
  MAIL_FROM_NAME: "Radioso",
  MAIL_SMTP_HOST: undefined,
  MAIL_SMTP_PORT: 587,
  MAIL_SMTP_SECURE: false,
  MAIL_SMTP_USERNAME: undefined,
  MAIL_SMTP_PASSWORD: undefined,
  AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: 10,
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: 20,
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 30,
  CONNECTOR_ENCRYPTION_KEY: "test",
  DOCUMENT_STORAGE_DRIVER: "local",
  DOCUMENT_STORAGE_LOCAL_PATH: "../.context/test-document-storage",
  DOCUMENT_STORAGE_BUCKET: "bucket",
  DOCUMENT_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
  WORKER_DISPATCH_DRIVER: "noop",
  WORKER_TASKS_QUEUE_LOCATION: undefined,
  WORKER_TASKS_QUEUE_NAME: undefined,
  WORKER_TASKS_SERVICE_URL: undefined,
  WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: undefined,
  WORKER_AMQP_URL: undefined,
  WORKER_AMQP_QUEUE_NAME: undefined,
  WORKER_AMQP_PREFETCH: 1,
  DOCUMENT_PROCESSING_JOB_LEASE_MS: 300_000,
  PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
});

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
    logger: createLogger().logger,
    documentProcessingWorker: {
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
    connectorDb: {},
    chatService: {},
  } as unknown as AppDependencies);

describe("runtime startup", () => {
  it("starts the API runtime with SQL migrations and connector bootstrapping, but without the worker loop", async () => {
    const env = createEnv();
    const dependencies = createDependencies();
    const runMigrations = vi.fn().mockResolvedValue(undefined);
    const listen = vi.fn((_app: unknown, _port: number, onListening: () => void) => {
      onListening();
      return {
        close(callback?: () => void) {
          callback?.();
        },
      };
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

    expect(runMigrations).toHaveBeenCalledWith(env.DATABASE_URL, logger);
    expect(dependencies.connectorRegistry.runMigrations).toHaveBeenCalledWith(dependencies.connectorDb);
    expect(dependencies.connectorRegistry.initializeAll).toHaveBeenCalledOnce();
    expect(dependencies.applicationModules.initializeAll).toHaveBeenCalledOnce();
    expect(dependencies.documentProcessingWorker.start).not.toHaveBeenCalled();

    await runtime.shutdown("test");
    expect(dependencies.applicationModules.shutdownAll).toHaveBeenCalledOnce();
    expect(dependencies.connectorRegistry.shutdownAll).toHaveBeenCalledOnce();
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

    expect(ensureNoPendingMigrations).toHaveBeenCalledWith(env.DATABASE_URL);
    expect(dependencies.applicationModules.initializeAll).toHaveBeenCalledOnce();
    expect(dependencies.documentProcessingWorker.start).toHaveBeenCalledOnce();
    expect(dependencies.connectorRegistry.runMigrations).not.toHaveBeenCalled();
    expect(dependencies.connectorRegistry.initializeAll).not.toHaveBeenCalled();

    await runtime.shutdown("test");
    expect(dependencies.documentProcessingWorker.stop).toHaveBeenCalledOnce();
    expect(dependencies.applicationModules.shutdownAll).toHaveBeenCalledOnce();
  });

  it("starts the worker task runtime with the polling worker loop and internal task server", async () => {
    const env = createEnv();
    const dependencies = createDependencies();
    const ensureNoPendingMigrations = vi.fn().mockResolvedValue(undefined);
    const listen = vi.fn((_app: unknown, _port: number, onListening: () => void) => {
      onListening();
      return {
        close(callback?: () => void) {
          callback?.();
        },
      };
    });

    const runtime = await startWorkerTaskRuntime({
      env,
      logger: createLogger().logger as any,
      ensureNoPendingMigrations,
      buildDependencies: () => dependencies,
      createApp: () => ({}) as any,
      listen,
    });

    expect(ensureNoPendingMigrations).toHaveBeenCalledWith(env.DATABASE_URL);
    expect(dependencies.applicationModules.initializeAll).toHaveBeenCalledOnce();
    expect(dependencies.documentProcessingWorker.start).toHaveBeenCalledOnce();

    await runtime.shutdown("test");
    expect(dependencies.documentProcessingWorker.stop).toHaveBeenCalledOnce();
    expect(dependencies.applicationModules.shutdownAll).toHaveBeenCalledOnce();
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

    expect(runMigrations).toHaveBeenCalledWith(env.DATABASE_URL, expect.anything());
    expect(createAppSpy).toHaveBeenCalledWith(expect.objectContaining({
      metricsRegistry: dependencies.metricsRegistry,
    }));

    await runtime.shutdown("test");
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
});
