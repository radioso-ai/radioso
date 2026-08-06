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
  it("dispatches an approval operator notification", async () => {
    const dispatch = vi.fn(async () => {});
    const handler = new ApprovalRequestActionHandler({ dispatch });

    await handler.handle({
      payload: {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        agentId: "agent_1",
        handle: "pd_abc",
        dashboardPath: "/conversations/conv_1",
      },
      context,
    });

    expect(dispatch).toHaveBeenCalledWith({
      kind: "approval",
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      handle: "pd_abc",
      dashboardPath: "/conversations/conv_1",
    }, {
      requestId: "request_1",
      workspaceId: "ws_1",
      accountId: null,
      conversationId: "conv_1",
      idempotencyKey: "routine-action:conv_1:approval.request",
      attempt: 1,
    });
  });

  it("falls back to context values and a conversation dashboard path", async () => {
    const dispatch = vi.fn(async () => {});
    const handler = new ApprovalRequestActionHandler({ dispatch });

    await handler.handle({ payload: {}, context });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "approval",
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "unknown",
      handle: "unknown",
      dashboardPath: "/conversations/conv_1",
    }), expect.any(Object));
  });
});
