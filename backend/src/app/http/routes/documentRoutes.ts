import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireApiToken } from "../middleware/requireApiToken.js";
import { validateBody } from "../middleware/validate.js";

const documentSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional().refine(
    (val) => !val || JSON.stringify(val).length <= 16384,
    { message: "Metadata must be 16 KB or less" },
  ),
});

const documentParamsSchema = z.object({
  documentId: z.string().uuid(),
});

export const createDocumentRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/", requireApiToken(dependencies), async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const documents = await dependencies.documentIngestionService.listForWorkspace(workspaceId);
      res.status(200).json({ documents });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", requireApiToken(dependencies), validateBody(documentSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const result = await dependencies.documentIngestionService.ingest({
        workspaceId,
        title: req.body.title,
        content: req.body.content,
        metadata: req.body.metadata,
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:documentId", requireApiToken(dependencies), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const document = await dependencies.documentIngestionService.getDocument(workspaceId, documentId);
      res.status(200).json(document);
    } catch (error) {
      next(error);
    }
  });

  router.put("/:documentId", requireApiToken(dependencies), validateBody(documentSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const result = await dependencies.documentIngestionService.update({
        workspaceId,
        documentId,
        title: req.body.title,
        content: req.body.content,
        metadata: req.body.metadata,
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:documentId/reprocess", requireApiToken(dependencies), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const result = await dependencies.documentIngestionService.reprocess({
        workspaceId,
        documentId,
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:documentId", requireApiToken(dependencies), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      await dependencies.documentDeletionService.delete({
        workspaceId,
        documentId,
      });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
