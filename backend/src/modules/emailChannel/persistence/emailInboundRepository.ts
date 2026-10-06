import type { ExpressionBuilder, Selectable } from "kysely";

import { currentTimestamp, nowPlusSeconds, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import { readEnum, readOptionalEnum } from "./columnValues.js";

type InboundEventKind = "message_received" | "delivery_status" | "domain_status" | "unsupported";
type InboundEventState = "pending" | "processing" | "processed" | "failed" | "ignored";
export type DeliveryState = "pending" | "fetched" | "resolved" | "ingested" | "done" | "failed";
type RouteRule = "relay" | "direct";
type Classification = "person" | "automated_sender" | "bounce" | "self_sender" | "spam";
export type Disposition = "ingest_only" | "run_review_turn" | "drop";
type DispositionReason =
  | "no_mailbox"
  | "mailbox_disabled"
  | "automated_sender"
  | "self_sender"
  | "bounce"
  | "spam"
  | "participant_mismatch"
  | "operator_only_mailbox"
  | "human_owned"
  | "generation_budget"
  | "no_agent"
  | "accepted";
type SpamVerdict = "spam" | "not_spam" | "unknown";
type StripConfidence = "confident" | "full_text";
type ThreadMatch = "in_reply_to" | "references" | "reverse_reference" | "thread_token" | "new_thread";

const EVENT_KINDS: readonly InboundEventKind[] = ["message_received", "delivery_status", "domain_status", "unsupported"];
const EVENT_STATES: readonly InboundEventState[] = ["pending", "processing", "processed", "failed", "ignored"];
const DELIVERY_STATES: readonly DeliveryState[] = ["pending", "fetched", "resolved", "ingested", "done", "failed"];
const ROUTE_RULES: readonly RouteRule[] = ["relay", "direct"];
const CLASSIFICATIONS: readonly Classification[] = ["person", "automated_sender", "bounce", "self_sender", "spam"];
const DISPOSITIONS: readonly Disposition[] = ["ingest_only", "run_review_turn", "drop"];
const DISPOSITION_REASONS: readonly DispositionReason[] = [
  "no_mailbox",
  "mailbox_disabled",
  "automated_sender",
  "self_sender",
  "bounce",
  "spam",
  "participant_mismatch",
  "operator_only_mailbox",
  "human_owned",
  "generation_budget",
  "no_agent",
  "accepted",
];
const SPAM_VERDICTS: readonly SpamVerdict[] = ["spam", "not_spam", "unknown"];
const THREAD_MATCHES: readonly ThreadMatch[] = ["in_reply_to", "references", "reverse_reference", "thread_token", "new_thread"];

/** Deliveries whose thread decision is persisted: the reservation log of research B15. */
const RESERVED_STATES: readonly DeliveryState[] = ["resolved", "ingested", "done"];
/** Deliveries a step can still advance; retention keeps them, and only they can fail. */
const UNFINISHED_STATES: readonly DeliveryState[] = ["pending", "fetched", "resolved", "ingested"];
/** Events a worker holds or will claim again; retention keeps their deliveries. */
const UNSETTLED_EVENT_STATES: readonly InboundEventState[] = ["pending", "processing"];

export interface InboundEventRecord {
  id: string;
  provider: string;
  providerEventId: string;
  eventKind: InboundEventKind;
  providerObjectId: string | null;
  /** Verified webhook metadata: customer content, never logged. */
  envelope: unknown;
  state: InboundEventState;
  /** Incremented by every claim; a worker's writes are fenced on the value its claim returned. */
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  lastErrorCode: string | null;
  /** Webhook acceptance: the moment whose mailbox policy governs the mail (research B16). */
  receivedAt: Date;
  processedAt: Date | null;
}

export interface InboundDeliveryRecord {
  id: string;
  inboundEventId: string;
  workspaceId: string | null;
  mailboxId: string | null;
  routeRule: RouteRule | null;
  acceptedPolicyVersion: number | null;
  state: DeliveryState;
  classification: Classification | null;
  disposition: Disposition | null;
  dispositionReason: DispositionReason | null;
  senderAddress: string | null;
  senderDisplayName: string | null;
  subject: string | null;
  rfcMessageId: string | null;
  referenceIds: readonly string[];
  ccAddresses: readonly string[];
  receivedFor: readonly string[];
  threadMatch: ThreadMatch | null;
  threadConflict: boolean;
  plannedConversationId: string | null;
  plannedMessageId: string | null;
  plannedThreadKey: string | null;
  /** Secret plus token for a new thread. Never logged. */
  plannedThreadToken: string | null;
  conversationId: string | null;
  messageId: string | null;
  lastErrorCode: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

/**
 * The event claim a delivery write is made under (research B15): the delivery, and the `attempts`
 * its event's claim returned. Each step's write lands only while that claim still holds the event,
 * so a worker whose lease was reclaimed writes nothing and stops.
 */
interface DeliveryClaim {
  deliveryId: string;
  attempt: number;
}

interface InsertInboundEventInput {
  provider: string;
  providerEventId: string;
  eventKind: InboundEventKind;
  providerObjectId: string | null;
  envelope: unknown;
}

interface InsertDeliveryInput {
  inboundEventId: string;
  workspaceId: string | null;
  mailboxId: string | null;
  routeRule: RouteRule | null;
  acceptedPolicyVersion: number | null;
  /** A delivery settled at routing (no mailbox, mailbox disabled) is written `done` with its reason. */
  settled?: { disposition: Disposition; dispositionReason: DispositionReason };
}

/** What stage 1 learned from the fetched message. Content columns are customer data. */
interface FetchedDeliveryContent {
  classification: Classification;
  senderAddress: string | null;
  senderDisplayName: string | null;
  subject: string | null;
  rfcMessageId: string | null;
  referenceIds: readonly string[];
  ccAddresses: readonly string[];
  receivedFor: readonly string[];
  authResults: { spf: string; dkim: string; dmarc: string };
  spamVerdict: SpamVerdict;
  attachments: readonly { name: string; contentType: string; sizeBytes: number }[];
  bodyText: string | null;
  stripConfidence: StripConfidence | null;
  rawMime: Buffer | null;
  rawSizeBytes: number | null;
  rawTruncated: boolean;
}

/** The thread decision and the ids ingest will create or join (research B15 step 1). */
interface ThreadReservation {
  threadMatch: ThreadMatch;
  threadConflict: boolean;
  disposition: Disposition;
  dispositionReason: DispositionReason;
  plannedConversationId: string;
  plannedMessageId: string;
  plannedThreadKey: string | null;
  plannedThreadToken: string | null;
}

interface ReservationMatch {
  deliveryId: string;
  conversationId: string;
  state: DeliveryState;
}

/** The identity an in-flight reservation gave its conversation: what ingest and the link will carry. */
interface ReservedThread {
  threadKey: string;
  /** Secret plus token. Never logged. */
  threadToken: string;
  participantAddress: string;
}

/** A drop decided at thread resolution (research B15 step 1); it reserves nothing. */
interface DroppedDelivery {
  threadMatch: ThreadMatch | null;
  threadConflict: boolean;
  dispositionReason: DispositionReason;
}

export interface EventLogEntry {
  id: string;
  createdAt: Date;
  state: DeliveryState;
  classification: Classification | null;
  disposition: Disposition | null;
  dispositionReason: DispositionReason | null;
  senderAddress: string | null;
  senderDisplayName: string | null;
  subject: string | null;
  authResults: unknown;
  spamVerdict: SpamVerdict;
  conversationId: string | null;
  threadConflict: boolean;
  hasRaw: boolean;
  /** Null for mail the workspace accepted for an address no mailbox has. */
  mailboxId: string | null;
}

interface EventLogPageQuery {
  cursor: string | null;
  limit: number;
  disposition: Disposition | null;
  states: readonly DeliveryState[] | null;
}

interface EventLogPage {
  entries: EventLogEntry[];
  nextCursor: string | null;
}

interface MailboxEventCounts {
  byDisposition: Record<string, number>;
  failed: number;
}

type EventRow = Selectable<DB["email_inbound_events"]>;
type DeliveryRow = Omit<Selectable<DB["email_inbound_deliveries"]>, "raw_mime" | "body_text" | "auth_results" | "attachments">;

const deliveryColumns = [
  "id",
  "inbound_event_id",
  "workspace_id",
  "mailbox_id",
  "route_rule",
  "accepted_policy_version",
  "state",
  "classification",
  "disposition",
  "disposition_reason",
  "sender_address",
  "sender_display_name",
  "subject",
  "rfc_message_id",
  "reference_ids",
  "cc_addresses",
  "received_for",
  "spam_verdict",
  "strip_confidence",
  "raw_size_bytes",
  "raw_truncated",
  "thread_match",
  "thread_conflict",
  "planned_conversation_id",
  "planned_message_id",
  "planned_thread_key",
  "planned_thread_token",
  "conversation_id",
  "message_id",
  "last_error_code",
  "created_at",
  "processed_at",
] as const;

const mapEvent = (row: EventRow): InboundEventRecord => ({
  id: row.id,
  provider: row.provider,
  providerEventId: row.provider_event_id,
  eventKind: readEnum(row.event_kind, EVENT_KINDS, "email_inbound_events.event_kind"),
  providerObjectId: row.provider_object_id,
  envelope: row.envelope,
  state: readEnum(row.state, EVENT_STATES, "email_inbound_events.state"),
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  leaseUntil: row.lease_until,
  lastErrorCode: row.last_error_code,
  receivedAt: row.received_at,
  processedAt: row.processed_at,
});

const mapDelivery = (row: DeliveryRow): InboundDeliveryRecord => ({
  id: row.id,
  inboundEventId: row.inbound_event_id,
  workspaceId: row.workspace_id,
  mailboxId: row.mailbox_id,
  routeRule: readOptionalEnum(row.route_rule, ROUTE_RULES, "email_inbound_deliveries.route_rule"),
  acceptedPolicyVersion: row.accepted_policy_version,
  state: readEnum(row.state, DELIVERY_STATES, "email_inbound_deliveries.state"),
  classification: readOptionalEnum(row.classification, CLASSIFICATIONS, "email_inbound_deliveries.classification"),
  disposition: readOptionalEnum(row.disposition, DISPOSITIONS, "email_inbound_deliveries.disposition"),
  dispositionReason: readOptionalEnum(row.disposition_reason, DISPOSITION_REASONS, "email_inbound_deliveries.disposition_reason"),
  senderAddress: row.sender_address,
  senderDisplayName: row.sender_display_name,
  subject: row.subject,
  rfcMessageId: row.rfc_message_id,
  referenceIds: row.reference_ids,
  ccAddresses: row.cc_addresses,
  receivedFor: row.received_for,
  threadMatch: readOptionalEnum(row.thread_match, THREAD_MATCHES, "email_inbound_deliveries.thread_match"),
  threadConflict: row.thread_conflict,
  plannedConversationId: row.planned_conversation_id,
  plannedMessageId: row.planned_message_id,
  plannedThreadKey: row.planned_thread_key,
  plannedThreadToken: row.planned_thread_token,
  conversationId: row.conversation_id,
  messageId: row.message_id,
  lastErrorCode: row.last_error_code,
  createdAt: row.created_at,
  processedAt: row.processed_at,
});

const changed = (result: readonly { numUpdatedRows: bigint }[]): boolean =>
  result.some((entry) => entry.numUpdatedRows > 0n);

/**
 * The fence on a delivery step's write: the delivery's event is still `processing` under the claim
 * that made `attempt`. The event row is share-locked, so a concurrent reclaim waits for this write
 * to commit, and a reclaim that committed first is seen.
 */
const heldByClaim = (attempt: number) => (eb: ExpressionBuilder<DB, "email_inbound_deliveries">) =>
  eb.exists(
    eb
      .selectFrom("email_inbound_events as claim")
      .select("claim.id")
      .whereRef("claim.id", "=", "email_inbound_deliveries.inbound_event_id")
      .where("claim.attempts", "=", attempt)
      .where("claim.state", "=", "processing")
      .forShare(),
  );

interface LogEntryRow {
  id: string;
  created_at: Date;
  state: string;
  classification: string | null;
  disposition: string | null;
  disposition_reason: string | null;
  sender_address: string | null;
  sender_display_name: string | null;
  subject: string | null;
  auth_results: unknown;
  spam_verdict: string;
  conversation_id: string | null;
  thread_conflict: boolean;
  has_raw: unknown;
  mailbox_id: string | null;
}

const toLogEntry = (row: LogEntryRow): EventLogEntry => ({
  id: row.id,
  createdAt: row.created_at,
  state: readEnum(row.state, DELIVERY_STATES, "email_inbound_deliveries.state"),
  classification: readOptionalEnum(row.classification, CLASSIFICATIONS, "email_inbound_deliveries.classification"),
  disposition: readOptionalEnum(row.disposition, DISPOSITIONS, "email_inbound_deliveries.disposition"),
  dispositionReason: readOptionalEnum(row.disposition_reason, DISPOSITION_REASONS, "email_inbound_deliveries.disposition_reason"),
  senderAddress: row.sender_address,
  senderDisplayName: row.sender_display_name,
  subject: row.subject,
  authResults: row.auth_results,
  spamVerdict: readEnum(row.spam_verdict, SPAM_VERDICTS, "email_inbound_deliveries.spam_verdict"),
  conversationId: row.conversation_id,
  threadConflict: row.thread_conflict,
  hasRaw: row.has_raw === true,
  mailboxId: row.mailbox_id,
});

/**
 * Inbound provider events (the processing obligation the webhook leaves) and their per-mailbox
 * deliveries (the event log, the content holder and the thread-reservation log).
 */
export class EmailInboundRepository {
  constructor(private readonly db: Db) {}

  /**
   * Persists a verified webhook delivery. A second delivery of the same provider event, or a new
   * event announcing an already-received message, is a duplicate and writes nothing.
   */
  async insertEvent(input: InsertInboundEventInput): Promise<{ eventId: string; duplicate: boolean }> {
    const inserted = await this.db
      .insertInto("email_inbound_events")
      .values({
        provider: input.provider,
        provider_event_id: input.providerEventId,
        event_kind: input.eventKind,
        provider_object_id: input.providerObjectId,
        envelope: toJsonb(input.envelope),
      })
      .onConflict((oc) => oc.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted) return { eventId: inserted.id, duplicate: false };

    const existing = await this.db
      .selectFrom("email_inbound_events")
      .select("id")
      .where("provider", "=", input.provider)
      .where((eb) => {
        const sameEvent = eb("provider_event_id", "=", input.providerEventId);
        return input.eventKind === "message_received" && input.providerObjectId !== null
          ? eb.or([
              sameEvent,
              eb.and([eb("event_kind", "=", "message_received"), eb("provider_object_id", "=", input.providerObjectId)]),
            ])
          : sameEvent;
      })
      .executeTakeFirstOrThrow();
    return { eventId: existing.id, duplicate: true };
  }

  /**
   * Claims up to `limit` due events in one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
   * LOCKED)`, so concurrent drains never claim the same row. A `processing` event whose lease ran
   * out is reclaimed, so a crashed worker's event is retried rather than stranded.
   */
  async claimDueEvents(input: { limit: number; leaseSeconds: number }): Promise<InboundEventRecord[]> {
    const rows = await this.db
      .updateTable("email_inbound_events")
      .set((eb) => ({
        state: "processing",
        attempts: eb("attempts", "+", 1),
        lease_until: nowPlusSeconds(input.leaseSeconds),
      }))
      .where("id", "in", (eb) =>
        eb
          .selectFrom("email_inbound_events")
          .select("id")
          .where((due) =>
            due.or([
              due.and([due("state", "=", "pending"), due("next_attempt_at", "<=", currentTimestamp())]),
              due.and([due("state", "=", "processing"), due("lease_until", "<", currentTimestamp())]),
            ]),
          )
          .orderBy("next_attempt_at", "asc")
          .limit(input.limit)
          .forUpdate()
          .skipLocked(),
      )
      .returningAll()
      .execute();
    return rows.map(mapEvent);
  }

  /**
   * Lease recovery for the sweep: returns `processing` events whose lease ran out to `pending`, due
   * now, so a worker that died mid-event leaves nothing stranded. The dead worker's late writes are
   * fenced out, because its settle requires `processing`.
   */
  async releaseExpiredLeases(limit: number): Promise<number> {
    const rows = await this.db
      .updateTable("email_inbound_events")
      .set({ state: "pending", lease_until: null, next_attempt_at: currentTimestamp() })
      .where("id", "in", (eb) =>
        eb
          .selectFrom("email_inbound_events")
          .select("id")
          .where("state", "=", "processing")
          .where("lease_until", "<", currentTimestamp())
          .orderBy("lease_until", "asc")
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .returning("id")
      .execute();
    return rows.length;
  }

  /** Settles this claim only: a worker whose lease was reclaimed (higher `attempts`) writes nothing. */
  async settleEvent(
    eventId: string,
    input: { attempt: number; state: "processed" | "ignored" | "failed"; errorCode: string | null },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("email_inbound_events")
      .set({ state: input.state, last_error_code: input.errorCode, lease_until: null, processed_at: currentTimestamp() })
      .where("id", "=", eventId)
      .where("attempts", "=", input.attempt)
      .where("state", "=", "processing")
      .execute();
    return changed(result);
  }

  /** Returns this claim to `pending`, due again at `nextAttemptAt`. */
  async retryEventLater(eventId: string, input: { attempt: number; nextAttemptAt: Date; errorCode: string }): Promise<boolean> {
    const result = await this.db
      .updateTable("email_inbound_events")
      .set({ state: "pending", next_attempt_at: input.nextAttemptAt, last_error_code: input.errorCode, lease_until: null })
      .where("id", "=", eventId)
      .where("attempts", "=", input.attempt)
      .where("state", "=", "processing")
      .execute();
    return changed(result);
  }

  /** One delivery per event and mailbox; a retried stage 1 finds the one it wrote before. */
  async insertDelivery(input: InsertDeliveryInput): Promise<{ deliveryId: string; duplicate: boolean }> {
    const inserted = await this.db
      .insertInto("email_inbound_deliveries")
      .values({
        inbound_event_id: input.inboundEventId,
        workspace_id: input.workspaceId,
        mailbox_id: input.mailboxId,
        route_rule: input.routeRule,
        accepted_policy_version: input.acceptedPolicyVersion,
        ...(input.settled
          ? {
              state: "done",
              disposition: input.settled.disposition,
              disposition_reason: input.settled.dispositionReason,
              processed_at: currentTimestamp(),
            }
          : {}),
      })
      .onConflict((oc) => oc.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted) return { deliveryId: inserted.id, duplicate: false };

    const existing = await this.db
      .selectFrom("email_inbound_deliveries")
      .select("id")
      .where("inbound_event_id", "=", input.inboundEventId)
      .where((eb) => (input.mailboxId === null ? eb("mailbox_id", "is", null) : eb("mailbox_id", "=", input.mailboxId)))
      .executeTakeFirstOrThrow();
    return { deliveryId: existing.id, duplicate: true };
  }

  async listEventDeliveries(inboundEventId: string): Promise<InboundDeliveryRecord[]> {
    const rows = await this.db
      .selectFrom("email_inbound_deliveries")
      .select(deliveryColumns)
      .where("inbound_event_id", "=", inboundEventId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(mapDelivery);
  }

  /** `pending` → `fetched` under `claim`, with the normalized content and its classification. */
  async recordFetched(claim: DeliveryClaim, content: FetchedDeliveryContent): Promise<boolean> {
    const result = await this.db
      .updateTable("email_inbound_deliveries")
      .set({
        state: "fetched",
        classification: content.classification,
        sender_address: content.senderAddress,
        sender_display_name: content.senderDisplayName,
        subject: content.subject,
        rfc_message_id: content.rfcMessageId,
        reference_ids: [...content.referenceIds],
        cc_addresses: [...content.ccAddresses],
        received_for: [...content.receivedFor],
        auth_results: toJsonb(content.authResults),
        spam_verdict: content.spamVerdict,
        attachments: toJsonb(content.attachments),
        body_text: content.bodyText,
        strip_confidence: content.stripConfidence,
        raw_mime: content.rawMime,
        raw_size_bytes: content.rawSizeBytes,
        raw_truncated: content.rawTruncated,
      })
      .where("id", "=", claim.deliveryId)
      .where("state", "=", "pending")
      .where(heldByClaim(claim.attempt))
      .execute();
    return changed(result);
  }

  /**
   * `fetched` → `resolved` under `claim`: persists the thread decision and the planned ids, so a
   * crash resumes at ingest with the same ids. Run under the thread-resolution lock (research B15 step 1).
   */
  async reserveThread(claim: DeliveryClaim, reservation: ThreadReservation): Promise<boolean> {
    const result = await this.db
      .updateTable("email_inbound_deliveries")
      .set({
        state: "resolved",
        thread_match: reservation.threadMatch,
        thread_conflict: reservation.threadConflict,
        disposition: reservation.disposition,
        disposition_reason: reservation.dispositionReason,
        planned_conversation_id: reservation.plannedConversationId,
        planned_message_id: reservation.plannedMessageId,
        planned_thread_key: reservation.plannedThreadKey,
        planned_thread_token: reservation.plannedThreadToken,
      })
      .where("id", "=", claim.deliveryId)
      .where("state", "=", "fetched")
      .where(heldByClaim(claim.attempt))
      .execute();
    return changed(result);
  }

  /**
   * Forward lookup among the mailbox's reserved deliveries: those carrying one of `rfcMessageIds`
   * as their own Message-Id, with the conversation they reserved or joined.
   */
  async findForwardReservations(
    mailboxId: string,
    rfcMessageIds: readonly string[],
  ): Promise<(ReservationMatch & { rfcMessageId: string })[]> {
    if (rfcMessageIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("email_inbound_deliveries")
      .select(["id", "rfc_message_id", "state", "conversation_id", "planned_conversation_id"])
      .where("mailbox_id", "=", mailboxId)
      .where("state", "in", RESERVED_STATES)
      .where("rfc_message_id", "in", [...rfcMessageIds])
      .orderBy("created_at", "asc")
      .execute();
    return rows.flatMap((row) => {
      const conversationId = row.conversation_id ?? row.planned_conversation_id;
      return conversationId && row.rfc_message_id
        ? [{
            deliveryId: row.id,
            rfcMessageId: row.rfc_message_id,
            conversationId,
            state: readEnum(row.state, DELIVERY_STATES, "email_inbound_deliveries.state"),
          }]
        : [];
    });
  }

  /**
   * Reverse lookup (GIN on `reference_ids`): the mailbox's reserved deliveries that reference
   * `rfcMessageId`, which finds a follow-up processed before its parent.
   */
  async findReverseReferences(mailboxId: string, rfcMessageId: string): Promise<ReservationMatch[]> {
    const rows = await this.db
      .selectFrom("email_inbound_deliveries")
      .select(["id", "state", "conversation_id", "planned_conversation_id"])
      .where("mailbox_id", "=", mailboxId)
      .where("state", "in", RESERVED_STATES)
      .where((eb) => eb("reference_ids", "@>", eb.val([rfcMessageId])))
      .orderBy("created_at", "asc")
      .execute();
    return rows.flatMap((row) => {
      const conversationId = row.conversation_id ?? row.planned_conversation_id;
      return conversationId
        ? [{ deliveryId: row.id, conversationId, state: readEnum(row.state, DELIVERY_STATES, "email_inbound_deliveries.state") }]
        : [];
    });
  }

  /**
   * The identity each of `conversationIds` was reserved with by the mailbox's earliest in-flight or
   * done delivery, for a thread whose link may not exist yet. Run under the thread-resolution lock.
   */
  async findReservedThreads(mailboxId: string, conversationIds: readonly string[]): Promise<Map<string, ReservedThread>> {
    if (conversationIds.length === 0) return new Map();
    const ids = [...conversationIds];
    const rows = await this.db
      .selectFrom("email_inbound_deliveries")
      .select(["conversation_id", "planned_conversation_id", "planned_thread_key", "planned_thread_token", "sender_address"])
      .where("mailbox_id", "=", mailboxId)
      .where("state", "in", RESERVED_STATES)
      .where("planned_thread_key", "is not", null)
      .where("planned_thread_token", "is not", null)
      .where((eb) => eb.or([eb("conversation_id", "in", ids), eb("planned_conversation_id", "in", ids)]))
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    const threads = new Map<string, ReservedThread>();
    for (const row of rows) {
      const conversationId = row.conversation_id ?? row.planned_conversation_id;
      if (!conversationId || threads.has(conversationId) || !row.planned_thread_key || !row.planned_thread_token) continue;
      threads.set(conversationId, {
        threadKey: row.planned_thread_key,
        threadToken: row.planned_thread_token,
        participantAddress: row.sender_address ?? "",
      });
    }
    return threads;
  }

  /**
   * `fetched` → `done` under `claim` for a dropped delivery, with the thread it reached if any. A
   * drop reserves nothing, so a later message referencing this one never joins a thread through it.
   */
  async settleDropped(claim: DeliveryClaim, drop: DroppedDelivery): Promise<boolean> {
    const result = await this.db
      .updateTable("email_inbound_deliveries")
      .set({
        state: "done",
        disposition: "drop",
        disposition_reason: drop.dispositionReason,
        thread_match: drop.threadMatch,
        thread_conflict: drop.threadConflict,
        processed_at: currentTimestamp(),
      })
      .where("id", "=", claim.deliveryId)
      .where("state", "=", "fetched")
      .where(heldByClaim(claim.attempt))
      .execute();
    return changed(result);
  }

  /** `resolved` → `ingested` under `claim`, once host ingest has committed the conversation and message. */
  async recordIngested(claim: DeliveryClaim, input: { conversationId: string; messageId: string }): Promise<boolean> {
    const result = await this.db
      .updateTable("email_inbound_deliveries")
      .set({ state: "ingested", conversation_id: input.conversationId, message_id: input.messageId })
      .where("id", "=", claim.deliveryId)
      .where("state", "=", "resolved")
      .where(heldByClaim(claim.attempt))
      .execute();
    return changed(result);
  }

  /**
   * `ingested` → `done` under `claim`: acquires the indexing step. Run first in the step's
   * transaction, so of two workers holding the same `ingested` snapshot only one writes the link,
   * the index and the review (research B15 step 3); the other's transaction writes nothing.
   */
  async markIndexed(claim: DeliveryClaim): Promise<boolean> {
    const result = await this.db
      .updateTable("email_inbound_deliveries")
      .set({ state: "done", last_error_code: null, processed_at: currentTimestamp() })
      .where("id", "=", claim.deliveryId)
      .where("state", "=", "ingested")
      .where(heldByClaim(claim.attempt))
      .execute();
    return changed(result);
  }

  /** An unfinished delivery → `failed` under `claim`, with a sanitized code. A settled delivery stays settled. */
  async failDelivery(claim: DeliveryClaim, errorCode: string): Promise<boolean> {
    const result = await this.db
      .updateTable("email_inbound_deliveries")
      .set({ state: "failed", last_error_code: errorCode, processed_at: currentTimestamp() })
      .where("id", "=", claim.deliveryId)
      .where("state", "in", UNFINISHED_STATES)
      .where(heldByClaim(claim.attempt))
      .execute();
    return changed(result);
  }

  /** A mailbox's event log, newest first. */
  async listMailboxLog(mailboxId: string, query: EventLogPageQuery): Promise<EventLogPage> {
    return this.pageLog({ workspaceId: null, mailboxId }, query);
  }

  /**
   * A workspace's event log, newest first: every delivery attributed to it — its mailboxes', a
   * removed mailbox's retained ones, and mail accepted for an address no mailbox has — or one
   * mailbox's when `mailboxId` is set.
   */
  async listWorkspaceLog(workspaceId: string, query: EventLogPageQuery & { mailboxId: string | null }): Promise<EventLogPage> {
    return this.pageLog({ workspaceId, mailboxId: query.mailboxId }, query);
  }

  async findDelivery(workspaceId: string, deliveryId: string): Promise<InboundDeliveryRecord | null> {
    const row = await this.db
      .selectFrom("email_inbound_deliveries")
      .select(deliveryColumns)
      .where("id", "=", deliveryId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? mapDelivery(row) : null;
  }

  /** The delivery a customer message on a conversation was ingested from; null when none was. */
  async findDeliveryIdForMessage(conversationId: string, messageId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("email_inbound_deliveries")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .where("message_id", "=", messageId)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /** One delivery of the workspace as its event log shows it; null when there is none. */
  async findLogEntry(workspaceId: string, deliveryId: string): Promise<EventLogEntry | null> {
    const row = await this.selectLogEntries()
      .where("d.id", "=", deliveryId)
      .where("d.workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? toLogEntry(row) : null;
  }

  /** The stored raw message of a workspace's delivery; `raw` is null when none was kept. */
  async readRawMessage(
    workspaceId: string,
    deliveryId: string,
  ): Promise<{ mailboxId: string | null; conversationId: string | null; raw: Buffer | null; truncated: boolean } | null> {
    const row = await this.db
      .selectFrom("email_inbound_deliveries")
      .select(["mailbox_id", "conversation_id", "raw_mime", "raw_truncated"])
      .where("id", "=", deliveryId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    if (!row) return null;
    return { mailboxId: row.mailbox_id, conversationId: row.conversation_id, raw: row.raw_mime, truncated: row.raw_truncated };
  }

  /**
   * An operator's retry of a failed delivery (FR-008): `failed` → `resumeState`, and its event back
   * to `pending`, due now, in one transaction. The event row is locked first, so no drain claims
   * it between the two writes; an event a drain is processing is refused rather than raced.
   */
  async reopenFailedDelivery(input: {
    workspaceId: string;
    deliveryId: string;
    resumeState: Exclude<DeliveryState, "done" | "failed">;
  }): Promise<"reopened" | "not_found" | "not_failed" | "in_flight"> {
    return this.inTransaction(async (trx) => {
      const delivery = await trx
        .selectFrom("email_inbound_deliveries")
        .select(["inbound_event_id", "state"])
        .where("id", "=", input.deliveryId)
        .where("workspace_id", "=", input.workspaceId)
        .executeTakeFirst();
      if (!delivery) return "not_found";
      if (delivery.state !== "failed") return "not_failed";
      const event = await trx
        .selectFrom("email_inbound_events")
        .select("state")
        .where("id", "=", delivery.inbound_event_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (event.state === "processing") return "in_flight";
      const reopened = await trx
        .updateTable("email_inbound_deliveries")
        .set({ state: input.resumeState, last_error_code: null, processed_at: null })
        .where("id", "=", input.deliveryId)
        .where("state", "=", "failed")
        .execute();
      if (!changed(reopened)) return "not_failed";
      await trx
        .updateTable("email_inbound_events")
        .set({ state: "pending", next_attempt_at: currentTimestamp(), lease_until: null, last_error_code: null, processed_at: null })
        .where("id", "=", delivery.inbound_event_id)
        .execute();
      return "reopened";
    });
  }

  /** Disposition and failure counts for the mailbox's deliveries created since `since`. */
  async countMailboxEvents(mailboxId: string, since: Date): Promise<MailboxEventCounts> {
    const rows = await this.db
      .selectFrom("email_inbound_deliveries")
      .select((eb) => [
        "disposition",
        eb.fn.countAll<string>().as("total"),
        eb.fn.countAll<string>().filterWhere("state", "=", "failed").as("failed"),
      ])
      .where("mailbox_id", "=", mailboxId)
      .where("created_at", ">=", since)
      .groupBy("disposition")
      .execute();
    const byDisposition: Record<string, number> = {};
    let failed = 0;
    for (const row of rows) {
      byDisposition[row.disposition ?? "undecided"] = Number(row.total);
      failed += Number(row.failed);
    }
    return { byDisposition, failed };
  }

  /**
   * Retention (research B10): deletes settled deliveries created before `cutoff` that never reached
   * a conversation, then the settled events left with no delivery. A delivery attached to a
   * conversation is kept; it goes when its conversation does. An unfinished delivery, or one whose
   * event is still pending or claimed, is a processing checkpoint and is never purged, however old:
   * its reserved ids are what keep a recovered retry from ingesting twice.
   */
  async purgeUnattachedBefore(cutoff: Date, limit: number): Promise<{ deliveries: number; events: number }> {
    const deliveries = await this.db
      .deleteFrom("email_inbound_deliveries")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("email_inbound_deliveries as d")
          .innerJoin("email_inbound_events as e", "e.id", "d.inbound_event_id")
          .select("d.id")
          .where("d.conversation_id", "is", null)
          .where("d.created_at", "<", cutoff)
          .where("d.state", "not in", UNFINISHED_STATES)
          .where("e.state", "not in", UNSETTLED_EVENT_STATES)
          .orderBy("d.created_at", "asc")
          .limit(limit),
      )
      .returning("id")
      .execute();
    const events = await this.db
      .deleteFrom("email_inbound_events")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("email_inbound_events as e")
          .select("e.id")
          .where("e.state", "in", ["processed", "ignored", "failed"])
          .where("e.received_at", "<", cutoff)
          .where(({ not, exists, selectFrom }) =>
            not(exists(selectFrom("email_inbound_deliveries as d").select("d.id").whereRef("d.inbound_event_id", "=", "e.id"))),
          )
          .orderBy("e.received_at", "asc")
          .limit(limit),
      )
      .returning("id")
      .execute();
    return { deliveries: deliveries.length, events: events.length };
  }
  /**
   * One page of an event log, newest first. The cursor is the last id of the previous page; its
   * position is read back from a row in the same scope, so paging keeps the column's full precision.
   */
  private async pageLog(
    scope: { workspaceId: string | null; mailboxId: string | null },
    query: EventLogPageQuery,
  ): Promise<EventLogPage> {
    let select = this.selectLogEntries();
    if (scope.workspaceId !== null) select = select.where("d.workspace_id", "=", scope.workspaceId);
    if (scope.mailboxId !== null) select = select.where("d.mailbox_id", "=", scope.mailboxId);
    if (query.disposition) select = select.where("d.disposition", "=", query.disposition);
    if (query.states) select = select.where("d.state", "in", [...query.states]);
    const cursor = query.cursor;
    if (cursor) {
      select = select.where((eb) => {
        let cursorRow = eb.selectFrom("email_inbound_deliveries as c").select("c.created_at").where("c.id", "=", cursor);
        if (scope.workspaceId !== null) cursorRow = cursorRow.where("c.workspace_id", "=", scope.workspaceId);
        if (scope.mailboxId !== null) cursorRow = cursorRow.where("c.mailbox_id", "=", scope.mailboxId);
        return eb.or([
          eb("d.created_at", "<", cursorRow),
          eb.and([eb("d.created_at", "=", cursorRow), eb("d.id", "<", cursor)]),
        ]);
      });
    }
    const rows = await select.orderBy("d.created_at", "desc").orderBy("d.id", "desc").limit(query.limit + 1).execute();
    const page = rows.slice(0, query.limit);
    return {
      entries: page.map(toLogEntry),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  private selectLogEntries() {
    return this.db
      .selectFrom("email_inbound_deliveries as d")
      .select((eb) => [
        "d.id",
        "d.created_at",
        "d.state",
        "d.classification",
        "d.disposition",
        "d.disposition_reason",
        "d.sender_address",
        "d.sender_display_name",
        "d.subject",
        "d.auth_results",
        "d.spam_verdict",
        "d.conversation_id",
        "d.thread_conflict",
        "d.mailbox_id",
        eb("d.raw_mime", "is not", null).as("has_raw"),
      ]);
  }

  private inTransaction<T>(work: (trx: Db) => Promise<T>): Promise<T> {
    return this.db.isTransaction ? work(this.db) : this.db.transaction().execute(work);
  }
}
