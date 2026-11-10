import type { ConversationDataRetentionRule } from "../../../shared/domain/conversationDataRetention.js";
import {
  exportTimestamp,
  type DataSubjectDataExporter,
  type DataSubjectExportRecord,
  type DataSubjectExportScope,
} from "../../../shared/domain/dataSubjectAccess.js";
import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { OPEN_TASK_STATES } from "../domain/taskState.js";

/**
 * Days a finished task, and a receipt, outlive their last change in a context that has no end of its
 * own (a grant's lasts as long as the grant version). Long past any retry or any caller polling a
 * task it finished with.
 */
const SETTLED_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1_000;

const settledBefore = (now: Date): Date => new Date(now.getTime() - SETTLED_RETENTION_DAYS * DAY_MS);

/**
 * Deletes tasks no caller can reach again: those of a walk-in context past its end, which no
 * request re-admits, and a finished task {@link SETTLED_RETENTION_DAYS} days after it finished. An
 * open task of a live grant context stays until its conversation goes.
 */
export class A2aTaskRetention implements ConversationDataRetentionRule {
  readonly table = "a2a_tasks";

  constructor(private readonly db: Db) {}

  async enforce(input: { now: Date; limit: number }): Promise<number> {
    const deleted = await this.db
      .deleteFrom("a2a_tasks")
      .where("id", "in", (eb) => eb
        .selectFrom("a2a_tasks as task")
        .select("task.id")
        .where(({ and, or, eb: cmp }) => or([
          and([cmp("task.context_expires_at", "is not", null), cmp("task.context_expires_at", "<=", input.now)]),
          and([cmp("task.state", "not in", OPEN_TASK_STATES), cmp("task.state_at", "<", settledBefore(input.now))]),
        ]))
        .limit(input.limit)
        .forUpdate()
        .skipLocked())
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}

/**
 * Deletes receipts no retry can use: those of a walk-in context past its end, and any receipt
 * {@link SETTLED_RETENTION_DAYS} days after it was claimed.
 */
export class A2aMessageReceiptRetention implements ConversationDataRetentionRule {
  readonly table = "a2a_message_receipts";

  constructor(private readonly db: Db) {}

  async enforce(input: { now: Date; limit: number }): Promise<number> {
    const deleted = await this.db
      .deleteFrom("a2a_message_receipts")
      .where(({ eb: cmp, refTuple, selectFrom }) => cmp(
        refTuple("conversation_id", "message_digest"),
        "in",
        selectFrom("a2a_message_receipts as receipt")
          .select(["receipt.conversation_id", "receipt.message_digest"])
          .where(({ and, or, eb: inner }) => or([
            and([inner("receipt.expires_at", "is not", null), inner("receipt.expires_at", "<=", input.now)]),
            inner("receipt.claimed_at", "<", settledBefore(input.now)),
          ]))
          .limit(input.limit)
          .forUpdate()
          .skipLocked()
          .$asTuple("conversation_id", "message_digest"),
      ))
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}

/**
 * The export's `a2a_tasks` section: the A2A tasks a calling agent ran in the subject's
 * conversations, by state and reason. A task holds references and state only; its messages are the
 * conversation's, which the export carries. The task id stays out: for a walk-in context it is the
 * authority to read the conversation while the context lives.
 */
export class A2aTaskExporter implements DataSubjectDataExporter {
  readonly section = "a2a_tasks";

  constructor(private readonly db: Db) {}

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    if (scope.conversationIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("a2a_tasks")
      .select(["conversation_id", "state", "reason", "state_at", "created_at"])
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("conversation_id"), scope.conversationIds, "uuid[]"))
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      state: row.state,
      reason: row.reason,
      stateAt: exportTimestamp(row.state_at),
      openedAt: exportTimestamp(row.created_at),
    }));
  }
}
