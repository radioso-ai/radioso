import type { RetrievalSourceFilter } from "../retrievalSourceFilter.js";
import type { RetrievedChunk } from "../vectorSearch.js";
import type { RequestedDateRange } from "./requestedDateRange.js";

/** The dates a structured temporal lookup reads. */
export type TemporalLookupWindow =
  /** Chunks still ongoing on `today` or starting after it, soonest first. */
  | { kind: "upcoming"; today: string }
  /**
   * Chunks whose dates overlap the range, soonest first, with each event's first chunk
   * ahead of any event's later chunks so a busy range lists as many events as fit.
   */
  | { kind: "requested_range"; range: RequestedDateRange };

export interface TemporalCandidateRetrievalInput {
  workspaceId: string;
  window: TemporalLookupWindow;
  topK: number;
  metadataFilter?: Record<string, unknown>;
  sourceFilter?: RetrievalSourceFilter;
}

export interface TemporalCandidateRetrievalPort {
  findInWindow(input: TemporalCandidateRetrievalInput): Promise<RetrievedChunk[]>;
}
