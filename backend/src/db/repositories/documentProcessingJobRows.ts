import type { DocumentProcessingJobOptions } from "../../modules/documents/contracts/documentContracts.js";

export type DocumentProcessingJobStatus = "queued" | "processing" | "completed" | "failed" | "skipped";
// Vectorize jobs make a document queryable (chunk + embed + publish). Enrich jobs
// run the metadata-extraction LLM afterward at lower priority, and images jobs
// capture the pictures the content names, anchored to the published chunks.
export type DocumentProcessingJobKind =
  | "vectorize"
  | "enrich"
  | "images"
  | "embedding_profile";
export type RevisionProcessingJobKind = Exclude<
  DocumentProcessingJobKind,
  "embedding_profile"
>;
/** The jobs a published revision queues after itself. */
export type FollowUpJobKind = Extract<DocumentProcessingJobKind, "enrich" | "images">;
export interface DocumentProcessingJobRecord {
  id: string;
  documentId: string;
  workspaceId: string;
  documentRevision: number;
  kind: DocumentProcessingJobKind;
  status: DocumentProcessingJobStatus;
  attemptCount: number;
  lastError: string | null;
  lastErrorCode?: string | null;
  availableAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  options?: DocumentProcessingJobOptions | null;
  embeddingSpaceId?: string | null;
  workspaceProfileGeneration?: string | null;
}

export interface DocumentProcessingJobRow {
  id: string;
  document_id: string;
  workspace_id: string;
  document_revision: number;
  kind: DocumentProcessingJobKind;
  status: DocumentProcessingJobStatus;
  attempt_count: number;
  last_error: string | null;
  last_error_code: string | null;
  available_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  options: Record<string, unknown> | null;
  embedding_space_id: string | null;
  workspace_profile_generation: string | null;
}

export const mapJob = (row: DocumentProcessingJobRow): DocumentProcessingJobRecord => ({
  id: row.id,
  documentId: row.document_id,
  workspaceId: row.workspace_id,
  documentRevision: row.document_revision,
  kind: normalizeJobKind(row.kind),
  status: row.status,
  attemptCount: row.attempt_count,
  lastError: row.last_error,
  lastErrorCode: row.last_error_code,
  availableAt: new Date(row.available_at),
  claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  options: mapJobOptions(row.options),
  embeddingSpaceId: row.embedding_space_id,
  workspaceProfileGeneration: row.workspace_profile_generation === null
    ? null
    : String(row.workspace_profile_generation),
});

const normalizeJobKind = (value: unknown): DocumentProcessingJobKind =>
  value === "enrich" || value === "images" || value === "embedding_profile" ? value : "vectorize";

// Rows written before a key existed simply lack it: an absent key is the
// default, never an error, so in-flight jobs keep running unchanged.
const mapJobOptions = (value: Record<string, unknown> | null): DocumentProcessingJobOptions | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const override = value.documentEnrichmentOverride;
  const options: DocumentProcessingJobOptions = {
    ...(override === "on" || override === "off" ? { documentEnrichmentOverride: override } : {}),
    ...(value.refreshDocumentEnrichment === true ? { refreshDocumentEnrichment: true } : {}),
  };
  return Object.keys(options).length > 0 ? options : null;
};

export const documentProcessingJobColumns = [
  "id",
  "document_id",
  "workspace_id",
  "document_revision",
  "kind",
  "status",
  "attempt_count",
  "last_error",
  "last_error_code",
  "available_at",
  "claimed_at",
  "completed_at",
  "created_at",
  "updated_at",
  "options",
  "embedding_space_id",
  "workspace_profile_generation",
] as const;
