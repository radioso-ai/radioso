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
    const now = new Date("2026-07-26T00:00:00.000Z");

    await expect(
      new EmbeddingProfileCleanupService(repository).runDue({ now, limit: 25 }),
    ).resolves.toEqual({
      cleaned: 1,
      refused: 1,
      alreadyCleaned: 0,
    });
    expect(repository.listDue).toHaveBeenCalledWith({ now, limit: 25 });
    expect(repository.cleanupIfSafe).toHaveBeenCalledTimes(2);
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

    await expect(
      new EmbeddingProfileCleanupService(repository).runDue(),
    ).resolves.toEqual({
      cleaned: 0,
      refused: 0,
      alreadyCleaned: 1,
    });
  });
});
