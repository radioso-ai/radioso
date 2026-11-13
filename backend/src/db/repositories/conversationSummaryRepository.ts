import type {
  ConversationSummaryRecord,
  ConversationSummaryStore,
} from "../../modules/chat/contracts/conversationSummary.js";
import { CHAT_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import type { ConversationDataRetentionRule } from "../../shared/domain/conversationDataRetention.js";
import {
  exportTimestamp,
  type DataSubjectDataExporter,
  type DataSubjectExportRecord,
  type DataSubjectExportScope,
} from "../../shared/domain/dataSubjectAccess.js";
import type { MessageCopyWithholder, WithheldMessages } from "../../shared/domain/messageWithholding.js";
import type { BackgroundJobRequest, BackgroundJobWriter } from "../../shared/background-jobs/index.js";
import { anyOf, currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface ConversationSummaryRow {
  session_id: string;
  summary: string;
  covered_message_count: number;
  covered_through: Date;
}

const summaryColumns = ["session_id", "summary", "covered_message_count", "covered_through"] as const;

const mapRow = (row: ConversationSummaryRow): ConversationSummaryRecord => ({
  summary: row.summary,
  coveredMessageCount: row.covered_message_count,
  coveredThrough: new Date(row.covered_through),
});

const DEFAULT_CONVERSATION_SUMMARY_TTL_MS =
  CHAT_BEHAVIOR.conversationSummary.ttlDays * 24 * 60 * 60 * 1000;

/**
 * DB-backed {@link ConversationSummaryStore}: one row per conversation holding the
 * rolling summary (#866). Owns expiry (TTL) so an abandoned conversation's summary
 * is eventually reclaimed and a revived conversation starts fresh.
 *
 * The upsert is watermark-guarded: it only overwrites an existing row when the
 * incoming `coveredMessageCount` is at least the stored one, so an older in-flight
 * regeneration (fewer covered messages) can never clobber a newer summary.
 */
export class ConversationSummaryRepository implements ConversationSummaryStore {
  constructor(
    private readonly db: Db,
    private readonly ttlMs: number = DEFAULT_CONVERSATION_SUMMARY_TTL_MS,
  ) {}

  async load(input: { sessionId: string }): Promise<ConversationSummaryRecord | null> {
    const row = await this.db
      .selectFrom("conversation_summaries")
      .select(summaryColumns)
      .where("session_id", "=", input.sessionId)
      .where("expires_at", ">", currentTimestamp())
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async save(input: { sessionId: string; summary: ConversationSummaryRecord }): Promise<void> {
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await this.db
      .insertInto("conversation_summaries")
      .values({
        session_id: input.sessionId,
        summary: input.summary.summary,
        covered_message_count: input.summary.coveredMessageCount,
        covered_through: input.summary.coveredThrough,
        expires_at: expiresAt,
        updated_at: currentTimestamp(),
      })
      .onConflict((oc) =>
        oc
          .column("session_id")
          .doUpdateSet((eb) => ({
            summary: eb.ref("excluded.summary"),
            covered_message_count: eb.ref("excluded.covered_message_count"),
            covered_through: eb.ref("excluded.covered_through"),
            expires_at: eb.ref("excluded.expires_at"),
            updated_at: currentTimestamp(),
          }))
          // Watermark guard: never let an older, lower-coverage regeneration
          // overwrite a newer summary that already covers more messages. An
          // expired row no longer holds a meaningful watermark (load() hides it
          // until the retention sweep deletes it), so it must never block a fresh save.
          .where((eb) =>
            eb.or([
              eb(
                "conversation_summaries.covered_message_count",
                "<=",
                eb.ref("excluded.covered_message_count"),
              ),
              eb("conversation_summaries.expires_at", "<=", currentTimestamp()),
            ]),
          ),
      )
      .execute();
  }
}

/**
 * Deletes summaries past their expiry. `load` already hides one, but a hidden summary is still a
 * copy of the conversation, so it goes rather than waiting for its conversation to.
 */
export class ConversationSummaryRetention implements ConversationDataRetentionRule {
  readonly table = "conversation_summaries";

  constructor(private readonly db: Db) {}

  async enforce(input: { now: Date; limit: number }): Promise<number> {
    const deleted = await this.db
      .deleteFrom("conversation_summaries")
      .where("session_id", "in", (eb) => eb
        .selectFrom("conversation_summaries")
        .select("session_id")
        .where("expires_at", "<=", input.now)
        .limit(input.limit)
        .forUpdate()
        .skipLocked())
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}

/**
 * Withholds the conversation's summary and title with its withheld messages (#1544). Both are
 * written from the transcript, the summary from its own last text too, so either can restate what a
 * withheld message carried, before any turn marked it. The summary goes, the title clears, and a
 * refresh queued in the withholding's transaction writes both again from the transcript as it now
 * reads.
 */
export class ConversationSummaryWithholder implements MessageCopyWithholder {
  readonly owner = "conversation-summary";

  constructor(
    private readonly db: Db,
    private readonly jobs: Pick<BackgroundJobWriter, "insert">,
    private readonly refreshRequest: (input: { workspaceId: string; conversationId: string }) => BackgroundJobRequest,
  ) {}

  async withhold(messages: WithheldMessages): Promise<number> {
    if (messages.messageIds.length === 0) {
      return 0;
    }
    const deleted = await this.db
      .deleteFrom("conversation_summaries")
      .where("session_id", "=", messages.conversationId)
      .executeTakeFirst();
    const untitled = await this.db
      .updateTable("conversations")
      .set({ title: null })
      .where("id", "=", messages.conversationId)
      .where("workspace_id", "=", messages.workspaceId)
      .where("title", "is not", null)
      .executeTakeFirst();
    await this.jobs.insert(this.refreshRequest(messages), this.db);
    return Number(deleted.numDeletedRows) + Number(untitled.numUpdatedRows);
  }
}

/** The export's `conversation_summaries` section: the rolling summary kept for each conversation. */
export class ConversationSummaryExporter implements DataSubjectDataExporter {
  readonly section = "conversation_summaries";

  constructor(private readonly db: Db) {}

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    if (scope.conversationIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("conversation_summaries as s")
      .innerJoin("conversations as c", "c.id", "s.session_id")
      .select(["s.session_id", "s.summary", "s.covered_message_count", "s.covered_through", "s.updated_at"])
      .where("c.workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("s.session_id"), scope.conversationIds, "uuid[]"))
      .orderBy("s.session_id")
      .execute();
    return rows.map((row) => ({
      conversationId: row.session_id,
      summary: row.summary,
      coveredMessageCount: row.covered_message_count,
      coveredThrough: exportTimestamp(row.covered_through),
      updatedAt: exportTimestamp(row.updated_at),
    }));
  }
}
