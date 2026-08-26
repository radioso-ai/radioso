import { describe, expect, it, vi } from "vitest";

import { AgentConverseService } from "../../src/modules/chat/services/agentConverseService.js";
import type { AgentConversePrincipal } from "../../src/modules/settings/contracts/agentConverseSession.js";
import type { ChatResponse } from "../../src/modules/chat/types/chatResponses.js";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

describe("AgentConverseService conversation publisher seam", () => {
  it("publishes MCP conversation.created only for the create-once result", async () => {
    const publisher: WorkspaceInvalidationPublisher = {
      enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })),
    };
    const getOrCreateByAnonymousSession = vi.fn()
      .mockResolvedValueOnce({ record: { id: "conversation-1" }, created: true })
      .mockResolvedValueOnce({ record: { id: "conversation-1" }, created: false });
    const service = new AgentConverseService({
      conversationRepository: { getOrCreateByAnonymousSession },
      assistantChatService: {
        answer: vi.fn(async () => ({
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
        } satisfies ChatResponse)),
      },
      publisher,
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

    await service.askAgent(principal, { message: "first" });
    await service.askAgent(principal, { message: "second" });

    expect(publisher.enqueue).toHaveBeenCalledTimes(1);
    expect(publisher.enqueue).toHaveBeenCalledWith("workspace-1", ["conversation.created"]);
  });
});
