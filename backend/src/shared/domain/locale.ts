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

let languageTagsByEnglishName: ReadonlyMap<string, string> | undefined;

/**
 * Every two-letter language tag by its English name in the runtime's CLDR data, lower-cased; built
 * once. A deprecated tag gives way to its canonical one ("mo" names Romanian, as "ro" does).
 */
const languageTagsByName = (): ReadonlyMap<string, string> => {
  if (languageTagsByEnglishName) return languageTagsByEnglishName;
  const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const byName = new Map<string, string>();
  for (const first of letters) {
    for (const second of letters) {
      const name = names.of(`${first}${second}`)?.toLowerCase();
      const [canonical] = Intl.getCanonicalLocales(`${first}${second}`);
      if (name && canonical && !byName.has(name)) byName.set(name, canonical);
    }
  }
  languageTagsByEnglishName = byName;
  return byName;
};

/**
 * The language tag of a response language as the turn's language detector reports it: a language
 * named in English ("Italian" → "it"), by its prompt's contract, or a tag already. Undefined for a
 * name the runtime's CLDR data does not hold, such as a regional variety.
 */
export const localeTagOfLanguage = (language: string): string | undefined =>
  languageTagsByName().get(language.trim().toLowerCase()) ?? localeTagOf(language);


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
