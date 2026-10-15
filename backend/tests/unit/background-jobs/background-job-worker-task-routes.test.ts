import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createBackgroundJobWorkerTaskRoutes } from "../../../src/app/worker/backgroundJobWorkerTaskRoutes.js";
import { createWorkerTaskApp } from "../../../src/app/worker/createWorkerTaskApp.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import { WORKER_TASK_AUTH_HEADER } from "../../../src/shared/infra/workerTaskAuth.js";
import { createTestDependencies } from "../../support/testApp.js";

const drained = { claimed: 1, completed: 1, requeued: 0, retried: 0, deadLettered: 0, superseded: 0 };
const taskToken = "0123456789abcdef0123456789abcdef";
const DRAIN_PATH = "/internal/tasks/background-jobs/drain";
const RETENTION_PATH = "/internal/tasks/background-job-retention/sweep";

const buildApp = (deps: {
  drain?: ReturnType<typeof vi.fn>;
  sweep?: ReturnType<typeof vi.fn>;
}) => {
  const app = express();
  app.use(express.json());
  app.use(createBackgroundJobWorkerTaskRoutes({
    backgroundJobRuntime: { drain: deps.drain ?? vi.fn(async () => drained) } as never,
    backgroundJobRetentionWorker: { sweep: deps.sweep ?? vi.fn(async () => ({ status: "swept", deleted: 0 })) } as never,
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: "failed" });
  });
  return app;
};

describe("background job worker task routes", () => {
  it("runs one job for a pushed wake, inside the drain's time budget", async () => {
    const drain = vi.fn(async () => drained);

    const response = await request(buildApp({ drain })).post(DRAIN_PATH).send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual(drained);
    expect(drain).toHaveBeenCalledWith({ maxJobs: 1, budgetMs: 270_000, startedAt: expect.any(Number) });
  });

  it("lets the scheduled sweep ask for more jobs under the same budget", async () => {
    const drain = vi.fn(async () => drained);

    await request(buildApp({ drain })).post(DRAIN_PATH).send({ maxJobs: 20 });

    expect(drain).toHaveBeenCalledWith({ maxJobs: 20, budgetMs: 270_000, startedAt: expect.any(Number) });
  });

  it("rejects a job count outside its bounds", async () => {
    const drain = vi.fn(async () => drained);

    const response = await request(buildApp({ drain })).post(DRAIN_PATH).send({ maxJobs: 500 });

    expect(response.status).toBe(400);
    expect(drain).not.toHaveBeenCalled();
  });

  it("fails the request when the store is unreachable, so Cloud Tasks retries the wake", async () => {
    const drain = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    const response = await request(buildApp({ drain })).post(DRAIN_PATH).send({});

    expect(response.status).toBe(500);
  });

  it("sweeps dead-lettered jobs past retention and reports how many went", async () => {
    const sweep = vi.fn(async () => ({ status: "swept", deleted: 3 }));

    const response = await request(buildApp({ sweep })).post(RETENTION_PATH).send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 3, status: "swept" });
  });

  it("answers a failed retention sweep with a retryable status", async () => {
    const sweep = vi.fn(async () => ({ status: "failed", error: "deadlock detected" }));

    const response = await request(buildApp({ sweep })).post(RETENTION_PATH).send({});

    expect(response.status).toBe(503);
  });
});

describe("background job routes on the worker task server", () => {
  const workerTaskServer = () => {
    const { dependencies } = createTestDependencies();
    Object.assign(dependencies.env, { WORKER_TASK_AUTH_TOKEN: taskToken });
    const drain = vi.spyOn(dependencies.backgroundJobRuntime, "drain");
    const sweep = vi.spyOn(dependencies.backgroundJobRetentionWorker, "sweep");
    return { app: createWorkerTaskApp(dependencies), drain, sweep };
  };

  it.each([DRAIN_PATH, RETENTION_PATH])("refuses %s without the worker task token", async (path) => {
    const { app, drain, sweep } = workerTaskServer();

    const missing = await request(app).post(path).send({});
    const wrong = await request(app).post(path).set(WORKER_TASK_AUTH_HEADER, "fedcba9876543210fedcba9876543210").send({});

    expect([missing.status, wrong.status]).toEqual([401, 401]);
    expect(drain).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });

  it("drains background jobs for a request carrying the token", async () => {
    const { app, drain } = workerTaskServer();

    const response = await request(app).post(DRAIN_PATH).set(WORKER_TASK_AUTH_HEADER, taskToken).send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ claimed: 0, completed: 0, requeued: 0, retried: 0, deadLettered: 0, superseded: 0 });
    expect(drain).toHaveBeenCalledWith({ maxJobs: 1, budgetMs: 270_000, startedAt: expect.any(Number) });
  });

  it("sweeps dead-lettered jobs for a request carrying the token", async () => {
    const { app, sweep } = workerTaskServer();

    const response = await request(app).post(RETENTION_PATH).set(WORKER_TASK_AUTH_HEADER, taskToken).send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 0, status: "swept" });
    expect(sweep).toHaveBeenCalledOnce();
  });
});
