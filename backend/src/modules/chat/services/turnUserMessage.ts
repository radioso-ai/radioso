import type { MessageRecord, MessageRepositoryPort, UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import { sensitiveTurnMetadata } from "../../../shared/domain/sensitiveTranscript.js";
import type { RoutineInvocation } from "../contracts/routineInvocation.js";
import type { UserMessageStoredListener } from "../types/assistantApi.js";

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
 * instead, for one), marked as it is created when it answers a sensitive routine field (#1543).
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
    onUserMessageStored?: UserMessageStoredListener;
  },
): Promise<MessageRecord> => {
  const inputMetadata = input.routineInvocation ? routineInvocationInputMetadata(input.routineInvocation) : input.inputMetadata;
  const message = await messages.create({
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    role: "user",
    content: input.query,
    ...(input.sensitiveSlotKeys.length > 0
      ? { metadata: { ...inputMetadata, ...sensitiveTurnMetadata(input.sensitiveSlotKeys) } }
      : { inputMetadata }),
  });
  await input.onUserMessageStored?.({ conversationId: message.conversationId, messageId: message.id });
  return message;
};
