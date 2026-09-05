import { stringifyUnknown } from "../text/stringifyUnknown.js";

/**
 * Normalizes a caught or rejected value of unknown origin into a real `Error`, passing an
 * existing `Error` through unchanged. JS permits throwing/rejecting with any value, so a
 * caught `unknown` is not guaranteed to be one; this keeps a rethrow or re-reject satisfying
 * `only-throw-error` / `prefer-promise-reject-errors` without losing the original error identity.
 */
export const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(stringifyUnknown(value)));
