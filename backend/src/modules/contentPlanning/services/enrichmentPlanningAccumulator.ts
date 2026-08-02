import type { QualityContentPlanningTurnEvidence } from "../../quality/contracts/contentPlanningEvidence.js";
import type {
  ContentPlanReadDocument,
  ContentPlanReadTopic,
} from "../infra/contentPlanReadSource.js";
import {
  CONTENT_PLAN_ACTION_POLICY_V1,
  compareContentPlanOpportunities,
  selectRecommendationAction,
} from "../domain/opportunityPolicy.js";
import {
  resolveContentPlanWindows,
  resolveEvidenceStrength,
  resolveTopicTrend,
} from "../domain/aggregationPolicy.js";
import { contentPlanCorpusEvidenceFingerprint } from "./enrichmentContextService.js";
import type { ContentPlanEnrichmentSchedulingTopic } from "./enrichmentScheduler.js";

export interface ContentPlanEnrichmentPlanningObservation {
  id: string;
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  conversationId: string;
  observedAt: string;
  topicId: string;
}

interface TopicAggregate {
  currentQuestionCount: number;
  comparisonQuestionCount: number;
  groundedCount: number;
  degradedCount: number;
  noSupportCount: number;
  notEvaluatedCount: number;
  currentConversations: Set<string>;
  evaluatedConversations: Set<string>;
  activeNoSupportConversations: Set<string>;
  activeDegradedConversations: Set<string>;
  activeGapConversations: Set<string>;
}

const emptyAggregate = (): TopicAggregate => ({
  currentQuestionCount: 0,
  comparisonQuestionCount: 0,
  groundedCount: 0,
  degradedCount: 0,
  noSupportCount: 0,
  notEvaluatedCount: 0,
  currentConversations: new Set(),
  evaluatedConversations: new Set(),
  activeNoSupportConversations: new Set(),
  activeDegradedConversations: new Set(),
  activeGapConversations: new Set(),
});

export class ContentPlanEnrichmentPlanningAccumulator {
  private readonly windows: ReturnType<typeof resolveContentPlanWindows>;
  private readonly topicsById: Map<string, ContentPlanReadTopic>;
  private readonly documentsByTopic = new Map<string, ContentPlanReadDocument[]>();
  private readonly aggregates = new Map<string, TopicAggregate>();

  constructor(private readonly input: {
    workspaceId: string;
    generationId: string;
    asOf: Date;
    topics: readonly ContentPlanReadTopic[];
    documents: readonly ContentPlanReadDocument[];
  }) {
    this.windows = resolveContentPlanWindows(input.asOf);
    this.topicsById = new Map(input.topics.map((topic) => [topic.id, topic]));
    for (const document of input.documents) {
      const values = this.documentsByTopic.get(document.topicId) ?? [];
      values.push(document);
      this.documentsByTopic.set(document.topicId, values);
    }
  }

  addPage(
    observations: readonly ContentPlanEnrichmentPlanningObservation[],
    evidenceByAssistantMessageId: ReadonlyMap<string, QualityContentPlanningTurnEvidence>,
  ): void {
    for (const observation of observations) {
      if (!this.topicsById.has(observation.topicId)) continue;
      const evidence = evidenceByAssistantMessageId.get(observation.sourceAssistantMessageId);
      if (!evidence) continue;
      const aggregate = this.aggregates.get(observation.topicId) ?? emptyAggregate();
      if (inWindow(observation.observedAt, this.windows.comparison)) {
        aggregate.comparisonQuestionCount += 1;
      } else if (inWindow(observation.observedAt, this.windows.current)) {
        aggregate.currentQuestionCount += 1;
        aggregate.currentConversations.add(observation.conversationId);
        const verdict = evidence.grounding?.verdict ?? "not_evaluated";
        if (verdict === "grounded") aggregate.groundedCount += 1;
        else if (verdict === "degraded") aggregate.degradedCount += 1;
        else if (verdict === "no_support") aggregate.noSupportCount += 1;
        else aggregate.notEvaluatedCount += 1;
        if (verdict !== "not_evaluated") {
          aggregate.evaluatedConversations.add(observation.conversationId);
        }
        if (evidence.remediation.active && (verdict === "degraded" || verdict === "no_support")) {
          aggregate.activeGapConversations.add(observation.conversationId);
          if (verdict === "degraded") {
            aggregate.activeDegradedConversations.add(observation.conversationId);
          } else {
            aggregate.activeNoSupportConversations.add(observation.conversationId);
          }
        }
      }
      this.aggregates.set(observation.topicId, aggregate);
    }
  }

  finish(): ContentPlanEnrichmentSchedulingTopic[] {
    return this.input.topics
      .flatMap((topic) => this.toSchedulingTopic(topic))
      .sort((left, right) => compareContentPlanOpportunities(
        rankingInput(left, this.aggregates.get(left.topicId)!),
        rankingInput(right, this.aggregates.get(right.topicId)!),
      ));
  }

  private toSchedulingTopic(topic: ContentPlanReadTopic): ContentPlanEnrichmentSchedulingTopic[] {
    const aggregate = this.aggregates.get(topic.id);
    if (topic.lifecycle !== "mature" || !aggregate || aggregate.currentQuestionCount === 0) return [];
    const credibleOpportunity = aggregate.activeGapConversations.size
      >= CONTENT_PLAN_ACTION_POLICY_V1.credibleGapConversationFloor;
    const documents = this.documentsByTopic.get(topic.id) ?? [];
    const action = selectRecommendationAction({
      credibleGap: credibleOpportunity,
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
    const corpusEvidenceFingerprint = contentPlanCorpusEvidenceFingerprint({
      state: topic.enrichment.corpusState,
      documents: documents.map((document) => ({
        id: document.id,
        updatedAt: document.updatedAt,
        possibleRelevance: document.possibleRelevance,
        evidence: {
          existedBeforeGap: document.existedBeforeGap,
          retrievedByGapAnswers: document.retrievedByGapAnswers,
          citedByGapAnswers: document.citedByGapAnswers,
          changedAfterGap: document.changedAfterGap,
        },
      })),
    });
    const publishedEvidence = topic.enrichment.publishedSourceEvidence;
    const publishedStrength = topic.enrichment.publishedSourceEvidenceStrength;
    const publishedAnalysisMode = hasPublishedContentBrief(topic.enrichment)
      ? "label_and_brief"
      : "label_only";
    return [{
      workspaceId: this.input.workspaceId,
      generationId: this.input.generationId,
      topicId: topic.id,
      topicRevision: topic.revision,
      lifecycle: "mature",
      current: {
        memberCount: aggregate.currentQuestionCount,
        groundedCount: aggregate.groundedCount,
        degradedCount: aggregate.degradedCount,
        noSupportCount: aggregate.noSupportCount,
        notEvaluatedCount: aggregate.notEvaluatedCount,
        credibleOpportunity,
        groundingBand: resolveEvidenceStrength(aggregate.evaluatedConversations.size),
        action,
        corpusEvidenceFingerprint,
      },
      lastEnriched: publishedEvidence
        && publishedStrength
        && topic.enrichment.sourceTopicRevision !== null
        ? {
            sourceTopicRevision: topic.enrichment.sourceTopicRevision,
            ...publishedEvidence,
            groundingBand: publishedStrength,
            action: topic.enrichment.persistedAction,
            corpusEvidenceFingerprint:
              topic.enrichment.publishedSourceCorpusEvidenceFingerprint,
            analysisMode: publishedAnalysisMode,
            recommendationState: publishedEvidence.credibleOpportunity
              && publishedAnalysisMode === "label_only"
              ? "outside_analysis_cap"
              : "ready",
          }
        : null,
    }];
  }
}

const rankingInput = (
  topic: ContentPlanEnrichmentSchedulingTopic,
  aggregate: TopicAggregate,
) => ({
  topicId: topic.topicId,
  activeNoSupportConversationCount: aggregate.activeNoSupportConversations.size,
  activeDegradedConversationCount: aggregate.activeDegradedConversations.size,
  currentConversationCount: aggregate.currentConversations.size,
  trend: resolveTopicTrend({
    currentQuestionCount: aggregate.currentQuestionCount,
    comparisonQuestionCount: aggregate.comparisonQuestionCount,
  }),
});

const inWindow = (
  observedAt: string,
  window: { from: string; to: string },
): boolean => {
  const value = new Date(observedAt).getTime();
  return Number.isFinite(value)
    && value >= new Date(window.from).getTime()
    && value < new Date(window.to).getTime();
};

const hasPublishedContentBrief = (
  enrichment: ContentPlanReadTopic["enrichment"],
): boolean => enrichment.suggestedTitle !== null
  && enrichment.rationale !== null
  && Array.isArray(enrichment.questionsToAnswer)
  && enrichment.questionsToAnswer.length >= 3
  && enrichment.suggestedShape !== null
  && enrichment.evidenceStatement !== null;
