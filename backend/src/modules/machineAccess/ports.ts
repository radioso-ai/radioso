import type {
  MachineAccessRole,
  MachineCredentialKind,
  ServiceAccountStatus,
  PersonalCredentialTenureEndReason,
} from "./domain.js";

export interface ServiceAccountRecord {
  id: string;
  workspaceId: string;
  accountId: string;
  displayName: string;
  role: MachineAccessRole;
  status: ServiceAccountStatus;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
  archivedAt: Date | null;
  lastUsedAt: Date | null;
  revision: number;
  activeCredentialCount?: number;
}

export interface ApiCredentialRecord {
  id: string;
  accountId: string;
  workspaceId: string;
  kind: MachineCredentialKind;
  label: string;
  tokenPrefix: string;
  tokenHash: string;
  roleCeiling: MachineAccessRole | null;
  ownerUserId: string | null;
  accessTenureMembershipId: string | null;
  serviceAccountId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
  rotatedFromCredentialId: string | null;
  revision: number;
}

export interface CredentialExpiryWarningClaim {
  credentialId: string;
  workspaceId: string;
  accountId: string;
  principalKind: "user" | "service";
  principalId: string;
  thresholdDays: 30 | 7 | 1;
  expiresAt: Date;
}

export interface MachineAccessSecurityObserver {
  recordAuthentication(input: {
    outcome: "success" | "denied";
    principalKind: "personal" | "service" | "unknown";
    reason: MachineAccessAuthenticationReason;
  }): void;
  recordAuthorizationDenial(input: {
    principalKind: "personal" | "service";
    reason: "route_policy";
  }): void;
}

export type MachineAccessAuthenticationReason =
  | "authenticated"
  | "expired"
  | "malformed"
  | "personal_binding_invalid"
  | "personal_membership_inactive"
  | "personal_role_unavailable"
  | "revoked"
  | "service_account_disabled"
  | "service_binding_invalid"
  | "unknown";

interface IssuedSecret {
  secret: string;
  tokenPrefix: string;
  tokenHash: string;
}

/** Persistence contract; application services select only the operations they consume. */
export interface MachineAccessPersistencePort {
  invalidatePersonalCredentialsForTenure(input: {
    membershipId: string;
    reason: PersonalCredentialTenureEndReason;
    actorUserId?: string | null;
    now: Date;
  }): Promise<ApiCredentialRecord[]>;
  invalidatePersonalCredentialsForWorkspace(input: {
    workspaceId: string;
    reason: Extract<PersonalCredentialTenureEndReason, "workspace_deleted" | "account_deleted">;
    actorUserId?: string | null;
    now: Date;
  }): Promise<ApiCredentialRecord[]>;
  invalidatePersonalCredentialsForAccount(input: {
    accountId: string;
    reason: Extract<PersonalCredentialTenureEndReason, "account_deleted">;
    actorUserId?: string | null;
    now: Date;
  }): Promise<ApiCredentialRecord[]>;
  createPersonalWithinLimit(input: {
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
    issueSecret: () => IssuedSecret;
  }): Promise<{ credential: ApiCredentialRecord; secret: string } | null>;
  createServiceAccountWithinLimit(input: {
    workspaceId: string;
    accountId: string;
    displayName: string;
    role: MachineAccessRole;
    createdByUserId: string;
    credentialLabel: string;
    expiresAt: Date;
    limit: number;
    issueSecret: () => IssuedSecret;
  }): Promise<{ account: ServiceAccountRecord; credential: ApiCredentialRecord; secret: string } | null>;
  createServiceCredentialWithinLimit(input: {
    accountId: string;
    workspaceId: string;
    serviceAccountId: string;
    label: string;
    expiresAt: Date;
    createdByUserId: string;
    now: Date;
    limit: number;
    issueSecret: () => IssuedSecret;
  }): Promise<
    | { status: "created"; credential: ApiCredentialRecord; secret: string }
    | { status: "inactive" | "limit" | "missing" }
  >;
  findCredentialByHash(tokenHash: string): Promise<ApiCredentialRecord | null>;
  findCredential(id: string): Promise<ApiCredentialRecord | null>;
  findServiceAccount(id: string): Promise<ServiceAccountRecord | null>;
  findLegacyMigrationTime(workspaceId: string): Promise<Date | null>;
  listCredentials(input: {
    workspaceId: string;
    kind?: MachineCredentialKind;
    ownerUserId?: string;
    serviceAccountId?: string;
    limit: number;
    page?: number;
  }): Promise<ApiCredentialRecord[]>;
  countCredentials(input: {
    workspaceId: string;
    kind?: MachineCredentialKind;
    ownerUserId?: string;
    serviceAccountId?: string;
  }): Promise<number>;
  listServiceAccounts(input: {
    workspaceId: string;
    limit: number;
    page?: number;
  }): Promise<ServiceAccountRecord[]>;
  countServiceAccounts(workspaceId: string): Promise<number>;
  countActiveServiceCredentials(serviceAccountId: string): Promise<number>;
  mutateServiceAccount(input: {
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
  >;
  revokeCredential(input: {
    id: string;
    actorUserId: string;
    expectedRevision?: number;
    now: Date;
  }): Promise<boolean>;
  relabelCredential(input: {
    id: string;
    label: string;
    expectedRevision?: number;
  }): Promise<ApiCredentialRecord | null>;
  replaceCredential(input: {
    credentialId: string;
    expectedRevision: number;
    label: string;
    tokenPrefix: string;
    tokenHash: string;
    createdByUserId: string;
  }): Promise<ApiCredentialRecord | null>;
  touchCredentialUse(input: {
    credentialId: string;
    serviceAccountId?: string | null;
    at: Date;
  }): Promise<void>;
  claimExpiryWarnings(now: Date): Promise<CredentialExpiryWarningClaim[]>;
  releaseExpiryWarning(credentialId: string, thresholdDays: 30 | 7 | 1): Promise<void>;
}
