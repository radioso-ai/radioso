import { describe, expect, it } from "vitest";

import { routineEndingNotificationFromAction } from "../../../src/modules/operatorNotifications/public.js";

const fallback = { conversationId: "conv_1", workspaceId: "ws_1", reason: "routine_handoff" };

describe("routineEndingNotificationFromAction", () => {
  it("builds a handoff notification from a handoff.notify action payload", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "handoff",
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

  // jsonb reorders an object's keys (shorter keys first), so a queued payload's `collected`
  // reads back out of the order the routine declares its slots in.
  const storedCollected = { nights: 3, guest_name: "Ada", arrival_date: "2026-10-12" };

  it("lists the collected values in the routine's declared slot order, not the order they were stored in", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "completion",
      payload: { agentId: "agent_1", routineId: "routine_1", collected: storedCollected },
      fallback,
      subject: {
        agentName: null,
        routineName: "Book accommodation",
        routineSlotKeys: ["guest_name", "arrival_date", "room_type", "nights"],
      },
    });

    expect(Object.keys(notification.collected ?? {})).toEqual(["guest_name", "arrival_date", "nights"]);
  });

  it("keeps a value the routine no longer declares, after the declared ones", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "completion",
      payload: { agentId: "agent_1", routineId: "routine_1", collected: storedCollected },
      fallback,
      subject: { agentName: null, routineName: "Book accommodation", routineSlotKeys: ["arrival_date", "guest_name"] },
    });

    expect(Object.keys(notification.collected ?? {})).toEqual(["arrival_date", "guest_name", "nights"]);
  });

  it("keeps the stored order when the routine no longer exists", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "handoff",
      payload: { agentId: "agent_1", routineId: "routine_1", collected: storedCollected },
      fallback,
      subject: { agentName: null, routineName: null },
    });

    expect(Object.keys(notification.collected ?? {})).toEqual(["nights", "guest_name", "arrival_date"]);
  });

  it("omits routine and collected when the payload carries neither (a retrieval-miss handoff)", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "handoff",
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
    const notification = routineEndingNotificationFromAction({ kind: "handoff", payload: {}, fallback });

    expect(notification).toEqual({
      kind: "handoff",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "unknown",
      reason: "routine_handoff",
    });
  });

  it("reports null names when no subject is given, matching an unresolved DB lookup", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "handoff",
      payload: { conversationId: "conv_1", workspaceId: "ws_1", agentId: "agent_1", routineId: "routine_1" },
      fallback,
      subject: { agentName: null, routineName: null },
    });

    expect(notification).toEqual(expect.objectContaining({
      agentName: null,
      routine: { id: "routine_1", name: null },
    }));
  });

  it("builds a completion notification from a completion.notify payload, with its notice and conversation facts", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "completion",
      payload: {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        agentId: "agent_1",
        routineId: "routine_1",
        collected: { name: "Ada" },
        notice: { subject: "Booking: {{slot.name}}", intro: 7 },
      },
      fallback: { ...fallback, reason: "routine_completed" },
      subject: {
        agentName: "Retreat desk",
        routineName: "Book accommodation",
        conversation: { channel: "embed", entryPageUrl: null },
      },
    });

    expect(notification).toEqual({
      kind: "completion",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "agent_1",
      reason: "routine_completed",
      agentName: "Retreat desk",
      routine: { id: "routine_1", name: "Book accommodation" },
      collected: { name: "Ada" },
      notice: { subject: "Booking: {{slot.name}}" },
      conversation: { channel: "embed", entryPageUrl: null },
    });
  });
});
