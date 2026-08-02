import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresContentPlanProjectionDiscovery } from "../../src/app/composition/adapters/contentPlanningProjectionDiscovery.js";
import { ContentPlanCorpusInvalidationRepository } from "../../src/db/repositories/contentPlanningCorpusInvalidationRepository.js";
import { ContentPlanEnrichmentRepository } from "../../src/db/repositories/contentPlanningEnrichmentRepository.js";
import { ContentPlanObservationRepository } from "../../src/db/repositories/contentPlanningObservationRepository.js";
import { ContentPlanProjectionRepository } from "../../src/db/repositories/contentPlanningProjectionRepository.js";
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
  embeddingSpaceId: string;
  generationId: string;
}

interface TopicTurnFixture {
  workspace: WorkspaceFixture;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  observationId: string;
  topicId: string;
  documentId: string;
}

describeIfDatabase("content-planning privacy fences", () => {
  const databaseName = `content_plan_privacy_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;

  const createWorkspace = async (suffix: string): Promise<WorkspaceFixture> => {
    const fixture = {
      accountId: randomUUID(),
      workspaceId: randomUUID(),
      embeddingSpaceId: randomUUID(),
      generationId: randomUUID(),
    };
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash')",
      [fixture.accountId, `Privacy ${suffix}`, `privacy-${suffix}-${fixture.accountId}@example.com`],
    );
    await database.execute(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)`,
      [fixture.workspaceId, fixture.accountId, `Privacy ${suffix}`, `privacy-${suffix}-${fixture.workspaceId}`],
    );
    await database.execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, 'privacy-model', 3, 'cosine', 'unit')`,
      [fixture.embeddingSpaceId, `privacy-space-${fixture.embeddingSpaceId}`, `privacy-endpoint-${fixture.embeddingSpaceId}`],
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

  const createTopicTurn = async (suffix: string): Promise<TopicTurnFixture> => {
    const workspace = await createWorkspace(suffix);
    const fixture = {
      workspace,
      conversationId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      observationId: randomUUID(),
      topicId: randomUUID(),
      documentId: randomUUID(),
    };
    await database.execute(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'embed')",
      [fixture.conversationId, workspace.workspaceId],
    );
    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at)
       VALUES
         ($1, $3, $4, 'user', $5, '2026-07-01T00:00:00Z'),
         ($2, $3, $4, 'assistant', 'message-owned answer', '2026-07-01T00:00:01Z')`,
      [
        fixture.userMessageId,
        fixture.assistantMessageId,
        fixture.conversationId,
        workspace.workspaceId,
        `message-owned private question ${suffix}`,
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_observations (
         id, workspace_id, source_user_message_id, source_assistant_message_id,
         conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count,
         observation_state, observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'substantive_new',
         'degraded', 1, 0, 1, 0, 'ready', '2026-07-01T00:00:01Z')`,
      [
        fixture.observationId,
        workspace.workspaceId,
        fixture.userMessageId,
        fixture.assistantMessageId,
        fixture.conversationId,
        `intent-${suffix}`,
        "a".repeat(64),
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id,
         dimensions, embedding, vector_source, state, completed_at
       ) VALUES ($1, $2, $3, $4, 3, '[1,0,0]'::vector, 'reused', 'assigned', NOW())`,
      [workspace.workspaceId, fixture.observationId, workspace.generationId, workspace.embeddingSpaceId],
    );
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 1, ARRAY[$5::uuid], 1)`,
      [workspace.workspaceId, workspace.generationId, fixture.topicId, workspace.embeddingSpaceId, fixture.observationId],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_memberships (
         workspace_id, generation_id, observation_id, topic_id,
         assignment_version, similarity, cohesion
       ) VALUES ($1, $2, $3, $4, 1, 1, 1)`,
      [workspace.workspaceId, workspace.generationId, fixture.observationId, fixture.topicId],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_enrichments (
         workspace_id, generation_id, topic_id, source_topic_revision,
         source_member_count, source_degraded_count, source_evidence_strength,
         source_credible_opportunity, analysis_mode, publish_state, state,
         label, description, action_rule_version, corpus_state, enriched_at
       ) VALUES ($1, $2, $3, 1, 1, 1, 'low', FALSE, 'label_and_brief', 'ready',
         'ready', 'Private derived label', 'Private derived description', 1, 'ready', NOW())`,
      [workspace.workspaceId, workspace.generationId, fixture.topicId],
    );
    await database.execute(
      `INSERT INTO documents (
         id, workspace_id, title, source_content, markdown_content, status, revision, metadata
       ) VALUES ($1, $2, 'Related', 'source', 'markdown', 'ready', 1, '{}'::jsonb)`,
      [fixture.documentId, workspace.workspaceId],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_documents (
         workspace_id, generation_id, topic_id, document_id, source_topic_revision, similarity
       ) VALUES ($1, $2, $3, $4, 1, 0.9)`,
      [workspace.workspaceId, workspace.generationId, fixture.topicId, fixture.documentId],
    );
    return fixture;
  };

  const expectPrivacyCleared = async (fixture: TopicTurnFixture): Promise<void> => {
    const state = await database.queryOne<{
      revision: number;
      observations: string;
      memberships: string;
      enrichments: string;
      documents: string;
    }>(
      `SELECT
         topic.revision,
         (SELECT count(*) FROM content_plan_observations observation
          WHERE observation.workspace_id = $1 AND observation.id = $4)::text AS observations,
         (SELECT count(*) FROM content_plan_topic_memberships membership
          WHERE membership.workspace_id = $1 AND membership.observation_id = $4)::text AS memberships,
         (SELECT count(*) FROM content_plan_topic_enrichments enrichment
          WHERE enrichment.workspace_id = $1 AND enrichment.generation_id = $2
            AND enrichment.topic_id = $3)::text AS enrichments,
         (SELECT count(*) FROM content_plan_topic_documents document
          WHERE document.workspace_id = $1 AND document.generation_id = $2
            AND document.topic_id = $3)::text AS documents
       FROM content_plan_topics topic
       WHERE topic.workspace_id = $1 AND topic.generation_id = $2 AND topic.id = $3`,
      [fixture.workspace.workspaceId, fixture.workspace.generationId, fixture.topicId, fixture.observationId],
    );
    expect(state).toEqual({
      revision: 2,
      observations: "0",
      memberships: "0",
      enrichments: "0",
      documents: "0",
    });
  };

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("freezes the exact source user so deletion cannot rebind replay to an earlier turn", async () => {
    const workspace = await createWorkspace("snapshot-source");
    const conversationId = randomUUID();
    const olderUserMessageId = randomUUID();
    const sourceUserMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const generationId = randomUUID();
    const leaseToken = randomUUID();
    await database.execute(
      "UPDATE content_plan_projection_generations SET state = 'superseded' WHERE workspace_id = $1",
      [workspace.workspaceId],
    );
    await database.execute(
      `INSERT INTO content_plan_projection_generations (
         id, workspace_id, embedding_space_id, kind, state, policy_version,
         horizon_from, horizon_to
       ) VALUES ($1, $2, $3, 'bootstrap', 'building', 1,
         '2026-06-03T00:00:00Z', '2026-08-02T00:00:00Z')`,
      [generationId, workspace.workspaceId, workspace.embeddingSpaceId],
    );
    await database.execute(
      `INSERT INTO content_plan_projection_states (
         workspace_id, target_generation_id, projection_state, budget_version,
         budget_window_started_at, lease_token, lease_expires_at
       ) VALUES ($1, $2, 'bootstrapping', 1, '2026-08-02T00:00:00Z', $3, '2026-08-02T00:01:00Z')`,
      [workspace.workspaceId, generationId, leaseToken],
    );
    await database.execute(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'embed')",
      [conversationId, workspace.workspaceId],
    );
    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, metadata_json, created_at)
       VALUES
         ($1, $4, $5, 'user', 'older question', '{}'::jsonb, '2026-07-01T00:00:00Z'),
         ($2, $4, $5, 'user', 'exact private question', $6::jsonb, '2026-07-01T00:00:01Z'),
         ($3, $4, $5, 'assistant', 'answer', '{}'::jsonb, '2026-07-01T00:00:02Z')`,
      [
        olderUserMessageId,
        sourceUserMessageId,
        assistantMessageId,
        conversationId,
        workspace.workspaceId,
        JSON.stringify({
          conversationInteraction: {
            version: 1,
            role: "substantive_new",
            semanticIntents: [{ id: "exact", text: "exact private question" }],
          },
        }),
      ],
    );
    const discovery = new PostgresContentPlanProjectionDiscovery(database.kysely);
    await expect(discovery.capturePopulationSnapshot({
      workspaceId: workspace.workspaceId,
      generationId,
      leaseToken,
      window: {
        from: "2026-06-03T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
      },
    })).resolves.toEqual({ total: 1 });
    await expect(database.query(
      `SELECT source_user_message_id, assistant_message_id
       FROM content_plan_projection_population_snapshots
       WHERE workspace_id = $1 AND generation_id = $2`,
      [workspace.workspaceId, generationId],
    )).resolves.toEqual([{
      source_user_message_id: sourceUserMessageId,
      assistant_message_id: assistantMessageId,
    }]);

    await database.execute(
      "DELETE FROM messages WHERE workspace_id = $1 AND id = $2",
      [workspace.workspaceId, sourceUserMessageId],
    );
    await expect(discovery.listPopulationSnapshotPage({
      workspaceId: workspace.workspaceId,
      generationId,
      window: {
        from: "2026-06-03T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
      },
      limit: 10,
    })).resolves.toEqual({ items: [], nextCursor: null });

    const projections = new ContentPlanProjectionRepository(database.kysely);
    const lease = await projections.claimProjectionLease({
      workspaceId: workspace.workspaceId,
      now: new Date("2026-08-02T00:00:03Z"),
      leaseMs: 30_000,
    });
    await expect(discovery.reconcilePopulationSnapshotProgress({
      workspaceId: workspace.workspaceId,
      generationId,
      leaseToken: lease!.leaseToken!,
      processed: 0,
    })).resolves.toEqual({ processed: 0, total: 0 });
    await expect(database.queryOne<{ content: string }>(
      "SELECT content FROM messages WHERE workspace_id = $1 AND id = $2",
      [workspace.workspaceId, olderUserMessageId],
    )).resolves.toEqual({ content: "older question" });
  });

  it("atomically fences user, assistant, conversation, and retention deletion without crossing workspaces", async () => {
    const user = await createTopicTurn("delete-user");
    const assistant = await createTopicTurn("delete-assistant");
    const conversation = await createTopicTurn("delete-conversation");
    const retention = await createTopicTurn("delete-retention");
    const foreign = await createTopicTurn("delete-foreign");

    await database.execute("DELETE FROM messages WHERE workspace_id = $1 AND id = $2", [
      user.workspace.workspaceId,
      user.userMessageId,
    ]);
    await database.execute("DELETE FROM messages WHERE workspace_id = $1 AND id = $2", [
      assistant.workspace.workspaceId,
      assistant.assistantMessageId,
    ]);
    await database.execute("DELETE FROM conversations WHERE workspace_id = $1 AND id = $2", [
      conversation.workspace.workspaceId,
      conversation.conversationId,
    ]);
    const observations = new ContentPlanObservationRepository(database.kysely);
    await expect(observations.pruneExpiredObservations({
      workspaceId: retention.workspace.workspaceId,
      observedBefore: new Date("2026-07-02T00:00:00Z"),
      limit: 1,
    })).resolves.toMatchObject({ deletedCount: 1 });

    for (const deleted of [user, assistant, conversation, retention]) {
      await expectPrivacyCleared(deleted);
    }
    await expect(database.queryOne<{ revision: number; enrichments: string; documents: string }>(
      `SELECT topic.revision,
         (SELECT count(*) FROM content_plan_topic_enrichments enrichment
          WHERE enrichment.workspace_id = topic.workspace_id
            AND enrichment.generation_id = topic.generation_id
            AND enrichment.topic_id = topic.id)::text AS enrichments,
         (SELECT count(*) FROM content_plan_topic_documents document
          WHERE document.workspace_id = topic.workspace_id
            AND document.generation_id = topic.generation_id
            AND document.topic_id = topic.id)::text AS documents
       FROM content_plan_topics topic
       WHERE topic.workspace_id = $1 AND topic.generation_id = $2 AND topic.id = $3`,
      [foreign.workspace.workspaceId, foreign.workspace.generationId, foreign.topicId],
    )).resolves.toEqual({ revision: 1, enrichments: "1", documents: "1" });
  });

  it("rejects an old claimed enrichment after a concurrent source deletion commits", async () => {
    const fixture = await createTopicTurn("claimed-delete");
    const claimToken = randomUUID();
    await database.execute(
      `UPDATE content_plan_topic_enrichments
       SET state = 'stale', claim_token = $4, claim_expires_at = '2099-01-01T00:00:00Z'
       WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
      [fixture.workspace.workspaceId, fixture.workspace.generationId, fixture.topicId, claimToken],
    );

    let releaseDeletion!: () => void;
    let reportDeletionApplied!: () => void;
    const deletionApplied = new Promise<void>((resolve) => { reportDeletionApplied = resolve; });
    const deletionRelease = new Promise<void>((resolve) => { releaseDeletion = resolve; });
    const deleting = database.kysely.transaction().execute(async (trx) => {
      await trx
        .deleteFrom("messages")
        .where("workspace_id", "=", fixture.workspace.workspaceId)
        .where("id", "=", fixture.userMessageId)
        .executeTakeFirst();
      reportDeletionApplied();
      await deletionRelease;
    });
    await deletionApplied;

    const enrichments = new ContentPlanEnrichmentRepository(database.kysely);
    let publicationSettled = false;
    const publishing = enrichments.publishEnrichment({
      workspaceId: fixture.workspace.workspaceId,
      generationId: fixture.workspace.generationId,
      topicId: fixture.topicId,
      sourceTopicRevision: 1,
      sourceEvidence: {
        memberCount: 1,
        groundedCount: 0,
        degradedCount: 1,
        noSupportCount: 0,
        notEvaluatedCount: 0,
        credibleOpportunity: false,
      },
      sourceCorpusEvidenceFingerprint: null,
      claimToken,
      publishState: "ready",
      label: "Must not publish",
      description: "Must not survive deletion",
      suggestedTitle: null,
      rationale: null,
      questionsToAnswer: null,
      suggestedShape: null,
      evidenceStatement: null,
      action: "monitor",
      actionRuleVersion: 1,
      corpusState: "ready",
      corpusCheckedAt: new Date("2026-08-02T00:00:00Z"),
      enrichedAt: new Date("2026-08-02T00:00:00Z"),
    }).then((published) => {
      publicationSettled = true;
      return published;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const publicationWaitedForDeletion = !publicationSettled;
    releaseDeletion();
    await deleting;

    expect(publicationWaitedForDeletion).toBe(true);
    await expect(publishing).resolves.toBe(false);
    await expect(database.query(
      `SELECT label FROM content_plan_topic_enrichments
       WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
      [fixture.workspace.workspaceId, fixture.workspace.generationId, fixture.topicId],
    )).resolves.toEqual([]);
  });

  it("marks document deletion after cascade, resets partial progress, and keeps fanout bounded", async () => {
    const workspace = await createWorkspace("document-fanout");
    const topicIds = Array.from({ length: 105 }, () => randomUUID()).sort();
    for (const topicId of topicIds) {
      await database.execute(
        `INSERT INTO content_plan_topics (
           workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
           dimensions, centroid_weight, representative_observation_ids, revision
         ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 2, '{}'::uuid[], 1)`,
        [workspace.workspaceId, workspace.generationId, topicId, workspace.embeddingSpaceId],
      );
      await database.execute(
        `INSERT INTO content_plan_topic_enrichments (
           workspace_id, generation_id, topic_id, source_topic_revision,
           source_member_count, source_degraded_count, source_credible_opportunity,
           source_evidence_strength, published_source_member_count,
           published_source_grounded_count, published_source_degraded_count,
           published_source_no_support_count, published_source_not_evaluated_count,
           published_source_credible_opportunity, published_source_evidence_strength,
           action_rule_version, state, label, description, corpus_state, enriched_at
         ) VALUES ($1, $2, $3, 1, 2, 2, TRUE, 'low', 2, 0, 2, 0, 0, TRUE, 'low',
           1, 'ready', 'Topic', 'Description', 'ready', NOW())`,
        [workspace.workspaceId, workspace.generationId, topicId],
      );
    }
    const documentId = randomUUID();
    await database.execute(
      `INSERT INTO documents (
         id, workspace_id, title, source_content, markdown_content, status, revision, metadata
       ) VALUES ($1, $2, 'Delete fence', 'source', 'markdown', 'ready', 1, '{}'::jsonb)`,
      [documentId, workspace.workspaceId],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_documents (
         workspace_id, generation_id, topic_id, document_id, source_topic_revision, similarity
       ) VALUES ($1, $2, $3, $4, 1, 0.9)`,
      [workspace.workspaceId, workspace.generationId, topicIds[104], documentId],
    );

    const invalidations = new ContentPlanCorpusInvalidationRepository(database.kysely);
    await invalidations.markWorkspaceDirty({
      workspaceId: workspace.workspaceId,
      dirtyAt: new Date("2026-08-02T00:00:00Z"),
    });
    await invalidations.drainWorkspace({ workspaceId: workspace.workspaceId, limit: 5 });
    const beforeDelete = await database.query<{ id: string; revision: number }>(
      "SELECT id, revision FROM content_plan_topics WHERE workspace_id = $1 ORDER BY id",
      [workspace.workspaceId],
    );

    await database.execute(
      "DELETE FROM documents WHERE workspace_id = $1 AND id = $2",
      [workspace.workspaceId, documentId],
    );
    await expect(database.query(
      `SELECT document_id FROM content_plan_topic_documents
       WHERE workspace_id = $1 AND document_id = $2`,
      [workspace.workspaceId, documentId],
    )).resolves.toEqual([]);
    await expect(database.queryOne<{
      revision: string;
      after_generation_id: string | null;
      after_topic_id: string | null;
    }>(
      `SELECT revision::text, after_generation_id, after_topic_id
       FROM content_plan_corpus_invalidations WHERE workspace_id = $1`,
      [workspace.workspaceId],
    )).resolves.toEqual({ revision: "2", after_generation_id: null, after_topic_id: null });
    await expect(database.query<{ id: string; revision: number }>(
      "SELECT id, revision FROM content_plan_topics WHERE workspace_id = $1 ORDER BY id",
      [workspace.workspaceId],
    )).resolves.toEqual(beforeDelete);

    await expect(invalidations.drainWorkspace({ workspaceId: workspace.workspaceId, limit: 100 }))
      .resolves.toMatchObject({ invalidatedCount: 100, pending: true });
    await expect(invalidations.drainWorkspace({ workspaceId: workspace.workspaceId, limit: 100 }))
      .resolves.toMatchObject({ invalidatedCount: 5, pending: false });
    const final = await database.query<{ revision: number; state: string; corpus_state: string }>(
      `SELECT topic.revision, enrichment.state, enrichment.corpus_state
       FROM content_plan_topics topic
       JOIN content_plan_topic_enrichments enrichment
         ON enrichment.workspace_id = topic.workspace_id
        AND enrichment.generation_id = topic.generation_id
        AND enrichment.topic_id = topic.id
       WHERE topic.workspace_id = $1`,
      [workspace.workspaceId],
    );
    expect(final).toHaveLength(105);
    expect(final.every((row) => row.revision >= 2 && row.state === "stale" && row.corpus_state === "stale"))
      .toBe(true);
  });

  it("rolls document deletion back when its unavoidable post-delete marker cannot persist", async () => {
    const workspace = await createWorkspace("document-marker-failure");
    const documentId = randomUUID();
    await database.execute(
      `INSERT INTO documents (
         id, workspace_id, title, source_content, markdown_content, status, revision, metadata
       ) VALUES ($1, $2, 'Delete failure', 'source', 'markdown', 'ready', 1, '{}'::jsonb)`,
      [documentId, workspace.workspaceId],
    );
    await database.execute(
      `INSERT INTO content_plan_corpus_invalidations (
         workspace_id, revision, dirty_at
       ) VALUES ($1, 9223372036854775807, NOW())`,
      [workspace.workspaceId],
    );

    await expect(database.execute(
      "DELETE FROM documents WHERE workspace_id = $1 AND id = $2",
      [workspace.workspaceId, documentId],
    )).rejects.toThrow();
    await expect(database.queryOne<{ id: string }>(
      "SELECT id FROM documents WHERE workspace_id = $1 AND id = $2",
      [workspace.workspaceId, documentId],
    )).resolves.toEqual({ id: documentId });
  });
});
