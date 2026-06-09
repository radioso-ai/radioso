import type {
  OrganizationCreationGuard,
  OrganizationCreationReservation,
  UsageLimitDatabaseClient,
  UsageLimitDatabasePort,
} from "../radiosoModuleTypes.js";

const DEFAULT_MONTHLY_LIMIT = 10;

const queryRows = async <T = Record<string, unknown>>(
  client: UsageLimitDatabaseClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const result = await client.query<T>(text, params);
  return Array.isArray(result) ? result : result.rows;
};

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
  private readonly defaultLimit: number;
  private readonly now: () => Date;

  constructor(
    private readonly database: UsageLimitDatabasePort,
    options: {
      defaultLimit?: number;
      now?: () => Date;
    } = {},
  ) {
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

    await queryRows(
      this.database,
      `INSERT INTO ee_org_creation_counters (user_id, period_start, used_count)
       VALUES ($1, $2::date, 0)
       ON CONFLICT (user_id, period_start) DO NOTHING`,
      [input.userId, periodStart],
    );

    const rows = await queryRows<{ used_count: number }>(
      this.database,
      `UPDATE ee_org_creation_counters
       SET used_count = used_count + 1,
           updated_at = NOW()
       WHERE user_id = $1
         AND period_start = $2::date
         AND used_count < $3
       RETURNING used_count`,
      [input.userId, periodStart, limit],
    );

    if (rows.length === 0) {
      const [counter] = await queryRows<{ used_count: number }>(
        this.database,
        `SELECT used_count
         FROM ee_org_creation_counters
         WHERE user_id = $1 AND period_start = $2::date`,
        [input.userId, periodStart],
      );
      throw new OrganizationCreationLimitExceededError({
        limit,
        used: counter?.used_count ?? limit,
        periodStart,
        resetAt: nextPeriodStart(periodStart),
      });
    }

    return new EnterpriseOrganizationCreationReservation(this.database, input.userId, periodStart);
  }

  async getOverride(userId: string): Promise<OrganizationCreationOverride | null> {
    const [row] = await queryRows<{
      user_id: string;
      monthly_limit: number | string | null;
      updated_at: Date | string;
    }>(
      this.database,
      `SELECT user_id, monthly_limit, updated_at
       FROM ee_org_creation_overrides
       WHERE user_id = $1`,
      [userId],
    );

    return row ? mapOverride(row) : null;
  }

  async upsertOverride(input: { userId: string; monthlyLimit: number | null }): Promise<OrganizationCreationOverride> {
    const [row] = await queryRows<{
      user_id: string;
      monthly_limit: number | string | null;
      updated_at: Date | string;
    }>(
      this.database,
      `INSERT INTO ee_org_creation_overrides (user_id, monthly_limit)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit, updated_at = NOW()
       RETURNING user_id, monthly_limit, updated_at`,
      [input.userId, input.monthlyLimit],
    );

    return mapOverride(row);
  }

  async deleteOverride(userId: string): Promise<void> {
    await queryRows(
      this.database,
      `DELETE FROM ee_org_creation_overrides WHERE user_id = $1`,
      [userId],
    );
  }
}

class EnterpriseOrganizationCreationReservation implements OrganizationCreationReservation {
  private completed = false;

  constructor(
    private readonly database: UsageLimitDatabasePort,
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
    await queryRows(
      this.database,
      `UPDATE ee_org_creation_counters
       SET used_count = GREATEST(used_count - 1, 0),
           updated_at = NOW()
       WHERE user_id = $1 AND period_start = $2::date`,
      [this.userId, this.periodStart],
    );
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
