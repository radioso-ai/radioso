/**
 * A run of the assertion markers the answer composer writes for citations — `[[n]]`, `[[?]]`,
 * `[n]`, `[?]` with n digits — and the whitespace before it. A single-bracket marker never matches
 * inside an unfinished `[[n]` that a later chunk will close. Structure only: no words.
 */
const ASSERTION_MARKER_RUN = /\s*(?:\[\[(?:\d+|\?)\]\]|(?<!\[)\[(?:\d+|\?)\](?!\]))+/gu;

/** Removes assertion markers from text a caller will hear; "information.[?] If" becomes "information. If". */
export const withoutAssertionMarkers = (text: string): string => text.replace(ASSERTION_MARKER_RUN, "");
