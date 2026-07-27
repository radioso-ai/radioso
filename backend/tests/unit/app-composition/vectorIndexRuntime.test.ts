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
    const reconcileBackfills = vi.fn().mockResolvedValue({
      discovered: 1,
      handedOff: 1,
      failed: 0,
    });
    const promotePendingEmbeddingModelIfReady = vi.fn()
      .mockResolvedValue(undefined);
    const maintenance = new PgVectorTransitionMaintenance(
      { runUntilIdle },
      {
        listBuildingTransitions: vi.fn().mockResolvedValue([{
          profile: { workspaceId: "workspace-1" },
        }]),
      } as never,
      {
        reconcileBackfills,
        promotePendingEmbeddingModelIfReady,
      },
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

  it("repairs committed backfill handoffs before retrying promotion", async () => {
    const events: string[] = [];
    const reconcileBackfills = vi.fn().mockImplementation(async () => {
      events.push("backfill");
      return {
        discovered: 1,
        handedOff: 1,
        failed: 0,
      };
    });
    const listBuildingTransitions = vi.fn().mockImplementation(async () => {
      events.push("list");
      return [{
        profile: { workspaceId: "workspace-1" },
      }];
    });
    const promotePendingEmbeddingModelIfReady = vi.fn()
      .mockImplementation(async () => {
        events.push("promote");
      });
    const maintenance = new PgVectorTransitionMaintenance(
      { runUntilIdle: vi.fn().mockResolvedValue(0) },
      { listBuildingTransitions } as never,
      {
        reconcileBackfills,
        promotePendingEmbeddingModelIfReady,
      },
    );

    await maintenance.reconcileBuildingTransitions(25);

    expect(reconcileBackfills).toHaveBeenCalledWith({ limit: 25 });
    expect(events).toEqual(["backfill", "list", "promote"]);
  });

  it("reports a persistent backfill-reconciliation failure once per incident", async () => {
    const reconcileBackfills = vi.fn()
      .mockResolvedValueOnce({
        discovered: 2,
        handedOff: 1,
        failed: 1,
      })
      .mockResolvedValueOnce({
        discovered: 2,
        handedOff: 1,
        failed: 1,
      })
      .mockResolvedValueOnce({
        discovered: 1,
        handedOff: 1,
        failed: 0,
      })
      .mockResolvedValueOnce({
        discovered: 2,
        handedOff: 1,
        failed: 1,
      });
    const onBackfillReconciliationFailure = vi.fn();
    const maintenance = new PgVectorTransitionMaintenance(
      { runUntilIdle: vi.fn().mockResolvedValue(0) },
      { listBuildingTransitions: vi.fn().mockResolvedValue([]) } as never,
      {
        reconcileBackfills,
        promotePendingEmbeddingModelIfReady: vi.fn(),
      },
      onBackfillReconciliationFailure,
    );

    await maintenance.reconcileBuildingTransitions();
    await maintenance.reconcileBuildingTransitions();
    await maintenance.reconcileBuildingTransitions();
    await maintenance.reconcileBuildingTransitions();

    expect(onBackfillReconciliationFailure).toHaveBeenCalledTimes(2);
    expect(onBackfillReconciliationFailure).toHaveBeenNthCalledWith(1, {
      discovered: 2,
      handedOff: 1,
      failed: 1,
    });
    expect(onBackfillReconciliationFailure).toHaveBeenNthCalledWith(2, {
      discovered: 2,
      handedOff: 1,
      failed: 1,
    });
  });
});
