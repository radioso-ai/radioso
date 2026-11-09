import { describe, expect, it } from "vitest";

import type { Routine } from "@radioso/conversation-contract";
import { completedRunSentValues } from "@radioso/conversation-engine";

import { compileRoutineDefinition, routineAdvisoriesWithMessages } from "../../src/modules/routines/public.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";
import { bookStayRoutine } from "../support/bookingConversationHarness.js";

/**
 * Two statements of one rule (#1714): the authoring advisory `mutable_slot_not_correctable`
 * (`@radioso/routine-definition`) judges a definition, and the engine's `completedRunSentValues`
 * judges a finished run of the compiled routine. The advisory must fire exactly when every run
 * that can end has sent what it held, so for each shape below it is compared against every
 * route through the compiled graph.
 */

type Step = RoutineDefinition["steps"][number];
type Transition = RoutineDefinition["transitions"][number];
type Terminal = RoutineDefinition["terminals"][number];

const step = (stableStepId: string, kind: Step["kind"], ordinal: number): Step => ({
  stableStepId,
  kind,
  instruction: `Run ${stableStepId}`,
  toolRef: kind === "tool" ? "availability" : null,
  actionType: kind === "action" ? "booking.request" : null,
  ...(kind === "approval" ? { captureKey: "approved", options: [{ id: "yes", label: "Approve" }] } : {}),
  ordinal,
  metadata: {},
});

const edge = (fromStep: string, toRef: string, ordinal: number): Transition => ({
  ...bookStayRoutine.transitions[1],
  fromStep,
  toRef,
  ordinal,
});

const quietEnd: Terminal = { stableStepId: "just_looking", kind: "complete", instruction: "Say goodbye.", ordinal: 0 };
const notifiedEnd: Terminal = bookStayRoutine.terminals[1];

const shape = (overrides: Partial<RoutineDefinition>): RoutineDefinition => ({ ...bookStayRoutine, ...overrides });

/** Every route from the first step to an ending, visiting no step twice. */
const routes = (routine: Routine): string[][] => {
  const found: string[][] = [];
  const walk = (path: string[]): void => {
    const current = routine.steps.find((candidate) => candidate.id === path.at(-1));
    if (current?.kind === "terminal") {
      found.push(path);
      return;
    }
    for (const transition of routine.transitions.filter((candidate) => candidate.from === path.at(-1))) {
      if (!path.includes(transition.to)) walk([...path, transition.to]);
    }
  };
  walk([routine.rootStepId]);
  return found;
};

const cases: Array<{ name: string; definition: RoutineDefinition; advisory: boolean }> = [
  { name: "a quiet ending beside a notifying one", definition: bookStayRoutine, advisory: false },
  {
    name: "only a notifying ending",
    definition: shape({ transitions: [edge("dates", "requested", 0)], terminals: [notifiedEnd] }),
    advisory: true,
  },
  ...(["tool", "action", "approval"] as const).map((kind) => ({
    name: `a quiet ending past a ${kind} step`,
    definition: shape({
      steps: [bookStayRoutine.steps[0], step("lookup", kind, 1)],
      transitions: [
        edge("dates", "lookup", 0),
        kind === "approval"
          ? { ...edge("lookup", "just_looking", 1), guardKind: "field", fieldRef: "approved.id", fieldOp: "equals", fieldValue: "yes" }
          : edge("lookup", "just_looking", 1),
      ],
      terminals: [quietEnd],
    }),
    advisory: true,
  })),
  {
    name: "a quiet ending the completion export fires on",
    definition: shape({
      transitions: [edge("dates", "just_looking", 0)],
      terminals: [quietEnd],
      completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: "crm" },
    }),
    advisory: true,
  },
  {
    name: "a quiet ending with an export that fires only on hand-off",
    definition: shape({
      transitions: [edge("dates", "just_looking", 0)],
      terminals: [quietEnd],
      completionExport: { enabled: true, triggerKinds: ["handoff"], destinationRef: "crm" },
    }),
    advisory: false,
  },
  {
    name: "only a hand-off",
    definition: shape({
      transitions: [edge("dates", "just_looking", 0)],
      terminals: [{ ...quietEnd, kind: "handoff" }],
    }),
    advisory: true,
  },
];

describe("mutable_slot_not_correctable agrees with completedRunSentValues (#1714)", () => {
  it.each(cases)("$name", ({ definition, advisory }) => {
    const compiled = compileRoutineDefinition(definition);
    const everyRouteSends = routes(compiled).every((path) => completedRunSentValues(compiled, {
      sessionId: "s1",
      routineId: compiled.id,
      path,
      variables: {},
      status: "completed",
    }));
    const flagged = routineAdvisoriesWithMessages(definition)
      .filter((finding) => finding.code === "mutable_slot_not_correctable")
      .map((finding) => finding.location);

    expect(everyRouteSends).toBe(advisory);
    expect(flagged).toEqual(advisory ? ["slot:arrival.mutable", "slot:departure.mutable"] : []);
  });

  it("words the advisory with the field's key only", () => {
    const [finding] = routineAdvisoriesWithMessages(cases[1].definition);
    expect(finding).toEqual({
      code: "mutable_slot_not_correctable",
      location: "slot:arrival.mutable",
      message: expect.stringContaining("@arrival can't be changed once this routine ends"),
    });
  });
});
