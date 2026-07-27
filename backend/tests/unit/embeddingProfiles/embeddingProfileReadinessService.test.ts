import { describe, expect, it } from "vitest";

import type { EmbeddingSpaceRef } from "../../../src/modules/embeddingProfiles/contracts/embeddingConsumers.js";
import {
  EmbeddingProfileReadinessError,
  EmbeddingProfileReadinessService,
  type EmbeddingIndexQualificationManifest,
  type EmbeddingProfileReadinessStatePort,
  type EmbeddingProfileVectorCapabilitiesPort,
} from "../../../src/modules/embeddingProfiles/services/embeddingProfileReadinessService.js";

const space = (
  dimensions = 3_072,
): EmbeddingSpaceRef => ({
  id: "space-target",
  dimensions,
  distanceMetric: "cosine",
});

const manifest = (
  overrides: Partial<EmbeddingIndexQualificationManifest> = {},
): EmbeddingIndexQualificationManifest => ({
  evidenceId: "embedding-index-v1:test-fixture",
  exactSearch: [{
    backend: "pgvector",
    minDimensions: 1,
    maxDimensions: 16_000,
    maxCorpusVectors: 100,
  }],
  acceleratedSearch: [],
  ...overrides,
});

const createHarness = (input: {
  capabilities?: Partial<Awaited<ReturnType<EmbeddingProfileVectorCapabilitiesPort["getCapabilities"]>>>;
  state?: Partial<Awaited<ReturnType<EmbeddingProfileReadinessStatePort["inspect"]>>>;
  qualification?: EmbeddingIndexQualificationManifest;
} = {}) => {
  const capabilities: EmbeddingProfileVectorCapabilitiesPort = {
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
        ...input.capabilities,
      };
    },
  };
  const state: EmbeddingProfileReadinessStatePort = {
    async inspect() {
      return {
        canonicalVectorCount: 50,
        requiredSequence: "10",
        checkpoint: {
          acknowledgedSequence: "10",
          readiness: "ready",
        },
        ...input.state,
      };
    },
  };
  const service = new EmbeddingProfileReadinessService({
    capabilities,
    state,
    qualification: input.qualification ?? manifest(),
  });
  const evaluate = () => service.evaluate({
    backendKey: "pgvector",
    workspaceId: "workspace-1",
    space: space(),
  });

  return { evaluate, service };
};

describe("EmbeddingProfileReadinessService", () => {
  it("allows exact fallback only within an explicitly benchmarked corpus threshold", async () => {
    const safe = await createHarness().evaluate();

    expect(safe).toMatchObject({
      readiness: "exact_fallback",
      route: "exact",
      activationAllowed: true,
      activationBlockReason: null,
      qualificationEvidenceId: "embedding-index-v1:test-fixture",
      projectionLag: "0",
    });

    const unsafe = await createHarness({
      state: { canonicalVectorCount: 101 },
    }).evaluate();
    expect(unsafe).toMatchObject({
      readiness: "unavailable",
      route: null,
      activationAllowed: false,
      activationBlockReason: "exact_corpus_limit_exceeded",
    });
  });

  it("enables acceleration only for a capability and shape qualified by committed evidence", async () => {
    const qualification = manifest({
      acceleratedSearch: [{
        backend: "pgvector",
        minDimensions: 3_072,
        maxDimensions: 3_072,
      }],
    });

    const accelerated = await createHarness({ qualification }).evaluate();
    expect(accelerated).toMatchObject({
      readiness: "accelerated",
      route: "accelerated",
      activationAllowed: true,
    });

    const notAdvertised = await createHarness({
      qualification,
      capabilities: { searchModes: ["exact"] },
      state: { canonicalVectorCount: 101 },
    }).evaluate();
    expect(notAdvertised).toMatchObject({
      activationAllowed: false,
      activationBlockReason: "exact_corpus_limit_exceeded",
      route: null,
    });
  });

  it("blocks spaces incompatible with backend dimensions, distance, or required filters", async () => {
    for (const capabilities of [
      { dimensionRanges: [{ min: 1, max: 1_536 }] },
      { distanceMetrics: [] },
      {
        filterOperations: [
          "source",
          "metadata_containment",
          "retrieval_eligibility",
        ],
      },
    ]) {
      await expect(createHarness({ capabilities }).evaluate()).resolves.toMatchObject({
        readiness: "unavailable",
        activationAllowed: false,
        activationBlockReason: "unsupported_embedding_space",
      });
    }
  });

  it("blocks missing, lagging, stale, and unavailable checkpoint state", async () => {
    await expect(createHarness({
      state: { checkpoint: null },
    }).evaluate()).resolves.toMatchObject({
      readiness: "building",
      activationBlockReason: "checkpoint_missing",
    });

    await expect(createHarness({
      state: {
        requiredSequence: "20",
        checkpoint: {
          acknowledgedSequence: "12",
          readiness: "ready",
        },
      },
    }).evaluate()).resolves.toMatchObject({
      readiness: "stale",
      projectionLag: "8",
      activationBlockReason: "projection_lag",
    });

    await expect(createHarness({
      state: {
        checkpoint: {
          acknowledgedSequence: "10",
          readiness: "stale",
        },
      },
    }).evaluate()).resolves.toMatchObject({
      readiness: "stale",
      activationBlockReason: "checkpoint_stale",
    });

    await expect(createHarness({
      state: {
        checkpoint: {
          acknowledgedSequence: "10",
          readiness: "unavailable",
        },
      },
    }).evaluate()).resolves.toMatchObject({
      readiness: "unavailable",
      activationBlockReason: "backend_unavailable",
    });
  });

  it("uses safe exact fallback while a qualified accelerated route is still building", async () => {
    const result = await createHarness({
      qualification: manifest({
        acceleratedSearch: [{
          backend: "pgvector",
          minDimensions: 3_072,
          maxDimensions: 3_072,
        }],
      }),
      state: {
        checkpoint: {
          acknowledgedSequence: "10",
          readiness: "building",
        },
      },
    }).evaluate();

    expect(result).toMatchObject({
      readiness: "exact_fallback",
      route: "exact",
      activationAllowed: true,
    });
  });

  it("blocks activation while an oversized qualified route is still building", async () => {
    const { evaluate, service } = createHarness({
      qualification: manifest({
        acceleratedSearch: [{
          backend: "pgvector",
          minDimensions: 3_072,
          maxDimensions: 3_072,
        }],
      }),
      state: {
        canonicalVectorCount: 101,
        checkpoint: {
          acknowledgedSequence: "10",
          readiness: "building",
        },
      },
    });
    const result = await evaluate();

    expect(result).toMatchObject({
      readiness: "building",
      route: null,
      activationAllowed: false,
      activationBlockReason: "accelerated_index_building",
    });
    expect(() => service.assertActivationAllowed(result)).toThrow(
      new EmbeddingProfileReadinessError("accelerated_index_building"),
    );
  });

  it("does not relabel an oversized exact-fallback checkpoint as an accelerated build", async () => {
    const result = await createHarness({
      qualification: manifest({
        acceleratedSearch: [{
          backend: "pgvector",
          minDimensions: 3_072,
          maxDimensions: 3_072,
        }],
      }),
      state: {
        canonicalVectorCount: 101,
        checkpoint: {
          acknowledgedSequence: "10",
          readiness: "exact_fallback",
        },
      },
    }).evaluate();

    expect(result).toMatchObject({
      readiness: "unavailable",
      activationAllowed: false,
      activationBlockReason: "exact_corpus_limit_exceeded",
    });
  });

  it("rejects malformed policy and checkpoint values instead of guessing readiness", async () => {
    expect(() => createHarness({
      qualification: manifest({
        exactSearch: [{
          backend: "pgvector",
          minDimensions: 1,
          maxDimensions: 16_000,
          maxCorpusVectors: -1,
        }],
      }),
    })).toThrow("invalid_embedding_index_qualification");

    await expect(createHarness({
      state: { requiredSequence: "not-a-sequence" },
    }).evaluate()).rejects.toThrow("invalid_embedding_readiness_snapshot");
  });
});
