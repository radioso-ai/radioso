import { describe, expect, it } from "vitest";

import {
  RoutineSkillExecutorDispatcher,
  StaticRoutineSkillResolver,
  type RoutineSkillResolver,
} from "../../src/modules/routines/skillDispatcher.js";
import {
  SkillExecutorRegistry,
  type SkillDefinition,
  type SkillExecutorPort,
  type SkillInvocation,
  type SkillOutcome,
} from "../../src/modules/skills/public.js";
import type { RoutineState, TurnContext } from "@radioso/conversation-contract";

const TEST_EXECUTION = { kind: "internal" as const, adapter: "test-adapter" };

const skillNamed = (
  name: string,
  execution: SkillDefinition["execution"] = TEST_EXECUTION,
): SkillDefinition => ({ name, execution }) as unknown as SkillDefinition;

const routineState = (variables: Record<string, unknown>): RoutineState =>
  ({ variables }) as unknown as RoutineState;

const turn = { agent: { id: "agent-1" } } as unknown as TurnContext;

const settledExecutor = (
  outcome: SkillOutcome,
  capture?: (invocation: SkillInvocation) => void,
): SkillExecutorPort => ({
  async dispatch(invocation) {
    capture?.(invocation);
    return { disposition: "settled", outcome };
  },
});

const registryWith = (executor: SkillExecutorPort): SkillExecutorRegistry => {
  const registry = new SkillExecutorRegistry();
  registry.register({ ...TEST_EXECUTION, executor });
  return registry;
};

describe("RoutineSkillExecutorDispatcher", () => {
  it("resolves a skill by name, dispatches through the registry, and projects the outcome", async () => {
    const outcome = {
      status: "completed",
      outputs: { bookingId: "bk_1" },
      answer: "Booked.",
    } as unknown as SkillOutcome;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(settledExecutor(outcome)),
    );

    const result = await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({}),
      turn,
    });

    expect(result).toEqual({
      status: "completed",
      outputs: { bookingId: "bk_1" },
      answer: "Booked.",
    });
  });

  it("carries a custom (fine-grained) status verbatim so the runner can branch on it", async () => {
    // The generic adapter may surface a service-shaped status (design seam: the
    // closed SkillOutcome enum → the open RoutineSkillResult union). It must
    // survive the projection unchanged, or condition-gated branches can't match.
    const outcome = {
      status: "slot_conflict",
      outputs: { requested: "2026-06-20T10:00" },
    } as unknown as SkillOutcome;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(settledExecutor(outcome)),
    );

    const result = await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({}),
      turn,
    });

    expect(result.status).toBe("slot_conflict");
    expect(result.outputs).toEqual({ requested: "2026-06-20T10:00" });
  });

  it("passes the routine's captured slots as the invocation's collected params", async () => {
    let captured: SkillInvocation | undefined;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(
        settledExecutor({ status: "completed" } as unknown as SkillOutcome, (invocation) => {
          captured = invocation;
        }),
      ),
    );

    await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({ email: "a@b.com", duration: 30 }),
      turn,
    });

    expect(captured?.skill.name).toBe("book_meeting");
    expect(captured?.collected).toEqual({ email: "a@b.com", duration: 30 });
  });

  it("threads the turn and agent id into the executor context", async () => {
    let captured: SkillInvocation | undefined;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(
        settledExecutor({ status: "completed" } as unknown as SkillOutcome, (invocation) => {
          captured = invocation;
        }),
      ),
    );

    await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({}),
      turn,
    });

    expect(captured?.context).toEqual({ turn, agentId: "agent-1" });
  });

  it("degrades to failed (not a throw) when the referenced skill is not resolvable", async () => {
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([]),
      registryWith(settledExecutor({ status: "completed" } as unknown as SkillOutcome)),
    );

    // Degrades rather than throwing: throwing here would 500 the turn pre-persistence
    // and permanently wedge the resumable routine. The runner advances off `failed`.
    const result = await dispatcher.dispatch({ skillName: "missing", state: routineState({}), turn });
    expect(result).toEqual({ status: "failed", outputs: { skill: "missing", reason: "unknown_skill" } });
  });

  it("degrades to failed when the resolved skill has no execution descriptor", async () => {
    const resolver: RoutineSkillResolver = {
      resolve: () => ({ name: "book_meeting" }) as unknown as SkillDefinition,
    };
    const dispatcher = new RoutineSkillExecutorDispatcher(
      resolver,
      registryWith(settledExecutor({ status: "completed" } as unknown as SkillOutcome)),
    );

    const result = await dispatcher.dispatch({ skillName: "book_meeting", state: routineState({}), turn });
    expect(result).toEqual({ status: "failed", outputs: { skill: "book_meeting", reason: "no_execution" } });
  });

  it("degrades to failed when no executor is registered for the skill's execution", async () => {
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([
        skillNamed("book_meeting", { kind: "internal", adapter: "unregistered" }),
      ]),
      new SkillExecutorRegistry(),
    );

    const result = await dispatcher.dispatch({ skillName: "book_meeting", state: routineState({}), turn });
    expect(result).toEqual({ status: "failed", outputs: { skill: "book_meeting", reason: "no_executor" } });
  });

  it("degrades to failed when the executor defers — a routine step must branch on a settled result", async () => {
    const deferringExecutor: SkillExecutorPort = {
      async dispatch() {
        return { disposition: "deferred", ticket: { ticketId: "t_1" } };
      },
    };
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(deferringExecutor),
    );

    const result = await dispatcher.dispatch({ skillName: "book_meeting", state: routineState({}), turn });
    expect(result).toEqual({ status: "failed", outputs: { skill: "book_meeting", reason: "deferred" } });
  });
});
