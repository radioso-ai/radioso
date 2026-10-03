import type { Selectable } from "kysely";
import { z } from "zod";

import { currentTimestamp, nowPlusSeconds, toJsonb, toSanitizedJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import { parseRfcMessageId, type OutboundThreadingHeaders, type RfcMessageId } from "../../mail/public.js";
import type { EngagementMode } from "../mailboxes/effectiveMode.js";
import type { SendHaltReason } from "../outbound/sendAuthority.js";
import {
  isTerminalSendIntentState,
  nextSendIntentState,
  type SendIntentEffect,
  type SendIntentEvent,
  type SendIntentSnapshot,
  type SendIntentState,
  type UncertainResolution,
} from "../outbound/sendIntentTransitions.js";
import { readEnum, readOptionalEnum } from "./columnValues.js";

type SendTrigger = "operator_reply" | "held_release" | "auto_reply" | "audited_resend";
type SendAuthorKind = "agent" | "operator";

const SEND_INTENT_STATES: readonly SendIntentState[] = ["queued", "accepted", "delivered", "bounced", "failed", "uncertain", "halted"];
const HALT_REASONS: readonly SendHaltReason[] = ["sending_not_verified", "domain_removed", "mailbox_removed"];
const UNCERTAIN_RESOLUTIONS: readonly UncertainResolution[] = ["provider_evidence", "marked_sent", "resend_authorized"];
const SEND_TRIGGERS: readonly SendTrigger[] = ["operator_reply", "held_release", "auto_reply", "audited_resend"];
const AUTHOR_KINDS: readonly SendAuthorKind[] = ["agent", "operator"];
const ENGAGEMENT_MODES = ["operator_only", "draft", "auto"] as const satisfies readonly EngagementMode[];
/** The states the reconciler may still act on; matches `email_send_intents_reconcile_due_idx`. */
const RECONCILABLE_STATES: readonly SendIntentState[] = ["queued", "accepted", "uncertain"];

/** The authority the send was enqueued under: the `email.send` payload's `authority` (ports §7a). */
interface SendAuthoritySnapshot {
  policyVersion: number;
  ownershipVersion: number;
  mode: EngagementMode;
  domainId: string;
}

/**
 * The provider request, frozen on the first attempt so that every re-POST under the idempotency
 * key is byte-identical (research A5). Customer content: never log it.
 */
interface SendRequestSnapshot {
  from: { email: string; name: string | null };
  to: string;
  replyTo: string | null;
  subject: string;
  threading: OutboundThreadingHeaders;
  /** Cleared once the intent is terminal. */
  body: { text: string; html: string | null } | null;
}

interface EmailSendIntentRecord extends SendIntentSnapshot {
  id: string;
  workspaceId: string;
  mailboxId: string;
  conversationId: string;
  messageId: string;
  heldReplyId: string | null;
  idempotencyKey: string;
  authorKind: SendAuthorKind;
  trigger: SendTrigger;
  /** The fence: every write compares and bumps it. */
  version: number;
  authority: SendAuthoritySnapshot;
  request: SendRequestSnapshot | null;
  provider: string;
  suppliedRfcMessageId: string;
  firstAttemptAt: Date | null;
  outcomeUnknownSince: Date | null;
  nextReconcileAt: Date | null;
  reconcileLeaseUntil: Date | null;
  acceptedAt: Date | null;
  settledAt: Date | null;
  complainedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MaterializeSendIntentInput {
  /** Minted by the caller, so the Message-ID derived from it is known before the insert. */
  id: string;
  workspaceId: string;
  mailboxId: string;
  conversationId: string;
  messageId: string;
  heldReplyId: string | null;
  /** The outbox key, which is also the provider's `Idempotency-Key`. */
  idempotencyKey: string;
  authorKind: SendAuthorKind;
  trigger: SendTrigger;
  authority: SendAuthoritySnapshot;
  provider: string;
  suppliedRfcMessageId: RfcMessageId;
}

/** A fenced write either lands at `expectedVersion + 1` or reports the row as it is now. */
type FencedWriteOutcome =
  | { outcome: "applied"; intent: EmailSendIntentRecord }
  | { outcome: "conflict"; current: EmailSendIntentRecord }
  | { outcome: "not_found" };

type SendIntentTransitionOutcome =
  | { outcome: "applied"; intent: EmailSendIntentRecord; effects: readonly SendIntentEffect[] }
  | { outcome: "ignored"; reason: "terminal" | "not_applicable"; intent: EmailSendIntentRecord }
  | { outcome: "conflict"; current: EmailSendIntentRecord }
  | { outcome: "not_found" };

type IntentRow = Selectable<DB["email_send_intents"]>;
type ScheduleEffect = Extract<SendIntentEffect, { kind: "schedule_reconcile" }>;

const rfcMessageIdSchema = z.string().transform((value, context): RfcMessageId => {
  const id = parseRfcMessageId(value);
  if (id === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "malformed Message-ID" });
    return z.NEVER;
  }
  return id;
});

const authoritySchema = z.object({
  policyVersion: z.number().int(),
  ownershipVersion: z.number().int(),
  mode: z.enum(ENGAGEMENT_MODES),
  domainId: z.string(),
});

const requestSchema = z.object({
  from: z.object({ email: z.string(), name: z.string().nullable() }),
  to: z.string(),
  replyTo: z.string().nullable(),
  subject: z.string(),
  threading: z.object({
    messageId: rfcMessageIdSchema,
    inReplyTo: rfcMessageIdSchema.nullable(),
    references: z.array(rfcMessageIdSchema),
    autoSubmitted: z.literal("auto-generated").nullable(),
  }),
  body: z.object({ text: z.string(), html: z.string().nullable() }).nullable(),
});

/** Narrows a jsonb column the repository wrote itself; the error names the column, never the content. */
const readJson = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, column: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${column} holds a malformed value.`);
  }
  return parsed.data;
};

const mapIntent = (row: IntentRow): EmailSendIntentRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  mailboxId: row.mailbox_id,
  conversationId: row.conversation_id,
  messageId: row.message_id,
  heldReplyId: row.held_reply_id,
  idempotencyKey: row.idempotency_key,
  authorKind: readEnum(row.author_kind, AUTHOR_KINDS, "email_send_intents.author_kind"),
  trigger: readEnum(row.trigger, SEND_TRIGGERS, "email_send_intents.trigger"),
  state: readEnum(row.state, SEND_INTENT_STATES, "email_send_intents.state"),
  version: row.version,
  haltReason: readOptionalEnum(row.halt_reason, HALT_REASONS, "email_send_intents.halt_reason"),
  authority: readJson(authoritySchema, row.authority_snapshot, "email_send_intents.authority_snapshot"),
  request: row.request_snapshot === null
    ? null
    : readJson(requestSchema, row.request_snapshot, "email_send_intents.request_snapshot"),
  provider: row.provider,
  providerMessageId: row.provider_message_id,
  suppliedRfcMessageId: row.supplied_rfc_message_id,
  deliveredRfcMessageId: row.delivered_rfc_message_id,
  failureCode: row.failure_code,
  outcomeUnknown: row.outcome_unknown_since !== null,
  uncertainResolution: readOptionalEnum(row.uncertain_resolution, UNCERTAIN_RESOLUTIONS, "email_send_intents.uncertain_resolution"),
  uncertainResolvedByUserId: row.uncertain_resolved_by_user_id,
  firstAttemptAt: row.first_attempt_at,
  outcomeUnknownSince: row.outcome_unknown_since,
  nextReconcileAt: row.next_reconcile_at,
  reconcileLeaseUntil: row.reconcile_lease_until,
  acceptedAt: row.accepted_at,
  settledAt: row.settled_at,
  complainedAt: row.complained_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const snapshotOf = (intent: EmailSendIntentRecord): SendIntentSnapshot => ({
  state: intent.state,
  haltReason: intent.haltReason,
  providerMessageId: intent.providerMessageId,
  deliveredRfcMessageId: intent.deliveredRfcMessageId,
  failureCode: intent.failureCode,
  outcomeUnknown: intent.outcomeUnknown,
  uncertainResolution: intent.uncertainResolution,
  uncertainResolvedByUserId: intent.uncertainResolvedByUserId,
});

const isSchedule = (effect: SendIntentEffect): effect is ScheduleEffect => effect.kind === "schedule_reconcile";

/**
 * The timestamps and bookkeeping a transition implies. The state machine stays clock-free; the
 * database clock stamps what it decided. A transition consumes any reconcile claim, and sets the
 * next reconcile time only when the machine scheduled one.
 */
const transitionBookkeeping = (current: EmailSendIntentRecord, next: SendIntentSnapshot, schedule: ScheduleEffect | undefined) => {
  const settles = isTerminalSendIntentState(next.state);
  return {
    next_reconcile_at: schedule ? nowPlusSeconds(schedule.afterSeconds) : null,
    reconcile_lease_until: null,
    ...(next.outcomeUnknown && current.outcomeUnknownSince === null ? { outcome_unknown_since: currentTimestamp() } : {}),
    ...(next.state === "accepted" && current.state !== "accepted" ? { accepted_at: currentTimestamp() } : {}),
    ...(settles ? { settled_at: currentTimestamp() } : {}),
    // The body is customer content kept only for replay; a settled send never replays.
    ...(settles && current.request !== null ? { request_snapshot: toJsonb({ ...current.request, body: null }) } : {}),
  };
};

/**
 * Outbound send intents (data model, research B6 and B18). Every state change goes through
 * `transition`, which applies `nextSendIntentState` under an optimistic `version` fence: a writer
 * whose read went stale gets `conflict` and the current row, and must re-read and re-apply. No
 * write ever overwrites another writer's.
 */
export class EmailSendIntentRepository {
  constructor(private readonly db: Db) {}

  /**
   * Materializes the intent for an outbox key, or returns the one already written for it, so a
   * redelivered action never creates a second send.
   */
  async materialize(input: MaterializeSendIntentInput): Promise<{ intent: EmailSendIntentRecord; created: boolean }> {
    const initial = nextSendIntentState(null, { kind: "materialized" });
    if ("ignored" in initial) {
      throw new Error("A new send intent must materialize.");
    }
    const inserted = await this.db
      .insertInto("email_send_intents")
      .values({
        id: input.id,
        workspace_id: input.workspaceId,
        mailbox_id: input.mailboxId,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        held_reply_id: input.heldReplyId,
        idempotency_key: input.idempotencyKey,
        author_kind: input.authorKind,
        trigger: input.trigger,
        state: initial.next.state,
        authority_snapshot: toJsonb(input.authority),
        provider: input.provider,
        supplied_rfc_message_id: input.suppliedRfcMessageId,
      })
      .onConflict((oc) => oc.column("idempotency_key").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { intent: mapIntent(inserted), created: true };

    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (!existing) {
      throw new Error("A send intent conflicted on its idempotency key but could not be read back.");
    }
    return { intent: existing, created: false };
  }

  async findById(id: string): Promise<EmailSendIntentRecord | null> {
    const row = await this.db.selectFrom("email_send_intents").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? mapIntent(row) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<EmailSendIntentRecord | null> {
    const row = await this.db
      .selectFrom("email_send_intents")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row ? mapIntent(row) : null;
  }

  /**
   * Applies one event to the intent at `expectedVersion`. `ignored` writes nothing; `conflict`
   * means another writer moved the intent first, and carries the row as it is now.
   */
  async transition(id: string, expectedVersion: number, event: SendIntentEvent): Promise<SendIntentTransitionOutcome> {
    const current = await this.findById(id);
    if (!current) return { outcome: "not_found" };
    if (current.version !== expectedVersion) return { outcome: "conflict", current };

    const result = nextSendIntentState(snapshotOf(current), event);
    if ("ignored" in result) return { outcome: "ignored", reason: result.ignored, intent: current };

    const { next, effects } = result;
    const row = await this.db
      .updateTable("email_send_intents")
      .set({
        state: next.state,
        halt_reason: next.haltReason,
        provider_message_id: next.providerMessageId,
        delivered_rfc_message_id: next.deliveredRfcMessageId,
        failure_code: next.failureCode,
        uncertain_resolution: next.uncertainResolution,
        uncertain_resolved_by_user_id: next.uncertainResolvedByUserId,
        ...transitionBookkeeping(current, next, effects.find(isSchedule)),
        version: expectedVersion + 1,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", id)
      .where("version", "=", expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row) return { outcome: "applied", intent: mapIntent(row), effects };
    return this.currentAfterLostRace(id);
  }

  /**
   * Freezes the request on the first attempt and stamps `first_attempt_at`, which starts the
   * re-POST window. The stored request is sanitized, so the caller sends the request this returns,
   * never the one it passed in. An intent frozen already reports `conflict` with that request.
   */
  async freezeRequest(
    id: string,
    expectedVersion: number,
    request: SendRequestSnapshot & { body: NonNullable<SendRequestSnapshot["body"]> },
  ): Promise<FencedWriteOutcome> {
    const row = await this.db
      .updateTable("email_send_intents")
      .set({
        request_snapshot: toSanitizedJsonb(request),
        first_attempt_at: currentTimestamp(),
        version: expectedVersion + 1,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", id)
      .where("version", "=", expectedVersion)
      .where("state", "=", "queued")
      .where("request_snapshot", "is", null)
      .returningAll()
      .executeTakeFirst();
    if (row) return { outcome: "applied", intent: mapIntent(row) };
    return this.currentAfterLostRace(id);
  }

  /**
   * Records the Message-ID the provider delivered under (research A7), once, for the provider id
   * it was fetched for. Bumps `version` like every write, so a writer that read before it re-reads.
   */
  async recordDeliveredMessageId(id: string, input: { providerMessageId: string; deliveredRfcMessageId: RfcMessageId }): Promise<boolean> {
    const row = await this.db
      .updateTable("email_send_intents")
      .set((eb) => ({
        delivered_rfc_message_id: input.deliveredRfcMessageId,
        version: eb("version", "+", 1),
        updated_at: currentTimestamp(),
      }))
      .where("id", "=", id)
      .where("provider_message_id", "=", input.providerMessageId)
      .where("delivered_rfc_message_id", "is", null)
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Claims up to `limit` intents due for a re-POST or a lookup, leasing each until
   * `now() + leaseSeconds`, in one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`. Two
   * sweeps never claim the same intent; an intent whose lease ran out is claimable again, so a
   * crashed sweep strands nothing. The lease is coordination, not state, so `version` is left
   * alone: the claimant's transition is still fenced against any writer that lands first.
   */
  async claimDueForReconcile(input: { limit: number; leaseSeconds: number }): Promise<EmailSendIntentRecord[]> {
    const rows = await this.db
      .updateTable("email_send_intents")
      .set({ reconcile_lease_until: nowPlusSeconds(input.leaseSeconds) })
      .where("id", "in", (eb) =>
        eb
          .selectFrom("email_send_intents")
          .select("id")
          .where("state", "in", RECONCILABLE_STATES)
          .where("next_reconcile_at", "is not", null)
          .where("next_reconcile_at", "<=", currentTimestamp())
          .where((lease) =>
            lease.or([lease("reconcile_lease_until", "is", null), lease("reconcile_lease_until", "<", currentTimestamp())]),
          )
          .orderBy("next_reconcile_at", "asc")
          .limit(input.limit)
          .forUpdate()
          .skipLocked(),
      )
      .returningAll()
      .execute();
    return rows.map(mapIntent);
  }

  private async currentAfterLostRace(id: string): Promise<{ outcome: "conflict"; current: EmailSendIntentRecord } | { outcome: "not_found" }> {
    const current = await this.findById(id);
    return current ? { outcome: "conflict", current } : { outcome: "not_found" };
  }
}
