import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { CompiledQuery, QueryResult } from "kysely";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contentPlanPageSchema } from "../../src/modules/contentPlanning/contracts/index.js";
import { PostgresContentPlanReadSource } from "../../src/modules/contentPlanning/infra/contentPlanReadSource.js";
import { ContentPlanCursorCodec } from "../../src/modules/contentPlanning/services/contentPlanCursor.js";
import { ContentPlanReadService } from "../../src/modules/contentPlanning/services/contentPlanReadService.js";
import { QualityContentPlanningEvidenceSource } from "../../src/modules/quality/contentPlanningEvidence.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const AS_OF = new Date("2026-08-02T12:00:00.000Z");
const OBSERVATION_COUNT = 20_000;
const TOPIC_COUNT = 100;
const PAGE_SIZE = 25;
const SAMPLE_COUNT = 20;
const WARMUP_COUNT = 2;
const EVIDENCE_BATCH_SIZE = 500;
const MAX_READ_QUERY_COUNT = 4 + Math.ceil(OBSERVATION_COUNT / EVIDENCE_BATCH_SIZE);

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
  generationId: string;
}

class CountingDb {
  count = 0;

  constructor(private readonly database: Database) {}

  reset(): void {
    this.count = 0;
  }

  async executeQuery<R>(query: CompiledQuery<unknown>): Promise<QueryResult<R>> {
    this.count += 1;
    return this.database.kysely.executeQuery(query) as Promise<QueryResult<R>>;
  }
}

describeIfDatabase("Content Planning read-model performance", () => {
  const databaseName = `content_plan_perf_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;
  let fixture: Fixture;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runAllTestMigrations(database);
    fixture = await seedPerformanceFixture(database);
  }, 180_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin
      ?.execute(`DROP DATABASE IF EXISTS "${databaseName}"`)
      .catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("serves a coherent first page from 20,000 eligible observations with p95 below two seconds", async () => {
    const qualityEvidence = new QualityContentPlanningEvidenceSource(database.kysely);
    const eligiblePopulation = await qualityEvidence.countPopulation(fixture.workspaceId, {
      window: {
        from: "2026-06-03T12:00:00.000Z",
        to: AS_OF.toISOString(),
      },
    });
    const [{ count: eligibleObservationCount }] = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM content_plan_observations observation
       JOIN content_plan_projection_generations generation
         ON generation.workspace_id = observation.workspace_id
        AND generation.id = $2
       WHERE observation.workspace_id = $1
         AND observation.observation_state = 'ready'
         AND observation.semantic_text_hash IS NOT NULL
         AND observation.interaction_role IN (
           'substantive_new', 'substantive_followup', 'clarification_value'
         )
         AND observation.observed_at >= generation.horizon_from
         AND observation.observed_at < generation.horizon_to`,
      [fixture.workspaceId, fixture.generationId],
    );
    expect(Number(eligibleObservationCount)).toBe(OBSERVATION_COUNT);
    expect(eligiblePopulation).toBe(OBSERVATION_COUNT);

    const countingDb = new CountingDb(database);
    const service = new ContentPlanReadService({
      source: new PostgresContentPlanReadSource(countingDb as never),
      qualityEvidence: new QualityContentPlanningEvidenceSource(countingDb as never),
      cursorCodec: new ContentPlanCursorCodec("content-plan-performance-test-secret"),
      now: () => new Date(AS_OF),
    });

    for (let index = 0; index < WARMUP_COUNT; index += 1) {
      await service.list(fixture.workspaceId, { view: "all_interests", limit: PAGE_SIZE });
    }

    const durationsMs: number[] = [];
    const queryCounts: number[] = [];
    let lastPage: Awaited<ReturnType<ContentPlanReadService["list"]>> | undefined;
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      countingDb.reset();
      const startedAt = performance.now();
      lastPage = await service.list(fixture.workspaceId, {
        view: "all_interests",
        limit: PAGE_SIZE,
      });
      durationsMs.push(performance.now() - startedAt);
      queryCounts.push(countingDb.count);
    }

    expect(lastPage).toBeDefined();
    expect(contentPlanPageSchema.safeParse(lastPage).success).toBe(true);
    expect(lastPage).toMatchObject({
      asOf: AS_OF.toISOString(),
      projection: {
        state: "ready",
        pendingEmbeddingCount: 0,
        pendingAssignmentCount: 0,
        pendingEnrichmentTopicCount: TOPIC_COUNT,
      },
      summary: {
        questionCount: OBSERVATION_COUNT / 2,
        conversationCount: OBSERVATION_COUNT / 2,
        matureTopicCount: TOPIC_COUNT,
        emergingQuestionCount: 0,
        opportunityCount: TOPIC_COUNT,
        grounding: {
          evaluatedAnswerCount: 7_500,
          groundedAnswerCount: 2_500,
          degradedAnswerCount: 2_500,
          noSupportAnswerCount: 2_500,
          notEvaluatedAnswerCount: 2_500,
          reducedOrNoSupportRate: 2 / 3,
          headlineState: "measured",
        },
      },
    });
    expect(lastPage!.items).toHaveLength(PAGE_SIZE);
    expect(lastPage!.items.every((topic) =>
      topic.demand.currentQuestionCount === 100
      && topic.demand.comparisonQuestionCount === 100
      && topic.demand.trend === "steady"
      && topic.opportunity.credible)).toBe(true);
    expect(lastPage!.nextCursor).not.toBeNull();
    expect(lastPage!.recommendedTopicId).not.toBeNull();

    // The read model uses four fixed report queries plus bounded 500-ID evidence batches.
    // This scales with supported batch count, never with individual observations or topics.
    expect(Math.max(...queryCounts)).toBeLessThanOrEqual(MAX_READ_QUERY_COUNT);
    expect(percentile95(durationsMs)).toBeLessThan(2_000);
  }, 180_000);
});

const percentile95 = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
};

const seedPerformanceFixture = async (database: Database): Promise<Fixture> => {
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const embeddingSpaceId = randomUUID();
  const generationId = randomUUID();

  await database.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO accounts (id, name, email, password_hash)
       VALUES ($1, 'Content Planning Performance', $2, 'hash')`,
      [accountId, `content-plan-performance-${accountId}@example.com`],
    );
    await client.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, 'Content Planning Performance', $3)`,
      [workspaceId, accountId, `content-plan-performance-${workspaceId}`],
    );
    await client.query(
      `INSERT INTO agents (id, workspace_id, name)
       VALUES ($1, $2, 'Performance agent')`,
      [agentId, workspaceId],
    );
    await client.query(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES (
         $1, 'content-plan-performance-space', 'test', 'performance-endpoint',
         'performance-model', 3, 'cosine', 'unit'
       )`,
      [embeddingSpaceId],
    );
    await client.query(
      `INSERT INTO content_plan_projection_generations (
         id, workspace_id, embedding_space_id, kind, state, policy_version,
         horizon_from, horizon_to, coherent_at
       ) VALUES (
         $1, $2, $3, 'active', 'coherent', 1,
         '2026-06-03T12:00:00.000Z', $4, $4
       )`,
      [generationId, workspaceId, embeddingSpaceId, AS_OF.toISOString()],
    );
    await client.query(
      `INSERT INTO content_plan_projection_states (
         workspace_id, coherent_generation_id, projection_state, processed_through,
         bootstrap_processed, bootstrap_total, budget_version, budget_window_started_at
       ) VALUES ($1, $2, 'ready', $3, $4, $4, 1, '2026-08-02T00:00:00.000Z')`,
      [workspaceId, generationId, AS_OF.toISOString(), OBSERVATION_COUNT],
    );

    await createSeedTables(client);

    await client.query(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle,
         centroid, dimensions, centroid_weight, representative_observation_ids, revision,
         created_at, updated_at
       )
       SELECT $1, $2, topic.id, $3, 'mature', '[1,0,0]'::vector, 3,
              $4::integer / $5::integer, '{}'::uuid[], 1,
              $6::timestamptz - INTERVAL '1 second', $6
       FROM perf_topics topic`,
      [workspaceId, generationId, embeddingSpaceId, OBSERVATION_COUNT, TOPIC_COUNT, AS_OF.toISOString()],
    );
    await client.query(
      `INSERT INTO conversations (
         id, workspace_id, source_channel, agent_id, created_at, updated_at
       )
       SELECT turn.conversation_id, $1, 'embed', $2, turn.observed_at, turn.observed_at
       FROM perf_turns turn`,
      [workspaceId, agentId],
    );
    await client.query(
      `INSERT INTO messages (
         id, conversation_id, role, content, created_at, workspace_id, source,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count
       )
       SELECT
         turn.user_message_id, turn.conversation_id, 'user',
         'Performance question ' || turn.turn_number,
         turn.observed_at, $1, NULL,
         NULL, NULL, NULL, NULL, NULL
       FROM perf_turns turn`,
      [workspaceId],
    );
    await client.query(
      `INSERT INTO messages (
         id, conversation_id, role, content, created_at, workspace_id, source,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count
       )
       SELECT
         turn.assistant_message_id, turn.conversation_id, 'assistant',
         'Performance answer ' || turn.turn_number,
         turn.observed_at + interval '1 second', $1, NULL,
         turn.grounding_verdict,
         CASE WHEN turn.grounding_verdict IS NULL THEN NULL ELSE 1 END,
         CASE WHEN turn.grounding_verdict = 'grounded' THEN 1
              WHEN turn.grounding_verdict IS NULL THEN NULL ELSE 0 END,
         CASE WHEN turn.grounding_verdict = 'grounded' THEN 0
              WHEN turn.grounding_verdict IS NULL THEN NULL ELSE 1 END,
         CASE WHEN turn.grounding_verdict IS NULL THEN NULL ELSE 0 END
       FROM perf_turns turn`,
      [workspaceId],
    );
    await client.query(
      `INSERT INTO content_plan_observations (
         id, workspace_id, source_user_message_id, source_assistant_message_id,
         conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count,
         observation_state, observed_at
       )
       SELECT
         turn.observation_id, $1, turn.user_message_id, turn.assistant_message_id,
         turn.conversation_id, 'primary', repeat('a', 64), 'substantive_new',
         turn.grounding_verdict,
         CASE WHEN turn.grounding_verdict IS NULL THEN NULL ELSE 1 END,
         CASE WHEN turn.grounding_verdict = 'grounded' THEN 1
              WHEN turn.grounding_verdict IS NULL THEN NULL ELSE 0 END,
         CASE WHEN turn.grounding_verdict = 'grounded' THEN 0
              WHEN turn.grounding_verdict IS NULL THEN NULL ELSE 1 END,
         CASE WHEN turn.grounding_verdict IS NULL THEN NULL ELSE 0 END,
         'ready', turn.observed_at
       FROM perf_turns turn`,
      [workspaceId],
    );
    await client.query(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id,
         dimensions, embedding, vector_source, state, completed_at
       )
       SELECT $1, turn.observation_id, $2, $3, 3, '[1,0,0]'::vector,
              'reused', 'assigned', turn.observed_at
       FROM perf_turns turn`,
      [workspaceId, generationId, embeddingSpaceId],
    );
    await client.query(
      `INSERT INTO content_plan_topic_memberships (
         workspace_id, generation_id, observation_id, topic_id,
         assignment_version, similarity, cohesion, assigned_at
       )
       SELECT $1, $2, turn.observation_id, topic.id, 1, 0.95, 0.92, turn.observed_at
       FROM perf_turns turn
       JOIN perf_topics topic ON topic.topic_number = turn.topic_number`,
      [workspaceId, generationId],
    );
    await client.query(
      `ANALYZE conversations, messages, content_plan_observations,
         content_plan_observation_vectors, content_plan_topic_memberships,
         content_plan_topics, content_plan_projection_generations,
         content_plan_projection_states`,
    );
  });

  return { workspaceId, generationId };
};

const createSeedTables = async (client: PoolClient): Promise<void> => {
  await client.query(
    `CREATE TEMP TABLE perf_topics ON COMMIT DROP AS
     SELECT topic_number, gen_random_uuid() AS id
     FROM generate_series(1, $1::integer) AS topic(topic_number)`,
    [TOPIC_COUNT],
  );
  await client.query(
    `CREATE TEMP TABLE perf_turns ON COMMIT DROP AS
     SELECT
       turn_number,
       gen_random_uuid() AS conversation_id,
       gen_random_uuid() AS user_message_id,
       gen_random_uuid() AS assistant_message_id,
       gen_random_uuid() AS observation_id,
       (((turn_number - 1) / 4) % $2::integer) + 1 AS topic_number,
       CASE
         WHEN turn_number <= $1::integer / 2
           THEN $3::timestamptz - interval '45 days'
             + (turn_number - 1) * interval '1 millisecond'
         ELSE $3::timestamptz - interval '15 days'
             + (turn_number - 1 - ($1::integer / 2)) * interval '1 millisecond'
       END AS observed_at,
       CASE ((turn_number - 1) % 4)
         WHEN 0 THEN 'grounded'
         WHEN 1 THEN 'degraded'
         WHEN 2 THEN 'no_support'
         ELSE NULL
       END::text AS grounding_verdict
     FROM generate_series(1, $1::integer) AS turn(turn_number)`,
    [OBSERVATION_COUNT, TOPIC_COUNT, AS_OF.toISOString()],
  );
};
