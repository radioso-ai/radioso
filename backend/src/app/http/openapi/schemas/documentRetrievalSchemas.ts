import { z } from "zod";
import {
  documentParamsSchema,
  documentSchema,
  documentSearchHistoryParamsSchema,
  documentSearchSchema,
} from "../../routes/documentRoutes.js";
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
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
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
    }),
  );

  const DocumentOperationResponseSchema = registry.register(
    "DocumentOperationResponse",
    z.object({
      documentId: z.string().uuid(),
      status: DocumentStatusSchema,
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
      sourceId: z.string().uuid().nullable().optional(),
      source: DocumentSourceSummarySchema.nullable().optional(),
      externalDocumentId: z.string().nullable().optional(),
      sourceKind: z.enum(["inline_text", "uploaded_file"]),
      sourceFilename: z.string().nullable().optional(),
      sourceMimeType: z.string().nullable().optional(),
    }),
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
      traceAvailable: z.boolean(),
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
    z.enum(["queued", "processing", "completed", "failed"]),
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
  });

  const CitationSchema = registry.register(
    "Citation",
    z.object({
      documentId: z.string().uuid(),
      chunkId: z.string().uuid(),
      title: z.string(),
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

  const RetrievalInfoSchema = registry.register(
    "RetrievalInfo",
    z.object({
      execution: RetrievalExecutionMetadataSchema.optional(),
      parsedQuery: ParsedQuerySchema.optional(),
      retrievalSubqueries: z.array(RetrievalSubquerySchema).optional(),
      responseIntent: z.enum(["retrieval", "social_only", "assistant_identity"]).optional().openapi({
        description: "High-level user-turn intent inferred before routing. This is independent from the assistant route reason.",
      }),
      retrievalSkipped: z.boolean().optional(),
      intentConfidence: z.number().min(0).max(1).optional(),
      intentFallbackApplied: z.boolean().optional(),
      responseLanguagePolicy: z.enum(["match_user_question"]).optional(),
      candidateCounts: CandidateCountsSchema,
      appliedConstraints: z.array(AppliedConstraintSchema).optional(),
      fallbackApplied: z.boolean(),
      rerankStatus: z.enum(["skipped", "applied", "fallback"]),
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

  const RetrievalTraceStageSchema = registry.register(
    "RetrievalTraceStage",
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

  const RetrievalTraceLinkSchema = registry.register(
    "RetrievalTraceLink",
    z.object({
      fromStageId: z.string(),
      toStageId: z.string(),
      kind: z.enum(["sequence", "branch", "converge"]),
    }),
  );

  const RetrievalTraceSchema = registry.register(
    "RetrievalTrace",
    z.object({
      traceId: z.string(),
      startedAt: z.string().datetime(),
      completedAt: z.string().datetime().optional(),
      totalDurationMs: z.number().int().min(0).optional(),
      stages: z.array(RetrievalTraceStageSchema),
      links: z.array(RetrievalTraceLinkSchema),
      summary: RetrievalInfoSchema.optional(),
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
      retrievalTrace: RetrievalTraceSchema.optional(),
    }),
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
      rewrittenQuery: z.object({
        semantic: z.string(),
        lexical: z.string(),
      }),
      results: z.array(RetrievalSearchEvidenceSchema),
      retrievalInfo: RetrievalInfoSchema,
      retrievalTrace: RetrievalTraceSchema,
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
    }),
  );

  const RetrievalAnswerSuccessSchema = registry.register(
    "RetrievalAnswerSuccess",
    z.object({
      outcome: z.literal("answer"),
      answer: z.string(),
      citations: z.array(CitationSchema).optional(),
      evidence: z.array(RetrievalAnswerEvidenceSchema),
      validation: z.object({
        status: z.enum(["supported", "unsupported", "not_checked"]),
      }),
      retrievalInfo: RetrievalInfoSchema,
      retrievalTrace: RetrievalTraceSchema,
    }),
  );

  const RetrievalAnswerUnsupportedSchema = registry.register(
    "RetrievalAnswerUnsupported",
    z.object({
      outcome: z.literal("unsupported"),
      code: z.literal("unsupported_query_type"),
      reason: z.enum(["social_only", "assistant_identity"]),
      message: z.literal("This request is outside retrieval scope."),
    }),
  );

  const RetrievalAnswerResponseSchema = registry.register(
    "RetrievalAnswerResponse",
    z.union([RetrievalAnswerSuccessSchema, RetrievalAnswerUnsupportedSchema]),
  );

  Object.assign(schemas, {
    documentParamsSchema,
    documentSchema,
    documentSearchHistoryParamsSchema,
    DocumentStatusSchema,
    RagStatusSchema,
    DocumentCreateRequestSchema,
    DocumentSourceSummarySchema,
    DocumentSourceListItemSchema,
    DocumentSourceListResponseSchema,
    DocumentImportRequestSchema,
    DocumentOperationResponseSchema,
    DocumentSummarySchema,
    DocumentDetailsSchema,
    DocumentListResponseSchema,
    DocumentSearchActionSchema,
    DocumentSearchResultSchema,
    DocumentSearchHistoryEntrySchema,
    DocumentSearchHistoryListResponseSchema,
    DocumentSearchRequestSchema,
    WebsiteCrawlRequestSchema,
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
    RetrievalInfoSchema,
    RetrievalTraceStageSchema,
    RetrievalTraceLinkSchema,
    RetrievalTraceSchema,
    DocumentSearchResponseSchema,
    RetrievalSearchRequestSchema,
    RetrievalAnswerRequestSchema,
    RetrievalSearchEvidenceSchema,
    RetrievalSearchResponseSchema,
    RetrievalAnswerEvidenceSchema,
    RetrievalAnswerSuccessSchema,
    RetrievalAnswerUnsupportedSchema,
    RetrievalAnswerResponseSchema,
  });
};
