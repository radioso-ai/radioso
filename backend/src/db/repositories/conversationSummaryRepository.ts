import type {
  ConversationSummaryRecord,
  ConversationSummaryStore,
} from "../../modules/chat/contracts/conversationSummary.js";
import { CHAT_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
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
    return row ? mapRow(row as ConversationSummaryRow) : null;
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
          // and nothing sweeps it), so it must never block a fresh save.
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
