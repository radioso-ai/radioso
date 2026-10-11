import { randomUUID } from "node:crypto";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { ChatService } from "../../../src/modules/chat/services/chatService.js";
import type { ChatResponse } from "../../../src/modules/chat/types/chatResponses.js";
import type { ChatReviewResult } from "../../../src/modules/chat/types/chatReview.js";
import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import type { TurnSkill } from "../../../src/modules/chat/services/turnOutcome.js";
import type { TurnSelectionStrategy } from "../../../src/modules/chat/services/turnSelectionStrategy.js";
import { ChatTurnSkillSelector } from "../../../src/modules/chat/services/turnSkillSelector.js";
import { HANDOFF_NOTIFY_ACTION_TYPE } from "../../../src/modules/chat/services/routines/contactRoutine.js";
import { RepositoryAgentSkillTurnSkillProvider } from "../../../src/app/composition/builtIn/agentSkillTurnSkillProvider.js";
import type { AgentSkillSpine } from "../../../src/modules/agentSkills/public.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../../src/modules/externalSkills/executor/mcpSkillExecutor.js";
import { SkillExecutorRegistry, type SkillDispatchResult } from "../../../src/modules/skills/public.js";
import { DefaultAllowCapabilityPolicy } from "../../../src/shared/domain/capabilityPolicy.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import {
  resolveSkillEffectPolicy,
  type AnswerTurnExecutionMode,
} from "../../../src/shared/domain/turnExecutionMode.js";
import { resolveContextForTurn } from "../../../src/modules/context-variables/public.js";
import { reviewedDraftWriter } from "../../../src/modules/chat/composition.js";
import {
  applyDeferredDirectiveTransition,
  DeferredDirectiveStateStore,
} from "../../../src/modules/chat/services/directives/deferredDirectiveStateStore.js";
import {
  deferredDirectiveTransitionOf,
  publishedDraftReply,
  reviewedTurnDraft,
} from "../../../src/modules/chat/services/reviewDraft.js";
import { reviewedTurnAuditEvent } from "../../../src/modules/chat/services/reviewTurnAudit.js";
import { createRouteScopedDirectiveSteering } from "../../../src/modules/chat/services/routeScopedDirectiveSteering.js";
import type { Directive, DirectiveFiringState, DirectiveStateStore } from "../../../src/modules/directives/public.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import { createAuditService, InMemoryAuditEventRepository } from "../../support/fakes.js";
import {
  humanOwnedRecord,
  REVIEW_WORKSPACE_ID,
  reviewLifecycleHarness,
  reviewServiceHarness,
  reviewedTurnFixture,
} from "../../support/reviewTurnFixtures.js";

const draftOf = (result: ChatReviewResult) => {
  if (result.kind !== "draft") {
    throw new Error(`expected a draft, got ${result.kind}`);
  }
  return result;
};

describe("ChatService.review", () => {
  it("answers the recorded customer message without recording a message of its own", async () => {
    const harness = await reviewServiceHarness();
    const countBefore = await harness.messageRepository.countByConversationId(REVIEW_WORKSPACE_ID, harness.conversation.id);

    const result = draftOf(await harness.review());

    expect(result.conversationId).toBe(harness.conversation.id);
    expect(result.draft.text).toBe("Yes, reply with the new address and we will update it.");
    expect(await harness.messageRepository.countByConversationId(REVIEW_WORKSPACE_ID, harness.conversation.id))
      .toBe(countBefore);
    const messages = await harness.messageRepository.listByConversationId(REVIEW_WORKSPACE_ID, harness.conversation.id);
    expect(messages.at(-1)?.id).toBe(harness.requestMessage.id);
  });

  it("rejects a message that does not belong to the conversation, before any turn work", async () => {
    const harness = await reviewServiceHarness();

    await expect(harness.review({ existingUserMessageId: randomUUID() })).rejects.toMatchObject({ statusCode: 404 });
    expect(harness.usageLimitPolicy.reserveAnswer).not.toHaveBeenCalled();
    expect(harness.chatGateway.answer).not.toHaveBeenCalled();
  });

  it("neither activates a routine nor resumes a suspended one", async () => {
    const harness = await reviewServiceHarness();

    draftOf(await harness.review());

    expect(harness.routineProvider.forTurn).not.toHaveBeenCalled();
    expect(harness.routineStore.loadActive).not.toHaveBeenCalled();
    expect(harness.suspendedRoutineReader.loadSuspended).not.toHaveBeenCalled();
    expect(harness.routineStore.save).not.toHaveBeenCalled();
  });

  it.each(["port", "fallback"] as const)(
    "writes no assistant row on the %s persistence path and commits the review audit",
    async (persistence) => {
      const harness = await reviewServiceHarness({ persistence });
      const countBefore = await harness.messageRepository.countByConversationId(REVIEW_WORKSPACE_ID, harness.conversation.id);

      draftOf(await harness.review());

      expect(harness.assistantTurnPersistence.completeAssistantTurn).not.toHaveBeenCalled();
      expect(await harness.messageRepository.countByConversationId(REVIEW_WORKSPACE_ID, harness.conversation.id))
        .toBe(countBefore);
      const answered = harness.auditRepository.items.filter((event) => event.eventType === "chat.answer");
      expect(answered).toHaveLength(1);
      expect(answered[0]).toMatchObject({
        eventStatus: "success",
        metadata: {
          executionMode: "review",
          surface: "email",
          conversationId: harness.conversation.id,
          requestMessageId: harness.requestMessage.id,
          userMessageId: harness.requestMessage.id,
        },
      });
      expect(answered[0].metadata).toHaveProperty("turnId", expect.any(String));
      expect(answered[0].metadata).not.toHaveProperty("assistantMessageId");
    },
  );

  it("returns human_owned on a human-owned conversation without generating the waiting line", async () => {
    const harness = await reviewServiceHarness();
    vi.mocked(harness.conversationOwnershipReader.load).mockResolvedValue(humanOwnedRecord(harness.conversation.id, 7));

    const result = await harness.review();

    expect(result).toEqual({ kind: "human_owned", conversationId: harness.conversation.id, ownershipVersion: 7 });
    expect(harness.handoffWaitingMessageGenerator.generate).not.toHaveBeenCalled();
    expect(harness.chatGateway.answer).not.toHaveBeenCalled();
    expect(harness.reservation.release).toHaveBeenCalledOnce();
    expect(harness.reservation.commit).not.toHaveBeenCalled();
  });

  it("binds the draft to the ownership version the turn read", async () => {
    const harness = await reviewServiceHarness();

    const result = draftOf(await harness.review());

    expect(result.ownershipVersion).toBe(3);
    expect(harness.conversationOwnershipReader.load).toHaveBeenCalledWith(harness.conversation.id);
  });

  it("reads ownership version 0 while the conversation has no ownership row", async () => {
    const harness = await reviewServiceHarness({ ownership: null });

    expect(draftOf(await harness.review()).ownershipVersion).toBe(0);
  });

  it("bounds the history the turn reads to the window", async () => {
    const harness = await reviewServiceHarness({ earlierMessages: 6 });

    draftOf(await harness.review({ maxMessages: 2 }));

    expect(harness.gatewayHistories).toEqual([2]);
  });

  it("reserves usage as a conversation reply on the conversation's channel and commits it", async () => {
    const harness = await reviewServiceHarness();

    draftOf(await harness.review());

    expect(harness.usageLimitPolicy.reserveAnswer).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: REVIEW_WORKSPACE_ID,
      usage: "conversation_reply",
      surface: "email",
      conversationId: harness.conversation.id,
    }));
    expect(harness.reservation.commit).toHaveBeenCalledOnce();
  });

  it("returns the effects the turn's skill runtime suppressed", async () => {
    const harness = await reviewServiceHarness({
      agentSkillTurnSkillProvider: {
        forSession: vi.fn(async () => ({
          turnSkills: [],
          agenticRetrievalToolFactories: () => [],
          skillStates: new Map(),
          suppressedEffects: () => [
            { skillName: "order_lookup", site: "turn" as const },
            { skillName: "grounded_search", site: "staged_tool" as const },
          ],
        })),
      },
    });

    const result = draftOf(await harness.review());

    expect(result.facts.suppressedEffects).toEqual([
      { skillName: "order_lookup", site: "turn" },
      { skillName: "grounded_search", site: "staged_tool" },
    ]);
  });

  it("never lets answer() run a review turn or observe a draft", () => {
    type AnswerInput = Parameters<ChatService["answer"]>[0];
    expectTypeOf<AnswerInput["executionMode"]>().toEqualTypeOf<AnswerTurnExecutionMode | undefined>();
    expectTypeOf<"review">().not.toMatchTypeOf<NonNullable<AnswerInput["executionMode"]>>();
    expectTypeOf<Awaited<ReturnType<ChatService["answer"]>>>().toEqualTypeOf<ChatResponse>();
    expectTypeOf<ChatResponse>().not.toMatchTypeOf<{ kind: "draft" }>();
    expectTypeOf<Awaited<ReturnType<ChatService["review"]>>>().toEqualTypeOf<ChatReviewResult>();
  });
});

describe("review completion in the turn lifecycle", () => {
  const session = (): PreparedSession =>
    ({
      agent: { id: "agent-review", name: "Support", chatModelOverride: null },
      conversation: { id: "conversation-review", sourceChannel: "email" },
      history: [],
      userMessage: { id: "request-message", content: "Where is my order?" },
      turnRoute: "retrieval",
      directiveSteering: { rules: [], matches: [], omissions: [] },
      stagedContext: [],
      resolvedContext: resolveContextForTurn(null),
      retrieval: {
        contexts: [],
        diagnostics: {},
        systemPrompt: undefined,
        trace: { traceId: "trace-review", startedAt: "2026-10-01T09:00:00.000Z", stages: [], links: [] },
      },
      answerCoverageDebug: {
        availability: "assessed",
        coverage: "answered",
        reason: "sufficient_evidence",
        originatingTurnId: "request-message",
        originatingRequestId: "request-message",
      },
    } as unknown as PreparedSession);

  const presentation = {
    answer: "Your order ships tomorrow.",
    skillName: "retrieval.answer",
    skillOutcome: "grounded",
    skillStatus: "completed" as const,
    answerOutcome: "grounded_success" as const,
    citations: [{ chunkId: "chunk-1", documentId: "doc-1", title: "Shipping" }],
  };

  const handoffNotify = {
    type: HANDOFF_NOTIFY_ACTION_TYPE,
    payload: { conversationId: "conversation-review", reason: "retrieval_miss" },
  };

  it.each(["port", "fallback"] as const)(
    "returns a draft correlated on the request and the turn, writing no reply on the %s path",
    async (path) => {
      const harness = reviewLifecycleHarness();

      const completed = await harness.lifecycle(path).completeAssistantTurn({
        workspaceId: REVIEW_WORKSPACE_ID,
        requestReceivedAt: Date.now(),
        session: session(),
        presentation,
        answerStartedAt: Date.now(),
        stream: false,
        executionMode: "review",
      });

      if (completed.kind !== "draft") {
        throw new Error("expected a draft completion");
      }
      expect(completed.correlation).toEqual({ requestMessageId: "request-message", turnId: expect.any(String) });
      expect(completed.draft.text).toBe("Your order ships tomorrow.");
      expect(completed.draft.presentation).toMatchObject({
        skillName: "retrieval.answer",
        skillOutcome: "grounded",
        skillStatus: "completed",
      });
      expect(completed.draft.presentation).not.toHaveProperty("id");
      expect(completed.postCommitReceipt.changeKinds).toEqual([]);
      expect(harness.persistence.completeAssistantTurn).not.toHaveBeenCalled();
      expect(harness.messageRepository.create).not.toHaveBeenCalled();
      expect(harness.conversationRepository.touch).not.toHaveBeenCalled();
    },
  );

  it("commits the coverage record with the review audit, both keyed on the request message", async () => {
    const harness = reviewLifecycleHarness();

    const completed = await harness.lifecycle("port").completeAssistantTurn({
      workspaceId: REVIEW_WORKSPACE_ID,
      requestReceivedAt: Date.now(),
      session: session(),
      presentation,
      answerStartedAt: Date.now(),
      stream: false,
      executionMode: "review",
    });

    if (completed.kind !== "draft") {
      throw new Error("expected a draft completion");
    }
    expect(completed.facts.answerCoverage).toMatchObject({
      availability: "assessed",
      coverage: "answered",
      originatingRequestId: "request-message",
    });
    expect(harness.audit.record).toHaveBeenCalledOnce();
    expect(harness.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: expect.objectContaining({
        executionMode: "review",
        surface: "email",
        requestMessageId: "request-message",
        turnId: completed.correlation.turnId,
        citationCount: 1,
      }),
    }));
    const [[auditEvent]] = harness.audit.record.mock.calls as unknown as [[{ metadata: Record<string, unknown> }]];
    expect(auditEvent.metadata).not.toHaveProperty("assistantMessageId");
  });

  it("reports the hand-off, leaves ownership unchanged, and drops the turn's actions", async () => {
    const harness = reviewLifecycleHarness();

    const completed = await harness.lifecycle("fallback").completeAssistantTurn({
      workspaceId: REVIEW_WORKSPACE_ID,
      requestReceivedAt: Date.now(),
      session: session(),
      presentation: { ...presentation, skillOutcome: "no_context", answerOutcome: "no_context_refusal" },
      answerStartedAt: Date.now(),
      stream: false,
      executionMode: "review",
      ownershipHandoff: { reason: "retrieval_miss" },
      actions: [handoffNotify],
    });

    if (completed.kind !== "draft") {
      throw new Error("expected a draft completion");
    }
    expect(completed.facts.ownershipHandoffSignal).toEqual({ reason: "retrieval_miss" });
    expect(harness.ownershipRepository.requestHandoff).not.toHaveBeenCalled();
    expect(harness.actionOutbox.enqueue).not.toHaveBeenCalled();
    expect(harness.audit.record).toHaveBeenCalledOnce();
    expect(harness.audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: "hitl.ownership" }));
    expect(completed.postCommitReceipt.changeKinds).toEqual([]);
  });

  it("drops the turn's actions on the persistence-port path too", async () => {
    const harness = reviewLifecycleHarness();

    await harness.lifecycle("port").completeAssistantTurn({
      workspaceId: REVIEW_WORKSPACE_ID,
      requestReceivedAt: Date.now(),
      session: session(),
      presentation,
      answerStartedAt: Date.now(),
      stream: false,
      executionMode: "review",
      ownershipHandoff: { reason: "retrieval_miss" },
      actions: [handoffNotify],
    });

    expect(harness.persistence.completeAssistantTurn).not.toHaveBeenCalled();
    expect(harness.actionOutbox.enqueue).not.toHaveBeenCalled();
    expect(harness.ownershipRepository.requestHandoff).not.toHaveBeenCalled();
  });

  it("carries the suppressed effects into the turn facts", async () => {
    const result = draftOf(await reviewedTurnFixture({
      suppressedEffects: [
        { skillName: "order_lookup", site: "turn" },
        { skillName: "grounded_search", site: "staged_tool" },
      ],
    }));

    expect(result.facts.suppressedEffects).toEqual([
      { skillName: "order_lookup", site: "turn" },
      { skillName: "grounded_search", site: "staged_tool" },
    ]);
  });

  it("returns no draft when the turn wrote no text or could not reach the model", async () => {
    const blank = await reviewedTurnFixture({ presentation: { answer: "  \n" } });
    const unavailable = await reviewedTurnFixture({
      presentation: {
        answer: "I can't respond right now.",
        skillOutcome: "unavailable",
        skillStatus: "failed",
        answerOutcome: undefined,
      },
    });

    expect(blank).toMatchObject({ kind: "no_draft", ownershipVersion: 1 });
    expect(blank).not.toHaveProperty("draft");
    expect(unavailable).toMatchObject({ kind: "no_draft", facts: { skillOutcome: "unavailable" } });
  });

  describe("the review audit (FR-045)", () => {
    // Content a review meets: the customer's mail, what retrieval made of it, and the unapproved draft.
    const CUSTOMER = "SENTINEL-customer-mail-c41";
    const QUERY = "SENTINEL-rewritten-query-q52";
    const DRAFT = "SENTINEL-draft-text-d63";
    const SEGMENT = "SENTINEL-answer-segment-s74";
    const SUGGESTION = "SENTINEL-suggestion-g85";
    const CITED = "SENTINEL-cited-title-t96";
    const PROVIDER = "SENTINEL-provider-error-e07";
    const SENTINELS = [CUSTOMER, QUERY, DRAFT, SEGMENT, SUGGESTION, CITED, PROVIDER];

    const expectContentFree = (value: unknown): void => {
      const serialized = JSON.stringify(value);
      for (const sentinel of SENTINELS) {
        expect(serialized).not.toContain(sentinel);
      }
    };

    const contentfulSession = (): PreparedSession => {
      const base = session();
      return {
        ...base,
        userMessage: { id: "request-message", content: CUSTOMER },
        effectiveQuery: CUSTOMER,
        retrieval: {
          ...base.retrieval,
          contexts: [{ chunkId: "chunk-1", documentId: "doc-1", title: CITED, content: CITED }],
          diagnostics: {
            rewrittenQuery: QUERY,
            rewriteStatus: "rewritten",
            parsedQuery: { semanticQuery: QUERY, lexicalQuery: QUERY, constraints: [] },
          },
          trace: {
            traceId: "trace-review",
            startedAt: "2026-10-01T09:00:00.000Z",
            stages: [{ id: "rewrite", kind: "rewrite", status: "completed", inputs: { query: CUSTOMER }, outputs: { query: QUERY } }],
            links: [],
          },
        },
      } as unknown as PreparedSession;
    };

    const contentfulPresentation = {
      ...presentation,
      answer: DRAFT,
      answerSegments: [{ text: SEGMENT, citationIndexes: [1] }],
      suggestions: [{ text: SUGGESTION }],
      citations: [{ chunkId: "chunk-1", documentId: "doc-1", title: CITED, snippet: CITED }],
      grounding: "grounded" as const,
      groundingDiagnostics: {
        parseStatus: "parsed",
        claimCount: 2,
        sourcedClaimCount: 2,
        unsourcedClaimCount: 0,
        invalidSourceCount: 0,
        assertionMismatch: false,
      },
    } as unknown as typeof presentation;

    const recordedAudits = (harness: ReturnType<typeof reviewLifecycleHarness>) =>
      (harness.audit.record.mock.calls as unknown as [{ eventStatus: string; metadata: Record<string, unknown> }][])
        .map(([event]) => event);

    it.each(["port", "fallback"] as const)(
      "keeps a successful review's audit to identifiers, outcome codes and counts on the %s path",
      async (path) => {
        const harness = reviewLifecycleHarness();

        const completed = await harness.lifecycle(path).completeAssistantTurn({
          workspaceId: REVIEW_WORKSPACE_ID,
          requestReceivedAt: Date.now(),
          session: contentfulSession(),
          presentation: contentfulPresentation,
          answerStartedAt: Date.now(),
          stream: false,
          executionMode: "review",
        });

        if (completed.kind !== "draft") {
          throw new Error("expected a draft completion");
        }
        // The draft itself keeps its text: it is the held reply's, not the audit's.
        expect(completed.draft.text).toBe(DRAFT);
        const [audit] = recordedAudits(harness);
        expectContentFree(audit);
        expect(audit.metadata).toEqual({
          workflow: "chat.turn",
          executionClass: expect.any(String),
          executionMode: "review",
          surface: "email",
          conversationId: "conversation-review",
          userMessageId: "request-message",
          requestMessageId: "request-message",
          turnId: completed.correlation.turnId,
          stream: false,
          skillTurn: { skillName: "retrieval.answer", outcome: "grounded", status: "completed" },
          answerOutcome: "grounded_success",
          route: expect.objectContaining({ generator: "assistant", routeType: expect.any(String), retrievalInvoked: expect.any(Boolean) }),
          citationCount: 1,
          groundingVerdict: "grounded",
          groundingDiagnostics: {
            parseStatus: "parsed",
            claimCount: 2,
            sourcedClaimCount: 2,
            unsourcedClaimCount: 0,
            invalidSourceCount: 0,
            assertionMismatch: false,
          },
        });
      },
    );

    it("keeps a failed review's audit to identifiers and an error code, never the error's message", async () => {
      const harness = reviewLifecycleHarness();
      const lifecycle = harness.lifecycle("port");

      await lifecycle.recordFailure(
        { workspaceId: REVIEW_WORKSPACE_ID, conversationId: "conversation-review", stream: false, executionMode: "review" },
        contentfulSession(),
        undefined,
        new Error(`The provider rejected: ${PROVIDER} ${CUSTOMER}`),
      );
      await lifecycle.recordFailure(
        { workspaceId: REVIEW_WORKSPACE_ID, conversationId: "conversation-review", stream: false, executionMode: "review" },
        contentfulSession(),
        undefined,
        new AppError(503, "service_unavailable", `Model unavailable for ${CUSTOMER}`),
      );

      const [plain, coded] = recordedAudits(harness);
      expectContentFree([plain, coded]);
      expect(plain).toMatchObject({ eventStatus: "failure" });
      expect(plain.metadata).toEqual({
        stage: "chat.answer",
        workflow: "chat.turn",
        executionClass: expect.any(String),
        executionMode: "review",
        surface: "email",
        conversationId: "conversation-review",
        userMessageId: "request-message",
        stream: false,
        citationCount: 0,
        errorCode: "Error",
      });
      expect(coded.metadata).toMatchObject({ errorCode: "service_unavailable" });
      expect(coded.metadata).not.toHaveProperty("errorMessage");
    });

    it("keeps a live turn's failure audit as it was, message included", async () => {
      const harness = reviewLifecycleHarness();

      await harness.lifecycle("port").recordFailure(
        { workspaceId: REVIEW_WORKSPACE_ID, conversationId: "conversation-review", stream: false },
        session(),
        undefined,
        new Error("Live failure"),
      );

      const [audit] = recordedAudits(harness);
      expect(audit.metadata).toMatchObject({ errorMessage: "Live failure" });
    });

    it("stores no content for a review whatever the audit it is handed carries", async () => {
      const auditRepository = new InMemoryAuditEventRepository();

      await createAuditService(auditRepository).record(reviewedTurnAuditEvent({
        workspaceId: REVIEW_WORKSPACE_ID,
        eventType: "chat.answer",
        eventStatus: "success",
        metadata: {
          executionMode: "review",
          conversationId: "conversation-review",
          userMessageId: "request-message",
          assistantMessageId: "turn-1",
          citationCount: 1,
          citations: [{ title: CITED }],
          answerSegments: [{ text: SEGMENT }],
          activityTrace: { outcome: { answer: DRAFT } },
          turnTrace: { answer: { text: DRAFT } },
          error: { message: QUERY },
          rewriteContinuityState: { lastQuery: QUERY },
          // An allowlisted name never carries what its kind does not allow.
          answerOutcome: { text: DRAFT },
          route: { routeType: "retrieval", routeReason: "evidence_required", extra: DRAFT },
        },
      }, { requestMessageId: "request-message", turnId: "turn-1" }));

      expect(auditRepository.items).toHaveLength(1);
      expectContentFree(auditRepository.items);
      expect(auditRepository.items[0].metadata).toEqual({
        executionMode: "review",
        conversationId: "conversation-review",
        userMessageId: "request-message",
        requestMessageId: "request-message",
        turnId: "turn-1",
        citationCount: 1,
        route: { routeType: "retrieval", routeReason: "evidence_required" },
      });
    });
  });

  it("keeps a hand-off turn's text as a draft, with the hand-off reported", async () => {
    const result = draftOf(await reviewedTurnFixture({
      presentation: { answer: "Let me get a teammate.", skillOutcome: "no_context", answerOutcome: "no_context_refusal" },
      ownershipHandoff: { reason: "retrieval_miss" },
    }));

    expect(result.facts.ownershipHandoffSignal).toEqual({ reason: "retrieval_miss" });
    expect(result.draft.text).toBe("Let me get a teammate.");
  });
});

describe("publishing a review draft", () => {
  const reply = {
    id: "reply-unwritten",
    conversationId: "conversation-review",
    workspaceId: REVIEW_WORKSPACE_ID,
    role: "assistant" as const,
    content: "Your order ships tomorrow.",
    skillName: "retrieval.answer",
    skillOutcome: "grounded",
    skillStatus: "completed",
    totalLatencyMs: 812,
    grounding: { verdict: "grounded" as const, claimCount: 2, sourcedClaimCount: 2, unsourcedClaimCount: 0, invalidSourceCount: 0 },
    metadata: { skillTurn: { outcome: "grounded" }, citations: [{ chunkId: "chunk-1", documentId: "doc-1" }] },
  };

  it("writes the reply row the turn would have written, from a draft that was stored in between", () => {
    const stored = JSON.parse(JSON.stringify(reviewedTurnDraft(reply, null))) as ReturnType<typeof reviewedTurnDraft>;

    const { id: _unwritten, ...expected } = reply;
    expect(publishedDraftReply({ workspaceId: REVIEW_WORKSPACE_ID, conversationId: "conversation-review", draft: stored }))
      .toEqual(expected);
  });

  it("leaves unset what no longer reads as its column", () => {
    const published = publishedDraftReply({
      workspaceId: REVIEW_WORKSPACE_ID,
      conversationId: "conversation-review",
      draft: {
        text: "Hello",
        presentation: { skillName: 7, totalLatencyMs: "fast", grounding: { verdict: "certain", claimCount: 1 }, metadata: ["not", "a", "map"] },
      },
    });

    expect(published).toEqual({
      conversationId: "conversation-review",
      workspaceId: REVIEW_WORKSPACE_ID,
      role: "assistant",
      content: "Hello",
      skillName: undefined,
      skillOutcome: undefined,
      skillStatus: undefined,
      totalLatencyMs: undefined,
      grounding: undefined,
      metadata: undefined,
    });
  });
});

describe("a reviewed reply's directive lifecycle", () => {
  const disclosure: Directive = {
    name: "ai-disclosure",
    condition: { kind: "always" },
    action: "Mention once that this reply was drafted by an AI assistant.",
    lifecycle: { kind: "once_per_conversation" },
  };

  /** One conversation's directive firing memory, as the durable store keeps it. */
  const firingMemory = (initial: Record<string, DirectiveFiringState> = {}) => {
    const states = new Map(Object.entries(initial));
    const store = {
      load: vi.fn(async ({ sessionId }: { sessionId: string }) => states.get(sessionId) ?? null),
      save: vi.fn(async ({ sessionId, state }: { sessionId: string; state: DirectiveFiringState }) => {
        states.set(sessionId, state);
      }),
    } satisfies DirectiveStateStore;
    return { states, store };
  };

  const transitionOf = (result: ChatReviewResult) => deferredDirectiveTransitionOf(draftOf(result).draft);

  const sessionWithStore = (store: DeferredDirectiveStateStore): PreparedSession =>
    ({
      agent: { id: "agent-review", name: "Support", chatModelOverride: null },
      conversation: { id: "conversation-review", sourceChannel: "email" },
      history: [],
      userMessage: { id: "request-message", content: "Where is my order?" },
      turnRoute: "retrieval",
      directiveSteering: { rules: [], matches: [], omissions: [] },
      directiveStateStore: store,
      stagedContext: [],
      resolvedContext: resolveContextForTurn(null),
      retrieval: {
        contexts: [],
        diagnostics: {},
        systemPrompt: undefined,
        trace: { traceId: "trace-review", startedAt: "2026-10-01T09:00:00.000Z", stages: [], links: [] },
      },
    }) as unknown as PreparedSession;

  const completeReview = async (store: DeferredDirectiveStateStore) => {
    const completed = await reviewLifecycleHarness().lifecycle("port").completeAssistantTurn({
      workspaceId: REVIEW_WORKSPACE_ID,
      requestReceivedAt: Date.now(),
      session: sessionWithStore(store),
      presentation: {
        answer: "Your order ships tomorrow.",
        skillName: "retrieval.answer",
        skillOutcome: "grounded",
        skillStatus: "completed",
        answerOutcome: "grounded_success",
        citations: [],
      },
      answerStartedAt: Date.now(),
      stream: false,
      executionMode: "review",
    });
    if (completed.kind !== "draft") {
      throw new Error("expected a draft completion");
    }
    return completed;
  };

  it("defers the firing memory advance with the draft instead of committing it", async () => {
    const memory = firingMemory({ "conversation-review": { turnSeq: 4, firings: { greeting: { lastFiredTurn: 1, count: 1 } } } });
    const store = new DeferredDirectiveStateStore(memory.store, "conversation-review");
    await store.load();
    store.capture(["ai-disclosure"]);

    const completed = await completeReview(store);

    expect(deferredDirectiveTransitionOf(completed.draft)).toEqual({ fromTurnSeq: 4, firedNames: ["ai-disclosure"] });
    expect(memory.store.save).not.toHaveBeenCalled();
  });

  it("defers a turn that fired nothing on a conversation with memory, so cooldowns still age on publication", async () => {
    const memory = firingMemory({ "conversation-review": { turnSeq: 2, firings: {} } });
    const store = new DeferredDirectiveStateStore(memory.store, "conversation-review");
    await store.load();

    const completed = await completeReview(store);

    expect(deferredDirectiveTransitionOf(completed.draft)).toEqual({ fromTurnSeq: 2, firedNames: [] });
  });

  it("defers nothing when the turn would have committed nothing", async () => {
    const unread = new DeferredDirectiveStateStore(firingMemory().store, "conversation-review");
    const readEmpty = new DeferredDirectiveStateStore(firingMemory().store, "conversation-review");
    await readEmpty.load();

    expect(deferredDirectiveTransitionOf((await completeReview(unread)).draft)).toBeNull();
    expect(deferredDirectiveTransitionOf((await completeReview(readEmpty)).draft)).toBeNull();
  });

  it("applies a stored transition once, from the memory the turn read", async () => {
    const memory = firingMemory({ c1: { turnSeq: 4, firings: {} } });
    const transition = { fromTurnSeq: 4, firedNames: ["ai-disclosure"] };

    expect(await applyDeferredDirectiveTransition(memory.store, "c1", transition)).toBe(true);
    expect(await applyDeferredDirectiveTransition(memory.store, "c1", transition)).toBe(false);

    expect(memory.store.save).toHaveBeenCalledOnce();
    expect(memory.states.get("c1")).toEqual({ turnSeq: 5, firings: { "ai-disclosure": { lastFiredTurn: 4, count: 1 } } });
  });

  it("leaves memory a later turn advanced, and restarts expired memory from the turn the review read", async () => {
    const memory = firingMemory({ moved: { turnSeq: 6, firings: {} } });

    expect(await applyDeferredDirectiveTransition(memory.store, "moved", { fromTurnSeq: 4, firedNames: ["ai-disclosure"] })).toBe(false);
    expect(await applyDeferredDirectiveTransition(memory.store, "expired", { fromTurnSeq: 4, firedNames: ["ai-disclosure"] })).toBe(true);
    expect(await applyDeferredDirectiveTransition(memory.store, "expired", { fromTurnSeq: 4, firedNames: ["ai-disclosure"] })).toBe(false);

    expect(memory.states.get("moved")).toEqual({ turnSeq: 6, firings: {} });
    expect(memory.states.get("expired")).toEqual({ turnSeq: 5, firings: { "ai-disclosure": { lastFiredTurn: 4, count: 1 } } });
  });

  it("publishes a draft as the reply row and its deferred transition, read back from storage", async () => {
    const memory = firingMemory();
    const messages = { create: vi.fn(async (input: { content: string }) => ({ id: "published-message", ...input })) };
    const stored = JSON.parse(JSON.stringify(reviewedTurnDraft(
      { conversationId: "c1", workspaceId: REVIEW_WORKSPACE_ID, role: "assistant", content: "Your order ships tomorrow." },
      { fromTurnSeq: 0, firedNames: ["ai-disclosure"] },
    ))) as ReturnType<typeof reviewedTurnDraft>;

    const message = await reviewedDraftWriter({ messages: messages as never, directiveStates: memory.store })
      .writeAgentMessage({ workspaceId: REVIEW_WORKSPACE_ID, conversationId: "c1", draft: stored });

    expect(message.id).toBe("published-message");
    // The transition rides with the draft, never into the reply row.
    expect(messages.create).toHaveBeenCalledWith(publishedDraftReply({ workspaceId: REVIEW_WORKSPACE_ID, conversationId: "c1", draft: stored }));
    expect(JSON.stringify(messages.create.mock.calls)).not.toContain("ai-disclosure");
    expect(memory.states.get("c1")).toEqual({ turnSeq: 1, firings: { "ai-disclosure": { lastFiredTurn: 0, count: 1 } } });
  });

  it("publishes a draft with no transition, or one that no longer reads as one, without touching the memory", async () => {
    const memory = firingMemory();
    const messages = { create: vi.fn(async () => ({ id: "published-message" })) };
    const writer = reviewedDraftWriter({ messages: messages as never, directiveStates: memory.store });

    await writer.writeAgentMessage({ workspaceId: REVIEW_WORKSPACE_ID, conversationId: "c1", draft: { text: "Hi", presentation: {} } });
    await writer.writeAgentMessage({
      workspaceId: REVIEW_WORKSPACE_ID,
      conversationId: "c1",
      draft: { text: "Hi", presentation: { directiveTransition: { fromTurnSeq: "4", firedNames: ["ai-disclosure"] } } },
    });
    await writer.writeAgentMessage({
      workspaceId: REVIEW_WORKSPACE_ID,
      conversationId: "c1",
      draft: { text: "Hi", presentation: { directiveTransition: { fromTurnSeq: 4, firedNames: [7] } } },
    });

    expect(messages.create).toHaveBeenCalledTimes(3);
    expect(memory.store.load).not.toHaveBeenCalled();
    expect(memory.store.save).not.toHaveBeenCalled();
  });

  describe("across two reviews of one conversation", () => {
    const twoReviewHarness = async () => {
      const memory = firingMemory();
      const harness = await reviewServiceHarness({
        directiveSteering: createRouteScopedDirectiveSteering({
          capabilityPolicy: new DefaultAllowCapabilityPolicy(),
          registrations: [{ directive: disclosure }],
        }),
        directiveStateStore: memory.store,
      });
      const nextMessage = () => harness.messageRepository.create({
        conversationId: harness.conversation.id,
        workspaceId: REVIEW_WORKSPACE_ID,
        role: "user",
        content: "And can I also change the delivery date?",
      });
      const publish = (result: ChatReviewResult) =>
        reviewedDraftWriter({ messages: harness.messageRepository, directiveStates: memory.store }).writeAgentMessage({
          workspaceId: REVIEW_WORKSPACE_ID,
          conversationId: harness.conversation.id,
          draft: draftOf(result).draft,
        });
      const steeredWithDisclosure = (call: number) =>
        JSON.stringify(vi.mocked(harness.chatGateway.answer).mock.calls[call]).includes(disclosure.action);
      return { harness, memory, nextMessage, publish, steeredWithDisclosure };
    };

    it("does not fire a once-per-conversation directive again after its review was published", async () => {
      const { harness, memory, nextMessage, publish, steeredWithDisclosure } = await twoReviewHarness();

      const first = await harness.review();
      expect(transitionOf(first)).toEqual({ fromTurnSeq: 0, firedNames: ["ai-disclosure"] });
      expect(steeredWithDisclosure(0)).toBe(true);
      expect(memory.store.save).not.toHaveBeenCalled();

      await publish(first);
      const second = await harness.review({ existingUserMessageId: (await nextMessage()).id });

      expect(transitionOf(second)).toEqual({ fromTurnSeq: 1, firedNames: [] });
      expect(steeredWithDisclosure(1)).toBe(false);
    });

    it("fires it again when the earlier review was never published: discarded, superseded or sent as a teammate's edit", async () => {
      const { harness, memory, nextMessage, steeredWithDisclosure } = await twoReviewHarness();

      await harness.review();
      const second = await harness.review({ existingUserMessageId: (await nextMessage()).id });

      expect(transitionOf(second)).toEqual({ fromTurnSeq: 0, firedNames: ["ai-disclosure"] });
      expect(steeredWithDisclosure(1)).toBe(true);
      expect(memory.store.save).not.toHaveBeenCalled();
    });

    it("advances the memory once when the same draft is published twice", async () => {
      const { harness, memory, publish } = await twoReviewHarness();

      const first = await harness.review();
      await publish(first);
      await publish(first);

      expect(memory.store.save).toHaveBeenCalledOnce();
      expect(memory.states.get(harness.conversation.id)).toEqual({
        turnSeq: 1,
        firings: { "ai-disclosure": { lastFiredTurn: 0, count: 1 } },
      });
    });
  });
});

describe("skill effects suppressed by a review turn", () => {
  const workspaceId = randomUUID();
  const agentId = randomUUID();

  const agentSkill = (skillName: string, overrides: Partial<AgentSkillSpine> = {}): AgentSkillSpine => ({
    id: randomUUID(),
    workspaceId,
    agentId,
    skillName,
    kind: "external_mcp",
    invocationMode: "agent_selectable",
    enabled: true,
    targetType: "mcp_connection",
    targetId: randomUUID(),
    config: {},
    createdAt: new Date("2026-10-01T09:00:00.000Z"),
    updatedAt: new Date("2026-10-01T09:00:00.000Z"),
    ...overrides,
  });

  // A retrieve binding whose execution points at an external executor: the staged-tool shape suppression applies to.
  const externallyExecutedRetrieveSkill = (skillName: string) => agentSkill(skillName, {
    kind: "retrieve",
    targetType: null,
    targetId: null,
    config: { execution: { kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER, enqueue: false } },
  });

  const reviewSession = (skillName: string): PreparedSession =>
    ({
      agent: {
        id: agentId,
        workspaceId,
        name: "Support agent",
        customInstruction: "",
        chatModelOverride: null,
        retrievalEnabled: true,
        skillSettings: {},
      },
      conversation: { id: randomUUID(), workspaceId },
      history: [],
      userMessage: { id: randomUUID(), content: "Where is order 123?" },
      effectiveQuery: "Where is order 123?",
      pageContext: null,
      resolvedContext: { snapshot: {}, fragments: [], renderFragments: [], staged: [] },
      stagedContext: [],
      turnTrace: { events: [] },
      executionMode: "review",
      skillEffects: resolveSkillEffectPolicy("review", "allowed"),
      directiveSteering: {
        rules: [{ action: "Look up the order.", source: "directive", lifespan: "response" }],
        omissions: [],
        matches: [{
          directive: {
            name: "order-status",
            condition: { kind: "always" },
            action: "Look up the order.",
            binding: { kind: "skill", skillName },
          },
          selectionMode: "deterministic",
          selectionReason: "always",
        }],
      },
    }) as unknown as PreparedSession;

  const defaultTurnSkill: TurnSkill = {
    definition: { name: "retrieval.answer", outcomeKinds: ["retrieval"] },
    selects: () => true,
    dispatch: () => {
      throw new Error("default dispatch not used");
    },
    renderer: {
      supports: () => false,
      render: async () => {
        throw new Error("default render not used");
      },
    },
  };

  const strategy: TurnSelectionStrategy = { select: () => ["retrieval"] };

  it("records both suppression sites with the review reason and the mode-labelled counter", async () => {
    const dispatch = vi.fn(async (): Promise<SkillDispatchResult> => ({
      disposition: "settled",
      outcome: { status: "completed", answer: "escaped" },
    }));
    const metricsRegistry = new MetricsRegistry();
    const provider = new RepositoryAgentSkillTurnSkillProvider({
      agentSkills: { listByAgent: vi.fn(async () => [agentSkill("order_lookup"), externallyExecutedRetrieveSkill("grounded_search")]) },
      executorRegistry: new SkillExecutorRegistry([{ kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER, executor: { dispatch } }]),
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
      metricsRegistry,
    });
    const turnSession = reviewSession("order_lookup");
    const stagedSession = reviewSession("grounded_search");

    const turnRuntime = await provider.forSession(turnSession);
    const outcome = await new ChatTurnSkillSelector(
      [defaultTurnSkill, ...turnRuntime.turnSkills],
      strategy,
      { agentSkillStates: turnRuntime.skillStates },
    ).select(turnSession).skill.dispatch(turnSession);
    const stagedRuntime = await provider.forSession(stagedSession);
    const stagedOutput = await stagedRuntime.agenticRetrievalToolFactories(stagedSession)
      .flatMap((factory) => factory({ registry: { record: vi.fn(), resolve: vi.fn(), has: vi.fn() }, snippetChars: 48 }))[0]
      .invoke({ query: "order 123" }, { signal: new AbortController().signal, stepIndex: 0, callId: "call-1" });

    expect(dispatch).not.toHaveBeenCalled();
    expect(turnRuntime.suppressedEffects()).toEqual([{ skillName: "order_lookup", site: "turn" }]);
    expect(stagedRuntime.suppressedEffects()).toEqual([{ skillName: "grounded_search", site: "staged_tool" }]);
    expect(outcome).toMatchObject({
      outcome: { status: "failed", outputs: { skill: "order_lookup", reason: "suppressed_for_review" } },
    });
    expect(stagedOutput).toMatchObject({ ok: false, error: "suppressed_for_review" });
    const metrics = metricsRegistry.renderPrometheus();
    expect(metrics).toContain('agent_skill_effect_suppressed_total{mode="review",site="turn"} 1');
    expect(metrics).toContain('agent_skill_effect_suppressed_total{mode="review",site="staged_tool"} 1');
    // The safe-test counter keeps counting safe-test suppressions only.
    expect(metrics).not.toContain("agent_skill_safe_test_dispatch_total");
  });

  it("labels a safe-test suppression with its mode on the new counter and keeps the safe-test reason", async () => {
    const metricsRegistry = new MetricsRegistry();
    const provider = new RepositoryAgentSkillTurnSkillProvider({
      agentSkills: { listByAgent: vi.fn(async () => [agentSkill("order_lookup")]) },
      executorRegistry: new SkillExecutorRegistry([]),
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
      metricsRegistry,
    });
    const session = {
      ...reviewSession("order_lookup"),
      executionMode: "safe_test",
      skillEffects: resolveSkillEffectPolicy("safe_test"),
    } as PreparedSession;

    const runtime = await provider.forSession(session);
    const outcome = await new ChatTurnSkillSelector(
      [defaultTurnSkill, ...runtime.turnSkills],
      strategy,
      { agentSkillStates: runtime.skillStates },
    ).select(session).skill.dispatch(session);

    expect(outcome).toMatchObject({ outcome: { outputs: { reason: "suppressed_for_safe_test" } } });
    expect(metricsRegistry.renderPrometheus()).toContain('agent_skill_effect_suppressed_total{mode="safe_test",site="turn"} 1');
  });
});
