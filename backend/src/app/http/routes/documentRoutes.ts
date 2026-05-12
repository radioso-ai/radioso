import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { createWebsiteCrawlerRoutes } from "../../../modules/websiteCrawler/routes.js";

const MAX_DOCUMENT_LIST_LIMIT = 100;

const documentSourceSchema = z.union([
  z.object({
    id: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("website"),
    url: z.string().trim().url().refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }, "source.url must use http or https"),
  }).strict(),
]);

export const documentSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().refine(
    (val) => !val || Buffer.byteLength(JSON.stringify(val), "utf8") <= 16384,
    { message: "Metadata must be 16 KB or less" },
  ),
  externalDocumentId: z.string().trim().min(1).optional(),
  source: documentSourceSchema.optional(),
});

export const documentParamsSchema = z.object({
  documentId: z.string().uuid(),
});

export const documentSearchSchema = z.object({
  query: z.string().trim().min(1),
  metadataFilter: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const documentSearchHistoryParamsSchema = z.object({
  searchId: z.string().uuid(),
});

export const documentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_DOCUMENT_LIST_LIMIT).default(MAX_DOCUMENT_LIST_LIMIT),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

type DocumentRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  | "env"
  | "abuseControlService"
  | "auditService"
  | "documentDeletionService"
  | "documentImportService"
  | "documentIngestionService"
  | "documentSearchHistoryService"
  | "documentSearchService"
  | "websiteCrawlJobService"
  | "websiteCrawlerProvider"
  | "usageLimitPolicy"
>;

export const createDocumentRoutes = (dependencies: DocumentRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const uploadRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "document.import",
    limit: dependencies.env.UPLOAD_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.AUTH_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => String(res.locals.workspaceId ?? "unknown"),
    resolveAuditContext: (_req, res) => ({
      accountId: res.locals.accountId as string | undefined,
      workspaceId: res.locals.workspaceId as string | undefined,
    }),
  });
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

  router.get("/", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedQuery = documentListQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.documentIngestionService.listForWorkspace(workspaceId, parsedQuery.data);
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.post("/search", workspaceSession, validateBody(documentSearchSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const result = await dependencies.documentSearchService.search({
        workspaceId,
        query: req.body.query,
        metadataFilter: req.body.metadataFilter,
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/search/history", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedQuery = documentListQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.documentSearchHistoryService.listHistory(workspaceId, parsedQuery.data);
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.get("/search/history/:searchId", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { searchId } = documentSearchHistoryParamsSchema.parse(req.params);
      const search = await dependencies.documentSearchHistoryService.getHistory(workspaceId, searchId);
      res.status(200).json(search);
    } catch (error) {
      next(error);
    }
  });

  router.post("/", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), validateBody(documentSchema), async (req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId?: string; workspaceId: string };
      const result = await dependencies.documentIngestionService.ingest({
        accountId,
        workspaceId,
        title: req.body.title,
        content: req.body.content,
        metadata: req.body.metadata,
        externalDocumentId: req.body.externalDocumentId,
        source: req.body.source,
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/import", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), uploadRateLimit, async (req, res, next) => {
    let usageReservation: Awaited<ReturnType<AppDependencies["usageLimitPolicy"]["reserveDocument"]>> | null = null;
    try {
      const { accountId, workspaceId } = res.locals as { accountId?: string; workspaceId: string };
      usageReservation = await dependencies.usageLimitPolicy.reserveDocument({
        accountId,
        workspaceId,
        sourceKind: "uploaded_file",
      });
      await runUploadSingle(req, res);

      if (!req.file) {
        throw badRequest("File is required");
      }

      const title = typeof req.body?.title === "string" ? req.body.title : undefined;
      const importReservation = usageReservation;
      usageReservation = null;
      const result = await dependencies.documentImportService.importDocument({
        accountId,
        workspaceId,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        title,
        usageReservation: importReservation,
      });
      res.status(202).json(result);
    } catch (error) {
      await usageReservation?.release();
      next(error);
    }
  });

  if (dependencies.env.WEBSITE_CRAWLER_ENABLED) {
    router.use("/crawl", createWebsiteCrawlerRoutes(dependencies));
  } else {
    // Stub the crawl namespace so requests get the project's JSON ErrorResponse
    // shape (not Express's default text 404), which matches what every other
    // route returns and what generated SDK clients expect to parse.
    router.use("/crawl", (_req, _res, next) => {
      next(notFound("Website crawler is disabled for this deployment"));
    });
  }

  router.get("/:documentId", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const document = await dependencies.documentIngestionService.getDocument(workspaceId, documentId);
      res.status(200).json(document);
    } catch (error) {
      next(error);
    }
  });

  router.put("/:documentId", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), validateBody(documentSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const result = await dependencies.documentIngestionService.update({
        workspaceId,
        documentId,
        title: req.body.title,
        content: req.body.content,
        metadata: req.body.metadata,
        externalDocumentId: req.body.externalDocumentId,
        source: req.body.source,
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:documentId/reprocess", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), async (req, res, next) => {
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

  router.delete("/:documentId", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), async (req, res, next) => {
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
