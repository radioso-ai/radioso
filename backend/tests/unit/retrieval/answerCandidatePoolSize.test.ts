import { describe, expect, it } from "vitest";

import {
  answerCandidatePoolSize,
  answerContextTopK,
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

describe("answerContextTopK", () => {
  it("holds the final context target for an ordinary answer", () => {
    expect(answerContextTopK({})).toBe(finalContextTopK);
  });

  it("holds the final context target when a requested range found only a few event passages", () => {
    expect(answerContextTopK({ requestedRangePassageCount: 2 })).toBe(finalContextTopK);
    expect(answerContextTopK({ requestedRangePassageCount: finalContextTopK })).toBe(finalContextTopK);
  });

  it("holds one passage per event passage a requested range found, between the two limits", () => {
    expect(answerContextTopK({ requestedRangePassageCount: 16 })).toBe(16);
  });

  it("holds at most the date listing limit however many event passages the range found", () => {
    expect(answerContextTopK({ requestedRangePassageCount: 45 })).toBe(dateRangeListingContextTopK);
    expect(dateRangeListingContextTopK).toBeGreaterThan(finalContextTopK);
  });

  it("fits a date listing's passages in the prompt token budget even at full passage size", () => {
    // The prompt selector estimates a passage at one token per four characters.
    const fullPassageTokens = Math.ceil(RETRIEVAL_BEHAVIOR.promptContextMaxCharsPerContext / 4);
    expect(dateRangeListingContextTopK * fullPassageTokens)
      .toBeLessThanOrEqual(RETRIEVAL_BEHAVIOR.promptContextTokenBudget);
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
