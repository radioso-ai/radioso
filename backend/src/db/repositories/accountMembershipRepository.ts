import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export type AccountMembershipRole = "owner" | "admin" | "member";
export type AccountMembershipStatus = "active";

export interface AccountMembershipRecord {
  id: string;
  accountId: string;
  userId: string;
  role: AccountMembershipRole;
  status: AccountMembershipStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountMembershipUserRecord extends AccountMembershipRecord {
  email: string;
}

interface AccountMembershipRow {
  id: string;
  account_id: string;
  user_id: string;
  role: AccountMembershipRole;
  status: AccountMembershipStatus;
  created_at: Date;
  updated_at: Date;
}

interface AccountMembershipUserRow extends AccountMembershipRow {
  email: string;
}

const accountMembershipColumns = [
  "id",
  "account_id",
  "user_id",
  "role",
  "status",
  "created_at",
  "updated_at",
] as const;

const mapMembership = (row: AccountMembershipRow): AccountMembershipRecord => ({
  id: row.id,
  accountId: row.account_id,
  userId: row.user_id,
  role: row.role,
  status: row.status,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const mapMembershipUser = (row: AccountMembershipUserRow): AccountMembershipUserRecord => ({
  ...mapMembership(row),
  email: row.email,
});

export interface AccountMembershipRepositoryPort {
  create(params: {
    accountId: string;
    userId: string;
    role: AccountMembershipRole;
    status?: AccountMembershipStatus;
  }): Promise<AccountMembershipRecord>;
  findActiveByAccountAndUser(accountId: string, userId: string): Promise<AccountMembershipRecord | null>;
  findById(id: string): Promise<AccountMembershipRecord | null>;
  listActiveByAccount(accountId: string): Promise<AccountMembershipUserRecord[]>;
  listActiveByUser(userId: string): Promise<AccountMembershipRecord[]>;
  updateRole(id: string, role: AccountMembershipRole): Promise<AccountMembershipRecord>;
  deleteById(id: string): Promise<boolean>;
}

export class AccountMembershipRepository implements AccountMembershipRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(params: {
    accountId: string;
    userId: string;
    role: AccountMembershipRole;
    status?: AccountMembershipStatus;
  }): Promise<AccountMembershipRecord> {
    const row = await this.db
      .insertInto("account_memberships")
      .values({
        id: randomUUID(),
        account_id: params.accountId,
        user_id: params.userId,
        role: params.role,
        status: params.status ?? "active",
      })
      .onConflict((oc) =>
        oc.columns(["account_id", "user_id"]).doUpdateSet((eb) => ({
          role: eb.ref("account_memberships.role"),
        })),
      )
      .returning(accountMembershipColumns)
      .executeTakeFirstOrThrow();

    return mapMembership(row as AccountMembershipRow);
  }

  async findActiveByAccountAndUser(accountId: string, userId: string): Promise<AccountMembershipRecord | null> {
    const row = await this.db
      .selectFrom("account_memberships")
      .select(accountMembershipColumns)
      .where("account_id", "=", accountId)
      .where("user_id", "=", userId)
      .where("status", "=", "active")
      .executeTakeFirst();

    return row ? mapMembership(row as AccountMembershipRow) : null;
  }

  async findById(id: string): Promise<AccountMembershipRecord | null> {
    const row = await this.db
      .selectFrom("account_memberships")
      .select(accountMembershipColumns)
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapMembership(row as AccountMembershipRow) : null;
  }

  async listActiveByAccount(accountId: string): Promise<AccountMembershipUserRecord[]> {
    const rows = await this.db
      .selectFrom("account_memberships as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .select([
        "m.id",
        "m.account_id",
        "m.user_id",
        "m.role",
        "m.status",
        "m.created_at",
        "m.updated_at",
        "u.email",
      ])
      .where("m.account_id", "=", accountId)
      .where("m.status", "=", "active")
      .orderBy("m.created_at", "asc")
      .execute();

    return rows.map((row) => mapMembershipUser(row as AccountMembershipUserRow));
  }

  async listActiveByUser(userId: string): Promise<AccountMembershipRecord[]> {
    const rows = await this.db
      .selectFrom("account_memberships")
      .select(accountMembershipColumns)
      .where("user_id", "=", userId)
      .where("status", "=", "active")
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) => mapMembership(row as AccountMembershipRow));
  }

  async updateRole(id: string, role: AccountMembershipRole): Promise<AccountMembershipRecord> {
    const row = await this.db
      .updateTable("account_memberships")
      .set({ role, updated_at: currentTimestamp() })
      .where("id", "=", id)
      .returning(accountMembershipColumns)
      .executeTakeFirstOrThrow();

    return mapMembership(row as AccountMembershipRow);
  }

  async deleteById(id: string): Promise<boolean> {
    const row = await this.db
      .deleteFrom("account_memberships")
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();

    return row !== undefined;
  }
}
