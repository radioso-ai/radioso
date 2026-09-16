import type { ChatGateway } from "../contracts/chatGateway.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { AnswerCoverageAssessment, RetrievalCoverageVerdictSink } from "../contracts/answerCoverage.js";
import {
  LlmAnswerCoverageProducer,
  classificationKeyFor,
  type AnswerCoverageInferencePort,
} from "../../answerCoverage/public.js";
import { buildContextualizedRequest } from "./contextualizedRequest.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { setTraceAttributes } from "../../../shared/observability/tracing/operations.js";

const SHADOW_USAGE_OPERATION = "answer_coverage_shadow_assessment";

// Retrieval's FinalPromptContext list is already the exact token-bounded set that
// answer composition receives. Do not independently shorten it here: assessing a
// different evidence set would manufacture a gap the answer could actually resolve.
const admittedEvidence = (session: PreparedSession) => session.retrieval.contexts
  .map((context) => ({
    id: context.chunkId,
    sourceLabel: context.title,
    content: context.content,
  }));

/**
 * The bounded label the agreement observation carries for one side of the
 * comparison: the eight-value classification when a side is assessed, or a
 * fixed sentinel otherwise. `shadow_failed` is applied by the caller, not
 * here, so the same helper can label either side.
 */
const classificationLabel = (assessment: AnswerCoverageAssessment): string =>
  assessment.availability === "assessed"
    ? classificationKeyFor(assessment) ?? "unclassified"
    : "head_unavailable";

/**
 * Runs the retired pre-compose assessor as a shadow for the #1260 measurement
 * window (US5): started concurrently with compose, never awaited on the turn
 * path, never consulted for any decision or record. Wraps the coverage
 * verdict sink exactly the way the head recorder does, but its `report()`
 * always returns the inner sink's own decision — the shadow cannot change a
 * turn's outcome, only observe it.
 */
export class AnswerCoverageShadowAssessor {
  constructor(
    private readonly gateway: Pick<ChatGateway, "answer">,
    private readonly enabled: boolean,
    private readonly metrics?: Pick<MetricsRegistry, "incrementCounter"> | null,
  ) {}

  wrapVerdictSink(
    input: { getSession: () => PreparedSession; accountId?: string; signal?: AbortSignal },
    inner: RetrievalCoverageVerdictSink,
  ): RetrievalCoverageVerdictSink {
    const session = input.getSession();
    // Admitted evidence only: the zero-evidence branch's deterministic verdict
    // has nothing for the old assessor to independently judge.
    if (!this.enabled || session.turnRoute !== "retrieval" || session.retrieval.contexts.length === 0) {
      return inner;
    }
    const shadowRun = this.runShadow(session, input.accountId, input.signal);
    return {
      report: async ({ assessment }) => {
        const decision = await inner.report({ assessment });
        void this.recordAgreement(assessment, shadowRun);
        return decision;
      },
    };
  }

  private async runShadow(
    session: PreparedSession,
    accountId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AnswerCoverageAssessment> {
    const inference: AnswerCoverageInferencePort = {
      complete: async (request) => ({
        text: await this.gateway.answer({
          query: "",
          history: [],
          prompt: request.prompt,
          workspaceContext: {
            workspaceId: session.agent.workspaceId,
            capabilityOverride: session.agent.chatModelOverride ?? undefined,
          },
          usageContext: request.operation,
          generation: {
            maxOutputTokens: request.maxOutputTokens,
            responseFormat: request.responseFormat,
          },
          signal: request.signal,
        }),
      }),
    };
    // `LlmAnswerCoverageProducer.assess` never rejects: a provider failure or an
    // abort from `signal` (the turn's own cap on how long the shadow may run)
    // resolves to `{ availability: "failed" }`.
    return new LlmAnswerCoverageProducer(inference).assess({
      contextualizedRequest: buildContextualizedRequest(session, session.effectiveQuery ?? session.userMessage.content),
      admissibleEvidence: admittedEvidence(session),
      usageContext: {
        accountId: accountId ?? null,
        workspaceId: session.agent.workspaceId,
        conversationId: session.conversation.id,
        messageId: session.userMessage.id,
        surface: "assistant",
        operation: SHADOW_USAGE_OPERATION,
        attemptKey: `${session.userMessage.id}:${SHADOW_USAGE_OPERATION}`,
        ...session.usageAttribution,
      },
      signal,
    });
  }

  private async recordAgreement(
    headAssessment: AnswerCoverageAssessment,
    shadowRun: Promise<AnswerCoverageAssessment>,
  ): Promise<void> {
    const shadow = await shadowRun;
    const headClassification = classificationLabel(headAssessment);
    const shadowClassification = shadow.availability === "assessed" ? classificationLabel(shadow) : "shadow_failed";
    setTraceAttributes({
      "answer_coverage.shadow.head_classification": headClassification,
      "answer_coverage.shadow.shadow_classification": shadowClassification,
    });
    this.metrics?.incrementCounter("answer_coverage_shadow_agreement_total", {
      help: "Agreement between the answer-head coverage verdict and the shadow assessor",
      labels: { head_classification: headClassification, shadow_classification: shadowClassification },
    });
  }
}
