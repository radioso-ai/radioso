import { RETRIEVAL_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";
import { answerDocumentKey } from "../../domain/answerCandidatePool.js";
import type { RetrievedCandidate, TemporalQueryMode } from "../../domain/retrievalPipelineTypes.js";
import {
  datesFromMetadata,
  positionInDateRange,
  type RequestedDateRange,
} from "../../domain/temporal/requestedDateRange.js";

/** The part of a requested-range answer a candidate is drawn into. */
type RangeAnswerGroup = "range" | "reserved" | "outside";

/** Where a ranked candidate's own dates put it: in the range, undated, or dated in another period. */
type Placement = "range" | "undated" | "elsewhere";

interface PlacedCandidate {
  candidate: RetrievedCandidate;
  placement: Placement;
  /** Its position in the ranked list, best match first. */
  rank: number;
}

/**
 * The one place that decides what a requested-range answer is built from. Each ranked candidate
 * is placed once by its own dates. The range's passages (the lookup's, most similar to the
 * question first, then any ranked candidate dated in the range) are one group. The candidates
 * outside the range keep their ranked order and are either reserved, holding the slots set aside
 * ahead of the range, or left to fill out a sparse range. The pool handed to reranking holds the
 * reserved candidates, the range's passages in the rest of it, and the best other outside
 * candidates in whatever room the range leaves, each group in its own relevance order.
 */
export const composeRangeAnswerPool = (input: {
  rangeCandidates: RetrievedCandidate[];
  generalCandidates: RetrievedCandidate[];
  range: RequestedDateRange;
  temporalQueryMode: TemporalQueryMode;
  poolSize: number;
  reservedCount: number;
}): { pool: RetrievedCandidate[]; groups: ReadonlyMap<string, RangeAnswerGroup> } => {
  const lookupChunkIds = new Set(input.rangeCandidates.map((candidate) => candidate.chunkId));
  const placed = input.generalCandidates.map((candidate, rank): PlacedCandidate => ({
    candidate,
    rank,
    placement: lookupChunkIds.has(candidate.chunkId) ? "range" : placeAgainstRange(candidate, input.range),
  }));
  const rangeGroup = [
    ...input.rangeCandidates,
    ...placed
      .filter((entry) => entry.placement === "range" && !lookupChunkIds.has(entry.candidate.chunkId))
      .map((entry) => entry.candidate),
  ];
  const outside = placed.filter((entry) => entry.placement !== "range");
  const reservedIds = new Set(reservedOutsideCandidates({
    outside,
    bestRangeRank: placed.find((entry) => entry.placement === "range")?.rank,
    namedTopic: input.temporalQueryMode === "topic_refinement",
    reservedCount: Math.min(input.reservedCount, input.poolSize),
  }).map((entry) => entry.candidate.chunkId));

  const rangeShare = Math.min(rangeGroup.length, input.poolSize - reservedIds.size);
  const outsideCandidates = outside.map((entry) => entry.candidate);
  return {
    pool: [
      ...rangeGroup.slice(0, rangeShare),
      ...outsidePoolCandidates(outsideCandidates, reservedIds, input.poolSize - rangeShare),
    ],
    groups: new Map<string, RangeAnswerGroup>([
      ...rangeGroup.map((candidate) => [candidate.chunkId, "range"] as const),
      ...outsideCandidates.map((candidate) =>
        [candidate.chunkId, reservedIds.has(candidate.chunkId) ? "reserved" : "outside"] as const),
    ]),
  };
};

/**
 * The quotas the prompt selector applies to a ranked range-answer pool, in order: the reserved
 * candidates outside the range, then the range's passages up to `maxPassages` in all, then any
 * candidate outside the range, undated or dated elsewhere, only to bring a sparse range's answer
 * up to `minPassages`. The selector's own limits (two passages per document, duplicates, the
 * token budget) decide how many of the range's passages fit, so the answer's size is what it can
 * actually keep.
 */
export const rangeAnswerSelectionStages = <T extends { chunkId: string }>(input: {
  ranked: T[];
  groups: ReadonlyMap<string, RangeAnswerGroup>;
  maxPassages: number;
  minPassages: number;
}): Array<{ contexts: T[]; until: number }> => {
  const inGroups = (...wanted: RangeAnswerGroup[]): T[] =>
    input.ranked.filter((context) => wanted.some((group) => input.groups.get(context.chunkId) === group));
  const reserved = inGroups("reserved");
  return [
    { contexts: reserved, until: reserved.length },
    { contexts: inGroups("range"), until: input.maxPassages },
    { contexts: inGroups("reserved", "outside"), until: input.minPassages },
  ];
};

// A candidate is placed by its own chunk dates, the same dates the structured lookup reads to find
// the range's passages, so the two agree on what lies in the range. One date is that single day,
// and a span that overlaps the range at either edge lies in it.
const placeAgainstRange = (candidate: RetrievedCandidate, range: RequestedDateRange): Placement => {
  const position = positionInDateRange(datesFromMetadata(candidate.metadata), range);
  if (position === undefined) {
    return "undated";
  }
  return position === "within" ? "range" : "elsewhere";
};

/**
 * The outside candidates that hold the reserved slots. Only the best-ranked ones the answer can
 * take are considered, up to `reservedCount` and at most `promptContextMaxPerDocument` per
 * document, so a weak match far down the list never displaces the range's own passages. Among
 * those, an undated candidate (general context such as prices, booking, or the venue) holds its
 * slot. A candidate dated in another period holds one only for a question about a named topic,
 * and only when search ranks it above every candidate dated in the range: the topic is then in
 * another period, and the answer needs its real date. For any other question it holds none,
 * because a passage about another period's events is the one an answer about this period can
 * mistake for its own. A slot no candidate holds goes back to the range.
 */
const reservedOutsideCandidates = (input: {
  outside: PlacedCandidate[];
  bestRangeRank: number | undefined;
  namedTopic: boolean;
  reservedCount: number;
}): PlacedCandidate[] => {
  const outranksRange = (entry: PlacedCandidate): boolean =>
    input.bestRangeRank === undefined || entry.rank < input.bestRangeRank;
  return firstTakeable(input.outside, input.reservedCount)
    .filter((entry) => entry.placement === "undated" || (input.namedTopic && outranksRange(entry)));
};

/** The first `count` entries the prompt selector can take, at most `promptContextMaxPerDocument` per document. */
const firstTakeable = (entries: PlacedCandidate[], count: number): PlacedCandidate[] => {
  const perDocument = new Map<string, number>();
  const taken: PlacedCandidate[] = [];
  for (const entry of entries) {
    if (taken.length >= count) {
      break;
    }
    const documentKey = answerDocumentKey(entry.candidate);
    const used = perDocument.get(documentKey) ?? 0;
    if (used < RETRIEVAL_BEHAVIOR.promptContextMaxPerDocument) {
      perDocument.set(documentKey, used + 1);
      taken.push(entry);
    }
  }
  return taken;
};

// The outside candidates the pool holds, in their ranked order: the reserved ones, and the best of
// the rest in whatever room the range leaves, for the sparse-range fill.
const outsidePoolCandidates = (
  outside: RetrievedCandidate[],
  reservedIds: ReadonlySet<string>,
  capacity: number,
): RetrievedCandidate[] => {
  const others = outside
    .filter((candidate) => !reservedIds.has(candidate.chunkId))
    .slice(0, Math.max(0, capacity - reservedIds.size));
  const kept = new Set([...reservedIds, ...others.map((candidate) => candidate.chunkId)]);
  return outside.filter((candidate) => kept.has(candidate.chunkId));
};
