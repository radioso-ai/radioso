import type {
  ContextVariable,
  ConversationAttributeEditReads,
  ConversationAttributeReadPort,
  ConversationScope,
  EditedConversation,
  StoredConversationAttributeValue,
} from "../../modules/context-variables/public.js";
import type { ChannelPersonKey } from "../../shared/domain/channelPersonKey.js";
import { anyOf } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { contextVariableColumns, mapContextVariableRow, type ContextVariableRow } from "./contextVariableRepository.js";
import { readWorkspaceMostSpecificValues } from "./contextVariableValueReads.js";
import { readConversationClassification, type ConversationReadSources } from "./conversationClassifiedVariables.js";

/**
 * A conversation's attributes as the operator surfaces read them: each variable's most specific
 * value on the conversation's own rungs, then the definitions of the variables that have one. Two
 * reads. Definitions are workspace-level, so a value reads under the definition as it is now,
 * whichever release ran the conversation. Which of them the AI fills comes from the release the
 * conversation is pinned to, through the agents module's revision reader, and the person a WhatsApp
 * conversation is with from the channel that keeps the number.
 */
export class ConversationAttributeReads implements ConversationAttributeReadPort, ConversationAttributeEditReads {
  constructor(
    private readonly db: Db,
    private readonly sources: ConversationReadSources,
  ) {}

  async readConversation(workspaceId: string, conversationId: string): Promise<EditedConversation | null> {
    const conversation = await readConversationClassification(this.db, this.sources, { workspaceId, conversationId });
    return conversation
      ? {
        keys: {
          conversationId: conversation.conversationId,
          chatSessionId: conversation.chatSessionId,
          verifiedCustomerId: conversation.verifiedCustomerId,
          channelPersonKey: conversation.channelPersonKey,
        },
        classifiedVariableIds: new Set(conversation.classifiedVariableIds),
      }
      : null;
  }

  readChannelPersonKey(workspaceId: string, conversationId: string, sourceChannel: string | null): Promise<ChannelPersonKey | null> {
    return this.sources.personKeys.personKeyOf({ workspaceId, conversationId, sourceChannel });
  }

  async readClassifiedVariableIds(workspaceId: string, conversationId: string): Promise<ReadonlySet<string>> {
    const conversation = await readConversationClassification(this.db, this.sources, { workspaceId, conversationId });
    return new Set(conversation?.classifiedVariableIds ?? []);
  }

  async readMostSpecificValues(workspaceId: string, scopes: readonly ConversationScope[]): Promise<StoredConversationAttributeValue[]> {
    const values = await readWorkspaceMostSpecificValues(this.db, workspaceId, scopes);
    if (values.length === 0) return [];
    const definitions = new Map((await this.db
      .selectFrom("context_variables")
      .select(contextVariableColumns)
      .where("workspace_id", "=", workspaceId)
      .where((eb) => anyOf(eb.ref("id"), values.map((value) => value.variableId), "uuid[]"))
      .execute()).map((row) => [row.id, mapContextVariableRow(row as ContextVariableRow)]));
    return values.flatMap((value) => {
      const variable = definitions.get(value.variableId);
      return variable ? [{ variable, value }] : [];
    });
  }

  async findByName(workspaceId: string, name: string): Promise<ContextVariable | null> {
    const row = await this.db
      .selectFrom("context_variables")
      .select(contextVariableColumns)
      .where("workspace_id", "=", workspaceId)
      .where("name", "=", name)
      .executeTakeFirst();
    return row ? mapContextVariableRow(row) : null;
  }
}
