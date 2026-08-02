import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ContentPlanEnrichmentRepository } from "../../src/db/repositories/contentPlanningEnrichmentRepository.js";
import { ContentPlanCorpusInvalidationRepository } from "../../src/db/repositories/contentPlanningCorpusInvalidationRepository.js";
import { ContentPlanEnrichmentTriggerRepository } from "../../src/db/repositories/contentPlanningEnrichmentTriggerRepository.js";
import { ContentPlanObservationRepository } from "../../src/db/repositories/contentPlanningObservationRepository.js";
import { ContentPlanProjectionRepository } from "../../src/db/repositories/contentPlanningProjectionRepository.js";
import { ContentPlanTopicRepository } from "../../src/db/repositories/contentPlanningTopicRepository.js";
import { RepositoryContentPlanEnrichmentQueue } from "../../src/modules/contentPlanning/infra/repositoryEnrichmentPorts.js";
import { ContentPlanningEnrichmentScheduler } from "../../src/modules/contentPlanning/services/enrichmentScheduler.js";
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

interface RepositoryFixture {
  accountId: string;
  workspaceId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  embeddingSpaceId: string;
}

describeIfDatabase("content-planning Kysely repositories", () => {
  let database: Database;
  let observations: ContentPlanObservationRepository;
  let projections: ContentPlanProjectionRepository;
  let topics: ContentPlanTopicRepository;
  let enrichments: ContentPlanEnrichmentRepository;
  let corpusInvalidations: ContentPlanCorpusInvalidationRepository;
  let enrichmentTriggers: ContentPlanEnrichmentTriggerRepository;
  const accountIds: string[] = [];
  const enrichmentEvidence = {
    memberCount: 2,
    groundedCount: 0,
    degradedCount: 1,
    noSupportCount: 1,
    notEvaluatedCount: 0,
    credibleOpportunity: true,
  } as const;
  const enrichmentCorpusFingerprint = "b".repeat(64);
  const refreshedEnrichmentCorpusFingerprint = "d".repeat(64);
  const updatedEnrichmentEvidence = {
    memberCount: 3,
    groundedCount: 0,
    degradedCount: 1,
    noSupportCount: 2,
    notEvaluatedCount: 0,
    credibleOpportunity: true,
  } as const;
  const updatedEnrichmentCorpusFingerprint = "c".repeat(64);

  const createFixture = async (suffix: string, dimensions = 3): Promise<RepositoryFixture> => {
    const fixture: RepositoryFixture = {
      accountId: randomUUID(),
      workspaceId: randomUUID(),
      conversationId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      embeddingSpaceId: randomUUID(),
    };
    accountIds.push(fixture.accountId);
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash')",
      [fixture.accountId, `Repositories ${suffix}`, `content-plan-repo-${suffix}-${fixture.accountId}@example.com`],
    );
    await database.execute(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)`,
      [fixture.workspaceId, fixture.accountId, `Workspace ${suffix}`, `repo-${suffix}-${fixture.workspaceId}`],
    );
    await database.execute(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [fixture.conversationId, fixture.workspaceId],
    );
    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, metadata_json)
       VALUES
         ($1, $3, $4, 'user', 'Where are deployment controls?', '{"conversationInteraction":{"version":1}}'::jsonb),
         ($2, $3, $4, 'assistant', 'Open deployment settings.', '{"answer":"metadata"}'::jsonb)`,
      [fixture.userMessageId, fixture.assistantMessageId, fixture.conversationId, fixture.workspaceId],
    );
    await database.execute(
      `UPDATE messages
       SET grounding_verdict = 'degraded', grounding_claim_count = 2,
           grounding_sourced_claim_count = 1, grounding_unsourced_claim_count = 1,
           grounding_invalid_source_count = 0
       WHERE id = $1`,
      [fixture.assistantMessageId],
    );
    await database.execute(
      `INSERT INTO audit_events (
         id, account_id, workspace_id, event_type, event_status, metadata_json
       ) VALUES ($1, $2, $3, 'chat.answer', 'success', $4::jsonb)`,
      [
        randomUUID(),
        fixture.accountId,
        fixture.workspaceId,
        JSON.stringify({ assistantMessageId: fixture.assistantMessageId, retrieval: { branchCount: 1 } }),
      ],
    );
    await database.execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, $4, $5, 'cosine', 'unit')`,
      [
        fixture.embeddingSpaceId,
        `content-plan-repo-space-${fixture.embeddingSpaceId}`,
        `repo-endpoint-${fixture.embeddingSpaceId}`,
        `repo-model-${fixture.embeddingSpaceId}`,
        dimensions,
      ],
    );
    return fixture;
  };

  const createGeneration = async (
    fixture: RepositoryFixture,
    state: "building" | "coherent",
    options: { embeddingSpaceId?: string; kind?: "bootstrap" | "active" | "reprojection" } = {},
  ) => projections.createGeneration({
    id: randomUUID(),
    workspaceId: fixture.workspaceId,
    embeddingSpaceId: options.embeddingSpaceId ?? fixture.embeddingSpaceId,
    kind: options.kind ?? "active",
    state,
    policyVersion: 1,
    horizonFrom: new Date("2026-06-01T00:00:00.000Z"),
    horizonTo: new Date("2026-08-01T00:00:00.000Z"),
    coherentAt: state === "coherent" ? new Date("2026-08-01T00:00:00.000Z") : null,
  });

  const registerReadyObservation = async (
    fixture: RepositoryFixture,
    generationId: string,
    semanticIntentId = "primary",
  ) => observations.registerTurn({
    workspaceId: fixture.workspaceId,
    conversationId: fixture.conversationId,
    sourceUserMessageId: fixture.userMessageId,
    sourceAssistantMessageId: fixture.assistantMessageId,
    interactionRole: "substantive_new",
    contributions: [{
      semanticIntentId,
      semanticTextHash: createHash("sha256").update(semanticIntentId).digest("hex"),
      observationState: "ready",
      vectorWork: {
        generationId,
        embeddingSpaceId: fixture.embeddingSpaceId,
        dimensions: 3,
        embedding: [1, 0, 0],
        vectorSource: "reused",
      },
    }],
  });

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    observations = new ContentPlanObservationRepository(database.kysely);
    projections = new ContentPlanProjectionRepository(database.kysely);
    topics = new ContentPlanTopicRepository(database.kysely);
    enrichments = new ContentPlanEnrichmentRepository(database.kysely);
    corpusInvalidations = new ContentPlanCorpusInvalidationRepository(database.kysely);
    enrichmentTriggers = new ContentPlanEnrichmentTriggerRepository(database.kysely);
  });

  afterAll(async () => {
    if (accountIds.length > 0) {
      await database.execute("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [accountIds]);
    }
    await database.close();
  });

  it("claims vector work with expiring leases and fences stale claim completion", async () => {
    const fixture = await createFixture("vector-claims");
    const generation = await createGeneration(fixture, "coherent");
    const registration = await observations.registerTurn({
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      sourceUserMessageId: fixture.userMessageId,
      sourceAssistantMessageId: fixture.assistantMessageId,
      interactionRole: "substantive_new",
      contributions: [{
        semanticIntentId: "primary",
        semanticTextHash: "a".repeat(64),
        observationState: "ready",
        vectorWork: {
          generationId: generation.id,
          embeddingSpaceId: fixture.embeddingSpaceId,
        },
      }],
    });
    const observation = registration.observations[0]!;
    const now = new Date("2099-08-02T12:00:00.000Z");

    const [firstClaim] = await observations.claimVectorBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 5,
      now,
      leaseMs: 30_000,
    });
    expect(firstClaim).toMatchObject({
      observationId: observation.id,
      state: "processing",
      attemptCount: 1,
      embedding: null,
    });
    expect(firstClaim?.claimToken).toEqual(expect.any(String));

    await expect(observations.storeClaimedEmbedding({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      observationId: observation.id,
      claimToken: randomUUID(),
      dimensions: 3,
      embedding: [0, 1, 0],
      vectorSource: "fallback",
    })).resolves.toBe(false);
    await expect(observations.storeClaimedEmbedding({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      observationId: observation.id,
      claimToken: firstClaim!.claimToken!,
      dimensions: 3,
      embedding: [0, 1, 0],
      vectorSource: "fallback",
    })).resolves.toBe(true);

    const [assignmentClaim] = await observations.claimVectorBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 5,
      now: new Date(now.getTime() + 1),
      leaseMs: 30_000,
    });
    expect(assignmentClaim).toMatchObject({ embedding: [0, 1, 0], attemptCount: 2 });
    await expect(observations.failVectorClaim({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      observationId: observation.id,
      claimToken: assignmentClaim!.claimToken!,
      terminal: false,
      failureStage: "assignment",
      failureReason: "transient_failure",
      availableAt: new Date(now.getTime() + 60_000),
    })).resolves.toBe(true);

    const sources = await observations.loadSources({
      workspaceId: fixture.workspaceId,
      observationIds: [observation.id],
      limit: 8,
    });
    expect(sources).toEqual([expect.objectContaining({
      observationId: observation.id,
      semanticIntentId: "primary",
      sourceUserContent: "Where are deployment controls?",
      sourceUserMetadata: { conversationInteraction: { version: 1 } },
      sourceAssistantMetadata: { answer: "metadata" },
      auditMetadata: {
        assistantMessageId: fixture.assistantMessageId,
        retrieval: { branchCount: 1 },
      },
    })]);
  });

  it("leases projection state and atomically promotes a coherent target generation", async () => {
    const fixture = await createFixture("promotion");
    const targetSpaceId = randomUUID();
    await database.execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, 'target-model', 3, 'cosine', 'unit')`,
      [targetSpaceId, `target-space-${targetSpaceId}`, `target-endpoint-${targetSpaceId}`],
    );
    const coherent = await createGeneration(fixture, "coherent");
    const target = await createGeneration(fixture, "building", {
      embeddingSpaceId: targetSpaceId,
      kind: "reprojection",
    });
    await projections.upsertProjectionState({
      workspaceId: fixture.workspaceId,
      coherentGenerationId: coherent.id,
      targetGenerationId: target.id,
      projectionState: "reprojecting",
      reason: null,
      processedThrough: new Date("2026-07-31T00:00:00.000Z"),
      bootstrapProcessed: "10",
      bootstrapTotal: "20",
      budgetVersion: 1,
      budgetWindowStartedAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    const lease = await projections.claimProjectionLease({
      workspaceId: fixture.workspaceId,
      now: new Date("2099-08-02T12:00:00.000Z"),
      leaseMs: 30_000,
    });
    expect(lease?.leaseToken).toEqual(expect.any(String));
    await expect(projections.advanceDiscoveryCursor({
      workspaceId: fixture.workspaceId,
      leaseToken: randomUUID(),
      discoveryCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
      discoveryMessageId: fixture.userMessageId,
      bootstrapProcessed: "11",
      bootstrapTotal: "20",
    })).resolves.toBe(false);
    await expect(projections.advanceDiscoveryCursor({
      workspaceId: fixture.workspaceId,
      leaseToken: lease!.leaseToken!,
      discoveryCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
      discoveryMessageId: fixture.userMessageId,
      bootstrapProcessed: "20",
      bootstrapTotal: "20",
    })).resolves.toBe(true);

    await expect(projections.promoteGeneration({
      workspaceId: fixture.workspaceId,
      targetGenerationId: target.id,
      expectedCoherentGenerationId: coherent.id,
      leaseToken: randomUUID(),
      coherentAt: new Date("2026-08-02T12:01:00.000Z"),
      processedThrough: new Date("2026-08-02T12:00:00.000Z"),
    })).resolves.toBeNull();
    const promoted = await projections.promoteGeneration({
      workspaceId: fixture.workspaceId,
      targetGenerationId: target.id,
      expectedCoherentGenerationId: coherent.id,
      leaseToken: lease!.leaseToken!,
      coherentAt: new Date("2026-08-02T12:01:00.000Z"),
      processedThrough: new Date("2026-08-02T12:00:00.000Z"),
    });
    expect(promoted).toMatchObject({
      coherentGenerationId: target.id,
      targetGenerationId: null,
      projectionState: "ready",
      leaseToken: null,
    });
    await expect(projections.findGeneration(coherent.id, fixture.workspaceId)).resolves.toMatchObject({
      state: "superseded",
    });
    await expect(projections.findGeneration(target.id, fixture.workspaceId)).resolves.toMatchObject({
      state: "coherent",
    });
  });

  it("assigns a claimed vector atomically, searches compatible centroids, and resolves bounded redirects", async () => {
    const fixture = await createFixture("topics");
    const generation = await createGeneration(fixture, "coherent");
    const registration = await registerReadyObservation(fixture, generation.id);
    const observation = registration.observations[0]!;
    const [claim] = await observations.claimVectorBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 1,
      now: new Date("2099-08-02T12:00:00.000Z"),
      leaseMs: 30_000,
    });
    const topicId = randomUUID();

    const assigned = await topics.createTopicAndAssign({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      observationId: observation.id,
      claimToken: claim!.claimToken!,
      topic: {
        id: topicId,
        embeddingSpaceId: fixture.embeddingSpaceId,
        lifecycle: "provisional",
        centroid: [1, 0, 0],
        dimensions: 3,
        centroidWeight: 1,
        representativeObservationIds: [observation.id],
        revision: 1,
        enrichmentDirtyAt: null,
      },
      assignmentVersion: 1,
      similarity: 1,
      cohesion: 1,
      assignedAt: new Date("2026-08-02T12:00:01.000Z"),
    });
    expect(assigned).toMatchObject({ applied: true, topic: { id: topicId } });
    await expect(topics.createTopicAndAssign({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      observationId: observation.id,
      claimToken: claim!.claimToken!,
      topic: {
        id: randomUUID(),
        embeddingSpaceId: fixture.embeddingSpaceId,
        lifecycle: "provisional",
        centroid: [1, 0, 0],
        dimensions: 3,
        centroidWeight: 1,
        representativeObservationIds: [observation.id],
        revision: 1,
        enrichmentDirtyAt: null,
      },
      assignmentVersion: 1,
      similarity: 1,
      cohesion: 1,
      assignedAt: new Date("2026-08-02T12:00:01.000Z"),
    })).resolves.toMatchObject({ applied: false });

    const secondRegistration = await registerReadyObservation(fixture, generation.id, "followup");
    const secondObservation = secondRegistration.observations[0]!;
    const thirdRegistration = await registerReadyObservation(fixture, generation.id, "another-intent");
    const thirdObservation = thirdRegistration.observations[0]!;
    const assignmentEvidence = await topics.loadAssignmentEvidence({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      observationId: secondObservation.id,
      topicIds: [topicId],
      limit: 5,
    });
    expect(assignmentEvidence).toEqual([expect.objectContaining({
      topicId,
      liveObservationCount: 1,
      liveConversationCount: 1,
      incomingConversationAlreadyPresent: true,
      representativeVectors: [{ observationId: observation.id, embedding: [1, 0, 0] }],
    })]);
    const concurrentClaims = await observations.claimVectorBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 2,
      now: new Date("2099-08-02T12:00:01.000Z"),
      leaseMs: 30_000,
    });
    const claimByObservation = new Map(concurrentClaims.map((item) => [item.observationId, item]));
    const secondClaim = claimByObservation.get(secondObservation.id)!;
    const thirdClaim = claimByObservation.get(thirdObservation.id)!;
    const joined = await topics.assignToExistingTopic({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      observationId: secondObservation.id,
      claimToken: secondClaim!.claimToken!,
      topicId,
      expectedTopicRevision: 1,
      topic: {
        lifecycle: "mature",
        centroid: [1, 0, 0],
        dimensions: 3,
        centroidWeight: 2,
        representativeObservationIds: [observation.id, secondObservation.id],
        revision: 2,
        enrichmentDirtyAt: new Date("2026-08-02T12:00:02.000Z"),
      },
      assignmentVersion: 1,
      similarity: 1,
      cohesion: 1,
      assignedAt: new Date("2026-08-02T12:00:02.000Z"),
    });
    expect(joined).toMatchObject({ applied: true, topic: { lifecycle: "mature", revision: 2 } });
    const staleConcurrentAssignment = {
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      observationId: thirdObservation.id,
      claimToken: thirdClaim.claimToken!,
      topicId,
      expectedTopicRevision: 1,
      topic: {
        lifecycle: "mature" as const,
        centroid: [1, 0, 0],
        dimensions: 3,
        centroidWeight: 2,
        representativeObservationIds: [observation.id, thirdObservation.id],
        revision: 2,
        enrichmentDirtyAt: new Date("2026-08-02T12:00:02.000Z"),
      },
      assignmentVersion: 1,
      similarity: 1,
      cohesion: 1,
      assignedAt: new Date("2026-08-02T12:00:02.000Z"),
    };
    await expect(topics.assignToExistingTopic(staleConcurrentAssignment)).resolves.toMatchObject({
      applied: false,
    });
    await expect(topics.assignToExistingTopic({
      ...staleConcurrentAssignment,
      expectedTopicRevision: 2,
      topic: {
        ...staleConcurrentAssignment.topic,
        centroidWeight: 3,
        representativeObservationIds: [observation.id, secondObservation.id, thirdObservation.id],
        revision: 3,
      },
    })).resolves.toMatchObject({ applied: true, topic: { revision: 3 } });
    await expect(topics.loadReconciliationEvidence({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicIds: [topicId],
      limit: 5,
    })).resolves.toEqual([expect.objectContaining({
      topicId,
      liveCentroid: [1, 0, 0],
      liveObservationCount: 3,
      liveConversationCount: 1,
      representativeObservationIds: [observation.id, secondObservation.id, thirdObservation.id],
    })]);

    const nearest = await topics.findNearestTopics({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      embeddingSpaceId: fixture.embeddingSpaceId,
      dimensions: 3,
      embedding: [1, 0, 0],
      limit: 5,
    });
    expect(nearest[0]).toMatchObject({ id: topicId, cosineSimilarity: 1 });

    const middleId = randomUUID();
    const sourceId = randomUUID();
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES
         ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 0, '{}'::uuid[], 1),
         ($1, $2, $5, $4, 'mature', '[1,0,0]'::vector, 3, 0, '{}'::uuid[], 1)`,
      [fixture.workspaceId, generation.id, middleId, fixture.embeddingSpaceId, sourceId],
    );
    const mergedAt = new Date("2026-08-02T12:00:03.000Z");
    const redirectExpiresAt = new Date("2026-11-01T12:00:03.000Z");
    await expect(topics.mergeTopics({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      sourceTopicId: sourceId,
      sourceExpectedRevision: 1,
      survivorTopicId: middleId,
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
    })).resolves.toMatchObject({ id: middleId, revision: 2 });
    await expect(topics.mergeTopics({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      sourceTopicId: middleId,
      sourceExpectedRevision: 2,
      survivorTopicId: topicId,
      survivorExpectedRevision: 3,
      survivor: {
        lifecycle: "mature",
        centroid: [1, 0, 0],
        dimensions: 3,
        centroidWeight: 3,
        representativeObservationIds: [observation.id, secondObservation.id, thirdObservation.id],
        revision: 4,
        enrichmentDirtyAt: mergedAt,
      },
      mergedAt,
      redirectExpiresAt,
    })).resolves.toMatchObject({ id: topicId, revision: 4 });
    await expect(topics.resolveTopicRedirect({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId: sourceId,
      now: new Date(),
    })).resolves.toMatchObject({
      kind: "active",
      redirectedFromTopicId: sourceId,
      topic: { id: topicId },
      hops: 2,
    });
    const pruned = await observations.pruneExpiredObservations({
      workspaceId: fixture.workspaceId,
      observedBefore: new Date("2099-08-03T00:00:00.000Z"),
      limit: 1,
    });
    expect(pruned).toMatchObject({
      deletedCount: 1,
      affectedTopics: [expect.objectContaining({ topicId })],
    });
    const [reconciliation] = await topics.loadReconciliationEvidence({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicIds: [topicId],
      limit: 1,
    });
    await expect(topics.reconcileTopic({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      expectedRevision: 4,
      topic: {
        lifecycle: "mature",
        centroid: reconciliation!.liveCentroid!,
        dimensions: 3,
        centroidWeight: reconciliation!.liveObservationCount,
        representativeObservationIds: reconciliation!.representativeObservationIds,
        revision: 5,
        enrichmentDirtyAt: new Date("2026-08-02T12:00:04.000Z"),
      },
    })).resolves.toMatchObject({ revision: 5, centroidWeight: 2 });
  });

  it("replenishes expired topic representatives from bounded live memberships", async () => {
    const fixture = await createFixture("representative-replenishment");
    const generation = await createGeneration(fixture, "coherent");
    const topicId = randomUUID();
    const observations = Array.from({ length: 12 }, (_, index) => ({
      id: randomUUID(),
      conversationId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      index,
    }));
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 12, $5::uuid[], 1)`,
      [
        fixture.workspaceId,
        generation.id,
        topicId,
        fixture.embeddingSpaceId,
        observations.slice(0, 8).map((observation) => observation.id),
      ],
    );
    for (const observation of observations) {
      await database.execute(
        "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
        [observation.conversationId, fixture.workspaceId],
      );
      await database.execute(
        `INSERT INTO messages (id, conversation_id, workspace_id, role, content, metadata_json)
         VALUES
           ($1, $3, $4, 'user', $5, '{}'::jsonb),
           ($2, $3, $4, 'assistant', 'Answer', '{}'::jsonb)`,
        [
          observation.userMessageId,
          observation.assistantMessageId,
          observation.conversationId,
          fixture.workspaceId,
          `Question ${observation.index}`,
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
          fixture.workspaceId,
          observation.userMessageId,
          observation.assistantMessageId,
          observation.conversationId,
          createHash("sha256").update(`representative-${observation.index}`).digest("hex"),
          new Date(`2026-07-${String(observation.index + 1).padStart(2, "0")}T12:00:00.000Z`),
        ],
      );
      await database.execute(
        `INSERT INTO content_plan_observation_vectors (
           workspace_id, observation_id, generation_id, embedding_space_id,
           dimensions, embedding, vector_source, state, completed_at
         ) VALUES ($1, $2, $3, $4, 3, '[1,0,0]'::vector, 'reused', 'assigned', $5)`,
        [
          fixture.workspaceId,
          observation.id,
          generation.id,
          fixture.embeddingSpaceId,
          new Date(`2026-07-${String(observation.index + 1).padStart(2, "0")}T12:00:00.000Z`),
        ],
      );
      await database.execute(
        `INSERT INTO content_plan_topic_memberships (
           workspace_id, generation_id, observation_id, topic_id,
           assignment_version, similarity, cohesion, assigned_at
         ) VALUES ($1, $2, $3, $4, 1, $5, $5, $6)`,
        [
          fixture.workspaceId,
          generation.id,
          observation.id,
          topicId,
          0.99 - (observation.index / 100),
          new Date(`2026-07-${String(observation.index + 1).padStart(2, "0")}T12:00:00.000Z`),
        ],
      );
    }
    await database.execute(
      "DELETE FROM content_plan_observations WHERE workspace_id = $1 AND id = ANY($2::uuid[])",
      [fixture.workspaceId, observations.slice(0, 8).map((observation) => observation.id)],
    );

    const [evidence] = await topics.loadReconciliationEvidence({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicIds: [topicId],
      limit: 1,
    });

    expect(evidence).toMatchObject({
      liveObservationCount: 4,
      liveConversationCount: 4,
      representativeObservationIds: observations.slice(8).map((observation) => observation.id),
    });
  });

  it("rebases a non-material mature-topic revision without claiming provider work", async () => {
    const fixture = await createFixture("enrichment-rebase");
    const generation = await createGeneration(fixture, "coherent");
    const topicId = randomUUID();
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 2, '{}'::uuid[], 1)`,
      [fixture.workspaceId, generation.id, topicId, fixture.embeddingSpaceId],
    );
    await enrichments.queueEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 1,
      sourceEvidence: enrichmentEvidence,
      sourceEvidenceStrength: "low",
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      analysisMode: "label_and_brief",
      publishState: "ready",
      actionRuleVersion: 1,
      availableAt: new Date("2026-08-02T12:00:00.000Z"),
    });
    const [claim] = await enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 1,
      now: new Date("2026-08-02T12:00:00.000Z"),
      leaseMs: 30_000,
    });
    await expect(enrichments.publishEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 1,
      sourceEvidence: enrichmentEvidence,
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      claimToken: claim!.claimToken!,
      publishState: "ready",
      label: "Deployment controls",
      description: "Questions about deployment configuration.",
      suggestedTitle: "Deployment controls guide",
      rationale: "Repeated questions need a clear reference.",
      questionsToAnswer: ["Where are controls?", "Who can edit?", "When do changes apply?"],
      suggestedShape: "guide",
      evidenceStatement: "Based on two conversations.",
      action: "add_content",
      actionRuleVersion: 1,
      corpusState: "ready",
      corpusCheckedAt: new Date("2026-08-02T12:00:00.000Z"),
      enrichedAt: new Date("2026-08-02T12:00:01.000Z"),
    })).resolves.toBe(true);

    await expect(database.execute(
      `UPDATE content_plan_topics
       SET revision = 2, centroid_weight = 3, enrichment_dirty_at = $4, updated_at = $4
       WHERE workspace_id = $1 AND generation_id = $2 AND id = $3`,
      [
        fixture.workspaceId,
        generation.id,
        topicId,
        new Date("2026-08-02T12:00:02.000Z"),
      ],
    )).resolves.toBe(1);
    await expect(enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 1,
      now: new Date("2026-08-02T12:10:00.000Z"),
      leaseMs: 30_000,
    })).resolves.toEqual([]);

    const scheduler = new ContentPlanningEnrichmentScheduler(
      new RepositoryContentPlanEnrichmentQueue(enrichments),
    );
    await expect(scheduler.schedule({
      now: new Date("2026-08-02T12:00:03.000Z"),
      topics: [{
        workspaceId: fixture.workspaceId,
        generationId: generation.id,
        topicId,
        topicRevision: 2,
        lifecycle: "mature",
        current: {
          memberCount: 3,
          groundedCount: 0,
          degradedCount: 1,
          noSupportCount: 2,
          notEvaluatedCount: 0,
          credibleOpportunity: true,
          groundingBand: "low",
          action: "add_content",
          corpusEvidenceFingerprint: enrichmentCorpusFingerprint,
        },
        lastEnriched: {
          sourceTopicRevision: 1,
          ...enrichmentEvidence,
          groundingBand: "low",
          action: "add_content",
          corpusEvidenceFingerprint: enrichmentCorpusFingerprint,
          analysisMode: "label_and_brief",
          recommendationState: "ready",
        },
      }],
    })).resolves.toMatchObject({ queuedCount: 0, rebasedCount: 1, failedCount: 0 });

    await expect(database.queryOne<{
      source_topic_revision: number;
      state: string;
      source_member_count: number;
      published_source_member_count: number;
    }>(
      `SELECT source_topic_revision, state, source_member_count, published_source_member_count
       FROM content_plan_topic_enrichments
       WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
      [fixture.workspaceId, generation.id, topicId],
    )).resolves.toEqual({
      source_topic_revision: 2,
      state: "ready",
      source_member_count: 3,
      published_source_member_count: 2,
    });
  });

  it("uses revision-fenced dirty markers", async () => {
    const fixture = await createFixture("enrichment-triggers");
    const generation = await createGeneration(fixture, "coherent");
    const credibleTopicId = randomUUID();
    const monitorTopicId = randomUUID();
    const firstDirtyAt = new Date("2026-08-02T12:00:00.000Z");
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision, enrichment_dirty_at
       ) VALUES
         ($1, $2, $3, $5, 'mature', '[1,0,0]'::vector, 3, 2, '{}'::uuid[], 1, $6),
         ($1, $2, $4, $5, 'mature', '[0,1,0]'::vector, 3, 2, '{}'::uuid[], 1, NULL)`,
      [
        fixture.workspaceId,
        generation.id,
        credibleTopicId,
        monitorTopicId,
        fixture.embeddingSpaceId,
        firstDirtyAt,
      ],
    );
    await enrichments.queueEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId: credibleTopicId,
      sourceTopicRevision: 1,
      sourceEvidence: enrichmentEvidence,
      sourceEvidenceStrength: "low",
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      analysisMode: "label_and_brief",
      publishState: "ready",
      actionRuleVersion: 1,
      availableAt: firstDirtyAt,
    });
    await enrichments.queueEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId: monitorTopicId,
      sourceTopicRevision: 1,
      sourceEvidence: { ...enrichmentEvidence, credibleOpportunity: false },
      sourceEvidenceStrength: "low",
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      analysisMode: "label_only",
      publishState: "ready",
      actionRuleVersion: 1,
      availableAt: firstDirtyAt,
    });

    const markers = await enrichmentTriggers.listDirtyTopics({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 10,
    });
    expect(markers).toEqual([{ topicId: credibleTopicId, revision: 1, dirtyAt: firstDirtyAt }]);

    const secondDirtyAt = new Date("2026-08-02T12:00:01.000Z");
    await database.execute(
      `UPDATE content_plan_topics
       SET revision = 2, enrichment_dirty_at = $4
       WHERE workspace_id = $1 AND generation_id = $2 AND id = $3`,
      [fixture.workspaceId, generation.id, credibleTopicId, secondDirtyAt],
    );
    await expect(enrichmentTriggers.acknowledgeDirtyTopics({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      markers,
    })).resolves.toBe(0);
    await expect(enrichmentTriggers.listDirtyTopics({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 10,
    })).resolves.toEqual([{ topicId: credibleTopicId, revision: 2, dirtyAt: secondDirtyAt }]);
    await expect(enrichmentTriggers.acknowledgeDirtyTopics({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      markers: [{ topicId: credibleTopicId, revision: 2, dirtyAt: secondDirtyAt }],
    })).resolves.toBe(1);
  });

  it("rejects stale enrichment publication and invalidates bounded document evidence", async () => {
    const fixture = await createFixture("enrichment");
    const generation = await createGeneration(fixture, "coherent");
    const topicId = randomUUID();
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 2, '{}'::uuid[], 1)`,
      [fixture.workspaceId, generation.id, topicId, fixture.embeddingSpaceId],
    );
    await enrichments.queueEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 1,
      sourceEvidence: enrichmentEvidence,
      sourceEvidenceStrength: "low",
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      analysisMode: "label_and_brief",
      publishState: "ready",
      actionRuleVersion: 1,
      availableAt: new Date("2026-08-02T12:00:00.000Z"),
    });
    const [staleClaim] = await enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 5,
      now: new Date("2026-08-02T12:00:00.000Z"),
      leaseMs: 30_000,
    });
    await topics.invalidateTopic({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      expectedRevision: 1,
      dirtyAt: new Date("2026-08-02T12:00:01.000Z"),
    });
    await expect(enrichments.publishEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 1,
      sourceEvidence: enrichmentEvidence,
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      publishState: "ready",
      claimToken: staleClaim!.claimToken!,
      label: "Deployment controls",
      description: "Questions about deployment configuration.",
      suggestedTitle: null,
      rationale: null,
      questionsToAnswer: null,
      suggestedShape: null,
      evidenceStatement: null,
      action: "monitor",
      actionRuleVersion: 1,
      corpusState: "pending",
      corpusCheckedAt: null,
      enrichedAt: new Date("2026-08-02T12:00:02.000Z"),
    })).resolves.toBe(false);
    await expect(database.queryOne<{
      state: string;
      source_corpus_evidence_fingerprint: string | null;
      published_source_member_count: number | null;
      published_source_corpus_evidence_fingerprint: string | null;
    }>(
      `SELECT state, source_corpus_evidence_fingerprint,
              published_source_member_count, published_source_corpus_evidence_fingerprint
       FROM content_plan_topic_enrichments
       WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
      [fixture.workspaceId, generation.id, topicId],
    )).resolves.toEqual({
      state: "pending",
      source_corpus_evidence_fingerprint: enrichmentCorpusFingerprint,
      published_source_member_count: null,
      published_source_corpus_evidence_fingerprint: null,
    });

    await enrichments.queueEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 2,
      sourceEvidence: enrichmentEvidence,
      sourceEvidenceStrength: "low",
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      analysisMode: "label_and_brief",
      publishState: "ready",
      actionRuleVersion: 1,
      availableAt: new Date("2026-08-02T12:00:03.000Z"),
    });
    const [freshClaim] = await enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 5,
      now: new Date("2026-08-02T12:00:03.000Z"),
      leaseMs: 30_000,
    });
    await expect(enrichments.publishEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 2,
      sourceEvidence: enrichmentEvidence,
      sourceCorpusEvidenceFingerprint: refreshedEnrichmentCorpusFingerprint,
      publishState: "ready",
      claimToken: freshClaim!.claimToken!,
      label: "Deployment controls",
      description: "Questions about deployment configuration.",
      suggestedTitle: "Deployment controls guide",
      rationale: "Repeated deployment questions need a clear reference.",
      questionsToAnswer: ["Where are controls?", "Who can edit them?", "When do changes apply?"],
      suggestedShape: "guide",
      evidenceStatement: "Based on two conversations.",
      action: "monitor",
      actionRuleVersion: 1,
      corpusState: "ready",
      corpusCheckedAt: new Date("2026-08-02T12:00:03.000Z"),
      enrichedAt: new Date("2026-08-02T12:00:04.000Z"),
    })).resolves.toBe(true);

    const documentIds = Array.from({ length: 6 }, () => randomUUID());
    for (const [index, documentId] of documentIds.entries()) {
      await database.execute(
        `INSERT INTO documents (
           id, workspace_id, title, source_content, markdown_content, status, revision, metadata
         ) VALUES ($1, $2, $3, 'source', 'markdown', 'ready', 1, '{}'::jsonb)`,
        [documentId, fixture.workspaceId, `Document ${index + 1}`],
      );
    }
    const replaced = await enrichments.replaceTopicDocuments({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 2,
      documents: documentIds.map((documentId, index) => ({
        documentId,
        similarity: 0.9 - (index / 100),
        existedBeforeGap: true,
        retrievedByGapAnswers: false,
        citedByGapAnswers: false,
        changedAfterGap: false,
      })),
    });
    expect(replaced).toEqual({ applied: true, storedCount: 5, truncatedCount: 1 });

    await corpusInvalidations.invalidateDeletedDocument({
      workspaceId: fixture.workspaceId,
      documentId: documentIds[0]!,
      dirtyAt: new Date("2026-08-02T12:00:05.000Z"),
    });
    const [topic, enrichment, links] = await Promise.all([
      database.queryOne<{ revision: number }>(
        "SELECT revision FROM content_plan_topics WHERE workspace_id = $1 AND generation_id = $2 AND id = $3",
        [fixture.workspaceId, generation.id, topicId],
      ),
      database.queryOne<{ state: string; corpus_state: string }>(
        "SELECT state, corpus_state FROM content_plan_topic_enrichments WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3",
        [fixture.workspaceId, generation.id, topicId],
      ),
      database.query<{ document_id: string }>(
        "SELECT document_id FROM content_plan_topic_documents WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3",
        [fixture.workspaceId, generation.id, topicId],
      ),
    ]);
    expect(topic.revision).toBe(3);
    expect(enrichment).toEqual({ state: "stale", corpus_state: "stale" });
    expect(links).toEqual([]);

    await expect(enrichments.queueEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 2,
      sourceEvidence: enrichmentEvidence,
      sourceEvidenceStrength: "low",
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      analysisMode: "label_and_brief",
      publishState: "ready",
      actionRuleVersion: 1,
      availableAt: new Date("2026-08-02T12:00:06.000Z"),
    })).resolves.toBeNull();
    const queuedForOutsideCap = await enrichments.queueEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 3,
      sourceEvidence: updatedEnrichmentEvidence,
      sourceEvidenceStrength: "low",
      sourceCorpusEvidenceFingerprint: updatedEnrichmentCorpusFingerprint,
      analysisMode: "label_only",
      publishState: "outside_analysis_cap",
      actionRuleVersion: 1,
      availableAt: new Date("2026-08-02T12:00:06.000Z"),
    });
    expect(queuedForOutsideCap).toMatchObject({
      sourceEvidence: updatedEnrichmentEvidence,
      sourceCorpusEvidenceFingerprint: updatedEnrichmentCorpusFingerprint,
      publishedSourceEvidence: enrichmentEvidence,
      publishedSourceEvidenceStrength: "low",
      publishedSourceCorpusEvidenceFingerprint: refreshedEnrichmentCorpusFingerprint,
    });
    const [retryClaim] = await enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 1,
      now: new Date("2026-08-02T12:00:06.000Z"),
      leaseMs: 30_000,
    });
    await expect(enrichments.failEnrichmentClaim({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 3,
      claimToken: retryClaim!.claimToken!,
      terminal: false,
      failureStage: "label_generation",
      failureReason: "provider_error",
      availableAt: new Date("2026-08-02T12:01:06.000Z"),
    })).resolves.toBe(true);
    const [outsideCapClaim] = await enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 1,
      now: new Date("2026-08-02T12:01:06.000Z"),
      leaseMs: 30_000,
    });
    expect(outsideCapClaim).toMatchObject({
      analysisMode: "label_only",
      publishState: "outside_analysis_cap",
      state: "pending",
      sourceEvidence: updatedEnrichmentEvidence,
      publishedSourceEvidence: enrichmentEvidence,
    });
    await expect(enrichments.publishEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 3,
      sourceEvidence: updatedEnrichmentEvidence,
      sourceCorpusEvidenceFingerprint: updatedEnrichmentCorpusFingerprint,
      claimToken: outsideCapClaim!.claimToken!,
      publishState: "outside_analysis_cap",
      label: "Deployment controls",
      description: "Questions about deployment configuration.",
      suggestedTitle: null,
      rationale: null,
      questionsToAnswer: null,
      suggestedShape: null,
      evidenceStatement: null,
      action: null,
      actionRuleVersion: 1,
      corpusState: "ready",
      corpusCheckedAt: new Date("2026-08-02T12:01:06.000Z"),
      enrichedAt: new Date("2026-08-02T12:01:07.000Z"),
    })).resolves.toBe(true);
    await expect(enrichments.markOutsideAnalysisCap({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 3,
      sourceEvidence: updatedEnrichmentEvidence,
      sourceEvidenceStrength: "low",
      sourceCorpusEvidenceFingerprint: updatedEnrichmentCorpusFingerprint,
      actionRuleVersion: 1,
      availableAt: new Date("2026-08-02T12:01:08.000Z"),
    })).resolves.toBe(true);
    await expect(database.queryOne<{
      state: string;
      label: string | null;
      source_member_count: number;
      published_source_member_count: number | null;
      source_corpus_evidence_fingerprint: string | null;
      published_source_corpus_evidence_fingerprint: string | null;
    }>(
      `SELECT state, label, source_member_count, published_source_member_count,
              source_corpus_evidence_fingerprint, published_source_corpus_evidence_fingerprint
       FROM content_plan_topic_enrichments
       WHERE workspace_id = $1 AND generation_id = $2 AND topic_id = $3`,
      [fixture.workspaceId, generation.id, topicId],
    )).resolves.toEqual({
      state: "outside_analysis_cap",
      label: "Deployment controls",
      source_member_count: updatedEnrichmentEvidence.memberCount,
      published_source_member_count: updatedEnrichmentEvidence.memberCount,
      source_corpus_evidence_fingerprint: updatedEnrichmentCorpusFingerprint,
      published_source_corpus_evidence_fingerprint: updatedEnrichmentCorpusFingerprint,
    });
  });

  it("keeps an unchanged enrichment schedule stable across claims, publication, and terminal failure", async () => {
    const fixture = await createFixture("enrichment-idempotency");
    const generation = await createGeneration(fixture, "coherent");
    const readyTopicId = randomUUID();
    const failedTopicId = randomUUID();
    for (const topicId of [readyTopicId, failedTopicId]) {
      await database.execute(
        `INSERT INTO content_plan_topics (
           workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
           dimensions, centroid_weight, representative_observation_ids, revision
         ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 2, '{}'::uuid[], 1)`,
        [fixture.workspaceId, generation.id, topicId, fixture.embeddingSpaceId],
      );
    }
    const originalAvailableAt = new Date("2026-08-02T12:10:00.000Z");
    const earliestAvailableAt = new Date("2026-08-02T12:05:00.000Z");
    const unchangedSchedule = {
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      sourceTopicRevision: 1,
      sourceEvidence: enrichmentEvidence,
      sourceEvidenceStrength: "low" as const,
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      analysisMode: "label_and_brief" as const,
      publishState: "ready" as const,
      actionRuleVersion: 1,
    };

    await enrichments.queueEnrichment({
      ...unchangedSchedule,
      topicId: readyTopicId,
      availableAt: originalAvailableAt,
    });
    const duplicateLater = await enrichments.queueEnrichment({
      ...unchangedSchedule,
      topicId: readyTopicId,
      availableAt: new Date("2026-08-02T12:15:00.000Z"),
    });
    expect(duplicateLater).toMatchObject({
      state: "pending",
      availableAt: originalAvailableAt,
      attemptCount: 0,
      claimToken: null,
    });
    const duplicateEarlier = await enrichments.queueEnrichment({
      ...unchangedSchedule,
      topicId: readyTopicId,
      availableAt: earliestAvailableAt,
    });
    expect(duplicateEarlier).toMatchObject({ availableAt: earliestAvailableAt });

    const [claim] = await enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 1,
      now: earliestAvailableAt,
      leaseMs: 60_000,
    });
    const duplicateClaimed = await enrichments.queueEnrichment({
      ...unchangedSchedule,
      topicId: readyTopicId,
      availableAt: new Date("2026-08-02T12:20:00.000Z"),
    });
    expect(duplicateClaimed).toMatchObject({
      state: "pending",
      availableAt: earliestAvailableAt,
      attemptCount: 1,
      claimToken: claim!.claimToken,
      claimExpiresAt: claim!.claimExpiresAt,
    });
    await expect(enrichments.publishEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId: readyTopicId,
      sourceTopicRevision: 1,
      sourceEvidence: enrichmentEvidence,
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      claimToken: claim!.claimToken!,
      publishState: "ready",
      label: "Deployment controls",
      description: "Questions about deployment configuration.",
      suggestedTitle: "Deployment controls guide",
      rationale: "Repeated deployment questions need a clear reference.",
      questionsToAnswer: ["Where are controls?", "Who can edit them?", "When do changes apply?"],
      suggestedShape: "guide",
      evidenceStatement: "Based on two conversations.",
      action: "monitor",
      actionRuleVersion: 1,
      corpusState: "ready",
      corpusCheckedAt: earliestAvailableAt,
      enrichedAt: new Date("2026-08-02T12:05:30.000Z"),
    })).resolves.toBe(true);
    const duplicateReady = await enrichments.queueEnrichment({
      ...unchangedSchedule,
      topicId: readyTopicId,
      availableAt: new Date("2026-08-02T12:25:00.000Z"),
    });
    expect(duplicateReady).toMatchObject({
      state: "ready",
      availableAt: earliestAvailableAt,
      attemptCount: 1,
      claimToken: null,
      label: "Deployment controls",
      suggestedTitle: "Deployment controls guide",
      publishedSourceEvidence: enrichmentEvidence,
      publishedSourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
    });
    await topics.invalidateTopic({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId: readyTopicId,
      expectedRevision: 1,
      dirtyAt: new Date("2026-08-02T12:25:30.000Z"),
    });
    const freshReadyDeadline = new Date("2026-08-02T12:30:30.000Z");
    await expect(enrichments.queueEnrichment({
      ...unchangedSchedule,
      topicId: readyTopicId,
      sourceTopicRevision: 2,
      availableAt: freshReadyDeadline,
    })).resolves.toMatchObject({
      sourceTopicRevision: 2,
      state: "pending",
      availableAt: freshReadyDeadline,
      attemptCount: 0,
    });

    await enrichments.queueEnrichment({
      ...unchangedSchedule,
      topicId: failedTopicId,
      availableAt: earliestAvailableAt,
    });
    const [failedClaim] = await enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 1,
      now: earliestAvailableAt,
      leaseMs: 60_000,
    });
    const failureAvailableAt = new Date("2026-08-02T12:06:00.000Z");
    await expect(enrichments.failEnrichmentClaim({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId: failedTopicId,
      sourceTopicRevision: 1,
      claimToken: failedClaim!.claimToken!,
      terminal: true,
      failureStage: "label_generation",
      failureReason: "provider_error",
      availableAt: failureAvailableAt,
    })).resolves.toBe(true);
    const duplicateFailed = await enrichments.queueEnrichment({
      ...unchangedSchedule,
      topicId: failedTopicId,
      availableAt: new Date("2026-08-02T12:30:00.000Z"),
    });
    expect(duplicateFailed).toMatchObject({
      state: "unavailable",
      availableAt: failureAvailableAt,
      attemptCount: 1,
      claimToken: null,
      failureStage: "label_generation",
      failureReason: "provider_error",
    });
    const freshTerminalDeadline = new Date("2026-08-02T12:40:00.000Z");
    await expect(enrichments.queueEnrichment({
      ...unchangedSchedule,
      topicId: failedTopicId,
      sourceEvidenceStrength: "medium",
      availableAt: freshTerminalDeadline,
    })).resolves.toMatchObject({
      state: "pending",
      availableAt: freshTerminalDeadline,
      attemptCount: 0,
      claimToken: null,
      failureStage: null,
      failureReason: null,
    });
  });

  it("keeps the first bounded debounce deadline while continuous revisions replace unpublished work", async () => {
    const fixture = await createFixture("enrichment-bounded-debounce");
    const generation = await createGeneration(fixture, "coherent");
    const topicId = randomUUID();
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 2, '{}'::uuid[], 1)`,
      [fixture.workspaceId, generation.id, topicId, fixture.embeddingSpaceId],
    );
    const firstDeadline = new Date("2026-08-02T14:05:00.000Z");
    await enrichments.queueEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 1,
      sourceEvidence: enrichmentEvidence,
      sourceEvidenceStrength: "low",
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      analysisMode: "label_and_brief",
      publishState: "ready",
      actionRuleVersion: 1,
      availableAt: firstDeadline,
    });

    const revisions = [
      {
        revision: 2,
        dirtyAt: new Date("2026-08-02T14:01:00.000Z"),
        scheduledAt: new Date("2026-08-02T14:06:00.000Z"),
        evidence: updatedEnrichmentEvidence,
        strength: "low" as const,
        fingerprint: enrichmentCorpusFingerprint,
      },
      {
        revision: 3,
        dirtyAt: new Date("2026-08-02T14:02:00.000Z"),
        scheduledAt: new Date("2026-08-02T14:07:00.000Z"),
        evidence: {
          memberCount: 4,
          groundedCount: 0,
          degradedCount: 2,
          noSupportCount: 2,
          notEvaluatedCount: 0,
          credibleOpportunity: true,
        },
        strength: "medium" as const,
        fingerprint: updatedEnrichmentCorpusFingerprint,
      },
      {
        revision: 4,
        dirtyAt: new Date("2026-08-02T14:03:00.000Z"),
        scheduledAt: new Date("2026-08-02T14:08:00.000Z"),
        evidence: {
          memberCount: 5,
          groundedCount: 1,
          degradedCount: 2,
          noSupportCount: 2,
          notEvaluatedCount: 0,
          credibleOpportunity: true,
        },
        strength: "medium" as const,
        fingerprint: refreshedEnrichmentCorpusFingerprint,
      },
    ] as const;

    for (const revision of revisions) {
      await topics.invalidateTopic({
        workspaceId: fixture.workspaceId,
        generationId: generation.id,
        topicId,
        expectedRevision: revision.revision - 1,
        dirtyAt: revision.dirtyAt,
      });
      await expect(enrichments.queueEnrichment({
        workspaceId: fixture.workspaceId,
        generationId: generation.id,
        topicId,
        sourceTopicRevision: revision.revision,
        sourceEvidence: revision.evidence,
        sourceEvidenceStrength: revision.strength,
        sourceCorpusEvidenceFingerprint: revision.fingerprint,
        analysisMode: "label_and_brief",
        publishState: "ready",
        actionRuleVersion: 1,
        availableAt: revision.scheduledAt,
      })).resolves.toMatchObject({
        sourceTopicRevision: revision.revision,
        sourceEvidence: revision.evidence,
        sourceEvidenceStrength: revision.strength,
        sourceCorpusEvidenceFingerprint: revision.fingerprint,
        state: "pending",
        availableAt: firstDeadline,
      });
    }

    await expect(enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 1,
      now: new Date(firstDeadline.getTime() - 1),
      leaseMs: 60_000,
    })).resolves.toEqual([]);
    const [latestClaim] = await enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 1,
      now: firstDeadline,
      leaseMs: 60_000,
    });
    expect(latestClaim).toMatchObject({
      topicId,
      sourceTopicRevision: 4,
      sourceEvidence: revisions[2].evidence,
      sourceEvidenceStrength: revisions[2].strength,
      sourceCorpusEvidenceFingerprint: revisions[2].fingerprint,
      attemptCount: 1,
      claimToken: expect.any(String),
    });

    const retryAt = new Date("2026-08-02T14:06:00.000Z");
    await expect(enrichments.failEnrichmentClaim({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 4,
      claimToken: latestClaim!.claimToken!,
      terminal: false,
      failureStage: "label_generation",
      failureReason: "provider_error",
      availableAt: retryAt,
    })).resolves.toBe(true);
    await topics.invalidateTopic({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      expectedRevision: 4,
      dirtyAt: new Date("2026-08-02T14:05:10.000Z"),
    });
    await expect(enrichments.queueEnrichment({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId,
      sourceTopicRevision: 5,
      sourceEvidence: {
        memberCount: 6,
        groundedCount: 1,
        degradedCount: 3,
        noSupportCount: 2,
        notEvaluatedCount: 0,
        credibleOpportunity: true,
      },
      sourceEvidenceStrength: "medium",
      sourceCorpusEvidenceFingerprint: refreshedEnrichmentCorpusFingerprint,
      analysisMode: "label_and_brief",
      publishState: "ready",
      actionRuleVersion: 1,
      availableAt: new Date("2026-08-02T14:10:10.000Z"),
    })).resolves.toMatchObject({
      sourceTopicRevision: 5,
      state: "pending",
      availableAt: retryAt,
      attemptCount: 0,
      failureStage: null,
      failureReason: null,
    });
  });

  it("requeues and fences an in-flight enrichment whenever its queued snapshot changes", async () => {
    const fixture = await createFixture("enrichment-requeue");
    const generation = await createGeneration(fixture, "coherent");
    const baseSchedule = {
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      sourceTopicRevision: 1,
      sourceEvidence: enrichmentEvidence,
      sourceEvidenceStrength: "low" as const,
      sourceCorpusEvidenceFingerprint: enrichmentCorpusFingerprint,
      analysisMode: "label_and_brief" as const,
      publishState: "ready" as const,
      actionRuleVersion: 1,
      availableAt: new Date("2026-08-02T13:00:00.000Z"),
    };
    const variants = [
      {
        name: "evidence",
        change: { sourceEvidence: updatedEnrichmentEvidence },
      },
      {
        name: "strength",
        change: { sourceEvidenceStrength: "medium" as const },
      },
      {
        name: "corpus fingerprint",
        change: { sourceCorpusEvidenceFingerprint: updatedEnrichmentCorpusFingerprint },
      },
      {
        name: "analysis mode",
        change: { analysisMode: "label_only" as const },
      },
      {
        name: "publish state",
        change: { analysisMode: "label_only" as const, publishState: "outside_analysis_cap" as const },
      },
      {
        name: "action rule version",
        change: { actionRuleVersion: 2 },
      },
    ] as const;

    for (const [index, variant] of variants.entries()) {
      const topicId = randomUUID();
      await database.execute(
        `INSERT INTO content_plan_topics (
           workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
           dimensions, centroid_weight, representative_observation_ids, revision
         ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 2, '{}'::uuid[], 1)`,
        [fixture.workspaceId, generation.id, topicId, fixture.embeddingSpaceId],
      );
      await enrichments.queueEnrichment({ ...baseSchedule, topicId });
      const [claim] = await enrichments.claimEnrichmentBatch({
        workspaceId: fixture.workspaceId,
        generationId: generation.id,
        limit: 1,
        now: baseSchedule.availableAt,
        leaseMs: 60_000,
      });
      const changedAvailableAt = new Date(baseSchedule.availableAt.getTime() + index + 1);
      const requeued = await enrichments.queueEnrichment({
        ...baseSchedule,
        ...variant.change,
        topicId,
        availableAt: changedAvailableAt,
      });
      expect(requeued, variant.name).toMatchObject({
        state: "pending",
        availableAt: baseSchedule.availableAt,
        attemptCount: 0,
        claimToken: null,
        failureStage: null,
        failureReason: null,
        ...variant.change,
      });
      await expect(enrichments.failEnrichmentClaim({
        workspaceId: fixture.workspaceId,
        generationId: generation.id,
        topicId,
        sourceTopicRevision: 1,
        claimToken: claim!.claimToken!,
        terminal: false,
        failureStage: "label_generation",
        failureReason: "provider_error",
        availableAt: changedAvailableAt,
      }), variant.name).resolves.toBe(false);
      const [replacementClaim] = await enrichments.claimEnrichmentBatch({
        workspaceId: fixture.workspaceId,
        generationId: generation.id,
        limit: 1,
        now: baseSchedule.availableAt,
        leaseMs: 60_000,
      });
      expect(replacementClaim?.topicId, variant.name).toBe(topicId);
      await expect(enrichments.failEnrichmentClaim({
        workspaceId: fixture.workspaceId,
        generationId: generation.id,
        topicId,
        sourceTopicRevision: 1,
        claimToken: replacementClaim!.claimToken!,
        terminal: true,
        failureStage: "label_generation",
        failureReason: "provider_error",
        availableAt: baseSchedule.availableAt,
      }), variant.name).resolves.toBe(true);
    }

    const revisionTopicId = randomUUID();
    await database.execute(
      `INSERT INTO content_plan_topics (
         workspace_id, generation_id, id, embedding_space_id, lifecycle, centroid,
         dimensions, centroid_weight, representative_observation_ids, revision
       ) VALUES ($1, $2, $3, $4, 'mature', '[1,0,0]'::vector, 3, 2, '{}'::uuid[], 1)`,
      [fixture.workspaceId, generation.id, revisionTopicId, fixture.embeddingSpaceId],
    );
    await enrichments.queueEnrichment({ ...baseSchedule, topicId: revisionTopicId });
    const [revisionClaim] = await enrichments.claimEnrichmentBatch({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      limit: 1,
      now: baseSchedule.availableAt,
      leaseMs: 60_000,
    });
    await topics.invalidateTopic({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId: revisionTopicId,
      expectedRevision: 1,
      dirtyAt: new Date("2026-08-02T13:01:00.000Z"),
    });
    const revisionAvailableAt = new Date("2026-08-02T13:06:00.000Z");
    await expect(enrichments.queueEnrichment({
      ...baseSchedule,
      topicId: revisionTopicId,
      sourceTopicRevision: 2,
      availableAt: revisionAvailableAt,
    })).resolves.toMatchObject({
      sourceTopicRevision: 2,
      state: "pending",
      availableAt: baseSchedule.availableAt,
      attemptCount: 0,
      claimToken: null,
    });
    await expect(enrichments.failEnrichmentClaim({
      workspaceId: fixture.workspaceId,
      generationId: generation.id,
      topicId: revisionTopicId,
      sourceTopicRevision: 1,
      claimToken: revisionClaim!.claimToken!,
      terminal: false,
      failureStage: "label_generation",
      failureReason: "provider_error",
      availableAt: revisionAvailableAt,
    })).resolves.toBe(false);
  });
});
