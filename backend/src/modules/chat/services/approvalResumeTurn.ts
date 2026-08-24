import type {
  ConversationEngine,
  ConversationTrace,
  RoutineState,
} from "@radioso/conversation-contract";

import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { PendingDecisionRecord } from "../../../db/repositories/pendingDecisionRepository.js";
import type { AgentService } from "../../agents/public.js";
import type { ResumeRunner } from "../../approvals/public.js";
import type { ChatGateway } from "../contracts/chatGateway.js";
import type { ChatAnswerPresenter } from "./chatAnswerPresenter.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import type { ChatTurnLifecycle } from "./chatTurnLifecycle.js";
import { buildChatTurnContext, type ChatRoutineProvider } from "./chatTurnAssembly.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { RoutineChatModelGateway } from "./routines/routineChatModelGateway.js";
import {
  createRoutineGroundedAnswerRenderer,
  presentRoutineRenderableAnswer,
} from "./routines/routineGroundedAnswerRenderer.js";
import type { CapturedRoutineTransition } from "./routines/deferredRoutineStore.js";
import {
  toConversationAgentConfig,
  toPreparedStagedContext,
} from "./conversationContractMappers.js";
import { resolveContextForTurn } from "../../context-variables/public.js";
import {
  type ConversationTurnLease,
  type ConversationTurnRegistry,
  type ConversationTurnStage,
} from "./conversationTurnRegistry.js";
import {
  createModelCallTraceCollector,
  runWithModelCallTrace,
  type ModelCallTraceCollector,
} from "../../../shared/observability/tracing/modelCallTraceContext.js";
import type { TurnSkill } from "./turnOutcome.js";

export interface SuspendedRoutineReader {
  loadSuspended(input: { sessionId: string }): Promise<RoutineState | null>;
}

export type ApprovalResumeTurnInput = Parameters<ResumeRunner["resume"]>[0];

export interface ApprovalResumeTurnOptions {
  conversationRepository: Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId">;
  messageRepository: Pick<MessageRepositoryPort, "listRecentByConversationId">;
  agentService?: Pick<AgentService, "resolve">;
  chatGateway: ChatGateway;
  chatAnswerPresenter: ChatAnswerPresenter;
  chatAnswerSupport?: ChatAnswerSupport;
  turnSkills: TurnSkill[];
  conversationEngine: ConversationEngine;
  chatTurnLifecycle: Pick<ChatTurnLifecycle, "completeAssistantTurn">;
  conversationTurnRegistry: Pick<ConversationTurnRegistry, "start">;
  routineProvider?: ChatRoutineProvider;
  suspendedRoutineReader?: SuspendedRoutineReader;
  detectResponseLanguage(input: {
    workspaceId: string;
    accountId?: string;
    query: string;
  }, session: PreparedSession): Promise<string | undefined>;
}

interface ResumeCoordination {
  lease: ConversationTurnLease;
}

/** Owns the durable HITL decision-resume turn, including its lease and trace. */
export class ApprovalResumeTurn {
  private readonly answerSupport: ChatAnswerSupport;

  constructor(private readonly options: ApprovalResumeTurnOptions) {
    this.answerSupport = options.chatAnswerSupport ?? new ChatAnswerSupport();
  }

  async resume(
    input: ApprovalResumeTurnInput,
  ): Promise<{
    conversationId: string;
    resumed: boolean;
    assistantMessageId?: string;
    ownershipChanged?: boolean;
  }> {
    const coordination: ResumeCoordination = {
      lease: this.options.conversationTurnRegistry.start(input.record.conversationId),
    };
    try {
      await coordination.lease.waitForPredecessor();
      const modelCallTrace = createModelCallTraceCollector();
      return await runWithModelCallTrace(
        modelCallTrace,
        () => this.resumeWithinTrace(input, coordination, modelCallTrace),
      );
    } catch (error) {
      let preferredError = error;
      try {
        this.checkTurnCancellation(coordination);
      } catch (cancellationError) {
        preferredError = cancellationError;
      }
      throw preferredError;
    } finally {
      coordination.lease.complete();
    }
  }

  asRunner(): ResumeRunner {
    return {
      resume: (input) => this.resume(input),
    };
  }

  private async resumeWithinTrace(
    input: ApprovalResumeTurnInput,
    coordination: ResumeCoordination,
    modelCallTrace: ModelCallTraceCollector,
  ): Promise<{
    conversationId: string;
    resumed: boolean;
    assistantMessageId?: string;
    ownershipChanged?: boolean;
  }> {
    if (!this.options.routineProvider || !this.options.suspendedRoutineReader) {
      throw new Error("approval_resume_routine_provider_missing");
    }
    if (!this.options.agentService) {
      throw new Error("approval_resume_agent_service_missing");
    }

    this.checkTurnCancellation(coordination, "preparing");
    let session = await this.prepareDecisionResumeSession(input.record);
    // A resumed routine renders its own reply, so it needs the same response-language guard
    // as every other turn — otherwise the renderer falls back to a weak hint and a routine
    // step authored in another language leaks through (issue #755).
    this.checkTurnCancellation(coordination, "routing");
    session = this.withResponseLanguage(session, await this.options.detectResponseLanguage({
      workspaceId: input.record.workspaceId,
      accountId: input.decidedBy,
      query: session.userMessage.content,
    }, session));
    this.checkTurnCancellation(coordination, "routing");
    const modelGateway = new RoutineChatModelGateway(this.options.chatGateway, {
      workspaceContext: this.answerSupport.buildChatWorkspaceContext(session),
      usageContext: this.answerSupport.buildChatUsageContext(session, input.decidedBy, "routine_turn"),
    });
    const routineTurnPorts = await this.options.routineProvider.forTurn({
      modelGateway,
      agentId: session.agent.id,
      workspaceId: session.conversation.workspaceId,
      accountId: input.decidedBy,
      pinnedRoutineIds: [input.record.routineId],
      responseLanguage: session.responseLanguage,
      groundedAnswerRenderer: createRoutineGroundedAnswerRenderer({
        session,
        accountId: input.decidedBy,
        responseLanguage: session.responseLanguage,
        turnSkills: this.options.turnSkills,
      }),
      throwIfCancelled: () => this.checkTurnCancellation(coordination, "routing"),
    });
    this.checkTurnCancellation(coordination, "routing");
    if (!routineTurnPorts) {
      throw new Error("approval_resume_routine_ports_missing");
    }

    this.checkTurnCancellation(coordination, "routing");
    const result = await this.options.conversationEngine.resumeAwaitingDecision({
      agent: toConversationAgentConfig(session.agent),
      turn: buildChatTurnContext(session),
      sessionId: input.record.sessionId,
      decision: {
        handle: input.record.handle,
        optionId: input.optionId,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      },
      suspendedReader: {
        loadSuspended: (query) => this.options.suspendedRoutineReader!.loadSuspended(query),
      },
      routineRunner: routineTurnPorts.runner,
    });
    this.checkTurnCancellation(coordination, "rendering");

    if (!result.resumed) {
      throw new Error("approval_resume_suspended_state_missing");
    }

    const routineStateTransition: CapturedRoutineTransition = result.nextState
      ? { kind: "save", state: result.nextState }
      : { kind: "clear", sessionId: input.record.sessionId };
    const presentation = presentRoutineRenderableAnswer(this.options.chatAnswerPresenter, result.response);

    this.beginTurnEmission(coordination);
    const completed = await this.options.chatTurnLifecycle.completeAssistantTurn({
      workspaceId: input.record.workspaceId,
      accountId: input.decidedBy,
      session,
      presentation,
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: result.trace ? conversationTraceWithRoutineTrace(session.turnTrace, result.trace) : session.turnTrace,
      modelCallTrace,
      actions: result.actions,
      routineStateTransition,
      additionalAuditEvent: {
        accountId: input.decidedBy,
        workspaceId: input.record.workspaceId,
        eventType: "hitl.decision",
        eventStatus: "success",
        metadata: {
          handle: input.record.handle,
          conversationId: input.record.conversationId,
          agentId: input.record.agentId,
          routineId: input.record.routineId,
          stepId: input.record.stepId,
          optionId: input.optionId,
        },
      },
      transaction: input.transaction,
    });

    return {
      conversationId: input.record.conversationId,
      resumed: result.resumed,
      assistantMessageId: completed.assistantMessageId,
      ...(completed.ownershipChanged ? { ownershipChanged: true } : {}),
    };
  }

  private checkTurnCancellation(
    coordination: ResumeCoordination,
    stage?: ConversationTurnStage,
  ): void {
    if (stage) {
      coordination.lease.setStage(stage);
    }
    coordination.lease.throwIfCancelled();
  }

  private beginTurnEmission(coordination: ResumeCoordination): void {
    coordination.lease.beginEmission();
  }

  private withResponseLanguage(
    session: PreparedSession,
    responseLanguage: string | undefined,
  ): PreparedSession {
    return { ...session, responseLanguage };
  }

  private async prepareDecisionResumeSession(record: PendingDecisionRecord): Promise<PreparedSession> {
    const conversation = await this.options.conversationRepository.findByIdAndWorkspaceId(
      record.conversationId,
      record.workspaceId,
    );
    if (!conversation || conversation.agentId !== record.agentId) {
      throw new Error("approval_resume_conversation_not_found");
    }
    const agent = await this.options.agentService!.resolve(record.workspaceId, record.agentId);
    const history = await this.options.messageRepository.listRecentByConversationId(
      record.workspaceId,
      record.conversationId,
      RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages,
    );
    const userMessage = [...history].reverse().find((message) => message.role === "user");
    if (!userMessage) {
      throw new Error("approval_resume_user_message_missing");
    }
    const retrieval = this.directDecisionResumeRetrieval(record, agent);
    return {
      agent,
      conversation,
      history,
      retrieval,
      turnRoute: CHAT_TURN_ROUTE.DIRECT,
      turnFraming: { isIdentityQuestion: false },
      userMessage,
      effectiveQuery: userMessage.content,
      pageContext: null,
      stagedContext: [toPreparedStagedContext(retrieval)],
      resolvedContext: resolveContextForTurn(null),
      turnTrace: {
        traceId: `approval-resume-${record.handle}`,
        startedAt: new Date().toISOString(),
        stages: [],
        links: [],
      },
    };
  }

  private directDecisionResumeRetrieval(
    record: PendingDecisionRecord,
    agent: PreparedSession["agent"],
  ): PreparedSession["retrieval"] {
    const now = new Date().toISOString();
    return {
      rewrittenQuery: "",
      contexts: [],
      systemPrompt: "",
      prompt: "",
      citations: [],
      responseIdentity: agent.name.trim() ? { name: agent.name.trim() } : null,
      responseSettings: {
        citationDisplayEnabled: false,
        suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
        suggestedQuestionsCount: 0,
        customInstruction: agent.customInstruction,
        responseLanguagePolicy: "match_user_question",
        responseLanguage: agent.assistantDefaultLocale ?? undefined,
      },
      diagnostics: {
        execution: {
          surface: "assistant",
          path: "assistant_direct",
          retrievalInvoked: false,
        },
        rewriteStatus: "skipped",
        rerankStatus: "skipped",
        originalCandidateCount: 0,
        rewrittenCandidateCount: 0,
        lexicalCandidateCount: 0,
        normalizedCandidateCount: 0,
        finalContextCount: 0,
        retrievalSkipped: true,
        candidateFallbackApplied: false,
        fallbackApplied: false,
        rewriteEligible: false,
        rewriteRan: false,
        materialDisagreement: false,
        rewriteProposal: {
          rewrittenQuery: "",
          semanticQuery: "",
          lexicalQuery: "",
          responseLanguagePolicy: "match_user_question",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0,
        },
        triggerAnalysis: {
          status: "skipped_non_retrieval",
          consideredRules: [],
          matchedRuleIds: [],
          unmatchedRuleIds: [],
          matchCount: 0,
          matcherVersion: "approval_resume",
        },
      },
      trace: {
        traceId: `approval-resume-${record.handle}`,
        startedAt: now,
        completedAt: now,
        totalDurationMs: 0,
        stages: [],
        links: [],
      },
    };
  }
}

const conversationTraceWithRoutineTrace = (
  trace: ConversationTrace,
  routineTrace: NonNullable<Awaited<ReturnType<ConversationEngine["resumeAwaitingDecision"]>>["trace"]>,
): ConversationTrace => ({
  ...trace,
  stages: [
    ...trace.stages,
    {
      id: `routine-decision:${routineTrace.routineId}`,
      kind: "routine",
      status: "applied",
      startedAt: new Date().toISOString(),
      outputs: {
        routineId: routineTrace.routineId,
        filledSlotKeys: routineTrace.filledSlotKeys,
        steps: routineTrace.steps.map((step) => ({
          stepId: step.stepId,
          kind: step.kind,
          event: step.event,
        })),
      },
    },
  ],
});
