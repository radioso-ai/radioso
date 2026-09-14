import { describe, expect, it, vi } from "vitest";

import { ChatAnswerCoverageAssessorFactory } from "../../../src/modules/chat/services/chatAnswerCoverageAssessor.js";
import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";

const session = (route: "direct" | "retrieval"): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Agent", chatModelOverride: null },
  conversation: { id: "conversation-1" },
  history: [{ id: "earlier", role: "user", content: "I mean the visiting teacher", workspaceId: "workspace-1", conversationId: "conversation-1", createdAt: new Date() }],
  retrieval: {
    contexts: [{ chunkId: "chunk-1", title: "Attendance policy", content: "A".repeat(2_000) }],
  },
  turnRoute: route,
  userMessage: { id: "user-1", role: "user", content: "Can I attend for one day?", workspaceId: "workspace-1", conversationId: "conversation-1", createdAt: new Date() },
  effectiveQuery: "Can I attend one day with the visiting teacher?",
} as unknown as PreparedSession);

describe("ChatAnswerCoverageAssessorFactory", () => {
  it("assesses the exact admitted retrieval context and persists request provenance before composition", async () => {
    const gateway = {
      answer: vi.fn(async () => JSON.stringify({
        classification: "unanswered_insufficient_evidence", requestFocus: "One-day attendance permission",
      })),
      async *streamAnswer() {},
    };
    const repository = {
      saveAssessment: vi.fn(async () => ({
        id: "assessment-1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        requestMessageId: "user-1",
        originatingTurnId: "user-1",
        contextualizedRequest: "Can I attend one day with the visiting teacher?",
        availability: "assessed" as const,
        coverage: "unanswered" as const,
        reason: "insufficient_evidence" as const,
        schemaVersion: 1,
        assessedAt: new Date(),
        createdAt: new Date(),
      })),
      findByRequestMessageId: vi.fn(async () => null),
      listByRequestMessageIds: vi.fn(async () => new Map()),
      markInteractionEvaluated: vi.fn(async () => {}),
      recordReaction: vi.fn(),
      listByAssessmentId: vi.fn(async () => []),
      listByAssessmentIds: vi.fn(async () => new Map()),
    };
    const current = session("retrieval");
    const assessor = new ChatAnswerCoverageAssessorFactory(gateway, repository).create({ getSession: () => current });

    await expect(assessor.assess({ turn: {
      inputEvent: { content: "Can I attend for one day?" },
      stagedContext: [],
    } as never })).resolves.toMatchObject({ availability: "assessed", coverage: "unanswered" });

    expect(gateway.answer).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("A".repeat(2_000)),
    }));
    expect(repository.saveAssessment).toHaveBeenCalledWith(expect.objectContaining({
      requestMessageId: "user-1",
      originatingTurnId: "user-1",
      contextualizedRequest: expect.stringContaining("visiting teacher"),
    }));
  });

  it("does not produce a semantic trigger for a direct turn", async () => {
    const gateway = { answer: vi.fn(), async *streamAnswer() {} };
    const assessor = new ChatAnswerCoverageAssessorFactory(gateway).create({ getSession: () => session("direct") });

    await expect(assessor.assess({ turn: { inputEvent: { content: "Hello" }, stagedContext: [] } as never }))
      .resolves.toEqual({ availability: "not_recorded" });
    expect(gateway.answer).not.toHaveBeenCalled();
  });
});
