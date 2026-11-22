import {
  classificationTargetFrom,
  contextScopeLadder,
  type ClassificationTarget,
  type ClassifiedVariableReader,
  type ContextVariable,
} from "../../modules/context-variables/public.js";
import type { AgentRevisionRuntimeReaderPort } from "../../modules/agents/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { contextVariableColumns, mapContextVariableRow, type ContextVariableRow } from "./contextVariableRepository.js";
import { readLadderValues } from "./contextVariableValueReads.js";
import { readConversationClassification } from "./conversationClassifiedVariables.js";

/**
 * The classifier's reads. A conversation's targets come from the revision it is pinned to, read
 * through the agents module's revision reader, so a run fills what the conversation's own release
 * classifies, as its turns resolve what that release selects. Definitions are read live: they are
 * workspace-level and not revisioned. Each target carries what the conversation's whole ladder
 * holds, the way its turns resolve it.
 */
export class ClassifiedContextVariableReads implements ClassifiedVariableReader {
  constructor(
    private readonly db: Db,
    private readonly revisions: Pick<AgentRevisionRuntimeReaderPort, "findRevision">,
  ) {}

  async readConversationTargets(input: { workspaceId: string; conversationId: string }): Promise<{ agentId: string; targets: ClassificationTarget[] } | null> {
    const conversation = await readConversationClassification(this.db, this.revisions, input);
    if (!conversation) return null;
    const agentId = conversation.agentId ?? "";
    const variableIds = conversation.classifiedVariableIds;
    if (!conversation.agentId || variableIds.length === 0) return { agentId, targets: [] };
    const ladder = contextScopeLadder({
      conversationId: conversation.conversationId,
      chatSessionId: conversation.chatSessionId,
      verifiedCustomerId: conversation.verifiedCustomerId,
      agentId,
      workspaceId: input.workspaceId,
    });
    const [variables, values] = await Promise.all([
      this.readDefinitions({ workspaceId: input.workspaceId, variableIds }),
      readLadderValues(this.db, variableIds, ladder),
    ]);
    return {
      agentId,
      targets: variables.map((variable) => classificationTargetFrom(variable, values.filter((value) => value.variableId === variable.id))),
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
