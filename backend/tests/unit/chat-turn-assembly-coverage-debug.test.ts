import { describe, expect, it } from "vitest";

import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import {
  applyCoverageAssessment,
  applyCoverageInteractionTrace,
} from "../../src/modules/chat/services/chatTurnAssembly.js";

const session = () => ({
  effectiveQuery: "Can I attend for one day?",
  userMessage: { id: "request-1", content: "Can I attend for one day?" },
}) as Pick<PreparedSession, "answerCoverage" | "answerCoverageDebug" | "answerCoverageInteractionTrace" | "effectiveQuery" | "userMessage">;

describe("coverage live debug projection", () => {
  it("starts a persisted assessed turn as not evaluated and replaces it only after reaction recording", () => {
    const current = session();
    applyCoverageAssessment(current, {
      assessment: {
        availability: "assessed",
        coverage: "unanswered",
        reason: "insufficient_evidence",
        unresolvedRequest: "One-day attendance permission",
        schemaVersion: 1,
      },
      record: {
        availability: "assessed",
        schemaVersion: 1,
        assessedAt: new Date(0),
        contextualizedRequest: "Can I attend for one day?",
        originatingTurnId: "request-1",
        requestMessageId: "request-1",
      } as never,
    });

    expect(current.answerCoverageInteractionTrace).toEqual({ state: "not_evaluated", decisions: [] });

    applyCoverageInteractionTrace(current, {
      assessment: current.answerCoverage as Extract<NonNullable<typeof current.answerCoverage>, { availability: "assessed" }>,
      evaluationState: "evaluated",
      reactions: [],
    });

    expect(current.answerCoverageInteractionTrace).toEqual({
      state: "evaluated",
      consumedAssessment: { coverage: "unanswered", reason: "insufficient_evidence" },
      decisions: [],
    });
  });
});
