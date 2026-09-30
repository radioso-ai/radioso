/**
 * The name a person chooses for themselves. It is free text in any script: no
 * first/last split and no vocabulary, since naming conventions differ by
 * language. The only rules are structural, so every writer — profile edit,
 * signup, invitation accept, federated provisioning — applies this one helper.
 *
 * Teammates and visitors read a name without the address beside it, so the
 * rules also refuse what would let one person read as another: text that
 * renders as nothing, text that reorders what surrounds it, and an address
 * standing in for a name.
 */
export const DISPLAY_NAME_MAX_LENGTH = 80;

export type DisplayNameRejection =
  | "too_long"
  | "control_characters"
  | "direction_controls"
  | "no_visible_characters"
  | "email_address";

type DisplayNameNormalization =
  | { ok: true; displayName: string | null }
  | { ok: false; reason: DisplayNameRejection };

const CONTROL_CHARACTER = /\p{Cc}/u;

/** Embeddings, overrides (U+202A–U+202E) and isolates (U+2066–U+2069); marks such as U+200F stay allowed. */
const DIRECTION_CONTROL = /[‪-‮⁦-⁩]/u;

/**
 * Characters that render as nothing on their own: format characters (which
 * include the zero-width joiners), separators, and the Hangul fillers, which
 * are letters by category but blank by design. Joiners are only refused when
 * nothing visible is left for them to join.
 */
const INVISIBLE_CHARACTER = /[\p{Cf}\p{Z}ᅟᅠㅤﾠ]/gu;

const WHITESPACE = /\s/u;

/**
 * Structural only: something@domain.tld with no spaces, whatever the script.
 * Read after NFKC normalisation, so lookalikes that normalise to "@" or "." —
 * U+FF20 FULLWIDTH COMMERCIAL AT, U+2024 ONE DOT LEADER — count as the real
 * thing. String scanning rather than a pattern, so the cost stays linear on
 * stored text of any length.
 */
export const looksLikeEmailAddress = (value: string): boolean => {
  const normalized = value.normalize("NFKC");
  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@") || WHITESPACE.test(normalized)) {
    return false;
  }
  // A dot with at least one character on each side somewhere in the domain.
  return normalized.slice(at + 2, -1).includes(".");
};

/** Trims the input; blank clears the name. Length counts characters, not UTF-16 units. */
export const normalizeDisplayName = (input: string | null): DisplayNameNormalization => {
  const trimmed = input?.trim() ?? "";
  if (trimmed.length === 0) {
    return { ok: true, displayName: null };
  }
  if (CONTROL_CHARACTER.test(trimmed)) {
    return { ok: false, reason: "control_characters" };
  }
  if (DIRECTION_CONTROL.test(trimmed)) {
    return { ok: false, reason: "direction_controls" };
  }
  if (trimmed.replace(INVISIBLE_CHARACTER, "").length === 0) {
    return { ok: false, reason: "no_visible_characters" };
  }
  if (Array.from(trimmed).length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  if (looksLikeEmailAddress(trimmed)) {
    return { ok: false, reason: "email_address" };
  }
  return { ok: true, displayName: trimmed };
};

/**
 * How teammates are named to each other on operator surfaces: the name a person
 * chose, or their email until they choose one. Never shown to a visitor.
 */
export const teammateLabel = (user: { displayName: string | null; email: string }): string =>
  user.displayName ?? user.email;

/**
 * A name shown outside the workspace — to a visitor, or in a Slack channel that
 * can include people who are not teammates: the first candidate that is neither
 * blank nor shaped like an email address, trimmed, else null. An email is private
 * to the workspace, and a stored name is checked again on the way out because
 * names saved before validation can still hold one.
 */
export const outwardFacingName = (...candidates: ReadonlyArray<string | null | undefined>): string | null => {
  for (const candidate of candidates) {
    const name = candidate?.trim() ?? "";
    if (name.length > 0 && !looksLikeEmailAddress(name)) {
      return name;
    }
  }
  return null;
};

/**
 * The name a visitor sees on a teammate's reply: the name they chose, else the
 * organisation's name, else nothing — never anything shaped like an email.
 */
export const visitorFacingName = (input: {
  displayName: string | null;
  organizationName: string | null;
}): string | null => outwardFacingName(input.displayName, input.organizationName);
