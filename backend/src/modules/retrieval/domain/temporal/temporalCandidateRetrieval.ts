import type { RetrievalSourceFilter } from "../retrievalSourceFilter.js";
import type { EmbeddingSpaceRef } from "../vectorAdapter.js";
import type { RetrievedChunk } from "../vectorSearch.js";
import type { RequestedDateRange } from "./requestedDateRange.js";

/** The question's embedding, to rank a requested range's passages by similarity to it. */
export interface TemporalSimilarityQuery {
  space: EmbeddingSpaceRef;
  queryVector: readonly number[];
}

/** The dates a structured temporal lookup reads. */
export type TemporalLookupWindow =
  /** Chunks still ongoing on `today` or starting after it, soonest first. */
  | { kind: "upcoming"; today: string }
  /**
   * Chunks whose dates overlap the range, each event's best chunk ahead of any event's next
   * one so a busy range lists as many events as fit. With `similarTo`, an event's best chunk is
   * its closest to the question and chunks closest to the question come first, with no
   * similarity threshold: the dates are the relevance gate. Without `similarTo`, and for chunks
   * with no embedding in its space, soonest first in document order.
   */
  | { kind: "requested_range"; range: RequestedDateRange; similarTo?: TemporalSimilarityQuery };

export interface TemporalCandidateRetrievalInput {
  workspaceId: string;
  window: TemporalLookupWindow;
  topK: number;
  metadataFilter?: Record<string, unknown>;
  sourceFilter?: RetrievalSourceFilter;
  /** The request's document scope: when present and non-empty, only chunks of these documents. */
  documentIds?: readonly string[];
}

export interface TemporalCandidateRetrievalPort {
  findInWindow(input: TemporalCandidateRetrievalInput): Promise<RetrievedChunk[]>;
}
