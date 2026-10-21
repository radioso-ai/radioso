import type {
  RerankedCandidate,
  RetrievalQueryShape,
  TemporalQueryMode,
} from "../../domain/retrievalPipelineTypes.js";
import { positionInDateRange, type RequestedDateRange } from "../../domain/temporal/requestedDateRange.js";

interface TemporalPromptContextOrderingResult {
  orderedContexts: RerankedCandidate[];
  applied: boolean;
  today: string;
  /** The requested range the order led with, when the question named one. */
  dateRange?: RequestedDateRange;
  datedContextCount: number;
}

export const orderTemporalPromptContexts = (input: {
  contexts: RerankedCandidate[];
  enabled: boolean;
  queryShape?: RetrievalQueryShape;
  temporalQueryMode?: TemporalQueryMode;
  today: string;
  dateRange?: RequestedDateRange;
}): TemporalPromptContextOrderingResult => {
  if (!shouldApplyTemporalOrdering(input)) {
    return {
      orderedContexts: input.contexts,
      applied: false,
      today: input.today,
      datedContextCount: 0,
    };
  }

  const indexed = input.contexts.map((context, index) => ({
    context,
    index,
    ...contextDateSpan(context.metadata),
  }));
  const dated = indexed.filter((entry) => entry.dateFrom);
  const undated = indexed.filter((entry) => !entry.dateFrom);

  if (input.dateRange) {
    return {
      orderedContexts: orderAroundDateRange(dated, undated, input.dateRange, input.today),
      applied: true,
      today: input.today,
      dateRange: input.dateRange,
      datedContextCount: dated.length,
    };
  }

  // An event is "past" only once its end date has elapsed, so a multi-day event that is
  // still ongoing today counts as upcoming. Past events are demoted below upcoming and
  // undated context (not dropped here) so recency-appropriate results win the final top-K
  // selection; when the context set exceeds the selector's top-K / token budget the
  // demoted past events are the first to be trimmed. This order assumes upcoming intent; a
  // question that names a period, past or future, is ordered around that range above.
  const upcoming = dated.filter((entry) => !isPastEvent(entry.dateTo, input.today));
  const past = dated.filter((entry) => isPastEvent(entry.dateTo, input.today));

  return {
    orderedContexts: [
      ...upcoming.sort((left, right) => compareDatedContexts(left, right)),
      ...undated,
      ...past.sort((left, right) => comparePastDatedContexts(left, right)),
    ].map((entry) => entry.context),
    applied: true,
    today: input.today,
    datedContextCount: dated.length,
  };
};

const isPastEvent = (dateTo: string | undefined, today: string): boolean =>
  Boolean(dateTo && dateTo < today);

// The upcoming order with the requested range pulled to the front. A question that names a
// range is answered by the events in it, so they lead, soonest first, whether the range is
// ahead of or behind today. Other ongoing and upcoming events follow, soonest first, ahead of
// undated context: a topic question asked about the wrong period ("is the retreat in March?"
// when it is in April) must keep the real date through the passage cut. Past events outside
// the range come last, most recent first.
const orderAroundDateRange = (
  dated: DatedContextEntry[],
  undated: DatedContextEntry[],
  range: RequestedDateRange,
  today: string,
): RerankedCandidate[] => {
  const inRange = dated.filter((entry) => positionInDateRange(entry, range) === "within");
  const outside = dated.filter((entry) => positionInDateRange(entry, range) !== "within");
  return [
    ...inRange.sort(compareDatedContexts),
    ...outside.filter((entry) => !isPastEvent(entry.dateTo, today)).sort(compareDatedContexts),
    ...undated,
    ...outside.filter((entry) => isPastEvent(entry.dateTo, today)).sort(comparePastDatedContexts),
  ].map((entry) => entry.context);
};

// A context's date span from its metadata. One date is that single day, matching how the
// structured lookup and `positionInDateRange` read a chunk, and an inverted pair spans its
// two dates. A context with neither date is undated.
const contextDateSpan = (metadata: Record<string, unknown> | undefined): { dateFrom?: string; dateTo?: string } => {
  const dates = [normalizeIsoDate(metadata?.dateFrom), normalizeIsoDate(metadata?.dateTo)]
    .filter((date): date is string => date !== undefined)
    .sort();
  return dates.length === 0 ? {} : { dateFrom: dates[0], dateTo: dates[dates.length - 1] };
};

const shouldApplyTemporalOrdering = (input: {
  enabled: boolean;
  queryShape?: RetrievalQueryShape;
  temporalQueryMode?: TemporalQueryMode;
}): boolean =>
  input.enabled &&
  input.queryShape === "event_date_lookup" &&
  (input.temporalQueryMode ?? "none") !== "none";

const normalizeIsoDate = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const date = value.slice(0, 10);
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed).toISOString().slice(0, 10) === date ? date : undefined;
};

interface DatedContextEntry {
  dateFrom?: string;
  dateTo?: string;
  context: RerankedCandidate;
  index: number;
}

const compareDatedContexts = (left: DatedContextEntry, right: DatedContextEntry): number => {
  const startComparison = compareStrings(left.dateFrom, right.dateFrom);
  if (startComparison !== 0) {
    return startComparison;
  }

  const endComparison = compareStrings(left.dateTo, right.dateTo);
  if (endComparison !== 0) {
    return endComparison;
  }

  return compareByRerankThenIndex(left, right);
};

// Past events surface most-recent-first (dates descending), but on identical dates we still
// keep the stronger rerank result ahead — reversing the whole comparator would demote it.
const comparePastDatedContexts = (left: DatedContextEntry, right: DatedContextEntry): number => {
  const startComparison = compareStrings(right.dateFrom, left.dateFrom);
  if (startComparison !== 0) {
    return startComparison;
  }

  const endComparison = compareStrings(right.dateTo, left.dateTo);
  if (endComparison !== 0) {
    return endComparison;
  }

  return compareByRerankThenIndex(left, right);
};

const compareByRerankThenIndex = (left: DatedContextEntry, right: DatedContextEntry): number => {
  const leftRank = Number.isFinite(left.context.rerankPosition) ? left.context.rerankPosition : left.index;
  const rightRank = Number.isFinite(right.context.rerankPosition) ? right.context.rerankPosition : right.index;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.index - right.index;
};

const compareStrings = (left: string | undefined, right: string | undefined): number => {
  if (left && right) {
    return left.localeCompare(right);
  }
  if (left) {
    return -1;
  }
  if (right) {
    return 1;
  }
  return 0;
};
