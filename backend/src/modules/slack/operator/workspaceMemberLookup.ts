import type { Db } from "../../../shared/infra/kysely/types.js";
import type {
  SlackOperatorPermissionPort,
  WorkspaceMemberLookupPort,
  WorkspaceMemberLookupResult,
} from "./slackOperatorIdentityResolver.js";

/**
 * Resolve a workspace member by email and check operator authorization. A member is anyone
 * who owns the workspace (`workspaces.account_id`) or holds a grant on it (`workspace_grants`)
 * via an active account membership. Mirrors the access model used elsewhere; expressed with
 * the Kysely builder so it stays inside the no-raw-SQL boundary.
 */
export class PostgresWorkspaceMemberLookup implements WorkspaceMemberLookupPort {
  constructor(private readonly db: Db) {}

  async findByEmail(workspaceId: string, email: string): Promise<WorkspaceMemberLookupResult | null> {
    const row = await this.db
      .selectFrom("accounts as a")
      .innerJoin("account_memberships as m", (join) =>
        join.onRef("m.account_id", "=", "a.id").on("m.status", "=", "active"),
      )
      .leftJoin("workspaces as w", (join) =>
        join.onRef("w.account_id", "=", "a.id").on("w.id", "=", workspaceId),
      )
      .leftJoin("workspace_grants as wg", (join) =>
        join
          .onRef("wg.account_id", "=", "a.id")
          .onRef("wg.user_id", "=", "m.user_id")
          .on("wg.workspace_id", "=", workspaceId),
      )
      .select(["a.id as account_id", "m.user_id as user_id"])
      .where((eb) => eb(eb.fn<string>("lower", ["a.email"]), "=", email.toLowerCase()))
      .where((eb) => eb.or([eb("w.id", "is not", null), eb("wg.id", "is not", null)]))
      .orderBy("a.id", "asc")
      .limit(1)
      .executeTakeFirst();
    return row ? { accountId: row.account_id, userId: row.user_id } : null;
  }
}

export class PostgresSlackOperatorPermission implements SlackOperatorPermissionPort {
  constructor(private readonly db: Db) {}

  async hasPermission(input: {
    accountId: string;
    userId?: string | null;
    workspaceId: string;
    permission: "workspace.conversation.takeover";
  }): Promise<boolean> {
    const row = await this.db
      .selectFrom("account_memberships as m")
      .leftJoin("workspaces as w", (join) =>
        join.onRef("w.account_id", "=", "m.account_id").on("w.id", "=", input.workspaceId),
      )
      .leftJoin("workspace_grants as wg", (join) =>
        join
          .onRef("wg.account_id", "=", "m.account_id")
          .onRef("wg.user_id", "=", "m.user_id")
          .on("wg.workspace_id", "=", input.workspaceId),
      )
      .select("m.account_id as account_id")
      .where("m.account_id", "=", input.accountId)
      .where("m.status", "=", "active")
      .$if(input.userId != null, (qb) => qb.where("m.user_id", "=", input.userId!))
      .where((eb) => eb.or([eb("w.id", "is not", null), eb("wg.id", "is not", null)]))
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }
}
