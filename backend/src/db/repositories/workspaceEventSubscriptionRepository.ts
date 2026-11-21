import { sql, type ExpressionBuilder } from "kysely";

import type {
  DueEventSubscription,
  EventDeliveryOutcome,
  EventSubscriptionCreator,
  EventSubscriptionCreatorKind,
  EventSubscriptionDeliveryStore,
  EventSubscriptionDisabledReason,
  EventSubscriptionLabel,
  EventSubscriptionStatus,
  SealedEventSubscription,
  StoredEventSubscription,
  WorkspaceEventSubscriptionStore,
} from "../../shared/domain/workspaceEventSubscriptions.js";
import type { LogPosition, WorkspaceEventType } from "../../shared/domain/workspaceEventLog.js";
import { transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../shared/infra/kysely/schema.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface SubscriptionRow {
  id: string;
  workspace_id: string;
  label: string;
  target_host: string;
  event_types: string[];
  status: string;
  disabled_reason: string | null;
  disabled_at: Date | null;
  created_at: Date;
  created_by_kind: string;
  created_by_credential_id: string | null;
  created_by_service_account_id: string | null;
  created_by_user_id: string | null;
  creator_label: string | null;
  cursor_tx: string;
  cursor_position: string;
  last_delivery_at: Date | null;
  last_delivery_outcome: string | null;
  last_delivery_status_code: number | null;
  consecutive_failures: number;
  failing_since: Date | null;
  next_attempt_at: Date | null;
}

/** Every column a subscription is read with, the sealed target URL and secret aside. */
const subscriptionColumns = [
  "id",
  "workspace_id",
  "label",
  "target_host",
  "event_types",
  "status",
  "disabled_reason",
  "disabled_at",
  "created_at",
  "created_by_kind",
  "created_by_credential_id",
  "created_by_service_account_id",
  "created_by_user_id",
  "cursor_tx",
  "cursor_position",
  "last_delivery_at",
  "last_delivery_outcome",
  "last_delivery_status_code",
  "consecutive_failures",
  "failing_since",
  "next_attempt_at",
] as const;

const date = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));

const mapSubscription = (row: SubscriptionRow): StoredEventSubscription => ({
  id: row.id,
  workspaceId: row.workspace_id,
  label: row.label as EventSubscriptionLabel,
  targetHost: row.target_host,
  eventTypes: row.event_types as WorkspaceEventType[],
  status: row.status as EventSubscriptionStatus,
  disabledReason: row.disabled_reason as EventSubscriptionDisabledReason | null,
  disabledAt: date(row.disabled_at),
  createdAt: new Date(row.created_at),
  createdBy: {
    kind: row.created_by_kind as EventSubscriptionCreatorKind,
    credentialId: row.created_by_credential_id,
    serviceAccountId: row.created_by_service_account_id,
    userId: row.created_by_user_id,
    label: row.creator_label,
  },
  cursor: { tx: String(row.cursor_tx), position: String(row.cursor_position) },
  lastDelivery: row.last_delivery_at && row.last_delivery_outcome
    ? { at: new Date(row.last_delivery_at), outcome: row.last_delivery_outcome as EventDeliveryOutcome, statusCode: row.last_delivery_status_code }
    : null,
  consecutiveFailures: row.consecutive_failures,
  failingSince: date(row.failing_since),
  nextAttemptAt: date(row.next_attempt_at),
});

/**
 * The creator's name as it reads now, so a rename shows: the service account's, the personal
 * token's, or the teammate's display name. A teammate's email is never read: the list is served to
 * API credentials.
 */
const creatorLabel = (eb: ExpressionBuilder<DB, "workspace_event_subscriptions">) => sql<string | null>`
  CASE ${eb.ref("workspace_event_subscriptions.created_by_kind")}
    WHEN 'service_account' THEN (
      SELECT sa.display_name FROM workspace_service_accounts sa
      WHERE sa.id = ${eb.ref("workspace_event_subscriptions.created_by_service_account_id")})
    WHEN 'personal_token' THEN (
      SELECT c.label FROM api_credentials c
      WHERE c.id = ${eb.ref("workspace_event_subscriptions.created_by_credential_id")})
    ELSE (
      SELECT u.display_name FROM users u
      WHERE u.id = ${eb.ref("workspace_event_subscriptions.created_by_user_id")})
  END`;

/** The log's horizon now, the place a new or reactivated subscription starts from. */
const horizonTx = sql<string>`pg_snapshot_xmin(pg_current_snapshot())`;

/** `(cursor_tx, cursor_position) < (tx, position)`: the cursor is behind `position`. */
const cursorBefore = (position: LogPosition) =>
  sql<boolean>`(cursor_tx, cursor_position) < (${position.tx}::xid8, ${position.position}::bigint)`;

/**
 * An event of one of the subscription's types after its cursor whose transaction has finished: the
 * horizon the log's reader stops at. Probed type by type with equality, so each probe is a range
 * scan of `workspace_events_type_log_idx`.
 */
const hasEventWaiting = sql<boolean>`EXISTS (
  SELECT 1 FROM unnest(s.event_types) AS subscribed(type)
  WHERE EXISTS (
    SELECT 1 FROM workspace_events e
    WHERE e.workspace_id = s.workspace_id
      AND e.type = subscribed.type
      AND (e.tx_id, e.position) > (s.cursor_tx, s.cursor_position)
      AND e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
  )
)`;

/** Serializes a workspace's creates, so finding, counting and inserting never race. */
const capLockKey = (workspaceId: string): string => `workspace-event-subscriptions:${workspaceId}`;

const creatorColumns = (creator: EventSubscriptionCreator) => ({
  created_by_kind: creator.kind,
  created_by_credential_id: creator.kind === "teammate" ? null : creator.credentialId,
  created_by_service_account_id: creator.kind === "service_account" ? creator.serviceAccountId : null,
  created_by_user_id: creator.kind === "service_account" ? null : creator.userId,
});

/** The Postgres store of workspace event subscriptions (#1852), for their lifecycle and their delivery. */
export class WorkspaceEventSubscriptionRepository implements WorkspaceEventSubscriptionStore, EventSubscriptionDeliveryStore {
  constructor(private readonly db: Db) {}

  private selectSubscriptions(db: Db = this.db) {
    return db
      .selectFrom("workspace_event_subscriptions")
      .select(subscriptionColumns)
      .select((eb) => creatorLabel(eb).as("creator_label"));
  }

  async upsertWithinCap(input: Parameters<WorkspaceEventSubscriptionStore["upsertWithinCap"]>[0]): Promise<{ subscription: StoredEventSubscription; replacedSubscriptionId: string | null } | null> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(capLockKey(input.workspaceId)).execute(trx);
      const existing = await trx
        .selectFrom("workspace_event_subscriptions")
        .select(["id", "status", "cursor_tx", "cursor_position"])
        .where("workspace_id", "=", input.workspaceId)
        .where("target_url_hash", "in", [...input.targetUrlHashes])
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        // The replacement takes the target's place in the cap and under the unique target index.
        await trx.deleteFrom("workspace_event_subscriptions").where("id", "=", existing.id).execute();
      } else {
        const held = await trx
          .selectFrom("workspace_event_subscriptions")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("workspace_id", "=", input.workspaceId)
          .executeTakeFirstOrThrow();
        if (Number(held.count) >= input.cap) {
          return null;
        }
      }
      // A replaced active subscription's place carries over, so nothing is skipped or sent twice;
      // a new one, or one replacing a disabled one, starts at the newest events.
      const keepsPlace = existing?.status === "active";
      const inserted = await trx
        .insertInto("workspace_event_subscriptions")
        .values({
          workspace_id: input.workspaceId,
          label: input.label,
          target_host: input.targetHost,
          target_url_ciphertext: input.targetUrlCiphertext,
          target_url_hash: input.targetUrlHashes[0],
          secret_ciphertext: input.secretCiphertext,
          event_types: [...input.eventTypes],
          ...creatorColumns(input.createdBy),
          cursor_tx: keepsPlace ? existing.cursor_tx : horizonTx,
          cursor_position: keepsPlace ? existing.cursor_position : "0",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const stored = await this.selectSubscriptions(trx).where("id", "=", inserted.id).executeTakeFirstOrThrow();
      return { subscription: mapSubscription(stored), replacedSubscriptionId: existing?.id ?? null };
    });
  }

  async list(workspaceId: string): Promise<StoredEventSubscription[]> {
    const rows = await this.selectSubscriptions()
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return rows.map(mapSubscription);
  }

  async find(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null> {
    const row = await this.selectSubscriptions()
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", subscriptionId)
      .executeTakeFirst();
    return row ? mapSubscription(row) : null;
  }

  async findSealed(workspaceId: string, subscriptionId: string): Promise<SealedEventSubscription | null> {
    const row = await this.selectSubscriptions()
      .select(["target_url_ciphertext", "secret_ciphertext"])
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", subscriptionId)
      .executeTakeFirst();
    return row
      ? { ...mapSubscription(row), targetUrlCiphertext: row.target_url_ciphertext, secretCiphertext: row.secret_ciphertext }
      : null;
  }

  async delete(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await this.selectSubscriptions(trx)
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", subscriptionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return null;
      await trx.deleteFrom("workspace_event_subscriptions").where("id", "=", subscriptionId).execute();
      return mapSubscription(row);
    });
  }

  async recordDelivered(input: Parameters<EventSubscriptionDeliveryStore["recordDelivered"]>[0]): Promise<boolean> {
    const result = await this.activeSubscription(this.db, input.workspaceId, input.subscriptionId)
      .where(cursorBefore(input.position))
      .set({
        cursor_tx: input.position.tx,
        cursor_position: input.position.position,
        last_delivery_at: input.at,
        last_delivery_outcome: "delivered",
        last_delivery_status_code: input.statusCode,
        consecutive_failures: 0,
        failing_since: null,
        next_attempt_at: null,
        updated_at: input.at,
      })
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async advanceCursor(input: Parameters<EventSubscriptionDeliveryStore["advanceCursor"]>[0]): Promise<void> {
    await this.activeSubscription(this.db, input.workspaceId, input.subscriptionId)
      .where(cursorBefore(input.position))
      .set({ cursor_tx: input.position.tx, cursor_position: input.position.position })
      .execute();
  }

  async recordFailed(input: Parameters<EventSubscriptionDeliveryStore["recordFailed"]>[0]): ReturnType<EventSubscriptionDeliveryStore["recordFailed"]> {
    return this.db.transaction().execute(async (trx) => {
      // Counted in the row, so a run abandoned by its lease and the run that replaced it never
      // write over each other's count.
      const counted = await this.activeSubscription(trx, input.workspaceId, input.subscriptionId)
        .set({
          consecutive_failures: sql<number>`consecutive_failures + 1`,
          failing_since: sql<Date>`coalesce(failing_since, ${input.at}::timestamptz)`,
          last_delivery_at: input.at,
          last_delivery_outcome: "failed",
          last_delivery_status_code: input.statusCode,
          updated_at: input.at,
        })
        .returning(["consecutive_failures", "failing_since"])
        .executeTakeFirst();
      if (!counted?.failing_since) return null;
      const streak = { consecutiveFailures: counted.consecutive_failures, failingSince: new Date(counted.failing_since) };
      const { nextAttemptAt, disable } = input.schedule(streak);
      await trx
        .updateTable("workspace_event_subscriptions")
        .set({
          next_attempt_at: nextAttemptAt,
          ...(disable ? { status: "disabled", disabled_reason: "delivery_failing", disabled_at: input.at } : {}),
        })
        .where("id", "=", input.subscriptionId)
        .execute();
      return { ...streak, disabled: disable };
    });
  }

  async disable(input: Parameters<EventSubscriptionDeliveryStore["disable"]>[0]): Promise<boolean> {
    const result = await this.activeSubscription(this.db, input.workspaceId, input.subscriptionId)
      .set({ status: "disabled", disabled_reason: input.reason, disabled_at: input.at, updated_at: input.at })
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async findDue(input: { workspaceId?: string; afterSubscriptionId?: string; limit: number }): Promise<DueEventSubscription[]> {
    const rows = await this.db
      .selectFrom("workspace_event_subscriptions as s")
      .select(["s.workspace_id", "s.id"])
      .where("s.status", "=", "active")
      .where((eb) => eb.or([eb("s.next_attempt_at", "is", null), eb("s.next_attempt_at", "<=", sql<Date>`now()`)]))
      .$if(input.workspaceId !== undefined, (query) => query.where("s.workspace_id", "=", input.workspaceId!))
      .$if(input.afterSubscriptionId !== undefined, (query) => query.where("s.id", ">", input.afterSubscriptionId!))
      .where(hasEventWaiting)
      .orderBy("s.id", "asc")
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({ workspaceId: row.workspace_id, subscriptionId: row.id }));
  }

  private activeSubscription(db: Db, workspaceId: string, subscriptionId: string) {
    return db
      .updateTable("workspace_event_subscriptions")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", subscriptionId)
      .where("status", "=", "active");
  }
}
