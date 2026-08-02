import { describe, expect, it, vi } from "vitest";

import type {
  ContentPlanObservationVectorRecord,
  ContentPlanTopicAssignmentEvidence,
  ContentPlanTopicRecord,
} from "../../src/modules/contentPlanning/contracts/persistence.js";
import {
  CONTENT_PLAN_WORKER_POLICY_V1,
  ContentPlanningWorker,
  ContentPlanningWorkerObservability,
  type ContentPlanWorkerEvent,
} from "../../src/modules/contentPlanning/worker.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");

const vectorWork = (
  overrides: Partial<ContentPlanObservationVectorRecord> = {},
): ContentPlanObservationVectorRecord => ({
  workspaceId: "workspace-1",
  observationId: "observation-1",
  generationId: "generation-1",
  embeddingSpaceId: "space-1",
  dimensions: null,
  embedding: null,
  vectorSource: null,
  state: "processing",
  attemptCount: 1,
  availableAt: NOW,
  claimToken: "claim-1",
  claimedAt: NOW,
  claimExpiresAt: new Date(NOW.getTime() + 60_000),
  failureStage: null,
  failureReason: null,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const topic = (
  overrides: Partial<ContentPlanTopicRecord> = {},
): ContentPlanTopicRecord => ({
  workspaceId: "workspace-1",
  generationId: "generation-1",
  id: "topic-1",
  embeddingSpaceId: "space-1",
  lifecycle: "provisional",
  centroid: [1, 0],
  dimensions: 2,
  centroidWeight: 1,
  representativeObservationIds: ["representative-1"],
  revision: 4,
  mergedIntoTopicId: null,
  redirectExpiresAt: null,
  enrichmentDirtyAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const assignmentEvidence = (
  overrides: Partial<ContentPlanTopicAssignmentEvidence> = {},
): ContentPlanTopicAssignmentEvidence => ({
  topicId: "topic-1",
  liveObservationCount: 1,
  liveConversationCount: 1,
  incomingConversationAlreadyPresent: false,
  representativeVectors: [{ observationId: "representative-1", embedding: [1, 0] }],
  ...overrides,
});

const resolvedSources = (records: readonly ContentPlanObservationVectorRecord[]) => ({
  items: records.map((record, index) => ({
    observationId: record.observationId,
    resolution: {
      status: "resolved" as const,
      source: "message_metadata" as const,
      semanticIntentId: `intent-${index}`,
      semanticText: `visitor question ${index}`,
      semanticTextHash: `${index}`.repeat(64).slice(0, 64),
    },
  })),
  requestedCount: records.length,
  loadedCount: records.length,
  truncatedCount: 0,
});

const createHarness = (claims: readonly ContentPlanObservationVectorRecord[]) => {
  const observationWork = {
    claimVectorBatch: vi.fn().mockResolvedValue([...claims]),
    storeClaimedEmbedding: vi.fn().mockResolvedValue(true),
    failVectorClaim: vi.fn().mockResolvedValue(true),
  };
  const semanticSources = {
    load: vi.fn().mockResolvedValue(resolvedSources(claims)),
  };
  const embeddings = {
    embedForProjection: vi.fn().mockImplementation(async (input: { texts: readonly string[] }) => ({
      embeddingSpaceId: "space-1",
      vectors: input.texts.map((_, index) => [1, index / 100]),
    })),
  };
  const topics = {
    findNearestTopics: vi.fn().mockResolvedValue([]),
    loadAssignmentEvidence: vi.fn().mockResolvedValue([]),
    loadReconciliationEvidence: vi.fn().mockResolvedValue([]),
    findTopicsNeedingReconciliation: vi.fn().mockResolvedValue([]),
    pruneExpiredRedirects: vi.fn().mockResolvedValue(0),
    createTopicAndAssign: vi.fn().mockResolvedValue({
      applied: true,
      topic: topic(),
      membership: {},
    }),
    assignToExistingTopic: vi.fn().mockResolvedValue({
      applied: true,
      topic: topic(),
      membership: {},
    }),
    reconcileTopic: vi.fn().mockResolvedValue(topic()),
    mergeTopics: vi.fn(),
    invalidateTopic: vi.fn(),
    resolveTopicRedirect: vi.fn().mockImplementation(async (input: { topicId: string }) => ({
      kind: "active" as const,
      topic: topic({ id: input.topicId }),
      redirectedFromTopicId: null,
      hops: 0,
    })),
  };
  const retention = {
    pruneExpiredObservations: vi.fn().mockResolvedValue({
      deletedCount: 0,
      affectedTopics: [],
    }),
  };
  const observer = { record: vi.fn() };
  let currentTime = NOW;
  const worker = new ContentPlanningWorker({
    observationWork,
    semanticSources,
    embeddings,
    topics,
    retention,
    observability: observer,
    clock: () => currentTime,
    createTopicId: () => "topic-created",
  });

  return {
    worker,
    observationWork,
    semanticSources,
    embeddings,
    topics,
    retention,
    observer,
    setNow: (value: Date) => {
      currentTime = value;
    },
  };
};

describe("ContentPlanningWorker", () => {
  it("claims and embeds at most the bounded fallback batch before releasing rows to ready", async () => {
    const claims = Array.from({ length: CONTENT_PLAN_WORKER_POLICY_V1.embeddingBatchSize }, (_, index) =>
      vectorWork({
        observationId: `observation-${index}`,
        claimToken: `claim-${index}`,
      }));
    const harness = createHarness(claims);

    const result = await harness.worker.runOnce();

    expect(harness.observationWork.claimVectorBatch).toHaveBeenCalledWith({
      limit: CONTENT_PLAN_WORKER_POLICY_V1.embeddingBatchSize,
      now: NOW,
      leaseMs: CONTENT_PLAN_WORKER_POLICY_V1.leaseMs,
    });
    expect(harness.semanticSources.load).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      observationIds: claims.map((claim) => claim.observationId),
    });
    expect(harness.embeddings.embedForProjection).toHaveBeenCalledTimes(1);
    expect(harness.embeddings.embedForProjection.mock.calls[0]?.[0].texts).toHaveLength(
      CONTENT_PLAN_WORKER_POLICY_V1.embeddingBatchSize,
    );
    expect(harness.observationWork.storeClaimedEmbedding).toHaveBeenCalledTimes(
      CONTENT_PLAN_WORKER_POLICY_V1.embeddingBatchSize,
    );
    expect(harness.topics.createTopicAndAssign).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      claimedCount: CONTENT_PLAN_WORKER_POLICY_V1.embeddingBatchSize,
      embeddedCount: CONTENT_PLAN_WORKER_POLICY_V1.embeddingBatchSize,
      assignedCount: 0,
    });
    expect(harness.observer.record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "embedding",
      outcome: "completed",
      workspaceId: "workspace-1",
      generationId: "generation-1",
      itemCount: CONTENT_PLAN_WORKER_POLICY_V1.embeddingBatchSize,
      providerOperation: "embedding",
      providerCallCount: 1,
      durationMs: expect.any(Number),
    }));
  });

  it("assigns a compatible reused vector without loading text or calling the provider", async () => {
    const claim = vectorWork({
      dimensions: 2,
      embedding: [1, 0],
      vectorSource: "reused",
    });
    const harness = createHarness([claim]);

    const result = await harness.worker.runOnce();

    expect(harness.semanticSources.load).not.toHaveBeenCalled();
    expect(harness.embeddings.embedForProjection).not.toHaveBeenCalled();
    expect(harness.topics.createTopicAndAssign).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: claim.workspaceId,
      generationId: claim.generationId,
      observationId: claim.observationId,
      claimToken: claim.claimToken,
      topic: expect.objectContaining({
        id: "topic-created",
        embeddingSpaceId: claim.embeddingSpaceId,
        centroid: claim.embedding,
        dimensions: 2,
        centroidWeight: 1,
        representativeObservationIds: [claim.observationId],
      }),
    }));
    expect(result).toMatchObject({ assignedCount: 1, createdTopicCount: 1 });
  });

  it("maps provider failures to typed exponential retries and stops at the attempt ceiling", async () => {
    const retryHarness = createHarness([vectorWork({ attemptCount: 2 })]);
    retryHarness.embeddings.embedForProjection.mockRejectedValueOnce(
      new Error("provider body: visitor question and [0.123,0.456]"),
    );

    const retryResult = await retryHarness.worker.runOnce();

    expect(retryHarness.observationWork.failVectorClaim).toHaveBeenCalledWith(expect.objectContaining({
      terminal: false,
      failureStage: "embedding",
      failureReason: "embedding_provider_failed",
      availableAt: new Date(
        NOW.getTime()
          + CONTENT_PLAN_WORKER_POLICY_V1.retryBaseDelayMs * 2,
      ),
    }));
    expect(retryResult).toMatchObject({ retryCount: 1, terminalFailureCount: 0 });
    expect(retryHarness.observer.record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "embedding",
      outcome: "retry_scheduled",
      reason: "embedding_provider_failed",
      itemCount: 1,
      providerOperation: "embedding",
      providerCallCount: 1,
      durationMs: expect.any(Number),
    }));

    const terminalHarness = createHarness([
      vectorWork({ attemptCount: CONTENT_PLAN_WORKER_POLICY_V1.maxAttempts }),
    ]);
    terminalHarness.embeddings.embedForProjection.mockRejectedValueOnce(new Error("private provider body"));

    const terminalResult = await terminalHarness.worker.runOnce();

    expect(terminalHarness.observationWork.failVectorClaim).toHaveBeenCalledWith(expect.objectContaining({
      terminal: true,
      failureStage: "embedding",
      failureReason: "embedding_provider_failed",
    }));
    expect(terminalResult).toMatchObject({ retryCount: 0, terminalFailureCount: 1 });
  });

  it("does not mutate a claim whose lease is already expired", async () => {
    const claim = vectorWork({
      dimensions: 2,
      embedding: [1, 0],
      vectorSource: "reused",
      claimExpiresAt: NOW,
    });
    const harness = createHarness([claim]);

    const result = await harness.worker.runOnce();

    expect(harness.topics.findNearestTopics).not.toHaveBeenCalled();
    expect(harness.observationWork.storeClaimedEmbedding).not.toHaveBeenCalled();
    expect(harness.observationWork.failVectorClaim).not.toHaveBeenCalled();
    expect(result).toMatchObject({ staleClaimCount: 1 });
    expect(harness.observer.record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "claim",
      outcome: "stale",
      reason: "lease_expired",
    }));
  });

  it("deduplicates duplicate claimed rows and lets repository CAS reject a stale token", async () => {
    const claim = vectorWork({
      dimensions: 2,
      embedding: [1, 0],
      vectorSource: "reused",
    });
    const harness = createHarness([claim, { ...claim }]);
    harness.topics.createTopicAndAssign.mockResolvedValueOnce({
      applied: false,
      topic: null,
      membership: null,
    });
    harness.observationWork.failVectorClaim.mockResolvedValueOnce(false);

    const result = await harness.worker.runOnce();

    expect(harness.topics.createTopicAndAssign).toHaveBeenCalledTimes(1);
    expect(harness.observationWork.failVectorClaim).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ claimedCount: 1, staleClaimCount: 1 });
  });

  it("rechecks the lease after provider work before storing a fallback vector", async () => {
    const claim = vectorWork();
    const harness = createHarness([claim]);
    harness.embeddings.embedForProjection.mockImplementationOnce(async () => {
      harness.setNow(new Date(NOW.getTime() + 60_000));
      return { embeddingSpaceId: "space-1", vectors: [[1, 0]] };
    });

    const result = await harness.worker.runOnce();

    expect(harness.observationWork.storeClaimedEmbedding).not.toHaveBeenCalled();
    expect(harness.observationWork.failVectorClaim).not.toHaveBeenCalled();
    expect(result).toMatchObject({ embeddedCount: 0, staleClaimCount: 1 });
  });

  it("uses topicPolicy evidence to update centroid, representatives, revision, and maturity", async () => {
    const claim = vectorWork({
      dimensions: 2,
      embedding: [0.98, 0.02],
      vectorSource: "reused",
    });
    const candidate = topic();
    const harness = createHarness([claim]);
    harness.topics.findNearestTopics.mockResolvedValueOnce([{
      ...candidate,
      cosineSimilarity: 0.99,
    }]);
    harness.topics.loadAssignmentEvidence.mockResolvedValueOnce([assignmentEvidence()]);

    const result = await harness.worker.runOnce();

    expect(harness.topics.assignToExistingTopic).toHaveBeenCalledWith(expect.objectContaining({
      topicId: candidate.id,
      expectedTopicRevision: candidate.revision,
      assignmentVersion: 1,
      similarity: expect.closeTo(0.999, 2),
      cohesion: expect.closeTo(0.999, 2),
      topic: {
        lifecycle: "mature",
        centroid: [0.99, 0.01],
        dimensions: 2,
        centroidWeight: 2,
        representativeObservationIds: ["representative-1", claim.observationId],
        revision: candidate.revision + 1,
        enrichmentDirtyAt: NOW,
      },
    }));
    expect(harness.topics.createTopicAndAssign).not.toHaveBeenCalled();
    expect(result).toMatchObject({ assignedCount: 1, maturedTopicCount: 1 });
  });

  it("does not mature repeated interest from the same conversation", async () => {
    const claim = vectorWork({
      dimensions: 2,
      embedding: [1, 0],
      vectorSource: "reused",
    });
    const harness = createHarness([claim]);
    harness.topics.findNearestTopics.mockResolvedValueOnce([{ ...topic(), cosineSimilarity: 1 }]);
    harness.topics.loadAssignmentEvidence.mockResolvedValueOnce([
      assignmentEvidence({ incomingConversationAlreadyPresent: true }),
    ]);

    const result = await harness.worker.runOnce();

    expect(harness.topics.assignToExistingTopic).toHaveBeenCalledWith(expect.objectContaining({
      topic: expect.objectContaining({
        lifecycle: "provisional",
        enrichmentDirtyAt: null,
      }),
    }));
    expect(result).toMatchObject({ assignedCount: 1, maturedTopicCount: 0 });
  });

  it("marks a mature topic dirty again when membership changes after acknowledgement", async () => {
    const claim = vectorWork({
      dimensions: 2,
      embedding: [1, 0],
      vectorSource: "reused",
    });
    const harness = createHarness([claim]);
    harness.topics.findNearestTopics.mockResolvedValueOnce([{
      ...topic({ lifecycle: "mature", centroidWeight: 2, enrichmentDirtyAt: null }),
      cosineSimilarity: 1,
    }]);
    harness.topics.loadAssignmentEvidence.mockResolvedValueOnce([
      assignmentEvidence({
        liveObservationCount: 2,
        liveConversationCount: 2,
        incomingConversationAlreadyPresent: false,
      }),
    ]);

    await harness.worker.runOnce();

    expect(harness.topics.assignToExistingTopic).toHaveBeenCalledWith(expect.objectContaining({
      topic: expect.objectContaining({
        lifecycle: "mature",
        enrichmentDirtyAt: NOW,
      }),
    }));
  });

  it("creates a provisional topic when representative cohesion rejects a centroid match", async () => {
    const claim = vectorWork({
      dimensions: 2,
      embedding: [1, 0],
      vectorSource: "reused",
    });
    const harness = createHarness([claim]);
    harness.topics.findNearestTopics.mockResolvedValueOnce([{
      ...topic(),
      cosineSimilarity: 1,
    }]);
    harness.topics.loadAssignmentEvidence.mockResolvedValueOnce([
      assignmentEvidence({
        representativeVectors: [{ observationId: "representative-1", embedding: [0, 1] }],
      }),
    ]);

    await harness.worker.runOnce();

    expect(harness.topics.assignToExistingTopic).not.toHaveBeenCalled();
    expect(harness.topics.createTopicAndAssign).toHaveBeenCalledTimes(1);
  });

  it("turns an assignment revision conflict into a retry only while the claim token remains current", async () => {
    const claim = vectorWork({
      dimensions: 2,
      embedding: [1, 0],
      vectorSource: "reused",
    });
    const harness = createHarness([claim]);
    harness.topics.findNearestTopics.mockResolvedValueOnce([{ ...topic(), cosineSimilarity: 1 }]);
    harness.topics.loadAssignmentEvidence.mockResolvedValueOnce([assignmentEvidence()]);
    harness.topics.assignToExistingTopic.mockResolvedValueOnce({
      applied: false,
      topic: null,
      membership: null,
    });

    const result = await harness.worker.runOnce();

    expect(harness.observationWork.failVectorClaim).toHaveBeenCalledWith(expect.objectContaining({
      terminal: false,
      failureStage: "assignment",
      failureReason: "assignment_conflict",
    }));
    expect(result).toMatchObject({ retryCount: 1, staleClaimCount: 0 });
  });

  it("reserves projection budget only for fallback work and pauses before the provider call", async () => {
    const claim = vectorWork({ attemptCount: CONTENT_PLAN_WORKER_POLICY_V1.maxAttempts });
    const harness = createHarness([claim]);
    const budget = {
      reserve: vi.fn().mockResolvedValue({
        kind: "budget_paused" as const,
        reason: "daily_budget_exhausted" as const,
      }),
    };
    const worker = new ContentPlanningWorker({
      observationWork: harness.observationWork,
      semanticSources: harness.semanticSources,
      embeddings: harness.embeddings,
      topics: harness.topics,
      retention: harness.retention,
      budget,
      observability: harness.observer,
      clock: () => NOW,
    });

    const result = await worker.runOnce();

    expect(budget.reserve).toHaveBeenCalledWith({
      workspaceId: claim.workspaceId,
      generationId: claim.generationId,
      requests: 1,
      estimatedSpendMicros: CONTENT_PLAN_WORKER_POLICY_V1.estimatedEmbeddingBatchSpendMicros,
      now: NOW,
    });
    expect(harness.embeddings.embedForProjection).not.toHaveBeenCalled();
    expect(harness.observationWork.failVectorClaim).toHaveBeenCalledWith(expect.objectContaining({
      terminal: false,
      failureStage: "embedding",
      failureReason: "embedding_budget_paused",
    }));
    expect(result).toMatchObject({ budgetPausedCount: 1, retryCount: 1 });
  });

  it("prunes exactly the 60-day boundary in bounded batches and reconciles affected topics", async () => {
    const harness = createHarness([]);
    harness.retention.pruneExpiredObservations.mockResolvedValueOnce({
      deletedCount: 2,
      affectedTopics: [
        { workspaceId: "workspace-1", generationId: "generation-1", topicId: "topic-live" },
        { workspaceId: "workspace-1", generationId: "generation-1", topicId: "topic-empty" },
      ],
    });
    harness.topics.loadReconciliationEvidence.mockResolvedValueOnce([
      {
        topicId: "topic-live",
        liveCentroid: [0.8, 0.2],
        liveObservationCount: 2,
        liveConversationCount: 2,
        representativeObservationIds: ["observation-2", "observation-3"],
      },
      {
        topicId: "topic-empty",
        liveCentroid: null,
        liveObservationCount: 0,
        liveConversationCount: 0,
        representativeObservationIds: [],
      },
    ]);
    harness.topics.resolveTopicRedirect.mockImplementation(async (input: { topicId: string }) => ({
      kind: "active" as const,
      topic: topic({
        id: input.topicId,
        lifecycle: input.topicId === "topic-live" ? "provisional" : "mature",
      }),
      redirectedFromTopicId: null,
      hops: 0,
    }));

    const result = await harness.worker.runRetentionOnce({ workspaceId: "workspace-1" });

    expect(harness.retention.pruneExpiredObservations).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      observedBefore: new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1_000),
      limit: CONTENT_PLAN_WORKER_POLICY_V1.retentionBatchSize,
    });
    expect(harness.topics.findTopicsNeedingReconciliation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      limit: CONTENT_PLAN_WORKER_POLICY_V1.retentionBatchSize,
    });
    expect(harness.topics.pruneExpiredRedirects).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      now: NOW,
      limit: CONTENT_PLAN_WORKER_POLICY_V1.retentionBatchSize,
    });
    expect(harness.topics.loadReconciliationEvidence).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      generationId: "generation-1",
      topicIds: ["topic-live", "topic-empty"],
      limit: 2,
    });
    expect(harness.topics.reconcileTopic).toHaveBeenNthCalledWith(1, expect.objectContaining({
      topicId: "topic-live",
      topic: expect.objectContaining({
        lifecycle: "mature",
        centroid: [0.8, 0.2],
        centroidWeight: 2,
        representativeObservationIds: ["observation-2", "observation-3"],
      }),
    }));
    expect(harness.topics.reconcileTopic).toHaveBeenNthCalledWith(2, expect.objectContaining({
      topicId: "topic-empty",
      topic: expect.objectContaining({
        lifecycle: "retired",
        centroidWeight: 0,
        representativeObservationIds: [],
      }),
    }));
    expect(result).toMatchObject({
      deletedCount: 2,
      reconciledTopicCount: 2,
      retiredTopicCount: 1,
    });
  });
});

describe("ContentPlanningWorkerObservability", () => {
  it("emits only closed safe log/metric/trace fields and never serializes provider failures", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const metrics = {
      incrementCounter: vi.fn(),
      observeHistogram: vi.fn(),
    };
    const tracer = { record: vi.fn() };
    const observability = new ContentPlanningWorkerObservability({ logger, metrics, tracer });
    const claim = vectorWork();
    const harness = createHarness([claim]);
    harness.embeddings.embedForProjection.mockRejectedValueOnce(
      new Error("SECRET QUESTION; [0.111,0.222]; generated label; provider response body"),
    );
    const worker = new ContentPlanningWorker({
      observationWork: harness.observationWork,
      semanticSources: harness.semanticSources,
      embeddings: harness.embeddings,
      topics: harness.topics,
      retention: harness.retention,
      observability,
      clock: () => NOW,
      createTopicId: () => "topic-created",
    });

    await worker.runOnce();

    const emitted = JSON.stringify({
      logs: [...logger.info.mock.calls, ...logger.warn.mock.calls],
      metrics: [...metrics.incrementCounter.mock.calls, ...metrics.observeHistogram.mock.calls],
      traces: tracer.record.mock.calls,
    });
    expect(emitted).not.toContain("SECRET QUESTION");
    expect(emitted).not.toContain("0.111");
    expect(emitted).not.toContain("generated label");
    expect(emitted).not.toContain("provider response body");

    const metricLabels = metrics.incrementCounter.mock.calls.map((call) => call[1]?.labels ?? {});
    for (const labels of metricLabels) {
      expect(labels).not.toHaveProperty("workspace_id");
      expect(labels).not.toHaveProperty("observation_id");
      expect(labels).not.toHaveProperty("topic_id");
    }
    const workerEventLabels = metrics.incrementCounter.mock.calls
      .filter((call) => call[0] === "content_planning_worker_events_total")
      .map((call) => call[1]?.labels ?? {});
    for (const labels of workerEventLabels) {
      expect(Object.keys(labels)).toEqual(expect.arrayContaining(["stage", "outcome"]));
    }

    const events = [...logger.info.mock.calls, ...logger.warn.mock.calls]
      .map((call) => call[0] as ContentPlanWorkerEvent);
    expect(events).toContainEqual(expect.objectContaining({
      stage: "embedding",
      outcome: "retry_scheduled",
      reason: "embedding_provider_failed",
    }));
  });
});
