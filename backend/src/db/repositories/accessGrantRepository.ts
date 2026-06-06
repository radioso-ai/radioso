import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import type {
  AccessGrantRole,
  AccessGrant,
  GrantPrincipalKind,
  OriginConstraint,
} from "../../modules/accessGrants/domain.js";

interface AccessGrantRow {
  id: string;
  agent_id: string;
  workspace_id: string;
  label: string | null;
  principal_kind: GrantPrincipalKind;
  role: AccessGrantRole;
  token_prefix: string;
  token_hash: string;
  encrypted_token: string;
  origin_mode: OriginConstraint["mode"];
  origin_allowlist: string[];
  enabled: boolean;
  expires_at: Date | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const mapOriginConstraint = (row: AccessGrantRow): OriginConstraint =>
  row.origin_mode === "allow-all"
    ? { mode: "allow-all", origins: [] }
    : { mode: "list", origins: row.origin_allowlist ?? [] };

const mapGrant = (row: AccessGrantRow): AccessGrant => ({
  id: row.id,
  agentId: row.agent_id,
  workspaceId: row.workspace_id,
  label: row.label,
  principalKind: row.principal_kind,
  role: row.role,
  tokenPrefix: row.token_prefix,
  tokenHash: row.token_hash,
  encryptedToken: row.encrypted_token,
  originConstraint: mapOriginConstraint(row),
  enabled: row.enabled,
  expiresAt: row.expires_at ? new Date(row.expires_at) : null,
  createdAt: new Date(row.created_at),
  lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
  revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
});

export interface AccessGrantRepositoryPort {
  findById(grantId: string): Promise<AccessGrant | null>;
  findByTokenHash(tokenHash: string): Promise<AccessGrant | null>;
  listByAgent(agentId: string): Promise<AccessGrant[]>;
  save(params: {
    agentId: string;
    workspaceId: string;
    label?: string | null;
    principalKind: GrantPrincipalKind;
    role: AccessGrantRole;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
    originConstraint: OriginConstraint;
    enabled?: boolean;
    expiresAt?: Date | null;
  }): Promise<AccessGrant>;
  rotate(grantId: string, params: {
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<AccessGrant | null>;
  revoke(grantId: string, revokedAt: Date): Promise<AccessGrant | null>;
  touch(grantId: string, lastUsedAt: Date): Promise<void>;
  updateConstraints(grantId: string, params: {
    originConstraint?: OriginConstraint;
    enabled?: boolean;
    label?: string | null;
  }): Promise<AccessGrant | null>;
}

const grantColumns = `
  id,
  agent_id,
  workspace_id,
  label,
  principal_kind,
  role,
  token_prefix,
  token_hash,
  encrypted_token,
  origin_mode,
  origin_allowlist,
  enabled,
  expires_at,
  created_at,
  last_used_at,
  revoked_at
`;

export class AccessGrantRepository implements AccessGrantRepositoryPort {
  constructor(private readonly database: Database) {}

  async findById(grantId: string): Promise<AccessGrant | null> {
    const row = await this.database.queryOptional<AccessGrantRow>(
      `SELECT ${grantColumns}
       FROM agent_access_grants
       WHERE id = $1`,
      [grantId],
    );
    return row ? mapGrant(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<AccessGrant | null> {
    const row = await this.database.queryOptional<AccessGrantRow>(
      `SELECT ${grantColumns}
       FROM agent_access_grants
       WHERE token_hash = $1`,
      [tokenHash],
    );
    return row ? mapGrant(row) : null;
  }

  async listByAgent(agentId: string): Promise<AccessGrant[]> {
    const rows = await this.database.query<AccessGrantRow>(
      `SELECT ${grantColumns}
       FROM agent_access_grants
       WHERE agent_id = $1
       ORDER BY created_at ASC, id ASC`,
      [agentId],
    );
    return rows.map(mapGrant);
  }

  async save(params: {
    agentId: string;
    workspaceId: string;
    label?: string | null;
    principalKind: GrantPrincipalKind;
    role: AccessGrantRole;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
    originConstraint: OriginConstraint;
    enabled?: boolean;
    expiresAt?: Date | null;
  }): Promise<AccessGrant> {
    const [row] = await this.database.query<AccessGrantRow>(
      `INSERT INTO agent_access_grants (
         id,
         agent_id,
         workspace_id,
         label,
         principal_kind,
         role,
         token_prefix,
         token_hash,
         encrypted_token,
         origin_mode,
         origin_allowlist,
         enabled,
         expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12, $13)
       ON CONFLICT (token_hash) DO UPDATE
       SET label = agent_access_grants.label
       RETURNING ${grantColumns}`,
      [
        randomUUID(),
        params.agentId,
        params.workspaceId,
        params.label ?? null,
        params.principalKind,
        params.role,
        params.tokenPrefix,
        params.tokenHash,
        params.encryptedToken,
        params.originConstraint.mode,
        params.originConstraint.mode === "allow-all" ? [] : params.originConstraint.origins,
        params.enabled ?? true,
        params.expiresAt ?? null,
      ],
    );
    return mapGrant(row);
  }

  async rotate(grantId: string, params: {
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<AccessGrant | null> {
    const row = await this.database.queryOptional<AccessGrantRow>(
      `UPDATE agent_access_grants
       SET token_prefix = $2,
           token_hash = $3,
           encrypted_token = $4,
           last_used_at = NULL,
           revoked_at = NULL
       WHERE id = $1
       RETURNING ${grantColumns}`,
      [grantId, params.tokenPrefix, params.tokenHash, params.encryptedToken],
    );
    return row ? mapGrant(row) : null;
  }

  async revoke(grantId: string, revokedAt: Date): Promise<AccessGrant | null> {
    const row = await this.database.queryOptional<AccessGrantRow>(
      `UPDATE agent_access_grants
       SET revoked_at = $2
       WHERE id = $1
       RETURNING ${grantColumns}`,
      [grantId, revokedAt],
    );
    return row ? mapGrant(row) : null;
  }

  async touch(grantId: string, lastUsedAt: Date): Promise<void> {
    await this.database.query(
      `UPDATE agent_access_grants
       SET last_used_at = $2
       WHERE id = $1
         AND revoked_at IS NULL`,
      [grantId, lastUsedAt],
    );
  }

  async updateConstraints(grantId: string, params: {
    originConstraint?: OriginConstraint;
    enabled?: boolean;
    label?: string | null;
  }): Promise<AccessGrant | null> {
    const current = await this.findById(grantId);
    if (!current) {
      return null;
    }
    const originConstraint = params.originConstraint ?? current.originConstraint;
    const row = await this.database.queryOptional<AccessGrantRow>(
      `UPDATE agent_access_grants
       SET origin_mode = $2,
           origin_allowlist = $3::text[],
           enabled = $4,
           label = $5
       WHERE id = $1
       RETURNING ${grantColumns}`,
      [
        grantId,
        originConstraint.mode,
        originConstraint.mode === "allow-all" ? [] : originConstraint.origins,
        params.enabled ?? current.enabled,
        params.label === undefined ? current.label : params.label,
      ],
    );
    return row ? mapGrant(row) : null;
  }
}
