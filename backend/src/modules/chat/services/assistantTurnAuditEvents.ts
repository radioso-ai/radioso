import type { AuditEventInput } from "../../audit/contracts/index.js";
import type { ConversationOwnershipReason } from "../../../db/repositories/conversationOwnershipRepository.js";
import type { ActivityTrace, RewriteContinuityState } from "../../retrieval/public.js";
import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import {
  type AssistantTurnOutcome,
  type SkillTurnOutcome,
  legacyAnswerOutcomeForSkillTurnOutcome,
} from "./assistantTurnOutcomeTypes.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import { buildRewriteContinuityState } from "./rewriteContinuityState.js";
import type { ChatRoute, ChatSuggestion } from "../types/chatResponses.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { TurnTraceEnvelope } from "./turnTraceEnvelope.js";

export interface OwnershipHandoffInput {
  reason: ConversationOwnershipReason;
  routineId?: string;
  stepId?: string;
}

export interface AssistantTurnSuccessInput {
  workspaceId: string;
  accountId?: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  skillTurnOutcome: SkillTurnOutcome;
  answerOutcome?: AssistantTurnOutcome;
  citations: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  priorRewriteContinuityState?: RewriteContinuityState;
  diagnostics: PreparedSession["retrieval"]["diagnostics"];
  activityTrace: ActivityTrace;
  turnTrace?: TurnTraceEnvelope;
  route: ChatRoute;
  stream: boolean;
  groundingVerdict?: ChatPresentedAnswer["grounding"];
  groundingProtocolVersion?: 1 | 2 | null;
  groundingDiagnostics?: ChatPresentedAnswer["groundingDiagnostics"];
}

export const buildAssistantTurnSuccessAuditEvent = (input: AssistantTurnSuccessInput): AuditEventInput => {
  const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType: "chat.answer",
    eventStatus: "success",
    metadata: {
      workflow: workflowPolicy.workflow,
      executionClass: workflowPolicy.executionClass,
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      stream: input.stream,
      skillTurn: input.skillTurnOutcome,
      answerOutcome: input.answerOutcome ?? legacyAnswerOutcomeForSkillTurnOutcome(input.skillTurnOutcome),
      route: {
        generator: "assistant",
        routeType: input.route.type,
        routeReason: input.route.reason,
        retrievalInvoked: input.route.type === "retrieval",
      },
      citationCount: input.citations.length,
      citations: input.citations,
      answerSegments: input.answerSegments,
      suggestions: input.suggestions,
      groundingVerdict: input.groundingVerdict,
      groundingProtocolVersion: input.groundingProtocolVersion,
      groundingDiagnostics: input.groundingDiagnostics,
      rewriteContinuityState: buildRewriteContinuityState({
        previousState: input.priorRewriteContinuityState,
        diagnostics: input.diagnostics,
        citations: input.citations,
      }),
      retrieval: input.diagnostics,
      // Legacy flat trace, still read by the history path and the live frontend's
      // textual diagnostics. Retained until those consume the envelope's leaf.
      activityTrace: input.activityTrace,
      // Turn-trace envelope: conversation spine (root span) with capability traces
      // as typed leaves. The spine supersedes the old `conversationEngine.trace`
      // audit key (which nothing read), so that key is no longer written.
      ...(input.turnTrace ? { turnTrace: input.turnTrace } : {}),
    },
  };
};

export const buildAssistantTurnSuspendedAuditEvent = (input: AssistantTurnSuccessInput): AuditEventInput => ({
  accountId: input.accountId,
  workspaceId: input.workspaceId,
  eventType: "chat.suspended",
  eventStatus: "success",
  metadata: {
    workflow: "chat.turn",
    executionClass: "durable_async",
    conversationId: input.conversationId,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    stream: input.stream,
    skillTurn: input.skillTurnOutcome,
    answerOutcome: input.answerOutcome ?? legacyAnswerOutcomeForSkillTurnOutcome(input.skillTurnOutcome),
    route: {
      generator: "assistant",
      routeType: input.route.type,
      routeReason: input.route.reason,
      retrievalInvoked: input.route.type === "retrieval",
    },
    citationCount: input.citations.length,
    citations: input.citations,
    answerSegments: input.answerSegments,
    suggestions: input.suggestions,
    groundingVerdict: input.groundingVerdict,
    groundingProtocolVersion: input.groundingProtocolVersion,
    groundingDiagnostics: input.groundingDiagnostics,
    rewriteContinuityState: buildRewriteContinuityState({
      previousState: input.priorRewriteContinuityState,
      diagnostics: input.diagnostics,
      citations: input.citations,
    }),
    retrieval: input.diagnostics,
    activityTrace: input.activityTrace,
    ...(input.turnTrace ? { turnTrace: input.turnTrace } : {}),
  },
});

export const buildOwnershipHandoffAuditEvent = (input: OwnershipHandoffInput & {
  workspaceId: string;
  accountId?: string;
  conversationId: string;
  agentId: string;
}): AuditEventInput => ({
  accountId: input.accountId,
  workspaceId: input.workspaceId,
  eventType: "hitl.ownership",
  eventStatus: "success",
  metadata: {
    actor: {
      type: "system",
      source: "routine",
    },
    action: "handoff_requested",
    reason: input.reason,
    conversationId: input.conversationId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    routineId: input.routineId,
    stepId: input.stepId,
  },
});
