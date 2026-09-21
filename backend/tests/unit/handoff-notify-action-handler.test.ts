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
  skillName: null,
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
      },
      context,
    });

    expect(dispatch).toHaveBeenCalledWith({
      kind: "handoff",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "agent_1",
      reason: "routine_handoff",
    }, {
      requestId: "request_1",
      workspaceId: "ws_1",
      accountId: null,
      conversationId: "conv_1",
      idempotencyKey: "routine-action:conv_1:handoff.notify",
      attempt: 1,
    });
  });

  it("forwards the routine id, resolved names, and the scalar collected values", async () => {
    const dispatch = vi.fn<OperatorNotificationDispatcher["dispatch"]>();
    dispatch.mockResolvedValue();
    const resolve = vi.fn(async () => ({ agentName: "Retreat desk", routineName: "Book accommodation" }));
    const handler = new HandoffNotifyActionHandler({ dispatch }, { resolve });

    await handler.handle({
      payload: {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        agentId: "agent_1",
        reason: "routine_handoff",
        routineId: "routine_1",
        stepId: "handoff",
        collected: {
          program: "Yoga retreat",
          guests: 2,
          needs_transfer: true,
          notes: null,
          preferences: { room: "single" },
          dates: ["2026-10-12"],
        },
      },
      context,
    });

    expect(resolve).toHaveBeenCalledWith({ workspaceId: "ws_1", agentId: "agent_1", routineId: "routine_1" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "handoff",
      agentName: "Retreat desk",
      routine: { id: "routine_1", name: "Book accommodation" },
      collected: { program: "Yoga retreat", guests: 2, needs_transfer: true },
    }), expect.any(Object));
  });

  it("dispatches with null names when the resolver finds nothing", async () => {
    const dispatch = vi.fn<OperatorNotificationDispatcher["dispatch"]>();
    dispatch.mockResolvedValue();
    const handler = new HandoffNotifyActionHandler(
      { dispatch },
      { resolve: async () => ({ agentName: null, routineName: null }) },
    );

    await handler.handle({
      payload: { conversationId: "conv_1", workspaceId: "ws_1", agentId: "agent_1", routineId: "routine_1" },
      context,
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      agentName: null,
      routine: { id: "routine_1", name: null },
    }), expect.any(Object));
  });

  it("omits the routine when the payload carries none (retrieval miss)", async () => {
    const dispatch = vi.fn<OperatorNotificationDispatcher["dispatch"]>();
    dispatch.mockResolvedValue();
    const resolve = vi.fn(async () => ({ agentName: "Retreat desk", routineName: null }));
    const handler = new HandoffNotifyActionHandler({ dispatch }, { resolve });

    await handler.handle({
      payload: { conversationId: "conv_1", workspaceId: "ws_1", agentId: "agent_1", reason: "retrieval_miss" },
      context,
    });

    expect(resolve).toHaveBeenCalledWith({ workspaceId: "ws_1", agentId: "agent_1", routineId: null });
    const notification = dispatch.mock.calls[0][0];
    expect(notification).toEqual(expect.objectContaining({ reason: "retrieval_miss", agentName: "Retreat desk" }));
    expect(notification).not.toHaveProperty("routine");
    expect(notification).not.toHaveProperty("collected");
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
    }), expect.any(Object));
  });
});
