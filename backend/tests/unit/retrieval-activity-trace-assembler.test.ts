import { describe, expect, it } from "vitest";

import { ActivityTraceAssembler } from "../../src/modules/retrieval/services/retrievalActivityTraceAssembler.js";
import type { ActivityTraceAssemblerInput } from "../../src/modules/retrieval/services/retrievalActivityTraceAssembler.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { activityTraceInputFixture } from "../support/retrievalTraceFixtures.js";

const baseInput = (): ActivityTraceAssemblerInput => activityTraceInputFixture();

describe("activity trace assembler", () => {
  it("emits branch stages for decomposed retrieval subqueries", () => {
    const assembler = new ActivityTraceAssembler();

    const trace = assembler.assemble(baseInput());

    expect(trace.stages.filter((stage) => stage.kind === "semantic_rewritten")).toHaveLength(2);
    expect(trace.stages.filter((stage) => stage.kind === "lexical")).toHaveLength(2);
    expect(trace.stages).toContainEqual(
      expect.objectContaining({
        stageId: "trigger_analysis",
        kind: "trigger_analysis",
        status: "applied",
      }),
    );
    expect(trace.summary?.retrievalSubqueries).toEqual([
      expect.objectContaining({ label: "Narayani", lexicalQuery: "narayani", responseLanguagePolicy: "match_user_question" }),
      expect.objectContaining({ label: "Arudra", lexicalQuery: "arudra", responseLanguagePolicy: "match_user_question" }),
    ]);
    expect(trace.summary?.responseLanguagePolicy).toBe("match_user_question");
    expect(trace.summary?.triggerAnalysis).toMatchObject({
      matchedRuleIds: ["events-only"],
      matchCount: 1,
    });
    expect(trace.summary?.triggerBackoff).toMatchObject({
      applied: true,
      relaxedRuleIds: ["events-only"],
    });
    expect(trace.summary?.appliedConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signalKey: "metadata.category",
          outcome: "relaxed",
          summary: "category equals event",
        }),
      ]),
    );
  });

  it("collapses branches that share a semantic query into a single semantic stage", () => {
    const assembler = new ActivityTraceAssembler();
    const input = baseInput();
    // Lexical-alternative split: both branches share one semantic query but run
    // distinct lexical searches (the common "OR" case).
    const sharedSemantic = "how to contact support";
    input.prompt.retrievalBranches = [
      {
        subqueryId: "subquery_1",
        label: "email",
        semanticQuery: sharedSemantic,
        lexicalQuery: "email",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: true,
        semanticContexts: [
          { chunkId: "s1", documentId: "d1", title: "Contact", content: "contact", similarity: 0.9 },
        ],
        lexicalContexts: [
          { chunkId: "l1", documentId: "d1", title: "Email", content: "email", similarity: 1 },
        ],
      },
      {
        subqueryId: "subquery_2",
        label: "phone",
        semanticQuery: sharedSemantic,
        lexicalQuery: "phone",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: true,
        // Same shared semantic search → identical contexts as the first branch.
        semanticContexts: [
          { chunkId: "s1", documentId: "d1", title: "Contact", content: "contact", similarity: 0.9 },
        ],
        lexicalContexts: [
          { chunkId: "l2", documentId: "d1", title: "Phone", content: "phone", similarity: 1 },
        ],
      },
    ];

    const trace = assembler.assemble(input);

    const semanticStages = trace.stages.filter((stage) => stage.kind === "semantic_rewritten");
    expect(semanticStages).toHaveLength(1);
    expect(semanticStages[0]?.stageId).toBe("semantic_rewritten");
    expect(semanticStages[0]?.label).toBe("Semantic retrieval");
    // Lexical fan-out is preserved.
    expect(trace.stages.filter((stage) => stage.kind === "lexical")).toHaveLength(2);
  });

  it("omits a semantic stage for lexical-only (capped) branches", () => {
    const assembler = new ActivityTraceAssembler();
    const input = baseInput();
    // Third branch fell outside the per-turn semantic cap: lexical-only.
    input.prompt.retrievalBranches = [
      {
        subqueryId: "subquery_1",
        label: "alpha",
        semanticQuery: "who is alpha",
        lexicalQuery: "alpha",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: true,
        semanticContexts: [
          { chunkId: "s1", documentId: "d1", title: "Alpha", content: "alpha", similarity: 0.9 },
        ],
        lexicalContexts: [
          { chunkId: "l1", documentId: "d1", title: "Alpha", content: "alpha", similarity: 1 },
        ],
      },
      {
        subqueryId: "subquery_2",
        label: "beta",
        semanticQuery: "who is beta",
        lexicalQuery: "beta",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: true,
        semanticContexts: [
          { chunkId: "s2", documentId: "d2", title: "Beta", content: "beta", similarity: 0.88 },
        ],
        lexicalContexts: [
          { chunkId: "l2", documentId: "d2", title: "Beta", content: "beta", similarity: 1 },
        ],
      },
      {
        subqueryId: "subquery_3",
        label: "gamma",
        semanticQuery: "who is gamma",
        lexicalQuery: "gamma",
        responseLanguagePolicy: "match_user_question",
        source: "rewritten",
        semanticSearched: false,
        semanticContexts: [],
        lexicalContexts: [
          { chunkId: "l3", documentId: "d3", title: "Gamma", content: "gamma", similarity: 1 },
        ],
      },
    ];

    const trace = assembler.assemble(input);

    // Only the two searched semantic queries produce semantic stages...
    expect(trace.stages.filter((stage) => stage.kind === "semantic_rewritten")).toHaveLength(2);
    // ...but every branch still contributes a lexical stage.
    expect(trace.stages.filter((stage) => stage.kind === "lexical")).toHaveLength(3);
  });

  it("labels normalized fused and per-source scores in candidate trace output", () => {
    const assembler = new ActivityTraceAssembler();
    const input = baseInput();
    const candidate: RetrievedCandidate = {
      chunkId: "n1",
      documentId: "d1",
      title: "Narayani",
      content: "Narayani profile",
      similarity: 0.93,
      fusedScore: 0.93,
      retrievalSources: ["semantic_rewritten", "lexical"],
      retrievalText: "Narayani profile",
      semanticScore: 0.9,
      lexicalScore: 1,
      lexicalRankScore: 0.4,
      semanticRank: 1,
      lexicalRank: 1,
    };
    input.prompt.normalizedCandidates = [candidate];
    input.prompt.mergedCandidates = [candidate];
    input.prompt.scoredCandidates = [candidate];

    const trace = assembler.assemble(input);
    const preparation = trace.stages.find((stage) => stage.kind === "candidate_preparation");
    const outputs = preparation?.outputs as {
      topCandidates?: Array<Record<string, unknown>>;
    } | undefined;

    expect(outputs?.topCandidates?.[0]).toMatchObject({
      similarity: 0.93,
      fusedScore: 0.93,
      semanticScore: 0.9,
      lexicalScore: 1,
      lexicalRankScore: 0.4,
      semanticRank: 1,
      lexicalRank: 1,
    });
    for (const field of ["similarity", "fusedScore", "semanticScore", "lexicalScore"] as const) {
      expect(outputs?.topCandidates?.[0]?.[field]).toEqual(expect.any(Number));
      expect(outputs?.topCandidates?.[0]?.[field]).toBeGreaterThanOrEqual(0);
      expect(outputs?.topCandidates?.[0]?.[field]).toBeLessThanOrEqual(1);
    }
  });
});
