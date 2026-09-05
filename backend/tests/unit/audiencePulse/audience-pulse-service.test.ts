import { describe, expect, it } from "vitest";

import { AudiencePulseService, buildSummaryTopics, hydrateReport } from "../../../src/modules/audiencePulse/services/audiencePulseService.js";
import type { AudiencePulseServiceDependencies } from "../../../src/modules/audiencePulse/services/audiencePulseService.js";
import type {
  AudiencePulseHistorySnapshot,
  AudiencePulseSnapshotRecord,
} from "../../../src/modules/audiencePulse/contracts.js";
import type { AudiencePulseStoredReport } from "../../../src/modules/audiencePulse/domain/report.js";
import type { CensusRunResult, CensusService } from "../../../src/modules/audiencePulse/services/censusService.js";
import type { CensusServiceFactory } from "../../../src/modules/audiencePulse/infra/censusServiceFactory.js";
import { AUDIENCE_PULSE_SUMMARY_MAX_TOPICS } from "../../../src/modules/audiencePulse/services/prompt.js";

const ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";
const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";

const history = (): AudiencePulseHistorySnapshot => ({
  period: { start: new Date("2026-07-01T00:00:00.000Z"), end: new Date("2026-07-31T00:00:00.000Z") },
  coverage: { populationSize: 2, sampleSize: 2, sampled: false },
  weeklyVolume: [{ weekStart: "2026-06-29T00:00:00.000Z", visitorQuestionCount: 2, conversationCount: 2 }],
  evidence: [
    {
      id: "evidence-1",
      reference: { messageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
      question: "How do I change a plan?",
      weekStart: "2026-06-29T00:00:00.000Z",
      channel: null,
      grounding: "no_support",
      contentGapEligible: true,
    },
    {
      id: "evidence-2",
      reference: { messageId: "cccccccc-cccc-cccc-cccc-cccccccccccc", conversationId: "dddddddd-dddd-dddd-dddd-dddddddddddd" },
      question: "Can I update a subscription?",
      weekStart: "2026-06-29T00:00:00.000Z",
      channel: null,
      grounding: "no_support",
      contentGapEligible: true,
    },
  ],
});

/** Census result matching `history()`: one topic claiming both evidence items, nothing unclassified. */
const censusResult = (): CensusRunResult => ({
  runId: "run-1",
  populationSize: 2,
  unclassifiedCount: 0,
  facetReadyQuestionCount: 2,
  topics: [{
    topicId: "topic-1",
    title: "Subscription changes",
    description: "Repeated questions about changing a plan.",
    memberIds: ["evidence-1", "evidence-2"],
    memberCount: 2,
    share: 1,
  }],
});

const recommendationCopy = (themeIndex: number) => ({
  title: `Document topic ${themeIndex + 1}`,
  rationale: `Questions about topic ${themeIndex + 1} recur across visitor conversations.`,
  questions: [`How does topic ${themeIndex + 1} work?`],
});

const modelResponse = JSON.stringify({
  summary: "Visitors ask about subscription changes.",
  themes: [],
  recommendations: { "0": recommendationCopy(0) },
  caveats: [],
});

const createService = (overrides: Partial<AudiencePulseServiceDependencies> = {}) => {
  const calls = {
    inference: 0,
    reserve: 0,
    commit: 0,
    release: 0,
    leaseRelease: 0,
    rate: 0,
    replace: 0,
    invalidate: 0,
    censusRun: 0,
    facetDrain: 0,
    facetDrainInputs: [] as Array<{ workspaceId: string; analysisStart: Date; analysisEnd: Date }>,
    censusWindows: [] as Array<{ windowStart: Date; windowEnd: Date }>,
    lifecycle: [] as string[],
    auditEvents: [] as Array<{ eventType: string; eventStatus: string; metadata?: Record<string, unknown> }>,
  };
  const dependencies: AudiencePulseServiceDependencies = {
    historySource: {
      async read() { return history(); },
      async listEligibleQuestionIds() { return []; },
      async rehydrate(input) {
        return new Map(input.references.map((reference) => [reference.evidenceId, {
          evidenceId: reference.evidenceId,
          conversationId: reference.conversationId,
          messageId: reference.messageId,
          question: "Rehydrated question",
        }]));
      },
      async readEvidenceAnchor() { return null; },
    },
    snapshotStore: {
      async find() { return null; },
      async replace(input) {
        calls.replace += 1;
        calls.lifecycle.push("snapshot");
        return { ...input, revision: "revision-1" };
      },
      async invalidate() { calls.invalidate += 1; return true; },
    },
    runGate: {
      async tryAcquire() {
        return { async release() { calls.leaseRelease += 1; } };
      },
    },
    refreshRateLimit: {
      async enforce() { calls.rate += 1; },
    },
    facetDrain: {
      async requestWorkspaceDrain(input) {
        calls.facetDrain += 1;
        calls.facetDrainInputs.push(input);
        calls.lifecycle.push("facet-drain");
        return false;
      },
      async hasPendingWorkspaceWork() { return false; },
    },
    inferenceFactory: {
      async create() {
        return {
          metadata: { capability: "chat", provider: "openai", model: "test" },
          async complete() { calls.inference += 1; return { text: modelResponse }; },
          stream() { throw new Error("not used"); },
        };
      },
    },
    censusServiceFactory: {
      // `CensusService` is a class with private state a test double cannot satisfy
      // structurally; this fake only ever needs to honor `run()`, the one method
      // `refresh()` calls, so it stands in for the whole class through `unknown`.
      create: () => ({
        run: async (input: { workspaceId: string; windowStart: Date; windowEnd: Date; signal?: AbortSignal }) => {
          calls.censusRun += 1;
          calls.lifecycle.push("census");
          calls.censusWindows.push({ windowStart: input.windowStart, windowEnd: input.windowEnd });
          return censusResult();
        },
      } as unknown as CensusService),
    } satisfies CensusServiceFactory,
    usageLimitPolicy: {
      async reserveAnswer() {
        calls.reserve += 1;
        calls.lifecycle.push("reserve");
        return {
          async commit() {
            calls.commit += 1;
            calls.lifecycle.push("commit");
          },
          async release() { calls.release += 1; },
        };
      },
      async reserveDocument() { throw new Error("not used"); },
      async reserveIndexedStorage() { throw new Error("not used"); },
      async reserveMonthlyIndexedContent() { throw new Error("not used"); },
    },
    auditService: {
      async record(input) {
        calls.auditEvents.push(input);
      },
    },
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
  const service = new AudiencePulseService({ ...dependencies, ...overrides });
  return { service, calls };
};

describe("AudiencePulseService", () => {
  it("weights shown exemplars toward eligible questions from distinct conversations", () => {
    const evidenceById = new Map([
      ["evidence-1", { ...history().evidence[0], id: "evidence-1", reference: { messageId: "message-1", conversationId: "conversation-1" }, contentGapEligible: true }],
      ["evidence-2", { ...history().evidence[1], id: "evidence-2", contentGapEligible: false }],
      ["evidence-3", { ...history().evidence[0], id: "evidence-3", reference: { messageId: "message-3", conversationId: "conversation-1" }, contentGapEligible: true }],
      ["evidence-4", { ...history().evidence[0], id: "evidence-4", reference: { messageId: "message-4", conversationId: "conversation-2" }, contentGapEligible: true }],
      ["evidence-5", { ...history().evidence[0], id: "evidence-5", reference: { messageId: "message-5", conversationId: "conversation-3" }, contentGapEligible: true }],
      ["evidence-6", { ...history().evidence[1], id: "evidence-6", reference: { messageId: "message-6", conversationId: "conversation-4" }, contentGapEligible: false }],
    ]);

    const { shown } = buildSummaryTopics({
      topics: [{
        topicId: "topic-1",
        title: "Topic",
        description: "Description",
        memberIds: ["evidence-1", "evidence-2", "evidence-3", "evidence-4", "evidence-5", "evidence-6"],
        memberCount: 6,
        share: 1,
      }],
      evidenceById,
    });

    expect(shown[0]?.exemplars.map((item) => item.id)).toEqual([
      "evidence-1", "evidence-4", "evidence-5", "evidence-2", "evidence-3", "evidence-6",
    ]);
    expect(shown[0]?.contentGapQualifies).toBe(true);
  });

  it("presents repeated normalized question text once with its occurrence count", () => {
    const report: AudiencePulseStoredReport = {
      period: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-31T00:00:00.000Z" },
      generatedAt: "2026-08-01T00:00:00.000Z",
      coverage: { populationSize: 3, sampleSize: 3, sampled: false, facetReadyQuestionCount: 3 },
      weeklyVolume: [],
      summary: "Summary",
      unclassifiedQuestionCount: 1,
      themes: [{
        id: "theme-1",
        title: "Plans",
        description: "Visitors ask about plans.",
        evidenceIds: ["evidence-1", "evidence-2"],
        memberCount: 2,
        share: 2 / 3,
        weeklyPulse: [],
        grounding: { grounded: 0, degraded: 0, noSupport: 2, unknown: 0, contentGapEligible: 2 },
      }],
      contentGaps: [{ themeId: "theme-1", eligibleEvidenceCount: 2, distinctConversationCount: 2 }],
      recommendations: [],
      caveats: [],
    };

    const hydrated = hydrateReport(report, new Map([
      ["evidence-1", {
        evidenceId: "evidence-1",
        conversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        messageId: "11111111-1111-1111-1111-111111111111",
        question: "How do I change my plan?",
      }],
      ["evidence-2", {
        evidenceId: "evidence-2",
        conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        messageId: "22222222-2222-2222-2222-222222222222",
        question: "  how do I change   my plan?  ",
      }],
      ["evidence-3", {
        evidenceId: "evidence-3",
        conversationId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        messageId: "33333333-3333-3333-3333-333333333333",
        question: "What does the annual plan include?",
      }],
    ]));

    expect(hydrated).toMatchObject({
      unclassifiedQuestionCount: 1,
      themes: [{
        memberCount: 2,
        share: 2 / 3,
        distinctQuestionCount: 1,
        evidence: [{
          question: "How do I change my plan?",
          occurrenceCount: 2,
        }],
      }],
    });
  });

  it("normalizes legacy saved reports that predate census coverage fields", () => {
    const legacyReport = {
      period: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-31T00:00:00.000Z" },
      generatedAt: "2026-08-01T00:00:00.000Z",
      coverage: { populationSize: 3, sampleSize: 3, sampled: false },
      weeklyVolume: [],
      summary: "Legacy summary",
      themes: [{
        id: "theme-1",
        title: "Plans",
        description: "Visitors ask about plans.",
        evidenceIds: ["evidence-1", "evidence-2"],
        sampleCount: 2,
        weeklyPulse: [],
        grounding: { grounded: 0, degraded: 0, noSupport: 2, unknown: 0, contentGapEligible: 2 },
      }],
      contentGaps: [],
      recommendations: [],
      caveats: [],
    } as unknown as AudiencePulseStoredReport;

    const hydrated = hydrateReport(legacyReport, new Map([
      ["evidence-1", {
        evidenceId: "evidence-1",
        conversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        messageId: "11111111-1111-1111-1111-111111111111",
        question: "How do I change my plan?",
      }],
      ["evidence-2", {
        evidenceId: "evidence-2",
        conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        messageId: "22222222-2222-2222-2222-222222222222",
        question: "Can I upgrade?",
      }],
      ["evidence-3", {
        evidenceId: "evidence-3",
        conversationId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        messageId: "33333333-3333-3333-3333-333333333333",
        question: "What does annual include?",
      }],
    ]));

    expect(hydrated.coverage.facetReadyQuestionCount).toBe(3);
    expect(hydrated.unclassifiedQuestionCount).toBe(1);
    expect(hydrated.themes[0]).toMatchObject({ memberCount: 2, share: 2 / 3 });
  });

  it("delegates an evidence anchor to the Chat-owned history port without report or provider work", async () => {
    const anchor = {
      conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      source: {
        messageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        role: "user" as const,
        source: "customer" as const,
        content: "How do I change a plan?",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      nextAssistant: null,
    };
    const historyCalls: Array<{ workspaceId: string; conversationId: string; messageId: string }> = [];
    const { service, calls } = createService({
      historySource: {
        async read() { return history(); },
        async listEligibleQuestionIds() { return []; },
        async rehydrate() { return new Map(); },
        async readEvidenceAnchor(input) {
          historyCalls.push(input);
          return anchor;
        },
      },
    });

    await expect(service.readEvidenceAnchor({
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      conversationId: anchor.conversationId,
      messageId: anchor.source.messageId,
    })).resolves.toEqual(anchor);

    expect(historyCalls).toEqual([{
      workspaceId: WORKSPACE_ID,
      conversationId: anchor.conversationId,
      messageId: anchor.source.messageId,
    }]);
    expect(calls).toMatchObject({ inference: 0, reserve: 0, replace: 0, leaseRelease: 0 });
  });

  it("does not reserve usage or call a provider for no traffic", async () => {
    const { service, calls } = createService({
      historySource: {
        async read() {
          return { ...history(), coverage: { populationSize: 0, sampleSize: 0, sampled: false }, evidence: [] };
        },
        async listEligibleQuestionIds() { return []; },
        async rehydrate() { return new Map(); },
        async readEvidenceAnchor() { return null; },
      },
    });

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result.kind).toBe("no_traffic");
    expect(calls).toMatchObject({ inference: 0, reserve: 0, commit: 0, release: 0, rate: 1, replace: 0, leaseRelease: 1 });
  });

  it("charges the durable refresh budget only after acquiring a refresh lease", async () => {
    const lifecycle: string[] = [];
    const { service } = createService({
      runGate: {
        async tryAcquire() {
          lifecycle.push("gate");
          return { async release() {} };
        },
      },
      refreshRateLimit: {
        async enforce() { lifecycle.push("rate_limit"); },
      },
      historySource: {
        async read() {
          lifecycle.push("history");
          return history();
        },
        async listEligibleQuestionIds() { return []; },
        async rehydrate() { return new Map(); },
        async readEvidenceAnchor() { return null; },
      },
    });

    await expect(service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ kind: "completed" });

    expect(lifecycle.slice(0, 3)).toEqual(["gate", "rate_limit", "history"]);
  });

  it("releases an acquired lease when the durable refresh budget rejects", async () => {
    const rateLimitError = Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 });
    const { service, calls } = createService({
      refreshRateLimit: {
        async enforce() { throw rateLimitError; },
      },
    });

    await expect(service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .rejects.toBe(rateLimitError);

    expect(calls).toMatchObject({ inference: 0, reserve: 0, rate: 0, leaseRelease: 1 });
    expect(calls.auditEvents.at(-1)).toMatchObject({
      eventType: "audience_pulse.refresh_failed",
      eventStatus: "failure",
      metadata: { outcome: "rate_limited" },
    });
  });

  it("commits usage after a validated model result before saving the report", async () => {
    const { service, calls } = createService();

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result.kind).toBe("completed");
    expect(calls).toMatchObject({ inference: 1, reserve: 1, replace: 1, commit: 1, release: 0, rate: 1, leaseRelease: 1, censusRun: 1, facetDrain: 0 });
    expect(calls.facetDrainInputs).toEqual([]);
    expect(calls.lifecycle).toEqual(["reserve", "census", "commit", "snapshot"]);
  });

  it("maps structurally keyed recommendation copy to every qualifying domain topic", async () => {
    const evidence = Array.from({ length: 6 }, (_unused, index) => ({
      id: `evidence-${index + 1}`,
      reference: { messageId: `message-${index + 1}`, conversationId: `conversation-${index + 1}` },
      question: `Question ${index + 1}`,
      weekStart: "2026-06-29T00:00:00.000Z",
      channel: null,
      grounding: "no_support" as const,
      contentGapEligible: index < 2 || index >= 4,
    }));
    const response = JSON.stringify({
      summary: "Visitors ask about two recurring topics.",
      themes: [],
      recommendations: { "0": recommendationCopy(0), "2": recommendationCopy(2) },
      caveats: [],
    });
    const { service } = createService({
      historySource: {
        async read() {
          return {
            ...history(),
            coverage: { populationSize: 6, sampleSize: 6, sampled: false },
            evidence,
          };
        },
        async listEligibleQuestionIds() { return []; },
        async rehydrate() { return new Map(); },
        async readEvidenceAnchor() { return null; },
      },
      censusServiceFactory: {
        create: () => ({
          run: async () => ({
            ...censusResult(),
            populationSize: 6,
            facetReadyQuestionCount: 6,
            topics: [
              { topicId: "topic-1", title: "Topic 1", description: "Description 1", memberIds: ["evidence-1", "evidence-2"], memberCount: 2, share: 1 / 3 },
              { topicId: "topic-2", title: "Topic 2", description: "Description 2", memberIds: ["evidence-3", "evidence-4"], memberCount: 2, share: 1 / 3 },
              { topicId: "topic-3", title: "Topic 3", description: "Description 3", memberIds: ["evidence-5", "evidence-6"], memberCount: 2, share: 1 / 3 },
            ],
          }),
        } as unknown as CensusService),
      } satisfies CensusServiceFactory,
      inferenceFactory: {
        async create() {
          return {
            metadata: { capability: "chat", provider: "openai", model: "test" },
            async complete() { return { text: response }; },
            stream() { throw new Error("not used"); },
          };
        },
      },
    });

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("expected a completed refresh");
    expect(result.report.recommendations.map((recommendation) => recommendation.themeId)).toEqual(["topic-1", "topic-3"]);
  });

  it("does not report recommendation divergence for qualifying topics beyond the narrative cap", async () => {
    const topicCount = AUDIENCE_PULSE_SUMMARY_MAX_TOPICS + 1;
    const evidence = Array.from({ length: topicCount * 2 }, (_unused, index) => ({
      id: `evidence-${index + 1}`,
      reference: { messageId: `message-${index + 1}`, conversationId: `conversation-${index + 1}` },
      question: `Question ${index + 1}`,
      weekStart: "2026-06-29T00:00:00.000Z",
      channel: null,
      grounding: "no_support" as const,
      contentGapEligible: true,
    }));
    const topics = Array.from({ length: topicCount }, (_unused, index) => ({
      topicId: `topic-${index + 1}`,
      title: `Topic ${index + 1}`,
      description: `Description ${index + 1}`,
      memberIds: [`evidence-${index * 2 + 1}`, `evidence-${index * 2 + 2}`],
      memberCount: 2,
      share: 1 / topicCount,
    }));
    const warnings: string[] = [];
    const response = JSON.stringify({
      summary: "Visitors ask about several recurring topics.",
      themes: [],
      recommendations: Object.fromEntries(
        Array.from({ length: AUDIENCE_PULSE_SUMMARY_MAX_TOPICS }, (_unused, index) =>
          [String(index), recommendationCopy(index)]),
      ),
      caveats: [],
    });
    const { service } = createService({
      logger: { warn(_context, message) { warnings.push(message); } },
      historySource: {
        async read() {
          return {
            ...history(),
            coverage: { populationSize: evidence.length, sampleSize: evidence.length, sampled: false },
            evidence,
          };
        },
        async listEligibleQuestionIds() { return []; },
        async rehydrate() { return new Map(); },
        async readEvidenceAnchor() { return null; },
      },
      censusServiceFactory: {
        create: () => ({
          run: async () => ({
            ...censusResult(),
            populationSize: evidence.length,
            facetReadyQuestionCount: evidence.length,
            topics,
          }),
        } as unknown as CensusService),
      } satisfies CensusServiceFactory,
      inferenceFactory: {
        async create() {
          return {
            metadata: { capability: "chat", provider: "openai", model: "test" },
            async complete() { return { text: response }; },
            stream() { throw new Error("not used"); },
          };
        },
      },
    });

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("expected a completed refresh");
    expect(result.report.contentGaps).toHaveLength(topicCount);
    expect(result.report.recommendations).toHaveLength(AUDIENCE_PULSE_SUMMARY_MAX_TOPICS);
    expect(warnings).not.toContain("audience_pulse_recommendation_divergence");
  });

  it("starts durable facet preparation without reserving or publishing a partial report", async () => {
    let requested = 0;
    const { service, calls } = createService({
      facetDrain: {
        async hasPendingWorkspaceWork() { return true; },
        async requestWorkspaceDrain() { requested += 1; return false; },
      },
    });

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result).toEqual({ kind: "preparing" });
    expect(requested).toBe(1);
    expect(calls).toMatchObject({ inference: 0, reserve: 0, replace: 0, censusRun: 0, leaseRelease: 1 });
  });

  it("runs the census over the same fixed window as the history read and builds the report from its real membership", async () => {
    const { service, calls } = createService();

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    if (result.kind !== "completed") throw new Error("expected a completed refresh");
    expect(calls.censusWindows).toEqual([{
      windowStart: new Date("2026-07-02T00:00:00.000Z"),
      windowEnd: new Date("2026-08-01T00:00:00.000Z"),
    }]);
    // The invariant the whole feature exists for (spec 956 FR-005): every eligible
    // question is a member of exactly one topic or unclassified, and the two sum to
    // the population -- with no sampling code path reachable to bias either number.
    const classified = result.report.themes.reduce((sum, theme) => sum + theme.memberCount, 0);
    expect(classified + result.report.unclassifiedQuestionCount).toBe(result.report.coverage.populationSize);
    expect(result.report.coverage).toEqual({ populationSize: 2, sampleSize: 2, sampled: false, facetReadyQuestionCount: 2 });
    expect(result.report.themes).toMatchObject([{
      title: "Subscription changes",
      description: "Repeated questions about changing a plan.",
      memberCount: 2,
      share: 1,
    }]);
  });

  it("rejects a refresh when the census and the history read disagree on the population", async () => {
    const { service, calls } = createService({
      censusServiceFactory: {
        create: () => ({
          run: async () => ({ ...censusResult(), populationSize: 3 }),
        } as unknown as CensusService),
      } satisfies CensusServiceFactory,
    });

    await expect(service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .rejects.toThrow(/census population .* does not match/);
    expect(calls).toMatchObject({ inference: 0, replace: 0, leaseRelease: 1 });
    expect(calls.auditEvents.at(-1)).toMatchObject({
      eventType: "audience_pulse.refresh_failed",
      metadata: { outcome: "internal" },
    });
  });

  it("builds report membership from the census result", async () => {
    const { service } = createService();

    await expect(service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ kind: "completed" });
  });

  it("rejects a refresh when the report's derived unclassified count disagrees with the census", async () => {
    const { service } = createService({
      censusServiceFactory: {
        create: () => ({
          run: async () => ({
            ...censusResult(),
            unclassifiedCount: 1,
          }),
        } as unknown as CensusService),
      } satisfies CensusServiceFactory,
    });

    await expect(service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .rejects.toThrow(/unclassified count .* does not match/);
  });

  it("persists prompt evidence refs only for evidence a topic actually claimed, not the whole population", async () => {
    let savedRefs: Array<{ evidenceId: string }> | undefined;
    const captureDeps = createService({
      historySource: {
        async read() {
          const base = history();
          return {
            ...base,
            coverage: { populationSize: 3, sampleSize: 3, sampled: false },
            evidence: [...base.evidence, {
              id: "evidence-unclassified",
              reference: { messageId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", conversationId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
              question: "An unrelated one-off question",
              weekStart: "2026-06-29T00:00:00.000Z",
              channel: null,
              grounding: "unknown",
              contentGapEligible: false,
            }],
          };
        },
        async listEligibleQuestionIds() { return []; },
        async rehydrate() { return new Map(); },
        async readEvidenceAnchor() { return null; },
      },
      censusServiceFactory: {
        create: () => ({
          run: async () => ({ ...censusResult(), populationSize: 3, unclassifiedCount: 1 }),
        } as unknown as CensusService),
      } satisfies CensusServiceFactory,
      snapshotStore: {
        async find() { return null; },
        async replace(input) {
          savedRefs = input.promptEvidenceRefs;
          return { ...input, revision: "revision-1" };
        },
        async invalidate() { return true; },
      },
    });

    const result = await captureDeps.service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result.kind).toBe("completed");
    expect(savedRefs?.map((ref) => ref.evidenceId).sort()).toEqual(["evidence-1", "evidence-2"]);
  });

  it("bounds saved display evidence while preserving exact topic member counts", async () => {
    const topicEvidence = Array.from({ length: 20 }, (_unused, index) => {
      const ordinal = index + 1;
      return {
        id: `evidence-${ordinal}`,
        reference: {
          messageId: `aaaaaaaa-aaaa-aaaa-aaaa-${String(ordinal).padStart(12, "0")}`,
          conversationId: `bbbbbbbb-bbbb-bbbb-bbbb-${String(ordinal).padStart(12, "0")}`,
        },
        question: `Question ${ordinal}`,
        weekStart: "2026-06-29T00:00:00.000Z",
        channel: null,
        grounding: "unknown" as const,
        contentGapEligible: false,
      };
    });
    let savedRefs: Array<{ evidenceId: string }> | undefined;
    const { service } = createService({
      historySource: {
        async read() {
          return {
            ...history(),
            coverage: { populationSize: topicEvidence.length, sampleSize: topicEvidence.length, sampled: false },
            evidence: topicEvidence,
          };
        },
        async listEligibleQuestionIds() { return []; },
        async rehydrate() { return new Map(); },
        async readEvidenceAnchor() { return null; },
      },
      censusServiceFactory: {
        create: () => ({
          run: async () => ({
            ...censusResult(),
            populationSize: topicEvidence.length,
            facetReadyQuestionCount: topicEvidence.length,
            topics: [{
              ...censusResult().topics[0],
              memberIds: topicEvidence.map((item) => item.id),
              memberCount: topicEvidence.length,
              share: 1,
            }],
          }),
        } as unknown as CensusService),
      } satisfies CensusServiceFactory,
      inferenceFactory: {
        async create() {
          return {
            metadata: { capability: "chat", provider: "openai", model: "test" },
            async complete() {
              return {
                text: JSON.stringify({
                  summary: "Visitors ask about a recurring topic.",
                  themes: [],
                  recommendations: {},
                  caveats: [],
                }),
              };
            },
            stream() { throw new Error("not used"); },
          };
        },
      },
      snapshotStore: {
        async find() { return null; },
        async replace(input) {
          savedRefs = input.promptEvidenceRefs;
          return { ...input, revision: "revision-1" };
        },
        async invalidate() { return true; },
      },
    });

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("expected a completed refresh");
    expect(result.report.themes[0]).toMatchObject({ memberCount: 20, share: 1 });
    expect(result.report.themes[0].evidence).toHaveLength(12);
    expect(savedRefs).toHaveLength(12);
    expect(savedRefs?.map((ref) => ref.evidenceId)).not.toContain("evidence-20");
  });

  it("rethrows persistence and accounting failures after completed model work", async () => {
    const snapshotFailure = new Error("snapshot write failed");
    let snapshotReplaceCalls = 0;
    const snapshot = createService({
      snapshotStore: {
        async find() { return null; },
        async replace() {
          snapshotReplaceCalls += 1;
          throw snapshotFailure;
        },
        async invalidate() { return true; },
      },
    });

    await expect(snapshot.service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .rejects.toBe(snapshotFailure);
    expect(snapshot.calls).toMatchObject({ inference: 1, reserve: 1, replace: 0, commit: 1, release: 0, leaseRelease: 1 });
    expect(snapshotReplaceCalls).toBe(1);
    expect(snapshot.calls.auditEvents.at(-1)).toMatchObject({
      eventType: "audience_pulse.refresh_failed",
      metadata: { outcome: "internal" },
    });

    const accountingFailure = new Error("usage commit failed");
    let accountingCommitCalls = 0;
    let accountingReleaseCalls = 0;
    const accounting = createService({
      usageLimitPolicy: {
        async reserveAnswer() {
          return {
            async commit() {
              accountingCommitCalls += 1;
              throw accountingFailure;
            },
            async release() { accountingReleaseCalls += 1; },
          };
        },
        async reserveDocument() { throw new Error("not used"); },
        async reserveIndexedStorage() { throw new Error("not used"); },
        async reserveMonthlyIndexedContent() { throw new Error("not used"); },
      },
    });

    await expect(accounting.service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .rejects.toBe(accountingFailure);
    expect(accounting.calls).toMatchObject({ inference: 1, replace: 0, leaseRelease: 1 });
    expect({ accountingCommitCalls, accountingReleaseCalls }).toEqual({ accountingCommitCalls: 1, accountingReleaseCalls: 0 });

    const historyFailure = new Error("history read failed");
    const historyRead = createService({
      historySource: {
        async read() { throw historyFailure; },
        async listEligibleQuestionIds() { return []; },
        async rehydrate() { return new Map(); },
        async readEvidenceAnchor() { return null; },
      },
    });

    await expect(historyRead.service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .rejects.toBe(historyFailure);
    expect(historyRead.calls).toMatchObject({ inference: 0, reserve: 0, replace: 0, commit: 0, release: 0, leaseRelease: 1 });
  });

  it("rethrows release accounting failures and still releases the refresh lease", async () => {
    const releaseFailure = new Error("usage release failed");
    let releaseCalls = 0;
    const { service, calls } = createService({
      inferenceFactory: {
        async create() {
          return {
            metadata: { capability: "chat", provider: "openai", model: "test" },
            async complete() { throw new Error("provider unavailable"); },
            stream() { throw new Error("not used"); },
          };
        },
      },
      usageLimitPolicy: {
        async reserveAnswer() {
          return {
            async commit() { throw new Error("not used"); },
            async release() {
              releaseCalls += 1;
              throw releaseFailure;
            },
          };
        },
        async reserveDocument() { throw new Error("not used"); },
        async reserveIndexedStorage() { throw new Error("not used"); },
        async reserveMonthlyIndexedContent() { throw new Error("not used"); },
      },
    });

    await expect(service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .rejects.toBe(releaseFailure);
    expect({ releaseCalls, leaseReleaseCalls: calls.leaseRelease }).toEqual({ releaseCalls: 1, leaseReleaseCalls: 1 });
    expect(calls.auditEvents.filter((event) => event.eventType === "audience_pulse.refresh_failed")).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: "internal" }) }),
    ]);
  });

  it("records only the release failure when provider setup fails before cleanup", async () => {
    const providerFailure = Object.assign(new Error("provider unavailable"), { statusCode: 503 });
    const releaseFailure = new Error("usage release failed");
    let releaseCalls = 0;
    const { service, calls } = createService({
      inferenceFactory: {
        async create() { throw providerFailure; },
      },
      usageLimitPolicy: {
        async reserveAnswer() {
          return {
            async commit() { throw new Error("not used"); },
            async release() {
              releaseCalls += 1;
              throw releaseFailure;
            },
          };
        },
        async reserveDocument() { throw new Error("not used"); },
        async reserveIndexedStorage() { throw new Error("not used"); },
        async reserveMonthlyIndexedContent() { throw new Error("not used"); },
      },
    });

    await expect(service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .rejects.toBe(releaseFailure);
    expect({ releaseCalls, leaseReleaseCalls: calls.leaseRelease }).toEqual({ releaseCalls: 1, leaseReleaseCalls: 1 });
    expect(calls.auditEvents.filter((event) => event.eventType === "audience_pulse.refresh_failed")).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: "internal" }) }),
    ]);
  });

  it("invalidates the whole saved revision when any full prompt evidence reference cannot rehydrate", async () => {
    const snapshot: AudiencePulseSnapshotRecord = {
      workspaceId: WORKSPACE_ID,
      revision: "revision-1",
      period: { start: new Date("2026-07-01T00:00:00.000Z"), end: new Date("2026-07-31T00:00:00.000Z") },
      generatedAt: new Date("2026-08-01T00:00:00.000Z"),
      report: {
        period: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-31T00:00:00.000Z" },
        generatedAt: "2026-08-01T00:00:00.000Z",
        coverage: { populationSize: 2, sampleSize: 2, sampled: false, facetReadyQuestionCount: 2 },
        weeklyVolume: [],
        summary: "Summary",
        unclassifiedQuestionCount: 0,
        themes: [],
        contentGaps: [],
        recommendations: [],
        caveats: [],
      },
      promptEvidenceRefs: [{
        evidenceId: "evidence-1",
        messageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      }],
    };
    const { service, calls } = createService({
      snapshotStore: {
        async find() { return snapshot; },
        async replace() { throw new Error("not used"); },
        async invalidate() { calls.invalidate += 1; return true; },
      },
      historySource: {
        async read() { return history(); },
        async listEligibleQuestionIds() { return []; },
        async rehydrate() { return new Map(); },
        async readEvidenceAnchor() { return null; },
      },
    });

    await expect(service.read({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .resolves.toEqual({ kind: "not_generated" });
    expect(calls.invalidate).toBe(1);
  });

  it("loads a valid saved report without acquiring a lease, reserving usage, or calling inference", async () => {
    const snapshot: AudiencePulseSnapshotRecord = {
      workspaceId: WORKSPACE_ID,
      revision: "revision-1",
      period: { start: new Date("2026-07-01T00:00:00.000Z"), end: new Date("2026-07-31T00:00:00.000Z") },
      generatedAt: new Date("2026-08-01T00:00:00.000Z"),
      report: {
        period: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-31T00:00:00.000Z" },
        generatedAt: "2026-08-01T00:00:00.000Z",
        coverage: { populationSize: 1, sampleSize: 1, sampled: false, facetReadyQuestionCount: 1 },
        weeklyVolume: [],
        summary: "Saved summary",
        unclassifiedQuestionCount: 0,
        themes: [],
        contentGaps: [],
        recommendations: [],
        caveats: [],
      },
      promptEvidenceRefs: [{
        evidenceId: "evidence-1",
        messageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      }],
    };
    const { service, calls } = createService({
      snapshotStore: {
        async find() { return snapshot; },
        async replace() { throw new Error("not used"); },
        async invalidate() { throw new Error("not used"); },
      },
    });

    await expect(service.read({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .resolves.toMatchObject({ kind: "completed", report: { summary: "Saved summary" } });
    expect(calls).toMatchObject({ inference: 0, reserve: 0, commit: 0, release: 0, leaseRelease: 0 });
  });

  it("releases a reservation and preserves the prior snapshot when provider or validation work fails", async () => {
    const failureCases = [
      {
        expectedReason: "provider",
        complete: async () => { throw new Error("provider unavailable"); },
      },
      {
        expectedReason: "validation",
        complete: async () => ({ text: "not json" }),
      },
      {
        expectedReason: "validation",
        complete: async () => ({
          text: JSON.stringify({ summary: "Summary", themes: [], recommendations: {}, caveats: [] }),
        }),
      },
    ] as const;

    for (const failure of failureCases) {
      let providerCalls = 0;
      const { service, calls } = createService({
        inferenceFactory: {
          async create() {
            return {
              metadata: { capability: "chat", provider: "openai", model: "test" },
              async complete() {
                providerCalls += 1;
                return failure.complete();
              },
              stream() { throw new Error("not used"); },
            };
          },
        },
      });

      await expect(service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
        .resolves.toEqual({ kind: "unavailable", reason: failure.expectedReason });
      expect(providerCalls).toBe(1);
      expect(calls).toMatchObject({ reserve: 1, commit: 0, release: 1, replace: 0, leaseRelease: 1 });
    }
  });

  it("keeps a validation failure available when the injected logger needs its receiver", async () => {
    const logger = {
      warningCount: 0,
      warn(this: { warningCount: number }, _context: Record<string, unknown>, _message: string) {
        this.warningCount += 1;
      },
    };
    const { service } = createService({
      logger,
      inferenceFactory: {
        async create() {
          return {
            metadata: { capability: "chat", provider: "openai", model: "test" },
            async complete() { return { text: "not json" }; },
            stream() { throw new Error("not used"); },
          };
        },
      },
    });

    await expect(service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .resolves.toEqual({ kind: "unavailable", reason: "validation" });
    expect(logger.warningCount).toBe(1);
  });

  it("returns distinct busy and usage-limit outcomes without a provider call and records safe audit outcomes", async () => {
    const busy = createService({
      runGate: { async tryAcquire() { return null; } },
    });
    await expect(busy.service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .resolves.toEqual({ kind: "busy" });
    expect(busy.calls).toMatchObject({ inference: 0, reserve: 0, rate: 0, leaseRelease: 0 });
    expect(busy.calls.auditEvents.map((event) => [event.eventType, event.eventStatus])).toEqual([
      ["audience_pulse.refresh_requested", "success"],
      ["audience_pulse.refresh_failed", "failure"],
    ]);

    const usageLimited = createService({
      usageLimitPolicy: {
        async reserveAnswer() { throw Object.assign(new Error("Usage limit exceeded"), { code: "usage_limit_exceeded" }); },
        async reserveDocument() { throw new Error("not used"); },
        async reserveIndexedStorage() { throw new Error("not used"); },
        async reserveMonthlyIndexedContent() { throw new Error("not used"); },
      },
    });
    await expect(usageLimited.service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .resolves.toEqual({ kind: "usage_limited" });
    expect(usageLimited.calls).toMatchObject({ inference: 0, censusRun: 0, commit: 0, release: 0, leaseRelease: 1 });
    expect(usageLimited.calls.auditEvents.at(-1)).toMatchObject({
      eventType: "audience_pulse.refresh_failed",
      eventStatus: "failure",
      metadata: { outcome: "usage_limited", populationSize: 2, sampleSize: 2 },
    });
  });
});

describe("AudiencePulseService facet readiness (spec 956 follow-up)", () => {
  it("skips the narrative model call and commits no usage when nothing has been computed for the window yet", async () => {
    const { service, calls } = createService({
      censusServiceFactory: {
        create: () => ({
          run: async () => ({
            ...censusResult(),
            facetReadyQuestionCount: 0,
            unclassifiedCount: 2,
            topics: [],
          }),
        } as unknown as CensusService),
      } satisfies CensusServiceFactory,
    });

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("expected a completed refresh");
    // No narrative call ran; the early reservation is released without being committed.
    expect(calls).toMatchObject({ inference: 0, reserve: 1, commit: 0, release: 1, replace: 1, leaseRelease: 1 });
    expect(result.report.summary).toBeUndefined();
    expect(result.report.themes).toEqual([]);
    expect(result.report.recommendations).toEqual([]);
    // Every population question is still unclassified, but the report says so
    // through `coverage.facetReadyQuestionCount`, not by pretending clustering ran.
    expect(result.report.unclassifiedQuestionCount).toBe(2);
    expect(result.report.coverage).toEqual({
      populationSize: 2,
      sampleSize: 2,
      sampled: false,
      facetReadyQuestionCount: 0,
    });
  });

  it("records a completed outcome carrying facetReadyQuestionCount when nothing has been computed yet", async () => {
    const { service, calls } = createService({
      censusServiceFactory: {
        create: () => ({
          run: async () => ({
            ...censusResult(),
            facetReadyQuestionCount: 0,
            unclassifiedCount: 2,
            topics: [],
          }),
        } as unknown as CensusService),
      } satisfies CensusServiceFactory,
    });

    await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(calls.auditEvents.at(-1)).toMatchObject({
      eventType: "audience_pulse.refresh_completed",
      eventStatus: "success",
      metadata: { outcome: "completed", facetReadyQuestionCount: 0, topicCount: 0 },
    });
  });

  it("still calls the model and commits usage when the window is partially facet-ready", async () => {
    const { service, calls } = createService({
      censusServiceFactory: {
        create: () => ({
          run: async () => ({ ...censusResult(), facetReadyQuestionCount: 1 }),
        } as unknown as CensusService),
      } satisfies CensusServiceFactory,
    });

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result.kind).toBe("completed");
    expect(calls).toMatchObject({ inference: 1, reserve: 1, commit: 1, release: 0, replace: 1 });
    if (result.kind !== "completed") throw new Error("expected a completed refresh");
    expect(result.report.coverage).toMatchObject({ facetReadyQuestionCount: 1 });
  });
});
