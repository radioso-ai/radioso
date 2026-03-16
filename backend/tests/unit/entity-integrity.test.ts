import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { RetrievedCandidate, RerankedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { EntityIntegrityService } from "../../src/modules/retrieval/services/entityIntegrityService.js";

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
  it("boosts candidates whose anchored subject matches the target entity", () => {
    const integrityService = new EntityIntegrityService();

    const result = integrityService.applyCandidateGuards({
      candidates: [
        candidate({
          chunkId: "narayani",
          retrievalText: "Subject: Narayani\nSection: Biography\nBorn in Spain and became a writer.",
          similarity: 0.62,
        }),
        candidate({
          chunkId: "premi",
          retrievalText: "Subject: Premi\nSection: Vows\nIn 2015 she took vows as Nayaswami.",
          similarity: 0.88,
        }),
      ],
      query: "Who is Narayani?",
      history: [],
    });

    expect(result[0]?.chunkId).toBe("narayani");
    expect(result[1]?.chunkId).toBe("premi");
  });

  it("treats competing anchored subjects as unsafe for single-entity answers", () => {
    const integrityService = new EntityIntegrityService();

    const result = integrityService.resolveContexts({
      contexts: [
        reranked({
          chunkId: "narayani",
          retrievalText: "Subject: Narayani\nSection: Biography\nBorn in Spain and became a writer.",
          similarity: 0.9,
        }),
        reranked({
          chunkId: "premi",
          retrievalText: "Subject: Premi\nSection: Vows\nIn 2015 she took vows as Nayaswami.",
          similarity: 0.85,
        }),
      ],
      query: "Who is Narayani?",
      history: [],
      topK: 5,
    });

    expect(result.ambiguityDetected).toBe(true);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]?.chunkId).toBe("narayani");
  });

  it("keeps multiple subject groups available when the query names both", () => {
    const integrityService = new EntityIntegrityService();

    const result = integrityService.resolveContexts({
      contexts: [
        reranked({
          chunkId: "narayani",
          retrievalText: "Subject: Narayani\nSection: Biography\nBorn in Spain and became a writer.",
          similarity: 0.9,
        }),
        reranked({
          chunkId: "premi",
          retrievalText: "Subject: Premi\nSection: Vows\nIn 2015 she took vows as Nayaswami.",
          similarity: 0.85,
        }),
      ],
      query: "Compare Narayani and Premi",
      history: [],
      topK: 5,
    });

    expect(result.selectedSubjects).toEqual(["narayani", "premi"]);
    expect(result.contexts.map((context) => context.chunkId)).toEqual(["narayani", "premi"]);
  });

  it("uses recent user history to keep follow-up retrieval anchored to the same subject", () => {
    const integrityService = new EntityIntegrityService();

    const result = integrityService.resolveContexts({
      contexts: [
        reranked({
          chunkId: "narayani",
          retrievalText: "Subject: Narayani\nSection: Biography\nBorn in Spain and became a writer.",
          similarity: 0.9,
        }),
        reranked({
          chunkId: "premi",
          retrievalText: "Subject: Premi\nSection: Vows\nIn 2015 she took vows as Nayaswami.",
          similarity: 0.89,
        }),
      ],
      query: "Tell me more",
      history: [message("Who is Narayani?")],
      topK: 5,
    });

    expect(result.ambiguityDetected).toBe(true);
    expect(result.selectedSubjects).toEqual(["narayani"]);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]?.chunkId).toBe("narayani");
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
      query: "Who is Narayani?",
      history: [],
      topK: 5,
    });

    expect(result.ambiguityDetected).toBe(true);
    expect(result.selectedSubjects).toEqual([]);
    expect(result.contexts).toHaveLength(2);
  });
});
