import { randomUUID } from "node:crypto";

import type {
  DocumentCreateInput,
  DocumentDerivedContentUpdateInput,
  DocumentQueueUpdateInput,
  DocumentRecord,
  DocumentRepositoryPort,
  DocumentSummaryRecord,
  DocumentUpdateInput,
  DocumentWorkspaceSummaryRecord,
} from "../../modules/documents/services/documentIngestionService.js";
import type { MetadataFieldSuggestion, MetadataValueType } from "../../modules/settings/domain/retrievalSettings.js";
import { decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";
import type { Database } from "../../shared/infra/database.js";
import { conflict, notFound } from "../../shared/domain/errors.js";
import {
  collectMetadataPaths,
  documentSelect,
  documentSummarySelect,
  mapDocument,
  mapDocumentSummary,
  type DocumentRow,
} from "./documentRowMapper.js";

interface QueuedDocumentRow {
  id: string;
  revision: number;
}

export class DocumentRepository implements DocumentRepositoryPort {
  constructor(private readonly database: Database) {}

  async summarizeWorkspace(workspaceId: string): Promise<DocumentWorkspaceSummaryRecord> {
    const [row] = await this.database.query<{
      document_count: string;
      ready_document_count: string;
      pending_document_count: string;
      sample_document_count: string;
      sample_document_slugs: string[];
    }>(
      `SELECT
         COUNT(*)::text AS document_count,
         COUNT(*) FILTER (WHERE status = 'ready')::text AS ready_document_count,
         COUNT(*) FILTER (WHERE status <> 'ready')::text AS pending_document_count,
         COUNT(*) FILTER (WHERE metadata ->> 'sampleDocument' = 'true')::text AS sample_document_count,
         COALESCE(
           ARRAY_AGG(metadata ->> 'sampleSlug')
             FILTER (
               WHERE metadata ->> 'sampleDocument' = 'true'
                 AND NULLIF(metadata ->> 'sampleSlug', '') IS NOT NULL
             ),
           ARRAY[]::text[]
         ) AS sample_document_slugs
       FROM documents
       WHERE workspace_id = $1`,
      [workspaceId],
    );

    return {
      documentCount: Number(row?.document_count ?? "0"),
      readyDocumentCount: Number(row?.ready_document_count ?? "0"),
      pendingDocumentCount: Number(row?.pending_document_count ?? "0"),
      sampleDocumentCount: Number(row?.sample_document_count ?? "0"),
      sampleDocumentSlugs: row?.sample_document_slugs ?? [],
    };
  }

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
             external_document_id,
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
           VALUES ($1, $2, $3, $4, $5, $6, 'queued', 1, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (workspace_id, external_document_id) WHERE external_document_id IS NOT NULL
           DO UPDATE
             SET title = EXCLUDED.title,
                 source_content = EXCLUDED.source_content,
                 markdown_content = EXCLUDED.markdown_content,
                 status = 'queued',
                 revision = documents.revision + 1,
                 failed_at = NULL,
                 failure_reason = NULL,
                 updated_at = NOW(),
                 metadata = EXCLUDED.metadata,
                 source_kind = EXCLUDED.source_kind,
                 source_filename = EXCLUDED.source_filename,
                 source_mime_type = EXCLUDED.source_mime_type,
                 source_storage_bucket = EXCLUDED.source_storage_bucket,
                 source_storage_object = EXCLUDED.source_storage_object,
                 source_storage_generation = EXCLUDED.source_storage_generation,
                 source_size_bytes = EXCLUDED.source_size_bytes
           WHERE documents.source_kind = EXCLUDED.source_kind
           RETURNING ${documentSelect}`,
          [
            documentId,
            input.workspaceId,
            input.title,
            input.sourceContent,
            input.markdownContent,
            input.externalDocumentId ?? null,
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

      if (!documentRow) {
        throw conflict("Imported documents cannot be updated through the inline document API");
      }

      await client.query(
        `INSERT INTO document_processing_jobs (id, document_id, workspace_id, document_revision, status)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [randomUUID(), documentRow.id, input.workspaceId, documentRow.revision],
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
         external_document_id,
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${documentSelect}`,
      [
        randomUUID(),
        input.workspaceId,
        input.title,
        input.sourceContent,
        input.markdownContent,
        input.externalDocumentId ?? null,
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
             external_document_id = COALESCE($7, external_document_id),
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
          input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
          input.externalDocumentId ?? null,
          input.sourceKind ?? null,
          input.sourceFilename ?? null,
          input.sourceMimeType ?? null,
          input.sourceStorageBucket ?? null,
          input.sourceStorageObject ?? null,
          input.sourceStorageGeneration ?? null,
          input.sourceSizeBytes ?? null,
        ],
      ).catch((error: unknown) => {
        throw this.mapDocumentConflict(error);
      });
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
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ documents: DocumentSummaryRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.database.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM documents
           WHERE workspace_id = $1`,
          [workspaceId],
        ))[0]?.count ?? "0");
    const params: Array<string | number> = [workspaceId];
    let cursorClause = "";

    if (cursor) {
      params.push(cursor.keys.createdAt, cursor.keys.id);
      cursorClause = `
         AND (
           created_at < $2::timestamptz
           OR (created_at = $2::timestamptz AND id < $3::uuid)
         )`;
    }

    const limitParam = params.length + 1;
    params.push(input.limit + 1);

    let offsetClause = "";
    if (!cursor) {
      offsetClause = `OFFSET $${params.length + 1}`;
      params.push(input.offset ?? 0);
    }

    const rows = await this.database.query<DocumentRow>(
      `SELECT ${documentSummarySelect}
       FROM documents
       WHERE workspace_id = $1
       ${cursorClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitParam}
       ${offsetClause}`,
      params,
    );

    const documents = rows.slice(0, input.limit).map(mapDocumentSummary);
    const hasMore = rows.length > input.limit;
    const lastDocument = documents.at(-1);

    return {
      documents,
      total,
      nextCursor: hasMore && lastDocument
        ? encodeCursor({
            createdAt: lastDocument.createdAt.toISOString(),
            id: lastDocument.id,
          }, total)
        : null,
      hasMore,
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
           external_document_id = COALESCE($8, external_document_id),
           source_kind = COALESCE($9, source_kind),
           source_filename = COALESCE($10, source_filename),
           source_mime_type = COALESCE($11, source_mime_type),
           source_storage_bucket = COALESCE($12, source_storage_bucket),
           source_storage_object = COALESCE($13, source_storage_object),
           source_storage_generation = COALESCE($14, source_storage_generation),
           source_size_bytes = COALESCE($15, source_size_bytes)
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
        input.externalDocumentId ?? null,
        input.sourceKind ?? null,
        input.sourceFilename ?? null,
        input.sourceMimeType ?? null,
        input.sourceStorageBucket ?? null,
        input.sourceStorageObject ?? null,
        input.sourceStorageGeneration ?? null,
        input.sourceSizeBytes ?? null,
      ],
    ).catch((error: unknown) => {
      throw this.mapDocumentConflict(error);
    });

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

  async requeueAllEligibleAndQueue(workspaceId: string): Promise<{
    queuedDocumentCount: number;
    skippedDocumentCount: number;
    queuedDocuments: Array<{ documentId: string; revision: number }>;
  }> {
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
        await client.query<QueuedDocumentRow>(
          `UPDATE documents
           SET status = 'queued',
               revision = revision + 1,
               failed_at = NULL,
               failure_reason = NULL,
               updated_at = NOW()
           WHERE workspace_id = $1
             AND status NOT IN ('queued', 'processing')
           RETURNING id, revision`,
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
        queuedDocuments: queuedRows.map((documentRow) => ({
          documentId: documentRow.id,
          revision: documentRow.revision,
        })),
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

  private mapDocumentConflict(error: unknown): unknown {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505" &&
      "constraint" in error &&
      (error as { constraint?: string }).constraint === "idx_documents_workspace_external_document_id_unique"
    ) {
      return conflict("externalDocumentId is already used by another document in this workspace");
    }

    return error;
  }
}
