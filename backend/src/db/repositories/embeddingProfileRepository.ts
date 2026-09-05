import { randomUUID } from "node:crypto";

import type {
  EmbeddingProfileRepositoryPort,
  EmbeddingSpaceCreateInput,
  EmbeddingSpaceRecord,
} from "../../modules/embeddingProfiles/contracts/repositories.js";
import {
  beginEmbeddingTransition,
  blockEmbeddingTransition,
  cancelEmbeddingTransition,
  EmbeddingProfileLifecycleError,
  failEmbeddingTransition,
  promoteEmbeddingTransition,
  quarantineEmbeddingTransition,
  type EmbeddingTransitionFailureReason,
  type EmbeddingTransitionFailureStatus,
  type EmbeddingTransitionState,
  type WorkspaceEmbeddingProfileState,
} from "../../modules/embeddingProfiles/domain/profileLifecycle.js";
import {
  currentTimestamp,
  nowPlusSeconds,
  toJsonb,
  transactionAdvisoryLock,
} from "../../shared/infra/kysely/sqlHelpers.js";
import type { JsonValue } from "../../shared/infra/kysely/schema.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import {
  vectorProjectionMutationFenceKey,
} from "./vectorIndexWorkRepository.js";

interface EmbeddingSpaceRow {
  id: string;
  identity_fingerprint: string;
  provider: string;
  endpoint_scope_fingerprint: string;
  model: string;
  dimensions: number;
  distance_metric: string;
  normalization: string;
  document_task: string | null;
  query_task: string | null;
  vector_options: JsonValue;
  model_version: string | null;
  status: string;
  quarantine_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface WorkspaceProfileRow {
  workspace_id: string;
  active_embedding_space_id: string;
  pending_embedding_space_id: string | null;
  generation: string;
}

interface EmbeddingTransitionRow {
  id: string;
  workspace_id: string;
  source_embedding_space_id: string;
  target_embedding_space_id: string;
  generation: string;
  status: string;
  failure_reason: string | null;
}

const embeddingSpaceColumns = [
  "id",
  "identity_fingerprint",
  "provider",
  "endpoint_scope_fingerprint",
  "model",
  "dimensions",
  "distance_metric",
  "normalization",
  "document_task",
  "query_task",
  "vector_options",
  "model_version",
  "status",
  "quarantine_reason",
  "created_at",
  "updated_at",
] as const;

const workspaceProfileColumns = [
  "workspace_id",
  "active_embedding_space_id",
  "pending_embedding_space_id",
  "generation",
] as const;

const transitionColumns = [
  "id",
  "workspace_id",
  "source_embedding_space_id",
  "target_embedding_space_id",
  "generation",
  "status",
  "failure_reason",
] as const;

const mapEmbeddingSpace = (row: EmbeddingSpaceRow): EmbeddingSpaceRecord => ({
  id: row.id,
  identityFingerprint: row.identity_fingerprint,
  provider: row.provider,
  endpointScopeFingerprint: row.endpoint_scope_fingerprint,
  model: row.model,
  dimensions: Number(row.dimensions),
  distanceMetric: "cosine",
  normalization: row.normalization,
  documentTask: row.document_task,
  queryTask: row.query_task,
  vectorOptions: (row.vector_options ?? {}) as Record<string, unknown>,
  modelVersion: row.model_version,
  status: row.status === "quarantined" ? "quarantined" : "active",
  quarantineReason: normalizeFailureReason(row.quarantine_reason),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const mapTransition = (row: EmbeddingTransitionRow): EmbeddingTransitionState => ({
  id: row.id,
  sourceEmbeddingSpaceId: row.source_embedding_space_id,
  targetEmbeddingSpaceId: row.target_embedding_space_id,
  generation: String(row.generation),
  status: normalizeTransitionStatus(row.status),
  failureReason: normalizeFailureReason(row.failure_reason),
});

const normalizeFailureReason = (
  reason: string | null,
): EmbeddingTransitionFailureReason | null => {
  switch (reason) {
    case null:
    case "validation_failed":
    case "backfill_retry_exhausted":
    case "embedding_contract_drift":
    case "terminal_failure":
      return reason;
    default:
      throw new Error(`Unsupported embedding transition failure reason ${reason}`);
  }
};

const normalizeTransitionStatus = (status: string): EmbeddingTransitionState["status"] => {
  switch (status) {
    case "building":
    case "blocked":
    case "quarantined":
    case "cancelled":
    case "promoted":
    case "failed":
      return status;
    default:
      throw new Error(`Unsupported embedding transition status ${status}`);
  }
};

export class EmbeddingProfileRepository implements EmbeddingProfileRepositoryPort {
  constructor(private readonly db: Db) {}

  async createEmbeddingSpace(input: EmbeddingSpaceCreateInput): Promise<EmbeddingSpaceRecord> {
    const inserted = await this.db
      .insertInto("embedding_spaces")
      .values({
        id: randomUUID(),
        identity_fingerprint: input.identityFingerprint,
        provider: input.provider,
        endpoint_scope_fingerprint: input.endpointScopeFingerprint,
        model: input.model,
        dimensions: input.dimensions,
        distance_metric: input.distanceMetric,
        normalization: input.normalization,
        document_task: input.documentTask,
        query_task: input.queryTask,
        vector_options: toJsonb(input.vectorOptions),
        model_version: input.modelVersion,
      })
      .onConflict((oc) => oc.column("identity_fingerprint").doNothing())
      .returning(embeddingSpaceColumns)
      .executeTakeFirst();

    if (inserted) {
      return mapEmbeddingSpace(inserted);
    }

    const existing = await this.db
      .selectFrom("embedding_spaces")
      .select(embeddingSpaceColumns)
      .where("identity_fingerprint", "=", input.identityFingerprint)
      .executeTakeFirstOrThrow();
    return mapEmbeddingSpace(existing);
  }

  async findEmbeddingSpaceById(id: string): Promise<EmbeddingSpaceRecord | null> {
    const row = await this.db
      .selectFrom("embedding_spaces")
      .select(embeddingSpaceColumns)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapEmbeddingSpace(row) : null;
  }

  async initializeWorkspaceProfile(input: {
    workspaceId: string;
    activeEmbeddingSpaceId: string;
  }): Promise<WorkspaceEmbeddingProfileState> {
    await this.db
      .insertInto("workspace_embedding_profiles")
      .values({
        workspace_id: input.workspaceId,
        active_embedding_space_id: input.activeEmbeddingSpaceId,
      })
      .onConflict((oc) => oc.column("workspace_id").doNothing())
      .execute();

    const profile = await this.findWorkspaceProfile(input.workspaceId);
    if (!profile) {
      throw new Error("Failed to initialize workspace embedding profile");
    }
    return profile;
  }

  async findWorkspaceProfile(workspaceId: string): Promise<WorkspaceEmbeddingProfileState | null> {
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (trx) => {
        const profileRow = await trx
          .selectFrom("workspace_embedding_profiles")
          .select(workspaceProfileColumns)
          .where("workspace_id", "=", workspaceId)
          .executeTakeFirst();
        if (!profileRow) {
          return null;
        }
        const transition = await this.findLatestTransition(trx, workspaceId);
        return mapWorkspaceProfile(
          profileRow,
          transition,
        );
      });
  }

  async listBuildingTransitions(input: {
    limit: number;
  }): Promise<Array<{
    profile: WorkspaceEmbeddingProfileState;
    transition: EmbeddingTransitionState;
  }>> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new Error("Embedding transition reconciliation limit must be between 1 and 1000");
    }
    const rows = await this.db
      .selectFrom("workspace_embedding_transitions as t")
      .innerJoin(
        "workspace_embedding_profiles as p",
        "p.workspace_id",
        "t.workspace_id",
      )
      .select([
        "p.workspace_id as workspace_id",
        "p.active_embedding_space_id",
        "p.pending_embedding_space_id",
        "p.generation as profile_generation",
        "t.id as transition_id",
        "t.source_embedding_space_id",
        "t.target_embedding_space_id",
        "t.generation as transition_generation",
        "t.status as transition_status",
        "t.failure_reason",
      ])
      .where("t.status", "=", "building")
      .whereRef(
        "p.pending_embedding_space_id",
        "=",
        "t.target_embedding_space_id",
      )
      .whereRef("p.generation", "=", "t.generation")
      .orderBy("t.generation", "asc")
      .orderBy("t.id", "asc")
      .limit(input.limit)
      .execute();

    return rows.map((row) => {
      const transition: EmbeddingTransitionState = {
        id: row.transition_id,
        sourceEmbeddingSpaceId: row.source_embedding_space_id,
        targetEmbeddingSpaceId: row.target_embedding_space_id,
        generation: String(row.transition_generation),
        status: normalizeTransitionStatus(row.transition_status),
        failureReason: normalizeFailureReason(row.failure_reason),
      };
      return {
        profile: {
          workspaceId: row.workspace_id,
          activeEmbeddingSpaceId: row.active_embedding_space_id,
          pendingEmbeddingSpaceId: row.pending_embedding_space_id,
          generation: String(row.profile_generation),
          transition,
        },
        transition,
      };
    });
  }

  async startTransition(input: {
    workspaceId: string;
    targetEmbeddingSpaceId: string;
    expectedGeneration: string;
  }): Promise<{ profile: WorkspaceEmbeddingProfileState; transition: EmbeddingTransitionState }> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.lockWorkspaceProfile(trx, input.workspaceId);
      const targetSpace = await trx
        .selectFrom("embedding_spaces")
        .select("status")
        .where("id", "=", input.targetEmbeddingSpaceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (targetSpace.status === "quarantined") {
        throw new EmbeddingProfileLifecycleError(
          "target_quarantined",
          "Embedding transition target is quarantined",
        );
      }
      const transitionId = randomUUID();
      const started = beginEmbeddingTransition(current, {
        transitionId,
        targetEmbeddingSpaceId: input.targetEmbeddingSpaceId,
        expectedGeneration: input.expectedGeneration,
      });

      await trx
        .updateTable("workspace_embedding_profiles")
        .set({
          pending_embedding_space_id: started.profile.pendingEmbeddingSpaceId,
          generation: started.profile.generation,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("generation", "=", input.expectedGeneration)
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("workspace_embedding_transitions")
        .values({
          id: transitionId,
          workspace_id: input.workspaceId,
          source_embedding_space_id: started.transition.sourceEmbeddingSpaceId,
          target_embedding_space_id: started.transition.targetEmbeddingSpaceId,
          generation: started.transition.generation,
          status: started.transition.status,
        })
        .execute();

      return started;
    });
  }

  async cancelTransition(input: {
    workspaceId: string;
    transitionId: string;
    expectedGeneration: string;
  }): Promise<WorkspaceEmbeddingProfileState> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.lockWorkspaceProfile(trx, input.workspaceId, input.transitionId);
      const cancelled = cancelEmbeddingTransition(current, input);

      await trx
        .updateTable("workspace_embedding_profiles")
        .set({
          pending_embedding_space_id: null,
          generation: cancelled.generation,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("generation", "=", input.expectedGeneration)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("workspace_embedding_transitions")
        .set({
          status: "cancelled",
          completed_at: currentTimestamp(),
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "=", input.transitionId)
        .where("status", "in", ["building", "blocked", "quarantined"])
        .executeTakeFirstOrThrow();

      return cancelled;
    });
  }

  async promoteTransitionIfEligible(input: {
    workspaceId: string;
    transitionId: string;
    expectedGeneration: string;
    backendKey: string;
  }): Promise<WorkspaceEmbeddingProfileState> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(
        vectorProjectionMutationFenceKey(input.workspaceId),
      ).execute(trx);
      const current = await this.lockWorkspaceProfile(trx, input.workspaceId, input.transitionId);
      const transition = current.transition;
      if (!transition || transition.id !== input.transitionId) {
        throw new EmbeddingProfileLifecycleError(
          "transition_not_building",
          "Embedding transition is not the current building transition",
        );
      }

      const targetSpace = await trx
        .selectFrom("embedding_spaces")
        .select("status")
        .where("id", "=", transition.targetEmbeddingSpaceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const unresolvedDeadLetter = await trx
        .selectFrom("vector_index_work as dead_letter")
        .select("dead_letter.id")
        .where("dead_letter.workspace_id", "=", input.workspaceId)
        .where(
          "dead_letter.embedding_space_id",
          "=",
          transition.targetEmbeddingSpaceId,
        )
        .where("dead_letter.status", "=", "dead_letter")
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("vector_index_work as superseding")
                .select("superseding.id")
                .whereRef(
                  "superseding.workspace_id",
                  "=",
                  "dead_letter.workspace_id",
                )
                .whereRef(
                  "superseding.embedding_space_id",
                  "=",
                  "dead_letter.embedding_space_id",
                )
                .whereRef(
                  "superseding.chunk_id",
                  "=",
                  "dead_letter.chunk_id",
                )
                .whereRef(
                  "superseding.canonical_version",
                  ">",
                  "dead_letter.canonical_version",
                )
                .whereRef(
                  "superseding.sequence",
                  ">",
                  "dead_letter.sequence",
                ),
            ),
          ),
        )
        .limit(1)
        .executeTakeFirst();
      if (unresolvedDeadLetter) {
        const blocked = blockEmbeddingTransition(current, {
          transitionId: input.transitionId,
          expectedGeneration: input.expectedGeneration,
          reason: "backfill_retry_exhausted",
        });
        await trx
          .updateTable("workspace_embedding_transitions")
          .set({
            status: "blocked",
            failure_reason: "backfill_retry_exhausted",
            updated_at: currentTimestamp(),
          })
          .where("workspace_id", "=", input.workspaceId)
          .where("id", "=", input.transitionId)
          .where("generation", "=", input.expectedGeneration)
          .where("status", "=", "building")
          .executeTakeFirstOrThrow();
        return blocked;
      }
      const uncoveredChunk = await trx
        .selectFrom("chunks as c")
        .innerJoin("documents as d", (join) =>
          join
            .onRef("d.id", "=", "c.document_id")
            .onRef("d.workspace_id", "=", "c.workspace_id"),
        )
        .select("c.id")
        .where("c.workspace_id", "=", input.workspaceId)
        .where("d.status", "=", "ready")
        .where("d.retrieval_enabled", "=", true)
        .where((eb) =>
          eb.or([
            eb("d.retrieval_expires_at", "is", null),
            eb("d.retrieval_expires_at", ">", currentTimestamp()),
          ]),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("chunk_embeddings as ce")
                .select("ce.chunk_id")
                .whereRef("ce.workspace_id", "=", "c.workspace_id")
                .whereRef("ce.chunk_id", "=", "c.id")
                .where("ce.embedding_space_id", "=", transition.targetEmbeddingSpaceId)
                .whereRef("ce.document_revision", "=", "d.revision"),
            ),
          ),
        )
        .limit(1)
        .executeTakeFirst();
      const pinnedWork = await trx
        .selectFrom("document_processing_jobs")
        .select("id")
        .where("workspace_id", "=", input.workspaceId)
        .where("kind", "=", "embedding_profile")
        .where("embedding_space_id", "=", transition.targetEmbeddingSpaceId)
        .where("workspace_profile_generation", "=", input.expectedGeneration)
        .where("status", "in", ["queued", "processing", "failed"])
        .limit(1)
        .executeTakeFirst();
      const highWater = await trx
        .selectFrom("vector_index_work")
        .select((eb) => eb.fn.max<string>("sequence").as("sequence"))
        .where("workspace_id", "=", input.workspaceId)
        .where("embedding_space_id", "=", transition.targetEmbeddingSpaceId)
        .executeTakeFirstOrThrow();
      const checkpoint = await trx
        .selectFrom("vector_index_checkpoints")
        .select(["acknowledged_sequence", "readiness"])
        .where("backend_key", "=", input.backendKey)
        .where("workspace_id", "=", input.workspaceId)
        .where("embedding_space_id", "=", transition.targetEmbeddingSpaceId)
        .forUpdate()
        .executeTakeFirst();
      const requiredSequence = String(highWater.sequence ?? "0");
      const vectorIndexReady = Boolean(
        checkpoint
        && (checkpoint.readiness === "ready" || checkpoint.readiness === "exact_fallback")
        && BigInt(checkpoint.acknowledged_sequence) >= BigInt(requiredSequence),
      );
      const promoted = promoteEmbeddingTransition(current, {
        transitionId: input.transitionId,
        expectedGeneration: input.expectedGeneration,
        canonicalCoverageComplete: targetSpace.status === "active" && !uncoveredChunk,
        vectorIndexReady,
        hasInFlightWork: Boolean(pinnedWork),
      });

      await trx
        .updateTable("workspace_embedding_profiles")
        .set({
          active_embedding_space_id: promoted.activeEmbeddingSpaceId,
          pending_embedding_space_id: null,
          generation: promoted.generation,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("generation", "=", input.expectedGeneration)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("workspace_embedding_transitions")
        .set({
          status: "promoted",
          completed_at: currentTimestamp(),
          cleanup_after: nowPlusSeconds(7 * 24 * 60 * 60),
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "=", input.transitionId)
        .where("status", "=", "building")
        .executeTakeFirstOrThrow();

      return promoted;
    });
  }

  async failTransition(input: {
    workspaceId: string;
    transitionId: string;
    expectedGeneration: string;
    status: EmbeddingTransitionFailureStatus;
    reason: EmbeddingTransitionFailureReason;
  }): Promise<WorkspaceEmbeddingProfileState> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.lockWorkspaceProfile(
        trx,
        input.workspaceId,
        input.transitionId,
      );
      const failed = transitionFailureState(current, input);

      if (input.status === "quarantined") {
        const transition = current.transition;
        if (!transition || transition.id !== input.transitionId) {
          throw new EmbeddingProfileLifecycleError(
            "transition_not_building",
            "Embedding transition is not the current building transition",
          );
        }
        await trx
          .selectFrom("embedding_spaces")
          .select("id")
          .where("id", "=", transition.targetEmbeddingSpaceId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await trx
          .updateTable("embedding_spaces")
          .set({
            status: "quarantined",
            quarantine_reason: input.reason,
            updated_at: currentTimestamp(),
          })
          .where("id", "=", transition.targetEmbeddingSpaceId)
          .executeTakeFirstOrThrow();
      }

      if (input.status === "failed") {
        await trx
          .updateTable("workspace_embedding_profiles")
          .set({
            pending_embedding_space_id: null,
            generation: failed.generation,
            updated_at: currentTimestamp(),
          })
          .where("workspace_id", "=", input.workspaceId)
          .where("generation", "=", input.expectedGeneration)
          .executeTakeFirstOrThrow();
      }

      await trx
        .updateTable("workspace_embedding_transitions")
        .set({
          status: input.status,
          failure_reason: input.reason,
          completed_at: input.status === "failed" ? currentTimestamp() : null,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "=", input.transitionId)
        .where("status", "=", "building")
        .executeTakeFirstOrThrow();

      return failed;
    });
  }

  async quarantineEmbeddingSpace(input: {
    embeddingSpaceId: string;
    reason: EmbeddingTransitionFailureReason;
  }): Promise<EmbeddingSpaceRecord> {
    const row = await this.db
      .updateTable("embedding_spaces")
      .set({
        status: "quarantined",
        quarantine_reason: input.reason,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", input.embeddingSpaceId)
      .returning(embeddingSpaceColumns)
      .executeTakeFirstOrThrow();
    return mapEmbeddingSpace(row);
  }

  async hasLiveReferences(embeddingSpaceId: string): Promise<boolean> {
    const profile = await this.db
      .selectFrom("workspace_embedding_profiles")
      .select("workspace_id")
      .where((eb) =>
        eb.or([
          eb("active_embedding_space_id", "=", embeddingSpaceId),
          eb("pending_embedding_space_id", "=", embeddingSpaceId),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    if (profile) {
      return true;
    }

    const transition = await this.db
      .selectFrom("workspace_embedding_transitions")
      .select("id")
      .where((eb) =>
        eb.or([
          eb("source_embedding_space_id", "=", embeddingSpaceId),
          eb("target_embedding_space_id", "=", embeddingSpaceId),
        ]),
      )
      .where("status", "in", ["building", "blocked", "quarantined"])
      .limit(1)
      .executeTakeFirst();
    return Boolean(transition);
  }

  private async lockWorkspaceProfile(
    db: Db,
    workspaceId: string,
    transitionId?: string,
  ): Promise<WorkspaceEmbeddingProfileState> {
    const profileRow = await db
      .selectFrom("workspace_embedding_profiles")
      .select(workspaceProfileColumns)
      .where("workspace_id", "=", workspaceId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const transition = transitionId
      ? await db
          .selectFrom("workspace_embedding_transitions")
          .select(transitionColumns)
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", transitionId)
          .forUpdate()
          .executeTakeFirst()
          .then((row) => row ? mapTransition(row) : null)
      : await this.findLatestTransition(db, workspaceId);
    return mapWorkspaceProfile(
      profileRow,
      transition,
    );
  }

  private async findLatestTransition(
    db: Db,
    workspaceId: string,
  ): Promise<EmbeddingTransitionState | null> {
    const row = await db
      .selectFrom("workspace_embedding_transitions")
      .select(transitionColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("generation", "desc")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? mapTransition(row) : null;
  }
}

const mapWorkspaceProfile = (
  row: WorkspaceProfileRow,
  transition: EmbeddingTransitionState | null,
): WorkspaceEmbeddingProfileState => ({
  workspaceId: row.workspace_id,
  activeEmbeddingSpaceId: row.active_embedding_space_id,
  pendingEmbeddingSpaceId: row.pending_embedding_space_id,
  generation: String(row.generation),
  transition,
});

const transitionFailureState = (
  profile: WorkspaceEmbeddingProfileState,
  input: {
    transitionId: string;
    expectedGeneration: string;
    status: EmbeddingTransitionFailureStatus;
    reason: EmbeddingTransitionFailureReason;
  },
): WorkspaceEmbeddingProfileState => {
  switch (input.status) {
    case "blocked":
      return blockEmbeddingTransition(profile, input);
    case "quarantined":
      return quarantineEmbeddingTransition(profile, input);
    case "failed":
      return failEmbeddingTransition(profile, input);
  }
};

export { EmbeddingProfileLifecycleError };
