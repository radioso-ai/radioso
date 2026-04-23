const TODAY_DATE_TOKEN = "today()";

export const normalizeDynamicDateToken = (value: string): string => value.trim().toLowerCase();

export const isDynamicDateToken = (value: string): boolean => normalizeDynamicDateToken(value) === TODAY_DATE_TOKEN;

export const resolveDynamicDateTokenToEpochMs = (value: string, now: Date = new Date()): number => {
  if (!isDynamicDateToken(value)) {
    return Date.parse(value.trim());
  }

  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

export const normalizeDateRuleValue = (value: string): string =>
  isDynamicDateToken(value) ? TODAY_DATE_TOKEN : value.trim();
