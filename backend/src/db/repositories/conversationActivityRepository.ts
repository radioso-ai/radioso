import { sql } from "kysely";

// The conversation-activity module owns the event vocabulary; this repository is its persistence
// adapter and imports the canonical types rather than redefining them.
import {
  CLOSING_ACTIVITY_KINDS,
  type ClosingConversationActivityRecord,
  type ConversationActivityEvent,
  type ConversationActivityKind,
  type ConversationActivityRecord,
  type ConversationActivityRecorder,
} from "../../modules/conversationActivity/contracts/index.js";
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

export class ConversationActivityRepository implements ConversationActivityRecorder {
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

  /** A conversation's events, oldest first. */
  async listForConversation(workspaceId: string, conversationId: string): Promise<ConversationActivityRecord[]> {
    const result = await sql<ConversationActivityRow>`
      SELECT id, conversation_id, workspace_id, kind, actor_user_id, subject_user_id, detail, created_at
        FROM (
          SELECT *
            FROM conversation_activity
           WHERE conversation_id = ${conversationId}
             AND workspace_id = ${workspaceId}
           ORDER BY created_at DESC, id DESC
           LIMIT ${TIMELINE_LIMIT}
        ) latest
       ORDER BY created_at ASC, id ASC
    `.execute(this.db);
    return result.rows.map(mapRecord);
  }

  /**
   * A workspace's latest closing events, newest first, each with its conversation's title. Operator
   * test traffic (dashboard test chat, workbench replay) is left out, as it is from the Inbox.
   */
  async listRecentClosing(workspaceId: string, limit: number): Promise<ClosingConversationActivityRecord[]> {
    // Literal kinds, not parameters, so the planner matches the partial index's predicate.
    const closingKinds = sql.join(CLOSING_ACTIVITY_KINDS.map((kind) => sql.lit(kind)));
    const operatorTestChannels = sql.join(OPERATOR_TEST_SOURCE_CHANNELS.map((channel) => sql.val(channel)));
    const result = await sql<ConversationActivityRow & { conversation_title: string | null }>`
      SELECT a.id, a.conversation_id, a.workspace_id, a.kind, a.actor_user_id, a.subject_user_id, a.detail,
             a.created_at, c.title AS conversation_title
        FROM conversation_activity a
        JOIN conversations c
          ON c.id = a.conversation_id
       WHERE a.workspace_id = ${workspaceId}
         AND a.kind IN (${closingKinds})
         AND (c.source_channel IS NULL OR c.source_channel NOT IN (${operatorTestChannels}))
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${limit}
    `.execute(this.db);
    return result.rows.map((row) => ({ ...mapRecord(row), conversationTitle: row.conversation_title }));
  }
}
