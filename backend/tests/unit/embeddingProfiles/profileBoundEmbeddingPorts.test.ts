import { describe, expect, it } from "vitest";

import type {
  EmbeddingGenerationOptions,
  EmbeddingGenerationGateway,
} from "../../../src/modules/embeddingProfiles/contracts/embeddingGeneration.js";
import {
  ProfileBoundEmbeddingPorts,
  type EmbeddingBindingResolverPort,
} from "../../../src/modules/embeddingProfiles/services/profileBoundEmbeddingPorts.js";

describe("ProfileBoundEmbeddingPorts", () => {
  it("binds query generation to the active workspace profile", async () => {
    const calls: Array<{
      texts: readonly string[];
      options?: EmbeddingGenerationOptions;
    }> = [];
    const gateway: EmbeddingGenerationGateway = {
      async embedTexts(texts, options) {
        calls.push({ texts, options });
        return [[0.1, 0.2, 0.3]];
      },
    };
    const bindings: EmbeddingBindingResolverPort = {
      async resolveBindingForSpace() {
        throw new Error("not expected");
      },
      async resolveBinding({ workspaceId, purpose }) {
        expect(workspaceId).toBe("workspace-1");
        expect(purpose).toBe("retrieval_query");
        return {
          space: {
            id: "space-3072",
            dimensions: 3072,
            distanceMetric: "cosine",
          },
          model: "text-embedding-3-large",
          provider: "openai",
          endpointScopeFingerprint: "endpoint-a",
        };
      },
    };
    const ports = new ProfileBoundEmbeddingPorts(gateway, bindings);

    const result = await ports.embedQueries({
      workspaceId: "workspace-1",
      texts: ["where is the policy?"],
      usageContext: {
        workspaceId: "workspace-1",
        surface: "retrieval",
        operation: "query_embedding",
        attemptKey: "query-1",
      },
    });

    expect(result).toEqual({
      space: {
        id: "space-3072",
        dimensions: 3072,
        distanceMetric: "cosine",
      },
      vectors: [[0.1, 0.2, 0.3]],
      usage: undefined,
    });
    expect(calls).toEqual([{
      texts: ["where is the policy?"],
      options: expect.objectContaining({
        model: "text-embedding-3-large",
        dimensions: 3072,
        provider: "openai",
        endpointScopeFingerprint: "endpoint-a",
        purpose: "retrieval_query",
      }),
    }]);
  });

  it("binds document and clustering purposes without exposing them to consumers", async () => {
    const purposes: Array<EmbeddingGenerationOptions["purpose"]> = [];
    const gateway: EmbeddingGenerationGateway = {
      async embedTexts() {
        throw new Error("usage-aware generation expected");
      },
      async embedTextsWithUsage(_texts, options) {
        purposes.push(options?.purpose);
        return {
          vectors: [[1, 0]],
          usage: { inputTokens: 4, quality: "actual" },
        };
      },
    };
    const bindings: EmbeddingBindingResolverPort = {
      async resolveBindingForSpace({ embeddingSpaceId }) {
        expect(embeddingSpaceId).toBe("space-gemini");
        return {
          space: {
            id: "space-gemini",
            dimensions: 2,
            distanceMetric: "cosine",
          },
          model: "gemini-embedding-001",
          provider: "gemini",
        };
      },
      async resolveBinding() {
        return {
          space: {
            id: "space-gemini",
            dimensions: 2,
            distanceMetric: "cosine",
          },
          model: "gemini-embedding-001",
          provider: "gemini",
        };
      },
    };
    const ports = new ProfileBoundEmbeddingPorts(gateway, bindings);

    const document = await ports.embedDocumentChunks({
      workspaceId: "workspace-1",
      texts: ["chunk"],
      documentId: "document-1",
      documentRevision: 2,
      jobId: "job-1",
    });
    const clustering = await ports.embedForClustering({
      workspaceId: "workspace-1",
      texts: ["sentence"],
    });

    expect(purposes).toEqual(["retrieval_document", "clustering"]);
    expect(document.space.id).toBe("space-gemini");
    expect(document.usage).toEqual({ inputTokens: 4, quality: "actual" });
    expect(clustering).toEqual({
      vectors: [[1, 0]],
      usage: { inputTokens: 4, quality: "actual" },
    });
  });
});
