import { notFound } from "../../../shared/domain/errors.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort, UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type { RetrievalPipelineService, RewriteContinuityState } from "../../retrieval/public.js";
import type { AgentRecord, AgentService } from "../../agents/public.js";
import { isAgentRetrievalEnabled } from "../../agents/public.js";
import { defaultWebsiteEmbedSettings } from "../../settings/contracts/websiteEmbed.js";
import type { AssistantPageContext } from "../types/assistantApi.js";
import { CHAT_TURN_ROUTE, ChatTurnIntentService, type ChatTurnRoute } from "./chatTurnIntentService.js";
import { normalizeRewriteContinuityState } from "./rewriteContinuityState.js";

type ChatIntentCapableRetrievalPipeline = Pick<RetrievalPipelineService, "run" | "interpret" | "runInterpreted" | "runWithoutRetrieval">;

interface ChatAnswerAuditMetadata {
  rewriteContinuityState?: RewriteContinuityState;
}

export interface PreparedSession {
  agent: AgentRecord;
  conversation: ConversationRecord;
  history: MessageRecord[];
  retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
  turnRoute: ChatTurnRoute;
  userMessage: MessageRecord;
  pageContext?: AssistantPageContext | null;
  priorRewriteContinuityState?: RewriteContinuityState;
}

export interface PrepareChatSessionInput {
  workspaceId: string;
  agentId?: string | null;
  conversationId?: string;
  query: string;
  inputMetadata?: UserMessageInputMetadata;
  metadataFilter?: Record<string, unknown>;
  pageContext?: AssistantPageContext | null;
  sourceChannel?: string | null;
  anonymousSessionId?: string | null;
  sourceOrigin?: string | null;
}

export class ChatSessionPreparer {
  private readonly chatTurnIntentService = new ChatTurnIntentService();

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly retrievalPipeline: RetrievalPipelineService,
    private readonly auditService: AuditService,
    private readonly workspaceRepository?: Pick<WorkspaceRepositoryPort, "findById">,
    private readonly agentService?: Pick<AgentService, "resolve">,
  ) {}

  async prepare(input: PrepareChatSessionInput): Promise<PreparedSession> {
    const conversation = input.conversationId
      ? await this.ensureConversation(input.conversationId, input.workspaceId, input.anonymousSessionId)
      : null;
    const agent = this.agentService
      ? await this.agentService.resolve(input.workspaceId, input.agentId ?? conversation?.agentId ?? null)
      : await this.resolveLegacyAgent(input.workspaceId);
    if (conversation?.agentId && conversation.agentId !== agent.id) {
      throw notFound("Conversation not found");
    }
    const history = conversation
      ? await this.messageRepository.listRecentByConversationId(
          input.workspaceId,
          conversation.id,
          RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages,
        )
      : [];
    const rewriteContinuityState = conversation
      ? await this.loadRewriteContinuityState(input.workspaceId, conversation.id)
      : undefined;
    const responseIdentity = this.resolveResponseIdentity(agent);
    const pipelineInput = {
      workspaceId: input.workspaceId,
      query: input.query,
      history,
      responseIdentity,
      responseBehavior: {
        customInstruction: agent.customInstruction,
        suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
        suggestedQuestionsCount: 3,
      },
      responseBehaviorEnabled: true,
      metadataFilter: input.metadataFilter,
      sourceScope: agent.sourceScope,
    };

    const retrievalPipeline = this.retrievalPipeline as ChatIntentCapableRetrievalPipeline;
    const { retrieval, turnRoute } = isAgentRetrievalEnabled(agent)
      ? await this.prepareRetrievalEnabledTurn(retrievalPipeline, pipelineInput)
      : this.prepareDirectOnlyTurn(pipelineInput, agent);
    const persistedConversation =
      conversation ?? await this.conversationRepository.create(
        input.workspaceId,
        agent.id,
        input.sourceChannel ?? null,
        input.anonymousSessionId ?? null,
        input.sourceOrigin ?? null,
      );

    const userMessage = await this.messageRepository.create({
      conversationId: persistedConversation.id,
      workspaceId: input.workspaceId,
      role: "user",
      content: input.query,
      inputMetadata: input.inputMetadata,
    });

    return {
      agent,
      conversation: persistedConversation,
      history,
      retrieval,
      turnRoute,
      userMessage,
      pageContext: input.pageContext ?? null,
      priorRewriteContinuityState: rewriteContinuityState,
    };
  }

  private async prepareRetrievalEnabledTurn(
    retrievalPipeline: ChatIntentCapableRetrievalPipeline,
    pipelineInput: Parameters<ChatIntentCapableRetrievalPipeline["interpret"]>[0],
  ) {
    const interpretation = await retrievalPipeline.interpret(pipelineInput);
    const turnRoute = this.chatTurnIntentService.resolve({
      responseIntent: interpretation.interpretation.result.responseIntent,
    });
    const interpretedWithExecution = {
      ...interpretation,
      request: {
        ...interpretation.request,
        execution: {
          surface: "assistant" as const,
          path: turnRoute === CHAT_TURN_ROUTE.RETRIEVAL ? "assistant_retrieval" as const : "assistant_direct" as const,
          retrievalInvoked: turnRoute === CHAT_TURN_ROUTE.RETRIEVAL,
        },
      },
    };
    const retrieval = turnRoute === CHAT_TURN_ROUTE.RETRIEVAL
      ? await retrievalPipeline.runInterpreted(interpretedWithExecution)
      : await retrievalPipeline.runWithoutRetrieval(interpretedWithExecution);

    return { retrieval, turnRoute };
  }

  private prepareDirectOnlyTurn(
    input: Parameters<ChatIntentCapableRetrievalPipeline["interpret"]>[0],
    agent: AgentRecord,
  ) {
    const now = new Date().toISOString();
    return {
      turnRoute: CHAT_TURN_ROUTE.SOCIAL_ONLY,
      retrieval: {
        rewrittenQuery: input.query,
        contexts: [],
        systemPrompt: "",
        prompt: "",
        citations: [],
        responseIdentity: input.responseIdentity ?? null,
        responseSettings: {
          citationDisplayEnabled: false,
          answerSupportValidationEnabled: false,
          suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
          suggestedQuestionsCount: 3,
          customInstruction: agent.customInstruction,
          responseLanguagePolicy: "match_user_question" as const,
        },
        diagnostics: {
          execution: {
            surface: "assistant" as const,
            path: "assistant_direct" as const,
            retrievalInvoked: false,
          },
          rewriteStatus: "skipped" as const,
          rerankStatus: "skipped" as const,
          originalCandidateCount: 0,
          rewrittenCandidateCount: 0,
          lexicalCandidateCount: 0,
          normalizedCandidateCount: 0,
          finalContextCount: 0,
          responseIntent: "social_only" as const,
          retrievalSkipped: true,
          candidateFallbackApplied: false,
          fallbackApplied: false,
          rewriteEligible: false,
          rewriteRan: false,
          materialDisagreement: false,
          triggerAnalysis: {
            status: "skipped_non_retrieval" as const,
            consideredRules: [],
            matchedRuleIds: [],
            unmatchedRuleIds: [],
            matchCount: 0,
            matcherVersion: "agent_direct",
          },
        },
        trace: {
          traceId: `agent-direct-${agent.id}`,
          startedAt: now,
          completedAt: now,
          totalDurationMs: 0,
          stages: [],
          links: [],
        },
      },
    };
  }

  private resolveResponseIdentity(agent: AgentRecord): ResponseIdentity | null {
    const name = agent.name.trim();
    return name
      ? {
          name,
        }
      : null;
  }

  private async resolveLegacyAgent(workspaceId: string): Promise<AgentRecord> {
    if (!this.workspaceRepository) {
      const now = new Date();
      return {
        id: workspaceId,
        workspaceId,
        name: "",
        customInstruction: "",
        suggestedQuestionsEnabled: true,
        retrievalEnabled: true,
        sourceScope: { mode: "all" },
        logo: null,
        // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
        theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
        greetingInstruction: "",
        assistantDefaultLocale: null,
        proactiveGreetingEnabled: false,
        surfaceSettings: {
          authenticatedChat: {
            enabled: true,
          },
          anonymousChat: {
            enabled: false,
            token: null,
          },
          websiteEmbed: {
            enabled: false,
            token: null,
            allowedOrigins: [],
            launcherLabel: "Chat with us",
            launcherPosition: "bottom-right",
            // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
            theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
            copy: {},
            expertOverrides: {},
          },
          extensions: {},
        },
        createdAt: now,
        updatedAt: now,
      };
    }

    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (!workspace) {
      throw notFound("Workspace not found");
    }
    return {
      id: workspace.defaultAgentId ?? workspace.id,
      workspaceId,
      name: workspace.assistantName,
      customInstruction: "",
      suggestedQuestionsEnabled: true,
      retrievalEnabled: true,
      sourceScope: { mode: "all" },
      logo: null,
      // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
      theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
      greetingInstruction: workspace.greetingInstruction,
      assistantDefaultLocale: workspace.assistantDefaultLocale,
      proactiveGreetingEnabled: workspace.proactiveGreetingEnabled,
      surfaceSettings: {
        authenticatedChat: {
          enabled: true,
        },
        anonymousChat: {
          enabled: workspace.anonymousChatEnabled,
          token: workspace.anonymousChatToken,
        },
        websiteEmbed: {
          enabled: workspace.websiteEmbedEnabled,
          token: workspace.websiteEmbedToken,
          allowedOrigins: workspace.websiteEmbedAllowedOrigins,
          launcherLabel: workspace.websiteEmbedLauncherLabel,
          launcherPosition: workspace.websiteEmbedLauncherPosition,
          // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
          theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
          copy: {},
          expertOverrides: {},
        },
        extensions: {},
      },
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  private async ensureConversation(conversationId: string, workspaceId: string, anonymousSessionId?: string | null) {
    if (anonymousSessionId) {
      const conversation = await this.conversationRepository.findByIdAndAnonymousSession(
        conversationId,
        workspaceId,
        anonymousSessionId,
      );
      if (!conversation) {
        throw notFound("Conversation not found");
      }
      return conversation;
    }

    const conversation = await this.conversationRepository.findByIdAndWorkspaceId(conversationId, workspaceId);

    if (!conversation) {
      throw notFound("Conversation not found");
    }

    return conversation;
  }

  private async loadRewriteContinuityState(
    workspaceId: string,
    conversationId: string,
  ): Promise<RewriteContinuityState | undefined> {
    const metadata = await this.auditService.getLatestSuccessfulChatAnswerMetadata({
      workspaceId,
      conversationId,
    }) as ChatAnswerAuditMetadata | null;

    return normalizeRewriteContinuityState(metadata?.rewriteContinuityState);
  }
}
