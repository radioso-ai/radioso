import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createEmailChannelWorkerTaskRoutes } from "../../src/app/worker/emailChannelWorkerTaskRoutes.js";
import { createWorkerTaskApp } from "../../src/app/worker/createWorkerTaskApp.js";
import { WORKER_TASK_AUTH_HEADER } from "../../src/shared/infra/workerTaskAuth.js";
import { createTestDependencies } from "../support/testApp.js";

const taskToken = "0123456789abcdef0123456789abcdef";

const createWorker = () => ({
  drain: vi.fn(async () => ({ claimed: 1, errored: 0, reviewed: 0, reconciled: 0, processed: 1, ignored: 0, retrying: 0, failed: 0, superseded: 0 })),
  sweep: vi.fn(async () => ({
    recoveredLeases: 0,
    refreshedDomains: 1,
    cleanedDomains: 0,
    purgedDeliveries: 2,
    purgedEvents: 1,
    reconciledSends: 0,
    drained: 0,
  })),
});

const workerTaskApp = (worker: ReturnType<typeof createWorker> | undefined) => {
  const { dependencies } = createTestDependencies();
  Object.assign(dependencies.env, { WORKER_TASK_AUTH_TOKEN: taskToken });
  Object.assign(dependencies, { emailChannelWorker: worker });
  return createWorkerTaskApp(dependencies);
};

const routesApp = (worker: ReturnType<typeof createWorker>) => {
  const app = express();
  app.use(express.json());
  app.use(createEmailChannelWorkerTaskRoutes({ emailChannelWorker: worker }));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal" });
  });
  return app;
};

describe("email channel worker task routes", () => {
  it.each(["/internal/tasks/email-channel/drain", "/internal/tasks/email-channel/sweep"])(
    "keeps %s behind the worker token",
    async (path) => {
      const worker = createWorker();
      const app = workerTaskApp(worker);

      const missing = await request(app).post(path).send({ maxJobs: 5 });
      const wrong = await request(app).post(path).set(WORKER_TASK_AUTH_HEADER, "fedcba9876543210fedcba9876543210").send({ maxJobs: 5 });

      expect(missing.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(worker.drain).not.toHaveBeenCalled();
      expect(worker.sweep).not.toHaveBeenCalled();
    },
  );

  it("drains the requested stage with the worker token", async () => {
    const worker = createWorker();

    const response = await request(workerTaskApp(worker))
      .post("/internal/tasks/email-channel/drain")
      .set(WORKER_TASK_AUTH_HEADER, taskToken)
      .send({ maxJobs: 7, stage: "inbound" });

    expect(response.status).toBe(204);
    expect(worker.drain).toHaveBeenCalledWith({ maxJobs: 7, stage: "inbound" });
  });

  it("sweeps with the worker token and reports the counts", async () => {
    const worker = createWorker();

    const response = await request(workerTaskApp(worker))
      .post("/internal/tasks/email-channel/sweep")
      .set(WORKER_TASK_AUTH_HEADER, taskToken)
      .send({ maxJobs: 20 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ refreshedDomains: 1, purgedDeliveries: 2 });
    expect(worker.sweep).toHaveBeenCalledWith({ maxJobs: 20 });
  });

  it("is not mounted when the email channel is not configured", async () => {
    const response = await request(workerTaskApp(undefined))
      .post("/internal/tasks/email-channel/drain")
      .set(WORKER_TASK_AUTH_HEADER, taskToken)
      .send({ maxJobs: 5 });

    expect(response.status).toBe(404);
  });

  it("defaults an empty drain body to a bounded drain of every stage", async () => {
    const worker = createWorker();

    await request(routesApp(worker)).post("/internal/tasks/email-channel/drain").send();

    expect(worker.drain).toHaveBeenCalledWith({ maxJobs: 10, stage: "all" });
  });

  it.each([
    ["an unknown stage", { maxJobs: 5, stage: "everything" }],
    ["too many jobs", { maxJobs: 51 }],
    ["a non-numeric job count", { maxJobs: "many" }],
  ])("rejects a drain with %s", async (_label, body) => {
    const worker = createWorker();

    const response = await request(routesApp(worker)).post("/internal/tasks/email-channel/drain").send(body);

    expect(response.status).toBe(400);
    expect(worker.drain).not.toHaveBeenCalled();
  });

  it("reports a disabled worker's sweep as skipped", async () => {
    const worker = createWorker();
    worker.sweep.mockResolvedValueOnce(null as never);

    const response = await request(routesApp(worker)).post("/internal/tasks/email-channel/sweep").send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ skipped: "disabled" });
  });

  it("forwards a drain failure to the error handler", async () => {
    const worker = createWorker();
    worker.drain.mockRejectedValueOnce(new Error("db down"));

    const response = await request(routesApp(worker)).post("/internal/tasks/email-channel/drain").send({});

    expect(response.status).toBe(500);
  });
});
