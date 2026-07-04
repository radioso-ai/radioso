import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type {
  DocumentProcessingJobOptions,
} from "./documentProcessingJobRepository.js";
import type {
  DocumentCreateInput,
  DocumentDerivedContentUpdateInput,
  DocumentEnrichmentMetadataUpdateInput,
  DocumentQueueUpdateInput,
  DocumentRecord,
  DocumentRepositoryPort,
  DocumentSummaryRecord,
  DocumentUpdateInput,
  DocumentWorkspaceSummaryRecord,
} from "../../modules/documents/contracts/index.js";
import type { MetadataFieldSuggestion, MetadataValueType } from "../../modules/settings/contracts/retrieval.js";
import { decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";
import { conflict, notFound } from "../../shared/domain/errors.js";
import { anyOf, currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import {
  collectMetadataPaths,
  mapDocument,
  mapDocumentSummary,
  type DocumentRow,
} from "./documentRowMapper.js";

interface QueuedDocumentRow {
  id: string;
  revision: number;
}

/**
 * Correlated `source` summary subquery shared by the full and summary projections. Mirrors
 * the raw `documentSelect`/`documentSummarySelect` subquery exactly: a single-row
 * `jsonb_build_object` from `document_sources` keyed on `documents.source_id`. Built as a
 * `sql` fragment because the column list is a fixed projection the Kysely builder can't
 * model more concisely than the SQL itself.
 */
const sourceSummaryExpression = sql<DocumentRow["source"]>`(
    SELECT jsonb_build_object(
      'id', s.id,
      'kind', s.kind,
      'name', s.name,
      'externalId', s.external_id
    )
    FROM document_sources s
    WHERE s.id = documents.source_id
  )`;

/**
 * `COALESCE(content_size_bytes, source_size_bytes, OCTET_LENGTH(source_content))` — the
 * derived size used by the summary projection. Preserves the raw `content_size` fallback
 * chain and ordering.
 */
const contentSizeExpression = sql<
  number | string | null
>`COALESCE(content_size_bytes, source_size_bytes, OCTET_LENGTH(source_content))`;

const documentSelectColumns = [
  "id",
  "workspace_id",
  "title",
  "source_content",
  "markdown_content",
  "source_id",
  sourceSummaryExpression.as("source"),
  "external_document_id",
  "status",
  "revision",
  "failure_reason",
  "created_at",
  "updated_at",
  "metadata",
  "source_kind",
  "source_filename",
  "source_mime_type",
  "source_storage_bucket",
  "source_storage_object",
  "source_storage_generation",
  "source_size_bytes",
  "content_size_bytes",
  "content_hash",
] as const;

const documentSummarySelectColumns = [
  "id",
  "workspace_id",
  "title",
  "status",
  "failure_reason",
  "created_at",
  "updated_at",
  "metadata",
  "source_id",
  sourceSummaryExpression.as("source"),
  "external_document_id",
  "source_kind",
  "source_filename",
  "source_mime_type",
  "source_storage_bucket",
  "source_storage_object",
  "source_storage_generation",
  "source_size_bytes",
  "content_size_bytes",
  "content_hash",
  contentSizeExpression.as("content_size"),
] as const;

const documentCursorCreatedAtExpression = sql<Date>`date_trunc('milliseconds', created_at)`;

export class DocumentRepository implements DocumentRepositoryPort {
  constructor(private readonly db: Db) {}

  async summarizeWorkspace(workspaceId: string): Promise<DocumentWorkspaceSummaryRecord> {
    const row = await this.db
      .selectFrom("documents")
      .select((eb) => [
        sql<string>`COUNT(*)::text`.as("document_count"),
        sql<string>`COUNT(*) FILTER (WHERE status = 'ready')::text`.as("ready_document_count"),
        sql<string>`COUNT(*) FILTER (WHERE status IN ('queued', 'processing'))::text`.as("pending_document_count"),
        sql<string>`COUNT(*) FILTER (WHERE metadata ->> 'sampleDocument' = 'true')::text`.as("sample_document_count"),
        sql<string[]>`COALESCE(
           ARRAY_AGG(metadata ->> 'sampleSlug')
             FILTER (
               WHERE metadata ->> 'sampleDocument' = 'true'
                 AND NULLIF(metadata ->> 'sampleSlug', '') IS NOT NULL
             ),
           ARRAY[]::text[]
         )`.as("sample_document_slugs"),
      ])
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();

    return {
      documentCount: Number(row?.document_count ?? "0"),
      readyDocumentCount: Number(row?.ready_document_count ?? "0"),
      pendingDocumentCount: Number(row?.pending_document_count ?? "0"),
      sampleDocumentCount: Number(row?.sample_document_count ?? "0"),
      sampleDocumentSlugs: row?.sample_document_slugs ?? [],
    };
  }

  async listMetadataFieldSuggestions(workspaceId: string): Promise<MetadataFieldSuggestion[]> {
    const rows = await this.db
      .selectFrom("documents")
      .select("metadata")
      .where("workspace_id", "=", workspaceId)
      .execute();

    const fields = new Map<string, MetadataValueType>();

    for (const row of rows) {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      for (const entry of collectMetadataPaths(metadata)) {
        const existing = fields.get(entry.path);
        fields.set(entry.path, existing && existing !== entry.inferredType ? "string" : entry.inferredType);
      }
    }

    return [...fields.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, inferredType]) => ({ field, inferredType }));
  }

  async createAndQueue(input: DocumentCreateInput, options?: DocumentProcessingJobOptions | null): Promise<DocumentRecord> {
    return this.db.transaction().execute(async (trx) => {
      const documentId = randomUUID();
      // ON CONFLICT target depends on whether the document is sourced: a sourced page keys
      // on (workspace_id, source_id, external_document_id); a manual document keys on
      // (workspace_id, external_document_id). Each is a partial unique index, so the target
      // is its column list plus the index predicate (Kysely: .columns(...).where(...)).
      const conflictColumns = (input.sourceId
        ? ["workspace_id", "source_id", "external_document_id"]
        : ["workspace_id", "external_document_id"]) as ("workspace_id" | "source_id" | "external_document_id")[];
      const conflictPredicate = input.sourceId
        ? sql<boolean>`source_id IS NOT NULL AND external_document_id IS NOT NULL`
        : sql<boolean>`source_id IS NULL AND external_document_id IS NOT NULL`;

      const documentRow = (await trx
        .insertInto("documents")
        .values({
          id: documentId,
          workspace_id: input.workspaceId,
          title: input.title,
          source_content: input.sourceContent,
          markdown_content: input.markdownContent,
          source_id: input.sourceId ?? null,
          external_document_id: input.externalDocumentId ?? null,
          status: "queued",
          revision: 1,
          metadata: toJsonb(input.metadata ?? {}),
          source_kind: input.sourceKind ?? "inline_text",
          source_filename: input.sourceFilename ?? null,
          source_mime_type: input.sourceMimeType ?? null,
          source_storage_bucket: input.sourceStorageBucket ?? null,
          source_storage_object: input.sourceStorageObject ?? null,
          source_storage_generation: input.sourceStorageGeneration ?? null,
          source_size_bytes: input.sourceSizeBytes ?? null,
          content_size_bytes: input.contentSizeBytes ?? null,
          content_hash: input.contentHash ?? null,
        })
        .onConflict((oc) =>
          oc.columns(conflictColumns).where(conflictPredicate).doUpdateSet((eb) => ({
            title: eb.ref("excluded.title"),
            source_content: eb.ref("excluded.source_content"),
            markdown_content: eb.ref("excluded.markdown_content"),
            source_id: eb.ref("excluded.source_id"),
            status: "queued",
            revision: sql<number>`documents.revision + 1`,
            failed_at: null,
            failure_reason: null,
            updated_at: currentTimestamp(),
            metadata: eb.ref("excluded.metadata"),
            source_kind: eb.ref("excluded.source_kind"),
            source_filename: eb.ref("excluded.source_filename"),
            source_mime_type: eb.ref("excluded.source_mime_type"),
            source_storage_bucket: eb.ref("excluded.source_storage_bucket"),
            source_storage_object: eb.ref("excluded.source_storage_object"),
            source_storage_generation: eb.ref("excluded.source_storage_generation"),
            source_size_bytes: eb.ref("excluded.source_size_bytes"),
            content_size_bytes: eb.ref("excluded.content_size_bytes"),
            content_hash: eb.ref("excluded.content_hash"),
          })).where(sql<boolean>`documents.source_kind = excluded.source_kind`),
        )
        .returning(documentSelectColumns)
        .executeTakeFirst()) as DocumentRow | undefined;

      if (!documentRow) {
        throw conflict("Imported documents cannot be updated through the inline document API");
      }

      await this.insertProcessingJob(trx, documentRow.id, input.workspaceId, documentRow.revision, options);

      return mapDocument(documentRow);
    });
  }

  async create(input: DocumentCreateInput & { status: string }): Promise<DocumentRecord> {
    const row = (await this.db
      .insertInto("documents")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        title: input.title,
        source_content: input.sourceContent,
        markdown_content: input.markdownContent,
        source_id: input.sourceId ?? null,
        external_document_id: input.externalDocumentId ?? null,
        status: input.status,
        revision: 1,
        metadata: toJsonb(input.metadata ?? {}),
        source_kind: input.sourceKind ?? "inline_text",
        source_filename: input.sourceFilename ?? null,
        source_mime_type: input.sourceMimeType ?? null,
        source_storage_bucket: input.sourceStorageBucket ?? null,
        source_storage_object: input.sourceStorageObject ?? null,
        source_storage_generation: input.sourceStorageGeneration ?? null,
        source_size_bytes: input.sourceSizeBytes ?? null,
        content_size_bytes: input.contentSizeBytes ?? null,
        content_hash: input.contentHash ?? null,
      })
      .returning(documentSelectColumns)
      .executeTakeFirstOrThrow()) as DocumentRow;

    return mapDocument(row);
  }

  async updateAndQueue(input: DocumentQueueUpdateInput): Promise<DocumentRecord> {
    return this.db.transaction().execute(async (trx) => {
      const documentRow = (await trx
        .updateTable("documents")
        .set((eb) => ({
          title: input.title,
          source_content: input.sourceContent,
          markdown_content: input.markdownContent,
          status: "queued",
          revision: sql<number>`revision + 1`,
          failed_at: null,
          failure_reason: null,
          updated_at: currentTimestamp(),
          metadata:
            input.metadata !== undefined
              ? toJsonb(input.metadata)
              : eb.ref("metadata"),
          external_document_id: eb.fn.coalesce(
            eb.val(input.externalDocumentId ?? null),
            "external_document_id",
          ),
          source_id: eb.fn.coalesce(eb.val(input.sourceId ?? null), "source_id"),
          source_kind: eb.fn.coalesce(eb.val(input.sourceKind ?? null), "source_kind"),
          source_filename: eb.fn.coalesce(eb.val(input.sourceFilename ?? null), "source_filename"),
          source_mime_type: eb.fn.coalesce(eb.val(input.sourceMimeType ?? null), "source_mime_type"),
          source_storage_bucket: eb.fn.coalesce(
            eb.val(input.sourceStorageBucket ?? null),
            "source_storage_bucket",
          ),
          source_storage_object: eb.fn.coalesce(
            eb.val(input.sourceStorageObject ?? null),
            "source_storage_object",
          ),
          source_storage_generation: eb.fn.coalesce(
            eb.val(input.sourceStorageGeneration ?? null),
            "source_storage_generation",
          ),
          source_size_bytes: eb.fn.coalesce(eb.val(input.sourceSizeBytes ?? null), "source_size_bytes"),
          content_size_bytes: eb.fn.coalesce(eb.val(input.contentSizeBytes ?? null), "content_size_bytes"),
          content_hash: eb.fn.coalesce(eb.val(input.contentHash ?? null), "content_hash"),
        }))
        .where("id", "=", input.documentId)
        .where("workspace_id", "=", input.workspaceId)
        .returning(documentSelectColumns)
        .executeTakeFirst()
        .catch((error: unknown) => {
          throw this.mapDocumentConflict(error);
        })) as DocumentRow | undefined;

      if (!documentRow) {
        throw notFound("Document not found");
      }

      await this.insertProcessingJob(trx, input.documentId, input.workspaceId, documentRow.revision);

      return mapDocument(documentRow);
    });
  }

  async listByWorkspaceId(workspaceId: string): Promise<DocumentRecord[]> {
    const rows = (await this.db
      .selectFrom("documents")
      .select(documentSelectColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .execute()) as DocumentRow[];

    return rows.map(mapDocument);
  }

  async listSummariesByIdsAndWorkspaceId(workspaceId: string, documentIds: string[]): Promise<DocumentSummaryRecord[]> {
    if (documentIds.length === 0) {
      return [];
    }

    const rows = (await this.db
      .selectFrom("documents")
      .select(documentSummarySelectColumns)
      .where("workspace_id", "=", workspaceId)
      .where((eb) => anyOf(eb.ref("id"), documentIds, "uuid[]"))
      .execute()) as DocumentRow[];

    return rows.map(mapDocumentSummary);
  }

  async listSummaryPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ documents: DocumentSummaryRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const total =
      cursor?.totalSnapshot !== undefined
        ? Number(cursor.totalSnapshot)
        : Number(
            (
              await this.db
                .selectFrom("documents")
                .select(sql<string>`COUNT(*)::text`.as("count"))
                .where("workspace_id", "=", workspaceId)
                .executeTakeFirst()
            )?.count ?? "0",
          );

    const rows = (await this.db
      .selectFrom("documents")
      .select(documentSummarySelectColumns)
      .where("workspace_id", "=", workspaceId)
      .$if(Boolean(cursor), (qb) =>
        qb.where((eb) =>
          eb.or([
            eb(documentCursorCreatedAtExpression, "<", sql<Date>`${cursor!.keys.createdAt}::timestamptz`),
            eb.and([
              eb(documentCursorCreatedAtExpression, "=", sql<Date>`${cursor!.keys.createdAt}::timestamptz`),
              eb("id", "<", sql<string>`${cursor!.keys.id}::uuid`),
            ]),
          ]),
        ),
      )
      .orderBy(documentCursorCreatedAtExpression, "desc")
      .orderBy("id", "desc")
      .limit(input.limit + 1)
      .$if(!cursor, (qb) => qb.offset(input.offset ?? 0))
      .execute()) as DocumentRow[];

    const documents = rows.slice(0, input.limit).map(mapDocumentSummary);
    const hasMore = rows.length > input.limit;
    const lastDocument = documents.at(-1);

    return {
      documents,
      total,
      nextCursor:
        hasMore && lastDocument
          ? encodeCursor(
              {
                createdAt: lastDocument.createdAt.toISOString(),
                id: lastDocument.id,
              },
              total,
            )
          : null,
      hasMore,
    };
  }

  async findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<DocumentRecord | null> {
    const row = (await this.db
      .selectFrom("documents")
      .select(documentSelectColumns)
      .where("id", "=", documentId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst()) as DocumentRow | undefined;

    return row ? mapDocument(row) : null;
  }

  async findByExternalDocumentId(
    workspaceId: string,
    externalDocumentId: string,
  ): Promise<DocumentRecord | null> {
    const row = (await this.db
      .selectFrom("documents")
      .select(documentSelectColumns)
      .where("workspace_id", "=", workspaceId)
      .where("external_document_id", "=", externalDocumentId)
      .limit(1)
      .executeTakeFirst()) as DocumentRow | undefined;

    return row ? mapDocument(row) : null;
  }

  async update(input: DocumentUpdateInput): Promise<DocumentRecord> {
    const row = (await this.db
      .updateTable("documents")
      .set((eb) => ({
        title: input.title,
        source_content: input.sourceContent,
        markdown_content: input.markdownContent,
        status: input.status,
        revision: sql<number>`revision + 1`,
        failed_at: null,
        failure_reason: null,
        updated_at: currentTimestamp(),
        metadata:
          input.metadata !== undefined ? toJsonb(input.metadata) : eb.ref("metadata"),
        external_document_id: eb.fn.coalesce(
          eb.val(input.externalDocumentId ?? null),
          "external_document_id",
        ),
        source_id: eb.fn.coalesce(eb.val(input.sourceId ?? null), "source_id"),
        source_kind: eb.fn.coalesce(eb.val(input.sourceKind ?? null), "source_kind"),
        source_filename: eb.fn.coalesce(eb.val(input.sourceFilename ?? null), "source_filename"),
        source_mime_type: eb.fn.coalesce(eb.val(input.sourceMimeType ?? null), "source_mime_type"),
        source_storage_bucket: eb.fn.coalesce(
          eb.val(input.sourceStorageBucket ?? null),
          "source_storage_bucket",
        ),
        source_storage_object: eb.fn.coalesce(
          eb.val(input.sourceStorageObject ?? null),
          "source_storage_object",
        ),
        source_storage_generation: eb.fn.coalesce(
          eb.val(input.sourceStorageGeneration ?? null),
          "source_storage_generation",
        ),
        source_size_bytes: eb.fn.coalesce(eb.val(input.sourceSizeBytes ?? null), "source_size_bytes"),
        content_size_bytes: eb.fn.coalesce(eb.val(input.contentSizeBytes ?? null), "content_size_bytes"),
        content_hash: eb.fn.coalesce(eb.val(input.contentHash ?? null), "content_hash"),
      }))
      .where("id", "=", input.documentId)
      .where("workspace_id", "=", input.workspaceId)
      .returning(documentSelectColumns)
      .executeTakeFirst()
      .catch((error: unknown) => {
        throw this.mapDocumentConflict(error);
      })) as DocumentRow | undefined;

    // Preserves the raw behaviour: a no-match `UPDATE … RETURNING` yields `undefined`, and
    // `mapDocument(undefined)` threw a TypeError. The non-null assertion keeps that contract.
    return mapDocument(row!);
  }

  async updateDerivedContentForRevision(input: DocumentDerivedContentUpdateInput): Promise<DocumentRecord | null> {
    const row = (await this.db
      .updateTable("documents")
      .set({
        source_content: input.sourceContent,
        markdown_content: input.markdownContent,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", input.documentId)
      .where("workspace_id", "=", input.workspaceId)
      .where("revision", "=", input.revision)
      .returning(documentSelectColumns)
      .executeTakeFirst()) as DocumentRow | undefined;

    return row ? mapDocument(row) : null;
  }

  async updateMetadataForRevision(input: DocumentEnrichmentMetadataUpdateInput): Promise<DocumentRecord | null> {
    const row = (await this.db
      .updateTable("documents")
      .set({
        metadata: toJsonb(input.metadata),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", input.documentId)
      .where("workspace_id", "=", input.workspaceId)
      .where("revision", "=", input.revision)
      .returning(documentSelectColumns)
      .executeTakeFirst()) as DocumentRow | undefined;

    return row ? mapDocument(row) : null;
  }

  async requeue(documentId: string, workspaceId: string): Promise<DocumentRecord> {
    const row = (await this.db
      .updateTable("documents")
      .set({
        status: "queued",
        revision: sql<number>`revision + 1`,
        failed_at: null,
        failure_reason: null,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", documentId)
      .where("workspace_id", "=", workspaceId)
      .returning(documentSelectColumns)
      .executeTakeFirst()) as DocumentRow | undefined;

    return mapDocument(row!);
  }

  async requeueAndQueue(
    documentId: string,
    workspaceId: string,
    options?: DocumentProcessingJobOptions | null,
  ): Promise<DocumentRecord> {
    return this.db.transaction().execute(async (trx) => {
      const documentRow = (await trx
        .updateTable("documents")
        .set({
          status: "queued",
          revision: sql<number>`revision + 1`,
          failed_at: null,
          failure_reason: null,
          updated_at: currentTimestamp(),
        })
        .where("id", "=", documentId)
        .where("workspace_id", "=", workspaceId)
        .returning(documentSelectColumns)
        .executeTakeFirst()) as DocumentRow | undefined;

      if (!documentRow) {
        throw notFound("Document not found");
      }

      await this.insertProcessingJob(trx, documentId, workspaceId, documentRow.revision, options);

      return mapDocument(documentRow);
    });
  }

  async requeueAllEligibleAndQueue(workspaceId: string, options?: DocumentProcessingJobOptions | null): Promise<{
    queuedDocumentCount: number;
    skippedDocumentCount: number;
    queuedDocuments: Array<{ documentId: string; revision: number }>;
  }> {
    return this.db.transaction().execute(async (trx) => {
      const counts = await trx
        .selectFrom("documents")
        .select([
          sql<string>`COUNT(*)::text`.as("total_count"),
          sql<string>`COUNT(*) FILTER (WHERE status IN ('queued', 'processing'))::text`.as("skipped_count"),
        ])
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();

      const queuedRows = (await trx
        .updateTable("documents")
        .set({
          status: "queued",
          revision: sql<number>`revision + 1`,
          failed_at: null,
          failure_reason: null,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", workspaceId)
        .where("status", "not in", ["queued", "processing"])
        .returning(["id", "revision"])
        .execute()) as QueuedDocumentRow[];

      for (const documentRow of queuedRows) {
        await this.insertProcessingJob(trx, documentRow.id, workspaceId, documentRow.revision, options);
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

  async requeueSourceEligibleAndQueue(input: {
    workspaceId: string;
    sourceId: string;
    options?: DocumentProcessingJobOptions | null;
  }): Promise<{
    queuedDocumentCount: number;
    skippedDocumentCount: number;
    queuedDocuments: Array<{ documentId: string; revision: number }>;
  }> {
    return this.db.transaction().execute(async (trx) => {
      const counts = await trx
        .selectFrom("documents")
        .select([
          sql<string>`COUNT(*)::text`.as("total_count"),
          sql<string>`COUNT(*) FILTER (WHERE status IN ('queued', 'processing'))::text`.as("skipped_count"),
        ])
        .where("workspace_id", "=", input.workspaceId)
        .where("source_id", "=", input.sourceId)
        .executeTakeFirst();

      const queuedRows = (await trx
        .updateTable("documents")
        .set({
          status: "queued",
          revision: sql<number>`revision + 1`,
          failed_at: null,
          failure_reason: null,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("source_id", "=", input.sourceId)
        .where("status", "in", ["ready", "failed"])
        .returning(["id", "revision"])
        .execute()) as QueuedDocumentRow[];

      for (const documentRow of queuedRows) {
        await this.insertProcessingJob(trx, documentRow.id, input.workspaceId, documentRow.revision, input.options);
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
    const row = (await this.db
      .updateTable("documents")
      .set({
        status: input.status,
        failed_at: sql<Date | null>`CASE WHEN ${input.status} = 'failed' THEN NOW() ELSE NULL END`,
        failure_reason: sql<string | null>`CASE WHEN ${input.status} = 'failed' THEN ${
          input.failureReason ?? null
        } ELSE NULL END`,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", input.documentId)
      .where("workspace_id", "=", input.workspaceId)
      .returning(documentSelectColumns)
      .executeTakeFirst()) as DocumentRow | undefined;

    return mapDocument(row!);
  }

  async setStatusIfRevisionMatches(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord | null> {
    const row = (await this.db
      .updateTable("documents")
      .set({
        status: input.status,
        failed_at: sql<Date | null>`CASE WHEN ${input.status} = 'failed' THEN NOW() ELSE NULL END`,
        failure_reason: sql<string | null>`CASE WHEN ${input.status} = 'failed' THEN ${
          input.failureReason ?? null
        } ELSE NULL END`,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", input.documentId)
      .where("workspace_id", "=", input.workspaceId)
      .where("revision", "=", input.revision)
      .returning(documentSelectColumns)
      .executeTakeFirst()) as DocumentRow | undefined;

    return row ? mapDocument(row) : null;
  }

  async deleteByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<boolean> {
    const rows = await this.db
      .deleteFrom("documents")
      .where("id", "=", documentId)
      .where("workspace_id", "=", workspaceId)
      .returning("id")
      .execute();

    return rows.length > 0;
  }

  async listSummaryPageBySourceId(
    workspaceId: string,
    sourceId: string | null,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ documents: DocumentSummaryRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const total =
      cursor?.totalSnapshot !== undefined
        ? Number(cursor.totalSnapshot)
        : Number(
            (
              await this.db
                .selectFrom("documents")
                .select(sql<string>`COUNT(*)::text`.as("count"))
                .where("workspace_id", "=", workspaceId)
                // `source_id = $n` for a concrete source; `source_id IS NULL` for the manual bucket.
                .$if(sourceId === null, (qb) => qb.where("source_id", "is", null))
                .$if(sourceId !== null, (qb) => qb.where("source_id", "=", sourceId!))
                .executeTakeFirst()
            )?.count ?? "0",
          );

    const rows = (await this.db
      .selectFrom("documents")
      .select(documentSummarySelectColumns)
      .where("workspace_id", "=", workspaceId)
      .$if(sourceId === null, (qb) => qb.where("source_id", "is", null))
      .$if(sourceId !== null, (qb) => qb.where("source_id", "=", sourceId!))
      .$if(Boolean(cursor), (qb) =>
        qb.where((eb) =>
          eb.or([
            eb(documentCursorCreatedAtExpression, "<", sql<Date>`${cursor!.keys.createdAt}::timestamptz`),
            eb.and([
              eb(documentCursorCreatedAtExpression, "=", sql<Date>`${cursor!.keys.createdAt}::timestamptz`),
              eb("id", "<", sql<string>`${cursor!.keys.id}::uuid`),
            ]),
          ]),
        ),
      )
      .orderBy(documentCursorCreatedAtExpression, "desc")
      .orderBy("id", "desc")
      .limit(input.limit + 1)
      .$if(!cursor, (qb) => qb.offset(input.offset ?? 0))
      .execute()) as DocumentRow[];

    const documents = rows.slice(0, input.limit).map(mapDocumentSummary);
    const hasMore = rows.length > input.limit;
    const lastDocument = documents.at(-1);

    return {
      documents,
      total,
      nextCursor:
        hasMore && lastDocument
          ? encodeCursor(
              {
                createdAt: lastDocument.createdAt.toISOString(),
                id: lastDocument.id,
              },
              total,
            )
          : null,
      hasMore,
    };
  }

  async deleteBySourceIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<{
    count: number;
    storageRefs: Array<{ bucket: string; objectPath: string; generation: string | null }>;
  }> {
    const rows = await this.db
      .deleteFrom("documents")
      .where("source_id", "=", sourceId)
      .where("workspace_id", "=", workspaceId)
      .returning([
        "id",
        "source_kind",
        "source_storage_bucket",
        "source_storage_object",
        "source_storage_generation",
      ])
      .execute();

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

    let query = this.db
      .selectFrom("documents")
      .select(["id", "revision", "content_size_bytes", "content_hash"])
      .where("workspace_id", "=", input.workspaceId)
      .where("external_document_id", "=", input.externalDocumentId)
      .where("status", "<>", "failed");
    query = sourceId === null ? query.where("source_id", "is", null) : query.where("source_id", "=", sourceId);

    const row = await query.limit(1).executeTakeFirst();

    if (!row) {
      return null;
    }

    const rawBytes = row.content_size_bytes;
    const bytes = typeof rawBytes === "string" ? Number(rawBytes) : rawBytes ?? null;

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

    let query = this.db
      .deleteFrom("documents")
      .where("source_id", "=", input.sourceId)
      .where("workspace_id", "=", input.workspaceId)
      .where("external_document_id", "is not", null);
    if (keep.length > 0) {
      query = query.where(sql<boolean>`external_document_id <> ALL(${sql.val(keep)}::text[])`);
    }

    const rows = await query.returning(["id", "content_size_bytes"]).execute();

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

  private async insertProcessingJob(
    db: Db,
    documentId: string,
    workspaceId: string,
    documentRevision: number,
    options?: DocumentProcessingJobOptions | null,
  ): Promise<void> {
    await db
      .insertInto("document_processing_jobs")
      .values({
        id: randomUUID(),
        document_id: documentId,
        workspace_id: workspaceId,
        document_revision: documentRevision,
        status: "queued",
        options: options ? toJsonb(options) : null,
      })
      .execute();
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
