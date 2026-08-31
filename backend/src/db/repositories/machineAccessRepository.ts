import { randomUUID } from "node:crypto";
import { sql } from "kysely";

import type { Db } from "../../shared/infra/kysely/types.js";
import type { MachineAccessRole, MachineCredentialKind, PersonalCredentialTenureEndReason, ServiceAccountStatus } from "../../modules/machineAccess/domain.js";
import type {
  ApiCredentialRecord,
  CredentialExpiryWarningClaim,
  MachineAccessPersistencePort,
  ServiceAccountRecord,
} from "../../modules/machineAccess/ports.js";

export type {
  ApiCredentialRecord,
  CredentialExpiryWarningClaim,
  ServiceAccountRecord,
} from "../../modules/machineAccess/ports.js";

const mapAccount = (row: Record<string, unknown>): ServiceAccountRecord => ({
  id: String(row.id), workspaceId: String(row.workspace_id), accountId: String(row.account_id), displayName: String(row.display_name),
  role: row.role as MachineAccessRole, status: row.status as ServiceAccountStatus, createdByUserId: row.created_by_user_id as string | null,
  createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)),
  disabledAt: row.disabled_at ? new Date(String(row.disabled_at)) : null, archivedAt: row.archived_at ? new Date(String(row.archived_at)) : null,
  lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)) : null,
  revision: Number(row.revision),
  activeCredentialCount: row.active_credential_count === undefined ? undefined : Number(row.active_credential_count),
});
const mapCredential = (row: Record<string, unknown>): ApiCredentialRecord => ({
  id: String(row.id), accountId: String(row.account_id), workspaceId: String(row.workspace_id), kind: row.kind as MachineCredentialKind, label: String(row.label),
  tokenPrefix: String(row.token_prefix), tokenHash: String(row.token_hash), roleCeiling: row.role_ceiling as MachineAccessRole | null,
  ownerUserId: row.owner_user_id as string | null, accessTenureMembershipId: row.access_tenure_membership_id as string | null,
  serviceAccountId: row.service_account_id as string | null, createdByUserId: row.created_by_user_id as string | null,
  createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)), expiresAt: new Date(String(row.expires_at)),
  lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)) : null, revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
  revokedByUserId: row.revoked_by_user_id as string | null, revocationReason: row.revocation_reason as string | null,
  rotatedFromCredentialId: row.rotated_from_credential_id as string | null, revision: Number(row.revision),
});

/** Persistence only: lifecycle and authorization decisions stay in machineAccess services. */
export class MachineAccessRepository implements MachineAccessPersistencePort {
  constructor(private readonly db: Db) {}

  async invalidatePersonalCredentialsForTenure(input: {
    membershipId: string;
    reason: PersonalCredentialTenureEndReason;
    actorUserId?: string | null;
    now: Date;
  }): Promise<ApiCredentialRecord[]> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx.updateTable("api_credentials").set({
        revoked_at: input.now,
        revoked_by_user_id: input.actorUserId ?? null,
        revocation_reason: input.reason,
        updated_at: input.now,
        revision: (eb) => eb("revision", "+", 1),
      }).where("kind", "=", "personal")
        .where("access_tenure_membership_id", "=", input.membershipId)
        .where("revoked_at", "is", null)
        .returningAll().execute();
      return rows.map((row) => mapCredential(row as Record<string, unknown>));
    });
  }

  async invalidatePersonalCredentialsForWorkspace(input: {
    workspaceId: string;
    reason: Extract<PersonalCredentialTenureEndReason, "workspace_deleted" | "account_deleted">;
    actorUserId?: string | null;
    now: Date;
  }): Promise<ApiCredentialRecord[]> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx.updateTable("api_credentials").set({
        revoked_at: input.now,
        revoked_by_user_id: input.actorUserId ?? null,
        revocation_reason: input.reason,
        updated_at: input.now,
        revision: (eb) => eb("revision", "+", 1),
      }).where("kind", "=", "personal")
        .where("workspace_id", "=", input.workspaceId)
        .where("revoked_at", "is", null)
        .returningAll().execute();
      return rows.map((row) => mapCredential(row as Record<string, unknown>));
    });
  }

  async invalidatePersonalCredentialsForAccount(input: {
    accountId: string;
    reason: Extract<PersonalCredentialTenureEndReason, "account_deleted">;
    actorUserId?: string | null;
    now: Date;
  }): Promise<ApiCredentialRecord[]> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx.updateTable("api_credentials").set({
        revoked_at: input.now,
        revoked_by_user_id: input.actorUserId ?? null,
        revocation_reason: input.reason,
        updated_at: input.now,
        revision: (eb) => eb("revision", "+", 1),
      }).where("kind", "=", "personal")
        .where("account_id", "=", input.accountId)
        .where("revoked_at", "is", null)
        .returningAll().execute();
      return rows.map((row) => mapCredential(row as Record<string, unknown>));
    });
  }

  async createPersonalWithinLimit(input: {
    accountId: string;
    workspaceId: string;
    ownerUserId: string;
    accessTenureMembershipId: string;
    roleCeiling: MachineAccessRole;
    label: string;
    expiresAt: Date;
    createdByUserId: string;
    now: Date;
    limit: number;
    issueSecret: () => { secret: string; tokenPrefix: string; tokenHash: string };
  }): Promise<{ credential: ApiCredentialRecord; secret: string } | null> {
    return this.db.transaction().execute(async (trx) => {
      const lockKey = `machine-personal:${input.workspaceId}:${input.ownerUserId}`;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
      const count = await trx.selectFrom("api_credentials").select(({ fn }) => fn.countAll<number>().as("count"))
        .where("workspace_id", "=", input.workspaceId).where("owner_user_id", "=", input.ownerUserId)
        .where("kind", "=", "personal").where("revoked_at", "is", null).where("expires_at", ">", input.now)
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= input.limit) return null;

      const issued = input.issueSecret();
      const row = await trx.insertInto("api_credentials").values({
        id: randomUUID(), account_id: input.accountId, workspace_id: input.workspaceId, kind: "personal", label: input.label,
        token_prefix: issued.tokenPrefix, token_hash: issued.tokenHash, role_ceiling: input.roleCeiling,
        owner_user_id: input.ownerUserId, access_tenure_membership_id: input.accessTenureMembershipId,
        created_by_user_id: input.createdByUserId, expires_at: input.expiresAt,
      }).returningAll().executeTakeFirstOrThrow();
      return { credential: mapCredential(row as Record<string, unknown>), secret: issued.secret };
    });
  }

  async findCredentialByHash(tokenHash: string): Promise<ApiCredentialRecord | null> {
    const row = await this.db.selectFrom("api_credentials").selectAll().where("token_hash", "=", tokenHash).executeTakeFirst();
    return row ? mapCredential(row as Record<string, unknown>) : null;
  }

  async findCredential(id: string): Promise<ApiCredentialRecord | null> {
    const row = await this.db.selectFrom("api_credentials").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? mapCredential(row as Record<string, unknown>) : null;
  }

  async findServiceAccount(id: string): Promise<ServiceAccountRecord | null> {
    const row = await this.db.selectFrom("workspace_service_accounts").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? mapAccount(row as Record<string, unknown>) : null;
  }

  async listServiceAccounts(input: { workspaceId: string; limit: number; page?: number }): Promise<ServiceAccountRecord[]> {
    const rows = await this.db.selectFrom("workspace_service_accounts").selectAll().where("workspace_id", "=", input.workspaceId)
      .orderBy("created_at", "desc").orderBy("id", "desc").limit(input.limit)
      .offset(((input.page ?? 1) - 1) * input.limit).execute();
    return Promise.all(rows.map(async (row) => ({
      ...mapAccount(row as Record<string, unknown>),
      activeCredentialCount: await this.countActiveServiceCredentials(String(row.id)),
    })));
  }

  async countServiceAccounts(workspaceId: string): Promise<number> {
    const row = await this.db.selectFrom("workspace_service_accounts").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("workspace_id", "=", workspaceId).executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async mutateServiceAccount(input: {
    id: string;
    workspaceId: string;
    expectedRevision: number;
    actorUserId: string;
    displayName?: string;
    role?: MachineAccessRole;
    targetStatus?: ServiceAccountStatus;
    now: Date;
  }): Promise<
    | { status: "updated"; account: ServiceAccountRecord; invalidatedCredentialIds: string[] }
    | { status: "conflict" }
    | { status: "missing" }
  > {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom("workspace_service_accounts").selectAll()
        .where("id", "=", input.id).where("workspace_id", "=", input.workspaceId)
        .forUpdate().executeTakeFirst();
      if (!existing) return { status: "missing" as const };
      if (Number(existing.revision) !== input.expectedRevision || existing.status === "archived") {
        return { status: "conflict" as const };
      }
      if (
        (input.targetStatus === "disabled" && existing.status !== "enabled")
        || (input.targetStatus === "enabled" && existing.status !== "disabled")
        || (input.targetStatus === "archived" && existing.status === "archived")
      ) {
        return { status: "conflict" as const };
      }

      const changes: Record<string, unknown> = {
        updated_at: input.now,
        revision: Number(existing.revision) + 1,
      };
      if (input.displayName !== undefined) changes.display_name = input.displayName;
      if (input.role !== undefined) changes.role = input.role;
      if (input.targetStatus !== undefined) {
        changes.status = input.targetStatus;
        if (input.targetStatus === "disabled") changes.disabled_at = input.now;
        if (input.targetStatus === "enabled") changes.disabled_at = null;
        if (input.targetStatus === "archived") changes.archived_at = input.now;
      }

      const row = await trx.updateTable("workspace_service_accounts").set(changes)
        .where("id", "=", input.id).where("revision", "=", input.expectedRevision)
        .returningAll().executeTakeFirst();
      if (!row) return { status: "conflict" as const };

      let invalidatedCredentialIds: string[] = [];
      if (input.targetStatus === "archived") {
        invalidatedCredentialIds = (await trx.updateTable("api_credentials").set({
          revoked_at: input.now,
          revoked_by_user_id: input.actorUserId,
          revocation_reason: "service_account_archived",
          updated_at: input.now,
          revision: (eb) => eb("revision", "+", 1),
        }).where("service_account_id", "=", input.id).where("revoked_at", "is", null)
          .returning("id").execute()).map((credential) => credential.id);
      }
      const activeCredentialCount = input.targetStatus === "archived"
        ? 0
        : await trx.selectFrom("api_credentials").select(({ fn }) => fn.countAll<number>().as("count"))
          .where("service_account_id", "=", input.id).where("revoked_at", "is", null)
          .where("expires_at", ">", input.now).executeTakeFirstOrThrow();
      return {
        status: "updated" as const,
        account: {
          ...mapAccount(row as Record<string, unknown>),
          activeCredentialCount: typeof activeCredentialCount === "number"
            ? activeCredentialCount
            : Number(activeCredentialCount.count),
        },
        invalidatedCredentialIds,
      };
    });
  }

  async createServiceAccountWithinLimit(input: {
    workspaceId: string;
    accountId: string;
    displayName: string;
    role: MachineAccessRole;
    createdByUserId: string;
    credentialLabel: string;
    expiresAt: Date;
    limit: number;
    issueSecret: () => { secret: string; tokenPrefix: string; tokenHash: string };
  }): Promise<{ account: ServiceAccountRecord; credential: ApiCredentialRecord; secret: string } | null> {
    return this.db.transaction().execute(async (trx) => {
      const lockKey = `machine-service-accounts:${input.workspaceId}`;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
      const count = await trx.selectFrom("workspace_service_accounts").select(({ fn }) => fn.countAll<number>().as("count"))
        .where("workspace_id", "=", input.workspaceId).where("status", "!=", "archived").executeTakeFirstOrThrow();
      if (Number(count.count) >= input.limit) return null;

      const accountRow = await trx.insertInto("workspace_service_accounts").values({
        id: randomUUID(), workspace_id: input.workspaceId, account_id: input.accountId,
        display_name: input.displayName, role: input.role, created_by_user_id: input.createdByUserId,
      }).returningAll().executeTakeFirstOrThrow();
      const issued = input.issueSecret();
      const credentialRow = await trx.insertInto("api_credentials").values({
        id: randomUUID(), account_id: input.accountId, workspace_id: input.workspaceId, kind: "service", label: input.credentialLabel,
        token_prefix: issued.tokenPrefix, token_hash: issued.tokenHash, service_account_id: accountRow.id,
        created_by_user_id: input.createdByUserId, expires_at: input.expiresAt,
      }).returningAll().executeTakeFirstOrThrow();
      return {
        account: { ...mapAccount(accountRow as Record<string, unknown>), activeCredentialCount: 1 },
        credential: mapCredential(credentialRow as Record<string, unknown>),
        secret: issued.secret,
      };
    });
  }

  async countActiveServiceCredentials(serviceAccountId: string): Promise<number> {
    const row = await this.db.selectFrom("api_credentials").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("service_account_id", "=", serviceAccountId).where("kind", "=", "service").where("revoked_at", "is", null).where("expires_at", ">", new Date()).executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async createServiceCredentialWithinLimit(input: {
    accountId: string;
    workspaceId: string;
    serviceAccountId: string;
    label: string;
    expiresAt: Date;
    createdByUserId: string;
    now: Date;
    limit: number;
    issueSecret: () => { secret: string; tokenPrefix: string; tokenHash: string };
  }): Promise<
    | { status: "created"; credential: ApiCredentialRecord; secret: string }
    | { status: "inactive" | "limit" | "missing" }
  > {
    return this.db.transaction().execute(async (trx) => {
      const lockKey = `machine-service-credentials:${input.serviceAccountId}`;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
      const account = await trx.selectFrom("workspace_service_accounts").selectAll()
        .where("id", "=", input.serviceAccountId).where("workspace_id", "=", input.workspaceId)
        .where("account_id", "=", input.accountId)
        .forUpdate().executeTakeFirst();
      if (!account) return { status: "missing" as const };
      if (account.status !== "enabled") return { status: "inactive" as const };

      const count = await trx.selectFrom("api_credentials").select(({ fn }) => fn.countAll<number>().as("count"))
        .where("service_account_id", "=", input.serviceAccountId).where("kind", "=", "service")
        .where("revoked_at", "is", null).where("expires_at", ">", input.now).executeTakeFirstOrThrow();
      if (Number(count.count) >= input.limit) return { status: "limit" as const };

      const issued = input.issueSecret();
      const row = await trx.insertInto("api_credentials").values({
        id: randomUUID(), account_id: input.accountId, workspace_id: input.workspaceId, kind: "service", label: input.label,
        token_prefix: issued.tokenPrefix, token_hash: issued.tokenHash, service_account_id: input.serviceAccountId,
        created_by_user_id: input.createdByUserId, expires_at: input.expiresAt,
      }).returningAll().executeTakeFirstOrThrow();
      return { status: "created" as const, credential: mapCredential(row as Record<string, unknown>), secret: issued.secret };
    });
  }

  async listCredentials(input: { workspaceId: string; kind?: MachineCredentialKind; ownerUserId?: string; serviceAccountId?: string; limit: number; page?: number }): Promise<ApiCredentialRecord[]> {
    let query = this.db.selectFrom("api_credentials").selectAll().where("workspace_id", "=", input.workspaceId).orderBy("created_at", "desc").orderBy("id", "desc").limit(input.limit).offset(((input.page ?? 1) - 1) * input.limit);
    if (input.kind) query = query.where("kind", "=", input.kind);
    if (input.ownerUserId) query = query.where("owner_user_id", "=", input.ownerUserId);
    if (input.serviceAccountId) query = query.where("service_account_id", "=", input.serviceAccountId);
    return (await query.execute()).map((row) => mapCredential(row as Record<string, unknown>));
  }

  async countCredentials(input: { workspaceId: string; kind?: MachineCredentialKind; ownerUserId?: string; serviceAccountId?: string }): Promise<number> {
    let query = this.db.selectFrom("api_credentials").select(({ fn }) => fn.countAll<number>().as("count")).where("workspace_id", "=", input.workspaceId);
    if (input.kind) query = query.where("kind", "=", input.kind);
    if (input.ownerUserId) query = query.where("owner_user_id", "=", input.ownerUserId);
    if (input.serviceAccountId) query = query.where("service_account_id", "=", input.serviceAccountId);
    return Number((await query.executeTakeFirstOrThrow()).count);
  }

  async findLegacyMigrationTime(workspaceId: string): Promise<Date | null> {
    const row = await this.db.selectFrom("legacy_workspace_credential_tombstones")
      .select(({ fn }) => fn.max("migrated_at").as("migrated_at"))
      .where("workspace_id", "=", workspaceId).executeTakeFirst();
    return row?.migrated_at ? new Date(String(row.migrated_at)) : null;
  }

  async revokeCredential(input: { id: string; actorUserId: string; expectedRevision?: number; now: Date }): Promise<boolean> {
    let query = this.db.updateTable("api_credentials").set({
      revoked_at: input.now,
      revoked_by_user_id: input.actorUserId,
      revocation_reason: "explicit",
      updated_at: input.now,
      revision: (eb) => eb("revision", "+", 1),
    }).where("id", "=", input.id).where("revoked_at", "is", null);
    if (input.expectedRevision !== undefined) query = query.where("revision", "=", input.expectedRevision);
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async relabelCredential(input: { id: string; label: string; expectedRevision?: number }): Promise<ApiCredentialRecord | null> {
    let query = this.db.updateTable("api_credentials").set({ label: input.label, updated_at: new Date(), revision: (eb) => eb("revision", "+", 1) })
      .where("id", "=", input.id).where("revoked_at", "is", null).where("expires_at", ">", new Date());
    if (input.expectedRevision !== undefined) query = query.where("revision", "=", input.expectedRevision);
    const row = await query.returningAll().executeTakeFirst();
    return row ? mapCredential(row as Record<string, unknown>) : null;
  }

  async replaceCredential(input: { credentialId: string; expectedRevision: number; label: string; tokenPrefix: string; tokenHash: string; createdByUserId: string }): Promise<ApiCredentialRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      const candidate = await trx.selectFrom("api_credentials").select(["id", "service_account_id"])
        .where("id", "=", input.credentialId).executeTakeFirst();
      if (!candidate) return null;

      // Archiving locks the parent before invalidating children. Take that same
      // lock first, then re-check both the parent and the credential so a
      // rotation cannot insert a replacement after archive has begun.
      if (candidate.service_account_id) {
        const parent = await trx.selectFrom("workspace_service_accounts").select(["id", "status"])
          .where("id", "=", candidate.service_account_id).forUpdate().executeTakeFirst();
        if (!parent || parent.status !== "enabled") return null;
      }

      const previous = await trx.selectFrom("api_credentials").selectAll().where("id", "=", input.credentialId)
        .where("revision", "=", input.expectedRevision).where("revoked_at", "is", null).where("expires_at", ">", new Date())
        .forUpdate().executeTakeFirst();
      if (!previous) return null;
      const now = new Date();
      const revoked = await trx.updateTable("api_credentials").set({
        revoked_at: now,
        revoked_by_user_id: input.createdByUserId,
        revocation_reason: "rotated",
        updated_at: now,
        revision: (eb) => eb("revision", "+", 1),
      })
        .where("id", "=", input.credentialId).where("revision", "=", input.expectedRevision).where("revoked_at", "is", null).executeTakeFirst();
      if (Number(revoked.numUpdatedRows) !== 1) return null;
      const row = await trx.insertInto("api_credentials").values({
        id: randomUUID(), account_id: previous.account_id, workspace_id: previous.workspace_id, kind: previous.kind, label: input.label,
        token_prefix: input.tokenPrefix, token_hash: input.tokenHash, role_ceiling: previous.role_ceiling,
        owner_user_id: previous.owner_user_id, access_tenure_membership_id: previous.access_tenure_membership_id,
        service_account_id: previous.service_account_id, created_by_user_id: input.createdByUserId,
        expires_at: previous.expires_at, rotated_from_credential_id: previous.id,
      }).returningAll().executeTakeFirstOrThrow();
      return mapCredential(row as Record<string, unknown>);
    });
  }

  async touchCredentialUse(input: { credentialId: string; serviceAccountId?: string | null; at: Date }): Promise<void> {
    const coalescingBoundary = new Date(input.at.getTime() - 5 * 60 * 1_000);
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable("api_credentials").set({ last_used_at: input.at })
        .where("id", "=", input.credentialId)
        .where((eb) => eb.or([eb("last_used_at", "is", null), eb("last_used_at", "<", coalescingBoundary)]))
        .execute();
      if (input.serviceAccountId) {
        await trx.updateTable("workspace_service_accounts").set({ last_used_at: input.at })
          .where("id", "=", input.serviceAccountId)
          .where((eb) => eb.or([eb("last_used_at", "is", null), eb("last_used_at", "<", coalescingBoundary)]))
          .execute();
      }
    });
  }

  async claimExpiryWarnings(now: Date): Promise<CredentialExpiryWarningClaim[]> {
    interface WarningRow {
      credential_id: string;
      workspace_id: string;
      account_id: string;
      principal_kind: "user" | "service";
      principal_id: string;
      threshold_days: 30 | 7 | 1;
      expires_at: Date;
    }
    const result = await sql<WarningRow>`
      WITH thresholds(threshold_days) AS (VALUES (30), (7), (1)),
      claimed AS (
        INSERT INTO api_credential_expiry_warnings (credential_id, threshold_days, claimed_at)
        SELECT credential.id, threshold.threshold_days, ${now}
        FROM api_credentials AS credential
        CROSS JOIN thresholds AS threshold
        JOIN workspaces AS workspace ON workspace.id = credential.workspace_id
        LEFT JOIN account_memberships AS membership
          ON membership.id = credential.access_tenure_membership_id
        LEFT JOIN workspace_service_accounts AS service_account
          ON service_account.id = credential.service_account_id
        WHERE credential.revoked_at IS NULL
          AND credential.account_id = workspace.account_id
          AND credential.expires_at > ${now}
          AND credential.expires_at <= ${now} + make_interval(days => threshold.threshold_days)
          AND (
            (
              credential.kind = 'personal'
              AND membership.status = 'active'
              AND membership.account_id = workspace.account_id
              AND membership.user_id = credential.owner_user_id
            )
            OR
            (
              credential.kind = 'service'
              AND service_account.status = 'enabled'
              AND service_account.workspace_id = credential.workspace_id
            )
          )
        ON CONFLICT (credential_id, threshold_days) DO NOTHING
        RETURNING credential_id, threshold_days
      )
      SELECT
        credential.id AS credential_id,
        credential.workspace_id,
        credential.account_id,
        CASE WHEN credential.kind = 'personal' THEN 'user' ELSE 'service' END AS principal_kind,
        CASE WHEN credential.kind = 'personal' THEN credential.owner_user_id ELSE credential.service_account_id END AS principal_id,
        claimed.threshold_days,
        credential.expires_at
      FROM claimed
      JOIN api_credentials AS credential ON credential.id = claimed.credential_id
      JOIN workspaces AS workspace ON workspace.id = credential.workspace_id
      ORDER BY credential.id, claimed.threshold_days DESC
    `.execute(this.db);

    return result.rows.map((row) => ({
      credentialId: row.credential_id,
      workspaceId: row.workspace_id,
      accountId: row.account_id,
      principalKind: row.principal_kind,
      principalId: row.principal_id,
      thresholdDays: row.threshold_days,
      expiresAt: new Date(row.expires_at),
    }));
  }

  async releaseExpiryWarning(credentialId: string, thresholdDays: 30 | 7 | 1): Promise<void> {
    await this.db.deleteFrom("api_credential_expiry_warnings")
      .where("credential_id", "=", credentialId)
      .where("threshold_days", "=", thresholdDays)
      .execute();
  }
}
