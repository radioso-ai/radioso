import { randomUUID } from "node:crypto";

import type { Db } from "../../shared/infra/kysely/types.js";

export interface PasswordResetTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

interface PasswordResetTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

const passwordResetTokenColumns = [
  "id",
  "user_id",
  "token_hash",
  "expires_at",
  "used_at",
  "created_at",
] as const;

const mapPasswordResetToken = (row: PasswordResetTokenRow): PasswordResetTokenRecord => ({
  id: row.id,
  userId: row.user_id,
  tokenHash: row.token_hash,
  expiresAt: new Date(row.expires_at),
  usedAt: row.used_at ? new Date(row.used_at) : null,
  createdAt: new Date(row.created_at),
});

export interface PasswordResetTokenRepositoryPort {
  create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<PasswordResetTokenRecord>;
  findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null>;
  findLatestActiveForUser(userId: string, now: Date): Promise<PasswordResetTokenRecord | null>;
  markUsed(id: string, usedAt: Date): Promise<number>;
  markAllActiveUsedForUser(userId: string, usedAt: Date): Promise<number>;
}

export class PasswordResetTokenRepository implements PasswordResetTokenRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<PasswordResetTokenRecord> {
    const row = await this.db
      .insertInto("password_reset_tokens")
      .values({
        id: randomUUID(),
        user_id: params.userId,
        token_hash: params.tokenHash,
        expires_at: params.expiresAt,
        request_ip: params.requestIp ?? null,
        request_user_agent: params.requestUserAgent ?? null,
      })
      .returning(passwordResetTokenColumns)
      .executeTakeFirstOrThrow();

    return mapPasswordResetToken(row);
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null> {
    const row = await this.db
      .selectFrom("password_reset_tokens")
      .select(passwordResetTokenColumns)
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();

    return row ? mapPasswordResetToken(row) : null;
  }

  async findLatestActiveForUser(userId: string, now: Date): Promise<PasswordResetTokenRecord | null> {
    const row = await this.db
      .selectFrom("password_reset_tokens")
      .select(passwordResetTokenColumns)
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .where("expires_at", ">", now)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapPasswordResetToken(row) : null;
  }

  async markUsed(id: string, usedAt: Date): Promise<number> {
    const result = await this.db
      .updateTable("password_reset_tokens")
      .set({ used_at: usedAt })
      .where("id", "=", id)
      .where("used_at", "is", null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }

  async markAllActiveUsedForUser(userId: string, usedAt: Date): Promise<number> {
    const result = await this.db
      .updateTable("password_reset_tokens")
      .set({ used_at: usedAt })
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .where("expires_at", ">", usedAt)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }
}
