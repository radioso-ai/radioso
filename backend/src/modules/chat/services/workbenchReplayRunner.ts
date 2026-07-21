import { randomUUID } from "node:crypto";

import type {
  ConversationEngine,
  ConversationRetrievalWorkPort,
  ConversationTurnInterpreter,
  RoutineState,
} from "@radioso/conversation-contract";

import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import {
  applyAgentConfigOverride,
  authoredDirectiveToSteeringDirective,
  materializeAgentFromConfig,
  type InternalAgentConfig,
} from "../../agents/public.js";
import type { StructuredRewriteResult } from "../../retrieval/public.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import {
  contextualDirectiveCandidates,
  lazyPromise,
  planAwareResponseLanguage,
  startTurnPlan,
  type TurnPlanCoordinator,
  type TurnPlanningGate,
} from "./turnPlanCoordinator.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import type { ChatGateway } from "../contracts/chatGateway.js";
import type { TurnTraceEnvelope } from "./turnTraceEnvelope.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import type { ChatAnswerPresenter } from "./chatAnswerPresenter.js";
import type { ChatRoutineProvider } from "./chatService.js";
import {
  resolveConversationTurnInterpretationContext,
  type ChatConversationTurnInterpreter,
  type TurnInterpretationContextSettings,
} from "./conversationTurnInterpreter.js";
import { RoutineChatModelGateway } from "./routines/routineChatModelGateway.js";
import { InMemoryRoutineStore } from "./routines/inMemoryRoutineStore.js";
import {
  createRoutineGroundedAnswerRenderer,
  presentRoutineRenderableAnswer,
} from "./routines/routineGroundedAnswerRenderer.js";
import {
  ChatSessionPreparer,
  type PrepareChatSessionInput,
  type PreparedSession,
} from "./chatSessionPreparer.js";
import {
  buildTurnTraceForPresentation,
} from "./chatTurnLifecycle.js";
import {
  attemptRoutineTurnWithConversationEngine,
  runPreparedChatTurnWithConversationEngine,
} from "./conversationEngineChatTurn.js";
import {
  noopRouteScopedDirectiveRuntime,
  type RouteScopedDirectiveRuntime,
} from "./routeScopedDirectiveSteering.js";
import type { RetrievalTurnPort } from "./retrievalTurnDispatch.js";
import type { TurnSkill } from "./turnOutcome.js";
import {
  DefaultTurnSelectionStrategy,
  type TurnSelectionStrategy,
} from "./turnSelectionStrategy.js";
import { ChatTurnSkillSelector } from "./turnSkillSelector.js";
import type { AgentSkillTurnRuntime, AgentSkillTurnSkillProvider } from "./agentSkillTurnSkillProvider.js";
import type { TurnRouter } from "./turnRouter.js";
import type { GroundingSummary } from "./groundingAssertions.js";
import type { ResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";
import {
  commitDirectiveFirings,
  emptyDirectiveFiringState,
  type DirectiveFiringState,
  type DirectiveStateStore,
} from "../../directives/public.js";
export interface WorkbenchReplayResolvedConfig {
  composedInstructions?: string;
  modelProvider?: string;
  modelId?: string;
  /**
   * The frozen rolling summary (#866) this replayed turn was given, echoed so an
   * operator can confirm the replay injected the same pre-window context a live
   * turn would. Absent when the snapshot carried no summary. Also surfaced as a
   * `conversation_summary` activity-trace stage; this echo lets the workbench
   * compare live-vs-replay on the summary without walking the trace.
   */
  conversationSummary?: string;
  retrievedChunks: Array<{
    chunkId: string;
    documentId: string;
    title: string;
    rank: number;
    similarity?: number;
    fusedScore?: number;
    semanticScore?: number;
    lexicalScore?: number;
    lexicalRankScore?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface WorkbenchReplayResult {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  groundingSummary?: GroundingSummary;
  turnTrace?: TurnTraceEnvelope;
  resolvedConfig: WorkbenchReplayResolvedConfig;
}

export interface WorkbenchReplayRunnerOptions {
  retrievalTurn: RetrievalTurnPort;
  auditService: AuditService;
  turnSkills: TurnSkill[];
  selectionStrategy?: TurnSelectionStrategy;
  directiveSteering?: RouteScopedDirectiveRuntime;
  conversationEngine: ConversationEngine;
  /** Same classifier the live turn uses, so a replayed turn takes the same route. */
  turnRouter: TurnRouter;
  /**
   * Same interpretation path the live turn uses when wired. Unlike the legacy router,
   * this consumes the frozen conversation summary and can return rewrite proposals.
   */
  turnInterpreter?: ChatConversationTurnInterpreter;
  /** Same staged response-language detector live chat uses. */
  responseLanguageDetector?: ResponseLanguageDetector;
  // Routine ports — when supplied, a replayed turn attempts the agent's routines
  // before grounding, exactly as the live chat turn does. When omitted, replay runs
  // the grounding/compose path only (legacy behavior).
  routineProvider?: ChatRoutineProvider;
  chatGateway?: Pick<ChatGateway, "answer">;
  chatAnswerPresenter?: ChatAnswerPresenter;
  /**
   * Same per-session agent-skill turn runtime live chat uses, so a replayed turn
   * with a directive-bound agent skill selects and dispatches exactly like
   * production. When omitted, only the static turn skills are selectable.
   */
  agentSkillTurnSkillProvider?: AgentSkillTurnSkillProvider;
  /**
   * Fused turn planning (paired with
   * {@link WorkbenchReplayRunnerOptions.turnPlanningGate}). Composition wires the
   * SAME coordinator + gate live chat uses, so a replayed turn executes the
   * identical planner-or-staged schedule under the same gating semantics.
   */
  turnPlanCoordinator?: TurnPlanCoordinator;
  turnPlanningGate?: TurnPlanningGate;
  /** Retrieval-owned settings seams used to preserve custom rewrite guidance. */
  turnPlanInterpretationContextSettings?: TurnInterpretationContextSettings;
}

/**
 * A starting routine position for a replayed turn. It is the full {@link RoutineState}
 * minus `sessionId` (the runner injects the ephemeral conversation id). Providing it
 * resumes the routine mid-flight at `path.at(-1)` with `variables`/`attempts` intact;
 * omitting it lets a routine activate fresh if its trigger matches this turn.
 */
export type WorkbenchReplayRoutineStartState = Omit<RoutineState, "sessionId">;

export interface WorkbenchReplayInput {
  workspaceId: string;
  accountId?: string | null;
  sourceAgentId: string;
  baselineAgentConfig: InternalAgentConfig;
  agentConfigOverride?: Partial<InternalAgentConfig>;
  query: string;
  history: MessageRecord[];
  userExpectedLocale?: string | null;
  routineStartState?: WorkbenchReplayRoutineStartState | null;
  /**
   * Rolling conversation summary (#866) frozen in the snapshot at capture time. Threaded
   * into the prepared session so a replayed turn injects the same pre-window context a
   * live turn would (turn interpretation + grounded/direct answer). Absent ⇒ no summary,
   * exactly as a short conversation. Replay never regenerates or persists the summary.
   */
  conversationSummary?: string | null;
}

const ephemeralConversation = (
  workspaceId: string,
  agentId: string | null,
): ConversationRecord => {
  const now = new Date();
  return {
    id: randomUUID(),
    workspaceId,
    agentId,
    agentName: null,
    sourceChannel: "workbench_replay",
    sourceOrigin: null,
    channelContext: null,
    anonymousSessionId: null,
    verifiedCustomerId: null,
    createdAt: now,
    updatedAt: now,
  };
};

const createNoopConversationRepository = (): ConversationRepositoryPort => ({
  async create(workspaceId, agentId) {
    return ephemeralConversation(workspaceId, agentId ?? null);
  },
  async createWithInitialAssistantMessage() {
    throw new Error("workbench_replay_unexpected_initial_assistant_message");
  },
  async listPageByWorkspaceId() {
    return { conversations: [], total: 0, nextCursor: null, hasMore: false };
  },
  async countByWorkspaceId() {
    return 0;
  },
  async listPageByAnonymousSession() {
    return { conversations: [], total: 0, nextCursor: null, hasMore: false };
  },
  async findByIdAndWorkspaceId() {
    return null;
  },
  async findByIdAndAnonymousSession() {
    return null;
  },
  async setVerifiedCustomerId() {},
  async touch() {},
});

const createNoopMessageRepository = (): MessageRepositoryPort => ({
  async listByConversationId() {
    return [];
  },
  async listRecentByConversationId() {
    return [];
  },
  async countByConversationId() {
    return 0;
  },
  async listWindowByConversationId() {
    return { messages: [], total: 0, nextCursor: null, hasMore: false };
  },
  async listSinceByConversationId() {
    return { messages: [], latestCursor: null };
  },
  async summarizeByConversationIds() {
    return new Map();
  },
  async create(input) {
    return {
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      role: input.role,
      content: input.content,
      inputMetadata: input.inputMetadata,
      metadata: input.metadata,
      skillName: input.skillName,
      skillOutcome: input.skillOutcome,
      skillStatus: input.skillStatus,
      createdAt: new Date(),
    };
  },
});

const cloneDirectiveFiringState = (state: DirectiveFiringState): DirectiveFiringState => ({
  turnSeq: state.turnSeq,
  firings: Object.fromEntries(
    Object.entries(state.firings).map(([name, firing]) => [name, { ...firing }]),
  ),
});

const directiveFiringNamesFromMetadata = (metadata: Record<string, unknown> | undefined): string[] => {
  const value = metadata?.directiveFirings;
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((name): name is string => typeof name === "string" && name.length > 0))];
};

const replayDirectiveStateFromHistory = (history: readonly MessageRecord[]): DirectiveFiringState | null => {
  let state: DirectiveFiringState | null = null;
  for (const message of history) {
    if (message.role !== "assistant") {
      continue;
    }
    const firedNames = directiveFiringNamesFromMetadata(message.metadata);
    if (!state && firedNames.length === 0) {
      continue;
    }
    state = commitDirectiveFirings(state ?? emptyDirectiveFiringState(), firedNames);
  }
  return state;
};

class ReplayDirectiveStateStore implements DirectiveStateStore {
  constructor(private state: DirectiveFiringState | null) {}

  async load(): Promise<DirectiveFiringState | null> {
    return this.state ? cloneDirectiveFiringState(this.state) : null;
  }

  async save(input: { state: DirectiveFiringState }): Promise<void> {
    this.state = cloneDirectiveFiringState(input.state);
  }
}

export class WorkbenchReplayRunner {
  private readonly preparer: ChatSessionPreparer;
  private readonly selectionStrategy: TurnSelectionStrategy;
  private readonly directiveRuntime: RouteScopedDirectiveRuntime;
  private readonly turnRouter: TurnRouter;
  private readonly turnInterpreter?: ChatConversationTurnInterpreter;
  private readonly answerSupport: ChatAnswerSupport;
  private readonly options: WorkbenchReplayRunnerOptions;

  constructor(options: WorkbenchReplayRunnerOptions) {
    this.selectionStrategy = options.selectionStrategy ?? new DefaultTurnSelectionStrategy();
    this.turnRouter = options.turnRouter;
    this.turnInterpreter = options.turnInterpreter;
    this.directiveRuntime = options.directiveSteering ?? noopRouteScopedDirectiveRuntime;
    this.answerSupport = new ChatAnswerSupport();
    this.preparer = new ChatSessionPreparer(
      createNoopConversationRepository(),
      createNoopMessageRepository(),
      options.retrievalTurn,
      options.auditService,
      undefined,
      undefined,
    );
    this.options = options;
  }

  async run(input: WorkbenchReplayInput): Promise<WorkbenchReplayResult> {
    const mergedConfig = applyAgentConfigOverride(
      input.baselineAgentConfig,
      input.agentConfigOverride ?? {},
    );
    const agent = materializeAgentFromConfig(mergedConfig, {
      agentId: input.sourceAgentId,
      workspaceId: input.workspaceId,
    });
    const prepareInput: PrepareChatSessionInput = {
      workspaceId: input.workspaceId,
      agentId: agent.id,
      query: input.query,
      sourceChannel: "workbench_replay",
    };

    let session = await this.preparer.prepare(prepareInput, {
      skipRetrieval: true,
      preResolvedAgent: agent,
      preResolvedHistory: input.history,
      preResolvedConversationSummary: input.conversationSummary ?? undefined,
    });
    const directiveStateStore = new ReplayDirectiveStateStore(
      replayDirectiveStateFromHistory(input.history),
    );

    // Fused turn planning: create the same lazy plan handle live chat creates, under
    // the same gate, so replay executes the identical planner-or-staged schedule.
    // A seeded routine state (active or suspended) bypasses planning exactly like a
    // live active/parked routine; replay has no pending-clarification concept.
    this.startReplayTurnPlan(session, input);
    const responseLanguagePromise = this.replayResponseLanguagePromise(session);

    // Routines are a pre-grounding skill: attempt them first, exactly as the live turn
    // does. If a routine claims the turn (activation or mid-routine resume), its reply
    // is the answer and grounding never runs; otherwise fall through.
    const routineResult = await this.attemptRoutine(
      session,
      input,
      agent,
      directiveStateStore,
      responseLanguagePromise,
    );
    if (routineResult) {
      return routineResult;
    }

    // Mirror live chat's per-session selection runtime: hydrate directive-bindable
    // agent skills so a replayed bound turn selects, dispatches, and stages lookup
    // tools like production.
    const agentSkillRuntime = await this.options.agentSkillTurnSkillProvider?.forSession(session);
    const turnSkills = [...this.options.turnSkills, ...(agentSkillRuntime?.turnSkills ?? [])];
    const turnSkillSelector = new ChatTurnSkillSelector(turnSkills, this.selectionStrategy, {
      agentSkillStates: agentSkillRuntime?.skillStates,
    });
    const sessionRef = { current: session };
    const { turnInterpreter, retrievalWork } = this.buildEnginePreparationPorts({
      input,
      prepareInput,
      sessionRef,
      responseLanguagePromise,
      agenticRetrievalToolFactories: agentSkillRuntime?.agenticRetrievalToolFactories,
    });

    const answerStartedAt = Date.now();
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: this.options.conversationEngine,
      session,
      getSession: () => sessionRef.current,
      turnSkillSelector,
      turnSkills,
      directiveRuntime: this.directiveRuntime,
      directiveStateStore,
      turnInterpreter,
      retrievalWork,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId ?? undefined,
    });
    session = sessionRef.current;
    const tracePresentation = buildTurnTraceForPresentation({
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? undefined,
      session,
      presentation,
      answerStartedAt,
      stream: false,
      engineTrace: result.trace,
    });

    return {
      answer: presentation.answer,
      citations: presentation.citations,
      answerSegments: presentation.answerSegments,
      groundingSummary: presentation.groundingSummary,
      turnTrace: tracePresentation.turnTrace,
      resolvedConfig: {
        composedInstructions: session.retrieval.systemPrompt,
        modelProvider: agent.chatModelOverride?.provider,
        modelId: agent.chatModelOverride?.model,
        ...(session.conversationSummary ? { conversationSummary: session.conversationSummary } : {}),
        retrievedChunks: session.retrieval.contexts.map((ctx, index) => ({
          chunkId: ctx.chunkId,
          documentId: ctx.documentId,
          title: ctx.title,
          rank: typeof ctx.promptPosition === "number" ? ctx.promptPosition : index,
          similarity: typeof ctx.similarity === "number" ? ctx.similarity : undefined,
          fusedScore: typeof ctx.fusedScore === "number" ? ctx.fusedScore : undefined,
          semanticScore: typeof ctx.semanticScore === "number" ? ctx.semanticScore : undefined,
          lexicalScore: typeof ctx.lexicalScore === "number" ? ctx.lexicalScore : undefined,
          lexicalRankScore: typeof ctx.lexicalRankScore === "number" ? ctx.lexicalRankScore : undefined,
          metadata: ctx.metadata,
        })),
      },
    };
  }

  /**
   * Mirrors {@link ChatService}'s plan start for replay: the same shared
   * `startTurnPlan` helper, gate semantics, union-of-routes directive candidates,
   * and usage attribution — so a replayed turn's planner call and consumption
   * match the live schedule exactly.
   */
  private startReplayTurnPlan(session: PreparedSession, input: WorkbenchReplayInput): void {
    const additionalDirectives = (session.agent.authoredDirectives ?? []).map(authoredDirectiveToSteeringDirective);
    const query = session.effectiveQuery ?? session.userMessage.content;
    const handle = startTurnPlan({
      coordinator: this.options.turnPlanCoordinator,
      gate: this.options.turnPlanningGate,
      workspaceId: session.agent.workspaceId,
      bypass: {
        activeRoutine: input.routineStartState?.status === "active",
        suspendedRoutine: input.routineStartState != null && input.routineStartState.status !== "active",
      },
      plan: () => ({
        query,
        history: session.history,
        ...resolveConversationTurnInterpretationContext({
          workspaceId: session.agent.workspaceId,
          responseIdentity: session.retrieval.responseIdentity,
          customInstruction: session.agent.customInstruction,
          agentSkillSettings: session.agent.skillSettings,
          conversationSummary: session.conversationSummary,
        }, this.options.turnPlanInterpretationContextSettings),
        directiveCandidates: contextualDirectiveCandidates({
          routes: [session.turnRoute, CHAT_TURN_ROUTE.DIRECT, CHAT_TURN_ROUTE.RETRIEVAL],
          directivesForRoute: (route) =>
            this.directiveRuntime.directivesFor({
              workspaceId: session.agent.workspaceId,
              accountId: input.accountId ?? undefined,
              additionalDirectives,
              turnContext: { query, route },
            }),
        }),
        workspaceContext: { workspaceId: session.agent.workspaceId },
        usageContext: {
          accountId: input.accountId ?? undefined,
          workspaceId: session.agent.workspaceId,
          conversationId: session.conversation.id,
          messageId: session.userMessage.id,
          surface: "assistant",
          operation: "turn_planning",
          attemptKey: `${session.userMessage.id}:turn_planning`,
        },
      }),
    });
    if (handle) {
      session.turnPlan = handle;
    }
  }

  /** Use the fused plan's language on the fast path and the live staged detector otherwise. */
  private replayResponseLanguagePromise(session: PreparedSession): Promise<string | undefined> {
    const staged = async (): Promise<string | undefined> => {
      if (!this.options.responseLanguageDetector) {
        return session.responseLanguage;
      }
      const detection = await this.options.responseLanguageDetector.detect({
        query: session.effectiveQuery ?? session.userMessage.content,
        history: session.history,
        workspaceContext: { workspaceId: session.agent.workspaceId },
        usageContext: {
          workspaceId: session.agent.workspaceId,
          conversationId: session.conversation.id,
          messageId: session.userMessage.id,
          surface: "assistant",
          operation: "response_language_detection",
          attemptKey: `${session.userMessage.id}:response_language_detection`,
        },
      });
      return detection.responseLanguage;
    };
    const handle = session.turnPlan;
    if (!handle) {
      return staged();
    }
    return lazyPromise(() =>
      planAwareResponseLanguage({
        handle: () => handle.resolve(null),
        fallback: staged,
      }),
    );
  }

  private buildEnginePreparationPorts(input: {
    input: WorkbenchReplayInput;
    prepareInput: PrepareChatSessionInput;
    sessionRef: { current: PreparedSession };
    responseLanguagePromise: Promise<string | undefined>;
    agenticRetrievalToolFactories?: AgentSkillTurnRuntime["agenticRetrievalToolFactories"];
  }): {
    turnInterpreter: ConversationTurnInterpreter;
    retrievalWork: ConversationRetrievalWorkPort;
  } {
    const turnInterpreter: ConversationTurnInterpreter = {
      interpret: async () => {
        const session = input.sessionRef.current;
        // Planned fast path: route + framing come from the shared fused plan, as in
        // live chat; the staged router classify below never runs on a planned turn.
        const plannedOutcome = session.turnPlan ? await session.turnPlan.resolve(null) : undefined;
        if (plannedOutcome?.status === "planned") {
          const plannedRouting = {
            route: plannedOutcome.plan.route,
            framing: plannedOutcome.plan.framing,
          };
          input.sessionRef.current = {
            ...session,
            turnRoute: plannedRouting.route,
            turnFraming: plannedRouting.framing,
            responseLanguage: await input.responseLanguagePromise,
          };
          if (plannedRouting.route === CHAT_TURN_ROUTE.DIRECT) {
            input.sessionRef.current = await this.preparer.prepareDirect(
              input.prepareInput,
              input.sessionRef.current,
              plannedRouting.framing,
            );
          }
          return {
            ...plannedRouting,
            metadata: {
              source: "planned",
              ...(plannedOutcome.plan.rewriteProposal
                ? { rewriteProposal: plannedOutcome.plan.rewriteProposal }
                : {}),
            },
          };
        }
        const interpreted = this.turnInterpreter
          ? await this.turnInterpreter.interpretChatTurn({
            query: input.input.query,
            history: session.history,
            responseIdentity: session.retrieval.responseIdentity,
            customInstruction: session.agent.customInstruction,
            workspaceId: input.input.workspaceId,
            accountId: input.input.accountId ?? undefined,
            conversationId: session.conversation.id,
            messageId: session.userMessage.id,
            agentSkillSettings: session.agent.skillSettings,
            conversationSummary: session.conversationSummary,
          })
          : await this.turnRouter.classify({
            query: input.input.query,
            history: session.history,
            responseIdentity: session.retrieval.responseIdentity,
            customInstruction: session.agent.customInstruction,
            workspaceContext: { workspaceId: input.input.workspaceId },
            usageContext: {
              accountId: input.input.accountId ?? undefined,
              workspaceId: input.input.workspaceId,
              conversationId: session.conversation.id,
              messageId: session.userMessage.id,
              surface: "assistant",
              attemptKey: session.userMessage.id,
            },
          });
        const routing = {
          route: interpreted.route,
          framing: interpreted.framing,
        };
        input.sessionRef.current = {
          ...session,
          turnRoute: routing.route,
          turnFraming: routing.framing,
        };
        if (routing.route === "direct") {
          input.sessionRef.current = await this.preparer.prepareDirect(
            input.prepareInput,
            input.sessionRef.current,
            routing.framing,
          );
        }
        return {
          route: routing.route,
          framing: routing.framing,
          metadata: "rewriteProposal" in interpreted && interpreted.rewriteProposal
            ? { rewriteProposal: interpreted.rewriteProposal }
            : undefined,
        };
      },
    };

    const retrievalWork: ConversationRetrievalWorkPort = {
      run: async ({ interpretation }) => {
        const rewriteProposal =
          interpretation.metadata?.rewriteProposal && typeof interpretation.metadata.rewriteProposal === "object"
            ? interpretation.metadata.rewriteProposal as StructuredRewriteResult
            : undefined;
        const agenticToolFactories = input.agenticRetrievalToolFactories?.(input.sessionRef.current) ?? [];
        const preparedInput = {
          ...input.prepareInput,
          ...(rewriteProposal ? { precomputedRewriteProposal: rewriteProposal } : {}),
          ...(agenticToolFactories.length > 0 ? { agenticToolFactories } : {}),
        };
        const directiveSteering = input.sessionRef.current.directiveSteering;
        const directiveStateStore = input.sessionRef.current.directiveStateStore;
        input.sessionRef.current = {
          ...input.sessionRef.current,
          responseLanguage: await input.responseLanguagePromise,
        };
        input.sessionRef.current = await this.preparer.prepareRetrieval(
          preparedInput,
          input.sessionRef.current,
          input.sessionRef.current.turnFraming,
        );
        if (directiveSteering) {
          input.sessionRef.current = {
            ...input.sessionRef.current,
            directiveSteering,
          };
        }
        if (directiveStateStore) {
          input.sessionRef.current = {
            ...input.sessionRef.current,
            directiveStateStore,
          };
        }
        return {
          stagedContext: input.sessionRef.current.stagedContext,
          trace: input.sessionRef.current.turnTrace,
        };
      },
    };

    return { turnInterpreter, retrievalWork };
  }

  /**
   * Mirrors {@link ChatService.attemptRoutineTurn} for replay: builds the per-turn
   * routine ports, seeds an in-memory store (empty = activation, populated = resume),
   * and runs the routine. Returns the routine's reply when it claims the turn, or null
   * so the caller falls through to grounding. Read-only — never touches live state.
   */
  private async attemptRoutine(
    session: PreparedSession,
    input: WorkbenchReplayInput,
    agent: ReturnType<typeof materializeAgentFromConfig>,
    directiveStateStore: DirectiveStateStore,
    responseLanguagePromise: Promise<string | undefined>,
  ): Promise<WorkbenchReplayResult | null> {
    const { routineProvider, chatGateway, chatAnswerPresenter } = this.options;
    if (!routineProvider || !chatGateway || !chatAnswerPresenter) {
      return null;
    }

    const store = new InMemoryRoutineStore(
      input.routineStartState
        ? { ...input.routineStartState, sessionId: session.conversation.id }
        : null,
    );
    const activeRoutine = await store.loadActive({ sessionId: session.conversation.id });

    const modelGateway = new RoutineChatModelGateway(chatGateway, {
      workspaceContext: this.answerSupport.buildChatWorkspaceContext(session),
      usageContext: this.answerSupport.buildChatUsageContext(
        session,
        input.accountId ?? undefined,
        "workbench_routine_replay",
      ),
    });
    const ports = await routineProvider.forTurn({
      modelGateway,
      agentId: session.agent.id,
      workspaceId: session.conversation.workspaceId,
      accountId: input.accountId ?? undefined,
      // Pin the seeded routine so its resume-only registration loads even if it would
      // not be offered for fresh activation this turn.
      pinnedRoutineIds: activeRoutine?.status === "active" ? [activeRoutine.routineId] : [],
      responseLanguage: responseLanguagePromise,
      groundedAnswerRenderer: createRoutineGroundedAnswerRenderer({
        session,
        accountId: input.accountId ?? undefined,
        responseLanguage: responseLanguagePromise,
        turnSkills: this.options.turnSkills,
      }),
      turnPlan: session.turnPlan,
    });
    if (!ports) {
      return null;
    }

    const answerStartedAt = Date.now();
    const outcome = await attemptRoutineTurnWithConversationEngine({
      engine: this.options.conversationEngine,
      session,
      accountId: input.accountId ?? undefined,
      directiveRuntime: this.directiveRuntime,
      directiveStateStore,
      routineStore: store,
      routineRunner: ports.runner,
      routineActivator: ports.activator,
      routineSlotCorrection: ports.slotCorrection,
      routineReentryGate: ports.reentryGate,
      presentRoutineReply: (response) => presentRoutineRenderableAnswer(chatAnswerPresenter, response),
    });
    if (!outcome) {
      return null;
    }

    const tracePresentation = buildTurnTraceForPresentation({
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? undefined,
      session,
      presentation: outcome.presentation,
      answerStartedAt,
      stream: false,
      engineTrace: outcome.result.trace,
    });

    return {
      answer: outcome.presentation.answer,
      citations: outcome.presentation.citations,
      answerSegments: outcome.presentation.answerSegments,
      groundingSummary: outcome.presentation.groundingSummary,
      turnTrace: tracePresentation.turnTrace,
      resolvedConfig: {
        composedInstructions: session.retrieval.systemPrompt,
        modelProvider: agent.chatModelOverride?.provider,
        modelId: agent.chatModelOverride?.model,
        ...(session.conversationSummary ? { conversationSummary: session.conversationSummary } : {}),
        // The routine path renders its own reply and does not run turn-level grounding,
        // so there are no turn-level retrieved chunks to report.
        retrievedChunks: [],
      },
    };
  }
}
