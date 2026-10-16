import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createActionDispatchWorkerTaskRoutes } from "../../src/app/worker/actionDispatchWorkerTaskRoutes.js";
import {
  BackgroundJobRuntime,
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
} from "../../src/shared/background-jobs/index.js";
import { InMemoryBackgroundJobStore } from "../support/inMemoryBackgroundJobStore.js";

const drained = { claimed: 1, completed: 1, skipped: 0, requeued: 0, retried: 0, deadLettered: 0, superseded: 0 };
const DRAIN_PATH = "/internal/tasks/actions/drain";
const RECOVER_PATH = "/internal/tasks/actions/recover";

const buildApp = (drain: ReturnType<typeof vi.fn>, reportActionOutboxQueueState: ReturnType<typeof vi.fn> = vi.fn(async () => undefined)) => {
  const app = express();
  app.use(express.json());
  app.use(createActionDispatchWorkerTaskRoutes({ actionDispatchJobRuntime: { drain } as never, reportActionOutboxQueueState }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal" });
  });
  return app;
};

describe("createActionDispatchWorkerTaskRoutes", () => {
  describe("POST /internal/tasks/actions/drain", () => {
    it("asks for up to a full batch per pushed wake, inside the drain's time budget", async () => {
      const drain = vi.fn(async () => drained);

      const response = await request(buildApp(drain)).post(DRAIN_PATH).send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual(drained);
      expect(drain).toHaveBeenCalledWith({ maxJobs: 20, budgetMs: 270_000, startedAt: expect.any(Number) });
    });

    it("drains every action a single turn enqueued from one pushed wake, against the real runtime", async () => {
      const clock = { now: () => new Date() };
      const store = new InMemoryBackgroundJobStore(clock);
      const job = defineBackgroundJob({
        kind: "test.two_action_turn",
        payload: z.object({ actionId: z.string() }),
        onDuplicateKey: "ignore",
      });
      const handled: string[] = [];
      const runtime = new BackgroundJobRuntime({
        store,
        handlers: [backgroundJobHandler(job, async (payload) => { handled.push(payload.actionId); })],
        logger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
      });
      // Mirrors a turn that enqueues two routine actions transactionally, then sends one push.
      await store.insert(backgroundJobRequest(job, { actionId: "a1" }));
      await store.insert(backgroundJobRequest(job, { actionId: "a2" }));

      const response = await request(
        express()
          .use(express.json())
          .use(createActionDispatchWorkerTaskRoutes({
            actionDispatchJobRuntime: runtime,
            reportActionOutboxQueueState: vi.fn(async () => undefined),
          })),
      )
        .post(DRAIN_PATH)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ claimed: 2, completed: 2 });
      expect(handled.sort()).toEqual(["a1", "a2"]);
    });

    it("reports the outbox queue state after a successful push drain", async () => {
      const drain = vi.fn(async () => drained);
      const reportActionOutboxQueueState = vi.fn(async () => undefined);

      const response = await request(buildApp(drain, reportActionOutboxQueueState)).post(DRAIN_PATH).send({});

      expect(response.status).toBe(200);
      expect(reportActionOutboxQueueState).toHaveBeenCalledTimes(1);
    });

    it("forwards an unexpected drain error to the error handler instead of hanging", async () => {
      const drain = vi.fn(async () => {
        throw new Error("db down");
      });

      const response = await request(buildApp(drain)).post(DRAIN_PATH).send({});

      expect(response.status).toBe(500);
    });

    it("rejects an invalid payload with 400", async () => {
      const drain = vi.fn();

      const response = await request(buildApp(drain)).post(DRAIN_PATH).send({ maxJobs: "not-a-number" });

      expect(response.status).toBe(400);
      expect(drain).not.toHaveBeenCalled();
    });
  });

  describe("POST /internal/tasks/actions/recover", () => {
    it("asks for well above one push's batch under the same budget, defaulting to the recovery sweep's own size", async () => {
      const drain = vi.fn(async () => drained);

      const response = await request(buildApp(drain)).post(RECOVER_PATH).send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual(drained);
      expect(drain).toHaveBeenCalledWith({ maxJobs: 200, budgetMs: 270_000, startedAt: expect.any(Number) });
    });

    it("honors an explicit maxJobs", async () => {
      const drain = vi.fn(async () => drained);

      await request(buildApp(drain)).post(RECOVER_PATH).send({ maxJobs: 10 });

      expect(drain).toHaveBeenCalledWith({ maxJobs: 10, budgetMs: 270_000, startedAt: expect.any(Number) });
    });

    it("reports the outbox queue state after a successful recovery sweep", async () => {
      const drain = vi.fn(async () => drained);
      const reportActionOutboxQueueState = vi.fn(async () => undefined);

      const response = await request(buildApp(drain, reportActionOutboxQueueState)).post(RECOVER_PATH).send({});

      expect(response.status).toBe(200);
      expect(reportActionOutboxQueueState).toHaveBeenCalledTimes(1);
    });

    it("rejects an invalid payload with 400", async () => {
      const drain = vi.fn();

      const response = await request(buildApp(drain)).post(RECOVER_PATH).send({ maxJobs: "not-a-number" });

      expect(response.status).toBe(400);
      expect(drain).not.toHaveBeenCalled();
    });

    it("caps maxJobs at 500", async () => {
      const drain = vi.fn();

      const response = await request(buildApp(drain)).post(RECOVER_PATH).send({ maxJobs: 501 });

      expect(response.status).toBe(400);
      expect(drain).not.toHaveBeenCalled();
    });

    it("forwards an unexpected drain error to the error handler", async () => {
      const drain = vi.fn(async () => {
        throw new Error("db down");
      });

      const response = await request(buildApp(drain)).post(RECOVER_PATH).send({});

      expect(response.status).toBe(500);
    });
  });
});
