import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireApiToken } from "../middleware/requireApiToken.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest } from "../../../shared/domain/errors.js";

export const documentSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().refine(
    (val) => !val || Buffer.byteLength(JSON.stringify(val), "utf8") <= 16384,
    { message: "Metadata must be 16 KB or less" },
  ),
});

export const documentParamsSchema = z.object({
  documentId: z.string().uuid(),
});

export const createDocumentRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: dependencies.env.DOCUMENT_UPLOAD_MAX_BYTES,
    },
  });

  const runUploadSingle = (req: Request, res: Response) =>
    new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (error) => {
        if (!error) {
          resolve();
          return;
        }

        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
          reject(badRequest("Uploaded file exceeds maximum size"));
          return;
        }

        reject(error);
      });
    });

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

  router.post("/import", requireApiToken(dependencies), async (req, res, next) => {
    try {
      await runUploadSingle(req, res);

      const { workspaceId } = res.locals as { workspaceId: string };
      if (!req.file) {
        throw badRequest("File is required");
      }

      const title = typeof req.body?.title === "string" ? req.body.title : undefined;
      const result = await dependencies.documentImportService.importDocument({
        workspaceId,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        title,
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
