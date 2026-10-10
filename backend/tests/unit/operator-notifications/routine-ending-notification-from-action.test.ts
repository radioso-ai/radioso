import { describe, expect, it } from "vitest";

import { routineEndingNotificationFromAction } from "../../../src/modules/operatorNotifications/public.js";

const ids = { conversationId: "conv_1", workspaceId: "ws_1", agentId: "agent_1" };
const fallback = { reason: "routine_handoff" };

describe("routineEndingNotificationFromAction", () => {
  it("builds a handoff notification from a handoff.notify action payload", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "handoff",
      payload: {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        agentId: "visitor_filled_agent",
        reason: "routine_handoff",
        routineId: "routine_1",
        collected: { program: "Yoga retreat", guests: 2, needs_transfer: true, notes: null, preferences: { room: "single" } },
      },
      ids,
      fallback,
      subject: { agentId: "agent_1", agentName: "Retreat desk", routineName: "Book accommodation" },
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

  it("trusts the given ids over differing ids the payload carries", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "handoff",
      payload: {
        // A routine action-step payload can carry visitor-filled variables under any key;
        // these must never override the given ids.
        conversationId: "visitor_filled_conv",
        workspaceId: "visitor_filled_ws",
        agentId: "agent_1",
        reason: "routine_handoff",
      },
      ids,
      fallback,
    });

    expect(notification).toEqual(expect.objectContaining({
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "agent_1",
    }));
  });

  // jsonb reorders an object's keys (shorter keys first), so a queued payload's `collected`
  // reads back out of the order the routine declares its slots in.
  const storedCollected = { nights: 3, guest_name: "Ada", arrival_date: "2026-10-12" };

  it("lists the collected values in the routine's declared slot order, not the order they were stored in", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "completion",
      payload: { agentId: "agent_1", routineId: "routine_1", collected: storedCollected },
      ids,
      fallback,
      subject: {
        agentId: "agent_1",
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
      ids,
      fallback,
      subject: { agentId: "agent_1", agentName: null, routineName: "Book accommodation", routineSlotKeys: ["arrival_date", "guest_name"] },
    });

    expect(Object.keys(notification.collected ?? {})).toEqual(["arrival_date", "guest_name", "nights"]);
  });

  it("keeps the stored order when the routine no longer exists", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "handoff",
      payload: { agentId: "agent_1", routineId: "routine_1", collected: storedCollected },
      ids,
      fallback,
      subject: { agentId: "agent_1", agentName: null, routineName: null },
    });

    expect(Object.keys(notification.collected ?? {})).toEqual(["nights", "guest_name", "arrival_date"]);
  });

  it("omits routine and collected when the payload carries neither (a retrieval-miss handoff)", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "handoff",
      payload: { conversationId: "conv_1", workspaceId: "ws_1", agentId: "agent_1", reason: "retrieval_miss" },
      ids,
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

  it("uses the given ids and falls back to the ending's default reason for missing payload fields", () => {
    const notification = routineEndingNotificationFromAction({ kind: "handoff", payload: {}, ids, fallback });

    expect(notification).toEqual({
      kind: "handoff",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      agentId: "agent_1",
      reason: "routine_handoff",
    });
  });

  it("reports null names when no subject is given, matching an unresolved DB lookup", () => {
    const notification = routineEndingNotificationFromAction({
      kind: "handoff",
      payload: { conversationId: "conv_1", workspaceId: "ws_1", agentId: "agent_1", routineId: "routine_1" },
      ids,
      fallback,
      subject: { agentId: "agent_1", agentName: null, routineName: null },
    });

    expect(notification).toEqual(expect.objectContaining({
      agentName: null,
      routine: { id: "routine_1", name: null },
    }));
  });

  describe("reply-to", () => {
    // A gift booking collects the buyer's and the recipient's address; the author chose the recipient's.
    const giftPayload = (collected: Record<string, unknown>, notice: Record<string, unknown> = { replyToSlot: "recipient_email" }) => ({
      routineId: "routine_1",
      collected,
      notice,
    });

    it("replies to the address collected in the field the notice names, even when an earlier field holds an address too", () => {
      const notification = routineEndingNotificationFromAction({
        kind: "completion",
        payload: giftPayload({ buyer_email: "ada@example.com", recipient_email: "grace@example.com" }),
        ids,
        fallback: { reason: "routine_completed" },
      });

      expect(notification.replyTo).toBe("grace@example.com");
      expect(notification.notice).toEqual({ replyToSlot: "recipient_email" });
    });

    it("sets no reply-to when the named field was never collected, or holds no text", () => {
      for (const collected of [{ buyer_email: "ada@example.com" }, { buyer_email: "ada@example.com", recipient_email: "  " }, { recipient_email: 7 }]) {
        const notification = routineEndingNotificationFromAction({ kind: "handoff", payload: giftPayload(collected), ids, fallback });
        expect(notification).not.toHaveProperty("replyTo");
      }
    });

    it("never guesses a reply-to when the notice names no field, whatever addresses were collected", () => {
      const notification = routineEndingNotificationFromAction({
        kind: "handoff",
        payload: giftPayload({ email: "ada@example.com" }, { subject: "Call back" }),
        ids,
        fallback,
      });

      expect(notification).not.toHaveProperty("replyTo");
      expect(notification.notice).toEqual({ subject: "Call back" });
    });

    it("sets no reply-to on a retrieval-miss hand-off, which has no routine notice", () => {
      const notification = routineEndingNotificationFromAction({
        kind: "handoff",
        payload: { reason: "retrieval_miss", collected: { email: "ada@example.com" } },
        ids,
        fallback,
      });

      expect(notification).not.toHaveProperty("replyTo");
    });
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
      ids,
      fallback: { reason: "routine_completed" },
      subject: {
        agentId: "agent_1",
        agentName: "Retreat desk",
        routineName: "Book accommodation",
        conversation: { entryPageUrl: null },
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
      conversation: { entryPageUrl: null },
    });
  });
});
