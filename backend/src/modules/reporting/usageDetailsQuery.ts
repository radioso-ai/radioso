import { badRequest } from "../../shared/domain/errors.js";

import type { UsageDetailsRange } from "./contracts/index.js";

export const MAX_USAGE_DETAILS_DAYS = 90;
export const DEFAULT_USAGE_DETAILS_LIMIT = 50;
export const MAX_USAGE_DETAILS_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const parseUtcDateOnly = (value: string): Date | null => {
  if (!DATE_ONLY.test(value)) {
    return null;
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
};

export const normalizeUsageDetailsRange = (input: { from: string; to: string }): UsageDetailsRange => {
  const fromDate = parseUtcDateOnly(input.from);
  const toDate = parseUtcDateOnly(input.to);
  if (!fromDate || !toDate || fromDate.getTime() > toDate.getTime()) {
    throw badRequest("Invalid detailed usage date range");
  }
  const days = Math.floor((toDate.getTime() - fromDate.getTime()) / DAY_MS) + 1;
  if (days > MAX_USAGE_DETAILS_DAYS) {
    throw badRequest(`Detailed usage range exceeds the maximum of ${MAX_USAGE_DETAILS_DAYS} days`);
  }
  return {
    from: input.from,
    to: input.to,
    queryStart: fromDate,
    queryEnd: new Date(toDate.getTime() + DAY_MS),
  };
};
