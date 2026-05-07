import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

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
  constructor(private readonly database: Database) {}

  async create(params: { id?: string; email: string; passwordHash: string; emailVerifiedAt?: Date | null }): Promise<UserRecord> {
    const row = await this.database.queryOne<UserRow>(
      `INSERT INTO users (id, email, password_hash, email_verified_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, password_hash, email_verified_at, created_at, updated_at`,
      [params.id ?? randomUUID(), params.email, params.passwordHash, params.emailVerifiedAt ?? null],
    );

    return mapUser(row);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.database.queryOptional<UserRow>(
      `SELECT id, email, password_hash, email_verified_at, created_at, updated_at
       FROM users
       WHERE email = $1`,
      [email],
    );

    return row ? mapUser(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.database.queryOptional<UserRow>(
      `SELECT id, email, password_hash, email_verified_at, created_at, updated_at
       FROM users
       WHERE id = $1`,
      [id],
    );

    return row ? mapUser(row) : null;
  }

  async updatePassword(id: string, passwordHash: string): Promise<UserRecord> {
    const row = await this.database.queryOne<UserRow>(
      `UPDATE users
       SET password_hash = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, password_hash, email_verified_at, created_at, updated_at`,
      [id, passwordHash],
    );

    return mapUser(row);
  }

  async markEmailVerified(id: string, verifiedAt: Date): Promise<UserRecord> {
    const row = await this.database.queryOne<UserRow>(
      `UPDATE users
       SET email_verified_at = COALESCE(email_verified_at, $2),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, password_hash, email_verified_at, created_at, updated_at`,
      [id, verifiedAt],
    );

    return mapUser(row);
  }

  async deleteById(id: string): Promise<boolean> {
    return (await this.database.execute("DELETE FROM users WHERE id = $1", [id])) > 0;
  }
}
