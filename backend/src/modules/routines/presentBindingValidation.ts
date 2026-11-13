import { presentBindingOf, type RoutineValidationCode } from "@radioso/routine-definition";

import type { RoutineDefinition } from "./domain.js";

interface PresentBindingDiagnostic {
  code: RoutineValidationCode;
  location: string;
  message: string;
}

/** What an operator-facing diagnostic says of each binding rule; locations carry only ids. */
export const safePresentBindingValidationMessages: Partial<Record<RoutineValidationCode, string>> = {
  present_step_not_chat: "Only a message step can show results as cards.",
  present_source_not_earlier_tool: "A step that shows results as cards must take them from a tool step that comes before it.",
  present_slot_not_item: "A step that lets the visitor pick a card must fill a field of type item.",
  present_selection_mismatch: "A step lets the visitor pick a card exactly when it names the item field the pick fills.",
  item_slot_without_presenting_step: "An item field is filled only by a pick on a step that shows results as cards, and no step fills this one.",
};

/** The steps the routine can pass through before reaching `stepId`. */
const stepsBefore = (definition: RoutineDefinition, stepId: string): ReadonlySet<string> => {
  const reached = new Set<string>();
  const pending = [stepId];
  while (pending.length > 0) {
    const target = pending.pop();
    for (const transition of definition.transitions) {
      if (transition.toRef === target && !reached.has(transition.fromStep)) {
        reached.add(transition.fromStep);
        pending.push(transition.fromStep);
      }
    }
  }
  return reached;
};

/**
 * The rules of a presenting step (#1763): it is a message step; `from` is a tool step the routine
 * passes through before it; `slot` is a declared `item` slot; and the step lets the visitor pick
 * (`single`) exactly when it names one. An `item` slot no presenting step binds can never be filled.
 */
export const presentBindingDiagnostics = (definition: RoutineDefinition): PresentBindingDiagnostic[] => {
  const diagnostics: PresentBindingDiagnostic[] = [];
  const stepById = new Map(definition.steps.map((step) => [step.stableStepId, step]));
  const slotByKey = new Map(definition.slots.map((slot) => [slot.key, slot]));
  const boundItemSlots = new Set<string>();
  for (const step of definition.steps) {
    const present = presentBindingOf(step);
    if (!present) {
      continue;
    }
    const at = `step:${step.stableStepId}.present`;
    if (step.kind !== "chat") {
      diagnostics.push({
        code: "present_step_not_chat",
        location: at,
        message: `present on a non-message step: "${step.stableStepId}" is a ${step.kind} step; only a message step shows results as cards.`,
      });
      continue;
    }
    if (stepById.get(present.from)?.kind !== "tool" || !stepsBefore(definition, step.stableStepId).has(present.from)) {
      diagnostics.push({
        code: "present_source_not_earlier_tool",
        location: `${at}.from`,
        message: `present source invalid: "${step.stableStepId}" shows results from "${present.from}", which is not a tool step the routine passes through before it.`,
      });
    }
    if (present.slot !== undefined) {
      if (slotByKey.get(present.slot)?.type === "item") {
        boundItemSlots.add(present.slot);
      } else {
        diagnostics.push({
          code: "present_slot_not_item",
          location: `${at}.slot`,
          message: `present slot invalid: "${step.stableStepId}" fills "${present.slot}", which is not a declared item field.`,
        });
      }
    }
    if ((present.slot !== undefined) !== (present.selection === "single")) {
      diagnostics.push({
        code: "present_selection_mismatch",
        location: `${at}.selection`,
        message: present.slot === undefined
          ? `present selection invalid: "${step.stableStepId}" lets the visitor pick a card but names no item field the pick fills.`
          : `present selection invalid: "${step.stableStepId}" fills "${present.slot}" but does not let the visitor pick a card.`,
      });
    }
  }
  for (const slot of definition.slots) {
    if (slot.type === "item" && !boundItemSlots.has(slot.key)) {
      diagnostics.push({
        code: "item_slot_without_presenting_step",
        location: `slot:${slot.key}`,
        message: `item field unfilled: "${slot.key}" is an item field, and no step that shows results as cards fills it.`,
      });
    }
  }
  return diagnostics;
};
