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

  it("falls back to the whole measured group span when a branch carries no timing of its own", () => {
    // The fixture's branches carry no semanticSearch*/lexicalSearch* fields (as an
    // older code path or fixture would produce), so every branch stage falls back to
    // the group-level window rather than an even split of it — an even split would
    // report two 300ms searches for one 600ms window.
    const trace = new ActivityTraceAssembler().assemble(baseInput());

    for (const stage of trace.stages.filter((candidate) => candidate.kind === "semantic_rewritten")) {
      expect(stage).toMatchObject({ startedAt: "2026-04-12T14:14:16.030Z", durationMs: 600 });
    }
    for (const stage of trace.stages.filter((candidate) => candidate.kind === "lexical")) {
      expect(stage).toMatchObject({ startedAt: "2026-04-12T14:14:16.630Z", durationMs: 400 });
    }
  });

  it("uses a branch's own measured timing for its stage instead of the group window", () => {
    const assembler = new ActivityTraceAssembler();
    const input = baseInput();
    input.prompt.retrievalBranches = [
      {
        ...input.prompt.retrievalBranches[0],
        semanticSearchStartedAtMs: Date.parse("2026-04-12T14:14:16.100Z"),
        semanticSearchDurationMs: 50,
        lexicalSearchStartedAtMs: Date.parse("2026-04-12T14:14:16.200Z"),
        lexicalSearchDurationMs: 30,
      },
      {
        ...input.prompt.retrievalBranches[1],
        semanticSearchStartedAtMs: Date.parse("2026-04-12T14:14:16.400Z"),
        semanticSearchDurationMs: 500,
        lexicalSearchStartedAtMs: Date.parse("2026-04-12T14:14:16.900Z"),
        lexicalSearchDurationMs: 5,
      },
    ];

    const trace = assembler.assemble(input);

    const semanticStages = trace.stages.filter((stage) => stage.kind === "semantic_rewritten");
    const lexicalStages = trace.stages.filter((stage) => stage.kind === "lexical");
    expect(semanticStages[0]).toMatchObject({ startedAt: "2026-04-12T14:14:16.100Z", durationMs: 50 });
    expect(semanticStages[1]).toMatchObject({ startedAt: "2026-04-12T14:14:16.400Z", durationMs: 500 });
    expect(lexicalStages[0]).toMatchObject({ startedAt: "2026-04-12T14:14:16.200Z", durationMs: 30 });
    expect(lexicalStages[1]).toMatchObject({ startedAt: "2026-04-12T14:14:16.900Z", durationMs: 5 });
    // Distinct from each other and from the group window — the whole point of
    // per-branch timing: a 50ms branch must not read as the 600ms group window.
    expect(semanticStages[0]?.durationMs).not.toBe(semanticStages[1]?.durationMs);
    expect(semanticStages[0]?.durationMs).not.toBe(600);
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
        // Both branches share one semantic query, so they share this one search's timing.
        semanticSearchStartedAtMs: Date.parse("2026-04-12T14:14:16.500Z"),
        semanticSearchDurationMs: 120,
        lexicalSearchStartedAtMs: Date.parse("2026-04-12T14:14:16.600Z"),
        lexicalSearchDurationMs: 15,
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
        semanticSearchStartedAtMs: Date.parse("2026-04-12T14:14:16.500Z"),
        semanticSearchDurationMs: 120,
        lexicalSearchStartedAtMs: Date.parse("2026-04-12T14:14:16.700Z"),
        lexicalSearchDurationMs: 25,
      },
    ];

    const trace = assembler.assemble(input);

    const semanticStages = trace.stages.filter((stage) => stage.kind === "semantic_rewritten");
    expect(semanticStages).toHaveLength(1);
    expect(semanticStages[0]?.stageId).toBe("semantic_rewritten");
    expect(semanticStages[0]?.label).toBe("Semantic retrieval");
    expect(semanticStages[0]).toMatchObject({ startedAt: "2026-04-12T14:14:16.500Z", durationMs: 120 });
    // Lexical fan-out is preserved, each with its own branch timing.
    const lexicalStages = trace.stages.filter((stage) => stage.kind === "lexical");
    expect(lexicalStages).toHaveLength(2);
    expect(lexicalStages[0]).toMatchObject({ startedAt: "2026-04-12T14:14:16.600Z", durationMs: 15 });
    expect(lexicalStages[1]).toMatchObject({ startedAt: "2026-04-12T14:14:16.700Z", durationMs: 25 });
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

  it("surfaces turnKind and resolutionNote in the interpretation stage output", () => {
    const assembler = new ActivityTraceAssembler();
    const input = baseInput();
    input.prompt.rewrittenQuery.structuredResult = {
      resolutionNote: "the user is still asking about narayani, so keep that subject",
      rewrittenQuery: "who is narayani and arudra?",
      turnKind: "referential_followup",
      relatedEntities: [],
      unresolved: false,
      confidence: 0.9,
    };

    const trace = assembler.assemble(input);
    const interpretation = trace.stages.find((stage) => stage.kind === "query_interpretation");
    const outputs = interpretation?.outputs as {
      turnKind?: string | null;
      resolutionNote?: string | null;
    } | undefined;

    expect(outputs?.turnKind).toBe("referential_followup");
    expect(outputs?.resolutionNote).toBe("the user is still asking about narayani, so keep that subject");
  });

  it("omits resolutionNote from the interpretation stage output when the rewrite has none", () => {
    const assembler = new ActivityTraceAssembler();

    const trace = assembler.assemble(baseInput());
    const interpretation = trace.stages.find((stage) => stage.kind === "query_interpretation");
    const outputs = interpretation?.outputs as {
      resolutionNote?: string | null;
    } | undefined;

    expect(outputs?.resolutionNote).toBeNull();
  });
});
