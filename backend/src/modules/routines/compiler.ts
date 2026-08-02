import type { Routine, RoutineGuard, RoutineSkillOutcomeStatus, RoutineSlotSchema, RoutineStep } from "@radioso/conversation-contract";

import type { RoutineDefinition, RoutineStepMetadata } from "./domain.js";
import { collectSlotKeys, collectedSlotsByStep } from "./slotCollection.js";
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
      const slots = collectSlotKeys(transition.guardText ?? "");
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
    case "field": {
      if (!transition.fieldRef || !transition.fieldOp) {
        return undefined;
      }
      return {
        kind: "field",
        ref: transition.fieldRef,
        op: transition.fieldOp,
        ...(transition.fieldValue !== null && transition.fieldValue !== undefined ? { value: transition.fieldValue } : {}),
        ...(transition.fieldValues ? { values: transition.fieldValues } : {}),
        ...(transition.fieldUnit ? { unit: transition.fieldUnit } : {}),
      };
    }
    case "default":
      return { kind: "default" };
    default:
      return undefined;
  }
};

type TypedStepMetadata = Pick<RoutineStepMetadata, "inputBindings" | "outputAssignments" | "mode">;

const typedStepMetadata = (metadata: RoutineStepMetadata): TypedStepMetadata => ({
  ...(metadata.inputBindings ? { inputBindings: metadata.inputBindings } : {}),
  ...(metadata.outputAssignments ? { outputAssignments: metadata.outputAssignments } : {}),
  ...(metadata.mode ? { mode: metadata.mode } : {}),
});

const authoredMetadata = (metadata: RoutineStepMetadata): Record<string, unknown> => {
  const { inputBindings: _inputBindings, outputAssignments: _outputAssignments, mode: _mode, ...authorMetadata } = metadata;
  return authorMetadata;
};

export const compileRoutineDefinition = (definition: RoutineDefinition): Routine => {
  const validation = validateRoutineDefinition(definition);
  if (!validation.ok) {
    const details = validation.diagnostics.map((diagnostic) => `${diagnostic.location}: ${diagnostic.message}`).join("; ");
    throw new Error(`routine_definition_invalid:${details}`);
  }

  const sortedSteps = [...definition.steps].sort((left, right) => left.ordinal - right.ordinal);
  const sortedTerminals = [...definition.terminals].sort((left, right) => left.ordinal - right.ordinal);

  // Auto-gate slot-collection steps. A chat step that asks for a {{slot.x}} must run the
  // LLM selector to capture the answer and wait for it — the selector is the only place
  // `variables` are extracted (runner) and it runs only for steps with an `llm` edge.
  // Authoring tools wire a plain sequential step list with bare `default` edges, which
  // the runner advances unconditionally and WITHOUT the selector, so the asked-for slot
  // is never captured (the step is even skipped on the activation turn). Promote the edge
  // to `llm` (selector-running) only for the exact plain-sequential signature: a `chat`
  // step whose SOLE exit is a `default` edge.
  //   - Restricted to `chat`: the runner treats tool/action step edges differently (a
  //     single skill edge auto-advances; action edges ignore guards), so promotion there
  //     is at best a no-op and at worst a behavior change.
  //   - Restricted to a single exit: multiple `default` exits are ambiguous (the selector
  //     cannot tell two identical conditions apart), and a step that already carries a
  //     structured (`slot_filled`/`counter`/`field`) or `llm` exit is deliberately shaped.
  //     Both are left exactly as authored.
  // A slot is *collected* by the FIRST chat step (in ordinal order) that references it; a
  // later `{{slot.x}}` reference is a *use* (interpolation), not a re-collection. Without
  // this, a content step that merely personalizes with an already-filled slot would be
  // flagged as a collection step and the runner would fast-forward (skip) it, silently
  // dropping its message. This rule is shared with the population analysis (see
  // slotCollection.ts) so validation and runtime agree on where a variable is produced.
  const slotsCollectedByStep = collectedSlotsByStep(definition);
  const collectedSlotsForStep = (step: RoutineDefinition["steps"][number]): string[] =>
    slotsCollectedByStep.get(step.stableStepId) ?? [];
  const autoGatedStepIds = new Set(
    [...slotsCollectedByStep.keys()].filter((stepId) => {
      const outgoing = definition.transitions.filter((transition) => transition.fromStep === stepId);
      return outgoing.length === 1 && outgoing[0]!.guardKind === "default";
    }),
  );
  // Slot-aware condition for the promoted edge, mirroring authored llm guardText so the
  // selector can judge "did the user answer?" by meaning (no keyword matching).
  const autoGateCondition = (collected: string[]): string =>
    `The user provided ${collected.map((slot) => `{{slot.${slot}}}`).join(" and ")}.`;

  const slots: RoutineSlotSchema[] = [...definition.slots]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((slot) => ({
      id: slot.stableSlotId,
      key: slot.key,
      type: slot.type,
      required: slot.required,
      description: slot.description ?? undefined,
      ...(slot.mutable ? { mutable: true } : {}),
    }));
  const steps: RoutineStep[] = [
    ...sortedSteps.map((step): RoutineStep => {
      const collectsSlots = collectedSlotsForStep(step);
      const authorMetadata = authoredMetadata(step.metadata);
      if (step.kind === "approval") {
        return {
          id: step.stableStepId,
          kind: "await",
          action: step.instruction,
          decision: {
            captureKey: step.captureKey ?? "",
            options: (step.options ?? []).map((option) => ({
              id: option.id,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
            })),
          },
          metadata: Object.keys(authorMetadata).length > 0
            ? { ...authorMetadata, authoredKind: step.kind }
            : { authoredKind: step.kind },
        };
      }
      if (step.kind === "tool") {
        return {
          id: step.stableStepId,
          kind: "skill",
          skillName: step.toolRef ?? undefined,
          action: step.instruction,
          ...typedStepMetadata(step.metadata),
          metadata: {
            ...authorMetadata,
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
          metadata: Object.keys(authorMetadata).length > 0
            ? { ...authorMetadata, authoredKind: step.kind, ...(collectsSlots.length > 0 ? { collectsSlots } : {}) }
            : { authoredKind: step.kind, ...(collectsSlots.length > 0 ? { collectsSlots } : {}) },
        };
      }
      return {
        id: step.stableStepId,
        kind: "chat",
        action: step.instruction,
        metadata: Object.keys(authorMetadata).length > 0
          ? { ...authorMetadata, authoredKind: step.kind, ...(collectsSlots.length > 0 ? { collectsSlots } : {}) }
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
        if (autoGatedStepIds.has(transition.fromStep)) {
          // Promote the bare default edge to a selector-running (llm) transition: no
          // structured guard, slot-aware condition. Extraction + gating now happen.
          return {
            from: transition.fromStep,
            to: transition.toRef,
            condition: autoGateCondition(slotsCollectedByStep.get(transition.fromStep) ?? []),
          };
        }
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
    activation: {
      triggerDescription: definition.activation.triggerDescription,
      ...(definition.activation.gateRef ? { gateRef: definition.activation.gateRef } : {}),
      priority: definition.activation.priority,
      // Default keeps definitions authored before reentry modes existed suppressing
      // on completion (the historical, safe behaviour).
      reentryMode: definition.activation.reentryMode ?? "once_per_conversation",
    },
    metadata: {
      definitionId: definition.id,
      agentId: definition.agentId,
      name: definition.name,
      version: definition.version,
      slotSchema: slots,
    },
  };
};
