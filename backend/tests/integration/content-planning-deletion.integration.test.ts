import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ContentPlanEnrichmentRepository } from "../../src/db/repositories/contentPlanningEnrichmentRepository.js";
import { ContentPlanCorpusInvalidationRepository } from "../../src/db/repositories/contentPlanningCorpusInvalidationRepository.js";
import { ContentPlanObservationRepository } from "../../src/db/repositories/contentPlanningObservationRepository.js";
import { ContentPlanTopicRepository } from "../../src/db/repositories/contentPlanningTopicRepository.js";
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

interface DeletionFixture {
  accountId: string;
  workspaceId: string;
  conversationId: string;
  embeddingSpaceId: string;
  generationId: string;
}

interface TurnFixture {
  userMessageId: string;
  assistantMessageId: string;
  observationId: string;
}

describeIfDatabase("content-planning deletion and retention", () => {
  let database: Database;
  let observations: ContentPlanObservationRepository;
  let topics: ContentPlanTopicRepository;
  let enrichments: ContentPlanEnrichmentRepository;
  let corpusInvalidations: ContentPlanCorpusInvalidationRepository;
  const accountIds: string[] = [];

  const createFixture = async (suffix: string): Promise<DeletionFixture> => {
    const fixture = {
      accountId: randomUUID(),
      workspaceId: randomUUID(),
      conversationId: randomUUID(),
      embeddingSpaceId: randomUUID(),
      generationId: randomUUID(),
    };
    accountIds.push(fixture.accountId);
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash')",
      [fixture.accountId, `Deletion ${suffix}`, `content-plan-delete-${suffix}-${fixture.accountId}@example.com`],
    );
    await database.execute(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)`,
      [fixture.workspaceId, fixture.accountId, `Deletion ${suffix}`, `delete-${suffix}-${fixture.workspaceId}`],
    );
    await database.execute(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [fixture.conversationId, fixture.workspaceId],
    );
    await database.execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, 'deletion-model', 3, 'cosine', 'unit')`,
      [fixture.embeddingSpaceId, `delete-space-${fixture.embeddingSpaceId}`, `delete-endpoint-${fixture.embeddingSpaceId}`],
    );
    await database.execute(
      `INSERT INTO content_plan_projection_generations (
         id, workspace_id, embedding_space_id, kind, state, policy_version,
         horizon_from, horizon_to, coherent_at
       ) VALUES ($1, $2, $3, 'active', 'coherent', 1,
         '2026-06-01T00:00:00Z', '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z')`,
      [fixture.generationId, fixture.workspaceId, fixture.embeddingSpaceId],
    );
    return fixture;
  };

  const addTurn = async (
    fixture: DeletionFixture,
    suffix: string,
    observedAt: Date,
    vector: readonly number[],
  ): Promise<TurnFixture> => {
    const turn = {
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      observationId: randomUUID(),
    };
    await database.execute(
      `INSERT INTO messages (
         id, conversation_id, workspace_id, role, content, created_at,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count
       ) VALUES
         ($1, $3, $4, 'user', $5, $6, NULL, NULL, NULL, NULL, NULL),
         ($2, $3, $4, 'assistant', 'Bounded answer', $6,
          'degraded', 1, 0, 1, 0)`,
      [
        turn.userMessageId,
        turn.assistantMessageId,
        fixture.conversationId,
        fixture.workspaceId,
        `DELETE-ME SECRET QUESTION ${suffix}`,
        observedAt,
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_observations (
         id, workspace_id, source_user_message_id, source_assistant_message_id,
         conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count,
         observation_state, observed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'substantive_new',
         'degraded', 1, 0, 1, 0, 'ready', $8
       )`,
      [
        turn.observationId,
        fixture.workspaceId,
        turn.userMessageId,
        turn.assistantMessageId,
        fixture.conversationId,
        `intent-${suffix}`,
        suffix.padEnd(64, "a").slice(0, 64).replace(/[^0-9a-f]/g, "a"),
        observedAt,
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id,
         dimensions, embedding, vector_source, state, completed_at
       ) VALUES ($1, $2, $3, $4, 3, $5::vector, 'reused', 'assigned', $6)`,
      [fixture.workspaceId, turn.observationId, fixture.generationId, fixture.embeddingSpaceId, `[${vector.join(",")}]`, observedAt],
    );
    return turn;
  };

  const addTopic = async (input: {
    fixture: DeletionFixture;
    topicId: string;
    lifecycle: "provisional" | "mature";
    turns: readonly TurnFixture[];
    centroid: readonly number[];
  }): Promise<void> => {
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, $5, $6::vector, 3, $7, $8::uuid[], 1)`,
      [
        input.fixture.workspaceId,
        input.fixture.generationId,
        input.topicId,
        input.fixture.embeddingSpaceId,
        input.lifecycle,
        `[${input.centroid.join(",")}]`,
        input.turns.length,
        input.turns.map((turn) => turn.observationId),
      ],
    );
    for (const turn of input.turns) {
      await database.execute(
        `INSERT INTO content_plan_topic_memberships (
           workspace_id, generation_id, observation_id, topic_id,
           assignment_version, similarity, cohesion, assigned_at
         ) VALUES ($1, $2, $3, $4, 1, 1, 1, NOW())`,
        [input.fixture.workspaceId, input.fixture.generationId, turn.observationId, input.topicId],
      );
    }
  };

  const addReadyEnrichment = async (
    fixture: DeletionFixture,
    topicId: string,
    sourceTopicRevision: number,
  ): Promise<void> => {
    await database.execute(
      `INSERT INTO content_plan_topic_enrichments (
         workspace_id, generation_id, topic_id, source_topic_revision, state,
         label, description, suggested_title, rationale, questions_to_answer,
         suggested_shape, evidence_statement, action, action_rule_version,
         corpus_state, enriched_at
       ) VALUES (
         $1, $2, $3, $4, 'ready', 'SECRET GENERATED LABEL',
         'SECRET GENERATED DESCRIPTION', 'SECRET GENERATED TITLE',
         'SECRET GENERATED RATIONALE', '["Question one?","Question two?","Question three?"]'::jsonb,
         'guide', 'SECRET GENERATED EVIDENCE', 'monitor', 1, 'ready', NOW()
       )`,
      [fixture.workspaceId, fixture.generationId, topicId, sourceTopicRevision],
    );
  };

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    observations = new ContentPlanObservationRepository(database.kysely);
    topics = new ContentPlanTopicRepository(database.kysely);
    enrichments = new ContentPlanEnrichmentRepository(database.kysely);
    corpusInvalidations = new ContentPlanCorpusInvalidationRepository(database.kysely);
  });

  afterAll(async () => {
    if (accountIds.length > 0) {
      await database.execute("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [accountIds]);
    }
    await database.close();
  });

  it("removes source text, vectors, and membership immediately, then clears and recomputes affected topic evidence", async () => {
    const fixture = await createFixture("privacy");
    const deletedTurn = await addTurn(fixture, "deleted", new Date("2026-07-01T00:00:00Z"), [1, 0, 0]);
    const survivingTurn = await addTurn(fixture, "surviving", new Date("2026-07-02T00:00:00Z"), [0, 1, 0]);
    const topicId = randomUUID();
    await addTopic({
      fixture,
      topicId,
      lifecycle: "mature",
      turns: [deletedTurn, survivingTurn],
      centroid: [0.5, 0.5, 0],
    });
    await addReadyEnrichment(fixture, topicId, 1);
    const documentId = randomUUID();
    await database.execute(
      `INSERT INTO documents (
         id, workspace_id, title, source_content, markdown_content, status, revision, metadata
       ) VALUES ($1, $2, 'Related', 'secret document', 'secret document', 'ready', 1, '{}'::jsonb)`,
      [documentId, fixture.workspaceId],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_documents (
         workspace_id, generation_id, topic_id, document_id, source_topic_revision, similarity
       ) VALUES ($1, $2, $3, $4, 1, 0.9)`,
      [fixture.workspaceId, fixture.generationId, topicId, documentId],
    );

    await database.execute("DELETE FROM messages WHERE workspace_id = $1 AND id = $2", [
      fixture.workspaceId,
      deletedTurn.userMessageId,
    ]);
    const immediate = await database.queryOne<{
      message_count: string;
      observation_count: string;
      vector_count: string;
      membership_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM messages WHERE workspace_id = $1 AND id = $2)::text AS message_count,
         (SELECT count(*) FROM content_plan_observations WHERE workspace_id = $1 AND id = $3)::text AS observation_count,
         (SELECT count(*) FROM content_plan_observation_vectors WHERE workspace_id = $1 AND observation_id = $3)::text AS vector_count,
         (SELECT count(*) FROM content_plan_topic_memberships WHERE workspace_id = $1 AND observation_id = $3)::text AS membership_count`,
      [fixture.workspaceId, deletedTurn.userMessageId, deletedTurn.observationId],
    );
    expect(immediate).toEqual({
      message_count: "0",
      observation_count: "0",
      vector_count: "0",
      membership_count: "0",
    });

    const affected = await topics.findTopicsNeedingReconciliation({
      workspaceId: fixture.workspaceId,
      generationId: fixture.generationId,
      limit: 10,
    });
    expect(affected).toEqual([{ workspaceId: fixture.workspaceId, generationId: fixture.generationId, topicId }]);
    const [evidence] = await topics.loadReconciliationEvidence({
      workspaceId: fixture.workspaceId,
      generationId: fixture.generationId,
      topicIds: [topicId],
      limit: 1,
    });
    expect(evidence).toMatchObject({
      liveCentroid: [0, 1, 0],
      liveObservationCount: 1,
      representativeObservationIds: [survivingTurn.observationId],
    });
    await expect(topics.reconcileTopic({
      workspaceId: fixture.workspaceId,
      generationId: fixture.generationId,
      topicId,
      expectedRevision: 1,
      topic: {
        lifecycle: "mature",
        centroid: evidence!.liveCentroid!,
        dimensions: 3,
        centroidWeight: evidence!.liveObservationCount,
        representativeObservationIds: evidence!.representativeObservationIds,
        revision: 2,
        enrichmentDirtyAt: new Date("2026-08-02T00:00:00Z"),
      },
    })).resolves.toMatchObject({
      revision: 2,
      centroid: [0, 1, 0],
      centroidWeight: 1,
      representativeObservationIds: [survivingTurn.observationId],
    });
    const cleared = await database.queryOne<{ enrichments: string; documents: string }>(
      `SELECT
         (SELECT count(*) FROM content_plan_topic_enrichments
          WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3)::text AS enrichments,
         (SELECT count(*) FROM content_plan_topic_documents
          WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3)::text AS documents`,
      [fixture.workspaceId, fixture.generationId, topicId],
    );
    expect(cleared).toEqual({ enrichments: "0", documents: "0" });
  });

  it("prunes only observations older than the boundary and retires the resulting empty topic", async () => {
    const fixture = await createFixture("retention");
    const boundary = new Date("2026-06-03T00:00:00Z");
    const turn = await addTurn(fixture, "boundary", boundary, [1, 0, 0]);
    const topicId = randomUUID();
    await addTopic({ fixture, topicId, lifecycle: "provisional", turns: [turn], centroid: [1, 0, 0] });

    await expect(observations.pruneExpiredObservations({
      workspaceId: fixture.workspaceId,
      observedBefore: boundary,
      limit: 10,
    })).resolves.toEqual({ deletedCount: 0, affectedTopics: [] });
    const pruned = await observations.pruneExpiredObservations({
      workspaceId: fixture.workspaceId,
      observedBefore: new Date(boundary.getTime() + 1),
      limit: 10,
    });
    expect(pruned).toEqual({
      deletedCount: 1,
      affectedTopics: [{ workspaceId: fixture.workspaceId, generationId: fixture.generationId, topicId }],
    });
    const [evidence] = await topics.loadReconciliationEvidence({
      workspaceId: fixture.workspaceId,
      generationId: fixture.generationId,
      topicIds: [topicId],
      limit: 1,
    });
    expect(evidence).toMatchObject({ liveCentroid: null, liveObservationCount: 0, representativeObservationIds: [] });
    await expect(topics.reconcileTopic({
      workspaceId: fixture.workspaceId,
      generationId: fixture.generationId,
      topicId,
      expectedRevision: 1,
      topic: {
        lifecycle: "retired",
        centroid: [1, 0, 0],
        dimensions: 3,
        centroidWeight: 0,
        representativeObservationIds: [],
        revision: 2,
        enrichmentDirtyAt: null,
      },
    })).resolves.toMatchObject({ lifecycle: "retired", centroidWeight: 0, representativeObservationIds: [] });
    await expect(topics.resolveTopicRedirect({
      workspaceId: fixture.workspaceId,
      generationId: fixture.generationId,
      topicId,
      now: new Date("2026-08-02T00:00:00Z"),
    })).resolves.toEqual({ kind: "not_found" });
  });

  it("invalidates deleted document evidence and retains merge redirects for exactly the required window", async () => {
    const fixture = await createFixture("redirects");
    const sourceTopicId = randomUUID();
    const survivorTopicId = randomUUID();
    for (const topicId of [sourceTopicId, survivorTopicId]) {
      await addTopic({ fixture, topicId, lifecycle: "mature", turns: [], centroid: [1, 0, 0] });
    }
    const mergedAt = new Date("2026-01-01T00:00:00Z");
    const redirectExpiresAt = new Date("2026-04-01T00:00:00Z");
    await expect(topics.mergeTopics({
      workspaceId: fixture.workspaceId,
      generationId: fixture.generationId,
      sourceTopicId,
      sourceExpectedRevision: 1,
      survivorTopicId,
      survivorExpectedRevision: 1,
      survivor: {
        lifecycle: "mature",
        centroid: [1, 0, 0],
        dimensions: 3,
        centroidWeight: 0,
        representativeObservationIds: [],
        revision: 2,
        enrichmentDirtyAt: mergedAt,
      },
      mergedAt,
      redirectExpiresAt,
    })).resolves.toMatchObject({ id: survivorTopicId, revision: 2 });

    const documentId = randomUUID();
    await database.execute(
      `INSERT INTO documents (
         id, workspace_id, title, source_content, markdown_content, status, revision, metadata
       ) VALUES ($1, $2, 'Delete me', 'source', 'markdown', 'ready', 1, '{}'::jsonb)`,
      [documentId, fixture.workspaceId],
    );
    await addReadyEnrichment(fixture, survivorTopicId, 2);
    await database.execute(
      `INSERT INTO content_plan_topic_documents (
         workspace_id, generation_id, topic_id, document_id, source_topic_revision, similarity
       ) VALUES ($1, $2, $3, $4, 2, 0.9)`,
      [fixture.workspaceId, fixture.generationId, survivorTopicId, documentId],
    );
    await expect(corpusInvalidations.invalidateDeletedDocument({
      workspaceId: fixture.workspaceId,
      documentId,
      dirtyAt: new Date("2026-03-31T00:00:00Z"),
    })).resolves.toBe(1);
    await database.execute("DELETE FROM documents WHERE workspace_id = $1 AND id = $2", [fixture.workspaceId, documentId]);
    await expect(database.queryOne<{ state: string; corpus_state: string }>(
      `SELECT state, corpus_state FROM content_plan_topic_enrichments
       WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
      [fixture.workspaceId, fixture.generationId, survivorTopicId],
    )).resolves.toEqual({ state: "stale", corpus_state: "stale" });

    await expect(topics.resolveTopicRedirect({
      workspaceId: fixture.workspaceId,
      generationId: fixture.generationId,
      topicId: sourceTopicId,
      now: new Date(redirectExpiresAt.getTime() - 1),
    })).resolves.toMatchObject({ kind: "active", topic: { id: survivorTopicId } });
    await expect(topics.pruneExpiredRedirects({
      workspaceId: fixture.workspaceId,
      now: new Date(redirectExpiresAt.getTime() - 1),
      limit: 10,
    })).resolves.toBe(0);
    await expect(topics.pruneExpiredRedirects({
      workspaceId: fixture.workspaceId,
      now: redirectExpiresAt,
      limit: 10,
    })).resolves.toBe(1);
    await expect(topics.resolveTopicRedirect({
      workspaceId: fixture.workspaceId,
      generationId: fixture.generationId,
      topicId: sourceTopicId,
      now: redirectExpiresAt,
    })).resolves.toEqual({ kind: "not_found" });
    await expect(topics.resolveTopicRedirect({
      workspaceId: fixture.workspaceId,
      generationId: fixture.generationId,
      topicId: survivorTopicId,
      now: redirectExpiresAt,
    })).resolves.toMatchObject({ kind: "active", topic: { id: survivorTopicId } });
  });
});
