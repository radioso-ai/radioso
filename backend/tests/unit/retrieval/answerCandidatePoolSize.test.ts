import { describe, expect, it } from "vitest";

import { answerCandidatePoolSize, answerContextTopK } from "../../../src/modules/retrieval/domain/answerCandidatePool.js";
import { RETRIEVAL_BEHAVIOR } from "../../../src/shared/domain/behaviorConfig.js";

describe("answerCandidatePoolSize", () => {
  it("raises a rerankTopK below the final context floor up to the floor", () => {
    expect(answerCandidatePoolSize(5)).toBe(RETRIEVAL_BEHAVIOR.finalContextTopK);
  });

  it("keeps a rerankTopK between the floor and the candidate limit as-is", () => {
    expect(answerCandidatePoolSize(30)).toBe(30);
  });

  it("caps a rerankTopK above the candidate limit at the candidate limit", () => {
    expect(answerCandidatePoolSize(80)).toBe(RETRIEVAL_BEHAVIOR.rerank.candidateLimit);
  });
});

describe("answerContextTopK", () => {
  it("holds the final context target for an ordinary answer", () => {
    expect(answerContextTopK({ dateRangeListing: false })).toBe(RETRIEVAL_BEHAVIOR.finalContextTopK);
  });

  it("holds more passages for a list of events in a requested date range", () => {
    expect(answerContextTopK({ dateRangeListing: true })).toBe(RETRIEVAL_BEHAVIOR.temporal.dateRangeListingContextTopK);
    expect(RETRIEVAL_BEHAVIOR.temporal.dateRangeListingContextTopK).toBeGreaterThan(RETRIEVAL_BEHAVIOR.finalContextTopK);
  });

  it("fits a date listing's passages in the prompt token budget even at full passage size", () => {
    // The prompt selector estimates a passage at one token per four characters.
    const fullPassageTokens = Math.ceil(RETRIEVAL_BEHAVIOR.promptContextMaxCharsPerContext / 4);
    expect(RETRIEVAL_BEHAVIOR.temporal.dateRangeListingContextTopK * fullPassageTokens)
      .toBeLessThanOrEqual(RETRIEVAL_BEHAVIOR.promptContextTokenBudget);
  });

  it("raises the answer pool to a date listing's context target", () => {
    expect(answerCandidatePoolSize(5, answerContextTopK({ dateRangeListing: true })))
      .toBe(RETRIEVAL_BEHAVIOR.temporal.dateRangeListingContextTopK);
    expect(answerCandidatePoolSize(80, answerContextTopK({ dateRangeListing: true })))
      .toBe(RETRIEVAL_BEHAVIOR.rerank.candidateLimit);
  });
});
