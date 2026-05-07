import type {
  DocumentRecord,
  DocumentSummaryRecord,
} from "../../modules/documents/contracts/index.js";
import {
  inferMetadataValueType,
  type MetadataValueType,
} from "../../modules/settings/domain/retrievalSettings.js";

export interface DocumentRow {
  id: string;
  workspace_id: string;
  title: string;
  source_content: string;
  markdown_content: string;
  external_document_id: string | null;
  status: string;
  revision: number;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
  source_kind: "inline_text" | "uploaded_file";
  source_filename: string | null;
  source_mime_type: string | null;
  source_storage_bucket: string | null;
  source_storage_object: string | null;
  source_storage_generation: string | null;
  source_size_bytes: number | null;
}

export const documentSelect = `
  id,
  workspace_id,
  title,
  source_content,
  markdown_content,
  external_document_id,
  status,
  revision,
  failure_reason,
  created_at,
  updated_at,
  metadata,
  source_kind,
  source_filename,
  source_mime_type,
  source_storage_bucket,
  source_storage_object,
  source_storage_generation,
  source_size_bytes
`;

export const documentSummarySelect = `
  id,
  workspace_id,
  title,
  status,
  failure_reason,
  created_at,
  updated_at,
  metadata,
  external_document_id,
  source_kind,
  source_filename,
  source_mime_type,
  source_storage_bucket,
  source_storage_object,
  source_storage_generation,
  source_size_bytes
`;

export const mapDocument = (row: DocumentRow): DocumentRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  title: row.title,
  sourceContent: row.source_content,
  markdownContent: row.markdown_content,
  externalDocumentId: row.external_document_id,
  status: row.status,
  revision: row.revision,
  failureReason: row.failure_reason,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  metadata: row.metadata ?? {},
  sourceKind: row.source_kind,
  sourceFilename: row.source_filename,
  sourceMimeType: row.source_mime_type,
  sourceStorageBucket: row.source_storage_bucket,
  sourceStorageObject: row.source_storage_object,
  sourceStorageGeneration: row.source_storage_generation,
  sourceSizeBytes: row.source_size_bytes,
});

export const mapDocumentSummary = (row: DocumentRow): DocumentSummaryRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  title: row.title,
  status: row.status,
  failureReason: row.failure_reason,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  metadata: row.metadata ?? {},
  externalDocumentId: row.external_document_id,
  sourceKind: row.source_kind,
  sourceFilename: row.source_filename,
  sourceMimeType: row.source_mime_type,
  sourceStorageBucket: row.source_storage_bucket,
  sourceStorageObject: row.source_storage_object,
  sourceStorageGeneration: row.source_storage_generation,
  sourceSizeBytes: row.source_size_bytes,
});

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
