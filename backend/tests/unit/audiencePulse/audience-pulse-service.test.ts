import { describe, expect, it } from "vitest";

import { AudiencePulseService } from "../../../src/modules/audiencePulse/services/audiencePulseService.js";
import type { AudiencePulseServiceDependencies } from "../../../src/modules/audiencePulse/services/audiencePulseService.js";
import type {
  AudiencePulseHistorySnapshot,
  AudiencePulseSnapshotRecord,
} from "../../../src/modules/audiencePulse/contracts.js";

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

const modelResponse = JSON.stringify({
  summary: "Visitors ask about subscription changes.",
  themes: [{
    title: "Subscription changes",
    description: "Repeated questions about changing a plan.",
    evidenceIds: ["evidence-1", "evidence-2"],
  }],
  recommendations: [{
    themeIndex: 0,
    title: "Document subscription changes",
    rationale: "Questions recur across visitor conversations.",
    questions: ["How can I change my plan?"],
    evidenceIds: ["evidence-1", "evidence-2"],
  }],
  caveats: [],
});

const createService = (overrides: Partial<AudiencePulseServiceDependencies> = {}) => {
  const calls = {
    inference: 0,
    reserve: 0,
    commit: 0,
    release: 0,
    leaseRelease: 0,
    replace: 0,
    invalidate: 0,
    auditEvents: [] as Array<{ eventType: string; eventStatus: string; metadata?: Record<string, unknown> }>,
  };
  const dependencies: AudiencePulseServiceDependencies = {
    historySource: {
      async read() { return history(); },
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
        return { ...input, revision: "revision-1" };
      },
      async invalidate() { calls.invalidate += 1; return true; },
    },
    runGate: {
      async tryAcquire() {
        return { async release() { calls.leaseRelease += 1; } };
      },
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
    usageLimitPolicy: {
      async reserveAnswer() {
        calls.reserve += 1;
        return {
          async commit() { calls.commit += 1; },
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
        async rehydrate() { return new Map(); },
        async readEvidenceAnchor() { return null; },
      },
    });

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result.kind).toBe("no_traffic");
    expect(calls).toMatchObject({ inference: 0, reserve: 0, commit: 0, release: 0, replace: 0, leaseRelease: 1 });
  });

  it("commits usage only after atomically saving a validated completed report", async () => {
    const { service, calls } = createService();

    const result = await service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID });

    expect(result.kind).toBe("completed");
    expect(calls).toMatchObject({ inference: 1, reserve: 1, replace: 1, commit: 1, release: 0, leaseRelease: 1 });
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
        coverage: { populationSize: 2, sampleSize: 2, sampled: false },
        weeklyVolume: [],
        summary: "Summary",
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
        coverage: { populationSize: 1, sampleSize: 1, sampled: false },
        weeklyVolume: [],
        summary: "Saved summary",
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

  it("returns distinct busy and usage-limit outcomes without a provider call and records safe audit outcomes", async () => {
    const busy = createService({
      runGate: { async tryAcquire() { return null; } },
    });
    await expect(busy.service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .resolves.toEqual({ kind: "busy" });
    expect(busy.calls).toMatchObject({ inference: 0, reserve: 0, leaseRelease: 0 });
    expect(busy.calls.auditEvents.map((event) => [event.eventType, event.eventStatus])).toEqual([
      ["audience_pulse.refresh_requested", "success"],
      ["audience_pulse.refresh_failed", "failure"],
    ]);

    const usageLimited = createService({
      usageLimitPolicy: {
        async reserveAnswer() { throw { code: "usage_limit_exceeded" }; },
        async reserveDocument() { throw new Error("not used"); },
        async reserveIndexedStorage() { throw new Error("not used"); },
        async reserveMonthlyIndexedContent() { throw new Error("not used"); },
      },
    });
    await expect(usageLimited.service.refresh({ accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID }))
      .resolves.toEqual({ kind: "usage_limited" });
    expect(usageLimited.calls).toMatchObject({ inference: 0, commit: 0, release: 0, leaseRelease: 1 });
    expect(usageLimited.calls.auditEvents.at(-1)).toMatchObject({
      eventType: "audience_pulse.refresh_failed",
      eventStatus: "failure",
      metadata: { outcome: "usage_limited", populationSize: 2, sampleSize: 2 },
    });
  });
});
