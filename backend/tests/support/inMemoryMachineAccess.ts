import { randomUUID } from "node:crypto";

import type {
  ApiCredentialRecord,
  CredentialExpiryWarningClaim,
  MachineAccessPersistencePort,
  ServiceAccountRecord,
} from "../../src/modules/machineAccess/ports.js";

type InputOf<K extends keyof MachineAccessPersistencePort> =
  MachineAccessPersistencePort[K] extends (input: infer I, ...args: never[]) => unknown ? I : never;

export class InMemoryMachineAccessRepository implements Pick<
  MachineAccessPersistencePort,
  | "claimExpiryWarnings"
  | "countActiveServiceCredentials"
  | "countCredentials"
  | "countServiceAccounts"
  | "createPersonalWithinLimit"
  | "createServiceAccountWithinLimit"
  | "createServiceCredentialWithinLimit"
  | "findCredential"
  | "findCredentialByHash"
  | "findLegacyMigrationTime"
  | "findServiceAccount"
  | "invalidatePersonalCredentialsForTenure"
  | "invalidatePersonalCredentialsForWorkspace"
  | "invalidatePersonalCredentialsForAccount"
  | "listCredentials"
  | "listServiceAccounts"
  | "mutateServiceAccount"
  | "relabelCredential"
  | "releaseExpiryWarning"
  | "replaceCredential"
  | "revokeCredential"
  | "touchCredentialUse"
> {
  readonly credentials = new Map<string, ApiCredentialRecord>();
  readonly serviceAccounts = new Map<string, ServiceAccountRecord>();
  readonly durableAuditEvents: import("../../src/modules/machineAccess/ports.js").MachineAccessAuditEvent[] = [];
  failAuditPersistence: Error | null = null;
  private readonly warningClaims = new Set<string>();

  async createPersonalWithinLimit(input: InputOf<"createPersonalWithinLimit">) {
    const active = [...this.credentials.values()].filter((credential) =>
      credential.kind === "personal"
      && credential.workspaceId === input.workspaceId
      && credential.ownerUserId === input.ownerUserId
      && credential.revokedAt === null
      && (!credential.expiresAt || credential.expiresAt > input.now)
    );
    if (active.length >= input.limit) return null;
    const issued = input.issueSecret();
    const credential: ApiCredentialRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      kind: "personal",
      label: input.label,
      tokenPrefix: issued.tokenPrefix,
      tokenHash: issued.tokenHash,
      roleCeiling: input.roleCeiling,
      ownerUserId: input.ownerUserId,
      accessTenureMembershipId: input.accessTenureMembershipId,
      serviceAccountId: null,
      createdByUserId: input.createdByUserId,
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      revokedByUserId: null,
      revocationReason: null,
      rotatedFromCredentialId: null,
      revision: 1,
    };
    this.credentials.set(credential.id, credential);
    try {
      await this.persistAuditEvents(input.auditEvents?.({ credential }) ?? []);
      return { credential, secret: issued.secret };
    } catch (error) {
      this.credentials.delete(credential.id);
      throw error;
    }
  }

  async findCredentialByHash(tokenHash: string): Promise<ApiCredentialRecord | null> {
    return [...this.credentials.values()].find((credential) => credential.tokenHash === tokenHash) ?? null;
  }

  async findCredential(id: string): Promise<ApiCredentialRecord | null> {
    return this.credentials.get(id) ?? null;
  }

  async findServiceAccount(id: string): Promise<ServiceAccountRecord | null> {
    return this.serviceAccounts.get(id) ?? null;
  }

  async invalidatePersonalCredentialsForTenure(input: InputOf<"invalidatePersonalCredentialsForTenure">): Promise<ApiCredentialRecord[]> {
    return this.invalidatePersonalCredentials((credential) => credential.accessTenureMembershipId === input.membershipId, input);
  }

  async invalidatePersonalCredentialsForWorkspace(input: InputOf<"invalidatePersonalCredentialsForWorkspace">): Promise<ApiCredentialRecord[]> {
    return this.invalidatePersonalCredentials((credential) => credential.workspaceId === input.workspaceId, input);
  }

  async invalidatePersonalCredentialsForAccount(input: InputOf<"invalidatePersonalCredentialsForAccount">): Promise<ApiCredentialRecord[]> {
    return this.invalidatePersonalCredentials((credential) => credential.accountId === input.accountId, input);
  }

  async listServiceAccounts(input: InputOf<"listServiceAccounts">): Promise<ServiceAccountRecord[]> {
    const offset = ((input.page ?? 1) - 1) * input.limit;
    return [...this.serviceAccounts.values()]
      .filter((account) => account.workspaceId === input.workspaceId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
      .slice(offset, offset + input.limit)
      .map((account) => ({
        ...account,
        activeCredentialCount: this.activeServiceCredentials(account.id).length,
      }));
  }

  async countServiceAccounts(workspaceId: string): Promise<number> {
    return [...this.serviceAccounts.values()].filter((account) => account.workspaceId === workspaceId).length;
  }

  async mutateServiceAccount(input: InputOf<"mutateServiceAccount">) {
    const credentialsBefore = new Map(this.credentials);
    const accountsBefore = new Map(this.serviceAccounts);
    const account = this.serviceAccounts.get(input.id);
    if (!account || account.workspaceId !== input.workspaceId) return { status: "missing" as const };
    if (account.revision !== input.expectedRevision || account.status === "archived") {
      return { status: "conflict" as const };
    }
    if (
      (input.targetStatus === "disabled" && account.status !== "enabled")
      || (input.targetStatus === "enabled" && account.status !== "disabled")
    ) return { status: "conflict" as const };
    const updated: ServiceAccountRecord = {
      ...account,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.targetStatus === undefined ? {} : { status: input.targetStatus }),
      disabledAt: input.targetStatus === "disabled"
        ? input.now
        : input.targetStatus === "enabled" ? null : account.disabledAt,
      archivedAt: input.targetStatus === "archived" ? input.now : account.archivedAt,
      updatedAt: input.now,
      revision: account.revision + 1,
    };
    const invalidatedCredentialIds: string[] = [];
    if (input.targetStatus === "archived") {
      for (const credential of this.credentials.values()) {
        if (credential.serviceAccountId === account.id && credential.revokedAt === null) {
          invalidatedCredentialIds.push(credential.id);
          this.credentials.set(credential.id, {
            ...credential,
            revokedAt: input.now,
            revokedByUserId: input.actorUserId,
            revocationReason: "service_account_archived",
            updatedAt: input.now,
            revision: credential.revision + 1,
          });
        }
      }
    }
    updated.activeCredentialCount = this.activeServiceCredentials(account.id, input.now).length;
    this.serviceAccounts.set(updated.id, updated);
    const result = { status: "updated" as const, account: updated, invalidatedCredentialIds };
    try {
      await this.persistAuditEvents(input.auditEvents?.(result) ?? []);
      return result;
    } catch (error) {
      this.credentials.clear();
      credentialsBefore.forEach((credential, id) => this.credentials.set(id, credential));
      this.serviceAccounts.clear();
      accountsBefore.forEach((account, id) => this.serviceAccounts.set(id, account));
      throw error;
    }
  }

  async createServiceAccountWithinLimit(input: InputOf<"createServiceAccountWithinLimit">) {
    const count = [...this.serviceAccounts.values()].filter((account) =>
      account.workspaceId === input.workspaceId && account.status !== "archived"
    ).length;
    if (count >= input.limit) return null;
    const now = new Date();
    const account: ServiceAccountRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      displayName: input.displayName,
      role: input.role,
      status: "enabled",
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
      archivedAt: null,
      lastUsedAt: null,
      revision: 1,
      activeCredentialCount: 1,
    };
    const issued = input.issueSecret();
    const credential = this.createServiceCredentialRecord({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      serviceAccountId: account.id,
      label: input.credentialLabel,
      tokenPrefix: issued.tokenPrefix,
      tokenHash: issued.tokenHash,
      expiresAt: input.expiresAt,
      createdByUserId: input.createdByUserId,
    });
    this.serviceAccounts.set(account.id, account);
    this.credentials.set(credential.id, credential);
    try {
      await this.persistAuditEvents(input.auditEvents?.({ account, credential }) ?? []);
      return { account, credential, secret: issued.secret };
    } catch (error) {
      this.serviceAccounts.delete(account.id);
      this.credentials.delete(credential.id);
      throw error;
    }
  }

  async createServiceCredentialWithinLimit(input: InputOf<"createServiceCredentialWithinLimit">) {
    const account = this.serviceAccounts.get(input.serviceAccountId);
    if (!account || account.workspaceId !== input.workspaceId) return { status: "missing" as const };
    if (account.status !== "enabled") return { status: "inactive" as const };
    if (this.activeServiceCredentials(account.id, input.now).length >= input.limit) {
      return { status: "limit" as const };
    }
    const issued = input.issueSecret();
    const credential = this.createServiceCredentialRecord({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      serviceAccountId: input.serviceAccountId,
      label: input.label,
      tokenPrefix: issued.tokenPrefix,
      tokenHash: issued.tokenHash,
      expiresAt: input.expiresAt,
      createdByUserId: input.createdByUserId,
    });
    this.credentials.set(credential.id, credential);
    try {
      await this.persistAuditEvents(input.auditEvents?.({ credential }) ?? []);
      return { status: "created" as const, credential, secret: issued.secret };
    } catch (error) {
      this.credentials.delete(credential.id);
      throw error;
    }
  }

  async countActiveServiceCredentials(serviceAccountId: string): Promise<number> {
    return this.activeServiceCredentials(serviceAccountId).length;
  }

  async listCredentials(input: InputOf<"listCredentials">): Promise<ApiCredentialRecord[]> {
    const offset = ((input.page ?? 1) - 1) * input.limit;
    return [...this.credentials.values()]
      .filter((credential) =>
        credential.workspaceId === input.workspaceId
        && (!input.kind || credential.kind === input.kind)
        && (!input.ownerUserId || credential.ownerUserId === input.ownerUserId)
        && (!input.serviceAccountId || credential.serviceAccountId === input.serviceAccountId)
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
      .slice(offset, offset + input.limit);
  }

  async countCredentials(input: InputOf<"countCredentials">): Promise<number> {
    return (await this.listCredentials({ ...input, limit: Number.MAX_SAFE_INTEGER, page: 1 })).length;
  }

  async findLegacyMigrationTime(_workspaceId: string): Promise<Date | null> {
    return null;
  }

  async revokeCredential(input: InputOf<"revokeCredential">): Promise<boolean> {
    const credential = this.credentials.get(input.id);
    if (!credential || credential.revokedAt || (input.expectedRevision !== undefined && credential.revision !== input.expectedRevision)) return false;
    const before = credential;
    this.credentials.set(input.id, {
      ...credential,
      revokedAt: input.now,
      revokedByUserId: input.actorUserId,
      revocationReason: "explicit",
      updatedAt: input.now,
      revision: credential.revision + 1,
    });
    try {
      await this.persistAuditEvents(input.auditEvents?.(true) ?? []);
      return true;
    } catch (error) {
      this.credentials.set(before.id, before);
      throw error;
    }
  }

  async relabelCredential(input: InputOf<"relabelCredential">): Promise<ApiCredentialRecord | null> {
    const credential = this.credentials.get(input.id);
    if (!credential || credential.revokedAt || (credential.expiresAt && credential.expiresAt <= new Date())
      || (input.expectedRevision !== undefined && credential.revision !== input.expectedRevision)) return null;
    const updated = { ...credential, label: input.label, updatedAt: new Date(), revision: credential.revision + 1 };
    this.credentials.set(updated.id, updated);
    try {
      await this.persistAuditEvents(input.auditEvents?.(updated) ?? []);
      return updated;
    } catch (error) {
      this.credentials.set(credential.id, credential);
      throw error;
    }
  }

  async replaceCredential(input: InputOf<"replaceCredential">): Promise<ApiCredentialRecord | null> {
    const previous = this.credentials.get(input.credentialId);
    if (!previous || previous.revokedAt || (previous.expiresAt && previous.expiresAt <= new Date()) || previous.revision !== input.expectedRevision) return null;
    if (previous.serviceAccountId && this.serviceAccounts.get(previous.serviceAccountId)?.status !== "enabled") return null;
    const now = new Date();
    const credentialsBefore = new Map(this.credentials);
    this.credentials.set(previous.id, { ...previous, revokedAt: now, revokedByUserId: input.createdByUserId, revocationReason: "rotated", updatedAt: now, revision: previous.revision + 1 });
    const replacement: ApiCredentialRecord = {
      ...previous,
      id: randomUUID(),
      label: input.label,
      tokenPrefix: input.tokenPrefix,
      tokenHash: input.tokenHash,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      revokedAt: null,
      revokedByUserId: null,
      revocationReason: null,
      rotatedFromCredentialId: previous.id,
      revision: 1,
    };
    this.credentials.set(replacement.id, replacement);
    try {
      await this.persistAuditEvents(input.auditEvents?.(replacement) ?? []);
      return replacement;
    } catch (error) {
      this.credentials.clear();
      credentialsBefore.forEach((credential, id) => this.credentials.set(id, credential));
      throw error;
    }
  }

  async touchCredentialUse(input: InputOf<"touchCredentialUse">): Promise<void> {
    const credential = this.credentials.get(input.credentialId);
    if (credential) this.credentials.set(credential.id, { ...credential, lastUsedAt: input.at });
    if (input.serviceAccountId) {
      const account = this.serviceAccounts.get(input.serviceAccountId);
      if (account) this.serviceAccounts.set(account.id, { ...account, lastUsedAt: input.at });
    }
  }

  async claimExpiryWarnings(now: Date): Promise<CredentialExpiryWarningClaim[]> {
    const claims: CredentialExpiryWarningClaim[] = [];
    for (const credential of this.credentials.values()) {
      if (credential.revokedAt || !credential.expiresAt || credential.expiresAt <= now) continue;
      const daysRemaining = (credential.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1_000);
      for (const thresholdDays of [30, 7, 1] as const) {
        const key = `${credential.id}:${thresholdDays}`;
        if (daysRemaining > thresholdDays || this.warningClaims.has(key)) continue;
        const serviceAccount = credential.serviceAccountId
          ? this.serviceAccounts.get(credential.serviceAccountId)
          : null;
        if (credential.kind === "service" && serviceAccount?.status !== "enabled") continue;
        this.warningClaims.add(key);
        claims.push({
          credentialId: credential.id,
          workspaceId: credential.workspaceId,
          accountId: serviceAccount?.accountId ?? "test-account",
          principalKind: credential.kind === "personal" ? "user" : "service",
          principalId: credential.ownerUserId ?? credential.serviceAccountId!,
          thresholdDays,
          expiresAt: credential.expiresAt,
        });
      }
    }
    return claims;
  }

  async releaseExpiryWarning(credentialId: string, thresholdDays: 30 | 7 | 1): Promise<void> {
    this.warningClaims.delete(`${credentialId}:${thresholdDays}`);
  }

  private activeServiceCredentials(serviceAccountId: string, now = new Date()): ApiCredentialRecord[] {
    return [...this.credentials.values()].filter((credential) =>
      credential.serviceAccountId === serviceAccountId
      && credential.revokedAt === null
      && (!credential.expiresAt || credential.expiresAt > now)
    );
  }

  private async invalidatePersonalCredentials(
    matches: (credential: ApiCredentialRecord) => boolean,
    input: { reason: string; actorUserId?: string | null; now: Date; auditEvents?: (credentials: ApiCredentialRecord[]) => import("../../src/modules/machineAccess/ports.js").MachineAccessAuditEvent[] },
  ): Promise<ApiCredentialRecord[]> {
    const before = new Map(this.credentials);
    const invalidated: ApiCredentialRecord[] = [];
    for (const credential of this.credentials.values()) {
      if (credential.kind !== "personal" || credential.revokedAt || !matches(credential)) continue;
      const updated = {
        ...credential,
        revokedAt: input.now,
        revokedByUserId: input.actorUserId ?? null,
        revocationReason: input.reason,
        updatedAt: input.now,
        revision: credential.revision + 1,
      };
      this.credentials.set(updated.id, updated);
      invalidated.push(updated);
    }
    try {
      await this.persistAuditEvents(input.auditEvents?.(invalidated) ?? []);
      return invalidated;
    } catch (error) {
      this.credentials.clear();
      before.forEach((credential, id) => this.credentials.set(id, credential));
      throw error;
    }
  }

  private createServiceCredentialRecord(input: {
    accountId: string;
    workspaceId: string;
    serviceAccountId: string;
    label: string;
    tokenPrefix: string;
    tokenHash: string;
    expiresAt: Date | null;
    createdByUserId: string;
  }): ApiCredentialRecord {
    return {
      id: randomUUID(),
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      kind: "service",
      label: input.label,
      tokenPrefix: input.tokenPrefix,
      tokenHash: input.tokenHash,
      roleCeiling: null,
      ownerUserId: null,
      accessTenureMembershipId: null,
      serviceAccountId: input.serviceAccountId,
      createdByUserId: input.createdByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      revokedByUserId: null,
      revocationReason: null,
      rotatedFromCredentialId: null,
      revision: 1,
    };
  }

  private async persistAuditEvents(events: readonly import("../../src/modules/machineAccess/ports.js").MachineAccessAuditEvent[]): Promise<void> {
    if (this.failAuditPersistence) throw this.failAuditPersistence;
    this.durableAuditEvents.push(...events);
  }
}
