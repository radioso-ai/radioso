import { describe, expect, it, vi } from "vitest";

import { AgentConverseService } from "../../src/modules/chat/services/agentConverseService.js";
import type { AgentConversePrincipal } from "../../src/modules/settings/contracts/agentConverseSession.js";
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
  grantId: "grant-1",
  grantVersion: "grant-version-1",
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
    expect(result.conversationId).toBe("session-1");
  });

  it("answers routine_tool_unknown from the pinned release and records no turn", async () => {
    const answer = vi.fn(async () => chatResponse());
    const catalog = startReturnCatalog();
    catalog.load.mockResolvedValueOnce({ agent: { name: "Support", description: null }, tools: [] });
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
});
