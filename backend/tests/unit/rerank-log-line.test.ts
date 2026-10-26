import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { ModelRerankGateway, RerankService } from "../../src/modules/retrieval/services/rerankService.js";
import type { ModelInferencePipeline } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import { createLogger } from "../../src/shared/observability/logger.js";

const visitorQuery = "is the ground floor room free for my daughter, she has asthma";
const modelReply = "Sorry, I can't score these for someone whose daughter has asthma";

const captureLog = () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { logger: createLogger("debug", stream), raw: () => chunks.join("") };
};

const contexts: RetrievedCandidate[] = [
  {
    chunkId: "c1",
    documentId: "d1",
    title: "Rooms",
    content: "Ground floor rooms",
    similarity: 0.9,
    retrievalSources: ["semantic_original"],
    retrievalText: "Rooms Ground floor rooms",
    semanticScore: 0.9,
    lexicalScore: 0,
  },
];

describe("rerank log lines", () => {
  it("never log the visitor's query when reranking fails or returns no scores", async () => {
    const { logger, raw } = captureLog();
    const failing = new RerankService({ rerank: async () => { throw new Error(`provider rejected "${visitorQuery}"`); } }, logger);
    const empty = new RerankService({ rerank: async () => [] }, logger);

    await expect(failing.rerank({ query: visitorQuery, contexts, enabled: true, topK: 1 })).resolves.toMatchObject({ status: "fallback" });
    await expect(empty.rerank({ query: visitorQuery, contexts, enabled: true, topK: 1 })).resolves.toMatchObject({ status: "fallback" });

    expect(raw()).toContain("Rerank request failed");
    expect(raw()).toContain("Rerank returned no valid scores");
    expect(raw()).not.toContain("asthma");
  });

  it("never log the model's unparseable reply, which can quote the query", async () => {
    const { logger, raw } = captureLog();
    const gateway = new ModelRerankGateway({
      metadata: { capability: "rerank", provider: "openai-compatible", model: "rerank-test" },
      complete: async () => ({ text: modelReply }),
    } as unknown as ModelInferencePipeline, logger);

    await expect(gateway.rerank({ query: visitorQuery, contexts, today: "2026-10-26" })).rejects.toThrow();

    expect(raw()).toContain("Rerank response could not be parsed");
    expect(raw()).not.toContain("asthma");
  });
});
