import { randomUUID } from "node:crypto";

import type { CompiledQuery, QueryResult } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { ContentPlanCursorCodec } from "../../src/modules/contentPlanning/services/contentPlanCursor.js";
import { ContentPlanReadService } from "../../src/modules/contentPlanning/services/contentPlanReadService.js";
import { PostgresContentPlanReadSource } from "../../src/modules/contentPlanning/infra/contentPlanReadSource.js";
import { contentPlanDetailSchema, contentPlanPageSchema } from "../../src/modules/contentPlanning/contracts/index.js";
import { QualityContentPlanningEvidenceSource } from "../../src/modules/quality/contentPlanningEvidence.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const AS_OF = new Date("2026-08-02T12:00:00.000Z");

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

interface Fixture {
  workspaceId: string;
  foreignWorkspaceId: string;
  generationId: string;
  opportunityTopicId: string;
  healthyTopicId: string;
  mergedTopicId: string;
  expiredMergedTopicId: string;
  retiredTopicId: string;
  opportunityAssistantMessageIds: string[];
  healthyAssistantMessageId: string;
}

class CountingDb {
  count = 0;

  constructor(private readonly database: Database) {}

  async executeQuery<R>(query: CompiledQuery<unknown>): Promise<QueryResult<R>> {
    this.count += 1;
    return this.database.kysely.executeQuery(query) as Promise<QueryResult<R>>;
  }
}

describeIfDatabase("Content Planning read model", () => {
  const databaseName = `content_plan_read_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;
  let fixture: Fixture;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runAllTestMigrations(database);
    fixture = await seedFixture(database);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin
      ?.execute(`DROP DATABASE IF EXISTS "${databaseName}"`)
      .catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  const createService = (countingDb = new CountingDb(database)) => ({
    countingDb,
    service: new ContentPlanReadService({
      source: new PostgresContentPlanReadSource(countingDb as never),
      qualityEvidence: new QualityContentPlanningEvidenceSource(countingDb as never),
      cursorCodec: new ContentPlanCursorCodec("content-plan-read-test-secret"),
      now: () => new Date(AS_OF),
    }),
  });

  it("derives exact current/comparison evidence, opportunity order, and response states without N+1 reads", async () => {
    const { countingDb, service } = createService();

    const page = await service.list(fixture.workspaceId, {
      view: "all_interests",
      limit: 25,
    });

    expect(contentPlanPageSchema.safeParse(page).success).toBe(true);
    expect(page.summary).toMatchObject({
      questionCount: 5,
      conversationCount: 5,
      matureTopicCount: 2,
      opportunityCount: 1,
      grounding: {
        evaluatedAnswerCount: 4,
        groundedAnswerCount: 1,
        degradedAnswerCount: 1,
        noSupportAnswerCount: 2,
        notEvaluatedAnswerCount: 1,
        reducedOrNoSupportRate: 0.75,
        headlineState: "insufficient_measured_turns",
      },
    });
    expect(page.items.map(({ id }) => id)).toEqual([
      fixture.opportunityTopicId,
      fixture.healthyTopicId,
    ]);
    expect(page.recommendedTopicId).toBe(fixture.opportunityTopicId);
    expect(page.items[0]).toMatchObject({
      label: "Enterprise access",
      demand: {
        currentQuestionCount: 2,
        comparisonQuestionCount: 1,
        currentConversationCount: 2,
        comparisonConversationCount: 1,
        trend: "steady",
      },
      grounding: {
        degradedAnswerCount: 1,
        noSupportAnswerCount: 1,
      },
      evidence: {
        activeGapConversationCount: 2,
      },
      opportunity: {
        credible: true,
        priorityReasons: ["active_no_support", "active_degraded"],
      },
      recommendation: {
        action: "investigate_retrieval",
        factsMustBeVerified: true,
      },
      corpusEvidence: { state: "ready", relatedDocumentCount: 1, actionRuleVersion: 1 },
      affected: { agentCount: 2, channelCount: 2 },
    });
    expect(page.emerging.map(({ state }) => state).sort()).toEqual([
      "awaiting_context",
      "awaiting_embedding",
      "emerging",
    ]);
    expect(page.summary.emergingQuestionCount).toBe(page.emerging.length);
    expect(page.projection).toMatchObject({
      state: "updating",
      pendingEmbeddingCount: 1,
      pendingAssignmentCount: 0,
      pendingEnrichmentTopicCount: 1,
      embeddingSpaceFingerprint: "content-plan-read-space",
    });
    expect(countingDb.count).toBeLessThanOrEqual(6);
  });

  it("counts a ready enrichment with an obsolete source revision as pending", async () => {
    const topicId = randomUUID();
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision,
         created_at, updated_at
       )
       SELECT $1, $2, $3, embedding_space_id, 'mature', '[0,0,1]'::vector,
         3, 0, '{}'::uuid[], 1, $4, $4
       FROM content_plan_projection_generations
       WHERE workspace_id = $1 AND id = $2`,
      [fixture.workspaceId, fixture.generationId, topicId, new Date(AS_OF.getTime() - 1_000)],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_enrichments (
         workspace_id, generation_id, topic_id, source_topic_revision,
         action_rule_version, state, label, description, enriched_at
       ) VALUES ($1, $2, $3, 1, 1, 'ready', 'Revision test', 'Revision test topic', $4)`,
      [fixture.workspaceId, fixture.generationId, topicId, new Date(AS_OF.getTime() - 1_000)],
    );
    const source = new PostgresContentPlanReadSource(database.kysely);

    expect((await source.getProjection(fixture.workspaceId))?.pendingEnrichmentTopicCount).toBe(1);
    await database.execute(
      `UPDATE content_plan_topics
       SET revision = revision + 1
       WHERE workspace_id = $1 AND generation_id = $2 AND id = $3`,
      [fixture.workspaceId, fixture.generationId, topicId],
    );
    expect((await source.getProjection(fixture.workspaceId))?.pendingEnrichmentTopicCount).toBe(2);

    await database.execute(
      `DELETE FROM content_plan_topics
       WHERE workspace_id = $1 AND generation_id = $2 AND id = $3`,
      [fixture.workspaceId, fixture.generationId, topicId],
    );
  });

  it("freezes asOf and ordering in the signed cursor while ignoring changes after the frozen window", async () => {
    const { service } = createService();
    const delayedConversationId = randomUUID();
    const delayedUserMessageId = randomUUID();
    const delayedAssistantMessageId = randomUUID();
    const delayedObservationId = randomUUID();
    const delayedTopicId = randomUUID();
    await database.execute(
      `INSERT INTO conversations (id, workspace_id, source_channel, created_at, updated_at)
       VALUES ($1, $2, 'embed', $3, $3)`,
      [delayedConversationId, fixture.workspaceId, new Date(AS_OF.getTime() - 300_000)],
    );
    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES
         ($1, $3, $4, 'user', 'Delayed assignment question', $5),
         ($2, $3, $4, 'assistant', 'Delayed assignment answer', $5 + INTERVAL '1 second')`,
      [
        delayedUserMessageId,
        delayedAssistantMessageId,
        delayedConversationId,
        fixture.workspaceId,
        new Date(AS_OF.getTime() - 300_000),
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_observations (
         id, workspace_id, source_user_message_id, source_assistant_message_id,
         conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
         observation_state, observed_at
       ) VALUES ($1, $2, $3, $4, $5, 'delayed-assignment', $6, 'substantive_new', 'ready', $7)`,
      [
        delayedObservationId,
        fixture.workspaceId,
        delayedUserMessageId,
        delayedAssistantMessageId,
        delayedConversationId,
        "e".repeat(64),
        new Date(AS_OF.getTime() - 299_000),
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id,
         dimensions, embedding, vector_source, state, completed_at
       )
       SELECT $1, $2, $3, embedding_space_id, 3, '[0,1,0]'::vector, 'reused', 'assigned', $4
       FROM content_plan_projection_generations
       WHERE workspace_id = $1 AND id = $3`,
      [fixture.workspaceId, delayedObservationId, fixture.generationId, AS_OF],
    );
    const first = await service.list(fixture.workspaceId, {
      view: "all_interests",
      limit: 1,
    });
    expect(first.items.map(({ id }) => id)).toEqual([fixture.opportunityTopicId]);
    expect(first.nextCursor).not.toBeNull();

    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision,
         created_at, updated_at
       )
       SELECT $1, $2, $3, embedding_space_id, 'mature', '[0,0,1]'::vector,
         3, 0, '{}'::uuid[], 1, $4, $4
       FROM content_plan_projection_generations
       WHERE workspace_id = $1 AND id = $2`,
      [fixture.workspaceId, fixture.generationId, delayedTopicId, new Date(AS_OF.getTime() + 1_000)],
    );

    await database.execute(
      `INSERT INTO content_plan_topic_memberships (
         workspace_id, generation_id, observation_id, topic_id,
         assignment_version, similarity, cohesion, assigned_at
       ) VALUES ($1, $2, $3, $4, 1, 0.94, 0.9, $5)`,
      [
        fixture.workspaceId,
        fixture.generationId,
        delayedObservationId,
        fixture.healthyTopicId,
        new Date(AS_OF.getTime() + 1_000),
      ],
    );

    const second = await service.list(fixture.workspaceId, {
      view: "all_interests",
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(second.asOf).toBe(first.asOf);
    expect(second.window).toEqual(first.window);
    expect(second.items.map(({ id }) => id)).toEqual([fixture.healthyTopicId]);
    expect(second.items[0]?.demand.currentQuestionCount).toBe(1);
    expect(second.recommendedTopicId).toBeNull();
    expect(second.nextCursor).toBeNull();

    await expect(service.list(fixture.workspaceId, {
      view: "opportunities",
      cursor: first.nextCursor!,
      limit: 1,
    })).rejects.toThrow(/content plan cursor/i);
  });

  it("invalidates a page cursor when Quality evidence changes the ranked snapshot", async () => {
    const { service } = createService();
    const first = await service.list(fixture.workspaceId, {
      view: "all_interests",
      limit: 1,
    });
    expect(first.nextCursor).not.toBeNull();

    try {
      await database.execute(
        `UPDATE messages
         SET grounding_verdict = 'no_support',
             grounding_claim_count = 1,
             grounding_sourced_claim_count = 0,
             grounding_unsourced_claim_count = 1,
             grounding_invalid_source_count = 0
         WHERE workspace_id = $1 AND id = $2`,
        [fixture.workspaceId, fixture.healthyAssistantMessageId],
      );

      await expect(service.list(fixture.workspaceId, {
        view: "all_interests",
        cursor: first.nextCursor!,
        limit: 1,
      })).rejects.toThrow(/changed while paging/i);
    } finally {
      await database.execute(
        `UPDATE messages
         SET grounding_verdict = 'grounded',
             grounding_claim_count = 1,
             grounding_sourced_claim_count = 1,
             grounding_unsourced_claim_count = 0,
             grounding_invalid_source_count = 0
         WHERE workspace_id = $1 AND id = $2`,
        [fixture.workspaceId, fixture.healthyAssistantMessageId],
      );
    }
  });

  it("resolves live merged IDs canonically and keeps foreign, retired, and expired IDs indistinguishable", async () => {
    const { service } = createService();
    const detail = await service.getTopic(fixture.workspaceId, fixture.mergedTopicId);

    expect(detail).not.toBeNull();
    expect(contentPlanDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({
      canonicalTopicId: fixture.opportunityTopicId,
      redirectedFromTopicId: fixture.mergedTopicId,
      topic: { id: fixture.opportunityTopicId },
      decision: { action: "investigate_retrieval", actionState: "ready" },
    });
    expect(detail?.representativeQuestions).toHaveLength(2);
    expect(detail?.relatedDocuments).toEqual([
      expect.objectContaining({
        title: "Enterprise SSO guide",
        possibleRelevance: 0.91,
        evidence: expect.objectContaining({ existedBeforeGap: true }),
      }),
    ]);
    expect(detail?.affectedAgents).toHaveLength(2);
    expect(detail?.affectedChannels).toHaveLength(2);

    await expect(Promise.all([
      service.getTopic(fixture.workspaceId, fixture.expiredMergedTopicId),
      service.getTopic(fixture.workspaceId, fixture.retiredTopicId),
      service.getTopic(fixture.workspaceId, randomUUID()),
      service.getTopic(fixture.foreignWorkspaceId, fixture.opportunityTopicId),
    ])).resolves.toEqual([null, null, null, null]);
  });

  it("reuses the Quality turn DTO, deduplicates semantic intents, and applies canonical population filtering", async () => {
    const { service } = createService();
    const current = await service.listTopicTurns(
      fixture.workspaceId,
      fixture.mergedTopicId,
      { window: "current", page: 1, pageSize: 25 },
    );

    expect(current).not.toBeNull();
    expect(current).toMatchObject({ total: 2, page: 1, pageSize: 25, totalPages: 1 });
    expect(current?.items.map(({ assistantMessageId }) => assistantMessageId).sort()).toEqual(
      [...fixture.opportunityAssistantMessageIds].sort(),
    );
    expect(current?.items[0]).toEqual(expect.objectContaining({
      question: expect.any(String),
      answerPreview: expect.any(String),
      grounding: expect.objectContaining({ verdict: expect.stringMatching(/degraded|no_support/) }),
      triage: expect.objectContaining({ state: expect.stringMatching(/open|acknowledged/) }),
      verification: null,
    }));

    await expect(service.listTopicTurns(
      fixture.foreignWorkspaceId,
      fixture.opportunityTopicId,
      { window: "current", page: 1, pageSize: 25 },
    )).resolves.toBeNull();
  });

  it("paginates a high-cardinality topic in SQL and hydrates only the selected Quality page", async () => {
    const memberCount = 1_200;
    await seedHighCardinalityTopicMembers(database, fixture, memberCount);
    const countingDb = new CountingDb(database);
    const verificationSource = {
      getByAssistantMessageIds: vi.fn(async (
        _workspaceId: string,
        _assistantMessageIds: string[],
      ) => new Map()),
    };
    const service = new ContentPlanReadService({
      source: new PostgresContentPlanReadSource(countingDb as never),
      qualityEvidence: new QualityContentPlanningEvidenceSource(
        countingDb as never,
        verificationSource,
      ),
      cursorCodec: new ContentPlanCursorCodec("content-plan-read-test-secret"),
      now: () => new Date(AS_OF),
    });
    const startedAt = performance.now();

    const page = await service.listTopicTurns(
      fixture.workspaceId,
      fixture.opportunityTopicId,
      { window: "current", page: 1, pageSize: 25 },
    );
    const elapsedMs = performance.now() - startedAt;

    expect(page).toMatchObject({
      total: memberCount + fixture.opportunityAssistantMessageIds.length,
      page: 1,
      pageSize: 25,
      totalPages: Math.ceil((memberCount + fixture.opportunityAssistantMessageIds.length) / 25),
    });
    expect(page?.items).toHaveLength(25);
    const verificationBatchSizes = verificationSource.getByAssistantMessageIds.mock.calls
      .map(([, assistantMessageIds]) => assistantMessageIds.length);
    expect(verificationBatchSizes).toEqual([25]);
    expect(countingDb.count).toBeLessThanOrEqual(6);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

const seedHighCardinalityTopicMembers = async (
  database: Database,
  fixture: Fixture,
  count: number,
): Promise<void> => {
  await database.execute(
    `INSERT INTO conversations (id, workspace_id, source_channel, created_at, updated_at)
     SELECT
       md5($1::text || ':high-cardinality:conversation:' || member::text)::uuid,
       $1::uuid,
       'embed',
       $3::timestamptz - make_interval(secs => member * 2),
       $3::timestamptz - make_interval(secs => member * 2)
     FROM generate_series(1, $2::int) AS member`,
    [fixture.workspaceId, count, AS_OF],
  );
  await database.execute(
    `INSERT INTO messages (
       id, conversation_id, workspace_id, role, content, metadata_json, created_at
     )
     SELECT
       md5($1::text || ':high-cardinality:user:' || member::text)::uuid,
       md5($1::text || ':high-cardinality:conversation:' || member::text)::uuid,
       $1::uuid,
       'user',
       'High-cardinality source question ' || member::text,
       '{}'::jsonb,
       $3::timestamptz - make_interval(secs => member * 2 + 1)
     FROM generate_series(1, $2::int) AS member
     UNION ALL
     SELECT
       md5($1::text || ':high-cardinality:assistant:' || member::text)::uuid,
       md5($1::text || ':high-cardinality:conversation:' || member::text)::uuid,
       $1::uuid,
       'assistant',
       'High-cardinality answer ' || member::text,
       '{}'::jsonb,
       $3::timestamptz - make_interval(secs => member * 2)
     FROM generate_series(1, $2::int) AS member`,
    [fixture.workspaceId, count, AS_OF],
  );
  await database.execute(
    `INSERT INTO content_plan_observations (
       id, workspace_id, source_user_message_id, source_assistant_message_id,
       conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
       observation_state, observed_at
     )
     SELECT
       md5($1::text || ':high-cardinality:observation:' || member::text)::uuid,
       $1::uuid,
       md5($1::text || ':high-cardinality:user:' || member::text)::uuid,
       md5($1::text || ':high-cardinality:assistant:' || member::text)::uuid,
       md5($1::text || ':high-cardinality:conversation:' || member::text)::uuid,
       'high-cardinality-' || member::text,
       repeat('a', 64),
       'substantive_new',
       'ready',
       $3::timestamptz - make_interval(secs => member * 2)
     FROM generate_series(1, $2::int) AS member`,
    [fixture.workspaceId, count, AS_OF],
  );
  await database.execute(
    `INSERT INTO content_plan_observation_vectors (
       workspace_id, observation_id, generation_id, embedding_space_id,
       dimensions, embedding, vector_source, state, completed_at
     )
     SELECT
       $1::uuid,
       md5($1::text || ':high-cardinality:observation:' || member::text)::uuid,
       $2::uuid,
       generation.embedding_space_id,
       3,
       '[1,0,0]'::vector,
       'reused',
       'assigned',
       $4::timestamptz
     FROM generate_series(1, $3::int) AS member
     CROSS JOIN content_plan_projection_generations generation
     WHERE generation.workspace_id = $1::uuid AND generation.id = $2::uuid`,
    [fixture.workspaceId, fixture.generationId, count, AS_OF],
  );
  await database.execute(
    `INSERT INTO content_plan_topic_memberships (
       workspace_id, generation_id, observation_id, topic_id,
       assignment_version, similarity, cohesion, assigned_at
     )
     SELECT
       $1::uuid,
       $2::uuid,
       md5($1::text || ':high-cardinality:observation:' || member::text)::uuid,
       $5::uuid,
       1,
       0.95,
       0.9,
       $4::timestamptz - INTERVAL '1 millisecond'
     FROM generate_series(1, $3::int) AS member`,
    [fixture.workspaceId, fixture.generationId, count, AS_OF, fixture.opportunityTopicId],
  );
};

const seedFixture = async (database: Database): Promise<Fixture> => {
  const accountId = randomUUID();
  const foreignAccountId = randomUUID();
  const workspaceId = randomUUID();
  const foreignWorkspaceId = randomUUID();
  const firstAgentId = randomUUID();
  const secondAgentId = randomUUID();
  const spaceId = randomUUID();
  const foreignSpaceId = randomUUID();
  const generationId = randomUUID();
  const foreignGenerationId = randomUUID();
  const opportunityTopicId = randomUUID();
  const healthyTopicId = randomUUID();
  const provisionalTopicId = randomUUID();
  const mergedTopicId = randomUUID();
  const expiredMergedTopicId = randomUUID();
  const retiredTopicId = randomUUID();

  await database.query(
    `INSERT INTO accounts (id, name, email, password_hash) VALUES
       ($1, 'Content Plan Read', $2, 'hash'),
       ($3, 'Foreign Content Plan Read', $4, 'hash')`,
    [accountId, `content-read-${accountId}@example.com`, foreignAccountId, `content-read-${foreignAccountId}@example.com`],
  );
  await database.query(
    `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES
       ($1, $2, 'Content Plan Read', $3),
       ($4, $5, 'Foreign Content Plan Read', $6)`,
    [workspaceId, accountId, `content-read-${workspaceId}`, foreignWorkspaceId, foreignAccountId, `content-read-${foreignWorkspaceId}`],
  );
  await database.query(
    `INSERT INTO agents (id, workspace_id, name) VALUES
       ($1, $3, 'Primary agent'), ($2, $3, 'Secondary agent')`,
    [firstAgentId, secondAgentId, workspaceId],
  );
  await database.query(
    `INSERT INTO embedding_spaces (
       id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
       dimensions, distance_metric, normalization
     ) VALUES
       ($1, 'content-plan-read-space', 'test', 'read-endpoint', 'read-model', 3, 'cosine', 'unit'),
       ($2, 'content-plan-foreign-space', 'test', 'foreign-endpoint', 'foreign-model', 3, 'cosine', 'unit')`,
    [spaceId, foreignSpaceId],
  );
  await database.query(
    `INSERT INTO content_plan_projection_generations (
       id, workspace_id, embedding_space_id, kind, state, policy_version,
       horizon_from, horizon_to, coherent_at
     ) VALUES
       ($1, $2, $3, 'active', 'coherent', 1, '2026-06-03T12:00:00Z', $7, $7),
       ($4, $5, $6, 'active', 'coherent', 1, '2026-06-03T12:00:00Z', $7, $7)`,
    [generationId, workspaceId, spaceId, foreignGenerationId, foreignWorkspaceId, foreignSpaceId, AS_OF.toISOString()],
  );
  await database.query(
    `INSERT INTO content_plan_projection_states (
       workspace_id, coherent_generation_id, projection_state, processed_through,
       budget_version, budget_window_started_at
     ) VALUES
       ($1, $2, 'updating', '2026-08-02T11:59:00Z', 1, '2026-08-02T00:00:00Z'),
       ($3, $4, 'ready', '2026-08-02T12:00:00Z', 1, '2026-08-02T00:00:00Z')`,
    [workspaceId, generationId, foreignWorkspaceId, foreignGenerationId],
  );
  await database.query(
    `INSERT INTO content_plan_topics (
       workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
       dimensions, centroid_weight, representative_observation_ids, revision,
       merged_into_topic_id, redirect_expires_at, created_at, updated_at
     ) VALUES
       ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 4, '{}'::uuid[], 1, NULL, NULL, '2026-08-02T10:00:00Z', '2026-08-02T10:00:00Z'),
       ($1, $2, $5, $4, 'mature', '[0,1,0]'::vector, 3, 1, '{}'::uuid[], 1, NULL, NULL, '2026-08-02T09:00:00Z', '2026-08-02T09:00:00Z'),
       ($1, $2, $6, $4, 'provisional', '[0,0,1]'::vector, 3, 1, '{}'::uuid[], 1, NULL, NULL, '2026-08-02T08:00:00Z', '2026-08-02T08:00:00Z'),
       ($1, $2, $7, $4, 'merged', '[1,0,0]'::vector, 3, 0, '{}'::uuid[], 1, $3, '2026-12-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
       ($1, $2, $8, $4, 'merged', '[1,0,0]'::vector, 3, 0, '{}'::uuid[], 1, $3, '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'),
       ($1, $2, $9, $4, 'retired', '[1,0,0]'::vector, 3, 0, '{}'::uuid[], 1, NULL, NULL, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
    [workspaceId, generationId, opportunityTopicId, spaceId, healthyTopicId, provisionalTopicId, mergedTopicId, expiredMergedTopicId, retiredTopicId],
  );

  type Turn = {
    userId: string;
    assistantId: string;
    conversationId: string;
    agentId: string;
    channel: string;
    question: string;
    verdict: "grounded" | "degraded" | "no_support" | null;
    at: string;
    source?: string | null;
  };
  const turns: Record<string, Turn> = {
    gapOne: { userId: randomUUID(), assistantId: randomUUID(), conversationId: randomUUID(), agentId: firstAgentId, channel: "embed", question: "How do we configure enterprise SSO?", verdict: "no_support", at: "2026-07-20T10:00:00Z" },
    gapTwo: { userId: randomUUID(), assistantId: randomUUID(), conversationId: randomUUID(), agentId: secondAgentId, channel: "api", question: "Can SCIM groups control enterprise access?", verdict: "degraded", at: "2026-07-21T10:00:00Z" },
    healthy: { userId: randomUUID(), assistantId: randomUUID(), conversationId: randomUUID(), agentId: firstAgentId, channel: "embed", question: "Where can I download invoices?", verdict: "grounded", at: "2026-07-22T10:00:00Z" },
    provisional: { userId: randomUUID(), assistantId: randomUUID(), conversationId: randomUUID(), agentId: firstAgentId, channel: "embed", question: "Do you support regional data residency?", verdict: "no_support", at: "2026-07-23T10:00:00Z" },
    awaitingEmbedding: { userId: randomUUID(), assistantId: randomUUID(), conversationId: randomUUID(), agentId: firstAgentId, channel: "embed", question: "How are audit exports retained?", verdict: null, at: "2026-07-24T10:00:00Z" },
    awaitingContext: { userId: randomUUID(), assistantId: randomUUID(), conversationId: randomUUID(), agentId: firstAgentId, channel: "embed", question: "yes", verdict: null, at: "2026-07-25T10:00:00Z" },
    comparison: { userId: randomUUID(), assistantId: randomUUID(), conversationId: randomUUID(), agentId: firstAgentId, channel: "embed", question: "How does SAML access work?", verdict: "grounded", at: "2026-06-20T10:00:00Z" },
    operatorTest: { userId: randomUUID(), assistantId: randomUUID(), conversationId: randomUUID(), agentId: firstAgentId, channel: "authenticated_chat", question: "Test enterprise access", verdict: "no_support", at: "2026-07-26T10:00:00Z" },
  };

  for (const turn of Object.values(turns)) {
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, $4)`,
      [turn.conversationId, workspaceId, turn.agentId, turn.channel],
    );
    const grounding = turn.verdict === null
      ? [null, null, null, null, null]
      : turn.verdict === "grounded"
        ? [turn.verdict, 1, 1, 0, 0]
        : [turn.verdict, 1, 0, 1, 0];
    await database.query(
      `INSERT INTO messages (
         id, conversation_id, workspace_id, role, content, source, created_at,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count
       ) VALUES
         ($1, $3, $4, 'user', $5, NULL, $7::timestamptz, NULL, NULL, NULL, NULL, NULL),
         ($2, $3, $4, 'assistant', $6, $8, $7::timestamptz + interval '1 second', $9, $10, $11, $12, $13)`,
      [
        turn.userId,
        turn.assistantId,
        turn.conversationId,
        workspaceId,
        turn.question,
        `Answer to: ${turn.question}`,
        turn.at,
        turn.source ?? null,
        ...grounding,
      ],
    );
  }

  await database.query(
    `INSERT INTO assistant_answer_triage (
       workspace_id, assistant_message_id, state, version, resolution_reason, closed_at, updated_at
     ) VALUES ($1, $2, 'resolved', 1, 'knowledge_gap', $3, $3)`,
    [workspaceId, turns.gapOne!.assistantId, "2026-07-20T11:00:00Z"],
  );
  await database.query(
    `INSERT INTO assistant_answer_feedback (
       id, workspace_id, conversation_id, assistant_message_id,
       actor_type, actor_id, value, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'authenticated_user', 'operator', 'down', $5, $5)`,
    [randomUUID(), workspaceId, turns.gapOne!.conversationId, turns.gapOne!.assistantId, "2026-07-20T12:00:00Z"],
  );
  await database.query(
    `INSERT INTO assistant_answer_triage (
       workspace_id, assistant_message_id, state, version, updated_at
     ) VALUES ($1, $2, 'acknowledged', 1, '2026-07-21T11:00:00Z')`,
    [workspaceId, turns.gapTwo!.assistantId],
  );

  const observationByName = new Map<string, string>();
  const insertObservation = async (name: string, turn: Turn, input: {
    state?: "ready" | "pending_context";
    topicId?: string;
    semanticIntentId?: string;
  } = {}) => {
    const observationId = randomUUID();
    observationByName.set(name, observationId);
    const state = input.state ?? "ready";
    await database.query(
      `INSERT INTO content_plan_observations (
         id, workspace_id, source_user_message_id, source_assistant_message_id,
         conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count,
         resolution_deadline, observation_state, observed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13,
         $14, $15, $16
       )`,
      [
        observationId,
        workspaceId,
        turn.userId,
        turn.assistantId,
        turn.conversationId,
        input.semanticIntentId ?? "primary",
        state === "ready" ? "a".repeat(64) : null,
        state === "pending_context" ? "unresolved" : "substantive_new",
        turn.verdict,
        turn.verdict === null ? null : 1,
        turn.verdict === "grounded" ? 1 : turn.verdict === null ? null : 0,
        turn.verdict === "grounded" ? 0 : turn.verdict === null ? null : 1,
        turn.verdict === null ? null : 0,
        state === "pending_context" ? "2026-07-25T10:05:00Z" : null,
        state,
        turn.at,
      ],
    );
    if (state === "ready") {
      const assigned = input.topicId !== undefined;
      await database.query(
        `INSERT INTO content_plan_observation_vectors (
           workspace_id, observation_id, generation_id, embedding_space_id,
           dimensions, embedding, vector_source, state, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9)`,
        assigned
          ? [workspaceId, observationId, generationId, spaceId, 3, "[1,0,0]", "reused", "assigned", turn.at]
          : [workspaceId, observationId, generationId, spaceId, null, null, null, "pending_embedding", null],
      );
      if (input.topicId) {
        await database.query(
          `INSERT INTO content_plan_topic_memberships (
             workspace_id, generation_id, observation_id, topic_id,
             assignment_version, similarity, cohesion, assigned_at
           ) VALUES ($1, $2, $3, $4, 1, 0.9, 0.88, $5)`,
          [workspaceId, generationId, observationId, input.topicId, turn.at],
        );
      }
    }
    return observationId;
  };

  const gapOnePrimary = await insertObservation("gapOnePrimary", turns.gapOne!, { topicId: opportunityTopicId });
  await insertObservation("gapOneSecondIntent", turns.gapOne!, {
    topicId: opportunityTopicId,
    semanticIntentId: "subquery_2",
  });
  const gapTwo = await insertObservation("gapTwo", turns.gapTwo!, { topicId: opportunityTopicId });
  await insertObservation("healthy", turns.healthy!, { topicId: healthyTopicId });
  const provisional = await insertObservation("provisional", turns.provisional!, { topicId: provisionalTopicId });
  await insertObservation("awaitingEmbedding", turns.awaitingEmbedding!);
  await insertObservation("awaitingContext", turns.awaitingContext!, { state: "pending_context" });
  await insertObservation("comparison", turns.comparison!, { topicId: opportunityTopicId });
  await insertObservation("operatorTest", turns.operatorTest!, { topicId: opportunityTopicId });

  await database.query(
    `UPDATE content_plan_topics
     SET representative_observation_ids = CASE id
       WHEN $3::uuid THEN ARRAY[$4::uuid, $5::uuid]
       WHEN $6::uuid THEN ARRAY[$7::uuid]
       ELSE representative_observation_ids
     END
     WHERE workspace_id = $1 AND generation_id = $2 AND id IN ($3, $6)`,
    [workspaceId, generationId, opportunityTopicId, gapOnePrimary, gapTwo, provisionalTopicId, provisional],
  );

  await database.query(
    `INSERT INTO content_plan_topic_enrichments (
       workspace_id, generation_id, topic_id, source_topic_revision, state,
       label, description, suggested_title, rationale, questions_to_answer,
       suggested_shape, evidence_statement, action, action_rule_version,
       corpus_state, corpus_checked_at, enriched_at
     ) VALUES (
       $1, $2, $3, 1, 'ready', 'Enterprise access',
       'Questions about SSO, SCIM, and enterprise access controls.',
       'Enterprise access setup', 'Visitors cannot reliably configure enterprise access.',
       $4::jsonb, 'guide', 'Based on two current visitor conversations.',
       'investigate_retrieval', 1, 'ready', '2026-08-02T09:00:00Z', '2026-08-02T09:00:00Z'
     )`,
    [workspaceId, generationId, opportunityTopicId, JSON.stringify([
      "How should SSO be configured?",
      "How do SCIM groups map to access?",
      "Which enterprise identity providers are supported?",
    ])],
  );

  const documentId = randomUUID();
  await database.query(
    `INSERT INTO documents (
       id, workspace_id, title, source_content, markdown_content, status, revision,
       metadata, created_at, updated_at
     ) VALUES (
       $1, $2, 'Enterprise SSO guide', 'source', 'markdown', 'ready', 1, '{}',
       '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'
     )`,
    [documentId, workspaceId],
  );
  await database.query(
    `INSERT INTO content_plan_topic_documents (
       workspace_id, generation_id, topic_id, document_id, source_topic_revision,
       similarity, existed_before_gap, retrieved_by_gap_answers,
       cited_by_gap_answers, changed_after_gap
     ) VALUES ($1, $2, $3, $4, 1, 0.91, TRUE, FALSE, FALSE, FALSE)`,
    [workspaceId, generationId, opportunityTopicId, documentId],
  );

  return {
    workspaceId,
    foreignWorkspaceId,
    generationId,
    opportunityTopicId,
    healthyTopicId,
    mergedTopicId,
    expiredMergedTopicId,
    retiredTopicId,
    opportunityAssistantMessageIds: [turns.gapOne!.assistantId, turns.gapTwo!.assistantId],
    healthyAssistantMessageId: turns.healthy!.assistantId,
  };
};
