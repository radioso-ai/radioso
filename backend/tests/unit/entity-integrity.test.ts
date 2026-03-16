import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { RetrievedCandidate, RerankedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { EntityIntegrityService } from "../../src/modules/retrieval/services/entityIntegrityService.js";
import { EntityQueryIntentService } from "../../src/modules/retrieval/services/entityQueryIntentService.js";

const message = (content: string, role: MessageRecord["role"] = "user"): MessageRecord => ({
  id: content,
  conversationId: "c1",
  accountId: "a1",
  role,
  content,
  createdAt: new Date(),
});

const candidate = (input: {
  chunkId: string;
  retrievalText: string;
  similarity?: number;
}): RetrievedCandidate => ({
  chunkId: input.chunkId,
  documentId: `doc-${input.chunkId}`,
  title: "| Generic Catalog |",
  content: input.retrievalText,
  searchText: input.retrievalText,
  similarity: input.similarity ?? 0.7,
  retrievalSources: ["semantic_original"],
  retrievalText: input.retrievalText,
  semanticScore: input.similarity ?? 0.7,
  lexicalScore: 0,
  attributeMatchScore: 0,
});

const reranked = (input: {
  chunkId: string;
  retrievalText: string;
  similarity?: number;
}): RerankedCandidate => ({
  ...candidate(input),
  relevanceScore: input.similarity ?? 0.7,
  rerankPosition: 0,
});

describe("entity integrity services", () => {
  it("parses correction turns without relying on person-specific rules", () => {
    const service = new EntityQueryIntentService();

    const result = service.interpret({
      query: "Premi was given a Nayaswami title, not Freya",
      history: [message("Who is Freya?")],
    });

    expect(result.mode).toBe("correction");
    expect(result.includePhrases).toContain("premi");
    expect(result.excludePhrases).toContain("freya");
  });

  it("does not treat ordinary negation as a correction when there is no correction context", () => {
    const service = new EntityQueryIntentService();

    const result = service.interpret({
      query: "What is not allowed in the API?",
      history: [],
    });

    expect(result.mode).toBe("generic");
    expect(result.includePhrases).toEqual([]);
    expect(result.excludePhrases).toEqual([]);
  });

  it("does not collapse explicit comparison queries into a single entity", () => {
    const service = new EntityQueryIntentService();

    const result = service.interpret({
      query: "Compare Freya and Premi",
      history: [],
    });

    expect(result.mode).toBe("comparison");
    expect(result.includePhrases).toEqual(expect.arrayContaining(["freya", "premi"]));
  });

  it("boosts candidates whose anchored subject matches the target entity", () => {
    const queryIntentService = new EntityQueryIntentService();
    const integrityService = new EntityIntegrityService();
    const intent = queryIntentService.interpret({
      query: "Who is Freya?",
      history: [],
    });

    const result = integrityService.applyCandidateGuards({
      candidates: [
        candidate({
          chunkId: "freya",
          retrievalText: "Subject: Freya\nSection: Biography\nBorn in Spain and became a writer.",
          similarity: 0.62,
        }),
        candidate({
          chunkId: "premi",
          retrievalText: "Subject: Premi\nSection: Vows\nIn 2015 she took vows as Nayaswami.",
          similarity: 0.88,
        }),
      ],
      query: "Who is Freya?",
      history: [],
      intent,
    });

    expect(result[0]?.chunkId).toBe("freya");
    expect(result[1]?.chunkId).toBe("premi");
  });

  it("treats competing anchored subjects as unsafe for single-entity answers", () => {
    const integrityService = new EntityIntegrityService();

    const result = integrityService.resolveContexts({
      contexts: [
        reranked({
          chunkId: "freya",
          retrievalText: "Subject: Freya\nSection: Biography\nBorn in Spain and became a writer.",
          similarity: 0.9,
        }),
        reranked({
          chunkId: "premi",
          retrievalText: "Subject: Premi\nSection: Vows\nIn 2015 she took vows as Nayaswami.",
          similarity: 0.85,
        }),
      ],
      query: "Who is Freya?",
      history: [],
      intent: {
        mode: "generic",
        includePhrases: [],
        excludePhrases: [],
      },
      topK: 5,
    });

    expect(result.ambiguityDetected).toBe(true);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]?.chunkId).toBe("freya");
  });

  it("keeps multiple subject groups available for explicit comparisons", () => {
    const queryIntentService = new EntityQueryIntentService();
    const integrityService = new EntityIntegrityService();
    const intent = queryIntentService.interpret({
      query: "Compare Freya and Premi",
      history: [],
    });

    const result = integrityService.resolveContexts({
      contexts: [
        reranked({
          chunkId: "freya",
          retrievalText: "Subject: Freya\nSection: Biography\nBorn in Spain and became a writer.",
          similarity: 0.9,
        }),
        reranked({
          chunkId: "premi",
          retrievalText: "Subject: Premi\nSection: Vows\nIn 2015 she took vows as Nayaswami.",
          similarity: 0.85,
        }),
      ],
      query: "Compare Freya and Premi",
      history: [],
      intent,
      topK: 5,
    });

    expect(result.ambiguityDetected).toBe(false);
    expect(result.contexts.map((context) => context.chunkId)).toEqual(["freya", "premi"]);
  });

  it("uses recent user history to keep follow-up retrieval anchored to the same subject", () => {
    const integrityService = new EntityIntegrityService();

    const result = integrityService.resolveContexts({
      contexts: [
        reranked({
          chunkId: "freya",
          retrievalText: "Subject: Freya\nSection: Biography\nBorn in Spain and became a writer.",
          similarity: 0.9,
        }),
        reranked({
          chunkId: "premi",
          retrievalText: "Subject: Premi\nSection: Vows\nIn 2015 she took vows as Nayaswami.",
          similarity: 0.89,
        }),
      ],
      query: "Tell me more",
      history: [message("Who is Freya?")],
      intent: {
        mode: "generic",
        includePhrases: [],
        excludePhrases: [],
      },
      topK: 5,
    });

    expect(result.ambiguityDetected).toBe(true);
    expect(result.selectedSubjects).toEqual(["freya"]);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]?.chunkId).toBe("freya");
  });

  it("marks unresolved competing subjects as unsafe when no preferred subject can be found", () => {
    const integrityService = new EntityIntegrityService();

    const result = integrityService.resolveContexts({
      contexts: [
        reranked({
          chunkId: "premi",
          retrievalText: "Subject: Premi\nSection: Vows\nIn 2015 she took vows as Nayaswami.",
          similarity: 0.9,
        }),
        reranked({
          chunkId: "clarita",
          retrievalText: "Subject: Clarita\nSection: Biography\nClarita teaches meditation and healing.",
          similarity: 0.85,
        }),
      ],
      query: "Who is Freya?",
      history: [],
      intent: {
        mode: "generic",
        includePhrases: ["freya"],
        excludePhrases: [],
      },
      topK: 5,
    });

    expect(result.ambiguityDetected).toBe(true);
    expect(result.selectedSubjects).toEqual([]);
    expect(result.contexts).toHaveLength(2);
  });
});
