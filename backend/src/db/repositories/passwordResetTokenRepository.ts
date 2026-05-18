import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

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
  constructor(private readonly database: Database) {}

  async create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<PasswordResetTokenRecord> {
    const row = await this.database.queryOne<PasswordResetTokenRow>(
      `INSERT INTO password_reset_tokens (
         id,
         user_id,
         token_hash,
         expires_at,
         request_ip,
         request_user_agent
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, token_hash, expires_at, used_at, created_at`,
      [
        randomUUID(),
        params.userId,
        params.tokenHash,
        params.expiresAt,
        params.requestIp ?? null,
        params.requestUserAgent ?? null,
      ],
    );

    return mapPasswordResetToken(row);
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null> {
    const row = await this.database.queryOptional<PasswordResetTokenRow>(
      `SELECT id, user_id, token_hash, expires_at, used_at, created_at
       FROM password_reset_tokens
       WHERE token_hash = $1`,
      [tokenHash],
    );

    return row ? mapPasswordResetToken(row) : null;
  }

  async findLatestActiveForUser(userId: string, now: Date): Promise<PasswordResetTokenRecord | null> {
    const row = await this.database.queryOptional<PasswordResetTokenRow>(
      `SELECT id, user_id, token_hash, expires_at, used_at, created_at
       FROM password_reset_tokens
       WHERE user_id = $1
         AND used_at IS NULL
         AND expires_at > $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, now],
    );

    return row ? mapPasswordResetToken(row) : null;
  }

  async markUsed(id: string, usedAt: Date): Promise<number> {
    return this.database.execute(
      `UPDATE password_reset_tokens
       SET used_at = $2
       WHERE id = $1
         AND used_at IS NULL`,
      [id, usedAt],
    );
  }

  async markAllActiveUsedForUser(userId: string, usedAt: Date): Promise<number> {
    return this.database.execute(
      `UPDATE password_reset_tokens
       SET used_at = COALESCE(used_at, $2)
       WHERE user_id = $1
         AND used_at IS NULL
         AND expires_at > $2`,
      [userId, usedAt],
    );
  }
}
