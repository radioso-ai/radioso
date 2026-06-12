import type { Routine, RoutineGuard, RoutineSkillOutcomeStatus, RoutineSlotSchema, RoutineStep } from "@radioso/conversation-contract";

import type { RoutineDefinition } from "./domain.js";
import { validateRoutineDefinition } from "./validator.js";

// The compiled routine id IS the definition id. Directive scope tags
// (`routine:<id>` / `step:<id>:<stepId>`), the engine's activeRoutineId, the
// publish-time scope-tag re-point, and new routine_states pins must all share
// one identity; the old synthetic `routine:<agent>:<name>:v<n>` id broke that
// (and its colons broke the engine's step-scope tag grammar).
const routineId = (definition: RoutineDefinition): string => definition.id;

// Pre-cutover routine_states pinned this synthetic id; kept ONLY so in-flight
// sessions started before the identity unification can resume until their
// state rows age out (routine_states TTL). Never used for new ids.
export const legacyCompiledRoutineId = (definition: RoutineDefinition): string =>
  `routine:${definition.agentId}:${definition.name}:v${definition.version}`;

const conditionFor = (guardKind: string, guardText: string | null): string =>
  guardKind === "llm" ? guardText ?? guardKind : guardKind;

const slotReferencePattern = /\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;

const collectedSlotKeys = (instruction: string): string[] => {
  const keys = new Set<string>();
  for (const match of instruction.matchAll(slotReferencePattern)) {
    const key = match[1];
    if (key) {
      keys.add(key);
    }
  }
  return [...keys];
};

const parsePositiveInteger = (value: string | null): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && String(parsed) === value.trim() ? parsed : null;
};

const guardFor = (transition: RoutineDefinition["transitions"][number]): RoutineGuard | undefined => {
  switch (transition.guardKind) {
    case "slot_filled": {
      const slots = collectedSlotKeys(transition.guardText ?? "");
      return { kind: "slot_filled", slots };
    }
    case "outcome": {
      const status = transition.outcomeStatus ?? transition.guardText;
      return status ? { kind: "outcome", status: status as RoutineSkillOutcomeStatus } : undefined;
    }
    case "counter": {
      const limit = transition.counterLimit ?? parsePositiveInteger(transition.guardText);
      return limit ? { kind: "counter", limit } : undefined;
    }
    case "default":
      return { kind: "default" };
    default:
      return undefined;
  }
};

export const compileRoutineDefinition = (definition: RoutineDefinition): Routine => {
  const validation = validateRoutineDefinition(definition);
  if (!validation.ok) {
    const details = validation.diagnostics.map((diagnostic) => `${diagnostic.location}: ${diagnostic.message}`).join("; ");
    throw new Error(`routine_definition_invalid:${details}`);
  }

  const sortedSteps = [...definition.steps].sort((left, right) => left.ordinal - right.ordinal);
  const sortedTerminals = [...definition.terminals].sort((left, right) => left.ordinal - right.ordinal);
  const slots: RoutineSlotSchema[] = [...definition.slots]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((slot) => ({
      id: slot.stableSlotId,
      key: slot.key,
      type: slot.type,
      required: slot.required,
      description: slot.description ?? undefined,
    }));
  const steps: RoutineStep[] = [
    ...sortedSteps.map((step): RoutineStep => {
      const collectsSlots = collectedSlotKeys(step.instruction);
      if (step.kind === "tool") {
        return {
          id: step.stableStepId,
          kind: "skill",
          skillName: step.toolRef ?? undefined,
          action: step.instruction,
          metadata: {
            ...step.metadata,
            authoredKind: step.kind,
            ...(collectsSlots.length > 0 ? { collectsSlots } : {}),
          },
        };
      }
      if (step.kind === "action") {
        return {
          id: step.stableStepId,
          kind: "action",
          actionType: step.actionType ?? undefined,
          metadata: Object.keys(step.metadata).length > 0
            ? { ...step.metadata, authoredKind: step.kind, ...(collectsSlots.length > 0 ? { collectsSlots } : {}) }
            : { authoredKind: step.kind, ...(collectsSlots.length > 0 ? { collectsSlots } : {}) },
        };
      }
      return {
        id: step.stableStepId,
        kind: "chat",
        action: step.instruction,
        metadata: Object.keys(step.metadata).length > 0
          ? { ...step.metadata, authoredKind: step.kind, ...(collectsSlots.length > 0 ? { collectsSlots } : {}) }
          : { authoredKind: step.kind, ...(collectsSlots.length > 0 ? { collectsSlots } : {}) },
      };
    }),
    ...sortedTerminals.map((terminal): RoutineStep => {
      return {
        id: terminal.stableStepId,
        kind: "terminal",
        action: terminal.instruction ?? undefined,
        metadata: { terminalKind: terminal.kind },
      };
    }),
  ];

  return {
    id: routineId(definition),
    rootStepId: sortedSteps[0]!.stableStepId,
    slots,
    steps,
    transitions: [...definition.transitions]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((transition) => {
        const guard = guardFor(transition);
        return {
          from: transition.fromStep,
          to: transition.toRef,
          condition: conditionFor(transition.guardKind, transition.guardText),
          ...(guard ? { guard } : {}),
        };
      }),
    ...(definition.completionExport?.enabled
      ? {
          completionExport: {
            enabled: true,
            triggerKinds: [...definition.completionExport.triggerKinds],
            destinationRef: definition.completionExport.destinationRef.trim(),
          },
        }
      : {}),
    metadata: {
      definitionId: definition.id,
      agentId: definition.agentId,
      name: definition.name,
      version: definition.version,
      activation: {
        triggerDescription: definition.activation.triggerDescription,
        gateRef: definition.activation.gateRef,
        priority: definition.activation.priority,
      },
      slotSchema: slots,
    },
  };
};
