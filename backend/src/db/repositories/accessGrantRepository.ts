import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { DB, Db } from "../../shared/infra/kysely/types.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import { AuditEventRepository } from "./auditEventRepository.js";
import type {
  AccessGrantChannel,
  AccessGrantRole,
  AccessGrant,
  GrantPrincipalKind,
  OriginConstraint,
} from "../../modules/accessGrants/domain.js";
import type {
  AccessGrantLifecycleAuditEvent,
  AccessGrantRepositoryPort,
  AccessGrantLifecycleUnitOfWorkPort,
  AccessGrantLifecycleResult,
  AccessGrantLifecycleSaveInput,
  AccessGrantLifecycleRotateInput,
} from "../../modules/accessGrants/ports.js";

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
  encrypted_token: string | null;
  origin_mode: OriginConstraint["mode"];
  origin_allowlist: string[];
  enabled: boolean;
  expires_at: Date | null;
  created_at: Date;
  created_at_text?: string;
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

  async listByAgent(agentId: string, params: {
    workspaceId?: string;
    principalKind?: GrantPrincipalKind;
    channel?: AccessGrantChannel;
    limit?: number;
    cursor?: { createdAt: string; id: string };
  } = {}): Promise<{ grants: AccessGrant[]; nextCursor: { createdAt: string; id: string } | null }> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    let query = this.db
      .selectFrom("agent_access_grants")
      .select([...grantColumns, sql<string>`created_at::text`.as("created_at_text")])
      .where("agent_id", "=", agentId);
    if (params.workspaceId) query = query.where("workspace_id", "=", params.workspaceId);
    if (params.principalKind) query = query.where("principal_kind", "=", params.principalKind);
    if (params.channel) {
      query = query.where("channel", "=", params.channel);
    }
    if (params.cursor) {
      query = query.where((eb) => eb.or([
        eb("created_at", ">", sql<Date>`CAST(${params.cursor!.createdAt} AS timestamptz)`),
        eb.and([
          eb("created_at", "=", sql<Date>`CAST(${params.cursor!.createdAt} AS timestamptz)`),
          eb("id", ">", params.cursor!.id),
        ]),
      ]));
    }
    const rows = await query
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(limit + 1)
      .execute();
    const grants = rows.slice(0, limit).map((row) => mapGrant(row as AccessGrantRow));
    const lastRow = rows.length > limit ? rows[limit - 1] as AccessGrantRow : undefined;
    return {
      grants,
      nextCursor: lastRow?.created_at_text ? { createdAt: lastRow.created_at_text, id: lastRow.id } : null,
    };
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
    encryptedToken: string | null;
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
    encryptedToken: string | null;
    expectedTokenHash?: string;
    requireActiveAgentChannel?: boolean;
    now?: Date;
  }): Promise<AccessGrant | null> {
    let query = this.db
      .updateTable("agent_access_grants")
      .set({
        token_prefix: params.tokenPrefix,
        token_hash: params.tokenHash,
        encrypted_token: params.encryptedToken,
        last_used_at: null,
        revoked_at: null,
      })
      .where("id", "=", grantId);
    if (params.expectedTokenHash) query = query.where("token_hash", "=", params.expectedTokenHash);
    if (params.requireActiveAgentChannel) {
      query = query
        .where("principal_kind", "=", "agent-api")
        .where("revoked_at", "is", null)
        .where((eb) => eb.or([
          eb("expires_at", "is", null),
          eb("expires_at", ">", currentTimestamp()),
        ]));
    }
    const row = await query.returning(grantColumns).executeTakeFirst();
    return row ? mapGrant(row as AccessGrantRow) : null;
  }

  async revoke(grantId: string, revokedAt: Date): Promise<AccessGrant | null> {
    const row = await this.db
      .updateTable("agent_access_grants")
      .set((eb) => ({ revoked_at: eb.fn.coalesce("revoked_at", eb.val(revokedAt)) }))
      .where("id", "=", grantId)
      .returning(grantColumns)
      .executeTakeFirst();
    return row ? mapGrant(row as AccessGrantRow) : null;
  }

  async touch(grantId: string, lastUsedAt: Date): Promise<void> {
    const coalescingBoundary = new Date(lastUsedAt.getTime() - 5 * 60 * 1_000);
    await this.db
      .updateTable("agent_access_grants")
      .set({ last_used_at: lastUsedAt })
      .where("id", "=", grantId)
      .where("revoked_at", "is", null)
      .where((eb) => eb.or([
        eb("last_used_at", "is", null),
        eb("last_used_at", "<", coalescingBoundary),
      ]))
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

/** Postgres composition for the grant mutation + audit transaction boundary. */
export class AccessGrantLifecycleUnitOfWork implements AccessGrantLifecycleUnitOfWorkPort {
  constructor(private readonly db: Kysely<DB>) {}

  async issue(input: {
    grant: AccessGrantLifecycleSaveInput;
    auditEvent: (grant: AccessGrant) => AccessGrantLifecycleAuditEvent;
  }): Promise<AccessGrantLifecycleResult> {
    return this.db.transaction().execute(async (trx) => {
      const grant = await new AccessGrantRepository(trx).save(input.grant);
      const auditEvent = input.auditEvent(grant);
      await new AuditEventRepository(trx).create(auditEvent);
      return { grant, auditEvent };
    });
  }

  async rotate(input: {
    grant: AccessGrantLifecycleRotateInput;
    auditEvent: (grant: AccessGrant) => AccessGrantLifecycleAuditEvent;
  }): Promise<AccessGrantLifecycleResult | null> {
    return this.db.transaction().execute(async (trx) => {
      const grant = await new AccessGrantRepository(trx).rotate(input.grant.grantId, input.grant);
      if (!grant) return null;
      const auditEvent = input.auditEvent(grant);
      await new AuditEventRepository(trx).create(auditEvent);
      return { grant, auditEvent };
    });
  }

  async revoke(input: {
    grantId: string;
    revokedAt: Date;
    auditEvent: (grant: AccessGrant) => AccessGrantLifecycleAuditEvent;
  }): Promise<AccessGrantLifecycleResult | null> {
    return this.db.transaction().execute(async (trx) => {
      const grant = await new AccessGrantRepository(trx).revoke(input.grantId, input.revokedAt);
      if (!grant) return null;
      const auditEvent = input.auditEvent(grant);
      await new AuditEventRepository(trx).create(auditEvent);
      return { grant, auditEvent };
    });
  }
}
