import type {
  ConversationMessage,
  TurnContext,
} from "@radioso/conversation-contract";
import type {
  SkillDispatchResult,
  SkillExecutorPort,
  SkillInvocation,
  SkillOutcome,
} from "../../skills/public.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";

import type {
  RetrievalPipelineInterpretationResult,
  RetrievalPipelinePort,
  RetrievalPipelineResult,
} from "./retrievalPipelineService.js";
import type { RetrievalPipelineRequest } from "./retrievalPipelineStages.js";

/** Internal-adapter key the `retrieval.answer` skill declares in its execution descriptor. */
export const RETRIEVAL_ANSWER_ADAPTER = "retrieval_answer";

// The rich RetrievalPipelineResult is not a model-visible answer/output — it is
// loop-internal context the chat turn composes its response from. It therefore
// rides on the outcome's non-model `metadata` channel under a private key, read
// back through the typed helper below so the boundary stays type-safe even
// though the envelope slot is Record<string, unknown>.
const RETRIEVAL_RESULT_KEY = "__retrievalResult";

const embedRetrievalResult = (result: RetrievalPipelineResult): SkillOutcome => ({
  status: "completed",
  metadata: { [RETRIEVAL_RESULT_KEY]: result },
});

/** Extracts the RetrievalPipelineResult a retrieval.answer dispatch settled with, if present. */
export const readRetrievalResult = (outcome: SkillOutcome): RetrievalPipelineResult | null => {
  const value = outcome.metadata?.[RETRIEVAL_RESULT_KEY];
  return value ? (value as RetrievalPipelineResult) : null;
};

interface InterpretedInvocationContext {
  interpreted: RetrievalPipelineInterpretationResult;
  withRetrieval: boolean;
}

interface TurnInvocationContext {
  turn: TurnContext;
  workspaceId: string;
}

const isRequest = (value: unknown): value is RetrievalPipelineRequest =>
  typeof value === "object" && value !== null &&
  typeof (value as RetrievalPipelineRequest).workspaceId === "string" &&
  typeof (value as RetrievalPipelineRequest).query === "string" &&
  Array.isArray((value as RetrievalPipelineRequest).history);

const isInterpreted = (value: unknown): value is InterpretedInvocationContext =>
  typeof value === "object" && value !== null &&
  "interpreted" in value && typeof (value as InterpretedInvocationContext).withRetrieval === "boolean";

const isTurnInvocation = (value: unknown): value is TurnInvocationContext =>
  typeof value === "object" && value !== null &&
  typeof (value as TurnInvocationContext).workspaceId === "string" &&
  typeof (value as TurnInvocationContext).turn === "object" &&
  (value as TurnInvocationContext).turn !== null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const messageDate = (message: ConversationMessage): Date => {
  if (!message.createdAt) return new Date(0);
  const parsed = new Date(message.createdAt);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
};

const retrievalRole = (role: ConversationMessage["role"]): MessageRecord["role"] =>
  role === "user" || role === "assistant" ? role : "system";

const toRetrievalHistory = (
  history: ConversationMessage[],
  workspaceId: string,
  conversationId: string,
): MessageRecord[] =>
  history.map((message, index) => ({
    id: message.id ?? `${conversationId}:history:${index}`,
    conversationId,
    workspaceId,
    role: retrievalRole(message.role),
    content: message.content,
    ...(message.metadata ? { metadata: message.metadata } : {}),
    createdAt: messageDate(message),
  }));

const requestFromTurn = ({ turn, workspaceId }: TurnInvocationContext): RetrievalPipelineRequest => {
  const metadata = optionalRecord(turn.agent.metadata);
  return {
    workspaceId,
    query: turn.inputEvent.content,
    history: toRetrievalHistory(turn.history, workspaceId, turn.sessionId),
    ...(turn.inputEvent.locale ? { responseLanguage: turn.inputEvent.locale } : {}),
    ...(metadata?.skillSettings ? { agentSkillSettings: optionalRecord(metadata.skillSettings) } : {}),
  };
};

/**
 * Dispatches the `retrieval.answer` capability through the skill-invocation port
 * by wrapping the retrieval controller (the fixed/reasoning strategy chooser).
 * Resolution (b) of spec 067/066: the chat turn loop owns answer composition, so
 * this executor returns the rich retrieval *result* as loop-internal context
 * rather than a composed answer.
 *
 * It accepts either a raw `request` (runs the full interpret+execute path) or an
 * already-interpreted result plus a `withRetrieval` flag (the two-phase path the
 * chat loop uses, where interpretation/routing happen in the loop's gather step),
 * or a routine turn context plus workspace id.
 */
export class RetrievalAnswerSkillExecutor implements SkillExecutorPort {
  constructor(private readonly controller: RetrievalPipelinePort) {}

  async dispatch(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    const context = invocation.context ?? {};

    if (isInterpreted(context)) {
      const result = context.withRetrieval
        ? await this.controller.runInterpreted(context.interpreted)
        : await this.controller.runWithoutRetrieval(context.interpreted);
      return { disposition: "settled", outcome: embedRetrievalResult(result) };
    }

    if (isRequest(context.request)) {
      const result = await this.controller.run(context.request);
      return { disposition: "settled", outcome: embedRetrievalResult(result) };
    }

    if (isTurnInvocation(context)) {
      const result = await this.controller.run(requestFromTurn(context));
      return { disposition: "settled", outcome: embedRetrievalResult(result) };
    }

    throw new Error(
      "retrieval.answer dispatch requires a `request`, an `interpreted` result, or a `turn` plus `workspaceId` in the invocation context",
    );
  }
}
