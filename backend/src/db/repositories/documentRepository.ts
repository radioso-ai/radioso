import { randomUUID } from "node:crypto";

import type { DocumentRecord, DocumentRepositoryPort } from "../../modules/documents/services/documentIngestionService.js";
import type { Database } from "../../shared/infra/database.js";

interface DocumentRow {
  id: string;
  account_id: string;
  title: string;
  source_content: string;
  markdown_content: string;
  status: string;
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
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class DocumentRepository implements DocumentRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: {
    accountId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
  }): Promise<DocumentRecord> {
    const [row] = await this.database.query<DocumentRow>(
      `INSERT INTO documents (id, account_id, title, source_content, markdown_content, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, account_id, title, source_content, markdown_content, status, created_at, updated_at`,
      [randomUUID(), input.accountId, input.title, input.sourceContent, input.markdownContent, input.status],
    );

    return mapDocument(row);
  }

  async listByAccountId(accountId: string): Promise<DocumentRecord[]> {
    const rows = await this.database.query<DocumentRow>(
      `SELECT id, account_id, title, source_content, markdown_content, status, created_at, updated_at
       FROM documents
       WHERE account_id = $1
       ORDER BY created_at DESC`,
      [accountId],
    );

    return rows.map(mapDocument);
  }

  async findByIdAndAccountId(documentId: string, accountId: string): Promise<DocumentRecord | null> {
    const [row] = await this.database.query<DocumentRow>(
      `SELECT id, account_id, title, source_content, markdown_content, status, created_at, updated_at
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
           updated_at = NOW()
       WHERE id = $1 AND account_id = $2
       RETURNING id, account_id, title, source_content, markdown_content, status, created_at, updated_at`,
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
       RETURNING id, account_id, title, source_content, markdown_content, status, created_at, updated_at`,
      [input.documentId, input.accountId, input.status, input.failureReason ?? null],
    );

    return mapDocument(row);
  }
}
