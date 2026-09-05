import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { MessageFacetRepository } from "../../../src/db/repositories/messageFacetRepository.js";
import { TopicRepository } from "../../../src/db/repositories/topicRepository.js";
import type { TopicLabel, TopicNamingExemplars, TopicNamingPort } from "../../../src/modules/audiencePulse/contracts/topicLabel.js";
import { CensusService } from "../../../src/modules/audiencePulse/services/censusService.js";
import { PostgresAudiencePulseHistorySource } from "../../../src/modules/chat/audiencePulseHistorySource.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const CURRENT_PROMPT_VERSION = "facet-extraction/census-integration-test";

// Two well-separated groups so k-means assigns them deterministically; clustering
// correctness itself is packages/census's own responsibility (tested there). These
// fixtures only need a predictable partition to exercise the orchestration.
const GROUP_A_VECTORS = [[1, 0, 0], [0.98, 0.02, 0], [0.97, 0, 0.03], [0.99, 0.01, 0.01]];
const GROUP_B_VECTORS = [[0, 1, 0], [0.02, 0.98, 0], [0, 0.97, 0.03], [0.01, 0.99, 0.01]];

describeIntegration("CensusService (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const historySource = new PostgresAudiencePulseHistorySource(database.kysely);
  const facetSource = new MessageFacetRepository(database.kysely);
  const topicRepository = new TopicRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const embeddingProfileId = randomUUID();
  const windowStart = new Date("2026-07-01T00:00:00.000Z");
  const windowEnd = new Date("2026-07-31T00:00:00.000Z");

  const namingPort = {
    name: async (exemplars: TopicNamingExemplars): Promise<TopicLabel> => ({
      title: `Topic: ${exemplars.prototypical[0] ?? "unknown"}`,
      description: "Deterministic test label, never read for membership",
    }),
    nameFallback: async (): Promise<TopicLabel> => ({ title: "General", description: "Fallback label" }),
  };
  const privacyAuditPort = { review: async () => ({ flagged: false }) };

  const buildService = (overrides: { namingPort?: TopicNamingPort } = {}): CensusService => new CensusService({
    historySource,
    facetSource,
    topicRepository,
    embeddingSpaceResolver: { resolveClusteringSpace: async () => ({ id: embeddingProfileId }) },
    namingPort: overrides.namingPort ?? namingPort,
    privacyAuditPort,
    currentFacetPromptVersion: CURRENT_PROMPT_VERSION,
  });

  const createConversation = async (): Promise<string> => {
    const id = randomUUID();
    await database.query("INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)", [id, workspaceId]);
    return id;
  };

  const createMessage = async (input: { conversationId: string; createdAt: string }): Promise<string> => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, workspace_id, source)
       VALUES ($1, $2, 'user', 'irrelevant', $3, $4, 'customer')`,
      [id, input.conversationId, input.createdAt, workspaceId],
    );
    return id;
  };

  const seedClusterablePopulation = async (): Promise<{ conversationId: string; messageIds: string[] }> => {
    const conversationId = await createConversation();
    const messageIds: string[] = [];
    let day = 1;
    for (const vector of [...GROUP_A_VECTORS, ...GROUP_B_VECTORS]) {
      const messageId = await createMessage({
        conversationId,
        createdAt: `2026-07-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      });
      day += 1;
      await facetSource.upsertFacet({
        messageId,
        workspaceId,
        facetText: `question about ${vector.join(",")}`,
        promptVersion: CURRENT_PROMPT_VERSION,
      });
      await facetSource.attachEmbedding({ messageId, embedding: vector, embeddingProfileId });
      messageIds.push(messageId);
    }
    return { conversationId, messageIds };
  };

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Census Service Test", `census-service-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Census Service Workspace", `census-service-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model, dimensions,
         distance_metric, normalization
       ) VALUES ($1, $2, 'openai', $3, $4, 3, 'cosine', 'provider_unit')`,
      [
        embeddingProfileId,
        `census-service-space-${embeddingProfileId}`,
        `census-service-endpoint-${embeddingProfileId}`,
        `census-service-model-${embeddingProfileId}`,
      ],
    );
  });

  beforeEach(async () => {
    await database.query(
      "DELETE FROM topic_transitions WHERE run_id IN (SELECT id FROM topic_census_runs WHERE workspace_id = $1)",
      [workspaceId],
    );
    await database.query(
      "DELETE FROM topic_memberships WHERE run_id IN (SELECT id FROM topic_census_runs WHERE workspace_id = $1)",
      [workspaceId],
    );
    await database.query("DELETE FROM topics WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM topic_census_runs WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM message_facets WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM messages WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM conversations WHERE workspace_id = $1", [workspaceId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM embedding_spaces WHERE id = $1", [embeddingProfileId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("records a partial census run without publishing incomplete topics or memberships", async () => {
    const { conversationId, messageIds: clusterableIds } = await seedClusterablePopulation();

    await createMessage({ conversationId, createdAt: "2026-07-10T00:00:00.000Z" });

    const staleId = await createMessage({ conversationId, createdAt: "2026-07-11T00:00:00.000Z" });
    await facetSource.upsertFacet({ messageId: staleId, workspaceId, facetText: "stale facet text", promptVersion: "old-version" });
    await facetSource.attachEmbedding({ messageId: staleId, embedding: [1, 1, 1], embeddingProfileId });

    const noEmbeddingId = await createMessage({ conversationId, createdAt: "2026-07-12T00:00:00.000Z" });
    await facetSource.upsertFacet({ messageId: noEmbeddingId, workspaceId, facetText: "not embedded yet", promptVersion: CURRENT_PROMPT_VERSION });

    const result = await buildService().run({ workspaceId, windowStart, windowEnd });

    expect(result.populationSize).toBe(clusterableIds.length + 3);
    const totalTopicMembers = result.topics.reduce((sum, topic) => sum + topic.memberCount, 0);
    expect(totalTopicMembers + result.unclassifiedCount).toBe(result.populationSize);
    expect(result.unclassifiedCount).toBeGreaterThanOrEqual(3);
    for (const topic of result.topics) {
      expect(topic.share).toBeCloseTo(topic.memberCount / result.populationSize, 10);
    }

    const persisted = await topicRepository.loadRun(result.runId);
    expect(persisted).not.toBeNull();
    expect(persisted?.questionCount).toBe(result.populationSize);
    expect(persisted?.unclassifiedCount).toBe(result.unclassifiedCount);
    expect(persisted?.topics).toEqual([]);

    const membershipRows = await database.query<{ message_id: string }>(
      "SELECT message_id FROM topic_memberships WHERE run_id = $1",
      [result.runId],
    );
    expect(membershipRows).toEqual([]);
  });

  it("produces identical topic membership across two runs over identical input", async () => {
    await seedClusterablePopulation();

    const firstRun = await buildService().run({ workspaceId, windowStart, windowEnd });
    const secondRun = await buildService().run({ workspaceId, windowStart, windowEnd });

    const groupsForRun = async (runId: string): Promise<string[][]> => {
      const rows = await database.query<{ topic_id: string; message_id: string }>(
        "SELECT topic_id, message_id FROM topic_memberships WHERE run_id = $1",
        [runId],
      );
      const byTopic = new Map<string, string[]>();
      for (const row of rows) {
        const bucket = byTopic.get(row.topic_id) ?? [];
        bucket.push(row.message_id);
        byTopic.set(row.topic_id, bucket);
      }
      return [...byTopic.values()].map((ids) => [...ids].sort()).sort();
    };

    expect(firstRun.populationSize).toBe(secondRun.populationSize);
    expect(firstRun.unclassifiedCount).toBe(secondRun.unclassifiedCount);
    expect(await groupsForRun(firstRun.runId)).toEqual(await groupsForRun(secondRun.runId));

    const firstRunRow = await database.query<{ seed: string }>(
      "SELECT seed FROM topic_census_runs WHERE id = $1",
      [firstRun.runId],
    );
    const secondRunRow = await database.query<{ seed: string }>(
      "SELECT seed FROM topic_census_runs WHERE id = $1",
      [secondRun.runId],
    );
    expect(firstRunRow[0].seed).toBe(secondRunRow[0].seed);
  });

  it("carries topic identity across runs: unchanged topics survive with identifier and label intact, a topic with its questions removed is recorded dissolved", async () => {
    const { messageIds } = await seedClusterablePopulation();
    const groupAIds = messageIds.slice(0, GROUP_A_VECTORS.length);
    const groupBIds = messageIds.slice(GROUP_A_VECTORS.length);

    const spyNamingPort = {
      name: vi.fn(namingPort.name),
      nameFallback: vi.fn(namingPort.nameFallback),
    };

    const firstRun = await buildService({ namingPort: spyNamingPort }).run({ workspaceId, windowStart, windowEnd });
    expect(firstRun.topics).toHaveLength(2);
    // Every topic in a first run over a workspace with no prior history is emerged,
    // so every cluster is named.
    expect(spyNamingPort.name).toHaveBeenCalledTimes(2);

    // Both groups are the same size, so member count alone cannot tell them apart;
    // correlate by an actual membership row instead.
    const firstMembershipRows = await database.query<{ topic_id: string; message_id: string }>(
      "SELECT topic_id, message_id FROM topic_memberships WHERE run_id = $1",
      [firstRun.runId],
    );
    const topicIdByMessageId = new Map(firstMembershipRows.map((row) => [row.message_id, row.topic_id]));
    const groupATopicId = topicIdByMessageId.get(groupAIds[0])!;
    const groupBTopicId = topicIdByMessageId.get(groupBIds[0])!;
    expect(groupATopicId).not.toBe(groupBTopicId);
    const groupAResult = firstRun.topics.find((topic) => topic.topicId === groupATopicId)!;
    const groupBResult = firstRun.topics.find((topic) => topic.topicId === groupBTopicId)!;

    spyNamingPort.name.mockClear();
    const secondRun = await buildService({ namingPort: spyNamingPort }).run({ workspaceId, windowStart, windowEnd });

    // Nothing changed between the two runs, so both topics survive and neither is
    // renamed: no naming call at all on the second run (spec 956 US2/US3).
    expect(spyNamingPort.name).not.toHaveBeenCalled();
    const secondTopicIds = secondRun.topics.map((topic) => topic.topicId).sort();
    expect(secondTopicIds).toEqual([groupAResult.topicId, groupBResult.topicId].sort());
    const secondGroupA = secondRun.topics.find((topic) => topic.topicId === groupAResult.topicId)!;
    const secondGroupB = secondRun.topics.find((topic) => topic.topicId === groupBResult.topicId)!;
    expect(secondGroupA.title).toBe(groupAResult.title);
    expect(secondGroupA.description).toBe(groupAResult.description);
    expect(secondGroupB.title).toBe(groupBResult.title);
    expect(secondGroupB.description).toBe(groupBResult.description);

    const secondTransitionRows = await database.query<{ topic_id: string; kind: string; via_centroid_fallback: boolean }>(
      "SELECT topic_id, kind, via_centroid_fallback FROM topic_transitions WHERE run_id = $1",
      [secondRun.runId],
    );
    expect(secondTransitionRows).toHaveLength(2);
    for (const row of secondTransitionRows) {
      expect(row.kind).toBe("survived");
      expect(row.via_centroid_fallback).toBe(false);
    }

    const activeAfterSecondRun = await topicRepository.listActiveTopics(workspaceId);
    expect(activeAfterSecondRun.map((topic) => topic.id).sort()).toEqual(secondTopicIds);

    // Group B's questions disappear from the window entirely: its topic no longer
    // has a counterpart in the next run and must be recorded dissolved, not deleted.
    await database.query("DELETE FROM message_facets WHERE message_id = ANY($1)", [groupBIds]);
    await database.query("DELETE FROM messages WHERE id = ANY($1)", [groupBIds]);

    spyNamingPort.name.mockClear();
    const thirdRun = await buildService({ namingPort: spyNamingPort }).run({ workspaceId, windowStart, windowEnd });

    expect(thirdRun.populationSize).toBe(groupAIds.length);
    // Group A's topic survives (possibly with a member pruned as an outlier once
    // isolated), still under no naming call.
    expect(spyNamingPort.name).not.toHaveBeenCalled();
    const thirdGroupA = thirdRun.topics.find((topic) => topic.topicId === groupAResult.topicId);
    expect(thirdGroupA).toBeDefined();
    expect(thirdGroupA?.title).toBe(groupAResult.title);
    expect(thirdRun.topics.some((topic) => topic.topicId === groupBResult.topicId)).toBe(false);

    const thirdTransitionRows = await database.query<{ topic_id: string; kind: string }>(
      "SELECT topic_id, kind FROM topic_transitions WHERE run_id = $1",
      [thirdRun.runId],
    );
    const groupBTransition = thirdTransitionRows.find((row) => row.topic_id === groupBResult.topicId);
    expect(groupBTransition?.kind).toBe("dissolved");

    const groupBTopicRow = await database.query<{ dissolved_at: Date | null; title: string }>(
      "SELECT dissolved_at, title FROM topics WHERE id = $1",
      [groupBResult.topicId],
    );
    expect(groupBTopicRow[0].dissolved_at).not.toBeNull();
    // Retained, not deleted -- so a topic that returns is recognizable.
    expect(groupBTopicRow[0].title).toBe(groupBResult.title);

    const activeAfterThirdRun = await topicRepository.listActiveTopics(workspaceId);
    expect(activeAfterThirdRun.map((topic) => topic.id)).toEqual([groupAResult.topicId]);
  });
});
