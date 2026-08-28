import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";

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
export interface DocumentSearchCopilotToolDependencies { readonly documentSearchService: CopilotDocumentSearchPort; }
export interface DocumentStatusCopilotToolDependencies { readonly documentStatusService: CopilotDocumentStatusPort; readonly documentSourceStatusService: CopilotDocumentSourceStatusPort; }

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
