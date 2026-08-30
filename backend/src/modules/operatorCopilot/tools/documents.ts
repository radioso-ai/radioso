import { z } from "zod";

import type { ChunkRepositoryPort } from "../../documents/contracts/index.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";
import { notFound } from "../../../shared/domain/errors.js";

const unknownRecord = z.record(z.unknown());
const documentAttentionStatuses = ["failed", "queued", "processing"] as const;
const documentAttentionLimit = 25;
const documentSearchInputSchema = z.object({ query: z.string().min(1).max(1000) });
const documentSearchOutputSchema = z.object({ results: z.array(unknownRecord) });
const documentStatusInputSchema = z.object({});
const documentStatusOutputSchema = z.object({
  counts: z.object({ total: z.number(), ready: z.number(), pending: z.number(), failed: z.number() }),
  attention: z.array(unknownRecord),
  sources: z.array(unknownRecord),
});
const documentChunkPageLimit = 10;
const documentChunksInputSchema = z.object({
  documentId: z.string().uuid(),
  startChunkIndex: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(documentChunkPageLimit).default(5),
}).strict();
const documentChunkSchema = z.object({
  id: z.string(),
  chunkIndex: z.number().int().min(0),
  content: z.string(),
  searchText: z.string().nullable(),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  metadata: unknownRecord,
  dateFrom: z.string().nullable(),
  dateTo: z.string().nullable(),
  createdAt: z.string().datetime(),
  embedding: z.object({ present: z.boolean(), dimensions: z.number().int().positive().nullable() }),
});
const documentChunksOutputSchema = z.object({
  documentId: z.string().uuid(),
  startChunkIndex: z.number().int().min(0),
  limit: z.number().int().min(1).max(documentChunkPageLimit),
  totalChunks: z.number().int().min(0),
  chunks: z.array(documentChunkSchema).max(documentChunkPageLimit),
  unavailableChunkIds: z.array(z.string()),
  nextChunkIndex: z.number().int().min(0).nullable(),
});
const reprocessDocumentInputSchema = z.object({
  documentId: z.string().uuid().optional(),
  sourceId: z.string().uuid().optional(),
  documentEnrichmentOverride: z.enum(["on", "off"]).optional(),
}).strict().superRefine((input, issueContext) => {
  if ((input.documentId ? 1 : 0) + (input.sourceId ? 1 : 0) !== 1) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of documentId or sourceId",
      path: ["documentId"],
    });
  }
});
const reprocessDocumentOutputSchema = z.object({
  target: z.object({ type: z.enum(["document", "source"]), id: z.string() }),
  status: z.enum(["queued", "noop"]),
  queuedDocumentCount: z.number().int().min(0),
  skippedDocumentCount: z.number().int().min(0),
});
const recrawlSourceInputSchema = z.object({ sourceId: z.string().uuid() }).strict();
const recrawlSourceOutputSchema = z.object({
  jobId: z.string(),
  sourceId: z.string().nullable(),
  requestedUrl: z.string().url(),
  status: z.literal("queued"),
});

export interface CopilotDocumentSearchPort {
  search(input: { workspaceId: string; query: string; executionSurface: "operator_copilot" }): Promise<{ results: ReadonlyArray<unknown> }>;
}
export interface CopilotDocumentStatusPort {
  summarizeWorkspace(workspaceId: string): Promise<{ documentCount: number; readyDocumentCount: number; pendingDocumentCount: number; failedDocumentCount: number }>;
  listByStatuses(workspaceId: string, statuses: ReadonlyArray<string>, input: { limit: number }): Promise<ReadonlyArray<{ id: string; title: string; status: string; failureReason?: string | null; updatedAt: Date; sourceId?: string | null }>>;
}
export interface CopilotDocumentSourceStatusPort {
  summarizeSourcesForWorkspace(workspaceId: string): Promise<{
    sources: ReadonlyArray<{ id: string; kind: string; name: string; lastSyncStatus: string | null; lastSyncedAt: Date | null; documentCount: number }>;
    documentsWithoutSourceCount: number;
  }>;
}
export type CopilotDocumentChunksPort = Pick<ChunkRepositoryPort, "listPageForDocument">;
export interface CopilotDocumentMaintenancePort {
  reprocessDocument(input: {
    documentId: string;
    workspaceId: string;
    documentEnrichmentOverride?: "on" | "off";
  }): Promise<{
    documentId: string;
    status: "queued" | "noop";
    queuedDocumentCount: number;
    skippedDocumentCount: number;
  }>;
  reprocessSource(input: {
    sourceId: string;
    workspaceId: string;
    documentEnrichmentOverride?: "on" | "off";
  }): Promise<{
    workspaceId: string;
    sourceId: string | null;
    queuedDocumentCount: number;
    skippedDocumentCount: number;
    status: "queued" | "noop";
  }>;
  recrawlSource(input: { accountId: string; sourceId: string; workspaceId: string }): Promise<{
    jobId: string;
    sourceId: string | null;
    requestedUrl: string;
    status: "queued";
  }>;
}
export interface DocumentSearchCopilotToolDependencies { readonly documentSearchService: CopilotDocumentSearchPort; }
export interface DocumentStatusCopilotToolDependencies { readonly documentStatusService: CopilotDocumentStatusPort; readonly documentSourceStatusService: CopilotDocumentSourceStatusPort; }
export interface DocumentKnowledgeCopilotToolDependencies {
  readonly documentChunks: CopilotDocumentChunksPort;
  readonly documentMaintenance: CopilotDocumentMaintenancePort;
}

export const createDocumentSearchCopilotTools = (deps: DocumentSearchCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "document_search", shape: "read", uiLabel: "Searching documents", contributingModule: "documents", dashboardSubject: { type: "document" }, requiredPermissions: ["workspace.documents.read"],
    description: "Search workspace documents and return matching document metadata and quoted evidence snippets — the only document text available to you.",
    inputSchema: documentSearchInputSchema, outputSchema: documentSearchOutputSchema,
    createTool: (context) => ({ name: "document_search", description: "Search workspace documents and return matching document metadata and quoted evidence snippets — the only document text available to you.", inputSchema: documentSearchInputSchema, outputSchema: documentSearchOutputSchema, invoke: async ({ query }) => ({ results: boundPayload({ results: (await deps.documentSearchService.search({ workspaceId: context.workspaceId, query, executionSurface: "operator_copilot" })).results as Record<string, unknown>[] }).results as Record<string, unknown>[] }) }),
  },
];

export const createDocumentStatusCopilotTools = (deps: DocumentStatusCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "document_status", shape: "read", uiLabel: "Checking document status", contributingModule: "documents", dashboardSubject: { type: "document" }, requiredPermissions: ["workspace.documents.read"],
    description: "Read knowledge base processing state: document counts by status, documents needing attention, and document source sync state. Returns titles, statuses, and failure reasons — never document content.",
    inputSchema: documentStatusInputSchema, outputSchema: documentStatusOutputSchema,
    createTool: (context) => ({
      name: "document_status",
      description: "Read knowledge base processing state: document counts by status, documents needing attention, and document source sync state. Returns titles, statuses, and failure reasons — never document content.",
      inputSchema: documentStatusInputSchema,
      outputSchema: documentStatusOutputSchema,
      invoke: async () => {
        const [summary, attention, sources] = await Promise.all([
          deps.documentStatusService.summarizeWorkspace(context.workspaceId),
          deps.documentStatusService.listByStatuses(context.workspaceId, documentAttentionStatuses, { limit: documentAttentionLimit }),
          deps.documentSourceStatusService.summarizeSourcesForWorkspace(context.workspaceId),
        ]);
        return boundPayload({
          counts: { total: summary.documentCount, ready: summary.readyDocumentCount, pending: summary.pendingDocumentCount, failed: summary.failedDocumentCount },
          attention: attention.map((document) => ({ id: document.id, title: document.title, status: document.status, failureReason: document.failureReason ?? null, updatedAt: document.updatedAt.toISOString(), sourceId: document.sourceId ?? null })),
          sources: sources.sources.map((source) => ({ id: source.id, kind: source.kind, label: source.name, lastSyncStatus: source.lastSyncStatus, lastSyncedAt: source.lastSyncedAt ? source.lastSyncedAt.toISOString() : null, documentCount: source.documentCount })),
        }) as z.infer<typeof documentStatusOutputSchema>;
      },
    }),
  },
];

const DOCUMENT_CHUNKS_DESCRIPTION = `Inspect how one workspace document was chunked. Returns complete, untruncated text, offsets, metadata, search text, and active-embedding presence for at most ${documentChunkPageLimit} chunks starting at a chunk index. Follow nextChunkIndex to continue; use a small range because chunk text is intentionally not compacted.`;
const REPROCESS_DOCUMENT_DESCRIPTION = "Requeue one existing document, or the existing documents belonging to one source, through the normal processing pipeline. This is an idempotent maintenance act: it does not create content, change settings, or reprocess a whole workspace.";
const RECRAWL_SOURCE_DESCRIPTION = "Recrawl one existing configured website source using its stored URL, bounded page limit, and crawl policy. This cannot create a new source or accept a different URL.";

export const createDocumentKnowledgeCopilotTools = (
  deps: DocumentKnowledgeCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "document_chunks",
    shape: "read",
    uiLabel: "Inspecting document chunks",
    contributingModule: "documents",
    dashboardSubject: { type: "document" },
    requiredPermissions: ["workspace.documents.read"],
    description: DOCUMENT_CHUNKS_DESCRIPTION,
    inputSchema: documentChunksInputSchema,
    outputSchema: documentChunksOutputSchema,
    createTool: (context) => ({
      name: "document_chunks",
      description: DOCUMENT_CHUNKS_DESCRIPTION,
      inputSchema: documentChunksInputSchema,
      outputSchema: documentChunksOutputSchema,
      invoke: async ({ documentId, startChunkIndex, limit }) => {
        const page = await deps.documentChunks.listPageForDocument({
          documentId,
          workspaceId: context.workspaceId,
          startChunkIndex,
          limit,
        });
        if (!page) throw notFound("Document not found");

        return documentChunksOutputSchema.parse({
          documentId,
          startChunkIndex,
          limit,
          totalChunks: page.totalChunks,
          chunks: page.chunks.map((detail) => ({
            id: detail.id,
            chunkIndex: detail.chunkIndex,
            content: detail.content,
            searchText: detail.searchText,
            startOffset: detail.startOffset,
            endOffset: detail.endOffset,
            metadata: detail.metadata,
            dateFrom: detail.dateFrom ?? null,
            dateTo: detail.dateTo ?? null,
            createdAt: detail.createdAt.toISOString(),
            embedding: {
              present: detail.embeddingDimensions !== null,
              dimensions: detail.embeddingDimensions,
            },
          })),
          unavailableChunkIds: [],
          nextChunkIndex: page.nextChunkIndex,
        });
      },
    }),
    describeEntity: ({ documentId }) => ({ type: "document", id: documentId }),
    describeOutputEntity: (output) => ({ type: "document", id: (output as z.infer<typeof documentChunksOutputSchema>).documentId }),
  },
  {
    name: "reprocess_document",
    shape: "act",
    uiLabel: "Reprocessing documents",
    contributingModule: "documents",
    dashboardSubject: { type: "document" },
    requiredPermissions: ["workspace.documents.manage"],
    description: REPROCESS_DOCUMENT_DESCRIPTION,
    inputSchema: reprocessDocumentInputSchema,
    outputSchema: reprocessDocumentOutputSchema,
    createTool: (context) => ({
      name: "reprocess_document",
      description: REPROCESS_DOCUMENT_DESCRIPTION,
      inputSchema: reprocessDocumentInputSchema,
      outputSchema: reprocessDocumentOutputSchema,
      invoke: async ({ documentId, sourceId, documentEnrichmentOverride }) => {
        if (documentId) {
          const result = await deps.documentMaintenance.reprocessDocument({
            documentId,
            workspaceId: context.workspaceId,
            documentEnrichmentOverride,
          });
          return reprocessDocumentOutputSchema.parse({
            target: { type: "document", id: result.documentId },
            status: result.status,
            queuedDocumentCount: result.queuedDocumentCount,
            skippedDocumentCount: result.skippedDocumentCount,
          });
        }
        if (!sourceId) throw new Error("A reprocess target is required");
        const result = await deps.documentMaintenance.reprocessSource({
          sourceId,
          workspaceId: context.workspaceId,
          documentEnrichmentOverride,
        });
        return reprocessDocumentOutputSchema.parse({
          target: { type: "source", id: sourceId },
          status: result.status,
          queuedDocumentCount: result.queuedDocumentCount,
          skippedDocumentCount: result.skippedDocumentCount,
        });
      },
    }),
    describeEntity: ({ documentId }) => documentId ? { type: "document", id: documentId } : { type: "document" },
    describeOutputEntity: (output) => {
      const target = (output as z.infer<typeof reprocessDocumentOutputSchema>).target;
      return target.type === "document" ? { type: "document", id: target.id } : null;
    },
  },
  {
    name: "recrawl_source",
    shape: "act",
    uiLabel: "Recrawling a document source",
    contributingModule: "documents",
    dashboardSubject: { type: "document" },
    requiredPermissions: ["workspace.documents.manage"],
    description: RECRAWL_SOURCE_DESCRIPTION,
    inputSchema: recrawlSourceInputSchema,
    outputSchema: recrawlSourceOutputSchema,
    createTool: (context) => ({
      name: "recrawl_source",
      description: RECRAWL_SOURCE_DESCRIPTION,
      inputSchema: recrawlSourceInputSchema,
      outputSchema: recrawlSourceOutputSchema,
      invoke: async ({ sourceId }) => recrawlSourceOutputSchema.parse(
        await deps.documentMaintenance.recrawlSource({
          accountId: context.accountId,
          sourceId,
          workspaceId: context.workspaceId,
        }),
      ),
    }),
  },
];
