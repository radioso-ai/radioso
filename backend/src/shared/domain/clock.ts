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

// English weekday names: model input for the prompt's date line, not product copy.
const UTC_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * Today's UTC date with its weekday, `2026-10-21 (Wednesday)`, for prompts that resolve a
 * period a question names. "This weekend" or "next Friday" is weekday arithmetic, and a
 * planner decoding straight into JSON at low reasoning effort should not have to derive the
 * weekday from the ISO date first.
 */
export const formatPromptDateUtc = (now: Date): string =>
  `${formatIsoDateUtc(now)} (${UTC_WEEKDAYS[now.getUTCDay()]})`;

/** As long as the longest date `formatPromptDateUtc` renders, for prompt size estimates. */
export const PROMPT_DATE_BUDGET_STAND_IN = "0000-00-00 (Wednesday)";
