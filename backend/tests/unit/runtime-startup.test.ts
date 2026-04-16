import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/app/config/env.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import { startApiRuntime } from "../../src/runtime/startApiRuntime.js";
import { startWorkerRuntime } from "../../src/runtime/startWorkerRuntime.js";

const createEnv = (): Env => ({
  NODE_ENV: "test",
  PORT: 8088,
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
  WEBSITE_EMBED_SECRET: "00112233445566778899aabbccddeeff",
  SESSION_TTL_HOURS: 168,
  AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: 10,
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: 20,
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 30,
  CONNECTOR_ENCRYPTION_KEY: "test",
  DOCUMENT_STORAGE_BUCKET: "bucket",
  DOCUMENT_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
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
    expect(dependencies.documentProcessingWorker.start).not.toHaveBeenCalled();

    await runtime.shutdown("test");
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
    expect(dependencies.documentProcessingWorker.start).toHaveBeenCalledOnce();
    expect(dependencies.connectorRegistry.runMigrations).not.toHaveBeenCalled();
    expect(dependencies.connectorRegistry.initializeAll).not.toHaveBeenCalled();

    await runtime.shutdown("test");
    expect(dependencies.documentProcessingWorker.stop).toHaveBeenCalledOnce();
  });
});
