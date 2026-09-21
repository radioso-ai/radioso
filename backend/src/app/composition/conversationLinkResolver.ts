import { WorkspaceRepository } from "../../db/repositories/workspaceRepository.js";
import type { ConversationLinkResolver } from "../../modules/operatorNotifications/public.js";
import { conversationPermalink } from "../../shared/domain/dashboardLinks.js";
import type { Database } from "../../shared/infra/database.js";

/**
 * Turns a workspace id into the dashboard link an operator can actually click. The workspace's
 * public route key is not on the notification — a routine action step or a Slack handler has no
 * reason to know the dashboard's URL shape — so it is resolved here, at the delivery edge.
 */
export const buildConversationLinkResolver = (input: {
  database: Database;
  appBaseUrl?: string;
}): ConversationLinkResolver => {
  const workspaces = new WorkspaceRepository(input.database.kysely);
  return {
    async resolve({ workspaceId, conversationId }) {
      const workspace = await workspaces.findById(workspaceId);
      if (!workspace) {
        return null;
      }
      return conversationPermalink(
        { workspacePublicRouteKey: workspace.publicRouteKey, conversationId },
        input.appBaseUrl,
      );
    },
  };
};
