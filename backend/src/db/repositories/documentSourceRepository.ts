import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export type DocumentOriginKind = "website" | "api" | "connector" | "upload";

export interface DocumentSourceRecord {
  id: string;
  workspaceId: string;
  kind: DocumentOriginKind;
  name: string;
  externalId: string | null;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  lastSyncStatus: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentSourceSummary {
  id: string;
  kind: DocumentOriginKind;
  name: string;
  externalId: string | null;
}

export interface DocumentSourceRepositoryPort {
  findByIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<DocumentSourceRecord | null>;
  upsertByExternalId(input: {
    workspaceId: string;
    kind: DocumentOriginKind;
    name: string;
    externalId: string;
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<DocumentSourceRecord>;
  updateSyncState(input: {
    workspaceId: string;
    sourceId: string;
    status: string;
    syncedAt?: Date | null;
  }): Promise<void>;
}

interface DocumentSourceRow {
  id: string;
  workspace_id: string;
  kind: DocumentOriginKind;
  name: string;
  external_id: string | null;
  config: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  last_sync_status: string | null;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const sourceSelect = `
  id,
  workspace_id,
  kind,
  name,
  external_id,
  config,
  metadata,
  last_sync_status,
  last_synced_at,
  created_at,
  updated_at
`;

export const toDocumentSourceSummary = (source: DocumentSourceRecord): DocumentSourceSummary => ({
  id: source.id,
  kind: source.kind,
  name: source.name,
  externalId: source.externalId,
});

export const mapDocumentSource = (row: DocumentSourceRow): DocumentSourceRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  kind: row.kind,
  name: row.name,
  externalId: row.external_id,
  config: row.config ?? {},
  metadata: row.metadata ?? {},
  lastSyncStatus: row.last_sync_status,
  lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class DocumentSourceRepository implements DocumentSourceRepositoryPort {
  constructor(private readonly database: Database) {}

  async findByIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<DocumentSourceRecord | null> {
    const [row] = await this.database.query<DocumentSourceRow>(
      `SELECT ${sourceSelect}
       FROM document_sources
       WHERE id = $1 AND workspace_id = $2`,
      [sourceId, workspaceId],
    );

    return row ? mapDocumentSource(row) : null;
  }

  async upsertByExternalId(input: {
    workspaceId: string;
    kind: DocumentOriginKind;
    name: string;
    externalId: string;
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<DocumentSourceRecord> {
    const [row] = await this.database.query<DocumentSourceRow>(
      `INSERT INTO document_sources (
         id,
         workspace_id,
         kind,
         name,
         external_id,
         config,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       ON CONFLICT (workspace_id, kind, external_id) WHERE external_id IS NOT NULL
       DO UPDATE
         SET name = EXCLUDED.name,
             config = EXCLUDED.config,
             metadata = document_sources.metadata || EXCLUDED.metadata,
             updated_at = NOW()
       RETURNING ${sourceSelect}`,
      [
        randomUUID(),
        input.workspaceId,
        input.kind,
        input.name,
        input.externalId,
        JSON.stringify(input.config ?? {}),
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    return mapDocumentSource(row);
  }

  async updateSyncState(input: {
    workspaceId: string;
    sourceId: string;
    status: string;
    syncedAt?: Date | null;
  }): Promise<void> {
    await this.database.query(
      `UPDATE document_sources
       SET last_sync_status = $3,
           last_synced_at = COALESCE($4, last_synced_at),
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2`,
      [input.sourceId, input.workspaceId, input.status, input.syncedAt ?? null],
    );
  }
}
