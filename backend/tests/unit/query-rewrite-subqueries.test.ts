import { describe, expect, it } from "vitest";

import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";

describe("query rewrite subqueries", () => {
  it("accepts decomposed retrieval subqueries even when top-level queries stay the same", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "who is narayani and arudra?",
          semanticQuery: "who is narayani and arudra?",
          lexicalQuery: "who is narayani and arudra?",
          responseLanguagePolicy: "match_user_question",
          retrievalSubqueries: [
            {
              id: "",
              label: "Narayani",
              semanticQuery: "who is narayani",
              lexicalQuery: "narayani",
              responseLanguagePolicy: "match_user_question",
            },
            {
              id: "",
              label: "Arudra",
              semanticQuery: "who is arudra",
              lexicalQuery: "arudra",
              responseLanguagePolicy: "match_user_question",
            },
          ],
          turnKind: "comparative",
          proposedActiveSubject: "Narayani",
          relatedEntities: ["Arudra"],
          unresolved: false,
          confidence: 0.92,
        };
      },
    });

    const result = await service.rewrite({
      query: "who is narayani and arudra?",
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
    expect(result.retrievalSubqueries?.map((subquery) => subquery.label)).toEqual(["Narayani", "Arudra"]);
    expect(result.retrievalSubqueries?.every((subquery) => subquery.responseLanguagePolicy === "match_user_question")).toBe(true);
  });

  it("turns OR-style lexical alternatives into existing retrieval subqueries without changing pipeline contracts", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "how do users recover account access?",
          semanticQuery: "how do users recover account access?",
          lexicalQuery: '"forgot password" OR "reset token" OR "magic link"',
          responseLanguagePolicy: "match_user_question",
          turnKind: "fresh_subject",
          proposedActiveSubject: "account access recovery",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.91,
        };
      },
    });

    const result = await service.rewrite({
      query: "how do I recover account access?",
      contextWindow: {
        selectedMessages: [
          {
            id: "u1",
            conversationId: "c1",
            workspaceId: "w1",
            role: "user",
            content: "We call password recovery reset tokens and magic links.",
            createdAt: new Date(),
          },
        ],
        truncated: false,
        selectionReason: "full-history",
      },
      enabled: true,
      semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
      lexicalRewriteInstructions: "Prefer exact aliases as alternatives.",
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalEligible).toBe(true);
    expect(result.retrievalSubqueries?.map((subquery) => subquery.lexicalQuery)).toEqual([
      "forgot password",
      "reset token",
      "magic link",
    ]);
    expect(result.retrievalSubqueries?.every((subquery) => subquery.semanticQuery === "how do users recover account access?")).toBe(true);
  });
});
