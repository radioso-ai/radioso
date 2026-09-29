/**
 * The name a person chooses for themselves. It is free text in any script: no
 * first/last split and no vocabulary, since naming conventions differ by
 * language. The only rules are structural, so every writer — profile edit,
 * signup, invitation accept, federated provisioning — applies this one helper.
 */
export const DISPLAY_NAME_MAX_LENGTH = 80;

type DisplayNameRejection = "too_long" | "control_characters";

type DisplayNameNormalization =
  | { ok: true; displayName: string | null }
  | { ok: false; reason: DisplayNameRejection };

const CONTROL_CHARACTER = /\p{Cc}/u;

/** Trims the input; blank clears the name. Length counts characters, not UTF-16 units. */
export const normalizeDisplayName = (input: string | null): DisplayNameNormalization => {
  const trimmed = input?.trim() ?? "";
  if (trimmed.length === 0) {
    return { ok: true, displayName: null };
  }
  if (CONTROL_CHARACTER.test(trimmed)) {
    return { ok: false, reason: "control_characters" };
  }
  if (Array.from(trimmed).length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true, displayName: trimmed };
};
