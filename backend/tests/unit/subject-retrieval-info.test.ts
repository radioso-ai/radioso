import { describe, expect, it } from "vitest";

import { RetrievalInfoPresenter } from "../../src/modules/retrieval/services/retrievalInfoPresenter.js";

describe("subject retrieval info", () => {
  it("includes continuity diagnostics in retrieval info", () => {
    const presenter = new RetrievalInfoPresenter();

    const result = presenter.present({
      rewriteStatus: "applied",
      rerankStatus: "applied",
      originalCandidateCount: 3,
      rewrittenCandidateCount: 2,
      lexicalCandidateCount: 0,
      normalizedCandidateCount: 4,
      finalContextCount: 2,
      candidateFallbackApplied: false,
      fallbackApplied: false,
      continuity: {
        subjectReuseOutcome: "reused",
        winningSubject: {
          canonicalLabel: "Narayani",
          normalizedKey: "narayani",
          aliases: ["Narayani Anaya"],
        },
        runnerUpSubject: null,
        rawPathWinningSubject: {
          canonicalLabel: "Narayani",
          normalizedKey: "narayani",
          aliases: [],
        },
        biasedPathWinningSubject: {
          canonicalLabel: "Narayani",
          normalizedKey: "narayani",
          aliases: [],
        },
        supportCount: 2,
        scoreMass: 1.82,
        winnerMargin: 1.31,
        agreementAcrossPaths: true,
        disagreementDetected: false,
      },
    });

    expect(result.continuity).toEqual({
      outcome: "reused",
      subject: "Narayani",
      normalizedSubject: "narayani",
      supportCount: 2,
      scoreMass: 1.82,
      winnerMargin: 1.31,
      agreementAcrossPaths: true,
      disagreementDetected: false,
    });
  });
});
