import type { RoutineSlotSchema } from "@radioso/conversation-contract";

import { checkSlotValue } from "./slotValue.js";

/**
 * Deterministic verification of a post-completion slot correction (issue #746).
 *
 * The detection of *which* slot the user wants to change and *what* the new raw value is
 * is a separate, model-driven step (multilingual — no keyword lists here). This function
 * is the deterministic gate that runs AFTER detection and BEFORE persistence: it confirms
 * the slot exists, is mutable, and the proposed value validates against the slot's declared
 * type by the shared slot value rules (`checkSlotValue`). Only `{ ok: true }` results should
 * ever be written to routine state.
 *
 * Pure and side-effect free: it neither reads nor writes routine state. Keeping it pure is
 * what lets a future mid-run correction reuse it unchanged.
 */

export type SlotCorrectionRejection = "unknown_slot" | "immutable" | "invalid_value";

export type SlotCorrectionResult =
  | { ok: true; key: string; value: string | number | boolean }
  | { ok: false; reason: SlotCorrectionRejection };

export const verifySlotCorrection = (input: {
  slots: readonly RoutineSlotSchema[];
  slotKey: string;
  rawValue: string;
}): SlotCorrectionResult => {
  const slot = input.slots.find((candidate) => candidate.key === input.slotKey);
  if (!slot) {
    return { ok: false, reason: "unknown_slot" };
  }
  if (!slot.mutable) {
    return { ok: false, reason: "immutable" };
  }
  const coerced = checkSlotValue(slot.type, input.rawValue);
  if (!coerced.ok) {
    return { ok: false, reason: "invalid_value" };
  }
  return { ok: true, key: slot.key, value: coerced.value };
};
