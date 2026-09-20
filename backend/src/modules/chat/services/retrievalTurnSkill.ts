import type { ChatGateway } from "../contracts/chatGateway.js";
import { ChatAnswerPresenter, type ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { BlankChatAnswerError } from "./chatAnswerErrors.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import { buildConversationIntentSnapshot } from "./conversationIntentSnapshot.js";
import {
  buildGroundedAnswerResponseFormat,
  GroundedAnswerEnvelopeReader,
  parseGroundedAnswerEnvelope,
  type GroundedAnswerEnvelope,
  type PlannedEnvelopeSuggestion,
} from "./groundedAnswerEnvelope.js";
import type {
  AnswerSideChannel,
  AnswerSideChannelFactory,
} from "../../../shared/domain/answerSideChannel.js";
import { CitationAnchorSanitizer } from "./citationAnchorSanitizer.js";
import { GENERATION_SURFACE } from "../../../shared/domain/generationSurface.js";
import {
  attestableSteering,
  composeGroundedAnswerSystemPrompt,
} from "./groundedAnswerPromptComposer.js";
import type { ComposedDecline, FallbackReplyComposer } from "./fallbackReplyComposer.js";
import type { TurnDeclineReason } from "./assistantTurnOutcomeTypes.js";
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
import { recordDirectiveSurfaceRendered } from "./directives/directiveSurfaceRendering.js";
import { GroundedAnswerHeadReader } from "./groundedAnswerHeadReader.js";
import { answerCoverageHeadParseOutcome, steeringForKnownVerdict } from "../../../shared/domain/steeringRule.js";
import {
  buildAnswerCoverageAssessmentFromHead,
  buildDeterministicZeroEvidenceAssessment,
  buildInvalidHeadAssessment,
} from "./answerCoverageFromHead.js";
import { REQUEST_FOCUS_MAX_LENGTH } from "../../answerCoverage/public.js";
import type { AnswerCoverageAssessment, RetrievalCoverageVerdictSink } from "../contracts/answerCoverage.js";

class GroundingStreamGateBoundError extends Error {
  constructor() {
    super("grounding_stream_gate_bound");
    this.name = "GroundingStreamGateBoundError";
  }
}

/** Abort reason for the model stream when a coverage verdict sink yields the turn (#1260, FR-006). */
class CoverageVerdictYieldedError extends Error {
  constructor() {
    super("coverage_verdict_yielded");
    this.name = "CoverageVerdictYieldedError";
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
 * Enforces the v2 grounding protocol at delivery time. A valid answer envelope
 * must carry at least one in-range sourced assertion; lexical similarity is not
 * evidence and cannot turn an anchor-free draft into a grounded answer. Captured
 * page content is a separate source admitted by the fused planner's typed gate.
 */
const shouldSuppressUnsupportedDraft = (
  session: PreparedSession,
  envelope: Pick<GroundedAnswerEnvelope, "parseStatus" | "outcome">,
  summary: GroundingSummary,
): boolean =>
  session.retrieval.contexts.length > 0
  && session.pageReadOutcome?.gate.kind !== "capture"
  && envelope.parseStatus === "valid_v2"
  && envelope.outcome === "answer"
  && summary.sourcedClaimCount === 0;

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
    private readonly answerSideChannel?: AnswerSideChannelFactory,
  ) {}

  private isEnvelopeDecline(outcome: GroundedAnswerEnvelope["outcome"]): boolean {
    return outcome === "no_support" || outcome === "out_of_scope";
  }

  /**
   * Maps a completed envelope's head to the coverage verdict sink's assessment
   * shape (#1260). `invalid` covers every way a completed envelope can fail to
   * carry a usable head — a legacy/non-v2 parse, or any of the three head
   * fields missing — never a failed turn (FR-004).
   */
  private assessmentFromEnvelope(envelope: GroundedAnswerEnvelope): AnswerCoverageAssessment {
    if (envelope.parseStatus !== "valid_v2" || !envelope.coverage || !envelope.requestFocus || !envelope.outcome) {
      return buildInvalidHeadAssessment();
    }
    return buildAnswerCoverageAssessmentFromHead({
      coverage: envelope.coverage,
      requestFocus: envelope.requestFocus,
      outcome: envelope.outcome,
    });
  }

  /**
   * The zero-evidence branch's `unresolvedRequest` (#1260 review F7): a short
   * noun phrase naming the request, matching what the model-produced head
   * would emit for `requestFocus` (FR-002). `buildContextualizedRequest`
   * prefixes up to six turns of role-labeled history — the right framing for
   * the persisted `contextualizedRequest` field, but a whole transcript is
   * not a short focus phrase.
   */
  private zeroEvidenceRequestFocus(session: PreparedSession, query: string): string {
    return (session.effectiveQuery || query).slice(0, REQUEST_FOCUS_MAX_LENGTH);
  }

  /** The presentation for a turn a coverage verdict sink yielded before any text was composed. */
  private yieldedPresentedAnswer(): ChatPresentedAnswer {
    return {
      answer: "",
      skillName: RETRIEVAL_TURN_SKILL,
      skillOutcome: "coverage_yielded",
      skillStatus: "completed",
      yielded: true,
    };
  }

  /** The streamed turn result for a turn a coverage verdict sink yielded before any text streamed. */
  private yieldedStreamResult(coverageHeadMs?: number): TurnStreamResult {
    return {
      finalPresentation: this.yieldedPresentedAnswer(),
      suggestions: { mode: "assistant", planned: [] },
      hasStreamedAnswer: false,
      streamedAnswer: "",
      deliveryMode: "yielded",
      yielded: true,
      ...(coverageHeadMs === undefined ? {} : { traceMetrics: { coverageHeadMs } }),
    };
  }

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
          : this.isEnvelopeDecline(envelope.outcome) && summary.verdict !== "no_support"
            ? "invalid_no_support"
            : summary.claimCount === 0 && summary.verdict !== "no_support"
              ? "anchor_free"
              : summary.unsourcedClaimCount > 0
                ? "unsourced"
                : "complete";
    this.metrics?.incrementCounter("chat_grounding_assertion_outcomes_total", {
      help: "Computed chat grounding assertion outcomes",
      labels: {
        protocol,
        verdict: summary.verdict,
        reason,
        stream: String(stream),
        // Content-free: why the turn declined, or `none` when it did not decline.
        decline: summary.declineReason ?? "none",
      },
    });
  }

  /**
   * The answer side channel for this turn, if composition supplied one. The composer
   * merges its schema extension into the envelope and hands the parsed extras back
   * to it for an opaque metadata patch — it never learns what the side channel means
   * (directive adherence today). Built from the steering rules the answer prompt
   * renders with ids, so the model is never asked to attest to a rule it cannot see.
   *
   * `knownAssessment`, when supplied, must be the same verdict `composeGroundedAnswerPrompt`
   * rendered the prompt against (round 3 review, Q4): a coverage-gated rule that
   * verdict drops from the prompt must also drop from the attestable enum, or the
   * model is asked to attest to a rule id it never saw rendered.
   */
  private sideChannel(session: PreparedSession, knownAssessment?: AnswerCoverageAssessment): AnswerSideChannel | undefined {
    const rules = session.directiveSteering?.rules ?? [];
    const knownVerdictRules = knownAssessment ? steeringForKnownVerdict(rules, knownAssessment) : rules;
    return this.answerSideChannel?.forSteeringRules(attestableSteering(knownVerdictRules));
  }

  private recordGroundingGateBound(declineReason: TurnDeclineReason): void {
    this.metrics?.incrementCounter("chat_grounding_assertion_outcomes_total", {
      help: "Computed chat grounding assertion outcomes",
      labels: {
        protocol: "v2",
        verdict: "no_support",
        reason: "gate_bound",
        stream: "true",
        decline: declineReason,
      },
    });
  }

  private recordUnsupportedAnswerDecline(declineReason: TurnDeclineReason, stream: boolean): void {
    this.metrics?.incrementCounter("chat_grounding_assertion_outcomes_total", {
      help: "Computed chat grounding assertion outcomes",
      labels: {
        protocol: "v2",
        verdict: "no_support",
        reason: "unsupported_answer",
        stream: String(stream),
        decline: declineReason,
      },
    });
  }

  /**
   * Bounded-label counters for the answer-head parse outcome and the host's
   * proceed/yield decision (#1260). Records nothing when `decision` is
   * absent — the coverage verdict sink was never wired for this turn, so
   * there is no host decision to attribute an outcome to.
   */
  private recordCoverageHeadOutcome(
    assessment: AnswerCoverageAssessment,
    decision: "proceed" | "yield_turn" | undefined,
  ): void {
    if (!decision) {
      return;
    }
    const parseOutcome = answerCoverageHeadParseOutcome(assessment);
    this.metrics?.incrementCounter("chat_answer_coverage_head_parse_total", {
      help: "Answer envelope head parse outcome before the host decides",
      labels: { outcome: parseOutcome },
    });
    this.metrics?.incrementCounter("chat_answer_coverage_head_decision_total", {
      help: "Host decision (proceed or yield the turn) after the answer coverage head verdict",
      labels: { decision },
    });
  }

  /**
   * `knownAssessment`, when supplied, means the turn's coverage verdict is already
   * committed (today only the zero-evidence branch's deterministic assessment,
   * already reported to the coverage sink before this prompt is built) rather than
   * something this call's own model is being asked to judge fresh. A coverage-gated
   * rule then renders like `steeringForKnownVerdict`'s other callers: plain and
   * unconditional when it matches, dropped when it does not — never as a condition
   * on a verdict this call's envelope schema happens to also ask for but that
   * nothing reads.
   */
  private composeGroundedAnswerPrompt(session: PreparedSession, knownAssessment?: AnswerCoverageAssessment) {
    const conversationIntentSnapshot = buildConversationIntentSnapshot({
      history: session.history,
      latestQuery: session.effectiveQuery ?? session.userMessage.content,
      priorRewriteContinuityState: session.priorRewriteContinuityState,
      rewriteProposal: session.retrieval.diagnostics.rewriteProposal,
    });
    const steering = session.directiveSteering?.rules ?? [];
    const composed = composeGroundedAnswerSystemPrompt({
      baseSystemPrompt: session.retrieval.systemPrompt,
      suggestedQuestionsEnabled: session.retrieval.responseSettings?.suggestedQuestionsEnabled ?? true,
      suggestedQuestionsCount:
        session.retrieval.responseSettings?.suggestedQuestionsCount ?? DEFAULT_SUGGESTED_QUESTIONS_COUNT,
      hasRetrievedContexts: session.retrieval.contexts.length > 0,
      conversationIntentSnapshot,
      conversationSummary: session.conversationSummary,
      steering: knownAssessment ? steeringForKnownVerdict(steering, knownAssessment) : steering,
      retrievalSenseOfferAlternatives: session.retrievalSenseOfferAlternatives,
    });
    if (session.directiveSteering) {
      // Whether the follow-up question generator's block went into the prompt at all.
      // "Ran and produced nothing" and "never ran" are different turns, and only the
      // second leaves a suggestion-scoped rule unfired.
      session.directiveSteering.suggestionBlockRendered = composed.suggestionsExpected;
    }
    return composed;
  }

  composeGroundedSystemPrompt(session: PreparedSession): string {
    return this.composeGroundedAnswerPrompt(session).systemPrompt;
  }

  private promptWithConversationContext(
    prompt: string,
    session: PreparedSession,
    knownAssessment?: AnswerCoverageAssessment,
  ) {
    const groundedPrompt = this.composeGroundedAnswerPrompt(session, knownAssessment);
    return {
      systemPrompt: groundedPrompt.systemPrompt,
      reusableInputBoundary: groundedPrompt.reusableInputBoundary,
      prompt: groundedPrompt.conversationContextPrompt
        ? `${prompt}\n\n${groundedPrompt.conversationContextPrompt}`
        : prompt,
    };
  }

  /**
   * Records that the follow-up question generator ran, and spends the once/cooldown
   * budget of any directive addressed only to it.
   *
   * The test is whether that generator's block reached the model and its output was
   * kept — not whether a suggestion survived. A rule whose whole purpose is to
   * suppress suggestions can legitimately leave zero of them: it ran, it applied, and
   * it has fired. Counting only visible output would leave such a rule unfired
   * forever, re-firing on every turn despite a `once_per_conversation` policy.
   *
   * The generator has not run when its block never entered the prompt (suggestions
   * off, count zero, nothing retrieved), or when the draft it belonged to was thrown
   * away and replaced by a focused decline.
   */
  private recordSuggestionGeneratorRun(
    session: PreparedSession,
    declined: boolean,
  ): void {
    if (!session.directiveSteering?.suggestionBlockRendered || declined) {
      return;
    }
    recordDirectiveSurfaceRendered(session, GENERATION_SURFACE.SUGGESTED_QUESTIONS);
  }

  private async generateGroundedAnswerEnvelope(
    session: PreparedSession,
    query: string,
    prompt: string,
    accountId: string | undefined,
    attemptKey: string,
    signal?: AbortSignal,
    knownAssessment?: AnswerCoverageAssessment,
  ): Promise<GroundedAnswerEnvelope> {
    const groundedPrompt = this.promptWithConversationContext(prompt, session, knownAssessment);
    const raw = await this.chatGateway.answer({
      query,
      history: session.history,
      systemPrompt: groundedPrompt.systemPrompt,
      reusableInputBoundary: groundedPrompt.reusableInputBoundary,
      prompt: groundedPrompt.prompt,
      workspaceContext: this.support.buildChatWorkspaceContext(session),
      usageContext: this.support.buildChatUsageContext(session, accountId, attemptKey),
      generation: {
        responseFormat: buildGroundedAnswerResponseFormat(this.sideChannel(session, knownAssessment)?.schemaExtension() ?? null),
      },
      ...(signal ? { signal } : {}),
    });
    const envelope = parseGroundedAnswerEnvelope(raw);
    if (!envelope.answer.trim()) {
      throw new BlankChatAnswerError();
    }
    return envelope;
  }

  async generateAnswerWithPageContext(
    session: PreparedSession,
    query: string,
    accountId: string | undefined,
    signal?: AbortSignal,
    knownAssessment?: AnswerCoverageAssessment,
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
      knownAssessment,
    );
    return { ...envelope, answer: envelope.answer.trim() };
  }

  async composeAnswer(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
    coverageVerdict?: RetrievalCoverageVerdictSink,
  ): Promise<ChatPresentedAnswer> {
    let answer: string;
    let plannedSuggestions: PlannedEnvelopeSuggestion[] = [];
    let metadataPatch: Record<string, unknown> | undefined;
    let grounding: GroundingSummary | GroundingVerdict = "no_support";
    let declineReason: TurnDeclineReason | undefined;

    if (session.retrieval.contexts.length === 0) {
      const zeroEvidenceAssessment = buildDeterministicZeroEvidenceAssessment(this.zeroEvidenceRequestFocus(session, query));
      const zeroEvidenceVerdict = await coverageVerdict?.report({ assessment: zeroEvidenceAssessment });
      // `report()`'s wrapper (`AnswerCoverageHeadRecorder.wrapVerdictSink`) upserts by
      // request-message id: a retried report for this same message can hand the engine
      // an *earlier* attempt's stored verdict (`assessmentFromRecord(saved)`), so
      // `zeroEvidenceVerdict.decision` may have been decided against a different
      // assessment than this one. That only changes what the engine acts on for
      // proceed/yield; this turn's own rendering (`steeringForKnownVerdict` below)
      // and head metrics always use this fresh `zeroEvidenceAssessment` — main's
      // regenerate behavior, where a re-run shows and measures its own attempt.
      this.recordCoverageHeadOutcome(zeroEvidenceAssessment, zeroEvidenceVerdict?.decision);
      if (zeroEvidenceVerdict?.decision === "yield_turn") {
        return this.yieldedPresentedAnswer();
      }
      const fallback = await this.generateAnswerWithPageContext(
        session,
        query,
        accountId,
        undefined,
        zeroEvidenceAssessment,
      );
      if (fallback) {
        answer = fallback.answer;
        plannedSuggestions = fallback.suggestions;
        metadataPatch = this.sideChannel(session, zeroEvidenceAssessment)?.resolve(fallback.extras);
        grounding = computeGroundingSummary({
          body: fallback.answer,
          envelope: fallback,
          contextCount: 0,
        });
        this.recordGroundingOutcome(grounding, fallback, false);
      } else {
        const decline = await this.fallbackReplyComposer.composeNoContext({
          query,
          userExpectedLocale,
          answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
          steering: steeringForKnownVerdict(session.directiveSteering?.rules ?? [], zeroEvidenceAssessment),
          workspaceContext: this.support.buildChatWorkspaceContext(session),
          usageContext: this.support.buildChatUsageContext(session, accountId, "grounded_miss"),
        });
        answer = decline.text;
        declineReason = decline.declineReason;
      }
    } else {
      const envelope = await this.generateGroundedAnswerEnvelope(
        session,
        query,
        this.support.buildPromptWithContext(session.retrieval.prompt, session),
        accountId,
        "grounded",
      );
      const envelopeAssessment = this.assessmentFromEnvelope(envelope);
      const headVerdict = await coverageVerdict?.report({ assessment: envelopeAssessment });
      // `headVerdict.decision` can be decided against a stored verdict from an earlier
      // attempt at this request message, not this call's own `envelopeAssessment` — see
      // the zero-evidence branch above. The composed decline and the head metrics below
      // still use this fresh `envelopeAssessment`.
      this.recordCoverageHeadOutcome(envelopeAssessment, headVerdict?.decision);
      if (headVerdict?.decision === "yield_turn") {
        return this.yieldedPresentedAnswer();
      }
      const summary = computeGroundingSummary({
        body: envelope.answer,
        envelope,
        contextCount: session.retrieval.contexts.length,
      });
      if (shouldSuppressUnsupportedDraft(session, envelope, summary)) {
        const decline = await this.composeFocusedDecline(
          session,
          query,
          userExpectedLocale,
          accountId,
          "unsupported_answer",
          envelopeAssessment,
        );
        this.recordUnsupportedAnswerDecline(decline.declineReason, false);
        answer = decline.text;
        declineReason = decline.declineReason;
        grounding = "no_support";
      } else {
        answer = envelope.answer;
        plannedSuggestions = envelope.suggestions;
        metadataPatch = this.sideChannel(session)?.resolve(envelope.extras);
        grounding = summary;
        this.recordGroundingOutcome(summary, envelope, false);
      }
    }

    const presentation = await this.chatAnswerPresenter.presentWithSuggestions(
      session,
      answer,
      query,
      plannedSuggestions,
      userExpectedLocale,
      { grounding, ...(declineReason ? { declineReason } : {}) },
    );
    this.recordSuggestionGeneratorRun(session, declineReason !== undefined);
    return {
      ...presentation,
      ...(metadataPatch
        ? { metadata: { ...presentation.metadata, ...metadataPatch } }
        : {}),
    };
  }

  /** Compose a focused decline through the grounded-miss path. Its narrow prompt
   * declines and redirects without the grounded answer model's pull to continue an
   * unsupported draft. `knownAssessment` is the verdict already reported to the
   * coverage sink for this turn: this model is never asked to emit one of its own,
   * so a coverage-gated steering rule renders unconditionally when it matches and
   * is dropped otherwise, rather than as a condition this call cannot evaluate. */
  private async composeFocusedDecline(
    session: PreparedSession,
    query: string,
    userExpectedLocale: string | null | undefined,
    accountId: string | undefined,
    attemptKey: string,
    knownAssessment: AnswerCoverageAssessment,
    signal?: AbortSignal,
  ): Promise<ComposedDecline> {
    return this.fallbackReplyComposer.composeNoContext({
      query,
      userExpectedLocale,
      answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
      steering: steeringForKnownVerdict(session.directiveSteering?.rules ?? [], knownAssessment),
      // This is a model-authored scope-policy response, not an ordinary answer.
      // It is the refusal path, so it stays on the workspace chat tier rather
      // than the agent override that governs the turn's own calls — see the rule
      // in agentChatWorkspaceContext.ts. Keep the workspace id so stored
      // credentials and workspace provider preferences still resolve instead of
      // falling back to process-wide env.
      workspaceContext: { workspaceId: session.agent.workspaceId },
      usageContext: this.support.buildChatUsageContext(session, accountId, attemptKey),
      ...(signal ? { signal } : {}),
    });
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
    coverageVerdict?: RetrievalCoverageVerdictSink,
  ): AsyncGenerator<string, TurnStreamResult> {
    let rawAnswer = "";
    let plannedSuggestions: PlannedEnvelopeSuggestion[] = [];
    let metadataPatch: Record<string, unknown> | undefined;
    let grounding: GroundingSummary | GroundingVerdict = "no_support";
    let declineReason: TurnDeclineReason | undefined;
    let hasStreamedAnswer = false;
    let streamedAnswer = "";
    let groundingGateWaitMs: number | undefined;
    let coverageHeadMs: number | undefined;

    if (session.retrieval.contexts.length === 0) {
      const zeroEvidenceAssessment = buildDeterministicZeroEvidenceAssessment(this.zeroEvidenceRequestFocus(session, query));
      const zeroEvidenceVerdict = await coverageVerdict?.report({ assessment: zeroEvidenceAssessment });
      // `zeroEvidenceVerdict.decision` may reflect a stored verdict from an earlier
      // attempt at this request message rather than this call's own assessment — see
      // the non-streaming `composeAnswer`'s zero-evidence branch. Rendering and head
      // metrics below still use this fresh `zeroEvidenceAssessment`.
      this.recordCoverageHeadOutcome(zeroEvidenceAssessment, zeroEvidenceVerdict?.decision);
      if (zeroEvidenceVerdict?.decision === "yield_turn") {
        return this.yieldedStreamResult();
      }
      const fallbackEnvelope = await this.generateAnswerWithPageContext(
        session,
        query,
        accountId,
        signal,
        zeroEvidenceAssessment,
      );
      if (fallbackEnvelope) {
        rawAnswer = fallbackEnvelope.answer;
      } else {
        const decline = await this.fallbackReplyComposer.composeNoContext({
          query,
          userExpectedLocale,
          answerInstructionBlock: this.support.buildAnswerInstructionBlock(session),
          steering: steeringForKnownVerdict(session.directiveSteering?.rules ?? [], zeroEvidenceAssessment),
          workspaceContext: this.support.buildChatWorkspaceContext(session),
          usageContext: this.support.buildChatUsageContext(session, accountId, "stream_grounded_miss"),
          ...(signal ? { signal } : {}),
        });
        rawAnswer = decline.text;
        declineReason = decline.declineReason;
      }
      plannedSuggestions = fallbackEnvelope?.suggestions ?? [];
      metadataPatch = this.sideChannel(session, zeroEvidenceAssessment)?.resolve(fallbackEnvelope?.extras);
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
      // Captured page content was never gated by citations (a separate source the
      // planner's typed gate already admitted) — its delivery stays a single
      // committed block regardless of this setting. Workspace default true,
      // agent-overridable (FR-025): with it off, an `answer` commitment against
      // indexed sources streams from its first token instead of holding for one
      // (FR-026). `no_support` / `out_of_scope` bypass the gate on their own via
      // `bypassCitationGate` below, regardless of this setting (FR-027).
      const pageCaptureBypassesGate = session.pageReadOutcome?.gate.kind === "capture";
      const citationHoldEnabled = session.retrieval.responseSettings?.citationHoldEnabled ?? true;
      const requiresIndexedSourceGate = !pageCaptureBypassesGate && citationHoldEnabled;
      let citationGateEngaged = false;
      const gateController = new AbortController();
      const prompt = this.promptWithConversationContext(
        this.support.buildPromptWithContext(session.retrieval.prompt, session),
        session,
      );
      const headReader = new GroundedAnswerHeadReader();
      const composeStartedAt = performance.now();
      let bypassCitationGate = false;
      let yieldedTurn = false;
      // Retained so a later decline (gate-bound, unsupported draft) can render its
      // coverage-gated steering against the verdict already reported to the sink,
      // rather than re-deriving it or rendering the conditional phrasing a decline
      // model — never asked to emit a verdict — cannot evaluate. This is always the
      // fresh head, not necessarily what the engine acted on: `report()`'s wrapper
      // (`AnswerCoverageHeadRecorder`) can hand the engine a stored verdict from an
      // earlier attempt at this same request message instead of this one, but the
      // skill's own rendering and head metrics stay on the attempt actually running.
      let headAssessment: AnswerCoverageAssessment | undefined;
      const candidateStream = this.chatGateway.streamAnswer({
        query,
        history: session.history,
        systemPrompt: prompt.systemPrompt,
        reusableInputBoundary: prompt.reusableInputBoundary,
        prompt: prompt.prompt,
        workspaceContext: this.support.buildChatWorkspaceContext(session),
        usageContext: this.support.buildChatUsageContext(session, accountId, "stream_grounded"),
        generation: {
          responseFormat: buildGroundedAnswerResponseFormat(this.sideChannel(session)?.schemaExtension() ?? null),
        },
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
        // The head is read from the same raw chunks as the answer field, but
        // nothing derived from them reaches the gate or the client until it
        // resolves (FR-003) — parsed, or invalid the moment `answer` opens early.
        headReader.push(text);
        const parsedText = reader.push(text);
        if (headReader.current.kind === "pending") {
          continue;
        }
        if (coverageHeadMs === undefined) {
          coverageHeadMs = performance.now() - composeStartedAt;
          const headStatus = headReader.current;
          const assessment = headStatus.kind === "parsed"
            ? buildAnswerCoverageAssessmentFromHead(headStatus.head)
            : buildInvalidHeadAssessment();
          headAssessment = assessment;
          const verdict = await coverageVerdict?.report({ assessment });
          // The sink's own work (routine ranked activation) can outlast the client:
          // a turn signal that aborted while `report()` was pending must end the
          // turn here, before any text from this chunk's already-decoded body is
          // released and before the verdict is acted on again (#1260 review F10a).
          if (signal?.aborted) {
            throw signal.reason ?? new Error("chat_turn_aborted");
          }
          this.recordCoverageHeadOutcome(assessment, verdict?.decision);
          if (verdict?.decision === "yield_turn") {
            yieldedTurn = true;
            gateController.abort(new CoverageVerdictYieldedError());
            break;
          }
          // A decline commitment streams from its own text; the citation gate
          // exists only to hold an `answer` commitment until it earns one (FR-027).
          bypassCitationGate = headStatus.kind === "parsed" && headStatus.head.outcome !== "answer";
        }
        const appliesCitationGate = requiresIndexedSourceGate && !bypassCitationGate;
        if (appliesCitationGate) {
          citationGateEngaged = true;
        }
        const decision = appliesCitationGate
          ? gate.push(parsedText)
          : undefined;
        if (decision?.kind === "bound") {
          gateBound = true;
          gateController.abort(new GroundingStreamGateBoundError());
          break;
        }
        // Released immediately when the head's own outcome bypassed the gate
        // (FR-027), or when the citation hold is off for a non-captured answer
        // (FR-026); a captured page with the gate off still only ever releases
        // through the gate decision below (never opens, so nothing streams live —
        // unchanged from before this setting existed).
        const releasesImmediately = bypassCitationGate || (!citationHoldEnabled && !pageCaptureBypassesGate);
        const releaseText = releasesImmediately
          ? parsedText
          : (decision?.kind === "release" ? decision.text : "");
        const cleanChunk = citationSanitizer.push(releaseText);
        if (cleanChunk) {
          streamedAnswer += cleanChunk;
          yield cleanChunk;
          hasStreamedAnswer = true;
        }
      }

      // Reported only when the gate actually ran this turn (FR-026); a bypassed or
      // hold-off turn never engaged it, and 0ms-from-never-engaging would read as a
      // gate that opened instantly rather than one that never applied.
      groundingGateWaitMs = citationGateEngaged ? gate.waitDurationMs : undefined;
      if (signal?.aborted) {
        throw signal.reason ?? new Error("chat_turn_aborted");
      }
      if (yieldedTurn) {
        return this.yieldedStreamResult(coverageHeadMs);
      }
      if (gateBound) {
        const decline = await this.composeFocusedDecline(
          session,
          query,
          userExpectedLocale,
          accountId,
          "stream_grounding_gate_bound",
          headAssessment ?? buildInvalidHeadAssessment(),
          signal,
        );
        if (signal?.aborted) {
          throw signal.reason ?? new Error("chat_turn_aborted");
        }
        // Recorded once the decline is composed so the counter carries the same
        // classification the persisted turn outcome does.
        this.recordGroundingGateBound(decline.declineReason);
        return {
          finalPresentation: this.chatAnswerPresenter.presentRetrievalDeclineAnswer(
            decline.text,
            decline.declineReason,
          ),
          suggestions: { mode: "assistant", planned: [] },
          hasStreamedAnswer: false,
          streamedAnswer: "",
          deliveryMode: "bounded_decline",
          traceMetrics: {
            // A bound decision only ever comes from an engaged gate, so this is
            // always a real measurement, never the "never ran" case.
            groundingGateWaitMs: gate.waitDurationMs,
            ...(coverageHeadMs === undefined ? {} : { coverageHeadMs }),
          },
        };
      }

      const finalized = reader.finalize();
      // The cap governs in-flight streaming only. On natural completion without
      // opening or bounding, the computed #860 verdict and draft suppression below
      // remain final authority, preserving pre-#859 delivery behavior.
      gate.finish();
      groundingGateWaitMs = citationGateEngaged ? gate.waitDurationMs : undefined;
      plannedSuggestions = finalized.suggestions;
      metadataPatch = this.sideChannel(session)?.resolve(finalized.extras);
      rawAnswer = finalized.fullAnswer;
      if (!rawAnswer.trim()) {
        throw new BlankChatAnswerError();
      }
      const summary = computeGroundingSummary({
        body: rawAnswer,
        envelope: finalized,
        contextCount: session.retrieval.contexts.length,
      });
      if (!hasStreamedAnswer && shouldSuppressUnsupportedDraft(session, finalized, summary)) {
        const decline = await this.composeFocusedDecline(
          session,
          query,
          userExpectedLocale,
          accountId,
          "stream_unsupported_answer",
          headAssessment ?? buildInvalidHeadAssessment(),
          signal,
        );
        if (signal?.aborted) {
          throw signal.reason ?? new Error("chat_turn_aborted");
        }
        this.recordUnsupportedAnswerDecline(decline.declineReason, true);
        rawAnswer = decline.text;
        declineReason = decline.declineReason;
        grounding = "no_support";
        plannedSuggestions = [];
        metadataPatch = undefined;
      } else {
        grounding = summary;
        this.recordGroundingOutcome(summary, finalized, true);
      }
    }

    // Present the same generated body from its computed assertion verdict. Suggestions
    // stay assistant-sourced; there is no semantic reconciliation generation here.
    const presentation = await this.chatAnswerPresenter.presentWithoutSuggestions(
      session,
      rawAnswer,
      query,
      userExpectedLocale,
      { grounding, ...(declineReason ? { declineReason } : {}) },
    );
    this.recordSuggestionGeneratorRun(session, declineReason !== undefined);
    return {
      finalPresentation: {
        ...presentation,
        ...(metadataPatch
          ? { metadata: { ...presentation.metadata, ...metadataPatch } }
          : {}),
      },
      suggestions: { mode: "assistant", planned: plannedSuggestions },
      hasStreamedAnswer,
      streamedAnswer,
      deliveryMode: hasStreamedAnswer ? "live" : "committed",
      ...(groundingGateWaitMs === undefined && coverageHeadMs === undefined ? {} : {
        traceMetrics: {
          ...(groundingGateWaitMs === undefined ? {} : { groundingGateWaitMs }),
          ...(coverageHeadMs === undefined ? {} : { coverageHeadMs }),
        },
      }),
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
      composer.composeAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId, ctx.coverageVerdict),
    stream: (_outcome, ctx: TurnRenderContext) =>
      composer.streamAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId, ctx.signal, ctx.coverageVerdict),
  },
});
