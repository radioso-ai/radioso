import { describe, expect, it, vi } from "vitest";

import type {
  AnswerCoverageHistoryReader,
} from "../../../src/modules/chat/services/answerCoverageHistoryProvider.js";
import { loadAnswerCoverageHistoryProjection } from "../../../src/modules/chat/services/answerCoverageHistoryProvider.js";
import type {
  AnswerCoverageReactionTrace,
  AnswerCoverageRecord,
} from "../../../src/modules/answerCoverage/public.js";

const makeRecord = (overrides: Partial<AnswerCoverageRecord> = {}): AnswerCoverageRecord => ({
  id: "assessment-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  requestMessageId: "request-1",
  originatingTurnId: "request-1",
  contextualizedRequest: "Where is my order?",
  availability: "assessed",
  coverage: "unanswered",
  reason: "insufficient_evidence",
  schemaVersion: 1,
  assessedAt: new Date("2026-09-09T10:00:00.000Z"),
  createdAt: new Date("2026-09-09T10:00:00.000Z"),
  ...overrides,
});

describe("loadAnswerCoverageHistoryProjection", () => {
  it("does not expose provisional assessments without a committed assistant turn", async () => {
    const provisional = makeRecord({ id: "assessment-provisional", requestMessageId: "request-provisional" });
    const confirmed = makeRecord({
      id: "assessment-confirmed",
      requestMessageId: "request-confirmed",
      assistantMessageId: "assistant-1",
    });
    const listByAssessmentIds = vi.fn(async ({ assessmentIds }: { assessmentIds: readonly string[] }) =>
      new Map<string, AnswerCoverageReactionTrace[]>(assessmentIds.map((assessmentId) => [assessmentId, []])));
    const reader: AnswerCoverageHistoryReader = {
      listByRequestMessageIds: vi.fn(async () => new Map([
        [provisional.requestMessageId, provisional],
        [confirmed.requestMessageId, confirmed],
      ])),
      listByAssessmentIds,
    };

    const projection = await loadAnswerCoverageHistoryProjection(
      reader,
      "workspace-1",
      [provisional.requestMessageId, confirmed.requestMessageId],
    );

    expect(projection.has(provisional.requestMessageId)).toBe(false);
    expect(projection.get(confirmed.requestMessageId)?.assessment).toMatchObject({
      availability: "assessed",
      coverage: "unanswered",
    });
    expect(listByAssessmentIds).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      assessmentIds: [confirmed.id],
    });
  });
});
