import { conflict, forbidden } from "../../../shared/domain/errors.js";
import type { AccountAccessService } from "../../account/public.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { ApiCredentialRecord, MachineAccessAuditEvent, MachineAccessPersistencePort } from "../ports.js";
import { MACHINE_ACCESS_LIFETIMES, MACHINE_ACCESS_LIMITS, assertAssignableRole, deriveCredentialStatus, normalizeCredentialLabel, normalizeCredentialExpiry, type MachineAccessRole } from "../domain.js";
import { issueMachineSecret } from "../credentialSecretCodec.js";
import { machineAccessAuditEvent } from "../auditMetadata.js";

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

  async issue(input: { accountId: string; workspaceId: string; userId: string; label: string; roleCeiling: MachineAccessRole; expiresAt?: Date | null }): Promise<{ credential: ApiCredentialRecord; secret: string }> {
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
    const expiresAt = normalizeCredentialExpiry(input.expiresAt, this.now(), MACHINE_ACCESS_LIFETIMES.personalDays);
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
      auditEvents: ({ credential }) => [this.credentialAuditEvent(input, credential.id, "issued", {
        roleCeiling: credential.roleCeiling,
      })],
    });
    if (!issued) throw conflict("Personal credential limit reached");
    const { credential } = issued;
    this.logCommitted([this.credentialAuditEvent(input, credential.id, "issued", { roleCeiling: credential.roleCeiling })]);
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
    return { items: items.map((credential) => this.withCredentialStatus(credential)), total };
  }

  async relabel(input: { accountId: string; workspaceId: string; userId: string; credentialId: string; label: string; revision?: number }): Promise<ApiCredentialRecord> {
    await this.input.accountAccess.requirePermission({
      accountId: input.accountId,
      userId: input.userId,
      permission: "workspace.api_access.personal.manage",
      workspaceId: input.workspaceId,
    });
    const credential = await this.requireOwned(input);
    const updated = await this.input.repository.relabelCredential({
      id: credential.id,
      label: normalizeCredentialLabel(input.label),
      expectedRevision: input.revision,
      auditEvents: (persisted) => [this.credentialAuditEvent(input, persisted.id, "relabeled")],
    });
    if (!updated) throw conflict("Credential changed concurrently");
    this.logCommitted([this.credentialAuditEvent(input, updated.id, "relabeled")]);
    return this.withCredentialStatus(updated);
  }

  async rotate(input: { accountId: string; workspaceId: string; userId: string; credentialId: string; revision: number; label?: string }): Promise<{ credential: ApiCredentialRecord; secret: string }> {
    await this.input.accountAccess.requirePermission({
      accountId: input.accountId,
      userId: input.userId,
      permission: "workspace.api_access.personal.manage",
      workspaceId: input.workspaceId,
    });
    const credential = await this.requireOwned(input);
    if (credential.revokedAt || (credential.expiresAt && credential.expiresAt <= this.now())) throw conflict("Credential is no longer active");
    const issued = issueMachineSecret("personal");
    const replacement = await this.input.repository.replaceCredential({
      credentialId: credential.id,
      expectedRevision: input.revision,
      label: normalizeCredentialLabel(input.label ?? credential.label),
      tokenPrefix: issued.tokenPrefix,
      tokenHash: issued.tokenHash,
      createdByUserId: input.userId,
      auditEvents: (persisted) => [this.rotationAuditEvent(input, persisted.id, credential.id)],
    });
    if (!replacement) throw conflict("Credential changed concurrently");
    this.logCommitted([this.rotationAuditEvent(input, replacement.id, credential.id)]);
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
      auditEvents: (changed) => [this.credentialAuditEvent(
        { ...input, userId: input.actorUserId }, credential.id, "revoked", { changed }, credential.ownerUserId!,
      )],
    });
    if (!changed && input.revision !== undefined) throw conflict("Credential changed concurrently");
    this.logCommitted([this.credentialAuditEvent(
      { ...input, userId: input.actorUserId }, credential.id, "revoked", { changed }, credential.ownerUserId!,
    )]);
    return this.withCredentialStatus(await this.input.repository.findCredential(credential.id) ?? credential);
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
    return { items: items.map((credential) => this.withCredentialStatus(credential)), total };
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

  private rotationAuditEvent(
    input: { accountId: string; workspaceId: string; userId: string },
    credentialId: string,
    rotatedFromCredentialId: string,
  ): MachineAccessAuditEvent {
    return machineAccessAuditEvent({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "machine_access.personal_credential.rotated",
      eventStatus: "success",
      metadata: {
        actorUserId: input.userId,
        principalKind: "user",
        principalId: input.userId,
        credentialId,
        rotatedFromCredentialId,
      },
    });
  }

  private credentialAuditEvent(
    input: { accountId: string; workspaceId: string; userId: string },
    credentialId: string,
    action: string,
    metadata: Record<string, unknown> = {},
    principalId = input.userId,
  ): MachineAccessAuditEvent {
    return machineAccessAuditEvent({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: `machine_access.personal_credential.${action}`,
      eventStatus: "success",
      metadata: { actorUserId: input.userId, credentialId, principalKind: "user", principalId, ...metadata },
    });
  }

  private logCommitted(events: readonly MachineAccessAuditEvent[]): void {
    for (const event of events) this.input.audit.logRecorded?.(event);
  }

  private withCredentialStatus(credential: ApiCredentialRecord) {
    return { ...credential, status: deriveCredentialStatus({ ...credential, now: this.now() }) };
  }
}
