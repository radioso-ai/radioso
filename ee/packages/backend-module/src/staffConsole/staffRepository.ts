import { randomUUID } from "node:crypto";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import type { StaffRole, StaffStatus, StaffUser } from "./staffTypes.js";

interface StaffUserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  google_subject: string | null;
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
  googleSubject: row.google_subject,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastLoginAt: row.last_login_at,
});

const STAFF_USER_COLUMNS =
  "id, email, name, password_hash, google_subject, role, status, created_at, updated_at, last_login_at";

const rowsOf = <T>(result: T[] | { rows: T[] }): T[] =>
  Array.isArray(result) ? result : result.rows;

export interface StaffUserRepository {
  findByEmail(email: string): Promise<StaffUser | null>;
  findById(id: string): Promise<StaffUser | null>;
  listStaff(): Promise<StaffUser[]>;
  countActiveOwners(): Promise<number>;
  create(input: {
    email: string;
    name: string;
    passwordHash: string | null;
    role: StaffRole;
    status?: StaffStatus;
  }): Promise<StaffUser>;
  /** Replaces every credential at once: the password, and whichever Google account was bound. */
  resetCredentials(id: string, passwordHash: string | null): Promise<StaffUser | null>;
  /** False when a different Google account is already bound to this staff member. */
  bindGoogleSubject(id: string, subject: string): Promise<boolean>;
  setRole(id: string, role: StaffRole): Promise<StaffUser | null>;
  /** Re-enabling releases the bound Google account: an owner is vouching for whoever holds the address now. */
  setStatus(id: string, status: StaffStatus): Promise<StaffUser | null>;
  touchLastLogin(id: string): Promise<void>;
}

export class PostgresStaffUserRepository implements StaffUserRepository {
  constructor(private readonly database: UsageLimitDatabasePort) {}

  async findByEmail(email: string): Promise<StaffUser | null> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `SELECT ${STAFF_USER_COLUMNS}
       FROM ee_staff_users
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email.trim()],
    ));
    return rows[0] ? mapStaffUser(rows[0]) : null;
  }

  async findById(id: string): Promise<StaffUser | null> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `SELECT ${STAFF_USER_COLUMNS}
       FROM ee_staff_users
       WHERE id = $1
       LIMIT 1`,
      [id],
    ));
    return rows[0] ? mapStaffUser(rows[0]) : null;
  }

  async listStaff(): Promise<StaffUser[]> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `SELECT ${STAFF_USER_COLUMNS}
       FROM ee_staff_users
       ORDER BY created_at ASC, id ASC`,
    ));
    return rows.map(mapStaffUser);
  }

  async countActiveOwners(): Promise<number> {
    const rows = rowsOf(await this.database.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count
       FROM ee_staff_users
       WHERE role = 'owner' AND status = 'active'`,
    ));
    return Number(rows[0]?.count ?? 0);
  }

  async create(input: {
    email: string;
    name: string;
    passwordHash: string | null;
    role: StaffRole;
    status?: StaffStatus;
  }): Promise<StaffUser> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `INSERT INTO ee_staff_users (id, email, name, password_hash, role, status)
       VALUES ($1, LOWER($2), $3, $4, $5, $6)
       RETURNING ${STAFF_USER_COLUMNS}`,
      [randomUUID(), input.email.trim(), input.name.trim(), input.passwordHash, input.role, input.status ?? "active"],
    ));
    return mapStaffUser(rows[0]);
  }

  async bindGoogleSubject(id: string, subject: string): Promise<boolean> {
    const rows = rowsOf(await this.database.query<{ id: string }>(
      `UPDATE ee_staff_users
       SET google_subject = $2, updated_at = NOW()
       WHERE id = $1 AND (google_subject IS NULL OR google_subject = $2)
       RETURNING id`,
      [id, subject],
    ));
    return rows.length > 0;
  }

  async resetCredentials(id: string, passwordHash: string | null): Promise<StaffUser | null> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `UPDATE ee_staff_users
       SET password_hash = $2, google_subject = NULL, status = 'active', updated_at = NOW()
       WHERE id = $1
       RETURNING ${STAFF_USER_COLUMNS}`,
      [id, passwordHash],
    ));
    return rows[0] ? mapStaffUser(rows[0]) : null;
  }

  async setRole(id: string, role: StaffRole): Promise<StaffUser | null> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `UPDATE ee_staff_users
       SET role = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING ${STAFF_USER_COLUMNS}`,
      [id, role],
    ));
    return rows[0] ? mapStaffUser(rows[0]) : null;
  }

  async setStatus(id: string, status: StaffStatus): Promise<StaffUser | null> {
    const rows = rowsOf(await this.database.query<StaffUserRow>(
      `UPDATE ee_staff_users
       SET status = $2,
           google_subject = CASE WHEN status = 'disabled' AND $2 = 'active' THEN NULL ELSE google_subject END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING ${STAFF_USER_COLUMNS}`,
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
