import { describe, expect, it } from "vitest";

import type { Routine, RoutineState } from "@radioso/conversation-contract";

import { completedRunSentValues } from "../src/index.js";
import { firingCompletionExport, routineEndingEffects, terminalKindFor } from "../src/routineEnding.js";

describe("routineEndingEffects", () => {
  it("hands off on an authored hand-off terminal, carrying its terminal kind", () => {
    const effects = routineEndingEffects("routine_1", {
      kind: "handoff",
      stepId: "step_handoff",
      collected: { email: "alex@example.com" },
    });

    expect(effects.handoff).toEqual({
      routineId: "routine_1",
      stepId: "step_handoff",
      terminalKind: "handoff",
      collected: { email: "alex@example.com" },
    });
  });

  it("hands off on a visitor stuck past the re-ask limit (#1384), carrying terminalKind stuck", () => {
    const effects = routineEndingEffects("routine_1", {
      kind: "stuck",
      stepId: "ask_contact",
      collected: { full_name: "Giulia" },
    });

    expect(effects.handoff).toEqual({
      routineId: "routine_1",
      stepId: "ask_contact",
      terminalKind: "stuck",
      collected: { full_name: "Giulia" },
    });
  });

  it("hands off when a visitor declines a consent whose decline choice is handoff (#1544), with no authored notice", () => {
    const effects = routineEndingEffects("routine_1", {
      kind: "consent_declined",
      stepId: "consent:health:ask_health",
      collected: { full_name: "Giulia" },
    });

    expect(effects).toEqual({
      handoff: {
        routineId: "routine_1",
        stepId: "consent:health:ask_health",
        terminalKind: "consent_declined",
        collected: { full_name: "Giulia" },
      },
    });
  });

  it("reports no hand-off and no operator notice for a stuck ending, since it lands on no authored terminal", () => {
    const effects = routineEndingEffects("routine_1", {
      kind: "stuck",
      stepId: "ask_contact",
      collected: {},
    });

    expect(effects.operatorNotice).toBeUndefined();
  });

  it("carries the notify skill an ending names onto its operator notice", () => {
    const effects = routineEndingEffects("routine_1", {
      kind: "complete",
      stepId: "done",
      collected: {},
      operatorNotice: { subject: "Booking", skillName: "notify_bookings" },
    });

    expect(effects.operatorNotice).toEqual({
      routineId: "routine_1",
      stepId: "done",
      terminalKind: "complete",
      collected: {},
      subject: "Booking",
      skillName: "notify_bookings",
    });
  });

  it("carries the field an ending's notice replies to onto its operator notice", () => {
    const effects = routineEndingEffects("routine_1", {
      kind: "complete",
      stepId: "done",
      collected: { guest_email: "ada@example.com" },
      operatorNotice: { subject: "Booking", replyToSlot: "guest_email" },
    });

    expect(effects.operatorNotice).toEqual({
      routineId: "routine_1",
      stepId: "done",
      terminalKind: "complete",
      collected: { guest_email: "ada@example.com" },
      subject: "Booking",
      replyToSlot: "guest_email",
    });
  });

  it("reports no hand-off for a normal completion", () => {
    const effects = routineEndingEffects("routine_1", {
      kind: "complete",
      stepId: "done",
      collected: {},
    });

    expect(effects.handoff).toBeUndefined();
  });

  it("reports no effects when the routine has not reached an ending", () => {
    const effects = routineEndingEffects("routine_1", undefined);

    expect(effects).toEqual({});
  });

  it("carries a hand-off's collected values only when present", () => {
    const effects = routineEndingEffects("routine_1", { kind: "stuck", stepId: "ask_contact" });

    expect(effects.handoff).toEqual({
      routineId: "routine_1",
      stepId: "ask_contact",
      terminalKind: "stuck",
    });
  });

  it("carries which collected values were masked as sensitive onto the hand-off and the notice (#1543)", () => {
    const effects = routineEndingEffects("routine_1", {
      kind: "handoff",
      stepId: "step_handoff",
      collected: { email: "alex@example.com", injury: "[redacted]" },
      sensitiveSlotKeys: ["injury"],
      operatorNotice: {},
    });

    expect(effects.handoff?.sensitiveSlotKeys).toEqual(["injury"]);
    expect(effects.operatorNotice?.sensitiveSlotKeys).toEqual(["injury"]);
  });
});

describe("completedRunSentValues (#1714)", () => {
  const booking = (overrides: Partial<Routine> = {}): Routine => ({
    id: "booking",
    rootStepId: "dates",
    steps: [
      { id: "dates", kind: "chat", action: "Ask for the dates" },
      { id: "lookup", kind: "skill", skillName: "availability" },
      { id: "queue", kind: "action", actionType: "booking.request" },
      { id: "approve", kind: "await" },
      { id: "info_only", kind: "terminal", metadata: { terminalKind: "complete" } },
      { id: "notified", kind: "terminal", metadata: { terminalKind: "complete", operatorNotice: {} } },
      { id: "to_person", kind: "terminal", metadata: { terminalKind: "handoff", operatorNotice: {} } },
    ],
    transitions: [],
    ...overrides,
  });
  const ended = (path: string[]): RoutineState => ({
    sessionId: "s1",
    routineId: "booking",
    path,
    variables: {},
    status: "completed",
  });

  it("is false for a run that only talked and ended on a complete ending that notifies no one", () => {
    expect(completedRunSentValues(booking(), ended(["dates", "info_only"]))).toBe(false);
  });

  it("is true when the ending notified operators or handed the conversation to a person", () => {
    expect(completedRunSentValues(booking(), ended(["dates", "notified"]))).toBe(true);
    expect(completedRunSentValues(booking(), ended(["dates", "to_person"]))).toBe(true);
  });

  it("is true when a run stuck on a step ended there, which hands off", () => {
    expect(completedRunSentValues(booking(), ended(["dates"]))).toBe(true);
  });

  it("is true when the run passed a tool, action, or approval step on its way", () => {
    expect(completedRunSentValues(booking(), ended(["dates", "lookup", "info_only"]))).toBe(true);
    expect(completedRunSentValues(booking(), ended(["dates", "queue", "info_only"]))).toBe(true);
    expect(completedRunSentValues(booking(), ended(["dates", "approve", "info_only"]))).toBe(true);
  });

  it("is true when the routine's completion export fires on the ending it reached, and false when it does not", () => {
    const exportOn = (triggerKinds: Array<"complete" | "handoff">): Routine =>
      booking({ completionExport: { enabled: true, triggerKinds, destinationRef: "crm" } });
    expect(completedRunSentValues(exportOn(["complete"]), ended(["dates", "info_only"]))).toBe(true);
    expect(completedRunSentValues(exportOn(["handoff"]), ended(["dates", "info_only"]))).toBe(false);
    expect(completedRunSentValues(
      booking({ completionExport: { enabled: false, triggerKinds: ["complete"], destinationRef: "crm" } }),
      ended(["dates", "info_only"]),
    )).toBe(false);
  });

  it("is true when the record names no step the routine has, since nothing can show the run kept its values", () => {
    expect(completedRunSentValues(booking(), ended([]))).toBe(true);
    expect(completedRunSentValues(booking(), ended(["dates", "renamed_end"]))).toBe(true);
  });
});

describe("firingCompletionExport", () => {
  const routine = (completionExport: Routine["completionExport"]): Routine => ({
    id: "r", rootStepId: "a", steps: [], transitions: [], ...(completionExport ? { completionExport } : {}),
  });
  const on = { enabled: true, triggerKinds: ["complete" as const], destinationRef: "crm" };

  it("fires only on an ending kind the enabled export names, to a destination", () => {
    expect(firingCompletionExport(routine(on), "complete")).toEqual(on);
    expect(firingCompletionExport(routine(on), "handoff")).toBeNull();
    expect(firingCompletionExport(routine(on), "action")).toBeNull();
    expect(firingCompletionExport(routine(on), null)).toBeNull();
    expect(firingCompletionExport(routine({ ...on, enabled: false }), "complete")).toBeNull();
    expect(firingCompletionExport(routine({ ...on, destinationRef: "" }), "complete")).toBeNull();
    expect(firingCompletionExport(routine(undefined), "complete")).toBeNull();
  });

  it("reads a terminal with no declared kind, or an unknown one, as a completion", () => {
    expect(terminalKindFor({ id: "t", kind: "terminal" })).toBe("complete");
    expect(terminalKindFor({ id: "t", kind: "terminal", metadata: { terminalKind: "other" } })).toBe("complete");
    expect(terminalKindFor({ id: "t", kind: "terminal", metadata: { terminalKind: "handoff" } })).toBe("handoff");
    expect(terminalKindFor({ id: "c", kind: "chat" })).toBeNull();
  });
});
