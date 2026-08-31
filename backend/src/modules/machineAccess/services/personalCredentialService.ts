import { conflict, forbidden } from "../../../shared/domain/errors.js";
import type { AccountAccessService } from "../../account/public.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { ApiCredentialRecord, MachineAccessPersistencePort } from "../ports.js";
import { MACHINE_ACCESS_LIFETIMES, MACHINE_ACCESS_LIMITS, assertAssignableRole, normalizeCredentialLabel, requireMaximumExpiry, type MachineAccessRole } from "../domain.js";
import { issueMachineSecret } from "../credentialSecretCodec.js";

type PersonalCredentialRepository = Pick<
  MachineAccessPersistencePort,
  | "countCredentials"
  | "createPersonalWithinLimit"
  | "findCredential"
  | "findLegacyMigrationTime"
  | "listCredentials"
  | "relabelCredential"
  | "replaceCredential"
  | "revokeCredential"
>;

export class PersonalCredentialService {
  constructor(private readonly input: { repository: PersonalCredentialRepository; accountAccess: AccountAccessService; audit: AuditService; now?: () => Date }) {}
  private now = () => (this.input.now ?? (() => new Date()))();

  async issue(input: { accountId: string; workspaceId: string; userId: string; label: string; roleCeiling: MachineAccessRole; expiresAt: Date }): Promise<{ credential: ApiCredentialRecord; secret: string }> {
    await this.input.accountAccess.requirePermission({
      accountId: input.accountId,
      userId: input.userId,
      permission: "workspace.api_access.personal.manage",
      workspaceId: input.workspaceId,
    });
    const membership = await this.input.accountAccess.requireActiveMembership(input.accountId, input.userId);
    const role = await this.input.accountAccess.resolveWorkspaceRole({ accountId: input.accountId, userId: input.userId, workspaceId: input.workspaceId });
    if (!role) throw forbidden();
    assertAssignableRole(role, input.roleCeiling);
    const label = normalizeCredentialLabel(input.label);
    const expiresAt = requireMaximumExpiry(input.expiresAt, this.now(), MACHINE_ACCESS_LIFETIMES.personalDays);
    const issued = await this.input.repository.createPersonalWithinLimit({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      ownerUserId: input.userId,
      accessTenureMembershipId: membership.id,
      roleCeiling: input.roleCeiling,
      label,
      expiresAt,
      createdByUserId: input.userId,
      now: this.now(),
      limit: MACHINE_ACCESS_LIMITS.maxActivePersonalCredentials,
      issueSecret: () => issueMachineSecret("personal"),
    });
    if (!issued) throw conflict("Personal credential limit reached");
    const { credential } = issued;
    await this.input.audit.record({ accountId: input.accountId, workspaceId: input.workspaceId, eventType: "machine_access.personal_credential.issued", eventStatus: "success", metadata: { actorUserId: input.userId, principalKind: "user", principalId: input.userId, credentialId: credential.id, roleCeiling: credential.roleCeiling } });
    return issued;
  }

  async listOwn(input: { accountId: string; workspaceId: string; userId: string; limit?: number; page?: number }): Promise<{ items: ApiCredentialRecord[]; total: number }> {
    await this.input.accountAccess.requirePermission({
      accountId: input.accountId,
      userId: input.userId,
      permission: "workspace.api_access.personal.manage",
      workspaceId: input.workspaceId,
    });
    const query = { workspaceId: input.workspaceId, ownerUserId: input.userId, kind: "personal" as const };
    const [items, total] = await Promise.all([
      this.input.repository.listCredentials({ ...query, page: input.page, limit: Math.min(input.limit ?? MACHINE_ACCESS_LIMITS.defaultPageSize, MACHINE_ACCESS_LIMITS.maxPageSize) }),
      this.input.repository.countCredentials(query),
    ]);
    return { items, total };
  }

  async relabel(input: { accountId: string; workspaceId: string; userId: string; credentialId: string; label: string; revision?: number }): Promise<ApiCredentialRecord> {
    await this.input.accountAccess.requirePermission({
      accountId: input.accountId,
      userId: input.userId,
      permission: "workspace.api_access.personal.manage",
      workspaceId: input.workspaceId,
    });
    const credential = await this.requireOwned(input);
    const updated = await this.input.repository.relabelCredential({ id: credential.id, label: normalizeCredentialLabel(input.label), expectedRevision: input.revision });
    if (!updated) throw conflict("Credential changed concurrently");
    await this.audit(input, input.userId, updated.id, "relabeled");
    return updated;
  }

  async rotate(input: { accountId: string; workspaceId: string; userId: string; credentialId: string; revision: number; label?: string }): Promise<{ credential: ApiCredentialRecord; secret: string }> {
    await this.input.accountAccess.requirePermission({
      accountId: input.accountId,
      userId: input.userId,
      permission: "workspace.api_access.personal.manage",
      workspaceId: input.workspaceId,
    });
    const credential = await this.requireOwned(input);
    if (credential.revokedAt || credential.expiresAt <= this.now()) throw conflict("Credential is no longer active");
    const issued = issueMachineSecret("personal");
    const replacement = await this.input.repository.replaceCredential({ credentialId: credential.id, expectedRevision: input.revision, label: normalizeCredentialLabel(input.label ?? credential.label), tokenPrefix: issued.tokenPrefix, tokenHash: issued.tokenHash, createdByUserId: input.userId });
    if (!replacement) throw conflict("Credential changed concurrently");
    await this.audit(input, input.userId, replacement.id, "rotated", {
      rotatedFromCredentialId: credential.id,
    });
    return { credential: replacement, secret: issued.secret };
  }

  async revoke(input: { accountId: string; workspaceId: string; actorUserId: string; credentialId: string; revision?: number }): Promise<ApiCredentialRecord> {
    const credential = await this.input.repository.findCredential(input.credentialId);
    if (!credential || credential.workspaceId !== input.workspaceId || credential.kind !== "personal") throw forbidden();
    if (credential.ownerUserId !== input.actorUserId) {
      await this.input.accountAccess.requirePermission({
        accountId: input.accountId,
        userId: input.actorUserId,
        permission: "workspace.api_access.personal.audit",
        workspaceId: input.workspaceId,
      });
    } else {
      await this.input.accountAccess.requirePermission({
        accountId: input.accountId,
        userId: input.actorUserId,
        permission: "workspace.api_access.personal.manage",
        workspaceId: input.workspaceId,
      });
    }
    const changed = await this.input.repository.revokeCredential({
      id: credential.id,
      actorUserId: input.actorUserId,
      expectedRevision: input.revision,
      now: this.now(),
    });
    if (!changed && input.revision !== undefined) throw conflict("Credential changed concurrently");
    await this.audit(
      { ...input, userId: input.actorUserId },
      credential.ownerUserId!,
      credential.id,
      "revoked",
      { changed },
    );
    return await this.input.repository.findCredential(credential.id) ?? credential;
  }

  async listWorkspace(input: { accountId: string; workspaceId: string; actorUserId: string; limit?: number; page?: number }): Promise<{ items: ApiCredentialRecord[]; total: number }> {
    await this.input.accountAccess.requirePermission({
      accountId: input.accountId,
      userId: input.actorUserId,
      permission: "workspace.api_access.personal.audit",
      workspaceId: input.workspaceId,
    });
    const query = { workspaceId: input.workspaceId, kind: "personal" as const };
    const [items, total] = await Promise.all([
      this.input.repository.listCredentials({ ...query, page: input.page, limit: Math.min(input.limit ?? MACHINE_ACCESS_LIMITS.defaultPageSize, MACHINE_ACCESS_LIMITS.maxPageSize) }),
      this.input.repository.countCredentials(query),
    ]);
    return { items, total };
  }

  async legacyMigrationStatus(workspaceId: string): Promise<{ status: "destroyed" | "not_applicable"; migratedAt: string | null }> {
    const migratedAt = await this.input.repository.findLegacyMigrationTime(workspaceId);
    return {
      status: migratedAt ? "destroyed" : "not_applicable",
      migratedAt: migratedAt?.toISOString() ?? null,
    };
  }

  private async requireOwned(input: { accountId: string; workspaceId: string; userId: string; credentialId: string }): Promise<ApiCredentialRecord> {
    const credential = await this.input.repository.findCredential(input.credentialId);
    if (!credential || credential.kind !== "personal" || credential.workspaceId !== input.workspaceId || credential.ownerUserId !== input.userId) throw forbidden();
    return credential;
  }

  private async audit(
    input: { accountId: string; workspaceId: string; userId: string },
    principalId: string,
    credentialId: string,
    action: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.input.audit.record({ accountId: input.accountId, workspaceId: input.workspaceId, eventType: `machine_access.personal_credential.${action}`, eventStatus: "success", metadata: { actorUserId: input.userId, principalKind: "user", principalId, credentialId, ...metadata } });
  }
}
