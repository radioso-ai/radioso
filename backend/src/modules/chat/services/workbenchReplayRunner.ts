import { randomUUID } from "node:crypto";

import type { ConversationEngine, RoutineState } from "@radioso/conversation-contract";

import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import {
  applyAgentConfigOverride,
  materializeAgentFromConfig,
  type InternalAgentConfig,
} from "../../agents/public.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import type { ChatGateway } from "../contracts/chatGateway.js";
import type { TurnTraceEnvelope } from "./turnTraceEnvelope.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import type { ChatAnswerPresenter } from "./chatAnswerPresenter.js";
import type { ChatRoutineProvider } from "./chatService.js";
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
import type { TurnRouter } from "./turnRouter.js";

export interface WorkbenchReplayResolvedConfig {
  composedInstructions?: string;
  modelProvider?: string;
  modelId?: string;
  retrievedChunks: Array<{
    chunkId: string;
    documentId: string;
    title: string;
    rank: number;
    similarity?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface WorkbenchReplayResult {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
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
  // Routine ports — when supplied, a replayed turn attempts the agent's routines
  // before grounding, exactly as the live chat turn does. When omitted, replay runs
  // the grounding/compose path only (legacy behavior).
  routineProvider?: ChatRoutineProvider;
  chatGateway?: Pick<ChatGateway, "answer">;
  chatAnswerPresenter?: ChatAnswerPresenter;
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

export class WorkbenchReplayRunner {
  private readonly preparer: ChatSessionPreparer;
  private readonly selectionStrategy: TurnSelectionStrategy;
  private readonly directiveRuntime: RouteScopedDirectiveRuntime;
  private readonly turnSkillSelector: ChatTurnSkillSelector;
  private readonly turnRouter: TurnRouter;
  private readonly answerSupport: ChatAnswerSupport;
  private readonly options: WorkbenchReplayRunnerOptions;

  constructor(options: WorkbenchReplayRunnerOptions) {
    this.selectionStrategy = options.selectionStrategy ?? new DefaultTurnSelectionStrategy();
    this.turnRouter = options.turnRouter;
    this.directiveRuntime = options.directiveSteering ?? noopRouteScopedDirectiveRuntime;
    this.answerSupport = new ChatAnswerSupport();
    this.turnSkillSelector = new ChatTurnSkillSelector(options.turnSkills, this.selectionStrategy);
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
    });

    // Routines are a pre-grounding skill: attempt them first, exactly as the live turn
    // does. If a routine claims the turn (activation or mid-routine resume), its reply
    // is the answer and grounding never runs; otherwise fall through.
    const routineResult = await this.attemptRoutine(session, input, agent);
    if (routineResult) {
      return routineResult;
    }

    // Route through the same classifier the live turn uses, so a replayed turn
    // takes the same retrieval-vs-direct path (Coach/preview fidelity).
    const routing = await this.turnRouter.classify({
      query: input.query,
      history: session.history,
      responseIdentity: session.retrieval.responseIdentity,
      customInstruction: session.agent.customInstruction,
      workspaceContext: { workspaceId: input.workspaceId },
      usageContext: {
        accountId: input.accountId ?? undefined,
        workspaceId: input.workspaceId,
        conversationId: session.conversation.id,
        messageId: session.userMessage.id,
        surface: "assistant",
        attemptKey: session.userMessage.id,
      },
    });
    session = routing.route === "retrieval"
      ? await this.preparer.prepareRetrieval(prepareInput, session, routing.framing)
      : await this.preparer.prepareDirect(prepareInput, session, routing.framing);

    const answerStartedAt = Date.now();
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: this.options.conversationEngine,
      session,
      turnSkillSelector: this.turnSkillSelector,
      turnSkills: this.options.turnSkills,
      directiveRuntime: this.directiveRuntime,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId ?? undefined,
    });
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
      turnTrace: tracePresentation.turnTrace,
      resolvedConfig: {
        composedInstructions: session.retrieval.systemPrompt,
        modelProvider: agent.chatModelOverride?.provider,
        modelId: agent.chatModelOverride?.model,
        retrievedChunks: session.retrieval.contexts.map((ctx, index) => ({
          chunkId: ctx.chunkId,
          documentId: ctx.documentId,
          title: ctx.title,
          rank: typeof ctx.promptPosition === "number" ? ctx.promptPosition : index,
          similarity: typeof ctx.similarity === "number" ? ctx.similarity : undefined,
          metadata: ctx.metadata,
        })),
      },
    };
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
      responseLanguage: Promise.resolve(session.responseLanguage ?? undefined),
      groundedAnswerRenderer: createRoutineGroundedAnswerRenderer({
        session,
        accountId: input.accountId ?? undefined,
        responseLanguage: Promise.resolve(session.responseLanguage ?? undefined),
        turnSkills: this.options.turnSkills,
      }),
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
      turnTrace: tracePresentation.turnTrace,
      resolvedConfig: {
        composedInstructions: session.retrieval.systemPrompt,
        modelProvider: agent.chatModelOverride?.provider,
        modelId: agent.chatModelOverride?.model,
        // The routine path renders its own reply and does not run turn-level grounding,
        // so there are no turn-level retrieved chunks to report.
        retrievedChunks: [],
      },
    };
  }
}
