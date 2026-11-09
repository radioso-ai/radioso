import { describe, expect, it, vi } from "vitest";

import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { AgentConverseService } from "../../src/modules/chat/services/agentConverseService.js";
import type { AgentConversePrincipal } from "../../src/modules/settings/contracts/agentConverseSession.js";
import type { AgentConverseTurnResult } from "../../src/modules/chat/contracts/index.js";
import type { ChatResponse } from "../../src/modules/chat/types/chatResponses.js";
import type { AgentToolCatalogPort } from "../../src/modules/chat/contracts/routineInvocation.js";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

const chatResponse = (): ChatResponse => ({
  conversationId: "conversation-1",
  assistantMessageId: "message-1",
  route: { type: "direct", reason: "social_only" },
  answer: "ok",
  citations: [],
  activitySummary: {},
  activityTrace: {
    traceId: "trace-1",
    startedAt: "2026-08-26T00:00:00.000Z",
    stages: [],
    links: [],
  },
});

const principal: AgentConversePrincipal = {
  workspaceId: "workspace-1",
  agentId: "agent-1",
  origin: { kind: "grant", grantId: "grant-1", grantVersion: "grant-version-1" },
  publicSessionId: "session-1",
  sourceChannel: "mcp",
  sourceOrigin: null,
  authPrincipal: {
    type: "public_chat_session",
    role: "agent",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    publicSessionId: "session-1",
  },
};

const startReturnCatalog = () => ({
  load: vi.fn<AgentToolCatalogPort["load"]>(async () => ({
    agent: { name: "Support", description: null },
    askAgentDescription: "Hold a conversation with Support.",
    tools: [{
      toolName: "start_return",
      description: "Start a return.",
      routineLineageId: "lineage-1",
      inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"], additionalProperties: false },
    }],
  })),
});

describe("AgentConverseService", () => {
  it("publishes MCP conversation.created only for the create-once result", async () => {
    const publisher: WorkspaceInvalidationPublisher = {
      enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })),
    };
    const getOrCreateByAnonymousSession = vi.fn()
      .mockResolvedValueOnce({ record: { id: "conversation-1", agentRevisionId: null }, created: true })
      .mockResolvedValueOnce({ record: { id: "conversation-1", agentRevisionId: "revision-1" }, created: false });
    const service = new AgentConverseService({
      conversationRepository: { getOrCreateByAnonymousSession },
      assistantChatService: { answer: vi.fn(async () => chatResponse()) },
      agentToolCatalog: startReturnCatalog(),
      publisher,
    });

    await service.askAgent(principal, { message: "first" });
    await service.askAgent(principal, { message: "second" });

    expect(publisher.enqueue).toHaveBeenCalledTimes(1);
    expect(publisher.enqueue).toHaveBeenCalledWith("workspace-1", ["conversation.created"]);
  });

  it("resolves a tool call against the release the bound conversation is pinned to, before any turn runs", async () => {
    const answer = vi.fn(async () => chatResponse());
    const catalog = startReturnCatalog();
    const service = new AgentConverseService({
      conversationRepository: {
        getOrCreateByAnonymousSession: vi.fn(async () => ({
          record: { id: "conversation-1", agentRevisionId: "revision-v1" },
          created: false,
        })),
      },
      assistantChatService: { answer },
      agentToolCatalog: catalog,
    });

    const result = await service.askAgent(principal, { routine: { toolName: "start_return", input: { orderId: "A-1" } } });

    expect(catalog.load).toHaveBeenCalledWith({ workspaceId: "workspace-1", agentId: "agent-1", agentRevisionId: "revision-v1" });
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({
      routineInvocation: { toolName: "start_return", input: { orderId: "A-1" } },
      conversationId: "conversation-1",
    }));
    expect(result.reply.conversationId).toBe("session-1");
  });

  it("answers routine_tool_unknown from the pinned release and records no turn", async () => {
    const answer = vi.fn(async () => chatResponse());
    const catalog = startReturnCatalog();
    catalog.load.mockResolvedValueOnce({ agent: { name: "Support", description: null }, askAgentDescription: "Hold a conversation with Support.", tools: [] });
    const audit = { recordAskOutcome: vi.fn(async () => {}) };
    const service = new AgentConverseService({
      conversationRepository: {
        getOrCreateByAnonymousSession: vi.fn(async () => ({
          record: { id: "conversation-1", agentRevisionId: "revision-v1" },
          created: false,
        })),
      },
      assistantChatService: { answer },
      agentToolCatalog: catalog,
      audit: audit as never,
    });

    await expect(service.askAgent(principal, { routine: { toolName: "start_return", input: { orderId: "A-1" } } }))
      .rejects.toMatchObject({ statusCode: 404, details: { code: "routine_tool_unknown", toolName: "start_return" } });

    expect(answer).not.toHaveBeenCalled();
    expect(audit.recordAskOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "failure" }));
  });

  it("resolves against the current release for a conversation not yet pinned", async () => {
    const catalog = startReturnCatalog();
    const service = new AgentConverseService({
      conversationRepository: {
        getOrCreateByAnonymousSession: vi.fn(async () => ({ record: { id: "conversation-1", agentRevisionId: null }, created: true })),
      },
      assistantChatService: { answer: vi.fn(async () => chatResponse()) },
      agentToolCatalog: catalog,
    });

    await service.askAgent(principal, { routine: { toolName: "start_return", input: { orderId: "A-1" } } });

    expect(catalog.load).toHaveBeenCalledWith({ workspaceId: "workspace-1", agentId: "agent-1" });
  });

  it("runs an A2A principal's turn on the a2a channel end to end: conversation, turn, audit, and metric", async () => {
    const getOrCreateByAnonymousSession = vi.fn(async () => ({ record: { id: "conversation-1", agentRevisionId: null }, created: true }));
    const answer = vi.fn(async () => chatResponse());
    const audit = { recordAskOutcome: vi.fn(async () => {}) };
    const metrics = new MetricsRegistry();
    const service = new AgentConverseService({
      conversationRepository: { getOrCreateByAnonymousSession },
      assistantChatService: { answer },
      agentToolCatalog: startReturnCatalog(),
      audit: audit as never,
      metrics,
    });

    await service.askAgent({ ...principal, sourceChannel: "a2a" }, { message: "hello" });

    expect(getOrCreateByAnonymousSession).toHaveBeenCalledWith(expect.objectContaining({ sourceChannel: "a2a" }));
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ sourceChannel: "a2a" }));
    expect(audit.recordAskOutcome).toHaveBeenCalledWith(expect.objectContaining({ sourceChannel: "a2a", status: "success" }));
    expect(metrics.renderPrometheus()).toContain('radioso_converse_turns_total{channel="a2a",input_kind="message"} 1');
  });

  it("keeps an MCP principal's turn on the mcp channel", async () => {
    const getOrCreateByAnonymousSession = vi.fn(async () => ({ record: { id: "conversation-1", agentRevisionId: null }, created: true }));
    const answer = vi.fn(async () => chatResponse());
    const service = new AgentConverseService({
      conversationRepository: { getOrCreateByAnonymousSession },
      assistantChatService: { answer },
      agentToolCatalog: startReturnCatalog(),
    });

    await service.askAgent(principal, { message: "hello" });

    expect(getOrCreateByAnonymousSession).toHaveBeenCalledWith(expect.objectContaining({ sourceChannel: "mcp" }));
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ sourceChannel: "mcp" }));
  });

  it("hands an in-process caller the routine run beside the reply, never inside it", async () => {
    const service = new AgentConverseService({
      conversationRepository: {
        getOrCreateByAnonymousSession: vi.fn(async () => ({ record: { id: "conversation-1", agentRevisionId: null }, created: false })),
      },
      assistantChatService: {
        answer: vi.fn(async () => ({
          ...chatResponse(),
          routine: { name: "Returns", status: "waiting_for_input" as const, pendingInput: [] },
          routineExecutionId: "execution-1",
        })),
      },
      agentToolCatalog: startReturnCatalog(),
    });

    const result: AgentConverseTurnResult = await service.askAgent(principal, { message: "I want to return an order" });

    expect(result.routineExecutionId).toBe("execution-1");
    expect(result.reply.routine).toEqual({ name: "Returns", status: "waiting_for_input", pendingInput: [] });
    expect(JSON.stringify(result.reply)).not.toContain("execution-1");
    expect(result.reply).not.toHaveProperty("routineExecutionId");
  });

  it("hands an in-process caller the conversation the turn ran in, never inside the reply", async () => {
    const service = new AgentConverseService({
      conversationRepository: {
        getOrCreateByAnonymousSession: vi.fn(async () => ({ record: { id: "conversation-row-7", agentRevisionId: null }, created: true })),
      },
      assistantChatService: { answer: vi.fn(async () => chatResponse()) },
      agentToolCatalog: startReturnCatalog(),
    });

    const result = await service.askAgent(principal, { message: "hello" });

    expect(result.conversationId).toBe("conversation-row-7");
    // The reply names the caller's own handle, the public session id, never the row.
    expect(result.reply.conversationId).toBe("session-1");
    expect(JSON.stringify(result.reply)).not.toContain("conversation-row-7");
  });

  it("hands an in-process caller the turn's own request and reply message ids, never inside the reply", async () => {
    const answer = vi.fn(async () => ({ ...chatResponse(), assistantMessageId: "reply-1", requestMessageId: "request-1" }));
    const service = new AgentConverseService({
      conversationRepository: {
        getOrCreateByAnonymousSession: vi.fn(async () => ({ record: { id: "conversation-1", agentRevisionId: null }, created: false })),
      },
      assistantChatService: { answer },
      agentToolCatalog: startReturnCatalog(),
    });

    const result = await service.askAgent(principal, { message: "hello" });

    expect(result).toMatchObject({ requestMessageId: "request-1", replyMessageId: "reply-1" });
    expect(JSON.stringify(result.reply)).not.toContain("request-1");
    expect(JSON.stringify(result.reply)).not.toContain("reply-1");

    // A person owns the thread: the caller's message is stored and no reply is generated.
    answer.mockResolvedValueOnce({ ...chatResponse(), assistantMessageId: "", requestMessageId: "request-2" });
    expect(await service.askAgent(principal, { message: "hello again" })).toMatchObject({ requestMessageId: "request-2", replyMessageId: null });
  });

  it("reports no routine run when the turn touched none", async () => {
    const service = new AgentConverseService({
      conversationRepository: {
        getOrCreateByAnonymousSession: vi.fn(async () => ({ record: { id: "conversation-1", agentRevisionId: null }, created: false })),
      },
      assistantChatService: { answer: vi.fn(async () => chatResponse()) },
      agentToolCatalog: startReturnCatalog(),
    });

    const result = await service.askAgent(principal, { message: "hello" });

    expect(result.routineExecutionId).toBeNull();
  });
});
