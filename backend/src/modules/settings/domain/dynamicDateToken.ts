import { formatIsoDate } from "../../../shared/domain/clock.js";

const TODAY_DATE_TOKEN = "today()";

const normalizeDynamicDateToken = (value: string): string => value.trim().toLowerCase();

export const isDynamicDateToken = (value: string): boolean => normalizeDynamicDateToken(value) === TODAY_DATE_TOKEN;

/**
 * `today` is the turn's local calendar date (`YYYY-MM-DD`), read in the conversation's zone; the
 * token resolves to its start, on the same UTC-midnight scale `Date.parse` gives a date value.
 */
export const resolveDynamicDateTokenToEpochMs = (value: string, today: string = formatIsoDate(new Date())): number =>
  Date.parse(isDynamicDateToken(value) ? today : value.trim());

export const normalizeDateRuleValue = (value: string): string =>
  isDynamicDateToken(value) ? TODAY_DATE_TOKEN : value.trim();
