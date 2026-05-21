import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, notFound, payloadTooLarge } from "../../../shared/domain/errors.js";
import { createWebsiteCrawlerRoutes } from "../../../modules/websiteCrawler/routes.js";
import { resolveWebsiteCrawlerConfig } from "../../../modules/websiteCrawler/config.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../../modules/documents/domain/sourceConstants.js";
import { includeDebugQuerySchema, presentDocumentSearchResponse } from "../presenters/documentSearchPresenter.js";

const MAX_DOCUMENT_LIST_LIMIT = 100;

const sourceParamsSchema = z.object({
  sourceId: z.string().uuid(),
});

const crawlPatternSchema = z.array(z.string().trim().min(1).max(200)).max(50);

const sourceUpdateSchema = z.object({
  crawlSettings: z
    .object({
      limit: z.number().int().min(1).optional(),
      includeUrlPatterns: crawlPatternSchema.optional(),
      excludeUrlPatterns: crawlPatternSchema.optional(),
      preserveContentLinks: z.boolean().optional(),
    })
    .refine(
      (value) =>
        value.limit !== undefined ||
        value.includeUrlPatterns !== undefined ||
        value.excludeUrlPatterns !== undefined ||
        value.preserveContentLinks !== undefined,
      { message: "crawlSettings must include at least one field" },
    )
    .optional(),
});

const toCrawlSettings = (config: Record<string, unknown>) => {
  const policy = config.policy && typeof config.policy === "object" && !Array.isArray(config.policy)
    ? (config.policy as Record<string, unknown>)
    : {};
  const includeUrlPatterns = Array.isArray(policy.includeUrlPatterns)
    ? policy.includeUrlPatterns.filter((value): value is string => typeof value === "string")
    : [];
  const excludeUrlPatterns = Array.isArray(policy.excludeUrlPatterns)
    ? policy.excludeUrlPatterns.filter((value): value is string => typeof value === "string")
    : [];
  return {
    url: typeof config.url === "string" ? config.url : null,
    limit:
      typeof config.limit === "number" && Number.isInteger(config.limit) && config.limit > 0
        ? config.limit
        : resolveWebsiteCrawlerConfig().defaultLimit,
    includeUrlPatterns,
    excludeUrlPatterns,
    preserveContentLinks: typeof policy.preserveContentLinks === "boolean" ? policy.preserveContentLinks : true,
  };
};

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
  includeDebug: z.boolean().optional().default(false),
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
  | "chunkRepository"
  | "documentDeletionService"
  | "documentImportService"
  | "documentIngestionService"
  | "documentSourceRepository"
  | "documentSearchHistoryService"
  | "documentSearchService"
  | "documentStorage"
  | "websiteCrawlJobService"
  | "websiteCrawlerProvider"
  | "usageLimitPolicy"
>;

export const chunkParamsSchema = z.object({
  documentId: z.string().uuid(),
  chunkId: z.string().uuid(),
});

export const createDocumentRoutes = (dependencies: DocumentRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const documentsRead = requireWorkspacePermission(dependencies, "workspace.documents.read");
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
          reject(payloadTooLarge("Uploaded file exceeds maximum size"));
          return;
        }

        reject(error);
      });
    });

  router.get("/", workspaceSession, documentsRead, async (req, res, next) => {
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

  router.get("/sources", workspaceSession, documentsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const [sources, documentsWithoutSourceCount] = await Promise.all([
        dependencies.documentSourceRepository.listByWorkspaceIdWithDocumentCounts(workspaceId),
        dependencies.documentSourceRepository.countDocumentsWithoutSource(workspaceId),
      ]);
      const syntheticSourceRows: typeof sources = [];

      if (documentsWithoutSourceCount > 0) {
        syntheticSourceRows.push({
          id: MANUALLY_ADDED_DOCUMENTS_SOURCE_ID,
          workspaceId,
          kind: "upload",
          name: "Manually added documents",
          externalId: null,
          config: {},
          metadata: {},
          lastSyncStatus: null,
          lastSyncedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          documentCount: documentsWithoutSourceCount,
        });
      }

      const allSources = [...sources, ...syntheticSourceRows];
      res.status(200).json({
        sources: allSources.map((source) => ({
          id: source.id,
          kind: source.kind,
          name: source.name,
          externalId: source.externalId,
          lastSyncStatus: source.lastSyncStatus,
          lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
          createdAt: source.createdAt.toISOString(),
          updatedAt: source.updatedAt.toISOString(),
          documentCount: source.documentCount,
          ...(source.kind === "website" ? { crawlSettings: toCrawlSettings(source.config) } : {}),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/sources/:sourceId/documents", workspaceSession, documentsRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { sourceId } = sourceParamsSchema.parse(req.params);
      const parsedQuery = documentListQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const resolvedSourceId = sourceId === MANUALLY_ADDED_DOCUMENTS_SOURCE_ID ? null : sourceId;
      if (resolvedSourceId !== null) {
        const source = await dependencies.documentSourceRepository.findByIdAndWorkspaceId(resolvedSourceId, workspaceId);
        if (!source) {
          throw notFound("Source not found");
        }
      }
      const page = await dependencies.documentIngestionService.listForSource(workspaceId, resolvedSourceId, parsedQuery.data);
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.post("/sources/:sourceId/recrawl", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      const { sourceId } = sourceParamsSchema.parse(req.params);
      const source = await dependencies.documentSourceRepository.findByIdAndWorkspaceId(sourceId, workspaceId);
      if (!source) {
        throw notFound("Source not found");
      }
      if (source.kind !== "website") {
        throw badRequest("Only website sources can be recrawled");
      }
      const url = typeof source.config.url === "string" ? source.config.url : null;
      if (!url) {
        throw badRequest("Source has no configured URL");
      }
      const config = resolveWebsiteCrawlerConfig();
      const previousLimit = typeof source.config.limit === "number" ? source.config.limit : config.defaultLimit;
      const limit = Math.min(previousLimit, config.maxLimit);
      const policy = source.config.policy && typeof source.config.policy === "object" && !Array.isArray(source.config.policy)
        ? source.config.policy as Record<string, unknown>
        : undefined;
      const result = await dependencies.websiteCrawlJobService.enqueue({
        accountId,
        workspaceId,
        url,
        limit,
        policy,
      });
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/sources/:sourceId/pause-crawl", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { sourceId } = sourceParamsSchema.parse(req.params);
      const source = await dependencies.documentSourceRepository.findByIdAndWorkspaceId(sourceId, workspaceId);
      if (!source) {
        throw notFound("Source not found");
      }
      if (source.kind !== "website") {
        throw badRequest("Only website sources can be paused");
      }
      const result = await dependencies.websiteCrawlJobService.pauseJobsForSource({ workspaceId, sourceId });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/sources/:sourceId/resume-crawl", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { sourceId } = sourceParamsSchema.parse(req.params);
      const source = await dependencies.documentSourceRepository.findByIdAndWorkspaceId(sourceId, workspaceId);
      if (!source) {
        throw notFound("Source not found");
      }
      if (source.kind !== "website") {
        throw badRequest("Only website sources can be resumed");
      }
      const result = await dependencies.websiteCrawlJobService.resumeJobsForSource({ workspaceId, sourceId });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/sources/:sourceId", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), validateBody(sourceUpdateSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { sourceId } = sourceParamsSchema.parse(req.params);
      if (sourceId === MANUALLY_ADDED_DOCUMENTS_SOURCE_ID) {
        throw badRequest("The manually added documents source cannot be edited");
      }
      const source = await dependencies.documentSourceRepository.findByIdAndWorkspaceId(sourceId, workspaceId);
      if (!source) {
        throw notFound("Source not found");
      }
      if (source.kind !== "website") {
        throw badRequest("Only website sources have editable crawl settings");
      }

      const crawlInput = (req.body as { crawlSettings?: Record<string, unknown> }).crawlSettings;
      if (!crawlInput) {
        res.status(200).json({
          id: source.id,
          kind: source.kind,
          name: source.name,
          externalId: source.externalId,
          lastSyncStatus: source.lastSyncStatus,
          lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
          createdAt: source.createdAt.toISOString(),
          updatedAt: source.updatedAt.toISOString(),
          documentCount: 0,
          crawlSettings: toCrawlSettings(source.config),
        });
        return;
      }

      const previous = toCrawlSettings(source.config);
      const crawlerConfig = resolveWebsiteCrawlerConfig();
      const nextLimit = crawlInput.limit !== undefined ? Math.min(crawlInput.limit as number, crawlerConfig.maxLimit) : previous.limit;
      const nextIncludeUrlPatterns = crawlInput.includeUrlPatterns !== undefined
        ? (crawlInput.includeUrlPatterns as string[])
        : previous.includeUrlPatterns;
      const nextExcludeUrlPatterns = crawlInput.excludeUrlPatterns !== undefined
        ? (crawlInput.excludeUrlPatterns as string[])
        : previous.excludeUrlPatterns;
      const nextPreserveContentLinks = crawlInput.preserveContentLinks !== undefined
        ? (crawlInput.preserveContentLinks as boolean)
        : previous.preserveContentLinks;

      const nextConfig: Record<string, unknown> = {
        ...source.config,
        limit: nextLimit,
        policy: {
          includeUrlPatterns: nextIncludeUrlPatterns,
          excludeUrlPatterns: nextExcludeUrlPatterns,
          preserveContentLinks: nextPreserveContentLinks,
        },
      };

      const updated = await dependencies.documentSourceRepository.updateConfigByIdAndWorkspaceId({
        sourceId,
        workspaceId,
        config: nextConfig,
      });

      res.status(200).json({
        id: updated.id,
        kind: updated.kind,
        name: updated.name,
        externalId: updated.externalId,
        lastSyncStatus: updated.lastSyncStatus,
        lastSyncedAt: updated.lastSyncedAt?.toISOString() ?? null,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
        documentCount: 0,
        crawlSettings: toCrawlSettings(updated.config),
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/sources/:sourceId", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { sourceId } = sourceParamsSchema.parse(req.params);
      if (sourceId === MANUALLY_ADDED_DOCUMENTS_SOURCE_ID) {
        throw badRequest("The manually added documents source cannot be deleted");
      }
      const source = await dependencies.documentSourceRepository.findByIdAndWorkspaceId(sourceId, workspaceId);
      if (!source) {
        throw notFound("Source not found");
      }
      await dependencies.websiteCrawlJobService.cancelJobsForSource({ workspaceId, sourceId });
      await dependencies.documentIngestionService.deleteSourceWithDocuments({
        workspaceId,
        sourceId,
        documentStorage: dependencies.documentStorage,
      });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post("/search", workspaceSession, documentsRead, validateBody(documentSearchSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const executionSurface = req.header("x-radioso-capability-client") === "mcp" ? "mcp_capability" : "documents";
      const result = await dependencies.documentSearchService.search({
        workspaceId,
        query: req.body.query,
        metadataFilter: req.body.metadataFilter,
        executionSurface,
      });
      res.status(200).json(presentDocumentSearchResponse(result, req.body.includeDebug));
    } catch (error) {
      next(error);
    }
  });

  router.get("/search/history", workspaceSession, documentsRead, async (req, res, next) => {
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

  router.get("/search/history/:searchId", workspaceSession, documentsRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { searchId } = documentSearchHistoryParamsSchema.parse(req.params);
      const parsedQuery = includeDebugQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const search = await dependencies.documentSearchHistoryService.getHistory(workspaceId, searchId);
      res.status(200).json(presentDocumentSearchResponse(search, parsedQuery.data.includeDebug));
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

  router.get("/:documentId", workspaceSession, documentsRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const document = await dependencies.documentIngestionService.getDocument(workspaceId, documentId);
      res.status(200).json(document);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:documentId/chunks", workspaceSession, documentsRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      await dependencies.documentIngestionService.getDocument(workspaceId, documentId);
      const chunks = await dependencies.chunkRepository.listSummariesForDocument({
        documentId,
        workspaceId,
      });
      res.status(200).json({ documentId, chunks });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:documentId/chunks/:chunkId", workspaceSession, documentsRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId, chunkId } = chunkParamsSchema.parse(req.params);
      const chunk = await dependencies.chunkRepository.findByIdForDocument({
        chunkId,
        documentId,
        workspaceId,
      });
      if (!chunk) {
        throw notFound("Chunk not found");
      }
      res.status(200).json({
        ...chunk,
        createdAt: chunk.createdAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/:documentId", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), validateBody(documentSchema), async (req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId?: string; workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const result = await dependencies.documentIngestionService.update({
        accountId,
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
