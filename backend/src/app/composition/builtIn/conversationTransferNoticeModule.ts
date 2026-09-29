import { AccountMembershipRepository } from "../../../db/repositories/accountMembershipRepository.js";
import { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import { UserRepository } from "../../../db/repositories/userRepository.js";
import { WorkspaceGrantRepository } from "../../../db/repositories/workspaceGrantRepository.js";
import { WorkspaceRepository } from "../../../db/repositories/workspaceRepository.js";
import { AccountAccessService } from "../../../modules/account/public.js";
import {
  CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
  ConversationTransferNoticeActionHandler,
} from "../../../modules/handoff/public.js";
import type { ApplicationModule } from "../applicationModule.js";
import { createConversationOperatorDirectory } from "../conversationOperatorDirectory.js";
import { buildConversationLinkResolver } from "../conversationLinkResolver.js";

/**
 * Delivers the email a teammate gets when a conversation is handed to them. The transfer route
 * queues the notice on the action outbox; this registers the worker-side handler that sends it.
 */
export const createConversationTransferNoticeApplicationModule = (): ApplicationModule => ({
  id: "radioso-conversation-transfer-notice",
  name: "Radioso Conversation Transfer Notice",
  register(context) {
    context.registerActionHandler({
      type: CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
      // An operator action, not a routine one: no capability gates a teammate's own inbox, and
      // only the transfer route queues it.
      requiredCapabilities: [],
      emittableByRoutines: false,
      handler: ({ auditService, database, env, logger, mailService }) => {
        const workspaces = new WorkspaceRepository(database.kysely);
        return new ConversationTransferNoticeActionHandler({
          users: new UserRepository(database.kysely),
          workspaces,
          ownership: new ConversationOwnershipRepository(database.kysely),
          operators: createConversationOperatorDirectory({
            accountAccess: new AccountAccessService(
              new AccountMembershipRepository(database.kysely),
              auditService,
              new WorkspaceGrantRepository(database.kysely),
              workspaces,
            ),
          }),
          conversationLinks: buildConversationLinkResolver({ database, appBaseUrl: env.APP_BASE_URL }),
          mail: mailService,
          appBaseUrl: env.APP_BASE_URL,
          logger,
        });
      },
    });
  },
});
