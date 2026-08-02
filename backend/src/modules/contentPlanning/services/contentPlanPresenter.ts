import type {
  ContentPlanEmergingQuestion,
  ContentPlanProjection,
  ContentPlanSummary,
  ContentPlanTopicDetail,
  ContentPlanTopicSummary,
  ContentPlanTrend,
} from "../contracts/index.js";
import {
  aggregateContentPlanTopic,
  resolveContentPlanWindows,
  resolveEvidenceStrength,
  resolveGroundingHeadlineState,
  resolveTopicTrend,
} from "../domain/aggregationPolicy.js";
import {
  compareContentPlanOpportunities,
  deriveContentPlanOpportunity,
  selectRecommendationAction,
} from "../domain/opportunityPolicy.js";
import type {
  ContentPlanReadDocument,
  ContentPlanReadObservation,
  ContentPlanReadTopic,
  ContentPlanReportReadData,
} from "../infra/contentPlanReadSource.js";
import type { QualityContentPlanningTurnEvidence } from "../../quality/contracts/contentPlanningEvidence.js";
import { CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1 } from "./enrichmentScheduler.js";

const TREND_RANK: Record<ContentPlanTrend, number> = {
  new: 4,
  rising: 3,
  steady: 2,
  falling: 1,
  insufficient_data: 0,
};

export interface PresentedContentPlanTopic {
  summary: ContentPlanTopicSummary;
  activeNoSupportConversationCount: number;
  activeDegradedConversationCount: number;
  trendRank: number;
  detail: Omit<ContentPlanTopicDetail,
    "asOf" | "window" | "comparisonWindow" | "projection"
    | "canonicalTopicId" | "redirectedFromTopicId">;
}

export interface PresentedContentPlanReport {
  summary: ContentPlanSummary;
  topics: PresentedContentPlanTopic[];
  emerging: ContentPlanEmergingQuestion[];
}

export const presentContentPlanReport = (input: {
  asOf: Date;
  projection: ContentPlanProjection;
  data: ContentPlanReportReadData;
  evidenceByAssistantMessageId: ReadonlyMap<string, QualityContentPlanningTurnEvidence>;
}): PresentedContentPlanReport => {
  const windows = resolveContentPlanWindows(input.asOf);
  const liveObservations = input.data.observations.filter((observation) =>
    input.evidenceByAssistantMessageId.has(observation.sourceAssistantMessageId));
  const reportReadyObservations = liveObservations.filter((observation) =>
    observation.observationState === "ready");
  const reportAggregates = aggregateContentPlanTopic({
    asOf: input.asOf,
    observations: reportReadyObservations.map((observation) =>
      toAggregateObservation(observation, input.evidenceByAssistantMessageId)),
  });
  const currentReportObservations = uniqueQuestions(reportReadyObservations.filter((observation) =>
    inWindow(observation.observedAt, windows.current)));
  const reportEvaluatedConversationCount = distinctConversations(
    currentReportObservations.filter((observation) =>
      groundingVerdict(observation, input.evidenceByAssistantMessageId) !== "not_evaluated"),
  );

  const topicById = new Map(input.data.topics.map((topic) => [topic.id, topic]));
  const documentsByTopic = groupBy(input.data.documents, (document) => document.topicId);
  const observationsByTopic = groupBy(
    reportReadyObservations.filter((observation) => observation.topicId !== null),
    (observation) => observation.topicId!,
  );
  const rankedTopics = input.data.topics
    .filter((topic) => topic.lifecycle === "mature")
    .flatMap((topic): PresentedContentPlanTopic[] => {
      const observations = observationsByTopic.get(topic.id) ?? [];
      const aggregates = aggregateContentPlanTopic({
        asOf: input.asOf,
        observations: observations.map((observation) =>
          toAggregateObservation(observation, input.evidenceByAssistantMessageId)),
      });
      if (aggregates.current.questionCount === 0) return [];

      const current = uniqueQuestions(observations.filter((observation) =>
        inWindow(observation.observedAt, windows.current)));
      const trend = resolveTopicTrend({
        currentQuestionCount: aggregates.current.questionCount,
        comparisonQuestionCount: aggregates.comparison.questionCount,
      });
      const evaluatedConversationCount = distinctConversations(current.filter((observation) =>
        groundingVerdict(observation, input.evidenceByAssistantMessageId) !== "not_evaluated"));
      const opportunity = deriveContentPlanOpportunity({
        mature: true,
        evidence: current.map((observation) => {
          const evidence = input.evidenceByAssistantMessageId.get(observation.sourceAssistantMessageId)!;
          return {
            conversationId: observation.conversationId,
            verdict: groundingVerdict(observation, input.evidenceByAssistantMessageId),
            remediationActive: evidence.remediation.active,
          };
        }),
      });
      const documents = documentsByTopic.get(topic.id) ?? [];
      const action = selectRecommendationAction({
        credibleGap: opportunity.credible,
        corpus: {
          state: topic.enrichment.corpusState,
          documents: documents.map((document) => ({
            possibleRelevance: document.possibleRelevance,
            existedBeforeGap: document.existedBeforeGap,
            retrievedByGapAnswers: document.retrievedByGapAnswers,
            citedByGapAnswers: document.citedByGapAnswers,
            changedAfterGap: document.changedAfterGap,
          })),
        },
      });
      const priorityReasons: ContentPlanTopicSummary["opportunity"]["priorityReasons"] = [];
      if (opportunity.activeNoSupportConversationCount > 0) priorityReasons.push("active_no_support");
      if (opportunity.activeDegradedConversationCount > 0) priorityReasons.push("active_degraded");
      if (trend === "new") priorityReasons.push("new_demand");
      if (trend === "rising") priorityReasons.push("rising_demand");
      const affectedAgents = countAffectedAgents(current, input.evidenceByAssistantMessageId);
      const affectedChannels = countAffectedChannels(current, input.evidenceByAssistantMessageId);
      const summary: ContentPlanTopicSummary = {
        id: topic.id,
        lifecycle: "mature",
        label: topic.enrichment.label,
        description: topic.enrichment.description,
        labelState: topic.enrichment.state,
        demand: {
          currentQuestionCount: aggregates.current.questionCount,
          comparisonQuestionCount: aggregates.comparison.questionCount,
          currentConversationCount: aggregates.current.conversationCount,
          comparisonConversationCount: aggregates.comparison.conversationCount,
          currentShare: reportAggregates.current.questionCount === 0
            ? null
            : aggregates.current.questionCount / reportAggregates.current.questionCount,
          absoluteChange: aggregates.current.questionCount - aggregates.comparison.questionCount,
          trend,
        },
        grounding: {
          ...aggregates.current.grounding,
          headlineState: resolveGroundingHeadlineState({
            evaluatedAnswerCount: aggregates.current.grounding.evaluatedAnswerCount,
            evaluatedConversationCount,
          }),
        },
        evidence: {
          strength: resolveEvidenceStrength(evaluatedConversationCount),
          evaluatedConversationCount,
          activeGapConversationCount: opportunity.activeGapConversationCount,
        },
        opportunity: {
          credible: opportunity.credible,
          priorityReasons,
        },
        recommendation: {
          action,
          state: topic.enrichment.state,
          rationale: topic.enrichment.rationale,
          suggestedTitle: topic.enrichment.suggestedTitle,
          questionsToAnswer: parseQuestions(topic.enrichment.questionsToAnswer),
          suggestedShape: parseSuggestedShape(topic.enrichment.suggestedShape),
          evidenceStatement: topic.enrichment.evidenceStatement,
          factsMustBeVerified: true,
        },
        corpusEvidence: {
          state: topic.enrichment.corpusState,
          relatedDocumentCount: Math.min(documents.length, 5),
          actionRuleVersion: 1,
        },
        affected: {
          agentCount: affectedAgents.length,
          channelCount: affectedChannels.length,
        },
        updatedAt: latestDate([
          topic.updatedAt,
          topic.enrichment.updatedAt,
          ...documents.map((document) => document.updatedAt),
        ]),
      };
      return [{
        summary,
        activeNoSupportConversationCount: opportunity.activeNoSupportConversationCount,
        activeDegradedConversationCount: opportunity.activeDegradedConversationCount,
        trendRank: TREND_RANK[trend],
        detail: {
          topic: summary,
          decision: {
            action,
            actionState: resolveActionState(action, topic.enrichment.corpusState),
            reasons: uniqueStrings([
              topic.enrichment.rationale,
              topic.enrichment.evidenceStatement,
            ]).slice(0, 8),
          },
          representativeQuestions: topic.representativeObservationIds
            .slice(0, 8)
            .flatMap((observationId) => {
              const observation = observations.find((candidate) => candidate.id === observationId);
              if (!observation) return [];
              return [{
                observationId: observation.id,
                question: observation.question,
                sourceAvailable: observation.question !== null,
                conversationId: observation.conversationId,
                userMessageId: observation.sourceUserMessageId,
                assistantMessageId: observation.sourceAssistantMessageId,
                observedAt: observation.observedAt,
                groundingVerdict: groundingVerdict(observation, input.evidenceByAssistantMessageId),
              }];
            }),
          relatedDocuments: documents.slice(0, 5).map(toDetailDocument),
          affectedAgents,
          affectedChannels,
        },
      }];
    })
    .sort((left, right) => compareContentPlanOpportunities(
      toRankingInput(left),
      toRankingInput(right),
    ));
  const topics = applyCurrentGeneratedBriefCap(rankedTopics);

  const emerging = presentEmerging({
    topics: topicById,
    observations: liveObservations,
    currentWindow: windows.current,
  });
  return {
    summary: {
      questionCount: reportAggregates.current.questionCount,
      conversationCount: reportAggregates.current.conversationCount,
      matureTopicCount: topics.length,
      emergingQuestionCount: emerging.length,
      opportunityCount: topics.filter(({ summary }) => summary.opportunity.credible).length,
      grounding: {
        ...reportAggregates.current.grounding,
        headlineState: resolveGroundingHeadlineState({
          evaluatedAnswerCount: reportAggregates.current.grounding.evaluatedAnswerCount,
          evaluatedConversationCount: reportEvaluatedConversationCount,
        }),
      },
    },
    topics,
    emerging,
  };
};

const applyCurrentGeneratedBriefCap = (
  topics: PresentedContentPlanTopic[],
): PresentedContentPlanTopic[] => {
  let credibleRank = 0;
  return topics.map((topic) => {
    const credible = topic.summary.opportunity.credible;
    if (credible) credibleRank += 1;
    const insideCap = credible
      && credibleRank <= CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1.generatedBriefCap;
    const publishedBriefComplete = hasCompleteGeneratedBrief(topic.summary.recommendation);
    const storedState = topic.summary.recommendation.state;
    const exposeBrief = insideCap
      && publishedBriefComplete
      && storedState !== "outside_analysis_cap";

    let state = storedState;
    if (credible && !insideCap) {
      state = "outside_analysis_cap";
    } else if (insideCap && !exposeBrief) {
      state = storedState === "stale" || storedState === "unavailable"
        ? storedState
        : "pending";
    } else if (!credible && storedState === "outside_analysis_cap") {
      state = "ready";
    }

    const recommendation: ContentPlanTopicSummary["recommendation"] = exposeBrief
      ? { ...topic.summary.recommendation, state }
      : {
          ...topic.summary.recommendation,
          state,
          rationale: null,
          suggestedTitle: null,
          questionsToAnswer: [],
          suggestedShape: null,
          evidenceStatement: null,
        };
    const summary: ContentPlanTopicSummary = { ...topic.summary, recommendation };
    return {
      ...topic,
      summary,
      detail: {
        ...topic.detail,
        topic: summary,
        decision: {
          ...topic.detail.decision,
          reasons: exposeBrief ? topic.detail.decision.reasons : [],
        },
      },
    };
  });
};

const hasCompleteGeneratedBrief = (
  recommendation: ContentPlanTopicSummary["recommendation"],
): boolean => recommendation.rationale !== null
  && recommendation.suggestedTitle !== null
  && recommendation.questionsToAnswer.length >= 3
  && recommendation.questionsToAnswer.length <= 7
  && recommendation.suggestedShape !== null
  && recommendation.evidenceStatement !== null;

const presentEmerging = (input: {
  topics: ReadonlyMap<string, ContentPlanReadTopic>;
  observations: ContentPlanReadObservation[];
  currentWindow: { from: string; to: string };
}): ContentPlanEmergingQuestion[] => {
  const current = input.observations.filter((observation) =>
    inWindow(observation.observedAt, input.currentWindow));
  const provisionalGroups = groupBy(current.filter((observation) =>
    observation.observationState === "ready"
    && observation.topicLifecycle === "provisional"
    && observation.topicId !== null), (observation) => observation.topicId!);
  const entries: ContentPlanEmergingQuestion[] = [];
  for (const [topicId, observations] of provisionalGroups) {
    const unique = uniqueQuestions(observations);
    const topic = input.topics.get(topicId);
    const representative = topic?.representativeObservationIds
      .map((id) => observations.find((observation) => observation.id === id))
      .find((observation): observation is ContentPlanReadObservation => Boolean(observation))
      ?? observations[0];
    if (!representative) continue;
    entries.push({
      observationId: representative.id,
      question: representative.question,
      sourceAvailable: representative.question !== null,
      conversationId: representative.conversationId,
      assistantMessageId: representative.sourceAssistantMessageId,
      questionCount: unique.length,
      conversationCount: distinctConversations(unique),
      observedAt: representative.observedAt,
      state: "emerging",
    });
  }

  for (const observation of current) {
    if (observation.observationState === "pending_context") {
      entries.push(toPendingEmerging(observation, "awaiting_context"));
    } else if (observation.topicId === null && observation.vectorState !== "assigned") {
      entries.push(toPendingEmerging(observation, "awaiting_embedding"));
    }
  }
  return entries.sort((left, right) =>
    right.observedAt.localeCompare(left.observedAt)
    || left.observationId.localeCompare(right.observationId));
};

const toPendingEmerging = (
  observation: ContentPlanReadObservation,
  state: "awaiting_context" | "awaiting_embedding",
): ContentPlanEmergingQuestion => ({
  observationId: observation.id,
  question: observation.question,
  sourceAvailable: observation.question !== null,
  conversationId: observation.conversationId,
  assistantMessageId: observation.sourceAssistantMessageId,
  questionCount: 1,
  conversationCount: 1,
  observedAt: observation.observedAt,
  state,
});

const toAggregateObservation = (
  observation: ContentPlanReadObservation,
  evidence: ReadonlyMap<string, QualityContentPlanningTurnEvidence>,
) => ({
  sourceUserMessageId: observation.sourceUserMessageId,
  conversationId: observation.conversationId,
  observedAt: observation.observedAt,
  groundingVerdict: groundingVerdict(observation, evidence),
});

const groundingVerdict = (
  observation: ContentPlanReadObservation,
  evidence: ReadonlyMap<string, QualityContentPlanningTurnEvidence>,
): "grounded" | "degraded" | "no_support" | "not_evaluated" =>
  evidence.get(observation.sourceAssistantMessageId)?.grounding?.verdict ?? "not_evaluated";

const toRankingInput = (topic: PresentedContentPlanTopic) => ({
  topicId: topic.summary.id,
  activeNoSupportConversationCount: topic.activeNoSupportConversationCount,
  activeDegradedConversationCount: topic.activeDegradedConversationCount,
  currentConversationCount: topic.summary.demand.currentConversationCount,
  trend: topic.summary.demand.trend,
});

const countAffectedAgents = (
  observations: ContentPlanReadObservation[],
  evidence: ReadonlyMap<string, QualityContentPlanningTurnEvidence>,
): ContentPlanTopicDetail["affectedAgents"] => {
  const byAgent = new Map<string, { name: string | null; questions: Set<string> }>();
  for (const observation of observations) {
    const agentId = evidence.get(observation.sourceAssistantMessageId)?.agentId;
    if (!agentId) continue;
    const entry = byAgent.get(agentId) ?? { name: observation.agentName, questions: new Set<string>() };
    entry.questions.add(observation.sourceUserMessageId);
    byAgent.set(agentId, entry);
  }
  return [...byAgent]
    .map(([id, value]) => ({ id, name: value.name, questionCount: value.questions.size }))
    .sort((left, right) => right.questionCount - left.questionCount || left.id.localeCompare(right.id));
};

const countAffectedChannels = (
  observations: ContentPlanReadObservation[],
  evidence: ReadonlyMap<string, QualityContentPlanningTurnEvidence>,
): ContentPlanTopicDetail["affectedChannels"] => {
  const byChannel = new Map<string | null, Set<string>>();
  for (const observation of observations) {
    const channel = evidence.get(observation.sourceAssistantMessageId)?.channel ?? null;
    const questions = byChannel.get(channel) ?? new Set<string>();
    questions.add(observation.sourceUserMessageId);
    byChannel.set(channel, questions);
  }
  return [...byChannel]
    .map(([channel, questions]) => ({ channel, questionCount: questions.size }))
    .sort((left, right) =>
      right.questionCount - left.questionCount
      || (left.channel ?? "").localeCompare(right.channel ?? ""));
};

const toDetailDocument = (document: ContentPlanReadDocument): ContentPlanTopicDetail["relatedDocuments"][number] => ({
  id: document.id,
  title: document.title,
  updatedAt: document.updatedAt,
  possibleRelevance: document.possibleRelevance,
  evidence: {
    existedBeforeGap: document.existedBeforeGap,
    retrievedByGapAnswers: document.retrievedByGapAnswers,
    citedByGapAnswers: document.citedByGapAnswers,
    changedAfterGap: document.changedAfterGap,
  },
});

const resolveActionState = (
  action: ContentPlanTopicSummary["recommendation"]["action"],
  corpusState: ContentPlanTopicSummary["corpusEvidence"]["state"],
): ContentPlanTopicDetail["decision"]["actionState"] => {
  if (action !== null) return "ready";
  if (corpusState === "unavailable") return "unavailable";
  if (corpusState === "stale") return "stale";
  return "pending";
};

const parseQuestions = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0 && item.length <= 500).slice(0, 7);
};

const parseSuggestedShape = (
  value: string | null,
): ContentPlanTopicSummary["recommendation"]["suggestedShape"] =>
  value === "guide" || value === "faq" || value === "reference"
    || value === "policy" || value === "troubleshooting"
    ? value
    : null;

const uniqueQuestions = (observations: ContentPlanReadObservation[]): ContentPlanReadObservation[] => {
  const byMessage = new Map<string, ContentPlanReadObservation>();
  for (const observation of observations) {
    if (!byMessage.has(observation.sourceUserMessageId)) {
      byMessage.set(observation.sourceUserMessageId, observation);
    }
  }
  return [...byMessage.values()];
};

const distinctConversations = (
  observations: ContentPlanReadObservation[],
): number => new Set(observations.map((observation) => observation.conversationId)).size;

const inWindow = (value: string, window: { from: string; to: string }): boolean =>
  value >= window.from && value < window.to;

const groupBy = <T>(values: T[], key: (value: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const name = key(value);
    const group = groups.get(name) ?? [];
    group.push(value);
    groups.set(name, group);
  }
  return groups;
};

const uniqueStrings = (values: Array<string | null>): string[] =>
  [...new Set(values.filter((value): value is string => Boolean(value)))];

const latestDate = (values: Array<string | null>): string =>
  values.filter((value): value is string => value !== null).sort().at(-1)!;
