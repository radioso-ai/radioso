import { describe, expect, it } from "vitest";

import type { ContentPlanProjection } from "../../src/modules/contentPlanning/contracts/index.js";
import type {
  ContentPlanReadObservation,
  ContentPlanReadTopic,
} from "../../src/modules/contentPlanning/infra/contentPlanReadSource.js";
import { presentContentPlanReport } from "../../src/modules/contentPlanning/services/contentPlanPresenter.js";
import type { QualityContentPlanningTurnEvidence } from "../../src/modules/quality/contracts/contentPlanningEvidence.js";

const AS_OF = new Date("2026-08-02T12:00:00.000Z");

describe("Content Planning presentation", () => {
  it("applies the current credible top-ten cap before exposing generated brief content", () => {
    const topics = Array.from({ length: 13 }, (_, offset) => readTopic(offset + 1));
    topics[0] = readTopic(1, {
      state: "ready",
      suggestedTitle: null,
      rationale: null,
      questionsToAnswer: null,
      suggestedShape: null,
      evidenceStatement: null,
    });
    topics[10] = readTopic(11, { state: "stale" });
    const observations = topics.flatMap((topic, offset) => topicObservations(
      topic.id,
      offset + 1,
    ));
    const evidence = new Map(observations.map((observation) => [
      observation.sourceAssistantMessageId,
      qualityEvidence(
        observation.sourceAssistantMessageId,
        observation.conversationId,
        observation.topicId === "topic_13" ? "grounded" : "no_support",
      ),
    ]));

    const report = presentContentPlanReport({
      asOf: AS_OF,
      projection: READY_PROJECTION,
      data: { topics, observations, documents: [] },
      evidenceByAssistantMessageId: evidence,
    });

    expect(report.topics.slice(0, 10).map(({ summary }) => summary.id)).toEqual(
      Array.from({ length: 10 }, (_, offset) => `topic_${String(offset + 1).padStart(2, "0")}`),
    );
    expect(report.topics[0]?.summary).toMatchObject({
      label: "Topic 01",
      opportunity: { credible: true },
      recommendation: {
        action: "add_content",
        state: "pending",
        rationale: null,
        suggestedTitle: null,
        questionsToAnswer: [],
        suggestedShape: null,
        evidenceStatement: null,
      },
    });

    for (const presented of report.topics.slice(10, 12)) {
      expect(presented.summary).toMatchObject({
        opportunity: { credible: true },
        recommendation: {
          action: "add_content",
          state: "outside_analysis_cap",
          rationale: null,
          suggestedTitle: null,
          questionsToAnswer: [],
          suggestedShape: null,
          evidenceStatement: null,
        },
      });
      expect(presented.summary.label).toMatch(/^Topic /);
      expect(presented.summary.description).toMatch(/^Questions about topic /);
      expect(presented.summary.evidence).toMatchObject({
        evaluatedConversationCount: 2,
        activeGapConversationCount: 2,
      });
      expect(presented.detail.decision).toMatchObject({ action: "add_content", reasons: [] });
    }

    const noLongerCredible = report.topics.find(({ summary }) => summary.id === "topic_13");
    expect(noLongerCredible?.summary).toMatchObject({
      label: "Topic 13",
      opportunity: { credible: false },
      recommendation: {
        action: "monitor",
        state: "ready",
        rationale: null,
        suggestedTitle: null,
        questionsToAnswer: [],
        suggestedShape: null,
        evidenceStatement: null,
      },
    });
    expect(noLongerCredible?.detail.decision).toMatchObject({ action: "monitor", reasons: [] });

    const exposedBriefs = report.topics.filter(({ summary }) =>
      summary.recommendation.suggestedTitle !== null);
    expect(exposedBriefs).toHaveLength(9);
    expect(exposedBriefs.every(({ summary }) => summary.opportunity.credible)).toBe(true);
    expect(exposedBriefs.map(({ summary }) => summary.id)).toEqual(
      Array.from({ length: 9 }, (_, offset) => `topic_${String(offset + 2).padStart(2, "0")}`),
    );
  });
});

const readTopic = (
  index: number,
  enrichmentOverrides: Partial<ContentPlanReadTopic["enrichment"]> = {},
): ContentPlanReadTopic => ({
  id: `topic_${String(index).padStart(2, "0")}`,
  lifecycle: "mature",
  representativeObservationIds: [],
  revision: 3,
  mergedIntoTopicId: null,
  redirectExpiresAt: null,
  updatedAt: "2026-08-02T11:00:00.000Z",
  enrichment: {
    state: "ready",
    sourceTopicRevision: 3,
    label: `Topic ${String(index).padStart(2, "0")}`,
    description: `Questions about topic ${index}.`,
    suggestedTitle: `Guide ${index}`,
    rationale: `Repeated gaps for topic ${index}.`,
    questionsToAnswer: ["What is it?", "How does it work?", "Who can use it?"],
    suggestedShape: "guide",
    evidenceStatement: `Based on two conversations for topic ${index}.`,
    persistedAction: "add_content",
    actionRuleVersion: 1,
    corpusState: "ready",
    publishedSourceEvidence: {
      memberCount: 2,
      groundedCount: 0,
      degradedCount: 0,
      noSupportCount: 2,
      notEvaluatedCount: 0,
      credibleOpportunity: true,
    },
    publishedSourceEvidenceStrength: "low",
    publishedSourceCorpusEvidenceFingerprint: null,
    updatedAt: "2026-08-02T11:00:00.000Z",
    ...enrichmentOverrides,
  },
});

const topicObservations = (
  topicId: string,
  index: number,
): ContentPlanReadObservation[] => Array.from({ length: 2 }, (_, offset) => ({
  id: `observation_${index}_${offset + 1}`,
  sourceUserMessageId: `user_${index}_${offset + 1}`,
  sourceAssistantMessageId: `assistant_${index}_${offset + 1}`,
  conversationId: `conversation_${index}_${offset + 1}`,
  observationState: "ready",
  observedAt: "2026-07-20T10:00:00.000Z",
  question: `Question ${offset + 1} for ${topicId}?`,
  agentName: "Support",
  topicId,
  topicLifecycle: "mature",
  vectorState: "assigned",
}));

const qualityEvidence = (
  assistantMessageId: string,
  conversationId: string,
  verdict: "grounded" | "no_support",
): QualityContentPlanningTurnEvidence => ({
  assistantMessageId,
  conversationId,
  agentId: "agent_1",
  channel: "web",
  createdAt: "2026-07-20T10:00:00.000Z",
  grounding: {
    verdict,
    claimCount: 1,
    sourcedClaimCount: verdict === "grounded" ? 1 : 0,
    unsourcedClaimCount: verdict === "grounded" ? 0 : 1,
    invalidSourceCount: 0,
  },
  triage: { state: "open", resolutionReason: null, reopenedByNewerNegativeFeedback: false },
  verification: null,
  remediation: { active: true, inactiveReasons: [] },
});

const READY_PROJECTION: ContentPlanProjection = {
  state: "ready",
  processedThrough: null,
  processingLagSeconds: null,
  pendingEmbeddingCount: 0,
  pendingAssignmentCount: 0,
  pendingEnrichmentTopicCount: 0,
  processedCount: null,
  totalCount: null,
  embeddingSpaceFingerprint: null,
  reason: null,
};
