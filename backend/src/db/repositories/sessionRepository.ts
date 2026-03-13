import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import type { SessionRecord, SessionRepositoryPort } from "../../modules/auth/services/authService.js";

interface SessionRow {
  id: string;
  account_id: string;
  session_token_hash: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

const mapSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  accountId: row.account_id,
  sessionTokenHash: row.session_token_hash,
  createdAt: new Date(row.created_at),
  expiresAt: new Date(row.expires_at),
  lastSeenAt: new Date(row.last_seen_at),
  revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
});

export class SessionRepository implements SessionRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(params: { accountId: string; sessionTokenHash: string; expiresAt: Date }): Promise<SessionRecord> {
    const [row] = await this.database.query<SessionRow>(
      `INSERT INTO sessions (id, account_id, session_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, account_id, session_token_hash, created_at, expires_at, last_seen_at, revoked_at`,
      [randomUUID(), params.accountId, params.sessionTokenHash, params.expiresAt],
    );

    return mapSession(row);
  }

  async findActiveByTokenHash(sessionTokenHash: string, now: Date): Promise<SessionRecord | null> {
    const [row] = await this.database.query<SessionRow>(
      `SELECT id, account_id, session_token_hash, created_at, expires_at, last_seen_at, revoked_at
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
}
