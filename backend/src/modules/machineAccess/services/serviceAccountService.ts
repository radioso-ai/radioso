import { conflict, forbidden, notFound } from "../../../shared/domain/errors.js";
import type { AccountAccessService } from "../../account/public.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { MachineAccessPersistencePort } from "../ports.js";
import { MACHINE_ACCESS_LIFETIMES, MACHINE_ACCESS_LIMITS, assertAssignableRole, normalizeCredentialLabel, requireMaximumExpiry, type MachineAccessRole } from "../domain.js";
import { issueMachineSecret } from "../credentialSecretCodec.js";
import { machineAccessAuditMetadata } from "../auditMetadata.js";

type ServiceAccountRepository = Pick<
  MachineAccessPersistencePort,
  | "countActiveServiceCredentials"
  | "countCredentials"
  | "countServiceAccounts"
  | "createServiceAccountWithinLimit"
  | "createServiceCredentialWithinLimit"
  | "findCredential"
  | "findServiceAccount"
  | "listCredentials"
  | "listServiceAccounts"
  | "mutateServiceAccount"
  | "relabelCredential"
  | "replaceCredential"
  | "revokeCredential"
>;

export class ServiceAccountService {
  constructor(private readonly input: { repository: ServiceAccountRepository; accountAccess: AccountAccessService; audit: AuditService; now?: () => Date }) {}
  private now = () => (this.input.now ?? (() => new Date()))();

  async createWithCredential(input: { accountId: string; workspaceId: string; actorUserId: string; displayName: string; role: MachineAccessRole; credentialLabel: string; expiresAt: Date }) {
    const actorRole = await this.requireServiceManage(input);
    assertAssignableRole(actorRole, input.role);
    const issued = await this.input.repository.createServiceAccountWithinLimit({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      displayName: normalizeCredentialLabel(input.displayName),
      role: input.role,
      createdByUserId: input.actorUserId,
      credentialLabel: normalizeCredentialLabel(input.credentialLabel),
      expiresAt: requireMaximumExpiry(input.expiresAt, this.now(), MACHINE_ACCESS_LIFETIMES.serviceDays),
      limit: MACHINE_ACCESS_LIMITS.maxNonArchivedServiceAccounts,
      issueSecret: () => issueMachineSecret("service"),
    });
    if (!issued) throw conflict("Service account limit reached");
    const { account, credential } = issued;
    await this.input.audit.record({ accountId: input.accountId, workspaceId: input.workspaceId, eventType: "machine_access.service_account.created", eventStatus: "success", metadata: { actorUserId: input.actorUserId, principalKind: "service", principalId: account.id, credentialId: credential.id, role: account.role } });
    await this.input.audit.record({ accountId: input.accountId, workspaceId: input.workspaceId, eventType: "machine_access.service_credential.issued", eventStatus: "success", metadata: machineAccessAuditMetadata({ actorUserId: input.actorUserId, principalKind: "service", principalId: account.id, credentialId: credential.id, initialCredential: true }) });
    return issued;
  }

  async issueCredential(input: { accountId: string; workspaceId: string; actorUserId: string; serviceAccountId: string; label: string; expiresAt: Date }) {
    await this.requireServiceManage(input);
    const issued = await this.input.repository.createServiceCredentialWithinLimit({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      serviceAccountId: input.serviceAccountId,
      label: normalizeCredentialLabel(input.label),
      expiresAt: requireMaximumExpiry(input.expiresAt, this.now(), MACHINE_ACCESS_LIFETIMES.serviceDays),
      createdByUserId: input.actorUserId,
      now: this.now(),
      limit: MACHINE_ACCESS_LIMITS.maxActiveCredentialsPerServiceAccount,
      issueSecret: () => issueMachineSecret("service"),
    });
    if (issued.status === "missing") throw notFound("Service account not found");
    if (issued.status === "limit") throw conflict("Service credential limit reached");
    if (issued.status !== "created") throw conflict("Service account is not enabled");
    await this.input.audit.record({ accountId: input.accountId, workspaceId: input.workspaceId, eventType: "machine_access.service_credential.issued", eventStatus: "success", metadata: { actorUserId: input.actorUserId, principalKind: "service", principalId: input.serviceAccountId, credentialId: issued.credential.id } });
    return { credential: issued.credential, secret: issued.secret };
  }

  async list(input: { accountId: string; workspaceId: string; actorUserId: string; limit?: number; page?: number }) {
    await this.requireAdmin(input);
    const [items, total] = await Promise.all([
      this.input.repository.listServiceAccounts({ workspaceId: input.workspaceId, limit: Math.min(input.limit ?? MACHINE_ACCESS_LIMITS.defaultPageSize, MACHINE_ACCESS_LIMITS.maxPageSize), page: input.page }),
      this.input.repository.countServiceAccounts(input.workspaceId),
    ]);
    return { items, total };
  }

  async get(input: { accountId: string; workspaceId: string; actorUserId: string; serviceAccountId: string }) {
    await this.requireAdmin(input);
    const account = await this.input.repository.findServiceAccount(input.serviceAccountId);
    if (!account || account.workspaceId !== input.workspaceId) throw notFound("Service account not found");
    return { ...account, activeCredentialCount: await this.input.repository.countActiveServiceCredentials(account.id) };
  }

  async update(input: { accountId: string; workspaceId: string; actorUserId: string; serviceAccountId: string; revision: number; displayName?: string; role?: MachineAccessRole; status?: "enabled" | "disabled" | "archived" }) {
    const actorRole = await this.requireAdmin(input);
    if (input.role) assertAssignableRole(actorRole, input.role);
    const result = await this.input.repository.mutateServiceAccount({
      id: input.serviceAccountId,
      workspaceId: input.workspaceId,
      expectedRevision: input.revision,
      actorUserId: input.actorUserId,
      displayName: input.displayName === undefined ? undefined : normalizeCredentialLabel(input.displayName),
      role: input.role,
      targetStatus: input.status,
      now: this.now(),
    });
    if (result.status === "missing") throw notFound("Service account not found");
    if (result.status === "conflict") throw conflict("Service account changed concurrently or cannot make that transition");
    const account = result.account;
    const metadata = { actorUserId: input.actorUserId, principalKind: "service", principalId: account.id, status: account.status, role: account.role } as const;
    if (input.displayName !== undefined) {
      await this.input.audit.record({ accountId: input.accountId, workspaceId: input.workspaceId, eventType: "machine_access.service_account.relabeled", eventStatus: "success", metadata });
    }
    if (input.role !== undefined) {
      await this.input.audit.record({ accountId: input.accountId, workspaceId: input.workspaceId, eventType: "machine_access.service_account.role_changed", eventStatus: "success", metadata });
    }
    if (input.status !== undefined) {
      await this.input.audit.record({ accountId: input.accountId, workspaceId: input.workspaceId, eventType: `machine_access.service_account.${input.status}`, eventStatus: "success", metadata });
    }
    for (const credentialId of result.invalidatedCredentialIds) {
      await this.input.audit.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "machine_access.service_credential.invalidated",
        eventStatus: "success",
        metadata: {
          actorUserId: input.actorUserId,
          credentialId,
          principalKind: "service",
          principalId: account.id,
          reason: "service_account_archived",
        },
      });
    }
    return account;
  }

  async listCredentials(input: { accountId: string; workspaceId: string; actorUserId: string; serviceAccountId: string; limit?: number; page?: number }) {
    await this.get(input);
    const query = { workspaceId: input.workspaceId, serviceAccountId: input.serviceAccountId, kind: "service" as const };
    const [items, total] = await Promise.all([
      this.input.repository.listCredentials({ ...query, page: input.page, limit: Math.min(input.limit ?? MACHINE_ACCESS_LIMITS.defaultPageSize, MACHINE_ACCESS_LIMITS.maxPageSize) }),
      this.input.repository.countCredentials(query),
    ]);
    return { items, total };
  }

  async relabelCredential(input: { accountId: string; workspaceId: string; actorUserId: string; serviceAccountId: string; credentialId: string; label: string; revision?: number }) {
    const account = await this.get(input);
    if (account.status === "archived") throw conflict("Archived service accounts cannot be changed");
    const credential = await this.requireServiceCredential(input);
    const updated = await this.input.repository.relabelCredential({ id: credential.id, label: normalizeCredentialLabel(input.label), expectedRevision: input.revision });
    if (!updated) throw conflict("Credential changed concurrently");
    await this.auditCredential(input, updated.id, "relabeled");
    return updated;
  }

  async rotateCredential(input: { accountId: string; workspaceId: string; actorUserId: string; serviceAccountId: string; credentialId: string; revision: number; label?: string }) {
    const account = await this.get(input);
    if (account.status !== "enabled") throw conflict("Service account is not enabled");
    const credential = await this.requireServiceCredential(input);
    const issued = issueMachineSecret("service");
    const replacement = await this.input.repository.replaceCredential({ credentialId: credential.id, expectedRevision: input.revision, label: normalizeCredentialLabel(input.label ?? credential.label), tokenPrefix: issued.tokenPrefix, tokenHash: issued.tokenHash, createdByUserId: input.actorUserId });
    if (!replacement) throw conflict("Credential changed concurrently");
    await this.auditCredential(input, replacement.id, "rotated", {
      rotatedFromCredentialId: credential.id,
    });
    return { credential: replacement, secret: issued.secret };
  }

  async revokeCredential(input: { accountId: string; workspaceId: string; actorUserId: string; serviceAccountId: string; credentialId: string; revision?: number }) {
    await this.get(input);
    const credential = await this.requireServiceCredential(input);
    const changed = await this.input.repository.revokeCredential({
      id: credential.id,
      actorUserId: input.actorUserId,
      expectedRevision: input.revision,
      now: this.now(),
    });
    if (!changed && input.revision !== undefined) throw conflict("Credential changed concurrently");
    await this.auditCredential(input, credential.id, "revoked", { changed });
    return await this.input.repository.findCredential(credential.id) ?? credential;
  }

  private async requireAdmin(input: { accountId: string; workspaceId: string; actorUserId: string }): Promise<"admin" | "owner"> {
    return this.requireServiceManage(input);
  }

  private async requireServiceManage(input: { accountId: string; workspaceId: string; actorUserId: string }): Promise<"admin" | "owner"> {
    await this.input.accountAccess.requirePermission({
      accountId: input.accountId,
      userId: input.actorUserId,
      permission: "workspace.api_access.service.manage",
      workspaceId: input.workspaceId,
    });
    const role = await this.input.accountAccess.resolveWorkspaceRole({ accountId: input.accountId, userId: input.actorUserId, workspaceId: input.workspaceId });
    // The central capability above makes this assertion impossible for a member;
    // resolving the role remains necessary only to enforce the requested role ceiling.
    if (!role || role === "member") throw forbidden();
    return role;
  }
  private async requireServiceCredential(input: { workspaceId: string; serviceAccountId: string; credentialId: string }) {
    const credential = await this.input.repository.findCredential(input.credentialId);
    if (!credential || credential.kind !== "service" || credential.workspaceId !== input.workspaceId || credential.serviceAccountId !== input.serviceAccountId) throw notFound("Service credential not found");
    return credential;
  }

  private async auditCredential(
    input: { accountId: string; workspaceId: string; actorUserId: string; serviceAccountId: string },
    credentialId: string,
    action: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.input.audit.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: `machine_access.service_credential.${action}`,
      eventStatus: "success",
      metadata: {
        actorUserId: input.actorUserId,
        credentialId,
        principalKind: "service",
        principalId: input.serviceAccountId,
        ...metadata,
      },
    });
  }
}
