import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// `humanAgent.userId` and similar references are read from stored JSON, so a batch read skips any
// value Postgres could not cast to the uuid column rather than failing the whole read.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const userColumns = ["id", "email", "password_hash", "display_name", "email_verified_at", "created_at", "updated_at"] as const;

const mapUser = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  displayName: row.display_name,
  emailVerifiedAt: row.email_verified_at ? new Date(row.email_verified_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface CreateUserParams {
  id?: string;
  email: string;
  passwordHash: string;
  displayName?: string | null;
  emailVerifiedAt?: Date | null;
}

export interface UserRepositoryPort {
  create(params: CreateUserParams): Promise<UserRecord>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** The users with these ids, in no particular order; an id with no user is skipped. */
  findByIds(ids: readonly string[]): Promise<UserRecord[]>;
  updatePassword(id: string, passwordHash: string): Promise<UserRecord>;
  updateDisplayName(id: string, displayName: string | null): Promise<UserRecord>;
  markEmailVerified(id: string, verifiedAt: Date): Promise<UserRecord>;
  deleteById(id: string): Promise<boolean>;
}

export class UserRepository implements UserRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(params: CreateUserParams): Promise<UserRecord> {
    const row = await this.db
      .insertInto("users")
      .values({
        id: params.id ?? randomUUID(),
        email: params.email,
        password_hash: params.passwordHash,
        display_name: params.displayName ?? null,
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

  async findByIds(ids: readonly string[]): Promise<UserRecord[]> {
    const lookupIds = [...new Set(ids)].filter((id) => uuidPattern.test(id));
    if (lookupIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom("users")
      .select(userColumns)
      .where("id", "in", lookupIds)
      .execute();

    return rows.map(mapUser);
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

  async updateDisplayName(id: string, displayName: string | null): Promise<UserRecord> {
    const row = await this.db
      .updateTable("users")
      .set({ display_name: displayName, updated_at: currentTimestamp() })
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
