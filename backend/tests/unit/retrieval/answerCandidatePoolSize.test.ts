import { describe, expect, it } from "vitest";

import { answerCandidatePoolSize } from "../../../src/modules/retrieval/domain/answerCandidatePool.js";
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
