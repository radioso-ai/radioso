import { describe, expect, it, vi } from "vitest";

import type { Routine, TurnContext } from "@radioso/conversation-contract";

import { RoutineRegistry } from "../../src/modules/chat/services/routines/routineRegistry.js";

const routine = (id: string): Routine => ({ id, rootStepId: "s", steps: [], transitions: [] });
const turn = { sessionId: "conv_1", inputEvent: { kind: "message", content: "hi" } } as unknown as TurnContext;

describe("RoutineRegistry", () => {
  it("exposes the registered routines for the runner", () => {
    const registry = new RoutineRegistry([
      { routine: routine("a"), activates: vi.fn(async () => null) },
      { routine: routine("b"), activates: vi.fn(async () => null) },
    ]);
    expect(registry.routines.map((r) => r.id)).toEqual(["a", "b"]);
    expect(registry.isEmpty).toBe(false);
  });

  it("activates the first routine whose registration claims the turn, with its seed variables", async () => {
    const aActivates = vi.fn(async () => null);
    const registry = new RoutineRegistry([
      { routine: routine("a"), activates: aActivates },
      { routine: routine("b"), activates: vi.fn(async () => ({ variables: { email: "x@y.z" } })) },
    ]);

    const decision = await registry.activator().activate({ turn });

    expect(decision).toEqual({ routineId: "b", variables: { email: "x@y.z" } });
    expect(aActivates).toHaveBeenCalledWith({ turn });
  });

  it("declines when no registration claims the turn", async () => {
    const registry = new RoutineRegistry([{ routine: routine("a"), activates: vi.fn(async () => null) }]);
    expect(await registry.activator().activate({ turn })).toBeNull();
  });

  it("is empty (and activates nothing) with no registrations", async () => {
    const registry = new RoutineRegistry([]);
    expect(registry.isEmpty).toBe(true);
    expect(registry.routines).toEqual([]);
    expect(await registry.activator().activate({ turn })).toBeNull();
  });
});
