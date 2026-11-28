import type { ConversationEngine, TurnContext } from "@radioso/conversation-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRecord } from "../../src/modules/agents/domain.js";
import type { PendingDecisionRecord } from "../../src/db/repositories/pendingDecisionRepository.js";
import type { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ApprovalResumeTurn } from "../../src/modules/chat/services/approvalResumeTurn.js";
import type { ChatRoutineProvider } from "../../src/modules/chat/contracts/routineProvider.js";
import type { RoutinePresentingSteps } from "../../src/modules/chat/services/routines/routinePresentingStepRenderer.js";
import { visitorTimeZoneTurnMetadata } from "../../src/modules/chat/services/turnReferenceTimeZone.js";
import type { ChannelPersonKey, ConversationChannelPersonKeys } from "../../src/shared/domain/channelPersonKey.js";
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

const setup = async (input: {
  workspaceTimeZone: string | null;
  /** The metadata of the visitor's first message. */
  messageMetadata?: Record<string, unknown>;
  /** A newer visitor message in the same conversation; `{}` is one whose client reported no zone. */
  laterMessageMetadata?: Record<string, unknown>;
  /** Another conversation of the workspace, whose visitor message is newer than this one's. */
  otherConversationMetadata?: Record<string, unknown>;
  presentingSteps?: RoutinePresentingSteps;
  /** The release the conversation is pinned to. */
  agentRevisionId?: string;
  sourceChannel?: string;
  channelPersonKeys?: ConversationChannelPersonKeys;
  agentRevisionRuntimeResolver?: ConstructorParameters<typeof ApprovalResumeTurn>[0]["agentRevisionRuntimeResolver"];
}) => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const agent = await new InMemoryAgentRepository().create(workspaceId, { name: "Support" });
  const conversation = await conversationRepository.create({
    workspaceId,
    agentId: agent.id,
    ...(input.agentRevisionId ? { agentRevisionId: input.agentRevisionId } : {}),
    ...(input.sourceChannel ? { sourceChannel: input.sourceChannel } : {}),
  });
  await messageRepository.create({
    conversationId: conversation.id,
    workspaceId,
    role: "user",
    content: "Book the table for tomorrow.",
    ...(input.messageMetadata ? { metadata: input.messageMetadata } : {}),
  });
  if (input.laterMessageMetadata) {
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId,
      role: "user",
      content: "Actually, make it for two.",
      metadata: input.laterMessageMetadata,
    });
  }
  if (input.otherConversationMetadata) {
    const other = await conversationRepository.create({ workspaceId, agentId: agent.id });
    await messageRepository.create({
      conversationId: other.id,
      workspaceId,
      role: "user",
      content: "What's on this weekend?",
      metadata: input.otherConversationMetadata,
    });
  }

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
  const forTurn = vi.fn<ChatRoutineProvider["forTurn"]>(async () => ({ activator: { activate: async () => null }, runner: {} as never }));
  const turn = new ApprovalResumeTurn({
    conversationRepository,
    messageRepository,
    agentService: { resolve: async () => agent },
    ...(input.agentRevisionRuntimeResolver ? { agentRevisionRuntimeResolver: input.agentRevisionRuntimeResolver } : {}),
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
    routineProvider: { describeStartable: async () => [], forTurn },
    ...(input.presentingSteps ? { presentingSteps: input.presentingSteps } : {}),
    suspendedRoutineReader: { loadSuspended: async () => null },
    detectResponseLanguage: async () => undefined,
    workspaceTimeZones: { readWorkspaceTimeZone },
    ...(input.channelPersonKeys ? { channelPersonKeys: input.channelPersonKeys } : {}),
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
  const decisionTransaction = { decision: "transaction" } as never;
  const commitSpy = vi.fn();
  const commit = <T,>(work: (db: never) => Promise<T>): Promise<T> => {
    commitSpy();
    return work(decisionTransaction);
  };
  const resume = async () => {
    await turn.resume({ record, optionId: "approve", decidedBy: "account-1", commit });
    const engineTurn: TurnContext = resumeAwaitingDecision.mock.calls[0][0].turn;
    const engineTrace = (completeAssistantTurn.mock.calls[0] as unknown as [{ engineTrace: { stages: Stage[] } }])[0].engineTrace;
    return { engineTurn, engineTrace, readWorkspaceTimeZone };
  };
  return { resume, forTurn, resumeAwaitingDecision, commit: commitSpy, completeAssistantTurn, decisionTransaction, agent, conversation };
};

// The decision's transaction must hold no transaction id while the routine calls the model, or it
// holds back the workspace event log (spec 957 §6).
describe("an approval resume's decision", () => {
  it("is committed once the routine has walked on from it, with the resumed reply written on its transaction", async () => {
    const { resume, resumeAwaitingDecision, commit, completeAssistantTurn, decisionTransaction } = await setup({ workspaceTimeZone: null });

    await resume();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(resumeAwaitingDecision.mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]);
    expect(completeAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({ transaction: decisionTransaction }));
  });
});

// #1763: an approval that leads to a search and a step that shows its results writes that step
// from the results, as a live turn does.
describe("an approval resume's routine steps that show a skill step's results", () => {
  it("writes the step from the staged results with the skill-result renderer", async () => {
    const render = vi.fn(async () => ({ answer: "Two homes match.", skillName: "search_homes", skillOutcome: "completed", skillStatus: "completed" as const }));
    const { resume, forTurn } = await setup({ workspaceTimeZone: null, presentingSteps: { skillResultRenderer: { supports: () => true, render } } });
    const { engineTurn } = await resume();

    const grounded = forTurn.mock.calls[0][0].groundedAnswerRenderer!;
    const pending = grounded.prepare!({
      step: { id: "choose", kind: "chat", action: "Show the homes.", present: { from: "search", selection: "single", slot: "chosen_home" } },
      steering: [],
      turn: {
        ...engineTurn,
        activeRoutineId: "booking",
        stagedContext: [{ kind: "skill_result", source: "search_homes", data: { results: [{ name: "Villa Rosa" }] }, metadata: { stepId: "search", status: "completed" } }],
      },
    });
    const reply = await pending!.render();

    expect(render).toHaveBeenCalledOnce();
    expect(reply.answer).toBe("Two homes match.");
  });
});

// #1793: an operator's approval resumes the routine on the conversation's release, so a skill
// edited or switched off in the draft since then does not reach the visitor before publish.
describe("an approval resume's skills", () => {
  const releaseSkills = [{ skillName: "book_table", kind: "webhook", enabled: true, settings: { payload: "release" } }];

  it("runs the skills of the release the conversation is pinned to", async () => {
    const resolvePinned = vi.fn(async (input: { agent: AgentRecord; revisionId: string }) => ({
      agent: { ...input.agent, authoredAgentSkills: releaseSkills } as unknown as AgentRecord,
    }));
    const { resume, forTurn, agent } = await setup({
      workspaceTimeZone: null,
      agentRevisionId: "revision-1",
      agentRevisionRuntimeResolver: { resolvePinned } as never,
    });

    await resume();

    expect(resolvePinned).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, revisionId: "revision-1", agent }));
    expect(forTurn.mock.calls[0][0]).toEqual(expect.objectContaining({
      agentRevisionId: "revision-1",
      conversationSkills: releaseSkills,
    }));
  });

  it("leaves the live skills to a conversation pinned to no release", async () => {
    const resolvePinned = vi.fn();
    const { resume, forTurn } = await setup({ workspaceTimeZone: null, agentRevisionRuntimeResolver: { resolvePinned } });

    await resume();

    expect(resolvePinned).not.toHaveBeenCalled();
    expect(forTurn.mock.calls[0][0]).not.toHaveProperty("conversationSkills");
  });
});

// #1884: no message is live on a resume, so nothing attests the number: the resumed turn runs as
// the person the conversation's channel keeps, and a routine it ends saves under that number.
describe("an approval resume's person", () => {
  // An obviously fake number in the reserved 555-01xx range.
  const recorded: ChannelPersonKey = { kind: "whatsapp_contact", id: "15550100101" };

  it("is the one the conversation's channel keeps", async () => {
    const personKeyOf = vi.fn<ConversationChannelPersonKeys["personKeyOf"]>(async () => recorded);
    const { resume, completeAssistantTurn, conversation } = await setup({ workspaceTimeZone: null, sourceChannel: "whatsapp", channelPersonKeys: { personKeyOf } });

    await resume();

    expect(personKeyOf).toHaveBeenCalledWith({ workspaceId, conversationId: conversation.id, sourceChannel: "whatsapp" });
    expect(completeAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ channelPersonKey: recorded }) }));
  });
});

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

  it("reads the visitor's last message, so a newer message that recorded no zone leaves the workspace zone", async () => {
    const { resume } = await setup({
      workspaceTimeZone: "Europe/Rome",
      messageMetadata: visitorTimeZoneTurnMetadata({ timeZone: "America/Los_Angeles", source: "visitor" }),
      laterMessageMetadata: {},
    });

    const { engineTurn } = await resume();

    expect(engineTurn.referenceTimeZone).toEqual({ timeZone: "Europe/Rome", source: "workspace" });
  });

  it("reads the newer zone when the visitor's later message recorded another", async () => {
    const { resume } = await setup({
      workspaceTimeZone: "Europe/Rome",
      messageMetadata: visitorTimeZoneTurnMetadata({ timeZone: "America/Los_Angeles", source: "visitor" }),
      laterMessageMetadata: visitorTimeZoneTurnMetadata({ timeZone: "Asia/Tokyo", source: "visitor" }),
    });

    const { engineTurn } = await resume();

    expect(engineTurn.referenceTimeZone).toEqual({ timeZone: "Asia/Tokyo", source: "conversation" });
  });

  it("ignores a zone another conversation of the workspace recorded", async () => {
    const { resume } = await setup({
      workspaceTimeZone: "Europe/Rome",
      otherConversationMetadata: visitorTimeZoneTurnMetadata({ timeZone: "Asia/Tokyo", source: "visitor" }),
    });

    const { engineTurn } = await resume();

    expect(engineTurn.referenceTimeZone).toEqual({ timeZone: "Europe/Rome", source: "workspace" });
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
