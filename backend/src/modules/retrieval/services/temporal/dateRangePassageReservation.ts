import type { RetrievedCandidate } from "../../domain/retrievalPipelineTypes.js";
import {
  datesFromMetadata,
  positionInDateRange,
  type RequestedDateRange,
} from "../../domain/temporal/requestedDateRange.js";

/**
 * A range lookup's passages lead the answer pool, so a busy range would fill every passage and
 * keep out the page that answers a question which only mentions a period. This keeps the top
 * `reservedCount` candidates outside the range, in the normal semantic and lexical order, in
 * the pool. A candidate is in the range when the lookup returned it or its dates fall in the
 * range; every other candidate, undated or dated elsewhere, is outside it. `poolOf` builds a
 * pool of a given size around the reserve: the rest goes to the range, then to further
 * candidates outside it when the range runs short, all in their prepared order.
 */
export const reserveOutsideRangeCandidates = (input: {
  candidates: RetrievedCandidate[];
  rangeChunkIds: ReadonlySet<string>;
  range: RequestedDateRange;
  reservedCount: number;
}): { reservedChunkIds: Set<string>; poolOf: (poolSize: number) => RetrievedCandidate[] } => {
  const inRange = (candidate: RetrievedCandidate): boolean =>
    input.rangeChunkIds.has(candidate.chunkId)
    || positionInDateRange(datesFromMetadata(candidate.metadata), input.range) === "within";
  const inside = input.candidates.filter(inRange);
  const outside = input.candidates.filter((candidate) => !inRange(candidate));
  const reserved = outside.slice(0, input.reservedCount);

  return {
    reservedChunkIds: new Set(reserved.map((candidate) => candidate.chunkId)),
    poolOf: (poolSize) => {
      const rangeShare = inside.slice(0, Math.max(0, poolSize - reserved.length));
      const fill = outside.slice(reserved.length, reserved.length + Math.max(0, poolSize - reserved.length - rangeShare.length));
      const chosen = new Set([...reserved, ...rangeShare, ...fill].map((candidate) => candidate.chunkId));
      return input.candidates.filter((candidate) => chosen.has(candidate.chunkId));
    },
  };
};

/**
 * Places the reserved passages right after the first `contextTopK - reserved` of the ordered
 * contexts, so the prompt selector takes them within the answer's passage limit while the
 * range's passages keep their place, and order, ahead of them.
 */
export const placeReservedPassages = <T extends { chunkId: string }>(input: {
  contexts: T[];
  reservedChunkIds: ReadonlySet<string>;
  contextTopK: number;
}): T[] => {
  if (input.reservedChunkIds.size === 0) {
    return input.contexts;
  }
  const reserved = input.contexts.filter((context) => input.reservedChunkIds.has(context.chunkId));
  const others = input.contexts.filter((context) => !input.reservedChunkIds.has(context.chunkId));
  const leading = Math.max(0, input.contextTopK - reserved.length);
  return [...others.slice(0, leading), ...reserved, ...others.slice(leading)];
};
