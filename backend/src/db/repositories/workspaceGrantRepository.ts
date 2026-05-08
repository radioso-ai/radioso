import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import { notFound } from "../../shared/domain/errors.js";

export type WorkspaceGrantRole = "admin" | "member";

export interface WorkspaceGrantRecord {
  id: string;
  workspaceId: string;
  accountId: string;
  userId: string;
  role: WorkspaceGrantRole;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkspaceGrantRow {
  id: string;
  workspace_id: string;
  account_id: string;
  user_id: string;
  role: WorkspaceGrantRole;
  created_at: Date;
  updated_at: Date;
}

const mapGrant = (row: WorkspaceGrantRow): WorkspaceGrantRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  accountId: row.account_id,
  userId: row.user_id,
  role: row.role,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface WorkspaceGrantRepositoryPort {
  upsert(input: {
    workspaceId: string;
    accountId: string;
    userId: string;
    role: WorkspaceGrantRole;
  }): Promise<WorkspaceGrantRecord>;
  findByWorkspaceAndUser(workspaceId: string, userId: string): Promise<WorkspaceGrantRecord | null>;
  listByAccount(accountId: string): Promise<WorkspaceGrantRecord[]>;
  listByWorkspace(workspaceId: string): Promise<WorkspaceGrantRecord[]>;
  deleteByWorkspaceAndUser(workspaceId: string, accountId: string, userId: string): Promise<boolean>;
}

export class WorkspaceGrantRepository implements WorkspaceGrantRepositoryPort {
  constructor(private readonly database: Database) {}

  async upsert(input: {
    workspaceId: string;
    accountId: string;
    userId: string;
    role: WorkspaceGrantRole;
  }): Promise<WorkspaceGrantRecord> {
    const row = await this.database.queryOptional<WorkspaceGrantRow>(
      `INSERT INTO workspace_grants (id, workspace_id, account_id, user_id, role)
       SELECT $1, w.id, w.account_id, $4, $5
       FROM workspaces w
       WHERE w.id = $2 AND w.account_id = $3
       ON CONFLICT (workspace_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()
       RETURNING id, workspace_id, account_id, user_id, role, created_at, updated_at`,
      [randomUUID(), input.workspaceId, input.accountId, input.userId, input.role],
    );

    if (!row) {
      throw notFound("Workspace not found");
    }

    return mapGrant(row);
  }

  async findByWorkspaceAndUser(workspaceId: string, userId: string): Promise<WorkspaceGrantRecord | null> {
    const row = await this.database.queryOptional<WorkspaceGrantRow>(
      `SELECT id, workspace_id, account_id, user_id, role, created_at, updated_at
       FROM workspace_grants
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );

    return row ? mapGrant(row) : null;
  }

  async listByAccount(accountId: string): Promise<WorkspaceGrantRecord[]> {
    const rows = await this.database.query<WorkspaceGrantRow>(
      `SELECT id, workspace_id, account_id, user_id, role, created_at, updated_at
       FROM workspace_grants
       WHERE account_id = $1
       ORDER BY created_at ASC`,
      [accountId],
    );

    return rows.map(mapGrant);
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceGrantRecord[]> {
    const rows = await this.database.query<WorkspaceGrantRow>(
      `SELECT id, workspace_id, account_id, user_id, role, created_at, updated_at
       FROM workspace_grants
       WHERE workspace_id = $1
       ORDER BY created_at ASC`,
      [workspaceId],
    );

    return rows.map(mapGrant);
  }

  async deleteByWorkspaceAndUser(workspaceId: string, accountId: string, userId: string): Promise<boolean> {
    const rows = await this.database.query<{ id: string }>(
      `DELETE FROM workspace_grants
       WHERE workspace_id = $1
         AND account_id = $2
         AND user_id = $3
       RETURNING id`,
      [workspaceId, accountId, userId],
    );

    return rows.length > 0;
  }
}
