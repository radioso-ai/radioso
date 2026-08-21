import { describe, expect, it, vi } from "vitest";

import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import {
  AgentTurnTestService,
  OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL,
} from "../../src/modules/chat/services/agentTurnTestService.js";
import type {
  AgentTurnTestRoutineReader,
  AgentTurnTestRunnerPort,
} from "../../src/modules/chat/contracts/agentTurnTest.js";
import type { ChatResponse } from "../../src/modules/chat/types/chatResponses.js";

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  account: "00000000-0000-4000-8000-000000000002",
  operator: "00000000-0000-4000-8000-000000000003",
  copilotConversation: "00000000-0000-4000-8000-000000000004",
  agent: "00000000-0000-4000-8000-000000000005",
  conversation: "00000000-0000-4000-8000-000000000006",
  userMessage: "00000000-0000-4000-8000-000000000007",
  assistantMessage: "00000000-0000-4000-8000-000000000008",
  routine: "00000000-0000-4000-8000-000000000009",
};

const message = (input: Pick<MessageRecord, "id" | "role">): MessageRecord => ({
  id: input.id,
  conversationId: ids.conversation,
  workspaceId: ids.workspace,
  role: input.role,
  content: input.role === "user" ? "Run the draft" : "Draft response",
  createdAt: new Date("2026-08-21T12:00:00.000Z"),
});

const conversation = (overrides: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id: ids.conversation,
  workspaceId: ids.workspace,
  agentId: ids.agent,
  agentName: "Ray test agent",
  agentInternalName: "ray-test-agent",
  sourceChannel: OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL,
  sourceOrigin: `operator:${ids.operator}:copilot_conversation:${ids.copilotConversation}`,
  channelContext: null,
  anonymousSessionId: null,
  verifiedCustomerId: null,
  entryPageUrl: null,
  createdAt: new Date("2026-08-21T12:00:00.000Z"),
  updatedAt: new Date("2026-08-21T12:00:00.000Z"),
  ...overrides,
});

const harness = (options: { existingConversation?: ConversationRecord | null } = {}) => {
  const calls: string[] = [];
  const conversationReader = {
    findByIdAndWorkspaceId: vi.fn(async () => {
      calls.push("conversation");
      return options.existingConversation ?? null;
    }),
  };
  const agentReader = {
    findByIdAndWorkspaceId: vi.fn(async () => {
      calls.push("agent");
      return { id: ids.agent };
    }),
  };
  const routineReader = {
    findById: vi.fn<AgentTurnTestRoutineReader["findById"]>(async () => {
      calls.push("routine");
      return { status: "draft" as const };
    }),
  };
  const abuseControl = {
    enforce: vi.fn(async () => {
      calls.push("abuse");
    }),
  };
  const audit = { record: vi.fn(async () => {}) };
  const runTurn = vi.fn<AgentTurnTestRunnerPort["run"]>(async () => {
      calls.push("turn");
      return {
        conversationId: ids.conversation,
        agentId: ids.agent,
        assistantMessageId: ids.assistantMessage,
        route: { type: "direct" as const, reason: "social_only" as const },
        answer: "Draft response",
        skillOutcome: "completed",
        answerOutcome: "routine_completed",
        citations: [],
        activitySummary: { execution: { surface: "assistant", path: "assistant_direct", retrievalInvoked: false } },
        activityTrace: { traceId: "trace-1", startedAt: "2026-08-21T12:00:00.000Z", stages: [], links: [] },
      } as ChatResponse;
    });
  const turnRunner = {
    run: runTurn,
  };
  const messageReader = {
    findByIdAndWorkspaceId: vi.fn(async () => ({
      ...message({ id: ids.assistantMessage, role: "assistant" }),
      metadata: { probeUserMessageId: ids.userMessage },
    })),
  };
  const service = new AgentTurnTestService({
    conversationReader,
    agentReader,
    routineReader,
    abuseControl,
    audit,
    abusePolicy: { limit: 60, windowMs: 60_000 },
    turnRunner,
    messageReader,
  });
  return { service, calls, conversationReader, routineReader, abuseControl, audit, turnRunner, runTurn };
};

const input = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: ids.workspace,
  accountId: ids.account,
  operatorUserId: ids.operator,
  copilotConversationId: ids.copilotConversation,
  agentId: ids.agent,
  message: "Run the draft",
  previewRoutineIds: [ids.routine],
  ...overrides,
});

describe("AgentTurnTestService", () => {
  it("spends abuse-control budget before ownership and draft preflight, then runs the turn", async () => {
    const { service, calls, abuseControl, runTurn } = harness({
      existingConversation: conversation(),
    });

    const result = await service.testTurn(input({ conversationId: ids.conversation }));

    expect(calls).toEqual(["abuse", "conversation", "agent", "routine", "turn"]);
    expect(abuseControl.enforce).toHaveBeenCalledWith({
      scope: "api.expensive_authenticated",
      subjectKey: `account:${ids.account}:workspace:${ids.workspace}:operator:${ids.operator}`,
      limit: 60,
      windowMs: 60_000,
    });
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: ids.workspace,
      accountId: ids.account,
      agentId: ids.agent,
      conversationId: ids.conversation,
      query: "Run the draft",
      previewRoutineIds: [ids.routine],
      sourceChannel: OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL,
      sourceOrigin: `operator:${ids.operator}:copilot_conversation:${ids.copilotConversation}`,
      usageAttribution: {
        surface: OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL,
        requestId: ids.copilotConversation,
      },
    }));
    expect(runTurn.mock.calls[0]?.[0]).not.toHaveProperty("stream");
    expect(result).toMatchObject({
      conversationId: ids.conversation,
      userMessageId: ids.userMessage,
      assistantMessageId: ids.assistantMessage,
      answer: "Draft response",
      answerOutcome: "routine_completed",
    });
  });

  it.each([
    ["workspace", { workspaceId: "wrong" }],
    ["agent", { agentId: "wrong" }],
    ["source channel", { sourceChannel: "authenticated_chat" }],
    ["operator", { sourceOrigin: `operator:wrong:copilot_conversation:${ids.copilotConversation}` }],
    ["parent conversation", { sourceOrigin: `operator:${ids.operator}:copilot_conversation:wrong` }],
  ])("fails continuation with one safe error on a %s mismatch", async (_label, overrides) => {
    const { service, abuseControl, turnRunner } = harness({
      existingConversation: conversation(overrides),
    });

    await expect(service.testTurn(input({ conversationId: ids.conversation })))
      .rejects.toMatchObject({ statusCode: 404, message: "Test conversation not found" });
    expect(abuseControl.enforce).toHaveBeenCalledOnce();
    expect(turnRunner.run).not.toHaveBeenCalled();
  });

  it("fails closed before effects when a preview routine is not eligible", async () => {
    const { service, routineReader, abuseControl, turnRunner } = harness();
    routineReader.findById.mockResolvedValue({ status: "archived" });

    await expect(service.testTurn(input()))
      .rejects.toMatchObject({ statusCode: 404, message: "Preview routine not found" });
    expect(abuseControl.enforce).toHaveBeenCalledOnce();
    expect(turnRunner.run).not.toHaveBeenCalled();
  });

  it("fails closed on repeated direct-service probes and preserves rate-limit audit semantics", async () => {
    const { service, abuseControl, audit, runTurn } = harness();
    abuseControl.enforce
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 }));

    await service.testTurn(input());
    await expect(service.testTurn(input())).rejects.toMatchObject({ statusCode: 429 });

    expect(runTurn).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith({
      accountId: ids.account,
      workspaceId: ids.workspace,
      eventType: "security.rate_limit_enforced",
      eventStatus: "success",
      metadata: {
        scope: "api.expensive_authenticated",
        subjectKey: `account:${ids.account}:workspace:${ids.workspace}:operator:${ids.operator}`,
        principalType: "operator_copilot",
        route: "test_agent_turn",
      },
    });
  });
});
