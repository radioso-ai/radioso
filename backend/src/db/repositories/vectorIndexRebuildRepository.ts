import type {
  CanonicalVectorRebuildRecord,
  CanonicalVectorRebuildSourcePort,
  VectorIndexRebuildScope,
} from "../../modules/retrieval/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import { vectorProjectionMutationFenceKey } from "./vectorIndexWorkRepository.js";

export class VectorIndexRebuildRepository
implements CanonicalVectorRebuildSourcePort {
  constructor(private readonly db: Db) {}

  async listTargets(scope: VectorIndexRebuildScope): Promise<Array<{
    workspaceId: string;
    space: CanonicalVectorRebuildRecord["space"];
  }>> {
    const rows = await applyScope(
      this.db
        .selectFrom("chunk_embeddings as ce")
        .innerJoin("chunks as c", (join) =>
          join
            .onRef("c.workspace_id", "=", "ce.workspace_id")
            .onRef("c.id", "=", "ce.chunk_id"))
        .innerJoin("embedding_spaces as es", "es.id", "ce.embedding_space_id")
        .select([
          "ce.workspace_id",
          "ce.embedding_space_id",
          "es.dimensions",
          "es.distance_metric",
        ])
        .distinct(),
      scope,
    )
      .orderBy("ce.workspace_id")
      .orderBy("ce.embedding_space_id")
      .execute();
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      space: {
        id: row.embedding_space_id,
        dimensions: Number(row.dimensions),
        distanceMetric: normalizeDistanceMetric(row.distance_metric),
      },
    }));
  }

  async scan(input: {
    scope: VectorIndexRebuildScope;
    cursor: string | null;
    limit: number;
  }): Promise<{
    records: CanonicalVectorRebuildRecord[];
    nextCursor: string | null;
  }> {
    assertLimit(input.limit);
    const offset = parseCursor(input.cursor);
    const rows = await applyScope(
      this.db
        .selectFrom("chunk_embeddings as ce")
        .innerJoin("chunks as c", (join) =>
          join
            .onRef("c.workspace_id", "=", "ce.workspace_id")
            .onRef("c.id", "=", "ce.chunk_id"))
        .innerJoin("documents as d", (join) =>
          join
            .onRef("d.workspace_id", "=", "c.workspace_id")
            .onRef("d.id", "=", "c.document_id"))
        .innerJoin("embedding_spaces as es", "es.id", "ce.embedding_space_id")
        .select([
          "ce.workspace_id",
          "ce.chunk_id",
          "ce.embedding_space_id",
          "ce.canonical_version",
          "ce.embedding",
          "es.dimensions",
          "es.distance_metric",
          "c.document_id",
          "c.metadata",
          "d.source_id",
          "d.retrieval_enabled",
          "d.retrieval_expires_at",
        ]),
      input.scope,
    )
      .orderBy("ce.workspace_id")
      .orderBy("ce.embedding_space_id")
      .orderBy("ce.chunk_id")
      .offset(offset)
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    return {
      records: page.map((row) => ({
        workspaceId: row.workspace_id,
        space: {
          id: row.embedding_space_id,
          dimensions: Number(row.dimensions),
          distanceMetric: normalizeDistanceMetric(row.distance_metric),
        },
        record: {
          chunkId: row.chunk_id,
          documentId: row.document_id,
          vector: parseVector(row.embedding),
          version: String(row.canonical_version),
          payload: {
            sourceId: row.source_id,
            metadata: (row.metadata ?? {}) as Record<string, never>,
            retrievalEnabled: row.retrieval_enabled,
            retrievalExpiresAt: row.retrieval_expires_at
              ? new Date(row.retrieval_expires_at).toISOString()
              : null,
          },
        },
      })),
      nextCursor: rows.length > input.limit
        ? String(offset + input.limit)
        : null,
    };
  }

  async applyIfCurrent(input: {
    item: CanonicalVectorRebuildRecord;
    apply(current: CanonicalVectorRebuildRecord): Promise<void>;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(
        vectorProjectionMutationFenceKey(input.item.workspaceId),
      ).execute(trx);
      const current = await trx
        .selectFrom("chunk_embeddings as ce")
        .innerJoin("chunks as c", (join) =>
          join
            .onRef("c.workspace_id", "=", "ce.workspace_id")
            .onRef("c.id", "=", "ce.chunk_id"))
        .innerJoin("documents as d", (join) =>
          join
            .onRef("d.workspace_id", "=", "c.workspace_id")
            .onRef("d.id", "=", "c.document_id"))
        .innerJoin("embedding_spaces as es", "es.id", "ce.embedding_space_id")
        .select([
          "ce.workspace_id",
          "ce.chunk_id",
          "ce.embedding_space_id",
          "ce.canonical_version",
          "ce.embedding",
          "es.dimensions",
          "es.distance_metric",
          "c.document_id",
          "c.metadata",
          "d.source_id",
          "d.retrieval_enabled",
          "d.retrieval_expires_at",
        ])
        .where("ce.workspace_id", "=", input.item.workspaceId)
        .where("ce.embedding_space_id", "=", input.item.space.id)
        .where("ce.chunk_id", "=", input.item.record.chunkId)
        .where("c.document_id", "=", input.item.record.documentId)
        .executeTakeFirst();
      if (!current) {
        return false;
      }
      await input.apply({
        workspaceId: current.workspace_id,
        space: {
          id: current.embedding_space_id,
          dimensions: Number(current.dimensions),
          distanceMetric: normalizeDistanceMetric(current.distance_metric),
        },
        record: {
          chunkId: current.chunk_id,
          documentId: current.document_id,
          vector: parseVector(current.embedding),
          version: String(current.canonical_version),
          payload: {
            sourceId: current.source_id,
            metadata: (current.metadata ?? {}) as Record<string, never>,
            retrievalEnabled: current.retrieval_enabled,
            retrievalExpiresAt: current.retrieval_expires_at
              ? new Date(current.retrieval_expires_at).toISOString()
              : null,
          },
        },
      });
      return true;
    });
  }
}

const applyScope = <
  T extends {
    where(column: string, operator: string, value: unknown): T;
  },
>(
  query: T,
  scope: VectorIndexRebuildScope,
): T => {
  if (scope.kind === "document") {
    return query
      .where("ce.workspace_id", "=", scope.workspaceId)
      .where("c.document_id", "=", scope.documentId);
  }
  if (scope.kind === "workspace") {
    return query.where("ce.workspace_id", "=", scope.workspaceId);
  }
  if (scope.kind === "space") {
    let scoped = query.where(
      "ce.embedding_space_id",
      "=",
      scope.embeddingSpaceId,
    );
    if (scope.workspaceId) {
      scoped = scoped.where("ce.workspace_id", "=", scope.workspaceId);
    }
    return scoped;
  }
  return query;
};

const assertLimit = (limit: number): void => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Vector rebuild batch limit must be between 1 and 1000");
  }
};

const parseCursor = (cursor: string | null): number => {
  if (cursor === null) {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new Error("Invalid vector rebuild cursor");
  }
  return Number(cursor);
};

const normalizeDistanceMetric = (value: string): "cosine" => {
  if (value !== "cosine") {
    throw new Error(`Unsupported canonical distance metric ${value}`);
  }
  return value;
};

const parseVector = (value: string): number[] => {
  const normalized = value.trim();
  if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
    throw new Error("Stored canonical embedding is not a vector literal");
  }
  return normalized === "[]"
    ? []
    : normalized.slice(1, -1).split(",").map(Number);
};
