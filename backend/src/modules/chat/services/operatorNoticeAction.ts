import type { RoutineOperatorNoticeTemplate } from "@radioso/conversation-contract";

/**
 * The payload every operator-notice action carries (`handoff.notify`, `completion.notify`): ids,
 * the reason code, the routine's declared slot values as-is, and the authored notice text when
 * the ending has some. One builder, so the two action types cannot drift apart.
 */
export const operatorNoticeActionPayload = (input: {
  conversationId: string;
  workspaceId: string;
  agentId: string;
  userMessageId: string;
  reason: string;
  routineId?: string;
  stepId?: string;
  /** The routine's declared slot values, forwarded to the operator notice as-is. */
  collected?: Record<string, unknown>;
  notice?: RoutineOperatorNoticeTemplate;
}): Record<string, unknown> => ({
  conversationId: input.conversationId,
  workspaceId: input.workspaceId,
  agentId: input.agentId,
  userMessageId: input.userMessageId,
  reason: input.reason,
  routineId: input.routineId,
  stepId: input.stepId,
  ...(input.collected ? { collected: input.collected } : {}),
  ...(input.notice?.subject || input.notice?.intro ? { notice: authoredNoticeText(input.notice) } : {}),
});

/** Only the text the author wrote; an absent field means the default for the ending's kind. */
const authoredNoticeText = (notice: RoutineOperatorNoticeTemplate): RoutineOperatorNoticeTemplate => ({
  ...(notice.subject ? { subject: notice.subject } : {}),
  ...(notice.intro ? { intro: notice.intro } : {}),
});
