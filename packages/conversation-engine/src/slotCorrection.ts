import type { RoutineSlotSchema, RoutineSlotType } from "@radioso/conversation-contract";

/**
 * Deterministic verification of a post-completion slot correction (issue #746).
 *
 * The detection of *which* slot the user wants to change and *what* the new raw value is
 * is a separate, model-driven step (multilingual — no keyword lists here). This function
 * is the deterministic gate that runs AFTER detection and BEFORE persistence: it confirms
 * the slot exists, is mutable, and the proposed value validates against the slot's declared
 * type. Only `{ ok: true }` results should ever be written to routine state.
 *
 * Pure and side-effect free: it neither reads nor writes routine state. Keeping it pure is
 * what lets a future mid-run correction reuse it unchanged.
 */

export type SlotCorrectionRejection = "unknown_slot" | "immutable" | "invalid_value";

export type SlotCorrectionResult =
  | { ok: true; key: string; value: string | number | boolean }
  | { ok: false; reason: SlotCorrectionRejection };

// Structural format check, not English product vocabulary: a localpart, "@", and a dotted
// domain. Deliberately permissive — the source of truth for deliverability is elsewhere.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// ISO calendar date (YYYY-MM-DD). Protocol syntax, not a keyword list.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Coerce/validate a raw string value against a declared slot type. Boolean accepts only the
 * canonical literal tokens `true`/`false` (case-insensitive) — the model-driven detection
 * step is responsible for normalizing natural language into one of those tokens, so no
 * language-specific affirmation words live in code.
 */
const coerceValue = (type: RoutineSlotType, raw: string): { ok: true; value: string | number | boolean } | { ok: false } => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false };
  }
  switch (type) {
    case "text":
      return { ok: true, value: trimmed };
    case "email":
      return EMAIL_PATTERN.test(trimmed) ? { ok: true, value: trimmed } : { ok: false };
    case "date":
      return ISO_DATE_PATTERN.test(trimmed) && !Number.isNaN(Date.parse(trimmed))
        ? { ok: true, value: trimmed }
        : { ok: false };
    case "number": {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false };
    }
    case "boolean": {
      const lowered = trimmed.toLowerCase();
      if (lowered === "true") {
        return { ok: true, value: true };
      }
      if (lowered === "false") {
        return { ok: true, value: false };
      }
      return { ok: false };
    }
  }
};

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
  const coerced = coerceValue(slot.type, input.rawValue);
  if (!coerced.ok) {
    return { ok: false, reason: "invalid_value" };
  }
  return { ok: true, key: slot.key, value: coerced.value };
};
