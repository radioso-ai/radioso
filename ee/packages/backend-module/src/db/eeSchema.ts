import {
  type Generated,
  Kysely,
  PostgresDialect,
  type Transaction,
} from "kysely";
import type { Pool } from "pg";

/**
 * EE's self-contained Kysely schema + builder.
 *
 * This package owns its OWN Kysely instance and `EeDatabase` interface. It must
 * NOT import the OSS `DB` type or any OSS `kysely` internals — the EE/OSS
 * boundary forbids EE from reaching into `backend/src`. At runtime the OSS
 * `Database` is handed to EE's registration callbacks (typed locally as
 * `UsageLimitDatabasePort`); it exposes the underlying `pg.Pool`, and EE builds
 * its own `Kysely<EeDatabase>` on that pool via `createEeKysely`.
 *
 * The pool is OWNED by the OSS `Database` (it configures timeouts/lifecycle and
 * closes it). EE never owns or destroys the pool, so the Kysely instances built
 * here must never have `.destroy()` called on them.
 *
 * Column-type conventions (match the authoritative DDL in
 * `usageLimits/usageLimitMigrator.ts`):
 *   - TEXT / UUID / DATE  -> string
 *   - INTEGER             -> number
 *   - BIGINT              -> string (node-postgres returns int8 as string)
 *   - TIMESTAMPTZ         -> Date
 *   - DB-defaulted cols   -> Generated<...>
 */

export interface EeUsageLimitProfilesTable {
  key: string;
  display_name: string;
  monthly_answer_limit: number | null;
  stored_document_limit: number | null;
  stored_indexed_byte_limit: string | null;
  monthly_indexed_byte_limit: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EeUsageLimitAccountAssignmentsTable {
  account_id: string;
  profile_key: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EeUsageLimitAnswerCountersTable {
  account_id: string;
  period_start: string;
  used_count: Generated<number>;
  updated_at: Generated<Date>;
}

export interface EeUsageLimitDocumentReservationsTable {
  id: string;
  account_id: string;
  workspace_id: string;
  created_at: Generated<Date>;
  expires_at: Date;
}

export interface EeUsageLimitStorageReservationsTable {
  id: string;
  account_id: string;
  workspace_id: string;
  bytes_reserved: string;
  created_at: Generated<Date>;
  expires_at: Date;
}

export interface EeUsageLimitMonthlyIndexedByteCountersTable {
  account_id: string;
  period_start: string;
  used_bytes: Generated<string>;
  updated_at: Generated<Date>;
}

export interface EeOrgCreationCountersTable {
  user_id: string;
  period_start: string;
  used_count: Generated<number>;
  updated_at: Generated<Date>;
}

export interface EeOrgCreationOverridesTable {
  user_id: string;
  monthly_limit: number | null;
  updated_at: Generated<Date>;
}

export interface EeStaffUsersTable {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: "support_read" | "billing_write" | "owner";
  status: "active" | "disabled";
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_login_at: Date | null;
}

export interface EeStaffSessionsTable {
  id: string;
  staff_id: string;
  session_token_hash: string;
  created_at: Generated<Date>;
  expires_at: Date;
  last_seen_at: Generated<Date>;
  revoked_at: Date | null;
}

/**
 * Shared (OSS-owned) tables this module only reads to resolve account scope and
 * to count stored documents / persisted assistant answers. EE neither migrates
 * nor writes these; the column subset here is just what the usage-limit reads
 * touch.
 */
export interface EeWorkspacesTable {
  id: string;
  account_id: string;
}

export interface EeDocumentsTable {
  id: string;
  workspace_id: string;
  content_size_bytes: number | null;
  external_document_id: string | null;
  source_kind: string | null;
}

export interface EeMessagesTable {
  id: string;
  workspace_id: string;
  role: string;
  created_at: Date;
}

export interface EeAccountsTable {
  id: string;
  name: string;
  email: string;
  created_at: Date;
  updated_at: Date;
}

export interface EeAccountMembershipsTable {
  account_id: string;
  user_id: string;
  role: string;
  status: string;
  created_at: Date;
}

export interface EeUsersTable {
  id: string;
  email: string;
}

export interface EeDatabase {
  ee_usage_limit_profiles: EeUsageLimitProfilesTable;
  ee_usage_limit_account_assignments: EeUsageLimitAccountAssignmentsTable;
  ee_usage_limit_answer_counters: EeUsageLimitAnswerCountersTable;
  ee_usage_limit_document_reservations: EeUsageLimitDocumentReservationsTable;
  ee_usage_limit_storage_reservations: EeUsageLimitStorageReservationsTable;
  ee_usage_limit_monthly_indexed_byte_counters: EeUsageLimitMonthlyIndexedByteCountersTable;
  ee_org_creation_counters: EeOrgCreationCountersTable;
  ee_org_creation_overrides: EeOrgCreationOverridesTable;
  ee_staff_users: EeStaffUsersTable;
  ee_staff_sessions: EeStaffSessionsTable;
  accounts: EeAccountsTable;
  account_memberships: EeAccountMembershipsTable;
  users: EeUsersTable;
  workspaces: EeWorkspacesTable;
  documents: EeDocumentsTable;
  messages: EeMessagesTable;
}

export type EeDb = Kysely<EeDatabase> | Transaction<EeDatabase>;

/**
 * Memoize one Kysely instance per `pg.Pool`. Services/guards are constructed
 * multiple times (per request, per registration callback) against the same OSS
 * `Database` pool; building a fresh `Kysely` each time is wasteful, so reuse one
 * instance per pool. A `WeakMap` lets the entry be collected if the pool itself
 * is ever discarded.
 */
const kyselyByPool = new WeakMap<Pool, Kysely<EeDatabase>>();

export const createEeKysely = (pool: Pool): Kysely<EeDatabase> => {
  const existing = kyselyByPool.get(pool);
  if (existing) {
    return existing;
  }
  const instance = new Kysely<EeDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
  kyselyByPool.set(pool, instance);
  return instance;
};
