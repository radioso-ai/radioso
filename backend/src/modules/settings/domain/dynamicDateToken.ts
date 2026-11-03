const TODAY_DATE_TOKEN = "today()";

const normalizeDynamicDateToken = (value: string): string => value.trim().toLowerCase();

export const isDynamicDateToken = (value: string): boolean => normalizeDynamicDateToken(value) === TODAY_DATE_TOKEN;

/**
 * `today` is the run's local calendar date (`YYYY-MM-DD`), read in the conversation's zone. The
 * token resolves to that date at 00:00 UTC, the scale `Date.parse` gives a date value, so date
 * values compare day for day.
 */
export const resolveDynamicDateTokenToEpochMs = (value: string, today: string): number =>
  Date.parse(isDynamicDateToken(value) ? today : value.trim());

export const normalizeDateRuleValue = (value: string): string =>
  isDynamicDateToken(value) ? TODAY_DATE_TOKEN : value.trim();
