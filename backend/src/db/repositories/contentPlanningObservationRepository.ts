import { randomUUID } from "node:crypto";

import type { ConversationInteractionRole } from "@radioso/conversation-contract";

import type {
  ContentPlanFinalizePendingContextInput,
  ContentPlanObservationIntakePort,
  ContentPlanObservationRecord,
  ContentPlanObservationRetentionPort,
  ContentPlanObservationSourcePort,
  ContentPlanObservationSourceRecord,
  ContentPlanObservationVectorRecord,
  ContentPlanObservationWorkPort,
  ContentPlanTurnContribution,
  ContentPlanTurnRegistration,
  ContentPlanTurnRegistrationResult,
} from "../../modules/contentPlanning/contracts/persistence.js";
import {
  MAX_CONTENT_PLAN_CLAIM_BATCH,
  MAX_CONTENT_PLAN_SOURCE_HYDRATION,
  MAX_CONTENT_PLAN_TURN_CONTRIBUTIONS,
} from "../../modules/contentPlanning/contracts/persistence.js";
import type { GroundingDiagnosticSnapshot } from "../../shared/domain/groundingDiagnostic.js";
import {
  createClaimLease,
  currentTimestamp,
  jsonbKeyText,
  toPgVector,
} from "../../shared/infra/kysely/sqlHelpers.js";
import type { JsonValue } from "../../shared/infra/kysely/schema.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface ObservationRow {
  id: string;
  workspace_id: string;
  source_user_message_id: string;
  source_assistant_message_id: string;
  conversation_id: string;
  semantic_intent_id: string;
  semantic_text_hash: string | null;
  interaction_role: string;
  grounding_verdict: string | null;
  grounding_claim_count: number | null;
  grounding_sourced_claim_count: number | null;
  grounding_unsourced_claim_count: number | null;
  grounding_invalid_source_count: number | null;
  resolution_deadline: Date | null;
  observation_state: string;
  excluded_reason: string | null;
  observed_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface ObservationVectorRow {
  workspace_id: string;
  observation_id: string;
  generation_id: string;
  embedding_space_id: string;
  dimensions: number | null;
  embedding: string | null;
  vector_source: string | null;
  state: string;
  attempt_count: number;
  available_at: Date;
  claim_token: string | null;
  claimed_at: Date | null;
  claim_expires_at: Date | null;
  failure_stage: string | null;
  failure_reason: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface GroundingRow {
  grounding_verdict: string | null;
  grounding_claim_count: number | null;
  grounding_sourced_claim_count: number | null;
  grounding_unsourced_claim_count: number | null;
  grounding_invalid_source_count: number | null;
}

interface AssistantSourceRow extends GroundingRow {
  created_at: Date;
}

const observationColumns = [
  "id",
  "workspace_id",
  "source_user_message_id",
  "source_assistant_message_id",
  "conversation_id",
  "semantic_intent_id",
  "semantic_text_hash",
  "interaction_role",
  "grounding_verdict",
  "grounding_claim_count",
  "grounding_sourced_claim_count",
  "grounding_unsourced_claim_count",
  "grounding_invalid_source_count",
  "resolution_deadline",
  "observation_state",
  "excluded_reason",
  "observed_at",
  "created_at",
  "updated_at",
] as const;

const observationVectorColumns = [
  "workspace_id",
  "observation_id",
  "generation_id",
  "embedding_space_id",
  "dimensions",
  "embedding",
  "vector_source",
  "state",
  "attempt_count",
  "available_at",
  "claim_token",
  "claimed_at",
  "claim_expires_at",
  "failure_stage",
  "failure_reason",
  "completed_at",
  "created_at",
  "updated_at",
] as const;

const mapGrounding = (row: GroundingRow): GroundingDiagnosticSnapshot | null =>
  row.grounding_verdict === null
    ? null
    : {
        verdict: row.grounding_verdict as GroundingDiagnosticSnapshot["verdict"],
        claimCount: row.grounding_claim_count!,
        sourcedClaimCount: row.grounding_sourced_claim_count!,
        unsourcedClaimCount: row.grounding_unsourced_claim_count!,
        invalidSourceCount: row.grounding_invalid_source_count!,
      };

const mapObservation = (row: ObservationRow): ContentPlanObservationRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  sourceUserMessageId: row.source_user_message_id,
  sourceAssistantMessageId: row.source_assistant_message_id,
  conversationId: row.conversation_id,
  semanticIntentId: row.semantic_intent_id,
  semanticTextHash: row.semantic_text_hash,
  interactionRole: row.interaction_role as ConversationInteractionRole,
  grounding: mapGrounding(row),
  resolutionDeadline: row.resolution_deadline ? new Date(row.resolution_deadline) : null,
  observationState: row.observation_state as ContentPlanObservationRecord["observationState"],
  excludedReason: row.excluded_reason,
  observedAt: new Date(row.observed_at),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const parsePgVector = (value: string | null): number[] | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error("Stored content planning vector has an invalid representation");
  }
  const body = trimmed.slice(1, -1);
  if (body.length === 0) return [];
  const vector = body.split(",").map(Number);
  if (vector.some((dimension) => !Number.isFinite(dimension))) {
    throw new Error("Stored content planning vector has a non-finite dimension");
  }
  return vector;
};

const mapObservationVector = (row: ObservationVectorRow): ContentPlanObservationVectorRecord => ({
  workspaceId: row.workspace_id,
  observationId: row.observation_id,
  generationId: row.generation_id,
  embeddingSpaceId: row.embedding_space_id,
  dimensions: row.dimensions,
  embedding: parsePgVector(row.embedding),
  vectorSource: row.vector_source as ContentPlanObservationVectorRecord["vectorSource"],
  state: row.state as ContentPlanObservationVectorRecord["state"],
  attemptCount: row.attempt_count,
  availableAt: new Date(row.available_at),
  claimToken: row.claim_token,
  claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
  claimExpiresAt: row.claim_expires_at ? new Date(row.claim_expires_at) : null,
  failureStage: row.failure_stage,
  failureReason: row.failure_reason,
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const asObject = (value: JsonValue | null): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const dedupeContributions = (
  contributions: readonly ContentPlanTurnContribution[],
): ContentPlanTurnContribution[] => {
  const seen = new Set<string>();
  const unique: ContentPlanTurnContribution[] = [];
  for (const contribution of contributions) {
    if (!seen.has(contribution.semanticIntentId)) {
      seen.add(contribution.semanticIntentId);
      unique.push(contribution);
    }
  }
  return unique;
};

const assertVectorWork = (contribution: ContentPlanTurnContribution): void => {
  if (contribution.observationState !== "ready") return;
  const vector = contribution.vectorWork.embedding;
  if (vector === undefined) {
    if (contribution.vectorWork.dimensions !== undefined || contribution.vectorWork.vectorSource !== undefined) {
      throw new Error("Missing content planning vectors cannot declare dimensions or a vector source");
    }
    return;
  }
  if (
    contribution.vectorWork.dimensions !== vector.length
    || contribution.vectorWork.vectorSource === undefined
  ) {
    throw new Error("Reusable content planning vectors require matching dimensions and a source");
  }
};

export class ContentPlanObservationRepository
implements ContentPlanObservationIntakePort,
  ContentPlanObservationWorkPort,
  ContentPlanObservationSourcePort,
  ContentPlanObservationRetentionPort {
  constructor(private readonly db: Db) {}

  async registerTurn(
    input: ContentPlanTurnRegistration,
    dbOverride?: Db,
  ): Promise<ContentPlanTurnRegistrationResult> {
    const unique = dedupeContributions(input.contributions);
    const selected = unique.slice(0, MAX_CONTENT_PLAN_TURN_CONTRIBUTIONS);
    selected.forEach(assertVectorWork);
    const run = (db: Db) => this.registerTurnInTransaction(db, input, selected, unique.length - selected.length);
    if (dbOverride) return run(dbOverride);
    return this.db.isTransaction ? run(this.db) : this.db.transaction().execute(run);
  }

  private async registerTurnInTransaction(
    db: Db,
    input: ContentPlanTurnRegistration,
    contributions: readonly ContentPlanTurnContribution[],
    truncatedCount: number,
  ): Promise<ContentPlanTurnRegistrationResult> {
    const userMessage = await db
      .selectFrom("messages")
      .select("id")
      .where("id", "=", input.sourceUserMessageId)
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("role", "=", "user")
      .executeTakeFirst();
    if (!userMessage) {
      throw new Error("Content planning source user message is unavailable");
    }
    const assistantMessage = await db
      .selectFrom("messages")
      .select([
        "created_at",
        "grounding_verdict",
        "grounding_claim_count",
        "grounding_sourced_claim_count",
        "grounding_unsourced_claim_count",
        "grounding_invalid_source_count",
      ])
      .where("id", "=", input.sourceAssistantMessageId)
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("role", "=", "assistant")
      .executeTakeFirst();
    if (!assistantMessage) {
      throw new Error("Content planning source assistant message is unavailable");
    }

    const grounding = mapGrounding(assistantMessage as AssistantSourceRow);
    const records: ContentPlanObservationRecord[] = [];
    let acceptedCount = 0;
    for (const contribution of contributions) {
      const id = randomUUID();
      const inserted = await db
        .insertInto("content_plan_observations")
        .values({
          id,
          workspace_id: input.workspaceId,
          source_user_message_id: input.sourceUserMessageId,
          source_assistant_message_id: input.sourceAssistantMessageId,
          conversation_id: input.conversationId,
          semantic_intent_id: contribution.semanticIntentId,
          semantic_text_hash: contribution.semanticTextHash,
          interaction_role: input.interactionRole,
          grounding_verdict: grounding?.verdict ?? null,
          grounding_claim_count: grounding?.claimCount ?? null,
          grounding_sourced_claim_count: grounding?.sourcedClaimCount ?? null,
          grounding_unsourced_claim_count: grounding?.unsourcedClaimCount ?? null,
          grounding_invalid_source_count: grounding?.invalidSourceCount ?? null,
          resolution_deadline: contribution.observationState === "pending_context"
            ? contribution.resolutionDeadline
            : null,
          observation_state: contribution.observationState,
          excluded_reason: contribution.observationState === "excluded"
            ? contribution.excludedReason
            : null,
          observed_at: assistantMessage.created_at,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["workspace_id", "source_user_message_id", "semantic_intent_id"])
            .doNothing())
        .returning(observationColumns)
        .executeTakeFirst();
      const row = inserted ?? await db
        .selectFrom("content_plan_observations")
        .select(observationColumns)
        .where("workspace_id", "=", input.workspaceId)
        .where("source_user_message_id", "=", input.sourceUserMessageId)
        .where("semantic_intent_id", "=", contribution.semanticIntentId)
        .executeTakeFirstOrThrow();
      if (inserted) acceptedCount += 1;
      records.push(mapObservation(row as ObservationRow));
      if (contribution.observationState === "ready") {
        await this.upsertVectorWork(db, row.id, input.workspaceId, contribution.vectorWork);
      }
    }

    return {
      observations: records,
      acceptedCount,
      duplicateCount: contributions.length - acceptedCount,
      truncatedCount,
    };
  }

  private async upsertVectorWork(
    db: Db,
    observationId: string,
    workspaceId: string,
    vectorWork: Extract<ContentPlanTurnContribution, { observationState: "ready" }>["vectorWork"],
  ): Promise<void> {
    const embedding = vectorWork.embedding;
    await db
      .insertInto("content_plan_observation_vectors")
      .values({
        workspace_id: workspaceId,
        observation_id: observationId,
        generation_id: vectorWork.generationId,
        embedding_space_id: vectorWork.embeddingSpaceId,
        dimensions: embedding ? vectorWork.dimensions! : null,
        embedding: embedding ? toPgVector(embedding) : null,
        vector_source: embedding ? vectorWork.vectorSource! : null,
        state: embedding ? "ready" : "pending_embedding",
      })
      .onConflict((conflict) =>
        conflict.columns(["workspace_id", "observation_id", "generation_id"]).doNothing())
      .execute();

    if (embedding) {
      await db
        .updateTable("content_plan_observation_vectors")
        .set({
          dimensions: vectorWork.dimensions!,
          embedding: toPgVector(embedding),
          vector_source: vectorWork.vectorSource!,
          state: "ready",
          failure_stage: null,
          failure_reason: null,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", workspaceId)
        .where("observation_id", "=", observationId)
        .where("generation_id", "=", vectorWork.generationId)
        .where("embedding", "is", null)
        .execute();
    }
  }

  async findPendingContext(input: {
    workspaceId: string;
    conversationId: string;
    sourceUserMessageId?: string;
    asOf: Date;
  }): Promise<ContentPlanObservationRecord | null> {
    if (!Number.isFinite(input.asOf.getTime())) {
      throw new Error("Content planning pending-context lookup time must be valid");
    }
    let query = this.db
      .selectFrom("content_plan_observations")
      .select(observationColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("observation_state", "=", "pending_context")
      .where("resolution_deadline", ">", input.asOf);
    if (input.sourceUserMessageId) {
      query = query.where("source_user_message_id", "=", input.sourceUserMessageId);
    }
    const row = await query.orderBy("observed_at", "desc").orderBy("id", "desc").executeTakeFirst();
    return row ? mapObservation(row as ObservationRow) : null;
  }

  async finalizePendingContext(
    input: ContentPlanFinalizePendingContextInput,
    dbOverride?: Db,
  ): Promise<ContentPlanObservationRecord | null> {
    if (!Number.isFinite(input.resolvedAt.getTime())) {
      throw new Error("Content planning pending-context resolution time must be valid");
    }
    const run = async (db: Db): Promise<ContentPlanObservationRecord | null> => {
      const assistantMessage = await db
        .selectFrom("messages")
        .select([
          "created_at",
          "grounding_verdict",
          "grounding_claim_count",
          "grounding_sourced_claim_count",
          "grounding_unsourced_claim_count",
          "grounding_invalid_source_count",
        ])
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "=", input.sourceAssistantMessageId)
        .where("role", "=", "assistant")
        .executeTakeFirst();
      if (!assistantMessage) return null;
      const grounding = mapGrounding(assistantMessage as AssistantSourceRow);
      const row = await db
        .updateTable("content_plan_observations")
        .set({
          source_assistant_message_id: input.sourceAssistantMessageId,
          semantic_intent_id: input.semanticIntentId,
          semantic_text_hash: input.semanticTextHash,
          interaction_role: input.interactionRole,
          grounding_verdict: grounding?.verdict ?? null,
          grounding_claim_count: grounding?.claimCount ?? null,
          grounding_sourced_claim_count: grounding?.sourcedClaimCount ?? null,
          grounding_unsourced_claim_count: grounding?.unsourcedClaimCount ?? null,
          grounding_invalid_source_count: grounding?.invalidSourceCount ?? null,
          resolution_deadline: null,
          observation_state: "ready",
          excluded_reason: null,
          observed_at: assistantMessage.created_at,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "=", input.observationId)
        .where("observation_state", "=", "pending_context")
        .where("resolution_deadline", ">", input.resolvedAt)
        .returning(observationColumns)
        .executeTakeFirst();
      if (!row) return null;
      assertVectorWork({
        semanticIntentId: input.semanticIntentId,
        semanticTextHash: input.semanticTextHash,
        observationState: "ready",
        vectorWork: input.vectorWork,
      });
      await this.upsertVectorWork(db, row.id, input.workspaceId, input.vectorWork);
      return mapObservation(row as ObservationRow);
    };
    if (dbOverride) return run(dbOverride);
    return this.db.isTransaction ? run(this.db) : this.db.transaction().execute(run);
  }

  async excludePendingContext(input: {
    workspaceId: string;
    observationId: string;
    excludedReason: string;
    sourceAssistantMessageId?: string;
  }, db: Db = this.db): Promise<ContentPlanObservationRecord | null> {
    const row = await db
      .updateTable("content_plan_observations")
      .set({
        ...(input.sourceAssistantMessageId
          ? { source_assistant_message_id: input.sourceAssistantMessageId }
          : {}),
        observation_state: "excluded",
        excluded_reason: input.excludedReason,
        resolution_deadline: null,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", input.workspaceId)
      .where("id", "=", input.observationId)
      .where("observation_state", "=", "pending_context")
      .returning(observationColumns)
      .executeTakeFirst();
    return row ? mapObservation(row as ObservationRow) : null;
  }

  async claimVectorBatch(input: {
    workspaceId?: string;
    generationId?: string;
    limit: number;
    now: Date;
    leaseMs: number;
  }): Promise<ContentPlanObservationVectorRecord[]> {
    const lease = createClaimLease({ ...input, maxLimit: MAX_CONTENT_PLAN_CLAIM_BATCH });
    return this.db.transaction().execute(async (trx) => {
      let query = trx
        .selectFrom("content_plan_observation_vectors")
        .select(observationVectorColumns)
        .where((eb) => eb.or([
          eb.and([
            eb("state", "in", ["pending_embedding", "ready", "retryable"]),
            eb("available_at", "<=", input.now),
          ]),
          eb.and([
            eb("state", "=", "processing"),
            eb("claim_expires_at", "<=", input.now),
          ]),
        ]));
      if (input.workspaceId) query = query.where("workspace_id", "=", input.workspaceId);
      if (input.generationId) query = query.where("generation_id", "=", input.generationId);
      const selected = await query
        .orderBy("available_at", "asc")
        .orderBy("observation_id", "asc")
        .forUpdate()
        .skipLocked()
        .limit(input.limit)
        .execute();
      if (selected.length === 0) return [];

      const rows = await trx
        .updateTable("content_plan_observation_vectors")
        .set((eb) => ({
          state: "processing",
          attempt_count: eb("attempt_count", "+", 1),
          claim_token: lease.token,
          claimed_at: input.now,
          claim_expires_at: lease.expiresAt,
          failure_stage: null,
          failure_reason: null,
          updated_at: input.now,
        }))
        .where((eb) => eb.or(selected.map((row) => eb.and([
          eb("workspace_id", "=", row.workspace_id),
          eb("observation_id", "=", row.observation_id),
          eb("generation_id", "=", row.generation_id),
        ]))))
        .returning(observationVectorColumns)
        .execute();
      const order = new Map(selected.map((row, index) => [
        `${row.workspace_id}:${row.observation_id}:${row.generation_id}`,
        index,
      ]));
      return rows
        .sort((left, right) =>
          order.get(`${left.workspace_id}:${left.observation_id}:${left.generation_id}`)!
          - order.get(`${right.workspace_id}:${right.observation_id}:${right.generation_id}`)!)
        .map((row) => mapObservationVector(row as ObservationVectorRow));
    });
  }

  async storeClaimedEmbedding(input: {
    workspaceId: string;
    observationId: string;
    generationId: string;
    claimToken: string;
    dimensions: number;
    embedding: readonly number[];
    vectorSource: "reused" | "fallback";
  }): Promise<boolean> {
    if (input.embedding.length !== input.dimensions) {
      throw new Error("Content planning embedding dimensions do not match the vector");
    }
    const result = await this.db
      .updateTable("content_plan_observation_vectors")
      .set({
        dimensions: input.dimensions,
        embedding: toPgVector(input.embedding),
        vector_source: input.vectorSource,
        state: "ready",
        claim_token: null,
        claimed_at: null,
        claim_expires_at: null,
        failure_stage: null,
        failure_reason: null,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", input.workspaceId)
      .where("observation_id", "=", input.observationId)
      .where("generation_id", "=", input.generationId)
      .where("state", "=", "processing")
      .where("claim_token", "=", input.claimToken)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async failVectorClaim(input: {
    workspaceId: string;
    observationId: string;
    generationId: string;
    claimToken: string;
    terminal: boolean;
    failureStage: string;
    failureReason: string;
    availableAt: Date;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("content_plan_observation_vectors")
      .set({
        state: input.terminal ? "failed" : "retryable",
        available_at: input.availableAt,
        claim_token: null,
        claimed_at: null,
        claim_expires_at: null,
        failure_stage: input.failureStage,
        failure_reason: input.failureReason,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", input.workspaceId)
      .where("observation_id", "=", input.observationId)
      .where("generation_id", "=", input.generationId)
      .where("state", "=", "processing")
      .where("claim_token", "=", input.claimToken)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async loadSources(input: {
    workspaceId: string;
    observationIds: readonly string[];
    limit: number;
  }): Promise<ContentPlanObservationSourceRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_CONTENT_PLAN_SOURCE_HYDRATION) {
      throw new Error(`Content planning source limit must be between 1 and ${MAX_CONTENT_PLAN_SOURCE_HYDRATION}`);
    }
    const ids = [...new Set(input.observationIds)].slice(0, input.limit);
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom("content_plan_observations as observation")
      .innerJoin("messages as source_user", (join) =>
        join
          .onRef("source_user.workspace_id", "=", "observation.workspace_id")
          .onRef("source_user.id", "=", "observation.source_user_message_id"))
      .innerJoin("messages as source_assistant", (join) =>
        join
          .onRef("source_assistant.workspace_id", "=", "observation.workspace_id")
          .onRef("source_assistant.id", "=", "observation.source_assistant_message_id"))
      .select([
        "observation.id as observation_id",
        "observation.conversation_id",
        "observation.semantic_intent_id",
        "observation.semantic_text_hash",
        "observation.source_user_message_id",
        "observation.source_assistant_message_id",
        "observation.observed_at",
        "observation.grounding_verdict",
        "observation.grounding_claim_count",
        "observation.grounding_sourced_claim_count",
        "observation.grounding_unsourced_claim_count",
        "observation.grounding_invalid_source_count",
        "source_user.content as source_user_content",
        "source_user.metadata_json as source_user_metadata",
        "source_assistant.metadata_json as source_assistant_metadata",
      ])
      .where("observation.workspace_id", "=", input.workspaceId)
      .where("observation.id", "in", ids)
      .execute();
    const assistantIds = rows.map((row) => row.source_assistant_message_id);
    const auditRows = assistantIds.length === 0
      ? []
      : await this.db
          .selectFrom("audit_events")
          .select(["id", "metadata_json", "created_at"])
          .where("workspace_id", "=", input.workspaceId)
          .where("event_type", "in", ["chat.answer", "chat.suspended"])
          .where((eb) => jsonbKeyText(eb.ref("metadata_json"), "assistantMessageId"), "in", assistantIds)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .execute();
    const auditsByAssistant = new Map<string, Record<string, unknown> | null>();
    for (const audit of auditRows) {
      const metadata = asObject(audit.metadata_json);
      const assistantMessageId = metadata?.assistantMessageId;
      if (typeof assistantMessageId === "string" && !auditsByAssistant.has(assistantMessageId)) {
        auditsByAssistant.set(assistantMessageId, metadata);
      }
    }
    const byId = new Map(rows.map((row) => [row.observation_id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const grounding = mapGrounding(row);
      return [{
        observationId: row.observation_id,
        conversationId: row.conversation_id,
        semanticIntentId: row.semantic_intent_id,
        semanticTextHash: row.semantic_text_hash,
        sourceUserMessageId: row.source_user_message_id,
        sourceAssistantMessageId: row.source_assistant_message_id,
        sourceUserContent: row.source_user_content,
        sourceUserMetadata: asObject(row.source_user_metadata),
        sourceAssistantMetadata: asObject(row.source_assistant_metadata),
        auditMetadata: auditsByAssistant.get(row.source_assistant_message_id) ?? null,
        observedAt: new Date(row.observed_at),
        grounding,
      }];
    });
  }

  async expirePendingContexts(input: {
    workspaceId: string;
    now: Date;
    limit: number;
  }): Promise<number> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_CONTENT_PLAN_CLAIM_BATCH) {
      throw new Error(`Content planning pending-context expiry limit must be between 1 and ${MAX_CONTENT_PLAN_CLAIM_BATCH}`);
    }
    if (!Number.isFinite(input.now.getTime())) {
      throw new Error("Content planning pending-context expiry time must be valid");
    }
    return this.db.transaction().execute(async (trx) => {
      const selected = await trx
        .selectFrom("content_plan_observations")
        .select("id")
        .where("workspace_id", "=", input.workspaceId)
        .where("observation_state", "=", "pending_context")
        .where("resolution_deadline", "<=", input.now)
        .orderBy("resolution_deadline", "asc")
        .orderBy("id", "asc")
        .forUpdate()
        .skipLocked()
        .limit(input.limit)
        .execute();
      const ids = selected.map((row) => row.id);
      if (ids.length === 0) return 0;
      const expired = await trx
        .updateTable("content_plan_observations")
        .set({
          observation_state: "excluded",
          excluded_reason: "context_resolution_expired",
          resolution_deadline: null,
          updated_at: input.now,
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "in", ids)
        .where("observation_state", "=", "pending_context")
        .where("resolution_deadline", "<=", input.now)
        .returning("id")
        .execute();
      return expired.length;
    });
  }

  async pruneExpiredObservations(input: {
    workspaceId: string;
    observedBefore: Date;
    limit: number;
  }): Promise<{
    deletedCount: number;
    affectedTopics: Array<{ workspaceId: string; generationId: string; topicId: string }>;
  }> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_CONTENT_PLAN_CLAIM_BATCH) {
      throw new Error(`Content planning prune limit must be between 1 and ${MAX_CONTENT_PLAN_CLAIM_BATCH}`);
    }
    if (!Number.isFinite(input.observedBefore.getTime())) {
      throw new Error("Content planning prune boundary must be valid");
    }
    return this.db.transaction().execute(async (trx) => {
      const observations = await trx
        .selectFrom("content_plan_observations")
        .select("id")
        .where("workspace_id", "=", input.workspaceId)
        .where("observed_at", "<", input.observedBefore)
        .orderBy("observed_at", "asc")
        .orderBy("id", "asc")
        .forUpdate()
        .skipLocked()
        .limit(input.limit)
        .execute();
      const observationIds = observations.map((row) => row.id);
      if (observationIds.length === 0) return { deletedCount: 0, affectedTopics: [] };
      const affected = await trx
        .selectFrom("content_plan_topic_memberships")
        .select(["workspace_id", "generation_id", "topic_id"])
        .distinct()
        .where("workspace_id", "=", input.workspaceId)
        .where("observation_id", "in", observationIds)
        .execute();
      const deleted = await trx
        .deleteFrom("content_plan_observations")
        .where("workspace_id", "=", input.workspaceId)
        .where("id", "in", observationIds)
        .returning("id")
        .execute();
      return {
        deletedCount: deleted.length,
        affectedTopics: affected.map((row) => ({
          workspaceId: row.workspace_id,
          generationId: row.generation_id,
          topicId: row.topic_id,
        })),
      };
    });
  }
}
