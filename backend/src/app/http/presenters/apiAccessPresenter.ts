import type { ApiCredentialRecord, ServiceAccountRecord } from "../../../modules/machineAccess/ports.js";
import { deriveCredentialStatus } from "../../../modules/machineAccess/domain.js";

const expiryWarningDays = (expiresAt: Date | null, now = new Date()): 30 | 7 | 1 | null => {
  if (!expiresAt) return null;
  if (expiresAt.getTime() <= now.getTime()) return null;
  const days = Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000);
  return days <= 1 ? 1 : days <= 7 ? 7 : days <= 30 ? 30 : null;
};

export const presentApiCredential = (credential: ApiCredentialRecord) => ({
  id: credential.id,
  kind: credential.kind,
  label: credential.label,
  prefix: credential.tokenPrefix,
  roleCeiling: credential.roleCeiling,
  ownerUserId: credential.ownerUserId,
  serviceAccountId: credential.serviceAccountId,
  createdByUserId: credential.createdByUserId,
  createdAt: credential.createdAt.toISOString(),
  expiresAt: credential.expiresAt?.toISOString() ?? null,
  status: credential.status ?? deriveCredentialStatus({ ...credential, now: new Date() }),
  expiryWarningDays: expiryWarningDays(credential.expiresAt),
  lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
  revokedAt: credential.revokedAt?.toISOString() ?? null,
  revokedByUserId: credential.revokedByUserId,
  revocationReason: credential.revocationReason,
  rotatedFromCredentialId: credential.rotatedFromCredentialId,
  revision: credential.revision,
});

export const presentServiceAccount = (account: ServiceAccountRecord) => ({
  id: account.id,
  displayName: account.displayName,
  role: account.role,
  status: account.status,
  createdByUserId: account.createdByUserId,
  createdAt: account.createdAt.toISOString(),
  updatedAt: account.updatedAt.toISOString(),
  disabledAt: account.disabledAt?.toISOString() ?? null,
  archivedAt: account.archivedAt?.toISOString() ?? null,
  lastUsedAt: account.lastUsedAt?.toISOString() ?? null,
  activeCredentialCount: account.activeCredentialCount ?? 0,
  revision: account.revision,
});
