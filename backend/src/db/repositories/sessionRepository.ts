import { randomUUID } from "node:crypto";
import { sql } from "kysely";

import type { Db } from "../../shared/infra/kysely/types.js";
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

const sessionColumns = [
  "id",
  "user_id",
  "account_id",
  "session_token_hash",
  "created_at",
  "expires_at",
  "last_seen_at",
  "revoked_at",
] as const;

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
  constructor(private readonly db: Db) {}

  async create(params: { userId: string; accountId: string; sessionTokenHash: string; expiresAt: Date }): Promise<SessionRecord> {
    const row = await this.db
      .insertInto("sessions")
      .values({
        id: randomUUID(),
        user_id: params.userId,
        account_id: params.accountId,
        session_token_hash: params.sessionTokenHash,
        expires_at: params.expiresAt,
      })
      .returning(sessionColumns)
      .executeTakeFirstOrThrow();

    return mapSession(row);
  }

  async findActiveByTokenHash(sessionTokenHash: string, now: Date): Promise<SessionRecord | null> {
    const row = await this.db
      .selectFrom("sessions")
      .select(sessionColumns)
      .where("session_token_hash", "=", sessionTokenHash)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", now)
      .where(sql<boolean>`EXISTS (
        SELECT 1 FROM users account_user
        WHERE account_user.id = sessions.user_id AND account_user.disabled_at IS NULL
      )`)
      .executeTakeFirst();

    return row ? mapSession(row) : null;
  }

  async touch(sessionId: string, lastSeenAt: Date): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({ last_seen_at: lastSeenAt })
      .where("id", "=", sessionId)
      .execute();
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<number> {
    const result = await this.db
      .updateTable("sessions")
      .set({ revoked_at: revokedAt })
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }
}
