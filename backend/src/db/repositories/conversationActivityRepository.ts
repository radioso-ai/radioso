import { sql } from "kysely";

// The conversation-activity module owns the event vocabulary; this repository is its persistence
// adapter and imports the canonical types rather than redefining them.
import type {
  ClosingActivityKind,
  ClosingConversationActivityRecord,
  ConversationActivityEvent,
  ConversationActivityKind,
  ConversationActivityRecord,
  ConversationActivityRecorder,
} from "../../modules/conversationActivity/contracts/index.js";
import type { ConversationActivityStore } from "../../modules/conversationActivity/public.js";
import { OPERATOR_TEST_SOURCE_CHANNELS } from "../../shared/domain/conversationSource.js";
import { toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface ConversationActivityRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  kind: string;
  actor_user_id: string | null;
  subject_user_id: string | null;
  detail: unknown;
  created_at: Date;
}

type NullableRow<Row> = { [Key in keyof Row]: Row[Key] | null };

// A row of the clock's join that found no event carries nulls in every event column.
const isActivityRow = (row: NullableRow<ConversationActivityRow>): row is ConversationActivityRow => row.id !== null;

const mapRecord = (row: ConversationActivityRow): ConversationActivityRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
  workspaceId: row.workspace_id,
  kind: row.kind as ConversationActivityKind,
  actorUserId: row.actor_user_id,
  subjectUserId: row.subject_user_id,
  detail: row.detail !== null && typeof row.detail === "object" && !Array.isArray(row.detail)
    ? row.detail as Record<string, unknown>
    : {},
  createdAt: row.created_at,
});

const subjectOf = (event: ConversationActivityEvent): string | null =>
  event.kind === "reassigned" ? event.subjectUserId : null;

const detailOf = (event: ConversationActivityEvent): Record<string, unknown> =>
  "detail" in event ? event.detail : {};

// A conversation's timeline is small — a handful of events per handoff or approval — so a cap
// this size only guards a read against a runaway writer.
const TIMELINE_LIMIT = 500;

// Kinds as literals, not parameters, so the planner can match a partial index's predicate.
const kindList = (kinds: readonly ConversationActivityKind[]) => sql.join(kinds.map((kind) => sql.lit(kind)));

export class ConversationActivityRepository implements ConversationActivityRecorder, ConversationActivityStore {
  constructor(private readonly db: Db) {}

  // `clock_timestamp()`, not the transaction's start time: an event dates from when it was written,
  // so it orders against the messages written in the same transaction.
  async record(db: Db, event: ConversationActivityEvent): Promise<void> {
    await sql`
      INSERT INTO conversation_activity (
          conversation_id, workspace_id, kind, actor_user_id, subject_user_id, detail, created_at
        )
        VALUES (
          ${event.conversationId},
          ${event.workspaceId},
          ${event.kind},
          ${event.actorUserId},
          ${subjectOf(event)},
          ${toJsonb(detailOf(event))},
          clock_timestamp()
        )
    `.execute(db);
  }

  /**
   * A conversation's latest {@link TIMELINE_LIMIT} events of `kinds`, oldest first — with
   * `recordedAfter`, only those recorded after that time — in one statement on the timeline index,
   * with the statement's start time as `readAt`: the database's clock dates the events too, and the
   * statement sees every event committed before it began.
   */
  async listForConversation(
    workspaceId: string,
    conversationId: string,
    options: { kinds: readonly ConversationActivityKind[]; recordedAfter?: Date },
  ): Promise<{ records: ConversationActivityRecord[]; readAt: Date }> {
    const kindFilter = options.kinds.length > 0 ? sql`kind IN (${kindList(options.kinds)})` : sql`FALSE`;
    const recordedAfter = options.recordedAfter ? sql`AND created_at > ${options.recordedAfter}` : sql``;
    // The clock row joins the latest events, so a read that finds none still reports when it began.
    const result = await sql<NullableRow<ConversationActivityRow> & { read_at: Date }>`
      SELECT clock.read_at, latest.id, latest.conversation_id, latest.workspace_id, latest.kind,
             latest.actor_user_id, latest.subject_user_id, latest.detail, latest.created_at
        FROM (SELECT statement_timestamp() AS read_at) clock
        LEFT JOIN LATERAL (
          SELECT id, conversation_id, workspace_id, kind, actor_user_id, subject_user_id, detail, created_at
            FROM conversation_activity
           WHERE conversation_id = ${conversationId}
             AND workspace_id = ${workspaceId}
             AND ${kindFilter}
             ${recordedAfter}
           ORDER BY created_at DESC, id DESC
           LIMIT ${TIMELINE_LIMIT}
        ) latest ON TRUE
       ORDER BY latest.created_at ASC, latest.id ASC
    `.execute(this.db);
    const readAt = result.rows[0]?.read_at ?? new Date();
    const records = result.rows.flatMap((row) => (isActivityRow(row) ? [mapRecord(row)] : []));
    return { records, readAt };
  }

  /**
   * A workspace's latest events of `kinds` — closing kinds — newest first, each with its
   * conversation's title. Operator test traffic (dashboard test chat, workbench replay) is left out,
   * as it is from the Inbox.
   */
  async listRecentClosing(
    workspaceId: string,
    limit: number,
    kinds: readonly ClosingActivityKind[],
  ): Promise<ClosingConversationActivityRecord[]> {
    if (kinds.length === 0) {
      return [];
    }
    const operatorTestChannels = sql.join(OPERATOR_TEST_SOURCE_CHANNELS.map((channel) => sql.val(channel)));
    const result = await sql<ConversationActivityRow & { conversation_title: string | null }>`
      SELECT a.id, a.conversation_id, a.workspace_id, a.kind, a.actor_user_id, a.subject_user_id, a.detail,
             a.created_at, c.title AS conversation_title
        FROM conversation_activity a
        JOIN conversations c
          ON c.id = a.conversation_id
       WHERE a.workspace_id = ${workspaceId}
         AND a.kind IN (${kindList(kinds)})
         AND (c.source_channel IS NULL OR c.source_channel NOT IN (${operatorTestChannels}))
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${limit}
    `.execute(this.db);
    return result.rows.map((row) => ({
      ...mapRecord(row),
      // Only closing kinds were asked for, and the table's CHECK holds every kind to the vocabulary.
      kind: row.kind as ClosingActivityKind,
      conversationTitle: row.conversation_title,
    }));
  }
}
