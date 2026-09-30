import type { MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import type { TeammateLabelReaderPort } from "../../modules/auth/contracts/index.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import {
  ConversationActivityReadService,
  type ConversationActivityStore,
} from "../../modules/conversationActivity/public.js";

/**
 * Conversation activity's default wiring: the Postgres table records each event in the writer's
 * transaction and serves the reads; teammates are labelled by the auth module's reader, and a
 * conversation with no generated title falls back to its first-message preview, as the Inbox's
 * other rows do.
 */
export const createConversationActivityComposition = (deps: {
  store: ConversationActivityRecorder & ConversationActivityStore;
  teammateLabels: TeammateLabelReaderPort;
  messages: Pick<MessageRepositoryPort, "summarizeByConversationIds">;
}): { recorder: ConversationActivityRecorder; reads: ConversationActivityReadService } => ({
  recorder: deps.store,
  reads: new ConversationActivityReadService({
    store: deps.store,
    teammateLabels: deps.teammateLabels,
    previews: {
      previewsByConversationIds: async (workspaceId, conversationIds) => {
        const summaries = await deps.messages.summarizeByConversationIds(workspaceId, [...conversationIds]);
        return new Map([...summaries].map(([conversationId, summary]) => [conversationId, summary.preview]));
      },
    },
  }),
});
