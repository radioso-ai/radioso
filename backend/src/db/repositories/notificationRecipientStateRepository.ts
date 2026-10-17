import { sql } from "kysely";

import { transactionAdvisoryLock, currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { normalizeRecipientEmail } from "../../shared/domain/recipientEmailAudit.js";
import type {
  ConfirmationReservation,
  NotificationRecipientStateStore,
  NotificationRecipientStateView,
  NotificationSuppressionStore,
} from "../../modules/operatorNotifications/public.js";

const usageDateOf = (at: Date): Date => new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);

export class NotificationRecipientStateRepository implements NotificationRecipientStateStore, NotificationSuppressionStore {
  constructor(private readonly db: Db) {}

  async read(input: {
    workspaceId: string;
    emails: readonly string[];
    now: Date;
  }): Promise<NotificationRecipientStateView[]> {
    const emails = [...new Set(input.emails.map(normalizeRecipientEmail).filter(Boolean))];
    if (emails.length === 0) return [];

    const [stored, suppressions, verifiedMembers] = await Promise.all([
      this.db.selectFrom("notification_recipient_confirmations")
        .select(["id", "normalized_email", "state", "grandfathered_until", "confirmation_sent_at", "confirmation_generation"])
        .where("workspace_id", "=", input.workspaceId)
        .where("normalized_email", "in", emails)
        .execute(),
      this.db.selectFrom("notification_email_suppressions")
        .select("normalized_email")
        .where("normalized_email", "in", emails)
        .execute(),
      this.db.selectFrom("workspaces as w")
        .innerJoin("account_memberships as m", "m.account_id", "w.account_id")
        .innerJoin("users as u", "u.id", "m.user_id")
        .select((expression) => expression.fn<string>("lower", ["u.email"]).as("normalized_email"))
        .where("w.id", "=", input.workspaceId)
        .where("m.status", "=", "active")
        .where("u.disabled_at", "is", null)
        .where("u.email_verified_at", "is not", null)
        .where((expression) => expression.fn<string>("lower", ["u.email"]), "in", emails)
        .execute(),
    ]);

    const storedByEmail = new Map(stored.map((row) => [row.normalized_email, row]));
    const suppressed = new Set(suppressions.map((row) => row.normalized_email));
    const confirmedMembers = new Set(verifiedMembers.map((row) => row.normalized_email));

    return emails.map((email): NotificationRecipientStateView => {
      const row = storedByEmail.get(email);
      const stored = row
        ? {
            recipientId: row.id,
            generation: row.confirmation_generation,
            confirmationSentAt: row.confirmation_sent_at ? new Date(row.confirmation_sent_at) : null,
          }
        : { confirmationSentAt: null };
      if (suppressed.has(email)) {
        return { email, state: "suppressed", grandfatheredUntil: null, confirmationSentAt: null };
      }
      if (row?.state === "revoked") {
        return { email, state: "revoked", grandfatheredUntil: null, ...stored };
      }
      // Membership is re-derived on every read, so an address that leaves the workspace has to confirm.
      if (confirmedMembers.has(email)) {
        return { email, state: "confirmed", grandfatheredUntil: null, ...stored };
      }
      if (!row) {
        return { email, state: "waiting_for_confirmation", grandfatheredUntil: null, ...stored };
      }
      return {
        email,
        state: row.state === "pending" ? "waiting_for_confirmation" : row.state as "confirmed" | "grandfathered",
        grandfatheredUntil: row.grandfathered_until ? new Date(row.grandfathered_until) : null,
        ...stored,
      };
    });
  }

  async ensure(workspaceId: string, rawEmail: string): Promise<{ recipientId: string; generation: number }> {
    const email = normalizeRecipientEmail(rawEmail);
    const inserted = await this.db.insertInto("notification_recipient_confirmations").values({
      workspace_id: workspaceId,
      normalized_email: email,
      state: "pending",
      grandfathered_until: null,
      confirmation_sent_at: null,
      confirmed_at: null,
      revoked_at: null,
      confirmation_generation: 0,
    }).onConflict((conflict) => conflict.columns(["workspace_id", "normalized_email"]).doNothing())
      .returning(["id", "confirmation_generation"])
      .executeTakeFirst();
    if (inserted) return { recipientId: inserted.id, generation: inserted.confirmation_generation };

    const existing = await this.db.selectFrom("notification_recipient_confirmations")
      .select(["id", "confirmation_generation"])
      .where("workspace_id", "=", workspaceId)
      .where("normalized_email", "=", email)
      .executeTakeFirstOrThrow();
    return { recipientId: existing.id, generation: existing.confirmation_generation };
  }

  async reserveConfirmationSend(input: {
    workspaceId: string;
    email: string;
    now: Date;
    force: boolean;
    limits: { dailySends: number; accountDailySends: number; resendCooldownMs: number };
  }): Promise<ConfirmationReservation | null> {
    const email = normalizeRecipientEmail(input.email);
    const usageDate = usageDateOf(input.now);
    return this.db.transaction().execute(async (transaction) => {
      const workspace = await transaction.selectFrom("workspaces")
        .select("account_id")
        .where("id", "=", input.workspaceId)
        .executeTakeFirst();
      if (!workspace) return null;
      // One lock per account and day, so the workspace and account allowances are checked together.
      await transactionAdvisoryLock(`notification-confirmation:${workspace.account_id}:${usageDate.toISOString()}`).execute(transaction);
      await transactionAdvisoryLock(`notification-recipient:${input.workspaceId}:${email}`).execute(transaction);

      const suppression = await transaction.selectFrom("notification_email_suppressions")
        .select("normalized_email")
        .where("normalized_email", "=", email)
        .executeTakeFirst();
      if (suppression) return null;

      const verifiedMember = await transaction.selectFrom("workspaces as w")
        .innerJoin("account_memberships as m", "m.account_id", "w.account_id")
        .innerJoin("users as u", "u.id", "m.user_id")
        .select("u.id")
        .where("w.id", "=", input.workspaceId)
        .where("m.status", "=", "active")
        .where("u.disabled_at", "is", null)
        .where("u.email_verified_at", "is not", null)
        .where((expression) => expression.fn<string>("lower", ["u.email"]), "=", email)
        .executeTakeFirst();
      await transaction.insertInto("notification_recipient_confirmations").values({
        workspace_id: input.workspaceId,
        normalized_email: email,
        state: "pending",
        grandfathered_until: null,
        confirmation_sent_at: null,
        confirmed_at: null,
        revoked_at: null,
        confirmation_generation: 0,
      }).onConflict((conflict) => conflict.columns(["workspace_id", "normalized_email"]).doNothing()).execute();

      const recipient = await transaction.selectFrom("notification_recipient_confirmations")
        .select(["id", "state", "confirmation_sent_at", "confirmation_generation"])
        .where("workspace_id", "=", input.workspaceId)
        .where("normalized_email", "=", email)
        .forUpdate()
        .executeTakeFirstOrThrow();
      // A revoked address is never asked again; only its owner can resume from a revocation link.
      if (recipient.state === "confirmed" || recipient.state === "revoked" || verifiedMember) return null;
      if (recipient.confirmation_sent_at !== null) {
        if (!input.force) return null;
        const sinceLastSend = input.now.getTime() - new Date(recipient.confirmation_sent_at).getTime();
        if (sinceLastSend < input.limits.resendCooldownMs) return null;
      }

      const accountUsage = await transaction.selectFrom("notification_recipient_confirmation_daily_usage as u")
        .innerJoin("workspaces as w", "w.id", "u.workspace_id")
        .select((expression) => expression.fn.coalesce(expression.fn.sum<number>("u.send_count"), expression.val(0)).as("sent"))
        .where("w.account_id", "=", workspace.account_id)
        .where("u.usage_date", "=", usageDate)
        .executeTakeFirstOrThrow();
      if (Number(accountUsage.sent) >= input.limits.accountDailySends) return null;

      await transaction.insertInto("notification_recipient_confirmation_daily_usage").values({
        workspace_id: input.workspaceId,
        usage_date: usageDate,
        send_count: 0,
      }).onConflict((conflict) => conflict.columns(["workspace_id", "usage_date"]).doNothing()).execute();
      const usage = await transaction.updateTable("notification_recipient_confirmation_daily_usage")
        .set({ send_count: sql`send_count + 1`, updated_at: input.now })
        .where("workspace_id", "=", input.workspaceId)
        .where("usage_date", "=", usageDate)
        .where("send_count", "<", input.limits.dailySends)
        .returning("send_count")
        .executeTakeFirst();
      if (!usage) return null;

      // A grandfathered address stays grandfathered: its answer window runs from this send.
      const reserved = await transaction.updateTable("notification_recipient_confirmations")
        .set({
          confirmation_sent_at: input.now,
          confirmation_generation: sql`confirmation_generation + 1`,
          updated_at: input.now,
        })
        .where("id", "=", recipient.id)
        .returning("confirmation_generation")
        .executeTakeFirstOrThrow();
      return {
        recipientId: recipient.id,
        generation: reserved.confirmation_generation,
        reservedAt: input.now,
        previousSentAt: recipient.confirmation_sent_at ? new Date(recipient.confirmation_sent_at) : null,
      };
    });
  }

  async confirm(recipientId: string, generation: number, now: Date): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const recipient = await transaction.selectFrom("notification_recipient_confirmations")
        .select(["state", "confirmation_generation"])
        .where("id", "=", recipientId)
        .forUpdate()
        .executeTakeFirst();
      // A grandfathered address may confirm after its grace period: the current link still proves the inbox.
      if (!recipient || recipient.confirmation_generation !== generation) return false;
      if (recipient.state !== "pending" && recipient.state !== "grandfathered") return false;
      await transaction.updateTable("notification_recipient_confirmations")
        .set({ state: "confirmed", grandfathered_until: null, confirmed_at: now, revoked_at: null, updated_at: now })
        .where("id", "=", recipientId)
        .execute();
      return true;
    });
  }

  /**
   * Hands back a reservation whose mail did not go out. A send the transport never dispatched is
   * undone outright: the earlier link stays valid and the daily slot is returned. A send that failed
   * may still have reached the provider, so its slot stays spent and only the address is reopened
   * for a later notice to ask again.
   */
  async releaseConfirmationSend(reservation: ConfirmationReservation, outcome: "not_dispatched" | "failed"): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      const released = await transaction.updateTable("notification_recipient_confirmations")
        .set(outcome === "not_dispatched"
          ? {
              confirmation_sent_at: reservation.previousSentAt,
              confirmation_generation: reservation.generation - 1,
              updated_at: currentTimestamp(),
            }
          : { confirmation_sent_at: null, updated_at: currentTimestamp() })
        .where("id", "=", reservation.recipientId)
        .where("confirmation_generation", "=", reservation.generation)
        .where("confirmation_sent_at", "=", reservation.reservedAt)
        .where("state", "in", ["pending", "grandfathered"])
        .returning("workspace_id")
        .executeTakeFirst();
      if (!released || outcome !== "not_dispatched") return;
      await transaction.updateTable("notification_recipient_confirmation_daily_usage")
        .set({ send_count: sql`send_count - 1`, updated_at: currentTimestamp() })
        .where("workspace_id", "=", released.workspace_id)
        .where("usage_date", "=", usageDateOf(reservation.reservedAt))
        .where("send_count", ">", 0)
        .execute();
    });
  }

  async revoke(recipientId: string, now: Date): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const recipient = await transaction.selectFrom("notification_recipient_confirmations")
        .select("state")
        .where("id", "=", recipientId)
        .forUpdate()
        .executeTakeFirst();
      if (!recipient || recipient.state === "revoked") return false;
      await transaction.updateTable("notification_recipient_confirmations")
        .set({ state: "revoked", grandfathered_until: null, revoked_at: now, updated_at: now })
        .where("id", "=", recipientId)
        .execute();
      return true;
    });
  }

  async resume(recipientId: string, now: Date): Promise<boolean> {
    const resumed = await this.db.updateTable("notification_recipient_confirmations")
      .set({ state: "confirmed", confirmed_at: now, revoked_at: null, updated_at: now })
      .where("id", "=", recipientId)
      .where("state", "=", "revoked")
      .executeTakeFirst();
    return Number(resumed.numUpdatedRows) > 0;
  }

  async suppress(input: {
    email: string;
    reason: "hard_bounce" | "complaint";
    provider: string;
    providerEventId: string;
  }): Promise<void> {
    const email = normalizeRecipientEmail(input.email);
    await this.db.insertInto("notification_email_suppressions").values({
      normalized_email: email,
      reason: input.reason,
      provider: input.provider,
      provider_event_id: input.providerEventId,
    }).onConflict((conflict) => conflict.column("normalized_email").doUpdateSet({
      reason: sql<string>`CASE WHEN notification_email_suppressions.reason = 'complaint' THEN 'complaint' ELSE EXCLUDED.reason END`,
      provider: input.provider,
      provider_event_id: input.providerEventId,
      updated_at: currentTimestamp(),
    })).execute();
  }
}

export class NotificationRecipientIdentityRepository {
  constructor(private readonly db: Db) {}

  async resolve(input: {
    workspaceId: string;
    agentId?: string | null;
    conversationId?: string | null;
  }): Promise<{ workspaceName: string; agentName: string }> {
    const workspace = await this.db.selectFrom("workspaces")
      .select("name")
      .where("id", "=", input.workspaceId)
      .executeTakeFirst();
    const agentId = input.agentId ?? (input.conversationId
      ? (await this.db.selectFrom("conversations")
          .select("agent_id")
          .where("id", "=", input.conversationId)
          .where("workspace_id", "=", input.workspaceId)
          .executeTakeFirst())?.agent_id
      : null);
    const agent = agentId
      ? await this.db.selectFrom("agents")
          .select(["name", "internal_name"])
          .where("id", "=", agentId)
          .where("workspace_id", "=", input.workspaceId)
          .executeTakeFirst()
      : null;
    return {
      workspaceName: workspace?.name ?? "Your workspace",
      agentName: agent?.internal_name || agent?.name || "your agent",
    };
  }
}
