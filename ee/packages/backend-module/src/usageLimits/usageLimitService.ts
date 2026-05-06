import { randomUUID } from "node:crypto";

import type {
  UsageLimitDatabaseClient,
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
}

const DOCUMENT_RESERVATION_TTL_MS = 10 * 60 * 1000;

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
  const date = new Date(Date.UTC(year, month, 1));
  return date.toISOString();
};

const mapProfile = (row: {
  key: string;
  display_name: string;
  monthly_answer_limit: number | null;
  stored_document_limit: number | null;
  created_at: Date;
  updated_at: Date;
}): UsageLimitProfile => ({
  key: row.key,
  displayName: row.display_name,
  monthlyAnswerLimit: row.monthly_answer_limit,
  storedDocumentLimit: row.stored_document_limit,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export class EnterpriseUsageLimitService implements UsageLimitPolicy {
  constructor(private readonly database: UsageLimitDatabasePort) {}

  async listProfiles(): Promise<UsageLimitProfile[]> {
    const rows = await queryRows<{
      key: string;
      display_name: string;
      monthly_answer_limit: number | null;
      stored_document_limit: number | null;
      created_at: Date;
      updated_at: Date;
    }>(
      this.database,
      `SELECT key, display_name, monthly_answer_limit, stored_document_limit, created_at, updated_at
       FROM ee_usage_limit_profiles
       ORDER BY key ASC`,
    );

    return rows.map(mapProfile);
  }

  async upsertProfile(input: {
    key: string;
    displayName: string;
    monthlyAnswerLimit: number | null;
    storedDocumentLimit: number | null;
  }): Promise<UsageLimitProfile> {
    const [row] = await queryRows<{
      key: string;
      display_name: string;
      monthly_answer_limit: number | null;
      stored_document_limit: number | null;
      created_at: Date;
      updated_at: Date;
    }>(
      this.database,
      `INSERT INTO ee_usage_limit_profiles (
         key,
         display_name,
         monthly_answer_limit,
         stored_document_limit
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         monthly_answer_limit = EXCLUDED.monthly_answer_limit,
         stored_document_limit = EXCLUDED.stored_document_limit,
         updated_at = NOW()
       RETURNING key, display_name, monthly_answer_limit, stored_document_limit, created_at, updated_at`,
      [input.key, input.displayName, input.monthlyAnswerLimit, input.storedDocumentLimit],
    );

    return mapProfile(row);
  }

  async assignProfile(accountId: string, profileKey: string | null): Promise<AccountUsageSummary> {
    if (profileKey === null) {
      await queryRows(
        this.database,
        `DELETE FROM ee_usage_limit_account_assignments WHERE account_id = $1`,
        [accountId],
      );
      return this.getAccountUsage(accountId);
    }

    await queryRows(
      this.database,
      `INSERT INTO ee_usage_limit_account_assignments (account_id, profile_key)
       VALUES ($1, $2)
       ON CONFLICT (account_id)
       DO UPDATE SET profile_key = EXCLUDED.profile_key, updated_at = NOW()`,
      [accountId, profileKey],
    );

    return this.getAccountUsage(accountId);
  }

  async getAccountUsage(accountId: string, periodStart = currentPeriodStart()): Promise<AccountUsageSummary> {
    const profile = await this.findProfileForAccount(accountId);
    const [answerCounter] = await queryRows<{ used_count: number }>(
      this.database,
      `SELECT used_count
       FROM ee_usage_limit_answer_counters
       WHERE account_id = $1 AND period_start = $2::date`,
      [accountId, periodStart],
    );
    const persistedAnswerCount = await this.countPersistedAssistantAnswers(accountId, periodStart);
    const storedDocumentCount = await this.countStoredDocuments(accountId, this.database, false);

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
    await queryRows(
      this.database,
      `INSERT INTO ee_usage_limit_answer_counters (account_id, period_start, used_count)
       VALUES ($1, $2::date, 0)
       ON CONFLICT (account_id, period_start) DO NOTHING`,
      [accountId, periodStart],
    );

    const rows = await queryRows<{ used_count: number }>(
      this.database,
      `UPDATE ee_usage_limit_answer_counters
       SET used_count = used_count + 1,
           updated_at = NOW()
       WHERE account_id = $1
         AND period_start = $2::date
         AND used_count < $3
       RETURNING used_count`,
      [accountId, periodStart, limit],
    );

    if (rows.length === 0) {
      const [counter] = await queryRows<{ used_count: number }>(
        this.database,
        `SELECT used_count
         FROM ee_usage_limit_answer_counters
         WHERE account_id = $1 AND period_start = $2::date`,
        [accountId, periodStart],
      );
      throw new UsageLimitExceededError({
        profileKey: profile.key,
        resource: "monthly_answers",
        limit,
        used: counter?.used_count ?? limit,
        periodStart,
        resetAt: nextPeriodStart(periodStart),
      });
    }

    return {
      async commit() {},
      release: async () => {
        await queryRows(
          this.database,
          `UPDATE ee_usage_limit_answer_counters
           SET used_count = GREATEST(used_count - 1, 0),
               updated_at = NOW()
           WHERE account_id = $1 AND period_start = $2::date`,
          [accountId, periodStart],
        );
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
    await this.withTransaction(async (client) => {
      await this.lockAccountUsage(client, accountId);
      await queryRows(
        client,
        `DELETE FROM ee_usage_limit_document_reservations
         WHERE account_id = $1 AND expires_at <= NOW()`,
        [accountId],
      );
      const used = await this.countStoredDocuments(accountId, client, true);
      if (used >= limit) {
        throw new UsageLimitExceededError({
          profileKey: profile.key,
          resource: "stored_documents",
          limit,
          used,
        });
      }

      await queryRows(
        client,
        `INSERT INTO ee_usage_limit_document_reservations (
           id,
           account_id,
           workspace_id,
           expires_at
         )
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [
          reservationId,
          accountId,
          input.workspaceId,
          new Date(Date.now() + DOCUMENT_RESERVATION_TTL_MS).toISOString(),
        ],
      );
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

  private async withTransaction<T>(callback: (client: UsageLimitDatabaseClient) => Promise<T>): Promise<T> {
    if (!this.database.withTransaction) {
      throw new Error("Usage limit enforcement requires transactional database support");
    }

    return this.database.withTransaction(callback);
  }

  private async lockAccountUsage(client: UsageLimitDatabaseClient, accountId: string): Promise<void> {
    await queryRows(
      client,
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [accountId],
    );
  }

  private async resolveAccountId(input: {
    accountId?: string | null;
    workspaceId: string;
  }): Promise<string | null> {
    if (input.accountId) {
      return input.accountId;
    }

    const [workspace] = await queryRows<{ account_id: string }>(
      this.database,
      `SELECT account_id FROM workspaces WHERE id = $1`,
      [input.workspaceId],
    );
    return workspace?.account_id ?? null;
  }

  private async findProfileForAccount(accountId: string): Promise<UsageLimitProfile | null> {
    const [row] = await queryRows<{
      key: string;
      display_name: string;
      monthly_answer_limit: number | null;
      stored_document_limit: number | null;
      created_at: Date;
      updated_at: Date;
    }>(
      this.database,
      `SELECT p.key, p.display_name, p.monthly_answer_limit, p.stored_document_limit, p.created_at, p.updated_at
       FROM ee_usage_limit_account_assignments a
       JOIN ee_usage_limit_profiles p ON p.key = a.profile_key
       WHERE a.account_id = $1`,
      [accountId],
    );

    return row ? mapProfile(row) : null;
  }

  private async countPersistedAssistantAnswers(accountId: string, periodStart: string): Promise<number> {
    const [answers] = await queryRows<{ count: string }>(
      this.database,
      `SELECT COUNT(*)::text AS count
       FROM messages m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE w.account_id = $1
         AND m.role = 'assistant'
         AND m.created_at >= $2::date
         AND m.created_at < $3::timestamptz`,
      [accountId, periodStart, nextPeriodStart(periodStart)],
    );

    return Number(answers?.count ?? "0");
  }

  private async countStoredDocuments(
    accountId: string,
    client: UsageLimitDatabaseClient,
    includeReservations: boolean,
  ): Promise<number> {
    const [documents] = await queryRows<{ count: string }>(
      client,
      `SELECT COUNT(*)::text AS count
       FROM documents d
       JOIN workspaces w ON w.id = d.workspace_id
       WHERE w.account_id = $1`,
      [accountId],
    );
    const documentCount = Number(documents?.count ?? "0");
    if (!includeReservations) {
      return documentCount;
    }

    const [reservations] = await queryRows<{ count: string }>(
      client,
      `SELECT COUNT(*)::text AS count
       FROM ee_usage_limit_document_reservations
       WHERE account_id = $1 AND expires_at > NOW()`,
      [accountId],
    );

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

    const rows = await queryRows<{ id: string }>(
      this.database,
      `SELECT id
       FROM documents
       WHERE workspace_id = $1
         AND external_document_id = $2
         AND source_kind = 'inline_text'
       LIMIT 1`,
      [input.workspaceId, input.externalDocumentId],
    );

    return rows.length > 0;
  }

  private async releaseDocumentReservation(reservationId: string): Promise<void> {
    await queryRows(
      this.database,
      `DELETE FROM ee_usage_limit_document_reservations WHERE id = $1`,
      [reservationId],
    );
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
