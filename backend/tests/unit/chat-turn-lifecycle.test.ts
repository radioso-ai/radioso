import { describe, expect, it, vi } from "vitest";

import type { ConversationTrace } from "@radioso/conversation-contract";

import type { AuditService } from "../../src/modules/audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../src/db/repositories/messageRepository.js";
import { ChatTurnLifecycle } from "../../src/modules/chat/services/chatTurnLifecycle.js";
import type { ChatIntakeResult } from "../../src/modules/chat/services/chatIntakeProvider.js";
import type { ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { TURN_TRACE_ENVELOPE_VERSION } from "../../src/modules/chat/services/turnTraceEnvelope.js";

interface RecordedAudit {
  metadata: Record<string, any>;
}

const harness = () => {
  const records: RecordedAudit[] = [];
  const auditService = {
    record: vi.fn(async (event: RecordedAudit) => {
      records.push(event);
    }),
    updateChatAnswerSuggestions: vi.fn(async () => {}),
  } as unknown as AuditService;
  const conversationRepository = {
    touch: vi.fn(async () => {}),
  } as unknown as ConversationRepositoryPort;
  const messageRepository = {
    create: vi.fn(async () => ({ id: "assistant_msg_1" })),
  } as unknown as MessageRepositoryPort;

  const lifecycle = new ChatTurnLifecycle(conversationRepository, messageRepository, auditService);
  return { lifecycle, records };
};

const session = (): PreparedSession =>
  ({
    agent: { id: "agent_1", name: "Support", chatModelOverride: null },
    conversation: { id: "conv_1" },
    history: [],
    userMessage: { id: "msg_1" },
    turnRoute: "social_only",
    directiveSteering: { rules: [], matches: [], omissions: [] },
    stagedContext: [],
    retrieval: {
      contexts: [],
      diagnostics: {},
      systemPrompt: undefined,
      trace: {
        traceId: "trace_1",
        startedAt: "2026-01-01T00:00:00.000Z",
        stages: [],
        links: [],
      },
    },
  } as unknown as PreparedSession);

const presentation = (): ChatPresentedAnswer => ({
  answer: "Grounded answer.",
  skillName: "retrieval.answer",
  skillOutcome: "grounded",
  skillStatus: "completed",
  answerOutcome: "grounded_success",
  citations: [],
});

const engineTrace = (): ConversationTrace => ({
  traceId: "conversation-turn-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  stages: [
    { id: "gather", kind: "gather", status: "applied" },
    {
      id: "dispatch:retrieval.answer",
      kind: "skill_dispatch",
      status: "applied",
      outputs: { skillName: "retrieval.answer" },
    },
    { id: "compose", kind: "compose", status: "applied" },
  ],
});

describe("ChatTurnLifecycle — engine turn envelope", () => {
  it("persists a turnTrace envelope with the retrieval activity trace as a leaf on the dispatch stage", async () => {
    const { lifecycle, records } = harness();

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    expect(records).toHaveLength(1);
    const { turnTrace } = records[0].metadata;
    expect(turnTrace.version).toBe(TURN_TRACE_ENVELOPE_VERSION);
    expect(turnTrace.spine.stages.map((stage: any) => stage.kind)).toEqual([
      "gather",
      "skill_dispatch",
      "compose",
    ]);

    const dispatchStage = turnTrace.spine.stages.find((stage: any) => stage.kind === "skill_dispatch");
    expect(dispatchStage.subTrace.namespace).toBe("retrieval");
    expect(dispatchStage.subTrace.version).toBe(1);
    // The leaf is the FINALIZED activity trace (answer-outcome stage appended), keyed off trace_1.
    expect(dispatchStage.subTrace.payload.traceId).toBe("trace_1");
    expect(dispatchStage.subTrace.payload.stages.length).toBeGreaterThan(0);
  });

  it("retains the legacy activityTrace key but no longer writes conversationEngine.trace", async () => {
    const { lifecycle, records } = harness();

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    const { metadata } = records[0];
    // Legacy flat trace is still written (history + live text diagnostics read it).
    expect(metadata.activityTrace?.traceId).toBe("trace_1");
    // The raw spine now lives only in the envelope; the dead audit key is gone.
    expect(metadata.conversationEngine).toBeUndefined();
    expect(metadata.turnTrace?.spine?.traceId).toBe("conversation-turn-1");
  });
});

describe("ChatTurnLifecycle — intake turn synthesized spine", () => {
  const intakeResult = (): ChatIntakeResult => ({
    skillName: "contact.collect",
    status: "completed",
    skillOutcome: "collected",
    answer: "Thanks — we'll be in touch.",
    activitySummary: {} as ChatIntakeResult["activitySummary"],
    activityTrace: {
      traceId: "intake-trace",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.500Z",
      stages: [],
      links: [],
    },
  });

  it("synthesizes a single-dispatch spine carrying the intake activity trace as a skill-intake leaf", async () => {
    const { lifecycle, records } = harness();

    await lifecycle.completeSkillIntakeTurn({
      workspaceId: "workspace_1",
      session: session(),
      intakeResult: intakeResult(),
      stream: false,
    });

    expect(records).toHaveLength(1);
    const { turnTrace } = records[0].metadata;
    expect(turnTrace.version).toBe(TURN_TRACE_ENVELOPE_VERSION);
    expect(turnTrace.spine.stages).toHaveLength(1);
    const stage = turnTrace.spine.stages[0];
    expect(stage.id).toBe("dispatch:contact.collect");
    expect(stage.subTrace.namespace).toBe("skill-intake");
    expect(stage.subTrace.payload.traceId).toBe("intake-trace");
  });
});
