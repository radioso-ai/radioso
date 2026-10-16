import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createActionDispatchWorkerTaskRoutes } from "../../src/app/worker/actionDispatchWorkerTaskRoutes.js";

const drained = { claimed: 1, completed: 1, skipped: 0, requeued: 0, retried: 0, deadLettered: 0, superseded: 0 };
const DRAIN_PATH = "/internal/tasks/actions/drain";
const RECOVER_PATH = "/internal/tasks/actions/recover";

const buildApp = (drain: ReturnType<typeof vi.fn>) => {
  const app = express();
  app.use(express.json());
  app.use(createActionDispatchWorkerTaskRoutes({ actionDispatchJobRuntime: { drain } as never }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal" });
  });
  return app;
};

describe("createActionDispatchWorkerTaskRoutes", () => {
  describe("POST /internal/tasks/actions/drain", () => {
    it("runs one job for a pushed wake, inside the drain's time budget", async () => {
      const drain = vi.fn(async () => drained);

      const response = await request(buildApp(drain)).post(DRAIN_PATH).send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual(drained);
      expect(drain).toHaveBeenCalledWith({ maxJobs: 1, budgetMs: 270_000, startedAt: expect.any(Number) });
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
    it("asks for more jobs under the same budget, defaulting to the recovery sweep's own batch size", async () => {
      const drain = vi.fn(async () => drained);

      const response = await request(buildApp(drain)).post(RECOVER_PATH).send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual(drained);
      expect(drain).toHaveBeenCalledWith({ maxJobs: 5, budgetMs: 270_000, startedAt: expect.any(Number) });
    });

    it("honors an explicit maxJobs", async () => {
      const drain = vi.fn(async () => drained);

      await request(buildApp(drain)).post(RECOVER_PATH).send({ maxJobs: 10 });

      expect(drain).toHaveBeenCalledWith({ maxJobs: 10, budgetMs: 270_000, startedAt: expect.any(Number) });
    });

    it("rejects an invalid payload with 400", async () => {
      const drain = vi.fn();

      const response = await request(buildApp(drain)).post(RECOVER_PATH).send({ maxJobs: "not-a-number" });

      expect(response.status).toBe(400);
      expect(drain).not.toHaveBeenCalled();
    });

    it("caps maxJobs at 50", async () => {
      const drain = vi.fn();

      const response = await request(buildApp(drain)).post(RECOVER_PATH).send({ maxJobs: 51 });

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
