import { isClassifiedEnablement, keepsStoredValue, type ConversationSaveContext } from "../../modules/context-variables/public.js";
import type { AgentRevisionEnablementReader } from "../../modules/agents/public.js";
import type { ChannelPersonKey, ConversationChannelPersonKeys } from "../../shared/domain/channelPersonKey.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * Where a conversation's reads look beyond its row: the agents module's releases, and the channel
 * that keeps the key of the person the conversation is with (a WhatsApp number), which no column of
 * the row holds.
 */
export interface ConversationReadSources {
  readonly revisions: AgentRevisionEnablementReader;
  readonly personKeys: ConversationChannelPersonKeys;
}

/** A conversation's keys, the agent it is with, and the variables the release it is pinned to classifies. */
interface ConversationClassification {
  readonly conversationId: string;
  readonly agentId: string | null;
  readonly chatSessionId: string | null;
  readonly verifiedCustomerId: string | null;
  readonly channelPersonKey: ChannelPersonKey | null;
  readonly classifiedVariableIds: readonly string[];
}

/**
 * A conversation's row and the enablements of the release it is pinned to, read through the agents
 * module's revision reader, which owns the snapshot and reads only the release's enablements. Null
 * when the conversation is gone; no enablements when it is pinned to no release.
 */
const readConversationRelease = async (
  db: Db,
  { revisions, personKeys }: ConversationReadSources,
  input: { workspaceId: string; conversationId: string },
) => {
  const conversation = await db
    .selectFrom("conversations")
    .select(["id", "agent_id", "agent_revision_id", "anonymous_session_id", "verified_customer_id"])
    .where("workspace_id", "=", input.workspaceId)
    .where("id", "=", input.conversationId)
    .executeTakeFirst();
  if (!conversation) return null;
  const enablements = conversation.agent_id && conversation.agent_revision_id
    ? await revisions.findRevisionEnablements({
      workspaceId: input.workspaceId,
      agentId: conversation.agent_id,
      revisionId: conversation.agent_revision_id,
    }) ?? []
    : [];
  // A conversation has one person key: a verified customer's needs no channel's.
  const channelPersonKey = conversation.verified_customer_id ? null : await personKeys.personKeyOf(input);
  return { conversation, enablements, channelPersonKey };
};

/**
 * Reads what a conversation's own release classifies: the classifier fills what that release
 * selects, the way its turns resolve what it selects. Null when the conversation is gone; no
 * variables when it is pinned to no release.
 */
export const readConversationClassification = async (
  db: Db,
  sources: ConversationReadSources,
  input: { workspaceId: string; conversationId: string },
): Promise<ConversationClassification | null> => {
  const release = await readConversationRelease(db, sources, input);
  if (!release) return null;
  const { conversation, enablements, channelPersonKey } = release;
  return {
    conversationId: conversation.id,
    agentId: conversation.agent_id,
    chatSessionId: conversation.anonymous_session_id,
    verifiedCustomerId: conversation.verified_customer_id,
    channelPersonKey,
    classifiedVariableIds: enablements.filter(isClassifiedEnablement).map((enablement) => enablement.variableId),
  };
};

/**
 * What a save for a conversation reads of it (#1884), in the saving turn's transaction: the customer
 * its row is bound to, or else the person its channel keeps a key for, and the attributes its release
 * keeps, so a save never writes an attribute the release dropped or a person the conversation is not
 * with. A conversation that is gone keeps nothing.
 */
export const readConversationSaveContext = async (
  db: Db,
  sources: ConversationReadSources,
  input: { workspaceId: string; conversationId: string },
): Promise<ConversationSaveContext> => {
  const release = await readConversationRelease(db, sources, input);
  return {
    verifiedCustomerId: release?.conversation.verified_customer_id ?? null,
    channelPersonKey: release?.channelPersonKey ?? null,
    keptVariableIds: new Set((release?.enablements ?? []).filter(keepsStoredValue).map((enablement) => enablement.variableId)),
  };
};
