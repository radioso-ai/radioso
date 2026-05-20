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
} from "../../modules/documents/contracts/index.js";
import type { MetadataFieldSuggestion, MetadataValueType } from "../../modules/settings/contracts/retrieval.js";
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
         COUNT(*) FILTER (WHERE status IN ('queued', 'processing'))::text AS pending_document_count,
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
      const conflictTarget = input.sourceId
        ? "(workspace_id, source_id, external_document_id) WHERE source_id IS NOT NULL AND external_document_id IS NOT NULL"
        : "(workspace_id, external_document_id) WHERE source_id IS NULL AND external_document_id IS NOT NULL";
      const [documentRow] = (
        await client.query<DocumentRow>(
          `INSERT INTO documents (
             id,
             workspace_id,
             title,
             source_content,
             markdown_content,
             source_id,
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
             source_size_bytes,
             content_size_bytes,
             content_hash
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 1, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17)
           ON CONFLICT ${conflictTarget}
           DO UPDATE
             SET title = EXCLUDED.title,
                 source_content = EXCLUDED.source_content,
                 markdown_content = EXCLUDED.markdown_content,
                 source_id = EXCLUDED.source_id,
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
                 source_size_bytes = EXCLUDED.source_size_bytes,
                 content_size_bytes = EXCLUDED.content_size_bytes,
                 content_hash = EXCLUDED.content_hash
           WHERE documents.source_kind = EXCLUDED.source_kind
           RETURNING ${documentSelect}`,
          [
            documentId,
            input.workspaceId,
            input.title,
            input.sourceContent,
            input.markdownContent,
            input.sourceId ?? null,
            input.externalDocumentId ?? null,
            JSON.stringify(input.metadata ?? {}),
            input.sourceKind ?? "inline_text",
            input.sourceFilename ?? null,
            input.sourceMimeType ?? null,
            input.sourceStorageBucket ?? null,
            input.sourceStorageObject ?? null,
            input.sourceStorageGeneration ?? null,
            input.sourceSizeBytes ?? null,
            input.contentSizeBytes ?? null,
            input.contentHash ?? null,
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
         source_id,
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
         source_size_bytes,
         content_size_bytes,
         content_hash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING ${documentSelect}`,
      [
        randomUUID(),
        input.workspaceId,
        input.title,
        input.sourceContent,
        input.markdownContent,
        input.sourceId ?? null,
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
        input.contentSizeBytes ?? null,
        input.contentHash ?? null,
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
             source_id = COALESCE($8, source_id),
             source_kind = COALESCE($9, source_kind),
             source_filename = COALESCE($10, source_filename),
             source_mime_type = COALESCE($11, source_mime_type),
             source_storage_bucket = COALESCE($12, source_storage_bucket),
             source_storage_object = COALESCE($13, source_storage_object),
             source_storage_generation = COALESCE($14, source_storage_generation),
             source_size_bytes = COALESCE($15, source_size_bytes),
             content_size_bytes = COALESCE($16, content_size_bytes),
             content_hash = COALESCE($17, content_hash)
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
          input.sourceId ?? null,
          input.sourceKind ?? null,
          input.sourceFilename ?? null,
          input.sourceMimeType ?? null,
          input.sourceStorageBucket ?? null,
          input.sourceStorageObject ?? null,
          input.sourceStorageGeneration ?? null,
          input.sourceSizeBytes ?? null,
          input.contentSizeBytes ?? null,
          input.contentHash ?? null,
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
           source_id = COALESCE($9, source_id),
           source_kind = COALESCE($10, source_kind),
           source_filename = COALESCE($11, source_filename),
           source_mime_type = COALESCE($12, source_mime_type),
           source_storage_bucket = COALESCE($13, source_storage_bucket),
           source_storage_object = COALESCE($14, source_storage_object),
           source_storage_generation = COALESCE($15, source_storage_generation),
           source_size_bytes = COALESCE($16, source_size_bytes),
           content_size_bytes = COALESCE($17, content_size_bytes),
           content_hash = COALESCE($18, content_hash)
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
        input.sourceId ?? null,
        input.sourceKind ?? null,
        input.sourceFilename ?? null,
        input.sourceMimeType ?? null,
        input.sourceStorageBucket ?? null,
        input.sourceStorageObject ?? null,
        input.sourceStorageGeneration ?? null,
        input.sourceSizeBytes ?? null,
        input.contentSizeBytes ?? null,
        input.contentHash ?? null,
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

  async listSummaryPageBySourceId(
    workspaceId: string,
    sourceId: string | null,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ documents: DocumentSummaryRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const sourceFilter = sourceId === null
      ? "AND source_id IS NULL"
      : "AND source_id = $2";
    const sourceParams: string[] = sourceId === null ? [workspaceId] : [workspaceId, sourceId];

    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.database.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM documents
           WHERE workspace_id = $1
           ${sourceFilter}`,
          sourceParams,
        ))[0]?.count ?? "0");

    const params: Array<string | number> = [...sourceParams];
    let cursorClause = "";

    if (cursor) {
      const p1 = params.length + 1;
      const p2 = params.length + 2;
      params.push(cursor.keys.createdAt, cursor.keys.id);
      cursorClause = `
         AND (
           created_at < $${p1}::timestamptz
           OR (created_at = $${p1}::timestamptz AND id < $${p2}::uuid)
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
       ${sourceFilter}
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

  async deleteBySourceIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<{
    count: number;
    storageRefs: Array<{ bucket: string; objectPath: string; generation: string | null }>;
  }> {
    const rows = await this.database.query<{
      id: string;
      source_kind: string;
      source_storage_bucket: string | null;
      source_storage_object: string | null;
      source_storage_generation: string | null;
    }>(
      `DELETE FROM documents
       WHERE source_id = $1 AND workspace_id = $2
       RETURNING id, source_kind, source_storage_bucket, source_storage_object, source_storage_generation`,
      [sourceId, workspaceId],
    );
    const storageRefs: Array<{ bucket: string; objectPath: string; generation: string | null }> = [];
    for (const row of rows) {
      if (row.source_kind === "uploaded_file" && row.source_storage_bucket && row.source_storage_object) {
        storageRefs.push({
          bucket: row.source_storage_bucket,
          objectPath: row.source_storage_object,
          generation: row.source_storage_generation ?? null,
        });
      }
    }
    return { count: rows.length, storageRefs };
  }

  async findActivePageState(input: {
    workspaceId: string;
    sourceId?: string | null;
    externalDocumentId: string;
  }): Promise<{
    documentId: string;
    revision: number;
    contentSizeBytes: number | null;
    contentHash: string | null;
  } | null> {
    const sourceId = input.sourceId ?? null;
    const sourceFilter = sourceId === null
      ? "source_id IS NULL"
      : "source_id = $3";
    const params: unknown[] = [input.workspaceId, input.externalDocumentId];
    if (sourceId !== null) {
      params.push(sourceId);
    }

    const [row] = await this.database.query<{
      id: string;
      revision: number;
      content_size_bytes: number | string | null;
      content_hash: string | null;
    }>(
      `SELECT id, revision, content_size_bytes, content_hash
       FROM documents
       WHERE workspace_id = $1
         AND external_document_id = $2
         AND ${sourceFilter}
         AND status <> 'failed'
       LIMIT 1`,
      params,
    );

    if (!row) {
      return null;
    }

    const rawBytes = row.content_size_bytes;
    const bytes = typeof rawBytes === "string"
      ? Number(rawBytes)
      : (rawBytes ?? null);

    return {
      documentId: row.id,
      revision: row.revision,
      contentSizeBytes: typeof bytes === "number" && Number.isFinite(bytes) ? bytes : null,
      contentHash: row.content_hash ?? null,
    };
  }

  async deleteMissingPagesBySourceAndExternalIds(input: {
    workspaceId: string;
    sourceId: string;
    keepExternalDocumentIds: string[];
  }): Promise<{ deletedCount: number; deletedContentBytes: number }> {
    const keep = Array.from(new Set(input.keepExternalDocumentIds.filter((value) => value && value.length > 0)));
    const params: unknown[] = [input.sourceId, input.workspaceId];
    let keepClause = "";
    if (keep.length > 0) {
      params.push(keep);
      keepClause = `AND external_document_id <> ALL($3::text[])`;
    }

    const rows = await this.database.query<{
      id: string;
      content_size_bytes: number | string | null;
    }>(
      `DELETE FROM documents
       WHERE source_id = $1
         AND workspace_id = $2
         AND external_document_id IS NOT NULL
         ${keepClause}
       RETURNING id, content_size_bytes`,
      params,
    );

    let deletedContentBytes = 0;
    for (const row of rows) {
      const raw = row.content_size_bytes;
      const bytes = typeof raw === "string" ? Number(raw) : raw;
      if (typeof bytes === "number" && Number.isFinite(bytes)) {
        deletedContentBytes += bytes;
      }
    }
    return { deletedCount: rows.length, deletedContentBytes };
  }

  private mapDocumentConflict(error: unknown): unknown {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505" &&
      "constraint" in error &&
      ((error as { constraint?: string }).constraint === "idx_documents_workspace_external_document_id_unique" ||
        (error as { constraint?: string }).constraint === "idx_documents_workspace_source_external_document_id_unique")
    ) {
      return conflict("externalDocumentId is already used by another document in this workspace");
    }

    return error;
  }
}
