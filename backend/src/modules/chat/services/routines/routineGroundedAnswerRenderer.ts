import type {
  PendingRenderableTurn,
  RenderableTurn,
  RoutineGroundedAnswerInput,
  RoutineGroundedAnswerRenderer,
  StagedContext,
} from "@radioso/conversation-contract";

import { CHAT_TURN_ROUTE } from "../../../../shared/domain/chatTurnRoute.js";
import { directiveAdherenceMetadataOf } from "../../../../shared/domain/directiveAdherence.js";
import { readRetrievalResult, type RetrievalPipelineResult } from "../../../retrieval/public.js";
import type { AnswerSegment, ChatCitation } from "../../contracts/answerTypes.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import { storedReplyBlockSchema } from "../../contracts/replyBlocks.js";
import type {
  ChatAnswerPresenter,
  ChatPresentedAnswer,
} from "../chatAnswerPresenter.js";
import type { PresentedReplyBlocks } from "../replyBlocks/replyBlockTurn.js";
import type { SkillTurnStatus } from "../assistantTurnOutcomeTypes.js";
import type { PreparedSession } from "../chatSessionPreparer.js";
import {
  buildRetrievalTurnOutcome,
} from "../retrievalTurnSkill.js";
import {
  getUnstreamedFinalAnswerRemainder,
  TurnOutcomeRendererRegistry,
  type TurnRenderContext,
  type TurnSkill,
  type TurnStreamResult,
} from "../turnOutcome.js";
import type { ChatSuggestion } from "../../types/chatResponses.js";

interface RoutineGroundedAnswerRendererOptions {
  session: PreparedSession;
  turnSkills: readonly TurnSkill[];
  /** Expands a streamed answer's planned suggestions the way a whole answer's are expanded. */
  chatAnswerPresenter: Pick<ChatAnswerPresenter, "applyAssistantSuggestions" | "applyActionSuggestions">;
  accountId?: string;
  responseLanguage?: string | Promise<string | undefined>;
  /** The turn's cancellation signal; the grounded answer generates under it. */
  signal?: AbortSignal;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const retrievalResultFromStagedContext = (
  stagedContext: readonly StagedContext[],
): RetrievalPipelineResult | null => {
  for (let index = stagedContext.length - 1; index >= 0; index -= 1) {
    const staged = stagedContext[index];
    if (!staged || !isRecord(staged.metadata) || !isRecord(staged.metadata.skillMetadata)) {
      continue;
    }
    const result = readRetrievalResult({ metadata: staged.metadata.skillMetadata });
    if (result) {
      return result;
    }
  }
  return null;
};

const withRoutineGrounding = (input: {
  session: PreparedSession;
  retrieval: RetrievalPipelineResult;
  responseLanguage?: string;
  steering: RoutineGroundedAnswerInput["steering"];
}): PreparedSession => {
  const directiveSteering = input.session.directiveSteering ?? { rules: [], matches: [], omissions: [] };
  return {
    ...input.session,
    retrieval: input.retrieval,
    turnRoute: CHAT_TURN_ROUTE.RETRIEVAL,
    ...(input.responseLanguage !== undefined ? { responseLanguage: input.responseLanguage } : {}),
    directiveSteering: {
      ...directiveSteering,
      rules: [...directiveSteering.rules, ...input.steering],
    },
  };
};

/**
 * The turn carries its reply blocks as a client receives them; the stored form the message row
 * keeps rides the metadata, so `presentRoutineRenderableAnswer` restores both.
 */
const toRenderableTurn = (presentation: ChatPresentedAnswer): RenderableTurn => ({
  answer: presentation.answer,
  citations: presentation.citations,
  suggestions: presentation.suggestions,
  ...(presentation.replyBlocks ? { blocks: presentation.replyBlocks.presented } : {}),
  metadata: {
    skillName: presentation.skillName,
    skillOutcome: presentation.skillOutcome,
    skillStatus: presentation.skillStatus,
    answerOutcome: presentation.answerOutcome,
    answerSegments: presentation.answerSegments,
    planningCitations: presentation.planningCitations,
    grounding: presentation.grounding,
    ...directiveAdherenceMetadataOf(presentation.metadata),
    effectiveRetrieval: presentation.effectiveRetrieval,
    ...(presentation.replyBlocks ? { storedReplyBlocks: presentation.replyBlocks.stored } : {}),
  },
});

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const skillTurnStatuses = new Set<SkillTurnStatus>([
  "active",
  "paused",
  "awaiting_confirmation",
  "awaiting_tool",
  "completed",
  "cancelled",
  "expired",
  "failed",
]);

const optionalSkillTurnStatus = (value: unknown): SkillTurnStatus | undefined =>
  typeof value === "string" && skillTurnStatuses.has(value as SkillTurnStatus)
    ? value as SkillTurnStatus
    : undefined;

const optionalChatCitations = (value: unknown): ChatCitation[] | undefined =>
  Array.isArray(value) ? value as ChatCitation[] : undefined;

const optionalAnswerSegments = (value: unknown): AnswerSegment[] | undefined =>
  Array.isArray(value) ? value as AnswerSegment[] : undefined;

const optionalChatSuggestions = (value: unknown): ChatSuggestion[] | undefined =>
  Array.isArray(value) ? value as ChatSuggestion[] : undefined;

const optionalGrounding = (value: unknown): ChatPresentedAnswer["grounding"] | undefined =>
  value === "grounded" || value === "degraded" ? value : undefined;

const optionalEffectiveRetrieval = (value: unknown): PreparedSession["retrieval"] | undefined =>
  isRecord(value) && Array.isArray(value.contexts) && isRecord(value.diagnostics) && isRecord(value.trace)
    ? value as unknown as PreparedSession["retrieval"]
    : undefined;

/** Where a restore reports reply blocks it drops, and the turn it names: ids only, never a block's text. */
interface RoutineRenderableAnswerRestore {
  logger?: Pick<AppLogger, "warn">;
  conversation: { id: string; workspaceId: string };
}

const storedReplyBlocksSchema = storedReplyBlockSchema.array();

/**
 * The turn's reply blocks in both forms. The stored form rides untyped metadata, so it is read
 * through its schema, and each stored block pairs with the presented one at its position, so the
 * two must be as many. Blocks that fail either check are dropped in both forms: the message row
 * never keeps a block the visitor was not shown, nor the other way round.
 */
const restoredReplyBlocks = (
  blocks: RenderableTurn["blocks"],
  stored: unknown,
  restore: RoutineRenderableAnswerRestore | undefined,
): PresentedReplyBlocks | undefined => {
  const presented = blocks ?? [];
  const parsed = storedReplyBlocksSchema.safeParse(stored ?? []);
  if (parsed.success && parsed.data.length === presented.length) {
    return presented.length > 0 ? { stored: parsed.data, presented } : undefined;
  }
  restore?.logger?.warn(
    {
      workspaceId: restore.conversation.workspaceId,
      conversationId: restore.conversation.id,
      blockIds: presented.map((block) => block.id),
    },
    "A routine reply's stored blocks did not match its presented blocks; the reply goes without them",
  );
  return undefined;
};

const presentationFromRenderableTurn = (
  response: RenderableTurn,
  restore: RoutineRenderableAnswerRestore | undefined,
): ChatPresentedAnswer | null => {
  if (!isRecord(response.metadata)) {
    return null;
  }
  const skillName = optionalString(response.metadata.skillName);
  const skillOutcome = optionalString(response.metadata.skillOutcome);
  const skillStatus = optionalSkillTurnStatus(response.metadata.skillStatus);
  if (!skillName || !skillOutcome || !skillStatus) {
    return null;
  }
  const replyBlocks = restoredReplyBlocks(response.blocks, response.metadata.storedReplyBlocks, restore);
  return {
    answer: response.answer,
    ...(optionalChatCitations(response.citations) ? { citations: optionalChatCitations(response.citations) } : {}),
    ...(optionalAnswerSegments(response.metadata.answerSegments)
      ? { answerSegments: optionalAnswerSegments(response.metadata.answerSegments) }
      : {}),
    ...(optionalChatSuggestions(response.suggestions) ? { suggestions: optionalChatSuggestions(response.suggestions) } : {}),
    ...(optionalChatCitations(response.metadata.planningCitations)
      ? { planningCitations: optionalChatCitations(response.metadata.planningCitations) }
      : {}),
    skillName,
    skillOutcome,
    skillStatus,
    ...(optionalString(response.metadata.answerOutcome)
      ? { answerOutcome: optionalString(response.metadata.answerOutcome) as ChatPresentedAnswer["answerOutcome"] }
      : {}),
    ...(optionalGrounding(response.metadata.grounding) ? { grounding: optionalGrounding(response.metadata.grounding) } : {}),
    ...(optionalEffectiveRetrieval(response.metadata.effectiveRetrieval)
      ? { effectiveRetrieval: optionalEffectiveRetrieval(response.metadata.effectiveRetrieval) }
      : {}),
    ...(replyBlocks ? { replyBlocks } : {}),
  };
};

export const presentRoutineRenderableAnswer = (
  presenter: ChatAnswerPresenter,
  response: RenderableTurn,
  restore?: RoutineRenderableAnswerRestore,
): ChatPresentedAnswer => {
  const presented = presentationFromRenderableTurn(response, restore);
  if (presented) {
    return presented;
  }
  // A step reply carries authored chips only when it shows a consent's two choices (#1544).
  const suggestions = optionalChatSuggestions(response.suggestions);
  const answer = presenter.presentRoutineAnswer(response.answer, response.citations);
  return suggestions ? { ...answer, suggestions } : answer;
};

export const createRoutineGroundedAnswerRenderer = (
  options: RoutineGroundedAnswerRendererOptions,
): RoutineGroundedAnswerRenderer => {
  /** The retrieval answer for the step: the grounded session, its outcome, and the renderer that writes it. */
  const grounded = async (input: RoutineGroundedAnswerInput, retrieval: RetrievalPipelineResult) => {
    const responseLanguage = await options.responseLanguage;
    const session = withRoutineGrounding({
      session: options.session,
      retrieval,
      responseLanguage,
      steering: input.steering,
    });
    const outcome = buildRetrievalTurnOutcome(session);
    const renderer = options.turnSkills
      .map((skill) => skill.renderer)
      .find((candidate) => candidate.supports(outcome));
    if (!renderer) {
      throw new Error("routine_grounded_renderer_missing_retrieval_turn_renderer");
    }
    const context: TurnRenderContext = {
      session,
      query: session.effectiveQuery ?? session.userMessage.content,
      accountId: options.accountId,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    return { session, outcome, renderer, context };
  };
  const finish = (session: PreparedSession, presentation: ChatPresentedAnswer): RenderableTurn =>
    toRenderableTurn({ ...presentation, effectiveRetrieval: session.retrieval });

  /**
   * A streamed answer settles with its question suggestions still planned; they are expanded,
   * and action suggestions added, exactly as a whole answer's are.
   */
  const withSuggestions = async (session: PreparedSession, result: TurnStreamResult): Promise<ChatPresentedAnswer> => {
    if (result.suggestions.mode !== "assistant") {
      return result.finalPresentation;
    }
    const presenter = options.chatAnswerPresenter;
    const withQuestions = presenter.applyAssistantSuggestions(session, result.finalPresentation, result.suggestions.planned);
    return presenter.applyActionSuggestions(session, withQuestions);
  };

  // Whether the step is groundable is read off the staged context alone; the answer is
  // generated only when the reply is rendered or streamed.
  const prepare = (input: RoutineGroundedAnswerInput): PendingRenderableTurn | null => {
    const retrieval = retrievalResultFromStagedContext(input.turn.stagedContext);
    if (!retrieval) {
      return null;
    }
    return {
      async render() {
        const { session, outcome, renderer, context } = await grounded(input, retrieval);
        return finish(session, await renderer.render(outcome, context));
      },
      // The retrieval renderer's own stream, so its coverage head reader and citation gate
      // decide what reaches the visitor; no coverage sink rides along, as on the whole path.
      async *stream() {
        const { session, outcome, renderer, context } = await grounded(input, retrieval);
        const result = yield* new TurnOutcomeRendererRegistry([renderer]).stream(outcome, context);
        // A bounded decline or a zero-evidence answer arrives only on the settled presentation.
        const remainder = getUnstreamedFinalAnswerRemainder(result);
        if (remainder) {
          yield remainder;
        }
        return finish(session, await withSuggestions(session, result));
      },
    };
  };
  return {
    prepare,
    async render(input) {
      return (await prepare(input)?.render()) ?? null;
    },
  };
};
