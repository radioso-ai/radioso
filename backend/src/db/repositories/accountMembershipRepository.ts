import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export type AccountMembershipRole = "owner" | "member";
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
  deleteById(id: string): Promise<boolean>;
}

export class AccountMembershipRepository implements AccountMembershipRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(params: {
    accountId: string;
    userId: string;
    role: AccountMembershipRole;
    status?: AccountMembershipStatus;
  }): Promise<AccountMembershipRecord> {
    const [row] = await this.database.query<AccountMembershipRow>(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, user_id)
       DO UPDATE SET role = account_memberships.role
       RETURNING id, account_id, user_id, role, status, created_at, updated_at`,
      [randomUUID(), params.accountId, params.userId, params.role, params.status ?? "active"],
    );

    return mapMembership(row);
  }

  async findActiveByAccountAndUser(accountId: string, userId: string): Promise<AccountMembershipRecord | null> {
    const [row] = await this.database.query<AccountMembershipRow>(
      `SELECT id, account_id, user_id, role, status, created_at, updated_at
       FROM account_memberships
       WHERE account_id = $1
         AND user_id = $2
         AND status = 'active'`,
      [accountId, userId],
    );

    return row ? mapMembership(row) : null;
  }

  async findById(id: string): Promise<AccountMembershipRecord | null> {
    const [row] = await this.database.query<AccountMembershipRow>(
      `SELECT id, account_id, user_id, role, status, created_at, updated_at
       FROM account_memberships
       WHERE id = $1`,
      [id],
    );

    return row ? mapMembership(row) : null;
  }

  async listActiveByAccount(accountId: string): Promise<AccountMembershipUserRecord[]> {
    const rows = await this.database.query<AccountMembershipUserRow>(
      `SELECT m.id, m.account_id, m.user_id, m.role, m.status, m.created_at, m.updated_at, u.email
       FROM account_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.account_id = $1
         AND m.status = 'active'
       ORDER BY m.created_at ASC`,
      [accountId],
    );

    return rows.map(mapMembershipUser);
  }

  async listActiveByUser(userId: string): Promise<AccountMembershipRecord[]> {
    const rows = await this.database.query<AccountMembershipRow>(
      `SELECT id, account_id, user_id, role, status, created_at, updated_at
       FROM account_memberships
       WHERE user_id = $1
         AND status = 'active'
       ORDER BY created_at ASC`,
      [userId],
    );

    return rows.map(mapMembership);
  }

  async deleteById(id: string): Promise<boolean> {
    const rows = await this.database.query<{ id: string }>(
      `DELETE FROM account_memberships
       WHERE id = $1
       RETURNING id`,
      [id],
    );

    return rows.length > 0;
  }
}
