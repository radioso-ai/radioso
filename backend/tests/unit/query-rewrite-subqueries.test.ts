import { describe, expect, it } from "vitest";

import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";

describe("query rewrite subqueries", () => {
  it("accepts decomposed retrieval subqueries even when top-level queries stay the same", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "who is freya and tomas?",
          semanticQuery: "who is freya and tomas?",
          lexicalQuery: "who is freya and tomas?",
          responseLanguagePolicy: "match_user_question",
          retrievalSubqueries: [
            {
              id: "",
              label: "Freya",
              semanticQuery: "who is freya",
              lexicalQuery: "freya",
              responseLanguagePolicy: "match_user_question",
            },
            {
              id: "",
              label: "Tomas",
              semanticQuery: "who is tomas",
              lexicalQuery: "tomas",
              responseLanguagePolicy: "match_user_question",
            },
          ],
          turnKind: "comparative",
          proposedActiveSubject: "Freya",
          relatedEntities: ["Tomas"],
          unresolved: false,
          confidence: 0.92,
        };
      },
    });

    const result = await service.rewrite({
      query: "who is freya and tomas?",
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
      enabled: true,
      semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
      lexicalRewriteInstructions: "Prefer exact literals and names.",
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(true);
    expect(result.responseLanguagePolicy).toBe("match_user_question");
    expect(result.retrievalSubqueries).toHaveLength(2);
    expect(result.retrievalSubqueries?.map((subquery) => subquery.label)).toEqual(["Freya", "Tomas"]);
    expect(result.retrievalSubqueries?.every((subquery) => subquery.responseLanguagePolicy === "match_user_question")).toBe(true);
  });
});
