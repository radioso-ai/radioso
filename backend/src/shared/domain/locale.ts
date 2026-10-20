import { badRequest } from "./errors.js";

const MAX_LOCALE_LENGTH = 35;
/** A BCP 47 language tag of the shape Radioso stores: language, optional script, optional region. */
export const LOCALE_TAG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/;

export const isLocaleTag = (value: string): boolean => LOCALE_TAG_PATTERN.test(value);

/** A value read from outside (a model's output, a vendor's payload) as a language tag: trimmed when it is one, undefined otherwise. */
export const localeTagOf = (value: unknown): string | undefined => {
  const tag = typeof value === "string" ? value.trim() : "";
  return isLocaleTag(tag) ? tag : undefined;
};


export const normalizeLocaleTag = (
  value: unknown,
  fieldName = "assistantDefaultLocale",
): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw badRequest(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_LOCALE_LENGTH) {
    throw badRequest(`${fieldName} must not exceed ${MAX_LOCALE_LENGTH} characters`);
  }
  if (!isLocaleTag(trimmed)) {
    throw badRequest(`${fieldName} must be a valid locale tag`);
  }

  return trimmed;
};
