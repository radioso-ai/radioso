import { z } from "zod";

import {
  ROUTINE_DEFINITION_LIMITS,
  routineReentryModes,
  type RoutineDefinition,
  type RoutineDefinitionDraftAuthoringInput,
} from "./domain.js";

/**
 * What an authoring surface outside the routine editor may change about a routine.
 *
 * Every edit addresses an existing element by its stable id, so applying a patch can never
 * renumber or re-key the graph. That is load-bearing rather than convenient: publishing repoints
 * directive scope tags by surviving stable step id, so an edit that regenerated step ids would
 * silently orphan every directive scoped to a step. Structural changes — adding or removing a
 * step, retargeting a transition — are deliberately not expressible here and belong in the
 * routine editor.
 */
// Each element is edited once. Two entries for the same id read as two changes and apply as one,
// silently dropping whichever came first.
const addressedOnce = <TItem>(
  schema: z.ZodType<TItem[], z.ZodTypeDef, unknown>,
  identify: (item: TItem) => string,
  element: string,
) => schema.refine(
  (items) => new Set(items.map(identify)).size === items.length,
  { message: `each ${element} may be edited only once` },
);

export const routineFieldPatchSchema = z.object({
  name: z.string().trim().min(1).max(ROUTINE_DEFINITION_LIMITS.name).optional(),
  activation: z.object({
    triggerDescription: z.string().trim().min(1).max(ROUTINE_DEFINITION_LIMITS.triggerDescription).optional(),
    priority: z.number().int().optional(),
    reentryMode: z.enum(routineReentryModes).optional(),
  }).strict().partial().refine((activation) => Object.keys(activation).length > 0, {
    message: "activation must change at least one field",
  }).optional(),
  steps: addressedOnce(z.array(z.object({
    stableStepId: z.string().trim().min(1).max(ROUTINE_DEFINITION_LIMITS.stableId),
    instruction: z.string().trim().min(1).max(ROUTINE_DEFINITION_LIMITS.instruction),
  }).strict()).min(1), (step) => step.stableStepId, "step").optional(),
  terminals: addressedOnce(z.array(z.object({
    stableStepId: z.string().trim().min(1).max(ROUTINE_DEFINITION_LIMITS.stableId),
    instruction: z.string().trim().min(1).max(ROUTINE_DEFINITION_LIMITS.instruction).nullable(),
  }).strict()).min(1), (terminal) => terminal.stableStepId, "ending").optional(),
  slots: addressedOnce(z.array(z.object({
    key: z.string().trim().min(1).max(ROUTINE_DEFINITION_LIMITS.slotKey),
    description: z.string().trim().max(ROUTINE_DEFINITION_LIMITS.slotDescription).nullable().optional(),
    required: z.boolean().optional(),
  }).strict().refine((slot) => slot.description !== undefined || slot.required !== undefined, {
    // An entry that names a field and changes nothing about it would still produce a card to apply
    // and a write that only moves the routine's version.
    message: "an information field edit must set a description or a required flag",
  })).min(1), (slot) => slot.key, "information field").optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, {
  message: "a routine edit must change at least one field",
});

export type RoutineFieldPatch = z.infer<typeof routineFieldPatchSchema>;

/** An edit that named an element the routine does not have. The message lists what it does have. */
export class RoutineFieldPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineFieldPatchError";
  }
}

const unknownIds = (element: string, missing: ReadonlyArray<string>, known: ReadonlyArray<string>): RoutineFieldPatchError =>
  new RoutineFieldPatchError(
    `This routine has no ${element} ${missing.join(", ")}. Its ${element}s are: ${known.join(", ")}.`,
  );

const requireExactlyOneAddress = <T>(
  element: string,
  addresses: ReadonlyArray<string>,
  items: ReadonlyArray<T>,
  identify: (item: T) => string,
): void => {
  const known = items.map(identify);
  const missing = addresses.filter((address) => !known.includes(address));
  if (missing.length > 0) throw unknownIds(element, missing, known);
  const duplicated = addresses.filter((address) => known.filter((candidate) => candidate === address).length > 1);
  if (duplicated.length > 0) {
    throw new RoutineFieldPatchError(
      `This routine has more than one ${element} named ${duplicated.join(", ")}. Fix the duplicate identity before editing it here.`,
    );
  }
};

/** Strips persistence identity so a stored routine re-enters the authoring schema. */
export const draftInputFromRoutine = (routine: RoutineDefinition): RoutineDefinitionDraftAuthoringInput => {
  const { id: _id, agentId: _agentId, lineageId: _lineageId, version: _version, status: _status, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = routine;
  return draft;
};

export const applyRoutineFieldPatch = (
  routine: RoutineDefinition,
  patch: RoutineFieldPatch,
): RoutineDefinitionDraftAuthoringInput => {
  const draft = draftInputFromRoutine(routine);
  const stepEdits = new Map((patch.steps ?? []).map((step) => [step.stableStepId, step]));
  const terminalEdits = new Map((patch.terminals ?? []).map((terminal) => [terminal.stableStepId, terminal]));
  const slotEdits = new Map((patch.slots ?? []).map((slot) => [slot.key, slot]));

  requireExactlyOneAddress("step", [...stepEdits.keys()], routine.steps, (step) => step.stableStepId);
  requireExactlyOneAddress("ending", [...terminalEdits.keys()], routine.terminals, (terminal) => terminal.stableStepId);
  requireExactlyOneAddress("information field", [...slotEdits.keys()], routine.slots, (slot) => slot.key);

  return {
    ...draft,
    ...(patch.name ? { name: patch.name } : {}),
    activation: { ...draft.activation, ...patch.activation },
    slots: draft.slots?.map((slot) => {
      const edit = slotEdits.get(slot.key);
      if (!edit) return slot;
      return {
        ...slot,
        ...(edit.description === undefined ? {} : { description: edit.description }),
        ...(edit.required === undefined ? {} : { required: edit.required }),
      };
    }),
    steps: draft.steps.map((step) => {
      const edit = stepEdits.get(step.stableStepId);
      return edit ? { ...step, instruction: edit.instruction } : step;
    }),
    terminals: draft.terminals.map((terminal) => {
      const edit = terminalEdits.get(terminal.stableStepId);
      return edit ? { ...terminal, instruction: edit.instruction } : terminal;
    }),
  };
};

/** Names what an edit touches, in the operator's routine vocabulary rather than field paths. */
export const describeRoutineFieldPatch = (patch: RoutineFieldPatch): string => {
  const parts: string[] = [];
  if (patch.name) parts.push("name");
  if (patch.activation?.triggerDescription) parts.push("trigger");
  if (patch.activation?.priority !== undefined) parts.push("priority");
  if (patch.activation?.reentryMode) parts.push("re-entry");
  for (const step of patch.steps ?? []) parts.push(`step ${step.stableStepId}`);
  for (const terminal of patch.terminals ?? []) parts.push(`ending ${terminal.stableStepId}`);
  for (const slot of patch.slots ?? []) parts.push(`field ${slot.key}`);
  return parts.join(", ");
};

/**
 * Projects a routine onto records keyed by stable id.
 *
 * A reviewer comparing two routines wants the changed step, not the whole graph. Generic diffing
 * walks objects and treats an array as one opaque value, so a keyed projection is what turns
 * "the steps changed" into "this step's instruction changed". Optional fields normalize to null so
 * a stored routine and the authoring draft taken from it project identically — an untouched field
 * must never read as a change.
 */
export const projectRoutineForReview = (routine: RoutineDefinitionDraftAuthoringInput): Record<string, unknown> => ({
  name: routine.name,
  activation: {
    triggerDescription: routine.activation.triggerDescription,
    gateRef: routine.activation.gateRef ?? null,
    priority: routine.activation.priority,
    reentryMode: routine.activation.reentryMode ?? "once_per_conversation",
  },
  slots: Object.fromEntries(uniquelyKeyed((routine.slots ?? []).map((slot) => [slot.key, {
    type: slot.type,
    required: slot.required,
    description: slot.description ?? null,
    mutable: slot.mutable ?? null,
    ordinal: slot.ordinal,
  }]))),
  steps: Object.fromEntries(uniquelyKeyed(routine.steps.map((step) => [step.stableStepId, {
    kind: step.kind,
    instruction: step.instruction,
    toolRef: step.toolRef ?? null,
    actionType: step.actionType ?? null,
    captureKey: step.captureKey ?? null,
    options: step.options ?? null,
    ordinal: step.ordinal,
    metadata: step.metadata ?? {},
  }]))),
  transitions: Object.fromEntries(uniquelyKeyed((routine.transitions ?? []).map((transition) => [
    `${transition.fromStep} → ${transition.toRef}`,
    {
      guardKind: transition.guardKind,
      guardText: transition.guardText ?? null,
      outcomeStatus: transition.outcomeStatus ?? null,
      counterLimit: transition.counterLimit ?? null,
      fieldRef: transition.fieldRef ?? null,
      fieldOp: transition.fieldOp ?? null,
      fieldValue: transition.fieldValue ?? null,
      fieldValues: transition.fieldValues ?? null,
      fieldUnit: transition.fieldUnit ?? null,
      ordinal: transition.ordinal,
    },
  ], ))),
  terminals: Object.fromEntries(uniquelyKeyed(routine.terminals.map((terminal) => [terminal.stableStepId, {
    kind: terminal.kind,
    instruction: terminal.instruction ?? null,
    ordinal: terminal.ordinal,
  }]))),
  completionExport: routine.completionExport ?? null,
});

// Two transitions may share a from/to pair with different guards; the ordinal disambiguates
// without making every single-transition pair read as "#0". Colliding again keeps counting rather
// than reusing a key, because a collision here would drop a changed transition out of the diff.
const uniquelyKeyed = <TValue extends { ordinal: number }>(entries: ReadonlyArray<readonly [string, TValue]>): Array<[string, TValue]> => {
  const used = new Set<string>();
  return entries.map(([key, value]) => {
    let candidate = key;
    for (let suffix = value.ordinal; used.has(candidate); suffix += 1) candidate = `${key} #${suffix}`;
    used.add(candidate);
    return [candidate, value];
  });
};
