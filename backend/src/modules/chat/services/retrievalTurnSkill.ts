import type { ChatGateway } from "../contracts/chatGateway.js";
import { ChatAnswerPresenter, type ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { BlankChatAnswerError } from "./chatAnswerErrors.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import { buildConversationIntentSnapshot } from "./conversationIntentSnapshot.js";
import {
  GroundedAnswerEnvelopeReader,
  parseGroundedAnswerEnvelope,
  type GroundedAnswerEnvelope,
  type PlannedEnvelopeSuggestion,
} from "./groundedAnswerEnvelope.js";
import { CitationAnchorSanitizer } from "./citationAnchorSanitizer.js";
import { composeGroundedAnswerSystemPrompt } from "./groundedAnswerPromptComposer.js";
import type { FallbackReplyComposer } from "./fallbackReplyComposer.js";
import { buildPreparedTurnOutcome } from "./preparedTurnOutcome.js";
import { DEFAULT_SUGGESTED_QUESTIONS_COUNT } from "../../settings/contracts/retrieval.js";
import { retrievalAnswerSkillDefinition } from "../../skills/public.js";
import type { TurnOutcome, TurnRenderContext, TurnSkill, TurnStreamResult } from "./turnOutcome.js";
import {
  computeGroundingSummary,
  type GroundingSummary,
  type GroundingVerdict,
} from "./groundingAssertions.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { BoundedGroundingStreamGate } from "./boundedGroundingStreamGate.js";

export class GroundingStreamGateBoundError extends Error {
  constructor() {
    super("grounding_stream_gate_bound");
    this.name = "GroundingStreamGateBoundError";
  }
}

const combineAbortSignals = (turnSignal: AbortSignal | undefined, gateSignal: AbortSignal): AbortSignal =>
  turnSignal ? AbortSignal.any([turnSignal, gateSignal]) : gateSignal;

/** The outcome kind a grounded/retrieval turn produces (chat-side renderer tag). */
export const RETRIEVAL_OUTCOME_KIND = "retrieval";

/** The skill this turn dispatches — identity sourced from the canonical skill catalog. */
export const RETRIEVAL_TURN_SKILL = retrievalAnswerSkillDefinition.name;

export const buildRetrievalTurnOutcome = (session: PreparedSession): TurnOutcome =>
  buildPreparedTurnOutcome(session, { kind: RETRIEVAL_OUTCOME_KIND, skillName: RETRIEVAL_TURN_SKILL });

/**
 * True when the turn router judged the request wholly outside the agent's scope: it
 * named an out-of-scope request and no in-scope one. Mixed turns (both present) fall
 * through to grounded answering, which answers the in-scope part and declines the rest.
 */
const isOutOfScopeOnly = (session: PreparedSession): boolean => {
  const framing = session.turnFraming;
  return Boolean(framing?.outsideScopeRequest?.trim()) && !framing?.inScopeRequest?.trim();
};

const shouldSuppressUnsupportedDraft = (
  session: PreparedSession,
  envelope: Pick<GroundedAnswerEnvelope, "parseStatus" | "outcome">,
  summary: GroundingSummary,
): boolean =>
  session.retrieval.contexts.length > 0
  && summary.sourcedClaimCount === 0
  && (
    envelope.outcome === "answer"
    || envelope.parseStatus === "missing"
    || envelope.parseStatus === "malformed"
    || envelope.parseStatus === "invalid_v2"
  );

/**
 * Composes a grounded answer for a retrieval turn: the grounded system prompt, the
 * envelope call, the page-context fallback, and computed grounding presentation.
 * Grounding is retrieval's *private* business — this only
 * ever runs for `RETRIEVAL` turns; social/identity turns are answered by their own
 * skills and never reach here.
 */
export class RetrievalAnswerComposer {
  constructor(
    private readonly support: ChatAnswerSupport,
    private readonly chatGateway: ChatGateway,
    private readonly chatAnswerPresenter: ChatAnswerPresenter,
    private readonly fallbackReplyComposer: FallbackReplyComposer,
    private readonly metrics?: Pick<MetricsRegistry, "incrementCounter"> | null,
  ) {}

  private recordGroundingOutcome(
    summary: GroundingSummary,
    envelope: Pick<GroundedAnswerEnvelope, "outcome">,
    stream: boolean,
  ): void {
    const protocol = summary.parseStatus === "valid_v2"
      ? "v2"
      : summary.parseStatus === "legacy_v1"
        ? "v1"
        : summary.parseStatus === "missing"
          ? "missing"
          : "malformed";
    const reason = summary.parseStatus !== "valid_v2"
      ? "parse_failure"
      : summary.invalidSourceCount > 0
        ? "invalid_index"
        : summary.assertionMismatch
          ? "mismatch"
          : envelope.outcome === "no_support" && summary.verdict !== "no_support"
            ? "invalid_no_support"
            : summary.claimCount === 0 && summary.verdict !== "no_support"
              ? "anchor_free"
              : summary.unsourcedClaimCount > 0
                ? "unsourced"
                : "complete";
    this.metrics?.incrementCounter("chat_grounding_assertion_outcomes_total", {
      help: "Computed chat grounding assertion outcomes",
      labels: { protocol, verdict: summary.verdict, reason, stream: String(stream) },
    });
  }

  private recordGroundingGateBound(): void {
    this.metrics?.incrementCounter("chat_grounding_assertion_outcomes_total", {
      help: "Computed chat grounding assertion outcomes",
      labels: { protocol: "v2", verdict: "no_support", reason: "gate_bound", stream: "true" },
    });
  }

  composeGroundedSystemPrompt(session: PreparedSession): string {
    const conversationIntentSnapshot = buildConversationIntentSnapshot({
      history: session.history,
      latestQuery: session.effectiveQuery ?? session.userMessage.content,
      priorRewriteContinuityState: session.priorRewriteContinuityState,
      rewriteProposal: session.retrieval.diagnostics.rewriteProposal,
    });
    return composeGroundedAnswerSystemPrompt({
      baseSystemPrompt: session.retrieval.systemPrompt,
      suggestedQuestionsEnabled: session.retrieval.responseSettings?.suggestedQuestionsEnabled ?? true,
      suggestedQuestionsCount:
        session.retrieval.responseSettings?.suggestedQuestionsCount ?? DEFAULT_SUGGESTED_QUESTIONS_COUNT,
      hasRetrievedContexts: session.retrieval.contexts.length > 0,
      conversationIntentSnapshot,
      conversationSummary: session.conversationSummary,
      steering: session.directiveSteering?.rules ?? [],
      retrievalSenseOfferAlternatives: session.retrievalSenseOfferAlternatives,
    }).systemPrompt;
  }

  private async generateGroundedAnswerEnvelope(
    session: PreparedSession,
    query: string,
    prompt: string,
    accountId: string | undefined,
    attemptKey: string,
    signal?: AbortSignal,
  ): Promise<GroundedAnswerEnvelope> {
    const raw = await this.chatGateway.answer({
      query,
      history: session.history,
      systemPrompt: this.composeGroundedSystemPrompt(session),
      prompt,
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, attemptKey),
      ...(signal ? { signal } : {}),
    });
    const envelope = parseGroundedAnswerEnvelope(raw);
    if (!envelope.answer.trim()) {
      throw new BlankChatAnswerError();
    }
    return envelope;
  }

  private async presentSuppressedUnsupportedDraft(
    session: PreparedSession,
    summary: GroundingSummary,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
    signal?: AbortSignal,
  ): Promise<ChatPresentedAnswer> {
    const decline = await this.composeFocusedDecline(
      session,
      query,
      userExpectedLocale,
      accountId,
      "grounded_suppressed_decline",
      signal,
    );
    return {
      ...this.chatAnswerPresenter.presentGroundedMissAnswer(decline),
      grounding: summary.verdict,
      groundingSummary: summary,
      effectiveRetrieval: session.retrieval,
    };
  }

  async generateAnswerWithPageContext(
    session: PreparedSession,
    query: string,
    accountId: string | undefined,
    signal?: AbortSignal,
  ): Promise<GroundedAnswerEnvelope | null> {
    const prompt = this.support.buildPromptWithContext(session.retrieval.prompt, session);
    if (prompt === session.retrieval.prompt) {
      return null;
    }

    const envelope = await this.generateGroundedAnswerEnvelope(
      session,
      query,
      prompt,
      accountId,
      "page_context",
      signal,
    );
    return { ...envelope, answer: envelope.answer.trim() };
  }

  async composeAnswer(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
  ): Promise<ChatPresentedAnswer> {
    // Scope gate: when the turn router judged the request wholly outside the agent's
    // configured scope (no in-scope part), decline deterministically via the focused
    // grounded-miss composer rather than generating a grounded answer — the answer
    // model otherwise leaks off-scope general knowledge despite the prompt's scope rule.
    if (isOutOfScopeOnly(session)) {
      return this.declineOutOfScope(session, query, userExpectedLocale, accountId, "out_of_scope");
    }

    let answer: string;
    let plannedSuggestions: PlannedEnvelopeSuggestion[] = [];
    let grounding: GroundingSummary | GroundingVerdict = "no_support";
    let suppressUnsupportedDraft = false;

    if (session.retrieval.contexts.length === 0) {
      const fallback = await this.generateAnswerWithPageContext(session, query, accountId);
      if (fallback) {
        answer = fallback.answer;
        plannedSuggestions = fallback.suggestions;
        grounding = computeGroundingSummary({
          body: fallback.answer,
          envelope: fallback,
          contextCount: 0,
        });
        this.recordGroundingOutcome(grounding, fallback, false);
      } else {
        answer = await this.fallbackReplyComposer.composeNoContext({
          query,
          userExpectedLocale,
          answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
          steering: session.directiveSteering?.rules ?? [],
          workspaceContext: this.support.buildChatWorkspaceContext(session),
          usageContext: this.support.buildChatUsageContext(session, accountId, "grounded_miss"),
        });
      }
    } else {
      const envelope = await this.generateGroundedAnswerEnvelope(
        session,
        query,
        this.support.buildPromptWithContext(session.retrieval.prompt, session),
        accountId,
        "grounded",
      );
      answer = envelope.answer;
      plannedSuggestions = envelope.suggestions;
      grounding = computeGroundingSummary({
        body: envelope.answer,
        envelope,
        contextCount: session.retrieval.contexts.length,
      });
      this.recordGroundingOutcome(grounding, envelope, false);
      suppressUnsupportedDraft = shouldSuppressUnsupportedDraft(session, envelope, grounding);
    }

    if (suppressUnsupportedDraft && typeof grounding !== "string") {
      return this.presentSuppressedUnsupportedDraft(
        session,
        grounding,
        query,
        userExpectedLocale,
        accountId,
      );
    }

    const presentation = await this.chatAnswerPresenter.presentWithSuggestions(
      session,
      answer,
      query,
      plannedSuggestions,
      userExpectedLocale,
      grounding,
    );
    return presentation;
  }

  /** Compose a focused decline through the grounded-miss path. Its narrow prompt
   * declines and redirects without the grounded answer model's pull to continue an
   * unsupported draft. */
  private async composeFocusedDecline(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
    attemptKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.fallbackReplyComposer.composeNoContext({
      query,
      userExpectedLocale,
      answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
      steering: session.directiveSteering?.rules ?? [],
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, attemptKey),
      ...(signal ? { signal } : {}),
    });
  }

  private async declineOutOfScope(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
    attemptKey: string,
  ): Promise<ChatPresentedAnswer> {
    const decline = await this.composeFocusedDecline(session, query, userExpectedLocale, accountId, attemptKey);
    return this.chatAnswerPresenter.presentGroundedMissAnswer(decline);
  }

  /**
   * Streams the grounded answer: a no-context fallback yielded as one chunk, or the
   * token loop that holds unasserted prose until the first valid sourced assertion,
   * then streams every later token. Yields sanitized body text and returns the
   * presentation computed from the same generation; the host only persists, re-emits
   * any non-streamed remainder, and sources suggestions.
   */
  async *streamAnswer(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<string, TurnStreamResult> {
    // Scope gate (mirrors composeAnswer): a wholly out-of-scope turn declines via the
    // focused grounded-miss composer instead of streaming a grounded answer.
    if (isOutOfScopeOnly(session)) {
      const decline = await this.composeFocusedDecline(
        session,
        query,
        userExpectedLocale,
        accountId,
        "stream_out_of_scope",
        signal,
      );
      return {
        finalPresentation: await this.chatAnswerPresenter.presentGroundedMissAnswer(decline),
        suggestions: { mode: "assistant", planned: [] },
        hasStreamedAnswer: false,
        streamedAnswer: "",
        deliveryMode: "committed",
      };
    }

    let rawAnswer = "";
    let plannedSuggestions: PlannedEnvelopeSuggestion[] = [];
    let grounding: GroundingSummary | GroundingVerdict = "no_support";
    let hasStreamedAnswer = false;
    let streamedAnswer = "";
    let suppressUnsupportedDraft = false;
    let groundingGateWaitMs: number | undefined;

    if (session.retrieval.contexts.length === 0) {
      const fallbackEnvelope = await this.generateAnswerWithPageContext(session, query, accountId, signal);
      rawAnswer = fallbackEnvelope?.answer
        ?? await this.fallbackReplyComposer.composeNoContext({
          query,
          userExpectedLocale,
          answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
          steering: session.directiveSteering?.rules ?? [],
          workspaceContext: this.support.buildChatWorkspaceContext(session),
          usageContext: this.support.buildChatUsageContext(session, accountId, "stream_grounded_miss"),
          ...(signal ? { signal } : {}),
        });
      plannedSuggestions = fallbackEnvelope?.suggestions ?? [];
      if (fallbackEnvelope) {
        grounding = computeGroundingSummary({ body: fallbackEnvelope.answer, envelope: fallbackEnvelope, contextCount: 0 });
        this.recordGroundingOutcome(grounding, fallbackEnvelope, true);
      }
    } else {
      const reader = new GroundedAnswerEnvelopeReader();
      const citationSanitizer = new CitationAnchorSanitizer();
      const gate = new BoundedGroundingStreamGate({
        contextCount: session.retrieval.contexts.length,
        maxRetainedCodePoints: RETRIEVAL_BEHAVIOR.groundingStreamGateMaxRetainedCodePoints,
      });
      const gateController = new AbortController();
      const candidateStream = this.chatGateway.streamAnswer({
        query,
        history: session.history,
        systemPrompt: this.composeGroundedSystemPrompt(session),
        prompt: this.support.buildPromptWithContext(session.retrieval.prompt, session),
        workspaceContext: this.support.buildChatWorkspaceContext(session),
        usageContext: this.support.buildChatUsageContext(session, accountId, "stream_grounded"),
        signal: combineAbortSignals(signal, gateController.signal),
      });
      let gateBound = false;
      for await (const text of candidateStream) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("chat_turn_aborted");
        }
        if (!text) {
          continue;
        }
        const decision = gate.push(reader.push(text));
        if (decision.kind === "bound") {
          gateBound = true;
          gateController.abort(new GroundingStreamGateBoundError());
          break;
        }
        const cleanChunk = citationSanitizer.push(decision.kind === "release" ? decision.text : "");
        if (cleanChunk) {
          streamedAnswer += cleanChunk;
          yield cleanChunk;
          hasStreamedAnswer = true;
        }
      }

      groundingGateWaitMs = gate.waitDurationMs;
      if (signal?.aborted) {
        throw signal.reason ?? new Error("chat_turn_aborted");
      }
      if (gateBound) {
        this.recordGroundingGateBound();
        const decline = await this.composeFocusedDecline(
          session,
          query,
          userExpectedLocale,
          accountId,
          "stream_grounding_gate_bound",
          signal,
        );
        if (signal?.aborted) {
          throw signal.reason ?? new Error("chat_turn_aborted");
        }
        return {
          finalPresentation: await this.chatAnswerPresenter.presentGroundedMissAnswer(decline),
          suggestions: { mode: "assistant", planned: [] },
          hasStreamedAnswer: false,
          streamedAnswer: "",
          deliveryMode: "bounded_decline",
          traceMetrics: { groundingGateWaitMs },
        };
      }

      const finalized = reader.finalize();
      // The cap governs in-flight streaming only. On natural completion without
      // opening or bounding, the computed #860 verdict and draft suppression below
      // remain final authority, preserving pre-#859 delivery behavior.
      gate.finish();
      groundingGateWaitMs = gate.waitDurationMs;
      plannedSuggestions = finalized.suggestions;
      rawAnswer = finalized.fullAnswer;
      if (!rawAnswer.trim()) {
        throw new BlankChatAnswerError();
      }
      grounding = computeGroundingSummary({
        body: rawAnswer,
        envelope: finalized,
        contextCount: session.retrieval.contexts.length,
      });
      this.recordGroundingOutcome(grounding, finalized, true);
      suppressUnsupportedDraft = shouldSuppressUnsupportedDraft(session, finalized, grounding);
    }

    if (suppressUnsupportedDraft && typeof grounding !== "string") {
      return {
        finalPresentation: await this.presentSuppressedUnsupportedDraft(
          session,
          grounding,
          query,
          userExpectedLocale,
          accountId,
          signal,
        ),
        suggestions: { mode: "assistant", planned: [] },
        hasStreamedAnswer,
        streamedAnswer,
        deliveryMode: hasStreamedAnswer ? "live" : "committed",
        ...(groundingGateWaitMs === undefined ? {} : { traceMetrics: { groundingGateWaitMs } }),
      };
    }

    // Present the same generated body from its computed assertion verdict. Suggestions
    // stay assistant-sourced; there is no semantic reconciliation generation here.
    const presentation = await this.chatAnswerPresenter.presentWithoutSuggestions(
      session,
      rawAnswer,
      query,
      userExpectedLocale,
      grounding,
    );
    return {
      finalPresentation: presentation,
      suggestions: { mode: "assistant", planned: plannedSuggestions },
      hasStreamedAnswer,
      streamedAnswer,
      deliveryMode: hasStreamedAnswer ? "live" : "committed",
      ...(groundingGateWaitMs === undefined ? {} : { traceMetrics: { groundingGateWaitMs } }),
    };
  }
}

/**
 * Registers retrieval as a terminal `TurnSkill`. It `selects` only `RETRIEVAL`
 * turns and renders through its own `RetrievalAnswerComposer`. The generic turn
 * machinery never references it.
 */
export const createRetrievalTurnSkill = (composer: RetrievalAnswerComposer): TurnSkill => ({
  definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
  selects: (session) => session.turnRoute === CHAT_TURN_ROUTE.RETRIEVAL,
  dispatch: (session) => buildRetrievalTurnOutcome(session),
  renderer: {
    supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
    render: (_outcome, ctx: TurnRenderContext) =>
      composer.composeAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
    stream: (_outcome, ctx: TurnRenderContext) =>
      composer.streamAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId, ctx.signal),
  },
});
