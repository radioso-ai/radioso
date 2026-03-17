import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface WorkspaceTokenRecord {
  id: string;
  workspaceId: string;
  accountId: string;
  tokenPrefix: string;
  tokenHash: string;
  encryptedToken: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

interface WorkspaceTokenRow {
  id: string;
  workspace_id: string;
  account_id: string;
  token_prefix: string;
  token_hash: string;
  encrypted_token: string;
  created_at: Date;
  last_used_at: Date | null;
}

const mapToken = (row: WorkspaceTokenRow): WorkspaceTokenRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  accountId: row.account_id,
  tokenPrefix: row.token_prefix,
  tokenHash: row.token_hash,
  encryptedToken: row.encrypted_token,
  createdAt: new Date(row.created_at),
  lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
});

export interface WorkspaceTokenRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<WorkspaceTokenRecord | null>;
  findByTokenHash(tokenHash: string): Promise<WorkspaceTokenRecord | null>;
  save(params: {
    workspaceId: string;
    accountId: string;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<WorkspaceTokenRecord>;
  touch(workspaceId: string, lastUsedAt: Date): Promise<void>;
}

export class WorkspaceTokenRepository implements WorkspaceTokenRepositoryPort {
  constructor(private readonly database: Database) {}

  async findByWorkspaceId(workspaceId: string): Promise<WorkspaceTokenRecord | null> {
    const [row] = await this.database.query<WorkspaceTokenRow>(
      `SELECT id, workspace_id, account_id, token_prefix, token_hash, encrypted_token, created_at, last_used_at
       FROM workspace_tokens
       WHERE workspace_id = $1`,
      [workspaceId],
    );

    return row ? mapToken(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<WorkspaceTokenRecord | null> {
    const [row] = await this.database.query<WorkspaceTokenRow>(
      `SELECT id, workspace_id, account_id, token_prefix, token_hash, encrypted_token, created_at, last_used_at
       FROM workspace_tokens
       WHERE token_hash = $1`,
      [tokenHash],
    );

    return row ? mapToken(row) : null;
  }

  async save(params: {
    workspaceId: string;
    accountId: string;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<WorkspaceTokenRecord> {
    const [row] = await this.database.query<WorkspaceTokenRow>(
      `INSERT INTO workspace_tokens (id, workspace_id, account_id, token_prefix, token_hash, encrypted_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id)
       DO UPDATE SET token_prefix = EXCLUDED.token_prefix,
                     token_hash = EXCLUDED.token_hash,
                     encrypted_token = EXCLUDED.encrypted_token
       RETURNING id, workspace_id, account_id, token_prefix, token_hash, encrypted_token, created_at, last_used_at`,
      [randomUUID(), params.workspaceId, params.accountId, params.tokenPrefix, params.tokenHash, params.encryptedToken],
    );

    return mapToken(row);
  }

  async touch(workspaceId: string, lastUsedAt: Date): Promise<void> {
    await this.database.query(
      `UPDATE workspace_tokens
       SET last_used_at = $2
       WHERE workspace_id = $1`,
      [workspaceId, lastUsedAt],
    );
  }
}
