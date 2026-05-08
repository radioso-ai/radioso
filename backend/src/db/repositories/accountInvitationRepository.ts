import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import type { AccountMembershipRole } from "./accountMembershipRepository.js";

export type AccountInvitationStatus = "pending" | "accepted" | "revoked" | "expired";
export type AccountInvitationRole = Exclude<AccountMembershipRole, "owner">;

export interface AccountInvitationRecord {
  id: string;
  accountId: string;
  email: string;
  invitedByMembershipId: string;
  tokenHash: string;
  status: AccountInvitationStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  role: AccountInvitationRole;
  createdAt: Date;
  updatedAt: Date;
}

interface AccountInvitationRow {
  id: string;
  account_id: string;
  email: string;
  invited_by_membership_id: string;
  token_hash: string;
  status: AccountInvitationStatus;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by_user_id: string | null;
  role: AccountInvitationRole;
  created_at: Date;
  updated_at: Date;
}

const mapInvitation = (row: AccountInvitationRow): AccountInvitationRecord => ({
  id: row.id,
  accountId: row.account_id,
  email: row.email,
  invitedByMembershipId: row.invited_by_membership_id,
  tokenHash: row.token_hash,
  status: row.status,
  expiresAt: new Date(row.expires_at),
  acceptedAt: row.accepted_at ? new Date(row.accepted_at) : null,
  acceptedByUserId: row.accepted_by_user_id,
  role: row.role ?? "member",
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface AccountInvitationRepositoryPort {
  create(params: {
    accountId: string;
    email: string;
    invitedByMembershipId: string;
    tokenHash: string;
    role: AccountInvitationRole;
    status?: AccountInvitationStatus;
    expiresAt: Date;
  }): Promise<AccountInvitationRecord>;
  findPendingByAccountAndEmail(accountId: string, email: string): Promise<AccountInvitationRecord | null>;
  findByTokenHash(tokenHash: string): Promise<AccountInvitationRecord | null>;
  listByAccount(accountId: string): Promise<AccountInvitationRecord[]>;
  update(params: {
    id: string;
    status: AccountInvitationStatus;
    acceptedAt?: Date | null;
    acceptedByUserId?: string | null;
  }): Promise<AccountInvitationRecord>;
}

export class AccountInvitationRepository implements AccountInvitationRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(params: {
    accountId: string;
    email: string;
    invitedByMembershipId: string;
    tokenHash: string;
    role: AccountInvitationRole;
    status?: AccountInvitationStatus;
    expiresAt: Date;
  }): Promise<AccountInvitationRecord> {
    const [row] = await this.database.query<AccountInvitationRow>(
      `INSERT INTO account_invitations (
         id,
         account_id,
         email,
         invited_by_membership_id,
         token_hash,
         role,
         status,
         expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, account_id, email, invited_by_membership_id, token_hash, status, expires_at, accepted_at, accepted_by_user_id, role, created_at, updated_at`,
      [
        randomUUID(),
        params.accountId,
        params.email,
        params.invitedByMembershipId,
        params.tokenHash,
        params.role,
        params.status ?? "pending",
        params.expiresAt,
      ],
    );

    return mapInvitation(row);
  }

  async findPendingByAccountAndEmail(accountId: string, email: string): Promise<AccountInvitationRecord | null> {
    const [row] = await this.database.query<AccountInvitationRow>(
      `SELECT id, account_id, email, invited_by_membership_id, token_hash, status, expires_at, accepted_at, accepted_by_user_id, role, created_at, updated_at
       FROM account_invitations
       WHERE account_id = $1
         AND email = $2
         AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      [accountId, email],
    );

    return row ? mapInvitation(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<AccountInvitationRecord | null> {
    const [row] = await this.database.query<AccountInvitationRow>(
      `SELECT id, account_id, email, invited_by_membership_id, token_hash, status, expires_at, accepted_at, accepted_by_user_id, role, created_at, updated_at
       FROM account_invitations
       WHERE token_hash = $1`,
      [tokenHash],
    );

    return row ? mapInvitation(row) : null;
  }

  async listByAccount(accountId: string): Promise<AccountInvitationRecord[]> {
    const rows = await this.database.query<AccountInvitationRow>(
      `SELECT id, account_id, email, invited_by_membership_id, token_hash, status, expires_at, accepted_at, accepted_by_user_id, role, created_at, updated_at
       FROM account_invitations
       WHERE account_id = $1
       ORDER BY created_at DESC`,
      [accountId],
    );

    return rows.map(mapInvitation);
  }

  async update(params: {
    id: string;
    status: AccountInvitationStatus;
    acceptedAt?: Date | null;
    acceptedByUserId?: string | null;
  }): Promise<AccountInvitationRecord> {
    const [row] = await this.database.query<AccountInvitationRow>(
      `UPDATE account_invitations
       SET status = $2,
           accepted_at = $3,
           accepted_by_user_id = $4,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, account_id, email, invited_by_membership_id, token_hash, status, expires_at, accepted_at, accepted_by_user_id, role, created_at, updated_at`,
      [params.id, params.status, params.acceptedAt ?? null, params.acceptedByUserId ?? null],
    );

    return mapInvitation(row);
  }
}
