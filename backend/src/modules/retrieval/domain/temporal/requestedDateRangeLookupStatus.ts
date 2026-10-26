/**
 * Whether a requested-range structured lookup ran, failed, or was never asked for. Shared by
 * every surface that reports on a question's resolved date range (`retrieval_probe`,
 * `document_search`), so a caller cannot invent its own meaning for "ran" — in particular, a
 * lookup the candidate stage degraded to an empty result after an error is `failed`, not `ran`.
 */
export type RequestedDateRangeLookupStatus = "ran" | "failed" | "not_requested";

export interface RequestedDateRangeLookupSummary {
  status: RequestedDateRangeLookupStatus;
  candidateCount: number;
}
