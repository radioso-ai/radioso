import type { Selectable } from "kysely";

import { currentTimestamp, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import { readEnum } from "./columnValues.js";

type ThreadMessageDirection = "inbound" | "outbound" | "referenced";
type ThreadMessageOrigin = "inbound" | "referenced" | "radioso_generated" | "provider_delivered";

const DIRECTIONS: readonly ThreadMessageDirection[] = ["inbound", "outbound", "referenced"];
const ORIGINS: readonly ThreadMessageOrigin[] = ["inbound", "referenced", "radioso_generated", "provider_delivered"];

export interface ThreadAttachment {
  name: string;
  contentType: string;
  sizeBytes: number;
}

export interface EmailThreadLinkRecord {
  conversationId: string;
  workspaceId: string;
  mailboxId: string;
  threadKey: string;
  /** Secret plus token. Never in an API response, a Ray projection or a log. */
  threadToken: string;
  participantAddress: string;
  latestSubject: string | null;
  latestParticipantDisplayName: string | null;
  latestCcAddresses: readonly string[];
  latestInboundAt: Date | null;
  autoSendsSinceRenewal: number;
  budgetRenewedAt: Date | null;
  reviewRevision: number;
  reviewCompletedRevision: number;
  reviewDueAt: Date | null;
  reviewPolicyVersion: number | null;
}

interface ThreadIndexEntry {
  workspaceId: string;
  mailboxId: string;
  conversationId: string;
  /** Null for a Message-Id only referenced, never seen. */
  messageId: string | null;
  direction: ThreadMessageDirection;
  origin: ThreadMessageOrigin;
  rfcMessageId: string;
  subject: string | null;
  ccAddresses: readonly string[];
  attachments: readonly ThreadAttachment[];
  inboundDeliveryId: string | null;
  /** The send intent an outbound id belongs to; absent or null for inbound and referenced ids. */
  sendIntentId?: string | null;
}

export interface ThreadIndexRecord extends ThreadIndexEntry {
  id: string;
  createdAt: Date;
}

type LinkRow = Selectable<DB["email_thread_links"]>;
type IndexRow = Selectable<DB["email_thread_messages"]>;

const isAttachment = (value: unknown): value is ThreadAttachment => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string"
    && typeof candidate.contentType === "string"
    && typeof candidate.sizeBytes === "number";
};

const readAttachments = (value: unknown): ThreadAttachment[] =>
  Array.isArray(value)
    ? value.filter(isAttachment).map((item) => ({ name: item.name, contentType: item.contentType, sizeBytes: item.sizeBytes }))
    : [];

const mapLink = (row: LinkRow): EmailThreadLinkRecord => ({
  conversationId: row.conversation_id,
  workspaceId: row.workspace_id,
  mailboxId: row.mailbox_id,
  threadKey: row.thread_key,
  threadToken: row.thread_token,
  participantAddress: row.participant_address,
  latestSubject: row.latest_subject,
  latestParticipantDisplayName: row.latest_participant_display_name,
  latestCcAddresses: row.latest_cc_addresses,
  latestInboundAt: row.latest_inbound_at,
  autoSendsSinceRenewal: row.auto_sends_since_renewal,
  budgetRenewedAt: row.budget_renewed_at,
  reviewRevision: row.review_revision,
  reviewCompletedRevision: row.review_completed_revision,
  reviewDueAt: row.review_due_at,
  reviewPolicyVersion: row.review_policy_version,
});

const mapIndex = (row: IndexRow): ThreadIndexRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  mailboxId: row.mailbox_id,
  conversationId: row.conversation_id,
  messageId: row.message_id,
  direction: readEnum(row.direction, DIRECTIONS, "email_thread_messages.direction"),
  origin: readEnum(row.origin, ORIGINS, "email_thread_messages.origin"),
  rfcMessageId: row.rfc_message_id,
  subject: row.subject,
  ccAddresses: row.cc_addresses,
  attachments: readAttachments(row.attachments),
  inboundDeliveryId: row.inbound_delivery_id,
  sendIntentId: row.send_intent_id,
  createdAt: row.created_at,
});

const changed = (result: readonly { numUpdatedRows: bigint }[]): boolean =>
  result.some((entry) => entry.numUpdatedRows > 0n);

/** Thread links (one per email conversation) and the committed Message-Id index. */
export class EmailThreadRepository {
  constructor(private readonly db: Db) {}

  /**
   * Writes the conversation's link unless it exists, and returns the stored one. Two deliveries
   * reserved to the same new conversation both index it; the first link wins (research B15 step 3).
   */
  async upsertLink(input: {
    conversationId: string;
    workspaceId: string;
    mailboxId: string;
    threadKey: string;
    threadToken: string;
    participantAddress: string;
  }): Promise<EmailThreadLinkRecord> {
    await this.db
      .insertInto("email_thread_links")
      .values({
        conversation_id: input.conversationId,
        workspace_id: input.workspaceId,
        mailbox_id: input.mailboxId,
        thread_key: input.threadKey,
        thread_token: input.threadToken,
        participant_address: input.participantAddress,
      })
      .onConflict((oc) => oc.column("conversation_id").doNothing())
      .execute();
    const row = await this.db
      .selectFrom("email_thread_links")
      .selectAll()
      .where("conversation_id", "=", input.conversationId)
      .executeTakeFirstOrThrow();
    return mapLink(row);
  }

  async findLink(conversationId: string): Promise<EmailThreadLinkRecord | null> {
    const row = await this.db
      .selectFrom("email_thread_links")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    return row ? mapLink(row) : null;
  }

  /** The token lookup, scoped to the destination mailbox (FR-010). */
  async findLinkByThreadToken(mailboxId: string, threadToken: string): Promise<EmailThreadLinkRecord | null> {
    const row = await this.db
      .selectFrom("email_thread_links")
      .selectAll()
      .where("mailbox_id", "=", mailboxId)
      .where("thread_token", "=", threadToken)
      .executeTakeFirst();
    return row ? mapLink(row) : null;
  }

  /** The participant of each linked conversation, for the participant-mismatch rule. */
  async participantsOf(conversationIds: readonly string[]): Promise<Map<string, string>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("email_thread_links")
      .select(["conversation_id", "participant_address"])
      .where("conversation_id", "in", [...conversationIds])
      .execute();
    return new Map(rows.map((row) => [row.conversation_id, row.participant_address]));
  }

  /** Moves the inbox header projection forward; an older message processed late leaves it alone. */
  async recordLatestInbound(
    conversationId: string,
    input: { subject: string | null; participantDisplayName: string | null; ccAddresses: readonly string[]; inboundAt: Date },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("email_thread_links")
      .set({
        latest_subject: input.subject,
        latest_participant_display_name: input.participantDisplayName,
        latest_cc_addresses: [...input.ccAddresses],
        latest_inbound_at: input.inboundAt,
        updated_at: currentTimestamp(),
      })
      .where("conversation_id", "=", conversationId)
      .where((eb) => eb.or([eb("latest_inbound_at", "is", null), eb("latest_inbound_at", "<=", input.inboundAt)]))
      .execute();
    return changed(result);
  }

  /**
   * Restarts the thread's automatic-send budget: an operator-authorized send renews it when its
   * intent materializes (research B8). Customer input never does.
   */
  async renewSendBudget(conversationId: string): Promise<boolean> {
    const result = await this.db
      .updateTable("email_thread_links")
      .set({ auto_sends_since_renewal: 0, budget_renewed_at: currentTimestamp(), updated_at: currentTimestamp() })
      .where("conversation_id", "=", conversationId)
      .execute();
    return changed(result);
  }

  /**
   * The newest customer message's Message-Id and the `References` it carried, which an outbound
   * reply threads under (RFC 5322 §3.6.4). Null before any inbound message is indexed.
   */
  async findLatestInboundThreading(conversationId: string): Promise<{ rfcMessageId: string; referenceIds: string[] } | null> {
    const row = await this.db
      .selectFrom("email_thread_messages as indexed")
      .leftJoin("email_inbound_deliveries as delivery", "delivery.id", "indexed.inbound_delivery_id")
      .select(["indexed.rfc_message_id as rfcMessageId", "delivery.reference_ids as referenceIds"])
      .where("indexed.conversation_id", "=", conversationId)
      .where("indexed.direction", "=", "inbound")
      .orderBy("indexed.created_at", "desc")
      .orderBy("indexed.id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? { rfcMessageId: row.rfcMessageId, referenceIds: row.referenceIds ?? [] } : null;
  }

  /** Inserts index rows; a Message-Id the mailbox already indexed is skipped. Returns the count written. */
  async insertIndexEntries(entries: readonly ThreadIndexEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const rows = await this.db
      .insertInto("email_thread_messages")
      .values(entries.map((entry) => ({
        workspace_id: entry.workspaceId,
        mailbox_id: entry.mailboxId,
        conversation_id: entry.conversationId,
        message_id: entry.messageId,
        direction: entry.direction,
        origin: entry.origin,
        rfc_message_id: entry.rfcMessageId,
        subject: entry.subject,
        cc_addresses: [...entry.ccAddresses],
        attachments: toJsonb(entry.attachments),
        inbound_delivery_id: entry.inboundDeliveryId,
        send_intent_id: entry.sendIntentId ?? null,
      })))
      .onConflict((oc) => oc.columns(["mailbox_id", "rfc_message_id"]).doNothing())
      .returning("id")
      .execute();
    return rows.length;
  }

  /** Forward lookup in the committed index, scoped to the mailbox. */
  async findIndexedConversations(
    mailboxId: string,
    rfcMessageIds: readonly string[],
  ): Promise<{ rfcMessageId: string; conversationId: string }[]> {
    if (rfcMessageIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("email_thread_messages")
      .select(["rfc_message_id", "conversation_id"])
      .where("mailbox_id", "=", mailboxId)
      .where("rfc_message_id", "in", [...rfcMessageIds])
      .execute();
    return rows.map((row) => ({ rfcMessageId: row.rfc_message_id, conversationId: row.conversation_id }));
  }

  /** Which of `rfcMessageIds` the mailbox sent: outbound index entries, for bounce classification. */
  async findOutboundMessageIds(mailboxId: string, rfcMessageIds: readonly string[]): Promise<Set<string>> {
    if (rfcMessageIds.length === 0) return new Set();
    const rows = await this.db
      .selectFrom("email_thread_messages")
      .select("rfc_message_id")
      .where("mailbox_id", "=", mailboxId)
      .where("direction", "=", "outbound")
      .where("rfc_message_id", "in", [...rfcMessageIds])
      .execute();
    return new Set(rows.map((row) => row.rfc_message_id));
  }

  /** A conversation's indexed messages, oldest first. */
  async listIndexedMessages(conversationId: string): Promise<ThreadIndexRecord[]> {
    const rows = await this.db
      .selectFrom("email_thread_messages")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(mapIndex);
  }

  /**
   * Schedules a review (research B17): bumps the revision, keeps an earlier due time so a burst
   * of mail coalesces, and binds the accepted policy version of the newest delivery.
   */
  async scheduleReview(
    conversationId: string,
    input: { dueAt: Date; policyVersion: number },
  ): Promise<{ revision: number; dueAt: Date } | null> {
    const row = await this.db
      .updateTable("email_thread_links")
      .set((eb) => ({
        review_revision: eb("review_revision", "+", 1),
        review_due_at: eb.fn.coalesce("review_due_at", eb.val(input.dueAt)),
        review_policy_version: input.policyVersion,
        updated_at: currentTimestamp(),
      }))
      .where("conversation_id", "=", conversationId)
      .returning(["review_revision", "review_due_at"])
      .executeTakeFirst();
    return row?.review_due_at ? { revision: row.review_revision, dueAt: row.review_due_at } : null;
  }

  /**
   * Completes revision `revision` only: a worker overtaken by newer mail never clears the newer
   * due time (research B17).
   */
  async completeReview(conversationId: string, revision: number): Promise<boolean> {
    const result = await this.db
      .updateTable("email_thread_links")
      .set({
        review_due_at: null,
        review_lease_until: null,
        review_completed_revision: revision,
        updated_at: currentTimestamp(),
      })
      .where("conversation_id", "=", conversationId)
      .where("review_revision", "=", revision)
      .execute();
    return changed(result);
  }
}
