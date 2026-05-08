import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import type { SessionRecord, SessionRepositoryPort } from "../../modules/auth/services/authService.js";

interface SessionRow {
  id: string;
  user_id: string;
  account_id: string;
  session_token_hash: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

const mapSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  userId: row.user_id,
  accountId: row.account_id,
  sessionTokenHash: row.session_token_hash,
  createdAt: new Date(row.created_at),
  expiresAt: new Date(row.expires_at),
  lastSeenAt: new Date(row.last_seen_at),
  revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
});

export class SessionRepository implements SessionRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(params: { userId: string; accountId: string; sessionTokenHash: string; expiresAt: Date }): Promise<SessionRecord> {
    const row = await this.database.queryOne<SessionRow>(
      `INSERT INTO sessions (id, user_id, account_id, session_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, account_id, session_token_hash, created_at, expires_at, last_seen_at, revoked_at`,
      [randomUUID(), params.userId, params.accountId, params.sessionTokenHash, params.expiresAt],
    );

    return mapSession(row);
  }

  async findActiveByTokenHash(sessionTokenHash: string, now: Date): Promise<SessionRecord | null> {
    const row = await this.database.queryOptional<SessionRow>(
      `SELECT id, user_id, account_id, session_token_hash, created_at, expires_at, last_seen_at, revoked_at
       FROM sessions
       WHERE session_token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > $2`,
      [sessionTokenHash, now],
    );

    return row ? mapSession(row) : null;
  }

  async touch(sessionId: string, lastSeenAt: Date): Promise<void> {
    await this.database.query(
      `UPDATE sessions
       SET last_seen_at = $2
       WHERE id = $1`,
      [sessionId, lastSeenAt],
    );
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<number> {
    return this.database.execute(
      `UPDATE sessions
       SET revoked_at = $2
       WHERE user_id = $1
         AND revoked_at IS NULL`,
      [userId, revokedAt],
    );
  }
}
