import { sql } from "kysely";

import {
  WITHHELD_MESSAGE_COPY_FIELDS,
  WITHHELD_MESSAGE_TEXT,
  WITHHELD_METADATA_KEY,
  type MessageWithholding,
} from "../../shared/domain/messageWithholding.js";
import type { RoutineConsentRecord as ConsentRecord } from "../../shared/domain/routineConsentRecord.js";
import { SENSITIVE_SLOT_KEYS_METADATA_KEY } from "../../shared/domain/sensitiveTranscript.js";
import { toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * The SQL side of withdrawing a routine consent (#1544): reading a conversation's consent records
 * with the wording each was decided on, and, inside the withdrawal's transaction, locking one,
 * erasing the values it covered from the routine state, withholding the messages that carried them,
 * and marking it withdrawn. Satisfies the privacy module's `ConsentRecordReader` structurally.
 */

const recordColumns = [
  "record.id",
  "record.routine_id",
  "record.consent_key",
  "record.slot_keys",
  "record.decision",
  "record.method",
  "record.defaulted",
  "record.locale",
  "record.channel",
  "record.wording_version_id",
  "record.decided_at",
  "record.withdrawn_at",
  "wording.body",
  "wording.agree_label",
  "wording.decline_label",
] as const;

interface RecordRow {
  id: string;
  routine_id: string;
  consent_key: string;
  slot_keys: string[];
  decision: string;
  method: string;
  defaulted: boolean;
  locale: string;
  channel: string | null;
  wording_version_id: string;
  decided_at: Date;
  withdrawn_at: Date | null;
  body: string;
  agree_label: string;
  decline_label: string;
}

const toConsentRecord = (row: RecordRow): ConsentRecord => ({
  id: row.id,
  routineId: row.routine_id,
  consentKey: row.consent_key,
  slotKeys: row.slot_keys,
  // The table's own checks hold both to these values.
  decision: row.decision as ConsentRecord["decision"],
  method: row.method as ConsentRecord["method"],
  defaulted: row.defaulted,
  locale: row.locale,
  channel: row.channel,
  wordingVersionId: row.wording_version_id,
  wording: { body: row.body, agreeLabel: row.agree_label, declineLabel: row.decline_label },
  decidedAt: row.decided_at,
  withdrawnAt: row.withdrawn_at,
});

export class ConsentWithdrawalRepository {
  constructor(private readonly db: Db) {}

  private selectRecords() {
    return this.db
      .selectFrom("routine_consent_records as record")
      .innerJoin("routine_consent_wording_versions as wording", (join) => join
        .onRef("wording.workspace_id", "=", "record.workspace_id")
        .onRef("wording.id", "=", "record.wording_version_id"))
      .select(recordColumns);
  }

  /** A conversation's records, oldest decision first. They outlive the conversation, so it need not exist. */
  async listForConversation(input: { workspaceId: string; conversationId: string }): Promise<ConsentRecord[]> {
    const rows = await this.selectRecords()
      .where("record.workspace_id", "=", input.workspaceId)
      .where("record.conversation_id", "=", input.conversationId)
      .orderBy("record.decided_at")
      .orderBy("record.id")
      .execute();
    return rows.map(toConsentRecord);
  }

  /** Locks one record of the conversation until the transaction ends; null when the workspace has no such record there. */
  async lockRecord(input: { workspaceId: string; conversationId: string; recordId: string }): Promise<ConsentRecord | null> {
    const row = await this.selectRecords()
      .where("record.id", "=", input.recordId)
      .where("record.workspace_id", "=", input.workspaceId)
      .where("record.conversation_id", "=", input.conversationId)
      .forUpdate("record")
      .executeTakeFirst();
    return row ? toConsentRecord(row) : null;
  }

  /** Marks a record withdrawn by the actor, at the transaction's time to the millisecond, and returns that time. */
  async markWithdrawn(input: { recordId: string; actor: { accountId: string; userId: string | null } }): Promise<Date> {
    const row = await this.db
      .updateTable("routine_consent_records")
      .set({
        withdrawn_at: sql<Date>`date_trunc('milliseconds', now())`,
        withdrawn_by_account_id: input.actor.accountId,
        withdrawn_by_user_id: input.actor.userId,
      })
      .where("id", "=", input.recordId)
      .returning("withdrawn_at")
      .executeTakeFirstOrThrow();
    if (!row.withdrawn_at) throw new Error("routine_consent_withdrawal_unrecorded");
    return row.withdrawn_at;
  }

  /**
   * Erases the slots' values from the conversation's state of the routine. The conversation keeps
   * one state, a completed run's included, which this edits where it stands.
   */
  async eraseRoutineValues(input: { conversationId: string; routineId: string; slotKeys: readonly string[] }): Promise<void> {
    await sql`
      UPDATE routine_states
         SET variables = variables - ${sql.val([...input.slotKeys])}::text[]
       WHERE session_id = ${input.conversationId}
         AND routine_id = ${input.routineId}
    `.execute(this.db);
  }

  /**
   * Withholds the conversation's messages whose sensitive marker names any of the slots: the text
   * becomes the redaction marker, the metadata fields that repeat it go, and the message records
   * the withholding. A message an earlier withdrawal withheld keeps its first record. Their facets
   * go too, as a sensitive turn's do. Returns the messages' ids.
   */
  async withholdMessages(input: { workspaceId: string; conversationId: string; slotKeys: readonly string[]; at: Date }): Promise<string[]> {
    const withholding: MessageWithholding = { reason: "consent_withdrawn", at: input.at.toISOString() };
    const rows = await sql<{ id: string }>`
      UPDATE messages
         SET content = ${WITHHELD_MESSAGE_TEXT},
             metadata_json = (metadata_json - ${sql.val([...WITHHELD_MESSAGE_COPY_FIELDS])}::text[])
               || CASE WHEN metadata_json ? ${WITHHELD_METADATA_KEY} THEN '{}'::jsonb
                       ELSE jsonb_build_object(${WITHHELD_METADATA_KEY}::text, ${toJsonb(withholding)}) END
       WHERE workspace_id = ${input.workspaceId}
         AND conversation_id = ${input.conversationId}
         AND jsonb_typeof(metadata_json -> ${SENSITIVE_SLOT_KEYS_METADATA_KEY}::text) = 'array'
         AND (metadata_json -> ${SENSITIVE_SLOT_KEYS_METADATA_KEY}::text) ?| ${sql.val([...input.slotKeys])}::text[]
      RETURNING id
    `.execute(this.db);
    const ids = rows.rows.map((row) => row.id);
    if (ids.length > 0) {
      await this.db
        .deleteFrom("message_facets")
        .where("workspace_id", "=", input.workspaceId)
        .where("message_id", "in", ids)
        .execute();
    }
    return ids;
  }
}
