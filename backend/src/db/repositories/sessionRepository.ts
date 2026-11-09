import type { Db } from "../../shared/infra/kysely/types.js";
import type { ActiveSession, SessionRepositoryPort } from "../../modules/auth/services/authService.js";
import type { EndedSession, SessionSignOutRepositoryPort } from "../../modules/auth/services/sessionSignOutService.js";

interface SessionRow {
  id: string;
  user_id: string;
  account_id: string;
  session_token_hash: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  credential_generation: number;
}

const mapSession = (row: SessionRow): ActiveSession => ({
  id: row.id,
  userId: row.user_id,
  accountId: row.account_id,
  sessionTokenHash: row.session_token_hash,
  createdAt: new Date(row.created_at),
  expiresAt: new Date(row.expires_at),
  lastSeenAt: new Date(row.last_seen_at),
  revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  userCredentialGeneration: row.credential_generation,
});

export class SessionRepository implements SessionRepositoryPort, SessionSignOutRepositoryPort {
  constructor(private readonly db: Db) {}

  // The user's credential generation comes from the same statement that finds
  // the session live. A reset revokes the session and advances the generation in
  // one transaction (as does federated recovery), so whoever acts on this session
  // presents the generation it was live under, which a later reset supersedes.
  async findActiveByTokenHash(sessionTokenHash: string, now: Date): Promise<ActiveSession | null> {
    const row = await this.db
      .selectFrom("sessions")
      .innerJoin("users as account_user", "account_user.id", "sessions.user_id")
      .select([
        "sessions.id",
        "sessions.user_id",
        "sessions.account_id",
        "sessions.session_token_hash",
        "sessions.created_at",
        "sessions.expires_at",
        "sessions.last_seen_at",
        "sessions.revoked_at",
        "account_user.credential_generation",
      ])
      .where("sessions.session_token_hash", "=", sessionTokenHash)
      .where("sessions.revoked_at", "is", null)
      .where("sessions.expires_at", ">", now)
      .where("account_user.disabled_at", "is", null)
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

  // Only a session not yet revoked is touched, so a repeat finds nothing to end.
  async revokeByTokenHash(sessionTokenHash: string, revokedAt: Date): Promise<EndedSession | null> {
    const row = await this.db
      .updateTable("sessions")
      .set({ revoked_at: revokedAt })
      .where("session_token_hash", "=", sessionTokenHash)
      .where("revoked_at", "is", null)
      .returning(["id", "user_id", "account_id"])
      .executeTakeFirst();

    return row ? { sessionId: row.id, userId: row.user_id, accountId: row.account_id } : null;
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
