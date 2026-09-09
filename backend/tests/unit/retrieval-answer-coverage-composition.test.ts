import { describe, expect, it, vi } from "vitest";

import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { RetrievalAnswerComposer } from "../../src/modules/chat/services/retrievalTurnSkill.js";
import type { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import type { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";

const session = (): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Agent" },
  conversation: { id: "conversation-1", workspaceId: "workspace-1" },
  history: [],
  userMessage: { id: "message-1", conversationId: "conversation-1", workspaceId: "workspace-1", role: "user", content: "Can I attend for one day?", createdAt: new Date() },
  effectiveQuery: "Can I attend for one day?",
  turnRoute: "retrieval",
  retrieval: {
    systemPrompt: "Answer from Results only.",
    prompt: "Result 1: The course meets on Saturday.",
    diagnostics: {},
    contexts: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Course schedule", content: "The course meets on Saturday." }],
    responseSettings: { suggestedQuestionsEnabled: false, suggestedQuestionsCount: 0 },
  },
  answerCoverage: {
    availability: "assessed",
    coverage: "unanswered",
    reason: "insufficient_evidence",
    unresolvedRequest: "Whether one-day attendance is permitted",
    schemaVersion: 1,
  },
  stagedContext: [],
  resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
  turnTrace: { traceId: "trace-1", startedAt: new Date().toISOString(), stages: [] },
} as unknown as PreparedSession);

describe("RetrievalAnswerComposer coverage composition", () => {
  it("passes the assessment into the real final-answer call and does not leave its unresolved result green", async () => {
    const gateway = {
      answer: vi.fn(async () => JSON.stringify({
        answer: "The course meets on Saturday[[1]], but I cannot confirm one-day attendance[[?]].",
        v: 2,
        outcome: "answer",
        claims: [[1], []],
        suggestions: [],
        grounding: "degraded",
      })),
    } as unknown as ChatGateway;
    const composer = new RetrievalAnswerComposer(
      {
        buildChatWorkspaceContext: () => ({ workspaceId: "workspace-1" }),
        buildChatUsageContext: () => ({ surface: "assistant", operation: "answer" }),
        buildPromptWithContext: (prompt: string) => prompt,
      } as unknown as ChatAnswerSupport,
      gateway,
      new ChatAnswerPresenter({ apply: () => ({ suggestions: [] }) } as unknown as AssistantSuggestionExpansionService),
      {} as never,
    );

    const result = await composer.composeAnswer(session(), "Can I attend for one day?", undefined, undefined);

    expect(gateway.answer).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining("Coverage-aware response"),
      prompt: expect.stringContaining('"coverage":"unanswered"'),
    }));
    expect(result.answerOutcome).toBe("coverage_unanswered");
  });
});
