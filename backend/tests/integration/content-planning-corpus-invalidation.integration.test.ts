import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ContentPlanCorpusInvalidationRepository } from "../../src/db/repositories/contentPlanningCorpusInvalidationRepository.js";
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

describeIfDatabase("content-planning corpus invalidation queue", () => {
  const databaseName = `content_plan_corpus_invalidation_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin
      ?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("coalesces multi-document publication and drains credible topics in bounded batches", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const embeddingSpaceId = randomUUID();
    const generationId = randomUUID();
    const credibleTopicIds = Array.from({ length: 5 }, () => randomUUID()).sort();
    const monitorTopicId = randomUUID();
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Corpus queue', $2, 'hash')",
      [accountId, `corpus-queue-${accountId}@example.com`],
    );
    await database.execute(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, 'Corpus queue', $3)`,
      [workspaceId, accountId, `corpus-queue-${workspaceId}`],
    );
    await database.execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, 'corpus-model', 3, 'cosine', 'unit')`,
      [embeddingSpaceId, `corpus-space-${embeddingSpaceId}`, `corpus-endpoint-${embeddingSpaceId}`],
    );
    await database.execute(
      `INSERT INTO content_plan_projection_generations (
         id, workspace_id, embedding_space_id, kind, state, policy_version,
         horizon_from, horizon_to, coherent_at
       ) VALUES ($1, $2, $3, 'active', 'coherent', 1, $4, $5, $5)`,
      [
        generationId,
        workspaceId,
        embeddingSpaceId,
        new Date("2026-06-03T00:00:00.000Z"),
        new Date("2026-08-02T00:00:00.000Z"),
      ],
    );
    const topicIds = [...credibleTopicIds, monitorTopicId];
    for (const topicId of topicIds) {
      await database.execute(
        `INSERT INTO content_plan_topics (
           workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
           dimensions, centroid_weight, representative_observation_ids, revision
         ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 2, '{}'::uuid[], 1)`,
        [workspaceId, generationId, topicId, embeddingSpaceId],
      );
      const credible = topicId !== monitorTopicId;
      await database.execute(
        `INSERT INTO content_plan_topic_enrichments (
           workspace_id, generation_id, topic_id, source_topic_revision,
           source_member_count, source_degraded_count, source_credible_opportunity,
           published_source_member_count, published_source_grounded_count,
           published_source_degraded_count, published_source_no_support_count,
           published_source_not_evaluated_count,
           published_source_credible_opportunity, published_source_evidence_strength,
           action_rule_version, state, label, description, corpus_state, enriched_at
         ) VALUES (
           $1, $2, $3, 1, 2, 2, $4,
           2, 0, 2, 0, 0, $4, 'low', 1, 'ready', 'Topic', 'Description', 'ready', $5
         )`,
        [workspaceId, generationId, topicId, credible, new Date("2026-08-02T00:00:00.000Z")],
      );
    }

    const queue = new ContentPlanCorpusInvalidationRepository(database.kysely);
    const firstDirtyAt = new Date("2026-08-02T12:00:00.000Z");
    for (let document = 0; document < 20; document += 1) {
      await queue.markWorkspaceDirty({ workspaceId, dirtyAt: firstDirtyAt });
    }
    const markers = await database.query<{ count: string; revision: string }>(
      `SELECT COUNT(*)::text AS count, MAX(revision)::text AS revision
       FROM content_plan_corpus_invalidations
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(markers[0]).toEqual({ count: "1", revision: "20" });

    await expect(queue.drainWorkspace({ workspaceId, limit: 2 }))
      .resolves.toMatchObject({ invalidatedCount: 2, pending: true });
    const afterFirst = await topicRevisions(database, workspaceId, generationId);
    expect([...afterFirst.values()].filter((revision) => revision === 2)).toHaveLength(2);

    // A publication racing a partially drained marker resets the cursor under the
    // marker row lock. Replaying an already-invalidated bounded batch is safe; no
    // not-yet-visited topic can be skipped.
    const secondDirtyAt = new Date("2026-08-02T12:00:01.000Z");
    await queue.markWorkspaceDirty({ workspaceId, dirtyAt: secondDirtyAt });
    await expect(queue.drainWorkspace({ workspaceId, limit: 2 }))
      .resolves.toMatchObject({ invalidatedCount: 2, pending: true });

    const batchSizes: number[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      const result = await queue.drainWorkspace({ workspaceId, limit: 2 });
      batchSizes.push(result.invalidatedCount);
      if (!result.pending) break;
    }
    expect(batchSizes.every((size) => size <= 2)).toBe(true);
    const final = await topicRevisions(database, workspaceId, generationId);
    expect(credibleTopicIds.every((topicId) => (final.get(topicId) ?? 0) >= 2)).toBe(true);
    expect(final.get(monitorTopicId)).toBe(1);
    await expect(database.query(
      "SELECT workspace_id FROM content_plan_corpus_invalidations WHERE workspace_id = $1",
      [workspaceId],
    )).resolves.toEqual([]);

    const racedTopicId = credibleTopicIds[0]!;
    const revisionBeforeRace = final.get(racedTopicId)!;
    await queue.markWorkspaceDirty({
      workspaceId,
      dirtyAt: new Date("2026-08-02T12:00:02.000Z"),
    });
    let releaseMutation!: () => void;
    let reportMutationLocked!: () => void;
    const mutationLocked = new Promise<void>((resolve) => { reportMutationLocked = resolve; });
    const mutationRelease = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const concurrentMutation = database.kysely.transaction().execute(async (trx) => {
      await trx
        .updateTable("content_plan_topics")
        .set((eb) => ({ revision: eb("revision", "+", 1) }))
        .where("workspace_id", "=", workspaceId)
        .where("generation_id", "=", generationId)
        .where("id", "=", racedTopicId)
        .executeTakeFirst();
      reportMutationLocked();
      await mutationRelease;
    });
    await mutationLocked;
    const racedDrain = queue.drainWorkspace({ workspaceId, limit: 1 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseMutation();
    await concurrentMutation;

    await expect(racedDrain).resolves.toMatchObject({ invalidatedCount: 1, pending: true });
    const afterRace = await topicRevisions(database, workspaceId, generationId);
    expect(afterRace.get(racedTopicId)).toBe(revisionBeforeRace + 2);

    for (let batch = 0; batch < 10; batch += 1) {
      const result = await queue.drainWorkspace({ workspaceId, limit: 2 });
      if (!result.pending) break;
    }
    const beforeTargetedDeletion = await topicRevisions(database, workspaceId, generationId);
    const documentId = randomUUID();
    await database.execute(
      `INSERT INTO documents (
         id, workspace_id, title, source_content, markdown_content, status, revision, metadata
       ) VALUES ($1, $2, 'Deleted corpus source', 'source', 'markdown', 'ready', 1, '{}')`,
      [documentId, workspaceId],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_documents (
         workspace_id, generation_id, topic_id, document_id, source_topic_revision,
         similarity, existed_before_gap, retrieved_by_gap_answers,
         cited_by_gap_answers, changed_after_gap
       ) VALUES ($1, $2, $3, $4, 1, 0.9, TRUE, FALSE, FALSE, FALSE)`,
      [workspaceId, generationId, monitorTopicId, documentId],
    );

    await expect(queue.invalidateDeletedDocument({
      workspaceId,
      documentId,
      dirtyAt: new Date("2026-08-02T12:00:03.000Z"),
    })).resolves.toBe(1);
    const targeted = await database.query<{
      revision: number;
      state: string;
      corpus_state: string;
    }>(
      `SELECT topic.revision, enrichment.state, enrichment.corpus_state
       FROM content_plan_topics topic
       JOIN content_plan_topic_enrichments enrichment
         ON enrichment.workspace_id = topic.workspace_id
        AND enrichment.generation_id = topic.generation_id
        AND enrichment.topic_id = topic.id
       WHERE topic.workspace_id = $1 AND topic.generation_id = $2 AND topic.id = $3`,
      [workspaceId, generationId, monitorTopicId],
    );
    expect(targeted[0]).toEqual({ revision: 2, state: "stale", corpus_state: "stale" });
    const afterTargetedDeletion = await topicRevisions(database, workspaceId, generationId);
    expect(credibleTopicIds.every((topicId) =>
      afterTargetedDeletion.get(topicId) === beforeTargetedDeletion.get(topicId))).toBe(true);
    await expect(database.query(
      `SELECT document_id FROM content_plan_topic_documents
       WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
      [workspaceId, generationId, monitorTopicId],
    )).resolves.toEqual([]);
  });
});

const topicRevisions = async (
  database: Database,
  workspaceId: string,
  generationId: string,
): Promise<Map<string, number>> => {
  const rows = await database.query<{ id: string; revision: number }>(
    `SELECT id, revision
     FROM content_plan_topics
     WHERE workspace_id = $1 AND generation_id = $2`,
    [workspaceId, generationId],
  );
  return new Map(rows.map((row) => [row.id, row.revision]));
};
