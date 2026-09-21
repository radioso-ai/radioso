import { describe, expect, it } from "vitest";
import type { Routine, RoutineRegistration, TurnContext } from "@radioso/conversation-contract";

import { createDirectInvocationActivator } from "../../../src/modules/routines/exposure/directInvocationActivator.js";
import type { RoutineInvocation } from "../../../src/modules/routines/exposure/routineInvocationValidator.js";

const routine = (id: string, toolName: string | null, reentryMode: "once_per_conversation" | "always" | "semantic"): Routine => ({
  id,
  rootStepId: "ask",
  slots: [{ id: "s1", key: "orderId", type: "text", required: true }],
  steps: [
    { id: "ask", kind: "chat", action: "Ask for {{slot.orderId}}.", metadata: { collectsSlots: ["orderId"] } },
    { id: "done", kind: "terminal", metadata: { terminalKind: "complete" } },
  ],
  transitions: [{ from: "ask", to: "done", condition: "always", guard: { kind: "default" } }],
  activation: { triggerDescription: "when asked", priority: 10, reentryMode },
  metadata: {
    definitionId: id,
    name: `Routine ${id}`,
    version: 1,
    lineageId: `lineage:${id}`,
    ...(toolName ? { exposure: { toolName } } : {}),
  },
});

const registration = (compiled: Routine): RoutineRegistration => ({
  routine: compiled,
  trigger: { description: "when asked", priority: 10 },
});

const invocation: RoutineInvocation = {
  toolName: "start_return",
  input: { orderId: "A-1001" },
};

const turn = {} as TurnContext;

describe("createDirectInvocationActivator", () => {
  it("admits the routine the tool name resolves to, with the input as its variables and no model call", async () => {
    const registrations = [
      registration(routine("r-other", "other_tool", "once_per_conversation")),
      registration(routine("r-return", "start_return", "once_per_conversation")),
    ];
    const activator = createDirectInvocationActivator(registrations, invocation);

    const activation = await activator.activate({ turn });

    expect(activation).toMatchObject({
      kind: "activate",
      routineId: "r-return",
      variables: { orderId: "A-1001" },
      decisionMetadata: { reason: "direct_invocation", decision: { kind: "auto_pick" } },
    });
    expect(activator.outcome()).toEqual({ kind: "started", routineId: "r-return" });
  });

  it("returns null when no registration carries the tool name", async () => {
    const activator = createDirectInvocationActivator(
      [registration(routine("r-other", "other_tool", "once_per_conversation"))],
      invocation,
    );

    await expect(activator.activate({ turn })).resolves.toBeNull();
    expect(activator.outcome()).toEqual({ kind: "unknown_tool" });
  });

  it("declines a once_per_conversation routine that already completed and remembers which one", async () => {
    const activator = createDirectInvocationActivator(
      [registration(routine("r-return", "start_return", "once_per_conversation"))],
      invocation,
    );

    await expect(activator.activate({ turn, suppressedRoutineIds: ["r-return"] })).resolves.toBeNull();
    expect(activator.outcome()).toEqual({ kind: "declined", routineId: "r-return" });
  });

  it.each(["always", "semantic"] as const)("re-admits a completed routine under %s reentry with the new input", async (reentryMode) => {
    const activator = createDirectInvocationActivator(
      [registration(routine("r-return", "start_return", reentryMode))],
      invocation,
    );

    const activation = await activator.activate({ turn, suppressedRoutineIds: ["r-return"] });

    expect(activation).toMatchObject({ kind: "activate", routineId: "r-return", variables: { orderId: "A-1001" } });
    expect(activator.outcome()).toEqual({ kind: "reentered", routineId: "r-return" });
  });

  it("ignores a completed routine that is not the one invoked", async () => {
    const activator = createDirectInvocationActivator(
      [
        registration(routine("r-other", "other_tool", "once_per_conversation")),
        registration(routine("r-return", "start_return", "once_per_conversation")),
      ],
      invocation,
    );

    const activation = await activator.activate({ turn, suppressedRoutineIds: ["r-other"] });

    expect(activation).toMatchObject({ kind: "activate", routineId: "r-return" });
  });
});
