import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { AgentSnapshot } from "../../agents/public.js";
import type { RetrievalSettingsRecord, RetrievalSettingsSnapshot } from "../../settings/contracts/retrieval.js";
import type { EvalRunModelOverride, EvalRunRetrievedChunk, EvalSnapshot, EvalSnapshotMessage } from "../domain/types.js";

/**
 * Narrow port the eval module uses to drive the assistant pipeline.
 *
 * - `retrieve` runs only the retrieval pipeline (no LLM call). Cheap and
 *   deterministic; used for retrieval_only run mode.
 * - `answer` runs the full pipeline: retrieval, instruction composition,
 *   and the chat LLM call. Used for full_assistant run mode and answer-
 *   based assertions.
 *
 * The concrete implementation wraps the existing RetrievalPipelineService
 * and ChatGateway. The eval module never depends on those contracts
 * directly — only on this port shape.
 */
export interface EvalReplayContext {
  /** Frozen agent snapshot to apply during replay: persona, custom
   * instruction, source scope, suggested-question behavior. */
  agent?: AgentSnapshot | null;
  /** Custom-instruction override that takes precedence over the agent's
   * baked-in customInstruction. Plumbed from EvalRunOverrides. */
  customInstructionOverride?: string;
}

export interface EvalRetrievalRunnerPort {
  retrieve(input: {
    workspaceId: string;
    query: string;
    history: MessageRecord[];
    context?: EvalReplayContext;
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }): Promise<{ chunks: EvalRunRetrievedChunk[]; resolvedSettings?: RetrievalSettingsSnapshot }>;

  answer(input: {
    workspaceId: string;
    accountId?: string | null;
    runId: string;
    query: string;
    history: MessageRecord[];
    context?: EvalReplayContext;
    modelOverride?: EvalRunModelOverride;
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }): Promise<{
    chunks: EvalRunRetrievedChunk[];
    answer: string;
    composedInstructions?: string;
    resolvedSettings?: RetrievalSettingsSnapshot;
    resolvedModel?: { provider: string; model: string };
  }>;
}

export interface ReplayInputs {
  query: string;
  history: MessageRecord[];
}

const toMessageRecord = (
  message: EvalSnapshotMessage,
  workspaceId: string,
  conversationId: string,
): MessageRecord => ({
  id: message.id,
  conversationId,
  workspaceId,
  role: message.role,
  content: message.content,
  createdAt: new Date(message.createdAt),
});

/**
 * Build the (query, history) pair that the retrieval/assistant pipeline needs
 * to replay a snapshot. The snapshot's messages are the full thread up to and
 * including the turn under test, in chronological order:
 *
 *   [...preceding turns, last_user_message, original_assistant_answer?]
 *
 * The eval replays the last user message — that's the prompt the assistant
 * needs to answer afresh. Everything before it is conversation history that
 * the pipeline uses for rewrite, retrieval, and prompt assembly. The
 * original assistant answer (if present at the very end) is NOT included in
 * history — that's the output we're regenerating, not context.
 *
 * Returns null when the snapshot has no user message to replay (e.g. the
 * conversation only contains the assistant's opening greeting).
 */
export const buildReplayInputs = (snapshot: EvalSnapshot): ReplayInputs | null => {
  const lastUserIdx = (() => {
    for (let i = snapshot.messages.length - 1; i >= 0; i--) {
      if (snapshot.messages[i]?.role === "user") return i;
    }
    return -1;
  })();
  if (lastUserIdx === -1) return null;
  const queryMessage = snapshot.messages[lastUserIdx]!;
  const history = snapshot.messages
    .slice(0, lastUserIdx)
    .map((m) => toMessageRecord(m, snapshot.workspaceId, snapshot.sourceConversationId));
  return { query: queryMessage.content, history };
};

/**
 * @deprecated use buildReplayInputs instead. Kept for backwards-compat with
 * tests that only need the bare last-user-message string.
 */
export const findLastUserMessage = (snapshot: EvalSnapshot): string | null =>
  buildReplayInputs(snapshot)?.query ?? null;
