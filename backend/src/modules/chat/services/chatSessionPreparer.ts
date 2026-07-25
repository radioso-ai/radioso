import type {
  ClarificationCandidate,
  ConversationChannelContext,
  ConversationTrace,
  StagedContext,
} from "@radioso/conversation-contract";

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
  AgenticRetrievalToolFactory,
  RetrievalPipelineRequest,
  RetrievalPipelineService,
  RewriteContinuityState,
  StructuredRewriteResult,
} from "../../retrieval/public.js";
import { resolveContextForTurn } from "../../context-variables/public.js";
import type {
  ResolvedTurnContext,
  ResolvedVariableInput,
  ContextVariableScope,
} from "../../context-variables/public.js";
import type { ContextVariableRepositoryPort } from "../../../db/repositories/contextVariableRepository.js";
import type { AgentRecord, AgentService } from "../../agents/public.js";
import { DEFAULT_CONTACT_REQUEST_DELIVERY, defaultAgentBrandingSettings, isAgentRetrievalEnabled } from "../../agents/public.js";
import { defaultWebsiteEmbedSettings } from "../../settings/contracts/websiteEmbed.js";
import type { AssistantPageContext } from "../types/assistantApi.js";
import type { PageReadCapability } from "./pageRead/pageReadDecision.js";
import type { PageReadOutcome } from "./pageRead/pageReadSessionOutcome.js";
import { CHAT_TURN_ROUTE, type ChatTurnRoute } from "../../../shared/domain/chatTurnRoute.js";
import { normalizeRewriteContinuityState } from "./rewriteContinuityState.js";
import type { RetrievalTurnPort } from "./retrievalTurnDispatch.js";
import type { DirectiveSteeringResult } from "../../directives/public.js";
import type { DeferredDirectiveStateStore } from "./directives/deferredDirectiveStateStore.js";
import { loadConversationSummaryText, type ConversationSummaryStore } from "../contracts/conversationSummary.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { DEFAULT_SUGGESTED_QUESTIONS_COUNT } from "../../settings/contracts/retrieval.js";
import type { TurnRouting } from "./turnRouter.js";
import type { ChatTurnPlanHandle } from "./turnPlanCoordinator.js";
import type { ModelCallUsageAttribution } from "../../../shared/domain/modelCallUsageContext.js";

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
  /** Raw host input held aside until the page-read gate admits it. */
  pageContext?: AssistantPageContext | null;
  pageReadCapability?: PageReadCapability | null;
  /** First-write-wins page-read decision and gate result shared by every downstream sink. */
  pageReadOutcome?: PageReadOutcome;
  priorRewriteContinuityState?: RewriteContinuityState;
  /** Shared per-turn response language label detected from the user message and history. */
  responseLanguage?: string;
  /** Behavioral steering matched for this turn; consumed by the answer composer and the trace. */
  directiveSteering?: DirectiveSteeringResult;
  /**
   * Per-turn directive firing memory, bound lazily by the directive matcher (issue
   * #865). Rides on the session like {@link directiveSteering} so the routine
   * attempt and process turn share one instance; the lifecycle commits it once at
   * turn completion, advancing the conversation's firing state.
   */
  directiveStateStore?: DeferredDirectiveStateStore;
  /**
   * The fused turn plan for this turn: a lazy, memoized handle (issue:
   * five-llm-calls). Rides on the session like {@link directiveSteering}: the
   * earliest consumer (usually the routine activator, which supplies the prepared
   * routine candidates) starts the single computation, all others await the same
   * promise, and a `bypassed`/`failed` outcome sends every consumer to its staged
   * fallback. Absent when the planning gate is off, the workspace is not
   * allowlisted, or a pre-engine bypass signal holds.
   */
  turnPlan?: ChatTurnPlanHandle;
  /**
   * Operator-only workbench test override carried from {@link PrepareChatSessionInput}:
   * routine definition ids (drafts included) to make eligible for this turn so an author
   * can test-run an unpublished routine end-to-end. Empty/absent for every live turn.
   */
  previewRoutineIds?: string[];
  /**
   * Rolling conversation summary text (issue #866), loaded once at prepare from the
   * per-conversation summary store. Absent for new/short conversations. Injected
   * alongside the recent-message window into turn interpretation and answer
   * composition; renders nothing when absent.
   */
  conversationSummary?: string;
  /** Retrieval-sense alternatives to offer in the current grounded answer; labels only, never alternative chunks. */
  retrievalSenseOfferAlternatives?: ClarificationCandidate[];
  /**
   * Neutral staged outcomes for this turn (A1, issue #482). Retrieval contributes
   * one entry; the turn-outcome builder reads these instead of `retrieval`, so the
   * outcome is a generic conversation outcome rather than a retrieval-shaped one.
   */
  stagedContext: StagedContext[];
  /**
   * Resolved visitor context variables for this turn (page context + host-defined variables).
   * The single source of truth for what the answer composers render and what the lifecycle
   * persists; its `staged` entries are also merged into `stagedContext` for the matcher.
   */
  resolvedContext: ResolvedTurnContext;
  /**
   * Pre-answer dispatch trace (neutral `ConversationTrace`) that rides on the turn
   * outcome. Distinct from the lifecycle's post-answer `ActivityTrace`.
   */
  turnTrace: ConversationTrace;
  /** Optional caller-owned usage attribution shared by every model call in this turn. */
  usageAttribution?: ModelCallUsageAttribution;
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
  pageReadCapability?: PageReadCapability | null;
  sourceChannel?: string | null;
  channelContext?: ConversationChannelContext | null;
  chatSessionId?: string | null;
  /** @deprecated Use chatSessionId. */
  anonymousSessionId?: string | null;
  sourceOrigin?: string | null;
  verifiedCustomerId?: string | null;
  verifiedIdentity?: Record<string, unknown> | null;
  precomputedRewriteProposal?: StructuredRewriteResult;
  agenticToolFactories?: ReadonlyArray<AgenticRetrievalToolFactory>;
  /** Ephemeral eval-only override; never persisted to workspace settings. */
  retrievalSettingsOverride?: RetrievalPipelineRequest["retrievalSettingsOverride"];
  /** Ephemeral caller attribution for model and retrieval usage emitted by this turn. */
  usageAttribution?: ModelCallUsageAttribution;
  /**
   * Operator-only workbench test override: routine definition ids (drafts included)
   * to make eligible for this turn's routine activation/resume. Ephemeral — never
   * persisted; only the authenticated workbench chat sets it.
   */
  previewRoutineIds?: string[];
}

export interface PrepareChatSessionOptions {
  skipRetrieval?: boolean;
  preResolvedAgent?: AgentRecord;
  preResolvedHistory?: MessageRecord[];
  /**
   * Rolling conversation summary (#866) supplied by a hermetic caller (workbench
   * replay / eval) instead of loading it from the summary store. When provided it is
   * used verbatim as {@link PreparedSession.conversationSummary}, so the summary flows
   * to every injection point through the existing session field. Absent => the store is
   * consulted exactly as the live turn does (unchanged behavior).
   */
  preResolvedConversationSummary?: string;
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
    private readonly contextVariableRepository?: Pick<ContextVariableRepositoryPort, "resolveForAgent">,
    private readonly conversationSummaryStore?: Pick<ConversationSummaryStore, "load">,
    private readonly logger?: Pick<AppLogger, "warn">,
  ) {}

  async prepare(input: PrepareChatSessionInput, options: PrepareChatSessionOptions = {}): Promise<PreparedSession> {
    const chatSessionId = input.chatSessionId ?? input.anonymousSessionId ?? null;
    const conversation = input.conversationId
      ? await this.ensureConversation(input.conversationId, input.workspaceId, chatSessionId)
      : null;
    const agent = options.preResolvedAgent ?? (this.agentService
      ? await this.agentService.resolve(input.workspaceId, input.agentId ?? conversation?.agentId ?? null)
      : await this.resolveLegacyAgent(input.workspaceId));
    if (conversation?.agentId && conversation.agentId !== agent.id) {
      throw notFound("Conversation not found");
    }
    const effectiveVerifiedCustomerId = input.verifiedCustomerId ?? conversation?.verifiedCustomerId ?? null;
    const history = options.preResolvedHistory ?? (conversation
      ? await this.messageRepository.listRecentByConversationId(
          input.workspaceId,
          conversation.id,
          RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages,
        )
      : []);
    const [rewriteContinuityState, conversationSummary] = await Promise.all([
      conversation
        ? this.loadRewriteContinuityState(input.workspaceId, conversation.id)
        : Promise.resolve(undefined),
      options.preResolvedConversationSummary !== undefined
        ? Promise.resolve(options.preResolvedConversationSummary)
        : conversation
          ? loadConversationSummaryText(this.conversationSummaryStore, conversation.id, this.logger)
          : Promise.resolve(undefined),
    ]);
    const persistedConversation =
      conversation ?? await this.conversationRepository.create(
        input.workspaceId,
        agent.id,
        input.sourceChannel ?? null,
        chatSessionId,
        input.sourceOrigin ?? null,
        input.channelContext ?? null,
        input.verifiedCustomerId ?? null,
      );
    if (conversation && input.verifiedCustomerId && !conversation.verifiedCustomerId) {
      await this.conversationRepository.setVerifiedCustomerId(
        conversation.id,
        input.workspaceId,
        input.verifiedCustomerId,
      );
    }
    const conversationForTurn = persistedConversation.verifiedCustomerId === effectiveVerifiedCustomerId
      ? persistedConversation
      : { ...persistedConversation, verifiedCustomerId: effectiveVerifiedCustomerId };
    const promotedBootstrapGreeting = conversation
      ? null
      : await this.promoteBootstrapGreeting(input, agent, conversationForTurn);
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
    const hostVariables = await this.resolveHostVariables(input, agent, effectiveVerifiedCustomerId, chatSessionId);
    const directOnlyTurn = this.prepareDirectOnlyTurn(
      this.buildPipelineInput(input, agent, turnHistory, conversationForTurn, userMessage),
      agent,
    );
    const { retrieval, turnRoute } = options.skipRetrieval
      ? directOnlyTurn
      : await this.prepareRetrieval(input, {
          agent,
          conversation: conversationForTurn,
          history: turnHistory,
          retrieval: directOnlyTurn.retrieval,
          turnRoute: CHAT_TURN_ROUTE.DIRECT,
          turnFraming: defaultTurnFraming(),
          userMessage,
          effectiveQuery: input.query,
          pageContext: input.pageContext ?? null,
          pageReadCapability: input.pageReadCapability ?? null,
          priorRewriteContinuityState: rewriteContinuityState,
          conversationSummary,
          usageAttribution: input.usageAttribution,
          // Only present to satisfy the PreparedSession shape; prepareRetrieval
          // recomputes the spine from the real retrieval result.
          ...this.stagedSpineFor(directOnlyTurn.retrieval, null, hostVariables),
        }, defaultTurnFraming(), hostVariables);

    return {
      agent,
      conversation: conversationForTurn,
      history: turnHistory,
      retrieval,
      turnRoute,
      turnFraming: defaultTurnFraming(),
      userMessage,
      effectiveQuery: input.query,
      pageContext: input.pageContext ?? null,
      pageReadCapability: input.pageReadCapability ?? null,
      priorRewriteContinuityState: rewriteContinuityState,
      conversationSummary,
      usageAttribution: input.usageAttribution,
      previewRoutineIds: input.previewRoutineIds,
      ...this.stagedSpineFor(retrieval, null, hostVariables),
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
    pageContext?: AssistantPageContext | null,
    variables: readonly ResolvedVariableInput[] = [],
  ): Pick<PreparedSession, "stagedContext" | "resolvedContext" | "turnTrace"> {
    const resolvedContext = resolveContextForTurn(pageContext, variables);
    return {
      stagedContext: [toPreparedStagedContext(retrieval), ...resolvedContext.staged],
      resolvedContext,
      turnTrace: toConversationTrace(retrieval.trace),
    };
  }

  private gatedPageContext(session: PreparedSession): AssistantPageContext | null {
    return session.pageReadOutcome?.gate.kind === "capture"
      ? session.pageContext ?? null
      : null;
  }

  /**
   * A routine-scoped staged view for a *tentative* capture outcome. The session
   * is not mutated: a routine may still yield the turn off-topic, and a yielded
   * turn must fall through to normal answering with zero page-derived context.
   */
  stagedPageContextFor(session: PreparedSession, outcome: PageReadOutcome): StagedContext[] {
    if (outcome.gate.kind !== "capture" || !session.pageContext) {
      return [...session.stagedContext];
    }
    const page = resolveContextForTurn(session.pageContext);
    return [
      ...page.staged,
      ...session.stagedContext.filter(
        (entry) => !(entry.kind === "context_variable" && entry.id === "page_context"),
      ),
    ];
  }

  /**
   * Routine execution happens before direct/retrieval preparation re-runs the
   * spine. Admit the frozen page fragment there without re-resolving or changing
   * the already-prepared host variables.
   */
  applyFrozenPageReadOutcome(session: PreparedSession): void {
    if (session.pageReadOutcome?.gate.kind !== "capture" || !session.pageContext) {
      return;
    }
    const page = resolveContextForTurn(session.pageContext);
    const isPageFragment = (fragment: ResolvedTurnContext["fragments"][number]): boolean =>
      fragment.kind === "page_context";
    const isPageStaged = (entry: StagedContext): boolean =>
      entry.kind === "context_variable" && entry.id === "page_context";
    const snapshot = { ...session.resolvedContext.snapshot };
    delete snapshot.page_context;
    session.resolvedContext = {
      fragments: [
        ...page.fragments,
        ...session.resolvedContext.fragments.filter((fragment) => !isPageFragment(fragment)),
      ],
      renderFragments: [
        ...page.renderFragments,
        ...session.resolvedContext.renderFragments.filter((fragment) => !isPageFragment(fragment)),
      ],
      staged: [
        ...page.staged,
        ...session.resolvedContext.staged.filter((entry) => !isPageStaged(entry)),
      ],
      snapshot: {
        ...page.snapshot,
        ...snapshot,
      },
    };
    session.stagedContext = [
      ...session.stagedContext.filter((entry) => entry.kind !== "context_variable"),
      ...session.resolvedContext.staged,
    ];
  }

  /**
   * Resolve the agent's enabled host-defined context variables for this turn, walking the
   * scope ladder (session → agent → workspace; customer scope arrives with verified identity).
   * Best-effort: a missing repository or a read failure degrades to no host variables so the
   * turn always proceeds (page context still renders).
   */
  private async resolveHostVariables(
    input: PrepareChatSessionInput,
    agent: AgentRecord,
    effectiveVerifiedCustomerId: string | null = input.verifiedCustomerId ?? null,
    chatSessionId: string | null = input.chatSessionId ?? input.anonymousSessionId ?? null,
  ): Promise<ResolvedVariableInput[]> {
    if (!this.contextVariableRepository) {
      return [];
    }
    const scopes: ContextVariableScope[] = [];
    if (chatSessionId) {
      scopes.push({ type: "session", id: chatSessionId });
    }
    if (effectiveVerifiedCustomerId) {
      scopes.push({ type: "customer", id: effectiveVerifiedCustomerId });
    }
    scopes.push({ type: "agent", id: agent.id });
    scopes.push({ type: "workspace", id: input.workspaceId });
    try {
      const resolved = await this.contextVariableRepository.resolveForAgent(input.workspaceId, agent.id, scopes);
      if (!input.verifiedIdentity) {
        return resolved;
      }
      // visitor_identity is exposed only on turns where a signed identity token freshly verifies.
      return [
        ...resolved,
        {
          name: "visitor_identity",
          description: "Verified visitor identity supplied by the host.",
          value: input.verifiedIdentity,
          surfacing: "on_reference",
          sensitive: true,
          trust: "verified",
        },
      ];
    } catch {
      if (!input.verifiedIdentity) {
        return [];
      }
      return [{
        name: "visitor_identity",
        description: "Verified visitor identity supplied by the host.",
        value: input.verifiedIdentity,
        surfacing: "on_reference",
        sensitive: true,
        trust: "verified",
      }];
    }
  }

  async prepareRetrieval(
    input: PrepareChatSessionInput,
    session: PreparedSession,
    framing: TurnRouting["framing"] = defaultTurnFraming(),
    hostVariables?: readonly ResolvedVariableInput[],
  ): Promise<PreparedSession> {
    const variables = hostVariables ?? (await this.resolveHostVariables(
      input,
      session.agent,
      input.verifiedCustomerId ?? session.conversation.verifiedCustomerId ?? null,
      input.chatSessionId ?? input.anonymousSessionId ?? session.conversation.anonymousSessionId ?? null,
    ));
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
      ...this.stagedSpineFor(retrieval, this.gatedPageContext(session), variables),
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
    hostVariables?: readonly ResolvedVariableInput[],
  ): Promise<PreparedSession> {
    const variables = hostVariables ?? (await this.resolveHostVariables(
      input,
      session.agent,
      input.verifiedCustomerId ?? session.conversation.verifiedCustomerId ?? null,
      input.chatSessionId ?? input.anonymousSessionId ?? session.conversation.anonymousSessionId ?? null,
    ));
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
        ...this.stagedSpineFor(retrieval, this.gatedPageContext(session), variables),
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
      ...this.stagedSpineFor(retrieval, this.gatedPageContext(session), variables),
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
      agenticToolFactories: input.agenticToolFactories,
      metadataFilter: input.metadataFilter,
      documentScope: input.documentScope,
      precomputedRewriteProposal: input.precomputedRewriteProposal,
      sourceScope: agent.sourceScope,
      retrievalSettingsOverride: input.retrievalSettingsOverride,
      usageContext: {
        workspaceId: input.workspaceId,
        conversationId: conversation?.id ?? null,
        messageId: userMessage?.id ?? null,
        surface: "assistant",
        attemptKey: userMessage?.id ?? conversation?.id ?? "chat_turn",
        ...input.usageAttribution,
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

  private async ensureConversation(conversationId: string, workspaceId: string, chatSessionId?: string | null) {
    if (chatSessionId) {
      const conversation = await this.conversationRepository.findByIdAndAnonymousSession(
        conversationId,
        workspaceId,
        chatSessionId,
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
