import { randomUUID } from "node:crypto";

import { currentTimestamp, jsonbConcat, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { DocumentSourceSummary } from "../../modules/documents/contracts/documentContracts.js";

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

export interface DocumentSourceListRecord extends DocumentSourceRecord {
  documentCount: number;
}

export interface DocumentSourceRepositoryPort {
  findByIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<DocumentSourceRecord | null>;
  findExistingIdsByWorkspaceId(workspaceId: string, sourceIds: string[]): Promise<string[]>;
  listByWorkspaceIdWithDocumentCounts(workspaceId: string): Promise<DocumentSourceListRecord[]>;
  countDocumentsWithoutSource(workspaceId: string): Promise<number>;
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
  updateConfigByIdAndWorkspaceId(input: {
    sourceId: string;
    workspaceId: string;
    config: Record<string, unknown>;
  }): Promise<DocumentSourceRecord>;
  deleteByIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<boolean>;
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

interface DocumentSourceListRow extends DocumentSourceRow {
  document_count: string;
}

const sourceColumns = [
  "id",
  "workspace_id",
  "kind",
  "name",
  "external_id",
  "config",
  "metadata",
  "last_sync_status",
  "last_synced_at",
  "created_at",
  "updated_at",
] as const;

const qualifiedSourceColumns = [
  "document_sources.id",
  "document_sources.workspace_id",
  "document_sources.kind",
  "document_sources.name",
  "document_sources.external_id",
  "document_sources.config",
  "document_sources.metadata",
  "document_sources.last_sync_status",
  "document_sources.last_synced_at",
  "document_sources.created_at",
  "document_sources.updated_at",
] as const;

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

const mapDocumentSourceListRecord = (row: DocumentSourceListRow): DocumentSourceListRecord => ({
  ...mapDocumentSource(row),
  documentCount: Number(row.document_count ?? "0"),
});

export class DocumentSourceRepository implements DocumentSourceRepositoryPort {
  constructor(private readonly db: Db) {}

  async findByIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<DocumentSourceRecord | null> {
    const row = await this.db
      .selectFrom("document_sources")
      .select(sourceColumns)
      .where("id", "=", sourceId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();

    return row ? mapDocumentSource(row as DocumentSourceRow) : null;
  }

  async findExistingIdsByWorkspaceId(workspaceId: string, sourceIds: string[]): Promise<string[]> {
    if (sourceIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom("document_sources")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("id", "in", sourceIds)
      .execute();

    return rows.map((row) => row.id);
  }

  async listByWorkspaceIdWithDocumentCounts(workspaceId: string): Promise<DocumentSourceListRecord[]> {
    const rows = await this.db
      .selectFrom("document_sources")
      .leftJoin("documents as d", (join) =>
        join.onRef("d.source_id", "=", "document_sources.id").onRef("d.workspace_id", "=", "document_sources.workspace_id"),
      )
      .select([...qualifiedSourceColumns, (eb) => eb.fn.count<string>("d.id").as("document_count")])
      .where("document_sources.workspace_id", "=", workspaceId)
      .groupBy("document_sources.id")
      .orderBy("document_sources.created_at", "desc")
      .orderBy("document_sources.id", "desc")
      .execute();

    return rows.map((row) => mapDocumentSourceListRecord(row as DocumentSourceListRow));
  }

  async countDocumentsWithoutSource(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom("documents")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .where("source_id", "is", null)
      .executeTakeFirst();

    return Number(row?.count ?? "0");
  }

  async upsertByExternalId(input: {
    workspaceId: string;
    kind: DocumentOriginKind;
    name: string;
    externalId: string;
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<DocumentSourceRecord> {
    const row = await this.db
      .insertInto("document_sources")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        kind: input.kind,
        name: input.name,
        external_id: input.externalId,
        config: toJsonb(input.config ?? {}),
        metadata: toJsonb(input.metadata ?? {}),
      })
      .onConflict((oc) =>
        // partial-index conflict target: (workspace_id, kind, external_id) WHERE external_id IS NOT NULL
        oc
          .columns(["workspace_id", "kind", "external_id"])
          .where("external_id", "is not", null)
          .doUpdateSet((eb) => ({
            name: eb.ref("excluded.name"),
            config: eb.ref("excluded.config"),
            metadata: jsonbConcat(eb.ref("document_sources.metadata"), eb.ref("excluded.metadata")),
            updated_at: currentTimestamp(),
          })),
      )
      .returning(sourceColumns)
      .executeTakeFirstOrThrow();

    return mapDocumentSource(row as DocumentSourceRow);
  }

  async updateSyncState(input: {
    workspaceId: string;
    sourceId: string;
    status: string;
    syncedAt?: Date | null;
  }): Promise<void> {
    await this.db
      .updateTable("document_sources")
      .set({
        last_sync_status: input.status,
        // COALESCE($, last_synced_at): keep existing when not provided.
        ...(input.syncedAt != null ? { last_synced_at: input.syncedAt } : {}),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", input.sourceId)
      .where("workspace_id", "=", input.workspaceId)
      .execute();
  }

  async updateConfigByIdAndWorkspaceId(input: {
    sourceId: string;
    workspaceId: string;
    config: Record<string, unknown>;
  }): Promise<DocumentSourceRecord> {
    const row = await this.db
      .updateTable("document_sources")
      .set({ config: toJsonb(input.config), updated_at: currentTimestamp() })
      .where("id", "=", input.sourceId)
      .where("workspace_id", "=", input.workspaceId)
      .returning(sourceColumns)
      .executeTakeFirst();

    if (!row) {
      throw new Error(`Document source ${input.sourceId} not found in workspace ${input.workspaceId}`);
    }
    return mapDocumentSource(row as DocumentSourceRow);
  }

  async deleteByIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("document_sources")
      .where("id", "=", sourceId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
