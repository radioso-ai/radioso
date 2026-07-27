import { describe, expect, it } from "vitest";

import { embeddingModelIds } from "../../../src/modules/settings/domain/ingestionSettings.js";
import {
  getSupportedEmbeddingModel,
  supportedEmbeddingModelIds,
} from "../../../src/shared/infra/llm/supportedEmbeddingModels.js";

describe("supported embedding model catalog", () => {
  it("contains exactly the existing four public model identifiers", () => {
    expect(supportedEmbeddingModelIds).toEqual(embeddingModelIds);
  });

  it("declares native dimensions and provider-neutral retrieval purposes", () => {
    expect(getSupportedEmbeddingModel("text-embedding-3-small")).toMatchObject({
      providerFamily: "openai_like",
      dimensions: 1536,
    });
    expect(getSupportedEmbeddingModel("text-embedding-3-large")).toMatchObject({
      providerFamily: "openai_like",
      dimensions: 3072,
    });
    expect(getSupportedEmbeddingModel("text-embedding-ada-002")).toMatchObject({
      providerFamily: "openai_like",
      dimensions: 1536,
    });
    expect(getSupportedEmbeddingModel("gemini-embedding-001")).toMatchObject({
      providerFamily: "gemini",
      dimensions: 3072,
      taskMapping: {
        retrieval_document: "RETRIEVAL_DOCUMENT",
        retrieval_query: "RETRIEVAL_QUERY",
      },
    });
  });

  it("rejects identifiers outside the current catalog", () => {
    expect(() => getSupportedEmbeddingModel("future-embedding-model")).toThrow(
      "Unsupported embedding model",
    );
  });
});

