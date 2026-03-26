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
  OPENAI_API_KEY: "test-key",
  OPENAI_CHAT_MODEL: "gpt-5.2",
  OPENAI_VECTOR_MODEL: "text-embedding-3-small",
  LLM_PROVIDER: "openai",
  SESSION_COOKIE_NAME: "radioso_session",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
  SESSION_TTL_HOURS: 168,
  CONNECTOR_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
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
});
