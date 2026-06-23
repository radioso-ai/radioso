import { sql } from "kysely";

import { createEeKysely, type EeDb } from "../db/eeSchema.js";
import type {
  OrganizationCreationGuard,
  OrganizationCreationReservation,
  UsageLimitDatabasePort,
} from "../radiosoModuleTypes.js";

const DEFAULT_MONTHLY_LIMIT = 10;

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

const currentPeriodStart = (date = new Date()): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;

const nextPeriodStart = (periodStart: string): string => {
  const [year, month] = periodStart.split("-").map((part) => Number(part));
  return new Date(Date.UTC(year, month, 1)).toISOString();
};

const toNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return null;
};

export interface OrganizationCreationOverride {
  userId: string;
  monthlyLimit: number | null;
  unlimited: boolean;
  updatedAt: string;
}

export interface OrganizationCreationLimitDetails {
  limit: number;
  used: number;
  periodStart: string;
  resetAt: string;
}

export class OrganizationCreationLimitExceededError extends Error {
  readonly statusCode = 429;
  readonly code = "rate_limit_exceeded";
  readonly details: OrganizationCreationLimitDetails;

  constructor(details: OrganizationCreationLimitDetails) {
    super(
      `Organization creation limit reached. You can create up to ${details.limit} organizations per month. Try again after ${details.resetAt}.`,
    );
    this.name = "OrganizationCreationLimitExceededError";
    this.details = details;
  }
}

export const resolveOrganizationCreationDefaultLimit = (): number => {
  const parsed = Number(process.env.EE_MAX_ORGS_PER_USER_PER_MONTH);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MONTHLY_LIMIT;
};

const mapOverride = (row: {
  user_id: string;
  monthly_limit: number | string | null;
  updated_at: Date | string;
}): OrganizationCreationOverride => {
  const monthlyLimit = toNullableNumber(row.monthly_limit);
  return {
    userId: row.user_id,
    monthlyLimit,
    unlimited: monthlyLimit === null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
  };
};

export class EnterpriseOrganizationCreationGuard implements OrganizationCreationGuard {
  private readonly db: EeDb;
  private readonly defaultLimit: number;
  private readonly now: () => Date;

  constructor(
    private readonly database: UsageLimitDatabasePort,
    options: {
      defaultLimit?: number;
      now?: () => Date;
    } = {},
  ) {
    this.db = createEeKysely(this.database.pool);
    this.defaultLimit = options.defaultLimit ?? resolveOrganizationCreationDefaultLimit();
    this.now = options.now ?? (() => new Date());
  }

  async reserve(input: { userId: string }): Promise<OrganizationCreationReservation> {
    const override = await this.getOverride(input.userId);
    if (override?.unlimited) {
      return noopReservation;
    }

    const limit = override?.monthlyLimit ?? this.defaultLimit;
    const periodStart = currentPeriodStart(this.now());

    await this.db
      .insertInto("ee_org_creation_counters")
      .values({
        user_id: input.userId,
        period_start: sql<string>`${periodStart}::date`,
        used_count: 0,
      })
      .onConflict((oc) => oc.columns(["user_id", "period_start"]).doNothing())
      .execute();

    const rows = await this.db
      .updateTable("ee_org_creation_counters")
      .set({
        used_count: sql<number>`used_count + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where("user_id", "=", input.userId)
      .where("period_start", "=", sql<string>`${periodStart}::date`)
      .where("used_count", "<", limit)
      .returning("used_count")
      .execute();

    if (rows.length === 0) {
      const counter = await this.db
        .selectFrom("ee_org_creation_counters")
        .select("used_count")
        .where("user_id", "=", input.userId)
        .where("period_start", "=", sql<string>`${periodStart}::date`)
        .executeTakeFirst();
      throw new OrganizationCreationLimitExceededError({
        limit,
        used: counter?.used_count ?? limit,
        periodStart,
        resetAt: nextPeriodStart(periodStart),
      });
    }

    return new EnterpriseOrganizationCreationReservation(this.db, input.userId, periodStart);
  }

  async getOverride(userId: string): Promise<OrganizationCreationOverride | null> {
    const row = await this.db
      .selectFrom("ee_org_creation_overrides")
      .select(["user_id", "monthly_limit", "updated_at"])
      .where("user_id", "=", userId)
      .executeTakeFirst();

    return row ? mapOverride(row) : null;
  }

  async upsertOverride(input: { userId: string; monthlyLimit: number | null }): Promise<OrganizationCreationOverride> {
    const row = await this.db
      .insertInto("ee_org_creation_overrides")
      .values({ user_id: input.userId, monthly_limit: input.monthlyLimit })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          monthly_limit: (eb) => eb.ref("excluded.monthly_limit"),
          updated_at: sql<Date>`now()`,
        }),
      )
      .returning(["user_id", "monthly_limit", "updated_at"])
      .executeTakeFirstOrThrow();

    return mapOverride(row);
  }

  async deleteOverride(userId: string): Promise<void> {
    await this.db
      .deleteFrom("ee_org_creation_overrides")
      .where("user_id", "=", userId)
      .execute();
  }
}

class EnterpriseOrganizationCreationReservation implements OrganizationCreationReservation {
  private completed = false;

  constructor(
    private readonly db: EeDb,
    private readonly userId: string,
    private readonly periodStart: string,
  ) {}

  async commit(): Promise<void> {
    this.completed = true;
  }

  async release(): Promise<void> {
    if (this.completed) {
      return;
    }
    this.completed = true;
    await this.db
      .updateTable("ee_org_creation_counters")
      .set({
        used_count: sql<number>`greatest(used_count - 1, 0)`,
        updated_at: sql<Date>`now()`,
      })
      .where("user_id", "=", this.userId)
      .where("period_start", "=", sql<string>`${this.periodStart}::date`)
      .execute();
  }
}

const noopReservation: OrganizationCreationReservation = {
  async commit() {},
  async release() {},
};

export const orgCreationPeriodForTest = {
  currentPeriodStart,
  nextPeriodStart,
  toIsoDate,
};
