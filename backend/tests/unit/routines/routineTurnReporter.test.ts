import { describe, expect, it } from "vitest";
import type { Routine, RoutineState } from "@radioso/conversation-contract";

import { createRoutineTurnReporter } from "../../../src/modules/routines/routineTurnReporter.js";

const bookDemo: Routine = {
  id: "routine-book-demo",
  rootStepId: "ask_name",
  slots: [
    { id: "slot-name", key: "name", type: "text", required: true, description: "Full name" },
    { id: "slot-email", key: "email", type: "email", required: true },
    { id: "slot-company", key: "company", type: "text", required: false, description: "Company" },
    { id: "slot-note", key: "note", type: "text", required: false },
  ],
  steps: [
    { id: "ask_name", kind: "chat", action: "Ask for {{slot.name}}.", metadata: { collectsSlots: ["name"] } },
    { id: "ask_contact", kind: "chat", action: "Ask for {{slot.email}} and {{slot.company}}.", metadata: { collectsSlots: ["email", "company"] } },
    { id: "confirm", kind: "await", action: "Confirm the booking.", decision: { captureKey: "decision", options: [{ id: "yes", label: "Yes" }] } },
    { id: "send", kind: "skill", skillName: "webhook.send" },
    { id: "done", kind: "terminal", action: "Thank the user.", metadata: { terminalKind: "complete" } },
  ],
  transitions: [
    { from: "ask_name", to: "ask_contact", condition: "always", guard: { kind: "default" } },
    { from: "ask_contact", to: "confirm", condition: "always", guard: { kind: "default" } },
    { from: "confirm", to: "send", condition: "always", guard: { kind: "default" } },
    { from: "send", to: "done", condition: "always", guard: { kind: "default" } },
  ],
  metadata: { definitionId: "definition-1", name: "Book a demo", version: 3 },
};

const state = (overrides: Partial<RoutineState>): RoutineState => ({
  sessionId: "conversation-1",
  routineId: bookDemo.id,
  path: ["ask_name"],
  variables: {},
  status: "active",
  ...overrides,
});

describe("createRoutineTurnReporter", () => {
  const reporter = createRoutineTurnReporter([bookDemo]);

  it("reports waiting_for_input with every unfilled required slot plus the current step's optional slots", () => {
    const described = reporter.describe({ state: state({ path: ["ask_name", "ask_contact"], variables: { name: "Ada" } }) });

    expect(described).toEqual({
      name: "Book a demo",
      status: "waiting_for_input",
      pendingInput: [
        { key: "email", type: "email", required: true },
        { key: "company", type: "text", required: false, description: "Company" },
      ],
    });
  });

  it("lists required slots collected by later steps so a caller can supply everything at once", () => {
    const described = reporter.describe({ state: state({ path: ["ask_name"] }) });

    expect(described?.status).toBe("waiting_for_input");
    expect(described?.pendingInput.map((slot) => slot.key)).toEqual(["name", "email"]);
    expect(described?.pendingInput[0]).toEqual({ key: "name", type: "text", required: true, description: "Full name" });
  });

  it("treats an empty path as the root step, as on an activation turn that re-asks it", () => {
    const described = reporter.describe({ state: state({ path: [] }) });

    expect(described?.status).toBe("waiting_for_input");
    expect(described?.pendingInput.map((slot) => slot.key)).toEqual(["name", "email"]);
  });

  it("reports active when the current step is not collecting anything", () => {
    const described = reporter.describe({
      state: state({ path: ["ask_name", "ask_contact", "confirm", "send"], variables: { name: "Ada", email: "ada@example.com" } }),
    });

    expect(described).toEqual({ name: "Book a demo", status: "active", pendingInput: [] });
  });

  it("reports waiting_for_approval for a suspended routine and for a turn awaiting a decision", () => {
    const suspended = reporter.describe({
      state: state({ path: ["ask_name", "ask_contact", "confirm"], variables: { name: "Ada", email: "ada@example.com" }, status: "suspended" }),
    });
    const awaiting = reporter.describe({
      state: state({ path: ["ask_name", "ask_contact", "confirm"], variables: { name: "Ada", email: "ada@example.com" } }),
      awaitingDecision: true,
    });

    expect(suspended).toEqual({ name: "Book a demo", status: "waiting_for_approval", pendingInput: [] });
    expect(awaiting).toEqual({ name: "Book a demo", status: "waiting_for_approval", pendingInput: [] });
  });

  it("reports completed for a finished routine, including a handoff terminal", () => {
    const completed = reporter.describe({ state: state({ path: ["ask_name", "done"], status: "completed" }) });
    const handedOff = reporter.describe({
      state: state({ path: ["ask_name", "done"], status: "completed", metadata: { terminalKind: "handoff", terminalStepId: "done" } }),
    });

    expect(completed).toEqual({ name: "Book a demo", status: "completed", pendingInput: [] });
    expect(handedOff).toEqual({ name: "Book a demo", status: "completed", pendingInput: [] });
  });

  it("reports abandoned for an expired routine", () => {
    expect(reporter.describe({ state: state({ status: "expired" }) })).toEqual({
      name: "Book a demo",
      status: "abandoned",
      pendingInput: [],
    });
  });

  it("returns null for a routine this turn does not know", () => {
    expect(reporter.describe({ state: state({ routineId: "routine-unknown" }) })).toBeNull();
  });

  it("falls back to the routine id when the compiled routine carries no name", () => {
    const unnamed = createRoutineTurnReporter([{ ...bookDemo, metadata: undefined }]);

    expect(unnamed.describe({ state: state({ status: "completed" }) })?.name).toBe(bookDemo.id);
  });
});

describe("createRoutineTurnReporter with exposed routines", () => {
  const exposed: Routine = {
    ...bookDemo,
    metadata: { ...bookDemo.metadata, exposure: { toolName: "book_demo" } },
  };

  it("names the tool the routine is exposed under on every report", () => {
    const reporter = createRoutineTurnReporter([exposed]);

    expect(reporter.describe({ state: state({ path: ["ask_name"] }) })).toMatchObject({
      toolName: "book_demo",
      name: "Book a demo",
      status: "waiting_for_input",
    });
    expect(reporter.describe({ state: state({ status: "completed" }) })).toEqual({
      toolName: "book_demo",
      name: "Book a demo",
      status: "completed",
      pendingInput: [],
    });
  });

  it("describes a routine an invocation named but the turn declined as completed, so the caller learns why nothing started", () => {
    const reporter = createRoutineTurnReporter([exposed], {
      invocation: { toolName: "book_demo", outcome: () => ({ kind: "declined", routineId: exposed.id }) },
    });

    expect(reporter.describeDeclined()).toEqual({
      toolName: "book_demo",
      name: "Book a demo",
      status: "completed",
      pendingInput: [],
    });
    expect(reporter.describeInvocation()).toEqual({ toolName: "book_demo", outcome: "declined" });
  });

  it("describes nothing declined and no invocation on an ordinary turn", () => {
    expect(createRoutineTurnReporter([exposed]).describeDeclined()).toBeNull();
    expect(createRoutineTurnReporter([exposed]).describeInvocation()).toBeNull();
    const started = createRoutineTurnReporter([exposed], {
      invocation: { toolName: "book_demo", outcome: () => ({ kind: "started", routineId: exposed.id }) },
    });
    expect(started.describeDeclined()).toBeNull();
    const declinedUnknown = createRoutineTurnReporter([exposed], {
      invocation: { toolName: "book_demo", outcome: () => ({ kind: "declined", routineId: "routine-unknown" }) },
    });
    expect(declinedUnknown.describeDeclined()).toBeNull();
  });

  it.each([
    [{ kind: "started", routineId: exposed.id }, "started"],
    [{ kind: "reentered", routineId: exposed.id }, "reentered"],
    [{ kind: "declined", routineId: exposed.id }, "declined"],
    [{ kind: "unknown_tool" }, "unknown_tool"],
  ] as const)("reports the activator's %o as the invocation outcome %s", (outcome, expected) => {
    const reporter = createRoutineTurnReporter([exposed], { invocation: { toolName: "book_demo", outcome: () => outcome } });

    expect(reporter.describeInvocation()).toEqual({ toolName: "book_demo", outcome: expected });
  });

  it("reports not_started when the invocation turn never reached the activator (another routine kept the turn)", () => {
    const reporter = createRoutineTurnReporter([exposed], { invocation: { toolName: "book_demo", outcome: () => null } });

    expect(reporter.describeInvocation()).toEqual({ toolName: "book_demo", outcome: "not_started" });
    expect(reporter.describeDeclined()).toBeNull();
  });
});
