import { routineSlotSavesToValueType, type RoutineSlotSaveValueType, type RoutineValidationCode } from "@radioso/routine-definition";

import type { AvailableContextVariable, ContextVariableValueType } from "../context-variables/public.js";
import type { SameType } from "../../shared/types/sameType.js";
import type { RoutineDefinition } from "./domain.js";

interface SaveTargetDiagnostic {
  code: RoutineValidationCode;
  location: string;
  message: string;
}

type Slot = RoutineDefinition["slots"][number];

// Every value type a field saves to is one an attribute has: renaming an attribute's type fails tsc here.
const saveValueTypesExist: SameType<Extract<RoutineSlotSaveValueType, ContextVariableValueType>, RoutineSlotSaveValueType> = true;
void saveValueTypesExist;

const SAVE_TO_LOCATION = /^slot:([A-Za-z_][A-Za-z0-9_]*)\.saveTo$/u;

/** A message naming the slot from the diagnostic's structural location, never from authored text. */
const naming = (rest: string) => (location: string): string => {
  const key = SAVE_TO_LOCATION.exec(location)?.[1];
  return key ? `Field "${key}" ${rest}` : `A field ${rest}`;
};

/** What an operator-facing diagnostic says of each save rule; locations carry only the slot key. */
export const safeSaveTargetValidationMessages: Partial<Record<RoutineValidationCode, (location: string) => string>> = {
  save_to_unknown_attribute: naming("saves to an attribute this agent doesn't have. Pick one of its attributes, or stop saving the field."),
  save_to_attribute_not_stored: naming("saves to an attribute whose value this agent doesn't keep. Turn it on for this agent as an attribute your website or API sets, or pick one that is."),
  save_to_type_mismatch: naming("saves to an attribute of another type. Text and email fields save to Text, and number, Yes/no and date fields to their own type."),
  save_to_attribute_signed: naming("saves to an attribute treated as proof. A visitor typed the value, so pick an attribute that isn't proof."),
  save_to_sensitive_slot_not_private: naming("is sensitive and saves to an attribute that isn't Private. Make the attribute Private, or pick a Private one."),
  save_to_duplicate_target: naming("saves to the same attribute and scope as another field. Each attribute takes one field per scope."),
};

const diagnostic = (code: RoutineValidationCode, slot: Slot, detail: string): SaveTargetDiagnostic => ({
  code,
  location: `slot:${slot.key}.saveTo`,
  message: `${code.replaceAll("_", " ")}: slot "${slot.key}" saves to attribute "${slot.saveTo?.contextVariable ?? ""}", ${detail}`,
});

/** Why a slot may not save to `variable`, or null when it may. */
const targetFault = (slot: Slot, variable: AvailableContextVariable | undefined): SaveTargetDiagnostic | null => {
  if (!variable) return diagnostic("save_to_unknown_attribute", slot, "which is not available to this agent.");
  if (!variable.stored) {
    return diagnostic("save_to_attribute_not_stored", slot, "whose value this agent does not keep (its source must be pushed or classified).");
  }
  if (!routineSlotSavesToValueType(slot.type, variable.valueType)) {
    return diagnostic("save_to_type_mismatch", slot, `whose type ${variable.valueType} does not take a ${slot.type} value.`);
  }
  if (variable.stored.trustTier === "signed") {
    return diagnostic("save_to_attribute_signed", slot, "which is treated as proof (signed); a value the visitor typed never is.");
  }
  if (slot.sensitivity === "sensitive" && variable.stored.sensitivity !== "sensitive") {
    return diagnostic("save_to_sensitive_slot_not_private", slot, "which is not Private (sensitive), so the value would leave unmasked.");
  }
  return null;
};

/**
 * The rules a slot's save target (#1884) must meet, checked when a routine is saved and when the
 * agent is published. Whether the attribute exists, keeps its value, takes the slot's type, is not
 * proof and is Private where the slot is sensitive needs the agent's attributes, so it runs only
 * when they are known; two slots of one routine never save to the same attribute and scope.
 */
export const saveTargetDiagnostics = (
  definition: Pick<RoutineDefinition, "slots">,
  availableContextVariables: ReadonlyMap<string, AvailableContextVariable> | undefined,
): SaveTargetDiagnostic[] => {
  const diagnostics: SaveTargetDiagnostic[] = [];
  const targets = new Set<string>();
  for (const slot of [...definition.slots].sort((left, right) => left.ordinal - right.ordinal)) {
    if (!slot.saveTo) continue;
    const target = `${slot.saveTo.scope}:${slot.saveTo.contextVariable}`;
    if (targets.has(target)) {
      diagnostics.push(diagnostic("save_to_duplicate_target", slot, `at scope ${slot.saveTo.scope}, as another field of this routine does.`));
      continue;
    }
    targets.add(target);
    const fault = availableContextVariables ? targetFault(slot, availableContextVariables.get(slot.saveTo.contextVariable)) : null;
    if (fault) diagnostics.push(fault);
  }
  return diagnostics;
};
