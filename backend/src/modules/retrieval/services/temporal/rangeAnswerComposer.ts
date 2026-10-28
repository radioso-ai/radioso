import type { RetrievedCandidate } from "../../domain/retrievalPipelineTypes.js";
import {
  datesFromMetadata,
  positionInDateRange,
  type RequestedDateRange,
} from "../../domain/temporal/requestedDateRange.js";

/**
 * Whether a candidate outside the requested range is dated entirely in another period, as
 * opposed to undated. Placing a passage there with confidence needs both ends of its date:
 * one of `dateFrom`/`dateTo` missing (open-ended) or neither parseable (unparseable) cannot
 * be placed, so it counts as undated, same as a passage with no date metadata at all. A date
 * overlapping the range at either end counts as within it, per `positionInDateRange`, so it
 * is never dated elsewhere.
 */
const isDatedElsewhere = (candidate: RetrievedCandidate, range: RequestedDateRange): boolean => {
  const dates = datesFromMetadata(candidate.metadata);
  if (!dates.dateFrom || !dates.dateTo) {
    return false;
  }
  const position = positionInDateRange(dates, range);
  return position === "before" || position === "after";
};

/**
 * Splits the outside group so undated candidates — general context such as prices, booking
 * and the venue, which is what the reserved slots exist for — lead the order, and passages
 * dated entirely in another period trail behind them. A tight pool slice drawn from the front
 * of this order reaches for undated candidates first and only falls back to a dated-elsewhere
 * one when too few undated candidates exist to fill it.
 */
const splitOutsideGroup = (
  outsideGroup: RetrievedCandidate[],
  range: RequestedDateRange,
): { ordered: RetrievedCandidate[]; undatedChunkIds: ReadonlySet<string> } => {
  const undated: RetrievedCandidate[] = [];
  const datedElsewhere: RetrievedCandidate[] = [];
  for (const candidate of outsideGroup) {
    (isDatedElsewhere(candidate, range) ? datedElsewhere : undated).push(candidate);
  }
  return {
    ordered: [...undated, ...datedElsewhere],
    undatedChunkIds: new Set(undated.map((candidate) => candidate.chunkId)),
  };
};

/**
 * The one place that decides what a requested-range answer is built from. The range's passages
 * (the lookup's, most similar to the question first, then any ranked candidate dated in the
 * range) and the best candidates outside the range (undated, or dated elsewhere, in their
 * semantic and lexical order, undated ones first) are two groups. The pool handed to reranking
 * always holds the first `reservedCount` candidates outside the range, the range fills the
 * rest, and further candidates outside it fill in when the range runs short.
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
  const { ordered: orderedOutsideGroup, undatedChunkIds } = splitOutsideGroup(outsideGroup, input.range);

  const reserveShare = Math.min(input.reservedCount, outsideGroup.length, input.poolSize);
  const rangeShare = Math.min(rangeGroup.length, input.poolSize - reserveShare);
  return {
    pool: [...rangeGroup.slice(0, rangeShare), ...orderedOutsideGroup.slice(0, input.poolSize - rangeShare)],
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
