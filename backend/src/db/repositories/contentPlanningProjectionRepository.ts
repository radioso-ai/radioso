import { randomUUID } from "node:crypto";
import { sql } from "kysely";

import type {
  ContentPlanProjectionBudgetReservation,
  ContentPlanProjectionGenerationRecord,
  ContentPlanProjectionRepositoryPort,
  ContentPlanProjectionStateRecord,
  ContentPlanProjectionTargetResolution,
} from "../../modules/contentPlanning/contracts/persistence.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface GenerationRow {
  id: string;
  workspace_id: string;
  embedding_space_id: string;
  kind: string;
  state: string;
  policy_version: number;
  horizon_from: Date;
  horizon_to: Date;
  coherent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ProjectionStateRow {
  workspace_id: string;
  coherent_generation_id: string | null;
  target_generation_id: string | null;
  projection_state: string;
  reason: string | null;
  discovery_created_at: Date | null;
  discovery_message_id: string | null;
  processed_through: Date | null;
  bootstrap_processed: string | null;
  bootstrap_total: string | null;
  budget_version: number;
  budget_window_started_at: Date;
  embedding_requests_used: number;
  estimated_spend_micros: string;
  lease_token: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface FreshnessObservationRow {
  id: string;
  observation_state: "pending_context" | "ready";
  observed_at: Date;
  vector_state: string | null;
}

interface IdentityTopicRow {
  id: string;
  generation_id: string;
  embedding_space_id: string;
  lifecycle: string;
  centroid: string | null;
  dimensions: number;
  centroid_weight: number;
  representative_observation_ids: string[];
  revision: number;
  merged_into_topic_id: string | null;
  redirect_expires_at: Date | null;
  enrichment_dirty_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface IdentityOverlapRow {
  old_topic_id: string;
  target_topic_id: string;
}

const REDIRECT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_IDENTITY_REDIRECT_HOPS = 8;

const generationColumns = [
  "id",
  "workspace_id",
  "embedding_space_id",
  "kind",
  "state",
  "policy_version",
  "horizon_from",
  "horizon_to",
  "coherent_at",
  "created_at",
  "updated_at",
] as const;

const projectionStateColumns = [
  "workspace_id",
  "coherent_generation_id",
  "target_generation_id",
  "projection_state",
  "reason",
  "discovery_created_at",
  "discovery_message_id",
  "processed_through",
  "bootstrap_processed",
  "bootstrap_total",
  "budget_version",
  "budget_window_started_at",
  "embedding_requests_used",
  "estimated_spend_micros",
  "lease_token",
  "lease_expires_at",
  "created_at",
  "updated_at",
] as const;

const mapGeneration = (row: GenerationRow): ContentPlanProjectionGenerationRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  embeddingSpaceId: row.embedding_space_id,
  kind: row.kind as ContentPlanProjectionGenerationRecord["kind"],
  state: row.state as ContentPlanProjectionGenerationRecord["state"],
  policyVersion: row.policy_version,
  horizonFrom: new Date(row.horizon_from),
  horizonTo: new Date(row.horizon_to),
  coherentAt: row.coherent_at ? new Date(row.coherent_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const mapProjectionState = (row: ProjectionStateRow): ContentPlanProjectionStateRecord => ({
  workspaceId: row.workspace_id,
  coherentGenerationId: row.coherent_generation_id,
  targetGenerationId: row.target_generation_id,
  projectionState: row.projection_state as ContentPlanProjectionStateRecord["projectionState"],
  reason: row.reason as ContentPlanProjectionStateRecord["reason"],
  discoveryCreatedAt: row.discovery_created_at ? new Date(row.discovery_created_at) : null,
  discoveryMessageId: row.discovery_message_id,
  processedThrough: row.processed_through ? new Date(row.processed_through) : null,
  bootstrapProcessed: row.bootstrap_processed,
  bootstrapTotal: row.bootstrap_total,
  budgetVersion: row.budget_version,
  budgetWindowStartedAt: new Date(row.budget_window_started_at),
  embeddingRequestsUsed: row.embedding_requests_used,
  estimatedSpendMicros: row.estimated_spend_micros,
  leaseToken: row.lease_token,
  leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class ContentPlanProjectionRepository implements ContentPlanProjectionRepositoryPort {
  constructor(private readonly db: Db) {}

  async createGeneration(
    input: Omit<ContentPlanProjectionGenerationRecord, "createdAt" | "updatedAt">,
  ): Promise<ContentPlanProjectionGenerationRecord> {
    const row = await this.db
      .insertInto("content_plan_projection_generations")
      .values({
        id: input.id,
        workspace_id: input.workspaceId,
        embedding_space_id: input.embeddingSpaceId,
        kind: input.kind,
        state: input.state,
        policy_version: input.policyVersion,
        horizon_from: input.horizonFrom,
        horizon_to: input.horizonTo,
        coherent_at: input.coherentAt,
      })
      .returning(generationColumns)
      .executeTakeFirstOrThrow();
    return mapGeneration(row as GenerationRow);
  }

  async findGeneration(
    id: string,
    workspaceId: string,
  ): Promise<ContentPlanProjectionGenerationRecord | null> {
    const row = await this.db
      .selectFrom("content_plan_projection_generations")
      .select(generationColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapGeneration(row as GenerationRow) : null;
  }

  async ensureTargetGeneration(input: {
    workspaceId: string;
    embeddingSpaceId: string;
    generationId: string;
    policyVersion: number;
    horizonFrom: Date;
    horizonTo: Date;
    total: string | null;
    budgetVersion: number;
    budgetWindowStartedAt: Date;
  }): Promise<ContentPlanProjectionTargetResolution> {
    if (
      !Number.isInteger(input.policyVersion)
      || input.policyVersion < 1
      || !Number.isInteger(input.budgetVersion)
      || input.budgetVersion < 1
      || !Number.isFinite(input.horizonFrom.getTime())
      || !Number.isFinite(input.horizonTo.getTime())
      || input.horizonFrom >= input.horizonTo
      || (input.total !== null && !/^\d+$/.test(input.total))
    ) {
      throw new Error("Invalid content planning projection target");
    }

    const run = async (trx: Db): Promise<ContentPlanProjectionTargetResolution> => {
      const workspace = await trx
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!workspace) {
        throw new Error("Content planning projection workspace is unavailable");
      }

      const stateRow = await trx
        .selectFrom("content_plan_projection_states")
        .select(projectionStateColumns)
        .where("workspace_id", "=", input.workspaceId)
        .executeTakeFirst();
      const state = stateRow ? mapProjectionState(stateRow as ProjectionStateRow) : null;
      const loadGeneration = async (generationId: string | null) => {
        if (!generationId) return null;
        const row = await trx
          .selectFrom("content_plan_projection_generations")
          .select(generationColumns)
          .where("workspace_id", "=", input.workspaceId)
          .where("id", "=", generationId)
          .executeTakeFirst();
        return row ? mapGeneration(row as GenerationRow) : null;
      };
      const coherent = await loadGeneration(state?.coherentGenerationId ?? null);
      const target = await loadGeneration(state?.targetGenerationId ?? null);

      if (coherent?.state === "coherent" && coherent.embeddingSpaceId === input.embeddingSpaceId) {
        if (target?.state === "building") {
          await trx
            .updateTable("content_plan_projection_generations")
            .set({ state: "failed", updated_at: currentTimestamp() })
            .where("workspace_id", "=", input.workspaceId)
            .where("id", "=", target.id)
            .execute();
          await trx
            .updateTable("content_plan_projection_states")
            .set({
              target_generation_id: null,
              projection_state: "ready",
              reason: null,
              discovery_created_at: null,
              discovery_message_id: null,
              bootstrap_processed: null,
              bootstrap_total: null,
              lease_token: null,
              lease_expires_at: null,
              updated_at: currentTimestamp(),
            })
            .where("workspace_id", "=", input.workspaceId)
            .execute();
        }
        return { kind: "coherent", generation: coherent };
      }

      if (target?.state === "building" && target.embeddingSpaceId === input.embeddingSpaceId) {
        return { kind: "target", generation: target };
      }
      if (target?.state === "building") {
        await trx
          .updateTable("content_plan_projection_generations")
          .set({ state: "failed", updated_at: currentTimestamp() })
          .where("workspace_id", "=", input.workspaceId)
          .where("id", "=", target.id)
          .execute();
      }

      const kind = coherent?.state === "coherent" ? "reprojection" as const : "bootstrap" as const;
      const generationRow = await trx
        .insertInto("content_plan_projection_generations")
        .values({
          id: input.generationId,
          workspace_id: input.workspaceId,
          embedding_space_id: input.embeddingSpaceId,
          kind,
          state: "building",
          policy_version: input.policyVersion,
          horizon_from: input.horizonFrom,
          horizon_to: input.horizonTo,
          coherent_at: null,
        })
        .returning(generationColumns)
        .executeTakeFirstOrThrow();

      const preserveBudget = state
        && state.budgetVersion === input.budgetVersion
        && state.budgetWindowStartedAt.getTime() === input.budgetWindowStartedAt.getTime();
      await trx
        .insertInto("content_plan_projection_states")
        .values({
          workspace_id: input.workspaceId,
          coherent_generation_id: coherent?.state === "coherent" ? coherent.id : null,
          target_generation_id: input.generationId,
          projection_state: kind === "bootstrap" ? "bootstrapping" : "reprojecting",
          reason: null,
          discovery_created_at: null,
          discovery_message_id: null,
          processed_through: state?.processedThrough ?? null,
          bootstrap_processed: input.total === null ? null : "0",
          bootstrap_total: input.total,
          budget_version: input.budgetVersion,
          budget_window_started_at: input.budgetWindowStartedAt,
          embedding_requests_used: preserveBudget ? state.embeddingRequestsUsed : 0,
          estimated_spend_micros: preserveBudget ? state.estimatedSpendMicros : "0",
          lease_token: null,
          lease_expires_at: null,
        })
        .onConflict((conflict) => conflict.column("workspace_id").doUpdateSet({
          coherent_generation_id: coherent?.state === "coherent" ? coherent.id : null,
          target_generation_id: input.generationId,
          projection_state: kind === "bootstrap" ? "bootstrapping" : "reprojecting",
          reason: null,
          discovery_created_at: null,
          discovery_message_id: null,
          bootstrap_processed: input.total === null ? null : "0",
          bootstrap_total: input.total,
          budget_version: input.budgetVersion,
          budget_window_started_at: input.budgetWindowStartedAt,
          embedding_requests_used: preserveBudget ? state!.embeddingRequestsUsed : 0,
          estimated_spend_micros: preserveBudget ? state!.estimatedSpendMicros : "0",
          lease_token: null,
          lease_expires_at: null,
          updated_at: currentTimestamp(),
        }))
        .execute();

      return {
        kind: "target",
        generation: mapGeneration(generationRow as GenerationRow),
      };
    };
    return this.db.isTransaction
      ? run(this.db)
      : this.db.transaction().execute(run);
  }

  async ensureTargetGenerationForIntake(input: {
    workspaceId: string;
    preferredEmbeddingSpaceId: string | undefined;
    generationId: string;
    policyVersion: number;
    horizonFrom: Date;
    horizonTo: Date;
    budgetVersion: number;
    budgetWindowStartedAt: Date;
  }): Promise<ContentPlanProjectionGenerationRecord | null> {
    const run = async (trx: Db) => {
      const embeddingSpaceId = input.preferredEmbeddingSpaceId ?? (await trx
        .selectFrom("workspace_embedding_profiles")
        .select("active_embedding_space_id")
        .where("workspace_id", "=", input.workspaceId)
        .executeTakeFirst())?.active_embedding_space_id;
      if (!embeddingSpaceId) return null;
      const target = await new ContentPlanProjectionRepository(trx).ensureTargetGeneration({
        workspaceId: input.workspaceId,
        embeddingSpaceId,
        generationId: input.generationId,
        policyVersion: input.policyVersion,
        horizonFrom: input.horizonFrom,
        horizonTo: input.horizonTo,
        total: null,
        budgetVersion: input.budgetVersion,
        budgetWindowStartedAt: input.budgetWindowStartedAt,
      });
      return target.generation;
    };
    return this.db.isTransaction
      ? run(this.db)
      : this.db.transaction().execute(run);
  }

  async upsertProjectionState(input: {
    workspaceId: string;
    coherentGenerationId: string | null;
    targetGenerationId: string | null;
    projectionState: ContentPlanProjectionStateRecord["projectionState"];
    reason: string | null;
    processedThrough: Date | null;
    bootstrapProcessed: string | null;
    bootstrapTotal: string | null;
    budgetVersion: number;
    budgetWindowStartedAt: Date;
  }): Promise<ContentPlanProjectionStateRecord> {
    const row = await this.db
      .insertInto("content_plan_projection_states")
      .values({
        workspace_id: input.workspaceId,
        coherent_generation_id: input.coherentGenerationId,
        target_generation_id: input.targetGenerationId,
        projection_state: input.projectionState,
        reason: input.reason,
        processed_through: input.processedThrough,
        bootstrap_processed: input.bootstrapProcessed,
        bootstrap_total: input.bootstrapTotal,
        budget_version: input.budgetVersion,
        budget_window_started_at: input.budgetWindowStartedAt,
      })
      .onConflict((conflict) => conflict.column("workspace_id").doUpdateSet({
        coherent_generation_id: input.coherentGenerationId,
        target_generation_id: input.targetGenerationId,
        projection_state: input.projectionState,
        reason: input.reason,
        processed_through: input.processedThrough,
        bootstrap_processed: input.bootstrapProcessed,
        bootstrap_total: input.bootstrapTotal,
        budget_version: input.budgetVersion,
        budget_window_started_at: input.budgetWindowStartedAt,
        updated_at: currentTimestamp(),
      }))
      .returning(projectionStateColumns)
      .executeTakeFirstOrThrow();
    return mapProjectionState(row as ProjectionStateRow);
  }

  async findProjectionState(workspaceId: string): Promise<ContentPlanProjectionStateRecord | null> {
    const row = await this.db
      .selectFrom("content_plan_projection_states")
      .select(projectionStateColumns)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? mapProjectionState(row as ProjectionStateRow) : null;
  }

  async markProjectionWorkPending(input: {
    workspaceId: string;
    generationId: string;
    observedAt: Date;
  }): Promise<boolean> {
    if (!Number.isFinite(input.observedAt.getTime())) {
      throw new Error("Content planning projection observation time must be valid");
    }
    const beforeObservedAt = new Date(input.observedAt.getTime() - 1);
    const result = await this.db
      .updateTable("content_plan_projection_states")
      .set({
        projection_state: "updating",
        reason: "projection_work_pending",
        processed_through: sql<Date | null>`CASE
          WHEN processed_through >= ${input.observedAt} THEN ${beforeObservedAt}
          ELSE processed_through
        END`,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", input.workspaceId)
      .where("coherent_generation_id", "=", input.generationId)
      .where("target_generation_id", "is", null)
      .where("projection_state", "=", "ready")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async refreshProjectionFreshness(input: {
    workspaceId: string;
    generationId: string;
    now: Date;
    delayedAfterMs: number;
    scanLimit: number;
  }): Promise<ContentPlanProjectionStateRecord | null> {
    if (
      !Number.isFinite(input.now.getTime())
      || !Number.isSafeInteger(input.delayedAfterMs)
      || input.delayedAfterMs < 1
      || !Number.isSafeInteger(input.scanLimit)
      || input.scanLimit < 1
      || input.scanLimit > 500
    ) {
      throw new Error("Content planning projection freshness input is invalid");
    }
    return this.db.transaction().execute(async (trx) => {
      const stateRow = await trx
        .selectFrom("content_plan_projection_states")
        .select(projectionStateColumns)
        .where("workspace_id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!stateRow) return null;
      const state = mapProjectionState(stateRow as ProjectionStateRow);
      if (
        state.coherentGenerationId !== input.generationId
        || state.targetGenerationId !== null
      ) return state;

      let progressQuery = trx
        .selectFrom("content_plan_observations as observation")
        .leftJoin("content_plan_observation_vectors as vector", (join) => join
          .onRef("vector.workspace_id", "=", "observation.workspace_id")
          .onRef("vector.observation_id", "=", "observation.id")
          .on("vector.generation_id", "=", input.generationId))
        .select([
          "observation.id",
          "observation.observation_state",
          "observation.observed_at",
          "vector.state as vector_state",
        ])
        .where("observation.workspace_id", "=", input.workspaceId)
        .where("observation.observation_state", "in", ["pending_context", "ready"]);
      if (state.processedThrough) {
        progressQuery = progressQuery.where("observation.observed_at", ">", state.processedThrough);
      }
      const progressRows = await progressQuery
        .orderBy("observation.observed_at", "asc")
        .orderBy("observation.id", "asc")
        .limit(input.scanLimit + 1)
        .execute() as FreshnessObservationRow[];
      const page = progressRows.slice(0, input.scanLimit);
      let processedThrough = state.processedThrough;
      for (let index = 0; index < page.length; index += 1) {
        const row = page[index]!;
        if (row.observation_state !== "ready" || row.vector_state !== "assigned") break;
        const next = progressRows[index + 1];
        if (!next || new Date(next.observed_at).getTime() > new Date(row.observed_at).getTime()) {
          processedThrough = new Date(row.observed_at);
        }
      }

      const [terminalVector, pendingVector, pendingContext] = await Promise.all([
        trx
          .selectFrom("content_plan_observation_vectors")
          .select("observation_id")
          .where("workspace_id", "=", input.workspaceId)
          .where("generation_id", "=", input.generationId)
          .where("state", "=", "failed")
          .limit(1)
          .executeTakeFirst(),
        trx
          .selectFrom("content_plan_observation_vectors")
          .select("observation_id")
          .where("workspace_id", "=", input.workspaceId)
          .where("generation_id", "=", input.generationId)
          .where("state", "in", ["pending_embedding", "ready", "processing", "retryable"])
          .limit(1)
          .executeTakeFirst(),
        trx
          .selectFrom("content_plan_observations")
          .select("id")
          .where("workspace_id", "=", input.workspaceId)
          .where("observation_state", "=", "pending_context")
          .limit(1)
          .executeTakeFirst(),
      ]);
      const missingVectorInPage = page.some((row) =>
        row.observation_state === "ready" && row.vector_state === null);
      const hasPendingWork = pendingVector !== undefined
        || pendingContext !== undefined
        || missingVectorInPage
        || progressRows.length > input.scanLimit;
      const lagMs = processedThrough === null
        ? 0
        : Math.max(0, input.now.getTime() - processedThrough.getTime());
      const projectionState = terminalVector
        ? "degraded" as const
        : hasPendingWork
          ? lagMs >= input.delayedAfterMs ? "delayed" as const : "updating" as const
          : "ready" as const;
      const reason = projectionState === "degraded"
        ? "projection_terminal_failure" as const
        : projectionState === "delayed"
          ? "projection_backlog_delayed" as const
          : projectionState === "updating"
            ? "projection_work_pending" as const
            : null;
      const updated = await trx
        .updateTable("content_plan_projection_states")
        .set({
          projection_state: projectionState,
          reason,
          processed_through: processedThrough,
          updated_at: input.now,
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("coherent_generation_id", "=", input.generationId)
        .where("target_generation_id", "is", null)
        .returning(projectionStateColumns)
        .executeTakeFirst();
      return updated ? mapProjectionState(updated as ProjectionStateRow) : null;
    });
  }

  async resolveWritableGeneration(input: {
    workspaceId: string;
    embeddingSpaceId?: string;
  }): Promise<ContentPlanProjectionGenerationRecord | null> {
    const state = await this.findProjectionState(input.workspaceId);
    if (!state) return null;
    for (const generationId of [state.targetGenerationId, state.coherentGenerationId]) {
      if (!generationId) continue;
      const generation = await this.findGeneration(generationId, input.workspaceId);
      if (
        generation
        && (generation.state === "building" || generation.state === "coherent")
        && (!input.embeddingSpaceId || generation.embeddingSpaceId === input.embeddingSpaceId)
      ) {
        return generation;
      }
    }
    return null;
  }

  async claimProjectionLease(input: {
    workspaceId: string;
    now: Date;
    leaseMs: number;
  }): Promise<ContentPlanProjectionStateRecord | null> {
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1 || !Number.isFinite(input.now.getTime())) {
      throw new Error("Projection lease requires a valid time and positive duration");
    }
    const token = randomUUID();
    const expiresAt = new Date(input.now.getTime() + input.leaseMs);
    const row = await this.db
      .updateTable("content_plan_projection_states")
      .set({
        lease_token: token,
        lease_expires_at: expiresAt,
        updated_at: input.now,
      })
      .where("workspace_id", "=", input.workspaceId)
      .where((eb) => eb.or([
        eb("lease_token", "is", null),
        eb("lease_expires_at", "<=", input.now),
      ]))
      .returning(projectionStateColumns)
      .executeTakeFirst();
    return row ? mapProjectionState(row as ProjectionStateRow) : null;
  }

  async releaseProjectionLease(input: {
    workspaceId: string;
    leaseToken: string;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("content_plan_projection_states")
      .set({
        lease_token: null,
        lease_expires_at: null,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", input.workspaceId)
      .where("lease_token", "=", input.leaseToken)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async initializeTargetProgress(input: {
    workspaceId: string;
    targetGenerationId: string;
    leaseToken: string;
    total: string;
  }): Promise<ContentPlanProjectionStateRecord | null> {
    if (!/^\d+$/.test(input.total)) {
      throw new Error("Invalid content planning projection total");
    }
    const row = await this.db
      .updateTable("content_plan_projection_states")
      .set({
        bootstrap_processed: "0",
        bootstrap_total: input.total,
        lease_token: null,
        lease_expires_at: null,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", input.workspaceId)
      .where("target_generation_id", "=", input.targetGenerationId)
      .where("lease_token", "=", input.leaseToken)
      .where("bootstrap_processed", "is", null)
      .where("bootstrap_total", "is", null)
      .returning(projectionStateColumns)
      .executeTakeFirst();
    return row ? mapProjectionState(row as ProjectionStateRow) : null;
  }

  async advanceDiscoveryCursor(input: {
    workspaceId: string;
    leaseToken: string;
    discoveryCreatedAt: Date;
    discoveryMessageId: string;
    bootstrapProcessed: string;
    bootstrapTotal: string;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("content_plan_projection_states")
      .set({
        discovery_created_at: input.discoveryCreatedAt,
        discovery_message_id: input.discoveryMessageId,
        bootstrap_processed: input.bootstrapProcessed,
        bootstrap_total: input.bootstrapTotal,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", input.workspaceId)
      .where("lease_token", "=", input.leaseToken)
      .where((eb) => eb.or([
        eb("discovery_created_at", "is", null),
        eb("discovery_created_at", "<", input.discoveryCreatedAt),
        eb.and([
          eb("discovery_created_at", "=", input.discoveryCreatedAt),
          eb("discovery_message_id", "<=", input.discoveryMessageId),
        ]),
      ]))
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async reserveProjectionBudget(input: {
    workspaceId: string;
    generationId: string;
    budgetVersion: number;
    budgetWindowStartedAt: Date;
    requests: number;
    estimatedSpendMicros: number;
    maxRequests: number;
    maxEstimatedSpendMicros: number;
  }): Promise<ContentPlanProjectionBudgetReservation> {
    for (const value of [
      input.budgetVersion,
      input.requests,
      input.estimatedSpendMicros,
      input.maxRequests,
      input.maxEstimatedSpendMicros,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Projection budget values must be non-negative safe integers");
      }
    }
    if (input.budgetVersion < 1 || input.maxRequests < 1 || input.maxEstimatedSpendMicros < 1) {
      throw new Error("Projection budget policy limits must be positive");
    }

    return this.db.transaction().execute(async (trx) => {
      const stateRow = await trx
        .selectFrom("content_plan_projection_states")
        .select(projectionStateColumns)
        .where("workspace_id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!stateRow || stateRow.target_generation_id !== input.generationId) {
        return { kind: "granted" };
      }
      const generation = await trx
        .selectFrom("content_plan_projection_generations")
        .select(["kind", "state"])
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "=", input.generationId)
        .executeTakeFirst();
      if (!generation || generation.state !== "building") {
        return { kind: "granted" };
      }

      const resetWindow = stateRow.budget_version !== input.budgetVersion
        || new Date(stateRow.budget_window_started_at).getTime() !== input.budgetWindowStartedAt.getTime();
      const usedRequests = resetWindow ? 0 : stateRow.embedding_requests_used;
      const usedSpend = resetWindow ? 0n : BigInt(stateRow.estimated_spend_micros);
      if (
        !resetWindow
        && stateRow.projection_state === "budget_paused"
        && input.requests === 0
        && input.estimatedSpendMicros === 0
      ) {
        return { kind: "budget_paused", reason: "daily_budget_exhausted" };
      }
      const nextRequests = usedRequests + input.requests;
      const nextSpend = usedSpend + BigInt(input.estimatedSpendMicros);
      const paused = nextRequests > input.maxRequests
        || nextSpend > BigInt(input.maxEstimatedSpendMicros);
      const resumeState = generation.kind === "bootstrap" ? "bootstrapping" : "reprojecting";

      await trx
        .updateTable("content_plan_projection_states")
        .set(paused
          ? {
              projection_state: "budget_paused",
              reason: "daily_budget_exhausted",
              budget_version: input.budgetVersion,
              budget_window_started_at: input.budgetWindowStartedAt,
              embedding_requests_used: usedRequests,
              estimated_spend_micros: usedSpend.toString(),
              lease_token: null,
              lease_expires_at: null,
              updated_at: currentTimestamp(),
            }
          : {
              projection_state: resumeState,
              reason: null,
              budget_version: input.budgetVersion,
              budget_window_started_at: input.budgetWindowStartedAt,
              embedding_requests_used: nextRequests,
              estimated_spend_micros: nextSpend.toString(),
              updated_at: currentTimestamp(),
            })
        .where("workspace_id", "=", input.workspaceId)
        .execute();

      return paused
        ? { kind: "budget_paused", reason: "daily_budget_exhausted" }
        : { kind: "granted" };
    });
  }

  async promoteGeneration(input: {
    workspaceId: string;
    targetGenerationId: string;
    expectedCoherentGenerationId: string | null;
    leaseToken: string;
    coherentAt: Date;
    processedThrough: Date;
  }): Promise<ContentPlanProjectionStateRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      const state = await trx
        .selectFrom("content_plan_projection_states")
        .select(projectionStateColumns)
        .where("workspace_id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !state
        || state.target_generation_id !== input.targetGenerationId
        || state.coherent_generation_id !== input.expectedCoherentGenerationId
        || state.lease_token !== input.leaseToken
      ) {
        return null;
      }
      const target = await trx
        .selectFrom("content_plan_projection_generations")
        .select(["id", "state", "horizon_from", "horizon_to"])
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "=", input.targetGenerationId)
        .forUpdate()
        .executeTakeFirst();
      if (!target || target.state !== "building") return null;

      if (
        state.bootstrap_processed === null
        || state.bootstrap_total === null
        || BigInt(state.bootstrap_processed) !== BigInt(state.bootstrap_total)
      ) {
        return null;
      }
      const consistency = await sql<{
        expected_count: string;
        assigned_count: string;
      }>`
        SELECT
          COUNT(*)::text AS expected_count,
          COUNT(*) FILTER (
            WHERE v.state = 'assigned' AND membership.observation_id IS NOT NULL
          )::text AS assigned_count
        FROM content_plan_observations observation
        LEFT JOIN content_plan_observation_vectors v
          ON v.workspace_id = observation.workspace_id
         AND v.observation_id = observation.id
         AND v.generation_id = ${input.targetGenerationId}
        LEFT JOIN content_plan_topic_memberships membership
          ON membership.workspace_id = observation.workspace_id
         AND membership.observation_id = observation.id
         AND membership.generation_id = ${input.targetGenerationId}
        WHERE observation.workspace_id = ${input.workspaceId}
          AND observation.observation_state = 'ready'
          AND observation.observed_at >= ${target.horizon_from}
          AND observation.observed_at < ${target.horizon_to}
      `.execute(trx);
      const summary = consistency.rows[0];
      if (!summary || BigInt(summary.expected_count) !== BigInt(summary.assigned_count)) {
        return null;
      }

      if (input.expectedCoherentGenerationId) {
        await reconcileTargetTopicIdentity(trx, {
          workspaceId: input.workspaceId,
          coherentGenerationId: input.expectedCoherentGenerationId,
          targetGenerationId: input.targetGenerationId,
          promotedAt: input.coherentAt,
        });
        const superseded = await trx
          .updateTable("content_plan_projection_generations")
          .set({ state: "superseded", updated_at: currentTimestamp() })
          .where("workspace_id", "=", input.workspaceId)
          .where("id", "=", input.expectedCoherentGenerationId)
          .where("state", "=", "coherent")
          .executeTakeFirst();
        if (Number(superseded.numUpdatedRows) !== 1) return null;
      }
      const coherent = await trx
        .updateTable("content_plan_projection_generations")
        .set({
          state: "coherent",
          coherent_at: input.coherentAt,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "=", input.targetGenerationId)
        .where("state", "=", "building")
        .executeTakeFirst();
      if (Number(coherent.numUpdatedRows) !== 1) return null;

      const promoted = await trx
        .updateTable("content_plan_projection_states")
        .set({
          coherent_generation_id: input.targetGenerationId,
          target_generation_id: null,
          projection_state: "ready",
          reason: null,
          processed_through: input.processedThrough,
          lease_token: null,
          lease_expires_at: null,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("lease_token", "=", input.leaseToken)
        .returning(projectionStateColumns)
        .executeTakeFirst();
      return promoted ? mapProjectionState(promoted as ProjectionStateRow) : null;
    });
  }

  async pruneExpiredGenerations(input: {
    workspaceId: string;
    failedBefore: Date;
    supersededBefore: Date;
    limit: number;
  }): Promise<{ failedCount: number; supersededCount: number }> {
    if (
      !Number.isFinite(input.failedBefore.getTime())
      || !Number.isFinite(input.supersededBefore.getTime())
      || !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > 100
    ) {
      throw new Error("Invalid content planning generation retention request");
    }
    return this.db.transaction().execute(async (trx) => {
      const selected = await trx
        .selectFrom("content_plan_projection_generations as generation")
        .select(["generation.id", "generation.state"])
        .where("generation.workspace_id", "=", input.workspaceId)
        .where((eb) => eb.or([
          eb.and([
            eb("generation.state", "=", "failed"),
            eb("generation.updated_at", "<", input.failedBefore),
          ]),
          eb.and([
            eb("generation.state", "=", "superseded"),
            eb("generation.updated_at", "<", input.supersededBefore),
          ]),
        ]))
        .where((eb) => eb.not(eb.exists(
          eb.selectFrom("content_plan_projection_states as projection_state")
            .select("projection_state.workspace_id")
            .whereRef("projection_state.workspace_id", "=", "generation.workspace_id")
            .where((stateExpression) => stateExpression.or([
              stateExpression("projection_state.coherent_generation_id", "=", eb.ref("generation.id")),
              stateExpression("projection_state.target_generation_id", "=", eb.ref("generation.id")),
            ])),
        )))
        .orderBy("generation.updated_at", "asc")
        .orderBy("generation.id", "asc")
        .forUpdate()
        .skipLocked()
        .limit(input.limit)
        .execute();
      if (selected.length === 0) return { failedCount: 0, supersededCount: 0 };
      const selectedIds = selected.map((generation) => generation.id);
      const deleted = await trx
        .deleteFrom("content_plan_projection_generations")
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "in", selectedIds)
        .where("state", "in", ["failed", "superseded"])
        .returning("state")
        .execute();
      return {
        failedCount: deleted.filter((generation) => generation.state === "failed").length,
        supersededCount: deleted.filter((generation) => generation.state === "superseded").length,
      };
    });
  }
}

const identityTopicColumns = [
  "id",
  "generation_id",
  "embedding_space_id",
  "lifecycle",
  "centroid",
  "dimensions",
  "centroid_weight",
  "representative_observation_ids",
  "revision",
  "merged_into_topic_id",
  "redirect_expires_at",
  "enrichment_dirty_at",
  "created_at",
  "updated_at",
] as const;

const reconcileTargetTopicIdentity = async (trx: Db, input: {
  workspaceId: string;
  coherentGenerationId: string;
  targetGenerationId: string;
  promotedAt: Date;
}): Promise<void> => {
  const lockedTopics = await trx
    .selectFrom("content_plan_topics")
    .select(identityTopicColumns)
    .where("workspace_id", "=", input.workspaceId)
    .where("generation_id", "in", [input.coherentGenerationId, input.targetGenerationId])
    .orderBy("generation_id", "asc")
    .orderBy("id", "asc")
    .forUpdate()
    .execute() as IdentityTopicRow[];
  const oldTopics = lockedTopics.filter((topic) => topic.generation_id === input.coherentGenerationId);
  const targetTopics = lockedTopics.filter((topic) => topic.generation_id === input.targetGenerationId);
  const targetIds = new Set(targetTopics.map((topic) => topic.id));
  const overlaps = await trx
    .selectFrom("content_plan_topic_memberships as old_membership")
    .innerJoin("content_plan_topics as old_topic", (join) => join
      .onRef("old_topic.workspace_id", "=", "old_membership.workspace_id")
      .onRef("old_topic.generation_id", "=", "old_membership.generation_id")
      .onRef("old_topic.id", "=", "old_membership.topic_id"))
    .innerJoin("content_plan_topic_memberships as target_membership", (join) => join
      .onRef("target_membership.workspace_id", "=", "old_membership.workspace_id")
      .onRef("target_membership.observation_id", "=", "old_membership.observation_id"))
    .innerJoin("content_plan_topics as target_topic", (join) => join
      .onRef("target_topic.workspace_id", "=", "target_membership.workspace_id")
      .onRef("target_topic.generation_id", "=", "target_membership.generation_id")
      .onRef("target_topic.id", "=", "target_membership.topic_id"))
    .select([
      "old_topic.id as old_topic_id",
      "target_topic.id as target_topic_id",
    ])
    .distinct()
    .where("old_membership.workspace_id", "=", input.workspaceId)
    .where("old_membership.generation_id", "=", input.coherentGenerationId)
    .where("target_membership.generation_id", "=", input.targetGenerationId)
    .where("old_topic.lifecycle", "=", "mature")
    .where("target_topic.lifecycle", "=", "mature")
    .execute() as IdentityOverlapRow[];
  if (overlaps.length === 0) return;

  const oldToTarget = groupIdentityEdges(overlaps, "old_topic_id", "target_topic_id");
  const targetToOld = groupIdentityEdges(overlaps, "target_topic_id", "old_topic_id");
  const stableTargetToOld = new Map<string, string>();
  const oldToCanonicalTarget = new Map<string, string>();
  for (const [targetTopicId, oldTopicIds] of targetToOld) {
    if (oldTopicIds.size !== 1) continue;
    const oldTopicId = [...oldTopicIds][0]!;
    if (oldToTarget.get(oldTopicId)?.size !== 1) continue;
    if (targetTopicId !== oldTopicId && targetIds.has(oldTopicId)) continue;
    stableTargetToOld.set(targetTopicId, oldTopicId);
    oldToCanonicalTarget.set(oldTopicId, oldTopicId);
  }
  for (const [targetTopicId, oldTopicIds] of targetToOld) {
    if (oldTopicIds.size < 2) continue;
    for (const oldTopicId of oldTopicIds) {
      if (oldToTarget.get(oldTopicId)?.size === 1) {
        oldToCanonicalTarget.set(oldTopicId, targetTopicId);
      }
    }
  }

  for (const [targetTopicId, oldTopicId] of [...stableTargetToOld].sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (targetTopicId === oldTopicId) continue;
    const target = targetTopics.find((topic) => topic.id === targetTopicId);
    if (!target || target.lifecycle !== "mature" || target.centroid === null) continue;
    await renameTargetTopic(trx, {
      workspaceId: input.workspaceId,
      generationId: input.targetGenerationId,
      target,
      publicTopicId: oldTopicId,
    });
  }

  for (const [oldTopicId, targetTopicId] of oldToCanonicalTarget) {
    oldToCanonicalTarget.set(oldTopicId, stableTargetToOld.get(targetTopicId) ?? targetTopicId);
  }
  const aliasCandidates = new Map<string, { canonicalTopicId: string; expiresAt: Date }>();
  const reprojectionRedirectExpiresAt = new Date(input.promotedAt.getTime() + REDIRECT_RETENTION_MS);
  for (const [oldTopicId, canonicalTopicId] of oldToCanonicalTarget) {
    if (oldTopicId === canonicalTopicId) continue;
    aliasCandidates.set(oldTopicId, {
      canonicalTopicId,
      expiresAt: reprojectionRedirectExpiresAt,
    });
  }

  const oldById = new Map(oldTopics.map((topic) => [topic.id, topic]));
  for (const alias of oldTopics.filter((topic) => topic.lifecycle === "merged")) {
    if (!alias.redirect_expires_at || alias.redirect_expires_at <= input.promotedAt) continue;
    const oldCanonicalTopicId = resolveOldCanonicalTopic(alias.id, oldById, input.promotedAt);
    if (!oldCanonicalTopicId) continue;
    const canonicalTopicId = oldToCanonicalTarget.get(oldCanonicalTopicId);
    if (!canonicalTopicId || alias.id === canonicalTopicId) continue;
    aliasCandidates.set(alias.id, {
      canonicalTopicId,
      expiresAt: alias.redirect_expires_at,
    });
  }

  const currentTargetTopics = await trx
    .selectFrom("content_plan_topics")
    .select(identityTopicColumns)
    .where("workspace_id", "=", input.workspaceId)
    .where("generation_id", "=", input.targetGenerationId)
    .execute() as IdentityTopicRow[];
  const currentById = new Map(currentTargetTopics.map((topic) => [topic.id, topic]));
  let insertedAliasCount = 0;
  for (const [aliasTopicId, alias] of [...aliasCandidates].sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (currentById.has(aliasTopicId) || aliasTopicId === alias.canonicalTopicId) continue;
    const canonical = currentById.get(alias.canonicalTopicId);
    if (!canonical || canonical.lifecycle !== "mature" || canonical.centroid === null) continue;
    await trx
      .insertInto("content_plan_topics")
      .values({
        workspace_id: input.workspaceId,
        generation_id: input.targetGenerationId,
        id: aliasTopicId,
        embedding_space_id: canonical.embedding_space_id,
        lifecycle: "merged",
        centroid: null,
        dimensions: canonical.dimensions,
        centroid_weight: 0,
        representative_observation_ids: [],
        revision: 1,
        merged_into_topic_id: alias.canonicalTopicId,
        redirect_expires_at: alias.expiresAt,
        enrichment_dirty_at: null,
        created_at: input.promotedAt,
        updated_at: input.promotedAt,
      })
      .execute();
    currentById.set(aliasTopicId, {
      ...canonical,
      id: aliasTopicId,
      lifecycle: "merged",
      centroid: null,
      centroid_weight: 0,
      representative_observation_ids: [],
      revision: 1,
      merged_into_topic_id: alias.canonicalTopicId,
      redirect_expires_at: alias.expiresAt,
      enrichment_dirty_at: null,
      created_at: input.promotedAt,
      updated_at: input.promotedAt,
    });
    insertedAliasCount += 1;
  }

  if (stableTargetToOld.size > 0 || insertedAliasCount > 0) {
    await trx
      .deleteFrom("content_plan_enrichment_repair_cursors")
      .where("workspace_id", "=", input.workspaceId)
      .where("generation_id", "=", input.targetGenerationId)
      .execute();
    await trx
      .updateTable("content_plan_corpus_invalidations")
      .set({
        after_generation_id: null,
        after_topic_id: null,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", input.workspaceId)
      .execute();
  }
};

const groupIdentityEdges = <
  Source extends keyof IdentityOverlapRow,
  Target extends keyof IdentityOverlapRow,
>(
  overlaps: readonly IdentityOverlapRow[],
  source: Source,
  target: Target,
): Map<string, Set<string>> => {
  const grouped = new Map<string, Set<string>>();
  for (const overlap of overlaps) {
    const sourceId = overlap[source];
    const values = grouped.get(sourceId) ?? new Set<string>();
    values.add(overlap[target]);
    grouped.set(sourceId, values);
  }
  return grouped;
};

const renameTargetTopic = async (trx: Db, input: {
  workspaceId: string;
  generationId: string;
  target: IdentityTopicRow;
  publicTopicId: string;
}): Promise<void> => {
  await trx
    .insertInto("content_plan_topics")
    .values({
      workspace_id: input.workspaceId,
      generation_id: input.generationId,
      id: input.publicTopicId,
      embedding_space_id: input.target.embedding_space_id,
      lifecycle: input.target.lifecycle,
      centroid: input.target.centroid,
      dimensions: input.target.dimensions,
      centroid_weight: input.target.centroid_weight,
      representative_observation_ids: input.target.representative_observation_ids,
      revision: input.target.revision,
      merged_into_topic_id: input.target.merged_into_topic_id,
      redirect_expires_at: input.target.redirect_expires_at,
      enrichment_dirty_at: input.target.enrichment_dirty_at,
      created_at: input.target.created_at,
      updated_at: input.target.updated_at,
    })
    .execute();
  await trx
    .updateTable("content_plan_topic_memberships")
    .set({ topic_id: input.publicTopicId })
    .where("workspace_id", "=", input.workspaceId)
    .where("generation_id", "=", input.generationId)
    .where("topic_id", "=", input.target.id)
    .execute();
  await trx
    .updateTable("content_plan_topics")
    .set({ merged_into_topic_id: input.publicTopicId })
    .where("workspace_id", "=", input.workspaceId)
    .where("generation_id", "=", input.generationId)
    .where("merged_into_topic_id", "=", input.target.id)
    .execute();
  await trx
    .updateTable("content_plan_topic_enrichments")
    .set({ topic_id: input.publicTopicId })
    .where("workspace_id", "=", input.workspaceId)
    .where("generation_id", "=", input.generationId)
    .where("topic_id", "=", input.target.id)
    .execute();
  await trx
    .updateTable("content_plan_topic_documents")
    .set({ topic_id: input.publicTopicId })
    .where("workspace_id", "=", input.workspaceId)
    .where("generation_id", "=", input.generationId)
    .where("topic_id", "=", input.target.id)
    .execute();
  await trx
    .deleteFrom("content_plan_topics")
    .where("workspace_id", "=", input.workspaceId)
    .where("generation_id", "=", input.generationId)
    .where("id", "=", input.target.id)
    .execute();
};

const resolveOldCanonicalTopic = (
  startTopicId: string,
  topics: ReadonlyMap<string, IdentityTopicRow>,
  asOf: Date,
): string | null => {
  const visited = new Set<string>();
  let currentTopicId = startTopicId;
  for (let hops = 0; hops <= MAX_IDENTITY_REDIRECT_HOPS; hops += 1) {
    if (visited.has(currentTopicId)) return null;
    visited.add(currentTopicId);
    const topic = topics.get(currentTopicId);
    if (!topic) return null;
    if (topic.lifecycle === "mature") return topic.id;
    if (
      topic.lifecycle !== "merged"
      || !topic.merged_into_topic_id
      || !topic.redirect_expires_at
      || topic.redirect_expires_at <= asOf
    ) return null;
    currentTopicId = topic.merged_into_topic_id;
  }
  return null;
};
