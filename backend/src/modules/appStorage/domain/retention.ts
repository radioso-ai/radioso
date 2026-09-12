const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The longest an operator may hold a removed App's data. Retention exists for a
 * support investigation or a compliance window, and an unbounded "until" is how
 * customer data outlives the reason it was kept — so the deadline is bounded by
 * policy rather than by whoever types the date.
 */
export const MAX_RETENTION_DAYS = 90;

type RetentionDeadlineValidation =
  | { ok: true; until: Date }
  | { ok: false; reason: "not_a_date" | "not_in_the_future" | "beyond_policy_maximum" };

/**
 * A retention deadline is a real instant, still ahead of the moment it is set,
 * and inside the policy ceiling. A deadline already past would delete the data on
 * the next sweep, which is a deletion wearing a retention's name.
 */
export const validateRetentionDeadline = (until: Date, now: Date): RetentionDeadlineValidation => {
  if (!(until instanceof Date) || Number.isNaN(until.getTime())) return { ok: false, reason: "not_a_date" };
  if (until.getTime() <= now.getTime()) return { ok: false, reason: "not_in_the_future" };
  if (until.getTime() - now.getTime() > MAX_RETENTION_DAYS * MILLISECONDS_PER_DAY) {
    return { ok: false, reason: "beyond_policy_maximum" };
  }
  return { ok: true, until };
};
