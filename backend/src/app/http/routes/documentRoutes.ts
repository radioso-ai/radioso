import { Router, type Request, type Response } from "express";
import multer from "multer";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, notFound, payloadTooLarge } from "../../../shared/domain/errors.js";
import { createWebsiteCrawlerRoutes } from "../../../modules/websiteCrawler/routes.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../../modules/documents/domain/sourceConstants.js";
import { includeDebugQuerySchema, presentDocumentSearchResponse } from "../presenters/documentSearchPresenter.js";
import {
  applyDocumentEnrichmentOverridePatch,
  applySourceDocumentMetadataPatch,
  applyWebsiteCrawlSettingsPatch,
  buildWebsiteRecrawlRequest,
  presentDocumentSource,
  presentDocumentSourceList,
} from "../presenters/documentSourcePresenter.js";
import {
  chunkParamsSchema,
  documentListQuerySchema,
  documentMetadataRecordSchema,
  documentParamsSchema,
  documentRetrievalUpdateSchema,
  documentSchema,
  reprocessDocumentBodySchema,
  documentSearchHistoryParamsSchema,
  documentSearchSchema,
  sourceParamsSchema,
  sourceUpdateSchema,
} from "./documentRouteSchemas.js";

type DocumentRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  | "env"
  | "abuseControlService"
  | "auditService"
  | "chunkRepository"
  | "documentDeletionService"
  | "documentImportService"
  | "documentIngestionService"
  | "documentSourceReprocessService"
  | "documentSourceRepository"
  | "documentSearchHistoryService"
  | "documentSearchService"
  | "documentStorage"
  | "websiteCrawlJobService"
  | "websiteCrawlerProvider"
  | "usageLimitPolicy"
>;

// Multipart fields arrive as strings, so the import route carries its metadata
// as a JSON document. It is held to exactly the same scalar-record and size
// rules as the JSON body routes.
const parseImportMetadataField = (raw: unknown): Record<string, unknown> | undefined => {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw badRequest("metadata must be a JSON object encoded as a string");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw badRequest("metadata must be valid JSON");
  }

  const parsed = documentMetadataRecordSchema.safeParse(decoded);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? "metadata is invalid");
  }
  return parsed.data;
};

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
      const summary = await dependencies.documentIngestionService.summarizeSourcesForWorkspace(workspaceId);
      res.status(200).json(presentDocumentSourceList(workspaceId, summary.sources, summary.documentsWithoutSourceCount));
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
      const { url, limit, policy } = buildWebsiteRecrawlRequest(source.config);
      if (!url) {
        throw badRequest("Source has no configured URL");
      }
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
      const body = req.body as {
        crawlSettings?: Record<string, unknown>;
        documentEnrichmentOverride?: "inherit" | "on" | "off";
        documentMetadata?: Record<string, unknown>;
      };
      if (body.crawlSettings && source.kind !== "website") {
        throw badRequest("Only website sources have editable crawl settings");
      }

      let nextConfig = source.config;
      if (body.crawlSettings) {
        nextConfig = applyWebsiteCrawlSettingsPatch(nextConfig, body.crawlSettings);
      }
      if (body.documentEnrichmentOverride !== undefined) {
        nextConfig = applyDocumentEnrichmentOverridePatch(nextConfig, body.documentEnrichmentOverride);
      }
      if (body.documentMetadata !== undefined) {
        nextConfig = applySourceDocumentMetadataPatch(nextConfig, body.documentMetadata);
      }

      const updated = await dependencies.documentSourceRepository.updateConfigByIdAndWorkspaceId({
        sourceId,
        workspaceId,
        config: nextConfig,
      });

      res.status(200).json(presentDocumentSource(updated));
    } catch (error) {
      next(error);
    }
  });

  router.post("/sources/:sourceId/reprocess", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { sourceId } = sourceParamsSchema.parse(req.params);
      const body = reprocessDocumentBodySchema.parse(req.body ?? {});
      // The manually added documents are presented as a synthetic source. They
      // have no document_sources row, so they reprocess as the null-source scope
      // while the response keeps echoing the synthetic id the client asked for.
      const result = await dependencies.documentSourceReprocessService.reprocessSource({
        workspaceId,
        sourceId: sourceId === MANUALLY_ADDED_DOCUMENTS_SOURCE_ID ? null : sourceId,
        documentEnrichmentOverride: body.documentEnrichmentOverride,
      });
      res.status(202).json({ ...result, sourceId });
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
        documentEnrichmentOverride: req.body.documentEnrichmentOverride,
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
      const metadata = parseImportMetadataField(req.body?.metadata);
      const enrichmentOverrideField =
        typeof req.body?.documentEnrichmentOverride === "string" ? req.body.documentEnrichmentOverride : undefined;
      const documentEnrichmentOverride =
        enrichmentOverrideField === "on" || enrichmentOverrideField === "off" ? enrichmentOverrideField : undefined;
      const importReservation = usageReservation;
      usageReservation = null;
      const result = await dependencies.documentImportService.importDocument({
        accountId,
        workspaceId,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        title,
        metadata,
        usageReservation: importReservation,
        documentEnrichmentOverride,
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

  router.patch("/:documentId", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), validateBody(documentRetrievalUpdateSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const body = req.body as {
        retrievalEnabled?: boolean;
        retrievalExpiresAt?: string | null;
        metadata?: Record<string, unknown>;
      };
      // Metadata is replaced first so the requeue it triggers carries the new
      // tags, and the retrieval update below returns the settled document.
      let document = body.metadata !== undefined
        ? await dependencies.documentIngestionService.updateMetadata({
            workspaceId,
            documentId,
            metadata: body.metadata,
          })
        : null;
      if (body.retrievalEnabled !== undefined || body.retrievalExpiresAt !== undefined) {
        document = await dependencies.documentIngestionService.updateRetrievalEligibility({
          workspaceId,
          documentId,
          ...(body.retrievalEnabled !== undefined ? { retrievalEnabled: body.retrievalEnabled } : {}),
          ...(body.retrievalExpiresAt !== undefined
            ? { retrievalExpiresAt: body.retrievalExpiresAt === null ? null : new Date(body.retrievalExpiresAt) }
            : {}),
        });
      }
      if (!document) {
        throw badRequest("Provide retrievalEnabled, retrievalExpiresAt and/or metadata");
      }
      res.status(200).json(document);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:documentId/reprocess", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { documentId } = documentParamsSchema.parse(req.params);
      const body = reprocessDocumentBodySchema.parse(req.body ?? {});
      const result = await dependencies.documentIngestionService.reprocess({
        workspaceId,
        documentId,
        documentEnrichmentOverride: body.documentEnrichmentOverride,
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
