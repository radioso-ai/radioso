import type { ConversationRecord } from "../../../db/repositories/conversationRepository.js";
import type { ChannelPersonKey, ConversationChannelPersonKeys } from "../../../shared/domain/channelPersonKey.js";

/**
 * The person key a turn runs as (#1884): the one its channel attested, else the one the
 * conversation's channel keeps, so a review of a recorded message, a turn whose key could not be
 * read and any other turn that carries none run as the same person as the conversation's other
 * turns. A turn that starts its conversation has none to look up.
 */
export const turnChannelPersonKey = async (
  keys: ConversationChannelPersonKeys | undefined,
  input: { workspaceId: string; channelPersonKey?: ChannelPersonKey | null },
  conversation: Pick<ConversationRecord, "id" | "sourceChannel"> | null,
): Promise<ChannelPersonKey | null> => {
  if (input.channelPersonKey) return input.channelPersonKey;
  if (!conversation || !keys) return null;
  return keys.personKeyOf({ workspaceId: input.workspaceId, conversationId: conversation.id, sourceChannel: conversation.sourceChannel });
};
