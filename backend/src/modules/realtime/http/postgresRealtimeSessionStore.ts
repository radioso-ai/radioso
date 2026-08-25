import type { Db } from "../../../shared/infra/kysely/types.js";
import { currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import { sha256 } from "../../auth/contracts/index.js";
import type { RealtimeSessionRecord, RealtimeSessionStore } from "../domain/contracts.js";

type RealtimeSessionRow = {
  session_id: string;
  account_id: string;
  user_id: string;
  expires_at: Date;
  membership_status: string | null;
  matched_workspace_id: string | null;
  matched_workspace_account_id: string | null;
};

/** One-query auth projection for the isolated realtime runtime. */
export class PostgresRealtimeSessionStore implements RealtimeSessionStore {
  constructor(private readonly db: Db) {}

  async lookup(input: { sessionToken: string; workspaceId: string }): Promise<RealtimeSessionRecord | null> {
    const row = await this.db
      .selectFrom("sessions")
      .leftJoin("account_memberships", (join) => join
        .onRef("account_memberships.account_id", "=", "sessions.account_id")
        .onRef("account_memberships.user_id", "=", "sessions.user_id"))
      .leftJoin("workspaces", (join) => join.on("workspaces.id", "=", input.workspaceId))
      .select([
        "sessions.id as session_id",
        "sessions.account_id",
        "sessions.user_id",
        "sessions.expires_at",
        "account_memberships.status as membership_status",
        "workspaces.id as matched_workspace_id",
        "workspaces.account_id as matched_workspace_account_id",
      ])
      .where("sessions.session_token_hash", "=", sha256(input.sessionToken))
      .where("sessions.revoked_at", "is", null)
      .where("sessions.expires_at", ">", currentTimestamp())
      .executeTakeFirst() as RealtimeSessionRow | undefined;
    if (!row) return null;
    const workspaceOwned = row.matched_workspace_id === input.workspaceId
      && row.matched_workspace_account_id === row.account_id;
    return {
      sessionId: row.session_id,
      accountId: row.account_id,
      userId: row.user_id,
      workspaceId: row.matched_workspace_id ?? input.workspaceId,
      sessionExpiresAt: new Date(row.expires_at),
      sessionActive: true,
      accountMembershipActive: row.membership_status === "active",
      workspaceOwned,
      credentialType: "dashboard_session",
    };
  }

  async touchLastSeen(sessionId: string): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({ last_seen_at: currentTimestamp() })
      .where("id", "=", sessionId)
      .execute();
  }
}
