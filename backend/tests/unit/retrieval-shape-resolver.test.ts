import { describe, expect, it } from "vitest";

import {
  buildRetrievalAnswerSkillDiagnostic,
  selectRetrievalAnswerShape,
  type RetrievalAnswerShapeSelection,
} from "../../src/modules/retrieval/services/retrievalShapeResolver.js";
import { validateSkillDiagnostic } from "../../src/modules/skills/public.js";

const expectSelection = (
  query: string,
  expected: Pick<RetrievalAnswerShapeSelection, "shapeName" | "queryShape">,
) => {
  const selection = selectRetrievalAnswerShape({
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
    selectionMode: expected.shapeName === "default_hybrid" ? "deterministic" : "probabilistic",
  });
  expect(selection.selectionReason.length).toBeGreaterThan(0);
};

describe("retrieval shape resolver", () => {
  it("selects definition lookup from structured query shape metadata", () => {
    expectSelection("BM25", {
      shapeName: "definition_lookup",
      queryShape: "definition_lookup",
    });
  });

  it("does not inspect English query text when structured metadata is absent", () => {
    const query = "What is a session cookie?";
    const selection = selectRetrievalAnswerShape({
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
      shapeName: "default_hybrid",
      queryShape: "general_grounding",
      selectionMode: "deterministic",
    });
  });

  it("supports multilingual definition lookup through structured metadata", () => {
    expectSelection("¿Qué significa BM25?", {
      shapeName: "definition_lookup",
      queryShape: "definition_lookup",
    });
  });

  it("selects event date lookup from structured query shape metadata", () => {
    expectSelection("kontserdi aeg", {
      shapeName: "event_date_lookup",
      queryShape: "event_date_lookup",
    });
  });

  it("selects policy answer from structured query shape metadata", () => {
    expectSelection("cancellation requirements", {
      shapeName: "policy_answer",
      queryShape: "policy_answer",
    });
  });

  it("selects exploratory summary from structured query shape metadata", () => {
    expectSelection("program comparison", {
      shapeName: "exploratory_summary",
      queryShape: "exploratory_summary",
    });
  });

  it("selects follow-up grounding when continuity metadata says the turn reused context", () => {
    const selection = selectRetrievalAnswerShape({
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
      shapeName: "follow_up_grounding",
      queryShape: "follow_up_grounding",
      selectionMode: "deterministic",
    });
  });

  it("does not select follow-up grounding when continuity was not updated", () => {
    const selection = selectRetrievalAnswerShape({
      query: "What about that?",
      continuityDecision: "rejected",
      historyMessageCount: 2,
      rewrittenQuery: {
        originalQuery: "What about that?",
        rewrittenQuery: "What about that?",
        effectiveQuery: "What about that?",
        semanticQuery: "What about that?",
        lexicalQuery: "What about that?",
        responseIntent: "retrieval",
        rewriteApplied: false,
        retrievalEligible: true,
        status: "rejected",
        confidence: 0.4,
        structuredResult: {
          rewrittenQuery: "What about that?",
          queryShape: "general_grounding",
          turnKind: "referential_followup",
          relatedEntities: [],
          unresolved: true,
          confidence: 0.4,
        },
      },
    });

    expect(selection).toMatchObject({
      shapeName: "default_hybrid",
      queryShape: "general_grounding",
      selectionMode: "deterministic",
    });
  });

  it("falls back to the default hybrid shape for uncertain queries", () => {
    const selection = selectRetrievalAnswerShape({
      query: "Narayani Arudra",
      continuityDecision: "unchanged",
    });

    expect(selection).toMatchObject({
      shapeName: "default_hybrid",
      queryShape: "general_grounding",
      selectionMode: "deterministic",
    });
  });

  it("resolves definition lookup into a context selection override", () => {
    const selection = selectRetrievalAnswerShape({
      query: "BM25",
      continuityDecision: "unchanged",
      rewrittenQuery: {
        originalQuery: "BM25",
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

    expect(selection.resolvedRun.resolvedSteps.find((step) => step.name === "context_selection")).toMatchObject({
      overrideApplied: true,
      clauses: {
        ranking: {
          rerankMode: "disabled",
          lexicalBias: "preferred",
        },
        finalContextLimit: "behavior_default",
      },
    });
    expect(selection.resolvedRun.resolvedSteps.find((step) => step.name === "prompt_assembly")).toMatchObject({
      overrideApplied: false,
      clauses: {
        citations: "settings_default",
      },
    });
  });

  it("builds a valid retrieval answer skill diagnostic", () => {
    const selection = selectRetrievalAnswerShape({
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
      shapeName: "definition_lookup",
      strategy: "definition_lookup",
      selectionMode: "probabilistic",
      callerSurface: "retrieval_api",
      outcome: "success",
      evidence: {
        queryShape: "definition_lookup",
        retrievalShape: "definition_lookup",
        retrievalStrategy: "definition_lookup",
      },
    });
  });
});
