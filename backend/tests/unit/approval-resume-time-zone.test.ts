import type { ConversationEngine, TurnContext } from "@radioso/conversation-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingDecisionRecord } from "../../src/db/repositories/pendingDecisionRepository.js";
import type { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ApprovalResumeTurn } from "../../src/modules/chat/services/approvalResumeTurn.js";
import { visitorTimeZoneTurnMetadata } from "../../src/modules/chat/services/turnReferenceTimeZone.js";
import { formatIsoDate } from "../../src/shared/domain/clock.js";
import {
  InMemoryAgentRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

const workspaceId = "workspace-1";

// 18:00 on 11 November in Los Angeles is already 12 November in UTC.
const FROZEN_NOW = new Date("2026-11-12T02:00:00.000Z");
const LOCAL_TODAY = "2026-11-11";
const UTC_TODAY = "2026-11-12";

type Stage = { id: string; inputs?: Record<string, unknown> };

const timeZoneStage = (trace: { stages: Stage[] }): Stage | undefined =>
  trace.stages.find((stage) => stage.id === "reference-time-zone");

const setup = async (input: { workspaceTimeZone: string | null; messageMetadata?: Record<string, unknown> }) => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const agent = await new InMemoryAgentRepository().create(workspaceId, { name: "Support" });
  const conversation = await conversationRepository.create({ workspaceId, agentId: agent.id });
  await messageRepository.create({
    conversationId: conversation.id,
    workspaceId,
    role: "user",
    content: "Book the table for tomorrow.",
    ...(input.messageMetadata ? { metadata: input.messageMetadata } : {}),
  });

  const resumeAwaitingDecision = vi.fn<ConversationEngine["resumeAwaitingDecision"]>(async () => ({
    resumed: true,
    response: { answer: "Booked." },
    nextState: null,
    terminal: { kind: "complete", stepId: "booked" },
    completedState: {
      sessionId: conversation.id,
      routineId: "booking",
      path: ["await-approval", "booked"],
      variables: {},
      status: "completed",
    },
  }));
  const completeAssistantTurn = vi.fn(async () => ({
    assistantMessageId: "assistant-message-1",
    postCommitReceipt: { workspaceId, changeKinds: ["conversation.turn_committed" as const] },
  }));
  const lease = {
    conversationId: conversation.id,
    signal: new AbortController().signal,
    waitForPredecessor: async () => undefined,
    setStage: () => undefined,
    throwIfCancelled: () => undefined,
    beginEmission: () => undefined,
    beginCommit: () => undefined,
    complete: () => undefined,
    cancelAfterDisconnect: () => undefined,
  };
  const readWorkspaceTimeZone = vi.fn(async () => input.workspaceTimeZone);
  const turn = new ApprovalResumeTurn({
    conversationRepository,
    messageRepository,
    agentService: { resolve: async () => agent },
    chatGateway: { answer: async () => "unused", streamAnswer: async function* () { yield "unused"; } },
    chatAnswerPresenter: {
      presentRoutineAnswer: (answer: string) => ({
        answer,
        skillName: "routine.answer",
        skillOutcome: "completed",
        skillStatus: "completed",
      }),
    } as unknown as ChatAnswerPresenter,
    turnSkills: [],
    conversationEngine: { resumeAwaitingDecision } as unknown as ConversationEngine,
    chatTurnLifecycle: { completeAssistantTurn } as never,
    conversationTurnRegistry: { start: () => lease },
    routineProvider: { forTurn: vi.fn(async () => ({ activator: { activate: async () => null }, runner: {} as never })) },
    suspendedRoutineReader: { loadSuspended: async () => null },
    detectResponseLanguage: async () => undefined,
    workspaceTimeZones: { readWorkspaceTimeZone },
  });
  const now = new Date();
  const record: PendingDecisionRecord = {
    id: "decision-1",
    handle: "booking-approval",
    conversationId: conversation.id,
    sessionId: conversation.id,
    workspaceId,
    agentId: agent.id,
    routineId: "booking",
    stepId: "await-approval",
    reason: "booking_review",
    options: [{ id: "approve", label: "Approve" }],
    deciderScope: {},
    contentHash: "hash-1",
    status: "resolved",
    decision: { optionId: "approve" },
    decidedBy: "account-1",
    decidedByUserId: null,
    decidedAt: now,
    deadline: null,
    createdAt: now,
    updatedAt: now,
  };
  const resume = async () => {
    await turn.resume({ record, optionId: "approve", decidedBy: "account-1", transaction: {} as never });
    const engineTurn: TurnContext = resumeAwaitingDecision.mock.calls[0][0].turn;
    const engineTrace = (completeAssistantTurn.mock.calls[0] as unknown as [{ engineTrace: { stages: Stage[] } }])[0].engineTrace;
    return { engineTurn, engineTrace, readWorkspaceTimeZone };
  };
  return { resume };
};

describe("an approval resume's reference time zone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("reads today in the zone the conversation last ran in, so tomorrow is the visitor's tomorrow", async () => {
    const { resume } = await setup({
      workspaceTimeZone: "Europe/Rome",
      messageMetadata: visitorTimeZoneTurnMetadata({ timeZone: "America/Los_Angeles", source: "visitor" }),
    });

    const { engineTurn, engineTrace } = await resume();

    expect(engineTurn.referenceTimeZone).toEqual({ timeZone: "America/Los_Angeles", source: "conversation" });
    expect(formatIsoDate(FROZEN_NOW, engineTurn.referenceTimeZone!.timeZone)).toBe(LOCAL_TODAY);
    expect(formatIsoDate(FROZEN_NOW)).toBe(UTC_TODAY);
    // The trace names where the zone came from, never the zone.
    expect(timeZoneStage(engineTrace)?.inputs).toEqual({ timeZoneSource: "conversation" });
    expect(JSON.stringify(engineTrace)).not.toContain("America/Los_Angeles");
  });

  it("falls back to the workspace zone when the conversation recorded none, never to UTC", async () => {
    const { resume } = await setup({ workspaceTimeZone: "America/Los_Angeles" });

    const { engineTurn, engineTrace } = await resume();

    expect(engineTurn.referenceTimeZone).toEqual({ timeZone: "America/Los_Angeles", source: "workspace" });
    expect(formatIsoDate(FROZEN_NOW, engineTurn.referenceTimeZone!.timeZone)).toBe(LOCAL_TODAY);
    expect(timeZoneStage(engineTrace)?.inputs).toEqual({ timeZoneSource: "workspace" });
  });

  it("ignores a recorded zone the runtime does not know and uses the workspace zone", async () => {
    const { resume } = await setup({
      workspaceTimeZone: "Europe/Rome",
      messageMetadata: { visitorTimeZone: "Not/AZone" },
    });

    const { engineTurn } = await resume();

    expect(engineTurn.referenceTimeZone).toEqual({ timeZone: "Europe/Rome", source: "workspace" });
  });

  it("reads UTC, and says so in the trace, only when neither the conversation nor the workspace has a zone", async () => {
    const { resume } = await setup({ workspaceTimeZone: null });

    const { engineTurn, engineTrace } = await resume();

    expect(engineTurn.referenceTimeZone).toEqual({ timeZone: "UTC", source: "default" });
    expect(timeZoneStage(engineTrace)?.inputs).toEqual({ timeZoneSource: "default" });
  });

  it("does not read the workspace zone when the conversation recorded one", async () => {
    const { resume } = await setup({
      workspaceTimeZone: "Europe/Rome",
      messageMetadata: visitorTimeZoneTurnMetadata({ timeZone: "Asia/Tokyo", source: "visitor" }),
    });

    const { readWorkspaceTimeZone } = await resume();

    expect(readWorkspaceTimeZone).not.toHaveBeenCalled();
  });
});
