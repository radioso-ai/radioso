import { describe, expect, it } from "vitest";

import { handoffNotificationFromAction } from "../../../src/modules/operatorNotifications/public.js";

const fallback = { conversationId: "conv_1", workspaceId: "ws_1" };

describe("handoffNotificationFromAction", () => {
  it("builds a handoff notification from a handoff.notify action payload", () => {
    const notification = handoffNotificationFromAction({
      payload: {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        agentId: "agent_1",
        reason: "routine_handoff",
        routineId: "routine_1",
        collected: { program: "Yoga retreat", guests: 2, needs_transfer: true, notes: null, preferences: { room: "single" } },
      },
      fallback,
      subject: { agentName: "Retreat desk", routineName: "Book accommodation" },
    });

    expect(notification).toEqual({
      kind: "handoff",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "agent_1",
      reason: "routine_handoff",
      agentName: "Retreat desk",
      routine: { id: "routine_1", name: "Book accommodation" },
      collected: { program: "Yoga retreat", guests: 2, needs_transfer: true },
    });
  });

  it("omits routine and collected when the payload carries neither (a retrieval-miss handoff)", () => {
    const notification = handoffNotificationFromAction({
      payload: { conversationId: "conv_1", workspaceId: "ws_1", agentId: "agent_1", reason: "retrieval_miss" },
      fallback,
    });

    expect(notification).toEqual({
      kind: "handoff",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "agent_1",
      reason: "retrieval_miss",
    });
  });

  it("falls back to the given conversation/workspace and defaults for missing payload fields", () => {
    const notification = handoffNotificationFromAction({ payload: {}, fallback });

    expect(notification).toEqual({
      kind: "handoff",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "unknown",
      reason: "routine_handoff",
    });
  });

  it("reports null names when no subject is given, matching an unresolved DB lookup", () => {
    const notification = handoffNotificationFromAction({
      payload: { conversationId: "conv_1", workspaceId: "ws_1", agentId: "agent_1", routineId: "routine_1" },
      fallback,
      subject: { agentName: null, routineName: null },
    });

    expect(notification).toEqual(expect.objectContaining({
      agentName: null,
      routine: { id: "routine_1", name: null },
    }));
  });
});
