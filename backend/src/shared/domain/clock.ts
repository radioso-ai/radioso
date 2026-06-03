/** A source of the current time. Injected so time-dependent code stays testable. */
export type Clock = () => Date;

/** Default clock backed by the system wall clock. */
export const systemClock: Clock = () => new Date();

/**
 * The UTC calendar date as `YYYY-MM-DD`. This is the reference "today" handed to
 * LLM prompts for recency reasoning. UTC is deliberate: it matches how the
 * `today()` retrieval-settings token resolves, so query-time date filters and
 * prompt recency share one notion of "today".
 */
export const formatIsoDateUtc = (now: Date): string => {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
