import { describe, expect, it, vi } from "vitest";

import { EmbeddingProfileCleanupService } from "../../../src/modules/embeddingProfiles/services/embeddingProfileCleanupService.js";

describe("EmbeddingProfileCleanupService", () => {
  it("cleans only repository-approved due candidates and reports refusals", async () => {
    const candidates = [
      {
        transitionId: "transition-1",
        workspaceId: "workspace-1",
        embeddingSpaceId: "space-old",
        generation: "2",
      },
      {
        transitionId: "transition-2",
        workspaceId: "workspace-2",
        embeddingSpaceId: "space-shared",
        generation: "4",
      },
    ];
    const repository = {
      listDue: vi.fn().mockResolvedValue(candidates),
      cleanupIfSafe: vi.fn()
        .mockResolvedValueOnce("cleaned")
        .mockResolvedValueOnce("refused"),
    };
    const projectionCleanup = {
      resetWorkspaceSpace: vi.fn().mockResolvedValue(undefined),
      dropUnusedIndexes: vi.fn().mockResolvedValue(0),
    };
    const now = new Date("2026-07-26T00:00:00.000Z");

    await expect(
      new EmbeddingProfileCleanupService(repository, projectionCleanup)
        .runDue({ now, limit: 25 }),
    ).resolves.toEqual({
      cleaned: 1,
      refused: 1,
      alreadyCleaned: 0,
    });
    expect(repository.listDue).toHaveBeenCalledWith({ now, limit: 25 });
    expect(repository.cleanupIfSafe).toHaveBeenCalledTimes(2);
    const firstCleanup = repository.cleanupIfSafe.mock.calls[0]?.[0];
    expect(firstCleanup).toMatchObject({
      candidate: candidates[0],
      now,
    });
    await firstCleanup?.cleanupProjection();
    expect(projectionCleanup.resetWorkspaceSpace).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      embeddingSpaceId: "space-old",
    });
  });

  it("is idempotent when a candidate was already cleaned", async () => {
    const repository = {
      listDue: vi.fn().mockResolvedValue([{
        transitionId: "transition-1",
        workspaceId: "workspace-1",
        embeddingSpaceId: "space-old",
        generation: "2",
      }]),
      cleanupIfSafe: vi.fn().mockResolvedValue("already_cleaned"),
    };
    const projectionCleanup = {
      resetWorkspaceSpace: vi.fn().mockResolvedValue(undefined),
      dropUnusedIndexes: vi.fn().mockResolvedValue(0),
    };

    await expect(
      new EmbeddingProfileCleanupService(repository, projectionCleanup).runDue(),
    ).resolves.toEqual({
      cleaned: 0,
      refused: 0,
      alreadyCleaned: 1,
    });
    expect(projectionCleanup.resetWorkspaceSpace).not.toHaveBeenCalled();
  });
});
