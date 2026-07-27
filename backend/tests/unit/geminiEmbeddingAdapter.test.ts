import { afterEach, describe, expect, it, vi } from "vitest";

import { GeminiEmbeddingClient } from "../../src/shared/infra/llm/geminiProvider.js";

afterEach(() => vi.restoreAllMocks());

describe("Gemini embedding descriptor mapping", () => {
  it.each([
    ["retrieval_document", "RETRIEVAL_DOCUMENT"],
    ["retrieval_query", "RETRIEVAL_QUERY"],
  ] as const)("maps %s purpose and explicit dimensions", async (purpose, taskType) => {
    let body: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ embedding: { values: [1, 0] } });
    });

    await new GeminiEmbeddingClient({
      capability: "embeddings",
      provider: "gemini",
      model: "gemini-embedding-001",
      apiKey: "key",
    }).embedTexts(["hello"], {
      dimensions: 3072,
      purpose,
    });

    expect(body).toMatchObject({
      model: "models/gemini-embedding-001",
      outputDimensionality: 3072,
      taskType,
    });
    expect(body).not.toHaveProperty("output_dimensionality");
  });
});
