import { randomUUID } from "node:crypto";

import type { DocumentRecord, DocumentRepositoryPort } from "../../modules/documents/services/documentIngestionService.js";
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
});

export class DocumentRepository implements DocumentRepositoryPort {
  constructor(private readonly database: Database) {}

  async createAndQueue(input: {
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    metadata?: Record<string, unknown>;
  }): Promise<DocumentRecord> {
    return this.database.withTransaction(async (client) => {
      const documentId = randomUUID();
      const [documentRow] = (
        await client.query<DocumentRow>(
          `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
           VALUES ($1, $2, $3, $4, $5, 'queued', 1, $6::jsonb)
           RETURNING id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata`,
          [documentId, input.workspaceId, input.title, input.sourceContent, input.markdownContent, JSON.stringify(input.metadata ?? {})],
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

  async create(input: {
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
    metadata?: Record<string, unknown>;
  }): Promise<DocumentRecord> {
    const [row] = await this.database.query<DocumentRow>(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb)
       RETURNING id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata`,
      [randomUUID(), input.workspaceId, input.title, input.sourceContent, input.markdownContent, input.status, JSON.stringify(input.metadata ?? {})],
    );

    return mapDocument(row);
  }

  async updateAndQueue(input: {
    documentId: string;
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    metadata?: Record<string, unknown>;
  }): Promise<DocumentRecord> {
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
             metadata = COALESCE($6::jsonb, metadata)
         WHERE id = $1 AND workspace_id = $2
         RETURNING id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata`,
        [input.documentId, input.workspaceId, input.title, input.sourceContent, input.markdownContent, input.metadata ? JSON.stringify(input.metadata) : null],
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
      `SELECT id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata
       FROM documents
       WHERE workspace_id = $1
       ORDER BY updated_at DESC`,
      [workspaceId],
    );

    return rows.map(mapDocument);
  }

  async findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<DocumentRecord | null> {
    const [row] = await this.database.query<DocumentRow>(
      `SELECT id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata
       FROM documents
       WHERE id = $1 AND workspace_id = $2`,
      [documentId, workspaceId],
    );

    return row ? mapDocument(row) : null;
  }

  async update(input: {
    documentId: string;
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
    metadata?: Record<string, unknown>;
  }): Promise<DocumentRecord> {
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
           metadata = COALESCE($7::jsonb, metadata)
       WHERE id = $1 AND workspace_id = $2
       RETURNING id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata`,
      [input.documentId, input.workspaceId, input.title, input.sourceContent, input.markdownContent, input.status, input.metadata ? JSON.stringify(input.metadata) : null],
    );

    return mapDocument(row);
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
       RETURNING id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata`,
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
         RETURNING id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata`,
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
       RETURNING id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata`,
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
       RETURNING id, workspace_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at, metadata`,
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
