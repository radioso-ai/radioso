import { randomUUID } from "node:crypto";

import type { DocumentRecord, DocumentRepositoryPort } from "../../modules/documents/services/documentIngestionService.js";
import type { Database } from "../../shared/infra/database.js";
import { notFound } from "../../shared/domain/errors.js";

interface DocumentRow {
  id: string;
  account_id: string;
  title: string;
  source_content: string;
  markdown_content: string;
  status: string;
  revision: number;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const mapDocument = (row: DocumentRow): DocumentRecord => ({
  id: row.id,
  accountId: row.account_id,
  title: row.title,
  sourceContent: row.source_content,
  markdownContent: row.markdown_content,
  status: row.status,
  revision: row.revision,
  failureReason: row.failure_reason,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class DocumentRepository implements DocumentRepositoryPort {
  constructor(private readonly database: Database) {}

  async createAndQueue(input: {
    accountId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
  }): Promise<DocumentRecord> {
    return this.database.withTransaction(async (client) => {
      const documentId = randomUUID();
      const [documentRow] = (
        await client.query<DocumentRow>(
          `INSERT INTO documents (id, account_id, title, source_content, markdown_content, status, revision)
           VALUES ($1, $2, $3, $4, $5, 'queued', 1)
           RETURNING id, account_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at`,
          [documentId, input.accountId, input.title, input.sourceContent, input.markdownContent],
        )
      ).rows;

      await client.query(
        `INSERT INTO document_processing_jobs (id, document_id, account_id, document_revision, status)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [randomUUID(), documentId, input.accountId, documentRow.revision],
      );

      return mapDocument(documentRow);
    });
  }

  async create(input: {
    accountId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
  }): Promise<DocumentRecord> {
    const [row] = await this.database.query<DocumentRow>(
      `INSERT INTO documents (id, account_id, title, source_content, markdown_content, status, revision)
       VALUES ($1, $2, $3, $4, $5, $6, 1)
       RETURNING id, account_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at`,
      [randomUUID(), input.accountId, input.title, input.sourceContent, input.markdownContent, input.status],
    );

    return mapDocument(row);
  }

  async updateAndQueue(input: {
    documentId: string;
    accountId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
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
             updated_at = NOW()
         WHERE id = $1 AND account_id = $2
         RETURNING id, account_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at`,
        [input.documentId, input.accountId, input.title, input.sourceContent, input.markdownContent],
      );
      const [documentRow] = documentResult.rows;

      if (!documentRow) {
        throw notFound("Document not found");
      }

      await client.query(
        `INSERT INTO document_processing_jobs (id, document_id, account_id, document_revision, status)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [randomUUID(), input.documentId, input.accountId, documentRow.revision],
      );

      return mapDocument(documentRow);
    });
  }

  async listByAccountId(accountId: string): Promise<DocumentRecord[]> {
    const rows = await this.database.query<DocumentRow>(
      `SELECT id, account_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at
       FROM documents
       WHERE account_id = $1
       ORDER BY updated_at DESC`,
      [accountId],
    );

    return rows.map(mapDocument);
  }

  async findByIdAndAccountId(documentId: string, accountId: string): Promise<DocumentRecord | null> {
    const [row] = await this.database.query<DocumentRow>(
      `SELECT id, account_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at
       FROM documents
       WHERE id = $1 AND account_id = $2`,
      [documentId, accountId],
    );

    return row ? mapDocument(row) : null;
  }

  async update(input: {
    documentId: string;
    accountId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
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
           updated_at = NOW()
       WHERE id = $1 AND account_id = $2
       RETURNING id, account_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at`,
      [
        input.documentId,
        input.accountId,
        input.title,
        input.sourceContent,
        input.markdownContent,
        input.status,
      ],
    );

    return mapDocument(row);
  }

  async requeue(documentId: string, accountId: string): Promise<DocumentRecord> {
    const [row] = await this.database.query<DocumentRow>(
      `UPDATE documents
       SET status = 'queued',
           revision = revision + 1,
           failed_at = NULL,
           failure_reason = NULL,
           updated_at = NOW()
       WHERE id = $1 AND account_id = $2
       RETURNING id, account_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at`,
      [documentId, accountId],
    );

    return mapDocument(row);
  }

  async requeueAndQueue(documentId: string, accountId: string): Promise<DocumentRecord> {
    return this.database.withTransaction(async (client) => {
      const documentResult = await client.query<DocumentRow>(
        `UPDATE documents
         SET status = 'queued',
             revision = revision + 1,
             failed_at = NULL,
             failure_reason = NULL,
             updated_at = NOW()
         WHERE id = $1 AND account_id = $2
         RETURNING id, account_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at`,
        [documentId, accountId],
      );
      const [documentRow] = documentResult.rows;

      if (!documentRow) {
        throw notFound("Document not found");
      }

      await client.query(
        `INSERT INTO document_processing_jobs (id, document_id, account_id, document_revision, status)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [randomUUID(), documentId, accountId, documentRow.revision],
      );

      return mapDocument(documentRow);
    });
  }

  async setStatus(input: {
    documentId: string;
    accountId: string;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord> {
    const [row] = await this.database.query<DocumentRow>(
      `UPDATE documents
       SET status = $3,
           failed_at = CASE WHEN $3 = 'failed' THEN NOW() ELSE NULL END,
           failure_reason = CASE WHEN $3 = 'failed' THEN $4 ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1 AND account_id = $2
       RETURNING id, account_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at`,
      [input.documentId, input.accountId, input.status, input.failureReason ?? null],
    );

    return mapDocument(row);
  }

  async setStatusIfRevisionMatches(input: {
    documentId: string;
    accountId: string;
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
         AND account_id = $2
         AND revision = $3
       RETURNING id, account_id, title, source_content, markdown_content, status, revision, failure_reason, created_at, updated_at`,
      [input.documentId, input.accountId, input.revision, input.status, input.failureReason ?? null],
    );

    return row ? mapDocument(row) : null;
  }

  async deleteByIdAndAccountId(documentId: string, accountId: string): Promise<boolean> {
    const rows = await this.database.query<{ id: string }>(
      `DELETE FROM documents
       WHERE id = $1 AND account_id = $2
       RETURNING id`,
      [documentId, accountId],
    );

    return rows.length > 0;
  }
}
