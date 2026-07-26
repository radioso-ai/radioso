import { describe, expect, it, vi } from "vitest";

import { EmbeddingProfileJobFailureAdapter } from "../../../src/app/composition/embeddingProfileJobFailureAdapter.js";
import { EmbeddingProfileLifecycleError } from "../../../src/modules/embeddingProfiles/public.js";

const buildingProfile = {
  workspaceId: "workspace-1",
  activeEmbeddingSpaceId: "space-active",
  pendingEmbeddingSpaceId: "space-target",
  generation: "2",
  transition: {
    id: "transition-1",
    sourceEmbeddingSpaceId: "space-active",
    targetEmbeddingSpaceId: "space-target",
    generation: "2",
    status: "building" as const,
    failureReason: null,
  },
};

const failureInput = {
  jobId: "job-1",
  workspaceId: "workspace-1",
  embeddingSpaceId: "space-target",
  workspaceProfileGeneration: "2",
  failureKind: "retry_exhausted" as const,
};

describe("EmbeddingProfileJobFailureAdapter", () => {
  it("maps a pinned terminal job failure to the fenced transition command", async () => {
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const adapter = new EmbeddingProfileJobFailureAdapter(
      {
        findWorkspaceProfile: vi.fn().mockResolvedValue(buildingProfile),
      },
      { recordFailure },
    );

    await adapter.recordFailure(failureInput);

    expect(recordFailure).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "2",
      kind: "retryable",
    });
  });

  it("maps contract and permanent failures to their distinct lifecycle commands", async () => {
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const adapter = new EmbeddingProfileJobFailureAdapter(
      {
        findWorkspaceProfile: vi.fn().mockResolvedValue(buildingProfile),
      },
      { recordFailure },
    );

    await adapter.recordFailure({
      ...failureInput,
      failureKind: "contract_invalid",
    });
    await adapter.recordFailure({
      ...failureInput,
      failureKind: "permanent",
    });

    expect(recordFailure).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "contract_drift" }),
    );
    expect(recordFailure).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "terminal" }),
    );
  });

  it("ignores stale and already-recorded job fences idempotently", async () => {
    const recordFailure = vi.fn();
    const profiles = {
      findWorkspaceProfile: vi.fn()
        .mockResolvedValueOnce({
          ...buildingProfile,
          transition: {
            ...buildingProfile.transition,
            status: "blocked" as const,
            failureReason: "backfill_retry_exhausted" as const,
          },
        })
        .mockResolvedValueOnce(buildingProfile),
    };
    const adapter = new EmbeddingProfileJobFailureAdapter(
      profiles,
      { recordFailure },
    );

    await adapter.recordFailure(failureInput);
    await adapter.recordFailure({
      ...failureInput,
      embeddingSpaceId: "space-superseded",
    });

    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("accepts a concurrent matching failure but propagates unresolved errors", async () => {
    const blocked = {
      ...buildingProfile,
      transition: {
        ...buildingProfile.transition,
        status: "blocked" as const,
        failureReason: "backfill_retry_exhausted" as const,
      },
    };
    const profiles = {
      findWorkspaceProfile: vi.fn()
        .mockResolvedValueOnce(buildingProfile)
        .mockResolvedValueOnce(blocked)
        .mockResolvedValueOnce(buildingProfile),
    };
    const recordFailure = vi.fn()
      .mockRejectedValueOnce(
        new EmbeddingProfileLifecycleError(
          "transition_not_building",
          "already recorded",
        ),
      )
      .mockRejectedValueOnce(new Error("database unavailable"));
    const adapter = new EmbeddingProfileJobFailureAdapter(
      profiles,
      { recordFailure },
    );

    await expect(adapter.recordFailure(failureInput)).resolves.toBeUndefined();
    await expect(adapter.recordFailure(failureInput)).rejects.toThrow(
      "database unavailable",
    );
  });
});
