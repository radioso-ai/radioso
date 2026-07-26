import { describe, expect, it } from "vitest";

import { OpenAIEmbeddingClient } from "../../src/shared/infra/llm/openaiProvider.js";

describe("OpenAI embedding descriptor mapping", () => {
  it("forwards explicit supported dimensions for text-embedding-3 models", async () => {
    let request: Record<string, unknown> | undefined;
    const client = new OpenAIEmbeddingClient({
      capability: "embeddings",
      provider: "openai",
      model: "text-embedding-3-large",
      apiKey: "key",
    });
    (client as any).client.embeddings.create = async (input: Record<string, unknown>) => {
      request = input;
      return { data: [{ embedding: [1, 0] }] };
    };

    await client.embedTexts(["hello"], {
      model: "text-embedding-3-large",
      dimensions: 3072,
      purpose: "retrieval_document",
    });

    expect(request).toMatchObject({ model: "text-embedding-3-large", dimensions: 3072 });
  });

  it("does not send dimensions for ada-002 or compatible endpoints", async () => {
    for (const config of [
      { provider: "openai" as const, model: "text-embedding-ada-002", apiKey: "key" },
      {
        provider: "openai-compatible" as const,
        model: "text-embedding-3-large",
        apiKey: "key",
        baseUrl: "https://example.test/v1",
      },
    ]) {
      let request: Record<string, unknown> | undefined;
      const client = new OpenAIEmbeddingClient({ capability: "embeddings", ...config });
      (client as any).client.embeddings.create = async (input: Record<string, unknown>) => {
        request = input;
        return { data: [{ embedding: [1, 0] }] };
      };
      await client.embedTexts(["hello"], { model: config.model, dimensions: 3072 });
      expect(request).not.toHaveProperty("dimensions");
    }
  });
});

