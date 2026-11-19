import { sql, type ExpressionBuilder } from "kysely";

import type {
  DueEventSubscription,
  EventDeliveryOutcome,
  EventSubscriptionCreator,
  EventSubscriptionCreatorKind,
  EventSubscriptionDisabledReason,
  EventSubscriptionLabel,
  EventSubscriptionStatus,
  SealedEventSubscription,
  StoredEventSubscription,
  WorkspaceEventSubscriptionStore,
} from "../../shared/domain/workspaceEventSubscriptions.js";
import type { WorkspaceEventType } from "../../shared/domain/workspaceEventLog.js";
import { transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../shared/infra/kysely/schema.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface SubscriptionRow {
  id: string;
  workspace_id: string;
  label: string;
  target_host: string;
  target_url_ciphertext: string;
  secret_ciphertext: string;
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
 * token's, or the teammate's display name or email.
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
      SELECT coalesce(u.display_name, u.email) FROM users u
      WHERE u.id = ${eb.ref("workspace_event_subscriptions.created_by_user_id")})
  END`;

/** Serializes a workspace's creates, so counting and inserting under the cap never race. */
const capLockKey = (workspaceId: string): string => `workspace-event-subscriptions:${workspaceId}`;

/** The Postgres store of workspace event subscriptions (#1852). */
export class WorkspaceEventSubscriptionRepository implements WorkspaceEventSubscriptionStore {
  constructor(private readonly db: Db) {}

  private selectSubscriptions(db: Db = this.db) {
    return db
      .selectFrom("workspace_event_subscriptions")
      .selectAll("workspace_event_subscriptions")
      .select((eb) => creatorLabel(eb).as("creator_label"));
  }

  async createWithinCap(input: Parameters<WorkspaceEventSubscriptionStore["createWithinCap"]>[0]): Promise<StoredEventSubscription | null> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(capLockKey(input.workspaceId)).execute(trx);
      const held = await trx
        .selectFrom("workspace_event_subscriptions")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("workspace_id", "=", input.workspaceId)
        .executeTakeFirstOrThrow();
      if (Number(held.count) >= input.cap) {
        return null;
      }
      const inserted = await trx
        .insertInto("workspace_event_subscriptions")
        .values({
          workspace_id: input.workspaceId,
          label: input.label,
          target_host: input.targetHost,
          target_url_ciphertext: input.targetUrlCiphertext,
          secret_ciphertext: input.secretCiphertext,
          event_types: [...input.eventTypes],
          ...creatorColumns(input.createdBy),
          // The log's horizon now: every event a still-running transaction writes comes after it.
          cursor_tx: sql<string>`pg_snapshot_xmin(pg_current_snapshot())`,
          cursor_position: "0",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const created = await this.selectSubscriptions(trx).where("id", "=", inserted.id).executeTakeFirstOrThrow();
      return mapSubscription(created);
    });
  }

  async list(workspaceId: string): Promise<StoredEventSubscription[]> {
    const rows = await this.selectSubscriptions()
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return (rows as SubscriptionRow[]).map(mapSubscription);
  }

  async find(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null> {
    return this.findSealed(workspaceId, subscriptionId);
  }

  async findSealed(workspaceId: string, subscriptionId: string): Promise<SealedEventSubscription | null> {
    const row = await this.selectSubscriptions()
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", subscriptionId)
      .executeTakeFirst();
    if (!row) return null;
    const subscription = row as SubscriptionRow;
    return {
      ...mapSubscription(subscription),
      targetUrlCiphertext: subscription.target_url_ciphertext,
      secretCiphertext: subscription.secret_ciphertext,
    };
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

  async recordDelivered(input: Parameters<WorkspaceEventSubscriptionStore["recordDelivered"]>[0]): Promise<boolean> {
    const result = await this.activeSubscription(input.workspaceId, input.subscriptionId)
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

  async recordFailed(input: Parameters<WorkspaceEventSubscriptionStore["recordFailed"]>[0]): Promise<boolean> {
    const result = await this.activeSubscription(input.workspaceId, input.subscriptionId)
      .set({
        last_delivery_at: input.at,
        last_delivery_outcome: "failed",
        last_delivery_status_code: input.statusCode,
        consecutive_failures: input.consecutiveFailures,
        failing_since: input.failingSince,
        next_attempt_at: input.nextAttemptAt,
        updated_at: input.at,
        ...(input.disable ? { status: "disabled", disabled_reason: "delivery_failing", disabled_at: input.at } : {}),
      })
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async disable(input: Parameters<WorkspaceEventSubscriptionStore["disable"]>[0]): Promise<boolean> {
    const result = await this.activeSubscription(input.workspaceId, input.subscriptionId)
      .set({ status: "disabled", disabled_reason: input.reason, disabled_at: input.at, updated_at: input.at })
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Active subscriptions that are due and have an event after their cursor whose transaction has
   * finished: the same horizon the log's reader stops at, so a drain is not started for an event
   * it could not yet read.
   */
  async findDue(input: { workspaceId?: string; limit: number }): Promise<DueEventSubscription[]> {
    const rows = await this.db
      .selectFrom("workspace_event_subscriptions as s")
      .select(["s.workspace_id", "s.id"])
      .where("s.status", "=", "active")
      .where((eb) => eb.or([eb("s.next_attempt_at", "is", null), eb("s.next_attempt_at", "<=", sql<Date>`now()`)]))
      .$if(input.workspaceId !== undefined, (query) => query.where("s.workspace_id", "=", input.workspaceId!))
      .where(({ exists, selectFrom }) => exists(
        selectFrom("workspace_events as e")
          .select(sql`1`.as("one"))
          .whereRef("e.workspace_id", "=", "s.workspace_id")
          .where(sql<boolean>`e.type = ANY(s.event_types)`)
          .where(sql<boolean>`(e.tx_id, e.position) > (s.cursor_tx, s.cursor_position)`)
          .where(sql<boolean>`e.tx_id < pg_snapshot_xmin(pg_current_snapshot())`),
      ))
      .orderBy("s.next_attempt_at", "asc")
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({ workspaceId: row.workspace_id, subscriptionId: row.id }));
  }

  private activeSubscription(workspaceId: string, subscriptionId: string) {
    return this.db
      .updateTable("workspace_event_subscriptions")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", subscriptionId)
      .where("status", "=", "active");
  }
}

const creatorColumns = (creator: EventSubscriptionCreator) => ({
  created_by_kind: creator.kind,
  created_by_credential_id: creator.kind === "teammate" ? null : creator.credentialId,
  created_by_service_account_id: creator.kind === "service_account" ? creator.serviceAccountId : null,
  created_by_user_id: creator.kind === "service_account" ? null : creator.userId,
});
