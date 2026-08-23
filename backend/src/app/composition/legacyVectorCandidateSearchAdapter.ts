import type {
  EmbeddingProfileRepositoryPort,
} from "../../modules/embeddingProfiles/contracts/repositories.js";
import type {
  VectorCandidateSearchInput,
  VectorCandidateSearchPort,
  VectorIndexPort,
} from "../../modules/retrieval/public.js";

export interface LegacyVectorCandidateSearchAdapterOptions {
  readonly legacy: VectorIndexPort;
  readonly profiles?: Pick<
    EmbeddingProfileRepositoryPort,
    "findEmbeddingSpaceById"
  >;
}

/**
 * Temporary production bridge while canonical vectors move from the existing
 * model-keyed chunks table to the embedding-space vector adapter.
 */
export class LegacyVectorCandidateSearchAdapter
implements VectorCandidateSearchPort {
  constructor(
    private readonly options: LegacyVectorCandidateSearchAdapterOptions,
  ) {}

  async search(input: VectorCandidateSearchInput) {
    const embeddingModel = await this.resolveLegacyModel(input.space.id);
    const candidates = await this.options.legacy.search({
      workspaceId: input.workspaceId,
      queryEmbedding: input.queryVector,
      queryEmbeddingDimensions: input.space.dimensions,
      topK: input.topK,
      similarityThreshold: input.minimumScore,
      embeddingModel,
      filter: {
        metadataContains: input.filter.metadataContains,
        source: input.filter.source,
      },
    });
    return candidates.map((candidate) => ({
      chunkId: candidate.chunkId,
      documentId: candidate.documentId ?? "",
      embeddingSpaceId: input.space.id,
      version: "0",
      score: candidate.score,
    }));
  }

  private async resolveLegacyModel(spaceId: string): Promise<string> {
    const stored = await this.options.profiles?.findEmbeddingSpaceById(spaceId);
    return stored?.model ?? spaceId;
  }
}

export interface VectorCandidateSearchRolloutAdapterOptions {
  readonly canonical: VectorCandidateSearchPort;
  readonly legacy: VectorCandidateSearchPort;
  readonly legacyDimensions: readonly number[];
}

/**
 * Additive-rollout bridge: canonical results are authoritative, while an
 * explicitly compatible legacy index may fill gaps until backfill completes.
 */
export class VectorCandidateSearchRolloutAdapter
implements VectorCandidateSearchPort {
  private readonly legacyDimensions: ReadonlySet<number>;

  constructor(
    private readonly options: VectorCandidateSearchRolloutAdapterOptions,
  ) {
    this.legacyDimensions = new Set(options.legacyDimensions);
  }

  async search(input: VectorCandidateSearchInput) {
    const canonicalPromise = this.options.canonical.search(input);
    if (!this.legacyDimensions.has(input.space.dimensions)) {
      return canonicalPromise;
    }
    const [canonical, legacy] = await Promise.all([
      canonicalPromise,
      this.options.legacy.search(input),
    ]);
    const candidatesByChunkId = new Map(
      legacy.map((candidate) => [candidate.chunkId, candidate]),
    );
    for (const candidate of canonical) {
      candidatesByChunkId.set(candidate.chunkId, candidate);
    }
    return [...candidatesByChunkId.values()]
      .sort((left, right) =>
        right.score - left.score || left.chunkId.localeCompare(right.chunkId))
      .slice(0, input.topK);
  }
}
