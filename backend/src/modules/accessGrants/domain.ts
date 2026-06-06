export type GrantPrincipalKind = "workspace-admin" | "agent-api" | "public-launch";
export type AccessGrantRole = "public";

export type OriginConstraint =
  | { mode: "allow-all"; origins: [] }
  | { mode: "list"; origins: string[] };

export interface AccessGrant {
  id: string;
  agentId: string;
  workspaceId: string;
  label: string | null;
  principalKind: GrantPrincipalKind;
  role: AccessGrantRole;
  tokenPrefix: string;
  tokenHash: string;
  encryptedToken: string;
  originConstraint: OriginConstraint;
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type AccessGrantAuthFailureReason =
  | "not_found"
  | "revoked"
  | "disabled"
  | "expired"
  | "wrong_principal_kind"
  | "origin_denied";

export type AccessGrantEvaluation =
  | { allowed: true }
  | { allowed: false; reason: AccessGrantAuthFailureReason };

export interface AccessGrantSecret {
  grant: AccessGrant;
  token: string;
}
