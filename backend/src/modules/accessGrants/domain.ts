import { badRequest } from "../../shared/domain/errors.js";

export type GrantPrincipalKind = "workspace-admin" | "agent-api" | "public-launch";
export type AccessGrantRole = "public" | "agent";
export type AccessGrantChannel = "embed" | "public-link" | "mcp-converse" | "agent-api";

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
  channel: AccessGrantChannel;
  tokenPrefix: string;
  tokenHash: string;
  encryptedToken: string | null;
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

/** Bounded operational signal for non-critical last-use persistence. */
export interface AccessGrantUsageObserver {
  recordLastUsePersistenceFailure?(): void;
}

/** Bounded operational signal for non-critical completed channel-chat audits. */
export interface AgentChannelChatAuditObserver {
  recordCompletedAuditPersistenceFailure?(): void;
}

const controlCharacter = /[\u0000-\u001F\u007F-\u009F]/u;

export const normalizeAccessGrantLabel = (value: string): string => {
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > 80 || controlCharacter.test(normalized)) {
    throw badRequest("Access grant labels must contain 1-80 non-control characters");
  }
  return normalized;
};
