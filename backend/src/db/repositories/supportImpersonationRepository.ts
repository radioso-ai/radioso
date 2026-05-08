import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export type SupportImpersonationStatus = "approved" | "active" | "ended" | "expired" | "revoked";

export interface SupportImpersonationRecord {
  id: string;
  accountId: string;
  staffUserId: string;
  approverUserId: string;
  reason: string;
  status: SupportImpersonationStatus;
  approvedAt: Date;
  startedAt: Date | null;
  expiresAt: Date;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SupportImpersonationRow {
  id: string;
  account_id: string;
  staff_user_id: string;
  approver_user_id: string;
  reason: string;
  status: SupportImpersonationStatus;
  approved_at: Date;
  started_at: Date | null;
  expires_at: Date;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const mapSession = (row: SupportImpersonationRow): SupportImpersonationRecord => ({
  id: row.id,
  accountId: row.account_id,
  staffUserId: row.staff_user_id,
  approverUserId: row.approver_user_id,
  reason: row.reason,
  status: row.status,
  approvedAt: new Date(row.approved_at),
  startedAt: row.started_at ? new Date(row.started_at) : null,
  expiresAt: new Date(row.expires_at),
  endedAt: row.ended_at ? new Date(row.ended_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface SupportImpersonationRepositoryPort {
  createApproved(input: {
    accountId: string;
    staffUserId: string;
    approverUserId: string;
    reason: string;
    expiresAt: Date;
  }): Promise<SupportImpersonationRecord>;
  findById(id: string): Promise<SupportImpersonationRecord | null>;
  listByAccount(accountId: string, now: Date): Promise<SupportImpersonationRecord[]>;
  markStarted(id: string, startedAt: Date): Promise<SupportImpersonationRecord>;
  end(id: string, status: "ended" | "expired" | "revoked", endedAt: Date): Promise<SupportImpersonationRecord>;
}

export class SupportImpersonationRepository implements SupportImpersonationRepositoryPort {
  constructor(private readonly database: Database) {}

  async createApproved(input: {
    accountId: string;
    staffUserId: string;
    approverUserId: string;
    reason: string;
    expiresAt: Date;
  }): Promise<SupportImpersonationRecord> {
    const row = await this.database.queryOne<SupportImpersonationRow>(
      `INSERT INTO support_impersonation_sessions (
         id, account_id, staff_user_id, approver_user_id, reason, status, approved_at, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, 'approved', NOW(), $6)
       RETURNING id, account_id, staff_user_id, approver_user_id, reason, status, approved_at,
         started_at, expires_at, ended_at, created_at, updated_at`,
      [randomUUID(), input.accountId, input.staffUserId, input.approverUserId, input.reason, input.expiresAt],
    );

    return mapSession(row);
  }

  async findById(id: string): Promise<SupportImpersonationRecord | null> {
    const row = await this.database.queryOptional<SupportImpersonationRow>(
      `SELECT id, account_id, staff_user_id, approver_user_id, reason, status, approved_at,
         started_at, expires_at, ended_at, created_at, updated_at
       FROM support_impersonation_sessions
       WHERE id = $1`,
      [id],
    );

    return row ? mapSession(row) : null;
  }

  async listByAccount(accountId: string, now: Date): Promise<SupportImpersonationRecord[]> {
    const rows = await this.database.query<SupportImpersonationRow>(
      `SELECT id, account_id, staff_user_id, approver_user_id, reason, status, approved_at,
         started_at, expires_at, ended_at, created_at, updated_at
       FROM support_impersonation_sessions
       WHERE account_id = $1
         AND created_at >= $2
       ORDER BY created_at DESC`,
      [accountId, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)],
    );

    return rows.map(mapSession);
  }

  async markStarted(id: string, startedAt: Date): Promise<SupportImpersonationRecord> {
    const row = await this.database.queryOne<SupportImpersonationRow>(
      `UPDATE support_impersonation_sessions
       SET status = 'active', started_at = COALESCE(started_at, $2), updated_at = NOW()
       WHERE id = $1
       RETURNING id, account_id, staff_user_id, approver_user_id, reason, status, approved_at,
         started_at, expires_at, ended_at, created_at, updated_at`,
      [id, startedAt],
    );

    return mapSession(row);
  }

  async end(id: string, status: "ended" | "expired" | "revoked", endedAt: Date): Promise<SupportImpersonationRecord> {
    const row = await this.database.queryOne<SupportImpersonationRow>(
      `UPDATE support_impersonation_sessions
       SET status = $2, ended_at = COALESCE(ended_at, $3), updated_at = NOW()
       WHERE id = $1
       RETURNING id, account_id, staff_user_id, approver_user_id, reason, status, approved_at,
         started_at, expires_at, ended_at, created_at, updated_at`,
      [id, status, endedAt],
    );

    return mapSession(row);
  }
}
