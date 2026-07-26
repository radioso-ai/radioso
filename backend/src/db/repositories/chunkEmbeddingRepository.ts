import { createHash, randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { EmbeddingSpaceRef } from "../../modules/embeddingProfiles/contracts/embeddingConsumers.js";
import type {
  ChunkEmbeddingRecord,
  ChunkEmbeddingRepositoryPort,
  ChunkEmbeddingWriteInput,
} from "../../modules/embeddingProfiles/contracts/repositories.js";
import {
  currentTimestamp,
  transactionAdvisoryLock,
} from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { appendVectorIndexWorkInTransaction } from "./vectorIndexWorkRepository.js";

interface ChunkEmbeddingRow {
  workspace_id: string;
  chunk_id: string;
  embedding_space_id: string;
  document_revision: number;
  canonical_version: string;
  dimensions: number;
  embedding: string;
  content_hash: string;
  created_at: Date;
  updated_at: Date;
}

interface StoredEmbeddingSpaceRow {
  id: string;
  dimensions: number;
  distance_metric: string;
}

export interface CanonicalChunkEmbeddingTransactionClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface CanonicalChunkEmbeddingPublication {
  workspaceId: string;
  documentId: string;
  documentRevision: number;
  canonicalVersion: string;
  embeddingSpace: EmbeddingSpaceRef;
  chunks: readonly {
    id: string;
    documentId: string;
    workspaceId: string;
    content: string;
    searchText?: string | null;
    metadata?: Record<string, unknown>;
    embedding: readonly number[];
  }[];
}

const chunkEmbeddingColumns = [
  "workspace_id",
  "chunk_id",
  "embedding_space_id",
  "document_revision",
  "canonical_version",
  "dimensions",
  "embedding",
  "content_hash",
  "created_at",
  "updated_at",
] as const;

export class ChunkEmbeddingRepository implements ChunkEmbeddingRepositoryPort {
  constructor(private readonly db: Db) {}

  async upsert(input: ChunkEmbeddingWriteInput): Promise<{
    record: ChunkEmbeddingRecord;
    applied: boolean;
  }> {
    return this.db.transaction().execute((trx) =>
      upsertCanonicalChunkEmbeddingWithProjection(trx, input));
  }

  async find(input: {
    workspaceId: string;
    chunkId: string;
    embeddingSpaceId: string;
  }): Promise<ChunkEmbeddingRecord | null> {
    const row = await this.db
      .selectFrom("chunk_embeddings")
      .select(chunkEmbeddingColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where("chunk_id", "=", input.chunkId)
      .where("embedding_space_id", "=", input.embeddingSpaceId)
      .executeTakeFirst();
    return row ? mapChunkEmbedding(row as ChunkEmbeddingRow) : null;
  }
}

export const insertCanonicalChunkEmbeddingsForDocumentRevision = async (
  client: CanonicalChunkEmbeddingTransactionClient,
  input: CanonicalChunkEmbeddingPublication,
): Promise<void> => {
  assertCanonicalVersion(input.canonicalVersion);
  const embeddingSpaceResult = await client.query<StoredEmbeddingSpaceRow>(
    `SELECT id, dimensions, distance_metric
     FROM embedding_spaces
     WHERE id = $1`,
    [input.embeddingSpace.id],
  );
  assertEmbeddingSpaceCompatibility(embeddingSpaceResult.rows[0], input.embeddingSpace);

  if (input.chunks.length === 0) {
    return;
  }

  const values: unknown[] = [];
  const placeholders = input.chunks.map((chunk, index) => {
    assertCanonicalChunkIdentity(chunk, input);
    assertEmbeddingVector(chunk.embedding, input.embeddingSpace.dimensions);
    const offset = index * 8;
    values.push(
      input.workspaceId,
      chunk.id,
      input.embeddingSpace.id,
      input.documentRevision,
      input.canonicalVersion,
      input.embeddingSpace.dimensions,
      serializeVector(chunk.embedding),
      hashEmbeddedContent(chunk.searchText ?? chunk.content),
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4},
             $${offset + 5}, $${offset + 6}, $${offset + 7}::vector, $${offset + 8})`;
  });

  await client.query(
    `INSERT INTO chunk_embeddings
       (workspace_id, chunk_id, embedding_space_id, document_revision,
        canonical_version, dimensions, embedding, content_hash)
     VALUES ${placeholders.join(", ")}`,
    values,
  );
  await appendCanonicalVectorProjectionWork(client, input);
};

export const upsertCanonicalChunkEmbeddingWithProjection = async (
  db: Db,
  input: ChunkEmbeddingWriteInput,
): Promise<{ record: ChunkEmbeddingRecord; applied: boolean }> => {
  assertCanonicalVersion(input.canonicalVersion);
  assertEmbeddingVector(input.embedding, input.dimensions);
  await transactionAdvisoryLock(
    `chunk-embedding:${input.workspaceId}:${input.chunkId}:${input.embeddingSpaceId}`,
  ).execute(db);

  const embeddingSpace = await db
    .selectFrom("embedding_spaces")
    .select(["id", "dimensions", "distance_metric"])
    .where("id", "=", input.embeddingSpaceId)
    .executeTakeFirst();
  assertEmbeddingSpaceCompatibility(
    embeddingSpace as StoredEmbeddingSpaceRow | undefined,
    {
      id: input.embeddingSpaceId,
      dimensions: input.dimensions,
      distanceMetric: "cosine",
    },
  );
  const canonicalChunk = await db
    .selectFrom("chunks as c")
    .innerJoin("documents as d", (join) =>
      join
        .onRef("d.id", "=", "c.document_id")
        .onRef("d.workspace_id", "=", "c.workspace_id"))
    .select([
      "c.id",
      "c.metadata",
      "d.revision",
      "d.source_id",
      "d.retrieval_enabled",
      "d.retrieval_expires_at",
    ])
    .where("c.workspace_id", "=", input.workspaceId)
    .where("c.id", "=", input.chunkId)
    .where("c.document_id", "=", input.documentId)
    .where("d.revision", "=", input.documentRevision)
    .executeTakeFirst();
  if (!canonicalChunk) {
    throw new Error("Canonical chunk revision no longer exists");
  }
  const existing = await db
    .selectFrom("chunk_embeddings")
    .select(chunkEmbeddingColumns)
    .where("workspace_id", "=", input.workspaceId)
    .where("chunk_id", "=", input.chunkId)
    .where("embedding_space_id", "=", input.embeddingSpaceId)
    .forUpdate()
    .executeTakeFirst();
  if (existing && BigInt(existing.canonical_version) >= BigInt(input.canonicalVersion)) {
    return {
      record: mapChunkEmbedding(existing as ChunkEmbeddingRow),
      applied: false,
    };
  }

  const values = {
    workspace_id: input.workspaceId,
    chunk_id: input.chunkId,
    embedding_space_id: input.embeddingSpaceId,
    document_revision: input.documentRevision,
    canonical_version: input.canonicalVersion,
    dimensions: input.dimensions,
    embedding: serializeVector(input.embedding),
    content_hash: input.contentHash,
  };
  const row = existing
    ? await db
        .updateTable("chunk_embeddings")
        .set({ ...values, updated_at: currentTimestamp() })
        .where("workspace_id", "=", input.workspaceId)
        .where("chunk_id", "=", input.chunkId)
        .where("embedding_space_id", "=", input.embeddingSpaceId)
        .returning(chunkEmbeddingColumns)
        .executeTakeFirstOrThrow()
    : await db
        .insertInto("chunk_embeddings")
        .values(values)
        .returning(chunkEmbeddingColumns)
        .executeTakeFirstOrThrow();
  await appendVectorIndexWorkInTransaction(db, {
    workspaceId: input.workspaceId,
    embeddingSpaceId: input.embeddingSpaceId,
    chunkId: input.chunkId,
    documentId: input.documentId,
    operation: "upsert",
    canonicalVersion: input.canonicalVersion,
    payload: {
      dimensions: input.dimensions,
      distanceMetric: "cosine",
      vector: [...input.embedding],
      sourceId: canonicalChunk.source_id,
      metadata: (canonicalChunk.metadata ?? {}) as Record<string, unknown>,
      retrievalEnabled: canonicalChunk.retrieval_enabled,
      retrievalExpiresAt: canonicalChunk.retrieval_expires_at
        ? new Date(canonicalChunk.retrieval_expires_at).toISOString()
        : null,
    },
  });
  return {
    record: mapChunkEmbedding(row as ChunkEmbeddingRow),
    applied: true,
  };
};

export const appendCanonicalVectorProjectionWork = async (
  client: CanonicalChunkEmbeddingTransactionClient,
  input: CanonicalChunkEmbeddingPublication,
): Promise<void> => {
  if (input.chunks.length === 0) {
    return;
  }
  const document = await client.query<{
    source_id: string | null;
    retrieval_enabled: boolean;
    retrieval_expires_at: Date | string | null;
  }>(
    `SELECT source_id, retrieval_enabled, retrieval_expires_at
     FROM documents
     WHERE id = $1
       AND workspace_id = $2
       AND revision = $3`,
    [input.documentId, input.workspaceId, input.documentRevision],
  );
  const canonicalDocument = document.rows[0];
  if (!canonicalDocument) {
    throw new Error("Canonical document revision no longer exists");
  }
  for (const chunk of input.chunks) {
    await client.query(
      `INSERT INTO vector_index_work (
         id, workspace_id, embedding_space_id, chunk_id, document_id,
         operation, canonical_version, payload
       )
       SELECT $1, $2, $3, $4, $5, 'upsert', $6, $7::jsonb
       WHERE NOT EXISTS (
         SELECT 1
         FROM vector_index_work
         WHERE workspace_id = $2
           AND embedding_space_id = $3
           AND chunk_id = $4
           AND canonical_version >= $6::bigint
       )`,
      [
        randomUUID(),
        input.workspaceId,
        input.embeddingSpace.id,
        chunk.id,
        input.documentId,
        input.canonicalVersion,
        JSON.stringify({
          dimensions: input.embeddingSpace.dimensions,
          distanceMetric: input.embeddingSpace.distanceMetric,
          vector: [...chunk.embedding],
          sourceId: canonicalDocument.source_id,
          metadata: chunk.metadata ?? {},
          retrievalEnabled: canonicalDocument.retrieval_enabled,
          retrievalExpiresAt: canonicalDocument.retrieval_expires_at
            ? new Date(canonicalDocument.retrieval_expires_at).toISOString()
            : null,
        }),
      ],
    );
  }
};

const mapChunkEmbedding = (row: ChunkEmbeddingRow): ChunkEmbeddingRecord => ({
  workspaceId: row.workspace_id,
  chunkId: row.chunk_id,
  embeddingSpaceId: row.embedding_space_id,
  documentRevision: Number(row.document_revision),
  canonicalVersion: String(row.canonical_version),
  dimensions: Number(row.dimensions),
  embedding: parseVector(row.embedding),
  contentHash: row.content_hash,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const assertCanonicalVersion = (value: string): void => {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("Canonical version must be a positive decimal integer");
  }
};

const assertEmbeddingSpaceCompatibility = (
  stored: StoredEmbeddingSpaceRow | undefined,
  expected: EmbeddingSpaceRef,
): void => {
  if (!stored) {
    throw new Error(`Embedding space ${expected.id} does not exist`);
  }
  const storedDimensions = Number(stored.dimensions);
  if (storedDimensions !== expected.dimensions) {
    throw new Error(
      `Embedding space ${expected.id} has dimensions ${storedDimensions}, not declared dimensions ${expected.dimensions}`,
    );
  }
  if (stored.distance_metric !== expected.distanceMetric) {
    throw new Error(
      `Embedding space ${expected.id} has distance metric ${stored.distance_metric}, not ${expected.distanceMetric}`,
    );
  }
};

const assertEmbeddingVector = (
  embedding: readonly number[],
  dimensions: number,
): void => {
  if (embedding.length !== dimensions) {
    throw new Error(
      `Embedding dimensions ${embedding.length} do not match declared dimensions ${dimensions}`,
    );
  }
  if (embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding contains a non-finite value");
  }
};

const assertCanonicalChunkIdentity = (
  chunk: CanonicalChunkEmbeddingPublication["chunks"][number],
  publication: Pick<
    CanonicalChunkEmbeddingPublication,
    "documentId" | "workspaceId"
  >,
): void => {
  if (chunk.documentId !== publication.documentId) {
    throw new Error(`Chunk ${chunk.id} does not belong to document ${publication.documentId}`);
  }
  if (chunk.workspaceId !== publication.workspaceId) {
    throw new Error(`Chunk ${chunk.id} does not belong to workspace ${publication.workspaceId}`);
  }
};

const hashEmbeddedContent = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const serializeVector = (embedding: readonly number[]): string => `[${embedding.join(",")}]`;

const parseVector = (value: string): number[] => {
  const normalized = value.trim();
  if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
    throw new Error("Stored chunk embedding is not a pgvector literal");
  }
  if (normalized === "[]") {
    return [];
  }
  return normalized
    .slice(1, -1)
    .split(",")
    .map((part) => Number(part));
};
