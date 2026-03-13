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
}
