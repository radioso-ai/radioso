import { randomUUID } from "node:crypto";

import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  AccessGrantChannel,
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
  channel: AccessGrantChannel;
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
  channel: row.channel,
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
    channel?: AccessGrantChannel;
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

const grantColumns = [
  "id",
  "agent_id",
  "workspace_id",
  "label",
  "principal_kind",
  "role",
  "channel",
  "token_prefix",
  "token_hash",
  "encrypted_token",
  "origin_mode",
  "origin_allowlist",
  "enabled",
  "expires_at",
  "created_at",
  "last_used_at",
  "revoked_at",
] as const;

export class AccessGrantRepository implements AccessGrantRepositoryPort {
  constructor(private readonly db: Db) {}

  async findById(grantId: string): Promise<AccessGrant | null> {
    const row = await this.db
      .selectFrom("agent_access_grants")
      .select(grantColumns)
      .where("id", "=", grantId)
      .executeTakeFirst();
    return row ? mapGrant(row as AccessGrantRow) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<AccessGrant | null> {
    const row = await this.db
      .selectFrom("agent_access_grants")
      .select(grantColumns)
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();
    return row ? mapGrant(row as AccessGrantRow) : null;
  }

  async listByAgent(agentId: string): Promise<AccessGrant[]> {
    const rows = await this.db
      .selectFrom("agent_access_grants")
      .select(grantColumns)
      .where("agent_id", "=", agentId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map((row) => mapGrant(row as AccessGrantRow));
  }

  async save(params: {
    agentId: string;
    workspaceId: string;
    label?: string | null;
    principalKind: GrantPrincipalKind;
    role: AccessGrantRole;
    channel?: AccessGrantChannel;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
    originConstraint: OriginConstraint;
    enabled?: boolean;
    expiresAt?: Date | null;
  }): Promise<AccessGrant> {
    const row = await this.db
      .insertInto("agent_access_grants")
      .values({
        id: randomUUID(),
        agent_id: params.agentId,
        workspace_id: params.workspaceId,
        label: params.label ?? null,
        principal_kind: params.principalKind,
        role: params.role,
        channel: params.channel ?? "public-link",
        token_prefix: params.tokenPrefix,
        token_hash: params.tokenHash,
        encrypted_token: params.encryptedToken,
        origin_mode: params.originConstraint.mode,
        origin_allowlist:
          params.originConstraint.mode === "allow-all" ? [] : params.originConstraint.origins,
        enabled: params.enabled ?? true,
        expires_at: params.expiresAt ?? null,
      })
      .onConflict((oc) =>
        oc.column("token_hash").doUpdateSet((eb) => ({
          label: eb.ref("agent_access_grants.label"),
        })),
      )
      .returning(grantColumns)
      .executeTakeFirstOrThrow();
    return mapGrant(row as AccessGrantRow);
  }

  async rotate(grantId: string, params: {
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<AccessGrant | null> {
    const row = await this.db
      .updateTable("agent_access_grants")
      .set({
        token_prefix: params.tokenPrefix,
        token_hash: params.tokenHash,
        encrypted_token: params.encryptedToken,
        last_used_at: null,
        revoked_at: null,
      })
      .where("id", "=", grantId)
      .returning(grantColumns)
      .executeTakeFirst();
    return row ? mapGrant(row as AccessGrantRow) : null;
  }

  async revoke(grantId: string, revokedAt: Date): Promise<AccessGrant | null> {
    const row = await this.db
      .updateTable("agent_access_grants")
      .set({ revoked_at: revokedAt })
      .where("id", "=", grantId)
      .returning(grantColumns)
      .executeTakeFirst();
    return row ? mapGrant(row as AccessGrantRow) : null;
  }

  async touch(grantId: string, lastUsedAt: Date): Promise<void> {
    await this.db
      .updateTable("agent_access_grants")
      .set({ last_used_at: lastUsedAt })
      .where("id", "=", grantId)
      .where("revoked_at", "is", null)
      .execute();
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
    const row = await this.db
      .updateTable("agent_access_grants")
      .set({
        origin_mode: originConstraint.mode,
        origin_allowlist: originConstraint.mode === "allow-all" ? [] : originConstraint.origins,
        enabled: params.enabled ?? current.enabled,
        label: params.label === undefined ? current.label : params.label,
      })
      .where("id", "=", grantId)
      .returning(grantColumns)
      .executeTakeFirst();
    return row ? mapGrant(row as AccessGrantRow) : null;
  }
}
