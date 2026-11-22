import { isClassifiedEnablement } from "../../modules/context-variables/public.js";
import type { AgentRevisionRuntimeReaderPort } from "../../modules/agents/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/** A conversation's keys, the agent it is with, and the variables the release it is pinned to classifies. */
interface ConversationClassification {
  readonly conversationId: string;
  readonly agentId: string | null;
  readonly chatSessionId: string | null;
  readonly verifiedCustomerId: string | null;
  readonly classifiedVariableIds: readonly string[];
}

/**
 * Reads what a conversation's own release classifies, through the agents module's revision reader,
 * which owns the snapshot: the classifier fills what that release selects, the way its turns resolve
 * what it selects. Null when the conversation is gone; no variables when it is pinned to no release.
 */
export const readConversationClassification = async (
  db: Db,
  revisions: Pick<AgentRevisionRuntimeReaderPort, "findRevision">,
  input: { workspaceId: string; conversationId: string },
): Promise<ConversationClassification | null> => {
  const conversation = await db
    .selectFrom("conversations")
    .select(["id", "agent_id", "agent_revision_id", "anonymous_session_id", "verified_customer_id"])
    .where("workspace_id", "=", input.workspaceId)
    .where("id", "=", input.conversationId)
    .executeTakeFirst();
  if (!conversation) return null;
  const facts = {
    conversationId: conversation.id,
    agentId: conversation.agent_id,
    chatSessionId: conversation.anonymous_session_id,
    verifiedCustomerId: conversation.verified_customer_id,
  };
  if (!conversation.agent_id || !conversation.agent_revision_id) return { ...facts, classifiedVariableIds: [] };
  const revision = await revisions.findRevision({
    workspaceId: input.workspaceId,
    agentId: conversation.agent_id,
    revisionId: conversation.agent_revision_id,
  });
  return {
    ...facts,
    classifiedVariableIds: (revision?.snapshot.contextVariableEnablements ?? [])
      .filter(isClassifiedEnablement)
      .map((enablement) => enablement.variableId),
  };
};
