import type { Routine, RoutineSlotSchema, RoutineStep } from "@radioso/conversation-contract";

import type { RoutineDefinition } from "./domain.js";
import { validateRoutineDefinition } from "./validator.js";

const routineId = (definition: RoutineDefinition): string =>
  `routine:${definition.agentId}:${definition.name}:v${definition.version}`;

const conditionFor = (guardKind: string, guardText: string | null): string =>
  guardText ?? guardKind;

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
      if (terminal.kind === "action") {
        return {
          id: terminal.stableStepId,
          kind: "action",
          actionType: terminal.actionType ?? undefined,
          metadata: { terminalKind: terminal.kind },
        };
      }
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
      .map((transition) => ({
        from: transition.fromStep,
        to: transition.toRef,
        condition: conditionFor(transition.guardKind, transition.guardText),
      })),
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
