import type { OperatorMcpScope } from "@radioso/operator-mcp-contract";

export type OperatorMcpClientStatus = "active" | "revoked" | "expired";
export type OperatorMcpGrantStatus = "active" | "revoked" | "superseded" | "expired";

export interface OperatorMcpClientSnapshot {
  id: string;
  clientId: string;
  clientVersion: string;
  metadataDigest: string;
  normalizedMetadata: Readonly<Record<string, unknown>>;
  clientUri?: string | null;
  displayName: string;
  applicationType: "web" | "native";
  redirectUris: readonly string[];
  source: "metadata_document" | "preregistered" | "compatibility";
  validatedAt: Date;
  expiresAt: Date | null;
}

export interface OperatorMcpGrantRecord {
  id: string;
  clientRecordId: string;
  clientId: string;
  clientVersion: string;
  clientMetadataSnapshotId: string;
  accountId: string;
  workspaceId: string;
  userId: string;
  membershipId: string;
  resource: string;
  toolScopes: readonly OperatorMcpScope[];
  offlineAccess: boolean;
  status: OperatorMcpGrantStatus;
  version: string;
  credentialEpoch: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export interface OperatorMcpCredentialRecord {
  id: string;
  grantId: string;
  tokenDigest: string;
  issuedGrantVersion: string;
  issuedClientVersion: string;
  issuedClientMetadataSnapshotId: string;
  issuedCredentialEpoch: string;
  issuedToolScopes: readonly OperatorMcpScope[];
  issuedOfflineAccess: boolean;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface OperatorMcpCurrentCredential {
  credential: OperatorMcpCredentialRecord;
  grant: OperatorMcpGrantRecord;
  clientStatus: OperatorMcpClientStatus;
  currentClientVersion: string;
  currentClientMetadataDigest: string;
  grantClientMetadataDigest: string;
  membershipStatus: string;
  membershipRole: string;
  userDisabledAt: Date | null;
}

export interface OperatorMcpPrincipal {
  credentialId: string;
  grantId: string;
  grantVersion: string;
  accountId: string;
  workspaceId: string;
  userId: string;
  membershipId: string;
  membershipRole: string;
  clientId: string;
  clientRecordId: string;
  clientVersion: string;
  clientMetadataSnapshotId: string;
  resource: string;
  currentToolScopes: readonly OperatorMcpScope[];
  currentOfflineAccess: boolean;
  credentialEpoch: string;
}

export interface OperatorMcpAuthorizationRepositoryPort {
  findCurrentCredential(input: { tokenDigest: string; resource: string; now: Date }): Promise<OperatorMcpCurrentCredential | null>;
  findCurrentCredentialById(input: { credentialId: string; resource: string; now: Date }): Promise<OperatorMcpCurrentCredential | null>;
  markCredentialUsed(input: { credentialId: string; grantId: string; now: Date }): Promise<void>;
  revokeGrant(input: { grantId: string; reason: string; now: Date }): Promise<boolean>;
  revokeClient(input: { clientRecordId: string; reason: string; now: Date }): Promise<{ clientRevoked: boolean; grantsRevoked: number }>;
  ensureDeploymentCredentialState(input: { resource: string; credentialEpoch: string; keyFingerprint: string; now: Date }): Promise<"initialized" | "current">;
  advanceDeploymentCredentialState(input: { resource: string; currentCredentialEpoch: string; credentialEpoch: string; keyFingerprint: string; now: Date }): Promise<boolean>;
}

export interface OperatorMcpLifecycleAttribution {
  accountId: string;
  workspaceId: string;
  userId: string;
  clientRecordId: string;
  grantId: string;
}

export interface OperatorMcpAuthorizationTransactionRecord {
  id: string;
  clientRecordId: string;
  clientId: string;
  clientVersion: string;
  clientMetadataSnapshotId: string;
  clientMetadataDigest: string;
  clientDisplayName: string;
  clientUri: string | null;
  applicationType: "web" | "native";
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  requestedToolScopes: readonly OperatorMcpScope[];
  requestedOfflineAccess: boolean;
  accountId: string | null;
  userId: string | null;
  sessionId: string | null;
  workspaceId: string | null;
  membershipId: string | null;
  approvedToolScopes: readonly OperatorMcpScope[] | null;
  approvedOfflineAccess: boolean | null;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  expiresAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
  consumedAt: Date | null;
}

export interface OperatorMcpAuthorizationFlowRepositoryPort {
  createTransaction(input: Omit<OperatorMcpAuthorizationTransactionRecord,
    "clientId" | "clientVersion" | "clientDisplayName" | "clientUri" | "applicationType" | "accountId" | "userId" | "sessionId" |
    "workspaceId" | "membershipId" | "approvedToolScopes" | "approvedOfflineAccess" | "status" | "decidedAt" | "consumedAt"
  >): Promise<void>;
  findTransaction(transactionId: string, now: Date): Promise<OperatorMcpAuthorizationTransactionRecord | null>;
  decideTransaction(input: {
    transactionId: string;
    sessionId: string;
    accountId: string;
    userId: string;
    workspaceId: string | null;
    membershipId: string | null;
    approvedToolScopes: readonly OperatorMcpScope[] | null;
    approvedOfflineAccess: boolean | null;
    authorizationCodeDigest: string | null;
    status: "approved" | "denied";
    now: Date;
  }): Promise<boolean>;
  exchangeAuthorizationCode(input: {
    authorizationCodeDigest: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    codeChallenge: string;
    requestedToolScopes?: readonly OperatorMcpScope[];
    credentialEpoch: string;
    accessCredential: { id: string; tokenDigest: string; expiresAt: Date };
    refreshCredential: { lineageId: string; tokenDigest: string; idleExpiresAt: Date; absoluteExpiresAt: Date } | null;
    now: Date;
  }): Promise<{ grantId: string; toolScopes: readonly OperatorMcpScope[]; offlineAccess: boolean; attribution?: OperatorMcpLifecycleAttribution } | null>;
  rotateRefreshCredential(input: {
    tokenDigest: string;
    clientId: string;
    resource: string;
    requestedToolScopes?: readonly OperatorMcpScope[];
    credentialEpoch: string;
    accessCredential: { id: string; tokenDigest: string; expiresAt: Date };
    successorTokenDigest: string;
    idleExpiresAt: Date;
    now: Date;
  }): Promise<{ status: "rotated" | "replay" | "invalid"; grantId?: string; toolScopes?: readonly OperatorMcpScope[]; attribution?: OperatorMcpLifecycleAttribution }>;
  revokeCredentialByDigest(input: { tokenDigest: string; clientId: string; now: Date }): Promise<OperatorMcpLifecycleAttribution | null>;
}

export interface OperatorMcpGrantSummaryRecord {
  id: string;
  clientId: string;
  clientName: string;
  clientVersion: string;
  clientMetadataDigest: string;
  workspaceId: string;
  workspaceName: string;
  userId: string;
  userName: string | null;
  scopes: readonly OperatorMcpScope[];
  offlineAccess: boolean;
  status: OperatorMcpGrantStatus;
  resource: string;
  redirectHost: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  credentialCount: number;
  recentInvocationCount: number;
}

export interface OperatorMcpGrantRepositoryPort {
  listGrants(input: { workspaceId: string; userId?: string }): Promise<readonly OperatorMcpGrantSummaryRecord[]>;
  findGrant(input: { workspaceId: string; grantId: string }): Promise<OperatorMcpGrantSummaryRecord | null>;
  revokeGrant(input: { grantId: string; reason: string; now: Date }): Promise<boolean>;
}

export interface PersistedOperatorMcpClient {
  recordId: string;
  clientId: string;
  clientVersion: string;
  metadataSnapshotId: string;
  metadataDigest: string;
  applicationType: "web" | "native";
  redirectUris: readonly string[];
  displayName: string;
  clientUri: string | null;
}

export interface OperatorMcpClientRepositoryPort {
  persistClientSnapshot(snapshot: OperatorMcpClientSnapshot): Promise<PersistedOperatorMcpClient>;
}
