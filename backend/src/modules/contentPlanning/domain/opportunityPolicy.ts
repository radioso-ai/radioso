import type { ContentPlanRecommendationAction, ContentPlanTrend } from "../contracts/index.js";

export const CONTENT_PLAN_ACTION_POLICY_V1 = Object.freeze({
  version: 1 as const,
  credibleGapConversationFloor: 2,
  relatedDocumentRelevanceFloor: 0.74,
});

export interface ActiveGapEvidence {
  conversationId: string;
  verdict: "grounded" | "degraded" | "no_support" | "not_evaluated";
  remediationActive: boolean;
}

export interface ContentPlanOpportunityEvidence {
  credible: boolean;
  activeNoSupportConversationCount: number;
  activeDegradedConversationCount: number;
  activeGapConversationCount: number;
}

export const deriveContentPlanOpportunity = (input: {
  mature: boolean;
  evidence: readonly ActiveGapEvidence[];
}): ContentPlanOpportunityEvidence => {
  const active = input.evidence.filter((item) =>
    item.remediationActive && (item.verdict === "degraded" || item.verdict === "no_support"));
  const noSupport = new Set(
    active.filter((item) => item.verdict === "no_support").map((item) => item.conversationId),
  );
  const degraded = new Set(
    active.filter((item) => item.verdict === "degraded").map((item) => item.conversationId),
  );
  const gap = new Set(active.map((item) => item.conversationId));
  return {
    credible: input.mature && gap.size >= CONTENT_PLAN_ACTION_POLICY_V1.credibleGapConversationFloor,
    activeNoSupportConversationCount: noSupport.size,
    activeDegradedConversationCount: degraded.size,
    activeGapConversationCount: gap.size,
  };
};

export interface RankedContentPlanOpportunity {
  topicId: string;
  activeNoSupportConversationCount: number;
  activeDegradedConversationCount: number;
  currentConversationCount: number;
  trend: ContentPlanTrend;
}

const TREND_RANK: Record<ContentPlanTrend, number> = {
  new: 4,
  rising: 3,
  steady: 2,
  falling: 1,
  insufficient_data: 0,
};

export const compareContentPlanOpportunities = (
  left: RankedContentPlanOpportunity,
  right: RankedContentPlanOpportunity,
): number =>
  right.activeNoSupportConversationCount - left.activeNoSupportConversationCount
  || right.activeDegradedConversationCount - left.activeDegradedConversationCount
  || right.currentConversationCount - left.currentConversationCount
  || TREND_RANK[right.trend] - TREND_RANK[left.trend]
  || left.topicId.localeCompare(right.topicId);

export interface ContentPlanCorpusDocumentEvidence {
  possibleRelevance: number;
  existedBeforeGap: boolean;
  retrievedByGapAnswers: boolean;
  citedByGapAnswers: boolean;
  changedAfterGap: boolean;
}

export interface ContentPlanCorpusEvidence {
  state: "pending" | "ready" | "unavailable" | "stale";
  documents: readonly ContentPlanCorpusDocumentEvidence[];
}

export const selectRecommendationAction = (input: {
  credibleGap: boolean;
  corpus: ContentPlanCorpusEvidence;
}): ContentPlanRecommendationAction | null => {
  if (!input.credibleGap) {
    return "monitor";
  }
  if (input.corpus.state !== "ready") {
    return null;
  }
  const relevant = input.corpus.documents.filter((document) =>
    Number.isFinite(document.possibleRelevance)
    && document.possibleRelevance >= CONTENT_PLAN_ACTION_POLICY_V1.relatedDocumentRelevanceFloor);
  if (relevant.length === 0) {
    return "add_content";
  }
  if (relevant.some((document) =>
    document.retrievedByGapAnswers
    || document.citedByGapAnswers
    || document.changedAfterGap)) {
    return "review_existing_content";
  }
  if (relevant.some((document) => document.existedBeforeGap)) {
    return "investigate_retrieval";
  }
  return "review_existing_content";
};
