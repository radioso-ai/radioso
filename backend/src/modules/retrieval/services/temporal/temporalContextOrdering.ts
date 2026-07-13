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

  return {
    orderedContexts: [
      ...dated.sort((left, right) => compareDatedContexts(left, right)),
      ...undated,
    ].map((entry) => entry.context),
    applied: true,
    today: input.today,
    datedContextCount: dated.length,
  };
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

const compareDatedContexts = (
  left: { dateFrom?: string; dateTo?: string; context: RerankedCandidate; index: number },
  right: { dateFrom?: string; dateTo?: string; context: RerankedCandidate; index: number },
): number => {
  const startComparison = compareStrings(left.dateFrom, right.dateFrom);
  if (startComparison !== 0) {
    return startComparison;
  }

  const endComparison = compareStrings(left.dateTo, right.dateTo);
  if (endComparison !== 0) {
    return endComparison;
  }

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
