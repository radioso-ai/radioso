import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import type { AccountRecord, AccountRepositoryPort } from "../../modules/auth/services/authService.js";

interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

const mapAccount = (row: AccountRow): AccountRecord => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class AccountRepository implements AccountRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(params: { email: string; passwordHash: string }): Promise<AccountRecord> {
    const [row] = await this.database.query<AccountRow>(
      `INSERT INTO accounts (id, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, password_hash, created_at, updated_at`,
      [randomUUID(), params.email, params.passwordHash],
    );

    return mapAccount(row);
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    const [row] = await this.database.query<AccountRow>(
      `SELECT id, email, password_hash, created_at, updated_at
       FROM accounts
       WHERE email = $1`,
      [email],
    );

    return row ? mapAccount(row) : null;
  }

  async findById(id: string): Promise<AccountRecord | null> {
    const [row] = await this.database.query<AccountRow>(
      `SELECT id, email, password_hash, created_at, updated_at
       FROM accounts
       WHERE id = $1`,
      [id],
    );

    return row ? mapAccount(row) : null;
  }
}
