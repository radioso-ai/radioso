import { describe, expect, it } from "vitest";

import {
  buildRetrievalAnswerSkillDiagnostic,
  selectRetrievalAnswerStrategy,
  type RetrievalAnswerStrategySelection,
} from "../../src/modules/retrieval/services/retrievalStrategySelector.js";
import { validateSkillDiagnostic } from "../../src/modules/skills/public.js";

const expectSelection = (
  query: string,
  expected: Pick<RetrievalAnswerStrategySelection, "strategy" | "queryShape">,
) => {
  const selection = selectRetrievalAnswerStrategy({
    query,
    rewrittenQuery: {
      originalQuery: query,
      rewrittenQuery: query,
      effectiveQuery: query,
      semanticQuery: query,
      lexicalQuery: query,
      responseIntent: "retrieval",
      rewriteApplied: false,
      retrievalEligible: true,
      status: "skipped",
      confidence: 1,
      structuredResult: {
        rewrittenQuery: query,
        queryShape: expected.queryShape,
        turnKind: "fresh_subject",
        relatedEntities: [],
        unresolved: false,
        confidence: 1,
      },
    },
    continuityDecision: "unchanged",
  });

  expect(selection).toMatchObject({
    ...expected,
    selectionMode: expected.strategy === "default_hybrid" ? "deterministic" : "probabilistic",
  });
  expect(selection.selectionReason.length).toBeGreaterThan(0);
};

describe("retrieval strategy selector", () => {
  it("selects definition lookup from structured query shape metadata", () => {
    expectSelection("BM25", {
      strategy: "definition_lookup",
      queryShape: "definition_lookup",
    });
  });

  it("does not inspect English query text when structured metadata is absent", () => {
    const query = "What is a session cookie?";
    const selection = selectRetrievalAnswerStrategy({
      query,
      rewrittenQuery: {
        originalQuery: query,
        rewrittenQuery: query,
        effectiveQuery: query,
        semanticQuery: query,
        lexicalQuery: query,
        responseIntent: "retrieval",
        rewriteApplied: false,
        retrievalEligible: true,
        status: "skipped",
        confidence: 1,
      },
      continuityDecision: "unchanged",
    });

    expect(selection).toMatchObject({
      strategy: "default_hybrid",
      queryShape: "general_grounding",
      selectionMode: "deterministic",
    });
  });

  it("supports multilingual definition lookup through structured metadata", () => {
    expectSelection("¿Qué significa BM25?", {
      strategy: "definition_lookup",
      queryShape: "definition_lookup",
    });
  });

  it("selects event date lookup from structured query shape metadata", () => {
    expectSelection("kontserdi aeg", {
      strategy: "event_date_lookup",
      queryShape: "event_date_lookup",
    });
  });

  it("selects policy answer from structured query shape metadata", () => {
    expectSelection("cancellation requirements", {
      strategy: "policy_answer",
      queryShape: "policy_answer",
    });
  });

  it("selects exploratory summary from structured query shape metadata", () => {
    expectSelection("program comparison", {
      strategy: "exploratory_summary",
      queryShape: "exploratory_summary",
    });
  });

  it("selects follow-up grounding when continuity metadata says the turn reused context", () => {
    const selection = selectRetrievalAnswerStrategy({
      query: "What about the next one?",
      continuityDecision: "updated",
      historyMessageCount: 2,
      rewrittenQuery: {
        originalQuery: "What about the next one?",
        rewrittenQuery: "When is the next workshop?",
        effectiveQuery: "When is the next workshop?",
        semanticQuery: "When is the next workshop?",
        lexicalQuery: "next workshop",
        responseIntent: "retrieval",
        rewriteApplied: true,
        retrievalEligible: true,
        status: "applied",
        confidence: 0.87,
        structuredResult: {
          rewrittenQuery: "When is the next workshop?",
          queryShape: "event_date_lookup",
          turnKind: "referential_followup",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.87,
        },
      },
    });

    expect(selection).toMatchObject({
      strategy: "follow_up_grounding",
      queryShape: "follow_up_grounding",
      selectionMode: "deterministic",
    });
  });

  it("falls back to the default hybrid strategy for uncertain queries", () => {
    const selection = selectRetrievalAnswerStrategy({
      query: "Narayani Arudra",
      continuityDecision: "unchanged",
    });

    expect(selection).toMatchObject({
      strategy: "default_hybrid",
      queryShape: "general_grounding",
      selectionMode: "deterministic",
    });
  });

  it("builds a valid retrieval answer skill diagnostic", () => {
    const selection = selectRetrievalAnswerStrategy({
      query: "What is BM25?",
      continuityDecision: "unchanged",
      rewrittenQuery: {
        originalQuery: "What is BM25?",
        rewrittenQuery: "BM25",
        effectiveQuery: "BM25",
        semanticQuery: "BM25",
        lexicalQuery: "BM25",
        responseIntent: "retrieval",
        rewriteApplied: true,
        retrievalEligible: true,
        status: "applied",
        confidence: 0.9,
        structuredResult: {
          rewrittenQuery: "BM25",
          queryShape: "definition_lookup",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        },
      },
    });

    const parsed = validateSkillDiagnostic(buildRetrievalAnswerSkillDiagnostic(selection, {
      callerSurface: "retrieval_api",
      rerankStatus: "skipped",
      candidateCounts: {
        semantic: 1,
        lexical: 2,
        merged: 2,
        final: 1,
      },
      fallbackApplied: false,
      supportStatus: "not_checked",
    }));

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : undefined).toMatchObject({
      skillName: "retrieval.answer",
      strategy: "definition_lookup",
      selectionMode: "probabilistic",
      callerSurface: "retrieval_api",
      outcome: "success",
      evidence: {
        queryShape: "definition_lookup",
        retrievalStrategy: "definition_lookup",
      },
    });
  });
});
