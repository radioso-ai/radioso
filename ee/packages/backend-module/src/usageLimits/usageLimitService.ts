import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { createEeKysely, type EeDb } from "../db/eeSchema.js";
import type {
  IndexedStorageReservationInput,
  MonthlyIndexedContentReservationInput,
  UsageLimitDatabasePort,
  UsageLimitPolicy,
  UsageLimitReservation,
} from "../radiosoModuleTypes.js";
import { UsageLimitExceededError } from "./errors.js";

export interface UsageLimitProfile {
  key: string;
  displayName: string;
  monthlyAnswerLimit: number | null;
  storedDocumentLimit: number | null;
  storedIndexedByteLimit: number | null;
  monthlyIndexedByteLimit: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountUsageSummary {
  accountId: string;
  profile: UsageLimitProfile | null;
  monthlyAnswers: {
    periodStart: string;
    resetAt: string;
    used: number;
    limit: number | null;
  };
  storedDocuments: {
    used: number;
    limit: number | null;
  };
  storedIndexedBytes: {
    used: number;
    limit: number | null;
  };
  monthlyIndexedBytes: {
    periodStart: string;
    resetAt: string;
    used: number;
    limit: number | null;
  };
}

const DOCUMENT_RESERVATION_TTL_MS = 10 * 60 * 1000;
const STORAGE_RESERVATION_TTL_MS = 10 * 60 * 1000;

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

const currentPeriodStart = (date = new Date()): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;

const nextPeriodStart = (periodStart: string): string => {
  const [year, month] = periodStart.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month, 1));
  return date.toISOString();
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

const mapProfile = (row: {
  key: string;
  display_name: string;
  monthly_answer_limit: number | null;
  stored_document_limit: number | null;
  stored_indexed_byte_limit: number | string | null;
  monthly_indexed_byte_limit: number | string | null;
  created_at: Date;
  updated_at: Date;
}): UsageLimitProfile => ({
  key: row.key,
  displayName: row.display_name,
  monthlyAnswerLimit: row.monthly_answer_limit,
  storedDocumentLimit: row.stored_document_limit,
  storedIndexedByteLimit: toNullableNumber(row.stored_indexed_byte_limit),
  monthlyIndexedByteLimit: toNullableNumber(row.monthly_indexed_byte_limit),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export class EnterpriseUsageLimitService implements UsageLimitPolicy {
  private readonly db: EeDb;

  constructor(private readonly database: UsageLimitDatabasePort) {
    this.db = createEeKysely(this.database.pool);
  }

  async listProfiles(): Promise<UsageLimitProfile[]> {
    const rows = await this.db
      .selectFrom("ee_usage_limit_profiles")
      .select([
        "key",
        "display_name",
        "monthly_answer_limit",
        "stored_document_limit",
        "stored_indexed_byte_limit",
        "monthly_indexed_byte_limit",
        "created_at",
        "updated_at",
      ])
      .orderBy("key", "asc")
      .execute();

    return rows.map(mapProfile);
  }

  async upsertProfile(input: {
    key: string;
    displayName: string;
    monthlyAnswerLimit: number | null;
    storedDocumentLimit: number | null;
    storedIndexedByteLimit?: number | null;
    monthlyIndexedByteLimit?: number | null;
  }): Promise<UsageLimitProfile> {
    const row = await this.db
      .insertInto("ee_usage_limit_profiles")
      .values({
        key: input.key,
        display_name: input.displayName,
        monthly_answer_limit: input.monthlyAnswerLimit,
        stored_document_limit: input.storedDocumentLimit,
        stored_indexed_byte_limit:
          input.storedIndexedByteLimit === null || input.storedIndexedByteLimit === undefined
            ? null
            : String(input.storedIndexedByteLimit),
        monthly_indexed_byte_limit:
          input.monthlyIndexedByteLimit === null || input.monthlyIndexedByteLimit === undefined
            ? null
            : String(input.monthlyIndexedByteLimit),
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          display_name: (eb) => eb.ref("excluded.display_name"),
          monthly_answer_limit: (eb) => eb.ref("excluded.monthly_answer_limit"),
          stored_document_limit: (eb) => eb.ref("excluded.stored_document_limit"),
          stored_indexed_byte_limit: (eb) => eb.ref("excluded.stored_indexed_byte_limit"),
          monthly_indexed_byte_limit: (eb) => eb.ref("excluded.monthly_indexed_byte_limit"),
          updated_at: sql<Date>`now()`,
        }),
      )
      .returning([
        "key",
        "display_name",
        "monthly_answer_limit",
        "stored_document_limit",
        "stored_indexed_byte_limit",
        "monthly_indexed_byte_limit",
        "created_at",
        "updated_at",
      ])
      .executeTakeFirstOrThrow();

    return mapProfile(row);
  }

  async assignProfile(accountId: string, profileKey: string | null): Promise<AccountUsageSummary> {
    if (profileKey === null) {
      await this.db
        .deleteFrom("ee_usage_limit_account_assignments")
        .where("account_id", "=", accountId)
        .execute();
      return this.getAccountUsage(accountId);
    }

    await this.db
      .insertInto("ee_usage_limit_account_assignments")
      .values({ account_id: accountId, profile_key: profileKey })
      .onConflict((oc) =>
        oc.column("account_id").doUpdateSet({
          profile_key: (eb) => eb.ref("excluded.profile_key"),
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();

    return this.getAccountUsage(accountId);
  }

  async getAccountUsage(accountId: string, periodStart = currentPeriodStart()): Promise<AccountUsageSummary> {
    const profile = await this.findProfileForAccount(accountId);
    const answerCounter = await this.db
      .selectFrom("ee_usage_limit_answer_counters")
      .select("used_count")
      .where("account_id", "=", accountId)
      .where("period_start", "=", sql<string>`${periodStart}::date`)
      .executeTakeFirst();
    const persistedAnswerCount = await this.countPersistedAssistantAnswers(accountId, periodStart);
    const storedDocumentCount = await this.countStoredDocuments(accountId, this.db, false);
    const storedIndexedBytes = await this.sumStoredIndexedBytes(accountId, this.db, false);
    const monthlyIndexedBytes = await this.readMonthlyIndexedBytes(accountId, periodStart);

    return {
      accountId,
      profile,
      monthlyAnswers: {
        periodStart,
        resetAt: nextPeriodStart(periodStart),
        used: Math.max(answerCounter?.used_count ?? 0, persistedAnswerCount),
        limit: profile?.monthlyAnswerLimit ?? null,
      },
      storedDocuments: {
        used: storedDocumentCount,
        limit: profile?.storedDocumentLimit ?? null,
      },
      storedIndexedBytes: {
        used: storedIndexedBytes,
        limit: profile?.storedIndexedByteLimit ?? null,
      },
      monthlyIndexedBytes: {
        periodStart,
        resetAt: nextPeriodStart(periodStart),
        used: monthlyIndexedBytes,
        limit: profile?.monthlyIndexedByteLimit ?? null,
      },
    };
  }

  async reserveAnswer(input: {
    accountId?: string | null;
    workspaceId: string;
    surface: string;
  }): Promise<UsageLimitReservation> {
    const accountId = await this.resolveAccountId(input);
    if (!accountId) {
      return noopReservation;
    }

    const profile = await this.findProfileForAccount(accountId);
    const limit = profile?.monthlyAnswerLimit;
    if (!profile || typeof limit !== "number") {
      return noopReservation;
    }

    const periodStart = currentPeriodStart();
    await this.db
      .insertInto("ee_usage_limit_answer_counters")
      .values({
        account_id: accountId,
        period_start: sql<string>`${periodStart}::date`,
        used_count: 0,
      })
      .onConflict((oc) => oc.columns(["account_id", "period_start"]).doNothing())
      .execute();

    const rows = await this.db
      .updateTable("ee_usage_limit_answer_counters")
      .set({
        used_count: sql<number>`used_count + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where("account_id", "=", accountId)
      .where("period_start", "=", sql<string>`${periodStart}::date`)
      .where("used_count", "<", limit)
      .returning("used_count")
      .execute();

    if (rows.length === 0) {
      const counter = await this.db
        .selectFrom("ee_usage_limit_answer_counters")
        .select("used_count")
        .where("account_id", "=", accountId)
        .where("period_start", "=", sql<string>`${periodStart}::date`)
        .executeTakeFirst();
      throw new UsageLimitExceededError({
        profileKey: profile.key,
        resource: "monthly_answers",
        limit,
        used: counter?.used_count ?? limit,
        periodStart,
        resetAt: nextPeriodStart(periodStart),
      });
    }

    const db = this.db;
    return {
      async commit() {},
      release: async () => {
        await db
          .updateTable("ee_usage_limit_answer_counters")
          .set({
            used_count: sql<number>`greatest(used_count - 1, 0)`,
            updated_at: sql<Date>`now()`,
          })
          .where("account_id", "=", accountId)
          .where("period_start", "=", sql<string>`${periodStart}::date`)
          .execute();
      },
    };
  }

  async reserveMonthlyIndexedContent(input: MonthlyIndexedContentReservationInput): Promise<UsageLimitReservation> {
    const accountId = await this.resolveAccountId(input);
    if (!accountId) {
      return noopReservation;
    }

    const requestedBytes = Math.max(0, Math.floor(input.contentSizeBytes ?? 0));
    if (requestedBytes === 0) {
      return noopReservation;
    }

    const profile = await this.findProfileForAccount(accountId);
    const limit = profile?.monthlyIndexedByteLimit;
    const enforcement = profile && typeof limit === "number"
      ? { profileKey: profile.key, limit }
      : null;

    const periodStart = currentPeriodStart();
    await this.db
      .insertInto("ee_usage_limit_monthly_indexed_byte_counters")
      .values({
        account_id: accountId,
        period_start: sql<string>`${periodStart}::date`,
        used_bytes: "0",
      })
      .onConflict((oc) => oc.columns(["account_id", "period_start"]).doNothing())
      .execute();

    const rows = enforcement
      ? await this.db
          .updateTable("ee_usage_limit_monthly_indexed_byte_counters")
          .set({
            used_bytes: sql<string>`used_bytes + ${requestedBytes}`,
            updated_at: sql<Date>`now()`,
          })
          .where("account_id", "=", accountId)
          .where("period_start", "=", sql<string>`${periodStart}::date`)
          .where(sql<boolean>`used_bytes + ${requestedBytes} <= ${enforcement.limit}`)
          .returning("used_bytes")
          .execute()
      : await this.db
          .updateTable("ee_usage_limit_monthly_indexed_byte_counters")
          .set({
            used_bytes: sql<string>`used_bytes + ${requestedBytes}`,
            updated_at: sql<Date>`now()`,
          })
          .where("account_id", "=", accountId)
          .where("period_start", "=", sql<string>`${periodStart}::date`)
          .returning("used_bytes")
          .execute();

    if (enforcement && rows.length === 0) {
      const used = await this.readMonthlyIndexedBytes(accountId, periodStart);
      throw new UsageLimitExceededError({
        profileKey: enforcement.profileKey,
        resource: "monthly_indexed_bytes",
        limit: enforcement.limit,
        used,
        periodStart,
        resetAt: nextPeriodStart(periodStart),
      });
    }

    const db = this.db;
    return {
      async commit() {},
      release: async () => {
        await db
          .updateTable("ee_usage_limit_monthly_indexed_byte_counters")
          .set({
            used_bytes: sql<string>`greatest(used_bytes - ${requestedBytes}, 0)`,
            updated_at: sql<Date>`now()`,
          })
          .where("account_id", "=", accountId)
          .where("period_start", "=", sql<string>`${periodStart}::date`)
          .execute();
      },
    };
  }

  async reserveIndexedStorage(input: IndexedStorageReservationInput): Promise<UsageLimitReservation> {
    const accountId = await this.resolveAccountId(input);
    if (!accountId) {
      return noopReservation;
    }

    const profile = await this.findProfileForAccount(accountId);
    const limit = profile?.storedIndexedByteLimit;
    if (!profile || typeof limit !== "number") {
      return noopReservation;
    }

    const requestedBytes = Math.max(0, Math.floor(input.contentSizeBytes ?? 0));
    if (requestedBytes === 0) {
      return noopReservation;
    }

    const reservationId = randomUUID();
    await this.db.transaction().execute(async (trx) => {
      await this.lockAccountUsage(trx, accountId);
      await trx
        .deleteFrom("ee_usage_limit_storage_reservations")
        .where("account_id", "=", accountId)
        .where("expires_at", "<=", sql<Date>`now()`)
        .execute();
      const used = await this.sumStoredIndexedBytes(accountId, trx, true);
      if (used + requestedBytes > limit) {
        throw new UsageLimitExceededError({
          profileKey: profile.key,
          resource: "stored_indexed_bytes",
          limit,
          used,
        });
      }

      await trx
        .insertInto("ee_usage_limit_storage_reservations")
        .values({
          id: reservationId,
          account_id: accountId,
          workspace_id: input.workspaceId,
          bytes_reserved: String(requestedBytes),
          expires_at: new Date(Date.now() + STORAGE_RESERVATION_TTL_MS),
        })
        .execute();
    });

    return {
      commit: async () => {
        await this.releaseStorageReservation(reservationId);
      },
      release: async () => {
        await this.releaseStorageReservation(reservationId);
      },
    };
  }

  async reserveDocument(input: {
    accountId?: string | null;
    workspaceId: string;
    sourceKind: string;
    externalDocumentId?: string | null;
  }): Promise<UsageLimitReservation> {
    const accountId = await this.resolveAccountId(input);
    if (!accountId) {
      return noopReservation;
    }

    const profile = await this.findProfileForAccount(accountId);
    const limit = profile?.storedDocumentLimit;
    if (!profile || typeof limit !== "number") {
      return noopReservation;
    }

    if (await this.isExistingInlineExternalDocument(input)) {
      return noopReservation;
    }

    const reservationId = randomUUID();
    await this.db.transaction().execute(async (trx) => {
      await this.lockAccountUsage(trx, accountId);
      await trx
        .deleteFrom("ee_usage_limit_document_reservations")
        .where("account_id", "=", accountId)
        .where("expires_at", "<=", sql<Date>`now()`)
        .execute();
      const used = await this.countStoredDocuments(accountId, trx, true);
      if (used >= limit) {
        throw new UsageLimitExceededError({
          profileKey: profile.key,
          resource: "stored_documents",
          limit,
          used,
        });
      }

      await trx
        .insertInto("ee_usage_limit_document_reservations")
        .values({
          id: reservationId,
          account_id: accountId,
          workspace_id: input.workspaceId,
          expires_at: new Date(Date.now() + DOCUMENT_RESERVATION_TTL_MS),
        })
        .execute();
    });

    return {
      commit: async () => {
        await this.releaseDocumentReservation(reservationId);
      },
      release: async () => {
        await this.releaseDocumentReservation(reservationId);
      },
    };
  }

  private async lockAccountUsage(db: EeDb, accountId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`.execute(db);
  }

  private async resolveAccountId(input: {
    accountId?: string | null;
    workspaceId: string;
  }): Promise<string | null> {
    if (input.accountId) {
      return input.accountId;
    }

    const workspace = await this.db
      .selectFrom("workspaces")
      .select("account_id")
      .where("id", "=", input.workspaceId)
      .executeTakeFirst();
    return workspace?.account_id ?? null;
  }

  private async findProfileForAccount(accountId: string): Promise<UsageLimitProfile | null> {
    const row = await this.db
      .selectFrom("ee_usage_limit_account_assignments as a")
      .innerJoin("ee_usage_limit_profiles as p", "p.key", "a.profile_key")
      .select([
        "p.key",
        "p.display_name",
        "p.monthly_answer_limit",
        "p.stored_document_limit",
        "p.stored_indexed_byte_limit",
        "p.monthly_indexed_byte_limit",
        "p.created_at",
        "p.updated_at",
      ])
      .where("a.account_id", "=", accountId)
      .executeTakeFirst();

    return row ? mapProfile(row) : null;
  }

  private async sumStoredIndexedBytes(
    accountId: string,
    db: EeDb,
    includeReservations: boolean,
  ): Promise<number> {
    const row = await db
      .selectFrom("documents as d")
      .innerJoin("workspaces as w", "w.id", "d.workspace_id")
      .select(sql<string>`coalesce(sum(d.content_size_bytes), 0)::text`.as("bytes"))
      .where("w.account_id", "=", accountId)
      .executeTakeFirst();
    const documentBytes = Number(row?.bytes ?? "0");
    if (!includeReservations) {
      return documentBytes;
    }

    const reservations = await db
      .selectFrom("ee_usage_limit_storage_reservations")
      .select(sql<string>`coalesce(sum(bytes_reserved), 0)::text`.as("bytes"))
      .where("account_id", "=", accountId)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();

    return documentBytes + Number(reservations?.bytes ?? "0");
  }

  private async readMonthlyIndexedBytes(accountId: string, periodStart: string): Promise<number> {
    const row = await this.db
      .selectFrom("ee_usage_limit_monthly_indexed_byte_counters")
      .select("used_bytes")
      .where("account_id", "=", accountId)
      .where("period_start", "=", sql<string>`${periodStart}::date`)
      .executeTakeFirst();
    return Number(row?.used_bytes ?? 0);
  }

  private async releaseStorageReservation(reservationId: string): Promise<void> {
    await this.db
      .deleteFrom("ee_usage_limit_storage_reservations")
      .where("id", "=", reservationId)
      .execute();
  }

  private async countPersistedAssistantAnswers(accountId: string, periodStart: string): Promise<number> {
    const answers = await this.db
      .selectFrom("messages as m")
      .innerJoin("workspaces as w", "w.id", "m.workspace_id")
      .select(sql<string>`count(*)::text`.as("count"))
      .where("w.account_id", "=", accountId)
      .where("m.role", "=", "assistant")
      .where("m.created_at", ">=", sql<Date>`${periodStart}::date`)
      .where("m.created_at", "<", sql<Date>`${nextPeriodStart(periodStart)}::timestamptz`)
      .executeTakeFirst();

    return Number(answers?.count ?? "0");
  }

  private async countStoredDocuments(
    accountId: string,
    db: EeDb,
    includeReservations: boolean,
  ): Promise<number> {
    const documents = await db
      .selectFrom("documents as d")
      .innerJoin("workspaces as w", "w.id", "d.workspace_id")
      .select(sql<string>`count(*)::text`.as("count"))
      .where("w.account_id", "=", accountId)
      .executeTakeFirst();
    const documentCount = Number(documents?.count ?? "0");
    if (!includeReservations) {
      return documentCount;
    }

    const reservations = await db
      .selectFrom("ee_usage_limit_document_reservations")
      .select(sql<string>`count(*)::text`.as("count"))
      .where("account_id", "=", accountId)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();

    return documentCount + Number(reservations?.count ?? "0");
  }

  private async isExistingInlineExternalDocument(input: {
    workspaceId: string;
    sourceKind: string;
    externalDocumentId?: string | null;
  }): Promise<boolean> {
    if (input.sourceKind !== "inline_text" || !input.externalDocumentId) {
      return false;
    }

    const row = await this.db
      .selectFrom("documents")
      .select("id")
      .where("workspace_id", "=", input.workspaceId)
      .where("external_document_id", "=", input.externalDocumentId)
      .where("source_kind", "=", "inline_text")
      .limit(1)
      .executeTakeFirst();

    return row !== undefined;
  }

  private async releaseDocumentReservation(reservationId: string): Promise<void> {
    await this.db
      .deleteFrom("ee_usage_limit_document_reservations")
      .where("id", "=", reservationId)
      .execute();
  }
}

const noopReservation: UsageLimitReservation = {
  async commit() {},
  async release() {},
};

export const normalizePeriodStart = (value: string | undefined): string => {
  if (!value) {
    return currentPeriodStart();
  }

  const date = new Date(`${value}-01T00:00:00.000Z`);
  return toIsoDate(date);
};
