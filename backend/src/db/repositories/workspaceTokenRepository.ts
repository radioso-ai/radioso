import { randomUUID } from "node:crypto";

import type { Db } from "../../shared/infra/kysely/types.js";

export interface WorkspaceTokenRecord {
  id: string;
  workspaceId: string;
  accountId: string;
  tokenPrefix: string;
  tokenHash: string;
  encryptedToken: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
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
  revoked_at: Date | null;
}

const workspaceTokenColumns = [
  "id",
  "workspace_id",
  "account_id",
  "token_prefix",
  "token_hash",
  "encrypted_token",
  "created_at",
  "last_used_at",
  "revoked_at",
] as const;

const mapToken = (row: WorkspaceTokenRow): WorkspaceTokenRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  accountId: row.account_id,
  tokenPrefix: row.token_prefix,
  tokenHash: row.token_hash,
  encryptedToken: row.encrypted_token,
  createdAt: new Date(row.created_at),
  lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
  revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
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
  constructor(private readonly db: Db) {}

  async findByWorkspaceId(workspaceId: string): Promise<WorkspaceTokenRecord | null> {
    const row = await this.db
      .selectFrom("workspace_tokens")
      .select(workspaceTokenColumns)
      .where("workspace_id", "=", workspaceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();

    return row ? mapToken(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<WorkspaceTokenRecord | null> {
    const row = await this.db
      .selectFrom("workspace_tokens")
      .select(workspaceTokenColumns)
      .where("token_hash", "=", tokenHash)
      .where("revoked_at", "is", null)
      .executeTakeFirst();

    return row ? mapToken(row) : null;
  }

  async save(params: {
    workspaceId: string;
    accountId: string;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<WorkspaceTokenRecord> {
    const row = await this.db
      .insertInto("workspace_tokens")
      .values({
        id: randomUUID(),
        workspace_id: params.workspaceId,
        account_id: params.accountId,
        token_prefix: params.tokenPrefix,
        token_hash: params.tokenHash,
        encrypted_token: params.encryptedToken,
      })
      .onConflict((oc) =>
        oc.column("workspace_id").doUpdateSet((eb) => ({
          token_prefix: eb.ref("excluded.token_prefix"),
          token_hash: eb.ref("excluded.token_hash"),
          encrypted_token: eb.ref("excluded.encrypted_token"),
          revoked_at: null,
        })),
      )
      .returning(workspaceTokenColumns)
      .executeTakeFirstOrThrow();

    return mapToken(row);
  }

  async touch(workspaceId: string, lastUsedAt: Date): Promise<void> {
    await this.db
      .updateTable("workspace_tokens")
      .set({ last_used_at: lastUsedAt })
      .where("workspace_id", "=", workspaceId)
      .where("revoked_at", "is", null)
      .execute();
  }
}
