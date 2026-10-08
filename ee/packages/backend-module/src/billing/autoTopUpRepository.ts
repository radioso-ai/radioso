import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { EeDb } from "../db/eeSchema.js";

/**
 * The account-level opt-in: whether auto top-up is on, and the monthly pack cap the account
 * chose (1..catalog limit). `disabledReason`/`disabledAt` are set only by the webhook, when a
 * charge fails -- never by an operator turning it off themselves.
 */
export interface AutoTopUpSettingsRow {
  accountId: string;
  enabled: boolean;
  maxPacksPerMonth: number;
  disabledReason: "payment_failed" | null;
  disabledAt: Date | null;
  updatedByUserId: string | null;
  updatedAt: Date;
}

/**
 * A field is written on conflict only when explicitly named (checked with `hasOwnProperty`),
 * the same source-gated merge convention `billingCustomerRepository.ts` uses -- an enable-only
 * patch must not reset `max_packs_per_month` to some default, and vice versa.
 */
export interface AutoTopUpSettingsPatch {
  accountId: string;
  enabled?: boolean;
  maxPacksPerMonth?: number;
  disabledReason?: "payment_failed" | null;
  disabledAt?: Date | null;
  updatedByUserId?: string | null;
}

/** One attempted pack purchase, from the sweep's `pending` claim through the webhook's
 *  `paid`/`failed` resolution. */
export interface AutoTopUpRow {
  id: string;
  accountId: string;
  periodStart: string;
  status: "pending" | "paid" | "failed";
  stripeInvoiceId: string | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutoTopUpRepository {
  getSettings(accountId: string): Promise<AutoTopUpSettingsRow | null>;
  upsertSettings(patch: AutoTopUpSettingsPatch): Promise<AutoTopUpSettingsRow>;
  /** Enabled accounts, oldest-updated first, bounded so one sweep tick never processes an
   *  unbounded set. */
  listEnabledAccountIds(limit: number): Promise<string[]>;
  /** `pending` + `paid` rows for this account/period -- the sweep's monthly-cap count, and the
   *  same figure `/me` reports back as `packsThisPeriod`. */
  countForPeriod(accountId: string, periodStart: string): Promise<number>;
  /**
   * Atomically claims a pending slot for one pack this period, honoring the pending guard (at
   * most one in-flight row per account), the monthly cap, and the failure cooldown. Returns the
   * new row's id, or `null` when none of the conditions hold -- including when a concurrent
   * caller already claimed one, which is exactly how two sweeps racing the same account produce
   * only one invoice.
   */
  claimPending(input: {
    accountId: string;
    periodStart: string;
    maxPacksPerMonth: number;
    cooldownMs: number;
  }): Promise<string | null>;
  findById(id: string): Promise<AutoTopUpRow | null>;
  markInvoiceCreated(input: { id: string; stripeInvoiceId: string }): Promise<void>;
  markFailed(input: { id: string; failureCode: string }): Promise<void>;
  markPaid(id: string): Promise<void>;
  /** Called only from the webhook, on a failed charge. Never called for an operator's own
   *  opt-out. */
  disable(input: { accountId: string; reason: "payment_failed" }): Promise<void>;
}

const mapSettingsRow = (row: {
  account_id: string;
  enabled: boolean;
  max_packs_per_month: number;
  disabled_reason: string | null;
  disabled_at: Date | null;
  updated_by_user_id: string | null;
  updated_at: Date;
}): AutoTopUpSettingsRow => ({
  accountId: row.account_id,
  enabled: row.enabled,
  maxPacksPerMonth: row.max_packs_per_month,
  disabledReason: row.disabled_reason as "payment_failed" | null,
  disabledAt: row.disabled_at,
  updatedByUserId: row.updated_by_user_id,
  updatedAt: row.updated_at,
});

const mapAutoTopUpRow = (row: {
  id: string;
  account_id: string;
  period_start: string;
  status: string;
  stripe_invoice_id: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}): AutoTopUpRow => ({
  id: row.id,
  accountId: row.account_id,
  periodStart: row.period_start,
  status: row.status as AutoTopUpRow["status"],
  stripeInvoiceId: row.stripe_invoice_id,
  failureCode: row.failure_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class PostgresAutoTopUpRepository implements AutoTopUpRepository {
  private readonly db: EeDb;

  constructor(db: EeDb) {
    this.db = db;
  }

  async getSettings(accountId: string): Promise<AutoTopUpSettingsRow | null> {
    const row = await this.db
      .selectFrom("ee_billing_auto_top_up_settings")
      .selectAll()
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return row ? mapSettingsRow(row) : null;
  }

  async upsertSettings(patch: AutoTopUpSettingsPatch): Promise<AutoTopUpSettingsRow> {
    const hasOwn = (key: keyof AutoTopUpSettingsPatch): boolean =>
      Object.prototype.hasOwnProperty.call(patch, key);

    await this.db
      .insertInto("ee_billing_auto_top_up_settings")
      .values({
        account_id: patch.accountId,
        enabled: patch.enabled ?? false,
        // A bare insert always names a cap -- the route resolves one from the catalog default
        // before calling this -- so there is no catalog dependency here.
        max_packs_per_month: patch.maxPacksPerMonth ?? 1,
        disabled_reason: patch.disabledReason ?? null,
        disabled_at: patch.disabledAt ?? null,
        updated_by_user_id: patch.updatedByUserId ?? null,
      })
      .onConflict((oc) =>
        oc.column("account_id").doUpdateSet({
          ...(hasOwn("enabled") ? { enabled: (eb) => eb.ref("excluded.enabled") } : {}),
          ...(hasOwn("maxPacksPerMonth")
            ? { max_packs_per_month: (eb) => eb.ref("excluded.max_packs_per_month") }
            : {}),
          ...(hasOwn("disabledReason") ? { disabled_reason: (eb) => eb.ref("excluded.disabled_reason") } : {}),
          ...(hasOwn("disabledAt") ? { disabled_at: (eb) => eb.ref("excluded.disabled_at") } : {}),
          ...(hasOwn("updatedByUserId")
            ? { updated_by_user_id: (eb) => eb.ref("excluded.updated_by_user_id") }
            : {}),
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();

    const row = await this.getSettings(patch.accountId);
    if (!row) {
      throw new Error("upsertSettings: row missing immediately after upsert");
    }
    return row;
  }

  async listEnabledAccountIds(limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom("ee_billing_auto_top_up_settings")
      .select("account_id")
      .where("enabled", "=", true)
      .orderBy("updated_at", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => row.account_id);
  }

  async countForPeriod(accountId: string, periodStart: string): Promise<number> {
    const row = await this.db
      .selectFrom("ee_billing_auto_top_ups")
      .select(sql<string>`count(*)`.as("count"))
      .where("account_id", "=", accountId)
      .where("period_start", "=", sql<string>`${periodStart}::date`)
      .where("status", "in", ["pending", "paid"])
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async claimPending(input: {
    accountId: string;
    periodStart: string;
    maxPacksPerMonth: number;
    cooldownMs: number;
  }): Promise<string | null> {
    const root = this.db;
    return root.transaction().execute(async (trx) => {
      // Scoped to this account only (a distinct salt from `usageLimitService`'s own
      // `pg_advisory_xact_lock(hashtextextended(accountId, 0))`, so the two never contend on the
      // same lock key), released automatically at commit/rollback. Serializes this whole
      // check-then-insert per account, which is what makes two concurrent sweeps produce at most
      // one claim: the second blocks here until the first commits, then sees the row it just
      // inserted and returns null instead of racing it.
      await sql`select pg_advisory_xact_lock(hashtextextended(${input.accountId}, 1))`.execute(trx);

      const pending = await trx
        .selectFrom("ee_billing_auto_top_ups")
        .select("id")
        .where("account_id", "=", input.accountId)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (pending) {
        return null;
      }

      const countRow = await trx
        .selectFrom("ee_billing_auto_top_ups")
        .select(sql<string>`count(*)`.as("count"))
        .where("account_id", "=", input.accountId)
        .where("period_start", "=", sql<string>`${input.periodStart}::date`)
        .where("status", "in", ["pending", "paid"])
        .executeTakeFirst();
      if (Number(countRow?.count ?? 0) >= input.maxPacksPerMonth) {
        return null;
      }

      const recentFailure = await trx
        .selectFrom("ee_billing_auto_top_ups")
        .select("id")
        .where("account_id", "=", input.accountId)
        .where("status", "=", "failed")
        .where("created_at", ">", sql<Date>`now() - (${input.cooldownMs} * interval '1 millisecond')`)
        .executeTakeFirst();
      if (recentFailure) {
        return null;
      }

      const id = randomUUID();
      await trx
        .insertInto("ee_billing_auto_top_ups")
        .values({
          id,
          account_id: input.accountId,
          period_start: sql<string>`${input.periodStart}::date`,
          status: "pending",
        })
        .execute();
      return id;
    });
  }

  async findById(id: string): Promise<AutoTopUpRow | null> {
    const row = await this.db
      .selectFrom("ee_billing_auto_top_ups")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapAutoTopUpRow(row) : null;
  }

  async markInvoiceCreated(input: { id: string; stripeInvoiceId: string }): Promise<void> {
    await this.db
      .updateTable("ee_billing_auto_top_ups")
      .set({ stripe_invoice_id: input.stripeInvoiceId, updated_at: sql<Date>`now()` })
      .where("id", "=", input.id)
      .execute();
  }

  async markFailed(input: { id: string; failureCode: string }): Promise<void> {
    await this.db
      .updateTable("ee_billing_auto_top_ups")
      .set({ status: "failed", failure_code: input.failureCode, updated_at: sql<Date>`now()` })
      .where("id", "=", input.id)
      .where("status", "=", "pending")
      .execute();
  }

  async markPaid(id: string): Promise<void> {
    await this.db
      .updateTable("ee_billing_auto_top_ups")
      .set({ status: "paid", updated_at: sql<Date>`now()` })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .execute();
  }

  async disable(input: { accountId: string; reason: "payment_failed" }): Promise<void> {
    await this.db
      .updateTable("ee_billing_auto_top_up_settings")
      .set({
        enabled: false,
        disabled_reason: input.reason,
        disabled_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      })
      .where("account_id", "=", input.accountId)
      .execute();
  }
}

