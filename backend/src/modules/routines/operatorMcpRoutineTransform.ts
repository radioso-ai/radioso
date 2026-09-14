import type { RoutineDefinition, RoutineDefinitionDraftAuthoringInput } from "./domain.js";
import { draftInputFromRoutine } from "./authoringEdit.js";

type RoutineStep = RoutineDefinitionDraftAuthoringInput["steps"][number];
type RoutineSlot = NonNullable<RoutineDefinitionDraftAuthoringInput["slots"]>[number];
type RoutineTransition = NonNullable<RoutineDefinitionDraftAuthoringInput["transitions"]>[number];
type RoutineTerminal = RoutineDefinitionDraftAuthoringInput["terminals"][number];

type OperatorMcpRoutineTransformOperation =
  | { kind: "set_enabled"; enabled: boolean }
  | { kind: "reorder_steps"; stableStepIds: readonly string[] }
  | { kind: "insert_step"; step: RoutineStep }
  | { kind: "replace_step"; previous: RoutineStep; next: RoutineStep }
  | { kind: "remove_step"; stableStepId: string }
  | { kind: "insert_slot"; slot: RoutineSlot }
  | { kind: "replace_slot"; previous: RoutineSlot; next: RoutineSlot }
  | { kind: "remove_slot"; stableSlotId: string }
  | { kind: "insert_terminal"; terminal: RoutineTerminal }
  | { kind: "replace_terminal"; previous: RoutineTerminal; next: RoutineTerminal }
  | { kind: "remove_terminal"; stableStepId: string }
  | { kind: "insert_transition"; transition: RoutineTransition }
  | { kind: "replace_transition"; previous: RoutineTransition; next: RoutineTransition }
  | { kind: "remove_transition"; transition: RoutineTransition };

interface OperatorMcpRoutineTransform {
  operations: readonly OperatorMcpRoutineTransformOperation[];
}

export interface OperatorMcpRoutineTransformReferenceGuard {
  assertNoScopedReferences(input: { readonly removedNodeIds: readonly string[]; readonly removedSlotIds: readonly string[] }): void;
}

export class RoutineTransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineTransformError";
  }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Routine transform identity accepts JSON values only");
};

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const exactIndex = <T>(items: readonly T[], target: T, description: string): number => {
  const indexes = items.flatMap((item, index) => same(item, target) ? [index] : []);
  if (indexes.length === 0) throw new RoutineTransformError(`The ${description} no longer exists.`);
  if (indexes.length > 1) throw new RoutineTransformError(`The ${description} reference is ambiguous.`);
  return indexes[0];
};

const replaceExact = <T>(items: readonly T[], previous: T, next: T, description: string): T[] => {
  const index = exactIndex(items, previous, description);
  return items.map((item, current) => current === index ? next : item);
};

const removeExact = <T>(items: readonly T[], target: T, description: string): T[] => {
  const index = exactIndex(items, target, description);
  return items.filter((_, current) => current !== index);
};

const requireKnown = (known: readonly string[], id: string, description: string): void => {
  if (!known.includes(id)) throw new RoutineTransformError(`This routine has no ${description} "${id}".`);
};

const requireNew = (known: readonly string[], id: string, description: string): void => {
  if (known.includes(id)) throw new RoutineTransformError(`The ${description} id "${id}" already exists.`);
};

const requireSameStableId = (previous: string, next: string, description: string): void => {
  if (previous !== next) throw new RoutineTransformError(`A ${description} replacement must preserve its stable id.`);
};

const reorderedSteps = (steps: readonly RoutineStep[], stableStepIds: readonly string[]): RoutineStep[] => {
  const known = steps.map((step) => step.stableStepId);
  if (stableStepIds.length !== known.length || new Set(stableStepIds).size !== known.length || stableStepIds.some((id) => !known.includes(id))) {
    throw new RoutineTransformError("Step reorder must provide one complete, non-repeating list of current step ids.");
  }
  const ordinalById = new Map(stableStepIds.map((id, ordinal) => [id, ordinal]));
  return steps.map((step) => ({ ...step, ordinal: ordinalById.get(step.stableStepId)! }));
};

const referencesSlot = (draft: RoutineDefinitionDraftAuthoringInput, slot: RoutineSlot): boolean => {
  const template = (value: unknown): boolean => typeof value === "string"
    && new RegExp(`\\{\\{\\s*slot\\.(?:${slot.key}|${slot.stableSlotId})\\s*\\}\\}`, "u").test(value);
  const fieldReference = (value: unknown): boolean => value === slot.key || value === slot.stableSlotId
    || value === `slot.${slot.key}` || value === `slot.${slot.stableSlotId}`;
  const bindingReference = (step: RoutineStep): boolean => Object.values(step.metadata?.inputBindings ?? {}).some((binding) =>
    binding && typeof binding === "object"
    && (binding as { kind?: unknown }).kind === "variableRef"
    && fieldReference((binding as { ref?: unknown }).ref));
  return [...draft.steps, ...draft.terminals].some((node) => template(node.instruction))
    || draft.steps.some(bindingReference)
    || (draft.transitions ?? []).some((transition) => fieldReference((transition as { fieldRef?: unknown }).fieldRef)
      || template((transition as { guardText?: unknown }).guardText));
};

/**
 * Applies only explicit graph operations. The returned draft must be sent to the routine owner,
 * whose existing validation remains the canonical acceptance policy.
 */
export const applyOperatorMcpRoutineTransform = (
  routine: RoutineDefinition,
  transform: OperatorMcpRoutineTransform,
  referenceGuard?: OperatorMcpRoutineTransformReferenceGuard,
): RoutineDefinitionDraftAuthoringInput => {
  let draft = draftInputFromRoutine(routine);
  const removedNodeIds = new Set<string>();
  const removedSlots: RoutineSlot[] = [];

  for (const operation of transform.operations) {
    switch (operation.kind) {
      case "set_enabled": draft = { ...draft, enabled: operation.enabled }; break;
      case "reorder_steps": draft = { ...draft, steps: reorderedSteps(draft.steps, operation.stableStepIds) }; break;
      case "insert_step":
        requireNew([...draft.steps, ...draft.terminals].map((node) => node.stableStepId), operation.step.stableStepId, "node");
        draft = { ...draft, steps: [...draft.steps, operation.step] };
        break;
      case "replace_step":
        requireSameStableId(operation.previous.stableStepId, operation.next.stableStepId, "step");
        draft = { ...draft, steps: replaceExact(draft.steps, operation.previous, operation.next, "step") };
        break;
      case "remove_step":
        requireKnown(draft.steps.map((step) => step.stableStepId), operation.stableStepId, "step");
        removedNodeIds.add(operation.stableStepId);
        draft = { ...draft, steps: draft.steps.filter((step) => step.stableStepId !== operation.stableStepId) };
        break;
      case "insert_slot":
        requireNew((draft.slots ?? []).map((slot) => slot.stableSlotId), operation.slot.stableSlotId, "slot");
        requireNew((draft.slots ?? []).map((slot) => slot.key), operation.slot.key, "slot key");
        draft = { ...draft, slots: [...(draft.slots ?? []), operation.slot] };
        break;
      case "replace_slot":
        requireSameStableId(operation.previous.stableSlotId, operation.next.stableSlotId, "slot");
        requireSameStableId(operation.previous.key, operation.next.key, "slot key");
        draft = { ...draft, slots: replaceExact(draft.slots ?? [], operation.previous, operation.next, "slot") };
        break;
      case "remove_slot":
        requireKnown((draft.slots ?? []).map((slot) => slot.stableSlotId), operation.stableSlotId, "slot");
        removedSlots.push((draft.slots ?? []).find((slot) => slot.stableSlotId === operation.stableSlotId)!);
        draft = { ...draft, slots: (draft.slots ?? []).filter((slot) => slot.stableSlotId !== operation.stableSlotId) };
        break;
      case "insert_terminal":
        requireNew([...draft.steps, ...draft.terminals].map((node) => node.stableStepId), operation.terminal.stableStepId, "node");
        draft = { ...draft, terminals: [...draft.terminals, operation.terminal] };
        break;
      case "replace_terminal":
        requireSameStableId(operation.previous.stableStepId, operation.next.stableStepId, "ending");
        draft = { ...draft, terminals: replaceExact(draft.terminals, operation.previous, operation.next, "ending") };
        break;
      case "remove_terminal":
        requireKnown(draft.terminals.map((terminal) => terminal.stableStepId), operation.stableStepId, "ending");
        removedNodeIds.add(operation.stableStepId);
        draft = { ...draft, terminals: draft.terminals.filter((terminal) => terminal.stableStepId !== operation.stableStepId) };
        break;
      case "insert_transition": draft = { ...draft, transitions: [...(draft.transitions ?? []), operation.transition] }; break;
      case "replace_transition": draft = { ...draft, transitions: replaceExact(draft.transitions ?? [], operation.previous, operation.next, "transition") }; break;
      case "remove_transition": draft = { ...draft, transitions: removeExact(draft.transitions ?? [], operation.transition, "transition") }; break;
    }
  }

  const survivingIds = new Set([...draft.steps.map((step) => step.stableStepId), ...draft.terminals.map((terminal) => terminal.stableStepId)]);
  for (const id of removedNodeIds) {
    if (survivingIds.has(id)) continue;
    if ((draft.transitions ?? []).some((transition) => transition.fromStep === id || transition.toRef === id)) {
      throw new RoutineTransformError(`Removed node "${id}" is still referenced; retarget or remove every connection in this transform.`);
    }
  }
  for (const slot of removedSlots) {
    if (referencesSlot(draft, slot)) {
      throw new RoutineTransformError(`Removed slot "${slot.stableSlotId}" is still referenced; update every local and scoped reference in this transform.`);
    }
  }
  referenceGuard?.assertNoScopedReferences({
    removedNodeIds: [...removedNodeIds].filter((id) => !survivingIds.has(id)),
    removedSlotIds: removedSlots.map((slot) => slot.stableSlotId),
  });
  return draft;
};
