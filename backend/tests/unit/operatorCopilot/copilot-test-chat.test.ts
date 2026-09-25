import { describe, expect, it, vi } from "vitest";

import { admittedAbuseControlDecision } from "../../support/fakes.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import { USAGE_LIMIT_EXCEEDED_CODE } from "../../../src/shared/domain/usageLimitPolicy.js";
import { operatorMcpToolSchemas } from "../../../src/modules/operatorCopilot/mcpToolSchema.js";
import { createChatCopilotTools } from "../../../src/modules/operatorCopilot/tools/chat.js";
import { createTestChatCopilotTools } from "../../../src/modules/operatorCopilot/tools/testChat.js";
import type {
  CopilotTestChatExecutionPort,
  CopilotTestChatPort,
  CopilotTestChatRevisionPort,
  CopilotTestChatSession,
  CopilotTestChatTurn,
} from "../../../src/modules/operatorCopilot/contracts/testChat.js";
import { TestChatService } from "../../../src/modules/operatorCopilot/services/testChatService.js";
import {
  CopilotExpensiveOperationRateLimitedError,
  CopilotUsageLimitReachedError,
} from "../../../src/modules/operatorCopilot/services/expensiveOperationGuard.js";
import { context } from "./copilot-tools-test-helpers.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXECUTION_ID = "e0000000-0000-4000-8000-000000000001";
const SIDE_ID = "5000000a-0000-4000-8000-000000000001";
const OTHER_SIDE_ID = "5000000b-0000-4000-8000-000000000002";
const CANDIDATE_ID = "c0000000-0000-4000-8000-000000000001";
const PUBLISHED_ID = "b0000000-0000-4000-8000-000000000001";
const TURN_ID = "70000000-0000-4000-8000-000000000001";
const GREETING_TURN_ID = "70000000-0000-4000-8000-000000000000";
const MESSAGE_ID = "30000000-0000-4000-8000-000000000001";

/** The runtime supplies the tool context; these tests exercise projection, not the runtime. */
const toolContext = {} as never;

const envelope = (stageCount = 3) => ({
  version: 1,
  spine: {
    traceId: "trace-1",
    startedAt: "2026-09-20T10:00:01.000Z",
    completedAt: "2026-09-20T10:00:03.000Z",
    stages: Array.from({ length: stageCount }, (_unused, index) => ({
      id: index === 1 ? "routine_activation:book-a-demo" : `stage-${index}`,
      kind: index === 1 ? "answer_coverage_routine_activation" : "compose",
      status: index === 1 ? "skipped" : "applied",
      inputs: { query: "private input" },
      outputs: { reason: "no_trigger_match" },
    })),
  },
});

const candidateRevision = { id: CANDIDATE_ID, kind: "candidate" as const, versionNumber: null, createdAt: "2026-09-20T09:59:00.000Z" };

const turn = (overrides: Partial<CopilotTestChatTurn> = {}): CopilotTestChatTurn => ({
  turnId: TURN_ID,
  userMessage: "Can I book a demo?",
  answer: { messageId: MESSAGE_ID, content: "Sure, here is how." },
  state: "completed",
  failureCode: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  turnTrace: envelope(),
  ...overrides,
});

const session = (overrides: Partial<CopilotTestChatSession> = {}): CopilotTestChatSession => ({
  testExecutionId: EXECUTION_ID,
  mode: "single",
  state: "completed",
  skillEffects: "suppressed",
  createdAt: "2026-09-20T10:00:00.000Z",
  sides: [{ sideId: SIDE_ID, revision: candidateRevision, state: "completed", turns: [turn()] }],
  ...overrides,
});

const port = (overrides: Partial<CopilotTestChatPort> = {}): CopilotTestChatPort => ({
  listSessions: vi.fn(async () => ({ sessions: [], nextCursor: null })),
  readSession: vi.fn(async () => session()),
  readTurn: vi.fn(async () => ({ testExecutionId: EXECUTION_ID, sideId: SIDE_ID, revision: candidateRevision, turn: turn() })),
  sendMessage: vi.fn(async () => ({
    testExecutionId: EXECUTION_ID,
    started: true,
    sideId: SIDE_ID,
    revision: candidateRevision,
    turnId: TURN_ID,
    outcome: "completed" as const,
    failureCode: null,
    answer: "Sure, here is how.",
    messageId: MESSAGE_ID,
    turnTrace: envelope(),
  })),
  ...overrides,
});

const tools = (testChat: CopilotTestChatPort) => new Map(createTestChatCopilotTools({
  testChat,
  agentLookup: { listExisting: async () => [] },
}).map((descriptor) => [descriptor.name, descriptor]));

const invoke = async (testChat: CopilotTestChatPort, name: string, input: Record<string, unknown>, agentId: string | null = AGENT_ID) => {
  const descriptor = tools(testChat).get(name);
  if (!descriptor) throw new Error(`missing ${name}`);
  return descriptor.createTool(context(agentId)).invoke(input, toolContext) as Promise<Record<string, any>>;
};

describe("Test Chat copilot descriptors", () => {
  it("reads sessions at no cost and spends one verification run per message sent", () => {
    const descriptors = [...tools(port()).values()];

    expect(descriptors.map(({ name, shape, requiredPermissions }) => ({ name, shape, requiredPermissions }))).toEqual([
      { name: "test_chat_sessions", shape: "read", requiredPermissions: ["workspace.agents.manage"] },
      { name: "test_chat_transcript", shape: "read", requiredPermissions: ["workspace.agents.manage"] },
      { name: "test_chat_turn_trace", shape: "read", requiredPermissions: ["workspace.agents.manage"] },
      { name: "send_test_chat_message", shape: "probe", requiredPermissions: ["workspace.agents.manage"] },
    ]);
    expect(descriptors.map((descriptor) => descriptor.verificationCost({}))).toEqual([0, 0, 0, 1]);
  });

  it("advertises plain object schemas an MCP client can load", () => {
    for (const descriptor of tools(port()).values()) {
      const { inputSchema, outputSchema } = operatorMcpToolSchemas(descriptor);
      for (const schema of [inputSchema, outputSchema]) {
        expect(schema.type, descriptor.name).toBe("object");
        expect(schema.anyOf ?? schema.oneOf ?? schema.allOf, descriptor.name).toBeUndefined();
        expect(JSON.stringify(schema), descriptor.name).not.toContain("\"exclusiveMinimum\":true");
      }
    }
  });

  it("points the customer conversation readers at the Test Chat readers", () => {
    const chat = new Map(createChatCopilotTools({
      chatHistoryService: { getConversation: vi.fn(), getConversationTurn: vi.fn(), listConversations: vi.fn() },
    }).map((descriptor) => [descriptor.name, descriptor]));

    expect(chat.get("conversation_transcript")?.description).toContain("test_chat_transcript");
    expect(chat.get("conversation_history_search")?.description).toContain("test_chat_sessions");
  });

  it("lists sessions with the revision each side ran and a bounded first message", async () => {
    const listSessions = vi.fn(async () => ({
      sessions: [{
        testExecutionId: EXECUTION_ID,
        mode: "single" as const,
        state: "completed" as const,
        skillEffects: "suppressed" as const,
        createdAt: "2026-09-20T10:00:00.000Z",
        sides: [{ sideId: SIDE_ID, revision: { id: PUBLISHED_ID, kind: "published" as const, versionNumber: 3, createdAt: "2026-09-01T00:00:00.000Z" }, state: "completed" as const }],
        turnCount: 4,
        firstMessage: "x".repeat(900),
      }],
      nextCursor: "cursor-2",
    }));
    const output = await invoke(port({ listSessions }), "test_chat_sessions", { cursor: "cursor-1" });

    expect(listSessions).toHaveBeenCalledWith({ workspaceId: "workspace-1", agentId: AGENT_ID, limit: 10, cursor: "cursor-1" });
    expect(output.sessions[0]).toMatchObject({
      testExecutionId: EXECUTION_ID,
      turnCount: 4,
      sides: [{ revision: { id: PUBLISHED_ID, kind: "published", versionNumber: 3 } }],
    });
    expect(output.sessions[0].firstMessage.length).toBeLessThanOrEqual(201);
    expect(output.nextCursor).toBe("cursor-2");
    expect(output.omissions).toEqual([{ field: "sessions.firstMessage", reason: "string_length", omittedCount: 1 }]);
  });

  it("reads a transcript as turns with coarse stages, keeping the most recent turns", async () => {
    const turns = Array.from({ length: 24 }, (_unused, index) => turn({
      turnId: `70000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
      answer: { messageId: MESSAGE_ID, content: index === 23 ? "y".repeat(5_000) : "ok" },
    }));
    const readSession = vi.fn(async () => session({
      sides: [{ sideId: SIDE_ID, revision: candidateRevision, state: "completed", turns }],
    }));

    const output = await invoke(port({ readSession }), "test_chat_transcript", { testExecutionId: EXECUTION_ID });

    expect(readSession).toHaveBeenCalledWith({ workspaceId: "workspace-1", agentId: AGENT_ID, testExecutionId: EXECUTION_ID });
    const [side] = output.session.sides;
    expect(side.revision).toEqual(candidateRevision);
    expect(side.turnCount).toBe(24);
    expect(side.turns).toHaveLength(20);
    expect(side.turns[0].turnId).toBe(turns[4].turnId);
    expect(side.turns[19].stages).toEqual([
      { id: "stage-0", kind: "compose", status: "applied" },
      { id: "routine_activation:book-a-demo", kind: "answer_coverage_routine_activation", status: "skipped" },
      { id: "stage-2", kind: "compose", status: "applied" },
    ]);
    expect(side.turns[19].answer.length).toBeLessThanOrEqual(2_001);
    expect(output.omissions).toEqual(expect.arrayContaining([
      { field: "turns", reason: "array_length", omittedCount: 4 },
      { field: "turns.answer", reason: "string_length", omittedCount: 1 },
    ]));
  });

  it("shows a failed turn's failure code and a greeting turn with no user message", async () => {
    const readSession = vi.fn(async () => session({
      state: "partial",
      sides: [{ sideId: SIDE_ID, revision: candidateRevision, state: "failed", turns: [
        turn({ turnId: GREETING_TURN_ID, userMessage: null, answer: { messageId: "bootstrap:1", content: "Hi!" }, turnTrace: undefined }),
        turn({ answer: null, state: "failed", failureCode: "runner_failed", turnTrace: undefined }),
      ] }],
    }));

    const output = await invoke(port({ readSession }), "test_chat_transcript", { testExecutionId: EXECUTION_ID });

    expect(output.session.sides[0].turns).toEqual([
      expect.objectContaining({ turnId: GREETING_TURN_ID, userMessage: null, answer: "Hi!", state: "completed", stages: [] }),
      expect.objectContaining({ turnId: TURN_ID, answer: null, state: "failed", failureCode: "runner_failed" }),
    ]);
  });

  it("returns one turn's full diagnostic spine with the revision it ran on", async () => {
    const readTurn = vi.fn(async () => ({ testExecutionId: EXECUTION_ID, sideId: SIDE_ID, revision: candidateRevision, turn: turn() }));

    const output = await invoke(port({ readTurn }), "test_chat_turn_trace", { testExecutionId: EXECUTION_ID, turnId: TURN_ID });

    expect(readTurn).toHaveBeenCalledWith({ workspaceId: "workspace-1", agentId: AGENT_ID, testExecutionId: EXECUTION_ID, turnId: TURN_ID });
    expect(output.trace).toMatchObject({
      testExecutionId: EXECUTION_ID,
      sideId: SIDE_ID,
      revision: candidateRevision,
      turnId: TURN_ID,
      userMessage: "Can I book a demo?",
      answer: { messageId: MESSAGE_ID, content: "Sure, here is how." },
      state: "completed",
      failureCode: null,
    });
    expect(output.trace.turnTrace.spine.stages[1]).toEqual(expect.objectContaining({
      id: "routine_activation:book-a-demo",
      outputs: { reason: "no_trigger_match" },
    }));
  });

  it("bounds an oversized turn trace and says it did", async () => {
    const readTurn = vi.fn(async () => ({
      testExecutionId: EXECUTION_ID,
      sideId: SIDE_ID,
      revision: candidateRevision,
      turn: turn({ turnTrace: { ...envelope(400), summary: { note: "z".repeat(80_000) } } }),
    }));

    const output = await invoke(port({ readTurn }), "test_chat_turn_trace", { testExecutionId: EXECUTION_ID, turnId: TURN_ID, sideId: SIDE_ID });

    expect(readTurn).toHaveBeenCalledWith(expect.objectContaining({ sideId: SIDE_ID }));
    expect(JSON.stringify(output).length).toBeLessThan(60_000);
    expect(output.trace.truncation.truncated).toBe(true);
  });

  it("sends a message and returns the answer, outcome, and coarse stages", async () => {
    const sendMessage = vi.fn(port().sendMessage);

    const output = await invoke(port({ sendMessage }), "send_test_chat_message", { message: "Can I book a demo?", revisionId: CANDIDATE_ID });

    expect(sendMessage).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      agentId: AGENT_ID,
      message: "Can I book a demo?",
      revisionId: CANDIDATE_ID,
    });
    expect(output.turn).toMatchObject({
      testExecutionId: EXECUTION_ID,
      started: true,
      sideId: SIDE_ID,
      turnId: TURN_ID,
      outcome: "completed",
      answer: "Sure, here is how.",
    });
    expect(output.turn.stages).toHaveLength(3);
    expect(output.turn.stages[0]).toEqual({ id: "stage-0", kind: "compose", status: "applied" });
  });

  it("falls back to the agent the operator is looking at and refuses without one", async () => {
    const testChat = port();

    await invoke(testChat, "test_chat_sessions", {}, AGENT_ID);
    expect(testChat.listSessions).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT_ID }));

    await expect(invoke(testChat, "send_test_chat_message", { message: "hi" }, null)).rejects.toThrow(/agent/i);
    expect(testChat.sendMessage).not.toHaveBeenCalled();
  });
});

const revision = (overrides: Record<string, unknown> = {}) => ({
  id: CANDIDATE_ID,
  snapshot: {},
  sourceDraftGeneration: 4,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date("2026-09-20T09:59:00.000Z"),
  publishedAt: null,
  publishedVersion: null,
  ...overrides,
});

const historyEntry = (overrides: Record<string, unknown>) => ({
  turnId: TURN_ID,
  attemptId: "a0000000-0000-4000-8000-000000000001",
  role: "user" as const,
  content: "Can I book a demo?",
  createdAt: new Date("2026-09-20T10:00:00.000Z"),
  ...overrides,
});

const execution = (overrides: Record<string, unknown> = {}) => ({
  id: EXECUTION_ID,
  workspaceId: "workspace-1",
  agentId: AGENT_ID,
  mode: "single",
  generation: 2,
  state: "completed",
  testValues: [],
  skillEffects: "suppressed",
  createdAt: new Date("2026-09-20T10:00:00.000Z"),
  sides: [{
    id: SIDE_ID,
    executionId: EXECUTION_ID,
    revision: revision(),
    conversationId: "c1000000-0000-4000-8000-000000000001",
    state: "completed",
    retryable: false,
    continuation: null,
    history: [
      historyEntry({ turnId: GREETING_TURN_ID, role: "assistant", content: "Hi!", messageId: "bootstrap:1" }),
      historyEntry({}),
      historyEntry({ role: "assistant", content: "Sure, here is how.", messageId: MESSAGE_ID, turnTrace: envelope() }),
    ],
  }],
  ...overrides,
});

const attempt = (overrides: Record<string, unknown>) => ({
  executionId: EXECUTION_ID,
  sideId: SIDE_ID,
  turnId: TURN_ID,
  attemptId: "a0000000-0000-4000-8000-000000000001",
  fence: 1,
  state: "completed",
  failureCode: null,
  leaseExpiresAt: new Date("2026-09-20T10:05:00.000Z"),
  createdAt: new Date("2026-09-20T10:00:00.000Z"),
  updatedAt: new Date("2026-09-20T10:00:03.000Z"),
  ...overrides,
});

const completedEvents = (turnId: string) => [
  { type: "side_started", executionId: EXECUTION_ID, generation: 1, turnId, attemptId: "x", sideId: SIDE_ID },
  { type: "message_delta", executionId: EXECUTION_ID, generation: 1, turnId, attemptId: "x", sideId: SIDE_ID, delta: "Sure, here is how." },
  { type: "side_completed", executionId: EXECUTION_ID, generation: 1, turnId, attemptId: "x", sideId: SIDE_ID, messageId: MESSAGE_ID, turnTrace: envelope() },
  { type: "execution_completed", executionId: EXECUTION_ID, generation: 1, turnId, attemptId: "x" },
];

const serviceHarness = (options: {
  draftStatus?: "unpublished" | "draft_clean" | "draft_dirty" | "published_changed_since_draft";
  published?: boolean;
  detail?: ReturnType<typeof execution>;
  attempts?: ReturnType<typeof attempt>[];
  events?: (turnId: string) => unknown[];
  abuse?: () => Promise<unknown>;
} = {}) => {
  const calls: string[] = [];
  let nextId = 0;
  const createId = vi.fn(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`);
  const executions = {
    list: vi.fn(async () => ({
      executions: [{ id: EXECUTION_ID, mode: "single", generation: 2, state: "completed", createdAt: new Date("2026-09-20T10:00:00.000Z"), skillEffects: "suppressed", sides: [] }],
      nextCursor: "cursor-2",
      hasMore: true,
    })),
    detail: vi.fn(async () => {
      calls.push("detail");
      return { execution: options.detail ?? execution(), attempts: options.attempts ?? [attempt({})] };
    }),
    start: vi.fn(async (input: { revisionIds: readonly string[] }) => {
      calls.push("start");
      return execution({ generation: 1, sides: [{ ...execution().sides[0], revision: revision({ id: input.revisionIds[0] }), history: [] }] });
    }),
    message: vi.fn(async (input: { turnId: string }) => {
      calls.push("message");
      return (options.events ?? completedEvents)(input.turnId);
    }),
  } as unknown as CopilotTestChatExecutionPort;
  const revisions = {
    state: vi.fn(async () => {
      calls.push("state");
      return {
        agentId: AGENT_ID,
        status: options.draftStatus ?? "draft_dirty",
        draft: { generation: 7, basePublishedRevisionId: options.published === false ? null : PUBLISHED_ID, updatedAt: new Date() },
        publishedRevision: options.published === false ? null : revision({ id: PUBLISHED_ID, publishedAt: new Date("2026-09-01T00:00:00.000Z"), publishedVersion: 3 }),
        canPublish: true,
      };
    }),
    createCandidate: vi.fn(async () => {
      calls.push("createCandidate");
      return revision();
    }),
  } as unknown as CopilotTestChatRevisionPort;
  const abuseControl = {
    enforce: vi.fn(async () => {
      calls.push("guard");
      return options.abuse ? options.abuse() : admittedAbuseControlDecision();
    }),
  };
  const service = new TestChatService({
    executions,
    revisions,
    createId,
    abuseControl: abuseControl as never,
    audit: { record: vi.fn(async () => {}) },
    abusePolicy: { limit: 10, windowMs: 60_000 },
  });
  return { service, executions, revisions, abuseControl, calls };
};

const scope = { workspaceId: "workspace-1", agentId: AGENT_ID };
const sender = { ...scope, accountId: "account-1", operatorUserId: "operator-1" };

describe("TestChatService", () => {
  it("lists sessions from the executions the dashboard lists, with each one's message count and opening", async () => {
    const { service, executions } = serviceHarness();

    const page = await service.listSessions({ ...scope, limit: 5, cursor: "cursor-1" });

    expect(executions.list).toHaveBeenCalledWith({ ...scope, limit: 5, cursor: "cursor-1" });
    expect(executions.detail).toHaveBeenCalledWith({ ...scope, executionId: EXECUTION_ID });
    expect(page).toEqual({
      sessions: [{
        testExecutionId: EXECUTION_ID,
        mode: "single",
        state: "completed",
        skillEffects: "suppressed",
        createdAt: "2026-09-20T10:00:00.000Z",
        sides: [{ sideId: SIDE_ID, revision: candidateRevision, state: "completed" }],
        turnCount: 1,
        firstMessage: "Can I book a demo?",
      }],
      nextCursor: "cursor-2",
    });
  });

  it("reads a session as turns, naming the published version a side ran", async () => {
    const { service } = serviceHarness({
      detail: execution({ sides: [{ ...execution().sides[0], revision: revision({ id: PUBLISHED_ID, publishedAt: new Date("2026-09-01T00:00:00.000Z"), publishedVersion: 3 }) }] }),
    });

    const read = await service.readSession({ ...scope, testExecutionId: EXECUTION_ID });

    expect(read.sides[0].revision).toEqual({ id: PUBLISHED_ID, kind: "published", versionNumber: 3, createdAt: "2026-09-20T09:59:00.000Z" });
    expect(read.sides[0].turns).toEqual([
      { turnId: GREETING_TURN_ID, userMessage: null, answer: { messageId: "bootstrap:1", content: "Hi!" }, state: "completed", failureCode: null, createdAt: "2026-09-20T10:00:00.000Z", turnTrace: undefined },
      { turnId: TURN_ID, userMessage: "Can I book a demo?", answer: { messageId: MESSAGE_ID, content: "Sure, here is how." }, state: "completed", failureCode: null, createdAt: "2026-09-20T10:00:00.000Z", turnTrace: envelope() },
    ]);
  });

  it("reports an unanswered turn's state and failure code from its latest attempt", async () => {
    const detail = execution({ state: "partial", sides: [{ ...execution().sides[0], state: "failed", retryable: true, history: [historyEntry({})] }] });
    const { service } = serviceHarness({
      detail,
      attempts: [attempt({ fence: 1, state: "failed", failureCode: "lease_expired" }), attempt({ fence: 2, state: "failed", failureCode: "runner_failed" })],
    });

    const read = await service.readSession({ ...scope, testExecutionId: EXECUTION_ID });

    expect(read.sides[0].turns[0]).toMatchObject({ answer: null, state: "failed", failureCode: "runner_failed" });
  });

  it("reads one turn, defaulting to the first side, and refuses an unknown turn or side as not found", async () => {
    const { service } = serviceHarness();

    await expect(service.readTurn({ ...scope, testExecutionId: EXECUTION_ID, turnId: TURN_ID })).resolves.toMatchObject({
      sideId: SIDE_ID,
      turn: { turnId: TURN_ID, turnTrace: envelope() },
    });
    await expect(service.readTurn({ ...scope, testExecutionId: EXECUTION_ID, turnId: "70000000-0000-4000-8000-00000000ffff" }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(service.readTurn({ ...scope, testExecutionId: EXECUTION_ID, turnId: TURN_ID, sideId: OTHER_SIDE_ID }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("starts a session on a fresh candidate of a changed draft, exactly as the dashboard does", async () => {
    const { service, executions, revisions, calls } = serviceHarness({ draftStatus: "draft_dirty" });

    const result = await service.sendMessage({ ...sender, message: "  Can I book a demo?  " });

    expect(revisions.createCandidate).toHaveBeenCalledWith("workspace-1", AGENT_ID, 7);
    expect(executions.start).toHaveBeenCalledWith(expect.objectContaining({
      ...scope,
      accountId: "account-1",
      mode: "single",
      revisionIds: [CANDIDATE_ID],
      testValues: [],
      expectedDraftGeneration: 7,
      skillEffects: "suppressed",
      idempotencyKey: expect.any(String),
    }));
    expect(executions.message).toHaveBeenCalledWith(expect.objectContaining({
      ...scope,
      accountId: "account-1",
      executionId: EXECUTION_ID,
      message: "Can I book a demo?",
      generation: 1,
      turnId: result.turnId,
      attemptId: expect.any(String),
    }));
    expect(calls).toEqual(["guard", "state", "createCandidate", "start", "message"]);
    expect(result).toEqual({
      testExecutionId: EXECUTION_ID,
      started: true,
      sideId: SIDE_ID,
      revision: candidateRevision,
      turnId: result.turnId,
      outcome: "completed",
      failureCode: null,
      answer: "Sure, here is how.",
      messageId: MESSAGE_ID,
      turnTrace: envelope(),
    });
  });

  it("starts on the published revision when the saved draft has no changes", async () => {
    const { service, executions, revisions } = serviceHarness({ draftStatus: "draft_clean" });

    await service.sendMessage({ ...sender, message: "hi" });

    expect(revisions.createCandidate).not.toHaveBeenCalled();
    expect(executions.start).toHaveBeenCalledWith(expect.objectContaining({ revisionIds: [PUBLISHED_ID], expectedDraftGeneration: 7 }));
  });

  it("starts on the candidate of a clean draft that was never published", async () => {
    const { service, revisions } = serviceHarness({ draftStatus: "draft_clean", published: false });

    await service.sendMessage({ ...sender, message: "hi" });

    expect(revisions.createCandidate).toHaveBeenCalled();
  });

  it("starts on a named revision without touching the draft", async () => {
    const { service, executions, revisions } = serviceHarness();

    await service.sendMessage({ ...sender, message: "hi", revisionId: PUBLISHED_ID });

    expect(revisions.state).not.toHaveBeenCalled();
    expect(executions.start).toHaveBeenCalledWith(expect.objectContaining({ revisionIds: [PUBLISHED_ID], skillEffects: "suppressed" }));
    expect(executions.start).toHaveBeenCalledWith(expect.not.objectContaining({ expectedDraftGeneration: expect.anything() }));
  });

  it("continues a session at its current generation", async () => {
    const { service, executions, calls } = serviceHarness();

    const result = await service.sendMessage({ ...sender, message: "and on Friday?", testExecutionId: EXECUTION_ID });

    expect(executions.start).not.toHaveBeenCalled();
    expect(executions.message).toHaveBeenCalledWith(expect.objectContaining({ executionId: EXECUTION_ID, generation: 2 }));
    expect(calls).toEqual(["detail", "guard", "message"]);
    expect(result.started).toBe(false);
  });

  it("refuses to continue a comparison or a session whose skills act, before spending anything", async () => {
    for (const detail of [execution({ mode: "compare" }), execution({ skillEffects: "allowed" })]) {
      const { service, executions, abuseControl } = serviceHarness({ detail });

      await expect(service.sendMessage({ ...sender, message: "hi", testExecutionId: EXECUTION_ID }))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(abuseControl.enforce).not.toHaveBeenCalled();
      expect(executions.message).not.toHaveBeenCalled();
    }
  });

  it("refuses a revision for a session that already has one", async () => {
    const { service, executions } = serviceHarness();

    await expect(service.sendMessage({ ...sender, message: "hi", testExecutionId: EXECUTION_ID, revisionId: PUBLISHED_ID }))
      .rejects.toBeInstanceOf(AppError);
    expect(executions.detail).not.toHaveBeenCalled();
  });

  it("starts nothing once the operator's expensive-operation budget is spent", async () => {
    const { service, executions, revisions } = serviceHarness({
      abuse: async () => { throw new AppError(429, "rate_limit_exceeded", "Please wait", { retryAfterSeconds: 12 }); },
    });

    await expect(service.sendMessage({ ...sender, message: "hi" })).rejects.toBeInstanceOf(CopilotExpensiveOperationRateLimitedError);
    expect(revisions.state).not.toHaveBeenCalled();
    expect(executions.start).not.toHaveBeenCalled();
  });

  it("returns a failed turn with its code, and refuses an exhausted answer allowance the way other probes do", async () => {
    const failed = (code: string) => (turnId: string) => [
      { type: "side_started", executionId: EXECUTION_ID, generation: 1, turnId, attemptId: "x", sideId: SIDE_ID },
      { type: "side_failed", executionId: EXECUTION_ID, generation: 1, turnId, attemptId: "x", sideId: SIDE_ID, code, retryable: true },
      { type: "execution_partial", executionId: EXECUTION_ID, generation: 1, turnId, attemptId: "x" },
    ];

    const runnerFailed = await serviceHarness({ events: failed("runner_failed") }).service.sendMessage({ ...sender, message: "hi" });
    expect(runnerFailed).toMatchObject({ outcome: "failed", failureCode: "runner_failed", answer: null, messageId: null });

    await expect(serviceHarness({ events: failed(USAGE_LIMIT_EXCEEDED_CODE) }).service.sendMessage({ ...sender, message: "hi" }))
      .rejects.toBeInstanceOf(CopilotUsageLimitReachedError);
  });
});
