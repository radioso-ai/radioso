import { describe, expect, it, vi } from "vitest";

import { AnswerCoverageShadowAssessor } from "../../../src/modules/chat/services/answerCoverageShadowAssessor.js";
import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalCoverageVerdictSink } from "../../../src/modules/chat/contracts/answerCoverage.js";
import type { AnswerCoverageAssessment } from "../../../src/modules/answerCoverage/public.js";

const session = (overrides: Partial<PreparedSession> = {}): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Agent", chatModelOverride: null },
  conversation: { id: "conversation-1" },
  history: [],
  turnRoute: "retrieval",
  userMessage: { id: "request-1", role: "user", content: "Can I attend for one day?", workspaceId: "workspace-1", conversationId: "conversation-1", createdAt: new Date() },
  effectiveQuery: "Can I attend one day with the visiting teacher?",
  retrieval: { contexts: [{ chunkId: "chunk-1", title: "Attendance policy", content: "A".repeat(200) }] },
  ...overrides,
} as unknown as PreparedSession);

const headVerdict: AnswerCoverageAssessment = {
  availability: "assessed",
  coverage: "unanswered",
  reason: "insufficient_evidence",
  unresolvedRequest: "One-day attendance permission",
  schemaVersion: 1,
  producer: "answer_head",
};

const fakeSink = (decision: "proceed" | "yield_turn" = "proceed"): RetrievalCoverageVerdictSink & { report: ReturnType<typeof vi.fn> } => ({
  report: vi.fn(async () => ({ decision })),
});

const gatewayReturning = (classification: string) => ({
  answer: vi.fn(async () => JSON.stringify({ classification, requestFocus: "One-day attendance permission" })),
});

const metrics = () => ({ incrementCounter: vi.fn() });

// Give queued microtasks (the detached agreement recording) a turn to run
// before assertions read their side effects.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AnswerCoverageShadowAssessor", () => {
  it("starts the shadow call as soon as the sink is wrapped, not when report() is later called", () => {
    const gateway = gatewayReturning("unanswered_insufficient_evidence");
    const assessor = new AnswerCoverageShadowAssessor(gateway, true, metrics());
    const inner = fakeSink();

    assessor.wrapVerdictSink({ getSession: () => session() }, inner);

    expect(gateway.answer).toHaveBeenCalledOnce();
    expect(inner.report).not.toHaveBeenCalled();
  });

  it("records agreement when the shadow classifies the same as the head, and never changes the turn's decision", async () => {
    const gateway = gatewayReturning("unanswered_insufficient_evidence");
    const registry = metrics();
    const assessor = new AnswerCoverageShadowAssessor(gateway, true, registry);
    const inner = fakeSink("proceed");

    const wrapped = assessor.wrapVerdictSink({ getSession: () => session() }, inner);
    const result = await wrapped.report({ assessment: headVerdict });
    await flush();

    expect(result).toEqual({ decision: "proceed" });
    expect(registry.incrementCounter).toHaveBeenCalledWith("answer_coverage_shadow_agreement_total", expect.objectContaining({
      labels: { head_classification: "unanswered_insufficient_evidence", shadow_classification: "unanswered_insufficient_evidence" },
    }));
  });

  it("records disagreement when the shadow classifies differently than the head", async () => {
    const gateway = gatewayReturning("partial_insufficient_evidence");
    const registry = metrics();
    const assessor = new AnswerCoverageShadowAssessor(gateway, true, registry);
    const inner = fakeSink();

    const wrapped = assessor.wrapVerdictSink({ getSession: () => session() }, inner);
    await wrapped.report({ assessment: headVerdict });
    await flush();

    expect(registry.incrementCounter).toHaveBeenCalledWith("answer_coverage_shadow_agreement_total", expect.objectContaining({
      labels: { head_classification: "unanswered_insufficient_evidence", shadow_classification: "partial_insufficient_evidence" },
    }));
  });

  it("records shadow_failed when the shadow call fails, and the turn is unaffected", async () => {
    const gateway = { answer: vi.fn(async () => { throw new Error("provider unavailable"); }) };
    const registry = metrics();
    const assessor = new AnswerCoverageShadowAssessor(gateway, true, registry);
    const inner = fakeSink("yield_turn");

    const wrapped = assessor.wrapVerdictSink({ getSession: () => session() }, inner);
    const result = await wrapped.report({ assessment: headVerdict });
    await flush();

    expect(result).toEqual({ decision: "yield_turn" });
    expect(registry.incrementCounter).toHaveBeenCalledWith("answer_coverage_shadow_agreement_total", expect.objectContaining({
      labels: { head_classification: "unanswered_insufficient_evidence", shadow_classification: "shadow_failed" },
    }));
  });

  it("never calls the gateway when disabled by configuration", async () => {
    const gateway = gatewayReturning("unanswered_insufficient_evidence");
    const assessor = new AnswerCoverageShadowAssessor(gateway, false, metrics());
    const inner = fakeSink();

    const wrapped = assessor.wrapVerdictSink({ getSession: () => session() }, inner);
    await wrapped.report({ assessment: headVerdict });

    expect(gateway.answer).not.toHaveBeenCalled();
  });

  it("never calls the gateway on a zero-evidence turn (nothing for the shadow to independently judge)", async () => {
    const gateway = gatewayReturning("unanswered_insufficient_evidence");
    const assessor = new AnswerCoverageShadowAssessor(gateway, true, metrics());
    const inner = fakeSink();

    const wrapped = assessor.wrapVerdictSink({ getSession: () => session({ retrieval: { contexts: [] } } as never) }, inner);
    await wrapped.report({ assessment: headVerdict });

    expect(gateway.answer).not.toHaveBeenCalled();
  });

  it("never calls the gateway off the retrieval route", async () => {
    const gateway = gatewayReturning("unanswered_insufficient_evidence");
    const assessor = new AnswerCoverageShadowAssessor(gateway, true, metrics());
    const inner = fakeSink();

    const wrapped = assessor.wrapVerdictSink({ getSession: () => session({ turnRoute: "direct" } as never) }, inner);
    await wrapped.report({ assessment: headVerdict });

    expect(gateway.answer).not.toHaveBeenCalled();
  });
});
