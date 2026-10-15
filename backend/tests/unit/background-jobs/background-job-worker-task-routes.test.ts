import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createBackgroundJobWorkerTaskRoutes } from "../../../src/app/worker/backgroundJobWorkerTaskRoutes.js";
import { AppError } from "../../../src/shared/domain/errors.js";

const drained = { claimed: 1, completed: 1, retried: 0, deadLettered: 0, superseded: 0 };

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
  it("runs one bounded drain for a pushed wake and reports what it did", async () => {
    const drain = vi.fn(async () => drained);

    const response = await request(buildApp({ drain })).post("/internal/tasks/background-jobs/drain").send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual(drained);
    expect(drain).toHaveBeenCalledWith({ maxJobs: 5 });
  });

  it("lets the scheduled sweep ask for a larger drain", async () => {
    const drain = vi.fn(async () => drained);

    await request(buildApp({ drain })).post("/internal/tasks/background-jobs/drain").send({ maxJobs: 20 });

    expect(drain).toHaveBeenCalledWith({ maxJobs: 20 });
  });

  it("rejects a drain budget outside its bounds", async () => {
    const drain = vi.fn(async () => drained);

    const response = await request(buildApp({ drain })).post("/internal/tasks/background-jobs/drain").send({ maxJobs: 500 });

    expect(response.status).toBe(400);
    expect(drain).not.toHaveBeenCalled();
  });

  it("fails the request when the store is unreachable, so Cloud Tasks retries the wake", async () => {
    const drain = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    const response = await request(buildApp({ drain })).post("/internal/tasks/background-jobs/drain").send({});

    expect(response.status).toBe(500);
  });

  it("sweeps dead-lettered jobs past retention and reports how many went", async () => {
    const sweep = vi.fn(async () => ({ status: "swept", deleted: 3 }));

    const response = await request(buildApp({ sweep })).post("/internal/tasks/background-job-retention/sweep").send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 3, status: "swept" });
  });

  it("answers a failed retention sweep with a retryable status", async () => {
    const sweep = vi.fn(async () => ({ status: "failed", error: "deadlock detected" }));

    const response = await request(buildApp({ sweep })).post("/internal/tasks/background-job-retention/sweep").send({});

    expect(response.status).toBe(503);
  });
});
