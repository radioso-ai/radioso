import type {
  AccessGrant,
  AccessGrantChannel,
  AccessGrantRole,
  GrantPrincipalKind,
  OriginConstraint,
} from "./domain.js";

/** Persistence contract owned by the access-grants module. Database adapters implement it structurally. */
export interface AccessGrantRepositoryPort {
  findById(grantId: string): Promise<AccessGrant | null>;
  findByTokenHash(tokenHash: string): Promise<AccessGrant | null>;
  listByAgent(agentId: string, params?: {
    workspaceId?: string;
    principalKind?: GrantPrincipalKind;
    channel?: AccessGrantChannel;
    limit?: number;
    cursor?: { createdAt: string; id: string };
  }): Promise<{ grants: AccessGrant[]; nextCursor: { createdAt: string; id: string } | null }>;
  save(params: {
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
  }): Promise<AccessGrant>;
  rotate(grantId: string, params: {
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string | null;
    expectedTokenHash?: string;
    requireActiveAgentChannel?: boolean;
  }): Promise<AccessGrant | null>;
  revoke(grantId: string, revokedAt: Date): Promise<AccessGrant | null>;
  touch(grantId: string, lastUsedAt: Date): Promise<void>;
  updateConstraints(grantId: string, params: {
    originConstraint?: OriginConstraint;
    enabled?: boolean;
    label?: string | null;
  }): Promise<AccessGrant | null>;
}

export interface AccessGrantLifecycleAuditEvent {
  accountId?: string | null;
  workspaceId: string;
  eventType: "access_grant.issue" | "access_grant.rotate" | "access_grant.revoke";
  eventStatus: "success";
  metadata: Record<string, unknown>;
}

export interface AccessGrantLifecycleSaveInput {
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
}

export interface AccessGrantLifecycleRotateInput {
  grantId: string;
  tokenPrefix: string;
  tokenHash: string;
  encryptedToken: string | null;
  expectedTokenHash?: string;
  requireActiveAgentChannel?: boolean;
}

export interface AccessGrantLifecycleResult {
  grant: AccessGrant;
  auditEvent: AccessGrantLifecycleAuditEvent;
}

/**
 * Commits an access-grant lifecycle mutation and its audit fact together. The
 * access-grants domain owns this narrow transactional boundary; composition
 * selects the Postgres implementation.
 */
export interface AccessGrantLifecycleUnitOfWorkPort {
  issue(input: {
    grant: AccessGrantLifecycleSaveInput;
    auditEvent: (grant: AccessGrant) => AccessGrantLifecycleAuditEvent;
  }): Promise<AccessGrantLifecycleResult>;
  rotate(input: {
    grant: AccessGrantLifecycleRotateInput;
    auditEvent: (grant: AccessGrant) => AccessGrantLifecycleAuditEvent;
  }): Promise<AccessGrantLifecycleResult | null>;
  revoke(input: {
    grantId: string;
    revokedAt: Date;
    auditEvent: (grant: AccessGrant) => AccessGrantLifecycleAuditEvent;
  }): Promise<AccessGrantLifecycleResult | null>;
}
