import type { RetrievedCandidate } from "../../domain/retrievalPipelineTypes.js";
import {
  datesFromMetadata,
  positionInDateRange,
  type RequestedDateRange,
} from "../../domain/temporal/requestedDateRange.js";

/**
 * Whether a candidate outside the requested range is dated entirely in another period, as
 * opposed to undated. This reads a candidate's date the way the rest of the platform already
 * does: one known date is that single day (`positionInDateRange`'s own rule — the structured
 * lookup reads a chunk the same way, and the date-aware retrieval trigger backfills a chunk's
 * `date_to` column from `date_from` when a source writes only one, the WordPress connector
 * among them). A date overlapping the range at either end counts as within it, so it is never
 * dated elsewhere; a candidate with no date at all is undated.
 */
const isDatedElsewhere = (candidate: RetrievedCandidate, range: RequestedDateRange): boolean => {
  const position = positionInDateRange(datesFromMetadata(candidate.metadata), range);
  return position === "before" || position === "after";
};

/**
 * The one place that decides what a requested-range answer is built from. The range's passages
 * (the lookup's, most similar to the question first, then any ranked candidate dated in the
 * range) and the best candidates outside the range (undated, or dated elsewhere, in their
 * semantic and lexical order) are two groups. The pool handed to reranking always holds the
 * first `reservedCount` undated candidates outside the range, the range fills the rest, and
 * further candidates outside it — undated or dated elsewhere — fill in when the range runs
 * short.
 */
export const composeRangeAnswerPool = (input: {
  rangeCandidates: RetrievedCandidate[];
  generalCandidates: RetrievedCandidate[];
  range: RequestedDateRange;
  poolSize: number;
  reservedCount: number;
}): {
  pool: RetrievedCandidate[];
  rangeChunkIds: ReadonlySet<string>;
  /** The outside group's undated chunk ids: the only ones a reserved slot may hold. */
  reservedEligibleChunkIds: ReadonlySet<string>;
} => {
  const lookupChunkIds = new Set(input.rangeCandidates.map((candidate) => candidate.chunkId));
  const datedInRange = (candidate: RetrievedCandidate): boolean =>
    positionInDateRange(datesFromMetadata(candidate.metadata), input.range) === "within";
  const rangeGroup = [
    ...input.rangeCandidates,
    ...input.generalCandidates.filter((candidate) => !lookupChunkIds.has(candidate.chunkId) && datedInRange(candidate)),
  ];
  const rangeChunkIds = new Set(rangeGroup.map((candidate) => candidate.chunkId));
  const outsideGroup = input.generalCandidates.filter((candidate) => !rangeChunkIds.has(candidate.chunkId));
  const undated = outsideGroup.filter((candidate) => !isDatedElsewhere(candidate, input.range));
  const undatedChunkIds = new Set(undated.map((candidate) => candidate.chunkId));

  // Only undated candidates compete for reserved-slot pool capacity; a range with nothing
  // undated outside it gives that capacity back to its own passages, same as a range with no
  // outside candidates at all.
  const reserveShare = Math.min(input.reservedCount, undated.length, input.poolSize);
  const rangeShare = Math.min(rangeGroup.length, input.poolSize - reserveShare);
  const outsidePoolCapacity = input.poolSize - rangeShare;

  // The reserve's own lead — the top `reserveShare` undated candidates — guarantees the pool's
  // limited outside share always has enough of them to fill the reserve. Anything left in that
  // share fills from the outside group's own relevance order (undated or dated elsewhere), not
  // a reorder that would bury a high-ranked dated-elsewhere candidate — the next period's
  // events, when this one is sparse — below every undated one and cut it from the pool.
  const reservedLead = undated.slice(0, reserveShare);
  const reservedLeadIds = new Set(reservedLead.map((candidate) => candidate.chunkId));
  const outsidePoolFill = [
    ...reservedLead,
    ...outsideGroup.filter((candidate) => !reservedLeadIds.has(candidate.chunkId)),
  ].slice(0, outsidePoolCapacity);

  return {
    pool: [...rangeGroup.slice(0, rangeShare), ...outsidePoolFill],
    rangeChunkIds,
    reservedEligibleChunkIds: undatedChunkIds,
  };
};

/**
 * The quotas the prompt selector applies to a ranked range-answer pool, in order: up to
 * `reservedCount` passages from outside the range that are undated, then the range's passages
 * up to `maxPassages` in all, then more passages from outside the range — undated or dated
 * elsewhere — only to bring a sparse range's answer up to `minPassages`. A passage dated
 * entirely in another period never takes a reserved slot; it reaches the answer only through
 * the sparse-range fill. The selector's own limits (two passages per document, duplicates, the
 * token budget) decide how many of the range's passages fit, so the answer's size is what it
 * can actually keep.
 */
export const rangeAnswerSelectionStages = <T extends { chunkId: string }>(input: {
  ranked: T[];
  rangeChunkIds: ReadonlySet<string>;
  reservedEligibleChunkIds: ReadonlySet<string>;
  reservedCount: number;
  maxPassages: number;
  minPassages: number;
}): Array<{ contexts: T[]; until: number }> => {
  const range = input.ranked.filter((context) => input.rangeChunkIds.has(context.chunkId));
  const outside = input.ranked.filter((context) => !input.rangeChunkIds.has(context.chunkId));
  const reservedEligibleOutside = outside.filter((context) => input.reservedEligibleChunkIds.has(context.chunkId));
  return [
    { contexts: reservedEligibleOutside, until: input.reservedCount },
    { contexts: range, until: input.maxPassages },
    { contexts: outside, until: input.minPassages },
  ];
};
