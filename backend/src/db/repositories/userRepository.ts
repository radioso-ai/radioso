import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

const mapUser = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface UserRepositoryPort {
  create(params: { id?: string; email: string; passwordHash: string }): Promise<UserRecord>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  deleteById(id: string): Promise<boolean>;
}

export class UserRepository implements UserRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(params: { id?: string; email: string; passwordHash: string }): Promise<UserRecord> {
    const [row] = await this.database.query<UserRow>(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, password_hash, created_at, updated_at`,
      [params.id ?? randomUUID(), params.email, params.passwordHash],
    );

    return mapUser(row);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const [row] = await this.database.query<UserRow>(
      `SELECT id, email, password_hash, created_at, updated_at
       FROM users
       WHERE email = $1`,
      [email],
    );

    return row ? mapUser(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const [row] = await this.database.query<UserRow>(
      `SELECT id, email, password_hash, created_at, updated_at
       FROM users
       WHERE id = $1`,
      [id],
    );

    return row ? mapUser(row) : null;
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.database.pool.query("DELETE FROM users WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
