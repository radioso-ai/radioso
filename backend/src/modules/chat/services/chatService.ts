import { normalizeProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import type {
  ConversationEngine,
  ConversationModelGateway,
  ConversationRoutineActivator,
  ConversationRoutineRunner,
  ConversationRoutineStore,
  ConversationTrace,
  RenderableTurn,
  RoutineActionRequest,
} from "@radioso/conversation-contract";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AgentService } from "../../agents/public.js";
import type { ChatGateway, ChatGatewayInput } from "../contracts/chatGateway.js";
import type { ChatStreamEvent, SkillStreamPayload, SkillStreamPhase } from "../contracts/streamEvents.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import type { ChatResponse } from "../types/chatResponses.js";
import type { AssistantPageContext } from "../types/assistantApi.js";
import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import { CHAT_TURN_ROUTE } from "./chatTurnIntentService.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";
import { NoopUsageLimitPolicy, type UsageLimitPolicy } from "../../../shared/domain/usageLimitPolicy.js";
import { NoopChatIntakeProvider, type ChatIntakeProviderPort, type ChatIntakeResult } from "./chatIntakeProvider.js";
import { ChatSessionPreparer, type PreparedSession } from "./chatSessionPreparer.js";
import {
  attemptRoutineTurnWithConversationEngine,
  runPreparedChatTurnStreamWithConversationEngine,
  runPreparedChatTurnWithConversationEngine,
} from "./conversationEngineChatTurn.js";
import type { RetrievalTurnPort } from "./retrievalTurnDispatch.js";
import { noopDirectiveSteering, type DirectiveSteeringPort } from "../../directives/public.js";
import {
  type TurnSkill,
  type TurnStreamSuggestions,
} from "./turnOutcome.js";
import type { ChatTurnRuntime } from "./chatTurnRuntime.js";
import {
  DefaultTurnSelectionStrategy,
  type TurnSelectionStrategy,
} from "./turnSelectionStrategy.js";
import { ChatTurnSkillSelector } from "./turnSkillSelector.js";
import type {
  ChatAnswerPresenter,
  ChatPresentedAnswer,
} from "./chatAnswerPresenter.js";
import {
  ChatTurnLifecycle,
  type AssistantTurnPersistencePort,
  type ChatActionOutboxPort,
} from "./chatTurnLifecycle.js";
import { BlankChatAnswerError } from "./chatAnswerErrors.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import { RoutineChatModelGateway } from "./routines/routineChatModelGateway.js";
import {
  DeferredRoutineStore,
  type CapturedRoutineTransition,
} from "./routines/deferredRoutineStore.js";

export type { ChatGateway } from "../contracts/chatGateway.js";
export type { ChatStreamEvent } from "../contracts/streamEvents.js";
export { BlankChatAnswerError } from "./chatAnswerErrors.js";

export class ModelChatGateway implements ChatGateway {
  constructor(private readonly inference: ModelInferencePipeline) {}

  async answer(input: ChatGatewayInput): Promise<string> {
    const result = await this.inference.complete({
      operation: input.usageContext,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      reasoningEffort: CHAT_BEHAVIOR.answer.reasoningEffort,
      validateResult(result) {
        if (!result.text?.trim()) {
          throw new BlankChatAnswerError();
        }
      },
    });
    return result.text;
  }

  async *streamAnswer(input: ChatGatewayInput): AsyncIterable<string> {
    const { textStream } = this.inference.stream({
      operation: input.usageContext,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      reasoningEffort: CHAT_BEHAVIOR.answer.reasoningEffort,
    });
    for await (const chunk of textStream) {
      if (chunk.length > 0) {
        yield chunk;
      }
    }
  }
}

export class OpenAIChatGateway extends ModelChatGateway {}

type PreparedChatStreamTurnEvent =
  | { type: "chunk"; text: string }
  | {
      type: "final";
      finalPresentation: ChatPresentedAnswer;
      suggestions: TurnStreamSuggestions;
      engineTrace?: ConversationTrace;
      actions?: RoutineActionRequest[];
    };

const SKILL_CHIP_TAG_PATTERN = /<skill_chip>([\s\S]*?)<\/skill_chip>\s*/i;
const SKILL_RECEIPT_TAG_PATTERN = /<skill_receipt>([\s\S]*?)<\/skill_receipt>\s*/i;

export interface ExtractedSkillReceiptOverrides {
  statusLabel?: string;
  fieldLabels?: Record<string, string>;
}

export interface ExtractedSkillTags {
  localizedTitle?: string;
  receiptOverrides?: ExtractedSkillReceiptOverrides;
  cleanedAnswer: string;
}

const parseReceiptOverrides = (raw: string): ExtractedSkillReceiptOverrides | undefined => {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const statusLabel = typeof record.status === "string" && record.status.trim() ? record.status.trim() : undefined;
    let fieldLabels: Record<string, string> | undefined;
    if (record.fields && typeof record.fields === "object" && !Array.isArray(record.fields)) {
      fieldLabels = {};
      for (const [name, label] of Object.entries(record.fields as Record<string, unknown>)) {
        if (typeof label === "string" && label.trim()) {
          fieldLabels[name] = label.trim();
        }
      }
      if (Object.keys(fieldLabels).length === 0) {
        fieldLabels = undefined;
      }
    }
    if (!statusLabel && !fieldLabels) {
      return undefined;
    }
    return { statusLabel, fieldLabels };
  } catch {
    return undefined;
  }
};

export const extractSkillTags = (answer: string): ExtractedSkillTags => {
  let cleanedAnswer = answer;
  let localizedTitle: string | undefined;
  const chipMatch = cleanedAnswer.match(SKILL_CHIP_TAG_PATTERN);
  if (chipMatch) {
    const candidate = chipMatch[1].trim();
    localizedTitle = candidate || undefined;
    cleanedAnswer = cleanedAnswer.replace(SKILL_CHIP_TAG_PATTERN, "");
  }
  let receiptOverrides: ExtractedSkillReceiptOverrides | undefined;
  const receiptMatch = cleanedAnswer.match(SKILL_RECEIPT_TAG_PATTERN);
  if (receiptMatch) {
    receiptOverrides = parseReceiptOverrides(receiptMatch[1]);
    cleanedAnswer = cleanedAnswer.replace(SKILL_RECEIPT_TAG_PATTERN, "");
  }
  const trimmed = cleanedAnswer.trimStart();
  return {
    localizedTitle,
    receiptOverrides,
    cleanedAnswer: trimmed || answer,
  };
};

// Kept for backward compatibility with any external callers; thin wrapper around extractSkillTags.
export const extractSkillChipTitle = (answer: string): { localizedTitle?: string; cleanedAnswer: string } => {
  const { localizedTitle, cleanedAnswer } = extractSkillTags(answer);
  return { localizedTitle, cleanedAnswer };
};

const intakeStatusToSkillPhase = (status: ChatIntakeResult["status"]): SkillStreamPhase => {
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed" || status === "cancelled" || status === "expired") {
    return "failed";
  }
  return "active";
};

const applyReceiptOverrides = (
  receipt: ChatIntakeResult["receipt"],
  overrides: ExtractedSkillReceiptOverrides | undefined,
): ChatIntakeResult["receipt"] => {
  if (!overrides) {
    return receipt;
  }
  if (!receipt) {
    return overrides.statusLabel
      ? { fields: [], statusLabel: overrides.statusLabel }
      : undefined;
  }
  const fields = overrides.fieldLabels
    ? receipt.fields.map((field) =>
        overrides.fieldLabels && overrides.fieldLabels[field.name]
          ? { ...field, displayName: overrides.fieldLabels[field.name] }
          : field,
      )
    : receipt.fields;
  return {
    ...receipt,
    fields,
    statusLabel: overrides.statusLabel ?? receipt.statusLabel,
  };
};

const buildSkillStreamPayload = (
  intakeResult: ChatIntakeResult,
  localizedTitle: string | undefined,
): SkillStreamPayload => ({
  skillName: intakeResult.skillName,
  phase: intakeStatusToSkillPhase(intakeResult.status),
  display: intakeResult.display,
  localizedTitle,
  receipt: intakeResult.receipt,
});

/**
 * The registered routines this turn may resume or activate. Composition assembles it
 * (the concrete `RoutineRegistry` plus a runner factory); ChatService only builds the
 * per-turn model gateway and asks for a runner, the activator, and whether anything is
 * registered. Empty → routine machinery stays off (no per-turn store load), and the
 * engine runner stays a composition concern rather than something ChatService news up.
 */
export interface ChatRoutineProvider {
  readonly isEmpty: boolean;
  activator(modelGateway: ConversationModelGateway): ConversationRoutineActivator;
  createRunner(modelGateway: ConversationModelGateway): ConversationRoutineRunner;
}

/**
 * Everything ChatService needs to run a turn. The turn runtime (presenter +
 * registered skills) is assembled by composition via {@link buildChatTurnRuntime}
 * and injected — registration lives in the wiring layer, never inline here.
 */
export interface ChatServiceOptions {
  conversationRepository: ConversationRepositoryPort;
  messageRepository: MessageRepositoryPort;
  retrievalTurn: RetrievalTurnPort;
  chatGateway: ChatGateway;
  auditService: AuditService;
  turnRuntime: ChatTurnRuntime;
  productAnalyticsService?: ProductAnalyticsPort;
  workspaceRepository?: Pick<WorkspaceRepositoryPort, "findById">;
  usageLimitPolicy?: UsageLimitPolicy;
  agentService?: Pick<AgentService, "resolve">;
  chatIntakeProvider?: ChatIntakeProviderPort;
  directiveSteering?: DirectiveSteeringPort;
  selectionStrategy?: TurnSelectionStrategy;
  /** The reusable conversation engine drives every chat turn; composition always wires it. */
  conversationEngine: ConversationEngine;
  /** Optional: when wired, routine-emitted fire-and-forget actions are enqueued to the outbox. */
  actionOutbox?: ChatActionOutboxPort;
  assistantTurnPersistence?: AssistantTurnPersistencePort;
  /** Optional: durable per-session routine state store (with {@link routineProvider}). */
  routineStore?: ConversationRoutineStore;
  /** Optional: registered routines + activation. Empty/absent leaves turns unchanged. */
  routineProvider?: ChatRoutineProvider;
}

export class ChatService {
  private readonly chatGateway: ChatGateway;
  private readonly auditService: AuditService;
  private readonly usageLimitPolicy: UsageLimitPolicy;
  private readonly chatIntakeProvider: ChatIntakeProviderPort;
  private readonly selectionStrategy: TurnSelectionStrategy;
  private readonly conversationEngine: ConversationEngine;
  private readonly chatAnswerPresenter: ChatAnswerPresenter;
  private readonly chatSessionPreparer: ChatSessionPreparer;
  private readonly chatTurnLifecycle: ChatTurnLifecycle;
  private readonly turnSkills: TurnSkill[];
  private readonly turnSkillSelector: ChatTurnSkillSelector;
  private readonly answerSupport = new ChatAnswerSupport();
  private readonly routineStore?: ConversationRoutineStore;
  private readonly routineProvider?: ChatRoutineProvider;

  constructor(options: ChatServiceOptions) {
    const {
      conversationRepository,
      messageRepository,
      retrievalTurn,
      chatGateway,
      auditService,
      turnRuntime,
      productAnalyticsService = new NoopProductAnalyticsService(),
      workspaceRepository,
      usageLimitPolicy = new NoopUsageLimitPolicy(),
      agentService,
      chatIntakeProvider = new NoopChatIntakeProvider(),
      directiveSteering = noopDirectiveSteering,
      selectionStrategy = new DefaultTurnSelectionStrategy(),
      conversationEngine,
      actionOutbox,
      assistantTurnPersistence,
      routineStore,
      routineProvider,
    } = options;
    this.routineStore = routineStore;
    this.routineProvider = routineProvider;
    this.chatGateway = chatGateway;
    this.auditService = auditService;
    this.usageLimitPolicy = usageLimitPolicy;
    this.chatIntakeProvider = chatIntakeProvider;
    this.selectionStrategy = selectionStrategy;
    this.conversationEngine = conversationEngine;
    this.chatAnswerPresenter = turnRuntime.chatAnswerPresenter;
    this.turnSkills = turnRuntime.turnSkills;
    this.chatTurnLifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      productAnalyticsService,
      actionOutbox,
      assistantTurnPersistence,
    );
    this.chatSessionPreparer = new ChatSessionPreparer(
      conversationRepository,
      messageRepository,
      retrievalTurn,
      auditService,
      workspaceRepository,
      agentService,
      directiveSteering,
    );
    // One selection seam shared by the engine turn and the host streaming path, so
    // streamed and non-streamed turns resolve the terminal skill identically.
    this.turnSkillSelector = new ChatTurnSkillSelector(this.turnSkills, this.selectionStrategy);
  }

  /**
   * Attempts the registered routines for this turn — a multi-turn skill selected *before*
   * grounding. Returns the routine's rendered reply when it claims the turn (so the host
   * persists it and skips retrieval), or null when no routines are registered, none is
   * active/activates, or the active routine yields the turn (off-topic) — in which case
   * the host falls through to normal selection + grounding. The next-step selector and
   * renderer generate through a model gateway bound to this turn's usage + workspace
   * context, so the runner is built per turn.
   */
  private async attemptRoutineTurn(
    session: PreparedSession,
    accountId: string | undefined,
  ): Promise<{
    presentation: ChatPresentedAnswer;
    engineTrace?: ConversationTrace;
    actions?: RoutineActionRequest[];
    routineStateTransition?: CapturedRoutineTransition | null;
    // Flushes the routine-state transition the engine made this turn. Called by the
    // lifecycle only after the turn's actions are durably enqueued, so a crash before
    // enqueue leaves the routine recoverable rather than advanced past a lost action.
    commitRoutineState: () => Promise<void>;
  } | null> {
    if (!this.routineStore || !this.routineProvider || this.routineProvider.isEmpty) {
      return null;
    }
    const modelGateway = new RoutineChatModelGateway(this.chatGateway, {
      workspaceContext: this.answerSupport.buildChatWorkspaceContext(session),
      usageContext: this.answerSupport.buildChatUsageContext(session, accountId, "routine_turn"),
    });
    const deferredStore = new DeferredRoutineStore(this.routineStore);
    const outcome = await attemptRoutineTurnWithConversationEngine({
      engine: this.conversationEngine,
      session,
      routineStore: deferredStore,
      routineRunner: this.routineProvider.createRunner(modelGateway),
      routineActivator: this.routineProvider.activator(modelGateway),
      presentRoutineReply: (response) => this.chatAnswerPresenter.presentNonRetrievalAnswer(response.answer),
    });
    if (!outcome) {
      return null;
    }
    return {
      presentation: outcome.presentation,
      engineTrace: outcome.result.trace,
      actions: outcome.result.actions,
      routineStateTransition: deferredStore.getTransition(),
      commitRoutineState: () => deferredStore.commit(),
    };
  }

  /**
   * Produces the answer for a prepared turn. The conversation engine drives
   * selection + dispatch and renders the outcome through the shared registry,
   * returning its turn trace for audit (`engineTrace`).
   */
  private async renderTurn(
    session: PreparedSession,
    input: { query: string; userExpectedLocale?: string | null; accountId?: string },
  ): Promise<{ presentation: ChatPresentedAnswer; engineTrace?: ConversationTrace; actions?: RoutineActionRequest[] }> {
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: this.conversationEngine,
      session,
      turnSkillSelector: this.turnSkillSelector,
      turnSkills: this.turnSkills,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId,
    });
    return { presentation, engineTrace: result.trace, actions: result.actions };
  }

  private async *streamTurn(
    session: PreparedSession,
    input: { query: string; userExpectedLocale?: string | null; accountId?: string },
  ): AsyncIterable<PreparedChatStreamTurnEvent> {
    for await (const event of runPreparedChatTurnStreamWithConversationEngine({
      engine: this.conversationEngine,
      session,
      turnSkillSelector: this.turnSkillSelector,
      turnSkills: this.turnSkills,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId,
    })) {
      if (event.type === "chunk") {
        yield event;
        continue;
      }
      yield {
        type: "final",
        finalPresentation: event.presentation,
        suggestions: event.suggestions,
        engineTrace: event.engineTrace,
        actions: event.result.actions,
      };
    }
  }

  async answer(input: {
    workspaceId: string;
    agentId?: string | null;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
    userExpectedLocale?: string | null;
    inputMetadata?: UserMessageInputMetadata;
    metadataFilter?: Record<string, unknown>;
    pageContext?: AssistantPageContext | null;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
  }): Promise<ChatResponse> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");
    const usageReservation = await this.usageLimitPolicy.reserveAnswer({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      surface: input.sourceChannel ?? "assistant",
    });

    try {
      session = await this.chatSessionPreparer.prepare(input, { skipRetrieval: true });
      // Capability-neutral selection: attempt the strategy's candidates in
      // order. `skill_intake` runs the intake skills (used if one matches);
      // `retrieval` is terminal below. Default order reproduces today's behavior.
      const candidates = this.selectionStrategy.select({
        session,
        directives: session.directiveSteering?.matches ?? [],
      });
      for (const candidate of candidates) {
        if (candidate !== "skill_intake") {
          break;
        }
        const intakeResult = await this.handleSkillIntake(input, session);
        if (intakeResult) {
          const { cleanedAnswer, receiptOverrides } = extractSkillTags(intakeResult.answer);
          const response = await this.persistSkillIntakeTurn({
            input,
            session,
            intakeResult: {
              ...intakeResult,
              answer: cleanedAnswer,
              receipt: applyReceiptOverrides(intakeResult.receipt, receiptOverrides),
            },
            stream: input.stream,
          });
          assistantMessageId = response.assistantMessageId;
          await usageReservation.commit();
          return response;
        }
      }
      // A routine is a multi-turn skill: attempt it before grounding. If it claims the
      // turn, there is no retrieval — the routine renders its own reply.
      const routineStartedAt = Date.now();
      const routineTurn = await this.attemptRoutineTurn(session, input.accountId);
      if (routineTurn) {
        const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          session,
          presentation: routineTurn.presentation,
          answerStartedAt: routineStartedAt,
          stream: input.stream,
          engineTrace: routineTurn.engineTrace,
          actions: routineTurn.actions,
          routineStateTransition: routineTurn.routineStateTransition,
          commitRoutineState: routineTurn.commitRoutineState,
        });
        assistantMessageId = completedTurn.assistantMessageId;
        await usageReservation.commit();
        return completedTurn.response;
      }

      // Selection is authoritative: ground only if the strategy selected
      // retrieval; otherwise answer directly (no forced fallthrough to retrieval).
      session = candidates.includes("retrieval")
        ? await this.chatSessionPreparer.prepareRetrieval(input, session)
        : await this.chatSessionPreparer.prepareDirect(input, session);
      const answerStartedAt = Date.now();
      const { presentation, engineTrace, actions } = await this.renderTurn(session, input);
      const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        session,
        presentation,
        answerStartedAt,
        stream: input.stream,
        engineTrace,
        actions,
      });
      assistantMessageId = completedTurn.assistantMessageId;
      await usageReservation.commit();

      return completedTurn.response;
    } catch (error) {
      await usageReservation.release();
      const normalizedError = normalizeProviderCredentialError(error);
      await this.chatTurnLifecycle.recordFailure(input, session, assistantMessageId, normalizedError, workflowPolicy);
      throw normalizedError;
    }
  }

  async *streamAnswer(input: {
    workspaceId: string;
    agentId?: string | null;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
    userExpectedLocale?: string | null;
    inputMetadata?: UserMessageInputMetadata;
    metadataFilter?: Record<string, unknown>;
    pageContext?: AssistantPageContext | null;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
  }): AsyncIterable<ChatStreamEvent> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;
    let lazySuggestionsPromise:
      | Promise<Pick<ChatPresentedAnswer, "suggestions">>
      | undefined;
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");
    const usageReservation = await this.usageLimitPolicy.reserveAnswer({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      surface: input.sourceChannel ?? "assistant",
    });
    let usageReservationCommitted = false;
    let usageReservationReleased = false;
    const releaseUsageReservation = async () => {
      if (usageReservationCommitted || usageReservationReleased) {
        return;
      }
      usageReservationReleased = true;
      await usageReservation.release();
    };

    try {
      session = await this.chatSessionPreparer.prepare(input, { skipRetrieval: true });

      yield {
        type: "conversation",
        conversationId: session.conversation.id,
      };

      const candidates = this.selectionStrategy.select({
        session,
        directives: session.directiveSteering?.matches ?? [],
      });
      for (const candidate of candidates) {
        if (candidate !== "skill_intake") {
          break;
        }
        const intakeResult = await this.handleSkillIntake(input, session);
        if (!intakeResult) {
          continue;
        }
        const { localizedTitle, receiptOverrides, cleanedAnswer } = extractSkillTags(intakeResult.answer);
        const cleanedIntakeResult: ChatIntakeResult = {
          ...intakeResult,
          answer: cleanedAnswer,
          receipt: applyReceiptOverrides(intakeResult.receipt, receiptOverrides),
        };
        const skill = buildSkillStreamPayload(cleanedIntakeResult, localizedTitle);
        yield {
          type: "skill",
          conversationId: session.conversation.id,
          ...skill,
        };
        yield {
          type: "chunk",
          text: cleanedAnswer,
        };
        const response = await this.persistSkillIntakeTurn({
          input,
          session,
          intakeResult: cleanedIntakeResult,
          stream: input.stream,
        });
        assistantMessageId = response.assistantMessageId;
        await usageReservation.commit();
        usageReservationCommitted = true;

        yield {
          type: "done",
          conversationId: response.conversationId,
          agentId: response.agentId,
          agentName: response.agentName,
          assistantMessageId: response.assistantMessageId,
          route: response.route,
          answer: response.answer,
          citations: response.citations,
          answerSegments: response.answerSegments,
          suggestions: response.suggestions,
          activitySummary: response.activitySummary,
          activityTrace: response.activityTrace,
          turnTrace: response.turnTrace,
          skill,
        };
        return;
      }

      // A routine is a multi-turn skill: attempt it before grounding. If it claims the
      // turn, stream its rendered reply and finish — no retrieval.
      const routineStartedAt = Date.now();
      const routineTurn = await this.attemptRoutineTurn(session, input.accountId);
      if (routineTurn) {
        // Durably enqueue the action + advance routine state + persist the reply BEFORE
        // streaming the confirmation. The routine reply is rendered whole (not token-
        // streamed), so delaying the chunk costs nothing — but it means the visitor only
        // sees the "sent" confirmation once the request is actually in the outbox; if the
        // enqueue fails this throws before any chunk and the routine stays recoverable.
        const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          session,
          presentation: routineTurn.presentation,
          answerStartedAt: routineStartedAt,
          stream: input.stream,
          engineTrace: routineTurn.engineTrace,
          actions: routineTurn.actions,
          routineStateTransition: routineTurn.routineStateTransition,
          commitRoutineState: routineTurn.commitRoutineState,
        });
        assistantMessageId = completedTurn.assistantMessageId;
        await usageReservation.commit();
        usageReservationCommitted = true;
        if (routineTurn.presentation.answer) {
          yield { type: "chunk", text: routineTurn.presentation.answer };
        }
        yield { type: "done", ...completedTurn.response };
        return;
      }

      // Selection is authoritative: ground only if the strategy selected
      // retrieval; otherwise answer directly (no forced fallthrough to retrieval).
      session = candidates.includes("retrieval")
        ? await this.chatSessionPreparer.prepareRetrieval(input, session)
        : await this.chatSessionPreparer.prepareDirect(input, session);
      const answerStartedAt = Date.now();

      // Route to the capability that claims this turn and stream its answer. When
      // the reusable engine is wired, it drives the terminal selection/dispatch
      // stages; otherwise the host uses the same selection seam directly.
      let finalPresentation: ChatPresentedAnswer | null = null;
      let suggestions: TurnStreamSuggestions | null = null;
      let engineTrace: ConversationTrace | undefined;
      let actions: RoutineActionRequest[] | undefined;
      for await (const event of this.streamTurn(session, input)) {
        if (event.type === "chunk") {
          yield {
            type: "chunk",
            text: event.text,
          };
          continue;
        }
        finalPresentation = event.finalPresentation;
        suggestions = event.suggestions;
        engineTrace = event.engineTrace;
        actions = event.actions;
      }
      if (!finalPresentation || !suggestions) {
        throw new Error("chat_stream_missing_final_presentation");
      }
      // The lazy promise can call chatActionSuggestionService.evaluate (which may
      // hit an LLM). If completeAssistantTurn below throws, we rethrow but the
      // promise stays in flight — swallow its rejection so it can't surface as an
      // unhandled rejection. The post-`done` await still observes the failure and
      // skips emitting suggestions, which is the desired behavior.
      lazySuggestionsPromise = this.composeLazySuggestions({
        session,
        presentation: finalPresentation,
        suggestions,
        userExpectedLocale: input.userExpectedLocale,
      });
      lazySuggestionsPromise.catch(() => undefined);
      const presentation: ChatPresentedAnswer = {
        ...finalPresentation,
        suggestions: undefined,
      };

      const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        session,
        presentation,
        answerStartedAt,
        stream: input.stream,
        engineTrace,
        actions,
      });
      assistantMessageId = completedTurn.assistantMessageId;
      await usageReservation.commit();
      usageReservationCommitted = true;

      yield {
        type: "done",
        ...completedTurn.response,
      };

    } catch (error) {
      await releaseUsageReservation();
      const normalizedError = normalizeProviderCredentialError(error);
      await this.chatTurnLifecycle.recordFailure(input, session, assistantMessageId, normalizedError, workflowPolicy);
      throw normalizedError;
    } finally {
      await releaseUsageReservation();
    }

    if (!lazySuggestionsPromise || !session) {
      return;
    }
    const conversationId = session.conversation.id;

    try {
      const lazySuggestions = await lazySuggestionsPromise;
      if (lazySuggestions.suggestions && lazySuggestions.suggestions.length > 0) {
        const suggestions = lazySuggestions.suggestions ?? [];
        if (assistantMessageId) {
          await this.chatTurnLifecycle.updateSuggestions({
            workspaceId: input.workspaceId,
            conversationId,
            assistantMessageId,
            suggestions,
          });
        }

        yield {
          type: "suggestions",
          conversationId,
          suggestions,
        };
      }
    } catch {
      // Lazy follow-up suggestions are best effort after the answer is already complete.
    }
  }

  private async composeLazySuggestions(input: {
    session: PreparedSession;
    presentation: ChatPresentedAnswer;
    suggestions: TurnStreamSuggestions;
    userExpectedLocale?: string | null;
  }): Promise<Pick<ChatPresentedAnswer, "suggestions">> {
    const { session, presentation, suggestions, userExpectedLocale } = input;
    // The skill decides where question suggestions come from: assistant-voice
    // replies settle their own onto the presentation; retrieval defers to the
    // host's expansion of the model's planned envelope suggestions.
    const questionSuggestions = suggestions.mode === "presentation"
      ? (presentation.suggestions ?? [])
      : (this.chatAnswerPresenter
          .applyAssistantSuggestions(session, presentation, suggestions.planned)
          .suggestions ?? []);
    const actionSuggestionsResult = await this.chatAnswerPresenter.applyActionSuggestions(
      session,
      presentation,
      userExpectedLocale,
    );
    const actionMergedSuggestions = actionSuggestionsResult.suggestions ?? [];
    return { suggestions: [...actionMergedSuggestions, ...questionSuggestions] };
  }

  private async handleSkillIntake(
    input: {
      workspaceId: string;
      accountId?: string;
      query: string;
      stream: boolean;
      userExpectedLocale?: string | null;
      sourceChannel?: string | null;
      anonymousSessionId?: string | null;
      sourceOrigin?: string | null;
      inputMetadata?: UserMessageInputMetadata;
    },
    session: PreparedSession,
  ): Promise<ChatIntakeResult | null> {
    try {
      return await this.chatIntakeProvider.handle({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        agentId: session.agent.id,
        conversationId: session.conversation.id,
        userMessageId: session.userMessage.id,
        query: input.query,
        history: [...session.history, session.userMessage],
        sourceChannel: input.sourceChannel,
        sourceOrigin: input.sourceOrigin,
        anonymousSessionId: input.anonymousSessionId,
        userExpectedLocale: input.userExpectedLocale,
        inputMetadata: input.inputMetadata,
      });
    } catch (error) {
      try {
        await this.auditService.record({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "chat.skill_intake",
          eventStatus: "failure",
          metadata: {
            conversationId: session.conversation.id,
            userMessageId: session.userMessage.id,
            stream: input.stream,
            errorMessage: error instanceof Error ? error.message : "Unknown error",
          },
        });
      } catch {
        // Intake failure reporting is best effort; the chat turn should remain recoverable.
      }
      return null;
    }
  }

  private async persistSkillIntakeTurn(input: {
    input: {
      workspaceId: string;
      accountId?: string;
    };
    session: PreparedSession;
    intakeResult: ChatIntakeResult;
    stream: boolean;
  }): Promise<ChatResponse> {
    return this.chatTurnLifecycle.completeSkillIntakeTurn({
      workspaceId: input.input.workspaceId,
      accountId: input.input.accountId,
      session: input.session,
      intakeResult: input.intakeResult,
      stream: input.stream,
    });
  }

}
