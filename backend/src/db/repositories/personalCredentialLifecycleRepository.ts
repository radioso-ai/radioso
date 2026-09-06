import { randomUUID } from "node:crypto";
import { sql } from "kysely";

import { machineAccessAuditEvent, transactionalLifecycleAuditEvent } from "../../modules/machineAccess/auditMetadata.js";
import type {
  MachineAccessAuditEvent,
  PersonalCredentialLifecyclePort,
  TransactionalLifecycleAuditEvent,
} from "../../modules/machineAccess/ports.js";
import { toSanitizedJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface InvalidatedCredential {
  id: string;
  workspace_id: string;
  owner_user_id: string | null;
}

/**
 * The sole storage adapter allowed to combine tenancy deletion and API
 * credential invalidation. It keeps lifecycle domains independent of one
 * another while ensuring a committed parent deletion can never leave an
 * active personal credential behind.
 */
export class PersonalCredentialLifecycleRepository implements PersonalCredentialLifecyclePort {
  constructor(private readonly db: Db) {}

  async removeMembership(input: {
    accountId: string;
    membershipId: string;
    userId: string;
    actorUserId?: string | null;
    auditEvent?: TransactionalLifecycleAuditEvent;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await this.lockMembership(trx, input.membershipId);
      const membership = await trx.selectFrom("account_memberships")
        .select(["id", "account_id", "user_id"])
        .where("id", "=", input.membershipId)
        .where("account_id", "=", input.accountId)
        .forUpdate()
        .executeTakeFirst();
      if (!membership || membership.user_id !== input.userId) return false;

      const invalidated = await this.invalidateByMembership(trx, input.membershipId, input.actorUserId, "membership_ended");
      await this.invalidateOperatorGrantsByMembership(trx, input.membershipId, "membership_ended");
      await trx.deleteFrom("workspace_grants")
        .where("account_id", "=", input.accountId)
        .where("user_id", "=", input.userId)
        .execute();
      await this.insertAuditEvents(trx, [
        ...this.invalidationEvents(input.accountId, invalidated, input.actorUserId, "membership_ended"),
        ...(input.auditEvent ? [this.contextualize(input.auditEvent)] : []),
      ]);
      const deleted = await trx.deleteFrom("account_memberships").where("id", "=", input.membershipId).executeTakeFirst();
      return Number(deleted.numDeletedRows) === 1;
    });
  }

  async deleteWorkspace(input: {
    accountId: string;
    workspaceId: string;
    actorUserId?: string | null;
    auditEvent?: TransactionalLifecycleAuditEvent;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // Rotation takes a tenure lock before its credential row. Acquire every
      // affected tenure lock before the workspace row so the delete never
      // holds the parent while waiting on a rotation that needs that parent
      // for its replacement credential's foreign-key check.
      await this.lockActivePersonalTenuresForWorkspace(trx, input.workspaceId);
      const workspace = await trx.selectFrom("workspaces")
        .select("id")
        .where("id", "=", input.workspaceId)
        .where("account_id", "=", input.accountId)
        .forUpdate()
        .executeTakeFirst();
      if (!workspace) return false;
      const invalidated = await this.invalidateByWorkspace(trx, input.workspaceId, input.actorUserId, "workspace_deleted");
      await this.invalidateOperatorGrantsByWorkspace(trx, input.workspaceId, "workspace_deleted");
      await this.insertAuditEvents(trx, [
        ...this.invalidationEvents(input.accountId, invalidated, input.actorUserId, "workspace_deleted"),
        ...(input.auditEvent ? [this.contextualize(input.auditEvent)] : []),
      ]);
      await this.deleteOperatorMcpWorkspaceHistory(trx, input.workspaceId);
      const deleted = await trx.deleteFrom("workspaces")
        .where("id", "=", input.workspaceId)
        .where("account_id", "=", input.accountId)
        .executeTakeFirst();
      return Number(deleted.numDeletedRows) === 1;
    });
  }

  async deleteAccount(input: {
    accountId: string;
    actorUserId?: string | null;
    auditEvent?: TransactionalLifecycleAuditEvent;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // See workspace deletion above. Account deletion must not invert the
      // membership -> credential -> parent ordering used by personal rotation.
      await this.lockActivePersonalTenuresForAccount(trx, input.accountId);
      const account = await trx.selectFrom("accounts").select("id").where("id", "=", input.accountId).forUpdate().executeTakeFirst();
      if (!account) return false;
      const invalidated = await this.invalidateByAccount(trx, input.accountId, input.actorUserId, "account_deleted");
      await this.invalidateOperatorGrantsByAccount(trx, input.accountId, "account_deleted");
      await this.insertAuditEvents(trx, [
        ...this.invalidationEvents(input.accountId, invalidated, input.actorUserId, "account_deleted"),
        ...(input.auditEvent ? [this.contextualize(input.auditEvent)] : []),
      ]);
      // Delete workspaces before the account. Besides making the ownership
      // boundary explicit, this lets audit_events.workspace_id transition to
      // NULL before audit_events.account_id does, avoiding Postgres' competing
      // account->workspace and account->audit cascade paths.
      await this.deleteOperatorMcpAccountHistory(trx, input.accountId);
      await trx.deleteFrom("workspaces").where("account_id", "=", input.accountId).execute();
      const deleted = await trx.deleteFrom("accounts").where("id", "=", input.accountId).executeTakeFirst();
      return Number(deleted.numDeletedRows) === 1;
    });
  }

  private async invalidateByMembership(trx: Db, membershipId: string, actorUserId: string | null | undefined, reason: "membership_ended") {
    const rows = await trx.updateTable("api_credentials").set({
      revoked_at: new Date(), revoked_by_user_id: actorUserId ?? null, revocation_reason: reason, updated_at: new Date(), revision: (eb) => eb("revision", "+", 1),
    }).where("kind", "=", "personal").where("access_tenure_membership_id", "=", membershipId).where("revoked_at", "is", null)
      .returning(["id", "workspace_id", "owner_user_id"]).execute();
    return rows as InvalidatedCredential[];
  }

  private async invalidateByWorkspace(trx: Db, workspaceId: string, actorUserId: string | null | undefined, reason: "workspace_deleted") {
    const rows = await trx.updateTable("api_credentials").set({
      revoked_at: new Date(), revoked_by_user_id: actorUserId ?? null, revocation_reason: reason, updated_at: new Date(), revision: (eb) => eb("revision", "+", 1),
    }).where("kind", "=", "personal").where("workspace_id", "=", workspaceId).where("revoked_at", "is", null)
      .returning(["id", "workspace_id", "owner_user_id"]).execute();
    return rows as InvalidatedCredential[];
  }

  private async invalidateByAccount(trx: Db, accountId: string, actorUserId: string | null | undefined, reason: "account_deleted") {
    const rows = await trx.updateTable("api_credentials").set({
      revoked_at: new Date(), revoked_by_user_id: actorUserId ?? null, revocation_reason: reason, updated_at: new Date(), revision: (eb) => eb("revision", "+", 1),
    }).where("kind", "=", "personal").where("account_id", "=", accountId).where("revoked_at", "is", null)
      .returning(["id", "workspace_id", "owner_user_id"]).execute();
    return rows as InvalidatedCredential[];
  }

  private async invalidateOperatorGrantsByMembership(trx: Db, membershipId: string, reason: "membership_ended") {
    await trx.updateTable("operator_mcp_grants").set({
      status: "revoked",
      revoked_at: new Date(),
      revoked_reason: reason,
      updated_at: new Date(),
      version: sql<string>`version + 1`,
    }).where("membership_id", "=", membershipId).where("status", "=", "active").execute();
  }

  private async invalidateOperatorGrantsByWorkspace(trx: Db, workspaceId: string, reason: "workspace_deleted") {
    await trx.updateTable("operator_mcp_grants").set({
      status: "revoked",
      revoked_at: new Date(),
      revoked_reason: reason,
      updated_at: new Date(),
      version: sql<string>`version + 1`,
    }).where("workspace_id", "=", workspaceId).where("status", "=", "active").execute();
  }

  private async invalidateOperatorGrantsByAccount(trx: Db, accountId: string, reason: "account_deleted") {
    await trx.updateTable("operator_mcp_grants").set({
      status: "revoked",
      revoked_at: new Date(),
      revoked_reason: reason,
      updated_at: new Date(),
      version: sql<string>`version + 1`,
    }).where("account_id", "=", accountId).where("status", "=", "active").execute();
  }

  private async deleteOperatorMcpWorkspaceHistory(trx: Db, workspaceId: string): Promise<void> {
    await trx.deleteFrom("copilot_replay_evidence")
      .where("workspace_id", "=", workspaceId)
      .where("operator_mcp_invocation_id", "is not", null)
      .execute();
    await trx.deleteFrom("copilot_proposals")
      .where("workspace_id", "=", workspaceId)
      .where("operator_mcp_invocation_id", "is not", null)
      .execute();
    await trx.deleteFrom("operator_mcp_invocations").where("workspace_id", "=", workspaceId).execute();
    await trx.deleteFrom("operator_mcp_grants").where("workspace_id", "=", workspaceId).execute();
  }

  private async deleteOperatorMcpAccountHistory(trx: Db, accountId: string): Promise<void> {
    const invocationIds = trx.selectFrom("operator_mcp_invocations")
      .select("id")
      .where("account_id", "=", accountId);
    await trx.deleteFrom("copilot_replay_evidence")
      .where("operator_mcp_invocation_id", "in", invocationIds)
      .execute();
    await trx.deleteFrom("copilot_proposals")
      .where("operator_mcp_invocation_id", "in", invocationIds)
      .execute();
    await trx.deleteFrom("operator_mcp_invocations").where("account_id", "=", accountId).execute();
    await trx.deleteFrom("operator_mcp_grants").where("account_id", "=", accountId).execute();
  }

  private invalidationEvents(accountId: string, credentials: InvalidatedCredential[], actorUserId: string | null | undefined, reason: "membership_ended" | "workspace_deleted" | "account_deleted"): MachineAccessAuditEvent[] {
    return credentials.map((credential) => machineAccessAuditEvent({
      accountId,
      workspaceId: credential.workspace_id,
      eventType: "machine_access.personal_credential.invalidated",
      eventStatus: "success",
      metadata: {
        actorUserId: actorUserId ?? null,
        credentialId: credential.id,
        principalKind: "user",
        principalId: credential.owner_user_id,
        reason,
        systemInitiated: actorUserId == null,
      },
    }));
  }

  private contextualize(event: TransactionalLifecycleAuditEvent): TransactionalLifecycleAuditEvent {
    return transactionalLifecycleAuditEvent(event);
  }

  private async insertAuditEvents(trx: Db, events: readonly TransactionalLifecycleAuditEvent[]): Promise<void> {
    await trx.insertInto("audit_events").values(events.map((event) => ({
      id: randomUUID(), account_id: event.accountId, workspace_id: event.workspaceId ?? null,
      event_type: event.eventType, event_status: event.eventStatus, metadata_json: toSanitizedJsonb(event.metadata),
    }))).execute();
  }

  private async lockMembership(trx: Db, membershipId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`machine-personal-membership:${membershipId}`}, 0))`.execute(trx);
  }

  private async lockActivePersonalTenuresForWorkspace(trx: Db, workspaceId: string): Promise<void> {
    const rows = await trx.selectFrom("api_credentials")
      .select("access_tenure_membership_id")
      .where("workspace_id", "=", workspaceId)
      .where("kind", "=", "personal")
      .where("revoked_at", "is", null)
      .where("access_tenure_membership_id", "is not", null)
      .distinct()
      .orderBy("access_tenure_membership_id", "asc")
      .execute();
    for (const row of rows) await this.lockMembership(trx, row.access_tenure_membership_id!);
  }

  private async lockActivePersonalTenuresForAccount(trx: Db, accountId: string): Promise<void> {
    const rows = await trx.selectFrom("api_credentials")
      .select("access_tenure_membership_id")
      .where("account_id", "=", accountId)
      .where("kind", "=", "personal")
      .where("revoked_at", "is", null)
      .where("access_tenure_membership_id", "is not", null)
      .distinct()
      .orderBy("access_tenure_membership_id", "asc")
      .execute();
    for (const row of rows) await this.lockMembership(trx, row.access_tenure_membership_id!);
  }
}
