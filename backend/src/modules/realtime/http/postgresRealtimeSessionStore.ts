import type { Db } from "../../../shared/infra/kysely/types.js";
import { sha256 } from "../../auth/contracts/index.js";
import { currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { RealtimeSessionRecord, RealtimeSessionStore } from "../domain/contracts.js";

interface RealtimeSessionRow {
  session_id: string;
  account_id: string;
  user_id: string;
  workspace_id: string;
  expires_at: Date;
}

/** The gateway's one-query auth store; it deliberately avoids AuthService and its graph. */
export class PostgresRealtimeSessionStore implements RealtimeSessionStore {
  constructor(private readonly db: Db) {}

  async lookup(input: { sessionToken: string; workspaceId: string }): Promise<RealtimeSessionRecord | null> {
    const row = await this.db
      .selectFrom("sessions")
      .innerJoin("account_memberships", (join) => join
        .onRef("account_memberships.account_id", "=", "sessions.account_id")
        .onRef("account_memberships.user_id", "=", "sessions.user_id")
        .on("account_memberships.status", "=", "active"))
      .innerJoin("workspaces", (join) => join
        .onRef("workspaces.account_id", "=", "sessions.account_id")
        .on("workspaces.id", "=", input.workspaceId))
      .select([
        "sessions.id as session_id",
        "sessions.account_id",
        "sessions.user_id",
        "workspaces.id as workspace_id",
        "sessions.expires_at",
      ])
      .where("sessions.session_token_hash", "=", sha256(input.sessionToken))
      .where("sessions.revoked_at", "is", null)
      .where("sessions.expires_at", ">", currentTimestamp())
      .executeTakeFirst() as RealtimeSessionRow | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      accountId: row.account_id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      sessionExpiresAt: new Date(row.expires_at),
      sessionActive: true,
      accountMembershipActive: true,
      workspaceOwned: true,
      credentialType: "dashboard_session",
    };
  }

  async touchLastSeen(sessionId: string): Promise<void> {
    await this.db.updateTable("sessions").set({ last_seen_at: currentTimestamp() }).where("id", "=", sessionId).execute();
  }
}
