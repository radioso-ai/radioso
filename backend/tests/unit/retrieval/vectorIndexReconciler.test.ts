import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EmbeddingSpaceRecord,
  VectorIndexCheckpointRecord,
  VectorIndexReadiness,
  VectorIndexWorkRecord,
} from "../../../src/modules/embeddingProfiles/contracts/repositories.js";
import { VectorIndexReconciler } from "../../../src/modules/retrieval/services/vectorIndexReconciler.js";
import { InMemoryVectorAdapter } from "../../support/inMemoryVectorAdapter.js";

const now = new Date("2026-07-26T12:00:00.000Z");
const workspaceId = "workspace-1";
const embeddingSpaceId = "space-1";

describe("VectorIndexReconciler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["ready", "exact_fallback"] as const)(
    "notifies after persisting a %s checkpoint",
    async (readiness) => {
      const onCheckpointAdvanced = vi.fn();
      const { reconciler, markCompletedAndAdvanceCheckpoint } = reconcilerFor({
        readiness,
        onCheckpointAdvanced,
      });

      await expect(reconciler.runOnce()).resolves.toBe(true);

      expect(onCheckpointAdvanced).toHaveBeenCalledWith({
        workspaceId,
        embeddingSpaceId,
        readiness,
      });
      expect(
        markCompletedAndAdvanceCheckpoint.mock.invocationCallOrder[0],
      ).toBeLessThan(onCheckpointAdvanced.mock.invocationCallOrder[0]!);
    },
  );

  it("does not notify for a building checkpoint", async () => {
    const onCheckpointAdvanced = vi.fn();
    const { reconciler } = reconcilerFor({
      readiness: "building",
      onCheckpointAdvanced,
    });

    await expect(reconciler.runOnce()).resolves.toBe(true);
    expect(onCheckpointAdvanced).not.toHaveBeenCalled();
  });

  it("completes superseded work without sending the obsolete mutation to the adapter", async () => {
    const checkpoint: VectorIndexCheckpointRecord = {
      backendKey: "in-memory",
      workspaceId,
      embeddingSpaceId,
      acknowledgedSequence: "1",
      readiness: "exact_fallback",
      updatedAt: now,
    };
    const adapter = new InMemoryVectorAdapter();
    const prepareSpace = vi.spyOn(adapter.admin, "prepareSpace");
    const applyMutations = vi.spyOn(adapter.writer, "applyMutations");
    const markCompletedAndAdvanceCheckpoint = vi.fn();
    const markFailed = vi.fn();
    const completeSupersededAndAdvanceCheckpoint = vi.fn()
      .mockResolvedValue(checkpoint);
    const onCheckpointAdvanced = vi.fn();
    const reconciler = new VectorIndexReconciler({
      adapter,
      backendKey: "in-memory",
      repository: {
        claimBatch: vi.fn().mockResolvedValue([work]),
        markFailed,
        markCompletedAndAdvanceCheckpoint,
        completeSupersededAndAdvanceCheckpoint,
        getLag: vi.fn(),
      },
      spaces: {
        findEmbeddingSpaceById: vi.fn().mockResolvedValue(space),
      },
      batchSize: 1,
      leaseMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      resolveCaughtUpReadiness: vi.fn().mockResolvedValue("exact_fallback"),
      onCheckpointAdvanced,
    });

    await expect(reconciler.runOnce()).resolves.toBe(true);

    expect(completeSupersededAndAdvanceCheckpoint).toHaveBeenCalledWith({
      id: work.id,
      backendKey: "in-memory",
      workspaceId,
      embeddingSpaceId,
      chunkId: work.chunkId,
      caughtUpReadiness: "exact_fallback",
    });
    expect(prepareSpace).not.toHaveBeenCalled();
    expect(applyMutations).not.toHaveBeenCalled();
    expect(markCompletedAndAdvanceCheckpoint).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(onCheckpointAdvanced).toHaveBeenCalledOnce();
  });

  it("preserves retries when failed work has no superseding mutation", async () => {
    const failure = new Error("backend unavailable");
    const adapter = new InMemoryVectorAdapter();
    vi.spyOn(adapter.writer, "applyMutations").mockRejectedValue(failure);
    const markFailed = vi.fn().mockResolvedValue({
      disposition: "retry_scheduled",
      checkpoint: null,
    });
    const reconciler = new VectorIndexReconciler({
      adapter,
      backendKey: "in-memory",
      clock: () => now,
      repository: {
        claimBatch: vi.fn().mockResolvedValue([work]),
        markFailed,
        markCompletedAndAdvanceCheckpoint: vi.fn(),
        completeSupersededAndAdvanceCheckpoint: vi.fn()
          .mockResolvedValue(null),
        getLag: vi.fn(),
      },
      spaces: {
        findEmbeddingSpaceById: vi.fn().mockResolvedValue(space),
      },
      batchSize: 1,
      leaseMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
    });

    await expect(reconciler.runOnce()).resolves.toBe(true);

    expect(markFailed).toHaveBeenCalledWith({
      id: work.id,
      errorCode: "adapter_unavailable",
      retryAt: new Date(now.getTime() + 5_000),
      maxAttempts: 3,
      backendKey: "in-memory",
      workspaceId,
      embeddingSpaceId,
      chunkId: work.chunkId,
      caughtUpReadiness: "building",
    });
  });

  it("notifies when a superseded failure closes the remaining checkpoint gap", async () => {
    const adapter = new InMemoryVectorAdapter();
    vi.spyOn(adapter.writer, "applyMutations")
      .mockRejectedValue(new Error("older mutation unavailable"));
    const checkpoint: VectorIndexCheckpointRecord = {
      backendKey: "in-memory",
      workspaceId,
      embeddingSpaceId,
      acknowledgedSequence: "2",
      readiness: "exact_fallback",
      updatedAt: now,
    };
    const markFailed = vi.fn().mockResolvedValue({
      disposition: "superseded",
      checkpoint,
    });
    const onCheckpointAdvanced = vi.fn();
    const reconciler = new VectorIndexReconciler({
      adapter,
      backendKey: "in-memory",
      clock: () => now,
      repository: {
        claimBatch: vi.fn().mockResolvedValue([work]),
        markFailed,
        markCompletedAndAdvanceCheckpoint: vi.fn(),
        completeSupersededAndAdvanceCheckpoint: vi.fn()
          .mockResolvedValue(null),
        getLag: vi.fn(),
      },
      spaces: {
        findEmbeddingSpaceById: vi.fn().mockResolvedValue(space),
      },
      batchSize: 1,
      leaseMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      resolveCaughtUpReadiness: vi.fn()
        .mockResolvedValue("exact_fallback"),
      onCheckpointAdvanced,
    });

    await expect(reconciler.runOnce()).resolves.toBe(true);

    expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({
      id: work.id,
      caughtUpReadiness: "exact_fallback",
    }));
    expect(onCheckpointAdvanced).toHaveBeenCalledWith({
      workspaceId,
      embeddingSpaceId,
      readiness: "exact_fallback",
    });
  });

  it("surfaces notification failures without marking persisted work as failed", async () => {
    const callbackError = new Error("activation callback failed");
    const onCheckpointAdvanced = vi.fn().mockRejectedValue(callbackError);
    const { reconciler, markCompletedAndAdvanceCheckpoint, markFailed } =
      reconcilerFor({
        readiness: "exact_fallback",
        onCheckpointAdvanced,
      });

    await expect(reconciler.runOnce()).rejects.toBe(callbackError);

    expect(markCompletedAndAdvanceCheckpoint).toHaveBeenCalledOnce();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("drains until idle or the validated batch bound", async () => {
    const { reconciler } = reconcilerFor({ readiness: "building" });
    const runOnce = vi.spyOn(reconciler, "runOnce")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(reconciler.runUntilIdle(100)).resolves.toBe(2);
    expect(runOnce).toHaveBeenCalledTimes(3);

    runOnce.mockReset().mockResolvedValue(true);
    await expect(reconciler.runUntilIdle(2)).resolves.toBe(2);
    expect(runOnce).toHaveBeenCalledTimes(2);

    for (const invalid of [0, 101, 1.5, Number.NaN]) {
      await expect(reconciler.runUntilIdle(invalid)).rejects.toThrow(
        /between 1 and 100/i,
      );
    }
  });

  it("reports polling failures instead of swallowing them", async () => {
    vi.useFakeTimers();
    const failure = new Error("checkpoint database unavailable");
    const onLoopError = vi.fn();
    const reconciler = new VectorIndexReconciler({
      adapter: new InMemoryVectorAdapter(),
      backendKey: "in-memory",
      repository: {
        claimBatch: vi.fn().mockRejectedValue(failure),
        markFailed: vi.fn(),
        markCompletedAndAdvanceCheckpoint: vi.fn(),
        completeSupersededAndAdvanceCheckpoint: vi.fn(),
        getLag: vi.fn(),
      },
      spaces: {
        findEmbeddingSpaceById: vi.fn(),
      },
      batchSize: 1,
      leaseMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      pollIntervalMs: 1_000,
      onLoopError,
    });

    reconciler.start();
    await vi.advanceTimersByTimeAsync(0);
    await reconciler.stop();

    expect(onLoopError).toHaveBeenCalledWith(failure);
  });

  it("runs transition maintenance when projection work is idle", async () => {
    const onIdle = vi.fn().mockResolvedValue(undefined);
    const reconciler = new VectorIndexReconciler({
      adapter: new InMemoryVectorAdapter(),
      backendKey: "in-memory",
      repository: {
        claimBatch: vi.fn().mockResolvedValue([]),
        markFailed: vi.fn(),
        markCompletedAndAdvanceCheckpoint: vi.fn(),
        completeSupersededAndAdvanceCheckpoint: vi.fn(),
        getLag: vi.fn(),
      },
      spaces: {
        findEmbeddingSpaceById: vi.fn(),
      },
      batchSize: 1,
      leaseMs: 1_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      onIdle,
    });

    await expect(reconciler.runOnce()).resolves.toBe(false);
    expect(onIdle).toHaveBeenCalledOnce();
  });
});

const reconcilerFor = (input: {
  readiness: VectorIndexReadiness;
  onCheckpointAdvanced?: (input: {
    workspaceId: string;
    embeddingSpaceId: string;
    readiness: "ready" | "exact_fallback";
  }) => Promise<void>;
}) => {
  const checkpoint: VectorIndexCheckpointRecord = {
    backendKey: "in-memory",
    workspaceId,
    embeddingSpaceId,
    acknowledgedSequence: "1",
    readiness: input.readiness,
    updatedAt: now,
  };
  const markCompletedAndAdvanceCheckpoint = vi.fn()
    .mockResolvedValue(checkpoint);
  const markFailed = vi.fn();
  const reconciler = new VectorIndexReconciler({
    adapter: new InMemoryVectorAdapter(),
    backendKey: "in-memory",
    repository: {
      claimBatch: vi.fn().mockResolvedValue([work]),
      markFailed,
      markCompletedAndAdvanceCheckpoint,
      completeSupersededAndAdvanceCheckpoint: vi.fn().mockResolvedValue(null),
      getLag: vi.fn(),
    },
    spaces: {
      findEmbeddingSpaceById: vi.fn().mockResolvedValue(space),
    },
    batchSize: 1,
    leaseMs: 1_000,
    maxAttempts: 3,
    retryDelayMs: 5_000,
    resolveCaughtUpReadiness: vi.fn().mockResolvedValue(input.readiness),
    onCheckpointAdvanced: input.onCheckpointAdvanced,
  });
  return { reconciler, markCompletedAndAdvanceCheckpoint, markFailed };
};

const space: EmbeddingSpaceRecord = {
  id: embeddingSpaceId,
  identityFingerprint: "fingerprint",
  provider: "openai",
  endpointScopeFingerprint: "scope",
  model: "test-model",
  dimensions: 2,
  distanceMetric: "cosine",
  normalization: "provider_unit",
  documentTask: null,
  queryTask: null,
  vectorOptions: {},
  modelVersion: null,
  status: "active",
  quarantineReason: null,
  createdAt: now,
  updatedAt: now,
};

const work: VectorIndexWorkRecord = {
  id: "work-1",
  sequence: "1",
  workspaceId,
  embeddingSpaceId,
  chunkId: "chunk-1",
  documentId: "document-1",
  operation: "upsert",
  canonicalVersion: "1",
  payload: {
    dimensions: 2,
    distanceMetric: "cosine",
    vector: [1, 0],
    sourceId: null,
    metadata: {},
    retrievalEnabled: true,
    retrievalExpiresAt: null,
  },
  status: "processing",
  attemptCount: 1,
  availableAt: now,
  claimedAt: now,
  completedAt: null,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};
