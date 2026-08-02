import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ContentPlanProjectionRepository } from "../../src/db/repositories/contentPlanningProjectionRepository.js";
import { ContentPlanTopicRepository } from "../../src/db/repositories/contentPlanningTopicRepository.js";
import { PostgresContentPlanReadSource } from "../../src/modules/contentPlanning/infra/contentPlanReadSource.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const isolatedUrl = (base: string, name: string): string => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

interface WorkspaceFixture {
  accountId: string;
  workspaceId: string;
  oldEmbeddingSpaceId: string;
  targetEmbeddingSpaceId: string;
}

interface GenerationFixture {
  oldGenerationId: string;
  targetGenerationId: string;
}

interface ObservationFixture {
  observationId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

describeIfDatabase("content-planning identity and generation retention", () => {
  const databaseName = `content_plan_identity_${randomUUID().replaceAll("-", "")}`;
  const now = new Date("2026-08-02T12:00:00.000Z");
  let admin: Database;
  let database: Database;
  let projections: ContentPlanProjectionRepository;
  let topics: ContentPlanTopicRepository;
  let readSource: PostgresContentPlanReadSource;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runAllTestMigrations(database);
    projections = new ContentPlanProjectionRepository(database.kysely);
    topics = new ContentPlanTopicRepository(database.kysely);
    readSource = new PostgresContentPlanReadSource(database.kysely);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin
      ?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  const createWorkspace = async (suffix: string): Promise<WorkspaceFixture> => {
    const fixture = {
      accountId: randomUUID(),
      workspaceId: randomUUID(),
      oldEmbeddingSpaceId: randomUUID(),
      targetEmbeddingSpaceId: randomUUID(),
    };
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash')",
      [fixture.accountId, `Identity ${suffix}`, `identity-${suffix}-${fixture.accountId}@example.com`],
    );
    await database.execute(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)`,
      [fixture.workspaceId, fixture.accountId, `Identity ${suffix}`, `identity-${suffix}-${fixture.workspaceId}`],
    );
    for (const [index, embeddingSpaceId] of [
      fixture.oldEmbeddingSpaceId,
      fixture.targetEmbeddingSpaceId,
    ].entries()) {
      await database.execute(
        `INSERT INTO embedding_spaces (
           id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
           dimensions, distance_metric, normalization
         ) VALUES ($1, $2, 'test', $3, $4, 3, 'cosine', 'unit')`,
        [
          embeddingSpaceId,
          `identity-space-${embeddingSpaceId}`,
          `identity-endpoint-${embeddingSpaceId}`,
          `identity-model-${index}`,
        ],
      );
    }
    return fixture;
  };

  const createProjectionPair = async (
    fixture: WorkspaceFixture,
    suffix: string,
  ): Promise<GenerationFixture> => {
    const oldGenerationId = randomUUID();
    const targetGenerationId = randomUUID();
    await projections.createGeneration({
      id: oldGenerationId,
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.oldEmbeddingSpaceId,
      kind: "active",
      state: "coherent",
      policyVersion: 1,
      horizonFrom: new Date("2026-06-03T12:00:00.000Z"),
      horizonTo: now,
      coherentAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    await projections.createGeneration({
      id: targetGenerationId,
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.targetEmbeddingSpaceId,
      kind: "reprojection",
      state: "building",
      policyVersion: 1,
      horizonFrom: new Date("2026-06-03T12:00:00.000Z"),
      horizonTo: now,
      coherentAt: null,
    });
    await projections.upsertProjectionState({
      workspaceId: fixture.workspaceId,
      coherentGenerationId: oldGenerationId,
      targetGenerationId,
      projectionState: "reprojecting",
      reason: null,
      processedThrough: new Date("2026-08-02T11:00:00.000Z"),
      bootstrapProcessed: "0",
      bootstrapTotal: "0",
      budgetVersion: 1,
      budgetWindowStartedAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    expect(suffix).toBeTruthy();
    return { oldGenerationId, targetGenerationId };
  };

  const addObservation = async (
    fixture: WorkspaceFixture,
    generations: GenerationFixture,
    suffix: string,
  ): Promise<ObservationFixture> => {
    const observation = {
      observationId: randomUUID(),
      conversationId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
    };
    await database.execute(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'embed')",
      [observation.conversationId, fixture.workspaceId],
    );
    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES
         ($1, $3, $4, 'user', $5, $6),
         ($2, $3, $4, 'assistant', 'message-owned answer', $6)`,
      [
        observation.userMessageId,
        observation.assistantMessageId,
        observation.conversationId,
        fixture.workspaceId,
        `message-owned identity question ${suffix}`,
        new Date("2026-07-15T00:00:00.000Z"),
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_observations (
         id, workspace_id, source_user_message_id, source_assistant_message_id,
         conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
         observation_state, observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'substantive_new', 'ready', $8)`,
      [
        observation.observationId,
        fixture.workspaceId,
        observation.userMessageId,
        observation.assistantMessageId,
        observation.conversationId,
        `intent-${suffix}`,
        suffix.padEnd(64, "a").slice(0, 64).replace(/[^0-9a-f]/g, "a"),
        new Date("2026-07-15T00:00:00.000Z"),
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id,
         dimensions, embedding, vector_source, state, completed_at
       ) VALUES
         ($1, $2, $3, $4, 3, '[1,0,0]'::vector, 'reused', 'assigned', $7),
         ($1, $2, $5, $6, 3, '[0,1,0]'::vector, 'fallback', 'assigned', $7)`,
      [
        fixture.workspaceId,
        observation.observationId,
        generations.oldGenerationId,
        fixture.oldEmbeddingSpaceId,
        generations.targetGenerationId,
        fixture.targetEmbeddingSpaceId,
        new Date("2026-07-15T00:00:01.000Z"),
      ],
    );
    return observation;
  };

  const addTopic = async (input: {
    fixture: WorkspaceFixture;
    generationId: string;
    embeddingSpaceId: string;
    topicId: string;
    observationIds: readonly string[];
    lifecycle?: "mature" | "merged";
    mergedIntoTopicId?: string;
    redirectExpiresAt?: Date;
    revision?: number;
  }): Promise<void> => {
    const lifecycle = input.lifecycle ?? "mature";
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision,
         merged_into_topic_id, redirect_expires_at, enrichment_dirty_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         CASE WHEN $5 = 'merged' THEN NULL ELSE '[1,0,0]'::vector END,
         3, $6, $7::uuid[], $8,
         $9, $10, $11
       )`,
      [
        input.fixture.workspaceId,
        input.generationId,
        input.topicId,
        input.embeddingSpaceId,
        lifecycle,
        input.observationIds.length,
        input.observationIds,
        input.revision ?? 1,
        input.mergedIntoTopicId ?? null,
        input.redirectExpiresAt ?? null,
        lifecycle === "mature" ? new Date("2026-07-15T00:00:00.000Z") : null,
      ],
    );
    for (const observationId of input.observationIds) {
      await database.execute(
        `INSERT INTO content_plan_topic_memberships (
           workspace_id, generation_id, observation_id, topic_id,
           assignment_version, similarity, cohesion, assigned_at
         ) VALUES ($1, $2, $3, $4, 1, 1, 1, $5)`,
        [
          input.fixture.workspaceId,
          input.generationId,
          observationId,
          input.topicId,
          new Date("2026-07-15T00:00:01.000Z"),
        ],
      );
    }
  };

  const promote = async (
    fixture: WorkspaceFixture,
    generations: GenerationFixture,
  ): Promise<void> => {
    const total = await database.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM content_plan_observations
       WHERE workspace_id = $1 AND observation_state = 'ready'`,
      [fixture.workspaceId],
    );
    await projections.upsertProjectionState({
      workspaceId: fixture.workspaceId,
      coherentGenerationId: generations.oldGenerationId,
      targetGenerationId: generations.targetGenerationId,
      projectionState: "reprojecting",
      reason: null,
      processedThrough: new Date("2026-08-02T11:00:00.000Z"),
      bootstrapProcessed: total.count,
      bootstrapTotal: total.count,
      budgetVersion: 1,
      budgetWindowStartedAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    const lease = await projections.claimProjectionLease({
      workspaceId: fixture.workspaceId,
      now,
      leaseMs: 30_000,
    });
    await expect(projections.promoteGeneration({
      workspaceId: fixture.workspaceId,
      targetGenerationId: generations.targetGenerationId,
      expectedCoherentGenerationId: generations.oldGenerationId,
      leaseToken: lease!.leaseToken!,
      coherentAt: now,
      processedThrough: now,
    })).resolves.toMatchObject({
      coherentGenerationId: generations.targetGenerationId,
      targetGenerationId: null,
      projectionState: "ready",
    });
  };

  it("carries an unambiguous mature public ID and its live redirect lineage across embedding spaces", async () => {
    const fixture = await createWorkspace("stable");
    const generations = await createProjectionPair(fixture, "stable");
    const first = await addObservation(fixture, generations, "stable-a");
    const second = await addObservation(fixture, generations, "stable-b");
    const oldTopicId = randomUUID();
    const priorAliasId = randomUUID();
    const targetTopicId = randomUUID();
    const observationIds = [first.observationId, second.observationId];
    await addTopic({
      fixture,
      generationId: generations.oldGenerationId,
      embeddingSpaceId: fixture.oldEmbeddingSpaceId,
      topicId: oldTopicId,
      observationIds,
      revision: 4,
    });
    await addTopic({
      fixture,
      generationId: generations.oldGenerationId,
      embeddingSpaceId: fixture.oldEmbeddingSpaceId,
      topicId: priorAliasId,
      observationIds: [],
      lifecycle: "merged",
      mergedIntoTopicId: oldTopicId,
      redirectExpiresAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    await addTopic({
      fixture,
      generationId: generations.targetGenerationId,
      embeddingSpaceId: fixture.targetEmbeddingSpaceId,
      topicId: targetTopicId,
      observationIds,
      revision: 7,
    });
    await database.execute(
      `INSERT INTO content_plan_topic_enrichments (
         workspace_id, generation_id, topic_id, source_topic_revision, state,
         label, description, action_rule_version, corpus_state, enriched_at
       ) VALUES ($1, $2, $3, 7, 'ready', 'Stable label', 'Stable description', 1, 'ready', $4)`,
      [fixture.workspaceId, generations.targetGenerationId, targetTopicId, now],
    );

    await promote(fixture, generations);

    await expect(database.query<{ id: string; revision: number }>(
      `SELECT id, revision
       FROM content_plan_topics
       WHERE workspace_id = $1 AND generation_id = $2 AND lifecycle = 'mature'`,
      [fixture.workspaceId, generations.targetGenerationId],
    )).resolves.toEqual([{ id: oldTopicId, revision: 7 }]);
    await expect(database.queryOne<{ topic_id: string; source_topic_revision: number; label: string }>(
      `SELECT topic_id, source_topic_revision, label
       FROM content_plan_topic_enrichments
       WHERE workspace_id = $1 AND generation_id = $2`,
      [fixture.workspaceId, generations.targetGenerationId],
    )).resolves.toEqual({
      topic_id: oldTopicId,
      source_topic_revision: 7,
      label: "Stable label",
    });
    await expect(readSource.getTopicRedirectChain(
      fixture.workspaceId,
      generations.targetGenerationId,
      priorAliasId,
    )).resolves.toEqual([
      expect.objectContaining({ id: priorAliasId, lifecycle: "merged", mergedIntoTopicId: oldTopicId }),
      expect.objectContaining({ id: oldTopicId, lifecycle: "mature" }),
    ]);
  });

  it("keeps a new survivor for a verified merge, aliases each old ID, and refuses a split ambiguity", async () => {
    const fixture = await createWorkspace("ambiguity");
    const generations = await createProjectionPair(fixture, "ambiguity");
    const mergedA = await addObservation(fixture, generations, "merge-a");
    const mergedB = await addObservation(fixture, generations, "merge-b");
    const splitA = await addObservation(fixture, generations, "split-a");
    const splitB = await addObservation(fixture, generations, "split-b");
    const oldMergeAId = randomUUID();
    const oldMergeBId = randomUUID();
    const targetMergeId = randomUUID();
    const oldSplitId = randomUUID();
    const targetSplitAId = randomUUID();
    const targetSplitBId = randomUUID();
    for (const [topicId, observationIds] of [
      [oldMergeAId, [mergedA.observationId]],
      [oldMergeBId, [mergedB.observationId]],
      [oldSplitId, [splitA.observationId, splitB.observationId]],
    ] as const) {
      await addTopic({
        fixture,
        generationId: generations.oldGenerationId,
        embeddingSpaceId: fixture.oldEmbeddingSpaceId,
        topicId,
        observationIds,
      });
    }
    for (const [topicId, observationIds] of [
      [targetMergeId, [mergedA.observationId, mergedB.observationId]],
      [targetSplitAId, [splitA.observationId]],
      [targetSplitBId, [splitB.observationId]],
    ] as const) {
      await addTopic({
        fixture,
        generationId: generations.targetGenerationId,
        embeddingSpaceId: fixture.targetEmbeddingSpaceId,
        topicId,
        observationIds,
      });
    }

    await promote(fixture, generations);

    for (const oldTopicId of [oldMergeAId, oldMergeBId]) {
      await expect(readSource.getTopicRedirectChain(
        fixture.workspaceId,
        generations.targetGenerationId,
        oldTopicId,
      )).resolves.toEqual([
        expect.objectContaining({
          id: oldTopicId,
          lifecycle: "merged",
          mergedIntoTopicId: targetMergeId,
        }),
        expect.objectContaining({ id: targetMergeId, lifecycle: "mature" }),
      ]);
    }
    await expect(readSource.getTopicRedirectChain(
      fixture.workspaceId,
      generations.targetGenerationId,
      oldSplitId,
    )).resolves.toEqual([]);
    await expect(database.query<{ id: string }>(
      `SELECT id
       FROM content_plan_topics
       WHERE workspace_id = $1 AND generation_id = $2 AND lifecycle = 'mature'
       ORDER BY id`,
      [fixture.workspaceId, generations.targetGenerationId],
    )).resolves.toEqual(
      [targetMergeId, targetSplitAId, targetSplitBId]
        .sort()
        .map((id) => ({ id })),
    );
  });

  it("retires a zero-member topic without retaining its centroid or generated prose", async () => {
    const fixture = await createWorkspace("retired-storage");
    const generations = await createProjectionPair(fixture, "retired-storage");
    const observation = await addObservation(fixture, generations, "retired-storage");
    const topicId = randomUUID();
    await addTopic({
      fixture,
      generationId: generations.targetGenerationId,
      embeddingSpaceId: fixture.targetEmbeddingSpaceId,
      topicId,
      observationIds: [observation.observationId],
      revision: 2,
    });
    await database.execute(
      `INSERT INTO content_plan_topic_enrichments (
         workspace_id, generation_id, topic_id, source_topic_revision, state,
         label, description, action_rule_version, corpus_state, enriched_at
       ) VALUES ($1, $2, $3, 2, 'ready', 'Private label', 'Private description', 1, 'ready', $4)`,
      [fixture.workspaceId, generations.targetGenerationId, topicId, now],
    );
    await database.execute(
      `DELETE FROM content_plan_topic_memberships
       WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
      [fixture.workspaceId, generations.targetGenerationId, topicId],
    );

    await expect(topics.reconcileTopic({
      workspaceId: fixture.workspaceId,
      generationId: generations.targetGenerationId,
      topicId,
      expectedRevision: 2,
      topic: {
        lifecycle: "retired",
        centroid: null,
        dimensions: 3,
        centroidWeight: 0,
        representativeObservationIds: [],
        revision: 3,
        enrichmentDirtyAt: null,
      },
    })).resolves.toMatchObject({ lifecycle: "retired", centroid: null });
    await expect(database.queryOne<{
      lifecycle: string;
      centroid_is_null: boolean;
      enrichment_count: string;
    }>(
      `SELECT
         topic.lifecycle,
         topic.centroid IS NULL AS centroid_is_null,
         (SELECT count(*)::text
          FROM content_plan_topic_enrichments enrichment
          WHERE enrichment.workspace_id = topic.workspace_id
            AND enrichment.generation_id = topic.generation_id
            AND enrichment.topic_id = topic.id) AS enrichment_count
       FROM content_plan_topics topic
       WHERE topic.workspace_id = $1 AND topic.generation_id = $2 AND topic.id = $3`,
      [fixture.workspaceId, generations.targetGenerationId, topicId],
    )).resolves.toEqual({
      lifecycle: "retired",
      centroid_is_null: true,
      enrichment_count: "0",
    });
    await expect(topics.resolveTopicRedirect({
      workspaceId: fixture.workspaceId,
      generationId: generations.targetGenerationId,
      topicId,
      now,
    })).resolves.toEqual({ kind: "not_found" });
  });

  it("prunes failed data after 60 days and superseded data after 90 days in bounded batches", async () => {
    const fixture = await createWorkspace("generation-prune");
    const coherentGenerationId = randomUUID();
    const targetGenerationId = randomUUID();
    const oldFailedGenerationId = randomUUID();
    const recentFailedGenerationId = randomUUID();
    const oldSupersededGenerationId = randomUUID();
    const redirectProtectedGenerationId = randomUUID();
    const generationRows = [
      [coherentGenerationId, "active", "coherent", now, now],
      [targetGenerationId, "reprojection", "building", null, now],
      [oldFailedGenerationId, "reprojection", "failed", null, new Date("2026-06-02T11:59:59.000Z")],
      [recentFailedGenerationId, "reprojection", "failed", null, new Date("2026-06-03T12:00:01.000Z")],
      [oldSupersededGenerationId, "active", "superseded", now, new Date("2026-05-04T11:59:59.000Z")],
      [redirectProtectedGenerationId, "active", "superseded", now, new Date("2026-05-04T12:00:01.000Z")],
    ] as const;
    for (const [generationId, kind, state, coherentAt, updatedAt] of generationRows) {
      await database.execute(
        `INSERT INTO content_plan_projection_generations (
           id, workspace_id, embedding_space_id, kind, state, policy_version,
           horizon_from, horizon_to, coherent_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $9)`,
        [
          generationId,
          fixture.workspaceId,
          fixture.targetEmbeddingSpaceId,
          kind,
          state,
          new Date("2026-04-01T00:00:00.000Z"),
          now,
          coherentAt,
          updatedAt,
        ],
      );
    }
    await projections.upsertProjectionState({
      workspaceId: fixture.workspaceId,
      coherentGenerationId,
      targetGenerationId,
      projectionState: "reprojecting",
      reason: null,
      processedThrough: now,
      bootstrapProcessed: "0",
      bootstrapTotal: "0",
      budgetVersion: 1,
      budgetWindowStartedAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    const observation = await addStorageObservation(fixture);
    for (const generationId of [
      oldFailedGenerationId,
      recentFailedGenerationId,
      oldSupersededGenerationId,
      redirectProtectedGenerationId,
    ]) {
      await addGenerationStorage({ fixture, generationId, observation });
    }

    await expect(projections.pruneExpiredGenerations({
      workspaceId: fixture.workspaceId,
      failedBefore: new Date("2026-06-03T12:00:00.000Z"),
      supersededBefore: new Date("2026-05-04T12:00:00.000Z"),
      limit: 1,
    })).resolves.toEqual({ failedCount: 0, supersededCount: 1 });
    await expect(projections.pruneExpiredGenerations({
      workspaceId: fixture.workspaceId,
      failedBefore: new Date("2026-06-03T12:00:00.000Z"),
      supersededBefore: new Date("2026-05-04T12:00:00.000Z"),
      limit: 1,
    })).resolves.toEqual({ failedCount: 1, supersededCount: 0 });

    const retained = await database.query<{ id: string }>(
      `SELECT id
       FROM content_plan_projection_generations
       WHERE workspace_id = $1
       ORDER BY id`,
      [fixture.workspaceId],
    );
    expect(retained.map((row) => row.id).sort()).toEqual([
      coherentGenerationId,
      targetGenerationId,
      recentFailedGenerationId,
      redirectProtectedGenerationId,
    ].sort());
    await expect(database.queryOne<{
      vector_count: string;
      topic_count: string;
      prose_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM content_plan_observation_vectors
          WHERE workspace_id = $1 AND generation_id = ANY($2::uuid[])) AS vector_count,
         (SELECT count(*)::text FROM content_plan_topics
          WHERE workspace_id = $1 AND generation_id = ANY($2::uuid[])) AS topic_count,
         (SELECT count(*)::text FROM content_plan_topic_enrichments
          WHERE workspace_id = $1 AND generation_id = ANY($2::uuid[])) AS prose_count`,
      [fixture.workspaceId, [oldFailedGenerationId, oldSupersededGenerationId]],
    )).resolves.toEqual({ vector_count: "0", topic_count: "0", prose_count: "0" });
    await expect(readSource.getTopicRedirectChain(
      fixture.workspaceId,
      redirectProtectedGenerationId,
      observation.redirectTopicId,
    )).resolves.toHaveLength(2);
  });

  const addStorageObservation = async (fixture: WorkspaceFixture) => {
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const observationId = randomUUID();
    await database.execute(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [conversationId, fixture.workspaceId],
    );
    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES
         ($1, $3, $4, 'user', 'message-owned retained question', $5),
         ($2, $3, $4, 'assistant', 'message-owned retained answer', $5)`,
      [userMessageId, assistantMessageId, conversationId, fixture.workspaceId, new Date("2026-07-01T00:00:00.000Z")],
    );
    await database.execute(
      `INSERT INTO content_plan_observations (
         id, workspace_id, source_user_message_id, source_assistant_message_id,
         conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
         observation_state, observed_at
       ) VALUES ($1, $2, $3, $4, $5, 'storage', $6, 'substantive_new', 'ready', $7)`,
      [
        observationId,
        fixture.workspaceId,
        userMessageId,
        assistantMessageId,
        conversationId,
        "a".repeat(64),
        new Date("2026-07-01T00:00:00.000Z"),
      ],
    );
    return { observationId, redirectTopicId: randomUUID() };
  };

  const addGenerationStorage = async (input: {
    fixture: WorkspaceFixture;
    generationId: string;
    observation: { observationId: string; redirectTopicId: string };
  }): Promise<void> => {
    const activeTopicId = randomUUID();
    await database.execute(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id,
         dimensions, embedding, vector_source, state, completed_at
       ) VALUES ($1, $2, $3, $4, 3, '[1,0,0]'::vector, 'fallback', 'assigned', $5)`,
      [input.fixture.workspaceId, input.observation.observationId, input.generationId, input.fixture.targetEmbeddingSpaceId, now],
    );
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 1, ARRAY[$5::uuid], 1)`,
      [
        input.fixture.workspaceId,
        input.generationId,
        activeTopicId,
        input.fixture.targetEmbeddingSpaceId,
        input.observation.observationId,
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_memberships (
         workspace_id, generation_id, observation_id, topic_id,
         assignment_version, similarity, cohesion, assigned_at
       ) VALUES ($1, $2, $3, $4, 1, 1, 1, $5)`,
      [input.fixture.workspaceId, input.generationId, input.observation.observationId, activeTopicId, now],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_enrichments (
         workspace_id, generation_id, topic_id, source_topic_revision, state,
         label, description, action_rule_version, corpus_state, enriched_at
       ) VALUES ($1, $2, $3, 1, 'ready', 'Private generated label',
         'Private generated description', 1, 'ready', $4)`,
      [input.fixture.workspaceId, input.generationId, activeTopicId, now],
    );
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision,
         merged_into_topic_id, redirect_expires_at
       ) VALUES ($1, $2, $3, $4, 'merged', NULL, 3, 0, '{}'::uuid[], 1, $5, $6)
       ON CONFLICT (workspace_id, generation_id, id) DO NOTHING`,
      [
        input.fixture.workspaceId,
        input.generationId,
        input.observation.redirectTopicId,
        input.fixture.targetEmbeddingSpaceId,
        activeTopicId,
        new Date("2026-10-01T00:00:00.000Z"),
      ],
    );
  };
});
