import { describe, expect, it, vi } from "vitest";

import type { ConversationTrace } from "@radioso/conversation-contract";

import type { AuditService } from "../../src/modules/audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../src/db/repositories/messageRepository.js";
import { ChatTurnSupersededError } from "../../src/modules/chat/services/conversationTurnRegistry.js";
import {
  buildTurnTraceForPresentation,
  ChatTurnLifecycle,
  type AssistantTurnPersistencePort,
  type ChatActionOutboxPort,
} from "../../src/modules/chat/services/chatTurnLifecycle.js";
import { HANDOFF_NOTIFY_ACTION_TYPE } from "../../src/modules/chat/services/routines/contactRoutine.js";
import type { ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { resolveContextForTurn } from "../../src/modules/context-variables/public.js";
import { TURN_TRACE_ENVELOPE_VERSION } from "../../src/modules/chat/services/turnTraceEnvelope.js";
import type { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { capabilityNames, type CapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../src/shared/domain/actionCapabilities.js";
import type {
  PageReadCandidateSource,
  PageReadCapability,
  PageReadDecision,
  PageReadGateOutcome,
} from "../../src/modules/chat/services/pageRead/pageReadDecision.js";

interface RecordedAudit {
  eventType?: string;
  eventStatus?: string;
  metadata: Record<string, unknown>;
}

const harness = (metrics?: { incrementCounter: MetricsRegistry["incrementCounter"] }) => {
  const records: RecordedAudit[] = [];
  const auditService = {
    record: vi.fn(async (event: RecordedAudit) => {
      records.push(event);
    }),
    updateChatAnswerSuggestions: vi.fn(async () => {}),
  } as unknown as AuditService;
  const conversationRepository = {
    touch: vi.fn(async () => {}),
  } as unknown as ConversationRepositoryPort;
  const messageRepository = {
    create: vi.fn(async () => ({ id: "assistant_msg_1" })),
  } as unknown as MessageRepositoryPort;

  const lifecycle = new ChatTurnLifecycle(
    conversationRepository,
    messageRepository,
    auditService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    metrics,
  );
  return { lifecycle, records, messageRepository, conversationRepository };
};

const session = (): PreparedSession =>
  ({
    agent: { id: "agent_1", name: "Support", chatModelOverride: null },
    conversation: { id: "conv_1" },
    history: [],
    userMessage: { id: "msg_1" },
    turnRoute: "direct",
    directiveSteering: { rules: [], matches: [], omissions: [] },
    stagedContext: [],
    resolvedContext: resolveContextForTurn(null),
    retrieval: {
      contexts: [],
      diagnostics: {},
      systemPrompt: undefined,
      trace: {
        traceId: "trace_1",
        startedAt: "2026-01-01T00:00:00.000Z",
        stages: [],
        links: [],
      },
    },
  } as unknown as PreparedSession);

const presentation = (): ChatPresentedAnswer => ({
  answer: "Grounded answer.",
  skillName: "retrieval.answer",
  skillOutcome: "grounded",
  skillStatus: "completed",
  answerOutcome: "grounded_success",
  citations: [],
});

const pageReadCapability: PageReadCapability = {
  available: true,
  mode: "content",
  supportedOperations: ["metadata", "lookup", "summarize"],
};

const pageReadSession = (input: {
  decision: PageReadDecision;
  gate: PageReadGateOutcome;
  source?: PageReadCandidateSource;
  capability?: PageReadCapability;
  capturePage?: boolean;
}): PreparedSession => {
  const resolvedContext = input.capturePage
    ? resolveContextForTurn({
        pageUrl: "https://example.test/docs",
        pageTitle: "Docs",
        pageLocale: "en-US",
        browserLocale: "en",
        content: "Visible page text.",
      })
    : resolveContextForTurn(null);
  return {
    ...session(),
    pageContext: {
      pageUrl: "https://example.test/docs",
      pageTitle: "Docs",
      content: "Visible page text.",
    },
    pageReadCapability: input.capability ?? pageReadCapability,
    pageReadOutcome: {
      merged: {
        decision: input.decision,
        contributors: input.decision.required && input.source
          ? [{
              source: input.source,
              operation: input.decision.operation,
              resolvedRequest: input.decision.resolvedRequest,
            }]
          : [],
      },
      gate: input.gate,
    },
    resolvedContext,
  };
};

const effectiveRetrieval = (): PreparedSession["retrieval"] =>
  ({
    contexts: [{
      documentId: "doc_1",
      chunkId: "chunk_1",
      title: "Source",
      content: "Grounded source text.",
      metadata: { sourceUrl: "https://example.com/source" },
      promptPosition: 0,
      similarity: 0.91,
      fusedScore: 0.91,
      semanticScore: 0.88,
      lexicalScore: 1,
      lexicalRankScore: 0.4,
    }],
    diagnostics: {
      retrievalSkipped: false,
      fallbackApplied: false,
      rewriteRan: false,
      rewriteStatus: "skipped",
      rewriteEligible: false,
      rerankStatus: "skipped",
      materialDisagreement: false,
      originalCandidateCount: 1,
      rewrittenCandidateCount: 0,
      lexicalCandidateCount: 0,
      normalizedCandidateCount: 1,
      finalContextCount: 1,
    },
    systemPrompt: "retrieval system prompt",
    trace: {
      traceId: "effective-retrieval-trace",
      startedAt: "2026-01-01T00:00:00.000Z",
      stages: [{
        stageId: "diagnostics",
        kind: "diagnostics",
        label: "Diagnostics",
        status: "applied",
      }],
      links: [],
    },
  } as unknown as PreparedSession["retrieval"]);

class FakeActionCapabilityMap implements ActionCapabilityMap {
  constructor(private readonly capabilitiesByType: Map<string, string[]>) {}

  has(type: string): boolean {
    return this.capabilitiesByType.has(type);
  }

  requiredCapabilitiesFor(type: string): string[] {
    return this.capabilitiesByType.get(type) ?? [];
  }
}

class FakeCapabilityPolicy implements CapabilityPolicy {
  readonly checks: string[] = [];

  constructor(private readonly deniedCapabilities = new Set<string>()) {}

  async can(input: { capability: string }): Promise<{ allowed: boolean; reason?: string }> {
    this.checks.push(input.capability);
    return this.deniedCapabilities.has(input.capability)
      ? { allowed: false, reason: "capability_denied" }
      : { allowed: true };
  }
}

const engineTrace = (): ConversationTrace => ({
  traceId: "conversation-turn-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  stages: [
    { id: "gather", kind: "gather", status: "applied" },
    {
      id: "dispatch:retrieval.answer",
      kind: "skill_dispatch",
      status: "applied",
      outputs: { skillName: "retrieval.answer" },
    },
    { id: "compose", kind: "compose", status: "applied" },
  ],
});

const routineRetrievalTrace = (): ConversationTrace => ({
  traceId: "conversation-turn-routine",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  stages: [
    { id: "message", kind: "message", status: "applied" },
    { id: "gather", kind: "gather", status: "applied" },
    {
      id: "routine:routine_1",
      kind: "routine_activate",
      status: "applied",
      outputs: { routineId: "routine_1", completed: false, answerLength: 42 },
      subTrace: {
        namespace: "routine",
        version: 1,
        payload: {
          routineId: "routine_1",
          startStepId: "retrieve",
          landedStepId: "answer",
          capturedSlotKeys: [],
          filledSlotKeys: [],
          steps: [
            {
              stepId: "retrieve",
              kind: "skill",
              event: "skill_dispatched",
              skillName: "retrieval.context",
              skillStatus: "context_ready",
            },
            { stepId: "answer", kind: "chat", event: "rendered" },
          ],
        },
      },
    },
  ],
});

describe("ChatTurnLifecycle — engine turn envelope", () => {
  it("persists the frozen capture decision and the gated page snapshot on assistant metadata", async () => {
    const { lifecycle, messageRepository } = harness();
    const prepared = pageReadSession({
      decision: {
        required: true,
        operation: "lookup",
        resolvedRequest: "Find the refund window",
      },
      source: { kind: "planner" },
      gate: {
        kind: "capture",
        operation: "lookup",
        resolvedRequest: "Find the refund window",
      },
      capturePage: true,
    });

    const completed = await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: prepared,
      presentation: {
        ...presentation(),
        grounding: "degraded",
        groundingSummary: {
          protocolVersion: 2,
          parseStatus: "valid_v2",
          verdict: "degraded",
          claimCount: 2,
          sourcedClaimCount: 1,
          unsourcedClaimCount: 1,
          invalidSourceCount: 0,
          assertionMismatch: false,
        },
        groundingDiagnostics: {
          parseStatus: "valid_v2",
          claimCount: 2,
          sourcedClaimCount: 1,
          unsourcedClaimCount: 1,
          invalidSourceCount: 0,
          assertionMismatch: false,
          eligibleSegmentCount: 1,
          implicitMatchCount: 0,
          explicitlyAssertedCount: 1,
        },
      },
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    const create = vi.mocked(messageRepository.create);
    const assistantMessage = create.mock.calls[0]?.[0];
    expect(assistantMessage?.grounding).toEqual({
      verdict: "degraded",
      claimCount: 2,
      sourcedClaimCount: 1,
      unsourcedClaimCount: 1,
      invalidSourceCount: 0,
    });
    expect(assistantMessage?.metadata?.contextVariables).toEqual({
      page_context: {
        kind: "page_context",
        pageUrl: "https://example.test/docs",
        pageTitle: "Docs",
        pageLocale: "en-US",
        browserLocale: "en",
        content: "Visible page text.",
      },
    });
    expect(assistantMessage?.metadata?.pageRead).toEqual({
      decision: {
        required: true,
        operation: "lookup",
        resolvedRequest: "Find the refund window",
      },
      winnerSource: { kind: "planner" },
      gateOutcome: "capture",
    });
    const gather = completed.response.turnTrace?.spine.stages.find((stage) => stage.kind === "gather");
    expect(gather?.outputs?.contextVariables).toBeUndefined();
    expect(gather?.outputs?.pageRead).toEqual({
      schemaVersion: 1,
      available: true,
      required: true,
      requested: false,
      resolved: true,
      operation: "lookup",
      outcome: "context_ready",
    });
  });

  it.each([
    {
      name: "not_required",
      decision: { required: false, operation: null, resolvedRequest: null },
      gate: { kind: "not_required" },
      source: undefined,
      expectedWinner: null,
    },
    {
      name: "unavailable",
      decision: { required: true, operation: "lookup", resolvedRequest: "Find the price" },
      gate: { kind: "unavailable" },
      source: { kind: "routine", routineId: "page.price" },
      expectedWinner: { kind: "routine", routineId: "page.price" },
    },
    {
      name: "unsupported_operation",
      decision: { required: true, operation: "transform", resolvedRequest: "Translate the page" },
      gate: { kind: "unsupported_operation" },
      source: { kind: "planner" },
      expectedWinner: { kind: "planner" },
    },
  ] satisfies Array<{
    name: string;
    decision: PageReadDecision;
    gate: PageReadGateOutcome;
    source: PageReadCandidateSource | undefined;
    expectedWinner: PageReadCandidateSource | null;
  }>)(
    "persists the frozen $name decision without page-derived metadata",
    async ({ decision, gate, source, expectedWinner }) => {
      const { lifecycle, messageRepository } = harness();
      await lifecycle.completeAssistantTurn({
        workspaceId: "workspace_1",
        session: pageReadSession({ decision, gate, source }),
        presentation: presentation(),
        answerStartedAt: Date.now(),
        stream: false,
        engineTrace: engineTrace(),
      });

      const assistantMessage = vi.mocked(messageRepository.create).mock.calls[0]?.[0];
      expect(assistantMessage?.metadata?.pageRead).toEqual({
        decision,
        winnerSource: expectedWinner,
        gateOutcome: gate.kind,
      });
      expect(assistantMessage?.metadata).not.toHaveProperty("contextVariables");
      expect(JSON.stringify(assistantMessage?.metadata)).not.toContain("Visible page text.");
      expect(JSON.stringify(assistantMessage?.metadata)).not.toContain("https://example.test/docs");
    },
  );

  it("persists no page-read metadata for a turn without the capability", async () => {
    const metrics = { incrementCounter: vi.fn() };
    const { lifecycle, messageRepository } = harness(metrics);

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    const assistantMessage = vi.mocked(messageRepository.create).mock.calls[0]?.[0];
    expect(assistantMessage?.metadata).not.toHaveProperty("pageRead");
    expect(metrics.incrementCounter).not.toHaveBeenCalled();
  });

  it.each([
    {
      decision: { required: false, operation: null, resolvedRequest: null },
      gate: { kind: "not_required" },
      expectedLabels: { outcome: "not_required", operation: "none" },
    },
    {
      decision: { required: true, operation: "lookup", resolvedRequest: "Find the price" },
      gate: { kind: "capture", operation: "lookup", resolvedRequest: "Find the price" },
      expectedLabels: { outcome: "capture", operation: "lookup" },
    },
    {
      decision: { required: true, operation: "summarize", resolvedRequest: "Summarize the page" },
      gate: { kind: "unavailable" },
      expectedLabels: { outcome: "unavailable", operation: "summarize" },
    },
    {
      decision: { required: true, operation: "transform", resolvedRequest: "Translate the page" },
      gate: { kind: "unsupported_operation" },
      expectedLabels: { outcome: "unsupported_operation", operation: "transform" },
    },
  ] satisfies Array<{
    decision: PageReadDecision;
    gate: PageReadGateOutcome;
    expectedLabels: { outcome: PageReadGateOutcome["kind"]; operation: string };
  }>)(
    "emits the $expectedLabels.outcome counter exactly once with bounded labels",
    async ({ decision, gate, expectedLabels }) => {
      const metrics = { incrementCounter: vi.fn() };
      const { lifecycle } = harness(metrics);

      await lifecycle.completeAssistantTurn({
        workspaceId: "workspace_1",
        session: pageReadSession({ decision, gate }),
        presentation: presentation(),
        answerStartedAt: Date.now(),
        stream: false,
        engineTrace: engineTrace(),
      });

      expect(metrics.incrementCounter).toHaveBeenCalledOnce();
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        "chat_page_read_gate_outcomes_total",
        {
          help: "Page-read gate outcomes by result and selected operation.",
          labels: expectedLabels,
        },
      );
    },
  );

  it("builds the same turn trace envelope through the extracted presentation helper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    const { lifecycle, records } = harness();
    const prepared = session();
    const presented = presentation();
    const answerStartedAt = Date.now() - 1000;

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: prepared,
      presentation: presented,
      answerStartedAt,
      stream: false,
      engineTrace: engineTrace(),
    });
    const extracted = buildTurnTraceForPresentation({
      workspaceId: "workspace_1",
      session: prepared,
      presentation: presented,
      answerStartedAt,
      stream: false,
      engineTrace: engineTrace(),
    });

    expect(records[0].metadata.turnTrace).toEqual(extracted.turnTrace);
    expect(records[0].metadata.activityTrace).toEqual(extracted.activityTrace);
    vi.useRealTimers();
  });

  it("appends a conversation_summary activity-trace stage when the session carries a rolling summary", () => {
    const prepared = {
      ...session(),
      conversationSummary: "User is booking a trip to Osaka and asked about visas.",
    } as PreparedSession;

    const { activityTrace } = buildTurnTraceForPresentation({
      workspaceId: "workspace_1",
      session: prepared,
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    const summaryStage = activityTrace.stages.find((stage) => stage.kind === "conversation_summary");
    expect(summaryStage).toBeDefined();
    expect(summaryStage?.outputs?.summary).toBe(prepared.conversationSummary);
    expect(summaryStage?.outputs?.injectedInto).toEqual([
      "turn_interpretation",
      "grounded_answer",
      "direct_answer",
    ]);
  });

  it("marks the conversation_summary stage skipped when the session has no rolling summary", () => {
    const { activityTrace } = buildTurnTraceForPresentation({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    const stage = activityTrace.stages.find((s) => s.kind === "conversation_summary");
    expect(stage?.status).toBe("skipped");
    expect(stage?.outputs?.summary).toBeUndefined();
  });

  it("persists the pre-answer conversation summary the session saw on assistant metadata", () => {
    const prepared = {
      ...session(),
      conversationSummary: "User is booking a trip to Osaka and asked about visas.",
    } as PreparedSession;

    const { assistantMessage } = buildTurnTraceForPresentation({
      workspaceId: "workspace_1",
      session: prepared,
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    expect(assistantMessage.metadata?.conversationSummary).toBe(
      "User is booking a trip to Osaka and asked about visas.",
    );
  });

  it("persists an explicit null summary when the summary-aware session had none", () => {
    const { assistantMessage } = buildTurnTraceForPresentation({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    expect(assistantMessage.metadata).toHaveProperty("conversationSummary", null);
  });

  it("persists turn wall time on the assistant message and the answer stage from one measurement", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:02.500Z"));
    const answerStartedAt = Date.now() - 1500;

    const { assistantMessage, activityTrace } = buildTurnTraceForPresentation({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt,
      stream: false,
      engineTrace: engineTrace(),
    });

    expect(assistantMessage.totalLatencyMs).toBe(1500);
    // Same measurement, so the persisted column and the trace can never disagree.
    const answerStage = activityTrace.stages.find((stage) => stage.stageId === "answer");
    expect(answerStage?.durationMs).toBe(assistantMessage.totalLatencyMs);
    vi.useRealTimers();
  });

  it("reports retrieval as invoked when a direct-classified routine turn dispatches retrieval.context", async () => {
    const { lifecycle, records } = harness();
    const prepared = session();
    const presented: ChatPresentedAnswer = {
      answer: "Routine grounded answer.",
      skillName: "assistant.chat",
      skillOutcome: "conversational",
      skillStatus: "completed",
      answerOutcome: "non_retrieval_response",
      citations: [{ documentId: "doc_1", chunkId: "chunk_1", title: "Source" }],
      answerSegments: [{ text: "Routine grounded answer.", citationIndices: [0] }],
    };

    const completed = await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: prepared,
      presentation: presented,
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: routineRetrievalTrace(),
    });

    expect(completed.response.route).toEqual({
      type: "retrieval",
      reason: "evidence_required",
    });
    expect(records[0].metadata.route).toEqual({
      generator: "assistant",
      routeType: "retrieval",
      routeReason: "evidence_required",
      retrievalInvoked: true,
    });
    expect(records[0].metadata.retrieval).toEqual(expect.objectContaining({
      execution: {
        surface: "assistant",
        path: "assistant_retrieval",
        retrievalInvoked: true,
      },
    }));
  });

  it("uses a routine-grounded presentation's effective retrieval for trace and message metadata", async () => {
    const { lifecycle, records, messageRepository } = harness();
    const prepared = session();
    const retrieval = effectiveRetrieval();
    const presented: ChatPresentedAnswer = {
      answer: "Routine grounded answer.",
      skillName: "retrieval.answer",
      skillOutcome: "grounded",
      skillStatus: "completed",
      answerOutcome: "grounded_success",
      citations: [{ documentId: "doc_1", chunkId: "chunk_1", title: "Source", sourceUrl: "https://example.com/source" }],
      answerSegments: [{ text: "Routine grounded answer.", citationIndices: [0] }],
      effectiveRetrieval: retrieval,
    };

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: prepared,
      presentation: presented,
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: routineRetrievalTrace(),
    });

    expect(records[0].metadata.retrieval).toEqual(expect.objectContaining({
      retrievalSkipped: false,
      finalContextCount: 1,
      execution: {
        surface: "assistant",
        path: "assistant_retrieval",
        retrievalInvoked: true,
      },
    }));
    expect(records[0].metadata.activityTrace).toEqual(expect.objectContaining({
      summary: expect.objectContaining({
        outcome: "retrieval_completed",
        retrievalSkipped: false,
        candidateCounts: expect.objectContaining({ final: 1 }),
        assistant: expect.objectContaining({
          route: "retrieval",
          routeReason: "evidence_required",
        }),
      }),
    }));
    const activityTrace = records[0].metadata.activityTrace as { stages: unknown[] };
    expect(activityTrace.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "answer_outcome",
        outputs: expect.objectContaining({ retrievalSkipped: false }),
      }),
    ]));
    expect(activityTrace.stages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: "Retrieval was intentionally skipped for a non-retrieval chat turn.",
      }),
    ]));

    const create = vi.mocked(messageRepository.create);
    const assistantMessage = create.mock.calls[0]?.[0];
    expect(assistantMessage?.metadata?.retrievedChunks).toEqual([{
      chunkId: "chunk_1",
      documentId: "doc_1",
      title: "Source",
      rank: 0,
      similarity: 0.91,
      fusedScore: 0.91,
      semanticScore: 0.88,
      lexicalScore: 1,
      lexicalRankScore: 0.4,
      metadata: { sourceUrl: "https://example.com/source" },
    }]);
    expect(assistantMessage?.metadata?.composedInstructions).toBe("retrieval system prompt");
  });

  it("uses the transaction port for assistant message, action outbox, routine state, touch, and success audit", async () => {
    const records: RecordedAudit[] = [];
    const auditService = {
      record: vi.fn(async (event: RecordedAudit) => {
        records.push(event);
      }),
      logRecorded: vi.fn((event: RecordedAudit) => {
        records.push(event);
      }),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => ({ id: "assistant_msg_separate_write" })),
    } as unknown as MessageRepositoryPort;
    const actionOutbox = {
      enqueue: vi.fn(async () => ({ id: "action_1", duplicate: false })),
    };
    const assistantTurnPersistence: AssistantTurnPersistencePort = {
      completeAssistantTurn: vi.fn(async (input) => ({
        id: input.assistantMessage.id!,
        conversationId: input.assistantMessage.conversationId,
        workspaceId: input.assistantMessage.workspaceId,
        role: "assistant" as const,
        content: input.assistantMessage.content,
        metadata: input.assistantMessage.metadata,
        skillName: input.assistantMessage.skillName,
        skillOutcome: input.assistantMessage.skillOutcome,
        skillStatus: input.assistantMessage.skillStatus,
        createdAt: new Date(),
      })),
    };
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      undefined,
      actionOutbox,
      assistantTurnPersistence,
    );

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: {
        ...presentation(),
        grounding: "degraded",
        groundingSummary: {
          protocolVersion: 2,
          parseStatus: "valid_v2",
          verdict: "degraded",
          claimCount: 2,
          sourcedClaimCount: 1,
          unsourcedClaimCount: 1,
          invalidSourceCount: 0,
          assertionMismatch: false,
        },
        groundingDiagnostics: {
          parseStatus: "valid_v2",
          claimCount: 2,
          sourcedClaimCount: 1,
          unsourcedClaimCount: 1,
          invalidSourceCount: 0,
          assertionMismatch: false,
          eligibleSegmentCount: 1,
          implicitMatchCount: 0,
          explicitlyAssertedCount: 1,
        },
      },
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
      actions: [{ type: "contact.send", payload: { email: "alex@example.com" } }],
      routineStateTransition: { kind: "clear", sessionId: "conv_1" },
      clarificationTransition: {
        kind: "save",
        pending: {
          sessionId: "conv_1",
          source: "test_surface",
          candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } }],
          askedEventId: "assistant_msg_1",
          status: "pending",
          expiresAt: "2026-06-10T12:00:00.000Z",
        },
      },
      commitRoutineState: vi.fn(async () => {}),
      commitClarificationState: vi.fn(async () => {}),
    });

    expect(actionOutbox.enqueue).not.toHaveBeenCalled();
    expect(messageRepository.create).not.toHaveBeenCalled();
    expect(conversationRepository.touch).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    expect(assistantTurnPersistence.completeAssistantTurn).toHaveBeenCalledOnce();
    const persisted = vi.mocked(assistantTurnPersistence.completeAssistantTurn).mock.calls[0]![0];
    expect(persisted.assistantMessage.grounding).toEqual({
      verdict: "degraded",
      claimCount: 2,
      sourcedClaimCount: 1,
      unsourcedClaimCount: 1,
      invalidSourceCount: 0,
    });
    expect(persisted.actions).toEqual([{ type: "contact.send", payload: { email: "alex@example.com" } }]);
    expect(persisted.routineStateTransition).toEqual({ kind: "clear", sessionId: "conv_1" });
    expect(persisted.pendingDecisionTransition).toBeUndefined();
    expect(persisted.clarificationTransition).toEqual({
      kind: "save",
      pending: {
        sessionId: "conv_1",
        source: "test_surface",
        candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } }],
        askedEventId: "assistant_msg_1",
        status: "pending",
        expiresAt: "2026-06-10T12:00:00.000Z",
      },
    });
    expect(persisted.assistantMessage.id).toEqual(expect.any(String));
    expect(persisted.auditEvent.metadata?.assistantMessageId).toBe(persisted.assistantMessage.id);
    expect(records[0]).toBe(persisted.auditEvent);
  });

  it("records suspended routine turns separately and carries the pending decision into the transaction port", async () => {
    const records: RecordedAudit[] = [];
    const auditService = {
      record: vi.fn(async (event: RecordedAudit) => {
        records.push(event);
      }),
      logRecorded: vi.fn((event: RecordedAudit) => {
        records.push(event);
      }),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => ({ id: "assistant_msg_separate_write" })),
    } as unknown as MessageRepositoryPort;
    const productAnalyticsService = {
      track: vi.fn(async () => null),
    };
    const assistantTurnPersistence: AssistantTurnPersistencePort = {
      completeAssistantTurn: vi.fn(async (input) => ({
        id: input.assistantMessage.id!,
        conversationId: input.assistantMessage.conversationId,
        workspaceId: input.assistantMessage.workspaceId,
        role: "assistant" as const,
        content: input.assistantMessage.content,
        metadata: input.assistantMessage.metadata,
        skillName: input.assistantMessage.skillName,
        skillOutcome: input.assistantMessage.skillOutcome,
        skillStatus: input.assistantMessage.skillStatus,
        createdAt: new Date(),
      })),
    };
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      productAnalyticsService,
      undefined,
      assistantTurnPersistence,
    );
    const pendingDecisionTransition = {
      handle: "pd_1",
      conversationId: "conv_1",
      sessionId: "conv_1",
      workspaceId: "workspace_1",
      agentId: "agent_1",
      routineId: "routine_1",
      stepId: "approve_step",
      reason: "approval_required",
      options: [{ id: "approve", label: "Approve" }],
      deciderScope: { kind: "workspace_member" },
      contentHash: "hash_1",
      deadline: null,
    };

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: {
        ...presentation(),
        grounding: "degraded",
        groundingSummary: {
          protocolVersion: 2,
          parseStatus: "valid_v2",
          verdict: "degraded",
          claimCount: 2,
          sourcedClaimCount: 1,
          unsourcedClaimCount: 1,
          invalidSourceCount: 0,
          assertionMismatch: false,
        },
        groundingDiagnostics: {
          parseStatus: "valid_v2",
          claimCount: 2,
          sourcedClaimCount: 1,
          unsourcedClaimCount: 1,
          invalidSourceCount: 0,
          assertionMismatch: false,
          eligibleSegmentCount: 1,
          implicitMatchCount: 0,
          explicitlyAssertedCount: 1,
        },
      },
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
      routineStateTransition: {
        kind: "save",
        state: {
          sessionId: "conv_1",
          routineId: "routine_1",
          path: ["approve_step"],
          variables: {},
          status: "suspended",
        },
      },
      pendingDecisionTransition,
      suspended: true,
    });

    expect(assistantTurnPersistence.completeAssistantTurn).toHaveBeenCalledOnce();
    const persisted = vi.mocked(assistantTurnPersistence.completeAssistantTurn).mock.calls[0]![0];
    expect(persisted.pendingDecisionTransition).toEqual(pendingDecisionTransition);
    expect(persisted.auditEvent.eventType).toBe("chat.suspended");
    expect(persisted.auditEvent.eventStatus).toBe("success");
    expect(persisted.auditEvent.metadata?.executionClass).toBe("durable_async");
    expect(records).toHaveLength(1);
    expect(records[0].eventType).toBe("chat.suspended");
    expect(productAnalyticsService.track).not.toHaveBeenCalled();
  });

  it("threads routine ownership handoff and audit through the transaction port", async () => {
    const records: RecordedAudit[] = [];
    const auditService = {
      record: vi.fn(async (event: RecordedAudit) => {
        records.push(event);
      }),
      logRecorded: vi.fn((event: RecordedAudit) => {
        records.push(event);
      }),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => ({ id: "assistant_msg_separate_write" })),
    } as unknown as MessageRepositoryPort;
    const assistantTurnPersistence: AssistantTurnPersistencePort = {
      completeAssistantTurn: vi.fn(async (input) => ({
        id: input.assistantMessage.id!,
        conversationId: input.assistantMessage.conversationId,
        workspaceId: input.assistantMessage.workspaceId,
        role: "assistant" as const,
        content: input.assistantMessage.content,
        metadata: input.assistantMessage.metadata,
        skillName: input.assistantMessage.skillName,
        skillOutcome: input.assistantMessage.skillOutcome,
        skillStatus: input.assistantMessage.skillStatus,
        createdAt: new Date(),
      })),
    };
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      undefined,
      undefined,
      assistantTurnPersistence,
    );

    const completed = await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: { ...presentation(), answer: "A person will help you from here." },
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
      actions: [{
        type: HANDOFF_NOTIFY_ACTION_TYPE,
        payload: {
          conversationId: "conv_1",
          workspaceId: "workspace_1",
          agentId: "agent_1",
          reason: "routine_handoff",
          routineId: "routine_1",
          stepId: "handoff",
        },
      }],
      ownershipHandoff: { reason: "routine_handoff", routineId: "routine_1", stepId: "handoff" },
    });

    expect(completed.response.answer).toBe("A person will help you from here.");
    expect(assistantTurnPersistence.completeAssistantTurn).toHaveBeenCalledOnce();
    const persisted = vi.mocked(assistantTurnPersistence.completeAssistantTurn).mock.calls[0]![0];
    expect(persisted.ownershipHandoff).toEqual({
      reason: "routine_handoff",
      routineId: "routine_1",
      stepId: "handoff",
    });
    expect(persisted.actions?.[0]?.type).toBe(HANDOFF_NOTIFY_ACTION_TYPE);
    expect(persisted.ownershipAuditEvent).toMatchObject({
      eventType: "hitl.ownership",
      eventStatus: "success",
      metadata: {
        actor: { type: "system", source: "routine" },
        action: "handoff_requested",
        reason: "routine_handoff",
        conversationId: "conv_1",
        agentId: "agent_1",
        workspaceId: "workspace_1",
        routineId: "routine_1",
        stepId: "handoff",
      },
    });
    expect(records.map((record) => record.eventType)).toEqual(["chat.answer"]);
  });

  it("keeps normal assistant turns as chat.answer successes without pending decision transitions", async () => {
    const records: RecordedAudit[] = [];
    const auditService = {
      record: vi.fn(async (event: RecordedAudit) => {
        records.push(event);
      }),
      logRecorded: vi.fn((event: RecordedAudit) => {
        records.push(event);
      }),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => ({ id: "assistant_msg_separate_write" })),
    } as unknown as MessageRepositoryPort;
    const productAnalyticsService = {
      track: vi.fn(async () => null),
    };
    const assistantTurnPersistence: AssistantTurnPersistencePort = {
      completeAssistantTurn: vi.fn(async (input) => ({
        id: input.assistantMessage.id!,
        conversationId: input.assistantMessage.conversationId,
        workspaceId: input.assistantMessage.workspaceId,
        role: "assistant" as const,
        content: input.assistantMessage.content,
        metadata: input.assistantMessage.metadata,
        skillName: input.assistantMessage.skillName,
        skillOutcome: input.assistantMessage.skillOutcome,
        skillStatus: input.assistantMessage.skillStatus,
        createdAt: new Date(),
      })),
    };
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      productAnalyticsService,
      undefined,
      assistantTurnPersistence,
    );

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: {
        ...presentation(),
        grounding: "degraded",
        groundingSummary: {
          protocolVersion: 2,
          parseStatus: "valid_v2",
          verdict: "degraded",
          claimCount: 2,
          sourcedClaimCount: 1,
          unsourcedClaimCount: 1,
          invalidSourceCount: 0,
          assertionMismatch: false,
        },
        groundingDiagnostics: {
          parseStatus: "valid_v2",
          claimCount: 2,
          sourcedClaimCount: 1,
          unsourcedClaimCount: 1,
          invalidSourceCount: 0,
          assertionMismatch: false,
          eligibleSegmentCount: 1,
          implicitMatchCount: 0,
          explicitlyAssertedCount: 1,
        },
      },
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    const persisted = vi.mocked(assistantTurnPersistence.completeAssistantTurn).mock.calls[0]![0];
    expect(persisted.pendingDecisionTransition).toBeUndefined();
    expect(persisted.auditEvent.eventType).toBe("chat.answer");
    expect(persisted.auditEvent.eventStatus).toBe("success");
    expect(persisted.assistantMessage.metadata).toMatchObject({
      groundingVerdict: "degraded",
      groundingProtocolVersion: 2,
      groundingDiagnostics: { claimCount: 2, unsourcedClaimCount: 1 },
    });
    expect(persisted.auditEvent.metadata).toMatchObject({
      groundingVerdict: "degraded",
      groundingProtocolVersion: 2,
      groundingDiagnostics: { claimCount: 2, unsourcedClaimCount: 1 },
    });
    expect(productAnalyticsService.track).toHaveBeenCalledOnce();
    expect(records[0].eventType).toBe("chat.answer");
  });

  it("does not commit a fallback clarification save when assistant message creation fails", async () => {
    const auditService = {
      record: vi.fn(async () => {}),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => {
        throw new Error("message write failed");
      }),
    } as unknown as MessageRepositoryPort;
    const commitClarificationState = vi.fn(async () => {});
    const lifecycle = new ChatTurnLifecycle(conversationRepository, messageRepository, auditService);

    await expect(lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
      clarificationTransition: {
        kind: "save",
        pending: {
          sessionId: "conv_1",
          source: "test_surface",
          candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } }],
          status: "pending",
          expiresAt: "2026-06-10T12:00:00.000Z",
        },
      },
      commitClarificationState,
    })).rejects.toThrow("message write failed");

    expect(commitClarificationState).not.toHaveBeenCalled();
  });

  it("fails a routine turn with a runtime-denied action before persisting a false success", async () => {
    const auditService = {
      record: vi.fn(async () => {}),
      logRecorded: vi.fn(() => {}),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => ({ id: "assistant_msg_separate_write" })),
    } as unknown as MessageRepositoryPort;
    const assistantTurnPersistence: AssistantTurnPersistencePort = {
      completeAssistantTurn: vi.fn(async (input) => ({
        id: input.assistantMessage.id!,
        conversationId: input.assistantMessage.conversationId,
        workspaceId: input.assistantMessage.workspaceId,
        role: "assistant" as const,
        content: input.assistantMessage.content,
        metadata: input.assistantMessage.metadata,
        skillName: input.assistantMessage.skillName,
        skillOutcome: input.assistantMessage.skillOutcome,
        skillStatus: input.assistantMessage.skillStatus,
        createdAt: new Date(),
      })),
    };
    const actionOutbox: ChatActionOutboxPort = {
      enqueue: vi.fn(async () => ({ id: "action_1", duplicate: false })),
    };
    const commitRoutineState = vi.fn(async () => {});
    const commitClarificationState = vi.fn(async () => {});
    const logger = {
      warn: vi.fn(),
    };
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      undefined,
      actionOutbox,
      assistantTurnPersistence,
      new FakeActionCapabilityMap(new Map([
        ["contact.send", [capabilityNames.humanContact.request]],
        ["ticket.create", []],
      ])),
      new FakeCapabilityPolicy(new Set([capabilityNames.humanContact.request])),
      logger,
    );

    await expect(lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      actions: [
        { type: "contact.send", payload: { email: "alex@example.com" } },
        { type: "ticket.create", payload: { title: "Keep this one" } },
      ],
      routineStateTransition: { kind: "clear", sessionId: "conv_1" },
      commitRoutineState,
      clarificationTransition: {
        kind: "save",
        pending: {
          sessionId: "conv_1",
          source: "test_surface",
          candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: {} }],
          status: "pending",
          expiresAt: "2026-06-10T12:00:00.000Z",
        },
      },
      commitClarificationState,
    })).rejects.toThrow("routine_action_authorization_denied");

    expect(assistantTurnPersistence.completeAssistantTurn).not.toHaveBeenCalled();
    expect(messageRepository.create).not.toHaveBeenCalled();
    expect(actionOutbox.enqueue).not.toHaveBeenCalled();
    expect(commitRoutineState).not.toHaveBeenCalled();
    expect(commitClarificationState).not.toHaveBeenCalled();
    expect(auditService.logRecorded).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        workspaceId: "workspace_1",
        conversationId: "conv_1",
        actionType: "contact.send",
        reason: "capability_denied",
        capability: capabilityNames.humanContact.request,
      },
      "Routine action blocked by capability policy",
    );
  });

  it("enqueues an authorized action unchanged on the fallback outbox path", async () => {
    const records: RecordedAudit[] = [];
    const auditService = {
      record: vi.fn(async (event: RecordedAudit) => {
        records.push(event);
      }),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => ({ id: "assistant_msg_1" })),
    } as unknown as MessageRepositoryPort;
    const actionOutbox: ChatActionOutboxPort = {
      enqueue: vi.fn(async () => ({ id: "action_1", duplicate: false })),
    };
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      undefined,
      actionOutbox,
      undefined,
      new FakeActionCapabilityMap(new Map([
        ["contact.send", [capabilityNames.humanContact.request]],
      ])),
      new FakeCapabilityPolicy(),
    );

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      actions: [{ type: "contact.send", payload: { email: "alex@example.com" } }],
      clarificationTransition: {
        kind: "clear",
        sessionId: "conv_1",
        outcome: "resolved",
      },
      commitClarificationState: vi.fn(async () => {}),
    });

    expect(actionOutbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: "contact.send",
      payload: { email: "alex@example.com" },
      workspaceId: "workspace_1",
      accountId: "account_1",
      conversationId: "conv_1",
      idempotencyKey: expect.stringMatching(/^routine-action:conv_1:contact\.send:/),
    }));
    expect(records).toHaveLength(1);
  });

  it("requests handoff ownership and records hitl audit on the fallback path", async () => {
    const records: RecordedAudit[] = [];
    const auditService = {
      record: vi.fn(async (event: RecordedAudit) => {
        records.push(event);
      }),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async (input) => ({ id: input.id ?? "assistant_msg_1" })),
    } as unknown as MessageRepositoryPort;
    const actionOutbox: ChatActionOutboxPort = {
      enqueue: vi.fn(async () => ({ id: "action_1", duplicate: false })),
    };
    const conversationOwnershipRepository = {
      requestHandoff: vi.fn(async () => null),
    };
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      undefined,
      actionOutbox,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      conversationOwnershipRepository,
    );

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: { ...presentation(), answer: "A person will help you from here." },
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
      actions: [{
        type: HANDOFF_NOTIFY_ACTION_TYPE,
        payload: {
          conversationId: "conv_1",
          workspaceId: "workspace_1",
          agentId: "agent_1",
          reason: "routine_handoff",
          routineId: "routine_1",
          stepId: "handoff",
        },
      }],
      ownershipHandoff: { reason: "routine_handoff", routineId: "routine_1", stepId: "handoff" },
    });

    expect(actionOutbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: HANDOFF_NOTIFY_ACTION_TYPE,
      idempotencyKey: expect.stringMatching(/^routine-action:conv_1:handoff\.notify:/),
    }));
    expect(conversationOwnershipRepository.requestHandoff).toHaveBeenCalledWith({
      conversationId: "conv_1",
      workspaceId: "workspace_1",
      reason: "routine_handoff",
    });
    expect(records.map((record) => record.eventType)).toEqual(["chat.answer", "hitl.ownership"]);
    expect(records[1]).toMatchObject({
      eventType: "hitl.ownership",
      metadata: {
        action: "handoff_requested",
        routineId: "routine_1",
        stepId: "handoff",
      },
    });
  });

  it("commits clarification state on the fallback path after the assistant message", async () => {
    const order: string[] = [];
    const auditService = {
      record: vi.fn(async () => {
        order.push("audit");
      }),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {
        order.push("touch");
      }),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => {
        order.push("message");
        return { id: "assistant_msg_1" };
      }),
    } as unknown as MessageRepositoryPort;
    const actionOutbox: ChatActionOutboxPort = {
      enqueue: vi.fn(async () => {
        order.push("action");
        return { id: "action_1", duplicate: false };
      }),
    };
    const commitClarificationState = vi.fn(async () => {
      order.push("clarification");
    });
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      undefined,
      actionOutbox,
    );

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      actions: [{ type: "contact.send", payload: { email: "alex@example.com" } }],
      clarificationTransition: {
        kind: "save",
        pending: {
          sessionId: "conv_1",
          source: "test_surface",
          candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: {} }],
          status: "pending",
          expiresAt: "2026-06-10T12:00:00.000Z",
        },
      },
      commitClarificationState,
    });

    expect(commitClarificationState).toHaveBeenCalledOnce();
    expect(order.slice(0, 3)).toEqual(["action", "message", "clarification"]);
  });

  it("persists a turnTrace envelope with the retrieval activity trace as a leaf on the dispatch stage", async () => {
    const { lifecycle, records } = harness();

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    expect(records).toHaveLength(1);
    const turnTrace = records[0].metadata.turnTrace as {
      version: number;
      spine: { traceId: string; stages: Array<{ kind: string; subTrace?: any }> };
    };
    expect(turnTrace.version).toBe(TURN_TRACE_ENVELOPE_VERSION);
    expect(turnTrace.spine.stages.map((stage: any) => stage.kind)).toEqual([
      "gather",
      "skill_dispatch",
      "compose",
    ]);

    const dispatchStage = turnTrace.spine.stages.find((stage: any) => stage.kind === "skill_dispatch");
    expect(dispatchStage).toBeDefined();
    if (!dispatchStage) {
      throw new Error("missing dispatch stage");
    }
    expect(dispatchStage.subTrace.namespace).toBe("retrieval");
    expect(dispatchStage.subTrace.version).toBe(1);
    // The leaf is the FINALIZED activity trace (answer-outcome stage appended), keyed off trace_1.
    expect(dispatchStage.subTrace.payload.traceId).toBe("trace_1");
    expect(dispatchStage.subTrace.payload.stages.length).toBeGreaterThan(0);
  });

  it("retains the legacy activityTrace key but no longer writes conversationEngine.trace", async () => {
    const { lifecycle, records } = harness();

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    const metadata = records[0].metadata as {
      activityTrace?: { traceId: string };
      conversationEngine?: unknown;
      turnTrace?: { spine?: { traceId?: string } };
    };
    // Legacy flat trace is still written (history + live text diagnostics read it).
    expect(metadata.activityTrace?.traceId).toBe("trace_1");
    // The raw spine now lives only in the envelope; the dead audit key is gone.
    expect(metadata.conversationEngine).toBeUndefined();
    expect(metadata.turnTrace?.spine?.traceId).toBe("conversation-turn-1");
  });

  describe("recordSupersession", () => {
    it("records an accountable chat.answer event keyed to the user message, distinct from a failure", async () => {
      const { lifecycle, records, conversationRepository } = harness();
      const supersededBy = new ChatTurnSupersededError("conv_1", "routing");

      await lifecycle.recordSupersession(
        { workspaceId: "workspace_1", accountId: "account_1", stream: false },
        session(),
        undefined,
        supersededBy,
      );

      expect(records).toHaveLength(1);
      const [event] = records;
      expect(event.eventType).toBe("chat.answer");
      // A supersession is a normal user interruption, not an error: it must never be
      // recorded as "failure", or Activity/health surfaces reading eventStatus would
      // count a user typing a follow-up as an assistant error.
      expect(event.eventStatus).toBe("cancelled");
      expect(event.eventStatus).not.toBe("failure");
      expect(event.metadata).toMatchObject({
        conversationId: "conv_1",
        userMessageId: "msg_1",
        stream: false,
        supersededStage: "routing",
      });
      expect(event.metadata.assistantMessageId).toBeUndefined();
      // No error text: this event records an interruption, not a diagnostic.
      expect(event.metadata.errorMessage).toBeUndefined();
      // No assistant message exists yet for this turn, so the conversation's
      // updated_at is left alone (mirrors recordFailure's touch guard).
      expect(conversationRepository.touch).not.toHaveBeenCalled();
    });

    it("touches the conversation when an assistant message already exists for the superseded turn", async () => {
      const { lifecycle, records, conversationRepository } = harness();
      const supersededBy = new ChatTurnSupersededError("conv_1", "persisting");

      await lifecycle.recordSupersession(
        { workspaceId: "workspace_1", stream: true },
        session(),
        "assistant_msg_partial",
        supersededBy,
      );

      expect(conversationRepository.touch).toHaveBeenCalledWith("conv_1", "workspace_1");
      expect(records[0].metadata).toMatchObject({
        assistantMessageId: "assistant_msg_partial",
        supersededStage: "persisting",
        stream: true,
      });
    });

    it("falls back to the input conversationId when no turn was prepared yet", async () => {
      const { lifecycle, records, conversationRepository } = harness();
      const supersededBy = new ChatTurnSupersededError("conv_pending", "waiting");

      await lifecycle.recordSupersession(
        { workspaceId: "workspace_1", conversationId: "conv_pending", stream: false },
        null,
        undefined,
        supersededBy,
      );

      expect(records[0].metadata).toMatchObject({
        conversationId: "conv_pending",
        supersededStage: "waiting",
      });
      expect(records[0].metadata.userMessageId).toBeUndefined();
      expect(conversationRepository.touch).not.toHaveBeenCalled();
    });
  });
});
