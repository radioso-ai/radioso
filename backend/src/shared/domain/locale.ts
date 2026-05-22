import { badRequest } from "./errors.js";

const MAX_LOCALE_LENGTH = 35;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/;

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
  if (!LOCALE_PATTERN.test(trimmed)) {
    throw badRequest(`${fieldName} must be a valid locale tag`);
  }

  return trimmed;
};
