import { randomUUID } from "node:crypto";

import type { ConversationEngine } from "@radioso/conversation-contract";

import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import {
  applyAgentConfigOverride,
  materializeAgentFromConfig,
  type InternalAgentConfig,
} from "../../agents/public.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import type { TurnTraceEnvelope } from "./turnTraceEnvelope.js";
import {
  ChatSessionPreparer,
  type PrepareChatSessionInput,
} from "./chatSessionPreparer.js";
import {
  buildTurnTraceForPresentation,
} from "./chatTurnLifecycle.js";
import {
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
}

export interface WorkbenchReplayInput {
  workspaceId: string;
  accountId?: string | null;
  sourceAgentId: string;
  baselineAgentConfig: InternalAgentConfig;
  agentConfigOverride?: Partial<InternalAgentConfig>;
  query: string;
  history: MessageRecord[];
  userExpectedLocale?: string | null;
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
    anonymousSessionId: null,
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
  private readonly options: WorkbenchReplayRunnerOptions;

  constructor(options: WorkbenchReplayRunnerOptions) {
    this.selectionStrategy = options.selectionStrategy ?? new DefaultTurnSelectionStrategy();
    this.directiveRuntime = options.directiveSteering ?? noopRouteScopedDirectiveRuntime;
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
    const candidates = this.selectionStrategy.select({
      session,
      directives: session.directiveSteering?.matches ?? [],
    });
    session = candidates.includes("retrieval")
      ? await this.preparer.prepareRetrieval(prepareInput, session)
      : await this.preparer.prepareDirect(prepareInput, session);

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
        })),
      },
    };
  }
}
