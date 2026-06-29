import { randomUUID } from "node:crypto";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import type { StaffSession } from "./staffTypes.js";

interface StaffSessionRow {
  id: string;
  staff_id: string;
  session_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

const mapStaffSession = (row: StaffSessionRow): StaffSession => ({
  id: row.id,
  staffId: row.staff_id,
  sessionTokenHash: row.session_token_hash,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
});

const rowsOf = <T>(result: T[] | { rows: T[] }): T[] =>
  Array.isArray(result) ? result : result.rows;

export interface StaffSessionRepository {
  create(input: { staffId: string; sessionTokenHash: string; expiresAt: Date }): Promise<StaffSession>;
  findActiveByTokenHash(tokenHash: string): Promise<StaffSession | null>;
  touch(tokenHash: string): Promise<void>;
  revoke(tokenHash: string): Promise<void>;
}

export class PostgresStaffSessionRepository implements StaffSessionRepository {
  constructor(private readonly database: UsageLimitDatabasePort) {}

  async create(input: { staffId: string; sessionTokenHash: string; expiresAt: Date }): Promise<StaffSession> {
    const rows = rowsOf(await this.database.query<StaffSessionRow>(
      `INSERT INTO ee_staff_sessions (id, staff_id, session_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, staff_id, session_token_hash, expires_at, revoked_at`,
      [randomUUID(), input.staffId, input.sessionTokenHash, input.expiresAt],
    ));
    return mapStaffSession(rows[0]);
  }

  async findActiveByTokenHash(tokenHash: string): Promise<StaffSession | null> {
    const rows = rowsOf(await this.database.query<StaffSessionRow>(
      `SELECT id, staff_id, session_token_hash, expires_at, revoked_at
       FROM ee_staff_sessions
       WHERE session_token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()
       LIMIT 1`,
      [tokenHash],
    ));
    return rows[0] ? mapStaffSession(rows[0]) : null;
  }

  async touch(tokenHash: string): Promise<void> {
    await this.database.query(
      `UPDATE ee_staff_sessions
       SET last_seen_at = NOW()
       WHERE session_token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  async revoke(tokenHash: string): Promise<void> {
    await this.database.query(
      `UPDATE ee_staff_sessions
       SET revoked_at = NOW()
       WHERE session_token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }
}
