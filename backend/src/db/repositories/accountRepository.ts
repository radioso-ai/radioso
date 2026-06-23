import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { AccountRecord, AccountRepositoryPort } from "../../modules/auth/services/authService.js";

interface AccountRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

const accountColumns = ["id", "name", "email", "password_hash", "created_at", "updated_at"] as const;

const mapAccount = (row: AccountRow): AccountRecord => ({
  id: row.id,
  name: row.name,
  email: row.email,
  passwordHash: row.password_hash,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class AccountRepository implements AccountRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(params: { name: string; email: string; passwordHash: string }): Promise<AccountRecord> {
    const row = await this.db
      .insertInto("accounts")
      .values({
        id: randomUUID(),
        name: params.name,
        email: params.email,
        password_hash: params.passwordHash,
      })
      .returning(accountColumns)
      .executeTakeFirstOrThrow();

    return mapAccount(row);
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    const row = await this.db
      .selectFrom("accounts")
      .select(accountColumns)
      .where("email", "=", email)
      .executeTakeFirst();

    return row ? mapAccount(row) : null;
  }

  async findById(id: string): Promise<AccountRecord | null> {
    const row = await this.db
      .selectFrom("accounts")
      .select(accountColumns)
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapAccount(row) : null;
  }

  async updateName(id: string, name: string): Promise<AccountRecord> {
    const row = await this.db
      .updateTable("accounts")
      .set({ name, updated_at: currentTimestamp() })
      .where("id", "=", id)
      .returning(accountColumns)
      .executeTakeFirstOrThrow();

    return mapAccount(row);
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom("accounts").where("id", "=", id).executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }
}
