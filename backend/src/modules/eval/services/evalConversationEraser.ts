import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { ConversationDataEraser, ConversationErasureScope } from "../../../shared/domain/conversationDataErasure.js";

/**
 * Erases the eval evidence built from erased conversations: each eval case whose snapshot copied
 * one of them, the runs replayed from those snapshots, and every revision-eval result that froze a
 * copy of such a case. A snapshot holds its conversation's messages and goes with the conversation;
 * the cases and runs on it hold it back (`ON DELETE RESTRICT`), so they go first.
 *
 * The same keys hold back a workspace's own cascade: a revision-eval result keeps its case and its
 * side keeps its agent revision, so a workspace with revision evals could not be deleted. The
 * workspace scope removes its revision evals, runs and cases first; the snapshots go with the workspace.
 */
export class EvalConversationEraser implements ConversationDataEraser {
  readonly owner = "eval";

  constructor(private readonly db: Db) {}

  async erase(scope: ConversationErasureScope): Promise<number> {
    if (scope.kind === "workspace") {
      return this.eraseWorkspace(scope.workspaceId);
    }
    if (scope.conversationIds.length === 0) {
      return 0;
    }
    const snapshots = await this.db
      .selectFrom("eval_snapshots")
      .select("id")
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("source_conversation_id"), scope.conversationIds, "uuid[]"))
      .execute();
    if (snapshots.length === 0) {
      return 0;
    }
    const snapshotIds = snapshots.map((snapshot) => snapshot.id);
    const cases = await this.db
      .selectFrom("eval_cases")
      .select("id")
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("snapshot_id"), snapshotIds, "uuid[]"))
      .execute();
    const caseIds = cases.map((evalCase) => evalCase.id);
    const revisionResults = caseIds.length === 0
      ? 0
      : Number((await this.db
          .deleteFrom("revision_eval_run_cases")
          .where((eb) => anyOf(eb.ref("case_id"), caseIds, "uuid[]"))
          .executeTakeFirst()).numDeletedRows);
    const runs = await this.db
      .deleteFrom("eval_runs")
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("snapshot_id"), snapshotIds, "uuid[]"))
      .executeTakeFirst();
    const deletedCases = caseIds.length === 0
      ? 0
      : Number((await this.db
          .deleteFrom("eval_cases")
          .where("workspace_id", "=", scope.workspaceId)
          .where((eb) => anyOf(eb.ref("id"), caseIds, "uuid[]"))
          .executeTakeFirst()).numDeletedRows);
    return revisionResults + Number(runs.numDeletedRows) + deletedCases;
  }

  private async eraseWorkspace(workspaceId: string): Promise<number> {
    // A revision eval's sides, results and attempts cascade from it.
    const revisionResults = await this.db.deleteFrom("revision_eval_runs").where("workspace_id", "=", workspaceId).executeTakeFirst();
    const runs = await this.db.deleteFrom("eval_runs").where("workspace_id", "=", workspaceId).executeTakeFirst();
    const cases = await this.db.deleteFrom("eval_cases").where("workspace_id", "=", workspaceId).executeTakeFirst();
    return Number(revisionResults.numDeletedRows) + Number(runs.numDeletedRows) + Number(cases.numDeletedRows);
  }
}
