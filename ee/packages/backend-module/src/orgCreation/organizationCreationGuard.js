const DEFAULT_MONTHLY_LIMIT = 10;
const queryRows = async (client, text, params = []) => {
    const result = await client.query(text, params);
    return Array.isArray(result) ? result : result.rows;
};
const toIsoDate = (date) => date.toISOString().slice(0, 10);
const currentPeriodStart = (date = new Date()) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
const nextPeriodStart = (periodStart) => {
    const [year, month] = periodStart.split("-").map((part) => Number(part));
    return new Date(Date.UTC(year, month, 1)).toISOString();
};
const toNullableNumber = (value) => {
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
export class OrganizationCreationLimitExceededError extends Error {
    statusCode = 429;
    code = "rate_limit_exceeded";
    details;
    constructor(details) {
        super(`Organization creation limit reached. You can create up to ${details.limit} organizations per month. Try again after ${details.resetAt}.`);
        this.name = "OrganizationCreationLimitExceededError";
        this.details = details;
    }
}
export const resolveOrganizationCreationDefaultLimit = () => {
    const parsed = Number(process.env.EE_MAX_ORGS_PER_USER_PER_MONTH);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MONTHLY_LIMIT;
};
const mapOverride = (row) => {
    const monthlyLimit = toNullableNumber(row.monthly_limit);
    return {
        userId: row.user_id,
        monthlyLimit,
        unlimited: monthlyLimit === null,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    };
};
export class EnterpriseOrganizationCreationGuard {
    database;
    defaultLimit;
    now;
    constructor(database, options = {}) {
        this.database = database;
        this.defaultLimit = options.defaultLimit ?? resolveOrganizationCreationDefaultLimit();
        this.now = options.now ?? (() => new Date());
    }
    async reserve(input) {
        const override = await this.getOverride(input.userId);
        if (override?.unlimited) {
            return noopReservation;
        }
        const limit = override?.monthlyLimit ?? this.defaultLimit;
        const periodStart = currentPeriodStart(this.now());
        await queryRows(this.database, `INSERT INTO ee_org_creation_counters (user_id, period_start, used_count)
       VALUES ($1, $2::date, 0)
       ON CONFLICT (user_id, period_start) DO NOTHING`, [input.userId, periodStart]);
        const rows = await queryRows(this.database, `UPDATE ee_org_creation_counters
       SET used_count = used_count + 1,
           updated_at = NOW()
       WHERE user_id = $1
         AND period_start = $2::date
         AND used_count < $3
       RETURNING used_count`, [input.userId, periodStart, limit]);
        if (rows.length === 0) {
            const [counter] = await queryRows(this.database, `SELECT used_count
         FROM ee_org_creation_counters
         WHERE user_id = $1 AND period_start = $2::date`, [input.userId, periodStart]);
            throw new OrganizationCreationLimitExceededError({
                limit,
                used: counter?.used_count ?? limit,
                periodStart,
                resetAt: nextPeriodStart(periodStart),
            });
        }
        return new EnterpriseOrganizationCreationReservation(this.database, input.userId, periodStart);
    }
    async getOverride(userId) {
        const [row] = await queryRows(this.database, `SELECT user_id, monthly_limit, updated_at
       FROM ee_org_creation_overrides
       WHERE user_id = $1`, [userId]);
        return row ? mapOverride(row) : null;
    }
    async upsertOverride(input) {
        const [row] = await queryRows(this.database, `INSERT INTO ee_org_creation_overrides (user_id, monthly_limit)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit, updated_at = NOW()
       RETURNING user_id, monthly_limit, updated_at`, [input.userId, input.monthlyLimit]);
        return mapOverride(row);
    }
    async deleteOverride(userId) {
        await queryRows(this.database, `DELETE FROM ee_org_creation_overrides WHERE user_id = $1`, [userId]);
    }
}
class EnterpriseOrganizationCreationReservation {
    database;
    userId;
    periodStart;
    completed = false;
    constructor(database, userId, periodStart) {
        this.database = database;
        this.userId = userId;
        this.periodStart = periodStart;
    }
    async commit() {
        this.completed = true;
    }
    async release() {
        if (this.completed) {
            return;
        }
        this.completed = true;
        await queryRows(this.database, `UPDATE ee_org_creation_counters
       SET used_count = GREATEST(used_count - 1, 0),
           updated_at = NOW()
       WHERE user_id = $1 AND period_start = $2::date`, [this.userId, this.periodStart]);
    }
}
const noopReservation = {
    async commit() { },
    async release() { },
};
export const orgCreationPeriodForTest = {
    currentPeriodStart,
    nextPeriodStart,
    toIsoDate,
};
