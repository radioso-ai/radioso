import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireApiToken } from "../middleware/requireApiToken.js";
import { validateBody } from "../middleware/validate.js";

const documentSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
});

const documentParamsSchema = z.object({
  documentId: z.string().uuid(),
});

export const createDocumentRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/", requireApiToken(dependencies), async (_req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const documents = await dependencies.documentIngestionService.listForAccount(accountId);
      res.status(200).json({ documents });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", requireApiToken(dependencies), validateBody(documentSchema), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const result = await dependencies.documentIngestionService.ingest({
        accountId,
        title: req.body.title,
        content: req.body.content,
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:documentId", requireApiToken(dependencies), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const document = await dependencies.documentIngestionService.getDocument(accountId, documentId);
      res.status(200).json(document);
    } catch (error) {
      next(error);
    }
  });

  router.put("/:documentId", requireApiToken(dependencies), validateBody(documentSchema), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const result = await dependencies.documentIngestionService.update({
        accountId,
        documentId,
        title: req.body.title,
        content: req.body.content,
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:documentId/reprocess", requireApiToken(dependencies), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const result = await dependencies.documentIngestionService.reprocess({
        accountId,
        documentId,
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:documentId", requireApiToken(dependencies), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      await dependencies.documentDeletionService.delete({
        accountId,
        documentId,
      });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
