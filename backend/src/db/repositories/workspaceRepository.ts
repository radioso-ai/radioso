import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface WorkspaceRecord {
  id: string;
  accountId: string;
  name: string;
  anonymousChatEnabled: boolean;
  anonymousChatToken: string | null;
  anonymousRateLimit: number;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkspaceRow {
  id: string;
  account_id: string;
  name: string;
  anonymous_chat_enabled: boolean;
  anonymous_chat_token: string | null;
  anonymous_rate_limit: number;
  created_at: Date;
  updated_at: Date;
}

const mapWorkspace = (row: WorkspaceRow): WorkspaceRecord => ({
  id: row.id,
  accountId: row.account_id,
  name: row.name,
  anonymousChatEnabled: row.anonymous_chat_enabled ?? false,
  anonymousChatToken: row.anonymous_chat_token ?? null,
  anonymousRateLimit: row.anonymous_rate_limit ?? 10,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface WorkspaceRepositoryPort {
  create(accountId: string, name: string): Promise<WorkspaceRecord>;
  findById(id: string): Promise<WorkspaceRecord | null>;
  findByIdAndAccountId(workspaceId: string, accountId: string): Promise<WorkspaceRecord | null>;
  findByAnonymousChatToken(token: string): Promise<WorkspaceRecord | null>;
  listByAccountId(accountId: string): Promise<WorkspaceRecord[]>;
  countByAccountId(accountId: string): Promise<number>;
  updateName(workspaceId: string, name: string): Promise<WorkspaceRecord>;
  updateAnonymousChatSettings(
    workspaceId: string,
    enabled: boolean,
    token: string | null,
    rateLimit: number,
  ): Promise<WorkspaceRecord>;
  deleteById(workspaceId: string): Promise<boolean>;
}

export class WorkspaceRepository implements WorkspaceRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(accountId: string, name: string): Promise<WorkspaceRecord> {
    const [row] = await this.database.query<WorkspaceRow>(
      `INSERT INTO workspaces (id, account_id, name)
       VALUES ($1, $2, $3)
       RETURNING id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at`,
      [randomUUID(), accountId, name],
    );

    return mapWorkspace(row);
  }

  async findById(id: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.database.query<WorkspaceRow>(
      `SELECT id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at
       FROM workspaces
       WHERE id = $1`,
      [id],
    );

    return row ? mapWorkspace(row) : null;
  }

  async findByIdAndAccountId(workspaceId: string, accountId: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.database.query<WorkspaceRow>(
      `SELECT id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at
       FROM workspaces
       WHERE id = $1 AND account_id = $2`,
      [workspaceId, accountId],
    );

    return row ? mapWorkspace(row) : null;
  }

  async listByAccountId(accountId: string): Promise<WorkspaceRecord[]> {
    const rows = await this.database.query<WorkspaceRow>(
      `SELECT id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at
       FROM workspaces
       WHERE account_id = $1
       ORDER BY created_at ASC`,
      [accountId],
    );

    return rows.map(mapWorkspace);
  }

  async countByAccountId(accountId: string): Promise<number> {
    const [row] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workspaces WHERE account_id = $1`,
      [accountId],
    );

    return parseInt(row.count, 10);
  }

  async updateName(workspaceId: string, name: string): Promise<WorkspaceRecord> {
    const [row] = await this.database.query<WorkspaceRow>(
      `UPDATE workspaces SET name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at`,
      [name, workspaceId],
    );

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row);
  }

  async findByAnonymousChatToken(token: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.database.query<WorkspaceRow>(
      `SELECT id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at
       FROM workspaces
       WHERE anonymous_chat_token = $1`,
      [token],
    );

    return row ? mapWorkspace(row) : null;
  }

  async updateAnonymousChatSettings(
    workspaceId: string,
    enabled: boolean,
    token: string | null,
    rateLimit: number,
  ): Promise<WorkspaceRecord> {
    const [row] = await this.database.query<WorkspaceRow>(
      `UPDATE workspaces
       SET anonymous_chat_enabled = $1, anonymous_chat_token = $2, anonymous_rate_limit = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at`,
      [enabled, token, rateLimit, workspaceId],
    );

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row);
  }

  async deleteById(workspaceId: string): Promise<boolean> {
    const rows = await this.database.query<{ id: string }>(
      `DELETE FROM workspaces WHERE id = $1 RETURNING id`,
      [workspaceId],
    );

    return rows.length > 0;
  }
}
