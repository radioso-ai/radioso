import { describe, expect, it, vi } from "vitest";

import { EvalQualityVerificationSource } from "../../src/app/composition/adapters/evalQualityVerificationSource.js";
import type {
  ContentPlanReadSourcePort,
  ContentPlanReadTopic,
} from "../../src/modules/contentPlanning/infra/contentPlanReadSource.js";
import {
  ContentPlanReportEnrichmentPlanningSource,
  ContentPlanningEnrichmentPlanningService,
} from "../../src/modules/contentPlanning/services/enrichmentPlanningService.js";
import { contentPlanCorpusEvidenceFingerprint } from "../../src/modules/contentPlanning/services/enrichmentContextService.js";
import { ContentPlanningEnrichmentScheduler } from "../../src/modules/contentPlanning/services/enrichmentScheduler.js";
import {
  QualityContentPlanningEvidenceSource,
  type QualityContentPlanningTurnEvidence,
} from "../../src/modules/quality/contentPlanningEvidence.js";

describe("Content Planning enrichment planning", () => {
  it("skips the report and Quality scan when no durable topic is dirty", async () => {
    const source = { load: vi.fn(), completeRepairPage: vi.fn() };
    const trigger = {
      listDirtyTopics: vi.fn(async () => []),
      acknowledgeDirtyTopics: vi.fn(),
    };
    const record = vi.fn();
    const runner = new ContentPlanningEnrichmentPlanningService({
      source,
      scheduler: new ContentPlanningEnrichmentScheduler({
        queue: vi.fn(),
        rebasePublished: vi.fn(),
      }),
      trigger,
      observability: { record },
      clock: () => new Date("2026-08-02T12:00:00.000Z"),
    });

    await expect(runner.runOnce({ workspaceId: "workspace_1", generationId: "generation_1" }))
      .resolves.toEqual({ kind: "skipped", dirtyTopicCount: 0 });
    expect(source.load).not.toHaveBeenCalled();
    expect(trigger.acknowledgeDirtyTopics).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "enrichment_schedule",
      outcome: "skipped",
      workspaceId: "workspace_1",
      generationId: "generation_1",
      itemCount: 0,
      durationMs: expect.any(Number),
    }));
  });

  it("acknowledges exact durable dirty markers only after scheduling succeeds", async () => {
    const dirtyAt = new Date("2026-08-02T11:59:00.000Z");
    const markers = [{ topicId: "topic_1", revision: 4, dirtyAt }];
    const source = {
      load: vi.fn(async () => ({ topics: [], repairCheckpoint: null })),
      completeRepairPage: vi.fn(async () => true),
    };
    const trigger = {
      listDirtyTopics: vi.fn(async () => markers),
      acknowledgeDirtyTopics: vi.fn(async () => 1),
    };
    const record = vi.fn();
    const runner = new ContentPlanningEnrichmentPlanningService({
      source,
      scheduler: new ContentPlanningEnrichmentScheduler({
        queue: vi.fn(),
        rebasePublished: vi.fn(),
      }),
      trigger,
      observability: { record },
      clock: () => new Date("2026-08-02T12:00:00.000Z"),
    });

    await expect(runner.runOnce({ workspaceId: "workspace_1", generationId: "generation_1" }))
      .resolves.toMatchObject({
        kind: "planned",
        dirtyTopicCount: 1,
        acknowledgedDirtyTopicCount: 1,
      });
    expect(source.load).toHaveBeenCalledOnce();
    expect(trigger.acknowledgeDirtyTopics).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      markers,
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "enrichment_schedule",
      outcome: "completed",
      workspaceId: "workspace_1",
      generationId: "generation_1",
      itemCount: 0,
      matureTopicCount: 0,
      pendingEnrichmentCount: 0,
      durationMs: expect.any(Number),
    }));
  });

  it("loads only the selected dirty batch on a hot run", async () => {
    const dirtyAt = new Date("2026-08-02T11:59:00.000Z");
    const markers = Array.from({ length: 100 }, (_, index) => ({
      topicId: `topic_${String(index).padStart(3, "0")}`,
      revision: 2,
      dirtyAt,
    }));
    const source = {
      load: vi.fn(async () => ({ topics: [], repairCheckpoint: null })),
      completeRepairPage: vi.fn(async () => true),
    };
    const trigger = {
      listDirtyTopics: vi.fn(async () => markers),
      acknowledgeDirtyTopics: vi.fn(async () => markers.length),
    };
    const runner = new ContentPlanningEnrichmentPlanningService({
      source,
      scheduler: new ContentPlanningEnrichmentScheduler({
        queue: vi.fn(),
        rebasePublished: vi.fn(),
      }),
      trigger,
      clock: () => new Date("2026-08-02T12:00:00.000Z"),
    });

    await expect(runner.runOnce({ workspaceId: "workspace_1", generationId: "generation_1" }))
      .resolves.toMatchObject({ dirtyTopicCount: 100, acknowledgedDirtyTopicCount: 100 });
    expect(trigger.listDirtyTopics).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    expect(source.load).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      asOf: new Date("2026-08-02T12:00:00.000Z"),
      dirtyTopicIds: markers.map((marker) => marker.topicId),
      repair: null,
    });
  });

  it("streams exact topic evidence through bounded DB and Quality pages", async () => {
    const observations = Array.from({ length: 501 }, (_, index) => ({
      id: `observation_${index}`,
      sourceUserMessageId: `user_${index}`,
      sourceAssistantMessageId: `assistant_${index}`,
      conversationId: `conversation_${index}`,
      observedAt: "2026-07-20T10:00:00.000Z",
      topicId: "topic_1",
    }));
    const pageObservations = vi.fn(async (input: { cursor: unknown; limit: number }) =>
      input.cursor === null
        ? {
            items: observations.slice(0, 500),
            nextCursor: {
              observedAt: observations[499]!.observedAt,
              observationId: observations[499]!.id,
            },
          }
        : { items: observations.slice(500), nextCursor: null });
    const getEvidenceByAssistantMessageIds = vi.fn(async (_workspaceId: string, ids: string[]) =>
      new Map(ids.map((assistantMessageId) => {
        const index = Number(assistantMessageId.slice("assistant_".length));
        return [
          assistantMessageId,
          evidence(assistantMessageId, `conversation_${index}`, "no_support"),
        ];
      })));
    const source = new ContentPlanReportEnrichmentPlanningSource({
      source: {
        loadData: vi.fn(async () => ({
          topics: [readTopic()],
          documents: [],
          repairCheckpoint: null,
        })),
        pageObservations,
        completeRepairPage: vi.fn(async () => true),
      },
      qualityEvidence: { getEvidenceByAssistantMessageIds },
    });

    const result = await source.load({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      asOf: new Date("2026-08-02T12:00:00.000Z"),
      dirtyTopicIds: ["topic_1"],
      repair: null,
    });

    expect(result.topics[0]?.current).toMatchObject({
      memberCount: 501,
      noSupportCount: 501,
      credibleOpportunity: true,
      groundingBand: "high",
    });
    expect(pageObservations).toHaveBeenCalledTimes(2);
    expect(pageObservations.mock.calls.every(([input]) => input.limit === 500)).toBe(true);
    expect(getEvidenceByAssistantMessageIds.mock.calls.map(([, ids]) => ids.length))
      .toEqual([500, 1]);
  });

  it("does not query observations or Quality when the selected batch is empty", async () => {
    const pageObservations = vi.fn();
    const getEvidenceByAssistantMessageIds = vi.fn();
    const source = new ContentPlanReportEnrichmentPlanningSource({
      source: {
        loadData: vi.fn(async () => ({
          topics: [],
          documents: [],
          repairCheckpoint: null,
        })),
        pageObservations,
        completeRepairPage: vi.fn(async () => true),
      },
      qualityEvidence: { getEvidenceByAssistantMessageIds },
    });

    await expect(source.load({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      asOf: new Date("2026-08-02T12:00:00.000Z"),
      dirtyTopicIds: ["topic_retired"],
      repair: null,
    })).resolves.toEqual({ topics: [], repairCheckpoint: null });
    expect(pageObservations).not.toHaveBeenCalled();
    expect(getEvidenceByAssistantMessageIds).not.toHaveBeenCalled();
  });

  it("runs a cadenced repair scan without dirty topics and retains failed markers", async () => {
    const dirtyAt = new Date("2026-08-02T11:59:00.000Z");
    const markers = [{ topicId: "topic_1", revision: 4, dirtyAt }];
    const schedulingTopic = {
      workspaceId: "workspace_1",
      generationId: "generation_1",
      topicId: "topic_1",
      topicRevision: 4,
      lifecycle: "mature" as const,
      current: {
        memberCount: 2,
        groundedCount: 0,
        degradedCount: 0,
        noSupportCount: 2,
        notEvaluatedCount: 0,
        credibleOpportunity: true,
        groundingBand: "low" as const,
        action: "add_content" as const,
        corpusEvidenceFingerprint: null,
      },
      lastEnriched: null,
    };
    const source = {
      load: vi.fn(async () => ({
        topics: [schedulingTopic],
        repairCheckpoint: { expectedVersion: 1, nextTopicId: "topic_1" },
      })),
      completeRepairPage: vi.fn(async () => true),
    };
    const trigger = {
      listDirtyTopics: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(markers),
      acknowledgeDirtyTopics: vi.fn(),
    };
    const queue = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const runner = new ContentPlanningEnrichmentPlanningService({
      source,
      scheduler: new ContentPlanningEnrichmentScheduler({
        queue,
        rebasePublished: vi.fn(async () => true),
      }),
      trigger,
      clock: () => new Date("2026-08-02T12:00:00.000Z"),
    });

    await expect(runner.runOnce({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      forceRepair: true,
    })).resolves.toMatchObject({ kind: "planned", dirtyTopicCount: 0, failedCount: 1 });
    await expect(runner.runOnce({
      workspaceId: "workspace_1",
      generationId: "generation_1",
    })).resolves.toMatchObject({ kind: "planned", dirtyTopicCount: 1, failedCount: 1 });
    expect(source.load).toHaveBeenCalledTimes(2);
    expect(trigger.acknowledgeDirtyTopics).not.toHaveBeenCalled();
  });

  it("assembles canonical report evidence and compares it with the last published snapshot", async () => {
    const readSource: ContentPlanReadSourcePort = {
      getProjection: vi.fn(async () => null),
      getReportData: vi.fn(async () => ({
        topics: [{
          id: "topic_1",
          lifecycle: "mature" as const,
          representativeObservationIds: ["observation_1", "observation_2"],
          revision: 4,
          mergedIntoTopicId: null,
          redirectExpiresAt: null,
          updatedAt: "2026-08-02T11:00:00.000Z",
          enrichment: {
            state: "ready" as const,
            sourceTopicRevision: 3,
            label: "Deployments",
            description: "Deployment questions.",
            suggestedTitle: "Deployment guide",
            rationale: "Repeated gaps.",
            questionsToAnswer: ["How?", "Who?", "When?"],
            suggestedShape: "guide",
            evidenceStatement: "One earlier question.",
            persistedAction: "add_content" as const,
            actionRuleVersion: 1,
            corpusState: "ready" as const,
            publishedSourceEvidence: {
              memberCount: 1,
              groundedCount: 0,
              degradedCount: 0,
              noSupportCount: 1,
              notEvaluatedCount: 0,
              credibleOpportunity: false,
            },
            publishedSourceEvidenceStrength: "low" as const,
            publishedSourceCorpusEvidenceFingerprint: "f".repeat(64),
            updatedAt: "2026-08-01T11:00:00.000Z",
          },
        }],
        observations: [
          observation("observation_1", "user_1", "assistant_1", "conversation_1", "no support?"),
          observation("observation_2", "user_2", "assistant_2", "conversation_2", "reduced support?"),
        ],
        documents: [{
          topicId: "topic_1",
          id: "document_1",
          title: "Existing guide",
          updatedAt: "2026-07-01T00:00:00.000Z",
          possibleRelevance: 0.9,
          existedBeforeGap: true,
          retrievedByGapAnswers: false,
          citedByGapAnswers: false,
          changedAfterGap: false,
        }],
      })),
      getTopicRedirectChain: vi.fn(async () => []),
      pageTopicAssistantMessageIds: vi.fn(async () => ({ assistantMessageIds: [], total: 0 })),
    };
    const planningSource = new ContentPlanReportEnrichmentPlanningSource({
      source: planningDataSource(readSource),
      qualityEvidence: {
        getEvidenceByAssistantMessageIds: vi.fn(async () => new Map([
          ["assistant_1", evidence("assistant_1", "conversation_1", "no_support")],
          ["assistant_2", evidence("assistant_2", "conversation_2", "degraded")],
        ])),
      },
    });
    const { topics } = await planningSource.load({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      asOf: new Date("2026-08-02T12:00:00.000Z"),
      dirtyTopicIds: ["topic_1"],
      repair: null,
    });

    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({
      topicId: "topic_1",
      topicRevision: 4,
      current: {
        memberCount: 2,
        groundedCount: 0,
        degradedCount: 1,
        noSupportCount: 1,
        notEvaluatedCount: 0,
        credibleOpportunity: true,
        groundingBand: "low",
        action: "investigate_retrieval",
      },
      lastEnriched: {
        memberCount: 1,
        credibleOpportunity: false,
        groundingBand: "low",
        action: "add_content",
        corpusEvidenceFingerprint: "f".repeat(64),
        analysisMode: "label_and_brief",
        recommendationState: "ready",
      },
    });
    expect(topics[0]?.current.corpusEvidenceFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const queue = vi.fn(async () => true);
    const runner = new ContentPlanningEnrichmentPlanningService({
      source: planningSource,
      scheduler: new ContentPlanningEnrichmentScheduler({
        queue,
        rebasePublished: vi.fn(async () => true),
      }),
      trigger: {
        listDirtyTopics: vi.fn(async () => [{
          topicId: "topic_1",
          revision: 4,
          dirtyAt: new Date("2026-08-02T11:59:00.000Z"),
        }]),
        acknowledgeDirtyTopics: vi.fn(async () => 1),
      },
      clock: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    await expect(runner.runOnce({ workspaceId: "workspace_1", generationId: "generation_1" }))
      .resolves.toMatchObject({ queuedCount: 1, staleCount: 0, failedCount: 0 });
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({
      topicId: "topic_1",
      sourceEvidence: expect.objectContaining({ memberCount: 2, credibleOpportunity: true }),
      evidenceStrength: "low",
    }));
  });

  it("uses linked passing Eval verification to remove a worker-planned opportunity", async () => {
    const assistantMessageIds = ["assistant_1", "assistant_2"];
    const lookupVerifications = vi.fn(async (_workspaceId: string, ids: string[]) => new Map(
      ids.map((assistantMessageId) => [assistantMessageId, {
        caseId: `case_${assistantMessageId}`,
        caseStatus: "passing" as const,
        latestRunStatus: "pass" as const,
        latestRunAt: "2026-08-02T10:00:00.000Z",
      }]),
    ));
    const executeQuery = vi.fn(async () => ({
      rows: assistantMessageIds.map((assistantMessageId, index) => ({
        assistant_message_id: assistantMessageId,
        conversation_id: `conversation_${index + 1}`,
        agent_id: "agent_1",
        source_channel: "web",
        created_at: `2026-07-2${index}T10:00:00.000Z`,
        grounding_verdict: "no_support",
        grounding_claim_count: 1,
        grounding_sourced_claim_count: 0,
        grounding_unsourced_claim_count: 1,
        grounding_invalid_source_count: 0,
        triage_state: "open",
        triage_resolution_reason: null,
        triage_reopened_by_feedback: false,
      })),
    }));
    const qualityEvidence = new QualityContentPlanningEvidenceSource(
      { executeQuery } as never,
      new EvalQualityVerificationSource({ lookupVerifications }),
    );
    const readSource: ContentPlanReadSourcePort = {
      getProjection: vi.fn(async () => null),
      getReportData: vi.fn(async () => ({
        topics: [{
          id: "topic_1",
          lifecycle: "mature" as const,
          representativeObservationIds: ["observation_1", "observation_2"],
          revision: 1,
          mergedIntoTopicId: null,
          redirectExpiresAt: null,
          updatedAt: "2026-08-02T11:00:00.000Z",
          enrichment: {
            state: "pending" as const,
            sourceTopicRevision: null,
            label: "Deployments",
            description: null,
            suggestedTitle: null,
            rationale: null,
            questionsToAnswer: null,
            suggestedShape: null,
            evidenceStatement: null,
            persistedAction: null,
            actionRuleVersion: 1,
            corpusState: "ready" as const,
            publishedSourceEvidence: null,
            publishedSourceEvidenceStrength: null,
            publishedSourceCorpusEvidenceFingerprint: null,
            updatedAt: null,
          },
        }],
        observations: [
          observation("observation_1", "user_1", "assistant_1", "conversation_1", "no support?"),
          observation("observation_2", "user_2", "assistant_2", "conversation_2", "still no support?"),
        ],
        documents: [],
      })),
      getTopicRedirectChain: vi.fn(async () => []),
      pageTopicAssistantMessageIds: vi.fn(async () => ({ assistantMessageIds: [], total: 0 })),
    };

    const { topics } = await new ContentPlanReportEnrichmentPlanningSource({
      source: planningDataSource(readSource),
      qualityEvidence,
    }).load({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      asOf: new Date("2026-08-02T12:00:00.000Z"),
      dirtyTopicIds: ["topic_1"],
      repair: null,
    });

    expect(lookupVerifications).toHaveBeenCalledWith("workspace_1", assistantMessageIds);
    expect(topics[0]?.current).toMatchObject({
      memberCount: 2,
      noSupportCount: 2,
      credibleOpportunity: false,
      action: "monitor",
    });
  });

  it("recovers a published outside-cap mode and schedules a rank-only promotion", async () => {
    const corpusFingerprint = contentPlanCorpusEvidenceFingerprint({ state: "ready", documents: [] });
    const readSource: ContentPlanReadSourcePort = {
      getProjection: vi.fn(async () => null),
      getReportData: vi.fn(async () => ({
        topics: [{
          id: "topic_1",
          lifecycle: "mature" as const,
          representativeObservationIds: ["observation_1", "observation_2"],
          revision: 4,
          mergedIntoTopicId: null,
          redirectExpiresAt: null,
          updatedAt: "2026-08-02T11:00:00.000Z",
          enrichment: {
            state: "outside_analysis_cap" as const,
            sourceTopicRevision: 4,
            label: "Deployments",
            description: "Deployment questions.",
            suggestedTitle: null,
            rationale: null,
            questionsToAnswer: null,
            suggestedShape: null,
            evidenceStatement: null,
            persistedAction: "add_content" as const,
            actionRuleVersion: 1,
            corpusState: "ready" as const,
            publishedSourceEvidence: {
              memberCount: 2,
              groundedCount: 0,
              degradedCount: 0,
              noSupportCount: 2,
              notEvaluatedCount: 0,
              credibleOpportunity: true,
            },
            publishedSourceEvidenceStrength: "low" as const,
            publishedSourceCorpusEvidenceFingerprint: corpusFingerprint,
            updatedAt: "2026-08-02T11:00:00.000Z",
          },
        }],
        observations: [
          observation("observation_1", "user_1", "assistant_1", "conversation_1", "no support?"),
          observation("observation_2", "user_2", "assistant_2", "conversation_2", "still no support?"),
        ],
        documents: [],
      })),
      getTopicRedirectChain: vi.fn(async () => []),
      pageTopicAssistantMessageIds: vi.fn(async () => ({ assistantMessageIds: [], total: 0 })),
    };
    const planningSource = new ContentPlanReportEnrichmentPlanningSource({
      source: planningDataSource(readSource),
      qualityEvidence: {
        getEvidenceByAssistantMessageIds: vi.fn(async () => new Map([
          ["assistant_1", evidence("assistant_1", "conversation_1", "no_support")],
          ["assistant_2", evidence("assistant_2", "conversation_2", "no_support")],
        ])),
      },
    });
    const { topics } = await planningSource.load({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      asOf: new Date("2026-08-02T12:00:00.000Z"),
      dirtyTopicIds: ["topic_1"],
      repair: null,
    });

    expect(topics[0]).toMatchObject({
      current: {
        memberCount: 2,
        credibleOpportunity: true,
        action: "add_content",
        corpusEvidenceFingerprint: corpusFingerprint,
      },
      lastEnriched: {
        memberCount: 2,
        credibleOpportunity: true,
        action: "add_content",
        corpusEvidenceFingerprint: corpusFingerprint,
        analysisMode: "label_only",
        recommendationState: "outside_analysis_cap",
      },
    });

    const queue = vi.fn(async () => true);
    const result = await new ContentPlanningEnrichmentPlanningService({
      source: planningSource,
      scheduler: new ContentPlanningEnrichmentScheduler({
        queue,
        rebasePublished: vi.fn(async () => true),
      }),
      trigger: {
        listDirtyTopics: vi.fn(async () => [{
          topicId: "topic_1",
          revision: 4,
          dirtyAt: new Date("2026-08-02T11:59:00.000Z"),
        }]),
        acknowledgeDirtyTopics: vi.fn(async () => 1),
      },
      clock: () => new Date("2026-08-02T12:00:00.000Z"),
    }).runOnce({ workspaceId: "workspace_1", generationId: "generation_1" });

    expect(result.kind).toBe("planned");
    if (result.kind !== "planned") throw new Error("expected enrichment planning to run");
    expect(result.jobs).toEqual([
      expect.objectContaining({
        topicId: "topic_1",
        analysisMode: "label_and_brief",
        recommendationState: "ready",
      }),
    ]);
  });
});

const observation = (
  id: string,
  sourceUserMessageId: string,
  sourceAssistantMessageId: string,
  conversationId: string,
  question: string,
) => ({
  id,
  sourceUserMessageId,
  sourceAssistantMessageId,
  conversationId,
  observationState: "ready" as const,
  observedAt: "2026-07-20T10:00:00.000Z",
  question,
  agentName: "Support",
  topicId: "topic_1",
  topicLifecycle: "mature" as const,
  vectorState: "assigned",
});

const evidence = (
  assistantMessageId: string,
  conversationId: string,
  verdict: "degraded" | "no_support",
): QualityContentPlanningTurnEvidence => ({
  assistantMessageId,
  conversationId,
  agentId: "agent_1",
  channel: "web",
  createdAt: "2026-07-20T10:00:00.000Z",
  grounding: {
    verdict,
    claimCount: 1,
    sourcedClaimCount: 0,
    unsourcedClaimCount: 1,
    invalidSourceCount: 0,
  },
  triage: { state: "open", resolutionReason: null, reopenedByNewerNegativeFeedback: false },
  verification: null,
  remediation: { active: true, inactiveReasons: [] },
});

const readTopic = (): ContentPlanReadTopic => ({
  id: "topic_1",
  lifecycle: "mature",
  representativeObservationIds: [],
  revision: 1,
  mergedIntoTopicId: null,
  redirectExpiresAt: null,
  updatedAt: "2026-08-02T11:00:00.000Z",
  enrichment: {
    state: "pending",
    sourceTopicRevision: null,
    label: null,
    description: null,
    suggestedTitle: null,
    rationale: null,
    questionsToAnswer: null,
    suggestedShape: null,
    evidenceStatement: null,
    persistedAction: null,
    actionRuleVersion: 1,
    corpusState: "ready",
    publishedSourceEvidence: null,
    publishedSourceEvidenceStrength: null,
    publishedSourceCorpusEvidenceFingerprint: null,
    updatedAt: null,
  },
});

const planningDataSource = (source: ContentPlanReadSourcePort) => {
  let observations: ReturnType<typeof observation>[] = [];
  return {
    loadData: vi.fn(async (input: {
      workspaceId: string;
      generationId: string;
      window: { from: string; to: string };
    }) => {
      const data = await source.getReportData(input.workspaceId, input.generationId, input.window);
      observations = data.observations as ReturnType<typeof observation>[];
      return {
        topics: data.topics,
        documents: data.documents,
        repairCheckpoint: null,
      };
    }),
    pageObservations: vi.fn(async (input: { cursor: unknown }) => ({
      items: input.cursor === null
        ? observations.map((item) => ({
            id: item.id,
            sourceUserMessageId: item.sourceUserMessageId,
            sourceAssistantMessageId: item.sourceAssistantMessageId,
            conversationId: item.conversationId,
            observedAt: item.observedAt,
            topicId: item.topicId,
          }))
        : [],
      nextCursor: null,
    })),
    completeRepairPage: vi.fn(async () => true),
  };
};
