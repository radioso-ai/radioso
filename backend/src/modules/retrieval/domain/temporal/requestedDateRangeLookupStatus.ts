/**
 * Whether a requested-range structured lookup ran, failed, or was never asked for. Shared by
 * every surface that reports on a question's resolved date range (`retrieval_probe`,
 * `document_search`), so a caller cannot invent its own meaning for "ran" — in particular, a
 * lookup the candidate stage degraded to an empty result after an error is `failed`, not `ran`.
 */
export const REQUESTED_DATE_RANGE_LOOKUP_STATUSES = ["ran", "failed", "not_requested"] as const;

export type RequestedDateRangeLookupStatus = typeof REQUESTED_DATE_RANGE_LOOKUP_STATUSES[number];

export const isRequestedDateRangeLookupStatus = (value: unknown): value is RequestedDateRangeLookupStatus =>
  typeof value === "string" && (REQUESTED_DATE_RANGE_LOOKUP_STATUSES as readonly string[]).includes(value);

export interface RequestedDateRangeLookupSummary {
  status: RequestedDateRangeLookupStatus;
  candidateCount: number;
}
