import type { AgentRevisionRuntimeReaderPort } from "../../modules/agents/public.js";
import type {
  ContextVariable,
  ConversationAttributeEditReads,
  ConversationAttributeReadPort,
  ConversationScopeKeys,
  ConversationScope,
  StoredConversationAttributeValue,
} from "../../modules/context-variables/public.js";
import { anyOf } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { contextVariableColumns, mapContextVariableRow, type ContextVariableRow } from "./contextVariableRepository.js";
import { readWorkspaceMostSpecificValues } from "./contextVariableValueReads.js";
import { readConversationClassification } from "./conversationClassifiedVariables.js";

/**
 * A conversation's attributes as the operator surfaces read them: each variable's most specific
 * value on the conversation's own rungs, then the definitions of the variables that have one. Two
 * reads. Definitions are workspace-level, so a value reads under the definition as it is now,
 * whichever release ran the conversation. Which of them the AI fills comes from the release the
 * conversation is pinned to, through the agents module's revision reader.
 */
export class ConversationAttributeReads implements ConversationAttributeReadPort, ConversationAttributeEditReads {
  constructor(
    private readonly db: Db,
    private readonly revisions: Pick<AgentRevisionRuntimeReaderPort, "findRevision">,
  ) {}

  async readConversationKeys(workspaceId: string, conversationId: string): Promise<ConversationScopeKeys | null> {
    const conversation = await this.db
      .selectFrom("conversations")
      .select(["id", "anonymous_session_id", "verified_customer_id"])
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", conversationId)
      .executeTakeFirst();
    return conversation
      ? { conversationId: conversation.id, chatSessionId: conversation.anonymous_session_id, verifiedCustomerId: conversation.verified_customer_id }
      : null;
  }

  async readClassifiedVariableIds(workspaceId: string, conversationId: string): Promise<ReadonlySet<string>> {
    const conversation = await readConversationClassification(this.db, this.revisions, { workspaceId, conversationId });
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
