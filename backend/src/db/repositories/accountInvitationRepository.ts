import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
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

const accountInvitationColumns = [
  "id",
  "account_id",
  "email",
  "invited_by_membership_id",
  "token_hash",
  "status",
  "expires_at",
  "accepted_at",
  "accepted_by_user_id",
  "role",
  "created_at",
  "updated_at",
] as const;

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
  findById(id: string): Promise<AccountInvitationRecord | null>;
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
  constructor(private readonly db: Db) {}

  async create(params: {
    accountId: string;
    email: string;
    invitedByMembershipId: string;
    tokenHash: string;
    role: AccountInvitationRole;
    status?: AccountInvitationStatus;
    expiresAt: Date;
  }): Promise<AccountInvitationRecord> {
    const row = await this.db
      .insertInto("account_invitations")
      .values({
        id: randomUUID(),
        account_id: params.accountId,
        email: params.email,
        invited_by_membership_id: params.invitedByMembershipId,
        token_hash: params.tokenHash,
        role: params.role,
        status: params.status ?? "pending",
        expires_at: params.expiresAt,
      })
      .returning(accountInvitationColumns)
      .executeTakeFirstOrThrow();

    return mapInvitation(row as AccountInvitationRow);
  }

  async findById(id: string): Promise<AccountInvitationRecord | null> {
    const row = await this.db
      .selectFrom("account_invitations")
      .select(accountInvitationColumns)
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapInvitation(row as AccountInvitationRow) : null;
  }

  async findPendingByAccountAndEmail(accountId: string, email: string): Promise<AccountInvitationRecord | null> {
    const row = await this.db
      .selectFrom("account_invitations")
      .select(accountInvitationColumns)
      .where("account_id", "=", accountId)
      .where("email", "=", email)
      .where("status", "=", "pending")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapInvitation(row as AccountInvitationRow) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<AccountInvitationRecord | null> {
    const row = await this.db
      .selectFrom("account_invitations")
      .select(accountInvitationColumns)
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();

    return row ? mapInvitation(row as AccountInvitationRow) : null;
  }

  async listByAccount(accountId: string): Promise<AccountInvitationRecord[]> {
    const rows = await this.db
      .selectFrom("account_invitations")
      .select(accountInvitationColumns)
      .where("account_id", "=", accountId)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map((row) => mapInvitation(row as AccountInvitationRow));
  }

  async update(params: {
    id: string;
    status: AccountInvitationStatus;
    acceptedAt?: Date | null;
    acceptedByUserId?: string | null;
  }): Promise<AccountInvitationRecord> {
    const row = await this.db
      .updateTable("account_invitations")
      .set({
        status: params.status,
        accepted_at: params.acceptedAt ?? null,
        accepted_by_user_id: params.acceptedByUserId ?? null,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", params.id)
      .returning(accountInvitationColumns)
      .executeTakeFirstOrThrow();

    return mapInvitation(row as AccountInvitationRow);
  }
}
