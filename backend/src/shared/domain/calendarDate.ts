// ISO calendar date (YYYY-MM-DD). Protocol syntax, not a keyword list.
const ISO_CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Whether `value` is an ISO calendar date that names a real day: `2028-02-29` is one, `2026-02-30` is not. */
export const isIsoCalendarDate = (value: string): boolean => {
  const match = ISO_CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
