import type { ConversationRepositoryPort } from "../src/db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../src/db/repositories/messageRepository.js";
import type { InternalAgentConfig } from "../src/modules/agents/public.js";
import type { ChatAnswerPort, ChatReviewResult } from "../src/modules/chat/contracts/index.js";
import { publishedDraftReply } from "../src/modules/chat/services/reviewDraft.js";
import type {
  WorkbenchReplayInput,
  WorkbenchReplayResult,
  WorkbenchReplayRunner,
} from "../src/modules/chat/services/workbenchReplayRunner.js";
import type { EvalRunObservedOutput } from "../src/modules/eval/domain/types.js";
import {
  conversationQualityCaseTurnText,
  type ConversationQualityCase,
  type ConversationQualityObservedOutput,
  type ConversationQualityRunnerPort,
} from "../src/modules/eval/suite/index.js";

/**
 * Maps a WorkbenchReplayRunner result into the eval domain's observed-output shape that
 * the suite scorer understands. This is the single translation point between "how a turn
 * is produced" (chat) and "how a turn is scored" (eval), kept out of the pure suite core
 * so that core never depends on chat internals.
 */
export const observedOutputFromReplayResult = (
  result: WorkbenchReplayResult,
): EvalRunObservedOutput => ({
  retrievedChunks: result.resolvedConfig.retrievedChunks.map((chunk) => ({ ...chunk })),
  answer: result.answer,
  citations: result.citations,
  answerSegments: result.answerSegments,
  groundingSummary: result.groundingSummary,
  groundingVerdict: result.groundingSummary?.verdict,
  turnTrace: result.turnTrace,
});

export interface ReplayContext {
  workspaceId: string;
  agentId: string;
  accountId?: string | null;
  baselineAgentConfig: InternalAgentConfig;
}

/**
 * Turns a committed case into the runner's input: prior turns become replayed history
 * records, any seeded routine position is passed through so the agent resumes
 * mid-routine, and a routine invocation rides beside its rendered text so the turn
 * admits the named routine directly. The ephemeral conversation id is injected by the
 * runner, so the history records only need a stable placeholder.
 */
export const buildReplayInput = (
  evalCase: ConversationQualityCase,
  context: ReplayContext,
): WorkbenchReplayInput => {
  const history: MessageRecord[] = (evalCase.history ?? []).map((turn, index) => ({
    id: `cq-history-${index}`,
    conversationId: "cq-replay",
    workspaceId: context.workspaceId,
    role: turn.role,
    content: turn.content,
    createdAt: new Date(0),
  }));

  return {
    workspaceId: context.workspaceId,
    accountId: context.accountId ?? null,
    executionMode: "live" as const,
    sourceAgentId: context.agentId,
    baselineAgentConfig: context.baselineAgentConfig,
    agentConfigOverride: evalCase.agentConfigOverride,
    query: conversationQualityCaseTurnText(evalCase),
    routineInvocation: evalCase.routineInvocation ?? null,
    history,
    pageContext: evalCase.pageContext,
    clientContextCapabilities: evalCase.clientContextCapabilities,
    routineStartState: evalCase.routineStartState ?? null,
  };
};

/**
 * Adapts a composed WorkbenchReplayRunner into the suite's narrow runner port.
 */
export const createWorkbenchReplayRunnerPort = (
  runner: Pick<WorkbenchReplayRunner, "run">,
  context: ReplayContext,
): ConversationQualityRunnerPort => ({
  async run(evalCase) {
    const result = await runner.run(buildReplayInput(evalCase, context));
    return observedOutputFromReplayResult(result);
  },
});

/** What a review case needs from the composed stack: the stores the email channel records into, and the review turn. */
export interface ReviewTurnStack {
  chat: Pick<ChatAnswerPort, "review">;
  conversations: Pick<ConversationRepositoryPort, "create">;
  messages: Pick<MessageRepositoryPort, "create" | "listByConversationId">;
}

export interface ReviewContext {
  workspaceId: string;
  agentId: string;
  /** The agent's published revision: a review turn runs what the email channel serves, not the draft. */
  agentRevisionId: string;
}

/**
 * A review turn as the suite scores it. The grounding verdict is read back from the draft's
 * presentation the way publishing reads it, the coverage verdict from the review facts, and the
 * persisted-reply count is what the conversation gained while the turn ran. A review turn
 * carries no retrieval trace, so it reports no retrieved chunks.
 */
const observedOutputFromReviewResult = (
  result: ChatReviewResult,
  context: { workspaceId: string; persistedAssistantMessageCount: number },
): ConversationQualityObservedOutput => {
  if (result.kind === "human_owned") {
    return { retrievedChunks: [], error: { message: "A person owns the conversation, so no review turn ran." } };
  }
  const draft = result.kind === "draft"
    ? publishedDraftReply({ workspaceId: context.workspaceId, conversationId: result.conversationId, draft: result.draft })
    : null;
  const coverage = result.facts.answerCoverage;
  return {
    retrievedChunks: [],
    ...(draft ? { answer: draft.content } : {}),
    ...(draft?.grounding ? { groundingVerdict: draft.grounding.verdict } : {}),
    reviewTurn: {
      answerCoverage: coverage
        ? { availability: coverage.availability, ...(coverage.coverage ? { coverage: coverage.coverage } : {}) }
        : null,
      persistedAssistantMessageCount: context.persistedAssistantMessageCount,
    },
  };
};

/**
 * Drives `review` cases the way the email channel does: the case's history and then its query are
 * recorded on a new email conversation pinned to the published revision, and `ChatService.review()`
 * answers that recorded message as a draft. The conversation is the case's alone, so the
 * assistant messages it gains while the turn runs are the replies the turn persisted.
 */
export const createReviewTurnRunnerPort = (
  stack: ReviewTurnStack,
  context: ReviewContext,
): Required<Pick<ConversationQualityRunnerPort, "review">> => {
  const assistantMessageCount = async (conversationId: string): Promise<number> =>
    (await stack.messages.listByConversationId(context.workspaceId, conversationId))
      .filter((message) => message.role === "assistant").length;

  return {
    async review(evalCase) {
      const conversation = await stack.conversations.create({
        workspaceId: context.workspaceId,
        agentId: context.agentId,
        agentRevisionId: context.agentRevisionId,
        sourceChannel: "email",
      });
      const history = evalCase.history ?? [];
      for (const turn of history) {
        await stack.messages.create({ conversationId: conversation.id, workspaceId: context.workspaceId, ...turn });
      }
      const request = await stack.messages.create({
        conversationId: conversation.id,
        workspaceId: context.workspaceId,
        role: "user",
        content: conversationQualityCaseTurnText(evalCase),
      });
      const before = await assistantMessageCount(conversation.id);
      const result = await stack.chat.review({
        workspaceId: context.workspaceId,
        agentId: context.agentId,
        conversationId: conversation.id,
        existingUserMessageId: request.id,
        historyWindow: { maxMessages: history.length },
      });
      return observedOutputFromReviewResult(result, {
        workspaceId: context.workspaceId,
        persistedAssistantMessageCount: (await assistantMessageCount(conversation.id)) - before,
      });
    },
  };
};
