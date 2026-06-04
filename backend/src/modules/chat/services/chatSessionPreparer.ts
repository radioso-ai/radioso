import type { ConversationTrace, StagedContext } from "@radioso/conversation-contract";

import { notFound } from "../../../shared/domain/errors.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { toConversationTrace, toPreparedStagedContext } from "./conversationContractMappers.js";
import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort, UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type {
  RetrievalPipelineRequest,
  RetrievalPipelineService,
  RewriteContinuityState,
} from "../../retrieval/public.js";
import type { AgentRecord, AgentService } from "../../agents/public.js";
import { defaultAgentBrandingSettings, isAgentRetrievalEnabled } from "../../agents/public.js";
import { defaultWebsiteEmbedSettings } from "../../settings/contracts/websiteEmbed.js";
import type { AssistantPageContext } from "../types/assistantApi.js";
import { CHAT_TURN_ROUTE, ChatTurnIntentService, type ChatTurnRoute } from "./chatTurnIntentService.js";
import { normalizeRewriteContinuityState } from "./rewriteContinuityState.js";
import type { RetrievalTurnPort } from "./retrievalTurnDispatch.js";
import type { DirectiveSteeringResult } from "../../directives/public.js";
import { DEFAULT_SUGGESTED_QUESTIONS_COUNT } from "../../settings/contracts/retrieval.js";

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
  /** Behavioral steering matched for this turn; consumed by the answer composer and the trace. */
  directiveSteering?: DirectiveSteeringResult;
  /**
   * Neutral staged outcomes for this turn (A1, issue #482). Retrieval contributes
   * one entry; the turn-outcome builder reads these instead of `retrieval`, so the
   * outcome is a generic conversation outcome rather than a retrieval-shaped one.
   */
  stagedContext: StagedContext[];
  /**
   * Pre-answer dispatch trace (neutral `ConversationTrace`) that rides on the turn
   * outcome. Distinct from the lifecycle's post-answer `ActivityTrace`.
   */
  turnTrace: ConversationTrace;
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

export interface PrepareChatSessionOptions {
  skipRetrieval?: boolean;
}

export class ChatSessionPreparer {
  private readonly chatTurnIntentService = new ChatTurnIntentService();

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly retrievalTurn: RetrievalTurnPort,
    private readonly auditService: AuditService,
    private readonly workspaceRepository?: Pick<WorkspaceRepositoryPort, "findById">,
    private readonly agentService?: Pick<AgentService, "resolve">,
  ) {}

  async prepare(input: PrepareChatSessionInput, options: PrepareChatSessionOptions = {}): Promise<PreparedSession> {
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
    // The direct-only (non-grounded) base turn. Used as-is when retrieval is
    // skipped, otherwise as the throwaway base `prepareRetrieval` recomputes from.
    const directOnlyTurn = this.prepareDirectOnlyTurn(
      this.buildPipelineInput(input, agent, history, persistedConversation, userMessage),
      agent,
    );
    const { retrieval, turnRoute } = options.skipRetrieval
      ? directOnlyTurn
      : await this.prepareRetrieval(input, {
          agent,
          conversation: persistedConversation,
          history,
          retrieval: directOnlyTurn.retrieval,
          turnRoute: CHAT_TURN_ROUTE.SOCIAL_ONLY,
          userMessage,
          pageContext: input.pageContext ?? null,
          priorRewriteContinuityState: rewriteContinuityState,
          // Only present to satisfy the PreparedSession shape; prepareRetrieval
          // recomputes the spine from the real retrieval result.
          ...this.stagedSpineFor(directOnlyTurn.retrieval),
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
      ...this.stagedSpineFor(retrieval),
    };
  }

  /**
   * Builds the neutral turn spine (A1, issue #482) the turn-outcome builder reads:
   * the staged retrieval result (source stamped later, at dispatch) and the
   * pre-answer dispatch trace. Sourced verbatim from the retrieval result so the
   * staged data and trace are identical to the prior dispatch-time derivation.
   */
  private stagedSpineFor(
    retrieval: PreparedSession["retrieval"],
  ): Pick<PreparedSession, "stagedContext" | "turnTrace"> {
    return {
      stagedContext: [toPreparedStagedContext(retrieval)],
      turnTrace: toConversationTrace(retrieval.trace),
    };
  }

  async prepareRetrieval(input: PrepareChatSessionInput, session: PreparedSession): Promise<PreparedSession> {
    const pipelineInput = this.buildPipelineInput(input, session.agent, session.history, session.conversation, session.userMessage);
    const { retrieval, turnRoute } = isAgentRetrievalEnabled(session.agent)
      ? await this.prepareRetrievalEnabledTurn(pipelineInput)
      : this.prepareDirectOnlyTurn(pipelineInput, session.agent);

    return {
      ...session,
      retrieval,
      turnRoute,
      ...this.stagedSpineFor(retrieval),
    };
  }

  /**
   * Prepares a non-grounded (direct) answer turn: interpret the query, then run
   * the answer path with retrieval forced off. Used when the turn-selection
   * strategy does not select retrieval — the agent answers conversationally
   * without grounding, rather than being forced through retrieval. Unlike the
   * skip-retrieval stub, this still produces a real prompt via the answer path.
   */
  async prepareDirect(input: PrepareChatSessionInput, session: PreparedSession): Promise<PreparedSession> {
    const pipelineInput = this.buildPipelineInput(input, session.agent, session.history, session.conversation, session.userMessage);
    if (!isAgentRetrievalEnabled(session.agent)) {
      const { retrieval, turnRoute } = this.prepareDirectOnlyTurn(pipelineInput, session.agent);
      return {
        ...session,
        retrieval,
        turnRoute,
        ...this.stagedSpineFor(retrieval),
      };
    }
    const interpretation = await this.retrievalTurn.interpret(pipelineInput);
    const interpretedWithExecution = {
      ...interpretation,
      request: {
        ...interpretation.request,
        execution: {
          surface: "assistant" as const,
          path: "assistant_direct" as const,
          retrievalInvoked: false,
        },
      },
    };
    const retrieval = await this.retrievalTurn.dispatch({ interpreted: interpretedWithExecution, withRetrieval: false });
    return {
      ...session,
      retrieval,
      turnRoute: CHAT_TURN_ROUTE.SOCIAL_ONLY,
      ...this.stagedSpineFor(retrieval),
    };
  }

  private buildPipelineInput(
    input: PrepareChatSessionInput,
    agent: AgentRecord,
    history: MessageRecord[],
    conversation?: ConversationRecord,
    userMessage?: MessageRecord,
  ): RetrievalPipelineRequest {
    return {
      workspaceId: input.workspaceId,
      query: input.query,
      history,
      responseIdentity: this.resolveResponseIdentity(agent),
      responseBehavior: {
        customInstruction: agent.customInstruction,
        citationDisplayEnabled: agent.citationDisplayEnabled,
      },
      responseBehaviorEnabled: true,
      agentSkillSettings: agent.skillSettings,
      metadataFilter: input.metadataFilter,
      sourceScope: agent.sourceScope,
      usageContext: {
        workspaceId: input.workspaceId,
        conversationId: conversation?.id ?? null,
        messageId: userMessage?.id ?? null,
        surface: "assistant",
        attemptKey: userMessage?.id ?? conversation?.id ?? "chat_turn",
      },
    };
  }

  private async prepareRetrievalEnabledTurn(pipelineInput: RetrievalPipelineRequest) {
    const interpretation = await this.retrievalTurn.interpret(pipelineInput);
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
    const retrieval = await this.retrievalTurn.dispatch({
      interpreted: interpretedWithExecution,
      withRetrieval: turnRoute === CHAT_TURN_ROUTE.RETRIEVAL,
    });

    return { retrieval, turnRoute };
  }

  private prepareDirectOnlyTurn(
    input: RetrievalPipelineRequest,
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
          suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
          suggestedQuestionsCount: DEFAULT_SUGGESTED_QUESTIONS_COUNT,
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
        assistantLinkUtmEnabled: true,
        citationDisplayEnabled: true,
        contactRequestsEnabled: false,
        retrievalEnabled: true,
        sourceScope: { mode: "all" },
        skillSettings: {},
        logo: null,
        // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
        theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
        branding: defaultAgentBrandingSettings(),
        greetingInstruction: "",
        assistantDefaultLocale: null,
        proactiveGreetingEnabled: false,
        chatModelOverride: null,
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
      assistantLinkUtmEnabled: true,
      citationDisplayEnabled: true,
      contactRequestsEnabled: false,
      retrievalEnabled: true,
      sourceScope: { mode: "all" },
      skillSettings: {},
      logo: null,
      // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
      theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
      branding: defaultAgentBrandingSettings(),
      greetingInstruction: workspace.greetingInstruction,
      assistantDefaultLocale: workspace.assistantDefaultLocale,
      proactiveGreetingEnabled: workspace.proactiveGreetingEnabled,
      chatModelOverride: null,
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
