import { describe, expect, it, vi } from "vitest";

import {
  PgVectorTransitionMaintenance,
  PgVectorTransitionIndexPreparation,
} from "../../../src/app/composition/retrievalComposition.js";

describe("vector index production composition", () => {
  it("prepares pgvector and initializes an exact fallback checkpoint", async () => {
    const adapter = {
      admin: {
        prepareSpace: vi.fn().mockResolvedValue(undefined),
      },
    };
    const checkpoints = {
      ensureCheckpoint: vi.fn().mockResolvedValue({
        acknowledgedSequence: "0",
        readiness: "exact_fallback",
      }),
    };
    const preparation = new PgVectorTransitionIndexPreparation(
      adapter as never,
      checkpoints as never,
    );
    const space = {
      id: "space-target",
      dimensions: 3072,
      distanceMetric: "cosine" as const,
    };

    await preparation.prepare({
      workspaceId: "workspace-1",
      space,
    });

    expect(adapter.admin.prepareSpace).toHaveBeenCalledWith({ space });
    expect(checkpoints.ensureCheckpoint).toHaveBeenCalledWith({
      backendKey: "pgvector",
      workspaceId: "workspace-1",
      embeddingSpaceId: "space-target",
      readiness: "exact_fallback",
    });
  });

  it("retries promotion after a persisted-checkpoint callback failure", async () => {
    const checkpointCallbackFailure = new Error("promotion callback failed");
    const runUntilIdle = vi.fn()
      .mockRejectedValueOnce(checkpointCallbackFailure)
      .mockResolvedValueOnce(0);
    const promotePendingEmbeddingModelIfReady = vi.fn()
      .mockResolvedValue(undefined);
    const maintenance = new PgVectorTransitionMaintenance(
      { runUntilIdle },
      {
        listBuildingTransitions: vi.fn().mockResolvedValue([{
          profile: { workspaceId: "workspace-1" },
        }]),
      } as never,
      { promotePendingEmbeddingModelIfReady },
    );

    await expect(maintenance.run({
      maxBatches: 10,
      workspaceId: "workspace-1",
    })).rejects.toBe(checkpointCallbackFailure);
    expect(promotePendingEmbeddingModelIfReady)
      .toHaveBeenCalledWith("workspace-1");

    promotePendingEmbeddingModelIfReady.mockClear();
    await maintenance.run({ maxBatches: 10 });
    expect(promotePendingEmbeddingModelIfReady)
      .toHaveBeenCalledWith("workspace-1");
  });
});
