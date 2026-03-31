import { randomUUID } from "node:crypto";

import type {
  DocumentCreateInput,
  DocumentDerivedContentUpdateInput,
  DocumentQueueUpdateInput,
  DocumentRecord,
  DocumentRepositoryPort,
  DocumentSummaryRecord,
  DocumentUpdateInput,
} from "../../modules/documents/services/documentIngestionService.js";
import {
  inferMetadataValueType,
  type MetadataFieldSuggestion,
  type MetadataValueType,
} from "../../modules/settings/domain/retrievalSettings.js";
import type { Database } from "../../shared/infra/database.js";
import { notFound } from "../../shared/domain/errors.js";

interface DocumentRow {
  id: string;
  workspace_id: string;
  title: string;
  source_content: string;
  markdown_content: string;
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

const mapDocument = (row: DocumentRow): DocumentRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  title: row.title,
  sourceContent: row.source_content,
  markdownContent: row.markdown_content,
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

const documentSelect = `
  id,
  workspace_id,
  title,
  source_content,
  markdown_content,
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

const documentSummarySelect = `
  id,
  workspace_id,
  title,
  status,
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

const mapDocumentSummary = (row: DocumentRow): DocumentSummaryRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  title: row.title,
  status: row.status,
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

export class DocumentRepository implements DocumentRepositoryPort {
  constructor(private readonly database: Database) {}

  async listMetadataFieldSuggestions(workspaceId: string): Promise<MetadataFieldSuggestion[]> {
    const rows = await this.database.query<{ metadata: Record<string, unknown> | null }>(
      `SELECT metadata
       FROM documents
       WHERE workspace_id = $1`,
      [workspaceId],
    );

    const fields = new Map<string, MetadataValueType>();

    for (const row of rows) {
      for (const entry of collectMetadataPaths(row.metadata ?? {})) {
        const existing = fields.get(entry.path);
        fields.set(entry.path, existing && existing !== entry.inferredType ? "string" : entry.inferredType);
      }
    }

    return [...fields.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, inferredType]) => ({ field, inferredType }));
  }

  async createAndQueue(input: DocumentCreateInput): Promise<DocumentRecord> {
    return this.database.withTransaction(async (client) => {
      const documentId = randomUUID();
      const [documentRow] = (
        await client.query<DocumentRow>(
          `INSERT INTO documents (
             id,
             workspace_id,
             title,
             source_content,
             markdown_content,
             status,
             revision,
             metadata,
             source_kind,
             source_filename,
             source_mime_type,
             source_storage_bucket,
             source_storage_object,
             source_storage_generation,
             source_size_bytes
           )
           VALUES ($1, $2, $3, $4, $5, 'queued', 1, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
           RETURNING ${documentSelect}`,
          [
            documentId,
            input.workspaceId,
            input.title,
            input.sourceContent,
            input.markdownContent,
            JSON.stringify(input.metadata ?? {}),
            input.sourceKind ?? "inline_text",
            input.sourceFilename ?? null,
            input.sourceMimeType ?? null,
            input.sourceStorageBucket ?? null,
            input.sourceStorageObject ?? null,
            input.sourceStorageGeneration ?? null,
            input.sourceSizeBytes ?? null,
          ],
        )
      ).rows;

      await client.query(
        `INSERT INTO document_processing_jobs (id, document_id, workspace_id, document_revision, status)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [randomUUID(), documentId, input.workspaceId, documentRow.revision],
      );

      return mapDocument(documentRow);
    });
  }

  async create(input: DocumentCreateInput & { status: string }): Promise<DocumentRecord> {
    const [row] = await this.database.query<DocumentRow>(
      `INSERT INTO documents (
         id,
         workspace_id,
         title,
         source_content,
         markdown_content,
         status,
         revision,
         metadata,
         source_kind,
         source_filename,
         source_mime_type,
         source_storage_bucket,
         source_storage_object,
         source_storage_generation,
         source_size_bytes
       )
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${documentSelect}`,
      [
        randomUUID(),
        input.workspaceId,
        input.title,
        input.sourceContent,
        input.markdownContent,
        input.status,
        JSON.stringify(input.metadata ?? {}),
        input.sourceKind ?? "inline_text",
        input.sourceFilename ?? null,
        input.sourceMimeType ?? null,
        input.sourceStorageBucket ?? null,
        input.sourceStorageObject ?? null,
        input.sourceStorageGeneration ?? null,
        input.sourceSizeBytes ?? null,
      ],
    );

    return mapDocument(row);
  }

  async updateAndQueue(input: DocumentQueueUpdateInput): Promise<DocumentRecord> {
    return this.database.withTransaction(async (client) => {
      const documentResult = await client.query<DocumentRow>(
        `UPDATE documents
         SET title = $3,
             source_content = $4,
             markdown_content = $5,
             status = 'queued',
             revision = revision + 1,
             failed_at = NULL,
             failure_reason = NULL,
             updated_at = NOW(),
             metadata = COALESCE($6::jsonb, metadata),
             source_kind = COALESCE($7, source_kind),
             source_filename = COALESCE($8, source_filename),
             source_mime_type = COALESCE($9, source_mime_type),
             source_storage_bucket = COALESCE($10, source_storage_bucket),
             source_storage_object = COALESCE($11, source_storage_object),
             source_storage_generation = COALESCE($12, source_storage_generation),
             source_size_bytes = COALESCE($13, source_size_bytes)
         WHERE id = $1 AND workspace_id = $2
         RETURNING ${documentSelect}`,
        [
          input.documentId,
          input.workspaceId,
          input.title,
          input.sourceContent,
          input.markdownContent,
          input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
          input.sourceKind ?? null,
          input.sourceFilename ?? null,
          input.sourceMimeType ?? null,
          input.sourceStorageBucket ?? null,
          input.sourceStorageObject ?? null,
          input.sourceStorageGeneration ?? null,
          input.sourceSizeBytes ?? null,
        ],
      );
      const [documentRow] = documentResult.rows;

      if (!documentRow) {
        throw notFound("Document not found");
      }

      await client.query(
        `INSERT INTO document_processing_jobs (id, document_id, workspace_id, document_revision, status)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [randomUUID(), input.documentId, input.workspaceId, documentRow.revision],
      );

      return mapDocument(documentRow);
    });
  }

  async listByWorkspaceId(workspaceId: string): Promise<DocumentRecord[]> {
    const rows = await this.database.query<DocumentRow>(
      `SELECT ${documentSelect}
       FROM documents
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId],
    );

    return rows.map(mapDocument);
  }

  async listSummariesByIdsAndWorkspaceId(workspaceId: string, documentIds: string[]): Promise<DocumentSummaryRecord[]> {
    if (documentIds.length === 0) {
      return [];
    }

    const rows = await this.database.query<DocumentRow>(
      `SELECT ${documentSummarySelect}
       FROM documents
       WHERE workspace_id = $1
         AND id = ANY($2::uuid[])`,
      [workspaceId, documentIds],
    );

    return rows.map(mapDocumentSummary);
  }

  async listSummaryPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset: number },
  ): Promise<{ documents: DocumentSummaryRecord[]; total: number }> {
    const [countRow] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM documents
       WHERE workspace_id = $1`,
      [workspaceId],
    );

    const rows = await this.database.query<DocumentRow>(
      `SELECT ${documentSummarySelect}
       FROM documents
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2
       OFFSET $3`,
      [workspaceId, input.limit, input.offset],
    );

    return {
      documents: rows.map(mapDocumentSummary),
      total: Number(countRow?.count ?? "0"),
    };
  }

  async findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<DocumentRecord | null> {
    const [row] = await this.database.query<DocumentRow>(
      `SELECT ${documentSelect}
       FROM documents
       WHERE id = $1 AND workspace_id = $2`,
      [documentId, workspaceId],
    );

    return row ? mapDocument(row) : null;
  }

  async update(input: DocumentUpdateInput): Promise<DocumentRecord> {
    const [row] = await this.database.query<DocumentRow>(
      `UPDATE documents
       SET title = $3,
           source_content = $4,
           markdown_content = $5,
           status = $6,
           revision = revision + 1,
           failed_at = NULL,
           failure_reason = NULL,
           updated_at = NOW(),
           metadata = COALESCE($7::jsonb, metadata),
           source_kind = COALESCE($8, source_kind),
           source_filename = COALESCE($9, source_filename),
           source_mime_type = COALESCE($10, source_mime_type),
           source_storage_bucket = COALESCE($11, source_storage_bucket),
           source_storage_object = COALESCE($12, source_storage_object),
           source_storage_generation = COALESCE($13, source_storage_generation),
           source_size_bytes = COALESCE($14, source_size_bytes)
       WHERE id = $1 AND workspace_id = $2
       RETURNING ${documentSelect}`,
      [
        input.documentId,
        input.workspaceId,
        input.title,
        input.sourceContent,
        input.markdownContent,
        input.status,
        input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
        input.sourceKind ?? null,
        input.sourceFilename ?? null,
        input.sourceMimeType ?? null,
        input.sourceStorageBucket ?? null,
        input.sourceStorageObject ?? null,
        input.sourceStorageGeneration ?? null,
        input.sourceSizeBytes ?? null,
      ],
    );

    return mapDocument(row);
  }

  async updateDerivedContentForRevision(input: DocumentDerivedContentUpdateInput): Promise<DocumentRecord | null> {
    const [row] = await this.database.query<DocumentRow>(
      `UPDATE documents
       SET source_content = $4,
           markdown_content = $5,
           updated_at = NOW()
       WHERE id = $1
         AND workspace_id = $2
         AND revision = $3
       RETURNING ${documentSelect}`,
      [input.documentId, input.workspaceId, input.revision, input.sourceContent, input.markdownContent],
    );

    return row ? mapDocument(row) : null;
  }

  async requeue(documentId: string, workspaceId: string): Promise<DocumentRecord> {
    const [row] = await this.database.query<DocumentRow>(
      `UPDATE documents
       SET status = 'queued',
           revision = revision + 1,
           failed_at = NULL,
           failure_reason = NULL,
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2
       RETURNING ${documentSelect}`,
      [documentId, workspaceId],
    );

    return mapDocument(row);
  }

  async requeueAndQueue(documentId: string, workspaceId: string): Promise<DocumentRecord> {
    return this.database.withTransaction(async (client) => {
      const documentResult = await client.query<DocumentRow>(
        `UPDATE documents
         SET status = 'queued',
             revision = revision + 1,
             failed_at = NULL,
             failure_reason = NULL,
             updated_at = NOW()
         WHERE id = $1 AND workspace_id = $2
         RETURNING ${documentSelect}`,
        [documentId, workspaceId],
      );
      const [documentRow] = documentResult.rows;

      if (!documentRow) {
        throw notFound("Document not found");
      }

      await client.query(
        `INSERT INTO document_processing_jobs (id, document_id, workspace_id, document_revision, status)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [randomUUID(), documentId, workspaceId, documentRow.revision],
      );

      return mapDocument(documentRow);
    });
  }

  async requeueAllEligibleAndQueue(workspaceId: string): Promise<{ queuedDocumentCount: number; skippedDocumentCount: number }> {
    return this.database.withTransaction(async (client) => {
      const countsResult = await client.query<{ total_count: string; skipped_count: string }>(
        `SELECT COUNT(*)::text AS total_count,
                COUNT(*) FILTER (WHERE status IN ('queued', 'processing'))::text AS skipped_count
         FROM documents
         WHERE workspace_id = $1`,
        [workspaceId],
      );
      const counts = countsResult.rows[0];

      const queuedRows = (
        await client.query<DocumentRow>(
          `UPDATE documents
           SET status = 'queued',
               revision = revision + 1,
               failed_at = NULL,
               failure_reason = NULL,
               updated_at = NOW()
           WHERE workspace_id = $1
             AND status NOT IN ('queued', 'processing')
           RETURNING id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata`,
          [workspaceId],
        )
      ).rows;

      for (const documentRow of queuedRows) {
        await client.query(
          `INSERT INTO document_processing_jobs (id, document_id, workspace_id, document_revision, status)
           VALUES ($1, $2, $3, $4, 'queued')`,
          [randomUUID(), documentRow.id, workspaceId, documentRow.revision],
        );
      }

      const totalCount = Number(counts?.total_count ?? "0");
      const skippedByStatus = Number(counts?.skipped_count ?? "0");

      return {
        queuedDocumentCount: queuedRows.length,
        skippedDocumentCount: Math.max(skippedByStatus, totalCount - queuedRows.length),
      };
    });
  }

  async setStatus(input: {
    documentId: string;
    workspaceId: string;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord> {
    const [row] = await this.database.query<DocumentRow>(
      `UPDATE documents
       SET status = $3,
           failed_at = CASE WHEN $3 = 'failed' THEN NOW() ELSE NULL END,
           failure_reason = CASE WHEN $3 = 'failed' THEN $4 ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2
       RETURNING ${documentSelect}`,
      [input.documentId, input.workspaceId, input.status, input.failureReason ?? null],
    );

    return mapDocument(row);
  }

  async setStatusIfRevisionMatches(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord | null> {
    const [row] = await this.database.query<DocumentRow>(
      `UPDATE documents
       SET status = $4,
           failed_at = CASE WHEN $4 = 'failed' THEN NOW() ELSE NULL END,
           failure_reason = CASE WHEN $4 = 'failed' THEN $5 ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1
         AND workspace_id = $2
         AND revision = $3
       RETURNING ${documentSelect}`,
      [input.documentId, input.workspaceId, input.revision, input.status, input.failureReason ?? null],
    );

    return row ? mapDocument(row) : null;
  }

  async deleteByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<boolean> {
    const rows = await this.database.query<{ id: string }>(
      `DELETE FROM documents
       WHERE id = $1 AND workspace_id = $2
       RETURNING id`,
      [documentId, workspaceId],
    );

    return rows.length > 0;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalarMetadataValue = (value: unknown): boolean =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const collectMetadataPaths = (
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
