import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { createApp } from "../../src/app/server/createApp.js";
import { createWorkerTaskApp } from "../../src/app/worker/createWorkerTaskApp.js";
import { createCrawlerWorkerTaskApp } from "../../src/app/worker/createCrawlerWorkerTaskApp.js";
import type { Env } from "../../src/app/config/env.js";
import { startApiRuntime } from "../../src/runtime/startApiRuntime.js";
import { startWorkerTaskRuntime } from "../../src/runtime/startWorkerTaskRuntime.js";
import { startWorkerRuntime } from "../../src/runtime/startWorkerRuntime.js";
import { startCrawlerWorkerRuntime } from "../../src/runtime/startCrawlerWorkerRuntime.js";
import { startCrawlerWorkerTaskRuntime } from "../../src/runtime/startCrawlerWorkerTaskRuntime.js";
import { createTestDependencies } from "../support/testApp.js";

const createEnv = (port: number): Env => ({
  NODE_ENV: "test",
  PORT: port,
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
  ERROR_SINKS: "audit",
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
  AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: 10,
  EE_MAX_ORGS_PER_USER_PER_MONTH: 10,
  PASSWORD_RESET_TOKEN_TTL_MINUTES: 30,
  EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: 30,
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: 20,
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 30,
  EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS: 60_000,
  EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS: 60,
  PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
  PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 10,
  PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 600,
  CONNECTOR_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  DOCUMENT_STORAGE_DRIVER: "local",
  DOCUMENT_STORAGE_LOCAL_PATH: "../.context/test-document-storage",
  DOCUMENT_STORAGE_BUCKET: "test-document-imports",
  DOCUMENT_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
  WORKER_DISPATCH_DRIVER: "noop",
  WORKER_TASKS_QUEUE_LOCATION: undefined,
  WORKER_TASKS_QUEUE_NAME: undefined,
  WORKER_TASKS_CRAWL_QUEUE_NAME: undefined,
  WORKER_TASKS_SERVICE_URL: undefined,
  WORKER_TASKS_CRAWL_SERVICE_URL: undefined,
  WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: undefined,
  WORKER_AMQP_URL: undefined,
  WORKER_AMQP_QUEUE_NAME: undefined,
  WORKER_AMQP_CRAWL_QUEUE_NAME: undefined,
  WORKER_AMQP_PREFETCH: 1,
  DOCUMENT_PROCESSING_JOB_LEASE_MS: 300_000,
  WEBSITE_CRAWL_JOB_LEASE_MS: 900_000,
  WEBSITE_CRAWL_WORKER_POLL_INTERVAL_MS: 5_000,
  WEBSITE_CRAWLER_ENABLED: true,
  APP_BASE_URL: undefined,
  PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  RADIOSO_BASE_URL: undefined,
  RADIOSO_MCP_ENABLED: false,
  RADIOSO_MCP_STANDALONE: false,
  RADIOSO_MCP_MOUNT_PATH: "/mcp",
  RADIOSO_MCP_MERGED_CORS_ORIGINS: "*",
  RADIOSO_MCP_ACCESS_TOKEN_TTL_SECONDS: 900,
  RADIOSO_MCP_ALLOWED_READ_TOOLS: undefined,
  RADIOSO_MCP_ALLOWED_WRITE_TOOLS: undefined,
  RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS: undefined,
  RADIOSO_MCP_AUDIT_LOG_PATH: undefined,
  RADIOSO_MCP_BIND_HOST: "127.0.0.1",
  RADIOSO_MCP_BIND_PORT: 8787,
  RADIOSO_MCP_REDIS_KEY_PREFIX: "radioso-mcp",
  RADIOSO_MCP_REDIS_URL: undefined,
  RADIOSO_MCP_REQUEST_TIMEOUT_MS: 30_000,
  RADIOSO_MCP_SERVER_NAME: "radioso-context",
  RADIOSO_MCP_WORKSPACE_POLICIES_PATH: undefined,
  RADIOSO_APPLICATION_MODULES: undefined,
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

  it("starts the worker runtime without starting an HTTP server, and without the crawler worker", async () => {
    const { dependencies } = createTestDependencies();
    const workerStartSpy = vi.spyOn(dependencies.documentProcessingWorker, "start");
    const crawlerStartSpy = vi.spyOn(dependencies.websiteCrawlWorker, "start");

    const runtime = await startWorkerRuntime({
      env: createEnv(8092),
      logger: dependencies.logger,
      ensureNoPendingMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
    });
    runtimes.push(runtime);

    expect(workerStartSpy).toHaveBeenCalledOnce();
    expect(crawlerStartSpy).not.toHaveBeenCalled();
    expect(runtime.server).toBeUndefined();
  });

  it("starts the crawler worker runtime without starting the document processing worker", async () => {
    const { dependencies } = createTestDependencies();
    const documentStartSpy = vi.spyOn(dependencies.documentProcessingWorker, "start");
    const crawlerStartSpy = vi.spyOn(dependencies.websiteCrawlWorker, "start");
    const crawlerStopSpy = vi.spyOn(dependencies.websiteCrawlWorker, "stop");

    const runtime = await startCrawlerWorkerRuntime({
      env: createEnv(8097),
      logger: dependencies.logger,
      ensureNoPendingMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
    });
    runtimes.push(runtime);

    expect(crawlerStartSpy).toHaveBeenCalledOnce();
    expect(documentStartSpy).not.toHaveBeenCalled();
    expect(runtime.server).toBeUndefined();

    await runtime.shutdown("test");
    runtimes.pop();
    expect(crawlerStopSpy).toHaveBeenCalledOnce();
  });

  it("worker task runtime returns 410 Gone for website-crawl pushes so Cloud Tasks stops retrying", async () => {
    const { dependencies } = createTestDependencies();
    const crawlWorkerSpy = vi.spyOn(dependencies.websiteCrawlWorker, "runJobById");

    const runtime = await startWorkerTaskRuntime({
      env: createEnv(8098),
      logger: dependencies.logger,
      ensureNoPendingMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
      createApp: createWorkerTaskApp,
    });
    runtimes.push(runtime);

    const response = await request(runtime.server!)
      .post("/internal/tasks/website-crawl")
      .send({ jobId: randomUUID() });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ error: "moved" });
    expect(crawlWorkerSpy).not.toHaveBeenCalled();
  });

  it("crawler worker task runtime serves the website-crawl route", async () => {
    const { dependencies } = createTestDependencies();
    const crawlerWorkerStartSpy = vi.spyOn(dependencies.websiteCrawlWorker, "start");
    const documentWorkerStartSpy = vi.spyOn(dependencies.documentProcessingWorker, "start");
    const runJobByIdSpy = vi
      .spyOn(dependencies.websiteCrawlWorker, "runJobById")
      .mockResolvedValue("processed");

    const runtime = await startCrawlerWorkerTaskRuntime({
      env: createEnv(8099),
      logger: dependencies.logger,
      ensureNoPendingMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
      createApp: createCrawlerWorkerTaskApp,
    });
    runtimes.push(runtime);

    const jobId = randomUUID();
    const response = await request(runtime.server!)
      .post("/internal/tasks/website-crawl")
      .send({ jobId });

    expect(response.status).toBe(204);
    expect(runJobByIdSpy).toHaveBeenCalledWith(jobId);
    expect(crawlerWorkerStartSpy).not.toHaveBeenCalled();
    expect(documentWorkerStartSpy).not.toHaveBeenCalled();
  });

  it("crawler worker task runtime does not expose the document-processing route", async () => {
    const { dependencies } = createTestDependencies();

    const runtime = await startCrawlerWorkerTaskRuntime({
      env: createEnv(8100),
      logger: dependencies.logger,
      ensureNoPendingMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
      createApp: createCrawlerWorkerTaskApp,
    });
    runtimes.push(runtime);

    const response = await request(runtime.server!)
      .post("/internal/tasks/document-processing")
      .send({ jobId: randomUUID() });

    expect(response.status).toBe(404);
  });

  it("worker task runtime exposes bounded document recovery without starting the polling loop", async () => {
    const { dependencies } = createTestDependencies();
    const workerStartSpy = vi.spyOn(dependencies.documentProcessingWorker, "start");
    const runOnceSpy = vi
      .spyOn(dependencies.documentProcessingWorker, "runOnce")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const runtime = await startWorkerTaskRuntime({
      env: createEnv(8101),
      logger: dependencies.logger,
      ensureNoPendingMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
      createApp: createWorkerTaskApp,
    });
    runtimes.push(runtime);

    const response = await request(runtime.server!)
      .post("/internal/tasks/document-processing/recover")
      .send({ maxJobs: 5 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ processedJobCount: 1 });
    expect(workerStartSpy).not.toHaveBeenCalled();
    expect(runOnceSpy).toHaveBeenCalledTimes(2);
  });

  it("crawler worker task runtime exposes bounded crawl recovery without starting the polling loop", async () => {
    const { dependencies } = createTestDependencies();
    const crawlerWorkerStartSpy = vi.spyOn(dependencies.websiteCrawlWorker, "start");
    const runOnceSpy = vi
      .spyOn(dependencies.websiteCrawlWorker, "runOnce")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    const runtime = await startCrawlerWorkerTaskRuntime({
      env: createEnv(8102),
      logger: dependencies.logger,
      ensureNoPendingMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
      createApp: createCrawlerWorkerTaskApp,
    });
    runtimes.push(runtime);

    const response = await request(runtime.server!)
      .post("/internal/tasks/website-crawl/recover")
      .send({ maxJobs: 2 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ processedJobCount: 2 });
    expect(crawlerWorkerStartSpy).not.toHaveBeenCalled();
    expect(runOnceSpy).toHaveBeenCalledTimes(2);
  });

  it("starts the worker task runtime and serves internal task routes", async () => {
    const { dependencies, repositories } = createTestDependencies();
    const workerStartSpy = vi
      .spyOn(dependencies.documentProcessingWorker, "start")
      .mockResolvedValue(undefined);
    const workerStopSpy = vi.spyOn(dependencies.documentProcessingWorker, "stop");
    const document = await repositories.documentRepository.create({
      workspaceId: randomUUID(),
      title: "Task queued",
      sourceContent: "Task queued",
      markdownContent: "Task queued",
      status: "queued",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const job = await repositories.documentProcessingJobRepository.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });

    const runtime = await startWorkerTaskRuntime({
      env: createEnv(8094),
      logger: dependencies.logger,
      ensureNoPendingMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
      createApp: createWorkerTaskApp,
    });
    runtimes.push(runtime);

    const response = await request(runtime.server!)
      .post("/internal/tasks/document-processing")
      .send({ jobId: job.id });

    expect(response.status).toBe(204);
    expect(workerStartSpy).not.toHaveBeenCalled();
    expect(repositories.documentProcessingJobRepository.items.get(job.id)?.status).toBe("completed");

    await runtime.shutdown("test");
    runtimes.pop();
    expect(workerStopSpy).not.toHaveBeenCalled();
  });

  it("serves session-authenticated admin routes after login bootstrap", async () => {
    const { dependencies, repositories } = createTestDependencies({
      envOverrides: {
      },
    });

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
    expect(register.status).toBe(201);

    await repositories.userRepository.markEmailVerified(register.body.userId as string, new Date());
    const login = await request(runtime.server!)
      .post("/api/v1/auth/login")
      .send({
        email: "runtime-session@example.com",
        password: "verysecurepassword",
      });
    expect(login.status).toBe(200);

    const settings = await request(runtime.server!)
      .get("/api/v1/settings/general")
      .set("Cookie", login.headers["set-cookie"][0] as string)
      .set("X-Workspace-Id", register.body.workspaceId as string);

    expect(settings.status).toBe(200);
    expect(settings.body.anonymousChatEnabled).toBe(false);
  });

  it("reports unhandled request failures through the error reporting seam", async () => {
    const { dependencies, repositories } = createTestDependencies({
      envOverrides: {
      },
    });
    const reportErrorSpy = vi.spyOn(dependencies.errorReportingService, "reportUnhandledRequestError");
    vi.spyOn(dependencies.platformSettingsService, "getForWorkspace").mockRejectedValue(new Error("boom"));

    const runtime = await startApiRuntime({
      env: createEnv(8095),
      logger: dependencies.logger,
      runMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
      createApp,
    });
    runtimes.push(runtime);

    const register = await request(runtime.server!)
      .post("/api/v1/auth/register")
      .send({
        email: "runtime-failure@example.com",
        password: "verysecurepassword",
      });
    expect(register.status).toBe(201);

    await repositories.userRepository.markEmailVerified(register.body.userId as string, new Date());
    const login = await request(runtime.server!)
      .post("/api/v1/auth/login")
      .send({
        email: "runtime-failure@example.com",
        password: "verysecurepassword",
      });
    expect(login.status).toBe(200);

    const response = await request(runtime.server!)
      .get("/api/v1/settings/general")
      .set("Cookie", login.headers["set-cookie"][0] as string)
      .set("X-Workspace-Id", register.body.workspaceId as string);

    expect(response.status).toBe(500);
    expect(reportErrorSpy).toHaveBeenCalledOnce();
  });

  it("serves Prometheus-style metrics when metrics exposure is enabled", async () => {
    const env = {
      ...createEnv(8096),
      METRICS_ENABLED: true,
      METRICS_AUTH_TOKEN: "metrics-test-token",
    };
    const { dependencies } = createTestDependencies({
      envOverrides: {
        METRICS_ENABLED: true,
        METRICS_AUTH_TOKEN: "metrics-test-token",
      },
    });

    const runtime = await startApiRuntime({
      env,
      logger: dependencies.logger,
      runMigrations: vi.fn().mockResolvedValue(undefined),
      buildDependencies: () => dependencies,
      createApp,
    });
    runtimes.push(runtime);

    await request(runtime.server!).get("/health");

    const unauthorizedResponse = await request(runtime.server!).get("/metrics");

    expect(unauthorizedResponse.status).toBe(401);

    const response = await request(runtime.server!)
      .get("/metrics")
      .set("Authorization", "Bearer metrics-test-token");

    expect(response.status).toBe(200);
    expect(response.text).toContain("radioso_http_requests_total");
    expect(response.text).toContain('route="/health"');
  });
});
