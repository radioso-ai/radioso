import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import {
  applyTestMigration,
  runTestMigrationsBefore,
} from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "134_content_planning.sql";

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
  workspaceId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  documentId: string;
  embeddingSpaceId: string;
}

describeIfDatabase("content-planning persistence migration (134)", () => {
  const databaseName = `mig134_${randomUUID().replaceAll("-", "")}`;
  let admin: Database | undefined;
  let database: Database | undefined;

  const db = (): Database => {
    if (!database) throw new Error("content-planning test database is not initialized");
    return database;
  };

  const createWorkspaceFixture = async (suffix: string): Promise<WorkspaceFixture> => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const documentId = randomUUID();
    const embeddingSpaceId = randomUUID();

    await db().execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash')",
      [accountId, `Content Plan ${suffix}`, `content-plan-${suffix}-${accountId}@example.com`],
    );
    await db().execute(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, `Workspace ${suffix}`, `content-plan-${suffix}-${workspaceId}`],
    );
    await db().execute(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [conversationId, workspaceId],
    );
    await db().execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content)
       VALUES
         ($1, $3, $4, 'user', 'message-owned visitor source'),
         ($2, $3, $4, 'assistant', 'message-owned assistant source')`,
      [userMessageId, assistantMessageId, conversationId, workspaceId],
    );
    await db().execute(
      `INSERT INTO documents
         (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, 'Related document', 'source', 'markdown', 'ready', 1, '{}'::jsonb)`,
      [documentId, workspaceId],
    );
    await db().execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, $4, 3, 'cosine', 'unit')`,
      [embeddingSpaceId, `content-plan-space-${suffix}-${embeddingSpaceId}`, `endpoint-${suffix}`, `model-${suffix}`],
    );

    return {
      workspaceId,
      conversationId,
      userMessageId,
      assistantMessageId,
      documentId,
      embeddingSpaceId,
    };
  };

  const insertGeneration = async (input: {
    workspaceId: string;
    embeddingSpaceId: string;
    state: "building" | "coherent";
    kind?: "bootstrap" | "active" | "reprojection";
  }): Promise<string> => {
    const id = randomUUID();
    await db().execute(
      `INSERT INTO content_plan_projection_generations (
         id, workspace_id, embedding_space_id, kind, state, policy_version,
         horizon_from, horizon_to, coherent_at
       ) VALUES ($1, $2, $3, $4, $5, 1,
         '2026-06-01T00:00:00Z', '2026-08-01T00:00:00Z',
         CASE WHEN $5 = 'coherent' THEN '2026-08-01T00:00:00Z'::timestamptz ELSE NULL END
       )`,
      [id, input.workspaceId, input.embeddingSpaceId, input.kind ?? "active", input.state],
    );
    return id;
  };

  const insertObservation = async (fixture: WorkspaceFixture): Promise<string> => {
    const id = randomUUID();
    await db().execute(
      `INSERT INTO content_plan_observations (
         id, workspace_id, source_user_message_id, source_assistant_message_id,
         conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count,
         observation_state, observed_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'subquery-0', $6, 'substantive_new',
         'degraded', 2, 1, 1, 0, 'ready', '2026-07-31T12:00:00Z'
       )`,
      [
        id,
        fixture.workspaceId,
        fixture.userMessageId,
        fixture.assistantMessageId,
        fixture.conversationId,
        "a".repeat(64),
      ],
    );
    return id;
  };

  const insertTopic = async (input: {
    workspaceId: string;
    generationId: string;
    embeddingSpaceId: string;
    lifecycle?: "provisional" | "mature" | "retired";
    observationIds?: string[];
  }): Promise<string> => {
    const id = randomUUID();
    await db().execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, $5, '[1,0,0]'::vector, 3, $6, $7::uuid[], 1)`,
      [
        input.workspaceId,
        input.generationId,
        id,
        input.embeddingSpaceId,
        input.lifecycle ?? "mature",
        input.observationIds?.length ?? 0,
        input.observationIds ?? [],
      ],
    );
    return id;
  };

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runTestMigrationsBefore(database, migrationFile);
    await applyTestMigration(database, migrationFile);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin
      ?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("creates only source-referencing projection tables without raw visitor or semantic text", async () => {
    const tables = await db().query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name LIKE 'content_plan_%'
       ORDER BY table_name`,
    );
    expect(tables.map(({ table_name }) => table_name)).toEqual([
      "content_plan_corpus_invalidations",
      "content_plan_enrichment_repair_cursors",
      "content_plan_observation_vectors",
      "content_plan_observations",
      "content_plan_projection_generations",
      "content_plan_projection_population_snapshots",
      "content_plan_projection_states",
      "content_plan_topic_documents",
      "content_plan_topic_enrichments",
      "content_plan_topic_memberships",
      "content_plan_topics",
    ]);

    const forbiddenColumns = await db().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name LIKE 'content_plan_%'
         AND column_name IN (
           'question', 'query', 'semantic_text', 'raw_text', 'prompt', 'completion',
           'provider_response', 'document_excerpt'
         )`,
    );
    expect(forbiddenColumns).toEqual([]);
  });

  it("enforces workspace-scoped source identity, bounded enums, hashes, and grounding snapshots", async () => {
    const first = await createWorkspaceFixture("source-first");
    const foreign = await createWorkspaceFixture("source-foreign");
    const observationId = await insertObservation(first);

    await expect(
      db().execute(
        `INSERT INTO content_plan_observations (
           id, workspace_id, source_user_message_id, source_assistant_message_id,
           conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
           observation_state, observed_at
         ) VALUES ($1, $2, $3, $4, $5, 'foreign', $6, 'substantive_new', 'ready', NOW())`,
        [
          randomUUID(),
          first.workspaceId,
          foreign.userMessageId,
          foreign.assistantMessageId,
          first.conversationId,
          "b".repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      db().execute(
        `INSERT INTO content_plan_observations (
           id, workspace_id, source_user_message_id, source_assistant_message_id,
           conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
           observation_state, observed_at
         ) VALUES ($1, $2, $3, $4, $5, 'subquery-0', $6, 'substantive_new', 'ready', NOW())`,
        [
          randomUUID(),
          first.workspaceId,
          first.userMessageId,
          first.assistantMessageId,
          first.conversationId,
          "a".repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      db().execute(
        `UPDATE content_plan_observations
         SET semantic_text_hash = 'reversible text'
         WHERE id = $1`,
        [observationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      db().execute(
        `UPDATE content_plan_observations
         SET interaction_role = 'yes_message'
         WHERE id = $1`,
        [observationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      db().execute(
        `UPDATE content_plan_observations
         SET grounding_claim_count = 3
         WHERE id = $1`,
        [observationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("supports coherent and target spaces without allowing cross-space vectors or malformed claims", async () => {
    const fixture = await createWorkspaceFixture("dual-space");
    const targetSpaceId = randomUUID();
    await db().execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', 'target-endpoint', 'target-model', 2, 'cosine', 'unit')`,
      [targetSpaceId, `content-plan-target-${targetSpaceId}`],
    );
    const coherentGenerationId = await insertGeneration({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      state: "coherent",
    });
    const targetGenerationId = await insertGeneration({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: targetSpaceId,
      state: "building",
      kind: "reprojection",
    });
    const observationId = await insertObservation(fixture);

    await db().execute(
      `INSERT INTO content_plan_projection_states (
         workspace_id, coherent_generation_id, target_generation_id, projection_state,
         bootstrap_processed, bootstrap_total, budget_version, budget_window_started_at
       ) VALUES ($1, $2, $3, 'reprojecting', 1, 2, 1, '2026-08-01T00:00:00Z')`,
      [fixture.workspaceId, coherentGenerationId, targetGenerationId],
    );
    await db().execute(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id, dimensions,
         embedding, vector_source, state
       ) VALUES ($1, $2, $3, $4, 3, '[1,0,0]'::vector, 'reused', 'ready')`,
      [fixture.workspaceId, observationId, coherentGenerationId, fixture.embeddingSpaceId],
    );
    await db().execute(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id, dimensions,
         embedding, vector_source, state
       ) VALUES ($1, $2, $3, $4, 2, '[1,0]'::vector, 'fallback', 'ready')`,
      [fixture.workspaceId, observationId, targetGenerationId, targetSpaceId],
    );

    const rows = await db().query<{ generation_id: string; dimensions: number }>(
      `SELECT generation_id, dimensions
       FROM content_plan_observation_vectors
       WHERE workspace_id = $1 AND observation_id = $2
       ORDER BY dimensions`,
      [fixture.workspaceId, observationId],
    );
    expect(rows).toEqual([
      { generation_id: targetGenerationId, dimensions: 2 },
      { generation_id: coherentGenerationId, dimensions: 3 },
    ]);

    await expect(
      db().execute(
        `UPDATE content_plan_observation_vectors
         SET embedding_space_id = $1
         WHERE workspace_id = $2 AND observation_id = $3 AND generation_id = $4`,
        [targetSpaceId, fixture.workspaceId, observationId, coherentGenerationId],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      db().execute(
        `UPDATE content_plan_observation_vectors
         SET dimensions = 2
         WHERE workspace_id = $1 AND observation_id = $2 AND generation_id = $3`,
        [fixture.workspaceId, observationId, coherentGenerationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      db().execute(
        `UPDATE content_plan_observation_vectors
         SET state = 'processing', claim_token = $1
         WHERE workspace_id = $2 AND observation_id = $3 AND generation_id = $4`,
        [randomUUID(), fixture.workspaceId, observationId, coherentGenerationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("fences memberships, redirects, enrichment revisions, and topic-document evidence", async () => {
    const fixture = await createWorkspaceFixture("topic-fences");
    const foreign = await createWorkspaceFixture("topic-fences-foreign");
    const generationId = await insertGeneration({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      state: "coherent",
    });
    const observationId = await insertObservation(fixture);
    await db().execute(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id, dimensions,
         embedding, vector_source, state
       ) VALUES ($1, $2, $3, $4, 3, '[1,0,0]'::vector, 'reused', 'ready')`,
      [fixture.workspaceId, observationId, generationId, fixture.embeddingSpaceId],
    );
    const survivorTopicId = await insertTopic({
      workspaceId: fixture.workspaceId,
      generationId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      observationIds: [observationId],
    });

    await db().execute(
      `INSERT INTO content_plan_topic_memberships (
         workspace_id, generation_id, observation_id, topic_id,
         assignment_version, similarity, cohesion
       ) VALUES ($1, $2, $3, $4, 1, 0.91, 0.84)`,
      [fixture.workspaceId, generationId, observationId, survivorTopicId],
    );
    await expect(
      db().execute(
        `UPDATE content_plan_topic_memberships
         SET similarity = 1.01
         WHERE workspace_id = $1 AND generation_id = $2 AND observation_id = $3`,
        [fixture.workspaceId, generationId, observationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const mergedTopicId = randomUUID();
    await db().execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision,
         merged_into_topic_id, redirect_expires_at
       ) VALUES (
         $1, $2, $3, $4, 'merged', '[1,0,0]'::vector, 3, 0, '{}'::uuid[], 1,
         $5, NOW() + INTERVAL '91 days'
       )`,
      [fixture.workspaceId, generationId, mergedTopicId, fixture.embeddingSpaceId, survivorTopicId],
    );
    await expect(
      db().execute(
        `INSERT INTO content_plan_topics (
           workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
           dimensions, centroid_weight, representative_observation_ids, revision,
           merged_into_topic_id, redirect_expires_at
         ) VALUES (
           $1, $2, $3, $4, 'merged', '[1,0,0]'::vector, 3, 0, '{}'::uuid[], 1,
           $5, NOW() + INTERVAL '91 days'
         )`,
        [fixture.workspaceId, generationId, randomUUID(), fixture.embeddingSpaceId, foreign.workspaceId],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await db().execute(
      `INSERT INTO content_plan_topic_enrichments (
         workspace_id, generation_id, topic_id, source_topic_revision, state,
         label, description, questions_to_answer, suggested_shape,
         action, action_rule_version, corpus_state, enriched_at
       ) VALUES (
         $1, $2, $3, 1, 'ready', 'Deployment', 'Deployment questions',
         '["What should this explain?", "Who needs it?", "How is it verified?"]'::jsonb,
         'guide', 'monitor', 1, 'ready', NOW()
       )`,
      [fixture.workspaceId, generationId, survivorTopicId],
    );
    await expect(
      db().execute(
        `UPDATE content_plan_topic_enrichments
         SET source_topic_revision = 2
         WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
        [fixture.workspaceId, generationId, survivorTopicId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await db().execute(
      `UPDATE content_plan_topics
       SET revision = 2, enrichment_dirty_at = NOW(), updated_at = NOW()
       WHERE workspace_id = $1 AND generation_id = $2 AND id = $3`,
      [fixture.workspaceId, generationId, survivorTopicId],
    );
    const [publishedEnrichment] = await db().query<{
      source_topic_revision: number;
      state: string;
      corpus_state: string;
    }>(
      `SELECT source_topic_revision, state, corpus_state
       FROM content_plan_topic_enrichments
       WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
      [fixture.workspaceId, generationId, survivorTopicId],
    );
    expect(publishedEnrichment).toEqual({
      source_topic_revision: 1,
      state: "ready",
      corpus_state: "ready",
    });

    await db().execute(
      `INSERT INTO content_plan_topic_documents (
         workspace_id, generation_id, topic_id, document_id, source_topic_revision,
         similarity, existed_before_gap, retrieved_by_gap_answers,
         cited_by_gap_answers, changed_after_gap
       ) VALUES ($1, $2, $3, $4, 2, 0.82, TRUE, FALSE, FALSE, FALSE)`,
      [fixture.workspaceId, generationId, survivorTopicId, fixture.documentId],
    );
    await expect(
      db().execute(
        `INSERT INTO content_plan_topic_documents (
           workspace_id, generation_id, topic_id, document_id, source_topic_revision,
           similarity, existed_before_gap, retrieved_by_gap_answers,
           cited_by_gap_answers, changed_after_gap
         ) VALUES ($1, $2, $3, $4, 2, 0.8, TRUE, FALSE, FALSE, FALSE)`,
        [fixture.workspaceId, generationId, survivorTopicId, foreign.documentId],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await db().execute("DELETE FROM documents WHERE id = $1", [fixture.documentId]);
    const documentLinks = await db().query(
      `SELECT 1 FROM content_plan_topic_documents
       WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
      [fixture.workspaceId, generationId, survivorTopicId],
    );
    expect(documentLinks).toHaveLength(0);
  });

  it("cascades source and workspace deletion through observations, vectors, memberships, and projections", async () => {
    const fixture = await createWorkspaceFixture("cascade");
    const generationId = await insertGeneration({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      state: "coherent",
    });
    const observationId = await insertObservation(fixture);
    await db().execute(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id, dimensions,
         embedding, vector_source, state
       ) VALUES ($1, $2, $3, $4, 3, '[1,0,0]'::vector, 'reused', 'ready')`,
      [fixture.workspaceId, observationId, generationId, fixture.embeddingSpaceId],
    );
    const topicId = await insertTopic({
      workspaceId: fixture.workspaceId,
      generationId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      observationIds: [observationId],
    });
    await db().execute(
      `INSERT INTO content_plan_topic_memberships (
         workspace_id, generation_id, observation_id, topic_id,
         assignment_version, similarity, cohesion
       ) VALUES ($1, $2, $3, $4, 1, 0.9, 0.8)`,
      [fixture.workspaceId, generationId, observationId, topicId],
    );
    await db().execute(
      `INSERT INTO content_plan_projection_states (
         workspace_id, coherent_generation_id, projection_state,
         budget_version, budget_window_started_at
       ) VALUES ($1, $2, 'ready', 1, '2026-08-01T00:00:00Z')`,
      [fixture.workspaceId, generationId],
    );

    await db().execute("DELETE FROM messages WHERE id = $1", [fixture.userMessageId]);
    const sourceRows = await db().query<{ observations: string; vectors: string; memberships: string }>(
      `SELECT
         (SELECT count(*) FROM content_plan_observations WHERE id = $1)::text AS observations,
         (SELECT count(*) FROM content_plan_observation_vectors WHERE observation_id = $1)::text AS vectors,
         (SELECT count(*) FROM content_plan_topic_memberships WHERE observation_id = $1)::text AS memberships`,
      [observationId],
    );
    expect(sourceRows[0]).toEqual({ observations: "0", vectors: "0", memberships: "0" });

    await db().execute("DELETE FROM workspaces WHERE id = $1", [fixture.workspaceId]);
    const workspaceRows = await db().query<{ generations: string; topics: string; states: string }>(
      `SELECT
         (SELECT count(*) FROM content_plan_projection_generations WHERE workspace_id = $1)::text AS generations,
         (SELECT count(*) FROM content_plan_topics WHERE workspace_id = $1)::text AS topics,
         (SELECT count(*) FROM content_plan_projection_states WHERE workspace_id = $1)::text AS states`,
      [fixture.workspaceId],
    );
    expect(workspaceRows[0]).toEqual({ generations: "0", topics: "0", states: "0" });
  });
});
