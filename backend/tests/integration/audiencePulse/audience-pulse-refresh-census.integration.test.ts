import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { AudiencePulseSnapshotRepository } from "../../../src/db/repositories/audiencePulseSnapshotRepository.js";
import { MessageFacetRepository } from "../../../src/db/repositories/messageFacetRepository.js";
import { TopicRepository } from "../../../src/db/repositories/topicRepository.js";
import type { AudiencePulseServiceDependencies } from "../../../src/modules/audiencePulse/services/audiencePulseService.js";
import { AudiencePulseService } from "../../../src/modules/audiencePulse/services/audiencePulseService.js";
import { CensusService } from "../../../src/modules/audiencePulse/services/censusService.js";
import type { CensusServiceFactory } from "../../../src/modules/audiencePulse/infra/censusServiceFactory.js";
import { PostgresAudiencePulseHistorySource } from "../../../src/modules/chat/audiencePulseHistorySource.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const CURRENT_PROMPT_VERSION = "facet-extraction/refresh-census-integration-test";
const REFRESH_NOW = new Date("2026-07-31T00:00:00.000Z");

// The same well-separated fixture `CensusService`'s own integration suite uses: two
// deterministic groups so k-means assigns them predictably. This test is not about
// clustering correctness (`@radioso/census` owns that); it is about `refresh()`
// actually wiring the census's real output into a persisted, exact report.
const GROUP_A_VECTORS = [[1, 0, 0], [0.98, 0.02, 0], [0.97, 0, 0.03], [0.99, 0.01, 0.01]];
const GROUP_B_VECTORS = [[0, 1, 0], [0.02, 0.98, 0], [0, 0.97, 0.03], [0.01, 0.99, 0.01]];

describeIntegration("AudiencePulseService.refresh() (Postgres, real census)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const historySource = new PostgresAudiencePulseHistorySource(database.kysely);
  const facetSource = new MessageFacetRepository(database.kysely);
  const topicRepository = new TopicRepository(database.kysely);
  const snapshotStore = new AudiencePulseSnapshotRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const embeddingProfileId = randomUUID();

  const namingPort = {
    name: async () => ({ title: "A named topic", description: "A deterministic test label." }),
    nameFallback: async () => ({ title: "General", description: "Fallback label" }),
  };
  const privacyAuditPort = { review: async () => ({ flagged: false }) };

  const censusServiceFactory: CensusServiceFactory = {
    create: () => new CensusService({
      historySource,
      facetSource,
      topicRepository,
      embeddingSpaceResolver: { resolveClusteringSpace: async () => ({ id: embeddingProfileId }) },
      namingPort,
      privacyAuditPort,
      currentFacetPromptVersion: CURRENT_PROMPT_VERSION,
    }),
  };

  const modelSummary = JSON.stringify({
    summary: "Visitors mostly asked about two distinct kinds of questions this period.",
    themes: [],
    recommendations: [],
    caveats: [],
  });

  const buildService = (): AudiencePulseService => {
    const deps: AudiencePulseServiceDependencies = {
      historySource,
      snapshotStore,
      runGate: { async tryAcquire() { return { async release() {} }; } },
      refreshRateLimit: { async enforce() {} },
      inferenceFactory: {
        async create() {
          return {
            metadata: { capability: "chat" as const, provider: "openai" as const, model: "test-model" },
            async complete() { return { text: modelSummary }; },
            stream() { throw new Error("not used"); },
          };
        },
      },
      censusServiceFactory,
      usageLimitPolicy: {
        async reserveAnswer() {
          return { async commit() {}, async release() {} };
        },
        async reserveDocument() { throw new Error("not used"); },
        async reserveIndexedStorage() { throw new Error("not used"); },
        async reserveMonthlyIndexedContent() { throw new Error("not used"); },
      },
      auditService: { async record() {} },
      now: () => REFRESH_NOW,
    };
    return new AudiencePulseService(deps);
  };

  const createConversation = async (): Promise<string> => {
    const id = randomUUID();
    await database.query("INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)", [id, workspaceId]);
    return id;
  };

  const seedQuestion = async (input: { conversationId: string; createdAt: string; vector: number[] }): Promise<string> => {
    const messageId = randomUUID();
    await database.query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, workspace_id, source)
       VALUES ($1, $2, 'user', $3, $4, $5, 'customer')`,
      [messageId, input.conversationId, `Question about ${input.vector.join(",")}`, input.createdAt, workspaceId],
    );
    await facetSource.upsertFacet({
      messageId,
      workspaceId,
      facetText: `facet about ${input.vector.join(",")}`,
      promptVersion: CURRENT_PROMPT_VERSION,
    });
    await facetSource.attachEmbedding({ messageId, embedding: input.vector, embeddingProfileId });
    return messageId;
  };

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Refresh Census Test", `refresh-census-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Refresh Census Workspace", `refresh-census-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model, dimensions,
         distance_metric, normalization
       ) VALUES ($1, $2, 'openai', $3, $4, 3, 'cosine', 'provider_unit')`,
      [
        embeddingProfileId,
        `refresh-census-space-${embeddingProfileId}`,
        `refresh-census-endpoint-${embeddingProfileId}`,
        `refresh-census-model-${embeddingProfileId}`,
      ],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM audience_pulse_snapshots WHERE workspace_id = $1", [workspaceId]);
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

  it("covers every eligible question in the window and persists a snapshot that reads back with exact counts", async () => {
    const conversationId = await createConversation();
    let day = 1;
    for (const vector of [...GROUP_A_VECTORS, ...GROUP_B_VECTORS]) {
      await seedQuestion({
        conversationId,
        createdAt: `2026-07-${String(day).padStart(2, "0")}T00:00:00.000Z`,
        vector,
      });
      day += 1;
    }
    const populationSize = GROUP_A_VECTORS.length + GROUP_B_VECTORS.length;

    const service = buildService();
    const result = await service.refresh({ accountId, userId: randomUUID(), workspaceId });

    if (result.kind !== "completed") throw new Error(`expected a completed refresh, got ${result.kind}`);
    // Every seeded question has a current, embedded facet, so the whole population is
    // facet-ready: this run measured the audience rather than reporting a window that
    // has not been processed yet.
    expect(result.report.coverage).toEqual({
      populationSize,
      sampleSize: populationSize,
      sampled: false,
      facetReadyQuestionCount: populationSize,
    });
    // Spec 956 FR-005/FR-003: every eligible question is a member of exactly one
    // topic or unclassified, and the two sum to the window's full population -- no
    // sample, no gap. The two well-separated seed groups are known to cluster clean
    // (`census-service.integration.test.ts` proves this same fixture), so every
    // question lands in one of exactly two topics with none left unclassified.
    const classified = result.report.themes.reduce((sum, theme) => sum + theme.memberCount, 0);
    expect(classified + result.report.unclassifiedQuestionCount).toBe(populationSize);
    expect(result.report.themes).toHaveLength(2);
    expect(result.report.unclassifiedQuestionCount).toBe(0);
    expect(result.report.themes.map((theme) => theme.memberCount).sort()).toEqual([4, 4]);

    const read = await service.read({ accountId, userId: randomUUID(), workspaceId });
    if (read.kind !== "completed") throw new Error(`expected a completed saved read, got ${read.kind}`);
    expect(read.report.coverage).toEqual(result.report.coverage);
    expect(read.report.unclassifiedQuestionCount).toBe(result.report.unclassifiedQuestionCount);
    expect(read.report.themes.map((theme) => ({ id: theme.id, memberCount: theme.memberCount, share: theme.share })))
      .toEqual(result.report.themes.map((theme) => ({ id: theme.id, memberCount: theme.memberCount, share: theme.share })));

    const runRow = await database.query<{ question_count: number; unclassified_count: number }>(
      "SELECT question_count, unclassified_count FROM topic_census_runs WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(runRow).toHaveLength(1);
    expect(runRow[0]!.question_count).toBe(populationSize);
    expect(runRow[0]!.unclassified_count).toBe(result.report.unclassifiedQuestionCount);
  });
});
