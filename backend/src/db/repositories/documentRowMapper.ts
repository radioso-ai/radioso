import type {
  DocumentEnrichmentProvenance,
  DocumentShape,
  EnrichmentAnchorSource,
  EnrichmentStatus,
} from "../../modules/documents/domain/enrichment/documentEnrichmentContract.js";
import type {
  DocumentRecord,
  DocumentSourceSummary,
  DocumentSummaryRecord,
} from "../../modules/documents/contracts/index.js";
import type { DocumentOriginKind } from "./documentSourceRepository.js";
import {
  inferMetadataValueType,
  type MetadataValueType,
} from "../../modules/settings/contracts/retrieval.js";

export interface DocumentRow {
  id: string;
  workspace_id: string;
  title: string;
  source_content: string;
  markdown_content: string;
  source_id: string | null;
  source: DocumentSourceSummary | null;
  external_document_id: string | null;
  status: string;
  revision: number;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
  retrieval_enabled: boolean;
  retrieval_expires_at: Date | string | null;
  metadata: Record<string, unknown>;
  enrichment?: unknown;
  source_kind: "inline_text" | "uploaded_file";
  source_filename: string | null;
  source_mime_type: string | null;
  source_storage_bucket: string | null;
  source_storage_object: string | null;
  source_storage_generation: string | null;
  // BIGINT columns arrive as strings from node-postgres unless a type parser is registered.
  source_size_bytes: number | string | null;
  content_size_bytes: number | string | null;
  content_hash: string | null;
  content_size?: number | string | null;
}

const coerceByteCount = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const coerceTimestamp = (value: Date | string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

export const documentSelect = `
  id,
  workspace_id,
  title,
  source_content,
  markdown_content,
  source_id,
  (
    SELECT jsonb_build_object(
      'id', s.id,
      'kind', s.kind,
      'name', s.name,
      'externalId', s.external_id
    )
    FROM document_sources s
    WHERE s.id = documents.source_id
  ) AS source,
  external_document_id,
  status,
  revision,
  failure_reason,
  created_at,
  updated_at,
  retrieval_enabled,
  retrieval_expires_at,
  metadata,
  source_kind,
  source_filename,
  source_mime_type,
  source_storage_bucket,
  source_storage_object,
  source_storage_generation,
  source_size_bytes,
  content_size_bytes,
  content_hash
`;

export const documentSummarySelect = `
  id,
  workspace_id,
  title,
  status,
  failure_reason,
  created_at,
  updated_at,
  retrieval_enabled,
  retrieval_expires_at,
  metadata,
  source_id,
  (
    SELECT jsonb_build_object(
      'id', s.id,
      'kind', s.kind,
      'name', s.name,
      'externalId', s.external_id
    )
    FROM document_sources s
    WHERE s.id = documents.source_id
  ) AS source,
  external_document_id,
  source_kind,
  source_filename,
  source_mime_type,
  source_storage_bucket,
  source_storage_object,
  source_storage_generation,
  source_size_bytes,
  content_size_bytes,
  content_hash,
  COALESCE(content_size_bytes, source_size_bytes, OCTET_LENGTH(source_content)) AS content_size
`;

export const mapDocument = (row: DocumentRow): DocumentRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  title: row.title,
  sourceContent: row.source_content,
  markdownContent: row.markdown_content,
  sourceId: row.source_id,
  source: mapDocumentSourceSummary(row.source),
  externalDocumentId: row.external_document_id,
  status: row.status,
  revision: row.revision,
  failureReason: row.failure_reason,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  retrievalEnabled: row.retrieval_enabled ?? true,
  retrievalExpiresAt: coerceTimestamp(row.retrieval_expires_at),
  metadata: row.metadata ?? {},
  enrichment: mapDocumentEnrichment(row.enrichment),
  sourceKind: row.source_kind,
  sourceFilename: row.source_filename,
  sourceMimeType: row.source_mime_type,
  sourceStorageBucket: row.source_storage_bucket,
  sourceStorageObject: row.source_storage_object,
  sourceStorageGeneration: row.source_storage_generation,
  sourceSizeBytes: coerceByteCount(row.source_size_bytes),
  contentSizeBytes: coerceByteCount(row.content_size_bytes),
  contentHash: row.content_hash,
});

export const mapDocumentSummary = (row: DocumentRow): DocumentSummaryRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  title: row.title,
  status: row.status,
  failureReason: row.failure_reason,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  retrievalEnabled: row.retrieval_enabled ?? true,
  retrievalExpiresAt: coerceTimestamp(row.retrieval_expires_at),
  metadata: row.metadata ?? {},
  enrichment: mapDocumentEnrichment(row.enrichment),
  sourceId: row.source_id,
  source: mapDocumentSourceSummary(row.source),
  externalDocumentId: row.external_document_id,
  sourceKind: row.source_kind,
  sourceFilename: row.source_filename,
  sourceMimeType: row.source_mime_type,
  sourceStorageBucket: row.source_storage_bucket,
  sourceStorageObject: row.source_storage_object,
  sourceStorageGeneration: row.source_storage_generation,
  sourceSizeBytes: coerceByteCount(row.source_size_bytes),
  contentSizeBytes: coerceByteCount(row.content_size_bytes),
  contentSize: coerceByteCount(row.content_size ?? row.content_size_bytes ?? row.source_size_bytes),
});

const documentShapeValues = new Set<DocumentShape>(["event", "article", "profile", "reference", "generic"]);
const enrichmentStatusValues = new Set<EnrichmentStatus>(["applied", "skipped", "failed"]);
const anchorSourceValues = new Set<EnrichmentAnchorSource>(["source_last_sync", "document_created_at"]);

const mapDocumentEnrichment = (
  value: unknown,
): DocumentEnrichmentProvenance | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== "string" || !enrichmentStatusValues.has(status as EnrichmentStatus)) {
    return null;
  }
  const shape = typeof record.shape === "string" && documentShapeValues.has(record.shape as DocumentShape)
    ? record.shape as DocumentShape
    : undefined;
  const anchorSource =
    typeof record.anchorSource === "string" && anchorSourceValues.has(record.anchorSource as EnrichmentAnchorSource)
      ? record.anchorSource as EnrichmentAnchorSource
      : null;

  return {
    status: status as EnrichmentStatus,
    shape,
    model: typeof record.model === "string" ? record.model : null,
    enrichedAt: typeof record.enrichedAt === "string" ? record.enrichedAt : null,
    anchorDate: typeof record.anchorDate === "string" ? record.anchorDate : null,
    anchorSource,
    factCount: typeof record.factCount === "number" ? record.factCount : 0,
    appliedChunkCount: typeof record.appliedChunkCount === "number" ? record.appliedChunkCount : 0,
    failureReason: typeof record.failureReason === "string" ? record.failureReason : null,
  };
};

const mapDocumentSourceSummary = (value: DocumentSourceSummary | null): DocumentSourceSummary | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as {
    id?: unknown;
    kind?: unknown;
    name?: unknown;
    externalId?: unknown;
  };
  if (typeof source.id !== "string" || typeof source.kind !== "string" || typeof source.name !== "string") {
    return null;
  }
  return {
    id: source.id,
    kind: source.kind as DocumentOriginKind,
    name: source.name,
    externalId: typeof source.externalId === "string" ? source.externalId : null,
  };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalarMetadataValue = (value: unknown): boolean =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

export const collectMetadataPaths = (
  metadata: Record<string, unknown>,
  prefix = "",
): Array<{ path: string; inferredType: MetadataValueType }> => {
  const paths: Array<{ path: string; inferredType: MetadataValueType }> = [];

  for (const [key, value] of Object.entries(metadata)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;

    if (isScalarMetadataValue(value)) {
      paths.push({
        path: nextPath,
        inferredType: inferMetadataValueType(value),
      });
      continue;
    }

    if (isPlainObject(value)) {
      paths.push(...collectMetadataPaths(value, nextPath));
    }
  }

  return paths;
};
