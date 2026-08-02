import { CompiledQuery } from "kysely";

import type {
  ContentPlanNearestTopic,
  ContentPlanNewTopicInput,
  ContentPlanTopicAggregateUpdate,
  ContentPlanTopicAssignmentEvidence,
  ContentPlanTopicMembershipRecord,
  ContentPlanTopicRecord,
  ContentPlanTopicReconciliationEvidence,
  ContentPlanTopicRedirectResult,
  ContentPlanTopicRepositoryPort,
} from "../../modules/contentPlanning/contracts/persistence.js";
import {
  MAX_CONTENT_PLAN_REDIRECT_HOPS,
  MAX_CONTENT_PLAN_SOURCE_HYDRATION,
} from "../../modules/contentPlanning/contracts/persistence.js";
import {
  currentTimestamp,
  pgVectorAverage,
  pgVectorCosineDistance,
  toPgVector,
} from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface TopicRow {
  workspace_id: string;
  generation_id: string;
  id: string;
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

interface MembershipRow {
  workspace_id: string;
  generation_id: string;
  observation_id: string;
  topic_id: string;
  assignment_version: number;
  similarity: number;
  cohesion: number;
  assigned_at: Date;
}

const topicColumns = [
  "workspace_id",
  "generation_id",
  "id",
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

const membershipColumns = [
  "workspace_id",
  "generation_id",
  "observation_id",
  "topic_id",
  "assignment_version",
  "similarity",
  "cohesion",
  "assigned_at",
] as const;

const parsePgVector = (value: string): number[] => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error("Stored content planning centroid has an invalid representation");
  }
  const values = trimmed.slice(1, -1).split(",").map(Number);
  if (values.length === 0 || values.some((dimension) => !Number.isFinite(dimension))) {
    throw new Error("Stored content planning centroid has invalid dimensions");
  }
  return values;
};

const mapTopic = (row: TopicRow): ContentPlanTopicRecord => ({
  workspaceId: row.workspace_id,
  generationId: row.generation_id,
  id: row.id,
  embeddingSpaceId: row.embedding_space_id,
  lifecycle: row.lifecycle as ContentPlanTopicRecord["lifecycle"],
  centroid: row.centroid === null ? null : parsePgVector(row.centroid),
  dimensions: row.dimensions,
  centroidWeight: row.centroid_weight,
  representativeObservationIds: row.representative_observation_ids,
  revision: row.revision,
  mergedIntoTopicId: row.merged_into_topic_id,
  redirectExpiresAt: row.redirect_expires_at ? new Date(row.redirect_expires_at) : null,
  enrichmentDirtyAt: row.enrichment_dirty_at ? new Date(row.enrichment_dirty_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const mapMembership = (row: MembershipRow): ContentPlanTopicMembershipRecord => ({
  workspaceId: row.workspace_id,
  generationId: row.generation_id,
  observationId: row.observation_id,
  topicId: row.topic_id,
  assignmentVersion: row.assignment_version,
  similarity: row.similarity,
  cohesion: row.cohesion,
  assignedAt: new Date(row.assigned_at),
});

const validateTopicVector = (topic: ContentPlanNewTopicInput): void => {
  if (topic.centroid.length !== topic.dimensions) {
    throw new Error("Content planning topic dimensions do not match its centroid");
  }
  if (topic.representativeObservationIds.length > 8) {
    throw new Error("Content planning topics retain at most eight representative observations");
  }
};

const validateAggregateUpdate = (
  topic: ContentPlanTopicAggregateUpdate,
  expectedRevision: number,
  requireRevisionBump: boolean,
): void => {
  if (topic.lifecycle === "retired") {
    if (
      topic.centroid !== null
      || topic.centroidWeight !== 0
      || topic.representativeObservationIds.length !== 0
    ) {
      throw new Error("Retired content planning topics cannot retain customer-derived aggregate evidence");
    }
  } else if (topic.centroid === null || topic.centroid.length !== topic.dimensions) {
    throw new Error("Content planning topic dimensions do not match its centroid");
  }
  if (new Set(topic.representativeObservationIds).size !== topic.representativeObservationIds.length
    || topic.representativeObservationIds.length > 8) {
    throw new Error("Content planning topic representatives must be unique and bounded");
  }
  const allowedRevisions = requireRevisionBump
    ? topic.revision === expectedRevision + 1
    : topic.revision === expectedRevision || topic.revision === expectedRevision + 1;
  if (!allowedRevisions) {
    throw new Error(requireRevisionBump
      ? "Content planning topic revision must advance by one"
      : "Content planning topic revision must be current or advance by one");
  }
};

const storedAggregateCentroid = (
  topic: ContentPlanTopicAggregateUpdate,
): ReturnType<typeof toPgVector> | null =>
  topic.centroid === null ? null : toPgVector(topic.centroid);

export class ContentPlanTopicRepository implements ContentPlanTopicRepositoryPort {
  constructor(private readonly db: Db) {}

  async findNearestTopics(input: {
    workspaceId: string;
    generationId: string;
    embeddingSpaceId: string;
    dimensions: number;
    embedding: readonly number[];
    limit: number;
  }): Promise<ContentPlanNearestTopic[]> {
    if (input.embedding.length !== input.dimensions) {
      throw new Error("Content planning search dimensions do not match its vector");
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("Content planning nearest-topic limit must be between 1 and 100");
    }
    const rows = await this.db
      .selectFrom("content_plan_topics")
      .select(topicColumns)
      .select((eb) => pgVectorCosineDistance(eb.ref("centroid"), input.embedding).as("cosine_distance"))
      .where("workspace_id", "=", input.workspaceId)
      .where("generation_id", "=", input.generationId)
      .where("embedding_space_id", "=", input.embeddingSpaceId)
      .where("dimensions", "=", input.dimensions)
      .where("lifecycle", "in", ["provisional", "mature"])
      .orderBy((eb) => pgVectorCosineDistance(eb.ref("centroid"), input.embedding), "asc")
      .orderBy("id", "asc")
      .limit(input.limit)
      .execute();
    return rows.map((row) => {
      const topic = mapTopic(row as TopicRow);
      if (topic.centroid === null) {
        throw new Error("Active content planning topic is missing its centroid");
      }
      return {
        ...topic,
        centroid: topic.centroid,
        cosineSimilarity: 1 - Number(row.cosine_distance),
      };
    });
  }

  async loadAssignmentEvidence(input: {
    workspaceId: string;
    generationId: string;
    observationId: string;
    topicIds: readonly string[];
    limit: number;
  }): Promise<ContentPlanTopicAssignmentEvidence[]> {
    const evidence = await this.loadTopicEvidence(input);
    if (evidence.length === 0) return [];
    const incoming = await this.db
      .selectFrom("content_plan_observations")
      .select("conversation_id")
      .where("workspace_id", "=", input.workspaceId)
      .where("id", "=", input.observationId)
      .executeTakeFirst();
    if (!incoming) return [];
    const represented = await this.db
      .selectFrom("content_plan_topic_memberships as membership")
      .innerJoin("content_plan_observations as observation", (join) => join
        .onRef("observation.workspace_id", "=", "membership.workspace_id")
        .onRef("observation.id", "=", "membership.observation_id"))
      .select("membership.topic_id")
      .distinct()
      .where("membership.workspace_id", "=", input.workspaceId)
      .where("membership.generation_id", "=", input.generationId)
      .where("membership.topic_id", "in", evidence.map((item) => item.topicId))
      .where("observation.conversation_id", "=", incoming.conversation_id)
      .execute();
    const representedIds = new Set(represented.map((row) => row.topic_id));
    return evidence.map((item) => ({
      topicId: item.topicId,
      liveObservationCount: item.liveObservationCount,
      liveConversationCount: item.liveConversationCount,
      incomingConversationAlreadyPresent: representedIds.has(item.topicId),
      representativeVectors: item.representativeVectors,
    }));
  }

  async loadReconciliationEvidence(input: {
    workspaceId: string;
    generationId: string;
    topicIds: readonly string[];
    limit: number;
  }): Promise<ContentPlanTopicReconciliationEvidence[]> {
    const evidence = await this.loadTopicEvidence(input);
    return evidence.map((item) => ({
      topicId: item.topicId,
      liveCentroid: item.liveCentroid,
      liveObservationCount: item.liveObservationCount,
      liveConversationCount: item.liveConversationCount,
      representativeObservationIds: item.representativeVectors.map((vector) => vector.observationId),
    }));
  }

  async findTopicsNeedingReconciliation(input: {
    workspaceId: string;
    generationId?: string;
    limit: number;
  }): Promise<Array<{ workspaceId: string; generationId: string; topicId: string }>> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("Content planning reconciliation scan limit must be between 1 and 100");
    }
    let query = this.db
      .selectFrom("content_plan_topics as topic")
      .leftJoin("content_plan_topic_memberships as membership", (join) => join
        .onRef("membership.workspace_id", "=", "topic.workspace_id")
        .onRef("membership.generation_id", "=", "topic.generation_id")
        .onRef("membership.topic_id", "=", "topic.id"))
      .select(["topic.workspace_id", "topic.generation_id", "topic.id"])
      .where("topic.workspace_id", "=", input.workspaceId)
      .where("topic.lifecycle", "in", ["provisional", "mature"])
      .groupBy(["topic.workspace_id", "topic.generation_id", "topic.id", "topic.centroid_weight"])
      .having((eb) => eb(
        eb.fn.count<number>("membership.observation_id"),
        "!=",
        eb.ref("topic.centroid_weight"),
      ));
    if (input.generationId) query = query.where("topic.generation_id", "=", input.generationId);
    const rows = await query
      .orderBy("topic.generation_id", "asc")
      .orderBy("topic.id", "asc")
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      generationId: row.generation_id,
      topicId: row.id,
    }));
  }

  private async loadTopicEvidence(input: {
    workspaceId: string;
    generationId: string;
    topicIds: readonly string[];
    limit: number;
  }): Promise<Array<{
    topicId: string;
    liveCentroid: number[] | null;
    liveObservationCount: number;
    liveConversationCount: number;
    representativeVectors: Array<{ observationId: string; embedding: number[] }>;
  }>> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("Content planning topic evidence limit must be between 1 and 100");
    }
    const topicIds = [...new Set(input.topicIds)].slice(0, input.limit);
    if (topicIds.length === 0) return [];
    const topics = await this.db
      .selectFrom("content_plan_topics")
      .select("id")
      .where("workspace_id", "=", input.workspaceId)
      .where("generation_id", "=", input.generationId)
      .where("id", "in", topicIds)
      .where("lifecycle", "in", ["provisional", "mature"])
      .execute();
    const foundTopicIds = topics.map((topic) => topic.id);
    if (foundTopicIds.length === 0) return [];
    const representativeRows = (await this.db.executeQuery<{
      topic_id: string;
      observation_id: string;
      embedding: string;
    }>(CompiledQuery.raw(
      `SELECT topic_id, observation_id, embedding
       FROM (
         SELECT
           membership.topic_id,
           membership.observation_id,
           vector.embedding,
           ROW_NUMBER() OVER (
             PARTITION BY membership.topic_id
             ORDER BY
               CASE
                 WHEN membership.observation_id = ANY(topic.representative_observation_ids)
                   THEN 0
                 ELSE 1
               END,
               CASE
                 WHEN membership.observation_id = ANY(topic.representative_observation_ids)
                   THEN array_position(topic.representative_observation_ids, membership.observation_id)
                 ELSE NULL
               END,
               membership.cohesion DESC,
               membership.assigned_at ASC,
               membership.observation_id ASC
           ) AS representative_rank
         FROM content_plan_topic_memberships membership
         JOIN content_plan_observation_vectors vector
           ON vector.workspace_id = membership.workspace_id
          AND vector.generation_id = membership.generation_id
          AND vector.observation_id = membership.observation_id
         JOIN content_plan_topics topic
           ON topic.workspace_id = membership.workspace_id
          AND topic.generation_id = membership.generation_id
          AND topic.id = membership.topic_id
         WHERE membership.workspace_id = $1
           AND membership.generation_id = $2
           AND membership.topic_id = ANY($3::uuid[])
           AND vector.embedding IS NOT NULL
       ) ranked
       WHERE representative_rank <= $4
       ORDER BY topic_id, representative_rank`,
      [
        input.workspaceId,
        input.generationId,
        foundTopicIds,
        MAX_CONTENT_PLAN_SOURCE_HYDRATION,
      ],
    ))).rows;
    const aggregateRows = await this.db
      .selectFrom("content_plan_topic_memberships as membership")
      .innerJoin("content_plan_observation_vectors as vector", (join) => join
        .onRef("vector.workspace_id", "=", "membership.workspace_id")
        .onRef("vector.generation_id", "=", "membership.generation_id")
        .onRef("vector.observation_id", "=", "membership.observation_id"))
      .innerJoin("content_plan_observations as observation", (join) => join
        .onRef("observation.workspace_id", "=", "membership.workspace_id")
        .onRef("observation.id", "=", "membership.observation_id"))
      .select("membership.topic_id")
      .select((eb) => [
        eb.fn.count<string>("membership.observation_id").as("live_observation_count"),
        eb.fn.count<string>("observation.conversation_id").distinct().as("live_conversation_count"),
        pgVectorAverage(eb.ref("vector.embedding")).as("live_centroid"),
      ])
      .where("membership.workspace_id", "=", input.workspaceId)
      .where("membership.generation_id", "=", input.generationId)
      .where("membership.topic_id", "in", foundTopicIds)
      .where("vector.embedding", "is not", null)
      .groupBy("membership.topic_id")
      .execute();
    const aggregateByTopic = new Map(aggregateRows.map((row) => [row.topic_id, row]));
    const representativesByTopic = new Map<string, Map<string, number[]>>();
    for (const row of representativeRows) {
      if (!row.embedding) continue;
      const vectors = representativesByTopic.get(row.topic_id) ?? new Map<string, number[]>();
      vectors.set(row.observation_id, parsePgVector(row.embedding));
      representativesByTopic.set(row.topic_id, vectors);
    }
    const byId = new Map(topics.map((topic) => [topic.id, topic]));
    return topicIds.flatMap((topicId) => {
      const topic = byId.get(topicId);
      if (!topic) return [];
      const aggregate = aggregateByTopic.get(topicId);
      const vectors = representativesByTopic.get(topicId) ?? new Map<string, number[]>();
      return [{
        topicId,
        liveCentroid: aggregate?.live_centroid ? parsePgVector(aggregate.live_centroid) : null,
        liveObservationCount: Number(aggregate?.live_observation_count ?? 0),
        liveConversationCount: Number(aggregate?.live_conversation_count ?? 0),
        representativeVectors: [...vectors].map(([observationId, embedding]) => ({
          observationId,
          embedding,
        })),
      }];
    });
  }

  async createTopicAndAssign(input: {
    workspaceId: string;
    generationId: string;
    observationId: string;
    claimToken: string;
    topic: ContentPlanNewTopicInput;
    assignmentVersion: number;
    similarity: number;
    cohesion: number;
    assignedAt: Date;
  }): Promise<{
    applied: boolean;
    topic: ContentPlanTopicRecord | null;
    membership: ContentPlanTopicMembershipRecord | null;
  }> {
    validateTopicVector(input.topic);
    return this.db.transaction().execute(async (trx) => {
      const vector = await trx
        .selectFrom("content_plan_observation_vectors")
        .select(["state", "claim_token", "embedding_space_id", "dimensions"])
        .where("workspace_id", "=", input.workspaceId)
        .where("observation_id", "=", input.observationId)
        .where("generation_id", "=", input.generationId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !vector
        || vector.state !== "processing"
        || vector.claim_token !== input.claimToken
        || vector.embedding_space_id !== input.topic.embeddingSpaceId
        || vector.dimensions !== input.topic.dimensions
      ) {
        return { applied: false, topic: null, membership: null };
      }

      const topic = await trx
        .insertInto("content_plan_topics")
        .values({
          workspace_id: input.workspaceId,
          generation_id: input.generationId,
          id: input.topic.id,
          embedding_space_id: input.topic.embeddingSpaceId,
          lifecycle: input.topic.lifecycle,
          centroid: storedAggregateCentroid(input.topic),
          dimensions: input.topic.dimensions,
          centroid_weight: input.topic.centroidWeight,
          representative_observation_ids: [...new Set(input.topic.representativeObservationIds)],
          revision: input.topic.revision,
          enrichment_dirty_at: input.topic.enrichmentDirtyAt,
        })
        .returning(topicColumns)
        .executeTakeFirstOrThrow();
      const membership = await trx
        .insertInto("content_plan_topic_memberships")
        .values({
          workspace_id: input.workspaceId,
          generation_id: input.generationId,
          observation_id: input.observationId,
          topic_id: input.topic.id,
          assignment_version: input.assignmentVersion,
          similarity: input.similarity,
          cohesion: input.cohesion,
          assigned_at: input.assignedAt,
        })
        .returning(membershipColumns)
        .executeTakeFirstOrThrow();
      const completed = await trx
        .updateTable("content_plan_observation_vectors")
        .set({
          state: "assigned",
          claim_token: null,
          claimed_at: null,
          claim_expires_at: null,
          completed_at: input.assignedAt,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("observation_id", "=", input.observationId)
        .where("generation_id", "=", input.generationId)
        .where("state", "=", "processing")
        .where("claim_token", "=", input.claimToken)
        .executeTakeFirst();
      if (Number(completed.numUpdatedRows) !== 1) {
        throw new Error("Content planning vector claim changed during assignment");
      }
      return {
        applied: true,
        topic: mapTopic(topic as TopicRow),
        membership: mapMembership(membership as MembershipRow),
      };
    });
  }

  async assignToExistingTopic(input: {
    workspaceId: string;
    generationId: string;
    observationId: string;
    claimToken: string;
    topicId: string;
    expectedTopicRevision: number;
    topic: ContentPlanTopicAggregateUpdate;
    assignmentVersion: number;
    similarity: number;
    cohesion: number;
    assignedAt: Date;
  }): Promise<{
    applied: boolean;
    topic: ContentPlanTopicRecord | null;
    membership: ContentPlanTopicMembershipRecord | null;
  }> {
    validateAggregateUpdate(input.topic, input.expectedTopicRevision, true);
    return this.db.transaction().execute(async (trx) => {
      const vector = await trx
        .selectFrom("content_plan_observation_vectors")
        .select(["state", "claim_token", "embedding_space_id", "dimensions"])
        .where("workspace_id", "=", input.workspaceId)
        .where("observation_id", "=", input.observationId)
        .where("generation_id", "=", input.generationId)
        .forUpdate()
        .executeTakeFirst();
      if (!vector || vector.state !== "processing" || vector.claim_token !== input.claimToken) {
        return { applied: false, topic: null, membership: null };
      }
      const currentTopic = await trx
        .selectFrom("content_plan_topics")
        .select(["revision", "embedding_space_id", "dimensions", "lifecycle"])
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", input.topicId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !currentTopic
        || currentTopic.revision !== input.expectedTopicRevision
        || !["provisional", "mature"].includes(currentTopic.lifecycle)
        || currentTopic.embedding_space_id !== vector.embedding_space_id
        || currentTopic.dimensions !== vector.dimensions
        || currentTopic.dimensions !== input.topic.dimensions
      ) {
        return { applied: false, topic: null, membership: null };
      }
      const existingMembership = await trx
        .selectFrom("content_plan_topic_memberships")
        .select("observation_id")
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("observation_id", "=", input.observationId)
        .executeTakeFirst();
      if (existingMembership) return { applied: false, topic: null, membership: null };

      const topic = await trx
        .updateTable("content_plan_topics")
        .set({
          lifecycle: input.topic.lifecycle,
          centroid: storedAggregateCentroid(input.topic),
          dimensions: input.topic.dimensions,
          centroid_weight: input.topic.centroidWeight,
          representative_observation_ids: [...input.topic.representativeObservationIds],
          revision: input.topic.revision,
          enrichment_dirty_at: input.topic.enrichmentDirtyAt,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", input.topicId)
        .where("revision", "=", input.expectedTopicRevision)
        .where("lifecycle", "in", ["provisional", "mature"])
        .returning(topicColumns)
        .executeTakeFirst();
      if (!topic) throw new Error("Content planning topic changed during assignment");
      const membership = await trx
        .insertInto("content_plan_topic_memberships")
        .values({
          workspace_id: input.workspaceId,
          generation_id: input.generationId,
          observation_id: input.observationId,
          topic_id: input.topicId,
          assignment_version: input.assignmentVersion,
          similarity: input.similarity,
          cohesion: input.cohesion,
          assigned_at: input.assignedAt,
        })
        .returning(membershipColumns)
        .executeTakeFirstOrThrow();
      const completed = await trx
        .updateTable("content_plan_observation_vectors")
        .set({
          state: "assigned",
          claim_token: null,
          claimed_at: null,
          claim_expires_at: null,
          completed_at: input.assignedAt,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("observation_id", "=", input.observationId)
        .where("generation_id", "=", input.generationId)
        .where("state", "=", "processing")
        .where("claim_token", "=", input.claimToken)
        .executeTakeFirst();
      if (Number(completed.numUpdatedRows) !== 1) {
        throw new Error("Content planning vector claim changed during assignment");
      }
      return {
        applied: true,
        topic: mapTopic(topic as TopicRow),
        membership: mapMembership(membership as MembershipRow),
      };
    });
  }

  async reconcileTopic(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    expectedRevision: number;
    topic: ContentPlanTopicAggregateUpdate;
  }): Promise<ContentPlanTopicRecord | null> {
    validateAggregateUpdate(input.topic, input.expectedRevision, true);
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("content_plan_topics")
        .set({
          lifecycle: input.topic.lifecycle,
          centroid: storedAggregateCentroid(input.topic),
          dimensions: input.topic.dimensions,
          centroid_weight: input.topic.centroidWeight,
          representative_observation_ids: [...input.topic.representativeObservationIds],
          revision: input.topic.revision,
          enrichment_dirty_at: input.topic.enrichmentDirtyAt,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", input.topicId)
        .where("revision", "=", input.expectedRevision)
        .where("lifecycle", "in", ["provisional", "mature"])
        .returning(topicColumns)
        .executeTakeFirst();
      if (!row) return null;
      await trx
        .deleteFrom("content_plan_topic_documents")
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("topic_id", "=", input.topicId)
        .execute();
      await trx
        .deleteFrom("content_plan_topic_enrichments")
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("topic_id", "=", input.topicId)
        .execute();
      return mapTopic(row as TopicRow);
    });
  }

  async mergeTopics(input: {
    workspaceId: string;
    generationId: string;
    sourceTopicId: string;
    sourceExpectedRevision: number;
    survivorTopicId: string;
    survivorExpectedRevision: number;
    survivor: ContentPlanTopicAggregateUpdate;
    mergedAt: Date;
    redirectExpiresAt: Date;
  }): Promise<ContentPlanTopicRecord | null> {
    if (input.sourceTopicId === input.survivorTopicId) {
      throw new Error("A content planning topic cannot merge into itself");
    }
    if (input.redirectExpiresAt.getTime() - input.mergedAt.getTime() < 90 * 24 * 60 * 60 * 1_000) {
      throw new Error("Content planning merge redirects must be retained for at least 90 days");
    }
    validateAggregateUpdate(input.survivor, input.survivorExpectedRevision, true);
    if (input.survivor.lifecycle !== "provisional" && input.survivor.lifecycle !== "mature") {
      throw new Error("A content planning merge survivor must remain active");
    }
    return this.db.transaction().execute(async (trx) => {
      const topicIds = [input.sourceTopicId, input.survivorTopicId].sort();
      const locked = await trx
        .selectFrom("content_plan_topics")
        .select(["id", "revision", "lifecycle", "embedding_space_id", "dimensions"])
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "in", topicIds)
        .orderBy("id", "asc")
        .forUpdate()
        .execute();
      const source = locked.find((topic) => topic.id === input.sourceTopicId);
      const survivor = locked.find((topic) => topic.id === input.survivorTopicId);
      if (
        !source
        || !survivor
        || source.revision !== input.sourceExpectedRevision
        || survivor.revision !== input.survivorExpectedRevision
        || !["provisional", "mature"].includes(source.lifecycle)
        || !["provisional", "mature"].includes(survivor.lifecycle)
        || source.embedding_space_id !== survivor.embedding_space_id
        || survivor.dimensions !== input.survivor.dimensions
      ) {
        return null;
      }
      const updatedSurvivor = await trx
        .updateTable("content_plan_topics")
        .set({
          lifecycle: input.survivor.lifecycle,
          centroid: storedAggregateCentroid(input.survivor),
          dimensions: input.survivor.dimensions,
          centroid_weight: input.survivor.centroidWeight,
          representative_observation_ids: [...input.survivor.representativeObservationIds],
          revision: input.survivor.revision,
          enrichment_dirty_at: input.survivor.enrichmentDirtyAt,
          updated_at: input.mergedAt,
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", input.survivorTopicId)
        .where("revision", "=", input.survivorExpectedRevision)
        .returning(topicColumns)
        .executeTakeFirst();
      if (!updatedSurvivor) return null;
      const merged = await trx
        .updateTable("content_plan_topics")
        .set({
          lifecycle: "merged",
          centroid: null,
          centroid_weight: 0,
          representative_observation_ids: [],
          revision: input.sourceExpectedRevision + 1,
          merged_into_topic_id: input.survivorTopicId,
          redirect_expires_at: input.redirectExpiresAt,
          enrichment_dirty_at: null,
          updated_at: input.mergedAt,
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", input.sourceTopicId)
        .where("revision", "=", input.sourceExpectedRevision)
        .executeTakeFirst();
      if (Number(merged.numUpdatedRows) !== 1) {
        throw new Error("Content planning merge source changed while locked");
      }
      await trx
        .updateTable("content_plan_topic_memberships")
        .set({ topic_id: input.survivorTopicId })
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("topic_id", "=", input.sourceTopicId)
        .execute();
      return mapTopic(updatedSurvivor as TopicRow);
    });
  }

  async pruneExpiredRedirects(input: {
    workspaceId: string;
    generationId?: string;
    now: Date;
    limit: number;
  }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("Content planning redirect prune limit must be between 1 and 100");
    }
    if (!Number.isFinite(input.now.getTime())) {
      throw new Error("Content planning redirect prune time must be valid");
    }
    return this.db.transaction().execute(async (trx) => {
      let query = trx
        .selectFrom("content_plan_topics as topic")
        .select(["topic.generation_id", "topic.id"])
        .where("topic.workspace_id", "=", input.workspaceId)
        .where("topic.lifecycle", "=", "merged")
        .where("topic.redirect_expires_at", "<=", input.now)
        .where((eb) => eb.not(eb.exists(
          eb.selectFrom("content_plan_topics as child")
            .select("child.id")
            .whereRef("child.workspace_id", "=", "topic.workspace_id")
            .whereRef("child.generation_id", "=", "topic.generation_id")
            .whereRef("child.merged_into_topic_id", "=", "topic.id"),
        )));
      if (input.generationId) query = query.where("topic.generation_id", "=", input.generationId);
      const selected = await query
        .orderBy("topic.redirect_expires_at", "asc")
        .orderBy("topic.generation_id", "asc")
        .orderBy("topic.id", "asc")
        .forUpdate()
        .skipLocked()
        .limit(input.limit)
        .execute();
      if (selected.length === 0) return 0;
      const deleted = await trx
        .deleteFrom("content_plan_topics")
        .where("workspace_id", "=", input.workspaceId)
        .where((eb) => eb.or(selected.map((topic) => eb.and([
          eb("generation_id", "=", topic.generation_id),
          eb("id", "=", topic.id),
        ]))))
        .returning("id")
        .execute();
      return deleted.length;
    });
  }

  async invalidateTopic(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    expectedRevision: number;
    dirtyAt: Date;
  }): Promise<ContentPlanTopicRecord | null> {
    const row = await this.db
      .updateTable("content_plan_topics")
      .set((eb) => ({
        revision: eb("revision", "+", 1),
        enrichment_dirty_at: input.dirtyAt,
        updated_at: currentTimestamp(),
      }))
      .where("workspace_id", "=", input.workspaceId)
      .where("generation_id", "=", input.generationId)
      .where("id", "=", input.topicId)
      .where("revision", "=", input.expectedRevision)
      .returning(topicColumns)
      .executeTakeFirst();
    return row ? mapTopic(row as TopicRow) : null;
  }

  async resolveTopicRedirect(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    now: Date;
    maxHops?: number;
  }): Promise<ContentPlanTopicRedirectResult> {
    const maxHops = input.maxHops ?? MAX_CONTENT_PLAN_REDIRECT_HOPS;
    if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > MAX_CONTENT_PLAN_REDIRECT_HOPS) {
      throw new Error(`Content planning redirect hops must be between 1 and ${MAX_CONTENT_PLAN_REDIRECT_HOPS}`);
    }
    const visited = new Set<string>();
    let currentId = input.topicId;
    let hops = 0;
    while (true) {
      if (visited.has(currentId)) return { kind: "cycle" };
      visited.add(currentId);
      const row = await this.db
        .selectFrom("content_plan_topics")
        .select(topicColumns)
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", currentId)
        .executeTakeFirst();
      if (!row) return { kind: "not_found" };
      const topic = mapTopic(row as TopicRow);
      if (topic.lifecycle === "provisional" || topic.lifecycle === "mature") {
        return {
          kind: "active",
          topic,
          redirectedFromTopicId: hops === 0 ? null : input.topicId,
          hops,
        };
      }
      if (
        topic.lifecycle !== "merged"
        || !topic.mergedIntoTopicId
        || !topic.redirectExpiresAt
        || topic.redirectExpiresAt <= input.now
        || hops >= maxHops
      ) {
        return { kind: "not_found" };
      }
      currentId = topic.mergedIntoTopicId;
      hops += 1;
    }
  }
}
