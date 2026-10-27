import { isReportableFault } from "../../../shared/domain/errors.js";
import { classifyLlmProviderFailure, type LlmProviderFailureClassification } from "../../../shared/infra/llm/llmProviderFailureClassification.js";
import { turnExecutionCapabilities, type TurnExecutionMode } from "../../../shared/domain/turnExecutionMode.js";
import type { AuditEventInput } from "../../audit/contracts/index.js";
import { ActivitySummaryPresenter, ActivityTracePresenter } from "../../retrieval/public.js";
import type { ChatRoute } from "../types/chatResponses.js";
import type { AssistantWorkflowPolicy } from "./chatExecutionPolicy.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { reviewTurnFailureAuditEvent } from "./reviewTurnAudit.js";

/**
 * Pure payload construction for a chat turn's failure, shared by
 * `ChatTurnLifecycle.recordFailure` (the error report and the `chat.failed` analytics
 * event) and `ChatService`'s routine-activation warn log. Nothing here performs I/O —
 * each export turns inputs into the exact object its one caller sends on, so the
 * caller's job is to decide *whether* to send it and to call the port.
 */

/**
 * Low-cardinality fields any turn-failure observability payload attaches when
 * `providerFailure` is set. Not part of this module's public surface — both exported
 * payload builders below fold it in, so nothing outside needs to name it.
 */
interface TurnFailureClassificationFields extends Record<string, unknown> {
  failureKind?: LlmProviderFailureClassification["kind"];
  providerStatus?: number;
  providerCode?: string;
}

const turnFailureClassificationFields = (
  providerFailure: LlmProviderFailureClassification | null,
): TurnFailureClassificationFields =>
  providerFailure
    ? { failureKind: providerFailure.kind, providerStatus: providerFailure.status, providerCode: providerFailure.code }
    : {};

/**
 * Bounded, provider-agnostic message that replaces the error's own text once it is
 * classified against a provider call: a provider's error text can echo the customer's
 * rejected prompt back (see shared/infra/llm/providerErrors.ts), so a classified
 * failure's message never leaves this process. `undefined` for an unclassified
 * failure, whose own message stands — most such errors are this codebase's own, not
 * provider echoes.
 */
const boundedTurnFailureMessage = (
  providerFailure: LlmProviderFailureClassification | null,
): string | undefined => (providerFailure ? `LLM provider call failed: ${providerFailure.kind}` : undefined);

const turnFailureErrorMessage = (error: unknown, providerFailure: LlmProviderFailureClassification | null): string =>
  boundedTurnFailureMessage(providerFailure) ?? (error instanceof Error ? error.message : "Unknown error");

/** The exact `properties` for the `chat.failed` product analytics event. */
interface TurnFailureAnalyticsProperties extends TurnFailureClassificationFields {
  stream: boolean;
  errorMessage: string;
}

export const turnFailureAnalyticsProperties = (input: {
  stream: boolean;
  error: unknown;
  providerFailure: LlmProviderFailureClassification | null;
}): TurnFailureAnalyticsProperties => ({
  stream: input.stream,
  errorMessage: turnFailureErrorMessage(input.error, input.providerFailure),
  ...turnFailureClassificationFields(input.providerFailure),
});

interface TurnFailureReportMetadata extends TurnFailureClassificationFields {
  workspaceId: string;
  conversationId?: string;
  stage: "chat.answer";
  executionMode: TurnExecutionMode;
}

interface TurnFailureReportInput {
  errorType: "chat.turn_failed";
  error: unknown;
  message?: string;
  metadata: TurnFailureReportMetadata;
}

/**
 * The exact input for `ErrorReporter.report(...)`, or `null` when `isReportableFault`
 * says `error` is an expected, already-handled outcome rather than a fault worth one.
 */
export const turnFailureReportInput = (input: {
  workspaceId: string;
  conversationId?: string;
  executionMode?: TurnExecutionMode;
  error: unknown;
  providerFailure: LlmProviderFailureClassification | null;
}): TurnFailureReportInput | null => {
  if (!isReportableFault(input.error)) {
    return null;
  }
  const boundedMessage = boundedTurnFailureMessage(input.providerFailure);
  return {
    errorType: "chat.turn_failed",
    error: input.error,
    ...(boundedMessage ? { message: boundedMessage } : {}),
    metadata: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      stage: "chat.answer",
      executionMode: input.executionMode ?? "live",
      ...turnFailureClassificationFields(input.providerFailure),
    },
  };
};

/** A turn that returns its reply as a draft answers nobody has approved, so its audit records neither content. */
const auditsWithoutContent = (executionMode: TurnExecutionMode | undefined): boolean =>
  turnExecutionCapabilities(executionMode).completion === "return_draft";

/** Labels a non-live turn's audit records with its execution mode and the surface that ran it. */
export const executionModeAuditMetadata = (
  executionMode: TurnExecutionMode | undefined,
  surface: string | null | undefined,
): Record<string, unknown> | null =>
  executionMode === undefined || executionMode === "live"
    ? null
    : { executionMode, ...(surface ? { surface } : {}) };

/** The `chat.answer` failure audit event `ChatTurnLifecycle.recordFailure` persists. */
export const turnFailureAuditEvent = (input: {
  workspaceId: string;
  accountId?: string;
  conversationId?: string;
  stream: boolean;
  executionMode?: TurnExecutionMode;
  session: PreparedSession | null;
  existingAssistantMessageId: string | undefined;
  error: unknown;
  workflowPolicy: AssistantWorkflowPolicy;
  /** Precomputed by the caller (`getChatTurnRoute`) — absent exactly when `session` is. */
  route: ChatRoute | undefined;
}): AuditEventInput => {
  const { session, route } = input;
  const event: AuditEventInput = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType: "chat.answer",
    eventStatus: "failure",
    metadata: {
      stage: "chat.answer",
      workflow: input.workflowPolicy.workflow,
      executionClass: input.workflowPolicy.executionClass,
      conversationId: session?.conversation.id ?? input.conversationId,
      userMessageId: session?.userMessage.id,
      assistantMessageId: input.existingAssistantMessageId,
      stream: input.stream,
      citationCount: 0,
      retrieval: session?.retrieval.diagnostics,
      activityTrace: session?.retrieval.trace && route
        ? new ActivityTracePresenter().appendAnswerOutcome({
            trace: session.retrieval.trace,
            summary: new ActivitySummaryPresenter().present(session.retrieval.diagnostics, {
              execution: {
                surface: "assistant",
                path: route.type === "direct" ? "assistant_direct" : "assistant_retrieval",
                retrievalInvoked: route.type === "retrieval",
              },
            }),
            outcome: {
              answer: "",
              stream: input.stream,
              hadContexts: session.retrieval.contexts.length > 0,
              retrievalSkipped: session.retrieval.diagnostics.retrievalSkipped,
              durationMs: 0,
            },
          })
        : undefined,
      errorMessage: input.error instanceof Error ? input.error.message : "Unknown error",
      ...executionModeAuditMetadata(input.executionMode, session?.conversation.sourceChannel),
    },
  };
  return auditsWithoutContent(input.executionMode) ? reviewTurnFailureAuditEvent(event, input.error) : event;
};

/**
 * The `RoutineActivationFailure` warn log's fields, including the classified kind of
 * its `.cause` — `undefined` for anything else, including a normal turn failure that
 * never touched routine activation at all.
 */
export const routineActivationFailureFields = (error: unknown): Record<string, string> | undefined => {
  if (!(error instanceof Error) || error.name !== "RoutineActivationFailure") {
    return undefined;
  }
  const phase = "phase" in error && typeof error.phase === "string" ? error.phase : "unknown";
  const cause = error.cause;
  const causeFailure = classifyLlmProviderFailure(cause);
  return {
    event: "routine_activation_failed",
    phase,
    causeType: cause instanceof Error ? cause.name : typeof cause,
    ...(causeFailure ? { causeFailureKind: causeFailure.kind } : {}),
  };
};
