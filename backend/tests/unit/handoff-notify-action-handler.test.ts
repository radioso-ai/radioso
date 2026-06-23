import { describe, expect, it, vi } from "vitest";

import { HandoffNotifyActionHandler } from "../../src/modules/chat/services/actions/handoffNotifyActionHandler.js";
import type { OperatorNotificationDispatcher } from "../../src/modules/operatorNotifications/public.js";

const context = {
  requestId: "request_1",
  workspaceId: "ws_1",
  accountId: null,
  conversationId: "conv_1",
  idempotencyKey: "routine-action:conv_1:handoff.notify",
  attempt: 1,
};

describe("HandoffNotifyActionHandler", () => {
  it("dispatches a handoff operator notification", async () => {
    const dispatch = vi.fn<OperatorNotificationDispatcher["dispatch"]>();
    dispatch.mockResolvedValue();
    const handler = new HandoffNotifyActionHandler({ dispatch });

    await handler.handle({
      payload: {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        agentId: "agent_1",
        reason: "routine_handoff",
        dashboardPath: "/conversations/conv_1",
      },
      context,
    });

    expect(dispatch).toHaveBeenCalledWith({
      kind: "handoff",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "agent_1",
      reason: "routine_handoff",
      dashboardPath: "/conversations/conv_1",
    }, {
      requestId: "request_1",
      workspaceId: "ws_1",
      accountId: null,
      conversationId: "conv_1",
      idempotencyKey: "routine-action:conv_1:handoff.notify",
      attempt: 1,
    });
  });

  it("falls back to context and defaults for missing payload fields", async () => {
    const dispatch = vi.fn<OperatorNotificationDispatcher["dispatch"]>();
    dispatch.mockResolvedValue();
    const handler = new HandoffNotifyActionHandler({ dispatch });

    await handler.handle({ payload: {}, context });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "handoff",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "unknown",
      reason: "routine_handoff",
      dashboardPath: "/conversations/conv_1",
    }), expect.any(Object));
  });
});
