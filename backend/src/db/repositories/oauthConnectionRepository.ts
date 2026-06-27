import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { OauthConnectionStatus } from "../../modules/integrationOauth/public.js";

export interface OauthConnectionRecord {
  id: string;
  workspaceId: string;
  provider: string;
  providerAccountId: string | null;
  displayName: string;
  status: OauthConnectionStatus;
  grantedScopes: string[];
  credentialCiphertext: string | null;
  encryptionKeyId: string | null;
  oauthClientCiphertext: string | null;
  oauthFlowCiphertext: string | null;
  lastRefreshAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOauthConnectionInput {
  workspaceId: string;
  provider: string;
  providerAccountId?: string | null;
  displayName: string;
  status?: OauthConnectionStatus;
  grantedScopes?: string[];
  credentialCiphertext?: string | null;
  encryptionKeyId?: string | null;
  oauthClientCiphertext?: string | null;
}

export interface UpdateOauthConnectionInput {
  displayName?: string;
  providerAccountId?: string | null;
  grantedScopes?: string[];
  status?: OauthConnectionStatus;
  credentialCiphertext?: string | null;
  encryptionKeyId?: string | null;
  oauthClientCiphertext?: string | null;
  oauthFlowCiphertext?: string | null;
  lastErrorCode?: string | null;
}

interface OauthConnectionRow {
  id: string;
  workspace_id: string;
  provider: string;
  provider_account_id: string | null;
  display_name: string;
  status: OauthConnectionStatus;
  granted_scopes: string[];
  credential_ciphertext: string | null;
  encryption_key_id: string | null;
  oauth_client_ciphertext: string | null;
  oauth_flow_ciphertext: string | null;
  last_refresh_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

const oauthColumns = [
  "id",
  "workspace_id",
  "provider",
  "provider_account_id",
  "display_name",
  "status",
  "granted_scopes",
  "credential_ciphertext",
  "encryption_key_id",
  "oauth_client_ciphertext",
  "oauth_flow_ciphertext",
  "last_refresh_at",
  "last_error_code",
  "created_at",
  "updated_at",
] as const;

const mapRecord = (row: OauthConnectionRow): OauthConnectionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  provider: row.provider,
  providerAccountId: row.provider_account_id,
  displayName: row.display_name,
  status: row.status,
  grantedScopes: row.granted_scopes ?? [],
  credentialCiphertext: row.credential_ciphertext,
  encryptionKeyId: row.encryption_key_id,
  oauthClientCiphertext: row.oauth_client_ciphertext,
  oauthFlowCiphertext: row.oauth_flow_ciphertext,
  lastRefreshAt: row.last_refresh_at ? new Date(row.last_refresh_at) : null,
  lastErrorCode: row.last_error_code,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface ListOauthConnectionsOptions {
  /**
   * Restrict the result to these providers. The connections table is a
   * provider-neutral spine shared by customer email, Slack, and future
   * integrations, so each consumer scopes the list to the providers it owns.
   */
  providers?: string[];
}

export interface OauthConnectionRepositoryPort {
  create(input: CreateOauthConnectionInput): Promise<OauthConnectionRecord>;
  findById(workspaceId: string, id: string): Promise<OauthConnectionRecord | null>;
  listByWorkspace(workspaceId: string, options?: ListOauthConnectionsOptions): Promise<OauthConnectionRecord[]>;
  updateStatus(workspaceId: string, id: string, status: OauthConnectionStatus): Promise<OauthConnectionRecord | null>;
  update(workspaceId: string, id: string, input: UpdateOauthConnectionInput): Promise<OauthConnectionRecord | null>;
  setOauthFlow(workspaceId: string, id: string, oauthFlowCiphertext: string): Promise<OauthConnectionRecord | null>;
  setOauthTokens(
    workspaceId: string,
    id: string,
    credentialCiphertext: string,
    encryptionKeyId: string | null,
    grantedScopes?: string[],
    providerAccountId?: string | null,
  ): Promise<OauthConnectionRecord | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

export class OauthConnectionRepository implements OauthConnectionRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: CreateOauthConnectionInput): Promise<OauthConnectionRecord> {
    const row = await this.db
      .insertInto("integration_oauth_connections")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        provider: input.provider,
        provider_account_id: input.providerAccountId ?? null,
        display_name: input.displayName,
        status: input.status ?? "pending",
        granted_scopes: input.grantedScopes ?? [],
        credential_ciphertext: input.credentialCiphertext ?? null,
        encryption_key_id: input.encryptionKeyId ?? null,
        oauth_client_ciphertext: input.oauthClientCiphertext ?? null,
      })
      .returning(oauthColumns)
      .executeTakeFirstOrThrow();
    return mapRecord(row as OauthConnectionRow);
  }

  async findById(workspaceId: string, id: string): Promise<OauthConnectionRecord | null> {
    const row = await this.db
      .selectFrom("integration_oauth_connections")
      .select(oauthColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row as OauthConnectionRow) : null;
  }

  async listByWorkspace(
    workspaceId: string,
    options?: ListOauthConnectionsOptions,
  ): Promise<OauthConnectionRecord[]> {
    let query = this.db
      .selectFrom("integration_oauth_connections")
      .select(oauthColumns)
      .where("workspace_id", "=", workspaceId);
    if (options?.providers && options.providers.length > 0) {
      query = query.where("provider", "in", options.providers);
    }
    const rows = await query.orderBy("created_at", "asc").execute();
    return rows.map((row) => mapRecord(row as OauthConnectionRow));
  }

  async updateStatus(
    workspaceId: string,
    id: string,
    status: OauthConnectionStatus,
  ): Promise<OauthConnectionRecord | null> {
    const row = await this.db
      .updateTable("integration_oauth_connections")
      .set({ status, updated_at: currentTimestamp() })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .returning(oauthColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as OauthConnectionRow) : null;
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateOauthConnectionInput,
  ): Promise<OauthConnectionRecord | null> {
    // Property presence (`"x" in input`) is the signal for which columns to write, matching
    // the original. Kysely merges chained .set() calls, so each is statically typed.
    let query = this.db.updateTable("integration_oauth_connections");
    let hasAssignment = false;

    if ("displayName" in input) {
      query = query.set({ display_name: input.displayName! });
      hasAssignment = true;
    }
    if ("providerAccountId" in input) {
      query = query.set({ provider_account_id: input.providerAccountId ?? null });
      hasAssignment = true;
    }
    if ("grantedScopes" in input) {
      query = query.set({ granted_scopes: input.grantedScopes ?? [] });
      hasAssignment = true;
    }
    if ("status" in input) {
      query = query.set({ status: input.status! });
      hasAssignment = true;
    }
    if ("credentialCiphertext" in input) {
      query = query.set({ credential_ciphertext: input.credentialCiphertext ?? null });
      hasAssignment = true;
    }
    if ("encryptionKeyId" in input) {
      query = query.set({ encryption_key_id: input.encryptionKeyId ?? null });
      hasAssignment = true;
    }
    if ("oauthClientCiphertext" in input) {
      query = query.set({ oauth_client_ciphertext: input.oauthClientCiphertext ?? null });
      hasAssignment = true;
    }
    if ("oauthFlowCiphertext" in input) {
      query = query.set({ oauth_flow_ciphertext: input.oauthFlowCiphertext ?? null });
      hasAssignment = true;
    }
    if ("lastErrorCode" in input) {
      query = query.set({ last_error_code: input.lastErrorCode ?? null });
      hasAssignment = true;
    }

    if (!hasAssignment) {
      return this.findById(workspaceId, id);
    }

    const row = await query
      .set({ updated_at: currentTimestamp() })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .returning(oauthColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as OauthConnectionRow) : null;
  }

  async setOauthFlow(
    workspaceId: string,
    id: string,
    oauthFlowCiphertext: string,
  ): Promise<OauthConnectionRecord | null> {
    const row = await this.db
      .updateTable("integration_oauth_connections")
      .set({
        oauth_flow_ciphertext: oauthFlowCiphertext,
        status: "pending",
        last_error_code: null,
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .returning(oauthColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as OauthConnectionRow) : null;
  }

  async setOauthTokens(
    workspaceId: string,
    id: string,
    credentialCiphertext: string,
    encryptionKeyId: string | null,
    grantedScopes?: string[],
    providerAccountId?: string | null,
  ): Promise<OauthConnectionRecord | null> {
    const row = await this.db
      .updateTable("integration_oauth_connections")
      .set((eb) => ({
        credential_ciphertext: credentialCiphertext,
        encryption_key_id: encryptionKeyId,
        // COALESCE(provided, existing): keep current value when the arg is null/undefined.
        granted_scopes: grantedScopes != null ? grantedScopes : eb.ref("granted_scopes"),
        provider_account_id: providerAccountId != null ? providerAccountId : eb.ref("provider_account_id"),
        oauth_flow_ciphertext: null,
        status: "authorized",
        last_refresh_at: currentTimestamp(),
        last_error_code: null,
        updated_at: currentTimestamp(),
      }))
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .returning(oauthColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as OauthConnectionRow) : null;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("integration_oauth_connections")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
