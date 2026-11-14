import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { ConversationDataEraser, ConversationErasureScope } from "../../../../shared/domain/conversationDataErasure.js";
import { anyOf, toJsonb } from "../../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../../shared/infra/kysely/types.js";

export interface WhatsAppContactRecord {
  id: string;
  waId: string;
  profileName: string | null;
  workspaceId: string;
  conversationId: string;
  firstSeenAt: Date;
  lastMessageAt: Date;
}

export type WhatsAppMessageLogStatus = "received" | "processing" | "replied" | "failed" | "retryable_failed" | "skipped";

export interface WhatsAppMessageLogRecord {
  id: string;
  wamid: string;
  direction: "inbound" | "outbound";
  workspaceId: string;
  waId: string;
  messageType: string;
  payload: Record<string, unknown>;
  status: WhatsAppMessageLogStatus;
  errorDetails: string | null;
  createdAt: Date;
}

export interface WhatsAppPersistencePort {
  findContact(workspaceId: string, waId: string): Promise<WhatsAppContactRecord | null>;
  upsertContact(input: {
    workspaceId: string;
    waId: string;
    profileName: string | null;
    conversationId: string;
    lastMessageAt: Date;
  }): Promise<WhatsAppContactRecord>;
  findMessageLogByWamid(wamid: string): Promise<WhatsAppMessageLogRecord | null>;
  createMessageLog(input: {
    wamid: string;
    direction: "inbound" | "outbound";
    workspaceId: string;
    waId: string;
    messageType: string;
    payload: Record<string, unknown>;
    status: WhatsAppMessageLogStatus;
    errorDetails?: string | null;
  }): Promise<WhatsAppMessageLogRecord>;
  createInboundMessageLog(input: {
    wamid: string;
    workspaceId: string;
    waId: string;
    messageType: string;
    payload: Record<string, unknown>;
  }): Promise<WhatsAppMessageLogRecord | null>;
  findPendingOutboundReply(input: {
    workspaceId: string;
    waId: string;
    inboundWamids: string[];
  }): Promise<WhatsAppMessageLogRecord | null>;
  findDeliveredOutboundReply(input: {
    workspaceId: string;
    waId: string;
    inboundWamids: string[];
  }): Promise<WhatsAppMessageLogRecord | null>;
  markOutboundReplyDelivered(input: {
    outboundWamid: string;
    inboundWamids: string[];
  }): Promise<void>;
  updateMessageLogStatus(
    wamid: string,
    status: WhatsAppMessageLogStatus,
    errorDetails?: string | null,
  ): Promise<void>;
  /**
   * Keeps, with an inbound photo message, the receipt of the photo the host stored for it, so a
   * retry of the message reuses the photo. The message log survives a restart, so a recovered
   * message finds it too. A no-op for a message the log does not hold.
   */
  savePhotoReceipt(wamid: string, receipt: string): Promise<void>;
  /**
   * Marks a cards reply's outbound row as fallen back to its numbered list, once: true for the
   * call that marked it, false when it already was, or the log holds no such outbound row.
   */
  claimCardsFallback(outboundWamid: string): Promise<boolean>;
  /** Lets go of a claim whose numbered list never reached Graph, so the reply's retry can claim it again. */
  releaseCardsFallback(outboundWamid: string): Promise<void>;
  /** The newest reply the connector wrote to a number, whatever its status; null when it wrote none. */
  findLatestOutboundReply(input: { workspaceId: string; waId: string }): Promise<WhatsAppMessageLogRecord | null>;
  listRecoverableInboundLogs(): Promise<WhatsAppMessageLogRecord[]>;
  nextLocalOutboundWamid(): string;
}

/** The key of an inbound row's payload under which Radioso keeps what it learned about the message. */
const RADIOSO_STATE_KEY = "radioso";
const PHOTO_RECEIPT_KEY = "photoReceipt";
const CARDS_FALLBACK_KEY = "cardsFallback";

/** The receipt a previous attempt kept for this inbound message's photo, if any. */
export const photoReceiptOf = (log: WhatsAppMessageLogRecord | null): string | null => {
  const state = log?.payload[RADIOSO_STATE_KEY];
  if (!state || typeof state !== "object") {
    return null;
  }
  const receipt = (state as Record<string, unknown>)[PHOTO_RECEIPT_KEY];
  return typeof receipt === "string" && receipt.length > 0 ? receipt : null;
};

interface WhatsAppContactRow {
  id: string;
  wa_id: string;
  profile_name: string | null;
  workspace_id: string;
  conversation_id: string;
  first_seen_at: Date;
  last_message_at: Date;
}

interface WhatsAppMessageLogRow {
  id: string;
  wamid: string;
  direction: "inbound" | "outbound";
  workspace_id: string;
  wa_id: string;
  message_type: string;
  payload: Record<string, unknown>;
  status: WhatsAppMessageLogStatus;
  error_details: string | null;
  created_at: Date;
}

const contactColumns = [
  "id",
  "wa_id",
  "profile_name",
  "workspace_id",
  "conversation_id",
  "first_seen_at",
  "last_message_at",
] as const;

const messageLogColumns = [
  "id",
  "wamid",
  "direction",
  "workspace_id",
  "wa_id",
  "message_type",
  "payload",
  "status",
  "error_details",
  "created_at",
] as const;

const mapContact = (row: WhatsAppContactRow): WhatsAppContactRecord => ({
  id: row.id,
  waId: row.wa_id,
  profileName: row.profile_name,
  workspaceId: row.workspace_id,
  conversationId: row.conversation_id,
  firstSeenAt: new Date(row.first_seen_at),
  lastMessageAt: new Date(row.last_message_at),
});

const mapMessageLog = (row: WhatsAppMessageLogRow): WhatsAppMessageLogRecord => ({
  id: row.id,
  wamid: row.wamid,
  direction: row.direction,
  workspaceId: row.workspace_id,
  waId: row.wa_id,
  messageType: row.message_type,
  payload: row.payload,
  status: row.status,
  errorDetails: row.error_details,
  createdAt: new Date(row.created_at),
});

export class PostgresWhatsAppPersistence implements WhatsAppPersistencePort {
  constructor(private readonly db: Db) {}

  async findContact(workspaceId: string, waId: string): Promise<WhatsAppContactRecord | null> {
    const row = await this.db
      .selectFrom("connector_whatsapp_contacts")
      .select(contactColumns)
      .where("workspace_id", "=", workspaceId)
      .where("wa_id", "=", waId)
      .executeTakeFirst();

    return row ? mapContact(row) : null;
  }

  async upsertContact(input: {
    workspaceId: string;
    waId: string;
    profileName: string | null;
    conversationId: string;
    lastMessageAt: Date;
  }): Promise<WhatsAppContactRecord> {
    const row = await this.db
      .insertInto("connector_whatsapp_contacts")
      .values({
        id: randomUUID(),
        wa_id: input.waId,
        profile_name: input.profileName,
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        last_message_at: input.lastMessageAt,
      })
      .onConflict((oc) =>
        oc.columns(["workspace_id", "wa_id"]).doUpdateSet((eb) => ({
          profile_name: eb.ref("excluded.profile_name"),
          conversation_id: eb.ref("excluded.conversation_id"),
          last_message_at: eb.ref("excluded.last_message_at"),
        })),
      )
      .returning(contactColumns)
      .executeTakeFirstOrThrow();

    return mapContact(row);
  }

  async findMessageLogByWamid(wamid: string): Promise<WhatsAppMessageLogRecord | null> {
    const row = await this.db
      .selectFrom("connector_whatsapp_message_log")
      .select(messageLogColumns)
      .where("wamid", "=", wamid)
      .executeTakeFirst();

    return row ? mapMessageLog(row as WhatsAppMessageLogRow) : null;
  }

  async createMessageLog(input: {
    wamid: string;
    direction: "inbound" | "outbound";
    workspaceId: string;
    waId: string;
    messageType: string;
    payload: Record<string, unknown>;
    status: WhatsAppMessageLogStatus;
    errorDetails?: string | null;
  }): Promise<WhatsAppMessageLogRecord> {
    const row = await this.db
      .insertInto("connector_whatsapp_message_log")
      .values({
        id: randomUUID(),
        wamid: input.wamid,
        direction: input.direction,
        workspace_id: input.workspaceId,
        wa_id: input.waId,
        message_type: input.messageType,
        payload: toJsonb(input.payload),
        status: input.status,
        error_details: input.errorDetails ?? null,
      })
      .returning(messageLogColumns)
      .executeTakeFirstOrThrow();

    return mapMessageLog(row as WhatsAppMessageLogRow);
  }

  async createInboundMessageLog(input: {
    wamid: string;
    workspaceId: string;
    waId: string;
    messageType: string;
    payload: Record<string, unknown>;
  }): Promise<WhatsAppMessageLogRecord | null> {
    const row = await this.db
      .insertInto("connector_whatsapp_message_log")
      .values({
        id: randomUUID(),
        wamid: input.wamid,
        direction: "inbound",
        workspace_id: input.workspaceId,
        wa_id: input.waId,
        message_type: input.messageType,
        payload: toJsonb(input.payload),
        status: "received",
        error_details: null,
      })
      .onConflict((oc) => oc.column("wamid").doNothing())
      .returning(messageLogColumns)
      .executeTakeFirst();

    return row ? mapMessageLog(row as WhatsAppMessageLogRow) : null;
  }

  async findPendingOutboundReply(input: {
    workspaceId: string;
    waId: string;
    inboundWamids: string[];
  }): Promise<WhatsAppMessageLogRecord | null> {
    const row = await this.db
      .selectFrom("connector_whatsapp_message_log")
      .select(messageLogColumns)
      .where("direction", "=", "outbound")
      .where("workspace_id", "=", input.workspaceId)
      .where("wa_id", "=", input.waId)
      .where("status", "in", ["processing", "retryable_failed"])
      // jsonb `->` (object) equality against the inbound-wamid set; `->>` would coerce to
      // text and is not the original semantics, so this stays a raw fragment.
      .where(sql<boolean>`payload -> 'inbound_wamids' = ${toJsonb(input.inboundWamids)}`)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapMessageLog(row as WhatsAppMessageLogRow) : null;
  }

  async findDeliveredOutboundReply(input: {
    workspaceId: string;
    waId: string;
    inboundWamids: string[];
  }): Promise<WhatsAppMessageLogRecord | null> {
    const row = await this.db
      .selectFrom("connector_whatsapp_message_log")
      .select(messageLogColumns)
      .where("direction", "=", "outbound")
      .where("workspace_id", "=", input.workspaceId)
      .where("wa_id", "=", input.waId)
      .where("status", "=", "replied")
      .where(sql<boolean>`payload -> 'inbound_wamids' = ${toJsonb(input.inboundWamids)}`)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapMessageLog(row as WhatsAppMessageLogRow) : null;
  }

  async markOutboundReplyDelivered(input: {
    outboundWamid: string;
    inboundWamids: string[];
  }): Promise<void> {
    // CTE-driven correlated UPDATE: mark the outbound row delivered, then mark every
    // inbound row in the set delivered only when the outbound row's stored
    // `inbound_wamids` matches. The data-modifying CTE + `= ANY(::varchar[])` membership
    // + jsonb object equality exceed the query builder, so this is a sanctioned raw
    // fragment.
    await sql`
      WITH delivered AS (
        UPDATE connector_whatsapp_message_log
        SET status = 'replied', error_details = NULL
        WHERE wamid = ${input.outboundWamid} AND direction = 'outbound'
        RETURNING payload
      )
      UPDATE connector_whatsapp_message_log AS inbound
      SET status = 'replied', error_details = NULL
      FROM delivered
      WHERE inbound.direction = 'inbound'
        AND inbound.wamid = ANY(${sql.val(input.inboundWamids)}::varchar[])
        AND delivered.payload -> 'inbound_wamids' = ${toJsonb(input.inboundWamids)}
    `.execute(this.db);
  }

  async updateMessageLogStatus(
    wamid: string,
    status: WhatsAppMessageLogStatus,
    errorDetails?: string | null,
  ): Promise<void> {
    await this.db
      .updateTable("connector_whatsapp_message_log")
      .set({ status, error_details: errorDetails ?? null })
      .where("wamid", "=", wamid)
      .execute();
  }

  async savePhotoReceipt(wamid: string, receipt: string): Promise<void> {
    // The inbound row's payload is its own copy of the webhook body, so what Radioso learned about
    // the message is kept under one namespaced key beside it. Merging keeps the rest of the body
    // and any other key under `radioso`; the jsonb functions are beyond the query builder.
    await sql`
      UPDATE connector_whatsapp_message_log
      SET payload = payload || jsonb_build_object(
        ${RADIOSO_STATE_KEY}::text,
        COALESCE(payload -> ${RADIOSO_STATE_KEY}::text, '{}'::jsonb) || jsonb_build_object(${PHOTO_RECEIPT_KEY}::text, ${receipt}::text)
      )
      WHERE wamid = ${wamid} AND direction = 'inbound'
    `.execute(this.db);
  }

  async claimCardsFallback(outboundWamid: string): Promise<boolean> {
    // One conditional update, so two failed statuses for the same reply mark it once. The flag
    // sits under the same namespaced key as an inbound row's photo receipt.
    const result = await sql<{ wamid: string }>`
      UPDATE connector_whatsapp_message_log
      SET payload = payload || jsonb_build_object(
        ${RADIOSO_STATE_KEY}::text,
        COALESCE(payload -> ${RADIOSO_STATE_KEY}::text, '{}'::jsonb) || jsonb_build_object(${CARDS_FALLBACK_KEY}::text, true)
      )
      WHERE wamid = ${outboundWamid}
        AND direction = 'outbound'
        AND COALESCE((payload -> ${RADIOSO_STATE_KEY}::text ->> ${CARDS_FALLBACK_KEY}::text)::boolean, false) = false
      RETURNING wamid
    `.execute(this.db);
    return result.rows.length > 0;
  }

  async releaseCardsFallback(outboundWamid: string): Promise<void> {
    await sql`
      UPDATE connector_whatsapp_message_log
      SET payload = payload || jsonb_build_object(
        ${RADIOSO_STATE_KEY}::text,
        COALESCE(payload -> ${RADIOSO_STATE_KEY}::text, '{}'::jsonb) - ${CARDS_FALLBACK_KEY}::text
      )
      WHERE wamid = ${outboundWamid} AND direction = 'outbound'
    `.execute(this.db);
  }

  async findLatestOutboundReply(input: { workspaceId: string; waId: string }): Promise<WhatsAppMessageLogRecord | null> {
    // A reply's own row names the inbound messages it answers; a sent cards message's row does not.
    const row = await this.db
      .selectFrom("connector_whatsapp_message_log")
      .select(messageLogColumns)
      .where("direction", "=", "outbound")
      .where("workspace_id", "=", input.workspaceId)
      .where("wa_id", "=", input.waId)
      .where(sql<boolean>`payload -> 'inbound_wamids' IS NOT NULL`)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapMessageLog(row as WhatsAppMessageLogRow) : null;
  }

  async listRecoverableInboundLogs(): Promise<WhatsAppMessageLogRecord[]> {
    const rows = await this.db
      .selectFrom("connector_whatsapp_message_log")
      .select(messageLogColumns)
      .where("direction", "=", "inbound")
      .where("status", "in", ["received", "processing", "retryable_failed"])
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) => mapMessageLog(row as WhatsAppMessageLogRow));
  }

  nextLocalOutboundWamid(): string {
    return `local-${randomUUID()}`;
  }
}

/**
 * Erases the WhatsApp transport log of a number whose conversation is erased: the raw inbound and
 * outbound payloads, message text included, keyed by the number rather than the conversation. The
 * number is found through its contact row, which cascades with the conversation, so this runs first.
 *
 * A number has one contact row, pointing at its latest conversation; a message after the
 * conversation timeout starts a new conversation and moves the row. The log cannot be split by
 * conversation, so erasing the number's latest conversation erases the whole log for the number,
 * earlier conversations' entries included. Erasing an earlier conversation reaches no number, and
 * its entries stay until the number's latest conversation is erased. A workspace's log cascades
 * with the workspace.
 */
export class WhatsAppMessageLogEraser implements ConversationDataEraser {
  readonly owner = "whatsapp";

  constructor(private readonly db: Db) {}

  async erase(scope: ConversationErasureScope): Promise<number> {
    if (scope.kind === "workspace" || scope.conversationIds.length === 0) {
      return 0;
    }
    const result = await this.db
      .deleteFrom("connector_whatsapp_message_log")
      .where("workspace_id", "=", scope.workspaceId)
      .where("wa_id", "in", (eb) => eb
        .selectFrom("connector_whatsapp_contacts")
        .select("wa_id")
        .where("workspace_id", "=", scope.workspaceId)
        .where((inner) => anyOf(inner.ref("conversation_id"), scope.conversationIds, "uuid[]")))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
