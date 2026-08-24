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
  facetExtractionWorker?: { runOnce: ReturnType<typeof vi.fn> };
}) => {
  const app = express();
  app.use(express.json());
  app.use(createDocumentWorkerTaskRoutes({
    documentProcessingWorker: input.documentProcessingWorker as never,
    facetExtractionWorker: input.facetExtractionWorker as never,
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal" });
  });
  return app;
};

describe("createDocumentWorkerTaskRoutes", () => {
  describe("POST /internal/tasks/document-processing/recover", () => {
    it("drains one at-most-ten-job facet claim regardless of the document recovery budget", async () => {
      const facetRunOnce = vi.fn().mockResolvedValue(10);
      const app = buildApp({
        documentProcessingWorker: {
          runJobById: vi.fn(),
          runOnce: vi.fn().mockResolvedValue(false),
          runPostJobMaintenance: vi.fn().mockResolvedValue(undefined),
        },
        facetExtractionWorker: { runOnce: facetRunOnce },
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
});
