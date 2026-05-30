import { normalizeProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import type { ConversationEngine, ConversationTrace } from "@radioso/conversation-contract";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AgentService } from "../../agents/public.js";
import type { ChatGateway, ChatGatewayInput, ChatGatewayUsageContext } from "../contracts/chatGateway.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type { ChatStreamEvent, SkillStreamPayload, SkillStreamPhase } from "../contracts/streamEvents.js";
import {
  MissingGroundedMissResponseComposer,
  type GroundedMissResponseComposer,
} from "./groundedMissResponseComposer.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import { AssistantSuggestionExpansionService } from "./assistantSuggestionExpansionService.js";
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
import { runPreparedChatTurnWithConversationEngine } from "./conversationEngineChatTurn.js";
import type { RetrievalTurnPort } from "./retrievalTurnDispatch.js";
import { noopDirectiveSteering, type DirectiveSteeringPort } from "../../directives/public.js";
import {
  buildTurnRendererRegistry,
  type TurnOutcomeRendererRegistry,
  type TurnSkill,
} from "./turnOutcome.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import { RetrievalAnswerComposer, createRetrievalTurnSkill } from "./retrievalTurnSkill.js";
import { SocialAnswerComposer, createSocialTurnSkill } from "./socialTurnSkill.js";
import { AssistantIdentityAnswerComposer, createAssistantIdentityTurnSkill } from "./assistantIdentityTurnSkill.js";
import {
  DefaultTurnSelectionStrategy,
  type TurnSelectionStrategy,
} from "./turnSelectionStrategy.js";
import {
  ChatAnswerPresenter,
  type ChatPresentedAnswer,
  type SkillOutcomeCapabilityProvider,
} from "./chatAnswerPresenter.js";
import { ChatTurnLifecycle } from "./chatTurnLifecycle.js";
import type { ChatActionSuggestionService } from "./actionSuggestions/chatActionSuggestionService.js";
import {
  GroundedAnswerEnvelopeReader,
  type AnswerGroundingVerdict,
  type GroundedAnswerEnvelope,
  type PlannedEnvelopeSuggestion,
} from "./groundedAnswerEnvelope.js";
import { BlankChatAnswerError, hasCitedAnswerSegment } from "./chatAnswerErrors.js";
import { CitationAnchorSanitizer } from "./citationAnchorSanitizer.js";

export type { ChatGateway } from "../contracts/chatGateway.js";
export type { ChatStreamEvent } from "../contracts/streamEvents.js";
export { BlankChatAnswerError } from "./chatAnswerErrors.js";
const CITED_ANSWER_PREFIX_PATTERN = /\[\[\d+\]\](?:[ \t]*[.,;:!?)]?)?[ \t]*/g;

const splitCitedAnswerPrefix = (buffer: string): { streamable: string; remaining: string } => {
  let releaseEnd = 0;
  for (const match of buffer.matchAll(CITED_ANSWER_PREFIX_PATTERN)) {
    releaseEnd = match.index + match[0].length;
  }
  return {
    streamable: buffer.slice(0, releaseEnd),
    remaining: buffer.slice(releaseEnd),
  };
};

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

export class ChatService {
  private readonly chatAnswerPresenter: ChatAnswerPresenter;
  private readonly chatSessionPreparer: ChatSessionPreparer;
  private readonly chatTurnLifecycle: ChatTurnLifecycle;
  private readonly answerSupport: ChatAnswerSupport;
  private readonly retrievalComposer: RetrievalAnswerComposer;
  private readonly socialComposer: SocialAnswerComposer;
  private readonly identityComposer: AssistantIdentityAnswerComposer;
  private readonly turnSkills: TurnSkill[];
  private readonly turnRenderers: TurnOutcomeRendererRegistry;
  constructor(
    conversationRepository: ConversationRepositoryPort,
    messageRepository: MessageRepositoryPort,
    retrievalTurn: RetrievalTurnPort,
    private readonly chatGateway: ChatGateway,
    private readonly auditService: AuditService,
    private readonly groundedMissResponseComposer: GroundedMissResponseComposer = new MissingGroundedMissResponseComposer(),
    productAnalyticsService: ProductAnalyticsPort = new NoopProductAnalyticsService(),
    workspaceRepository?: Pick<WorkspaceRepositoryPort, "findById">,
    private readonly usageLimitPolicy: UsageLimitPolicy = new NoopUsageLimitPolicy(),
    agentService?: Pick<AgentService, "resolve">,
    private readonly chatIntakeProvider: ChatIntakeProviderPort = new NoopChatIntakeProvider(),
    private readonly chatActionSuggestionService?: ChatActionSuggestionService,
    skillOutcomeCapabilities: SkillOutcomeCapabilityProvider = {
      supportsGroundedAnswer: () => false,
    },
    directiveSteering: DirectiveSteeringPort = noopDirectiveSteering,
    private readonly selectionStrategy: TurnSelectionStrategy = new DefaultTurnSelectionStrategy(),
    private readonly conversationEngine?: ConversationEngine,
  ) {
    this.chatTurnLifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      productAnalyticsService,
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
    this.chatAnswerPresenter = new ChatAnswerPresenter(
      new AssistantSuggestionExpansionService(),
      chatActionSuggestionService,
      skillOutcomeCapabilities,
    );
    this.answerSupport = new ChatAnswerSupport();
    this.retrievalComposer = new RetrievalAnswerComposer(
      this.answerSupport,
      this.chatGateway,
      this.chatAnswerPresenter,
      this.groundedMissResponseComposer,
    );
    this.socialComposer = new SocialAnswerComposer(
      this.answerSupport,
      this.chatGateway,
      this.chatAnswerPresenter,
      this.groundedMissResponseComposer,
    );
    this.identityComposer = new AssistantIdentityAnswerComposer(
      this.answerSupport,
      this.chatGateway,
      this.chatAnswerPresenter,
      this.groundedMissResponseComposer,
    );
    // Each terminal answer capability registers as its own skill, selected by route.
    // The turn machinery never branches on "retrieval vs not" — adding a capability
    // is registration here, not a code branch in the turn loop.
    this.turnSkills = [
      createRetrievalTurnSkill(this.retrievalComposer),
      createSocialTurnSkill(this.socialComposer),
      createAssistantIdentityTurnSkill(this.identityComposer),
    ];
    this.turnRenderers = buildTurnRendererRegistry(this.turnSkills);
  }

  /**
   * Produces the answer for a prepared turn by selecting the capability that claims
   * it (retrieval / social / identity) and rendering its outcome. With the engine
   * enabled, the conversation engine drives selection + dispatch and returns its
   * turn trace for audit; otherwise the same skill is selected and rendered
   * directly. Both paths render through the same registry, so the user-facing
   * answer is identical — `engineTrace` is added observability on the engine path.
   */
  private async renderTurn(
    session: PreparedSession,
    input: { query: string; userExpectedLocale?: string | null; accountId?: string },
  ): Promise<{ presentation: ChatPresentedAnswer; engineTrace?: ConversationTrace }> {
    if (this.conversationEngine) {
      const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
        engine: this.conversationEngine,
        session,
        selectionStrategy: this.selectionStrategy,
        turnSkills: this.turnSkills,
        query: input.query,
        userExpectedLocale: input.userExpectedLocale,
        accountId: input.accountId,
      });
      return { presentation, engineTrace: result.trace };
    }
    const skill = this.turnSkills.find((candidate) => candidate.selects(session)) ?? this.turnSkills[0];
    if (!skill) {
      throw new Error("chat_no_turn_skill_registered");
    }
    const turnOutcome = await skill.dispatch(session);
    const presentation = await this.turnRenderers.resolve(turnOutcome).render(turnOutcome, {
      session,
      query: input.query,
      userExpectedLocale: input.userExpectedLocale,
      accountId: input.accountId,
    });
    return { presentation };
  }

  private buildChatWorkspaceContext(session: PreparedSession): LlmCapabilityResolveInput {
    return this.answerSupport.buildChatWorkspaceContext(session);
  }

  private buildChatUsageContext(
    session: PreparedSession,
    accountId: string | undefined,
    attemptKey: string,
  ): ChatGatewayUsageContext {
    return this.answerSupport.buildChatUsageContext(session, accountId, attemptKey);
  }

  private buildAnswerInstructionBlock(session: PreparedSession): string {
    return this.answerSupport.buildAnswerInstructionBlock(session);
  }

  private buildPromptWithPageContext(prompt: string, pageContext?: AssistantPageContext | null): string {
    return this.answerSupport.buildPromptWithPageContext(prompt, pageContext);
  }

  private composeGroundedSystemPrompt(session: PreparedSession): string {
    return this.retrievalComposer.composeGroundedSystemPrompt(session);
  }

  private generateAnswerWithPageContext(
    session: PreparedSession,
    query: string,
    accountId: string | undefined,
  ): Promise<GroundedAnswerEnvelope | null> {
    return this.retrievalComposer.generateAnswerWithPageContext(session, query, accountId);
  }

  // streamAnswer's non-retrieval branch routes to the capability that claims the
  // turn (null on a blank reply, so streaming keeps its own fallback).
  private generateNonRetrievalAnswer(
    session: PreparedSession,
    query: string,
    accountId: string | undefined,
  ): Promise<ChatPresentedAnswer | null> {
    if (session.turnRoute === CHAT_TURN_ROUTE.RETRIEVAL) {
      return Promise.resolve(null);
    }
    const composer = session.turnRoute === CHAT_TURN_ROUTE.SOCIAL_ONLY ? this.socialComposer : this.identityComposer;
    return composer.tryComposeAnswer(session, query, accountId);
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
      // Selection is authoritative: ground only if the strategy selected
      // retrieval; otherwise answer directly (no forced fallthrough to retrieval).
      session = candidates.includes("retrieval")
        ? await this.chatSessionPreparer.prepareRetrieval(input, session)
        : await this.chatSessionPreparer.prepareDirect(input, session);
      const answerStartedAt = Date.now();
      const { presentation, engineTrace } = await this.renderTurn(session, input);
      const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        session,
        presentation,
        answerStartedAt,
        stream: input.stream,
        engineTrace,
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
          skill,
        };
        return;
      }

      // Selection is authoritative: ground only if the strategy selected
      // retrieval; otherwise answer directly (no forced fallthrough to retrieval).
      session = candidates.includes("retrieval")
        ? await this.chatSessionPreparer.prepareRetrieval(input, session)
        : await this.chatSessionPreparer.prepareDirect(input, session);
      let rawAnswer = "";
      let plannedSuggestions: PlannedEnvelopeSuggestion[] = [];
      let answerGrounding: AnswerGroundingVerdict = "grounded";
      let noContextPresentation: ChatPresentedAnswer | null = null;
      let hasStreamedAnswer = false;
      let streamedAnswer = "";
      const answerStartedAt = Date.now();

      if (session.turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL) {
        noContextPresentation = await this.generateNonRetrievalAnswer(session, input.query, input.accountId);
        rawAnswer = noContextPresentation?.answer
          ?? await this.groundedMissResponseComposer.composeNoContext({
            query: input.query,
            userExpectedLocale: input.userExpectedLocale,
            answerInstructionBlock: this.buildAnswerInstructionBlock(session),
            workspaceContext: this.buildChatWorkspaceContext(session),
            usageContext: this.buildChatUsageContext(session, input.accountId, "stream_non_retrieval_miss"),
          });
        yield {
          type: "chunk",
          text: rawAnswer,
        };
        hasStreamedAnswer = true;
        streamedAnswer += rawAnswer;
      } else if (session.retrieval.contexts.length === 0) {
        const fallbackEnvelope = await this.generateAnswerWithPageContext(session, input.query, input.accountId);
        rawAnswer = fallbackEnvelope?.answer
          ?? await this.groundedMissResponseComposer.composeNoContext({
            query: input.query,
            userExpectedLocale: input.userExpectedLocale,
            answerInstructionBlock: this.buildAnswerInstructionBlock(session),
            workspaceContext: this.buildChatWorkspaceContext(session),
            usageContext: this.buildChatUsageContext(session, input.accountId, "stream_grounded_miss"),
          });
        yield {
          type: "chunk",
          text: rawAnswer,
        };
        hasStreamedAnswer = true;
        streamedAnswer += rawAnswer;
      } else {
        const reader = new GroundedAnswerEnvelopeReader();
        const citationSanitizer = new CitationAnchorSanitizer();
        let pendingStreamText = "";
        // Un-cited prose can be retracted wholesale as a grounded miss (see the
        // hasCitedAnswerSegment replacement below), so we withhold the answer
        // until it is anchored. The FIRST citation anchor proves the answer is
        // grounded; once seen, every later token is part of the final answer and
        // streams immediately. Re-holding after each anchor would batch the
        // stream into citation-sized chunks — the cause of coarse streaming.
        let groundingConfirmed = false;
        for await (const text of this.chatGateway.streamAnswer({
          query: input.query,
          history: session.history,
          systemPrompt: this.composeGroundedSystemPrompt(session),
          prompt: this.buildPromptWithPageContext(session.retrieval.prompt, session.pageContext),
          workspaceContext: this.buildChatWorkspaceContext(session),
          usageContext: this.buildChatUsageContext(session, input.accountId, "stream_grounded"),
        })) {
          if (!text) {
            continue;
          }
          pendingStreamText += reader.push(text);
          if (!groundingConfirmed && splitCitedAnswerPrefix(pendingStreamText).streamable) {
            groundingConfirmed = true;
          }
          let streamable = "";
          if (groundingConfirmed) {
            streamable = pendingStreamText;
            pendingStreamText = "";
          }
          const cleanChunk = citationSanitizer.push(streamable);
          if (cleanChunk) {
            streamedAnswer += cleanChunk;
            yield {
              type: "chunk",
              text: cleanChunk,
            };
            hasStreamedAnswer = true;
          }
        }

        const finalized = reader.finalize();
        plannedSuggestions = finalized.suggestions;
        answerGrounding = finalized.grounding;
        rawAnswer = finalized.fullAnswer;
        if (!rawAnswer.trim()) {
          throw new BlankChatAnswerError();
        }
      }

      let presentationWithoutSuggestions = noContextPresentation ?? await this.chatAnswerPresenter.presentWithoutSuggestions(
        session,
        rawAnswer,
        input.query,
        input.userExpectedLocale,
        answerGrounding,
      );
      if (
        !noContextPresentation
        && session.retrieval.contexts.length > 0
        && !hasCitedAnswerSegment(presentationWithoutSuggestions)
      ) {
        const groundedMiss = await this.groundedMissResponseComposer.composeNoContext({
          query: input.query,
          userExpectedLocale: input.userExpectedLocale,
          answerInstructionBlock: this.buildAnswerInstructionBlock(session),
          workspaceContext: this.buildChatWorkspaceContext(session),
          usageContext: this.buildChatUsageContext(session, input.accountId, "stream_grounded_unsupported"),
        });
        presentationWithoutSuggestions = this.chatAnswerPresenter.presentGroundedMissAnswer(groundedMiss);
      }
      if (!hasStreamedAnswer && presentationWithoutSuggestions.answer) {
        yield {
          type: "chunk",
          text: presentationWithoutSuggestions.answer,
        };
        hasStreamedAnswer = true;
        streamedAnswer += presentationWithoutSuggestions.answer;
      } else if (
        hasStreamedAnswer
        && presentationWithoutSuggestions.answer
        && presentationWithoutSuggestions.answer.startsWith(streamedAnswer)
      ) {
        const remainingAnswer = presentationWithoutSuggestions.answer.slice(streamedAnswer.length);
        if (remainingAnswer) {
          yield {
            type: "chunk",
            text: remainingAnswer,
          };
        }
      }
      // The lazy promise can call chatActionSuggestionService.evaluate (which may
      // hit an LLM). If completeAssistantTurn below throws, we rethrow but the
      // promise stays in flight — swallow its rejection so it can't surface as an
      // unhandled rejection. The post-`done` await still observes the failure and
      // skips emitting suggestions, which is the desired behavior.
      lazySuggestionsPromise = this.composeLazySuggestions({
        session,
        presentationWithoutSuggestions,
        noContextPresentation,
        plannedSuggestions,
        userExpectedLocale: input.userExpectedLocale,
      });
      lazySuggestionsPromise.catch(() => undefined);
      const presentation: ChatPresentedAnswer = {
        ...presentationWithoutSuggestions,
        suggestions: undefined,
      };

      const completedTurn = await this.chatTurnLifecycle.completeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        session,
        presentation,
        answerStartedAt,
        stream: input.stream,
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
    presentationWithoutSuggestions: ChatPresentedAnswer;
    noContextPresentation: ChatPresentedAnswer | null;
    plannedSuggestions: PlannedEnvelopeSuggestion[];
    userExpectedLocale?: string | null;
  }): Promise<Pick<ChatPresentedAnswer, "suggestions">> {
    const { session, presentationWithoutSuggestions, noContextPresentation, plannedSuggestions, userExpectedLocale } = input;
    const questionSuggestions = noContextPresentation
      ? (noContextPresentation.suggestions ?? [])
      : (this.chatAnswerPresenter
          .applyAssistantSuggestions(session, presentationWithoutSuggestions, plannedSuggestions)
          .suggestions ?? []);
    const actionSuggestionsResult = await this.chatAnswerPresenter.applyActionSuggestions(
      session,
      presentationWithoutSuggestions,
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
