import { describe, expect, it, vi } from "vitest";

import { DeferredCoverageReactionRecorder } from "../../src/modules/chat/services/answerCoverage/deferredCoverageReactionRecorder.js";

describe("DeferredCoverageReactionRecorder", () => {
  const reaction = {
    assessment: { availability: "assessed" as const, coverage: "unanswered" as const, reason: "insufficient_evidence" as const, schemaVersion: 1 },
    evaluationState: "evaluated" as const,
    reactions: [{ reactionKey: "routine:r_1:eligible", routineId: "r_1", routineExecutionId: "run_1", decision: "activated" as const, reasonCode: "coverage_criteria_activated" }],
  };

  it("does not publish an activation reaction until the caller commits the completed assistant turn", async () => {
    const inner = { record: vi.fn(async () => {}) };
    const deferred = new DeferredCoverageReactionRecorder(inner);
    await deferred.record(reaction);
    expect(inner.record).not.toHaveBeenCalled();
    await deferred.commit();
    expect(inner.record).toHaveBeenCalledWith(reaction);
  });

  it("drops an uncommitted activation reaction when completion is abandoned", async () => {
    const inner = { record: vi.fn(async () => {}) };
    const deferred = new DeferredCoverageReactionRecorder(inner);
    await deferred.record(reaction);
    // No commit models lifecycle rollback/cancellation before assistant persistence.
    expect(inner.record).not.toHaveBeenCalled();
  });
});
