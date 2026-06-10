import { describe, expect, it, vi } from "vitest";

import type { Routine, TurnContext } from "@radioso/conversation-contract";

import { RoutineRegistry } from "@radioso/conversation-defaults";

const routine = (id: string): Routine => ({ id, rootStepId: "s", steps: [], transitions: [] });
const turn: TurnContext = {
  agent: { id: "agent_1", name: "Support" },
  sessionId: "conv_1",
  inputEvent: { kind: "message", content: "hi" },
  history: [],
  stagedContext: [],
  steering: [],
};
const registration = (id: string) => ({
  routine: routine(id),
  trigger: { description: `Start ${id}`, priority: 0 },
});
const modelGateway = (text: string) => ({ complete: vi.fn(async () => ({ text })) });

describe("RoutineRegistry", () => {
  it("exposes the registered routines for the runner", () => {
    const registry = new RoutineRegistry([
      registration("a"),
      registration("b"),
    ]);
    expect(registry.routines.map((r) => r.id)).toEqual(["a", "b"]);
    expect(registry.isEmpty).toBe(false);
  });

  it("activates the first routine whose registration claims the turn, with its seed variables", async () => {
    const gateway = modelGateway(JSON.stringify({
      matches: [
        { routineId: "a", confidence: 0.1 },
        { routineId: "b", confidence: 0.9, variables: { email: "x@y.z" } },
      ],
    }));
    const registry = new RoutineRegistry([
      registration("a"),
      registration("b"),
    ]);

    const decision = await registry.activator(gateway).activate({ turn });

    expect(decision).toEqual({ kind: "activate", routineId: "b", variables: { email: "x@y.z" } });
    expect(gateway.complete).toHaveBeenCalledTimes(1);
  });

  it("declines when no registration claims the turn", async () => {
    const registry = new RoutineRegistry([registration("a")]);
    expect(await registry.activator(modelGateway(JSON.stringify({ matches: [{ routineId: "a", confidence: 0.1 }] }))).activate({ turn })).toBeNull();
  });

  it("is empty (and activates nothing) with no registrations", async () => {
    const registry = new RoutineRegistry([]);
    expect(registry.isEmpty).toBe(true);
    expect(registry.routines).toEqual([]);
    expect(await registry.activator(modelGateway("")).activate({ turn })).toBeNull();
  });
});
