import { randomUUID } from "node:crypto";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import type { StaffRole, StaffStatus, StaffUser } from "./staffTypes.js";

interface StaffUserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: StaffRole;
  status: StaffStatus;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

const mapStaffUser = (row: StaffUserRow): StaffUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  passwordHash: row.password_hash,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastLoginAt: row.last_login_at,
});

const rowsOf = <T>(result: T[] | { rows: T[] }): T[] =>
  Array.isArray(result) ? result : result.rows;

export interface StaffUserRepository {
  findByEmail(email: string): Promise<StaffUser | null>;
  findById(id: string): Promise<StaffUser | null>;
  create(input: {
    email: string;
    name: string;
    passwordHash: string;
    role: StaffRole;
    status?: StaffStatus;
  }): Promise<StaffUser>;
  updatePassword(id: string, passwordHash: string): Promise<StaffUser | null>;
  setRole(id: string, role: StaffRole): Promise<StaffUser | null>;
  setStatus(id: string, status: StaffStatus): Promise<StaffUser | null>;
  touchLastLogin(id: string): Promise<void>;
}

export class PostgresStaffUserRepository implements StaffUserRepository {
  constructor(private readonly database: UsageLimitDatabasePort) {}

  async findByEmail(email: string): Promise<StaffUser | null> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `SELECT id, email, name, password_hash, role, status, created_at, updated_at, last_login_at
       FROM ee_staff_users
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email.trim()],
    ));
    return rows[0] ? mapStaffUser(rows[0]) : null;
  }

  async findById(id: string): Promise<StaffUser | null> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `SELECT id, email, name, password_hash, role, status, created_at, updated_at, last_login_at
       FROM ee_staff_users
       WHERE id = $1
       LIMIT 1`,
      [id],
    ));
    return rows[0] ? mapStaffUser(rows[0]) : null;
  }

  async create(input: {
    email: string;
    name: string;
    passwordHash: string;
    role: StaffRole;
    status?: StaffStatus;
  }): Promise<StaffUser> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `INSERT INTO ee_staff_users (id, email, name, password_hash, role, status)
       VALUES ($1, LOWER($2), $3, $4, $5, $6)
       RETURNING id, email, name, password_hash, role, status, created_at, updated_at, last_login_at`,
      [randomUUID(), input.email.trim(), input.name.trim(), input.passwordHash, input.role, input.status ?? "active"],
    ));
    return mapStaffUser(rows[0]);
  }

  async updatePassword(id: string, passwordHash: string): Promise<StaffUser | null> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `UPDATE ee_staff_users
       SET password_hash = $2, status = 'active', updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, password_hash, role, status, created_at, updated_at, last_login_at`,
      [id, passwordHash],
    ));
    return rows[0] ? mapStaffUser(rows[0]) : null;
  }

  async setRole(id: string, role: StaffRole): Promise<StaffUser | null> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `UPDATE ee_staff_users
       SET role = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, password_hash, role, status, created_at, updated_at, last_login_at`,
      [id, role],
    ));
    return rows[0] ? mapStaffUser(rows[0]) : null;
  }

  async setStatus(id: string, status: StaffStatus): Promise<StaffUser | null> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `UPDATE ee_staff_users
       SET status = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, password_hash, role, status, created_at, updated_at, last_login_at`,
      [id, status],
    ));
    return rows[0] ? mapStaffUser(rows[0]) : null;
  }

  async touchLastLogin(id: string): Promise<void> {
    await this.database.query(
      `UPDATE ee_staff_users
       SET last_login_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id],
    );
  }
}

export type { StaffSessionRepository } from "./staffSessionRepository.js";
