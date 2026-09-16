import { describe, expect, it, vi } from "vitest";

import { AnswerCoverageHeadRecorder } from "../../../src/modules/chat/services/answerCoverageHeadRecorder.js";
import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalCoverageVerdictSink } from "../../../src/modules/chat/contracts/answerCoverage.js";
import type { AnswerCoverageAssessment, AnswerCoverageRecord } from "../../../src/modules/answerCoverage/public.js";

const session = (): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Agent", chatModelOverride: null },
  conversation: { id: "conversation-1" },
  history: [],
  turnRoute: "retrieval",
  userMessage: { id: "request-1", role: "user", content: "Can I attend for one day?", workspaceId: "workspace-1", conversationId: "conversation-1", createdAt: new Date() },
  effectiveQuery: "Can I attend one day with the visiting teacher?",
  retrieval: { contexts: [{ chunkId: "chunk-1", title: "Attendance policy", content: "A".repeat(200) }] },
} as unknown as PreparedSession);

const assessedVerdict: AnswerCoverageAssessment = {
  availability: "assessed",
  coverage: "unanswered",
  reason: "insufficient_evidence",
  unresolvedRequest: "One-day attendance permission",
  schemaVersion: 1,
  producer: "answer_head",
};

const savedRecord: AnswerCoverageRecord = {
  ...assessedVerdict,
  id: "assessment-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  requestMessageId: "request-1",
  originatingTurnId: "request-1",
  contextualizedRequest: "Can I attend one day with the visiting teacher?",
  assessedAt: new Date("2026-09-16T00:00:00.000Z"),
  createdAt: new Date("2026-09-16T00:00:00.000Z"),
};

const fakeRepository = (overrides: { saveAssessment?: () => Promise<AnswerCoverageRecord> } = {}) => ({
  saveAssessment: vi.fn(overrides.saveAssessment ?? (async () => savedRecord)),
  findByRequestMessageId: vi.fn(async (): Promise<AnswerCoverageRecord | null> => null),
  listByRequestMessageIds: vi.fn(async () => new Map()),
  markInteractionEvaluated: vi.fn(async () => {}),
  recordReaction: vi.fn(),
  listByAssessmentId: vi.fn(async () => []),
  listByAssessmentIds: vi.fn(async () => new Map()),
});

const fakeSink = (decision: "proceed" | "yield_turn" = "proceed"): RetrievalCoverageVerdictSink & { report: ReturnType<typeof vi.fn> } => ({
  report: vi.fn(async () => ({ decision })),
});

describe("AnswerCoverageHeadRecorder.wrapVerdictSink", () => {
  it("persists the reported assessment, attaches the saved record to onAssessment, then delegates to the inner sink", async () => {
    const repository = fakeRepository();
    const recorder = new AnswerCoverageHeadRecorder(repository);
    const inner = fakeSink("proceed");
    const onAssessment = vi.fn();
    const current = session();

    const wrapped = recorder.wrapVerdictSink({ getSession: () => current, onAssessment }, inner);
    const result = await wrapped.report({ assessment: assessedVerdict });

    expect(repository.saveAssessment).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      requestMessageId: "request-1",
      originatingTurnId: "request-1",
      assessment: assessedVerdict,
    }));
    expect(onAssessment).toHaveBeenCalledWith({
      assessment: expect.objectContaining({ availability: "assessed", coverage: "unanswered", producer: "answer_head" }),
      record: savedRecord,
    });
    expect(inner.report).toHaveBeenCalledWith({ assessment: assessedVerdict });
    expect(result).toEqual({ decision: "proceed" });
  });

  it("upserts idempotently: a retried report for the same request message converges on the repository's existing row", async () => {
    // `saveAssessment`'s own `onConflict` handling is the repository's job; the
    // recorder just trusts whatever record it gets back.
    const repository = fakeRepository({ saveAssessment: async () => savedRecord });
    const recorder = new AnswerCoverageHeadRecorder(repository);
    const inner = fakeSink();
    const onAssessment = vi.fn();
    const current = session();
    const wrapped = recorder.wrapVerdictSink({ getSession: () => current, onAssessment }, inner);

    await wrapped.report({ assessment: assessedVerdict });
    await wrapped.report({ assessment: assessedVerdict });

    expect(repository.saveAssessment).toHaveBeenCalledTimes(2);
    expect(onAssessment).toHaveBeenNthCalledWith(1, expect.objectContaining({ record: savedRecord }));
    expect(onAssessment).toHaveBeenNthCalledWith(2, expect.objectContaining({ record: savedRecord }));
  });

  it("forwards the stored verdict to the engine, not a second report's fresh one, when saveAssessment upserts onto an existing row (#1260 review F8)", async () => {
    // `saveAssessment` is insert-or-return-existing: a second report for the same
    // request message id (a retry/regenerate) always gets `savedRecord` back,
    // whatever assessment it was actually called with. The engine must decide on
    // the verdict the row carries, or the persisted record and the turn's actual
    // directive/routine reactions disagree about what was assessed.
    const divergentAssessment: AnswerCoverageAssessment = {
      availability: "assessed",
      coverage: "answered",
      reason: "sufficient_evidence",
      schemaVersion: 1,
      producer: "answer_head",
    };
    const repository = fakeRepository({ saveAssessment: async () => savedRecord });
    const recorder = new AnswerCoverageHeadRecorder(repository);
    const inner = fakeSink();
    const current = session();
    const wrapped = recorder.wrapVerdictSink({ getSession: () => current }, inner);

    await wrapped.report({ assessment: assessedVerdict });
    await wrapped.report({ assessment: divergentAssessment });

    expect(inner.report).toHaveBeenNthCalledWith(2, { assessment: expect.objectContaining({
      coverage: savedRecord.coverage,
      reason: savedRecord.reason,
    }) });
    expect(inner.report).not.toHaveBeenNthCalledWith(2, { assessment: divergentAssessment });
  });

  it("never throws when persistence fails, and still delegates to the inner sink's decision", async () => {
    const repository = fakeRepository({ saveAssessment: async () => { throw new Error("db unavailable"); } });
    const recorder = new AnswerCoverageHeadRecorder(repository);
    const inner = fakeSink("yield_turn");
    const onAssessment = vi.fn();
    const current = session();
    const wrapped = recorder.wrapVerdictSink({ getSession: () => current, onAssessment }, inner);

    await expect(wrapped.report({ assessment: assessedVerdict })).resolves.toEqual({ decision: "yield_turn" });
    expect(onAssessment).not.toHaveBeenCalled();
    expect(inner.report).toHaveBeenCalledWith({ assessment: assessedVerdict });
  });

  it("returns the inner sink unchanged when no repository is configured (draft test chat, eval replay: Flow only, no record)", async () => {
    const recorder = new AnswerCoverageHeadRecorder();
    const inner = fakeSink("proceed");
    const onAssessment = vi.fn();
    const current = session();

    const wrapped = recorder.wrapVerdictSink({ getSession: () => current, onAssessment }, inner);
    const result = await wrapped.report({ assessment: assessedVerdict });

    expect(onAssessment).not.toHaveBeenCalled();
    expect(inner.report).toHaveBeenCalledWith({ assessment: assessedVerdict });
    expect(result).toEqual({ decision: "proceed" });
  });
});

describe("AnswerCoverageHeadRecorder.createReactionRecorder", () => {
  it("records each reaction against the persisted assessment and notifies onRecorded", async () => {
    const repository = fakeRepository();
    repository.findByRequestMessageId.mockResolvedValue(savedRecord);
    const recorder = new AnswerCoverageHeadRecorder(repository);
    const onRecorded = vi.fn();
    const current = session();

    const reactionRecorder = recorder.createReactionRecorder({ getSession: () => current, onRecorded });
    await reactionRecorder!.record({
      assessment: assessedVerdict,
      evaluationState: "evaluated",
      reactions: [{ reactionKey: "routine:r1:activated", routineId: "r1", decision: "activated", reasonCode: "coverage_criteria_activated" }],
    });

    expect(repository.recordReaction).toHaveBeenCalledWith(expect.objectContaining({ assessmentId: savedRecord.id, reactionKey: "routine:r1:activated" }));
    expect(repository.markInteractionEvaluated).toHaveBeenCalledWith({ workspaceId: "workspace-1", assessmentId: savedRecord.id });
    expect(onRecorded).toHaveBeenCalledOnce();
  });

  it("returns undefined when no repository is configured", () => {
    const recorder = new AnswerCoverageHeadRecorder();
    expect(recorder.createReactionRecorder({ getSession: session })).toBeUndefined();
  });
});
