export interface EmbeddingProfileCleanupCandidate {
  transitionId: string;
  workspaceId: string;
  embeddingSpaceId: string;
  generation: string;
}

export interface EmbeddingProfileCleanupRepositoryPort {
  listDue(input: {
    now: Date;
    limit: number;
  }): Promise<EmbeddingProfileCleanupCandidate[]>;
  cleanupIfSafe(input: {
    candidate: EmbeddingProfileCleanupCandidate;
    now: Date;
    cleanupProjection(): Promise<void>;
  }): Promise<"cleaned" | "refused" | "already_cleaned">;
}

export interface EmbeddingProfileProjectionCleanupPort {
  resetWorkspaceSpace(input: {
    workspaceId: string;
    embeddingSpaceId: string;
  }): Promise<void>;
  // Runs after canonical rows are deleted, so a width that no longer has any rows
  // stops costing query planning time. Returns how many indexes it removed.
  dropUnusedIndexes(): Promise<number>;
}

export class EmbeddingProfileCleanupService {
  constructor(
    private readonly repository: EmbeddingProfileCleanupRepositoryPort,
    private readonly projectionCleanup: EmbeddingProfileProjectionCleanupPort,
  ) {}

  async runDue(input: {
    now?: Date;
    limit?: number;
  } = {}): Promise<{
    cleaned: number;
    refused: number;
    alreadyCleaned: number;
  }> {
    const now = input.now ?? new Date();
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Embedding cleanup limit must be between 1 and 1000");
    }
    const candidates = await this.repository.listDue({ now, limit });
    const counts = { cleaned: 0, refused: 0, alreadyCleaned: 0 };
    for (const candidate of candidates) {
      const outcome = await this.repository.cleanupIfSafe({
        candidate,
        now,
        cleanupProjection: () =>
          this.projectionCleanup.resetWorkspaceSpace({
            workspaceId: candidate.workspaceId,
            embeddingSpaceId: candidate.embeddingSpaceId,
          }),
      });
      if (outcome === "cleaned") {
        counts.cleaned += 1;
      } else if (outcome === "refused") {
        counts.refused += 1;
      } else {
        counts.alreadyCleaned += 1;
      }
    }
    // Only after the delete transactions have committed can a width be observed as
    // empty. Failing here must not undo a successful cleanup, so it is reported and
    // retried on the next sweep rather than thrown.
    if (counts.cleaned > 0) {
      await this.projectionCleanup.dropUnusedIndexes().catch(() => 0);
    }

    return counts;
  }
}
