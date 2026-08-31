import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createDocumentWorkerTaskRoutes } from "../../src/app/worker/documentWorkerTaskRoutes.js";

const buildApp = (input: {
  documentProcessingWorker?: {
    runJobById: ReturnType<typeof vi.fn>;
    runOnce: ReturnType<typeof vi.fn>;
    runPostJobMaintenance: ReturnType<typeof vi.fn>;
  };
  facetExtractionWorker?: { runOnce: ReturnType<typeof vi.fn>; drainWorkspace: ReturnType<typeof vi.fn> };
  facetExtractionWorkspaceDrain?: { requestWorkspaceDrain: ReturnType<typeof vi.fn> };
  copilotRetentionWorker?: { sweep: ReturnType<typeof vi.fn> };
}) => {
  const app = express();
  app.use(express.json());
  app.use(createDocumentWorkerTaskRoutes({
    documentProcessingWorker: input.documentProcessingWorker as never,
    facetExtractionWorker: input.facetExtractionWorker as never,
    facetExtractionWorkspaceDrain: input.facetExtractionWorkspaceDrain as never,
    copilotRetentionWorker: input.copilotRetentionWorker as never,
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal" });
  });
  return app;
};

describe("createDocumentWorkerTaskRoutes", () => {
  describe("POST /internal/tasks/document-processing", () => {
    it("accepts the exact serialized Cloud Tasks document payload", async () => {
      const runJobById = vi.fn().mockResolvedValue("processed");
      const app = buildApp({
        documentProcessingWorker: {
          runJobById,
          runOnce: vi.fn(),
          runPostJobMaintenance: vi.fn(),
        },
      });

      const response = await request(app)
        .post("/internal/tasks/document-processing")
        .send({
          jobId: "11111111-1111-4111-8111-111111111111",
          documentId: "22222222-2222-4222-8222-222222222222",
          workspaceId: "33333333-3333-4333-8333-333333333333",
          revision: 1,
        });

      expect(response.status).toBe(204);
      expect(runJobById).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    });
  });

  describe("POST /internal/tasks/document-processing/recover", () => {
    it("drains one at-most-ten-job facet claim regardless of the document recovery budget", async () => {
      const facetRunOnce = vi.fn().mockResolvedValue(10);
      const app = buildApp({
        documentProcessingWorker: {
          runJobById: vi.fn(),
          runOnce: vi.fn().mockResolvedValue(false),
          runPostJobMaintenance: vi.fn().mockResolvedValue(undefined),
        },
        facetExtractionWorker: { runOnce: facetRunOnce, drainWorkspace: vi.fn() },
      });

      const response = await request(app)
        .post("/internal/tasks/document-processing/recover")
        .send({ maxJobs: 50 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ processedJobCount: 0, processedFacetJobCount: 10 });
      expect(facetRunOnce).toHaveBeenCalledTimes(1);
      expect(facetRunOnce).toHaveBeenCalledWith(expect.any(Date), 10);
    });

    it("keeps recovery compatible when facet extraction is unavailable", async () => {
      const app = buildApp({
        documentProcessingWorker: {
          runJobById: vi.fn(),
          runOnce: vi.fn().mockResolvedValue(false),
          runPostJobMaintenance: vi.fn().mockResolvedValue(undefined),
        },
      });

      const response = await request(app)
        .post("/internal/tasks/document-processing/recover")
        .send({ maxJobs: 5 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ processedJobCount: 0, processedFacetJobCount: 0 });
    });
  });

  describe("POST /internal/tasks/facet-extraction/drain", () => {
    it("drains a bounded workspace slice and schedules the following slice", async () => {
      const drainWorkspace = vi.fn().mockResolvedValue(100);
      const requestWorkspaceDrain = vi.fn().mockResolvedValue(false);
      const app = buildApp({
        documentProcessingWorker: {
          runJobById: vi.fn(),
          runOnce: vi.fn().mockResolvedValue(false),
          runPostJobMaintenance: vi.fn().mockResolvedValue(undefined),
        },
        facetExtractionWorker: { runOnce: vi.fn(), drainWorkspace },
        facetExtractionWorkspaceDrain: { requestWorkspaceDrain },
      });

      const response = await request(app)
        .post("/internal/tasks/facet-extraction/drain")
        .send({
          workspaceId: "11111111-1111-1111-1111-111111111111",
          analysisStart: "2026-07-01T00:00:00.000Z",
          analysisEnd: "2026-08-01T00:00:00.000Z",
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ processedJobCount: 100 });
      expect(drainWorkspace).toHaveBeenCalledWith({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        analysisStart: new Date("2026-07-01T00:00:00.000Z"),
        analysisEnd: new Date("2026-08-01T00:00:00.000Z"),
        maxJobs: 100,
      });
      expect(requestWorkspaceDrain).toHaveBeenCalledWith({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        analysisStart: new Date("2026-07-01T00:00:00.000Z"),
        analysisEnd: new Date("2026-08-01T00:00:00.000Z"),
      });
    });
  });
});

describe("POST /internal/tasks/copilot-retention/sweep", () => {
  it("reports what the sweep removed", async () => {
    const sweep = vi.fn().mockResolvedValue({ deleted: 12 });
    const app = buildApp({ copilotRetentionWorker: { sweep } });

    const response = await request(app).post("/internal/tasks/copilot-retention/sweep").send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 12 });
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("succeeds when retention is switched off, so a scheduled push is not a recurring failure", async () => {
    const app = buildApp({ copilotRetentionWorker: { sweep: vi.fn().mockResolvedValue(null) } });

    const response = await request(app).post("/internal/tasks/copilot-retention/sweep").send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 0 });
  });
});
