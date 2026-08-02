import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresContentPlanEnrichmentPlanningDataSource } from "../../src/modules/contentPlanning/infra/postgresEnrichmentPlanningDataSource.js";
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

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("bounded content-planning enrichment source", () => {
  let database: Database;
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const embeddingSpaceId = randomUUID();
  const generationId = randomUUID();
  let topicIds: string[];
  const visibleObservationId = randomUUID();
  const futureAssignmentObservationId = randomUUID();

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Planning source', $2, 'hash')",
      [accountId, `planning-source-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Planning', $3)",
      [workspaceId, accountId, `planning-${workspaceId}`],
    );
    await database.execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, 'test-model', 3, 'cosine', 'unit')`,
      [embeddingSpaceId, `planning-${embeddingSpaceId}`, `planning-endpoint-${embeddingSpaceId}`],
    );
    await database.execute(
      `INSERT INTO content_plan_projection_generations (
         id, workspace_id, embedding_space_id, kind, state, policy_version,
         horizon_from, horizon_to, coherent_at
       ) VALUES ($1, $2, $3, 'active', 'coherent', 1, '2026-06-01', '2026-08-01', '2026-08-01')`,
      [generationId, workspaceId, embeddingSpaceId],
    );

    topicIds = Array.from({ length: 130 }, () => randomUUID()).sort();
    for (const [index, topicId] of topicIds.entries()) {
      const carriesBrief = index < 10;
      const memberCount = index + 2;
      await database.execute(
        `INSERT INTO content_plan_topics (
           workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
           dimensions, centroid_weight, representative_observation_ids, revision, created_at
         ) VALUES (
           $1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, $5, '{}'::uuid[], 1,
           '2026-07-01T00:00:00.000Z'
         )`,
        [workspaceId, generationId, topicId, embeddingSpaceId, memberCount],
      );
      await database.execute(
        `INSERT INTO content_plan_topic_enrichments (
           workspace_id, generation_id, topic_id, source_topic_revision,
           source_member_count, source_grounded_count, source_degraded_count,
           source_no_support_count, source_not_evaluated_count, source_credible_opportunity,
           source_evidence_strength, published_source_member_count,
           published_source_grounded_count, published_source_degraded_count,
           published_source_no_support_count, published_source_not_evaluated_count,
           published_source_credible_opportunity, published_source_evidence_strength,
           analysis_mode, publish_state, state, label, description, suggested_title,
           rationale, questions_to_answer, suggested_shape, evidence_statement,
           action_rule_version, corpus_state, enriched_at
         ) VALUES (
           $1, $2, $3, 1, $4, 0, 0, $4, 0, TRUE, 'low', $4, 0, 0, $4, 0,
           TRUE, 'low', $5, $6, $6, 'Topic', 'Topic questions', $7, $8, $9::jsonb,
           $10, $11, 1, 'ready', NOW()
         )`,
        [
          workspaceId,
          generationId,
          topicId,
          memberCount,
          carriesBrief ? "label_and_brief" : "label_only",
          carriesBrief ? "ready" : "outside_analysis_cap",
          carriesBrief ? `Guide ${index}` : null,
          carriesBrief ? "Repeated unsupported questions." : null,
          carriesBrief ? JSON.stringify(["One?", "Two?", "Three?"]) : null,
          carriesBrief ? "guide" : null,
          carriesBrief ? "Based on repeated questions." : null,
        ],
      );
    }

    const observationFixtures = [
      {
        id: visibleObservationId,
        conversationId: randomUUID(),
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        assignedAt: new Date("2026-07-20T10:00:00.000Z"),
        hash: "a".repeat(64),
      },
      {
        id: futureAssignmentObservationId,
        conversationId: randomUUID(),
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        assignedAt: new Date("2026-08-03T10:00:00.000Z"),
        hash: "b".repeat(64),
      },
    ];
    for (const observation of observationFixtures) {
      await database.execute(
        "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
        [observation.conversationId, workspaceId],
      );
      await database.execute(
        `INSERT INTO messages (id, conversation_id, workspace_id, role, content, metadata_json)
         VALUES
           ($1, $3, $4, 'user', 'Question', '{}'::jsonb),
           ($2, $3, $4, 'assistant', 'Answer', '{}'::jsonb)`,
        [
          observation.userMessageId,
          observation.assistantMessageId,
          observation.conversationId,
          workspaceId,
        ],
      );
      await database.execute(
        `INSERT INTO content_plan_observations (
           id, workspace_id, source_user_message_id, source_assistant_message_id,
           conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
           observation_state, observed_at
         ) VALUES ($1, $2, $3, $4, $5, 'primary', $6, 'substantive_new', 'ready', $7)`,
        [
          observation.id,
          workspaceId,
          observation.userMessageId,
          observation.assistantMessageId,
          observation.conversationId,
          observation.hash,
          new Date("2026-07-20T10:00:00.000Z"),
        ],
      );
      await database.execute(
        `INSERT INTO content_plan_observation_vectors (
           workspace_id, observation_id, generation_id, embedding_space_id,
           dimensions, embedding, vector_source, state, completed_at
         ) VALUES ($1, $2, $3, $4, 3, '[1,0,0]'::vector, 'reused', 'assigned', $5)`,
        [workspaceId, observation.id, generationId, embeddingSpaceId, observation.assignedAt],
      );
      await database.execute(
        `INSERT INTO content_plan_topic_memberships (
           workspace_id, generation_id, observation_id, topic_id,
           assignment_version, similarity, cohesion, assigned_at
         ) VALUES ($1, $2, $3, $4, 1, 0.9, 0.9, $5)`,
        [workspaceId, generationId, observation.id, topicIds[0], observation.assignedAt],
      );
    }
  });

  afterAll(async () => {
    await database.execute("DELETE FROM accounts WHERE id = $1", [accountId]);
    await database.close();
  });

  it("loads a hot dirty batch plus only the persisted cap frontier", async () => {
    const source = new PostgresContentPlanEnrichmentPlanningDataSource(database.kysely);

    const result = await source.loadData({
      workspaceId,
      generationId,
      window: { from: "2026-06-01T00:00:00.000Z", to: "2026-08-02T12:00:00.000Z" },
      dirtyTopicIds: [topicIds[60]!],
      repair: null,
    });

    expect(result.topics.map((topic) => topic.id)).toContain(topicIds[60]);
    expect(result.topics.length).toBeLessThanOrEqual(22);
    expect(result.topics.length).toBeLessThan(130);
    expect(result.repairCheckpoint).toBeNull();
    await expect(source.pageObservations({
      workspaceId,
      generationId,
      window: { from: "2026-06-01T00:00:00.000Z", to: "2026-08-02T12:00:00.000Z" },
      topicIds: [topicIds[60]!],
      cursor: null,
      limit: 500,
    })).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("excludes memberships assigned after the planning snapshot", async () => {
    const source = new PostgresContentPlanEnrichmentPlanningDataSource(database.kysely);

    const page = await source.pageObservations({
      workspaceId,
      generationId,
      window: { from: "2026-06-01T00:00:00.000Z", to: "2026-08-02T12:00:00.000Z" },
      topicIds: [topicIds[0]!],
      cursor: null,
      limit: 500,
    });

    expect(page.items.map((item) => item.id)).toEqual([visibleObservationId]);
    expect(page.items.map((item) => item.id)).not.toContain(futureAssignmentObservationId);
  });

  it("pages exact repair candidates without widening a page to the whole workspace", async () => {
    const source = new PostgresContentPlanEnrichmentPlanningDataSource(database.kysely);
    const first = await source.loadData({
      workspaceId,
      generationId,
      window: { from: "2026-06-01T00:00:00.000Z", to: "2026-08-02T12:00:00.000Z" },
      dirtyTopicIds: [],
      repair: { limit: 100 },
    });
    expect(first.repairCheckpoint?.nextTopicId).not.toBeNull();
    expect(first.topics.length).toBeLessThanOrEqual(121);
    await expect(source.completeRepairPage({
      workspaceId,
      generationId,
      checkpoint: first.repairCheckpoint!,
    })).resolves.toBe(true);

    const restartedSource = new PostgresContentPlanEnrichmentPlanningDataSource(database.kysely);
    const second = await restartedSource.loadData({
      workspaceId,
      generationId,
      window: { from: "2026-06-01T00:00:00.000Z", to: "2026-08-02T12:00:00.000Z" },
      dirtyTopicIds: [],
      repair: { limit: 100 },
    });
    expect(second.topics.length).toBeLessThanOrEqual(51);
  });
});
