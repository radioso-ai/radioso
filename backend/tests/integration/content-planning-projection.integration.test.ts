import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresContentPlanProjectionDiscovery } from "../../src/app/composition/adapters/contentPlanningProjectionDiscovery.js";
import { PostgresContentPlanProjectionCandidateSource } from "../../src/app/composition/adapters/contentPlanningProjectionCandidates.js";
import { PostgresContentPlanHistoricalTurnSource } from "../../src/app/composition/adapters/contentPlanningHistoricalTurnSource.js";
import { ContentPlanProjectionRepository } from "../../src/db/repositories/contentPlanningProjectionRepository.js";
import { QualityContentPlanningEvidenceSource } from "../../src/modules/quality/composition.js";
import {
  CONTENT_PLAN_PROJECTION_BUDGET_V1,
  ContentPlanProjectionBudgetService,
} from "../../src/modules/contentPlanning/services/projectionBudgetService.js";
import { ContentPlanProjectionOrchestrator } from "../../src/modules/contentPlanning/services/projectionOrchestrator.js";
import { ContentPlanHistoricalTurnProjectionService } from "../../src/modules/contentPlanning/services/historicalTurnProjectionService.js";
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
}

interface TurnFixture {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

describeIfDatabase("content-planning projection orchestration", () => {
  const databaseName = `content_plan_projection_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;
  let projections: ContentPlanProjectionRepository;

  const createWorkspace = async (suffix: string): Promise<WorkspaceFixture> => {
    const fixture = {
      accountId: randomUUID(),
      workspaceId: randomUUID(),
      embeddingSpaceId: randomUUID(),
    };
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash')",
      [fixture.accountId, `Projection ${suffix}`, `projection-${suffix}-${fixture.accountId}@example.com`],
    );
    await database.execute(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)`,
      [fixture.workspaceId, fixture.accountId, `Projection ${suffix}`, `projection-${suffix}-${fixture.workspaceId}`],
    );
    await database.execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, $4, 3, 'cosine', 'unit')`,
      [
        fixture.embeddingSpaceId,
        `projection-space-${fixture.embeddingSpaceId}`,
        `projection-endpoint-${fixture.embeddingSpaceId}`,
        `projection-model-${suffix}`,
      ],
    );
    await database.execute(
      `INSERT INTO workspace_embedding_profiles (workspace_id, active_embedding_space_id)
       VALUES ($1, $2)`,
      [fixture.workspaceId, fixture.embeddingSpaceId],
    );
    return fixture;
  };

  const createTurn = async (
    fixture: WorkspaceFixture,
    createdAt: string,
    suffix: string,
  ): Promise<TurnFixture> => {
    const turn = {
      conversationId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
    };
    await database.execute(
      `INSERT INTO conversations (id, workspace_id, source_channel)
       VALUES ($1, $2, 'embed')`,
      [turn.conversationId, fixture.workspaceId],
    );
    await database.execute(
      `INSERT INTO messages (
         id, conversation_id, workspace_id, role, content, metadata_json, created_at
       ) VALUES
         ($1, $3, $4, 'user', $5, $6::jsonb, $7::timestamptz - INTERVAL '1 second'),
         ($2, $3, $4, 'assistant', 'message-owned answer', '{}'::jsonb, $7::timestamptz)`,
      [
        turn.userMessageId,
        turn.assistantMessageId,
        turn.conversationId,
        fixture.workspaceId,
        `message-owned question ${suffix}`,
        JSON.stringify({
          conversationInteraction: {
            version: 1,
            role: "substantive_new",
            semanticIntents: [{ id: `intent-${suffix}`, text: `canonical semantic intent ${suffix}` }],
          },
        }),
        createdAt,
      ],
    );
    return turn;
  };

  const createGeneration = async (input: {
    workspaceId: string;
    embeddingSpaceId: string;
    kind: "bootstrap" | "active" | "reprojection";
    state: "building" | "coherent";
  }) => projections.createGeneration({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    embeddingSpaceId: input.embeddingSpaceId,
    kind: input.kind,
    state: input.state,
    policyVersion: 1,
    horizonFrom: new Date("2026-06-03T00:00:00.000Z"),
    horizonTo: new Date("2026-08-02T00:00:00.000Z"),
    coherentAt: input.state === "coherent" ? new Date("2026-08-02T00:00:00.000Z") : null,
  });

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runAllTestMigrations(database);
    projections = new ContentPlanProjectionRepository(database.kysely);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin
      ?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("freezes a bounded 60-day bootstrap and advances processed/total with the Quality cursor", async () => {
    const fixture = await createWorkspace("bootstrap");
    await createTurn(fixture, "2026-05-31T23:59:59.000Z", "outside");
    await createTurn(fixture, "2026-06-03T00:00:00.000Z", "first");
    await createTurn(fixture, "2026-07-15T12:00:00.000Z", "second");

    const quality = new QualityContentPlanningEvidenceSource(database.kysely);
    const budget = new ContentPlanProjectionBudgetService(projections, {
      ...CONTENT_PLAN_PROJECTION_BUDGET_V1,
      maxRequests: 10,
      maxEstimatedSpendMicros: 100_000,
    });
    const orchestrator = new ContentPlanProjectionOrchestrator({
      projections,
      population: quality,
      discovery: new PostgresContentPlanProjectionDiscovery(database.kysely),
      budget,
      historicalTurns: new ContentPlanHistoricalTurnProjectionService(
        new PostgresContentPlanHistoricalTurnSource(database.kysely),
        budget,
      ),
    }, {
      pageSize: 1,
      leaseMs: 30_000,
    });
    const now = new Date("2026-08-02T00:00:00.000Z");

    await expect(orchestrator.runWorkspaceOnce({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      now,
    })).resolves.toMatchObject({ kind: "progressed", processed: 1, total: 2 });

    const firstState = await projections.findProjectionState(fixture.workspaceId);
    expect(firstState).toMatchObject({
      projectionState: "bootstrapping",
      bootstrapProcessed: "1",
      bootstrapTotal: "2",
    });
    const target = await projections.findGeneration(
      firstState!.targetGenerationId!,
      fixture.workspaceId,
    );
    expect(target).toMatchObject({
      kind: "bootstrap",
      state: "building",
      horizonFrom: new Date("2026-06-03T00:00:00.000Z"),
      horizonTo: now,
    });

    await expect(orchestrator.runWorkspaceOnce({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      now: new Date("2026-08-02T00:00:01.000Z"),
    })).resolves.toMatchObject({ kind: "awaiting_projection", processed: 2, total: 2 });
    await expect(projections.findProjectionState(fixture.workspaceId)).resolves.toMatchObject({
      bootstrapProcessed: "2",
      bootstrapTotal: "2",
    });
  });

  it("initializes a transaction-created null-progress target from the frozen Quality population before paging", async () => {
    const fixture = await createWorkspace("intake-target");
    await createTurn(fixture, "2026-07-01T00:00:00.000Z", "first");
    await createTurn(fixture, "2026-07-02T00:00:00.000Z", "second");
    const now = new Date("2026-08-02T00:00:00.000Z");
    const target = await projections.ensureTargetGeneration({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      generationId: randomUUID(),
      policyVersion: 1,
      horizonFrom: new Date("2026-06-03T00:00:00.000Z"),
      horizonTo: now,
      total: null,
      budgetVersion: 1,
      budgetWindowStartedAt: now,
    });
    const quality = new QualityContentPlanningEvidenceSource(database.kysely);
    const budget = new ContentPlanProjectionBudgetService(projections);
    const orchestrator = new ContentPlanProjectionOrchestrator({
      projections,
      population: quality,
      discovery: new PostgresContentPlanProjectionDiscovery(database.kysely),
      historicalTurns: new ContentPlanHistoricalTurnProjectionService(
        new PostgresContentPlanHistoricalTurnSource(database.kysely),
        budget,
      ),
      budget,
    }, { pageSize: 1, leaseMs: 30_000 });

    await expect(orchestrator.runWorkspaceOnce({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      now,
    })).resolves.toEqual({
      kind: "progressed",
      processed: 0,
      total: 2,
      generationId: target.generation.id,
    });
    await expect(projections.findProjectionState(fixture.workspaceId)).resolves.toMatchObject({
      targetGenerationId: target.generation.id,
      coherentGenerationId: null,
      bootstrapProcessed: "0",
      bootstrapTotal: "2",
    });
    await expect(projections.findGeneration(target.generation.id, fixture.workspaceId))
      .resolves.toMatchObject({ state: "building" });

    await expect(orchestrator.runWorkspaceOnce({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      now: new Date("2026-08-02T00:00:01.000Z"),
    })).resolves.toMatchObject({ kind: "progressed", processed: 1, total: 2 });
  });

  it("rolls back observation discovery when cursor/progress cannot commit atomically", async () => {
    const fixture = await createWorkspace("atomic");
    const foreign = await createWorkspace("atomic-foreign");
    const valid = await createTurn(fixture, "2026-07-01T00:00:00.000Z", "atomic-valid");
    const invalid = await createTurn(foreign, "2026-07-01T00:00:01.000Z", "atomic-invalid");
    const generation = await createGeneration({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      kind: "bootstrap",
      state: "building",
    });
    await projections.upsertProjectionState({
      workspaceId: fixture.workspaceId,
      coherentGenerationId: null,
      targetGenerationId: generation.id,
      projectionState: "bootstrapping",
      reason: null,
      processedThrough: null,
      bootstrapProcessed: "0",
      bootstrapTotal: "2",
      budgetVersion: 1,
      budgetWindowStartedAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    const lease = await projections.claimProjectionLease({
      workspaceId: fixture.workspaceId,
      now: new Date("2026-08-02T00:00:00.000Z"),
      leaseMs: 30_000,
    });
    const discovery = new PostgresContentPlanProjectionDiscovery(database.kysely);

    await expect(discovery.commitPage({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      leaseToken: lease!.leaseToken!,
      turns: [valid, invalid].map((turn, index) => ({
        conversationId: turn.conversationId,
        sourceChannel: "embed",
        sourceUserMessageId: turn.userMessageId,
        sourceAssistantMessageId: turn.assistantMessageId,
        interaction: {
          role: "substantive_new" as const,
          semanticIntents: [{ id: `atomic-${index}`, text: `atomic semantic ${index}` }],
        },
      })),
      cursor: {
        createdAt: new Date("2026-07-01T00:00:01.000Z"),
        assistantMessageId: invalid.assistantMessageId,
      },
      processed: 2,
      total: 2,
    })).rejects.toThrow("source user message is unavailable");

    const state = await projections.findProjectionState(fixture.workspaceId);
    expect(state).toMatchObject({
      discoveryCreatedAt: null,
      discoveryMessageId: null,
      bootstrapProcessed: "0",
      bootstrapTotal: "2",
    });
    const rows = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM content_plan_observations WHERE workspace_id = $1",
      [fixture.workspaceId],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("pauses each workspace independently and resumes with zeroed counters at the next UTC day", async () => {
    const first = await createWorkspace("budget-first");
    const second = await createWorkspace("budget-second");
    for (const fixture of [first, second]) {
      const generation = await createGeneration({
        workspaceId: fixture.workspaceId,
        embeddingSpaceId: fixture.embeddingSpaceId,
        kind: "bootstrap",
        state: "building",
      });
      await projections.upsertProjectionState({
        workspaceId: fixture.workspaceId,
        coherentGenerationId: null,
        targetGenerationId: generation.id,
        projectionState: "bootstrapping",
        reason: null,
        processedThrough: null,
        bootstrapProcessed: "0",
        bootstrapTotal: "4",
        budgetVersion: 1,
        budgetWindowStartedAt: new Date("2026-08-02T00:00:00.000Z"),
      });
    }
    const firstState = await projections.findProjectionState(first.workspaceId);
    const secondState = await projections.findProjectionState(second.workspaceId);
    const budget = new ContentPlanProjectionBudgetService(projections, {
      version: 1,
      maxRequests: 1,
      maxEstimatedSpendMicros: 10,
    });

    await expect(budget.reserve({
      workspaceId: first.workspaceId,
      generationId: firstState!.targetGenerationId!,
      requests: 1,
      estimatedSpendMicros: 10,
      now: new Date("2026-08-02T23:59:58.000Z"),
    })).resolves.toEqual({ kind: "granted" });
    await expect(budget.reserve({
      workspaceId: first.workspaceId,
      generationId: firstState!.targetGenerationId!,
      requests: 1,
      estimatedSpendMicros: 1,
      now: new Date("2026-08-02T23:59:59.000Z"),
    })).resolves.toEqual({ kind: "budget_paused", reason: "daily_budget_exhausted" });
    await expect(budget.reserve({
      workspaceId: second.workspaceId,
      generationId: secondState!.targetGenerationId!,
      requests: 1,
      estimatedSpendMicros: 10,
      now: new Date("2026-08-02T23:59:59.000Z"),
    })).resolves.toEqual({ kind: "granted" });
    await expect(projections.findProjectionState(first.workspaceId)).resolves.toMatchObject({
      projectionState: "budget_paused",
      reason: "daily_budget_exhausted",
      embeddingRequestsUsed: 1,
      estimatedSpendMicros: "10",
    });

    await expect(budget.reserve({
      workspaceId: first.workspaceId,
      generationId: firstState!.targetGenerationId!,
      requests: 1,
      estimatedSpendMicros: 2,
      now: new Date("2026-08-03T00:00:00.000Z"),
    })).resolves.toEqual({ kind: "granted" });
    await expect(projections.findProjectionState(first.workspaceId)).resolves.toMatchObject({
      projectionState: "bootstrapping",
      reason: null,
      budgetWindowStartedAt: new Date("2026-08-03T00:00:00.000Z"),
      embeddingRequestsUsed: 1,
      estimatedSpendMicros: "2",
    });
  });

  it("selects only durable active work and keeps budget-neutral work moving while embeddings are paused", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const budgetWindowStartedAt = new Date("2026-08-02T00:00:00.000Z");
    const candidates = new PostgresContentPlanProjectionCandidateSource(database.kysely);

    const idle = await createWorkspace("candidate-idle");
    const idleGeneration = await createGeneration({
      workspaceId: idle.workspaceId,
      embeddingSpaceId: idle.embeddingSpaceId,
      kind: "active",
      state: "coherent",
    });
    await projections.upsertProjectionState({
      workspaceId: idle.workspaceId,
      coherentGenerationId: idleGeneration.id,
      targetGenerationId: null,
      projectionState: "ready",
      reason: null,
      processedThrough: now,
      bootstrapProcessed: null,
      bootstrapTotal: null,
      budgetVersion: 1,
      budgetWindowStartedAt,
    });

    const createPausedTarget = async (suffix: string) => {
      const fixture = await createWorkspace(suffix);
      const generation = await createGeneration({
        workspaceId: fixture.workspaceId,
        embeddingSpaceId: fixture.embeddingSpaceId,
        kind: "bootstrap",
        state: "building",
      });
      await projections.upsertProjectionState({
        workspaceId: fixture.workspaceId,
        coherentGenerationId: null,
        targetGenerationId: generation.id,
        projectionState: "budget_paused",
        reason: "daily_budget_exhausted",
        processedThrough: null,
        bootstrapProcessed: "0",
        bootstrapTotal: "1",
        budgetVersion: 1,
        budgetWindowStartedAt,
      });
      return { fixture, generation };
    };
    const insertObservationWork = async (input: {
      fixture: WorkspaceFixture;
      generationId: string;
      suffix: string;
      vector: "reused" | "missing";
    }) => {
      const turn = await createTurn(input.fixture, "2026-08-02T11:00:00.000Z", input.suffix);
      const observationId = randomUUID();
      await database.execute(
        `INSERT INTO content_plan_observations (
           id, workspace_id, source_user_message_id, source_assistant_message_id,
           conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
           observation_state, observed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'substantive_new', 'ready', $8)`,
        [
          observationId,
          input.fixture.workspaceId,
          turn.userMessageId,
          turn.assistantMessageId,
          turn.conversationId,
          `candidate-${input.suffix}`,
          "a".repeat(64),
          "2026-08-02T11:00:00.000Z",
        ],
      );
      if (input.vector === "reused") {
        await database.execute(
          `INSERT INTO content_plan_observation_vectors (
             workspace_id, observation_id, generation_id, embedding_space_id,
             dimensions, embedding, vector_source, state, available_at
           ) VALUES ($1, $2, $3, $4, 3, '[1,0,0]'::vector, 'reused', 'ready', $5)`,
          [input.fixture.workspaceId, observationId, input.generationId, input.fixture.embeddingSpaceId, now],
        );
      } else {
        await database.execute(
          `INSERT INTO content_plan_observation_vectors (
             workspace_id, observation_id, generation_id, embedding_space_id,
             state, available_at
           ) VALUES ($1, $2, $3, $4, 'pending_embedding', $5)`,
          [input.fixture.workspaceId, observationId, input.generationId, input.fixture.embeddingSpaceId, now],
        );
      }
    };

    const assignment = await createPausedTarget("candidate-assignment");
    await insertObservationWork({
      fixture: assignment.fixture,
      generationId: assignment.generation.id,
      suffix: "assignment",
      vector: "reused",
    });

    const fallback = await createPausedTarget("candidate-fallback");
    await insertObservationWork({
      fixture: fallback.fixture,
      generationId: fallback.generation.id,
      suffix: "fallback",
      vector: "missing",
    });

    const enrichment = await createPausedTarget("candidate-enrichment");
    const topicId = randomUUID();
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 2, '{}'::uuid[], 1)`,
      [
        enrichment.fixture.workspaceId,
        enrichment.generation.id,
        topicId,
        enrichment.fixture.embeddingSpaceId,
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_enrichments (
         workspace_id, generation_id, topic_id, source_topic_revision,
         action_rule_version, state, available_at
       ) VALUES ($1, $2, $3, 1, 1, 'pending', $4)`,
      [enrichment.fixture.workspaceId, enrichment.generation.id, topicId, now],
    );

    const sameDay = new Set((await candidates.listCandidates({ limit: 100, now }))
      .map((candidate) => candidate.workspaceId));
    expect(sameDay.has(idle.workspaceId)).toBe(false);
    expect(sameDay.has(assignment.fixture.workspaceId)).toBe(true);
    expect(sameDay.has(enrichment.fixture.workspaceId)).toBe(true);
    expect(sameDay.has(fallback.fixture.workspaceId)).toBe(false);

    const nextBudgetWindow = new Set((await candidates.listCandidates({
      limit: 100,
      now: new Date("2026-08-03T00:00:00.000Z"),
    })).map((candidate) => candidate.workspaceId));
    expect(nextBudgetWindow.has(fallback.fixture.workspaceId)).toBe(true);

    const workspaceWorkIndexes = await database.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = ANY($1::text[])`,
      [[
        "idx_content_plan_vectors_workspace_due",
        "idx_content_plan_vectors_workspace_expired",
        "idx_content_plan_topics_workspace_dirty",
        "idx_content_plan_enrichments_workspace_due",
      ]],
    );
    expect(new Set(workspaceWorkIndexes.map((row) => row.indexname))).toEqual(new Set([
      "idx_content_plan_vectors_workspace_due",
      "idx_content_plan_vectors_workspace_expired",
      "idx_content_plan_topics_workspace_dirty",
      "idx_content_plan_enrichments_workspace_due",
    ]));
  });

  it("keeps the old generation coherent until the target passes the consistency gate, then hands off atomically", async () => {
    const fixture = await createWorkspace("reprojection");
    const sourceSpaceId = randomUUID();
    await database.execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, 'source-model', 3, 'cosine', 'unit')`,
      [sourceSpaceId, `source-space-${sourceSpaceId}`, `source-endpoint-${sourceSpaceId}`],
    );
    const turn = await createTurn(fixture, "2026-07-01T00:00:00.000Z", "reprojection");
    const coherent = await createGeneration({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: sourceSpaceId,
      kind: "active",
      state: "coherent",
    });
    const observationId = randomUUID();
    await database.execute(
      `INSERT INTO content_plan_observations (
         id, workspace_id, source_user_message_id, source_assistant_message_id,
         conversation_id, semantic_intent_id, semantic_text_hash, interaction_role,
         observation_state, observed_at
       ) VALUES ($1, $2, $3, $4, $5, 'reprojection', $6, 'substantive_new', 'ready', $7)`,
      [
        observationId,
        fixture.workspaceId,
        turn.userMessageId,
        turn.assistantMessageId,
        turn.conversationId,
        "a".repeat(64),
        "2026-07-01T00:00:00.000Z",
      ],
    );
    await projections.upsertProjectionState({
      workspaceId: fixture.workspaceId,
      coherentGenerationId: coherent.id,
      targetGenerationId: null,
      projectionState: "ready",
      reason: null,
      processedThrough: new Date("2026-08-02T00:00:00.000Z"),
      bootstrapProcessed: null,
      bootstrapTotal: null,
      budgetVersion: 1,
      budgetWindowStartedAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    const target = await projections.ensureTargetGeneration({
      workspaceId: fixture.workspaceId,
      embeddingSpaceId: fixture.embeddingSpaceId,
      generationId: randomUUID(),
      policyVersion: 1,
      horizonFrom: new Date("2026-06-03T00:00:00.000Z"),
      horizonTo: new Date("2026-08-02T00:00:00.000Z"),
      total: "1",
      budgetVersion: 1,
      budgetWindowStartedAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    expect(target).toMatchObject({ kind: "target", generation: { kind: "reprojection" } });
    const lease = await projections.claimProjectionLease({
      workspaceId: fixture.workspaceId,
      now: new Date("2026-08-02T00:00:00.000Z"),
      leaseMs: 30_000,
    });
    await projections.advanceDiscoveryCursor({
      workspaceId: fixture.workspaceId,
      leaseToken: lease!.leaseToken!,
      discoveryCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
      discoveryMessageId: turn.assistantMessageId,
      bootstrapProcessed: "1",
      bootstrapTotal: "1",
    });

    await expect(projections.promoteGeneration({
      workspaceId: fixture.workspaceId,
      targetGenerationId: target.generation.id,
      expectedCoherentGenerationId: coherent.id,
      leaseToken: lease!.leaseToken!,
      coherentAt: new Date("2026-08-02T00:00:01.000Z"),
      processedThrough: new Date("2026-08-02T00:00:00.000Z"),
    })).resolves.toBeNull();
    await expect(projections.findGeneration(coherent.id, fixture.workspaceId)).resolves.toMatchObject({
      state: "coherent",
    });

    const topicId = randomUUID();
    await database.execute(
      `INSERT INTO content_plan_observation_vectors (
         workspace_id, observation_id, generation_id, embedding_space_id,
         dimensions, embedding, vector_source, state, completed_at
       ) VALUES ($1, $2, $3, $4, 3, '[1,0,0]'::vector, 'fallback', 'assigned', $5)`,
      [fixture.workspaceId, observationId, target.generation.id, fixture.embeddingSpaceId, "2026-08-02T00:00:00.000Z"],
    );
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, 'provisional', '[1,0,0]'::vector, 3, 1, $5::uuid[], 1)`,
      [fixture.workspaceId, target.generation.id, topicId, fixture.embeddingSpaceId, [observationId]],
    );
    await database.execute(
      `INSERT INTO content_plan_topic_memberships (
         workspace_id, generation_id, observation_id, topic_id,
         assignment_version, similarity, cohesion, assigned_at
       ) VALUES ($1, $2, $3, $4, 1, 1, 1, $5)`,
      [fixture.workspaceId, target.generation.id, observationId, topicId, "2026-08-02T00:00:00.000Z"],
    );

    const promoted = await projections.promoteGeneration({
      workspaceId: fixture.workspaceId,
      targetGenerationId: target.generation.id,
      expectedCoherentGenerationId: coherent.id,
      leaseToken: lease!.leaseToken!,
      coherentAt: new Date("2026-08-02T00:00:02.000Z"),
      processedThrough: new Date("2026-08-02T00:00:00.000Z"),
    });
    expect(promoted).toMatchObject({
      coherentGenerationId: target.generation.id,
      targetGenerationId: null,
      projectionState: "ready",
    });
    await expect(projections.findGeneration(coherent.id, fixture.workspaceId)).resolves.toMatchObject({
      state: "superseded",
    });
  });
});
