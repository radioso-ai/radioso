import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const userColumns = ["id", "email", "password_hash", "email_verified_at", "created_at", "updated_at"] as const;

const mapUser = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  emailVerifiedAt: row.email_verified_at ? new Date(row.email_verified_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface UserRepositoryPort {
  create(params: { id?: string; email: string; passwordHash: string; emailVerifiedAt?: Date | null }): Promise<UserRecord>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  updatePassword(id: string, passwordHash: string): Promise<UserRecord>;
  markEmailVerified(id: string, verifiedAt: Date): Promise<UserRecord>;
  deleteById(id: string): Promise<boolean>;
}

export class UserRepository implements UserRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(params: { id?: string; email: string; passwordHash: string; emailVerifiedAt?: Date | null }): Promise<UserRecord> {
    const row = await this.db
      .insertInto("users")
      .values({
        id: params.id ?? randomUUID(),
        email: params.email,
        password_hash: params.passwordHash,
        email_verified_at: params.emailVerifiedAt ?? null,
      })
      .returning(userColumns)
      .executeTakeFirstOrThrow();

    return mapUser(row);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.db
      .selectFrom("users")
      .select(userColumns)
      .where("email", "=", email)
      .executeTakeFirst();

    return row ? mapUser(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.db
      .selectFrom("users")
      .select(userColumns)
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapUser(row) : null;
  }

  async updatePassword(id: string, passwordHash: string): Promise<UserRecord> {
    const row = await this.db
      .updateTable("users")
      .set({ password_hash: passwordHash, updated_at: currentTimestamp() })
      .where("id", "=", id)
      .returning(userColumns)
      .executeTakeFirstOrThrow();

    return mapUser(row);
  }

  async markEmailVerified(id: string, verifiedAt: Date): Promise<UserRecord> {
    const row = await this.db
      .updateTable("users")
      // COALESCE keeps an existing verification timestamp (idempotent re-verify).
      .set((eb) => ({
        email_verified_at: eb.fn.coalesce("email_verified_at", eb.val(verifiedAt)),
        updated_at: currentTimestamp(),
      }))
      .where("id", "=", id)
      .returning(userColumns)
      .executeTakeFirstOrThrow();

    return mapUser(row);
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom("users").where("id", "=", id).executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
