import { describe, expect, it, vi } from "vitest";

import {
  CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1,
  ContentPlanningEnrichmentScheduler,
  isContentPlanEnrichmentMaterialChange,
  resolveContentPlanEnrichmentRetry,
  type ContentPlanEnrichmentSchedulingTopic,
} from "../../src/modules/contentPlanning/services/enrichmentScheduler.js";
import {
  ContentPlanningEnrichmentProcessor,
  type ContentPlanEnrichmentClaim,
} from "../../src/modules/contentPlanning/services/enrichmentProcessor.js";

const topic = (
  index: number,
  overrides: Partial<ContentPlanEnrichmentSchedulingTopic> = {},
): ContentPlanEnrichmentSchedulingTopic => ({
  workspaceId: "workspace_1",
  generationId: "generation_1",
  topicId: `topic_${String(index).padStart(2, "0")}`,
  topicRevision: 3,
  lifecycle: "mature",
  current: {
    memberCount: 10,
    groundedCount: 2,
    degradedCount: 3,
    noSupportCount: 4,
    notEvaluatedCount: 1,
    credibleOpportunity: true,
    groundingBand: "medium",
    action: "add_content",
    corpusEvidenceFingerprint: "corpus_v2",
  },
  lastEnriched: {
    sourceTopicRevision: 3,
    ...{
      memberCount: 4,
      groundedCount: 1,
      degradedCount: 1,
      noSupportCount: 2,
      notEvaluatedCount: 0,
      credibleOpportunity: true,
    },
    groundingBand: "low",
    action: "monitor",
    corpusEvidenceFingerprint: "corpus_v1",
    analysisMode: "label_and_brief",
    recommendationState: "ready",
  },
  ...overrides,
});

describe("Content Planning enrichment scheduling", () => {
  it("dirties only first maturity or material evidence changes", () => {
    expect(isContentPlanEnrichmentMaterialChange(topic(1, { lastEnriched: null }))).toBe(true);
    expect(isContentPlanEnrichmentMaterialChange(topic(1, {
      current: { ...topic(1).current, memberCount: 9 },
      lastEnriched: { ...publishedSnapshot(1, "label_and_brief", "ready"), memberCount: 4 },
    }))).toBe(true);
    expect(isContentPlanEnrichmentMaterialChange(topic(1, {
      current: { ...topic(1).current, memberCount: 8 },
      lastEnriched: { ...publishedSnapshot(1, "label_and_brief", "ready"), memberCount: 4 },
    }))).toBe(false);
    expect(isContentPlanEnrichmentMaterialChange(topic(1, {
      current: { ...topic(1).current, groundingBand: "high" },
      lastEnriched: publishedSnapshot(1, "label_and_brief", "ready"),
    }))).toBe(true);
    expect(isContentPlanEnrichmentMaterialChange(topic(1, {
      current: { ...topic(1).current, action: "review_existing_content" },
      lastEnriched: publishedSnapshot(1, "label_and_brief", "ready"),
    }))).toBe(true);
    expect(isContentPlanEnrichmentMaterialChange(topic(1, {
      current: { ...topic(1).current, corpusEvidenceFingerprint: "corpus_v3" },
      lastEnriched: publishedSnapshot(1, "label_and_brief", "ready"),
    }))).toBe(true);
    expect(isContentPlanEnrichmentMaterialChange(topic(1, {
      current: topic(1).current,
      lastEnriched: publishedSnapshot(1, "label_and_brief", "ready"),
    }))).toBe(false);
    expect(isContentPlanEnrichmentMaterialChange(topic(1, { lifecycle: "provisional" }))).toBe(false);
  });

  it("debounces every material label job and caps generated briefs to the top ten credible topics", async () => {
    const queue = vi.fn(async () => true);
    const scheduler = new ContentPlanningEnrichmentScheduler({
      queue,
      rebasePublished: vi.fn(async () => true),
    });
    const now = new Date("2026-08-02T12:00:00.000Z");
    const topics = [
      ...Array.from({ length: 12 }, (_, index) => topic(index + 1)),
      topic(13, {
        current: { ...topic(13).current, credibleOpportunity: false },
      }),
    ];

    const result = await scheduler.schedule({ topics, now });

    expect(result.queuedCount).toBe(13);
    expect(result.staleCount).toBe(0);
    expect(result.jobs.filter((job) => job.analysisMode === "label_and_brief")).toHaveLength(10);
    expect(result.jobs.slice(10, 12)).toEqual(expect.arrayContaining([
      expect.objectContaining({ analysisMode: "label_only", recommendationState: "outside_analysis_cap" }),
    ]));
    expect(result.jobs[12]).toMatchObject({
      analysisMode: "label_only",
      recommendationState: "ready",
    });
    expect(queue).toHaveBeenCalledTimes(13);
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({
      availableAt: new Date("2026-08-02T12:05:00.000Z"),
      evidenceStrength: "medium",
      sourceCorpusEvidenceFingerprint: "corpus_v2",
      sourceEvidence: {
        memberCount: 10,
        groundedCount: 2,
        degradedCount: 3,
        noSupportCount: 4,
        notEvaluatedCount: 1,
        credibleOpportunity: true,
      },
    }));
  });

  it("schedules both sides of a top-ten rank transition without an evidence change", async () => {
    const queue = vi.fn(async () => true);
    const scheduler = new ContentPlanningEnrichmentScheduler({
      queue,
      rebasePublished: vi.fn(async () => true),
    });
    const unchangedInCap = Array.from({ length: 9 }, (_, index) => topic(index + 1, {
      lastEnriched: publishedSnapshot(index + 1, "label_and_brief", "ready"),
    }));
    const enteringCap = topic(11, {
      lastEnriched: publishedSnapshot(11, "label_only", "outside_analysis_cap"),
    });
    const leavingCap = topic(10, {
      lastEnriched: publishedSnapshot(10, "label_and_brief", "ready"),
    });

    const result = await scheduler.schedule({
      topics: [...unchangedInCap, enteringCap, leavingCap],
      now: new Date("2026-08-02T12:00:00.000Z"),
    });

    expect(result.jobs).toEqual([
      expect.objectContaining({
        topicId: "topic_11",
        analysisMode: "label_and_brief",
        recommendationState: "ready",
      }),
      expect.objectContaining({
        topicId: "topic_10",
        analysisMode: "label_only",
        recommendationState: "outside_analysis_cap",
      }),
    ]);
    expect(queue).toHaveBeenCalledTimes(2);
  });

  it("schedules removal of a generated brief when an opportunity ceases to be credible", async () => {
    const queue = vi.fn(async () => true);
    const scheduler = new ContentPlanningEnrichmentScheduler({
      queue,
      rebasePublished: vi.fn(async () => true),
    });
    const candidate = topic(1, {
      current: { ...topic(1).current, credibleOpportunity: false },
      lastEnriched: publishedSnapshot(1, "label_and_brief", "ready"),
    });

    const result = await scheduler.schedule({
      topics: [candidate],
      now: new Date("2026-08-02T12:00:00.000Z"),
    });

    expect(result.jobs).toEqual([
      expect.objectContaining({
        topicId: "topic_01",
        analysisMode: "label_only",
        recommendationState: "ready",
      }),
    ]);
    expect(queue).toHaveBeenCalledOnce();
  });

  it("rebases a published enrichment to a non-material topic revision without provider work", async () => {
    const queue = vi.fn(async () => true);
    const rebasePublished = vi.fn(async () => true);
    const scheduler = new ContentPlanningEnrichmentScheduler({ queue, rebasePublished });
    const candidate = topic(1, {
      topicRevision: 4,
      current: { ...topic(1).current, memberCount: 5 },
      lastEnriched: {
        ...publishedSnapshot(1, "label_and_brief", "ready"),
        sourceTopicRevision: 3,
        memberCount: 4,
      },
    });

    const result = await scheduler.schedule({
      topics: [candidate],
      now: new Date("2026-08-02T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ queuedCount: 0, rebasedCount: 1, failedCount: 0 });
    expect(queue).not.toHaveBeenCalled();
    expect(rebasePublished).toHaveBeenCalledWith(expect.objectContaining({
      topicId: "topic_01",
      sourceTopicRevision: 4,
      sourceEvidence: expect.objectContaining({ memberCount: 5 }),
      evidenceStrength: "medium",
      analysisMode: "label_and_brief",
      recommendationState: "ready",
    }));
  });

  it("continues a batch when a newer revision rejects one queue request", async () => {
    const queue = vi.fn(async (input: { topicId: string }) => input.topicId !== "topic_02");
    const scheduler = new ContentPlanningEnrichmentScheduler({
      queue,
      rebasePublished: vi.fn(async () => true),
    });

    const result = await scheduler.schedule({
      topics: [topic(1), topic(2), topic(3)],
      now: new Date("2026-08-02T12:00:00.000Z"),
    });

    expect(result.queuedCount).toBe(2);
    expect(result.staleCount).toBe(1);
    expect(queue).toHaveBeenCalledTimes(3);
  });

  it("uses bounded exponential retries and terminates after the fifth claim", () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    expect(resolveContentPlanEnrichmentRetry({ attemptCount: 1, now })).toEqual({
      terminal: false,
      availableAt: new Date("2026-08-02T12:01:00.000Z"),
    });
    expect(resolveContentPlanEnrichmentRetry({ attemptCount: 4, now })).toEqual({
      terminal: false,
      availableAt: new Date("2026-08-02T12:08:00.000Z"),
    });
    expect(resolveContentPlanEnrichmentRetry({ attemptCount: 5, now })).toEqual({
      terminal: true,
      availableAt: now,
    });
    expect(CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1).toMatchObject({
      debounceMs: 300_000,
      generatedBriefCap: 10,
      maxAttempts: 5,
    });
  });

  it("publishes a label and brief only for an in-cap opportunity", async () => {
    const claim = enrichmentClaim();
    const generateLabel = vi.fn(async () => ({
      state: "ready" as const,
      label: "Deployment controls",
      description: "Questions about configuring deployments.",
    }));
    const generateBrief = vi.fn(async () => ({
      state: "ready" as const,
      rationale: "Repeated unsupported deployment questions.",
      suggestedTitle: "Deployment controls guide",
      questionsToAnswer: ["Where are controls?", "Who can edit?", "When do changes apply?"],
      suggestedShape: "guide" as const,
      evidenceStatement: "Based on six conversations.",
      factsMustBeVerified: true as const,
    }));
    const publish = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const record = vi.fn();
    const processor = new ContentPlanningEnrichmentProcessor({
      generator: { generateLabel, generateBrief },
      context: {
        load: vi.fn(async () => ({
          analysisMode: "label_and_brief" as const,
          recommendationState: "ready" as const,
          samples: [{ observationId: "observation_1", question: "How do deployments work?" }],
          action: "add_content" as const,
          corpusState: "ready" as const,
          corpusCheckedAt: new Date("2026-08-02T11:59:00.000Z"),
          sourceEvidence: {
            memberCount: 8,
            groundedCount: 1,
            degradedCount: 2,
            noSupportCount: 5,
            notEvaluatedCount: 0,
            credibleOpportunity: true,
          },
          evidenceStrength: "medium" as const,
          corpusEvidenceFingerprint: "corpus-ready-v2",
        })),
      },
      store: { publish, fail },
      observability: { record },
      clock: () => new Date("2026-08-02T12:00:00.000Z"),
    });

    await expect(processor.process(claim)).resolves.toEqual({ status: "published" });
    expect(generateLabel).toHaveBeenCalledOnce();
    expect(generateBrief).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      publishState: "ready",
      action: "add_content",
      suggestedTitle: "Deployment controls guide",
      sourceEvidence: expect.objectContaining({ memberCount: 8 }),
      evidenceStrength: "medium",
      corpusEvidenceFingerprint: "corpus-ready-v2",
    }));
    expect(fail).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "enrichment",
      outcome: "completed",
      workspaceId: claim.workspaceId,
      generationId: claim.generationId,
      topicId: claim.topicId,
      providerOperation: "topic_label",
      providerCallCount: 1,
    }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "enrichment",
      outcome: "completed",
      providerOperation: "content_brief",
      providerCallCount: 1,
    }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "enrichment",
      outcome: "published",
      topicId: claim.topicId,
      revision: claim.sourceTopicRevision,
    }));
  });

  it("retains a useful label but does not generate a brief outside the analysis cap", async () => {
    const generateBrief = vi.fn();
    const publish = vi.fn(async () => true);
    const processor = new ContentPlanningEnrichmentProcessor({
      generator: {
        generateLabel: vi.fn(async () => ({
          state: "ready" as const,
          label: "API limits",
          description: "Questions about API limits.",
        })),
        generateBrief,
      },
      context: {
        load: vi.fn(async () => ({
          analysisMode: "label_only" as const,
          recommendationState: "outside_analysis_cap" as const,
          samples: [{ observationId: "observation_1", question: "What are the API limits?" }],
          action: null,
          corpusState: "ready" as const,
          corpusCheckedAt: null,
          sourceEvidence: {
            memberCount: 3,
            groundedCount: 0,
            degradedCount: 1,
            noSupportCount: 2,
            notEvaluatedCount: 0,
            credibleOpportunity: true,
          },
          evidenceStrength: "low" as const,
          corpusEvidenceFingerprint: "corpus-ready-v1",
        })),
      },
      store: { publish, fail: vi.fn(async () => true) },
    });

    await expect(processor.process(enrichmentClaim())).resolves.toEqual({ status: "published" });
    expect(generateBrief).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      publishState: "outside_analysis_cap",
      label: "API limits",
      suggestedTitle: null,
      questionsToAnswer: null,
    }));
  });

  it("maps provider failure to a safe bounded retry and rejects stale publication", async () => {
    const fail = vi.fn(async () => true);
    const record = vi.fn();
    const providerFailure = new ContentPlanningEnrichmentProcessor({
      generator: {
        generateLabel: vi.fn(async () => ({ state: "unavailable" as const, reason: "provider_error" as const })),
        generateBrief: vi.fn(),
      },
      context: { load: vi.fn(async () => enrichmentContext()) },
      store: { publish: vi.fn(async () => true), fail },
      observability: { record },
      clock: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    await expect(providerFailure.process(enrichmentClaim())).resolves.toEqual({ status: "retry_scheduled" });
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      terminal: false,
      failureStage: "label_generation",
      failureReason: "provider_error",
      availableAt: new Date("2026-08-02T12:01:00.000Z"),
    }));
    expect(JSON.stringify(fail.mock.calls)).not.toContain("question");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "enrichment",
      outcome: "retry_scheduled",
      reason: "enrichment_provider_error",
      providerOperation: "topic_label",
      providerCallCount: 1,
    }));

    const staleFail = vi.fn();
    const stale = new ContentPlanningEnrichmentProcessor({
      generator: {
        generateLabel: vi.fn(async () => ({
          state: "ready" as const,
          label: "Label",
          description: "Description",
        })),
        generateBrief: vi.fn(async () => ({
          state: "ready" as const,
          rationale: "Rationale",
          suggestedTitle: "Title",
          questionsToAnswer: ["One?", "Two?", "Three?"],
          suggestedShape: "faq" as const,
          evidenceStatement: "Based on evidence.",
          factsMustBeVerified: true as const,
        })),
      },
      context: { load: vi.fn(async () => enrichmentContext()) },
      store: { publish: vi.fn(async () => false), fail: staleFail },
    });
    await expect(stale.process(enrichmentClaim())).resolves.toEqual({ status: "stale" });
    expect(staleFail).not.toHaveBeenCalled();
  });
});

const enrichmentClaim = (): ContentPlanEnrichmentClaim => ({
  workspaceId: "workspace_1",
  generationId: "generation_1",
  topicId: "topic_1",
  sourceTopicRevision: 3,
  attemptCount: 1,
  claimToken: "claim_1",
  analysisMode: "label_and_brief",
  recommendationState: "ready",
  sourceEvidence: {
    memberCount: 3,
    groundedCount: 0,
    degradedCount: 1,
    noSupportCount: 2,
    notEvaluatedCount: 0,
    credibleOpportunity: true,
  },
  evidenceStrength: "medium",
});

const enrichmentContext = () => ({
  analysisMode: "label_and_brief" as const,
  recommendationState: "ready" as const,
  samples: [{ observationId: "observation_1", question: "A bounded question" }],
  action: "add_content" as const,
  corpusState: "ready" as const,
  corpusCheckedAt: null,
  sourceEvidence: {
    memberCount: 3,
    groundedCount: 0,
    degradedCount: 1,
    noSupportCount: 2,
    notEvaluatedCount: 0,
    credibleOpportunity: true,
  },
  evidenceStrength: "medium" as const,
  corpusEvidenceFingerprint: "corpus-ready-v2",
});

const publishedSnapshot = (
  index: number,
  analysisMode: "label_and_brief" | "label_only",
  recommendationState: "ready" | "outside_analysis_cap",
): NonNullable<ContentPlanEnrichmentSchedulingTopic["lastEnriched"]> => ({
  sourceTopicRevision: 3,
  ...topic(index).current,
  analysisMode,
  recommendationState,
} as unknown as NonNullable<ContentPlanEnrichmentSchedulingTopic["lastEnriched"]>);
