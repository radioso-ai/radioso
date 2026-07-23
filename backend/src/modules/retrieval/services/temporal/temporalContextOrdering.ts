import type {
  RerankedCandidate,
  RetrievalQueryShape,
  TemporalQueryMode,
} from "../../domain/retrievalPipelineTypes.js";

export interface TemporalPromptContextOrderingResult {
  orderedContexts: RerankedCandidate[];
  applied: boolean;
  today: string;
  datedContextCount: number;
}

export const orderTemporalPromptContexts = (input: {
  contexts: RerankedCandidate[];
  enabled: boolean;
  queryShape?: RetrievalQueryShape;
  temporalQueryMode?: TemporalQueryMode;
  today: string;
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
    dateFrom: normalizeIsoDate(context.metadata?.dateFrom),
    dateTo: normalizeIsoDate(context.metadata?.dateTo) ?? normalizeIsoDate(context.metadata?.dateFrom),
  }));
  const dated = indexed.filter((entry) => entry.dateFrom);
  const undated = indexed.filter((entry) => !entry.dateFrom);

  // An event is "past" only once its end date has elapsed, so a multi-day event that is
  // still ongoing today counts as upcoming. Past events are demoted below upcoming and
  // undated context (not dropped here) so recency-appropriate results win the final top-K
  // selection; when the context set exceeds the selector's top-K / token budget the
  // demoted past events are the first to be trimmed. This ordering assumes upcoming intent
  // and does not yet special-case queries that explicitly ask about a past period.
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
