import { badRequest } from "./errors.js";

const MAX_LOCALE_LENGTH = 35;

/**
 * Bootstrap never resolves `resolveChatLocale` to a hardcoded language (it returns `null`
 * when the agent has never set `assistantDefaultLocale`), but exact content's "one
 * mandatory default-locale variant" rule (spec 1150 FR-005/FR-007), and a routine consent's
 * (#1544), need an actual language to require. An agent that has never set a default locale
 * falls back to English here — at draft-save time (`AgentService.updateDraftGreeting`,
 * `RoutineDefinitionService`) and at candidate/publish time (`AgentRevisionRepository`) — so
 * the checks never disagree with each other.
 */
export const DEFAULT_AGENT_LOCALE_FALLBACK = "en";

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
