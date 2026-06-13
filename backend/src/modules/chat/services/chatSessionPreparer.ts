import type { ClarificationCandidate, ConversationTrace, StagedContext } from "@radioso/conversation-contract";

import { notFound } from "../../../shared/domain/errors.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { toConversationTrace, toPreparedStagedContext } from "./conversationContractMappers.js";
import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort, UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { BootstrapGreetingCacheRepositoryPort } from "../../../db/repositories/bootstrapGreetingCacheRepository.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type {
  RetrievalPipelineRequest,
  RetrievalPipelineService,
  RewriteContinuityState,
} from "../../retrieval/public.js";
import type { AgentRecord, AgentService } from "../../agents/public.js";
import { DEFAULT_CONTACT_REQUEST_DELIVERY, defaultAgentBrandingSettings, isAgentRetrievalEnabled } from "../../agents/public.js";
import { defaultWebsiteEmbedSettings } from "../../settings/contracts/websiteEmbed.js";
import type { AssistantPageContext } from "../types/assistantApi.js";
import { CHAT_TURN_ROUTE, type ChatTurnRoute } from "../../../shared/domain/chatTurnRoute.js";
import { normalizeRewriteContinuityState } from "./rewriteContinuityState.js";
import type { RetrievalTurnPort } from "./retrievalTurnDispatch.js";
import type { DirectiveSteeringResult } from "../../directives/public.js";
import { DEFAULT_SUGGESTED_QUESTIONS_COUNT } from "../../settings/contracts/retrieval.js";
import type { TurnRouting } from "./turnRouter.js";

interface ChatAnswerAuditMetadata {
  rewriteContinuityState?: RewriteContinuityState;
}

const defaultTurnFraming = (): TurnRouting["framing"] => ({
  isIdentityQuestion: false,
});

export interface PreparedSession {
  agent: AgentRecord;
  conversation: ConversationRecord;
  history: MessageRecord[];
  retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
  turnRoute: ChatTurnRoute;
  turnFraming?: TurnRouting["framing"];
  userMessage: MessageRecord;
  /** What the user is effectively asking this turn; differs from the persisted user message for resolved selectors. */
  effectiveQuery: string;
  pageContext?: AssistantPageContext | null;
  priorRewriteContinuityState?: RewriteContinuityState;
  /** Shared per-turn response language label detected from the user message and history. */
  responseLanguage?: string;
  /** Behavioral steering matched for this turn; consumed by the answer composer and the trace. */
  directiveSteering?: DirectiveSteeringResult;
  /** Retrieval-sense alternatives to offer in the current grounded answer; labels only, never alternative chunks. */
  retrievalSenseOfferAlternatives?: ClarificationCandidate[];
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
  bootstrapGreetingId?: string;
  query: string;
  inputMetadata?: UserMessageInputMetadata;
  metadataFilter?: Record<string, unknown>;
  documentScope?: string[];
  pageContext?: AssistantPageContext | null;
  sourceChannel?: string | null;
  anonymousSessionId?: string | null;
  sourceOrigin?: string | null;
}

export interface PrepareChatSessionOptions {
  skipRetrieval?: boolean;
  preResolvedAgent?: AgentRecord;
  preResolvedHistory?: MessageRecord[];
}

export class ChatSessionPreparer {
  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly retrievalTurn: RetrievalTurnPort,
    private readonly auditService: AuditService,
    private readonly workspaceRepository?: Pick<WorkspaceRepositoryPort, "findById">,
    private readonly agentService?: Pick<AgentService, "resolve">,
    private readonly bootstrapGreetingCacheRepository?: BootstrapGreetingCacheRepositoryPort,
  ) {}

  async prepare(input: PrepareChatSessionInput, options: PrepareChatSessionOptions = {}): Promise<PreparedSession> {
    const conversation = input.conversationId
      ? await this.ensureConversation(input.conversationId, input.workspaceId, input.anonymousSessionId)
      : null;
    const agent = options.preResolvedAgent ?? (this.agentService
      ? await this.agentService.resolve(input.workspaceId, input.agentId ?? conversation?.agentId ?? null)
      : await this.resolveLegacyAgent(input.workspaceId));
    if (conversation?.agentId && conversation.agentId !== agent.id) {
      throw notFound("Conversation not found");
    }
    const history = options.preResolvedHistory ?? (conversation
      ? await this.messageRepository.listRecentByConversationId(
          input.workspaceId,
          conversation.id,
          RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages,
        )
      : []);
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
    const promotedBootstrapGreeting = conversation
      ? null
      : await this.promoteBootstrapGreeting(input, agent, persistedConversation);
    const turnHistory = promotedBootstrapGreeting
      ? [...history, promotedBootstrapGreeting]
      : history;

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
      this.buildPipelineInput(input, agent, turnHistory, persistedConversation, userMessage),
      agent,
    );
    const { retrieval, turnRoute } = options.skipRetrieval
      ? directOnlyTurn
      : await this.prepareRetrieval(input, {
          agent,
          conversation: persistedConversation,
          history: turnHistory,
          retrieval: directOnlyTurn.retrieval,
          turnRoute: CHAT_TURN_ROUTE.DIRECT,
          turnFraming: defaultTurnFraming(),
          userMessage,
          effectiveQuery: input.query,
          pageContext: input.pageContext ?? null,
          priorRewriteContinuityState: rewriteContinuityState,
          // Only present to satisfy the PreparedSession shape; prepareRetrieval
          // recomputes the spine from the real retrieval result.
          ...this.stagedSpineFor(directOnlyTurn.retrieval),
        });

    return {
      agent,
      conversation: persistedConversation,
      history: turnHistory,
      retrieval,
      turnRoute,
      turnFraming: defaultTurnFraming(),
      userMessage,
      effectiveQuery: input.query,
      pageContext: input.pageContext ?? null,
      priorRewriteContinuityState: rewriteContinuityState,
      ...this.stagedSpineFor(retrieval),
    };
  }

  private async promoteBootstrapGreeting(
    input: PrepareChatSessionInput,
    agent: AgentRecord,
    conversation: ConversationRecord,
  ): Promise<MessageRecord | null> {
    if (!input.bootstrapGreetingId || !this.bootstrapGreetingCacheRepository) {
      return null;
    }
    const greeting = await this.bootstrapGreetingCacheRepository.findById(
      input.workspaceId,
      input.bootstrapGreetingId,
    );
    if (!greeting || greeting.agentId !== agent.id || !greeting.greetingText.trim()) {
      return null;
    }
    return this.messageRepository.create({
      conversationId: conversation.id,
      workspaceId: input.workspaceId,
      role: "assistant",
      content: greeting.greetingText,
      metadata: {
        bootstrapGreeting: true,
        bootstrapGreetingId: greeting.id,
        source: "ephemeral_bootstrap",
      },
    });
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

  async prepareRetrieval(
    input: PrepareChatSessionInput,
    session: PreparedSession,
    framing: TurnRouting["framing"] = defaultTurnFraming(),
  ): Promise<PreparedSession> {
    const pipelineInput = this.buildPipelineInput(
      input,
      session.agent,
      session.history,
      session.conversation,
      session.userMessage,
      session.responseLanguage,
    );
    const { retrieval, turnRoute } = isAgentRetrievalEnabled(session.agent)
      ? await this.prepareRetrievalEnabledTurn(pipelineInput)
      : this.prepareDirectOnlyTurn(pipelineInput, session.agent, framing);

    return {
      ...session,
      retrieval,
      turnRoute,
      turnFraming: framing,
      effectiveQuery: input.query,
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
  async prepareDirect(
    input: PrepareChatSessionInput,
    session: PreparedSession,
    framing: TurnRouting["framing"] = defaultTurnFraming(),
  ): Promise<PreparedSession> {
    const pipelineInput = {
      ...this.buildPipelineInput(
        input,
        session.agent,
        session.history,
        session.conversation,
        session.userMessage,
        session.responseLanguage,
      ),
      retrievalSettingsOverride: { queryRewriteEnabled: false },
    };
    if (!isAgentRetrievalEnabled(session.agent)) {
      const { retrieval, turnRoute } = this.prepareDirectOnlyTurn(pipelineInput, session.agent, framing);
      return {
        ...session,
        retrieval,
        turnRoute,
        turnFraming: framing,
        effectiveQuery: input.query,
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
      turnRoute: CHAT_TURN_ROUTE.DIRECT,
      turnFraming: framing,
      effectiveQuery: input.query,
      ...this.stagedSpineFor(retrieval),
    };
  }

  private buildPipelineInput(
    input: PrepareChatSessionInput,
    agent: AgentRecord,
    history: MessageRecord[],
    conversation?: ConversationRecord,
    userMessage?: MessageRecord,
    responseLanguage?: string,
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
      responseLanguage,
      responseBehaviorEnabled: true,
      agentSkillSettings: agent.skillSettings,
      metadataFilter: input.metadataFilter,
      documentScope: input.documentScope,
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
    const interpretedWithExecution = {
      ...interpretation,
      request: {
        ...interpretation.request,
        execution: {
          surface: "assistant" as const,
          path: "assistant_retrieval" as const,
          retrievalInvoked: true,
        },
      },
    };
    const retrieval = await this.retrievalTurn.dispatch({
      interpreted: interpretedWithExecution,
      withRetrieval: true,
    });

    return { retrieval, turnRoute: CHAT_TURN_ROUTE.RETRIEVAL };
  }

  private prepareDirectOnlyTurn(
    input: RetrievalPipelineRequest,
    agent: AgentRecord,
    framing: TurnRouting["framing"] = defaultTurnFraming(),
  ) {
    const now = new Date().toISOString();
    return {
      turnRoute: CHAT_TURN_ROUTE.DIRECT,
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
          responseLanguage: input.responseLanguage,
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
          retrievalSkipped: true,
          candidateFallbackApplied: false,
          fallbackApplied: false,
          rewriteEligible: false,
          rewriteRan: false,
          materialDisagreement: false,
          rewriteProposal: {
            rewrittenQuery: input.query,
            semanticQuery: input.query,
            lexicalQuery: input.query,
            responseLanguagePolicy: "match_user_question" as const,
            turnKind: "fresh_subject" as const,
            relatedEntities: [],
            unresolved: false,
            confidence: 0,
          },
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
      turnFraming: framing,
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
        webhookExportsEnabled: false,
        contactRequestDelivery: DEFAULT_CONTACT_REQUEST_DELIVERY,
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
      webhookExportsEnabled: false,
      contactRequestDelivery: DEFAULT_CONTACT_REQUEST_DELIVERY,
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
