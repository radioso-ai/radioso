/**
 * The UTC month every usage counter is scoped to. Shared so a surface that reports a
 * counter reads the same period the charge was written under: a second copy of these
 * two lines is how a list silently stops agreeing with enforcement.
 */

export const currentPeriodStart = (date = new Date()): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;

export const nextPeriodStart = (periodStart: string): string => {
  const [year, month] = periodStart.split("-").map((part) => Number(part));
  return new Date(Date.UTC(year, month, 1)).toISOString();
};
