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
  }): Promise<"cleaned" | "refused" | "already_cleaned">;
}

export class EmbeddingProfileCleanupService {
  constructor(private readonly repository: EmbeddingProfileCleanupRepositoryPort) {}

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
      const outcome = await this.repository.cleanupIfSafe({ candidate, now });
      if (outcome === "cleaned") {
        counts.cleaned += 1;
      } else if (outcome === "refused") {
        counts.refused += 1;
      } else {
        counts.alreadyCleaned += 1;
      }
    }
    return counts;
  }
}
