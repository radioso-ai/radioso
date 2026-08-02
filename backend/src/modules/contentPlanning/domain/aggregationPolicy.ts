import type {
  ContentPlanEvidenceStrength,
  ContentPlanHeadlineState,
  ContentPlanTrend,
} from "../contracts/index.js";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ContentPlanWindow {
  from: string;
  to: string;
}

export const resolveContentPlanWindows = (asOf: Date): {
  asOf: string;
  current: ContentPlanWindow;
  comparison: ContentPlanWindow;
} => {
  if (!Number.isFinite(asOf.getTime())) {
    throw new Error("invalid_content_plan_as_of");
  }
  const to = asOf.getTime();
  return {
    asOf: asOf.toISOString(),
    current: {
      from: new Date(to - WINDOW_MS).toISOString(),
      to: asOf.toISOString(),
    },
    comparison: {
      from: new Date(to - (2 * WINDOW_MS)).toISOString(),
      to: new Date(to - WINDOW_MS).toISOString(),
    },
  };
};

export type ContentPlanGroundingVerdict = "grounded" | "degraded" | "no_support" | "not_evaluated";

export interface ContentPlanAggregateObservation {
  sourceUserMessageId: string;
  conversationId: string;
  observedAt: string;
  groundingVerdict: ContentPlanGroundingVerdict;
}

export interface ContentPlanWindowAggregate {
  questionCount: number;
  conversationCount: number;
  grounding: {
    groundedAnswerCount: number;
    degradedAnswerCount: number;
    noSupportAnswerCount: number;
    notEvaluatedAnswerCount: number;
    evaluatedAnswerCount: number;
    reducedOrNoSupportRate: number | null;
  };
}

const inWindow = (observedAt: string, window: ContentPlanWindow): boolean => {
  const value = new Date(observedAt).getTime();
  return Number.isFinite(value)
    && value >= new Date(window.from).getTime()
    && value < new Date(window.to).getTime();
};

const aggregateWindow = (
  observations: readonly ContentPlanAggregateObservation[],
  window: ContentPlanWindow,
): ContentPlanWindowAggregate => {
  const byMessage = new Map<string, ContentPlanAggregateObservation>();
  for (const observation of observations) {
    if (inWindow(observation.observedAt, window) && !byMessage.has(observation.sourceUserMessageId)) {
      byMessage.set(observation.sourceUserMessageId, observation);
    }
  }
  const unique = [...byMessage.values()];
  const groundedAnswerCount = unique.filter((item) => item.groundingVerdict === "grounded").length;
  const degradedAnswerCount = unique.filter((item) => item.groundingVerdict === "degraded").length;
  const noSupportAnswerCount = unique.filter((item) => item.groundingVerdict === "no_support").length;
  const notEvaluatedAnswerCount = unique.filter((item) => item.groundingVerdict === "not_evaluated").length;
  const evaluatedAnswerCount = groundedAnswerCount + degradedAnswerCount + noSupportAnswerCount;
  return {
    questionCount: unique.length,
    conversationCount: new Set(unique.map((item) => item.conversationId)).size,
    grounding: {
      groundedAnswerCount,
      degradedAnswerCount,
      noSupportAnswerCount,
      notEvaluatedAnswerCount,
      evaluatedAnswerCount,
      reducedOrNoSupportRate: evaluatedAnswerCount === 0
        ? null
        : (degradedAnswerCount + noSupportAnswerCount) / evaluatedAnswerCount,
    },
  };
};

export const aggregateContentPlanTopic = (input: {
  asOf: Date;
  observations: readonly ContentPlanAggregateObservation[];
}): { current: ContentPlanWindowAggregate; comparison: ContentPlanWindowAggregate } => {
  const windows = resolveContentPlanWindows(input.asOf);
  return {
    current: aggregateWindow(input.observations, windows.current),
    comparison: aggregateWindow(input.observations, windows.comparison),
  };
};

export const countDistinctReportQuestions = (
  observations: ReadonlyArray<Pick<ContentPlanAggregateObservation, "sourceUserMessageId" | "observedAt">>,
  window: ContentPlanWindow,
): number => new Set(
  observations
    .filter((observation) => inWindow(observation.observedAt, window))
    .map((observation) => observation.sourceUserMessageId),
).size;

export const resolveTopicTrend = (input: {
  currentQuestionCount: number;
  comparisonQuestionCount: number;
}): ContentPlanTrend => {
  const current = Math.max(0, input.currentQuestionCount);
  const comparison = Math.max(0, input.comparisonQuestionCount);
  if (current >= 2 && comparison === 0) {
    return "new";
  }
  if (current + comparison < 3) {
    return "insufficient_data";
  }
  const delta = current - comparison;
  const relativeDelta = comparison === 0 ? Number.POSITIVE_INFINITY : Math.abs(delta) / comparison;
  if (Math.abs(delta) >= 2 && relativeDelta >= 0.25) {
    return delta > 0 ? "rising" : "falling";
  }
  return "steady";
};

export const resolveEvidenceStrength = (evaluatedConversationCount: number): ContentPlanEvidenceStrength => {
  if (evaluatedConversationCount <= 0) return "none";
  if (evaluatedConversationCount < 5) return "low";
  if (evaluatedConversationCount < 20) return "medium";
  return "high";
};

export const resolveGroundingHeadlineState = (input: {
  evaluatedAnswerCount: number;
  evaluatedConversationCount: number;
}): ContentPlanHeadlineState => {
  if (input.evaluatedAnswerCount <= 0) {
    return "unmeasured";
  }
  return input.evaluatedConversationCount < 5
    ? "insufficient_measured_turns"
    : "measured";
};
