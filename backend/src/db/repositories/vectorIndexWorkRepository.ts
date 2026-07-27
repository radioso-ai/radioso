import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type {
  VectorIndexFailureCode,
  VectorIndexCheckpointRecord,
  VectorIndexLagRecord,
  VectorIndexOperation,
  VectorIndexReadiness,
  VectorIndexWorkRecord,
  VectorIndexWorkRepositoryPort,
} from "../../modules/embeddingProfiles/contracts/repositories.js";
import {
  currentTimestamp,
  toJsonb,
  transactionAdvisoryLock,
} from "../../shared/infra/kysely/sqlHelpers.js";
import type { JsonValue } from "../../shared/infra/kysely/schema.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface VectorIndexWorkRow {
  id: string;
  sequence: string;
  workspace_id: string;
  embedding_space_id: string;
  chunk_id: string;
  document_id: string | null;
  operation: string;
  canonical_version: string;
  payload: JsonValue;
  status: string;
  attempt_count: number;
  available_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface VectorIndexCheckpointRow {
  backend_key: string;
  workspace_id: string;
  embedding_space_id: string;
  acknowledged_sequence: string;
  readiness: string;
  updated_at: Date;
}

const vectorIndexWorkColumns = [
  "id",
  "sequence",
  "workspace_id",
  "embedding_space_id",
  "chunk_id",
  "document_id",
  "operation",
  "canonical_version",
  "payload",
  "status",
  "attempt_count",
  "available_at",
  "claimed_at",
  "completed_at",
  "last_error",
  "created_at",
  "updated_at",
] as const;

const vectorIndexCheckpointColumns = [
  "backend_key",
  "workspace_id",
  "embedding_space_id",
  "acknowledged_sequence",
  "readiness",
  "updated_at",
] as const;

export const vectorProjectionMutationFenceKey = (workspaceId: string): string =>
  `vector-projection-mutation:${workspaceId}`;

export class VectorIndexWorkRepository implements VectorIndexWorkRepositoryPort {
  constructor(private readonly db: Db) {}

  async append(input: {
    workspaceId: string;
    embeddingSpaceId: string;
    chunkId: string;
    documentId?: string | null;
    operation: VectorIndexOperation;
    canonicalVersion: string;
    payload: Record<string, unknown>;
  }): Promise<{ work: VectorIndexWorkRecord; accepted: boolean }> {
    assertUnsignedDecimal(input.canonicalVersion, "Canonical version", false);

    return this.db.transaction().execute((trx) =>
      appendVectorIndexWorkInTransaction(trx, input));
  }

  async markCompleted(id: string): Promise<void> {
    await this.db
      .updateTable("vector_index_work")
      .set({
        status: "completed",
        completed_at: currentTimestamp(),
        claimed_at: null,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", id)
      .execute();
  }

  async claimBatch(input: {
    limit: number;
    now: Date;
    leaseMs: number;
  }): Promise<VectorIndexWorkRecord[]> {
    assertBatchLimit(input.limit);
    assertLeaseMs(input.leaseMs);
    const leaseExpiredAt = new Date(input.now.getTime() - input.leaseMs);

    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom("vector_index_work")
        .select(vectorIndexWorkColumns)
        .where((eb) => eb.or([
          eb.and([
            eb("status", "in", ["queued", "failed"]),
            eb("available_at", "<=", input.now),
            eb.not(
              eb.exists(
                eb
                  .selectFrom("workspace_embedding_transitions as cleanup")
                  .select("cleanup.id")
                  .whereRef(
                    "cleanup.workspace_id",
                    "=",
                    "vector_index_work.workspace_id",
                  )
                  .whereRef(
                    "cleanup.source_embedding_space_id",
                    "=",
                    "vector_index_work.embedding_space_id",
                  )
                  .where("cleanup.status", "=", "promoted")
                  .where("cleanup.cleanup_after", "is not", null)
                  .where("cleanup.cleanup_after", "<=", input.now)
                  .where((cleanupEb) =>
                    cleanupEb.not(
                      cleanupEb.exists(
                        cleanupEb
                          .selectFrom("workspace_embedding_profiles as live_profile")
                          .select("live_profile.workspace_id")
                          .whereRef(
                            "live_profile.workspace_id",
                            "=",
                            "vector_index_work.workspace_id",
                          )
                          .where((profileEb) =>
                            profileEb.or([
                              profileEb(
                                "live_profile.active_embedding_space_id",
                                "=",
                                profileEb.ref("vector_index_work.embedding_space_id"),
                              ),
                              profileEb(
                                "live_profile.pending_embedding_space_id",
                                "=",
                                profileEb.ref("vector_index_work.embedding_space_id"),
                              ),
                            ])),
                      ),
                    )),
              ),
            ),
          ]),
          eb.and([
            eb("status", "=", "processing"),
            eb("claimed_at", "<=", leaseExpiredAt),
          ]),
        ]))
        .orderBy("sequence", "asc")
        .forUpdate()
        .skipLocked()
        .limit(input.limit)
        .execute();
      if (rows.length === 0) {
        return [];
      }
      const claimed = await trx
        .updateTable("vector_index_work")
        .set((eb) => ({
          status: "processing",
          attempt_count: eb("attempt_count", "+", 1),
          claimed_at: input.now,
          updated_at: input.now,
        }))
        .where("id", "in", rows.map((row) => row.id))
        .returning(vectorIndexWorkColumns)
        .execute();
      const order = new Map(rows.map((row, index) => [row.id, index]));
      return claimed
        .sort((left, right) => order.get(left.id)! - order.get(right.id)!)
        .map((row) => mapVectorIndexWork(row as VectorIndexWorkRow));
    });
  }

  async markFailed(input: {
    id: string;
    errorCode: VectorIndexFailureCode;
    retryAt: Date;
    maxAttempts: number;
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
    chunkId: string;
    caughtUpReadiness: VectorIndexReadiness;
  }): Promise<
    | {
        disposition: "retry_scheduled" | "dead_lettered";
        checkpoint: null;
      }
    | {
        disposition: "superseded";
        checkpoint: VectorIndexCheckpointRecord;
      }
  > {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
      throw new Error("Vector index max attempts must be a positive integer");
    }
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(
        `vector-index-work:${input.workspaceId}:${input.embeddingSpaceId}:${input.chunkId}`,
      ).execute(trx);
      const work = await trx
        .selectFrom("vector_index_work")
        .select(vectorIndexWorkColumns)
        .where("id", "=", input.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        work.workspace_id !== input.workspaceId
        || work.embedding_space_id !== input.embeddingSpaceId
        || work.chunk_id !== input.chunkId
      ) {
        throw new Error("Vector index work identity does not match claimed work");
      }
      if (work.status !== "processing") {
        throw new Error("Vector index work is not processing");
      }
      const superseding = await trx
        .selectFrom("vector_index_work")
        .select("id")
        .where("workspace_id", "=", work.workspace_id)
        .where("embedding_space_id", "=", work.embedding_space_id)
        .where("chunk_id", "=", work.chunk_id)
        .where("canonical_version", ">", work.canonical_version)
        .where("sequence", ">", work.sequence)
        .orderBy("sequence", "asc")
        .limit(1)
        .executeTakeFirst();
      if (superseding) {
        return {
          disposition: "superseded",
          checkpoint: await completeWorkAndAdvanceCheckpoint(
            trx,
            work as VectorIndexWorkRow,
            {
              backendKey: input.backendKey,
              caughtUpReadiness: input.caughtUpReadiness,
            },
          ),
        };
      }
      const deadLettered = Number(work.attempt_count) >= input.maxAttempts;
      await trx
        .updateTable("vector_index_work")
        .set({
          status: deadLettered ? "dead_letter" : "failed",
          available_at: input.retryAt,
          claimed_at: null,
          completed_at: deadLettered ? currentTimestamp() : null,
          last_error: input.errorCode,
          updated_at: currentTimestamp(),
        })
        .where("id", "=", input.id)
        .executeTakeFirstOrThrow();
      return {
        disposition: deadLettered ? "dead_lettered" : "retry_scheduled",
        checkpoint: null,
      };
    });
  }

  async markCompletedAndAdvanceCheckpoint(input: {
    id: string;
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
    chunkId: string;
    caughtUpReadiness: VectorIndexReadiness;
  }): Promise<VectorIndexCheckpointRecord> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(
        `vector-index-work:${input.workspaceId}:${input.embeddingSpaceId}:${input.chunkId}`,
      ).execute(trx);
      const work = await trx
        .selectFrom("vector_index_work")
        .select(vectorIndexWorkColumns)
        .where("id", "=", input.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        work.workspace_id !== input.workspaceId
        || work.embedding_space_id !== input.embeddingSpaceId
        || work.chunk_id !== input.chunkId
      ) {
        throw new Error("Vector index work identity does not match claimed work");
      }
      if (work.status !== "processing" && work.status !== "completed") {
        throw new Error("Vector index work cannot be acknowledged from its current state");
      }
      return completeWorkAndAdvanceCheckpoint(trx, work as VectorIndexWorkRow, {
        backendKey: input.backendKey,
        caughtUpReadiness: input.caughtUpReadiness,
      });
    });
  }

  async completeSupersededAndAdvanceCheckpoint(input: {
    id: string;
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
    chunkId: string;
    caughtUpReadiness: VectorIndexReadiness;
  }): Promise<VectorIndexCheckpointRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(
        `vector-index-work:${input.workspaceId}:${input.embeddingSpaceId}:${input.chunkId}`,
      ).execute(trx);
      const work = await trx
        .selectFrom("vector_index_work")
        .select(vectorIndexWorkColumns)
        .where("id", "=", input.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        work.workspace_id !== input.workspaceId
        || work.embedding_space_id !== input.embeddingSpaceId
        || work.chunk_id !== input.chunkId
      ) {
        throw new Error("Vector index work identity does not match claimed work");
      }
      if (work.status !== "processing") {
        throw new Error("Vector index work is not processing");
      }
      const superseding = await trx
        .selectFrom("vector_index_work")
        .select("id")
        .where("workspace_id", "=", work.workspace_id)
        .where("embedding_space_id", "=", work.embedding_space_id)
        .where("chunk_id", "=", work.chunk_id)
        .where("canonical_version", ">", work.canonical_version)
        .where("sequence", ">", work.sequence)
        .orderBy("sequence", "asc")
        .limit(1)
        .executeTakeFirst();
      if (!superseding) {
        return null;
      }
      return completeWorkAndAdvanceCheckpoint(trx, work as VectorIndexWorkRow, {
        backendKey: input.backendKey,
        caughtUpReadiness: input.caughtUpReadiness,
      });
    });
  }

  async advanceCheckpoint(input: {
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
    acknowledgedSequence: string;
    expectedAcknowledgedSequence: string;
    readiness: VectorIndexReadiness;
  }): Promise<VectorIndexCheckpointRecord> {
    assertUnsignedDecimal(input.acknowledgedSequence, "Acknowledged sequence", true);
    assertUnsignedDecimal(input.expectedAcknowledgedSequence, "Expected acknowledged sequence", true);
    if (BigInt(input.acknowledgedSequence) < BigInt(input.expectedAcknowledgedSequence)) {
      throw new Error("Acknowledged sequence cannot move backwards");
    }

    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(
        `vector-index-checkpoint:${input.backendKey}:${input.workspaceId}:${input.embeddingSpaceId}`,
      ).execute(trx);
      const existing = await trx
        .selectFrom("vector_index_checkpoints")
        .select(vectorIndexCheckpointColumns)
        .where("backend_key", "=", input.backendKey)
        .where("workspace_id", "=", input.workspaceId)
        .where("embedding_space_id", "=", input.embeddingSpaceId)
        .forUpdate()
        .executeTakeFirst();
      const currentSequence = String(existing?.acknowledged_sequence ?? "0");
      if (currentSequence !== input.expectedAcknowledgedSequence) {
        throw new Error(
          `Stale vector index checkpoint: expected ${input.expectedAcknowledgedSequence}, current ${currentSequence}`,
        );
      }

      const row = existing
        ? await trx
            .updateTable("vector_index_checkpoints")
            .set({
              acknowledged_sequence: input.acknowledgedSequence,
              readiness: input.readiness,
              updated_at: currentTimestamp(),
            })
            .where("backend_key", "=", input.backendKey)
            .where("workspace_id", "=", input.workspaceId)
            .where("embedding_space_id", "=", input.embeddingSpaceId)
            .returning(vectorIndexCheckpointColumns)
            .executeTakeFirstOrThrow()
        : await trx
            .insertInto("vector_index_checkpoints")
            .values({
              backend_key: input.backendKey,
              workspace_id: input.workspaceId,
              embedding_space_id: input.embeddingSpaceId,
              acknowledged_sequence: input.acknowledgedSequence,
              readiness: input.readiness,
            })
            .returning(vectorIndexCheckpointColumns)
            .executeTakeFirstOrThrow();

      return mapCheckpoint(row as VectorIndexCheckpointRow);
    });
  }

  async ensureCheckpoint(input: {
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
    readiness: VectorIndexReadiness;
  }): Promise<VectorIndexCheckpointRecord> {
    const inserted = await this.db
      .insertInto("vector_index_checkpoints")
      .values({
        backend_key: input.backendKey,
        workspace_id: input.workspaceId,
        embedding_space_id: input.embeddingSpaceId,
        acknowledged_sequence: "0",
        readiness: input.readiness,
      })
      .onConflict((oc) =>
        oc
          .columns(["backend_key", "workspace_id", "embedding_space_id"])
          .doNothing(),
      )
      .returning(vectorIndexCheckpointColumns)
      .executeTakeFirst();
    if (inserted) {
      return mapCheckpoint(inserted as VectorIndexCheckpointRow);
    }

    const existing = await this.findCheckpoint(input);
    if (!existing) {
      throw new Error("Vector index checkpoint could not be initialized");
    }
    return existing;
  }

  async findCheckpoint(input: {
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
  }): Promise<VectorIndexCheckpointRecord | null> {
    const row = await this.db
      .selectFrom("vector_index_checkpoints")
      .select(vectorIndexCheckpointColumns)
      .where("backend_key", "=", input.backendKey)
      .where("workspace_id", "=", input.workspaceId)
      .where("embedding_space_id", "=", input.embeddingSpaceId)
      .executeTakeFirst();
    return row ? mapCheckpoint(row as VectorIndexCheckpointRow) : null;
  }

  async getLag(input: {
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
  }): Promise<VectorIndexLagRecord> {
    const checkpoint = await this.findCheckpoint(input);
    const acknowledgedSequence = checkpoint?.acknowledgedSequence ?? "0";
    const [required, counts] = await Promise.all([
      this.db
        .selectFrom("vector_index_work")
        .select((eb) => eb.fn.max<string>("sequence").as("sequence"))
        .where("workspace_id", "=", input.workspaceId)
        .where("embedding_space_id", "=", input.embeddingSpaceId)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom("vector_index_work")
        .select((eb) => [
          eb.fn.countAll<string>()
            .filterWhere("status", "!=", "completed")
            .as("pending_count"),
          eb.fn.countAll<string>()
            .filterWhere("status", "=", "dead_letter")
            .as("dead_letter_count"),
        ])
        .where("workspace_id", "=", input.workspaceId)
        .where("embedding_space_id", "=", input.embeddingSpaceId)
        .where("sequence", ">", acknowledgedSequence)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      backendKey: input.backendKey,
      workspaceId: input.workspaceId,
      embeddingSpaceId: input.embeddingSpaceId,
      requiredSequence: String(required.sequence ?? "0"),
      acknowledgedSequence,
      pendingCount: Number(counts.pending_count),
      deadLetterCount: Number(counts.dead_letter_count),
      readiness: checkpoint?.readiness ?? "building",
    };
  }
}

const retireOlderDeadLetterWork = async (
  db: Db,
  work: Pick<
    VectorIndexWorkRow,
    | "workspace_id"
    | "embedding_space_id"
    | "chunk_id"
    | "canonical_version"
    | "sequence"
  >,
): Promise<void> => {
  await db
    .updateTable("vector_index_work")
    .set({
      status: "completed",
      completed_at: currentTimestamp(),
      claimed_at: null,
      last_error: null,
      updated_at: currentTimestamp(),
    })
    .where("workspace_id", "=", work.workspace_id)
    .where("embedding_space_id", "=", work.embedding_space_id)
    .where("chunk_id", "=", work.chunk_id)
    .where("status", "=", "dead_letter")
    .where("canonical_version", "<", work.canonical_version)
    .where("sequence", "<", work.sequence)
    .execute();
};

const completeWorkAndAdvanceCheckpoint = async (
  db: Db,
  work: VectorIndexWorkRow,
  input: {
    backendKey: string;
    caughtUpReadiness: VectorIndexReadiness;
  },
): Promise<VectorIndexCheckpointRecord> => {
  await transactionAdvisoryLock(
    `vector-index-checkpoint:${input.backendKey}:${work.workspace_id}:${work.embedding_space_id}`,
  ).execute(db);
  if (work.status === "processing") {
    await db
      .updateTable("vector_index_work")
      .set({
        status: "completed",
        completed_at: currentTimestamp(),
        claimed_at: null,
        last_error: null,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", work.id)
      .executeTakeFirstOrThrow();
  }
  await retireOlderDeadLetterWork(db, work);

  const outstanding = await db
    .selectFrom("vector_index_work")
    .select(["sequence", "status"])
    .where("workspace_id", "=", work.workspace_id)
    .where("embedding_space_id", "=", work.embedding_space_id)
    .where("status", "!=", "completed")
    .orderBy("sequence", "asc")
    .limit(1)
    .executeTakeFirst();
  let completedQuery = db
    .selectFrom("vector_index_work")
    .select((eb) => eb.fn.max<string>("sequence").as("sequence"))
    .where("workspace_id", "=", work.workspace_id)
    .where("embedding_space_id", "=", work.embedding_space_id)
    .where("status", "=", "completed");
  if (outstanding) {
    completedQuery = completedQuery.where(
      "sequence",
      "<",
      outstanding.sequence,
    );
  }
  const completed = await completedQuery.executeTakeFirstOrThrow();
  const acknowledgedSequence = String(completed.sequence ?? "0");
  const readiness: VectorIndexReadiness = outstanding
    ? outstanding.status === "dead_letter" ? "stale" : "building"
    : input.caughtUpReadiness;
  const existingCheckpoint = await db
    .selectFrom("vector_index_checkpoints")
    .select("acknowledged_sequence")
    .where("backend_key", "=", input.backendKey)
    .where("workspace_id", "=", work.workspace_id)
    .where("embedding_space_id", "=", work.embedding_space_id)
    .forUpdate()
    .executeTakeFirst();
  const monotonicAcknowledgedSequence = existingCheckpoint
    ? maxBigInt(
        existingCheckpoint.acknowledged_sequence,
        acknowledgedSequence,
      ).toString()
    : acknowledgedSequence;
  const checkpoint = await db
    .insertInto("vector_index_checkpoints")
    .values({
      backend_key: input.backendKey,
      workspace_id: work.workspace_id,
      embedding_space_id: work.embedding_space_id,
      acknowledged_sequence: monotonicAcknowledgedSequence,
      readiness,
    })
    .onConflict((oc) => oc
      .columns(["backend_key", "workspace_id", "embedding_space_id"])
      .doUpdateSet({
        acknowledged_sequence: monotonicAcknowledgedSequence,
        readiness,
        updated_at: currentTimestamp(),
      }))
    .returning(vectorIndexCheckpointColumns)
    .executeTakeFirstOrThrow();
  return mapCheckpoint(checkpoint as VectorIndexCheckpointRow);
};

export const appendVectorIndexWorkInTransaction = async (
  db: Db,
  input: {
    workspaceId: string;
    embeddingSpaceId: string;
    chunkId: string;
    documentId?: string | null;
    operation: VectorIndexOperation;
    canonicalVersion: string;
    payload: Record<string, unknown>;
  },
): Promise<{ work: VectorIndexWorkRecord; accepted: boolean }> => {
  assertUnsignedDecimal(input.canonicalVersion, "Canonical version", false);
  await transactionAdvisoryLock(
    vectorProjectionMutationFenceKey(input.workspaceId),
  ).execute(db);
  await transactionAdvisoryLock(
    `vector-index-work:${input.workspaceId}:${input.embeddingSpaceId}:${input.chunkId}`,
  ).execute(db);
  const latest = await db
    .selectFrom("vector_index_work")
    .select(vectorIndexWorkColumns)
    .where("workspace_id", "=", input.workspaceId)
    .where("embedding_space_id", "=", input.embeddingSpaceId)
    .where("chunk_id", "=", input.chunkId)
    .orderBy("canonical_version", "desc")
    .orderBy("sequence", "desc")
    .forUpdate()
    .limit(1)
    .executeTakeFirst();

  if (latest && BigInt(latest.canonical_version) >= BigInt(input.canonicalVersion)) {
    return {
      work: mapVectorIndexWork(latest as VectorIndexWorkRow),
      accepted: false,
    };
  }

  const row = await db
    .insertInto("vector_index_work")
    .values({
      id: randomUUID(),
      workspace_id: input.workspaceId,
      embedding_space_id: input.embeddingSpaceId,
      chunk_id: input.chunkId,
      document_id: input.documentId ?? null,
      operation: input.operation,
      canonical_version: input.canonicalVersion,
      payload: toJsonb(input.payload),
    })
    .returning(vectorIndexWorkColumns)
    .executeTakeFirstOrThrow();
  await retireOlderDeadLetterWork(db, row as VectorIndexWorkRow);

  return {
    work: mapVectorIndexWork(row as VectorIndexWorkRow),
    accepted: true,
  };
};

/**
 * Allocates projection versions while the caller owns the canonical metadata
 * transaction. The canonical vector row and its portable work item advance
 * together, so repeated filter changes within one document revision cannot
 * reuse the document revision as an index version.
 */
export const appendVectorFilterUpdatesForDocument = async (
  db: Db,
  input: {
    workspaceId: string;
    documentId: string;
    embeddingSpaceId?: string;
  },
): Promise<VectorIndexWorkRecord[]> => {
  await transactionAdvisoryLock(
    vectorProjectionMutationFenceKey(input.workspaceId),
  ).execute(db);
  await transactionAdvisoryLock(
    `vector-index-filter:${input.workspaceId}:${input.documentId}:${input.embeddingSpaceId ?? "*"}`,
  ).execute(db);
  let query = db
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
      "ce.chunk_id",
      "ce.embedding_space_id",
      "ce.canonical_version",
      "ce.dimensions",
      "ce.embedding",
      "c.metadata",
      "d.source_id",
      "d.retrieval_enabled",
      "d.retrieval_expires_at",
      "es.distance_metric",
    ])
    .where("ce.workspace_id", "=", input.workspaceId)
    .where("c.document_id", "=", input.documentId)
    .forUpdate("ce");
  if (input.embeddingSpaceId) {
    query = query.where("ce.embedding_space_id", "=", input.embeddingSpaceId);
  }
  const canonicalRows = await query.execute();
  const appended: VectorIndexWorkRecord[] = [];
  for (const row of canonicalRows) {
    const latest = await db
      .selectFrom("vector_index_work")
      .select("canonical_version")
      .where("workspace_id", "=", input.workspaceId)
      .where("embedding_space_id", "=", row.embedding_space_id)
      .where("chunk_id", "=", row.chunk_id)
      .orderBy("canonical_version", "desc")
      .limit(1)
      .executeTakeFirst();
    const nextVersion = (
      (latest
        ? maxBigInt(row.canonical_version, latest.canonical_version)
        : BigInt(String(row.canonical_version)))
      + 1n
    ).toString();
    await db
      .updateTable("chunk_embeddings")
      .set({
        canonical_version: nextVersion,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", input.workspaceId)
      .where("embedding_space_id", "=", row.embedding_space_id)
      .where("chunk_id", "=", row.chunk_id)
      .executeTakeFirstOrThrow();
    const result = await appendVectorIndexWorkInTransaction(db, {
      workspaceId: input.workspaceId,
      embeddingSpaceId: row.embedding_space_id,
      chunkId: row.chunk_id,
      documentId: input.documentId,
      operation: "filter_update",
      canonicalVersion: nextVersion,
      payload: {
        dimensions: Number(row.dimensions),
        distanceMetric: row.distance_metric,
        vector: parseVectorLiteral(row.embedding),
        sourceId: row.source_id,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        retrievalEnabled: row.retrieval_enabled,
        retrievalExpiresAt: row.retrieval_expires_at
          ? new Date(row.retrieval_expires_at).toISOString()
          : null,
      },
    });
    if (result.accepted) {
      appended.push(result.work);
    }
  }
  return appended;
};

export const appendVectorTombstonesForDocuments = async (
  db: Db,
  input: {
    workspaceId: string;
    documentIds: readonly string[];
    retainedChunkIds?: readonly string[];
    embeddingSpaceId?: string;
  },
): Promise<VectorIndexWorkRecord[]> => {
  if (input.documentIds.length === 0) {
    return [];
  }
  await transactionAdvisoryLock(
    vectorProjectionMutationFenceKey(input.workspaceId),
  ).execute(db);
  await transactionAdvisoryLock(
    `vector-index-delete:${input.workspaceId}:${[...input.documentIds].sort().join(",")}`,
  ).execute(db);
  let query = db
    .selectFrom("chunk_embeddings as ce")
    .innerJoin("chunks as c", (join) =>
      join
        .onRef("c.workspace_id", "=", "ce.workspace_id")
        .onRef("c.id", "=", "ce.chunk_id"))
    .select([
      "ce.chunk_id",
      "ce.embedding_space_id",
      "ce.canonical_version",
      "c.document_id",
    ])
    .where("ce.workspace_id", "=", input.workspaceId)
    .where("c.document_id", "in", [...input.documentIds])
    .forUpdate("ce");
  if (input.retainedChunkIds && input.retainedChunkIds.length > 0) {
    query = query.where("ce.chunk_id", "not in", [...input.retainedChunkIds]);
  }
  if (input.embeddingSpaceId) {
    query = query.where("ce.embedding_space_id", "=", input.embeddingSpaceId);
  }
  const rows = await query.execute();
  const work: VectorIndexWorkRecord[] = [];
  for (const row of rows) {
    const latest = await db
      .selectFrom("vector_index_work")
      .select("canonical_version")
      .where("workspace_id", "=", input.workspaceId)
      .where("embedding_space_id", "=", row.embedding_space_id)
      .where("chunk_id", "=", row.chunk_id)
      .orderBy("canonical_version", "desc")
      .limit(1)
      .executeTakeFirst();
    const version = (
      (latest
        ? maxBigInt(row.canonical_version, latest.canonical_version)
        : BigInt(String(row.canonical_version)))
      + 1n
    ).toString();
    const appended = await appendVectorIndexWorkInTransaction(db, {
      workspaceId: input.workspaceId,
      embeddingSpaceId: row.embedding_space_id,
      chunkId: row.chunk_id,
      documentId: row.document_id,
      operation: "delete",
      canonicalVersion: version,
      payload: {},
    });
    if (appended.accepted) {
      work.push(appended.work);
    }
  }
  return work;
};

export interface VectorIndexProjectionTransactionClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export const appendVectorTombstonesForDocumentTransaction = async (
  client: VectorIndexProjectionTransactionClient,
  input: {
    workspaceId: string;
    documentId: string;
    retainedChunkIds?: readonly string[];
  },
): Promise<void> => {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [vectorProjectionMutationFenceKey(input.workspaceId)],
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`vector-index-delete:${input.workspaceId}:${input.documentId}`],
  );
  const retained = [...(input.retainedChunkIds ?? [])];
  const rows = await client.query<{
    chunk_id: string;
    embedding_space_id: string;
    document_id: string;
    canonical_version: string;
    latest_work_version: string | null;
  }>(
    `SELECT
       ce.chunk_id,
       ce.embedding_space_id,
       c.document_id,
       ce.canonical_version,
       (
         SELECT MAX(w.canonical_version)
         FROM vector_index_work w
         WHERE w.workspace_id = ce.workspace_id
           AND w.embedding_space_id = ce.embedding_space_id
           AND w.chunk_id = ce.chunk_id
       ) AS latest_work_version
     FROM chunk_embeddings ce
     JOIN chunks c
       ON c.workspace_id = ce.workspace_id
      AND c.id = ce.chunk_id
     WHERE ce.workspace_id = $1
       AND c.document_id = $2
       AND (
         cardinality($3::uuid[]) = 0
         OR NOT (ce.chunk_id = ANY($3::uuid[]))
       )
     FOR NO KEY UPDATE OF ce`,
    [input.workspaceId, input.documentId, retained],
  );
  for (const row of rows.rows) {
    const version = (
      (row.latest_work_version
        ? maxBigInt(row.canonical_version, row.latest_work_version)
        : BigInt(row.canonical_version))
      + 1n
    ).toString();
    await client.query(
      `INSERT INTO vector_index_work (
         id, workspace_id, embedding_space_id, chunk_id, document_id,
         operation, canonical_version, payload
       )
       VALUES ($1, $2, $3, $4, $5, 'delete', $6, '{}'::jsonb)`,
      [
        randomUUID(),
        input.workspaceId,
        row.embedding_space_id,
        row.chunk_id,
        row.document_id,
        version,
      ],
    );
  }
};

export const appendVectorFilterUpdatesForDocumentTransaction = async (
  client: VectorIndexProjectionTransactionClient,
  input: {
    workspaceId: string;
    documentId: string;
    embeddingSpaceId?: string;
  },
): Promise<void> => {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [vectorProjectionMutationFenceKey(input.workspaceId)],
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`vector-index-filter:${input.workspaceId}:${input.documentId}:${input.embeddingSpaceId ?? "*"}`],
  );
  const rows = await client.query<{
    chunk_id: string;
    embedding_space_id: string;
    canonical_version: string;
    latest_work_version: string | null;
    dimensions: number;
    embedding: string;
    distance_metric: string;
    metadata: Record<string, unknown> | null;
    source_id: string | null;
    retrieval_enabled: boolean;
    retrieval_expires_at: Date | string | null;
  }>(
    `SELECT
       ce.chunk_id,
       ce.embedding_space_id,
       ce.canonical_version,
       ce.dimensions,
       ce.embedding::text AS embedding,
       es.distance_metric,
       c.metadata,
       d.source_id,
       d.retrieval_enabled,
       d.retrieval_expires_at,
       (
         SELECT MAX(w.canonical_version)
         FROM vector_index_work w
         WHERE w.workspace_id = ce.workspace_id
           AND w.embedding_space_id = ce.embedding_space_id
           AND w.chunk_id = ce.chunk_id
       ) AS latest_work_version
     FROM chunk_embeddings ce
     JOIN chunks c
       ON c.workspace_id = ce.workspace_id
      AND c.id = ce.chunk_id
     JOIN documents d
       ON d.workspace_id = c.workspace_id
      AND d.id = c.document_id
     JOIN embedding_spaces es
       ON es.id = ce.embedding_space_id
     WHERE ce.workspace_id = $1
       AND c.document_id = $2
       AND ($3::uuid IS NULL OR ce.embedding_space_id = $3)
     FOR UPDATE OF ce`,
    [input.workspaceId, input.documentId, input.embeddingSpaceId ?? null],
  );
  for (const row of rows.rows) {
    const version = (
      (row.latest_work_version
        ? maxBigInt(row.canonical_version, row.latest_work_version)
        : BigInt(row.canonical_version))
      + 1n
    ).toString();
    await client.query(
      `UPDATE chunk_embeddings
       SET canonical_version = $4,
           updated_at = NOW()
       WHERE workspace_id = $1
         AND chunk_id = $2
         AND embedding_space_id = $3`,
      [
        input.workspaceId,
        row.chunk_id,
        row.embedding_space_id,
        version,
      ],
    );
    await client.query(
      `INSERT INTO vector_index_work (
         id, workspace_id, embedding_space_id, chunk_id, document_id,
         operation, canonical_version, payload
       )
       VALUES ($1, $2, $3, $4, $5, 'filter_update', $6, $7::jsonb)`,
      [
        randomUUID(),
        input.workspaceId,
        row.embedding_space_id,
        row.chunk_id,
        input.documentId,
        version,
        JSON.stringify({
          dimensions: Number(row.dimensions),
          distanceMetric: row.distance_metric,
          vector: parseVectorLiteral(row.embedding),
          sourceId: row.source_id,
          metadata: row.metadata ?? {},
          retrievalEnabled: row.retrieval_enabled,
          retrievalExpiresAt: row.retrieval_expires_at
            ? new Date(row.retrieval_expires_at).toISOString()
            : null,
        }),
      ],
    );
  }
};

const mapVectorIndexWork = (row: VectorIndexWorkRow): VectorIndexWorkRecord => ({
  id: row.id,
  sequence: String(row.sequence),
  workspaceId: row.workspace_id,
  embeddingSpaceId: row.embedding_space_id,
  chunkId: row.chunk_id,
  documentId: row.document_id,
  operation: normalizeOperation(row.operation),
  canonicalVersion: String(row.canonical_version),
  payload: (row.payload ?? {}) as Record<string, unknown>,
  status: normalizeWorkStatus(row.status),
  attemptCount: Number(row.attempt_count),
  availableAt: new Date(row.available_at),
  claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
  lastError: row.last_error,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const mapCheckpoint = (row: VectorIndexCheckpointRow): VectorIndexCheckpointRecord => ({
  backendKey: row.backend_key,
  workspaceId: row.workspace_id,
  embeddingSpaceId: row.embedding_space_id,
  acknowledgedSequence: String(row.acknowledged_sequence),
  readiness: normalizeReadiness(row.readiness),
  updatedAt: new Date(row.updated_at),
});

const normalizeOperation = (value: string): VectorIndexOperation => {
  if (value === "upsert" || value === "delete" || value === "filter_update") {
    return value;
  }
  throw new Error(`Unsupported vector index operation ${value}`);
};

const normalizeWorkStatus = (value: string): VectorIndexWorkRecord["status"] => {
  if (
    value === "queued"
    || value === "processing"
    || value === "completed"
    || value === "failed"
    || value === "dead_letter"
  ) {
    return value;
  }
  throw new Error(`Unsupported vector index work status ${value}`);
};

const assertBatchLimit = (limit: number): void => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Vector index work batch limit must be between 1 and 1000");
  }
};

const assertLeaseMs = (leaseMs: number): void => {
  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new Error("Vector index work lease must be a positive integer");
  }
};

const normalizeReadiness = (value: string): VectorIndexReadiness => {
  if (
    value === "building"
    || value === "ready"
    || value === "stale"
    || value === "unavailable"
    || value === "exact_fallback"
  ) {
    return value;
  }
  throw new Error(`Unsupported vector index readiness ${value}`);
};

const assertUnsignedDecimal = (value: string, label: string, allowZero: boolean): void => {
  const pattern = allowZero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(value)) {
    throw new Error(`${label} must be ${allowZero ? "an unsigned" : "a positive"} decimal integer`);
  }
};

const maxBigInt = (left: string | number | bigint, right: string | number | bigint): bigint => {
  const leftValue = BigInt(String(left));
  const rightValue = BigInt(String(right));
  return leftValue > rightValue ? leftValue : rightValue;
};

const parseVectorLiteral = (value: string): number[] => {
  const normalized = value.trim();
  if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
    throw new Error("Stored canonical embedding is not a vector literal");
  }
  if (normalized === "[]") {
    return [];
  }
  const parsed = normalized
    .slice(1, -1)
    .split(",")
    .map((item) => Number(item));
  if (parsed.some((item) => !Number.isFinite(item))) {
    throw new Error("Stored canonical embedding contains a non-finite value");
  }
  return parsed;
};
