import type {
  ContextVariable,
  ContextVariableScope,
  ConversationAttributeReadPort,
  StoredConversationAttributeValue,
} from "../../modules/context-variables/public.js";
import { anyOf } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { contextVariableColumns, mapContextVariableRow, type ContextVariableRow } from "./contextVariableRepository.js";
import { contextVariableValueColumns, mapContextVariableValueRow, storedScopeId } from "./contextVariableValueReads.js";

/**
 * A conversation's attributes as the operator surfaces read them: the values stored for the
 * conversation, its chat session and its verified customer, with their definitions. Definitions are
 * workspace-level, so a value reads under the definition as it is now, whichever release ran the
 * conversation.
 */
export class ConversationAttributeReads implements ConversationAttributeReadPort {
  constructor(private readonly db: Db) {}

  async readConversationValues(input: { workspaceId: string; conversationId: string }): Promise<StoredConversationAttributeValue[]> {
    const conversation = await this.db
      .selectFrom("conversations")
      .select(["id", "anonymous_session_id", "verified_customer_id"])
      .where("workspace_id", "=", input.workspaceId)
      .where("id", "=", input.conversationId)
      .executeTakeFirst();
    if (!conversation) return [];
    const scopes: ContextVariableScope[] = [
      { type: "conversation", id: conversation.id },
      ...(conversation.anonymous_session_id ? [{ type: "session" as const, id: conversation.anonymous_session_id }] : []),
      ...(conversation.verified_customer_id ? [{ type: "customer" as const, id: conversation.verified_customer_id }] : []),
    ];
    const values = (await this.db
      .selectFrom("context_variable_values")
      .select(contextVariableValueColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where((eb) => eb.or(scopes.map((scope) => eb.and([
        eb("scope_type", "=", scope.type),
        eb("scope_id", "=", storedScopeId(scope)),
      ]))))
      .execute()).map(mapContextVariableValueRow);
    if (values.length === 0) return [];
    const definitions = new Map((await this.db
      .selectFrom("context_variables")
      .select(contextVariableColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where((eb) => anyOf(eb.ref("id"), [...new Set(values.map((value) => value.variableId))], "uuid[]"))
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
