import type { DatabaseExecutor } from "../../../shared/infra/database.js";
import type {
  SlackOperatorPermissionPort,
  WorkspaceMemberLookupPort,
  WorkspaceMemberLookupResult,
} from "./slackOperatorIdentityResolver.js";

interface WorkspaceMemberRow {
  account_id: string;
  user_id: string;
}

export class PostgresWorkspaceMemberLookup implements WorkspaceMemberLookupPort {
  constructor(private readonly database: DatabaseExecutor) {}

  async findByEmail(workspaceId: string, email: string): Promise<WorkspaceMemberLookupResult | null> {
    const row = await this.database.queryOptional<WorkspaceMemberRow>(
      `SELECT DISTINCT a.id AS account_id, m.user_id
       FROM accounts a
       JOIN account_memberships m ON m.account_id = a.id AND m.status = 'active'
       LEFT JOIN workspaces w ON w.account_id = a.id AND w.id = $1
       LEFT JOIN workspace_grants wg ON wg.account_id = a.id AND wg.user_id = m.user_id AND wg.workspace_id = $1
       WHERE lower(a.email) = lower($2)
         AND (w.id IS NOT NULL OR wg.id IS NOT NULL)
       ORDER BY a.id ASC
       LIMIT 1`,
      [workspaceId, email],
    );
    return row ? { accountId: row.account_id, userId: row.user_id } : null;
  }
}

interface PermissionRow {
  allowed: boolean;
}

export class PostgresSlackOperatorPermission implements SlackOperatorPermissionPort {
  constructor(private readonly database: DatabaseExecutor) {}

  async hasPermission(input: {
    accountId: string;
    userId?: string | null;
    workspaceId: string;
    permission: "workspace.conversation.takeover";
  }): Promise<boolean> {
    const row = await this.database.queryOptional<PermissionRow>(
      `SELECT EXISTS (
         SELECT 1
         FROM account_memberships m
         LEFT JOIN workspaces w ON w.account_id = m.account_id AND w.id = $2
         LEFT JOIN workspace_grants wg ON wg.account_id = m.account_id
           AND wg.user_id = m.user_id
           AND wg.workspace_id = $2
         WHERE m.account_id = $1
           AND m.status = 'active'
           AND ($3::uuid IS NULL OR m.user_id = $3::uuid)
           AND (w.id IS NOT NULL OR wg.id IS NOT NULL)
       ) AS allowed`,
      [input.accountId, input.workspaceId, input.userId ?? null],
    );
    return row?.allowed === true;
  }
}
