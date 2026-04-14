import { describe, expect, it } from "vitest";

import { RetrievalInfoPresenter } from "../../src/modules/retrieval/services/retrievalInfoPresenter.js";

describe("hybrid retrieval info", () => {
  it("shapes bounded retrieval information from execution diagnostics", () => {
    const presenter = new RetrievalInfoPresenter();

    const result = presenter.present({
      rewriteStatus: "applied",
      rerankStatus: "applied",
      originalCandidateCount: 4,
      rewrittenCandidateCount: 2,
      lexicalCandidateCount: 3,
      normalizedCandidateCount: 5,
      finalContextCount: 3,
      candidateFallbackApplied: false,
      fallbackApplied: true,
      rewriteEligible: true,
      rewriteRan: true,
      materialDisagreement: false,
      continuityDecision: "reused",
      parsedQuery: {
        originalQuery: "retreats in Estonia",
        semanticQuery: "retreats",
        lexicalQuery: "retreats",
        constraints: [],
      },
      appliedConstraints: [],
    });

    expect(result).toEqual({
      parsedQuery: {
        originalQuery: "retreats in Estonia",
        semanticQuery: "retreats",
        lexicalQuery: "retreats",
        constraintSummary: [],
      },
      candidateCounts: {
        semantic: 6,
        lexical: 3,
        merged: 5,
        final: 3,
      },
      appliedConstraints: undefined,
      fallbackApplied: true,
      rerankStatus: "applied",
      rewrite: {
        status: "applied",
        eligible: true,
        ran: true,
        materialDisagreement: false,
        continuityDecision: "reused",
        rejectionReason: undefined,
        fallbackReason: undefined,
      },
    });
  });
});
