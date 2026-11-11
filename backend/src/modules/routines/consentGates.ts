import type { RoutineConsent, RoutineStep, RoutineTransition } from "@radioso/conversation-contract";

import type { RoutineDefinition } from "./domain.js";

type ConsentDefinition = NonNullable<RoutineDefinition["consents"]>[number];

interface CompiledRoutineGraph {
  rootStepId: string;
  steps: RoutineStep[];
  transitions: RoutineTransition[];
}

/**
 * The compiled id of the step that asks consent `key` before step `stepId`. Authored ids match
 * `routineIdentifierPattern`, which has no colon, so a gate id never collides with one.
 */
const consentGateStepId = (key: string, stepId: string): string => `consent:${key}:${stepId}`;

/** The consent key a compiled consent step id names; null for any other step id. */
export const consentKeyOfGateStepId = (stepId: string): string | null => {
  const [prefix, key, ...rest] = stepId.split(":");
  return prefix === "consent" && key && rest.length > 0 ? key : null;
};

const gateExit = (from: string, to: string): RoutineTransition => ({
  from,
  to,
  condition: "default",
  guard: { kind: "default" },
});

/**
 * Places a routine's consents in its compiled graph (#1544). For every step that collects a slot a
 * consent covers, by the one collection rule the compiler and validation share
 * (`collectedSlotsByStep`), a `consent` step asking it goes immediately before that step: every
 * transition into the step leads to the gate instead, and the gate's default exit leads on to it. A
 * step whose slots two consents cover gets both gates, chained in the order the consents are
 * written. A gated root step hands the root to its first gate. A consent placed this way cannot be
 * asked anywhere but right before its slot is collected.
 *
 * Knows where gates go; what a gate does at runtime is the engine's.
 */
export const withConsentGates = (
  graph: CompiledRoutineGraph,
  consents: readonly ConsentDefinition[],
  slotsCollectedByStep: ReadonlyMap<string, readonly string[]>,
): CompiledRoutineGraph & { consents: RoutineConsent[] } => {
  const seenKeys = new Set<string>();
  for (const { key } of consents) {
    // Two consents with one key would compile to gates the engine cannot tell apart. Validation
    // reports the authoring error (`consent_key_duplicate`); compiling refuses it.
    if (seenKeys.has(key)) throw new Error(`routine_consent_key_duplicate:${key}`);
    seenKeys.add(key);
  }

  // The gates before each collecting step, in the order the consents are written.
  const gatesBefore = new Map<string, RoutineStep[]>();
  for (const step of graph.steps) {
    const collected = new Set(slotsCollectedByStep.get(step.id) ?? []);
    const gates = consents
      .filter((consent) => consent.slotKeys.some((key) => collected.has(key)))
      .map((consent): RoutineStep => ({ id: consentGateStepId(consent.key, step.id), kind: "consent", consentKey: consent.key }));
    if (gates.length > 0) gatesBefore.set(step.id, gates);
  }
  const entryTo = (stepId: string): string => gatesBefore.get(stepId)?.[0]?.id ?? stepId;

  return {
    rootStepId: entryTo(graph.rootStepId),
    steps: graph.steps.flatMap((step) => [...(gatesBefore.get(step.id) ?? []), step]),
    transitions: [
      ...graph.transitions.map((transition) => ({ ...transition, to: entryTo(transition.to) })),
      ...[...gatesBefore].flatMap(([stepId, gates]) =>
        gates.map((gate, index) => gateExit(gate.id, gates[index + 1]?.id ?? stepId))),
    ],
    consents: consents.map(({ key, slotKeys, onDecline }) => ({ key, slotKeys: [...slotKeys], onDecline })),
  };
};
