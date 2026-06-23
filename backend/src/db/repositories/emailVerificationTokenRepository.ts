import { randomUUID } from "node:crypto";

import type { Db } from "../../shared/infra/kysely/types.js";

export interface EmailVerificationTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

interface EmailVerificationTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

const emailVerificationTokenColumns = [
  "id",
  "user_id",
  "token_hash",
  "expires_at",
  "used_at",
  "created_at",
] as const;

const mapEmailVerificationToken = (row: EmailVerificationTokenRow): EmailVerificationTokenRecord => ({
  id: row.id,
  userId: row.user_id,
  tokenHash: row.token_hash,
  expiresAt: new Date(row.expires_at),
  usedAt: row.used_at ? new Date(row.used_at) : null,
  createdAt: new Date(row.created_at),
});

export interface EmailVerificationTokenRepositoryPort {
  create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<EmailVerificationTokenRecord>;
  findByTokenHash(tokenHash: string): Promise<EmailVerificationTokenRecord | null>;
  findLatestActiveForUser(userId: string, now: Date): Promise<EmailVerificationTokenRecord | null>;
  markUsed(id: string, usedAt: Date): Promise<void>;
  markAllActiveUsedForUser(userId: string, usedAt: Date): Promise<number>;
}

export class EmailVerificationTokenRepository implements EmailVerificationTokenRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<EmailVerificationTokenRecord> {
    const row = await this.db
      .insertInto("email_verification_tokens")
      .values({
        id: randomUUID(),
        user_id: params.userId,
        token_hash: params.tokenHash,
        expires_at: params.expiresAt,
        request_ip: params.requestIp ?? null,
        request_user_agent: params.requestUserAgent ?? null,
      })
      .returning(emailVerificationTokenColumns)
      .executeTakeFirstOrThrow();

    return mapEmailVerificationToken(row);
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationTokenRecord | null> {
    const row = await this.db
      .selectFrom("email_verification_tokens")
      .select(emailVerificationTokenColumns)
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();

    return row ? mapEmailVerificationToken(row) : null;
  }

  async findLatestActiveForUser(userId: string, now: Date): Promise<EmailVerificationTokenRecord | null> {
    const row = await this.db
      .selectFrom("email_verification_tokens")
      .select(emailVerificationTokenColumns)
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .where("expires_at", ">", now)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapEmailVerificationToken(row) : null;
  }

  // Idempotent: only stamps used_at when not already set, mirroring the prior
  // COALESCE(used_at, $2) write. The persisted value and the void return are identical.
  async markUsed(id: string, usedAt: Date): Promise<void> {
    await this.db
      .updateTable("email_verification_tokens")
      .set({ used_at: usedAt })
      .where("id", "=", id)
      .where("used_at", "is", null)
      .execute();
  }

  async markAllActiveUsedForUser(userId: string, usedAt: Date): Promise<number> {
    const result = await this.db
      .updateTable("email_verification_tokens")
      .set({ used_at: usedAt })
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .where("expires_at", ">", usedAt)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }
}
