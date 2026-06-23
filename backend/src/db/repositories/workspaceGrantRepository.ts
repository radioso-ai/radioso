import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
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

const grantColumns = ["id", "workspace_id", "account_id", "user_id", "role", "created_at", "updated_at"] as const;

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
  deleteByAccountAndUser(accountId: string, userId: string): Promise<number>;
  deleteByWorkspaceAndUser(workspaceId: string, accountId: string, userId: string): Promise<boolean>;
}

export class WorkspaceGrantRepository implements WorkspaceGrantRepositoryPort {
  constructor(private readonly db: Db) {}

  async upsert(input: {
    workspaceId: string;
    accountId: string;
    userId: string;
    role: WorkspaceGrantRole;
  }): Promise<WorkspaceGrantRecord> {
    // INSERT ... SELECT FROM workspaces both derives account_id and verifies the workspace
    // belongs to the account; no matching workspace → zero rows inserted → notFound.
    const row = await this.db
      .insertInto("workspace_grants")
      .columns(["id", "workspace_id", "account_id", "user_id", "role"])
      .expression((eb) =>
        eb
          .selectFrom("workspaces as w")
          .select([
            eb.val(randomUUID()).as("id"),
            "w.id as workspace_id",
            "w.account_id",
            eb.val(input.userId).as("user_id"),
            eb.val(input.role).as("role"),
          ])
          .where("w.id", "=", input.workspaceId)
          .where("w.account_id", "=", input.accountId),
      )
      .onConflict((oc) =>
        oc.columns(["workspace_id", "user_id"]).doUpdateSet((eb) => ({
          role: eb.ref("excluded.role"),
          updated_at: currentTimestamp(),
        })),
      )
      .returning(grantColumns)
      .executeTakeFirst();

    if (!row) {
      throw notFound("Workspace not found");
    }

    return mapGrant(row as WorkspaceGrantRow);
  }

  async findByWorkspaceAndUser(workspaceId: string, userId: string): Promise<WorkspaceGrantRecord | null> {
    const row = await this.db
      .selectFrom("workspace_grants")
      .select(grantColumns)
      .where("workspace_id", "=", workspaceId)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    return row ? mapGrant(row as WorkspaceGrantRow) : null;
  }

  async listByAccount(accountId: string): Promise<WorkspaceGrantRecord[]> {
    const rows = await this.db
      .selectFrom("workspace_grants")
      .select(grantColumns)
      .where("account_id", "=", accountId)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) => mapGrant(row as WorkspaceGrantRow));
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceGrantRecord[]> {
    const rows = await this.db
      .selectFrom("workspace_grants")
      .select(grantColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) => mapGrant(row as WorkspaceGrantRow));
  }

  async deleteByAccountAndUser(accountId: string, userId: string): Promise<number> {
    const result = await this.db
      .deleteFrom("workspace_grants")
      .where("account_id", "=", accountId)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  async deleteByWorkspaceAndUser(workspaceId: string, accountId: string, userId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("workspace_grants")
      .where("workspace_id", "=", workspaceId)
      .where("account_id", "=", accountId)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }
}
