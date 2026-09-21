import { describe, expect, it } from "vitest";

import { buildAgentReplyEnvelope } from "../../../src/modules/chat/services/agentReplyEnvelope.js";
import type { ChatAnswerCoverageAssessment } from "../../../src/modules/chat/contracts/answerCoverage.js";
import type { ChatRoutineTurnState } from "../../../src/modules/chat/contracts/routineTurnState.js";
import type { TurnTraceEnvelope } from "../../../src/modules/chat/services/turnTraceEnvelope.js";

const assessed: ChatAnswerCoverageAssessment = {
  availability: "assessed",
  coverage: "answered",
  reason: "sufficient_evidence",
  originatingTurnId: "request-1",
  originatingRequestId: "request-1",
};

describe("buildAgentReplyEnvelope", () => {
  it("forwards the recorded coverage, ownership, routine state, and trace id", () => {
    const routine: ChatRoutineTurnState = {
      name: "Book a demo",
      status: "waiting_for_input",
      pendingInput: [{ key: "email", type: "email", required: true }],
    };
    const envelope = buildAgentReplyEnvelope({
      conversationId: "conversation-1",
      answerCoverage: assessed,
      ownership: { state: "human_owned", suppressed: true },
      routine,
      turnTrace: { spine: { traceId: "trace-1" } } as TurnTraceEnvelope,
    });

    expect(envelope).toEqual({
      conversationId: "conversation-1",
      answerCoverage: assessed,
      ownership: { state: "human_owned", suppressed: true },
      routine,
      traceId: "trace-1",
    });
  });

  it("defaults ownership to ai_owned and unsuppressed when the turn recorded none", () => {
    const envelope = buildAgentReplyEnvelope({ conversationId: "conversation-1", answerCoverage: assessed });

    expect(envelope.ownership).toEqual({ state: "ai_owned", suppressed: false });
    expect(envelope).not.toHaveProperty("routine");
    expect(envelope).not.toHaveProperty("traceId");
  });

  it("marks coverage as not_recorded when no assessment reached the response", () => {
    const envelope = buildAgentReplyEnvelope({ conversationId: "conversation-1" });

    expect(envelope.answerCoverage).toMatchObject({ availability: "not_recorded" });
    expect(envelope.answerCoverage).not.toHaveProperty("coverage");
  });

  it("carries only the envelope core, never the answer text or citations", () => {
    const envelope = buildAgentReplyEnvelope({
      conversationId: "conversation-1",
      answerCoverage: assessed,
      answer: "Hello",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Doc" }],
    } as Parameters<typeof buildAgentReplyEnvelope>[0]);

    expect(Object.keys(envelope).sort()).toEqual(["answerCoverage", "conversationId", "ownership"]);
  });
});
