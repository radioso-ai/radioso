import { describe, expect, it, vi } from "vitest";

import { RoutineEndingNotifyActionHandler } from "../../src/modules/chat/services/actions/routineEndingNotifyActionHandler.js";
import { ROUTINE_ENDING_NOTICE_ACTIONS } from "../../src/modules/chat/services/operatorNoticeAction.js";
import {
  formatRoutineEndingNotification,
  type OperatorNotificationDispatcher,
  type RoutineEndingOperatorNotification,
} from "../../src/modules/operatorNotifications/public.js";

const context = {
  requestId: "request_1",
  workspaceId: "ws_1",
  accountId: null,
  conversationId: "conv_1",
  idempotencyKey: "routine-action:conv_1:handoff.notify",
  attempt: 1,
  skillName: null,
};

describe("RoutineEndingNotifyActionHandler", () => {
  it("dispatches a handoff operator notification", async () => {
    const dispatch = vi.fn<OperatorNotificationDispatcher["dispatch"]>();
    dispatch.mockResolvedValue();
    const handler = new RoutineEndingNotifyActionHandler({ ending: ROUTINE_ENDING_NOTICE_ACTIONS.handoff, dispatcher: { dispatch } });

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
    const handler = new RoutineEndingNotifyActionHandler({ ending: ROUTINE_ENDING_NOTICE_ACTIONS.handoff, dispatcher: { dispatch }, subjects: { resolve } });

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

    expect(resolve).toHaveBeenCalledWith({ workspaceId: "ws_1", agentId: "agent_1", routineId: "routine_1", conversationId: "conv_1" });
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
    const handler = new RoutineEndingNotifyActionHandler({
      ending: ROUTINE_ENDING_NOTICE_ACTIONS.handoff,
      dispatcher: { dispatch },
      subjects: { resolve: async () => ({ agentName: null, routineName: null }) },
    });

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
    const handler = new RoutineEndingNotifyActionHandler({ ending: ROUTINE_ENDING_NOTICE_ACTIONS.handoff, dispatcher: { dispatch }, subjects: { resolve } });

    await handler.handle({
      payload: { conversationId: "conv_1", workspaceId: "ws_1", agentId: "agent_1", reason: "retrieval_miss" },
      context,
    });

    expect(resolve).toHaveBeenCalledWith({ workspaceId: "ws_1", agentId: "agent_1", routineId: null, conversationId: "conv_1" });
    const notification = dispatch.mock.calls[0][0];
    expect(notification).toEqual(expect.objectContaining({ reason: "retrieval_miss", agentName: "Retreat desk" }));
    expect(notification).not.toHaveProperty("routine");
    expect(notification).not.toHaveProperty("collected");
  });

  it.each([
    ["handoff", ROUTINE_ENDING_NOTICE_ACTIONS.handoff, "routine_handoff"],
    ["completion", ROUTINE_ENDING_NOTICE_ACTIONS.complete, "routine_completed"],
  ] as const)("falls back to context and its ending's defaults for missing payload fields (%s)", async (kind, ending, reason) => {
    const dispatch = vi.fn<OperatorNotificationDispatcher["dispatch"]>();
    dispatch.mockResolvedValue();
    const handler = new RoutineEndingNotifyActionHandler({ ending, dispatcher: { dispatch } });

    await handler.handle({ payload: {}, context });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind,
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "unknown",
      reason,
    }), expect.any(Object));
  });

  it("dispatches a completion notice with its authored text and the conversation facts, never touching ownership", async () => {
    const dispatch = vi.fn<OperatorNotificationDispatcher["dispatch"]>();
    dispatch.mockResolvedValue();
    const resolve = vi.fn(async () => ({
      agentName: "Retreat desk",
      routineName: "Book accommodation",
      conversation: { channel: "embed", entryPageUrl: "https://ananda.example/stays" },
    }));
    const handler = new RoutineEndingNotifyActionHandler({ ending: ROUTINE_ENDING_NOTICE_ACTIONS.complete, dispatcher: { dispatch }, subjects: { resolve } });

    await handler.handle({
      payload: {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        agentId: "agent_1",
        reason: "routine_completed",
        routineId: "routine_1",
        stepId: "done",
        collected: { name: "Ada" },
        notice: { subject: "Booking: {{slot.name}}" },
      },
      context: { ...context, idempotencyKey: "routine-action:conv_1:completion.notify" },
    });

    expect(dispatch).toHaveBeenCalledWith({
      kind: "completion",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "agent_1",
      reason: "routine_completed",
      agentName: "Retreat desk",
      routine: { id: "routine_1", name: "Book accommodation" },
      collected: { name: "Ada" },
      notice: { subject: "Booking: {{slot.name}}" },
      conversation: { channel: "embed", entryPageUrl: "https://ananda.example/stays" },
    }, expect.objectContaining({ idempotencyKey: "routine-action:conv_1:completion.notify" }));
  });

  it("delivers the collected values in the order the routine declares its slots, whatever order the queue stored them in", async () => {
    const dispatch = vi.fn<OperatorNotificationDispatcher["dispatch"]>();
    dispatch.mockResolvedValue();
    const resolve = vi.fn(async () => ({
      agentName: null,
      routineName: "Book accommodation",
      routineSlotKeys: ["guest_name", "arrival_date", "nights"],
    }));
    const handler = new RoutineEndingNotifyActionHandler({ ending: ROUTINE_ENDING_NOTICE_ACTIONS.complete, dispatcher: { dispatch }, subjects: { resolve } });

    await handler.handle({
      payload: {
        agentId: "agent_1",
        routineId: "routine_1",
        // The order jsonb hands the payload back in: shorter keys first.
        collected: { nights: 3, guest_name: "Ada", arrival_date: "2026-10-12" },
      },
      context,
    });

    const notification = dispatch.mock.calls[0][0] as RoutineEndingOperatorNotification;
    const lines = formatRoutineEndingNotification(notification).lines;
    expect(lines.slice(lines.indexOf("Collected:") + 1)).toEqual([
      "  Guest name: Ada",
      "  Arrival date: 2026-10-12",
      "  Nights: 3",
    ]);
    expect(JSON.stringify(notification.collected)).toBe('{"guest_name":"Ada","arrival_date":"2026-10-12","nights":3}');
  });
});
