import {
  compareVectorIndexVersions,
  cosineSimilarity,
  matchesVectorIndexFilter,
  supportsEmbeddingSpace,
  type EmbeddingSpaceRef,
  type VectorAdapter,
  type VectorCandidate,
  type VectorCandidateSearchInput,
  type VectorIndexCapabilities,
  type VectorIndexHealth,
  type VectorIndexMutation,
  type VectorIndexMutationResult,
  type VectorIndexRecord,
  type VectorIndexWriteResult,
} from "../../src/modules/retrieval/domain/vectorAdapter.js";

interface StoredVector {
  record: VectorIndexRecord | null;
  version: string;
}

const capabilities: VectorIndexCapabilities = {
  backend: "in_memory_external_style",
  dimensionRanges: [{ min: 1, max: 16_000 }],
  distanceMetrics: ["cosine"],
  filterOperations: [
    "source",
    "metadata_containment",
    "retrieval_eligibility",
    "expiry",
  ],
  maxBatchSize: 1_000,
  searchModes: ["exact"],
  consistency: "eventual",
};

export class InMemoryVectorAdapter implements VectorAdapter {
  private readonly preparedSpaces = new Map<string, EmbeddingSpaceRef>();
  private readonly vectors = new Map<string, StoredVector>();

  readonly capabilities = {
    getCapabilities: async (): Promise<VectorIndexCapabilities> => capabilities,
  };

  readonly writer = {
    applyMutations: async (input: {
      workspaceId: string;
      space: EmbeddingSpaceRef;
      mutations: VectorIndexMutation[];
    }): Promise<VectorIndexWriteResult> => {
      this.assertPrepared(input.space);
      if (input.mutations.length > capabilities.maxBatchSize) {
        throw new Error("vector_index_batch_too_large");
      }

      const results = input.mutations.map((mutation) =>
        this.applyMutation(input.workspaceId, input.space, mutation));
      return { mutations: results };
    },
  };

  readonly search = {
    search: async (input: VectorCandidateSearchInput): Promise<VectorCandidate[]> => {
      this.assertPrepared(input.space);
      if (!Number.isInteger(input.topK) || input.topK <= 0) {
        throw new Error("invalid_vector_top_k");
      }
      if (
        !Number.isFinite(input.minimumScore)
        || input.minimumScore < -1
        || input.minimumScore > 1
      ) {
        throw new Error("invalid_vector_minimum_score");
      }
      if (input.queryVector.length !== input.space.dimensions) {
        throw new Error("vector_dimension_mismatch");
      }

      return [...this.vectors.entries()]
        .flatMap(([key, stored]) => {
          if (!key.startsWith(recordKeyPrefix(input.workspaceId, input.space.id))) {
            return [];
          }
          const record = stored.record;
          if (!record || !matchesVectorIndexFilter(record, input.filter)) {
            return [];
          }
          const score = cosineSimilarity(input.queryVector, record.vector);
          if (score < input.minimumScore) {
            return [];
          }
          return [{
            chunkId: record.chunkId,
            documentId: record.documentId,
            embeddingSpaceId: input.space.id,
            version: record.version,
            score,
          }];
        })
        .sort((left, right) =>
          right.score - left.score || left.chunkId.localeCompare(right.chunkId))
        .slice(0, input.topK);
    },
  };

  readonly admin = {
    prepareSpace: async (input: { space: EmbeddingSpaceRef }): Promise<void> => {
      if (!supportsEmbeddingSpace(capabilities, input.space)) {
        throw new Error("unsupported_embedding_space");
      }
      const existing = this.preparedSpaces.get(input.space.id);
      if (
        existing
        && (
          existing.dimensions !== input.space.dimensions
          || existing.distanceMetric !== input.space.distanceMetric
        )
      ) {
        throw new Error("embedding_space_definition_conflict");
      }
      this.preparedSpaces.set(input.space.id, { ...input.space });
    },
    resetSpace: async (input: { spaceId: string; workspaceId?: string }): Promise<void> => {
      const prefix = input.workspaceId
        ? recordKeyPrefix(input.workspaceId, input.spaceId)
        : `${input.spaceId}\u0000`;
      for (const key of this.vectors.keys()) {
        if (key.startsWith(prefix)) {
          this.vectors.delete(key);
        }
      }
    },
    getHealth: async (input: { spaceId?: string }): Promise<VectorIndexHealth> => {
      const prepared = input.spaceId
        ? this.preparedSpaces.has(input.spaceId)
        : true;
      return {
        backend: capabilities.backend,
        status: prepared ? "available" : "unavailable",
        readiness: prepared ? "ready" : "unavailable",
      };
    },
  };

  private applyMutation(
    workspaceId: string,
    space: EmbeddingSpaceRef,
    mutation: VectorIndexMutation,
  ): VectorIndexMutationResult {
    const chunkId = mutation.kind === "upsert" ? mutation.record.chunkId : mutation.chunkId;
    const version = mutation.kind === "upsert" ? mutation.record.version : mutation.version;
    const key = recordKey(workspaceId, space.id, chunkId);
    const existing = this.vectors.get(key);
    const ordering = existing
      ? compareVectorIndexVersions(version, existing.version)
      : 1;

    if (ordering < 0) {
      return {
        chunkId,
        requestedVersion: version,
        acknowledgedVersion: existing!.version,
        outcome: "ignored_stale",
      };
    }
    if (ordering === 0) {
      return {
        chunkId,
        requestedVersion: version,
        acknowledgedVersion: existing!.version,
        outcome: "duplicate",
      };
    }

    if (mutation.kind === "upsert") {
      if (mutation.record.vector.length !== space.dimensions) {
        throw new Error("vector_dimension_mismatch");
      }
      cosineSimilarity(mutation.record.vector, mutation.record.vector);
      this.vectors.set(key, {
        record: cloneRecord(mutation.record),
        version,
      });
    } else {
      this.vectors.set(key, {
        record: null,
        version,
      });
    }

    return {
      chunkId,
      requestedVersion: version,
      acknowledgedVersion: version,
      outcome: "applied",
    };
  }

  private assertPrepared(space: EmbeddingSpaceRef): void {
    const prepared = this.preparedSpaces.get(space.id);
    if (!prepared) {
      throw new Error("vector_space_not_prepared");
    }
    if (
      prepared.dimensions !== space.dimensions
      || prepared.distanceMetric !== space.distanceMetric
    ) {
      throw new Error("embedding_space_definition_conflict");
    }
  }
}

const recordKeyPrefix = (workspaceId: string, spaceId: string): string =>
  `${spaceId}\u0000${workspaceId}\u0000`;

const recordKey = (workspaceId: string, spaceId: string, chunkId: string): string =>
  `${recordKeyPrefix(workspaceId, spaceId)}${chunkId}`;

const cloneRecord = (record: VectorIndexRecord): VectorIndexRecord => ({
  ...record,
  vector: [...record.vector],
  payload: {
    ...record.payload,
    metadata: structuredClone(record.payload.metadata),
  },
});
