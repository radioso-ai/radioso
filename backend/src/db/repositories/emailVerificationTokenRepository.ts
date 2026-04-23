import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface EmailVerificationTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  requestIp: string | null;
  requestUserAgent: string | null;
}

interface EmailVerificationTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
  request_ip: string | null;
  request_user_agent: string | null;
}

const mapToken = (row: EmailVerificationTokenRow): EmailVerificationTokenRecord => ({
  id: row.id,
  userId: row.user_id,
  tokenHash: row.token_hash,
  expiresAt: new Date(row.expires_at),
  usedAt: row.used_at ? new Date(row.used_at) : null,
  createdAt: new Date(row.created_at),
  requestIp: row.request_ip,
  requestUserAgent: row.request_user_agent,
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
  findLatestActiveByUserId(userId: string, now: Date): Promise<EmailVerificationTokenRecord | null>;
  markUsed(id: string, usedAt: Date): Promise<void>;
  markAllActiveForUserUsed(userId: string, usedAt: Date): Promise<void>;
  markOlderActiveForUserUsed(userId: string, createdBefore: Date, usedAt: Date): Promise<void>;
}

export class EmailVerificationTokenRepository implements EmailVerificationTokenRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<EmailVerificationTokenRecord> {
    const [row] = await this.database.query<EmailVerificationTokenRow>(
      `INSERT INTO email_verification_tokens (
         id,
         user_id,
         token_hash,
         expires_at,
         request_ip,
         request_user_agent
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, token_hash, expires_at, used_at, created_at, request_ip, request_user_agent`,
      [
        randomUUID(),
        params.userId,
        params.tokenHash,
        params.expiresAt,
        params.requestIp ?? null,
        params.requestUserAgent ?? null,
      ],
    );

    return mapToken(row);
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationTokenRecord | null> {
    const [row] = await this.database.query<EmailVerificationTokenRow>(
      `SELECT id, user_id, token_hash, expires_at, used_at, created_at, request_ip, request_user_agent
       FROM email_verification_tokens
       WHERE token_hash = $1`,
      [tokenHash],
    );

    return row ? mapToken(row) : null;
  }

  async findLatestActiveByUserId(userId: string, now: Date): Promise<EmailVerificationTokenRecord | null> {
    const [row] = await this.database.query<EmailVerificationTokenRow>(
      `SELECT id, user_id, token_hash, expires_at, used_at, created_at, request_ip, request_user_agent
       FROM email_verification_tokens
       WHERE user_id = $1
         AND used_at IS NULL
         AND expires_at > $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, now],
    );

    return row ? mapToken(row) : null;
  }

  async markUsed(id: string, usedAt: Date): Promise<void> {
    await this.database.query(
      `UPDATE email_verification_tokens
       SET used_at = COALESCE(used_at, $2)
       WHERE id = $1`,
      [id, usedAt],
    );
  }

  async markAllActiveForUserUsed(userId: string, usedAt: Date): Promise<void> {
    await this.database.query(
      `UPDATE email_verification_tokens
       SET used_at = COALESCE(used_at, $2)
       WHERE user_id = $1
         AND used_at IS NULL
         AND expires_at > $2`,
      [userId, usedAt],
    );
  }

  async markOlderActiveForUserUsed(userId: string, createdBefore: Date, usedAt: Date): Promise<void> {
    await this.database.query(
      `UPDATE email_verification_tokens
       SET used_at = COALESCE(used_at, $3)
       WHERE user_id = $1
         AND created_at < $2
         AND used_at IS NULL
         AND expires_at > $3`,
      [userId, createdBefore, usedAt],
    );
  }
}
