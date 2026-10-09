import { describe, expect, it } from "vitest";

import { routineEndingEffects } from "../src/routineEnding.js";

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
});
