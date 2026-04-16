import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createApp } from "../../src/app/server/createApp.js";
import type { Env } from "../../src/app/config/env.js";
import { startApiRuntime } from "../../src/runtime/startApiRuntime.js";
import { startWorkerRuntime } from "../../src/runtime/startWorkerRuntime.js";
import { createTestDependencies } from "../support/testApp.js";

const createEnv = (port: number): Env => ({
  NODE_ENV: "test",
  PORT: port,
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
  CONNECTOR_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  DOCUMENT_STORAGE_DRIVER: "local",
  DOCUMENT_STORAGE_LOCAL_PATH: "../.context/test-document-storage",
  DOCUMENT_STORAGE_BUCKET: "test-document-imports",
  DOCUMENT_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
  PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
});

describe("runtime entrypoints", () => {
  const runtimes: Array<{ shutdown(signal: string): Promise<void> }> = [];

  afterEach(async () => {
    while (runtimes.length > 0) {
      await runtimes.pop()!.shutdown("test");
    }
  });

  it("starts the API runtime without starting the worker loop and serves HTTP traffic", async () => {
    const { dependencies } = createTestDependencies();
    const workerStartSpy = vi.spyOn(dependencies.documentProcessingWorker, "start");

    const runtime = await startApiRuntime({
      env: createEnv(8091),
      logger: dependencies.logger,
      runMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
      createApp,
    });
    runtimes.push(runtime);

    const response = await request(runtime.server!).get("/health");
    expect(response.status).toBe(200);
    expect(workerStartSpy).not.toHaveBeenCalled();
  });

  it("starts the worker runtime without starting an HTTP server", async () => {
    const { dependencies } = createTestDependencies();
    const workerStartSpy = vi.spyOn(dependencies.documentProcessingWorker, "start");

    const runtime = await startWorkerRuntime({
      env: createEnv(8092),
      logger: dependencies.logger,
      ensureNoPendingMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
    });
    runtimes.push(runtime);

    expect(workerStartSpy).toHaveBeenCalledOnce();
    expect(runtime.server).toBeUndefined();
  });

  it("serves session-authenticated admin routes after login bootstrap", async () => {
    const { dependencies } = createTestDependencies();

    const runtime = await startApiRuntime({
      env: createEnv(8093),
      logger: dependencies.logger,
      runMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
      createApp,
    });
    runtimes.push(runtime);

    const register = await request(runtime.server!)
      .post("/api/v1/auth/register")
      .send({
        email: "runtime-session@example.com",
        password: "verysecurepassword",
      });

    const settings = await request(runtime.server!)
      .get("/api/v1/settings/general")
      .set("Cookie", register.headers["set-cookie"][0] as string)
      .set("X-Workspace-Id", register.body.workspaceId as string);

    expect(register.status).toBe(201);
    expect(settings.status).toBe(200);
    expect(settings.body.anonymousChatEnabled).toBe(false);
  });
});
