import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  ClarificationPolicy,
  Routine,
  RoutineReentryMode,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import {
  RoutineRegistry,
  RoutineReentryGate,
  type RoutineActivationPrefilter,
  type RoutineRegistration,
} from "../src/index.js";

/**
 * Characterization tests for routine activation policy: which completed routines stay
 * suppressed, how the semantic reentry gate composes with that suppression, and what the
 * registry does when the activation prefilter fails. These pin behavior that is currently
 * split across `RoutineRegistration.trigger` and the compiled routine, so they are the
 * safety net for collapsing reentry policy onto a single source of truth.
 */

const policy: ClarificationPolicy = { floor: 0.4, margin: 0.15, maxOptions: 4 };

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "I need to book a call" },
  history: [],
  stagedContext: [],
  steering: [],
};

const baseRoutine = (id: string): Routine => ({
  id,
  rootStepId: "start",
  steps: [],
  transitions: [],
});

/** A routine whose author declared `mode`, with the guidance the semantic gate prompts on. */
const gatedRoutine = (
  id: string,
  mode: RoutineReentryMode,
  triggerDescription = `User wants ${id}`,
): Routine => ({
  ...baseRoutine(id),
  activation: { reentryMode: mode, triggerDescription, priority: 0 },
});

/**
 * Builds a registration for a routine whose author chose `mode`. The single place these
 * tests express "this routine's authored reentry policy" — the seam that carries it is an
 * implementation detail of the registry, not of the behavior under test.
 */
const authored = (id: string, mode?: RoutineReentryMode): RoutineRegistration => ({
  routine: mode ? gatedRoutine(id, mode) : baseRoutine(id),
  trigger: {
    description: `User wants ${id}`,
    priority: 0,
  },
});

const gateway = (text: string): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text })) });

describe("routine activation prefilter failure is not a filter", () => {
  it("keeps every eligible registration, in registration order, when the prefilter rejects", async () => {
    // The backend prefilter factory rethrows when the query cannot be embedded. The
    // registry's contract is that a failed prefilter degrades to the unpruned candidate
    // set: it must not throw, and it must not prune or reorder.
    const rank = vi.fn().mockRejectedValue(new Error("embedding unavailable"));
    const prefilter: RoutineActivationPrefilter = { rank };
    const registrations = [authored("alpha"), authored("bravo"), authored("charlie")];

    const prepared = await new RoutineRegistry(registrations, { policy, activationPrefilter: prefilter })
      .prepareCandidates(turn);

    expect(rank).toHaveBeenCalledTimes(1);
    expect(prepared.kind).toBe("rank");
    if (prepared.kind !== "rank") {
      return;
    }
    expect(prepared.registrations.map((registration) => registration.routine.id)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    expect(prepared.candidates.map((candidate) => candidate.routineId)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  it("still prunes and reorders by score when the prefilter succeeds", async () => {
    // The complement of the case above: the fallback is a failure path, not the norm.
    const prefilter: RoutineActivationPrefilter = {
      rank: vi.fn(async () => [
        { routineId: "charlie", score: 0.9 },
        { routineId: "alpha", score: 0.5 },
        { routineId: "bravo", score: 0.01 },
      ]),
    };
    const registrations = [authored("alpha"), authored("bravo"), authored("charlie")];

    const prepared = await new RoutineRegistry(registrations, { policy, activationPrefilter: prefilter })
      .prepareCandidates(turn);

    expect(prepared.kind).toBe("rank");
    if (prepared.kind !== "rank") {
      return;
    }
    expect(prepared.registrations.map((registration) => registration.routine.id)).toEqual([
      "charlie",
      "alpha",
    ]);
  });
});

describe("routine reentry policy governs completed-instance suppression", () => {
  it("offers a routine that has not completed, whatever its authored reentry mode", async () => {
    for (const mode of ["once_per_conversation", "always", "semantic"] as const) {
      const prepared = await new RoutineRegistry([authored("qualify", mode)], { policy })
        .prepareCandidates(turn, { suppressedRoutineIds: [] });

      expect(prepared.kind, `${mode} with no completed instance`).toBe("rank");
    }
  });

  it("keeps an `always` routine eligible after it has completed", async () => {
    const prepared = await new RoutineRegistry([authored("repeatable", "always")], { policy })
      .prepareCandidates(turn, { suppressedRoutineIds: ["repeatable"] });

    expect(prepared.kind).toBe("rank");
    if (prepared.kind !== "rank") {
      return;
    }
    expect(prepared.registrations.map((registration) => registration.routine.id)).toEqual(["repeatable"]);
  });

  it("suppresses a `once_per_conversation` routine after it has completed", async () => {
    const prepared = await new RoutineRegistry([authored("lead-capture", "once_per_conversation")], { policy })
      .prepareCandidates(turn, { suppressedRoutineIds: ["lead-capture"] });

    expect(prepared).toEqual({ kind: "none" });
  });

  it("treats a routine with no authored activation as `once_per_conversation`", async () => {
    // Hand-built registrations (tests, hosts embedding the kit) declare no reentry mode.
    // Absent policy must resolve to the safe historical default, not to `always`.
    const prepared = await new RoutineRegistry([authored("legacy")], { policy })
      .prepareCandidates(turn, { suppressedRoutineIds: ["legacy"] });

    expect(prepared).toEqual({ kind: "none" });
  });

  it("suppresses a completed `semantic` routine from fresh ranked activation", async () => {
    // `semantic` re-opens the *completed instance* through the reentry gate, which runs
    // before activation. It never re-enters through ranked activation, so at this seam it
    // behaves exactly like the default.
    const prepared = await new RoutineRegistry([authored("qualify", "semantic")], { policy })
      .prepareCandidates(turn, { suppressedRoutineIds: ["qualify"] });

    expect(prepared).toEqual({ kind: "none" });
  });

  it("never asks the ranking model about a routine the reentry policy suppressed", async () => {
    const gw = gateway(JSON.stringify({ matches: [] }));

    const result = await new RoutineRegistry([authored("lead-capture", "once_per_conversation")], { policy })
      .activator(gw)
      .activate({ turn, suppressedRoutineIds: ["lead-capture"] });

    expect(gw.complete).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("semantic reentry gate composes with completed-instance suppression", () => {
  const completedState: RoutineState = {
    sessionId: "session_1",
    routineId: "qualify",
    path: ["done"],
    variables: { budget: "10k" },
    status: "completed",
  };

  it("is inert for a routine that has not completed, because it is only consulted for completed state", async () => {
    // The gate's only input is a completed instance; a routine with none never reaches it
    // and stays eligible for normal ranked activation instead.
    const prepared = await new RoutineRegistry([authored("qualify", "semantic")], { policy })
      .prepareCandidates(turn, {});

    expect(prepared.kind).toBe("rank");
  });

  it("does not offer a completed `semantic` routine when the gate suppresses", async () => {
    const gw = gateway(JSON.stringify({ decision: "suppress" }));
    const routine = gatedRoutine("qualify", "semantic", "Qualify a prospect.");

    const decision = await new RoutineReentryGate([routine], gw).decide({ turn, completedState });
    const prepared = await new RoutineRegistry([{ routine, trigger: { description: "q", priority: 0 } }], { policy })
      .prepareCandidates(turn, { suppressedRoutineIds: ["qualify"] });

    // Gate declines to reopen the completed instance, and ranked activation will not
    // start a fresh one: the routine is offered by neither path.
    expect(decision).toEqual({ kind: "suppress" });
    expect(prepared).toEqual({ kind: "none" });
  });

  it("reopens the completed instance when the gate says so", async () => {
    const gw = gateway(JSON.stringify({ decision: "resume_existing" }));
    const routine = gatedRoutine("qualify", "semantic", "Qualify a prospect.");

    const decision = await new RoutineReentryGate([routine], gw).decide({ turn, completedState });

    expect(decision).toEqual({ kind: "resume_existing" });
    expect(gw.complete).toHaveBeenCalledTimes(1);
  });

  it("suppresses without a model call for a non-semantic routine", async () => {
    for (const mode of ["once_per_conversation", "always"] as const) {
      const gw = gateway(JSON.stringify({ decision: "start_new" }));
      const routine = gatedRoutine("qualify", mode, "Qualify a prospect.");

      const decision = await new RoutineReentryGate([routine], gw).decide({ turn, completedState });

      expect(decision, mode).toEqual({ kind: "suppress" });
      expect(gw.complete, mode).not.toHaveBeenCalled();
    }
  });
});
