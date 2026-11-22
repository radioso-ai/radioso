import { sql } from "kysely";

import type {
  ClassificationTarget,
  ClassifiedVariableReader,
  ContextValueWriterKind,
  ContextVariable,
} from "../../modules/context-variables/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { contextVariableColumns, mapContextVariableRow, type ContextVariableRow } from "./contextVariableRepository.js";

interface ClassificationTargetRow extends ContextVariableRow {
  stored_data: unknown;
  stored_written_by_kind: string | null;
  stored_written_by_ref: string | null;
}

/**
 * The classifier's reads. A conversation's targets come from the revision it is pinned to, so a run
 * fills what the conversation's own release classifies, as its turns resolve what that release
 * selects. Definitions are read live: they are workspace-level and not revisioned.
 */
export class ClassifiedContextVariableReads implements ClassifiedVariableReader {
  constructor(private readonly db: Db) {}

  async readConversationTargets(input: { workspaceId: string; conversationId: string }): Promise<{ agentId: string; targets: ClassificationTarget[] } | null> {
    const conversation = await this.db
      .selectFrom("conversations")
      .select(["id", "agent_id", "agent_revision_id"])
      .where("workspace_id", "=", input.workspaceId)
      .where("id", "=", input.conversationId)
      .executeTakeFirst();
    if (!conversation) return null;
    if (!conversation.agent_id || !conversation.agent_revision_id) {
      return { agentId: conversation.agent_id ?? "", targets: [] };
    }
    const variableColumns = sql.join(contextVariableColumns.map((column) => sql.ref(`variable.${column}`)));
    const { rows } = await sql<ClassificationTargetRow>`
      SELECT ${variableColumns},
             stored.data AS stored_data,
             stored.written_by_kind AS stored_written_by_kind,
             stored.written_by_ref AS stored_written_by_ref
        FROM agent_revisions AS revision
       CROSS JOIN LATERAL jsonb_array_elements(revision.snapshot -> 'contextVariableEnablements') AS enablement(value)
        JOIN context_variables AS variable
          ON variable.id::text = enablement.value ->> 'variableId'
         AND variable.workspace_id = revision.workspace_id
        LEFT JOIN context_variable_values AS stored
          ON stored.variable_id = variable.id
         AND stored.scope_type = 'conversation'
         AND stored.scope_id = ${conversation.id}
       WHERE revision.id = ${conversation.agent_revision_id}
         AND revision.workspace_id = ${input.workspaceId}
         AND enablement.value ->> 'source' = 'classified'
         AND (enablement.value ->> 'enabled')::boolean
       ORDER BY variable.name`.execute(this.db);
    return {
      agentId: conversation.agent_id,
      targets: rows.map((row) => ({
        variable: mapContextVariableRow(row),
        stored: row.stored_written_by_kind
          ? { data: row.stored_data, writtenBy: { kind: row.stored_written_by_kind as ContextValueWriterKind, ref: row.stored_written_by_ref } }
          : null,
      })),
    };
  }

  async readDefinitions(input: { workspaceId: string; variableIds: readonly string[] }): Promise<ContextVariable[]> {
    if (input.variableIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("context_variables")
      .select(contextVariableColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where("id", "in", [...input.variableIds])
      .orderBy("name")
      .execute();
    return rows.map((row) => mapContextVariableRow(row as ContextVariableRow));
  }
}
