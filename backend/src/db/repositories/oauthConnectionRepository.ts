import { randomUUID } from "node:crypto";

import type { OauthConnectionStatus } from "../../modules/integrationOauth/public.js";
import type { Database } from "../../shared/infra/database.js";

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

const COLUMNS =
  "id, workspace_id, provider, provider_account_id, display_name, status, granted_scopes, credential_ciphertext, encryption_key_id, oauth_client_ciphertext, oauth_flow_ciphertext, last_refresh_at, last_error_code, created_at, updated_at";

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

export interface OauthConnectionRepositoryPort {
  create(input: CreateOauthConnectionInput): Promise<OauthConnectionRecord>;
  findById(workspaceId: string, id: string): Promise<OauthConnectionRecord | null>;
  listByWorkspace(workspaceId: string): Promise<OauthConnectionRecord[]>;
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
  constructor(private readonly database: Database) {}

  async create(input: CreateOauthConnectionInput): Promise<OauthConnectionRecord> {
    const [row] = await this.database.query<OauthConnectionRow>(
      `INSERT INTO integration_oauth_connections
         (id, workspace_id, provider, provider_account_id, display_name, status, granted_scopes,
          credential_ciphertext, encryption_key_id, oauth_client_ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.workspaceId,
        input.provider,
        input.providerAccountId ?? null,
        input.displayName,
        input.status ?? "pending",
        input.grantedScopes ?? [],
        input.credentialCiphertext ?? null,
        input.encryptionKeyId ?? null,
        input.oauthClientCiphertext ?? null,
      ],
    );
    return mapRecord(row);
  }

  async findById(workspaceId: string, id: string): Promise<OauthConnectionRecord | null> {
    const [row] = await this.database.query<OauthConnectionRow>(
      `SELECT ${COLUMNS} FROM integration_oauth_connections WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    );
    return row ? mapRecord(row) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<OauthConnectionRecord[]> {
    const rows = await this.database.query<OauthConnectionRow>(
      `SELECT ${COLUMNS}
       FROM integration_oauth_connections
       WHERE workspace_id = $1
       ORDER BY created_at ASC`,
      [workspaceId],
    );
    return rows.map(mapRecord);
  }

  async updateStatus(
    workspaceId: string,
    id: string,
    status: OauthConnectionStatus,
  ): Promise<OauthConnectionRecord | null> {
    const [row] = await this.database.query<OauthConnectionRow>(
      `UPDATE integration_oauth_connections
       SET status = $3, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [workspaceId, id, status],
    );
    return row ? mapRecord(row) : null;
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateOauthConnectionInput,
  ): Promise<OauthConnectionRecord | null> {
    const assignments: string[] = [];
    const params: unknown[] = [workspaceId, id];
    const addAssignment = (column: string, value: unknown): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };

    if ("displayName" in input) {
      addAssignment("display_name", input.displayName);
    }
    if ("providerAccountId" in input) {
      addAssignment("provider_account_id", input.providerAccountId ?? null);
    }
    if ("grantedScopes" in input) {
      addAssignment("granted_scopes", input.grantedScopes ?? []);
    }
    if ("status" in input) {
      addAssignment("status", input.status);
    }
    if ("credentialCiphertext" in input) {
      addAssignment("credential_ciphertext", input.credentialCiphertext ?? null);
    }
    if ("encryptionKeyId" in input) {
      addAssignment("encryption_key_id", input.encryptionKeyId ?? null);
    }
    if ("oauthClientCiphertext" in input) {
      addAssignment("oauth_client_ciphertext", input.oauthClientCiphertext ?? null);
    }
    if ("oauthFlowCiphertext" in input) {
      addAssignment("oauth_flow_ciphertext", input.oauthFlowCiphertext ?? null);
    }
    if ("lastErrorCode" in input) {
      addAssignment("last_error_code", input.lastErrorCode ?? null);
    }

    if (assignments.length === 0) {
      return this.findById(workspaceId, id);
    }

    const [row] = await this.database.query<OauthConnectionRow>(
      `UPDATE integration_oauth_connections
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      params,
    );
    return row ? mapRecord(row) : null;
  }

  async setOauthFlow(
    workspaceId: string,
    id: string,
    oauthFlowCiphertext: string,
  ): Promise<OauthConnectionRecord | null> {
    const [row] = await this.database.query<OauthConnectionRow>(
      `UPDATE integration_oauth_connections
       SET oauth_flow_ciphertext = $3, status = 'pending', last_error_code = NULL, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [workspaceId, id, oauthFlowCiphertext],
    );
    return row ? mapRecord(row) : null;
  }

  async setOauthTokens(
    workspaceId: string,
    id: string,
    credentialCiphertext: string,
    encryptionKeyId: string | null,
    grantedScopes?: string[],
    providerAccountId?: string | null,
  ): Promise<OauthConnectionRecord | null> {
    const [row] = await this.database.query<OauthConnectionRow>(
      `UPDATE integration_oauth_connections
       SET credential_ciphertext = $3,
           encryption_key_id = $4,
           granted_scopes = COALESCE($5::text[], granted_scopes),
           provider_account_id = COALESCE($6, provider_account_id),
           oauth_flow_ciphertext = NULL,
           status = 'authorized',
           last_refresh_at = NOW(),
           last_error_code = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [workspaceId, id, credentialCiphertext, encryptionKeyId, grantedScopes ?? null, providerAccountId ?? null],
    );
    return row ? mapRecord(row) : null;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const affected = await this.database.execute(
      `DELETE FROM integration_oauth_connections WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    );
    return affected > 0;
  }
}
