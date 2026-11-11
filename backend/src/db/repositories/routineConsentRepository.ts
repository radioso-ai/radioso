import { randomUUID } from "node:crypto";

import type { RoutineConsentDecision, RoutineConsentMethod } from "@radioso/conversation-contract";
import { sql, type Expression } from "kysely";
import { z } from "zod";

import type { ConversationDataRetentionRule } from "../../shared/domain/conversationDataRetention.js";
import {
  exportTimestamp,
  type DataSubjectDataExporter,
  type DataSubjectExportRecord,
  type DataSubjectExportScope,
} from "../../shared/domain/dataSubjectAccess.js";
import type { RoutineConsentTurnEvents, RoutineConsentWritten } from "../../shared/domain/routineConsentTurn.js";
import {
  routineConsentWordingOf,
  routineConsentWordingVersionId,
  type RoutineConsentWording,
} from "../../shared/domain/routineConsentWording.js";
import { anyOf, jsonbKeyText, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * Proof of a routine consent (#1544): every wording a visitor was shown, kept immutably, and every
 * decision a visitor gave, with no reply text and no slot value. A record outlives its conversation
 * and visitor, whose ids it keeps as plain ids; the link to the message that carried the decision
 * goes with that message. Records and wordings go with their workspace; a record is kept while its
 * conversation exists and then follows the workspace's own retention window.
 */

/** One decision as a turn records it. */
interface RoutineConsentRecordInput {
  workspaceId: string;
  agentId: string | null;
  conversationId: string;
  visitorId: string | null;
  routineId: string;
  consentKey: string;
  /** The slots the consent covered when it was decided, which a withdrawal erases. */
  slotKeys: readonly string[];
  wordingVersionId: string;
  locale: string;
  decision: RoutineConsentDecision;
  method: RoutineConsentMethod;
  /** Declined because the visitor's replies stayed unclear after the consent was asked twice. */
  defaulted: boolean;
  /** The conversation's source channel. */
  channel: string | null;
  /** The visitor message that carried the decision. */
  decisionMessageId: string | null;
}

/**
 * What an assistant message that shows a consent carries in its metadata under `consentPrompt`:
 * which consent, and which wording version in which language. Message metadata is the one place a
 * later turn finds the prompt a button click answers.
 */
const consentPromptStampSchema = z.object({
  routineId: z.string(),
  consentKey: z.string(),
  wordingVersionId: z.string(),
  locale: z.string(),
});

/** Rows past their workspace's own conversation retention window, measured from `column`. */
const pastWorkspaceWindow = (column: Expression<Date>, retentionDays: Expression<number | null>, now: Date) =>
  sql<boolean>`${column} < ${now}::timestamptz - make_interval(days => ${retentionDays})`;

export class RoutineConsentRepository {
  constructor(private readonly db: Db) {}

  /**
   * Keeps a wording as shown and returns its version id. A version's content never changes: the
   * same wording shown again finds its row and writes the same id back over it. That write locks the
   * row until the turn commits, so the retention sweep (which skips locked rows) cannot remove a
   * version the turn is about to record a decision against; if the sweep took the row first, the
   * write waits for it and inserts the version again.
   */
  async upsertWordingVersion(input: { workspaceId: string; wording: RoutineConsentWording }): Promise<string> {
    const id = routineConsentWordingVersionId(input.wording);
    await this.db
      .insertInto("routine_consent_wording_versions")
      .values({
        workspace_id: input.workspaceId,
        id,
        locale: input.wording.locale,
        body: input.wording.body,
        agree_label: input.wording.agreeLabel,
        decline_label: input.wording.declineLabel,
      })
      .onConflict((conflict) => conflict.columns(["workspace_id", "id"]).doUpdateSet({ id: (eb) => eb.ref("excluded.id") }))
      .execute();
    return id;
  }

  /**
   * Records a decision once per conversation, routine, consent and wording version, so a retried
   * turn records nothing more. Returns whether this call recorded it. The wording version must
   * already be kept ({@link upsertWordingVersion}).
   */
  async insertRecord(input: RoutineConsentRecordInput): Promise<boolean> {
    const inserted = await this.db
      .insertInto("routine_consent_records")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        conversation_id: input.conversationId,
        visitor_id: input.visitorId,
        routine_id: input.routineId,
        consent_key: input.consentKey,
        slot_keys: [...input.slotKeys],
        wording_version_id: input.wordingVersionId,
        locale: input.locale,
        decision: input.decision,
        method: input.method,
        defaulted: input.defaulted,
        channel: input.channel,
        decision_message_id: input.decisionMessageId,
      })
      .onConflict((conflict) => conflict.columns(["conversation_id", "routine_id", "consent_key", "wording_version_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /**
   * What the conversation decided for a routine's consent, on any of `versionIds` (the wording
   * versions of every language the consent carries): `null` when nothing was decided. A withdrawn
   * grant reads as declined, so a routine never asks again once consent was withdrawn.
   */
  async standing(input: {
    conversationId: string;
    routineId: string;
    consentKey: string;
    versionIds: readonly string[];
  }): Promise<RoutineConsentDecision | null> {
    if (input.versionIds.length === 0) return null;
    const row = await this.db
      .selectFrom("routine_consent_records")
      .select(["decision", "withdrawn_at"])
      .where("conversation_id", "=", input.conversationId)
      .where("routine_id", "=", input.routineId)
      .where("consent_key", "=", input.consentKey)
      .where((eb) => anyOf(eb.ref("wording_version_id"), input.versionIds, "text[]"))
      .orderBy(sql`withdrawn_at IS NOT NULL`, "desc")
      .orderBy("decided_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return row.withdrawn_at === null && row.decision === "granted" ? "granted" : "declined";
  }

  /**
   * The assistant message that showed this routine's consent last in the conversation, with the
   * wording version it showed: the only prompt a button click may answer.
   */
  async latestPrompt(input: {
    conversationId: string;
    routineId: string;
    consentKey: string;
  }): Promise<{ messageId: string; wordingVersionId: string; locale: string } | null> {
    const row = await this.db
      .selectFrom("messages")
      .select(["id", sql<unknown>`metadata_json -> 'consentPrompt'`.as("prompt")])
      .where("conversation_id", "=", input.conversationId)
      .where("role", "=", "assistant")
      .where((eb) => jsonbKeyText(sql`${eb.ref("metadata_json")} -> 'consentPrompt'`, "routineId"), "=", input.routineId)
      .where((eb) => jsonbKeyText(sql`${eb.ref("metadata_json")} -> 'consentPrompt'`, "consentKey"), "=", input.consentKey)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    const stamp = consentPromptStampSchema.parse(row.prompt);
    return { messageId: row.id, wordingVersionId: stamp.wordingVersionId, locale: stamp.locale };
  }

  /**
   * Records what a turn's routine did with its consents, inside the turn's transaction: a consent
   * shown keeps its wording and is stamped on the reply that shows it (`consentPrompt`); a decision
   * keeps its wording and is recorded against the visitor message that carried it; a consent not
   * asked records nothing.
   */
  async writeTurnEvents(input: RoutineConsentTurnEvents & {
    workspaceId: string;
    conversationId: string;
    /** The turn's reply, already stored. */
    assistantMessageId: string;
  }): Promise<RoutineConsentWritten[]> {
    const written: RoutineConsentWritten[] = [];
    for (const event of input.events) {
      if (event.kind === "skipped") {
        written.push({ kind: "skipped", routineId: event.routineId, consentKey: event.consentKey, reason: event.reason });
        continue;
      }
      const wording = routineConsentWordingOf(event.wording);
      if (!wording) {
        // The host's own port produced it, so this is a wiring fault; a decision is never dropped.
        throw new Error(`routine_consent_wording_unreadable:${event.routineId}:${event.consentKey}`);
      }
      const wordingVersionId = await this.upsertWordingVersion({ workspaceId: input.workspaceId, wording });
      if (event.kind === "asked") {
        await this.stampPrompt({ ...input, routineId: event.routineId, consentKey: event.consentKey, wordingVersionId, locale: wording.locale });
        written.push({ kind: "asked", routineId: event.routineId, consentKey: event.consentKey, reask: event.reask, wordingVersionId });
        continue;
      }
      const recorded = await this.insertRecord({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        visitorId: input.visitorId,
        routineId: event.routineId,
        consentKey: event.consentKey,
        slotKeys: event.slotKeys,
        wordingVersionId,
        locale: wording.locale,
        decision: event.decision,
        method: event.method,
        defaulted: event.defaulted,
        channel: input.channel,
        decisionMessageId: input.decisionMessageId,
      });
      const { kind, routineId, consentKey, decision, method, defaulted } = event;
      written.push({ kind, routineId, consentKey, decision, method, defaulted, wordingVersionId, recorded });
    }
    return written;
  }

  /**
   * Erases from a conversation's routine state the slots of every consent withdrawn in it. Run in
   * a turn's transaction after it saves the state, so a withdrawal that committed while the turn
   * ran never leaves a covered value behind, whichever of the two commits first.
   */
  async stripWithdrawnSlots(input: { conversationId: string }): Promise<void> {
    await sql`
      UPDATE routine_states AS state
         SET variables = state.variables - ARRAY(
               SELECT DISTINCT slot_key
                 FROM routine_consent_records AS record, unnest(record.slot_keys) AS slot_key
                WHERE record.conversation_id = state.session_id
                  AND record.routine_id = state.routine_id
                  AND record.withdrawn_at IS NOT NULL)
       WHERE state.session_id = ${input.conversationId}
         AND EXISTS (
               SELECT 1
                 FROM routine_consent_records AS record
                WHERE record.conversation_id = state.session_id
                  AND record.routine_id = state.routine_id
                  AND record.withdrawn_at IS NOT NULL)
    `.execute(this.db);
  }

  private async stampPrompt(input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    routineId: string;
    consentKey: string;
    wordingVersionId: string;
    locale: string;
  }): Promise<void> {
    const stamp: z.infer<typeof consentPromptStampSchema> = {
      routineId: input.routineId,
      consentKey: input.consentKey,
      wordingVersionId: input.wordingVersionId,
      locale: input.locale,
    };
    await this.db
      .updateTable("messages")
      .set({ metadata_json: sql`coalesce(metadata_json, '{}'::jsonb) || jsonb_build_object('consentPrompt', ${toJsonb(stamp)})` })
      .where("id", "=", input.assistantMessageId)
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .execute();
  }
}

/**
 * The export's `consent_records` section: each consent decision the subject gave, in a conversation
 * the export reaches or as a visitor it reaches, with the exact wording they were shown.
 */
export class ConsentRecordExporter implements DataSubjectDataExporter {
  readonly section = "consent_records";

  constructor(private readonly db: Db) {}

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    if (scope.conversationIds.length === 0 && scope.visitorIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("routine_consent_records as record")
      .innerJoin("routine_consent_wording_versions as wording", (join) => join
        .onRef("wording.workspace_id", "=", "record.workspace_id")
        .onRef("wording.id", "=", "record.wording_version_id"))
      .select([
        "record.id",
        "record.conversation_id",
        "record.routine_id",
        "record.consent_key",
        "record.decision",
        "record.method",
        "record.defaulted",
        "record.channel",
        "record.locale",
        "record.wording_version_id",
        "record.decided_at",
        "record.withdrawn_at",
        "wording.body",
        "wording.agree_label",
        "wording.decline_label",
      ])
      .where("record.workspace_id", "=", scope.workspaceId)
      .where((eb) => eb.or([
        anyOf(eb.ref("record.conversation_id"), scope.conversationIds, "uuid[]"),
        anyOf(eb.ref("record.visitor_id"), scope.visitorIds, "uuid[]"),
      ]))
      .orderBy("record.decided_at")
      .orderBy("record.id")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      routineId: row.routine_id,
      consentKey: row.consent_key,
      decision: row.decision,
      method: row.method,
      defaulted: row.defaulted,
      channel: row.channel,
      locale: row.locale,
      wordingVersionId: row.wording_version_id,
      wording: { body: row.body, agreeLabel: row.agree_label, declineLabel: row.decline_label },
      decidedAt: exportTimestamp(row.decided_at),
      withdrawnAt: exportTimestamp(row.withdrawn_at),
    }));
  }
}

/**
 * Removes consent records whose conversation is gone and which were decided before their
 * workspace's own conversation retention window. A conversation expires from its last activity, so
 * a decision older than the window can still prove consent for values its conversation keeps; the
 * record stays as long as the conversation does.
 */
export class ConsentRecordRetention implements ConversationDataRetentionRule {
  readonly table = "routine_consent_records";

  constructor(private readonly db: Db) {}

  async enforce(input: { now: Date; limit: number }): Promise<number> {
    const deleted = await this.db
      .deleteFrom("routine_consent_records")
      .where("id", "in", (eb) => eb
        .selectFrom("routine_consent_records as record")
        .innerJoin("workspaces as workspace", "workspace.id", "record.workspace_id")
        .select("record.id")
        .where("workspace.conversation_retention_days", "is not", null)
        .where(({ ref }) => pastWorkspaceWindow(ref("record.decided_at"), ref("workspace.conversation_retention_days"), input.now))
        .where(({ not, exists, selectFrom: selectConversations }) => not(exists(selectConversations("conversations as conversation")
          .select("conversation.id")
          .whereRef("conversation.id", "=", "record.conversation_id"))))
        .limit(input.limit)
        .forUpdate("record")
        .skipLocked())
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}

/**
 * Removes wording versions first shown before their workspace's own conversation retention window
 * that no record names any more. A version a record still names stays as long as the record.
 */
export class ConsentWordingVersionRetention implements ConversationDataRetentionRule {
  readonly table = "routine_consent_wording_versions";

  constructor(private readonly db: Db) {}

  async enforce(input: { now: Date; limit: number }): Promise<number> {
    const deleted = await this.db
      .deleteFrom("routine_consent_wording_versions")
      .where((eb) => eb(eb.refTuple("workspace_id", "id"), "in", eb.selectFrom("routine_consent_wording_versions as version")
        .innerJoin("workspaces as workspace", "workspace.id", "version.workspace_id")
        .select(["version.workspace_id", "version.id"])
        .where("workspace.conversation_retention_days", "is not", null)
        .where(({ ref }) => pastWorkspaceWindow(ref("version.first_shown_at"), ref("workspace.conversation_retention_days"), input.now))
        .where(({ not, exists, selectFrom: selectRecords }) => not(exists(selectRecords("routine_consent_records as record")
          .select("record.id")
          .whereRef("record.workspace_id", "=", "version.workspace_id")
          .whereRef("record.wording_version_id", "=", "version.id"))))
        .limit(input.limit)
        .forUpdate("version")
        .skipLocked()
        .$asTuple("workspace_id", "id")))
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}
