import { describe, expect, it } from "vitest";

import {
  answerCandidatePoolSize,
  dateRangeLookupDepth,
} from "../../../src/modules/retrieval/domain/answerCandidatePool.js";
import { RETRIEVAL_BEHAVIOR } from "../../../src/shared/domain/behaviorConfig.js";

const { finalContextTopK } = RETRIEVAL_BEHAVIOR;
const { dateRangeListingContextTopK } = RETRIEVAL_BEHAVIOR.temporal;

describe("answerCandidatePoolSize", () => {
  it("raises a rerankTopK below the final context floor up to the floor", () => {
    expect(answerCandidatePoolSize(5)).toBe(finalContextTopK);
  });

  it("keeps a rerankTopK between the floor and the candidate limit as-is", () => {
    expect(answerCandidatePoolSize(30)).toBe(30);
  });

  it("caps a rerankTopK above the candidate limit at the candidate limit", () => {
    expect(answerCandidatePoolSize(80)).toBe(RETRIEVAL_BEHAVIOR.rerank.candidateLimit);
  });
});

describe("date listing passage limit", () => {
  it("fits a date listing's passages in the prompt token budget even at full passage size", () => {
    // The prompt selector estimates a passage at one token per four characters.
    const fullPassageTokens = Math.ceil(RETRIEVAL_BEHAVIOR.promptContextMaxCharsPerContext / 4);
    expect(dateRangeListingContextTopK * fullPassageTokens)
      .toBeLessThanOrEqual(RETRIEVAL_BEHAVIOR.promptContextTokenBudget);
    expect(dateRangeListingContextTopK).toBeGreaterThan(finalContextTopK);
  });
});

describe("dateRangeLookupDepth", () => {
  it("fetches a busy week of range passages, and never fewer than a raised answer pool can use", () => {
    expect(RETRIEVAL_BEHAVIOR.temporal.dateRangeLookupDepth).toBe(40);
    expect(dateRangeLookupDepth(5)).toBe(40);
    expect(dateRangeLookupDepth(45)).toBe(45);
    expect(dateRangeLookupDepth(80)).toBe(RETRIEVAL_BEHAVIOR.rerank.candidateLimit);
  });
});
