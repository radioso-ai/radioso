import type { MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import { postgresWorkspaceEventRecorder } from "../../db/repositories/workspaceEventRepository.js";
import type { TeammateLabelReaderPort } from "../../modules/auth/contracts/index.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import {
  ConversationActivityReadService,
  publishingWorkspaceEvents,
  type ConversationActivityStore,
} from "../../modules/conversationActivity/public.js";

/**
 * Conversation activity's default wiring: the Postgres table records each event in the writer's
 * transaction and serves the reads, and the activity automations follow is recorded in the workspace
 * event log in that same transaction; teammates are labelled by the auth module's reader, and a
 * conversation with no generated title falls back to its first-message preview, as the Inbox's
 * other rows do.
 */
export const createConversationActivityComposition = (deps: {
  repositories: {
    conversationActivityRepository: ConversationActivityRecorder & ConversationActivityStore;
    messageRepository: Pick<MessageRepositoryPort, "summarizeByConversationIds">;
  };
  teammateLabels: TeammateLabelReaderPort;
}): { recorder: ConversationActivityRecorder; reads: ConversationActivityReadService } => ({
  recorder: publishingWorkspaceEvents(deps.repositories.conversationActivityRepository, postgresWorkspaceEventRecorder),
  reads: new ConversationActivityReadService({
    store: deps.repositories.conversationActivityRepository,
    teammateLabels: deps.teammateLabels,
    previews: {
      previewsByConversationIds: async (workspaceId, conversationIds) => {
        const summaries = await deps.repositories.messageRepository.summarizeByConversationIds(workspaceId, [...conversationIds]);
        return new Map([...summaries].map(([conversationId, summary]) => [conversationId, { text: summary.preview, photoCount: summary.previewPhotoCount }]));
      },
    },
  }),
});
