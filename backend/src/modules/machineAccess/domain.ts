import { badRequest, conflict } from "../../shared/domain/errors.js";

export const MACHINE_CREDENTIAL_KINDS = ["personal", "service"] as const;
export type MachineCredentialKind = (typeof MACHINE_CREDENTIAL_KINDS)[number];
export type MachineAccessRole = "member" | "admin";
export type ServiceAccountStatus = "enabled" | "disabled" | "archived";
export const MACHINE_CREDENTIAL_STATUSES = ["active", "expired", "revoked", "suspended", "invalid"] as const;
export type MachineCredentialStatus = (typeof MACHINE_CREDENTIAL_STATUSES)[number];
export const PERSONAL_CREDENTIAL_TENURE_END_REASONS = [
  "membership_ended",
  "workspace_deleted",
  "account_deleted",
  "user_deleted",
] as const;
export type PersonalCredentialTenureEndReason = (typeof PERSONAL_CREDENTIAL_TENURE_END_REASONS)[number];

export const MACHINE_ACCESS_LIMITS = {
  maxActiveCredentialsPerServiceAccount: 5,
  maxActivePersonalCredentials: 10,
  maxNonArchivedServiceAccounts: 50,
  maxPageSize: 100,
  defaultPageSize: 50,
} as const;

export const MACHINE_ACCESS_LIFETIMES = {
  personalDays: 90,
  serviceDays: 365,
} as const;

const controlCharacter = /[\u0000-\u001F\u007F-\u009F]/u;

export const normalizeCredentialLabel = (value: string): string => {
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > 80 || controlCharacter.test(normalized)) {
    throw badRequest("Credential labels must contain 1-80 non-control characters");
  }
  return normalized;
};

export const requireFutureExpiry = (expiresAt: Date, now: Date): Date => {
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    throw badRequest("Credential expiry must be in the future");
  }
  return expiresAt;
};

export const normalizeCredentialExpiry = (
  expiresAt: Date | null | undefined,
  now: Date,
  maximumDays: number,
): Date => {
  if (expiresAt == null) throw badRequest("Credential expiry is required");
  const normalized = requireFutureExpiry(expiresAt, now);
  if (normalized.getTime() > now.getTime() + maximumDays * 24 * 60 * 60 * 1000) {
    throw badRequest(`Credential expiry cannot exceed ${maximumDays} days`);
  }
  return normalized;
};

export const minimumRole = (left: MachineAccessRole, right: MachineAccessRole): MachineAccessRole =>
  left === "member" || right === "member" ? "member" : "admin";

export const assertAssignableRole = (actorRole: "owner" | MachineAccessRole, role: MachineAccessRole): void => {
  if (actorRole === "member" && role === "admin") throw conflict("Role exceeds current workspace access");
};

export const isServiceAccountActive = (status: ServiceAccountStatus): boolean => status === "enabled";

export const deriveCredentialStatus = (input: {
  kind: MachineCredentialKind;
  expiresAt: Date;
  revokedAt: Date | null;
  ownerUserId: string | null;
  accessTenureMembershipId: string | null;
  roleCeiling: MachineAccessRole | null;
  serviceAccountId: string | null;
  serviceAccountStatus?: ServiceAccountStatus | null;
  now: Date;
}): MachineCredentialStatus => {
  if (input.revokedAt) return "revoked";
  if (input.expiresAt.getTime() <= input.now.getTime()) return "expired";
  if (input.kind === "personal") {
    return input.ownerUserId && input.accessTenureMembershipId && input.roleCeiling ? "active" : "invalid";
  }
  if (!input.serviceAccountId || input.serviceAccountStatus === null) return "invalid";
  if (input.serviceAccountStatus === "disabled") return "suspended";
  if (input.serviceAccountStatus === "archived") return "invalid";
  return "active";
};
