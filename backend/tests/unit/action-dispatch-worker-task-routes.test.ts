import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createActionDispatchWorkerTaskRoutes } from "../../src/app/worker/actionDispatchWorkerTaskRoutes.js";

const buildApp = (actionDispatchWorker: { drain: ReturnType<typeof vi.fn> }) => {
  const app = express();
  app.use(express.json());
  app.use(createActionDispatchWorkerTaskRoutes({ actionDispatchWorker: actionDispatchWorker as never }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal" });
  });
  return app;
};

describe("createActionDispatchWorkerTaskRoutes", () => {
  describe("POST /internal/tasks/actions/drain", () => {
    it("triggers exactly one drain and responds 204", async () => {
      const drain = vi.fn().mockResolvedValue({ dispatched: 1, retried: 0, failed: 0 });
      const app = buildApp({ drain });

      const response = await request(app).post("/internal/tasks/actions/drain").send({});

      expect(response.status).toBe(204);
      expect(drain).toHaveBeenCalledOnce();
    });

    it("responds 204 even when the drain is a no-op (nothing pending) or already in flight", async () => {
      const drain = vi.fn().mockResolvedValue(null);
      const app = buildApp({ drain });

      const response = await request(app).post("/internal/tasks/actions/drain").send({});

      expect(response.status).toBe(204);
    });

    it("forwards an unexpected drain error to the error handler instead of hanging", async () => {
      const drain = vi.fn().mockRejectedValue(new Error("db down"));
      const app = buildApp({ drain });

      const response = await request(app).post("/internal/tasks/actions/drain").send({});

      expect(response.status).toBe(500);
    });
  });

  describe("POST /internal/tasks/actions/recover", () => {
    it("drains repeatedly until a batch does no work, bounded by maxJobs", async () => {
      const drain = vi
        .fn()
        .mockResolvedValueOnce({ dispatched: 5, retried: 0, failed: 0 })
        .mockResolvedValueOnce({ dispatched: 3, retried: 0, failed: 0 })
        .mockResolvedValueOnce({ dispatched: 0, retried: 0, failed: 0 });
      const app = buildApp({ drain });

      const response = await request(app).post("/internal/tasks/actions/recover").send({ maxJobs: 10 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ processedBatchCount: 2 });
      expect(drain).toHaveBeenCalledTimes(3);
    });

    it("stops after maxJobs batches even if every batch found work", async () => {
      const drain = vi.fn().mockResolvedValue({ dispatched: 1, retried: 0, failed: 0 });
      const app = buildApp({ drain });

      const response = await request(app).post("/internal/tasks/actions/recover").send({ maxJobs: 3 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ processedBatchCount: 3 });
      expect(drain).toHaveBeenCalledTimes(3);
    });

    it("treats a null (already-draining) result as done and stops the loop", async () => {
      const drain = vi.fn().mockResolvedValue(null);
      const app = buildApp({ drain });

      const response = await request(app).post("/internal/tasks/actions/recover").send({ maxJobs: 5 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ processedBatchCount: 0 });
      expect(drain).toHaveBeenCalledTimes(1);
    });

    it("defaults maxJobs when the body is empty", async () => {
      const drain = vi.fn().mockResolvedValue(null);
      const app = buildApp({ drain });

      const response = await request(app).post("/internal/tasks/actions/recover").send();

      expect(response.status).toBe(200);
      expect(drain).toHaveBeenCalledTimes(1);
    });

    it("rejects an invalid payload with 400", async () => {
      const drain = vi.fn();
      const app = buildApp({ drain });

      const response = await request(app).post("/internal/tasks/actions/recover").send({ maxJobs: "not-a-number" });

      expect(response.status).toBe(400);
      expect(drain).not.toHaveBeenCalled();
    });

    it("caps maxJobs at 50", async () => {
      const drain = vi.fn();
      const app = buildApp({ drain });

      const response = await request(app).post("/internal/tasks/actions/recover").send({ maxJobs: 51 });

      expect(response.status).toBe(400);
      expect(drain).not.toHaveBeenCalled();
    });
  });
});
