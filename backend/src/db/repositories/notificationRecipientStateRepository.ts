import { sql } from "kysely";

import { transactionAdvisoryLock, currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export const NOTIFICATION_CONFIRMATION_DAILY_LIMIT = 25;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

type NotificationRecipientStateView = {
  email: string;
  state: "confirmed" | "grandfathered" | "waiting_for_confirmation" | "revoked" | "suppressed";
  grandfatheredUntil: Date | null;
  recipientId?: string | null;
  generation?: number | null;
};

export class NotificationRecipientStateRepository {
  constructor(private readonly db: Db) {}

  async read(input: {
    workspaceId: string;
    emails: readonly string[];
    now: Date;
  }): Promise<NotificationRecipientStateView[]> {
    const emails = [...new Set(input.emails.map(normalizeEmail).filter(Boolean))];
    if (emails.length === 0) return [];

    const [stored, suppressions, verifiedMembers] = await Promise.all([
      this.db.selectFrom("notification_recipient_confirmations")
        .select(["id", "normalized_email", "state", "grandfathered_until", "confirmation_generation", "requires_confirmation"])
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

    return emails.map((email) => {
      if (suppressed.has(email)) {
        return { email, state: "suppressed", grandfatheredUntil: null };
      }
      const row = storedByEmail.get(email);
      if (row?.state === "revoked") {
        return { email, state: "revoked", grandfatheredUntil: null, recipientId: row.id, generation: row.confirmation_generation };
      }
      if (confirmedMembers.has(email) && (!row || !row.requires_confirmation)) {
        return row
          ? { email, state: "confirmed", grandfatheredUntil: null, recipientId: row.id, generation: row.confirmation_generation }
          : { email, state: "confirmed", grandfatheredUntil: null };
      }
      if (!row) {
        return { email, state: "waiting_for_confirmation", grandfatheredUntil: null };
      }
      return {
        email,
        state: row.state === "pending" ? "waiting_for_confirmation" : row.state as "confirmed" | "grandfathered" | "revoked",
        grandfatheredUntil: row.grandfathered_until ? new Date(row.grandfathered_until) : null,
        recipientId: row.id,
        generation: row.confirmation_generation,
      };
    });
  }

  async ensure(workspaceId: string, rawEmail: string, initialState: "confirmed" | "pending"): Promise<{ recipientId: string; generation: number }> {
    const email = normalizeEmail(rawEmail);
    const inserted = await this.db.insertInto("notification_recipient_confirmations").values({
      workspace_id: workspaceId,
      normalized_email: email,
      state: initialState,
      grandfathered_until: null,
      confirmation_sent_at: null,
      confirmed_at: initialState === "confirmed" ? currentTimestamp() : null,
      revoked_at: null,
      confirmation_generation: 0,
      requires_confirmation: false,
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
  }): Promise<{ recipientId: string; generation: number } | null> {
    const email = normalizeEmail(input.email);
    const usageDate = new Date(`${input.now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    return this.db.transaction().execute(async (transaction) => {
      await transactionAdvisoryLock(`notification-confirmation:${input.workspaceId}:${usageDate.toISOString()}`).execute(transaction);
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
        state: verifiedMember ? "confirmed" : "pending",
        grandfathered_until: null,
        confirmation_sent_at: null,
        confirmed_at: verifiedMember ? input.now : null,
        revoked_at: null,
        confirmation_generation: 0,
        requires_confirmation: false,
      }).onConflict((conflict) => conflict.columns(["workspace_id", "normalized_email"]).doNothing()).execute();

      const recipient = await transaction.selectFrom("notification_recipient_confirmations")
        .select(["id", "state", "grandfathered_until", "confirmation_sent_at", "confirmation_generation"])
        .where("workspace_id", "=", input.workspaceId)
        .where("normalized_email", "=", email)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (recipient.state === "confirmed"
        || (recipient.state === "revoked" && !input.force)
        || (!input.force && recipient.confirmation_sent_at !== null)) return null;

      await transaction.insertInto("notification_recipient_confirmation_daily_usage").values({
        workspace_id: input.workspaceId,
        usage_date: usageDate,
        send_count: 0,
      }).onConflict((conflict) => conflict.columns(["workspace_id", "usage_date"]).doNothing()).execute();
      const usage = await transaction.updateTable("notification_recipient_confirmation_daily_usage")
        .set({ send_count: sql`send_count + 1`, updated_at: input.now })
        .where("workspace_id", "=", input.workspaceId)
        .where("usage_date", "=", usageDate)
        .where("send_count", "<", NOTIFICATION_CONFIRMATION_DAILY_LIMIT)
        .returning("send_count")
        .executeTakeFirst();
      if (!usage) return null;

      const grandfatheringExpired = recipient.state === "grandfathered"
        && recipient.grandfathered_until !== null
        && new Date(recipient.grandfathered_until).getTime() <= input.now.getTime();
      const nextState = recipient.state === "revoked" || grandfatheringExpired ? "pending" : recipient.state;
      const reserved = await transaction.updateTable("notification_recipient_confirmations")
        .set({
          confirmation_sent_at: input.now,
          confirmation_generation: sql`confirmation_generation + 1`,
          state: nextState,
          grandfathered_until: nextState === "pending" ? null : undefined,
          revoked_at: recipient.state === "revoked" ? null : undefined,
          requires_confirmation: recipient.state === "revoked" ? true : undefined,
          updated_at: input.now,
        })
        .where("id", "=", recipient.id)
        .returning("confirmation_generation")
        .executeTakeFirstOrThrow();
      return { recipientId: recipient.id, generation: reserved.confirmation_generation };
    });
  }

  async confirm(recipientId: string, generation: number, now: Date): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const recipient = await transaction.selectFrom("notification_recipient_confirmations")
        .select(["state", "confirmation_generation", "grandfathered_until"])
        .where("id", "=", recipientId)
        .forUpdate()
        .executeTakeFirst();
      if (!recipient || recipient.confirmation_generation !== generation) return false;
      const confirmable = recipient.state === "pending"
        || (recipient.state === "grandfathered"
          && recipient.grandfathered_until !== null
          && new Date(recipient.grandfathered_until).getTime() > now.getTime());
      if (!confirmable) return false;
      await transaction.updateTable("notification_recipient_confirmations")
        .set({ state: "confirmed", grandfathered_until: null, confirmed_at: now, revoked_at: null, requires_confirmation: false, updated_at: now })
        .where("id", "=", recipientId)
        .execute();
      return true;
    });
  }

  async releaseConfirmationSend(recipientId: string, generation: number, reservedAt: Date): Promise<void> {
    await this.db.updateTable("notification_recipient_confirmations")
      .set({ confirmation_sent_at: null, updated_at: currentTimestamp() })
      .where("id", "=", recipientId)
      .where("confirmation_generation", "=", generation)
      .where("confirmation_sent_at", "=", reservedAt)
      .where("state", "in", ["pending", "grandfathered"])
      .execute();
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

  async suppress(input: {
    email: string;
    reason: "hard_bounce" | "complaint";
    provider: string;
    providerEventId: string;
  }): Promise<void> {
    const email = normalizeEmail(input.email);
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
