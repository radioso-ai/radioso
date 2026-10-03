import { describe, expect, it, vi } from "vitest";

import { ApprovalRequestActionHandler } from "../../src/modules/chat/services/actions/approvalRequestActionHandler.js";

const context = {
  requestId: "request_1",
  workspaceId: "ws_1",
  accountId: null,
  conversationId: "conv_1",
  idempotencyKey: "routine-action:conv_1:approval.request",
  attempt: 1,
  skillName: null,
};

describe("ApprovalRequestActionHandler", () => {
  it("does not trust workspace, conversation, or agent ids from an approval payload", async () => {
    const dispatch = vi.fn(async () => {});
    const conversations = { findByIdAndWorkspaceId: vi.fn(async () => ({ agentId: "agent_from_conversation" })) };
    const handler = new ApprovalRequestActionHandler({ dispatch }, conversations);

    await handler.handle({
      payload: {
        conversationId: "visitor_filled_conv",
        workspaceId: "visitor_filled_ws",
        agentId: "visitor_filled_agent",
        handle: "pd_abc",
      },
      context,
    });

    expect(dispatch).toHaveBeenCalledWith({
      kind: "approval",
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_from_conversation",
      handle: "pd_abc",
    }, {
      requestId: "request_1",
      workspaceId: "ws_1",
      accountId: null,
      conversationId: "conv_1",
      idempotencyKey: "routine-action:conv_1:approval.request",
      attempt: 1,
    });
    expect(conversations.findByIdAndWorkspaceId).toHaveBeenCalledWith("conv_1", "ws_1");
  });

  it("does not query a conversation when the queued row lacks a conversation id", async () => {
    const dispatch = vi.fn(async () => {});
    const conversations = { findByIdAndWorkspaceId: vi.fn(async () => ({ agentId: "agent_1" })) };
    const handler = new ApprovalRequestActionHandler({ dispatch }, conversations);

    await handler.handle({ payload: {}, context: { ...context, conversationId: null } });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "approval",
      conversationId: "unknown",
      workspaceId: "ws_1",
      agentId: "unknown",
      handle: "unknown",
    }), expect.any(Object));
    expect(conversations.findByIdAndWorkspaceId).not.toHaveBeenCalled();
  });
});
