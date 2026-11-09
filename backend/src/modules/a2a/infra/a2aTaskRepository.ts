import type { Kysely } from "kysely";

import { isUniqueViolation, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../../shared/infra/kysely/types.js";
import type {
  A2aTaskChanges,
  A2aTaskListQuery,
  A2aTaskRecord,
  A2aTaskStore,
  A2aTaskWrite,
} from "../contracts/ports.js";
import {
  A2A_TASK_REASONS,
  A2A_TASK_STATES,
  OPEN_TASK_STATES,
  type A2aTaskReason,
  type A2aTaskState,
} from "../domain/taskState.js";

const taskColumns = [
  "id",
  "workspace_id",
  "conversation_id",
  "context_token",
  "context_expires_at",
  "routine_execution_id",
  "opening_message_id",
  "caller_message_id",
  "cursor",
  "shown_through_message_id",
  "status_message_id",
  "artifact_message_id",
  "envelope",
  "state",
  "reason",
  "human_stretch",
  "state_at",
  "version",
] as const;

interface TaskRow {
  // SQL rows keep database column names; the repository maps to the port's record.
  id: string;
  workspace_id: string;
  conversation_id: string;
  context_token: string;
  context_expires_at: Date | null;
  routine_execution_id: string | null;
  opening_message_id: string | null;
  caller_message_id: string | null;
  cursor: string | null;
  shown_through_message_id: string | null;
  status_message_id: string | null;
  artifact_message_id: string | null;
  envelope: unknown;
  state: string;
  reason: string | null;
  human_stretch: boolean;
  state_at: Date;
  version: number;
}

const isTaskState = (value: string): value is A2aTaskState => (A2A_TASK_STATES as readonly string[]).includes(value);
const isTaskReason = (value: string): value is A2aTaskReason => (A2A_TASK_REASONS as readonly string[]).includes(value);

const toRecord = (row: TaskRow): A2aTaskRecord => {
  if (!isTaskState(row.state)) {
    // The column's CHECK holds the same list; a row outside it is a schema the code does not know.
    throw new Error("a2a_tasks row has a state this release does not know");
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    contextToken: row.context_token,
    contextExpiresAt: row.context_expires_at,
    routineExecutionId: row.routine_execution_id,
    openingMessageId: row.opening_message_id,
    callerMessageId: row.caller_message_id,
    cursor: row.cursor,
    shownThroughMessageId: row.shown_through_message_id,
    statusMessageId: row.status_message_id,
    artifactMessageId: row.artifact_message_id,
    envelope: row.envelope && typeof row.envelope === "object" ? row.envelope : null,
    state: row.state,
    reason: row.reason && isTaskReason(row.reason) ? row.reason : null,
    humanStretch: row.human_stretch,
    stateAt: row.state_at,
    version: row.version,
  };
};

/** The columns a write sets, from the fields it changes; an absent field keeps its column. */
const changedColumns = (changes: A2aTaskChanges) => ({
  ...(changes.routineExecutionId !== undefined ? { routine_execution_id: changes.routineExecutionId } : {}),
  ...(changes.openingMessageId !== undefined ? { opening_message_id: changes.openingMessageId } : {}),
  ...(changes.callerMessageId !== undefined ? { caller_message_id: changes.callerMessageId } : {}),
  ...(changes.cursor !== undefined ? { cursor: changes.cursor } : {}),
  ...(changes.shownThroughMessageId !== undefined ? { shown_through_message_id: changes.shownThroughMessageId } : {}),
  ...(changes.statusMessageId !== undefined ? { status_message_id: changes.statusMessageId } : {}),
  ...(changes.artifactMessageId !== undefined ? { artifact_message_id: changes.artifactMessageId } : {}),
  ...(changes.envelope !== undefined ? { envelope: changes.envelope === null ? null : toJsonb(changes.envelope) } : {}),
  ...(changes.state !== undefined ? { state: changes.state } : {}),
  ...(changes.reason !== undefined ? { reason: changes.reason } : {}),
  // Set once and kept: no write clears it.
  ...(changes.humanStretch === true ? { human_stretch: true } : {}),
  ...(changes.stateAt !== undefined ? { state_at: changes.stateAt } : {}),
});

/** Raised inside a commit's transaction to roll every part of it back. */
class TaskWriteConflict extends Error {}

export class A2aTaskRepository implements A2aTaskStore {
  constructor(private readonly db: Kysely<DB>) {}

  async findById(id: string): Promise<A2aTaskRecord | null> {
    const row = await this.db.selectFrom("a2a_tasks").select(taskColumns).where("id", "=", id).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async findOpen(conversationId: string): Promise<A2aTaskRecord | null> {
    const row = await this.db
      .selectFrom("a2a_tasks")
      .select(taskColumns)
      .where("conversation_id", "=", conversationId)
      .where("state", "in", OPEN_TASK_STATES)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async commit(write: A2aTaskWrite): Promise<"committed" | "conflict"> {
    try {
      await this.db.transaction().execute(async (trx) => {
        for (const update of write.updates) {
          const result = await trx
            .updateTable("a2a_tasks")
            .set({ ...changedColumns(update.changes), version: update.expectedVersion + 1 })
            .where("id", "=", update.id)
            .where("version", "=", update.expectedVersion)
            .executeTakeFirst();
          if (result.numUpdatedRows === 0n) {
            throw new TaskWriteConflict();
          }
        }
        if (write.insert) {
          const task = write.insert;
          await trx.insertInto("a2a_tasks").values({
            id: task.id,
            workspace_id: task.workspaceId,
            conversation_id: task.conversationId,
            context_token: task.contextToken,
            context_expires_at: task.contextExpiresAt,
            routine_execution_id: task.routineExecutionId,
            opening_message_id: task.openingMessageId,
            caller_message_id: task.callerMessageId,
            cursor: task.cursor,
            shown_through_message_id: task.shownThroughMessageId,
            status_message_id: task.statusMessageId,
            artifact_message_id: task.artifactMessageId,
            envelope: task.envelope === null ? null : toJsonb(task.envelope),
            state: task.state,
            reason: task.reason,
            human_stretch: task.humanStretch,
            state_at: task.stateAt,
            version: 1,
          }).execute();
        }
      });
      return "committed";
    } catch (error) {
      if (error instanceof TaskWriteConflict || isUniqueViolation(error)) {
        return "conflict";
      }
      throw error;
    }
  }

  async list(query: A2aTaskListQuery): Promise<{ tasks: A2aTaskRecord[]; total: number }> {
    let filtered = this.db.selectFrom("a2a_tasks").where("conversation_id", "=", query.conversationId);
    if (query.state) {
      filtered = filtered.where("state", "=", query.state);
    }
    if (query.stateAfter) {
      // A2A's `statusTimestampAfter` is strictly after: a task whose status changed at that instant is not listed.
      filtered = filtered.where("state_at", ">", query.stateAfter);
    }
    let page = filtered.select(taskColumns);
    if (query.before) {
      const { stateAt, id } = query.before;
      page = page.where((eb) => eb.or([
        eb("state_at", "<", stateAt),
        eb.and([eb("state_at", "=", stateAt), eb("id", "<", id)]),
      ]));
    }
    const [rows, count] = await Promise.all([
      page.orderBy("state_at", "desc").orderBy("id", "desc").limit(query.limit).execute(),
      filtered.select((eb) => eb.fn.countAll<string>().as("total")).executeTakeFirst(),
    ]);
    return { tasks: rows.map(toRecord), total: Number(count?.total ?? 0) };
  }
}
