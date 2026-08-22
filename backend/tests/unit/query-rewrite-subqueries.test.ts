import { describe, expect, it } from "vitest";

import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";

const rewriteComparison = async (
  subqueries: Array<{ label: string; semanticQuery: string; lexicalQuery: string }>,
  query = "compare alpha and beta",
) => {
  const service = new QueryRewriteService({
    async rewrite() {
      return {
        rewrittenQuery: query,
        semanticQuery: query,
        lexicalQuery: query,
        responseLanguagePolicy: "match_user_question" as const,
        retrievalSubqueries: subqueries.map((subquery) => ({
          id: "",
          ...subquery,
          responseLanguagePolicy: "match_user_question" as const,
        })),
        turnKind: "comparative" as const,
        relatedEntities: [],
        unresolved: false,
        confidence: 0.9,
      };
    },
  });

  return service.rewrite({
    query,
    contextWindow: {
      selectedMessages: [],
      truncated: false,
      selectionReason: "no-history",
    },
    enabled: true,
  });
};

describe("query rewrite subqueries", () => {
  it("normalizes a typographic apostrophe without dropping its comparison branch", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery:
            "Confronto tra 108 palpiti d’Amore, La meditazione di Yogananda e L'arte come guida al risveglio",
          semanticQuery:
            "Confronto tra 108 palpiti d’Amore, La meditazione di Yogananda e L'arte come guida al risveglio per identificare il più romantico",
          lexicalQuery:
            "108 palpiti d’Amore La meditazione di Yogananda L'arte come guida al risveglio romantico",
          responseLanguagePolicy: "match_user_question",
          retrievalSubqueries: [
            {
              id: "",
              label: "108 palpiti d’Amore",
              semanticQuery: "108 palpiti d’Amore come libro romantico",
              lexicalQuery: "108 palpiti d’Amore",
              responseLanguagePolicy: "match_user_question",
            },
            {
              id: "",
              label: "La meditazione di Yogananda",
              semanticQuery: "La meditazione di Yogananda come libro romantico",
              lexicalQuery: "La meditazione di Yogananda",
              responseLanguagePolicy: "match_user_question",
            },
            {
              id: "",
              label: "L'arte come guida al risveglio",
              semanticQuery: "L'arte come guida al risveglio come libro romantico",
              lexicalQuery: "L'arte come guida al risveglio",
              responseLanguagePolicy: "match_user_question",
            },
          ],
          turnKind: "comparative",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.89,
        };
      },
    });

    const result = await service.rewrite({
      query: "Qual è il più romantico?",
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
      enabled: true,
    });

    expect(result.retrievalSubqueries?.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "subquery_1", label: "108 palpiti d'Amore" },
      { id: "subquery_2", label: "La meditazione di Yogananda" },
      { id: "subquery_3", label: "L'arte come guida al risveglio" },
    ]);
    expect(result.retrievalSubqueries?.[0]?.semanticQuery).toBe("108 palpiti d’Amore come libro romantico");
    expect(result.retrievalSubqueries?.[0]?.lexicalQuery).toBe("108 palpiti d’Amore");
  });

  it.each([
    ["an em dash", "Alpha—Edition"],
    ["smart double quotes", "“Alpha”"],
    ["an injection-keyword collision", "System Design Interview"],
    ["a long legitimate title", "A Practical Guide to Designing Data-Intensive Applications at Scale"],
  ])("keeps executable comparison branches when the label contains %s", async (_case, label) => {
    const result = await rewriteComparison([
      { label, semanticQuery: "alpha details", lexicalQuery: "alpha" },
      { label: "Beta", semanticQuery: "beta details", lexicalQuery: "beta" },
    ]);

    expect(result.status).toBe("applied");
    expect(result.retrievalSubqueries).toHaveLength(2);
    expect(result.retrievalSubqueries?.[0]).toMatchObject({
      id: "subquery_1",
      label: "Subquery 1",
      semanticQuery: "alpha details",
      lexicalQuery: "alpha",
    });
  });

  it.each([
    ["semantic", "", "alpha", "alpha", "alpha"],
    ["lexical", "alpha details", "", "alpha details", "alpha details"],
    ["semantic exact-phrase", "", '"alpha beta"', "alpha beta", '"alpha beta"'],
  ])("uses the non-empty execution query when the %s query is empty", async (
    _field,
    semanticQuery,
    lexicalQuery,
    expectedSemanticQuery,
    expectedLexicalQuery,
  ) => {
    const result = await rewriteComparison([
      { label: "Alpha", semanticQuery, lexicalQuery },
      { label: "Beta", semanticQuery: "beta details", lexicalQuery: "beta" },
    ]);

    expect(result.status).toBe("applied");
    expect(result.retrievalSubqueries).toHaveLength(2);
    expect(result.retrievalSubqueries?.[0]).toMatchObject({
      semanticQuery: expectedSemanticQuery,
      lexicalQuery: expectedLexicalQuery,
    });
  });

  it("still discards a branch when both execution queries are empty", async () => {
    const result = await rewriteComparison([
      { label: "Alpha", semanticQuery: "alpha details", lexicalQuery: "alpha" },
      { label: "Beta", semanticQuery: "   ", lexicalQuery: "\t" },
      { label: "Gamma", semanticQuery: "gamma details", lexicalQuery: "gamma" },
    ], "compare alpha, beta, and gamma");

    expect(result.retrievalSubqueries?.map((subquery) => subquery.label)).toEqual(["Alpha", "Gamma"]);
    expect(result.retrievalSubqueries?.every((subquery) => subquery.semanticQuery && subquery.lexicalQuery)).toBe(true);
  });

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
      '"forgot password"',
      '"reset token"',
      '"magic link"',
    ]);
    expect(result.retrievalSubqueries?.every((subquery) => subquery.semanticQuery === "how do users recover account access?")).toBe(true);
  });

  it("does not let derived lexical alternatives bypass the first-turn lexical guard", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "who are these teachers?",
          semanticQuery: "who are these teachers?",
          lexicalQuery: '"Narayani" OR "Swami Kriyananda"',
          responseLanguagePolicy: "match_user_question",
          turnKind: "fresh_subject",
          proposedActiveSubject: "teachers",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.91,
        };
      },
    });

    const result = await service.rewrite({
      query: "who are these teachers?",
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
      enabled: true,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "Prefer exact aliases as alternatives.",
    });

    expect(result.status).toBe("fallback");
    expect(result.retrievalSubqueries).toBeUndefined();
    expect(result.lexicalQuery).toBe("who are these teachers?");
  });

  it("does not split original user text containing OR when lexical rewrite falls back", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "What does OR mean?",
          semanticQuery: "What does OR mean?",
          lexicalQuery: "What does OR mean?",
          responseLanguagePolicy: "match_user_question",
          turnKind: "fresh_subject",
          proposedActiveSubject: "OR",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.91,
        };
      },
    });

    const result = await service.rewrite({
      query: "What does OR mean?",
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
      enabled: true,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "",
    });

    expect(result.status).toBe("fallback");
    expect(result.retrievalSubqueries).toBeUndefined();
  });

  it("attaches internal lexical plans only to derived lexical alternatives", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "account recovery",
          semanticQuery: "account recovery",
          lexicalQuery: '"forgot password" OR "reset token"',
          responseLanguagePolicy: "match_user_question",
          turnKind: "fresh_subject",
          proposedActiveSubject: "account recovery",
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
            content: "We call password recovery reset tokens.",
            createdAt: new Date(),
          },
        ],
        truncated: false,
        selectionReason: "full-history",
      },
      enabled: true,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "",
    });

    expect(result.retrievalSubqueries?.map((subquery) => subquery.lexicalPlan?.options[0]?.lexicalQuery)).toEqual([
      '"forgot password"',
      '"reset token"',
    ]);
  });

  it("preserves exact phrase quotes in model-provided lexical subqueries", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "account recovery",
          semanticQuery: "account recovery",
          lexicalQuery: "account recovery",
          responseLanguagePolicy: "match_user_question",
          retrievalSubqueries: [
            {
              id: "",
              label: "Reset token",
              semanticQuery: "account recovery",
              lexicalQuery: '"reset token"',
              responseLanguagePolicy: "match_user_question",
            },
            {
              id: "",
              label: "Magic link",
              semanticQuery: "account recovery",
              lexicalQuery: '"magic link"',
              responseLanguagePolicy: "match_user_question",
            },
          ],
          turnKind: "fresh_subject",
          proposedActiveSubject: "account recovery",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.91,
        };
      },
    });

    const result = await service.rewrite({
      query: "how do I recover account access?",
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
      enabled: true,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "Prefer exact aliases as alternatives.",
    });

    expect(result.status).toBe("applied");
    expect(result.retrievalSubqueries?.map((subquery) => subquery.lexicalQuery)).toEqual([
      '"reset token"',
      '"magic link"',
    ]);
  });

  it("uses the resolved definition subject as the lexical query without adding a second subquery", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "definition of Arya Cheng",
          semanticQuery: "definition of Arya Cheng",
          lexicalQuery: "who is Arya Cheng?",
          responseLanguagePolicy: "match_user_question",
          turnKind: "fresh_subject",
          queryShape: "definition_lookup",
          proposedActiveSubject: "Arya Cheng",
          relatedEntities: ["Arya Cheng"],
          unresolved: true,
          confidence: 0,
        };
      },
    });

    const result = await service.rewrite({
      query: "who is Arya Cheng?",
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
      enabled: true,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "",
    });

    expect(result.status).toBe("applied");
    expect(result.lexicalQuery).toBe("Arya Cheng");
    expect(result.retrievalSubqueries).toBeUndefined();
    expect(result.structuredResult?.lexicalQuery).toBe("Arya Cheng");
    expect(result.structuredResult?.retrievalSubqueries).toBeUndefined();
  });

  it("uses the resolved definition subject even when the model leaves top-level queries unchanged", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "Who is Arya Cheng?",
          semanticQuery: "Who is Arya Cheng?",
          lexicalQuery: "Who is Arya Cheng?",
          responseLanguagePolicy: "match_user_question",
          turnKind: "fresh_subject",
          queryShape: "definition_lookup",
          proposedActiveSubject: "Arya Cheng",
          relatedEntities: ["Arya Cheng"],
          unresolved: false,
          confidence: 0.91,
        };
      },
    });

    const result = await service.rewrite({
      query: "Who is Arya Cheng?",
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
      enabled: true,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "",
    });

    expect(result.status).toBe("applied");
    expect(result.semanticQuery).toBe("Who is Arya Cheng?");
    expect(result.lexicalQuery).toBe("Arya Cheng");
    expect(result.retrievalSubqueries).toBeUndefined();
  });
});

describe("query rewrite temporal mode propagation", () => {
  it("preserves the gateway's temporalQueryMode in the structured result", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "upcoming events schedule",
          semanticQuery: "upcoming events schedule",
          lexicalQuery: "events schedule",
          responseLanguagePolicy: "match_user_question",
          queryShape: "event_date_lookup",
          temporalQueryMode: "listing",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.94,
        };
      },
    });

    const result = await service.rewrite({
      query: "what are the next events?",
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
      enabled: true,
    });

    // The temporal candidate lookup, upcoming boost, and deterministic sort all
    // gate on this field; dropping it during normalization silently disables
    // every temporal retrieval behavior.
    expect(result.structuredResult?.queryShape).toBe("event_date_lookup");
    expect(result.structuredResult?.temporalQueryMode).toBe("listing");
  });

  it("normalizes unknown temporal modes to none", async () => {
    const service = new QueryRewriteService({
      async rewrite() {
        return {
          rewrittenQuery: "next events",
          semanticQuery: "next events",
          lexicalQuery: "next events",
          responseLanguagePolicy: "match_user_question",
          queryShape: "event_date_lookup",
          temporalQueryMode: "whenever" as never,
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        };
      },
    });

    const result = await service.rewrite({
      query: "events",
      contextWindow: { selectedMessages: [], truncated: false, selectionReason: "no-history" },
      enabled: true,
    });

    expect(result.structuredResult?.temporalQueryMode).toBe("none");
  });
});
