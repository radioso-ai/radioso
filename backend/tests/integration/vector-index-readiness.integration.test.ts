import { describe, expect, it } from "vitest";

import {
  EmbeddingProfileReadinessService,
  type EmbeddingIndexQualificationManifest,
  type EmbeddingProfileReadinessState,
} from "../../src/modules/embeddingProfiles/services/embeddingProfileReadinessService.js";

const qualification: EmbeddingIndexQualificationManifest = {
  evidenceId: "embedding-index-v1:committed-test-manifest",
  exactSearch: [{
    backend: "pgvector",
    minDimensions: 1,
    maxDimensions: 16_000,
    maxCorpusVectors: 1_000,
  }],
  acceleratedSearch: [{
    backend: "pgvector",
    minDimensions: 1_536,
    maxDimensions: 3_072,
  }],
};

const evaluate = async (input: {
  dimensions: number;
  canonicalVectorCount: number;
  checkpoint: EmbeddingProfileReadinessState["checkpoint"];
  requiredSequence?: string;
}) => new EmbeddingProfileReadinessService({
  capabilities: {
    async getCapabilities() {
      return {
        backend: "pgvector",
        dimensionRanges: [{ min: 1, max: 16_000 }],
        distanceMetrics: ["cosine"],
        filterOperations: [
          "source",
          "metadata_containment",
          "retrieval_eligibility",
          "expiry",
        ],
        searchModes: ["exact", "accelerated"],
      };
    },
  },
  state: {
    async inspect() {
      return {
        canonicalVectorCount: input.canonicalVectorCount,
        requiredSequence: input.requiredSequence ?? "100",
        checkpoint: input.checkpoint,
      };
    },
  },
  qualification,
}).evaluate({
  backendKey: "pgvector",
  workspaceId: "workspace-1",
  space: {
    id: `space-${input.dimensions}`,
    dimensions: input.dimensions,
    distanceMetric: "cosine",
  },
});

describe("embedding profile vector-index readiness integration", () => {
  it("routes benchmark-safe small corpora to exact fallback across dimensions", async () => {
    for (const dimensions of [768, 3_072, 4_096]) {
      await expect(evaluate({
        dimensions,
        canonicalVectorCount: 1_000,
        checkpoint: {
          acknowledgedSequence: "100",
          readiness: "exact_fallback",
        },
      })).resolves.toMatchObject({
        activationAllowed: true,
        readiness: "exact_fallback",
        route: "exact",
      });
    }
  });

  it("activates only a qualified, caught-up accelerated dimension", async () => {
    await expect(evaluate({
      dimensions: 3_072,
      canonicalVectorCount: 100_000,
      checkpoint: {
        acknowledgedSequence: "100",
        readiness: "ready",
      },
    })).resolves.toMatchObject({
      activationAllowed: true,
      readiness: "accelerated",
      route: "accelerated",
      projectionLag: "0",
    });
  });

  it("blocks oversized unqualified dimensions and lagging qualified routes", async () => {
    await expect(evaluate({
      dimensions: 4_096,
      canonicalVectorCount: 1_001,
      checkpoint: {
        acknowledgedSequence: "100",
        readiness: "ready",
      },
    })).resolves.toMatchObject({
      activationAllowed: false,
      readiness: "unavailable",
      activationBlockReason: "exact_corpus_limit_exceeded",
    });

    await expect(evaluate({
      dimensions: 3_072,
      canonicalVectorCount: 100_000,
      checkpoint: {
        acknowledgedSequence: "99",
        readiness: "ready",
      },
    })).resolves.toMatchObject({
      activationAllowed: false,
      readiness: "stale",
      projectionLag: "1",
      activationBlockReason: "projection_lag",
    });
  });
});
