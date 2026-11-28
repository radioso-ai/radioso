import type { ConversationRecord } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort, UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { notFound } from "../../../shared/domain/errors.js";
import type { ReferenceTimeZone } from "../../../shared/domain/referenceTimeZone.js";
import type { RoutineInvocation } from "../contracts/routineInvocation.js";
import type { UserMessageStoredListener } from "../types/assistantApi.js";
import { userMessageTurnMetadata } from "./userMessageTurnMetadata.js";

/**
 * The recorded form of a tool call: Activity and the Inbox render it as a tool-call block
 * from this, while the message content stays the rendered text a person would have typed.
 */
const routineInvocationInputMetadata = (invocation: RoutineInvocation): UserMessageInputMetadata => ({
  method: "routine_invocation",
  routine: { toolName: invocation.toolName, input: { ...invocation.input } },
});

/**
 * Stores the customer message a turn runs on: its input metadata (a tool call's structured form
 * instead, for one) and what it records about its own turn (`userMessageTurnMetadata`).
 * Then tells `onUserMessageStored` the ids it got, before the rest of the turn runs, so what the
 * caller ties to the message (a send's photos) is tied to it whatever the turn then manages.
 */
export const storeTurnUserMessage = async (
  messages: Pick<MessageRepositoryPort, "create">,
  input: {
    conversationId: string;
    workspaceId: string;
    query: string;
    inputMetadata?: UserMessageInputMetadata;
    routineInvocation?: RoutineInvocation;
    sensitiveSlotKeys: readonly string[];
    referenceTimeZone: ReferenceTimeZone;
    onUserMessageStored?: UserMessageStoredListener;
  },
): Promise<MessageRecord> => {
  const inputMetadata = input.routineInvocation ? routineInvocationInputMetadata(input.routineInvocation) : input.inputMetadata;
  const message = await messages.create({
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    role: "user",
    content: input.query,
    ...userMessageTurnMetadata({
      inputMetadata,
      sensitiveSlotKeys: input.sensitiveSlotKeys,
      referenceTimeZone: input.referenceTimeZone,
    }),
  });
  await input.onUserMessageStored?.({ conversationId: message.conversationId, messageId: message.id });
  return message;
};

/** A recorded customer message a review turn answers instead of recording one. */
export interface ExistingUserMessage {
  message: MessageRecord;
  historyWindow: { maxMessages: number };
}

export const isMessageOf = (
  message: MessageRecord,
  workspaceId: string,
  conversation: ConversationRecord | null,
): boolean =>
  conversation !== null
  && message.workspaceId === workspaceId
  && message.conversationId === conversation.id
  && message.role === "user";

/**
 * The recorded message a retried turn answers, in the form the preparer reads, so the retry
 * records no second copy; nothing for a turn that stores its own message. The history window is
 * the one a live turn reads.
 */
export const resumedUserMessage = async (
  preparer: { loadExistingUserMessage(input: { workspaceId: string; conversationId: string; messageId: string }): Promise<MessageRecord> },
  input: { workspaceId: string; conversationId?: string; resumeUserMessageId?: string },
): Promise<{ existingUserMessage?: ExistingUserMessage }> => {
  if (!input.resumeUserMessageId) {
    return {};
  }
  if (!input.conversationId) {
    throw notFound("Message not found");
  }
  const message = await preparer.loadExistingUserMessage({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: input.resumeUserMessageId,
  });
  return { existingUserMessage: { message, historyWindow: { maxMessages: RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages } } };
};
