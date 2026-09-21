import { describe, expect, it } from "vitest";

import { formatHandoffNotification } from "../../../src/modules/operatorNotifications/public.js";

const base = {
  kind: "handoff" as const,
  workspaceId: "ws_1",
  conversationId: "conv_1",
  agentId: "agent_1",
  reason: "routine_handoff",
};

describe("formatHandoffNotification", () => {
  it("keeps the generic subject and id-only lines when no names or values are known", () => {
    expect(formatHandoffNotification(base)).toEqual({
      subject: "Conversation needs a human",
      lines: [
        "A conversation needs a human operator.",
        "",
        "Agent: agent_1",
        "Reason: routine_handoff",
        "Conversation: conv_1",
        "Workspace: ws_1",
      ],
    });
  });

  it("names the routine in the subject and lists the collected values in key order", () => {
    const formatted = formatHandoffNotification({
      ...base,
      agentName: "Retreat desk",
      routine: { id: "routine_1", name: "Book accommodation" },
      collected: {
        program: "Yoga retreat",
        "arrival-date": "2026-10-12",
        guests: 2,
        needs_transfer: true,
        vegetarian: false,
      },
    });

    expect(formatted.subject).toBe("Book accommodation: needs a human");
    expect(formatted.lines).toEqual([
      "A conversation needs a human operator.",
      "",
      "Agent: Retreat desk (agent_1)",
      "Routine: Book accommodation",
      "Reason: routine_handoff",
      "Conversation: conv_1",
      "Workspace: ws_1",
      "",
      "Collected:",
      "  Program: Yoga retreat",
      "  Arrival date: 2026-10-12",
      "  Guests: 2",
      "  Needs transfer: yes",
      "  Vegetarian: no",
    ]);
  });

  it("falls back to the generic subject and skips the routine line when the routine has no name", () => {
    const formatted = formatHandoffNotification({
      ...base,
      routine: { id: "routine_1", name: null },
      collected: {},
    });

    expect(formatted.subject).toBe("Conversation needs a human");
    expect(formatted.lines).not.toContain("Collected:");
    expect(formatted.lines.some((line) => line.startsWith("Routine:"))).toBe(false);
  });
});
