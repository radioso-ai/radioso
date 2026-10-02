import { describe, expect, it } from "vitest";

import { formatRoutineEndingNotification } from "../../../src/modules/operatorNotifications/public.js";

const base = {
  kind: "handoff" as const,
  workspaceId: "ws_1",
  conversationId: "conv_1",
  agentId: "agent_1",
  reason: "routine_handoff",
};

describe("formatRoutineEndingNotification", () => {
  it("reads as just the headline and a blank line for a retrieval-miss hand-off with nothing else known", () => {
    expect(formatRoutineEndingNotification(base)).toEqual({
      subject: "Conversation needs a human",
      lines: ["A conversation needs a human operator.", ""],
      notice: { subject: null, intro: null },
    });
  });

  it("names the routine in the subject and lists the collected values in key order", () => {
    const formatted = formatRoutineEndingNotification({
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
      "Collected:",
      "  Program: Yoga retreat",
      "  Arrival date: 2026-10-12",
      "  Guests: 2",
      "  Needs transfer: yes",
      "  Vegetarian: no",
      "",
    ]);
  });

  it("falls back to the generic subject when the routine has no name, and lists no collected values", () => {
    const formatted = formatRoutineEndingNotification({
      ...base,
      routine: { id: "routine_1", name: null },
      collected: {},
    });

    expect(formatted.subject).toBe("Conversation needs a human");
    expect(formatted.lines).not.toContain("Collected:");
  });

  const booking = {
    ...base,
    agentName: "Retreat desk",
    routine: { id: "routine_1", name: "Book accommodation" },
    collected: { name: "Ada Lovelace", arrival: "2026-10-12", guests: 2 },
  };

  it("uses the completion defaults for a completion notice", () => {
    const formatted = formatRoutineEndingNotification({ ...booking, kind: "completion", reason: "routine_completed" });

    expect(formatted.subject).toBe("Book accommodation: completed");
    expect(formatted.lines[0]).toBe("A conversation completed a routine.");
    expect(formatRoutineEndingNotification({ ...base, kind: "completion", reason: "routine_completed" }).subject).toBe("Routine completed");
  });

  it("replaces the default subject with the authored one and puts the authored intro right after the headline", () => {
    const formatted = formatRoutineEndingNotification({
      ...booking,
      kind: "completion",
      reason: "routine_completed",
      notice: { subject: "New booking: {{slot.name}}, {{ slot.guests }} guests", intro: "Please confirm {{slot.arrival}} with {{slot.name}}." },
    });

    expect(formatted.subject).toBe("New booking: Ada Lovelace, 2 guests");
    expect(formatted.lines.slice(0, 3)).toEqual([
      "A conversation completed a routine.",
      "Please confirm 2026-10-12 with Ada Lovelace.",
      "",
    ]);
    expect(formatted.notice).toEqual({
      subject: "New booking: Ada Lovelace, 2 guests",
      intro: "Please confirm 2026-10-12 with Ada Lovelace.",
    });
  });

  it("renders a dash for a value the routine did not collect, so the notice still goes out", () => {
    const formatted = formatRoutineEndingNotification({
      ...booking,
      collected: { name: "Ada Lovelace", arrival: "   " },
      notice: { subject: "{{slot.name}} arriving {{slot.arrival}}", intro: "Room: {{slot.room}}" },
    });

    expect(formatted.subject).toBe("Ada Lovelace arriving —");
    expect(formatted.notice.intro).toBe("Room: —");
  });

  it("keeps the subject on one line whatever a collected value contains", () => {
    const formatted = formatRoutineEndingNotification({
      ...booking,
      collected: { name: "Ada\r\nBcc: attacker@example.com" },
      notice: { subject: "Booking: {{slot.name}}" },
    });

    expect(formatted.subject).toBe("Booking: Ada Bcc: attacker@example.com");
    expect(formatted.subject).not.toMatch(/[\r\n]/u);
  });

  it("always appends every collected value in declaration order, whatever the template shows", () => {
    const formatted = formatRoutineEndingNotification({
      ...booking,
      notice: { subject: "Booking", intro: "See below." },
    });

    expect(formatted.lines).toEqual([
      "A conversation needs a human operator.",
      "See below.",
      "",
      "Collected:",
      "  Name: Ada Lovelace",
      "  Arrival: 2026-10-12",
      "  Guests: 2",
      "",
    ]);
  });

  it("adds the entry page as a footer line, directly after a single blank line, when known", () => {
    const formatted = formatRoutineEndingNotification({
      ...booking,
      conversation: { entryPageUrl: "https://ananda.example/stays" },
    });

    expect(formatted.lines.slice(-2)).toEqual(["", "Entry page: https://ananda.example/stays"]);
  });

  it("ends in a single blank line, reserved for the sink's Open link, when the entry page is not known", () => {
    const formatted = formatRoutineEndingNotification({ ...booking, conversation: { entryPageUrl: null } });

    expect(formatted.lines.at(-1)).toBe("");
    expect(formatted.lines.some((line) => line.startsWith("Entry page:"))).toBe(false);
  });
});
