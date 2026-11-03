import type { AnswerUsageKind } from "../../../shared/domain/usageLimitPolicy.js";
import { WORKBENCH_TEST_SOURCE_CHANNELS } from "../../../shared/domain/conversationSource.js";
import type { TurnExecutionMode } from "../../../shared/domain/turnExecutionMode.js";

/** Operator-driven workbench/test-chat traffic metering as a cheaper `test_run`; every
 *  other channel is a real customer conversation reply. */
export const chatAnswerUsageKind = (sourceChannel?: string | null): AnswerUsageKind =>
  sourceChannel != null && (WORKBENCH_TEST_SOURCE_CHANNELS as readonly string[]).includes(sourceChannel)
    ? "test_run"
    : "conversation_reply";

export const chatTurnTraceAttributes = (input: {
  accountId?: string;
  conversationId?: string;
  sourceChannel?: string | null;
  stream: boolean;
  workspaceId: string;
  executionMode?: TurnExecutionMode;
}): Record<string, unknown> => ({
  "radioso.account_id": input.accountId,
  "radioso.conversation_id": input.conversationId,
  "radioso.workspace_id": input.workspaceId,
  "chat.source_channel": input.sourceChannel ?? "assistant",
  "chat.stream": input.stream,
  "chat.execution_mode": input.executionMode ?? "live",
});
