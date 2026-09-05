import { z } from "zod";
import {
  documentParamsSchema,
  documentRetrievalUpdateSchema,
  documentSchema,
  reprocessDocumentBodySchema,
  documentSearchHistoryParamsSchema,
  documentSearchSchema,
  sourceParamsSchema,
  sourceUpdateSchema,
} from "../../routes/documentRouteSchemas.js";
import { crawlBodySchema } from "../../../../modules/websiteCrawler/routes.js";
import {
  retrievalAnswerSchema,
  retrievalSearchSchema,
} from "../../routes/retrievalRoutes.js";
import { skillDiagnosticSchema } from "../../../../modules/skills/public.js";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerDocumentRetrievalSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const DocumentStatusSchema = z.string().openapi("DocumentStatus");
  const RagStatusSchema = z.string().openapi("RagStatus");
  const DocumentCreateRequestSchema = registry.register("DocumentCreateRequest", documentSchema);
  const DocumentSourceSummarySchema = registry.register(
    "DocumentSourceSummary",
    z.object({
      id: z.string().uuid(),
      kind: z.enum(["website", "api", "connector", "upload"]),
      name: z.string(),
      externalId: z.string().nullable(),
    }),
  );

  const DocumentSourceCrawlSettingsSchema = registry.register(
    "DocumentSourceCrawlSettings",
    z.object({
      url: z.string().nullable(),
      limit: z.number().int().min(1),
      includeUrlPatterns: z.array(z.string()),
      excludeUrlPatterns: z.array(z.string()),
      preserveContentLinks: z.boolean(),
    }),
  );

  const DocumentSourceListItemSchema = registry.register(
    "DocumentSourceListItem",
    z.object({
      id: z.string().uuid(),
      kind: z.enum(["website", "api", "connector", "upload"]),
      name: z.string(),
      externalId: z.string().nullable(),
      lastSyncStatus: z.string().nullable(),
      lastSyncedAt: z.string().datetime().nullable(),
      documentCount: z.number().int().min(0),
      documentEnrichmentOverride: z.enum(["inherit", "on", "off"]),
      documentMetadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}).openapi({
        description:
          "Tags stamped onto every chunk produced from this source's documents. A document's own metadata wins on key collisions.",
      }),
      crawlSettings: DocumentSourceCrawlSettingsSchema.optional(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const DocumentSourceUpdateRequestSchema = registry.register(
    "DocumentSourceUpdateRequest",
    sourceUpdateSchema,
  );

  const DocumentReprocessRequestSchema = registry.register(
    "DocumentReprocessRequest",
    reprocessDocumentBodySchema,
  );

  const SourceReprocessResponseSchema = registry.register(
    "SourceReprocessResponse",
    z.object({
      sourceId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      queuedDocumentCount: z.number().int().min(0),
      skippedDocumentCount: z.number().int().min(0),
      status: z.enum(["queued", "noop"]),
    }),
  );

  const DocumentSourceListResponseSchema = registry.register(
    "DocumentSourceListResponse",
    z.object({
      sources: z.array(DocumentSourceListItemSchema),
    }),
  );

  const DocumentImportRequestSchema = registry.register(
    "DocumentImportRequest",
    z.object({
      file: z.string().openapi({
        type: "string",
        format: "binary",
        description: "Source file to import.",
      }),
      title: z.string().optional().openapi({
        description: "Optional title to use instead of the source filename.",
      }),
      documentEnrichmentOverride: z.enum(["on", "off"]).optional().openapi({
        description: "Force metadata extraction on or off for this import's processing run only.",
      }),
      metadata: z.string().optional().openapi({
        description:
          "Operator-authored metadata for the imported document, as a JSON object of string, number, boolean, or null values. 16 KB maximum.",
      }),
    }),
  );

  const DocumentOperationResponseSchema = registry.register(
    "DocumentOperationResponse",
    z.object({
      documentId: z.string().uuid(),
      status: DocumentStatusSchema,
    }),
  );
  const DocumentEnrichmentSchema = registry.register(
    "DocumentEnrichment",
    z.object({
      status: z.enum(["applied", "skipped", "failed"]),
      shape: z.enum(["event", "article", "profile", "reference", "generic"]).optional(),
      model: z.string().nullable().optional(),
      enrichedAt: z.string().datetime().nullable().optional(),
      anchorDate: z.string().nullable().optional(),
      anchorSource: z.enum(["source_last_sync", "document_created_at"]).nullable().optional(),
      factCount: z.number().int().min(0).optional(),
      appliedChunkCount: z.number().int().min(0).optional(),
      failureReason: z.string().nullable().optional(),
      matchedTypeKey: z.string().nullable().optional().openapi({
        description:
          "The document type catalog entry that matched. Equals `shape` for built-in entries; an operator-defined key otherwise.",
      }),
      catalogRevision: z.string().nullable().optional().openapi({
        description: "The catalog revision this run resolved at execution time.",
      }),
      generatedKeys: z.array(z.string()).optional().openapi({
        description:
          "The metadata keys this run generated. Extraction owns exactly these keys and replaces them on the next successful run; every other key is manually or connector owned.",
      }),
      fieldCounts: z
        .object({
          applied: z.number().int().min(0),
          droppedInvalid: z.number().int().min(0),
          droppedUndeclared: z.number().int().min(0),
          droppedDuplicate: z.number().int().min(0),
          droppedOverCap: z.number().int().min(0),
          skippedCollision: z.number().int().min(0),
        })
        .nullable()
        .optional()
        .openapi({ description: "Content-free tallies of what the run did with the model's field payload." }),
      classificationNote: z.string().nullable().optional().openapi({
        description: "Content-free note about a classification fallback on an otherwise successful run.",
      }),
    }),
  );

  const DocumentSummarySchema = registry.register(
    "DocumentSummary",
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      status: DocumentStatusSchema,
      ragStatus: RagStatusSchema,
      failureReason: z.string().nullable().optional(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
      enrichment: z.union([DocumentEnrichmentSchema, z.null()]).optional(),
      sourceId: z.string().uuid().nullable().optional(),
      source: z.union([DocumentSourceSummarySchema, z.null()]).optional(),
      externalDocumentId: z.string().nullable().optional(),
      sourceKind: z.enum(["inline_text", "uploaded_file"]),
      sourceFilename: z.string().nullable().optional(),
      sourceMimeType: z.string().nullable().optional(),
      contentSize: z.number().int().min(0).nullable().optional(),
      retrievalEnabled: z.boolean().openapi({
        description: "When false, the document is excluded from retrieval regardless of processing status.",
      }),
      retrievalExpiresAt: z.string().datetime().nullable().openapi({
        description: "Instant after which the document is auto-excluded from retrieval. Null when no expiry is set.",
      }),
    }),
  );

  const DocumentRetrievalUpdateRequestSchema = registry.register(
    "DocumentRetrievalUpdateRequest",
    documentRetrievalUpdateSchema,
  );

  const DocumentDetailsSchema = registry.register(
    "DocumentDetails",
    DocumentSummarySchema.extend({
      content: z.string(),
    }),
  );

  const DocumentListResponseSchema = registry.register(
    "DocumentListResponse",
    z.object({
      documents: z.array(DocumentSummarySchema),
      total: z.number().int().min(0),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  );

  const DocumentSearchActionSchema = registry.register(
    "DocumentSearchAction",
    z.object({
      type: z.enum(["open_document", "inspect_match_evidence", "open_history_entry", "rerun_search"]),
      status: z.enum(["available", "unavailable"]),
    }),
  );

  const DocumentSearchResultSchema = registry.register(
    "DocumentSearchResult",
    z.object({
      documentId: z.string().uuid(),
      title: z.string(),
      status: DocumentStatusSchema,
      ragStatus: RagStatusSchema,
      metadata: z.record(z.unknown()),
      score: z.number(),
      rank: z.number().int().min(1),
      matchEvidence: z.array(z.string()),
      sourceKind: z.enum(["inline_text", "uploaded_file"]),
      sourceFilename: z.string().nullable().optional(),
      sourceMimeType: z.string().nullable().optional(),
      actions: z.array(DocumentSearchActionSchema),
    }),
  );

  const DocumentSearchHistoryEntrySchema = registry.register(
    "DocumentSearchHistoryEntry",
    z.object({
      searchId: z.string().uuid(),
      query: z.string(),
      createdAt: z.string().datetime(),
      resultCount: z.number().int().min(0),
      activityTraceAvailable: z.boolean(),
      previewTopTitles: z.array(z.string()),
    }),
  );

  const DocumentSearchHistoryListResponseSchema = registry.register(
    "DocumentSearchHistoryListResponse",
    z.object({
      searches: z.array(DocumentSearchHistoryEntrySchema),
      total: z.number().int().min(0),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  );
  const DocumentSearchRequestSchema = registry.register("DocumentSearchRequest", documentSearchSchema);
  const WebsiteCrawlRequestSchema = registry.register("WebsiteCrawlRequest", crawlBodySchema);
  const WebsiteCrawlJobResponseSchema = registry.register(
    "WebsiteCrawlJobResponse",
    z.object({
      jobId: z.string().uuid(),
      sourceId: z.string().uuid().nullable(),
      requestedUrl: z.string().url(),
      status: z.literal("queued"),
    }),
  );
  const WebsiteCrawlPublicationResponseSchema = registry.register(
    "WebsiteCrawlPublicationResponse",
    z.object({
      provider: z.string(),
      runId: z.string().nullable(),
      status: z.string().nullable(),
      requestedUrl: z.string(),
      accepted: z.number().int().min(0),
      skipped: z.number().int().min(0),
      failed: z.number().int().min(0),
      documents: z.array(z.object({
        externalDocumentId: z.string(),
        documentId: z.string(),
        status: z.string(),
        sourceUrl: z.string(),
        canonicalUrl: z.string().nullable(),
      })),
      failures: z.array(z.object({
        sourceUrl: z.string(),
        reason: z.string(),
      })),
    }),
  );

  const WebsiteCrawlJobStatusSchema = registry.register(
    "WebsiteCrawlJobStatus",
    z.enum(["queued", "processing", "paused", "completed", "failed"]),
  );

  const CrawlPageFailureSchema = registry.register(
    "CrawlPageFailure",
    z.object({
      sourceUrl: z.string(),
      reason: z.string(),
    }),
  );

  const WebsiteCrawlJobSummarySchema = registry.register(
    "WebsiteCrawlJobSummary",
    z.object({
      id: z.string().uuid(),
      requestedUrl: z.string().url(),
      status: WebsiteCrawlJobStatusSchema,
      limit: z.number().int().min(1),
      sourceId: z.string().uuid().nullable(),
      documentCount: z.number().int().min(0).nullable(),
      failedPageCount: z.number().int().min(0).nullable(),
      skippedPageCount: z.number().int().min(0).nullable(),
      failures: z.array(CrawlPageFailureSchema),
      lastError: z.string().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      completedAt: z.string().datetime().nullable(),
    }),
  );

  const WebsiteCrawlJobListResponseSchema = registry.register(
    "WebsiteCrawlJobListResponse",
    z.object({
      jobs: z.array(WebsiteCrawlJobSummarySchema),
    }),
  );

  const WebsiteCrawlJobListQuerySchema = z.object({
    status: WebsiteCrawlJobStatusSchema.optional(),
    sinceMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    sourceId: z.string().uuid().optional(),
  });

  const CitationSchema = registry.register(
    "Citation",
    z.object({
      documentId: z.string().uuid(),
      chunkId: z.string().uuid(),
      title: z.string(),
      sourceUrl: z.string().url().optional(),
    }),
  );

  const AnswerSegmentSchema = registry.register(
    "AnswerSegment",
    z.object({
      text: z.string(),
      citationIndices: z.array(z.number().int().min(0)).optional(),
    }),
  );

  const ParsedQuerySchema = registry.register(
    "ParsedQuery",
    z.object({
      originalQuery: z.string().optional(),
      semanticQuery: z.string(),
      lexicalQuery: z.string(),
      constraintSummary: z.array(z.string()),
    }),
  );

  const CandidateCountsSchema = registry.register(
    "CandidateCounts",
    z.object({
      semantic: z.number().int().min(0),
      lexical: z.number().int().min(0),
      merged: z.number().int().min(0),
      final: z.number().int().min(0),
    }),
  );

  const RetrievalSubquerySchema = registry.register(
    "RetrievalSubquery",
    z.object({
      id: z.string(),
      label: z.string(),
      semanticQuery: z.string(),
      lexicalQuery: z.string(),
      reason: z.string().optional(),
      responseLanguagePolicy: z.enum(["match_user_question"]).optional(),
    }),
  );

  const AppliedConstraintSchema = registry.register(
    "AppliedConstraint",
    z.object({
      signalKey: z.string(),
      mode: z.enum(["boost_only", "hard_filter"]),
      outcome: z.enum(["applied", "relaxed", "skipped"]),
      summary: z.string(),
    }),
  );

  const RewriteInfoSchema = registry.register(
    "RewriteInfo",
    z.object({
      status: z.string(),
      eligible: z.boolean(),
      ran: z.boolean(),
      materialDisagreement: z.boolean(),
      continuityDecision: z.string().optional(),
      rejectionReason: z.string().optional(),
    }),
  );

  const RetrievalExecutionMetadataSchema = registry.register(
    "RetrievalExecutionMetadata",
    z.object({
      surface: z.enum(["assistant", "retrieval", "mcp_capability"]),
      path: z.enum([
        "assistant_direct",
        "assistant_retrieval",
        "retrieval_search",
        "retrieval_answer",
        "mcp_grounded_answer",
      ]),
      retrievalInvoked: z.boolean(),
    }),
  );

  const ActivitySummarySchema = registry.register(
    "ActivitySummary",
    z.object({
      traceId: z.string().optional(),
      skillName: z.string().optional(),
      surface: z.string().optional(),
      path: z.string().optional(),
      status: z.enum(["success", "skipped", "blocked", "failed", "fallback", "pending"]).optional(),
      outcome: z.string().optional(),
      primaryCounts: z.record(z.number()).optional(),
      assistant: z.record(z.unknown()).optional(),
      contact: z.record(z.unknown()).optional(),
      execution: RetrievalExecutionMetadataSchema.optional(),
      parsedQuery: ParsedQuerySchema.optional(),
      retrievalSubqueries: z.array(RetrievalSubquerySchema).optional(),
      retrievalSkipped: z.boolean().optional(),
      responseLanguagePolicy: z.enum(["match_user_question"]).optional(),
      candidateCounts: CandidateCountsSchema.optional(),
      appliedConstraints: z.array(AppliedConstraintSchema).optional(),
      fallbackApplied: z.boolean().optional(),
      rerankStatus: z.enum(["skipped", "applied", "fallback"]).optional(),
      rewrite: RewriteInfoSchema.optional(),
      triggerAnalysis: schemas.TriggerAnalysisSchema.optional(),
      triggerBackoff: schemas.TriggerBackoffSchema.optional(),
      shapeName: z.enum([
        "definition_lookup",
        "event_date_lookup",
        "policy_answer",
        "exploratory_summary",
        "follow_up_grounding",
        "default_hybrid",
      ]).optional(),
      queryShape: z.enum([
        "definition_lookup",
        "event_date_lookup",
        "policy_answer",
        "exploratory_summary",
        "follow_up_grounding",
        "default_hybrid",
        "general_grounding",
      ]).optional(),
      resolvedSteps: z.array(z.record(z.unknown())).optional(),
      skillDiagnostic: skillDiagnosticSchema.optional(),
    }),
  );

  const ActivityStageSchema = registry.register(
    "ActivityStage",
    z.object({
      stageId: z.string(),
      kind: z.string(),
      label: z.string(),
      status: z.enum(["applied", "skipped", "fallback", "rejected", "unavailable", "failed"]),
      startedAt: z.string().datetime().optional(),
      durationMs: z.number().int().min(0).optional(),
      settings: z.record(z.unknown()).optional(),
      inputs: z.record(z.unknown()).optional(),
      outputs: z.record(z.unknown()).optional(),
      metrics: z.record(z.number()).optional(),
      reason: z.string().optional(),
    }),
  );

  const ActivityLinkSchema = registry.register(
    "ActivityLink",
    z.object({
      fromStageId: z.string(),
      toStageId: z.string(),
      kind: z.enum(["sequence", "branch", "converge"]),
    }),
  );

  const ActivityTraceSchema = registry.register(
    "ActivityTrace",
    z.object({
      traceId: z.string(),
      startedAt: z.string().datetime(),
      completedAt: z.string().datetime().optional(),
      totalDurationMs: z.number().int().min(0).optional(),
      stages: z.array(ActivityStageSchema),
      links: z.array(ActivityLinkSchema),
      summary: ActivitySummarySchema.optional(),
    }),
  );

  const DocumentSearchResponseSchema = registry.register(
    "DocumentSearchResponse",
    z.object({
      searchId: z.string().uuid(),
      mode: z.enum(["live", "snapshot"]),
      query: z.string(),
      resultCount: z.number().int().min(0),
      results: z.array(DocumentSearchResultSchema),
      debug: z.object({
        activityTrace: ActivityTraceSchema,
      }).optional(),
    }),
  );

  const RetrievalAgentScopeSchema = registry.register(
    "RetrievalAgentScope",
    z.object({
      agentId: z.string().uuid(),
      retrievalEnabled: z.boolean(),
    }).nullable(),
  );

  const RetrievalSearchRequestSchema = registry.register("RetrievalSearchRequest", retrievalSearchSchema);
  const RetrievalAnswerRequestSchema = registry.register("RetrievalAnswerRequest", retrievalAnswerSchema);

  const RetrievalSearchEvidenceSchema = registry.register(
    "RetrievalSearchEvidence",
    z.object({
      documentId: z.string().uuid(),
      chunkId: z.string().uuid(),
      title: z.string(),
      content: z.string(),
      metadata: z.record(z.unknown()).optional(),
      score: z.number().optional(),
    }),
  );

  const RetrievalSearchResponseSchema = registry.register(
    "RetrievalSearchResponse",
    z.object({
      outcome: z.literal("results"),
      agentScope: RetrievalAgentScopeSchema,
      rewrittenQuery: z.object({
        semantic: z.string(),
        lexical: z.string(),
      }),
      results: z.array(RetrievalSearchEvidenceSchema),
      debug: z.object({
        activitySummary: ActivitySummarySchema,
        activityTrace: ActivityTraceSchema,
      }).optional(),
    }),
  );

  const RetrievalAnswerEvidenceSchema = registry.register(
    "RetrievalAnswerEvidence",
    z.object({
      documentId: z.string().uuid(),
      chunkId: z.string().uuid(),
      title: z.string(),
      content: z.string(),
      metadata: z.record(z.unknown()).optional(),
      score: z.number().optional(),
    }),
  );

  const RetrievalAnswerSuccessSchema = registry.register(
    "RetrievalAnswerSuccess",
    z.object({
      outcome: z.literal("answer"),
      agentScope: RetrievalAgentScopeSchema,
      answer: z.string(),
      citations: z.array(CitationSchema).optional(),
      validation: z.object({
        status: z.enum(["supported", "unsupported", "not_checked"]),
      }),
      debug: z.object({
        evidence: z.array(RetrievalAnswerEvidenceSchema),
        activitySummary: ActivitySummarySchema,
        activityTrace: ActivityTraceSchema,
      }).optional(),
    }),
  );

  const RetrievalAnswerResponseSchema = registry.register(
    "RetrievalAnswerResponse",
    RetrievalAnswerSuccessSchema,
  );

  const sourceParamsSchema = z.object({
    sourceId: z.string().uuid(),
  });

  const DocumentSourceDocumentsQuerySchema = z.object({
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
    cursor: z.string().min(1).optional(),
  });

  Object.assign(schemas, {
    documentParamsSchema,
    documentSchema,
    documentSearchHistoryParamsSchema,
    sourceParamsSchema,
    DocumentSourceDocumentsQuerySchema,
    DocumentStatusSchema,
    RagStatusSchema,
    DocumentCreateRequestSchema,
    DocumentSourceSummarySchema,
    DocumentSourceCrawlSettingsSchema,
    DocumentSourceListItemSchema,
    DocumentSourceUpdateRequestSchema,
    DocumentReprocessRequestSchema,
    SourceReprocessResponseSchema,
    DocumentSourceListResponseSchema,
    DocumentImportRequestSchema,
    DocumentOperationResponseSchema,
    DocumentEnrichmentSchema,
    DocumentSummarySchema,
    DocumentRetrievalUpdateRequestSchema,
    DocumentDetailsSchema,
    DocumentListResponseSchema,
    DocumentSearchActionSchema,
    DocumentSearchResultSchema,
    DocumentSearchHistoryEntrySchema,
    DocumentSearchHistoryListResponseSchema,
    DocumentSearchRequestSchema,
    WebsiteCrawlRequestSchema,
    CrawlPageFailureSchema,
    WebsiteCrawlJobResponseSchema,
    WebsiteCrawlPublicationResponseSchema,
    WebsiteCrawlJobStatusSchema,
    WebsiteCrawlJobSummarySchema,
    WebsiteCrawlJobListResponseSchema,
    WebsiteCrawlJobListQuerySchema,
    CitationSchema,
    AnswerSegmentSchema,
    ParsedQuerySchema,
    CandidateCountsSchema,
    RetrievalSubquerySchema,
    AppliedConstraintSchema,
    RewriteInfoSchema,
    RetrievalExecutionMetadataSchema,
    ActivitySummarySchema,
    ActivityStageSchema,
    ActivityLinkSchema,
    ActivityTraceSchema,
    DocumentSearchResponseSchema,
    RetrievalSearchRequestSchema,
    RetrievalAnswerRequestSchema,
    RetrievalSearchEvidenceSchema,
    RetrievalSearchResponseSchema,
    RetrievalAnswerEvidenceSchema,
    RetrievalAnswerSuccessSchema,
    RetrievalAnswerResponseSchema,
  });
};
